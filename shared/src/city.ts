import type { Box } from './collision';
import { mulberry32 } from './rng';

/** Facade styles. Index into the facade texture atlas (see CityRenderer). */
export const FACADE = { glass: 0, office: 1, brick: 2, concrete: 3, roof: 4 } as const;
export type FacadeStyle = 0 | 1 | 2 | 3;

export interface Building extends Box {
  /** 0xRRGGBB tint multiplied over the facade texture (near-white = texture's own color). */
  tint: number;
  facade: FacadeStyle;
}

export interface Tree {
  x: number;
  z: number;
  scale: number;
}

/** Small decorative things. Visual only, no collision. */
export interface Prop {
  kind: 'ac' | 'waterTower' | 'streetLight';
  x: number;
  y: number;
  z: number;
  /** Rotation around Y (radians). */
  rot: number;
  scale: number;
}

/** A street or avenue: a straight road across the whole city. */
export interface Road {
  /** 'x' = runs along X (at z = center); 'z' = runs along Z (at x = center). */
  along: 'x' | 'z';
  center: number;
  width: number;
}

export interface CityLayout {
  seed: number;
  /** City spans -halfX..halfX and -halfZ..halfZ. */
  halfX: number;
  halfZ: number;
  buildings: Building[];
  /** Raised curbs around each block. Solid, but low enough to step onto. */
  sidewalks: Box[];
  parks: Box[];
  trees: Tree[];
  props: Prop[];
  roads: Road[];
  spawn: { x: number; y: number; z: number };
}

/**
 * Grid like a real downtown: long blocks between wide avenues (running
 * along Z), short blocks between narrower cross streets (running along X).
 */
export const CITY = {
  avenueBlocks: 12, // blocks across X
  streetBlocks: 21, // blocks across Z
  blockX: 80, // long side of a block
  blockZ: 44, // short side
  avenueWidth: 22,
  streetWidth: 14,
  sidewalk: 4,
  curbHeight: 0.2,
  /** Big park: a rectangle of blocks (inclusive) with no buildings. */
  park: { i0: 8, i1: 9, j0: 3, j1: 8 },
};

// Near-white tints so each facade texture keeps its own color, with variety.
const TINTS: Record<FacadeStyle, number[]> = {
  0: [0xdbe7f2, 0xc9d8e6, 0xe6eef5, 0xbfd0de, 0xd2dce0], // glass: cool blues/greys
  1: [0xf2efe8, 0xe0ddd5, 0xd8dde2, 0xece4d6, 0xc9ccd0], // office: warm/cool concrete
  2: [0xffffff, 0xf0e2d8, 0xe8d6c8, 0xd9c7bd, 0xf5ebe0], // brick
  3: [0xe6e6e6, 0xd2d2cc, 0xc4c8cc, 0xdedad0, 0xbcbcb8], // concrete
};

/**
 * Builds the city from a seed. Deterministic, so the server and every
 * client can generate the same map from just the seed.
 */
