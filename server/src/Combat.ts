import { COMBAT, type CityCollider, type ClientMessage, type GameMode, type HitFx, type HitKind, type ServerMessage, type Vec3 } from '@game/shared';
import { isAlive, positionAt, type Actor } from './Actor';

/** A web shot in flight. Lives at most shotRange / shotSpeed seconds (~1.4 s). */
interface Shot {
  sid: number;
  shooter: Actor;
  o: Vec3;
  d: Vec3;
  t0: number;
  /** Meters until it hits a building (or max range). */
  len: number;
  /** Meters traveled at the last tick. */
  traveled: number;
  /** How far back (ms) to rewind targets: what the shooter was seeing. */
  rewind: number;
}

/** Body as a vertical capsule: feet + this low/high, this radius. */
const BODY_LOW = 0.2;
const BODY_HIGH = 1.7;
const CHEST = 1.2;

let nextShotId = 1;

export interface CombatHost {
  actors(): Iterable<Actor>;
  find(id: string): Actor | undefined;
  broadcast(msg: ServerMessage): void;
}

/**
 * All combat rules for one room. The server decides every hit: shots are
 * simulated here, close-range actions are checked against where the target
 * actually was when the attacker saw it, and health lives here.
 */
export class Combat {
  private shots: Shot[] = [];
  // Tag mode.
  private it: string | null = null;
  private readonly tagScores = new Map<string, number>();
  private tagImmunity: { from: string; to: string; until: number } | null = null;
  private tagBroadcastAt = 0;

  constructor(
    private readonly host: CombatHost,
    private readonly collider: CityCollider,
    readonly mode: GameMode,
  ) {}

  get damageEnabled(): boolean {
    return this.mode !== 'tag' && this.mode !== 'race';
  }

  /** Races are about movement: no web shots or attacks. */
  private get combatAllowed(): boolean {
    return this.mode !== 'race';
  }

  get shotCount(): number {
    return this.shots.length;
  }

  // ---------------------------------------------------------------- input

  fire(a: Actor & { shotsInFlight?: number }, m: Extract<ClientMessage, { t: 'fire' }>, now: number): void {
    if (!this.combatAllowed || !isAlive(a, now) || !a.state || a.downedUntil > now) return;
    if (now - (a.cooldowns.get('shot') ?? -Infinity) < COMBAT.shotCooldownMs * 0.8) return;
    if ((a.shotsInFlight ?? 0) >= COMBAT.maxShotsInFlight) return;
    // The shot has to start near the shooter's hands.
    const p = a.state.p;
    if (Math.hypot(m.o[0] - p[0], m.o[1] - (p[1] + 1.5), m.o[2] - p[2]) > 6) return;
    a.cooldowns.set('shot', now);

    // Where it hits a building decides its whole life up front.
    const hit = this.collider.raycast(m.o[0], m.o[1], m.o[2], m.d[0], m.d[1], m.d[2], COMBAT.shotRange);
    const shot: Shot = {
      sid: nextShotId++,
      shooter: a,
      o: m.o,
      d: m.d,
      t0: now,
      len: hit ?? COMBAT.shotRange,
      traveled: 0,
      rewind: clamp(now - m.vt, 0, COMBAT.maxRewindMs),
    };
    this.shots.push(shot);
    if (a.shotsInFlight !== undefined) a.shotsInFlight++;
    this.host.broadcast({ t: 'shot', sid: shot.sid, by: a.id, c: m.c, o: m.o, d: m.d, len: shot.len, time: now });
  }

