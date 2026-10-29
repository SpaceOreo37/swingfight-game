/** Axis-aligned box. Every solid thing in the city is one of these. */
export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Spatial grid over the city's boxes so we only test the few boxes near the player.
 * Lives in `shared` so a future server can run the exact same collision.
 */
export class CityCollider {
  private readonly cells = new Map<number, number[]>();
  private readonly stamps: Uint32Array;
  private stamp = 0;

  constructor(
    readonly boxes: Box[],
    private readonly cellSize = 32,
  ) {
    this.stamps = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      for (let cx = this.cell(b.minX); cx <= this.cell(b.maxX); cx++) {
        for (let cz = this.cell(b.minZ); cz <= this.cell(b.maxZ); cz++) {
          const k = this.key(cx, cz);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
      }
    });
  }

  private cell(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Fills `out` with every box overlapping the given region. */
  query(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Box[],
  ): Box[] {
    out.length = 0;
    // Guard: an invalid or enormous region would loop (nearly) forever and freeze the tab.
    if (!Number.isFinite(minX + maxX + minZ + maxZ)) return out;
    const cx0 = this.cell(minX);
    const cz0 = this.cell(minZ);
    const cx1 = Math.min(this.cell(maxX), cx0 + 64);
    const cz1 = Math.min(this.cell(maxZ), cz0 + 64);
    this.stamp++;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (this.stamps[i] === this.stamp) continue;
          this.stamps[i] = this.stamp;
          const b = this.boxes[i];
          if (
            b.minX <= maxX && b.maxX >= minX &&
            b.minY <= maxY && b.maxY >= minY &&
            b.minZ <= maxZ && b.maxZ >= minZ
          ) {
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  /** Distance along a normalized ray to the first box hit, or null. */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): number | null {
    const ex = ox + dx * maxDist;
    const ey = oy + dy * maxDist;
    const ez = oz + dz * maxDist;
    const hits = this.query(
      Math.min(ox, ex), Math.min(oy, ey), Math.min(oz, ez),
      Math.max(ox, ex), Math.max(oy, ey), Math.max(oz, ez),
      [],
    );
    let best: number | null = null;
    for (const b of hits) {
      const t = rayBox(ox, oy, oz, dx, dy, dz, b, best ?? maxDist);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }
}

/** Slab test. Returns entry distance, or null on miss (or if the ray starts inside). */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  b: Box, maxT: number,
): number | null {
  let tmin = 0;
  let tmax = maxT;
  let entered = false;
  const axes: [number, number, number, number][] = [
    [ox, dx, b.minX, b.maxX],
    [oy, dy, b.minY, b.maxY],
    [oz, dz, b.minZ, b.maxZ],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return null;
      continue;
    }
    let t0 = (mn - o) / d;
    let t1 = (mx - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tmin) {
      tmin = t0;
      entered = true;
    }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  return entered ? tmin : null;
}
