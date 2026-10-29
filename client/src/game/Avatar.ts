import * as THREE from 'three';

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

/** Placeholder character built from primitives. Swap for a real model later. */
export class Avatar {
  readonly root = new THREE.Group();
  /** Holds the meshes, shifted down so the root sits at the body's center. */
  private readonly body = new THREE.Group();
  private readonly rightArm: THREE.Mesh;
  private readonly leftArm: THREE.Mesh;

  constructor(color: number) {
    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2433, roughness: 0.7 });
    this.body.position.y = -CENTER;
    this.root.add(this.body);

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.body.add(m);
      return m;
    };

    add(new THREE.CapsuleGeometry(0.28, 0.5, 4, 10), suit, 0, 1.15, 0); // torso
    add(new THREE.SphereGeometry(0.2, 16, 12), suit, 0, 1.68, 0); // head
    add(new THREE.BoxGeometry(0.26, 0.08, 0.06), dark, 0, 1.7, -0.18); // visor (faces -Z)
    const leg = new THREE.CapsuleGeometry(0.11, 0.55, 4, 8);
    add(leg, dark, -0.13, 0.42, 0);
    add(leg, dark, 0.13, 0.42, 0);

    // Arms pivot at the shoulder so they can be raised.
    const arm = new THREE.CapsuleGeometry(0.08, 0.5, 4, 8);
    arm.translate(0, -0.3, 0);
    this.leftArm = add(arm, suit, -0.38, 1.45, 0);
    this.rightArm = add(arm, suit, 0.38, 1.45, 0);
  }

  /**
   * @param ropeDir unit vector toward the web anchor while swinging, else null.
   * @param wallNormal normal of the wall while wall-running, else null.
   * @param charging crouched and upright (web arm up) while charging a launch.
   */
  update(
    pos: THREE.Vector3,
    yaw: number,
    ropeDir: THREE.Vector3 | null,
    wallNormal: THREE.Vector3 | null,
    vel: THREE.Vector3,
    dt: number,
    charging = false,
    thwipAge = Infinity,
  ): void {
    this.root.position.set(pos.x, pos.y + CENTER, pos.z);

    if (wallNormal) {
      // On a wall: belly to the wall, head pointing the way you're running.
      _bodyUp.copy(vel).addScaledVector(wallNormal, -vel.dot(wallNormal));
      if (_bodyUp.lengthSq() < 4) _bodyUp.copy(UP); // slow: stay upright
      _bodyUp.normalize();
      _back.copy(wallNormal); // model faces -Z, so +Z (its back) points away from the wall
      _right.crossVectors(_bodyUp, _back).normalize();
      _m.makeBasis(_right, _bodyUp, _back);
      _target.setFromRotationMatrix(_m);
    } else {
      // Lean the whole body along the web while swinging.
      _yawQ.setFromAxisAngle(UP, yaw);
      if (ropeDir && !charging) _tiltQ.setFromUnitVectors(UP, ropeDir);
      else _tiltQ.identity();
      _target.multiplyQuaternions(_tiltQ, _yawQ);
    }
    this.root.quaternion.slerp(_target, Math.min(1, dt * 12));

    // Crouch while charging a launch.
    const squash = charging ? 0.72 : 1;
    this.body.scale.y += (squash - this.body.scale.y) * Math.min(1, dt * 8);
    this.body.position.y = -CENTER * this.body.scale.y;

    // Web arm points up while swinging.
    const armTarget = ropeDir ? Math.PI : 0;
    this.rightArm.rotation.z += (armTarget - this.rightArm.rotation.z) * Math.min(1, dt * 15);
    // Thwip: left arm punches forward for a moment.
    const punch = thwipAge < 0.25 ? Math.PI / 2 : 0;
    this.leftArm.rotation.x += (punch - this.leftArm.rotation.x) * Math.min(1, dt * (punch ? 30 : 10));
  }
}
