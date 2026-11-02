import type { CityLayout } from './city';
import type { Vec3 } from './protocol';

/** Race rules and timing. */
export const RACE = {
  /** Checkpoint ring radius (m). Fly through within this distance of the center. */
  radius: 9,
  /** Countdown before a group race starts (ms). */
  countdownMs: 5000,
  /** A group race ends after this long even if not everyone finished (ms). */
  maxRaceMs: 4 * 60 * 1000,
  /** Moves bigger than this between two updates are teleports (respawns), not flying (m). */
  teleportDistance: 60,
};

export interface RaceCourse {
  name: string;
  /** Ring centers in order. The last one is the finish (same spot as the start: it's a loop). */
  checkpoints: Vec3[];
  radius: number;
}

/**
 * The race course, built from the city's street grid so it always flies
 * through open air (above avenues and streets). Deterministic: the server
 * and every client build the exact same course.
 */
export function raceCourse(city: CityLayout): RaceCourse {
  const avenues = city.roads.filter((r) => r.along === 'z').map((r) => r.center).sort((a, b) => a - b);
  const streets = city.roads.filter((r) => r.along === 'x').map((r) => r.center).sort((a, b) => a - b);
  const nearest = (list: number[], v: number) => list.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(list[best] - v) ? i : best), 0);

  let ai = nearest(avenues, city.spawn.x);
  let sj = nearest(streets, city.spawn.z);
  const start: Vec3 = [avenues[ai], 7, streets[sj]];

  // A loop around midtown: north, east, a long run south, west, north, east home.
  // (Steps are in avenues / streets; they add up to zero, so it ends at the start.)
  const legs: [number, number][] = [
    [0, -6],
    [2, 0],
    [0, 10],
    [-4, 0],
    [0, -4],
    [2, 0],
  ];
  // Heights vary so you have to climb, dive and swing, not just fly straight.
  const heights = [16, 28, 40, 22, 48, 30, 14, 36, 44, 20, 54, 26, 18, 38, 24, 32];

  const checkpoints: Vec3[] = [start];
  let k = 0;
  for (const [di, dj] of legs) {
    const steps = Math.abs(di) + Math.abs(dj);
    for (let s = 1; s <= steps; s++) {
      ai += Math.sign(di);
      sj += Math.sign(dj);
      const corner = s === steps;
      // A ring every two intersections, and always at the corners.
      if (s % 2 === 0 || corner) {
        const last = corner && ai === nearest(avenues, start[0]) && sj === nearest(streets, start[2]);
        checkpoints.push([avenues[ai], last ? start[1] : heights[k++ % heights.length], streets[sj]]);
      }
    }
  }
  return { name: 'Midtown Loop', checkpoints, radius: RACE.radius };
}

/** Did the move from `a` to `b` pass within `r` of `c`? */
export function passesThrough(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby + (c[2] - a[2]) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a[0] + abx * t - c[0];
  const dy = a[1] + aby * t - c[1];
  const dz = a[2] + abz * t - c[2];
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** "1:23.45" */
export function formatRaceTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
