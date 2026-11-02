import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY, FACADE, type Box, type Building, type CityLayout, type Prop } from '@game/shared';

/** Materials that change between day and night. */
export interface CityNightMaterials {
  facade: THREE.MeshStandardMaterial;
  lamps: THREE.MeshLambertMaterial;
  /** Warm light pools on the street under each lamp. */
  lampPools: THREE.MeshBasicMaterial;
}

const lampMaterial = new THREE.MeshLambertMaterial({ color: 0x6a6f76, emissive: new THREE.Color(0xffd28a), emissiveIntensity: 0 });
const lampPoolMaterial = new THREE.MeshBasicMaterial({
  map: poolTexture(),
  color: 0xffc070,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  fog: false,
});

/** Soft round gradient for the light pools. */
function poolTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** World size (meters) covered by one copy of a facade texture: 8 floors of 4m. */
const TEX_METERS = 32;
/** Buildings are merged per chunk so the camera only draws chunks it can see. */
const CHUNK_SIZE = 192;
/** Number of tiles stacked in the facade atlas (glass, office, brick, concrete, roof). */
const ATLAS_TILES = 5;
const TILE_PX = 256;

/**
 * Turns a CityLayout into meshes. Everything is generated in code (no
 * downloads) and merged so the whole city is a few dozen draw calls.
 */
export function buildCity(city: CityLayout): { group: THREE.Group; night: CityNightMaterials } {
  const group = new THREE.Group();

  // Water all around, and the street-level ground of the island.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshStandardMaterial({ color: 0x2f5f7a, roughness: 0.25, metalness: 0.1 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.5;
  group.add(water);

  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(city.halfX * 2 + 60, 4, city.halfZ * 2 + 60),
    new THREE.MeshLambertMaterial({ color: 0x5c6068 }),
  );
  ground.position.y = -2;
  ground.receiveShadow = true;
  group.add(ground);

  group.add(buildRoadMarkings(city));

  // Buildings, grouped by chunk, all sharing one material.
  const chunks = new Map<string, Building[]>();
  for (const b of city.buildings) {
    const key = `${Math.floor((b.minX + b.maxX) / 2 / CHUNK_SIZE)},${Math.floor((b.minZ + b.maxZ) / 2 / CHUNK_SIZE)}`;
    const list = chunks.get(key);
    if (list) list.push(b);
    else chunks.set(key, [b]);
  }
  const buildingMat = facadeMaterial();
  for (const list of chunks.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(list.map(buildingGeometry)), buildingMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const sidewalks = new THREE.Mesh(
    mergeGeometries(city.sidewalks.map(plainBox)),
    new THREE.MeshLambertMaterial({ color: 0x8d9096 }),
  );
  sidewalks.receiveShadow = true;
  group.add(sidewalks);

  if (city.parks.length) {
    const parks = new THREE.Mesh(
      mergeGeometries(city.parks.map(plainBox)),
      new THREE.MeshLambertMaterial({ color: 0x4f8a3c }),
    );
    parks.receiveShadow = true;
    group.add(parks);
    group.add(buildTrees(city));
  }

  group.add(buildProps(city.props));

  // Everything here is static: skip per-frame matrix updates.
  group.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  return { group, night: { facade: buildingMat, lamps: lampMaterial, lampPools: lampPoolMaterial } };
}

function plainBox(b: Box): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
  return g;
}

// ------------------------------------------------------------------ buildings

/**
 * Building as 4 walls + roof (no bottom face, it's never seen). UVs are in
 * world meters so windows don't stretch. A per-vertex "facade" value picks
 * which tile of the texture atlas to use (walls: the building's style, roof: gravel).
 */
function buildingGeometry(b: Building): THREE.BufferGeometry {
  const { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 } = b;
  const tint = new THREE.Color(b.tint);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const fac: number[] = [];
  const idx: number[] = [];
  const S = TEX_METERS;

  const quad = (c: number[][], n: number[], uvs: number[][], facade: number, shade: number) => {
    const base = pos.length / 3;
    for (let i = 0; i < 4; i++) {
      pos.push(...c[i]);
      nrm.push(...n);
      uv.push(...uvs[i]);
      col.push(tint.r * shade, tint.g * shade, tint.b * shade);
      fac.push(facade);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // v starts at the building's absolute height so stacked tiers line up floor-to-floor.
  const vy0 = y0 / S;
  const vy1 = y1 / S;
  // u offset per face from the corner position so adjacent faces don't look identical.
  const wallUV = (u0: number, w: number) => [[u0, vy0], [u0 + w / S, vy0], [u0 + w / S, vy1], [u0, vy1]];
  const w = x1 - x0;
  const d = z1 - z0;
  const f = b.facade;

  quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], wallUV(x0 / S, w), f, 1); // +Z
  quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], wallUV(-x1 / S, w), f, 0.96); // -Z
  quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], wallUV(-z1 / S, d), f, 0.92); // +X
  quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], wallUV(z0 / S, d), f, 0.98); // -X
  const r = (x: number, z: number) => [x / 16, z / 16];
  quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [r(x0, z1), r(x1, z1), r(x1, z0), r(x0, z0)], FACADE.roof, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('facade', new THREE.Float32BufferAttribute(fac, 1));
  g.setIndex(idx);
  return g;
}