export function generateCity(seed: number): CityLayout {
  const rand = mulberry32(seed);
  const C = CITY;
  const pitchX = C.blockX + C.avenueWidth;
  const pitchZ = C.blockZ + C.streetWidth;
  const halfX = (C.avenueBlocks * pitchX) / 2;
  const halfZ = (C.streetBlocks * pitchZ) / 2;

  const buildings: Building[] = [];
  const sidewalks: Box[] = [];
  const parks: Box[] = [];
  const trees: Tree[] = [];
  const props: Prop[] = [];
  const roads: Road[] = [];

  for (let i = 0; i <= C.avenueBlocks; i++) roads.push({ along: 'z', center: -halfX + i * pitchX, width: C.avenueWidth });
  for (let j = 0; j <= C.streetBlocks; j++) roads.push({ along: 'x', center: -halfZ + j * pitchZ, width: C.streetWidth });

  /** 0..1: how "downtown" a spot is. Two skyscraper districts. */
  const density = (x: number, z: number) => {
    const peak = (cx: number, cz: number, r: number) =>
      Math.exp(-(((x - cx) / (r * halfX)) ** 2 + ((z - cz) / (r * halfZ)) ** 2));
    return Math.max(peak(-0.05 * halfX, -0.35 * halfZ, 0.45), 0.85 * peak(0.1 * halfX, 0.62 * halfZ, 0.3));
  };

  const { park } = C;
  const blockRect = (i: number, j: number) => {
    const x0 = -halfX + C.avenueWidth / 2 + i * pitchX;
    const z0 = -halfZ + C.streetWidth / 2 + j * pitchZ;
    return { x0, z0, x1: x0 + C.blockX, z1: z0 + C.blockZ };
  };

  // The big park covers its blocks AND the streets between them.
  {
    const a = blockRect(park.i0, park.j0);
    const b = blockRect(park.i1, park.j1);
    parks.push({ minX: a.x0, minY: 0, minZ: a.z0, maxX: b.x1, maxY: C.curbHeight, maxZ: b.z1 });
    const area = (b.x1 - a.x0) * (b.z1 - a.z0);
    for (let t = 0; t < area / 250; t++) {
      trees.push({
        x: a.x0 + 4 + rand() * (b.x1 - a.x0 - 8),
        z: a.z0 + 4 + rand() * (b.z1 - a.z0 - 8),
        scale: 0.8 + rand() * 0.8,
      });
    }
  }

  for (let i = 0; i < C.avenueBlocks; i++) {
    for (let j = 0; j < C.streetBlocks; j++) {
      if (i >= park.i0 && i <= park.i1 && j >= park.j0 && j <= park.j1) continue;
      const { x0, z0, x1, z1 } = blockRect(i, j);
      sidewalks.push({ minX: x0, minY: 0, minZ: z0, maxX: x1, maxY: C.curbHeight, maxZ: z1 });

      // Street lights along the long sides of the block.
      for (let x = x0 + 8; x < x1 - 4; x += 26) {
        props.push({ kind: 'streetLight', x, y: C.curbHeight, z: z0 + 0.8, rot: Math.PI, scale: 1 });
        props.push({ kind: 'streetLight', x, y: C.curbHeight, z: z1 - 0.8, rot: 0, scale: 1 });
      }

      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const d = density(cx, cz);

      const ix0 = x0 + C.sidewalk;
      const iz0 = z0 + C.sidewalk;
      const innerX = C.blockX - C.sidewalk * 2;
      const innerZ = C.blockZ - C.sidewalk * 2;

      // Occasional small park away from downtown.
      if (d < 0.25 && rand() < 0.04) {
        parks.push({ minX: ix0, minY: C.curbHeight, minZ: iz0, maxX: ix0 + innerX, maxY: C.curbHeight + 0.05, maxZ: iz0 + innerZ });
        for (let t = 0; t < 14; t++) {
          trees.push({ x: ix0 + 3 + rand() * (innerX - 6), z: iz0 + 3 + rand() * (innerZ - 6), scale: 0.8 + rand() * 0.5 });
        }
        continue;
      }

      // Split the block into lots: 2-5 along the long side, 1-2 deep.
      const nx = 2 + Math.floor(rand() * (d > 0.5 ? 2 : 4));
      const nz = rand() < 0.6 ? 2 : 1;
      const widths = Array.from({ length: nx }, () => 0.6 + rand());
      const sum = widths.reduce((a, b) => a + b, 0);
      // Every block has a base height; lots vary around it.
      const blockBase = 12 + rand() * 16 + Math.pow(d, 1.3) * (35 + rand() * 170);

      let lx0 = ix0;
      for (let a = 0; a < nx; a++) {
        const lw = (widths[a] / sum) * innerX;
        const lx1 = a === nx - 1 ? ix0 + innerX : lx0 + lw;
        for (let b = 0; b < nz; b++) {
          const lz0 = iz0 + (b * innerZ) / nz;
          const lz1 = lz0 + innerZ / nz;
          addBuilding(lx0, lz0, lx1, lz1, blockBase * (0.55 + rand() * 0.75), d);
        }
        lx0 = lx1;
      }
    }
  }

  function addBuilding(x0: number, z0: number, x1: number, z1: number, h: number, d: number): void {
    const w = x1 - x0;
    const dep = z1 - z0;
    let height = Math.max(8, Math.round(h / 4) * 4); // whole floors (4m)
    const landmark = d > 0.55 && rand() < 0.06 && w > 20 && dep > 16;
    if (landmark) height += 100 + Math.round(rand() * 15) * 4;

    const facade: FacadeStyle =
      height > 110 ? (rand() < 0.75 ? 0 : 1) : height > 50 ? (([1, 1, 3, 0] as const)[Math.floor(rand() * 4)]) : rand() < 0.65 ? 2 : 3;
    const palette = TINTS[facade];
    const tint = palette[Math.floor(rand() * palette.length)];

    // Tall buildings step back as they rise ("wedding cake" setbacks).
    let bx0 = x0, bz0 = z0, bx1 = x1, bz1 = z1, y = 0;
    const tiers = height > 90 ? 1 + Math.floor(rand() * (height > 180 ? 3 : 2)) : 0;
    const baseShare = tiers ? 0.45 + rand() * 0.2 : 1;
    let remaining = height;
    for (let t = 0; t <= tiers; t++) {
      const th = t === tiers ? remaining : Math.round((remaining * baseShare) / 4) * 4;
      buildings.push({ minX: bx0, minY: y, minZ: bz0, maxX: bx1, maxY: y + th, maxZ: bz1, tint, facade });
      y += th;
      remaining -= th;
      if (t === tiers) break;
      const inset = 2 + rand() * 4;
      if (bx1 - bx0 - inset * 2 < 8 || bz1 - bz0 - inset * 2 < 8) break;
      bx0 += inset; bz0 += inset; bx1 -= inset; bz1 -= inset;
    }

    // Spire on landmarks: something tall to swing from.
    if (landmark) {
      const sx = (bx0 + bx1) / 2;
      const sz = (bz0 + bz1) / 2;
      const sh = 25 + rand() * 35;
      buildings.push({ minX: sx - 1.5, minY: y, minZ: sz - 1.5, maxX: sx + 1.5, maxY: y + sh, maxZ: sz + 1.5, tint: 0xd0d4d8, facade: 3 });
    }

    // Rooftop clutter on the top tier (not on glass towers).
    if (facade !== 0) {
      const rw = bx1 - bx0;
      const rd = bz1 - bz0;
      const units = Math.floor((rw * rd) / 180);
      for (let k = 0; k < Math.min(units, 4); k++) {
        props.push({ kind: 'ac', x: bx0 + 2 + rand() * (rw - 4), y, z: bz0 + 2 + rand() * (rd - 4), rot: rand() * Math.PI, scale: 0.8 + rand() * 0.6 });
      }
      if (height < 70 && rand() < 0.35 && rw > 10 && rd > 10) {
        props.push({ kind: 'waterTower', x: bx0 + 3 + rand() * (rw - 6), y, z: bz0 + 3 + rand() * (rd - 6), rot: 0, scale: 0.9 + rand() * 0.4 });
      }
    }
  }

  // Spawn at the avenue/street intersection closest to the middle of midtown.
  const sx = -halfX + Math.round((-0.05 * halfX + halfX) / pitchX) * pitchX;
  const sz = -halfZ + Math.round((-0.3 * halfZ + halfZ) / pitchZ) * pitchZ;

  return { seed, halfX, halfZ, buildings, sidewalks, parks, trees, props, roads, spawn: { x: sx, y: 0, z: sz } };
}
