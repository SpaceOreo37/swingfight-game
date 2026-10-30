import * as THREE from 'three';
import { DRAG_K, LAUNCH, PHYS, SWING, THWIP, WALL, launchPower, type Box, type CityCollider } from '@game/shared';

export type MoveState = 'ground' | 'air' | 'swing' | 'wall' | 'charge' | 'zip';

export interface StepInput {
  /** -1..1, right is positive. */
  moveX: number;
  /** -1..1, forward is positive. */
  moveZ: number;
  sprint: boolean;
  jumpPressed: boolean;
  swingHeld: boolean;
  /** True on the step the swing button was pressed (fires immediately). */
  swingPressed: boolean;
  /** Camera yaw, so movement is relative to where you're looking. */
  camYaw: number;
  /** Camera pitch (positive = camera above, looking down). */
  camPitch: number;
  /** Anchor key (C) held: changes what a web click does (launch / zip). */
  anchorHeld: boolean;
  /** True on the step the thwip button was pressed. */
  thwipPressed: boolean;
  /** Unit vector the camera is looking along (used by thwip). */
  aimDir: THREE.Vector3;
}

const _boxes: Box[] = [];
const _aimBoxes: Box[] = [];
const _wish = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ideal = new THREE.Vector3();
const _cand = new THREE.Vector3();
const _best = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _n = new THREE.Vector3();
const _lookDir = new THREE.Vector3(0, 0, -1);
const _target = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Player movement on a fixed timestep. Each movement mode is a state;
 * wall-running, zipping, etc. will be added as more states.
 */