  act(a: Actor, m: Extract<ClientMessage, { t: 'act' }>, now: number): void {
    if (!this.combatAllowed) return;
    const target = this.host.find(m.target);
    if (!target || target === a || !isAlive(a, now) || !isAlive(target, now) || !a.state) return;
    // Downed (yanked to the floor): no attacking back.
    if (a.downedUntil > now) return;
    const at = clamp(m.vt, now - COMBAT.maxRewindMs, now);
    const tp = positionAt(target, at);
    if (!tp) return;
    const ap = a.state.p;
    const dist = Math.hypot(tp[0] - ap[0], tp[1] - ap[1], tp[2] - ap[2]);
    const cdKey = `${m.k}:${target.id}`;

    if (m.k === 'kick') {
      const speed = Math.hypot(...a.state.v);
      if (dist > COMBAT.kickRange + 1 || speed < COMBAT.kickMinSpeed * 0.8) return;
      if (!this.cooldownReady(a, cdKey, COMBAT.kickCooldownMs, now)) return;
      const dmg = Math.min(COMBAT.kickDamageMax, COMBAT.kickDamageBase + speed * COMBAT.kickDamagePerSpeed);
      // Knocked along the kicker's direction of travel, with a bit of lift.
      const v = a.state.v;
      this.hit(target, a, 'kick', dmg, { imp: [v[0] * 0.5, v[1] * 0.5 + 4, v[2] * 0.5] }, now);
      return;
    }
    if (m.k === 'strike') {
      if (dist > COMBAT.strikeRange + 1.5) return;
      if (!this.cooldownReady(a, cdKey, COMBAT.strikeCooldownMs, now)) return;
      const dir = norm([tp[0] - ap[0], 0, tp[2] - ap[2]]);
      // A strike on someone who's been yanked to the floor is a fatal slam.
      if (target.downedUntil > at) {
        this.hit(target, a, 'slam', COMBAT.slamDamage, { imp: [dir[0] * 6, -10, dir[2] * 6] }, now);
      } else {
        this.hit(target, a, 'strike', COMBAT.strikeDamage, { imp: [dir[0] * 14, 6, dir[2] * 14] }, now);
      }
      return;
    }
    if (m.k === 'yank') {
      if (dist > COMBAT.yankRange + 2) return;
      // Already down, or just got up: can't be yanked again yet.
      if (target.downedUntil + COMBAT.yankImmuneMs > now) return;
      // Need a clear line between the two (no yanking through buildings).
      const from: Vec3 = [ap[0], ap[1] + CHEST, ap[2]];
      const to: Vec3 = [tp[0], tp[1] + CHEST, tp[2]];
      const dir3 = norm([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const blocked = this.collider.raycast(from[0], from[1], from[2], dir3[0], dir3[1], dir3[2], len);
      if (blocked !== null && blocked < len - 1) return;
      if (!this.cooldownReady(a, 'yank', COMBAT.yankCooldownMs, now)) return;
      // Ripped off their feet in a short arc that slams them to the floor a few
      // meters in front of the yanker (however far away they were).
      const dx = ap[0] - tp[0];
      const dz = ap[2] - tp[2];
      const D = Math.hypot(dx, dz) || 1;
      const T = COMBAT.yankFlightTime;
      const vh = Math.min(COMBAT.yankMaxPull, Math.max(0, D - COMBAT.yankLandShort) / T);
      // Up just enough to be airborne for T seconds, plus whatever drop there is to the yanker's level.
      const vy = Math.max(-30, Math.min(30, (0.5 * COMBAT.yankGravity * T * T + (ap[1] - tp[1])) / T));
      const imp: Vec3 = [(dx / D) * vh, vy, (dz / D) * vh];
      this.hit(target, a, 'yank', COMBAT.yankDamage, { imp, down: COMBAT.yankDown }, now);
    }
  }

  // ---------------------------------------------------------------- simulation

  tick(now: number, dt: number): void {
    this.tickShots(now);
    this.tickRespawns(now);
    if (this.mode === 'tag') this.tickTag(now, dt);
  }

  private tickShots(now: number): void {
    const keep: Shot[] = [];
    for (const s of this.shots) {
      const reach = Math.min(((now - s.t0) / 1000) * COMBAT.shotSpeed, s.len);
      const a: Vec3 = along(s, s.traveled);
      const b: Vec3 = along(s, reach);
      let hitTarget: Actor | null = null;
      let hitAt = Infinity;
      for (const t of this.host.actors()) {
        if (t === s.shooter || !isAlive(t, now)) continue;
        const p = positionAt(t, now - s.rewind);
        if (!p) continue;
        const { dist2, s: u } = segSeg(a, b, [p[0], p[1] + BODY_LOW, p[2]], [p[0], p[1] + BODY_HIGH, p[2]]);
        if (dist2 <= COMBAT.shotRadius ** 2 && u < hitAt) {
          hitAt = u;
          hitTarget = t;
        }
      }
      const prev = s.traveled;
      s.traveled = reach;
      if (hitTarget) {
        const at = along(s, prev + (reach - prev) * hitAt);
        this.host.broadcast({ t: 'shotHit', sid: s.sid, target: hitTarget.id, at: [round(at[0]), round(at[1]), round(at[2])] });
        this.hit(hitTarget, s.shooter, 'shot', COMBAT.shotDamage, { slow: COMBAT.shotSlow }, now);
        this.shotDone(s);
      } else if (reach >= s.len) {
        this.shotDone(s); // hit a building / ran out of range: gone (clients remove it on their own)
      } else keep.push(s);
    }
    this.shots = keep;
  }

  private shotDone(s: Shot): void {
    const shooter = s.shooter as Actor & { shotsInFlight?: number };
    if (shooter.shotsInFlight !== undefined) shooter.shotsInFlight = Math.max(0, shooter.shotsInFlight - 1);
  }

  /** Forget shots from someone who left. */
  removeActor(a: Actor, now: number): void {
    this.shots = this.shots.filter((s) => s.shooter !== a);
    this.tagScores.delete(a.id);
    if (this.it === a.id) {
      this.it = null;
      this.pickIt(now);
      if (!this.it) this.broadcastTag(now);
    }
  }

  private tickRespawns(now: number): void {
    for (const a of this.host.actors()) {
      if (a.koUntil > 0 && a.koUntil <= now) {
        a.koUntil = 0;
        a.hp = COMBAT.maxHp;
        a.downedUntil = 0;
        a.protectUntil = now + COMBAT.spawnProtectSeconds * 1000;
        (a as Actor & { reset?: () => void }).reset?.();
        this.host.broadcast({ t: 'respawn', id: a.id, hp: a.hp });
      }
    }
  }

  // ---------------------------------------------------------------- damage

  private hit(target: Actor, by: Actor, kind: HitKind, amount: number, fx: HitFx, now: number): void {
    if (target.protectUntil > now) return;
    if (fx.down) target.downedUntil = now + fx.down * 1000;

    if (this.mode === 'tag') {
      // No damage in tag: a hit from "it" passes it on. Effects still apply (yanks are fun).
      target.applyFx(fx, now);
      this.host.broadcast({ t: 'dmg', target: target.id, by: by.id, kind, amount: 0, hp: target.hp, fx });
      if (by.id === this.it) this.tagged(by, target, now);
      return;
    }

    target.hp = Math.max(0, Math.round(target.hp - amount));
    target.applyFx(fx, now);
    this.host.broadcast({ t: 'dmg', target: target.id, by: by.id, kind, amount: Math.round(amount), hp: target.hp, fx });
    if (target.hp <= 0) {
      target.koUntil = now + COMBAT.respawnSeconds * 1000;
      this.host.broadcast({ t: 'ko', target: target.id, by: by.id, kind });
    }
  }

  private cooldownReady(a: Actor, key: string, ms: number, now: number): boolean {
    if (now - (a.cooldowns.get(key) ?? -Infinity) < ms) return false;
    a.cooldowns.set(key, now);
    return true;
  }

  // ---------------------------------------------------------------- tag

  /** Pick a random player to be "it" once there are at least two people. */
  pickIt(now: number): void {
    if (this.mode !== 'tag' || this.it) return;
    const players = [...this.host.actors()].filter((a) => !a.isBot);
    if (players.length < 2) return;
    this.it = players[Math.floor(Math.random() * players.length)].id;
    this.broadcastTag(now);
  }

  private tagged(from: Actor, to: Actor, now: number): void {
    const imm = this.tagImmunity;
    if (imm && imm.from === from.id && imm.to === to.id && now < imm.until) return; // no instant tag-backs
    this.it = to.id;
    this.tagImmunity = { from: to.id, to: from.id, until: now + COMBAT.tagBackImmunity * 1000 };
    this.broadcastTag(now);
  }

  private tickTag(now: number, dt: number): void {
    if (!this.it) {
      this.pickIt(now);
      return;
    }
    this.tagScores.set(this.it, (this.tagScores.get(this.it) ?? 0) + dt);
    if (now - this.tagBroadcastAt > 1000) this.broadcastTag(now);
  }

  private broadcastTag(now: number): void {
    this.tagBroadcastAt = now;
    const scores: [string, number][] = [...this.tagScores].map(([id, s]) => [id, Math.round(s * 10) / 10]);
    this.host.broadcast({ t: 'tag', it: this.it, scores });
  }

  tagSnapshot(): Extract<ServerMessage, { t: 'tag' }> | null {
    if (this.mode !== 'tag') return null;
    return { t: 'tag', it: this.it, scores: [...this.tagScores].map(([id, s]) => [id, Math.round(s * 10) / 10]) };
  }
}

// ---------------------------------------------------------------- math

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function along(s: Shot, dist: number): Vec3 {
  return [s.o[0] + s.d[0] * dist, s.o[1] + s.d[1] * dist, s.o[2] + s.d[2] * dist];
}

/**
 * Closest distance (squared) between segments p1-q1 and p2-q2, plus how far
 * along the first segment (0..1) the closest point is.
 */
export function segSeg(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { dist2: number; s: number } {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
  const d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s: number;
  let t: number;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const dx = p1[0] + d1[0] * s - (p2[0] + d2[0] * t);
  const dy = p1[1] + d1[1] * s - (p2[1] + d2[1] * t);
  const dz = p1[2] + d1[2] * s - (p2[2] + d2[2] * t);
  return { dist2: dx * dx + dy * dy + dz * dz, s };
}
