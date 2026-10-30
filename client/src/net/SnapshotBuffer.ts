import { NET, type NetState, type Vec3 } from '@game/shared';

/** A blended state for drawing a remote player at a given time. */
export interface SampledState {
  p: Vec3;
  v: Vec3;
  y: number;
  s: number;
  a?: Vec3;
  w?: [number, number];
}

interface Sample {
  /** Server time (ms) the state was received. */
  t: number;
  s: NetState;
}

/** Moves bigger than this between two snapshots are teleports (respawn): snap, don't blend. */
const TELEPORT_DISTANCE = 40;
/** Keep at most this many snapshots per player. */
const MAX_SAMPLES = 40;

/**
 * Remote players are drawn slightly in the past (NET.interpDelayMs) so there
 * are almost always two snapshots around the time being drawn. Positions
 * are blended with a cubic curve that uses both snapshots' velocities, so
 * fast swings look smooth instead of zig-zagging between samples.
 */
export class SnapshotBuffer {
  private readonly samples: Sample[] = [];

  get size(): number {
    return this.samples.length;
  }

  /** Add a snapshot. Out-of-order and duplicate timestamps are handled. */
  push(t: number, s: NetState): void {
    const list = this.samples;
    // Insert in time order (almost always appends).
    let i = list.length;
    while (i > 0 && list[i - 1].t > t) i--;
    if (i > 0 && list[i - 1].t === t) list[i - 1] = { t, s };
    else list.splice(i, 0, { t, s });
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** The state to draw at server time `t`, or null if nothing has arrived yet. */
  sample(t: number): SampledState | null {
    const list = this.samples;
    if (!list.length) return null;
    // Drop snapshots we'll never need again (keep one before t to blend from).
    while (list.length > 2 && list[1].t <= t) list.shift();

    const first = list[0];
    if (t <= first.t) return copy(first.s);

    const last = list[list.length - 1];
    if (t >= last.t) {
      // Ran past the newest snapshot (late packet): predict briefly along velocity, then hold.
      const dt = Math.min(t - last.t, NET.maxExtrapolateMs) / 1000;
      const out = copy(last.s);
      for (let k = 0; k < 3; k++) out.p[k] += last.s.v[k] * dt;
      return out;
    }

    // Find the pair around t.
    let i = 0;
    while (i < list.length - 2 && list[i + 1].t <= t) i++;
    const a = list[i];
    const b = list[i + 1];
    const span = b.t - a.t;
    const u = span > 0 ? (t - a.t) / span : 1;

    const pa = a.s.p;
    const pb = b.s.p;
    if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) > TELEPORT_DISTANCE) {
      return copy(u < 0.5 ? a.s : b.s);
    }

    // Cubic Hermite: matches position AND velocity at both snapshots.
    const dt = span / 1000;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const p: Vec3 = [0, 0, 0];
    const v: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      p[k] = h00 * pa[k] + h10 * dt * a.s.v[k] + h01 * pb[k] + h11 * dt * b.s.v[k];
      v[k] = a.s.v[k] + (b.s.v[k] - a.s.v[k]) * u;
    }

    // Discrete things (state, web anchor, wall) switch at the halfway point.
    const pick = u < 0.5 ? a.s : b.s;
    const out: SampledState = { p, v, y: lerpAngle(a.s.y, b.s.y, u), s: pick.s };
    if (pick.a) out.a = [...pick.a];
    if (pick.w) out.w = [pick.w[0], pick.w[1]];
    return out;
  }
}

function copy(s: NetState): SampledState {
  const out: SampledState = { p: [...s.p], v: [...s.v], y: s.y, s: s.s };
  if (s.a) out.a = [...s.a];
  if (s.w) out.w = [s.w[0], s.w[1]];
  return out;
}

/** Blend two angles the short way around. */
export function lerpAngle(a: number, b: number, u: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * u;
}
