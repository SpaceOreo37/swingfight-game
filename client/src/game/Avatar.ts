import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
/** Body center height: the avatar rotates around this point, not its feet. */
const CENTER = 0.9;
const _yawQ = new THREE.Quaternion();
const _tiltQ = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const _bodyUp = new THREE.Vector3();
const _back = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 * 0.92);

/** Color roles baked into each vertex; recolored when the suit color changes. */
const ROLE = { suit: 0, dark: 1, lens: 2, accent: 3 } as const;
type Role = (typeof ROLE)[keyof typeof ROLE];

/** What the body is doing (drives the animation). */
export type AvatarState = 'ground' | 'air' | 'swing' | 'wall' | 'charge' | 'zip';

export interface AvatarPose {
  pos: THREE.Vector3;
  yaw: number;
  vel: THREE.Vector3;
  state: AvatarState;
  /** Unit vector toward the web anchor (swing / charge / zip). */
  ropeDir: THREE.Vector3 | null;
  /** Wall normal while on a wall. */
  wallNormal: THREE.Vector3 | null;
  /** Seconds since the last thwip / web shot (left-arm punch). */
  punchAge: number;
  /** On the floor (yanked or knocked out). */
  downed: boolean;
}

/** Joint rotation targets for one frame (radians). Missing = 0. */
type JointName =
  | 'hips' | 'spine' | 'chest' | 'neck'
  | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR'
  | 'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'ankleL' | 'ankleR';
type Pose = Partial<Record<JointName, [number, number, number]>>;