export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  state: MoveState = 'air';
  /** Direction the character faces (radians, 0 = -Z). */
  yaw = 0;

  /** Where a web would stick if fired now (what the marker shows). */
  readonly target = new THREE.Vector3();
  hasTarget = false;

  /** Where the current web is stuck (valid while swinging). */
  readonly anchor = new THREE.Vector3();
  /** The point we swing around: the anchor, with the sideways assist applied. */
  readonly pivot = new THREE.Vector3();
  ropeLength = 0;
  /** Swings in a row without touching the ground. */
  chain = 0;
  /** 0..1 timing of the last release (1 = perfect). Shown in the HUD. */
  lastReleaseQuality = 0;
  /** Where the last thwip web hit (for drawing) and how long ago it fired. */
  readonly thwipPoint = new THREE.Vector3();
  thwipAge = Infinity;
  /** Increments on every thwip (the network sends an event when it changes). */
  thwipCount = 0;
  private thwipCooldown = 0;

  /** Normal of the wall you're on (valid while state === 'wall'). Points away from the wall. */
  readonly wallNormal = new THREE.Vector3();

  private onGround = false;
  private hitWall = false;
  /** Normal of the last wall touched during the move. */
  private readonly contactNormal = new THREE.Vector3();
  /** Velocity before collisions zeroed it (to know how hard we hit a wall). */
  private readonly preMoveVel = new THREE.Vector3();
  private wallCooldown = 0;

  /**
   * Impact "jolts" since the camera last read them (0..~1 each): web catches,
   * launches, thwips, wall hits, hard landings. The camera turns them into shake.
   */
  jolt = 0;
  private webWasTaut = false;

  /** Seconds the launch has been charging (valid while state === 'charge'). */
  chargeTime = 0;
  /** Number of point launches (for tests / stats). */
  pointLaunches = 0;
  /** Power (0..1) of the last launch, for the HUD. */
  lastLaunchPower = 0;
  /** The building the marker is on, and whether it's on that building's roof edge. */
  private targetBox: Box | null = null;
  private targetOnRoof = false;
  private candBox: Box | null = null;
  private candRoof = false;
  // Zip-to-point.
  private readonly zipDest = new THREE.Vector3();
  private readonly zipNormal = new THREE.Vector3();
  private zipLand = false;
  /** Space was pressed during this zip: launch off the edge on arrival. */
  private zipLaunchQueued = false;
  private zipTime = 0;
  /** Set on a swing press; fires as soon as you're airborne with a target. */
  private firePending = false;
  private swingCooldown = 0;
  private reeled = 0;
  private startLength = 0;

  constructor(
    private readonly collider: CityCollider,
    private readonly boundsX: number,
    private readonly boundsZ: number,
  ) {}

  /** Touching a building's side this step (wall-running will use this). */
  get touchingWall(): boolean {
    return this.hitWall;
  }

  teleport(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.state = 'air';
  }

  step(inp: StepInput, dt: number): void {
    this.prevPos.copy(this.pos);
    this.swingCooldown = Math.max(0, this.swingCooldown - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);

    // Input direction in world space, relative to the camera.
    const s = Math.sin(inp.camYaw);
    const c = Math.cos(inp.camYaw);
    _wish.set(-s * inp.moveZ + c * inp.moveX, 0, -c * inp.moveZ - s * inp.moveX);
    if (_wish.lengthSq() > 1) _wish.normalize();

    this.updateTarget(inp);

    this.thwipCooldown = Math.max(0, this.thwipCooldown - dt);
    this.thwipAge += dt;
    if (inp.thwipPressed && this.thwipCooldown === 0) this.thwip(inp.aimDir);

    if (this.state === 'swing' && !inp.swingHeld) this.releaseSwing(false);
    // Webs only fire in the air: jump first, then swing. A fresh press fires
    // right away; holding chains the next web once you stop rising.
    // One web per click. Webs only fire in the air: press while airborne, or
    // hold the button and jump, and it fires the moment you leave the ground.
    if (inp.swingPressed) this.firePending = true;
    if (!inp.swingHeld) this.firePending = false;
    const airborne = this.state === 'air' || this.state === 'wall'; // you can swing off a wall
    if (this.firePending && this.hasTarget && inp.anchorHeld && this.state === 'ground') {
      // C + web on the ground: plant the web and start charging a launch.
      this.firePending = false;
      this.anchor.copy(this.target);
      this.chargeTime = 0;
      this.state = 'charge';
    } else if (this.firePending && airborne && this.swingCooldown === 0 && this.hasTarget) {
      this.firePending = false;
      if (this.state === 'wall') this.wallCooldown = WALL.cooldown;
      if (inp.anchorHeld) this.startZip(); // C + web in the air: zip to the point
      else this.attach();
    }

    if (this.state === 'charge') {
      this.chargeStep(inp, dt);
    } else if (this.state === 'zip') {
      this.zipStep(inp, dt);
    } else if (this.state === 'swing') {
      this.swingStep(inp, dt);
    } else if (this.state === 'wall') {
      this.wallStep(inp, dt);
    } else {
      const wasGround = this.state === 'ground';
      if (this.state === 'ground') this.groundMove(inp, dt);
      else {
        this.airMove(dt);
        this.applyDrag(dt);
      }
      const rising = this.state === 'air' && this.vel.y > 0;
      this.vel.y -= PHYS.gravity * (rising ? PHYS.riseGravityScale : 1) * dt;
      this.move(dt);
      if (this.onGround && this.state === 'air' && this.preMoveVel.y < -14) this.jolt += Math.min(0.7, -this.preMoveVel.y / 45);
      this.state = this.onGround ? 'ground' : 'air';
      if (this.hitWall && this.wallCooldown === 0 && this.wantsWall(wasGround)) this.enterWall();
    }
    if (this.state === 'ground') this.chain = 0;

    // Body faces where the mouse is looking (or the wall you're on).
    const target = this.state === 'wall' ? Math.atan2(this.wallNormal.x, this.wallNormal.z) : inp.camYaw;
    let diff = target - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yaw += diff * Math.min(1, dt * 16);
  }

  // ---------------------------------------------------------------- ground / air

  private groundMove(inp: StepInput, dt: number): void {
    const speed = inp.sprint ? PHYS.sprintSpeed : PHYS.runSpeed;
    const tx = _wish.x * speed;
    const tz = _wish.z * speed;
    const rate = (_wish.lengthSq() > 0.01 ? PHYS.groundAccel : PHYS.groundFriction) * dt;
    const dx = tx - this.vel.x;
    const dz = tz - this.vel.z;
    const len = Math.hypot(dx, dz);
    if (len <= rate) {
      this.vel.x = tx;
      this.vel.z = tz;
    } else {
      this.vel.x += (dx / len) * rate;
      this.vel.z += (dz / len) * rate;
    }

    if (inp.jumpPressed) {
      this.vel.y = inp.sprint ? PHYS.sprintJumpSpeed : PHYS.jumpSpeed;
      this.state = 'air';
    }
  }

  private airMove(dt: number): void {
    // Only add speed in the wished direction up to a cap: you can nudge
    // yourself in the air but can't build speed from nothing.
    if (_wish.lengthSq() < 0.01) return;
    const current = this.vel.x * _wish.x + this.vel.z * _wish.z;
    const add = Math.min(Math.max(PHYS.airMaxSpeed - current, 0), PHYS.airAccel * dt);
    this.vel.x += _wish.x * add;
    this.vel.z += _wish.z * add;
  }

  /** Quadratic air resistance: a = -k * |v| * v. */
  private applyDrag(dt: number): void {
    const speed = this.vel.length();
    this.vel.multiplyScalar(1 / (1 + DRAG_K * speed * dt));
  }

  // ---------------------------------------------------------------- aiming

  /**
   * Finds the web point the marker shows: the building edge or corner closest
   * to a spot ahead of and above the player, in the direction you're looking
   * (blended with where you're moving when you're fast).
   */
  private updateTarget(inp: StepInput): void {
    const lookX = -Math.sin(inp.camYaw);
    const lookZ = -Math.cos(inp.camYaw);
    _lookDir.set(lookX, 0, lookZ);
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const w = Math.min(SWING.travelWeight, hSpeed / 40); // weight of travel direction vs. look
    if (hSpeed > 1) {
      _dir.set(
        lookX * (1 - w) + (this.vel.x / hSpeed) * w,
        0,
        lookZ * (1 - w) + (this.vel.z / hSpeed) * w,
      );
    } else _dir.set(lookX, 0, lookZ);
    _dir.normalize();

    const speed = this.vel.length();
    const lookUp = THREE.MathUtils.clamp(0.3 - inp.camPitch, -0.5, 1); // camera low = looking up

    // Slow: a spot ahead of and above you, where you're looking.
    _ideal.copy(this.pos).addScaledVector(_dir, SWING.ahead);
    _ideal.y += SWING.up + lookUp * SWING.lookRange;

    // Moving: a spot at a right angle to your velocity, so the web is tight the
    // instant it attaches (no slack, no jolt). Overhead at the top of a jump,
    // ahead-and-up while diving.
    if (speed > 3) {
      const forward = Math.max(0.1, this.vel.x * _dir.x + this.vel.z * _dir.z);
      const m = Math.hypot(forward, this.vel.y);
      let fwd = -this.vel.y / m;
      let up = forward / m;
      up = Math.max(up + lookUp * 0.3, SWING.minUpTilt);
      fwd = Math.max(fwd, 0.15);
      const k = 1 / Math.hypot(fwd, up);
      const L = SWING.ropeLength + speed * SWING.ropePerSpeed;
      _cand.copy(this.pos).addScaledVector(_dir, fwd * k * L);
      _cand.y += up * k * L;
      _ideal.lerp(_cand, THREE.MathUtils.clamp((speed - 3) / 12, 0, 1));
    }

    const r = SWING.searchRadius;
    this.collider.query(
      _ideal.x - r, this.pos.y + SWING.minAnchorHeight, _ideal.z - r,
      _ideal.x + r, _ideal.y + r, _ideal.z + r,
      _aimBoxes,
    );

    let bestScore = Infinity;
    const had = this.hasTarget;
    const consider = () => {
      if (_cand.y < this.pos.y + SWING.minAnchorHeight) return;
      _tmp.subVectors(_cand, this.pos);
      const d = _tmp.length();
      if (d < SWING.minDist || d > SWING.maxDist) return;
      if (_tmp.x * _dir.x + _tmp.z * _dir.z < 0) return; // behind
      let score = _cand.distanceToSquared(_ideal);
      if (had && _cand.distanceToSquared(this.target) < 1) score *= SWING.stickiness;
      if (score >= bestScore) return;
      // Must be able to see it: no building in the way.
      _tmp.divideScalar(d);
      const hit = this.collider.raycast(this.pos.x, this.pos.y, this.pos.z, _tmp.x, _tmp.y, _tmp.z, d);
      if (hit !== null && hit < d - 1) return;
      bestScore = score;
      _best.copy(_cand);
      this.targetBox = this.candBox;
      this.targetOnRoof = this.candRoof;
    };

    for (const b of _aimBoxes) {
      if (b.maxY - b.minY < 3) continue; // curbs
      const cx = THREE.MathUtils.clamp(_ideal.x, b.minX, b.maxX);
      const cy = THREE.MathUtils.clamp(_ideal.y, b.minY, b.maxY);
      const cz = THREE.MathUtils.clamp(_ideal.z, b.minZ, b.maxZ);
      this.candBox = b;
      // Roof edges (4)...
      this.candRoof = true;
      _cand.set(cx, b.maxY, b.minZ); consider();
      _cand.set(cx, b.maxY, b.maxZ); consider();
      _cand.set(b.minX, b.maxY, cz); consider();
      _cand.set(b.maxX, b.maxY, cz); consider();
      // ...and corner edges running up the building (4).
      this.candRoof = cy >= b.maxY - 0.01;
      _cand.set(b.minX, cy, b.minZ); consider();
      _cand.set(b.maxX, cy, b.minZ); consider();
      _cand.set(b.minX, cy, b.maxZ); consider();
      _cand.set(b.maxX, cy, b.maxZ); consider();
    }

    this.hasTarget = bestScore !== Infinity;
    if (this.hasTarget) this.target.copy(_best);
  }

  // ---------------------------------------------------------------- thwip

  /**
   * Quick web toward where you're looking: you keep your speed (plus a bit)
   * but it all points the way you aimed. Cancels a swing.
   */
  private thwip(aim: THREE.Vector3): void {
    _dir.copy(aim).normalize();
    // On the ground, aiming flat or down would just skid: give it some lift.
    if (this.state === 'ground' && _dir.y < 0.2) {
      _dir.y = 0.2;
      _dir.normalize();
    }
    const speed = Math.max(this.vel.length() + THWIP.boost, THWIP.minSpeed);
    this.vel.copy(_dir).multiplyScalar(speed);
    if (this.state === 'swing') this.swingCooldown = SWING.cooldown;
    if (this.state === 'wall') this.wallCooldown = WALL.cooldown;
    this.state = 'air';
    this.thwipCooldown = THWIP.cooldown;
    this.thwipAge = 0;
    this.thwipCount++;
    this.jolt += 0.3;

    // Where the strand lands: the first building along the aim, or just far out.
    const hit = this.collider.raycast(this.pos.x, this.pos.y + 1.5, this.pos.z, _dir.x, _dir.y, _dir.z, THWIP.reach);
    this.thwipPoint.copy(this.pos).addScaledVector(_dir, hit ?? THWIP.reach);
    this.thwipPoint.y += 1.5;
  }

  // ---------------------------------------------------------------- swinging

  private attach(): void {
    this.anchor.copy(this.target);

    // Swing assist: shrink the anchor's sideways offset, measured from where
    // you're LOOKING. Look down the street: side webs barely pull you sideways.
    // Look down a side street: the corner web is "ahead" and swings you round.
    const sideX = -_lookDir.z;
    const sideZ = _lookDir.x;
    _tmp.subVectors(this.anchor, this.pos);
    const cut = (_tmp.x * sideX + _tmp.z * sideZ) * (1 - SWING.lateralPull);
    this.pivot.set(this.anchor.x - sideX * cut, this.anchor.y, this.anchor.z - sideZ * cut);

    this.ropeLength = this.pos.distanceTo(this.pivot);
    this.startLength = this.ropeLength;
    this.reeled = 0;
    this.chain++;
    this.state = 'swing';
    // The web snaps tight: a short tug toward the anchor.
    _tmp.subVectors(this.pivot, this.pos).normalize();
    this.vel.addScaledVector(_tmp, SWING.attachTug);
    this.webWasTaut = false;
    this.jolt += 0.15;
  }

  private swingStep(inp: StepInput, dt: number): void {
    const v = this.vel;

    _n.subVectors(this.pos, this.pivot);
    const d = _n.length();
    _n.divideScalar(d);
    const radialVel = v.dot(_n); // + = moving away from the anchor

    // Pull the web in near the bottom of the arc (like pumping a swing),
    // and always enough to keep the arc off the street.
    const taut = d >= this.ropeLength;
    let newLength = this.ropeLength;
    const belowness = -_n.y; // 1 = straight below the anchor
    if (taut && belowness > SWING.reelZone && this.reeled < this.startLength * this.reelLimit()) {
      newLength -= SWING.reelSpeed * dt;
    }
    // Account for stretch so the arc's lowest point still clears the street.
    const safeLength = (this.pivot.y - SWING.groundClearance) / (1 + SWING.maxStretch);
    if (newLength > safeLength) newLength = Math.max(safeLength, this.ropeLength - SWING.reelSpeed * 2 * dt);
    newLength = Math.max(SWING.minRope, newLength);
    this.reeled += this.ropeLength - newLength;
    this.ropeLength = newLength;

    // Forces: gravity, air drag, a little body steering, and web tension.
    v.y -= PHYS.gravity * dt;
    this.applyDrag(dt);
    v.addScaledVector(_wish, SWING.steer * dt);

    // The web is elastic (Hooke's law + damping). It only pulls, never pushes,
    // and goes slack when shorter than its length. Tension always points at the
    // anchor, so angular momentum is conserved: pulling the web in spins you faster.
    const stretch = d - this.ropeLength;
    // Web going from slack to tight while you're flying outward: a jolt.
    if (stretch > 0 && !this.webWasTaut && radialVel > 4) this.jolt += Math.min(0.6, radialVel / 25);
    this.webWasTaut = stretch > 0;
    if (stretch > 0) {
      const tension = Math.max(0, SWING.webStiffness * stretch + SWING.webDamping * radialVel);
      v.addScaledVector(_n, -tension * dt);
    }

    this.move(dt);

    // Webs can only stretch so far.
    _n.subVectors(this.pos, this.pivot);
    const d2 = _n.length();
    const maxLen = this.ropeLength * (1 + SWING.maxStretch);
    if (d2 > maxLen) {
      _n.divideScalar(d2);
      this.pos.copy(this.pivot).addScaledVector(_n, maxLen);
      const outward = v.dot(_n);
      if (outward > 0) v.addScaledVector(_n, -outward);
    }
    const speed = v.length();
    if (speed > SWING.maxSpeed) v.multiplyScalar(SWING.maxSpeed / speed);

    // The web stays on until you let go of the button (handled in step()).
    // Keep holding past the top and you swing back like a real pendulum.
    if (inp.jumpPressed) this.releaseSwing(true);
    else if (this.onGround) this.state = 'ground'; // landed: web drops
    else if (this.hitWall) this.enterWall(); // swung into a building: run up it
  }

  /** Fraction of the web pulled in this swing: grows with the swing chain. */
  private reelLimit(): number {
    return SWING.reelFraction + Math.min(this.chain - 1, SWING.chainBonusMax) * SWING.chainBonus;
  }

  /**
   * 0..1: how close this release is to the sweet spot on the upswing
   * (in front of the anchor, moving up, ~35 degrees past straight down).
   */
  private releaseQuality(): number {
    _tmp.subVectors(this.pos, this.pivot);
    const ahead = _tmp.x * this.vel.x + _tmp.z * this.vel.z > 0;
    if (!ahead || this.vel.y <= 0) return 0;
    const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(-_tmp.y / _tmp.length(), -1, 1)));
    return Math.max(0, 1 - Math.abs(angle - SWING.perfectReleaseAngle) / SWING.releaseWindow);
  }

  /** Let go. You keep exactly the velocity you had (momentum), plus a timing boost. */
  private releaseSwing(yank: boolean): void {
    this.lastReleaseQuality = this.releaseQuality();
    this.jolt += 0.12 * this.lastReleaseQuality;
    if (this.lastReleaseQuality > 0) {
      const speed = this.vel.length();
      this.vel.multiplyScalar((speed + SWING.releaseBoost * this.lastReleaseQuality) / speed);
    }
    if (yank) {
      // One hard pull on the web before letting go: velocity toward the anchor.
      _tmp.subVectors(this.pivot, this.pos).normalize();
      this.vel.addScaledVector(_tmp, SWING.yankSpeed);
    }
    this.state = 'air';
    this.swingCooldown = SWING.cooldown;
  }

  // ---------------------------------------------------------------- anchor key: launch & zip

  /** Charging a launch on the ground: stand still, web planted, until either button is let go. */
  private chargeStep(inp: StepInput, dt: number): void {
    this.chargeTime += dt;
    const v = this.vel;
    const rate = PHYS.groundFriction * dt;
    const h = Math.hypot(v.x, v.z);
    if (h <= rate) v.x = v.z = 0;
    else v.multiplyScalar((h - rate) / h);
    v.y -= PHYS.gravity * dt;
    this.move(dt);
    if (!inp.swingHeld || !inp.anchorHeld) this.launch();
    else if (!this.onGround) this.state = 'air'; // knocked off the ground: cancel
  }

  /** Fire the charged launch: mostly up, leaning a little toward the web point. */
  private launch(): void {
    const power = launchPower(this.chargeTime);
    _tmp.subVectors(this.anchor, this.pos).setY(0);
    if (_tmp.lengthSq() > 0.01) _tmp.normalize().multiplyScalar(LAUNCH.sideways);
    _tmp.y = 1;
    _tmp.normalize();
    this.vel.copy(_tmp).multiplyScalar(Math.max(LAUNCH.minSpeed, LAUNCH.maxSpeed * power));
    this.lastLaunchPower = power;
    this.jolt += 0.25 + 0.5 * power;
    this.chargeTime = 0;
    this.state = 'air';
    this.swingCooldown = SWING.cooldown;
    // Don't stick to the building you launched beside; slide up past it instead.
    this.wallCooldown = LAUNCH.noWallGrab;
  }

  /**
   * Zip to the marker point. On a roof edge: fly to just outside and above
   * the edge, then pop up onto the roof. On a corner partway up: fly there
   * and stick to the wall.
   */
  private startZip(): void {
    const b = this.targetBox;
    if (!b) return;
    const t = this.target;
    this.anchor.copy(t);

    // Which face of the building is the point on? Pick the one facing us.
    let best = -Infinity;
    const faces: [boolean, number, number][] = [
      [Math.abs(t.x - b.minX) < 0.01, -1, 0],
      [Math.abs(t.x - b.maxX) < 0.01, 1, 0],
      [Math.abs(t.z - b.minZ) < 0.01, 0, -1],
      [Math.abs(t.z - b.maxZ) < 0.01, 0, 1],
    ];
    for (const [on, nx, nz] of faces) {
      if (!on) continue;
      const facing = (this.pos.x - t.x) * nx + (this.pos.z - t.z) * nz;
      if (facing > best) {
        best = facing;
        this.zipNormal.set(nx, 0, nz);
      }
    }
    if (best === -Infinity) return;

    this.zipLand = this.targetOnRoof;
    if (this.zipLand) {
      // Just outside and above the edge, then pop over it.
      this.zipDest.copy(t).addScaledVector(this.zipNormal, PHYS.radius + 0.6);
      this.zipDest.y += 1;
    } else {
      // Touching the wall, hands at the point, feet below. Shift a little
      // along the wall, off the corner, so you're fully on one face.
      this.zipDest.copy(t).addScaledVector(this.zipNormal, PHYS.radius - 0.05);
      this.zipDest.y -= 1.6;
      const shift = PHYS.radius + 0.3;
      if (this.zipNormal.x !== 0) this.zipDest.z += Math.sign((b.minZ + b.maxZ) / 2 - t.z) * shift;
      else this.zipDest.x += Math.sign((b.minX + b.maxX) / 2 - t.x) * shift;
    }
    this.zipTime = 0;
    this.zipLaunchQueued = false;
    this.state = 'zip';
  }

  private zipStep(inp: StepInput, dt: number): void {
    this.zipTime += dt;
    // Space at any point during a zip to an edge = point launch on arrival.
    if (inp.jumpPressed && this.zipLand) this.zipLaunchQueued = true;
    _tmp.subVectors(this.zipDest, this.pos);
    const d = _tmp.length();
    if (d < 0.8 || this.zipTime > LAUNCH.zipMaxTime) {
      this.finishZip();
      return;
    }
    this.vel.copy(_tmp).multiplyScalar(Math.min(LAUNCH.zipSpeed, d / dt) / d);
    this.move(dt);
    // Something in the way (another wall): stick to it.
    if (this.hitWall && d > 2) this.enterWall();
    else if (this.onGround && d > 2) this.state = 'ground';
  }

  private finishZip(): void {
    const n = this.zipNormal;
    this.jolt += 0.25;
    if (this.zipLand && this.zipLaunchQueued) {
      // Point launch: fling up and onward the way we were zipping (over the edge).
      let fx = this.vel.x;
      let fz = this.vel.z;
      const h = Math.hypot(fx, fz);
      if (h > 3) {
        fx /= h;
        fz /= h;
      } else {
        fx = -n.x;
        fz = -n.z;
      }
      this.vel.set(fx * LAUNCH.pointLaunchForward, LAUNCH.pointLaunchUp, fz * LAUNCH.pointLaunchForward);
      this.state = 'air';
      this.wallCooldown = LAUNCH.noWallGrab;
      this.jolt += 0.45;
      this.pointLaunches++;
    } else if (this.zipLand) {
      // Pop up and over the edge onto the roof.
      this.vel.set(-n.x * LAUNCH.zipPopIn, LAUNCH.zipPopUp, -n.z * LAUNCH.zipPopIn);
      this.state = 'air';
    } else {
      // Snap the last few centimeters so we're actually touching the wall.
      if (this.pos.distanceTo(this.zipDest) < 1.5) this.pos.copy(this.zipDest);
      this.vel.set(0, 0, 0);
      this.wallNormal.copy(n);
      this.state = 'wall';
    }
    this.swingCooldown = SWING.cooldown;
  }

  // ---------------------------------------------------------------- wall running

  /** Should touching this wall make us stick to it? */
  private wantsWall(fromGround: boolean): boolean {
    const n = this.contactNormal;
    const pushing = -(_wish.x * n.x + _wish.z * n.z); // 1 = pressing straight at the wall
    if (fromGround) return pushing > WALL.groundGrabInput;
    const impact = -(this.preMoveVel.x * n.x + this.preMoveVel.z * n.z);
    return pushing > WALL.grabInput || impact > WALL.grabSpeed;
  }

  /** Stick to the wall we just hit. The speed we hit it with turns into running up it. */
  private enterWall(): void {
    const n = this.contactNormal;
    this.wallNormal.copy(n);
    const v = this.vel.copy(this.preMoveVel);
    const into = Math.max(0, -v.dot(n));
    v.addScaledVector(n, v.dot(n) > 0 ? 0 : -v.dot(n)); // drop the into-wall part
    v.y += into * WALL.impactToUp;
    this.jolt += Math.min(0.6, into / 35);
    if (v.length() > WALL.maxEntrySpeed) v.setLength(WALL.maxEntrySpeed);
    this.state = 'wall';
  }

  private wallStep(inp: StepInput, dt: number): void {
    const n = this.wallNormal;
    const v = this.vel;
    // Along-wall direction (horizontal, perpendicular to the normal).
    const tx = n.z;
    const tz = -n.x;
    const toward = -(_wish.x * n.x + _wish.z * n.z); // + = pushing at the wall
    const along = _wish.x * tx + _wish.z * tz;

    if (inp.jumpPressed) {
      // Wall jump: off the wall and up, keeping some of the sideways run.
      const keep = v.x * tx + v.z * tz;
      v.set(0, 0, 0)
        .addScaledVector(n, WALL.jumpOut)
        .addScaledVector(UP, WALL.jumpUp);
      v.x += tx * keep * 0.6;
      v.z += tz * keep * 0.6;
      this.leaveWall();
      this.move(dt);
      return;
    }
    if (_wish.lengthSq() > 0.01 && toward < -0.5) {
      // Pulling away: let go.
      v.addScaledVector(n, 4);
      this.leaveWall();
      this.move(dt);
      return;
    }

    // Push toward the wall = climb up. Sideways = run along it. Nothing = slow slide.
    if (_wish.lengthSq() > 0.01) {
      const climb = inp.sprint ? WALL.sprintClimbSpeed : WALL.climbSpeed;
      const run = inp.sprint ? WALL.sprintRunSpeed : WALL.runSpeed;
      _target.set(tx * along * run, Math.max(0, toward) * climb, tz * along * run);
    } else {
      _target.set(0, -WALL.slideSpeed, 0);
    }
    // Ease toward the target, so the speed you arrived with carries for a moment.
    _tmp.subVectors(_target, v);
    const rate = WALL.accel * dt;
    if (_tmp.length() > rate) _tmp.setLength(rate);
    v.add(_tmp);
    v.addScaledVector(n, -2); // press into the wall to stay attached

    this.move(dt);

    if (this.onGround && v.y <= 0.1) {
      this.state = 'ground';
    } else if (!this.hitWall) {
      // Ran out of wall.
      if (v.y > 1) {
        // Top of the building: hop up and onto the roof.
        v.y = Math.max(v.y, WALL.vaultUp);
        v.addScaledVector(n, -WALL.vaultPush);
      }
      this.leaveWall();
    } else if (this.contactNormal.dot(n) < 0.9) {
      // Ran into an inside corner: carry on up the new wall.
      this.wallNormal.copy(this.contactNormal);
    }
  }

  private leaveWall(): void {
    this.state = 'air';
    this.wallCooldown = WALL.cooldown;
  }

  // ---------------------------------------------------------------- collision

  /** Moves in small sub-steps so fast movement can't tunnel through walls. */
  private move(dt: number): void {
    this.onGround = false;
    this.hitWall = false;
    this.preMoveVel.copy(this.vel);
    const steps = Math.min(12, Math.max(1, Math.ceil((this.vel.length() * dt) / 0.25)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.vel, sdt);
      this.resolveCollisions();
    }

    // Keep the player inside the city.
    if (Math.abs(this.pos.x) > this.boundsX) {
      this.pos.x = Math.sign(this.pos.x) * this.boundsX;
      this.vel.x = 0;
    }
    if (Math.abs(this.pos.z) > this.boundsZ) {
      this.pos.z = Math.sign(this.pos.z) * this.boundsZ;
      this.vel.z = 0;
    }
  }

  /** Pushes the player out of any overlapping box along the shallowest axis. */
  private resolveCollisions(): void {
    const r = PHYS.radius;
    const h = PHYS.height;
    const p = this.pos;
    const v = this.vel;

    this.collider.query(p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r, _boxes);
    for (const b of _boxes) {
      const ox1 = p.x + r - b.minX;
      const ox2 = b.maxX - (p.x - r);
      const oy1 = p.y + h - b.minY;
      const oy2 = b.maxY - p.y;
      const oz1 = p.z + r - b.minZ;
      const oz2 = b.maxZ - (p.z - r);
      if (ox1 <= 0 || ox2 <= 0 || oy1 <= 0 || oy2 <= 0 || oz1 <= 0 || oz2 <= 0) continue;

      // Small ledges (curbs) are stepped onto instead of blocking.
      if (oy2 <= PHYS.stepHeight && v.y <= 0.5) {
        p.y = b.maxY;
        if (v.y < 0) v.y = 0;
        this.onGround = true;
        continue;
      }

      const m = Math.min(ox1, ox2, oy1, oy2, oz1, oz2);
      if (m === oy2) {
        p.y = b.maxY;
        if (v.y < 0) v.y = 0;
        this.onGround = true;
      } else if (m === oy1) {
        p.y = b.minY - h;
        if (v.y > 0) v.y = 0;
      } else if (m === ox1) {
        p.x = b.minX - r;
        this.hitWall = true;
        this.contactNormal.set(-1, 0, 0);
        if (v.x > 0) v.x = 0;
      } else if (m === ox2) {
        p.x = b.maxX + r;
        this.hitWall = true;
        this.contactNormal.set(1, 0, 0);
        if (v.x < 0) v.x = 0;
      } else if (m === oz1) {
        p.z = b.minZ - r;
        this.hitWall = true;
        this.contactNormal.set(0, 0, -1);
        if (v.z > 0) v.z = 0;
      } else {
        p.z = b.maxZ + r;
        this.hitWall = true;
        this.contactNormal.set(0, 0, 1);
        if (v.z < 0) v.z = 0;
      }
    }

    // Street level.
    if (p.y <= 0) {
      p.y = 0;
      if (v.y < 0) v.y = 0;
      this.onGround = true;
    }
  }
}
