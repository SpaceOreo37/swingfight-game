import { NET_STATES, PHYS, type CityCollider, type HitFx, type NetState, type PlayerInfo, type ServerMessage, type Vec3 } from '@game/shared';
import { newCombatFields, recordHistory, type Actor } from './Actor';

export type BotPattern = 'stand' | 'patrol' | 'flyer';

const GROUND = NET_STATES.indexOf('ground');
const AIR = NET_STATES.indexOf('air');
/** After being hit, physics takes over for at least this long before the dummy walks home. */
const DISTURBED_MS = 1500;
const RETURN_SPEED = 12;

/**
 * Training dummy, simulated by the server. It shows up for clients exactly
 * like a player (same snapshots, health, hits), so everything you test on a
 * dummy works the same on friends.
 */
export class Bot implements Actor {
  readonly isBot = true;
  info: PlayerInfo;
  state: NetState | null = null;
  stateTime = 0;
  stateDirty = false;
  readonly history: { t: number; p: Vec3 }[] = [];

  hp: number;
  koUntil: number;
  protectUntil: number;
  downedUntil: number;
  readonly cooldowns: Map<string, number>;

  private readonly pos: Vec3;
  private readonly vel: Vec3 = [0, 0, 0];
  private disturbedUntil = 0;
  private t = 0;

  constructor(
    readonly id: string,
    name: string,
    private readonly home: Vec3,
    private readonly pattern: BotPattern,
    private readonly collider: CityCollider,
  ) {
    this.info = { id, name, color: 0x8a8f98, bot: true };
    this.pos = [...home];
    const c = newCombatFields();
    this.hp = c.hp;
    this.koUntil = c.koUntil;
    this.protectUntil = c.protectUntil;
    this.downedUntil = c.downedUntil;
    this.cooldowns = c.cooldowns;
  }

  send(_msg: ServerMessage): void {}

  applyFx(fx: HitFx, now: number): void {
    if (fx.imp) for (let k = 0; k < 3; k++) this.vel[k] += fx.imp[k];
    this.disturbedUntil = Math.max(this.disturbedUntil, now + Math.max(DISTURBED_MS, (fx.down ?? 0) * 1000));
  }

  /** Back to the starting spot (after a knockout). */
  reset(): void {
    this.pos[0] = this.home[0];
    this.pos[1] = this.home[1];
    this.pos[2] = this.home[2];
    this.vel.fill(0);
    this.disturbedUntil = 0;
  }

  update(now: number, dt: number): void {
    this.t += dt;
    const p = this.pos;
    const v = this.vel;
    const floor = this.floorAt(p[0], p[2], p[1] + 0.5);
    let onGround = p[1] <= floor + 0.01;

    if (now < this.disturbedUntil || (this.pattern !== 'flyer' && !onGround)) {
      // Knocked around: simple physics (gravity, ground, friction).
      v[1] -= PHYS.gravity * dt;
      for (let k = 0; k < 3; k++) p[k] += v[k] * dt;
      const f = this.floorAt(p[0], p[2], p[1] + 0.5);
      if (p[1] <= f) {
        // Yanked: hits the floor and stops dead (no sliding).
        if (!onGround && now < this.downedUntil) {
          v[0] = 0;
          v[2] = 0;
        }
        p[1] = f;
        if (v[1] < 0) v[1] = 0;
        const slow = Math.max(0, 1 - 8 * dt);
        v[0] *= slow;
        v[2] *= slow;
        onGround = true;
      } else onGround = false;
    } else {
      // Follow the pattern, walking/flying back to it first if knocked away.
      const target = this.patternPoint();
      const dx = target[0] - p[0];
      const dy = target[1] - p[1];
      const dz = target[2] - p[2];
      const d = Math.hypot(dx, dy, dz);
      const maxStep = (this.pattern === 'stand' && d < 0.05 ? 0 : RETURN_SPEED) * dt;
      if (d > maxStep && d > 0.05) {
        const s = maxStep / d;
        v[0] = (dx * s) / dt;
        v[1] = this.pattern === 'flyer' ? (dy * s) / dt : 0;
        v[2] = (dz * s) / dt;
      } else {
        v[0] = dx / dt;
        v[1] = this.pattern === 'flyer' ? dy / dt : 0;
        v[2] = dz / dt;
      }
      for (let k = 0; k < 3; k++) p[k] += v[k] * dt;
      if (this.pattern !== 'flyer') p[1] = this.floorAt(p[0], p[2], p[1] + 0.5);
    }

    const yaw = Math.hypot(v[0], v[2]) > 0.5 ? Math.atan2(-v[0], -v[2]) : this.state?.y ?? 0;
    this.state = {
      p: [p[0], p[1], p[2]],
      v: [v[0], v[1], v[2]],
      y: yaw,
      s: onGround ? GROUND : AIR,
    };
    this.stateTime = now;
    this.stateDirty = true;
    recordHistory(this, now);
  }

  /** Where the pattern wants the dummy right now. */
  private patternPoint(): Vec3 {
    const [hx, hy, hz] = this.home;
    switch (this.pattern) {
      case 'patrol':
        return [hx + Math.sin(this.t * 0.6) * 10, hy, hz];
      case 'flyer':
        return [hx + Math.cos(this.t * 0.5) * 22, hy + Math.sin(this.t * 1.1) * 4, hz + Math.sin(this.t * 0.5) * 22];
      default:
        return [hx, hy, hz];
    }
  }

  /** Highest surface under (x, z) that isn't above maxY (0 = street). */
  private floorAt(x: number, z: number, maxY: number): number {
    let top = 0;
    for (const b of this.collider.query(x - 0.3, -1, z - 0.3, x + 0.3, maxY, z + 0.3, [])) {
      if (b.maxY <= maxY && b.maxY > top) top = b.maxY;
    }
    return top;
  }
}
