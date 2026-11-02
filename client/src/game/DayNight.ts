import * as THREE from 'three';
import type { CityNightMaterials } from './CityRenderer';

export type TimeOfDay = 'cycle' | 'day' | 'sunset' | 'night';

/** One full day-night cycle (ms). */
const DAY_MS = 20 * 60 * 1000;
/** Where in the day the cycle starts when the server starts (0 = midnight, 0.5 = noon). */
const CYCLE_START = 0.35;
/** Fixed times for the non-cycling settings. */
const FIXED: Record<Exclude<TimeOfDay, 'cycle'>, number> = { day: 0.46, sunset: 0.735, night: 0.02 };

const SKY_DAY = new THREE.Color(0x9fc4e8);
const SKY_NIGHT = new THREE.Color(0x0a1226);
const SKY_SUNSET = new THREE.Color(0xf4925a);
const SUN_LOW = new THREE.Color(0xffa860);
const SUN_HIGH = new THREE.Color(0xfff2dd);
const MOON = new THREE.Color(0x9fb4ff);
const HEMI_SKY_DAY = new THREE.Color(0xdfefff);
const HEMI_SKY_NIGHT = new THREE.Color(0x4a5f96);
const HEMI_GROUND_DAY = new THREE.Color(0x8a8f96);
const HEMI_GROUND_NIGHT = new THREE.Color(0x2a2e3c);

const _dir = new THREE.Vector3();
const _light = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Sun, moon, sky, fog, stars and city lights over a 20-minute day. In
 * "cycle" mode the time comes from the server clock, so everyone in the
 * game sees the same sky.
 */
export class DayNight {
  setting: TimeOfDay = 'cycle';
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  time = CYCLE_START;
  /** 0 at night, 1 in full daylight. */
  daylight = 1;

  private readonly stars: THREE.Points;
  private readonly sunDisc: THREE.Sprite;
  private readonly moonDisc: THREE.Sprite;
  private readonly sky = new THREE.Color();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly hemi: THREE.HemisphereLight,
    private readonly night: CityNightMaterials,
  ) {
    this.scene.background = this.sky;
    this.stars = makeStars();
    this.sunDisc = disc('#fff6d8', 'rgba(255,220,150,0)', 90);
    this.moonDisc = disc('#e8eeff', 'rgba(180,200,255,0)', 55);
    scene.add(this.stars, this.sunDisc, this.moonDisc);
  }

  /**
   * @param clockMs shared clock (server time when online)
   * @param camera stars and discs follow it
   * @param focus where shadows are centered (the player)
   */
  update(clockMs: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.time = this.setting === 'cycle' ? (CYCLE_START + clockMs / DAY_MS) % 1 : FIXED[this.setting];
    const t = this.time;

    // Sun path: up at 0.25, highest at 0.5, down at 0.75. Elevation -1..1.
    const elevation = Math.sin((t - 0.25) * Math.PI * 2);
    const angle = elevation * 1.15; // highest ~66 degrees
    const azimuth = t * Math.PI * 2 + 0.6;
    _dir.set(Math.cos(azimuth) * Math.cos(angle), Math.sin(angle), Math.sin(azimuth) * Math.cos(angle));

    const day = smoothstep(-0.12, 0.22, elevation);
    const horizon = Math.exp(-((elevation / 0.2) ** 2)); // peaks at sunrise / sunset
    this.daylight = day;

    // Sky + fog.
    this.sky.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_SUNSET, horizon * 0.55 * (0.3 + day));
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(this.sky);

    // Sunlight by day, dim blue moonlight by night (the moon is opposite the sun).
    const moonUp = elevation < -0.05;
    const lightDir = moonUp ? _light.copy(_dir).negate() : _dir;
    if (moonUp) {
      this.sun.color.copy(MOON);
      this.sun.intensity = 0.8 * (1 - day);
    } else {
      this.sun.color.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(0, 0.45, elevation));
      this.sun.intensity = 2.4 * day + 0.2 * horizon;
    }
    this.sun.position.copy(focus).addScaledVector(lightDir, 500);
    this.sun.target.position.copy(focus);

    this.hemi.color.copy(HEMI_SKY_NIGHT).lerp(HEMI_SKY_DAY, day);
    this.hemi.groundColor.copy(HEMI_GROUND_NIGHT).lerp(HEMI_GROUND_DAY, day);
    this.hemi.intensity = 1.0 + 0.6 * day;

    // City lights come on as it gets dark.
    const dark = 1 - day;
    this.night.facade.emissiveIntensity = dark * 1.05 + horizon * 0.2;
    const lamps = smoothstep(0.35, 0.9, dark);
    this.night.lamps.emissiveIntensity = lamps * 2.2;
    this.night.lampPools.opacity = lamps * 0.85;

    // Stars, sun and moon follow the camera (they're "infinitely" far away).
    this.stars.position.copy(camera.position);
    (this.stars.material as THREE.PointsMaterial).opacity = dark * dark;
    this.stars.visible = dark > 0.02;
    this.sunDisc.position.copy(camera.position).addScaledVector(_dir, 1200);
    this.sunDisc.visible = elevation > -0.1;
    _c.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(0, 0.4, elevation));
    (this.sunDisc.material as THREE.SpriteMaterial).color.copy(_c);
    this.moonDisc.position.copy(camera.position).addScaledVector(_dir, -1200);
    this.moonDisc.visible = elevation < 0.1;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Stars scattered over the upper sky dome. */
function makeStars(): THREE.Points {
  const n = 1400;
  const pos = new Float32Array(n * 3);
  let s = 42;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const az = rnd() * Math.PI * 2;
    const el = Math.asin(0.05 + rnd() * 0.95);
    pos[i * 3] = Math.cos(az) * Math.cos(el) * 1300;
    pos[i * 3 + 1] = Math.sin(el) * 1300;
    pos[i * 3 + 2] = Math.sin(az) * Math.cos(el) * 1300;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -1;
  return pts;
}

/** A soft glowing disc (sun / moon). */
function disc(core: string, edge: string, size: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, core);
  g.addColorStop(0.35, core);
  g.addColorStop(1, edge);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.setScalar(size);
  sprite.renderOrder = -1;
  sprite.frustumCulled = false;
  return sprite;
}