/**
 * Standard lit material, with a small shader tweak: it tiles the chosen atlas
 * tile instead of the whole texture, so every building style shares ONE
 * texture and ONE draw call per chunk.
 */
function facadeMaterial(): THREE.MeshStandardMaterial {
  const atlas = facadeAtlas();
  const mat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.05,
    // Lit windows glow at night (DayNight drives emissiveIntensity).
    emissive: new THREE.Color(0xffffff),
    emissiveMap: atlas.glow,
    emissiveIntensity: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float facade;\nvarying float vFacade;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vFacade;
        const float ATLAS_TILES = ${ATLAS_TILES.toFixed(1)};
        const float ATLAS_PAD = 2.0 / ${TILE_PX.toFixed(1)};
        // Wrap inside the chosen tile of the atlas.
        #define ATLAS_UV(uv) vec2((uv).x, (fract((uv).y) * (1.0 - 2.0 * ATLAS_PAD) + ATLAS_PAD + floor(vFacade + 0.5)) / ATLAS_TILES)`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          // Sample with the unwrapped UV's gradients so mipmapping doesn't show
          // seams where the tile repeats.
          vec2 atlasGx = dFdx(vMapUv) * vec2(1.0, 1.0 / ATLAS_TILES);
          vec2 atlasGy = dFdy(vMapUv) * vec2(1.0, 1.0 / ATLAS_TILES);
          diffuseColor *= textureGrad(map, ATLAS_UV(vMapUv), atlasGx, atlasGy);
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#ifdef USE_EMISSIVEMAP
          totalEmissiveRadiance *= textureGrad(emissiveMap, ATLAS_UV(vMapUv), atlasGx, atlasGy).rgb;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'facade-atlas';
  return mat;
}