/**
 * The hero: a jointed figure in a suit (mask, eye lenses, gloves, boots,
 * chest emblem) built from simple shapes, animated procedurally from what
 * the player is doing. No downloads. Each body part is one mesh, so a
 * player costs about a dozen draw calls.
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** Holds the skeleton, shifted down so the root sits at the body's center. */
  private readonly body = new THREE.Group();
  private readonly joints = {} as Record<JointName, THREE.Group>;
  private readonly rightHand = new THREE.Object3D();
  private readonly leftHand = new THREE.Object3D();
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  private readonly geometries: THREE.BufferGeometry[] = [];
  private stride = 0;
  private time = Math.random() * 10;
  private crouch = 0;

  constructor(color: number) {
    this.body.position.y = -CENTER;
    this.root.add(this.body);
    this.build();
    this.setColor(color);
  }

  // ---------------------------------------------------------------- building

  private build(): void {
    const j = (name: JointName, parent: THREE.Object3D, x: number, y: number, z: number) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      this.joints[name] = g;
      return g;
    };
    const mesh = (parent: THREE.Object3D, parts: [THREE.BufferGeometry, Role][]) => {
      const geo = mergeGeometries(parts.map(([g, role]) => withRole(g, role)));
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, this.material);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 10);
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    const sphere = (r: number) => new THREE.SphereGeometry(r, 16, 12);

    // Torso: pelvis -> spine -> chest -> neck -> head.
    const hips = j('hips', this.body, 0, 0.98, 0);
    mesh(hips, [
      [box(0.3, 0.16, 0.18).translate(0, -0.02, 0), ROLE.suit],
      [box(0.32, 0.05, 0.2).translate(0, 0.06, 0), ROLE.dark], // belt
      [box(0.07, 0.05, 0.02).translate(0, 0.06, -0.105), ROLE.accent], // buckle
    ]);
    const spine = j('spine', hips, 0, 0.08, 0);
    mesh(spine, [[cap(0.135, 0.12).scale(1.05, 1, 0.75).translate(0, 0.1, 0), ROLE.suit]]);
    const chest = j('chest', spine, 0, 0.2, 0);
    mesh(chest, [
      [cap(0.16, 0.16).scale(1.15, 1, 0.78).translate(0, 0.08, 0), ROLE.suit],
      // Dark side panels and a diamond emblem on the chest.
      [box(0.05, 0.26, 0.2).translate(-0.17, 0.06, 0), ROLE.dark],
      [box(0.05, 0.26, 0.2).translate(0.17, 0.06, 0), ROLE.dark],
      [new THREE.OctahedronGeometry(0.07, 0).scale(0.8, 1, 0.25).translate(0, 0.1, -0.12), ROLE.dark],
      [new THREE.OctahedronGeometry(0.04, 0).scale(0.8, 1, 0.25).translate(0, 0.1, -0.135), ROLE.accent],
    ]);
    const neck = j('neck', chest, 0, 0.22, 0);
    mesh(neck, [
      [cap(0.055, 0.05).translate(0, 0.02, 0), ROLE.suit],
      // Masked head with angular eye lenses outlined in dark.
      [sphere(0.13).scale(0.92, 1.08, 1).translate(0, 0.16, 0), ROLE.suit],
      [box(0.085, 0.05, 0.03).rotateZ(-0.35).translate(-0.05, 0.18, -0.115), ROLE.dark],
      [box(0.085, 0.05, 0.03).rotateZ(0.35).translate(0.05, 0.18, -0.115), ROLE.dark],
      [box(0.07, 0.035, 0.03).rotateZ(-0.35).translate(-0.05, 0.18, -0.125), ROLE.lens],
      [box(0.07, 0.035, 0.03).rotateZ(0.35).translate(0.05, 0.18, -0.125), ROLE.lens],
    ]);

    // Arms: shoulder -> elbow -> hand.
    for (const side of [-1, 1] as const) {
      const L = side < 0;
      const shoulder = j(L ? 'shoulderL' : 'shoulderR', chest, 0.22 * side, 0.14, 0);
      mesh(shoulder, [
        [sphere(0.075), ROLE.suit],
        [cap(0.058, 0.2).translate(0, -0.15, 0), ROLE.suit],
      ]);
      const elbow = j(L ? 'elbowL' : 'elbowR', shoulder, 0, -0.28, 0);
      mesh(elbow, [
        [cap(0.05, 0.16).translate(0, -0.11, 0), ROLE.suit],
        [cap(0.054, 0.06).translate(0, -0.2, 0), ROLE.dark], // glove cuff
        [box(0.08, 0.1, 0.06).translate(0, -0.29, 0), ROLE.dark], // hand
      ]);
      const hand = L ? this.leftHand : this.rightHand;
      hand.position.set(0, -0.3, 0);
      elbow.add(hand);
    }

    // Legs: hip -> knee -> ankle.
    for (const side of [-1, 1] as const) {
      const L = side < 0;
      const hip = j(L ? 'hipL' : 'hipR', hips, 0.095 * side, -0.05, 0);
      mesh(hip, [[cap(0.075, 0.28).translate(0, -0.2, 0), ROLE.suit]]);
      const knee = j(L ? 'kneeL' : 'kneeR', hip, 0, -0.42, 0);
      mesh(knee, [
        [cap(0.062, 0.18).translate(0, -0.13, 0), ROLE.suit],
        [cap(0.066, 0.16).translate(0, -0.27, 0), ROLE.dark], // boot
      ]);
      const ankle = j(L ? 'ankleL' : 'ankleR', knee, 0, -0.42, 0);
      mesh(ankle, [[box(0.1, 0.08, 0.22).translate(0, -0.02, -0.05), ROLE.dark]]);
    }
  }

  /** Change the suit color (the server assigns each player one). */
  setColor(color: number): void {
    const suit = new THREE.Color(color);
    const dark = new THREE.Color(0x141a2a).lerp(suit, 0.12);
    const accent = suit.clone().lerp(new THREE.Color(0xffffff), 0.55);
    const lens = new THREE.Color(0xf4f8ff);
    const palette = [suit, dark, lens, accent];
    for (const g of this.geometries) {
      const roles = g.getAttribute('role') as THREE.BufferAttribute;
      const colors = g.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < roles.count; i++) {
        const c = palette[roles.getX(i)];
        colors.setXYZ(i, c.r, c.g, c.b);
      }
      colors.needsUpdate = true;
    }
  }

  /** World position of the right (web) hand / left (punch) hand. */
  rightHandWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.rightHand.getWorldPosition(out);
  }

  leftHandWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.leftHand.getWorldPosition(out);
  }

  // ---------------------------------------------------------------- animation

  update(p: AvatarPose, dt: number): void {
    this.time += dt;
    this.root.position.set(p.pos.x, p.pos.y + CENTER, p.pos.z);

    // Whole-body orientation: wall = belly to the wall, swing = lean along
    // the web, downed = lying face down.
    if (p.wallNormal && !p.downed) {
      _bodyUp.copy(p.vel).addScaledVector(p.wallNormal, -p.vel.dot(p.wallNormal));
      if (_bodyUp.lengthSq() < 4) _bodyUp.copy(UP);
      _bodyUp.normalize();
      _back.copy(p.wallNormal);
      _right.crossVectors(_bodyUp, _back).normalize();
      _m.makeBasis(_right, _bodyUp, _back);
      _target.setFromRotationMatrix(_m);
    } else {
      _yawQ.setFromAxisAngle(UP, p.yaw);
      if (p.ropeDir && p.state !== 'charge') _tiltQ.setFromUnitVectors(UP, p.ropeDir);
      else _tiltQ.identity();
      _target.multiplyQuaternions(_tiltQ, _yawQ);
      if (p.downed) _target.multiply(_down);
    }
    this.root.quaternion.slerp(_target, Math.min(1, dt * 12));

    const pose = this.poseFor(p, dt);
    // Crouch lowers the whole body (charging a launch).
    this.body.position.y = -CENTER - this.crouch * 0.32;

    const k = Math.min(1, dt * 14);
    for (const name of Object.keys(this.joints) as JointName[]) {
      const joint = this.joints[name];
      const t = pose[name] ?? ZERO;
      joint.rotation.x += (t[0] - joint.rotation.x) * k;
      joint.rotation.y += (t[1] - joint.rotation.y) * k;
      joint.rotation.z += (t[2] - joint.rotation.z) * k;
    }
  }

  /**
   * Joint targets for what the body is doing right now. Conventions (the
   * model faces -Z): +x on a hip/shoulder swings the limb forward, -x on a
   * knee bends it, +x on an elbow bends it; +z raises the right arm sideways,
   * -z the left.
   */
  private poseFor(p: AvatarPose, dt: number): Pose {
    const hSpeed = Math.hypot(p.vel.x, p.vel.z);
    const t = this.time;
    const pose: Pose = {};
    let crouch = 0;

    if (p.downed) {
      // Sprawled on the floor.
      Object.assign(pose, {
        shoulderL: [2.6, 0, -0.5], shoulderR: [2.6, 0, 0.5],
        elbowL: [0.3, 0, 0], elbowR: [0.3, 0, 0],
        hipL: [0.1, 0, -0.25], hipR: [0.1, 0, 0.25],
        kneeL: [-0.3, 0, 0], kneeR: [-0.3, 0, 0],
      } satisfies Pose);
    } else if (p.state === 'ground') {
      if (hSpeed < 0.6) {
        // Idle: breathing, relaxed arms.
        const b = Math.sin(t * 2.2) * 0.03;
        Object.assign(pose, {
          chest: [b, 0, 0], neck: [-b, 0, 0],
          shoulderL: [0.05, 0, -0.12], shoulderR: [0.05, 0, 0.12],
          elbowL: [0.2, 0, 0], elbowR: [0.2, 0, 0],
        } satisfies Pose);
      } else {
        // Running: stride length and lean grow with speed.
        this.stride += dt * (4 + hSpeed * 0.55);
        const amp = Math.min(1, 0.35 + hSpeed / 16);
        const s = Math.sin(this.stride);
        const c = Math.cos(this.stride);
        Object.assign(pose, {
          spine: [-0.12 * amp, 0, 0], chest: [-0.08 * amp, -s * 0.12 * amp, 0],
          hipL: [s * 0.9 * amp, 0, 0], hipR: [-s * 0.9 * amp, 0, 0],
          kneeL: [-Math.max(0, -c) * 1.4 * amp - 0.1, 0, 0], kneeR: [-Math.max(0, c) * 1.4 * amp - 0.1, 0, 0],
          ankleL: [Math.max(0, s) * 0.3, 0, 0], ankleR: [Math.max(0, -s) * 0.3, 0, 0],
          shoulderL: [-s * 0.8 * amp, 0, -0.1], shoulderR: [s * 0.8 * amp, 0, 0.1],
          elbowL: [0.5 + 0.5 * amp, 0, 0], elbowR: [0.5 + 0.5 * amp, 0, 0],
        } satisfies Pose);
      }
    } else if (p.state === 'swing' && p.ropeDir) {
      // Web arm straight up the line, other arm out for balance, legs trailing the swing.
      const kick = Math.sin(t * 3) * 0.12;
      Object.assign(pose, {
        shoulderR: [Math.PI, 0, 0.05], elbowR: [0, 0, 0],
        shoulderL: [0.5, 0, -1.1], elbowL: [0.6, 0, 0],
        hipL: [0.35 + kick, 0, -0.05], hipR: [0.2 - kick, 0, 0.05],
        kneeL: [-0.6, 0, 0], kneeR: [-0.35, 0, 0],
        chest: [-0.1, 0, 0],
      } satisfies Pose);
    } else if (p.state === 'zip') {
      // Both arms reaching for the point, legs trailing behind.
      Object.assign(pose, {
        shoulderL: [2.7, 0, 0.15], shoulderR: [2.7, 0, -0.15],
        elbowL: [0.15, 0, 0], elbowR: [0.15, 0, 0],
        hipL: [-0.25, 0, -0.05], hipR: [-0.4, 0, 0.05],
        kneeL: [-0.5, 0, 0], kneeR: [-0.8, 0, 0],
      } satisfies Pose);
    } else if (p.state === 'charge') {
      // Crouched, web arm up holding the line, free hand down by the ground.
      crouch = 1;
      Object.assign(pose, {
        spine: [-0.35, 0, 0], chest: [-0.2, 0, 0],
        hipL: [1.5, 0, -0.18], hipR: [1.2, 0, 0.18],
        kneeL: [-2.1, 0, 0], kneeR: [-1.9, 0, 0],
        ankleL: [0.5, 0, 0], ankleR: [0.5, 0, 0],
        shoulderR: [Math.PI, 0, 0.1], elbowR: [0.1, 0, 0],
        shoulderL: [0.9, 0, -0.25], elbowL: [0.4, 0, 0],
      } satisfies Pose);
    } else if (p.state === 'wall') {
      // Crawling up the wall: arms reach overhead in turn, legs push like a frog.
      const moving = p.vel.lengthSq() > 4;
      if (moving) this.stride += dt * 7;
      const s = moving ? Math.sin(this.stride) : 0;
      Object.assign(pose, {
        shoulderL: [2.5 + s * 0.45, 0, -0.35], shoulderR: [2.5 - s * 0.45, 0, 0.35],
        elbowL: [0.7 - s * 0.4, 0, 0], elbowR: [0.7 + s * 0.4, 0, 0],
        hipL: [1.1 - s * 0.4, 0, -0.45], hipR: [1.1 + s * 0.4, 0, 0.45],
        kneeL: [-1.7 + s * 0.3, 0, 0], kneeR: [-1.7 - s * 0.3, 0, 0],
        neck: [-0.4, 0, 0],
      } satisfies Pose);
    } else {
      // In the air: tucked going up, spread wide when falling fast.
      const fall = Math.min(1, Math.max(0, -p.vel.y / 25));
      const tuck = 1 - fall;
      const flap = Math.sin(t * 9) * 0.06 * fall;
      Object.assign(pose, {
        spine: [-0.1 * tuck + 0.15 * fall, 0, 0],
        hipL: [0.7 * tuck + 0.1 * fall, 0, -0.35 * fall], hipR: [0.4 * tuck + 0.1 * fall, 0, 0.35 * fall],
        kneeL: [-1.2 * tuck - 0.3 * fall, 0, 0], kneeR: [-0.7 * tuck - 0.3 * fall, 0, 0],
        shoulderL: [0.6 * tuck + 0.3 * fall, 0, -0.5 - 0.9 * fall + flap], shoulderR: [0.6 * tuck + 0.3 * fall, 0, 0.5 + 0.9 * fall - flap],
        elbowL: [0.7 * tuck + 0.2, 0, 0], elbowR: [0.7 * tuck + 0.2, 0, 0],
      } satisfies Pose);
    }

    // Punch / web shot: left arm snaps straight out in front.
    if (p.punchAge < 0.25 && !p.downed) {
      pose.shoulderL = [1.55, 0, 0];
      pose.elbowL = [0, 0, 0];
    }

    this.crouch += (crouch - this.crouch) * Math.min(1, dt * 10);
    return pose;
  }
}

const ZERO: [number, number, number] = [0, 0, 0];

/** Tag a geometry's vertices with a color role (and give it a color attribute to fill in). */
function withRole(g: THREE.BufferGeometry, role: Role): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count;
  geo.setAttribute('role', new THREE.Float32BufferAttribute(new Float32Array(n).fill(role), 1));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  return geo;
}
