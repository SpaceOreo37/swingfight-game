import * as THREE from 'three';

/** What the arms should be doing this frame. */
export interface ArmPose {
  state: 'ground' | 'air' | 'swing' | 'wall' | 'charge' | 'zip';
  /** World point the web is attached to (swing / charge / zip), else null. */
  anchor: THREE.Vector3 | null;
  /** Seconds since the last thwip (punch-out lasts ~0.25s). */
  thwipAge: number;
  /** Where the thwip web went (world). */
  thwipPoint: THREE.Vector3;
  speed: number;
  /** Moving on the ground (for walk bob). */
  moving: boolean;
}

const ARM_LEN = 0.5;
const FORWARD = new THREE.Vector3(0, 0, -1);
const right = new THREE.Vector3();
const left = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();

/**
 * First-person arms, attached to the camera. Each arm is a pivot at the
 * shoulder whose -Z axis is the arm direction, so posing = pointing.
 * Drawn on top of the world so they never clip into walls.
 */
export class FirstPersonArms {
  readonly root = new THREE.Group();
  private readonly left: THREE.Group;
  private readonly right: THREE.Group;
  private readonly leftHand: THREE.Object3D;
  private readonly rightHand: THREE.Object3D;
  private time = 0;
  /** Extra reach for the punch-out (0..1). */
  private leftPunch = 0;
  private readonly suit: THREE.MeshStandardMaterial;

  constructor(color: number) {
    const suit = (this.suit = new THREE.MeshStandardMaterial({ color, roughness: 0.55, depthTest: false, depthWrite: false }));
    const glove = new THREE.MeshStandardMaterial({ color: 0x1d2433, roughness: 0.6, depthTest: false, depthWrite: false });
    const make = (side: number) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.3 * side, -0.36, -0.22);
      const armGeo = new THREE.CapsuleGeometry(0.042, ARM_LEN, 4, 10).rotateX(-Math.PI / 2).translate(0, 0, -ARM_LEN / 2);
      const arm = new THREE.Mesh(armGeo, suit);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.058, 12, 10), glove);
      hand.position.set(0, 0, -ARM_LEN - 0.04);
      hand.scale.set(1, 0.8, 1.2);
      shoulder.add(arm, hand);
      for (const m of [arm, hand]) m.renderOrder = 1000;
      this.root.add(shoulder);
      return { shoulder, hand };
    };
    const l = make(-1);
    const r = make(1);
    this.left = l.shoulder;
    this.right = r.shoulder;
    this.leftHand = l.hand;
    this.rightHand = r.hand;
    this.root.visible = false;
  }

  setColor(color: number): void {
    this.suit.color.setHex(color);
  }

  /** World position of the right (web-swinging) hand. */
  rightHandWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.rightHand.getWorldPosition(out);
  }

  /** World position of the left (thwip) hand. */
  leftHandWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.leftHand.getWorldPosition(out);
  }

  update(camera: THREE.Camera, pose: ArmPose, dt: number): void {
    this.time += dt;
    const t = this.time;
    _inv.copy(camera.matrixWorld).invert();

    // Direction (camera space) from a shoulder toward a world point.
    const toward = (shoulder: THREE.Group, world: THREE.Vector3, out: THREE.Vector3) =>
      out.copy(world).applyMatrix4(_inv).sub(shoulder.position).normalize();

    // Rest: hands low in the corners of the screen, swaying with speed.
    const sway = Math.min(1, pose.speed / 40);
    const bob = pose.moving ? Math.sin(t * 11) * 0.06 : Math.sin(t * 1.6) * 0.015;
    right.set(0.12 + sway * 0.1, -0.55 + bob, -1);
    left.set(-0.12 - sway * 0.1, -0.55 - bob, -1);

    switch (pose.state) {
      case 'swing':
      case 'zip':
        // Web arm reaches for the anchor; the other arm trails behind with the speed.
        if (pose.anchor) toward(this.right, pose.anchor, right);
        if (pose.state === 'zip' && pose.anchor) {
          toward(this.left, pose.anchor, left);
          left.x -= 0.1;
          left.y -= 0.05;
        }
        else left.set(-0.35 - sway * 0.3, -0.7 - sway * 0.2, -0.6);
        break;
      case 'charge':
        // Web planted overhead; free hand braced low.
        if (pose.anchor) toward(this.right, pose.anchor, right);
        left.set(-0.25, -0.9, -0.5);
        break;
      case 'wall': {
        // Climbing: hands forward, alternating reach.
        const c = Math.sin(t * 9);
        right.set(0.2, 0.25 + c * 0.25, -1);
        left.set(-0.2, 0.25 - c * 0.25, -1);
        break;
      }
      case 'air':
        // Arms spread a little for balance when flying fast.
        right.set(0.3 + sway * 0.4, -0.45 + sway * 0.15, -1);
        left.set(-0.3 - sway * 0.4, -0.45 + sway * 0.15, -1);
        break;
      default:
        break;
    }

    // Thwip: left arm snaps out toward where the web went, then returns.
    const punching = pose.thwipAge < 0.25;
    if (punching) toward(this.left, pose.thwipPoint, left);
    this.leftPunch += ((punching ? 1 : 0) - this.leftPunch) * Math.min(1, dt * (punching ? 30 : 10));

    // Keep each arm on its own side and in front of the camera, so a reach
    // toward a web point high overhead never sweeps across the view.
    keepInView(right.normalize(), 1);
    keepInView(left.normalize(), -1);
    this.aim(this.right, right, dt);
    this.aim(this.left, left, dt);
    // Punch: shoulder lunges forward.
    this.left.position.z = -0.22 - this.leftPunch * 0.15;
  }

  /** Smoothly rotate a shoulder so its arm points along dir (camera space). */
  private aim(shoulder: THREE.Group, dir: THREE.Vector3, dt: number): void {
    _q.setFromUnitVectors(FORWARD, dir);
    shoulder.quaternion.slerp(_q, Math.min(1, dt * 18));
  }
}

/** Clamp an arm direction (camera space) to its side of the screen, forward, and not too high. */
function keepInView(dir: THREE.Vector3, side: number): void {
  dir.x = side > 0 ? Math.max(dir.x, 0.12) : Math.min(dir.x, -0.12);
  dir.y = Math.min(dir.y, 0.5);
  dir.z = Math.min(dir.z, -0.55);
  dir.normalize();
}
