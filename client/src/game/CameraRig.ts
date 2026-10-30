import * as THREE from 'three';
import { CAMERA_FX, type Box, type CityCollider } from '@game/shared';

export type ViewMode = 'third' | 'first';

/** Third person looks this far above the hero's head, so they sit lower on screen. */
const FRAME_ABOVE = 1.8;
/** Eye height above the feet in first person. */
const EYE = 1.65;

/**
 * Third- or first-person camera with game feel: shake (from impacts plus a
 * speed rumble), lag behind sudden acceleration, and a speed-based FOV.
 */
export class CameraRig {
  yaw = 0;
  /** Positive = looking down (third person: camera above the player). */
  pitch = 0.3;
  /** Radians per pixel of mouse movement. */
  sensitivity = 0.003;
  mode: ViewMode = 'third';

  private dist = 6;
  /** Actual distance after wall checks; eases back out so the camera doesn't pop. */
  private shownDist = 6;
  private readonly focus = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly floorBoxes: Box[] = [];

  // Feel.
  private trauma = 0;
  private time = 0;
  private readonly lastVel = new THREE.Vector3();
  private readonly accel = new THREE.Vector3();
  private readonly lag = new THREE.Vector3();
  private fovKick = 0;
  private readonly look = new THREE.Vector3();
  private readonly shake = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly collider: CityCollider,
  ) {}

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * this.sensitivity, ...this.pitchLimits());
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.pitch = THREE.MathUtils.clamp(mode === 'first' ? 0 : 0.3, ...this.pitchLimits());
  }

  private pitchLimits(): [number, number] {
    return this.mode === 'first' ? [-1.45, 1.45] : [-0.35, 1.3];
  }

  /** Add camera shake (0..1). Big moments add more. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(target: THREE.Vector3, vel: THREE.Vector3, dt: number): void {
    if (dt <= 0) return;
    this.time += dt;
    const speed = vel.length();
    const F = CAMERA_FX;

    // Acceleration (smoothed): drives camera lag and the FOV kick.
    this.accel.subVectors(vel, this.lastVel).divideScalar(dt);
    this.lastVel.copy(vel);
    const forwardAccel = speed > 1 ? this.accel.dot(vel) / speed : 0;
    this.fovKick += (THREE.MathUtils.clamp(forwardAccel * F.fovKickPerAccel, 0, F.fovKickMax) - this.fovKick) * Math.min(1, dt * (forwardAccel > 0 ? 10 : 3));
    // Camera trails behind sudden pushes, then catches up.
    this.lag.lerp(this.accel.multiplyScalar(-F.lagPerAccel).clampLength(0, F.lagMax), Math.min(1, dt * 6));

    if (this.mode === 'first') this.updateFirstPerson(target);
    else this.updateThirdPerson(target, speed, dt);

    this.applyShake(speed, dt);

    const fov = F.fov + THREE.MathUtils.clamp(speed / 35, 0, 1) * F.fovSpeedExtra + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }
  }

  private updateFirstPerson(target: THREE.Vector3): void {
    // Eyes in the head; a little of the G-force lag as head movement.
    this.camera.position.set(target.x, target.y + EYE, target.z).addScaledVector(this.lag, 0.15);
    const lp = -this.pitch;
    this.look.set(-Math.sin(this.yaw) * Math.cos(lp), Math.sin(lp), -Math.cos(this.yaw) * Math.cos(lp));
    this.camera.lookAt(this.look.add(this.camera.position));
  }

  private updateThirdPerson(target: THREE.Vector3, speed: number, dt: number): void {
    const wantDist = 6 + THREE.MathUtils.clamp(speed / 30, 0, 1) * 3;
    this.dist += (wantDist - this.dist) * Math.min(1, dt * 4);

    this.focus.set(target.x, target.y + 1.6, target.z);
    const cp = Math.cos(this.pitch);
    this.offset.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);

    // Looking up (camera below the player): the camera would dig into the
    // roof/street you're standing on. Instead, keep its horizontal distance
    // and let it slide along that surface.
    const lookingUp = this.offset.y < 0;
    if (lookingUp) this.offset.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // Don't let buildings get between the camera and the player.
    const reach = lookingUp ? this.dist * cp : this.dist;
    const hit = this.collider.raycast(
      this.focus.x, this.focus.y, this.focus.z,
      this.offset.x, this.offset.y, this.offset.z,
      reach,
    );
    const allowed = hit !== null ? Math.max(0.5, hit - 0.3) : reach;
    // Pull in instantly (never see through walls), ease back out smoothly.
    this.shownDist = allowed < this.shownDist ? allowed : this.shownDist + (allowed - this.shownDist) * Math.min(1, dt * 5);
    const d = this.shownDist;

    this.camera.position.copy(this.focus).addScaledVector(this.offset, d);
    if (lookingUp) {
      const wantY = this.focus.y + Math.sin(this.pitch) * this.dist;
      const floor = this.floorAt(this.camera.position.x, this.camera.position.z, target.y + 0.1);
      this.camera.position.y = Math.max(wantY, floor + 0.3);
    } else {
      this.camera.position.y = Math.max(this.camera.position.y, 0.3);
    }
    // G-force lag: only when there's room (no wall right behind us).
    if (d > 2) this.camera.position.add(this.lag);
    // Frame the hero a little low, with more of the city (and web points) above.
    this.camera.lookAt(this.focus.x, this.focus.y + FRAME_ABOVE, this.focus.z);
  }

  /** Smooth noise shake: impacts (trauma) plus a constant rumble at high speed. */
  private applyShake(speed: number, dt: number): void {
    const F = CAMERA_FX;
    this.trauma = Math.max(0, this.trauma - F.shakeDecay * dt);
    const rumble = THREE.MathUtils.clamp((speed - F.rumbleFrom) / F.rumbleRange, 0, 1) * F.rumbleMax;
    const t = Math.max(this.trauma, rumble);
    if (t <= 0.001) return;
    const amt = t * t; // squared: small shakes stay subtle, big ones hit hard
    const k = this.time * 22;
    const n = (a: number, b: number) => Math.sin(k * a + b) * 0.6 + Math.sin(k * a * 2.3 + b * 1.7) * 0.4;
    this.shake.set(n(1.0, 0.0), n(1.13, 2.1), 0).multiplyScalar(F.shakeMove * amt);
    // Move in camera space (sideways/up), then add a little roll.
    this.camera.translateX(this.shake.x);
    this.camera.translateY(this.shake.y);
    this.camera.rotateZ(n(0.87, 4.2) * F.shakeRoll * amt);
  }

  /** Height of the highest surface under (x, z) that's not above maxY (0 = street). */
  private floorAt(x: number, z: number, maxY: number): number {
    let top = 0;
    for (const b of this.collider.query(x - 0.1, -1, z - 0.1, x + 0.1, maxY, z + 0.1, this.floorBoxes)) {
      if (b.maxY <= maxY && b.maxY > top) top = b.maxY;
    }
    return top;
  }
}