/** One canvas, 5 tiles stacked vertically: glass, office, brick, concrete, roof gravel. */
function facadeAtlas(): { map: THREE.Texture; glow: THREE.Texture } {
  const T = TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = T;
  canvas.height = T * ATLAS_TILES;
  const ctx = canvas.getContext('2d')!;
  // Glow mask with the same layout: only the lit windows, which light up at night.
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = T;
  glowCanvas.height = T * ATLAS_TILES;
  const gctx = glowCanvas.getContext('2d')!;
  gctx.fillStyle = '#000';
  gctx.fillRect(0, 0, T, T * ATLAS_TILES);
  const glow = (x: number, y: number, w: number, h: number) => {
    gctx.fillStyle = '#ffd9a0';
    gctx.fillRect(x, y, w, h);
  };
  // Seeded noise so every load looks the same.
  let s = 1234567;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Tiles are drawn top-down in canvas space; with flipY, tile k sits at v in [k/5,(k+1)/5].
  const tileTop = (k: number) => T * (ATLAS_TILES - 1 - k);
  const floors = 8;
  const fh = T / floors; // one 4m floor

  // 0: glass curtain wall
  {
    const y0 = tileTop(0);
    const g = ctx.createLinearGradient(0, y0, T, y0 + T);
    g.addColorStop(0, '#5f7f99');
    g.addColorStop(0.5, '#86a4bb');
    g.addColorStop(1, '#4f6c85');
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, T, T);
    for (let r = 0; r < floors; r++) {
      for (let c = 0; c < 8; c++) {
        const lit = rnd() < 0.12;
        ctx.fillStyle = lit ? 'rgba(255,240,190,0.55)' : `rgba(20,35,55,${0.15 + rnd() * 0.25})`;
        ctx.fillRect(c * 32 + 1, y0 + r * fh + 1, 30, fh - 2);
        if (lit) glow(c * 32 + 1, y0 + r * fh + 1, 30, fh - 2);
      }
    }
    ctx.fillStyle = '#c9d3dc'; // mullions
    for (let c = 0; c <= 8; c++) ctx.fillRect(c * 32 - 1, y0, 2, T);
    ctx.fillStyle = '#9fb0bf'; // floor slabs
    for (let r = 0; r <= floors; r++) ctx.fillRect(0, y0 + r * fh - 2, T, 3);
  }

  // 1: office: concrete with ribbon windows
  {
    const y0 = tileTop(1);
    ctx.fillStyle = '#c8c4bc';
    ctx.fillRect(0, y0, T, T);
    for (let r = 0; r < floors; r++) {
      const wy = y0 + r * fh + 8;
      ctx.fillStyle = '#3d4a58';
      ctx.fillRect(0, wy, T, fh - 14);
      for (let c = 0; c < 16; c++) {
        if (rnd() < 0.15) {
          ctx.fillStyle = 'rgba(255,236,180,0.7)';
          ctx.fillRect(c * 16 + 1, wy + 1, 14, fh - 16);
          glow(c * 16 + 1, wy + 1, 14, fh - 16);
        }
      }
      ctx.fillStyle = '#b5b1a9';
      for (let c = 0; c < 16; c++) ctx.fillRect(c * 16, wy, 2, fh - 14);
    }
  }

  // 2: brick with punched windows
  {
    const y0 = tileTop(2);
    ctx.fillStyle = '#8f4a3a';
    ctx.fillRect(0, y0, T, T);
    for (let by = 0; by < T; by += 4) {
      for (let bx = (by / 4) % 2 ? -4 : 0; bx < T; bx += 8) {
        const v = 120 + Math.floor(rnd() * 40);
        ctx.fillStyle = `rgb(${v + 20},${Math.floor(v * 0.5)},${Math.floor(v * 0.38)})`;
        ctx.fillRect(bx, y0 + by, 7, 3);
      }
    }
    for (let r = 0; r < floors; r++) {
      for (let c = 0; c < 8; c++) {
        const wx = c * 32 + 9;
        const wy = y0 + r * fh + 6;
        ctx.fillStyle = '#d9cfc0'; // sill/frame
        ctx.fillRect(wx - 2, wy - 2, 18, fh - 8);
        const lit = rnd() < 0.18;
        ctx.fillStyle = lit ? '#f2dc9a' : '#2c3440';
        ctx.fillRect(wx, wy, 14, fh - 12);
        if (lit) glow(wx, wy, 14, fh - 12);
      }
    }
  }

  // 3: concrete panels
  {
    const y0 = tileTop(3);
    ctx.fillStyle = '#a9a9a4';
    ctx.fillRect(0, y0, T, T);
    for (let i = 0; i < 400; i++) {
      const v = 150 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgba(${v},${v},${v - 5},0.25)`;
      ctx.fillRect(rnd() * T, y0 + rnd() * T, 3, 3);
    }
    for (let r = 0; r < floors; r++) {
      for (let c = 0; c < 6; c++) {
        const wx = c * 42 + 8;
        const wy = y0 + r * fh + 7;
        const lit = rnd() < 0.14;
        ctx.fillStyle = lit ? '#f0dfa8' : '#34404c';
        ctx.fillRect(wx, wy, 28, fh - 14);
        if (lit) glow(wx, wy, 28, fh - 14);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(0, y0 + r * fh, T, 2);
    }
  }

  // 4: roof gravel / tar
  {
    const y0 = tileTop(4);
    ctx.fillStyle = '#6b6a66';
    ctx.fillRect(0, y0, T, T);
    for (let i = 0; i < 3000; i++) {
      const v = 80 + Math.floor(rnd() * 70);
      ctx.fillStyle = `rgb(${v},${v},${v - 4})`;
      ctx.fillRect(rnd() * T, y0 + rnd() * T, 2, 2);
    }
  }

  const make = (c: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  return { map: make(canvas), glow: make(glowCanvas) };
}

// ------------------------------------------------------------------ streets

/** Dashed center lines and crosswalks, merged into one mesh. */
function buildRoadMarkings(city: CityLayout): THREE.Mesh {
  const yellow: number[] = [];
  const white: number[] = [];
  const Y = 0.02;
  // Axis-aligned rectangle on the ground, appended as 2 triangles.
  const rect = (out: number[], x0: number, z0: number, x1: number, z1: number) => {
    out.push(x0, Y, z0, x0, Y, z1, x1, Y, z1, x0, Y, z0, x1, Y, z1, x1, Y, z0);
  };
  const avenues = city.roads.filter((r) => r.along === 'z');
  const streets = city.roads.filter((r) => r.along === 'x');
  const inPark = (x: number, z: number) => city.parks.some((p) => x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ);

  // Center lines between intersections.
  for (const a of avenues) {
    for (let k = 0; k < streets.length - 1; k++) {
      const z0 = streets[k].center + streets[k].width / 2 + 3;
      const z1 = streets[k + 1].center - streets[k + 1].width / 2 - 3;
      for (let z = z0; z < z1 - 3; z += 6) {
        if (inPark(a.center, z)) continue;
        rect(yellow, a.center - 0.15, z, a.center + 0.15, Math.min(z + 3, z1));
      }
    }
  }
  for (const s of streets) {
    for (let k = 0; k < avenues.length - 1; k++) {
      const x0 = avenues[k].center + avenues[k].width / 2 + 3;
      const x1 = avenues[k + 1].center - avenues[k + 1].width / 2 - 3;
      for (let x = x0; x < x1 - 3; x += 6) {
        if (inPark(x, s.center)) continue;
        rect(white, x, s.center - 0.12, Math.min(x + 3, x1), s.center + 0.12);
      }
    }
  }

  // Crosswalk stripes on all 4 sides of each intersection.
  for (const a of avenues) {
    for (const s of streets) {
      if (inPark(a.center, s.center)) continue;
      const hw = a.width / 2;
      const hs = s.width / 2;
      for (const side of [-1, 1]) {
        // Across the avenue (stripes run along Z), just outside the street.
        const zc = s.center + side * (hs + 1.5);
        for (let x = a.center - hw + 1; x < a.center + hw - 1; x += 1.6) rect(white, x, zc - 1.2, x + 0.8, zc + 1.2);
        // Across the street (stripes run along X), just outside the avenue.
        const xc = a.center + side * (hw + 1.5);
        for (let z = s.center - hs + 1; z < s.center + hs - 1; z += 1.6) rect(white, xc - 1.2, z, xc + 1.2, z + 0.8);
      }
    }
  }

  const geo = (arr: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  const merged = mergeGeometries([geo(yellow), geo(white)], true);
  const mesh = new THREE.Mesh(merged, [
    new THREE.MeshLambertMaterial({ color: 0xd9b84a, polygonOffset: true, polygonOffsetFactor: -2 }),
    new THREE.MeshLambertMaterial({ color: 0xe8e8e2, polygonOffset: true, polygonOffsetFactor: -2 }),
  ]);
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ props

/** Instanced street lights, rooftop AC units and water towers: thousands of objects, a handful of draws. */
function buildProps(props: Prop[]): THREE.Group {
  const group = new THREE.Group();
  const byKind = (k: Prop['kind']) => props.filter((p) => p.kind === k);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();

  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Prop[], shadow = true) => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      m.compose(v.set(p.x, p.y, p.z), q, sc.setScalar(p.scale));
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = shadow;
    mesh.computeBoundingSphere();
    group.add(mesh);
  };

  // Street light: pole + arm + lamp, merged into one geometry.
  const lights = byKind('streetLight');
  const pole = new THREE.CylinderGeometry(0.09, 0.12, 7, 6).translate(0, 3.5, 0);
  const arm = new THREE.BoxGeometry(0.12, 0.12, 2).translate(0, 7, 1);
  const head = new THREE.BoxGeometry(0.45, 0.2, 0.7).translate(0, 6.9, 1.9);
  instanced(mergeGeometries([pole, arm]), new THREE.MeshLambertMaterial({ color: 0x3b4148 }), lights, false);
  // Lamp heads glow at night (DayNight drives emissiveIntensity), with a pool of light below.
  instanced(head, lampMaterial, lights, false);
  const pool = new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2).translate(0, 0.06, 2.4);
  instanced(pool, lampPoolMaterial, lights, false);

  const ac = byKind('ac');
  instanced(new THREE.BoxGeometry(2.4, 1.4, 1.8).translate(0, 0.7, 0), new THREE.MeshLambertMaterial({ color: 0xb9bcbf }), ac);

  // Water tower: wooden tank on legs with a conical roof.
  const towers = byKind('waterTower');
  const legs = [-1, 1].flatMap((a) => [-1, 1].map((b) => new THREE.CylinderGeometry(0.12, 0.12, 3, 4).translate(a * 1.3, 1.5, b * 1.3)));
  const tank = new THREE.CylinderGeometry(1.9, 1.9, 3.6, 12).translate(0, 4.8, 0);
  const cap = new THREE.ConeGeometry(2.1, 1.6, 12).translate(0, 7.4, 0);
  instanced(mergeGeometries([...legs, tank, cap]), new THREE.MeshLambertMaterial({ color: 0x7a5a3e }), towers);

  return group;
}

function buildTrees(city: CityLayout): THREE.Group {
  const group = new THREE.Group();
  const n = city.trees.length;
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.2, 0.3, 3, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a4030 }),
    n,
  );
  const tops = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(2, 0),
    new THREE.MeshLambertMaterial({ color: 0x3f7a35, flatShading: true }),
    n,
  );
  const m = new THREE.Matrix4();
  const base = CITY.curbHeight;
  city.trees.forEach((t, i) => {
    m.makeScale(t.scale, t.scale, t.scale).setPosition(t.x, base + 1.5 * t.scale, t.z);
    trunks.setMatrixAt(i, m);
    m.makeScale(t.scale, t.scale, t.scale).setPosition(t.x, base + 4 * t.scale, t.z);
    tops.setMatrixAt(i, m);
  });
  trunks.castShadow = tops.castShadow = true;
  trunks.computeBoundingSphere();
  tops.computeBoundingSphere();
  group.add(trunks, tops);
  return group;
}
