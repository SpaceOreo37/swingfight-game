import type { CityLayout } from '@game/shared';

/** Meters shown from the center of the minimap to its edge. */
const VIEW_RADIUS = 200;

/**
 * Round minimap that rotates with the camera (forward is always up).
 * The city is drawn once into an offscreen canvas; each frame just copies a
 * rotated slice of it, which is very cheap.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: HTMLCanvasElement;
  private readonly halfX: number;
  private readonly halfZ: number;
  private readonly size: number;

  constructor(canvas: HTMLCanvasElement, city: CityLayout) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const cssSize = canvas.clientWidth || 180;
    this.size = Math.round(cssSize * dpr);
    canvas.width = canvas.height = this.size;
    this.ctx = canvas.getContext('2d')!;
    this.halfX = city.halfX;
    this.halfZ = city.halfZ;
    this.map = renderCity(city);
  }

  /**
   * @param camYaw camera yaw (map rotates so the view direction is up)
   * @param playerYaw direction the character faces
   */
  draw(
    x: number,
    z: number,
    camYaw: number,
    playerYaw: number,
    others: { x: number; z: number; color: number }[] = [],
  ): void {
    const { ctx, size } = this;
    const r = size / 2;
    const scale = r / VIEW_RADIUS;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#23465c'; // water
    ctx.fillRect(0, 0, size, size);

    // Map: center on the player, rotate so the camera's forward points up.
    ctx.translate(r, r);
    ctx.rotate(camYaw);
    ctx.scale(scale, scale);
    ctx.drawImage(this.map, -this.halfX - x, -this.halfZ - z);
    // Other players: colored dots (clamped to the rim when far away).
    for (const o of others) {
      let dx = o.x - x;
      let dz = o.z - z;
      const d = Math.hypot(dx, dz);
      const max = VIEW_RADIUS * 0.92;
      if (d > max) {
        dx *= max / d;
        dz *= max / d;
      }
      ctx.beginPath();
      ctx.arc(dx, dz, size * 0.03 / scale, 0, Math.PI * 2);
      ctx.fillStyle = `#${o.color.toString(16).padStart(6, '0')}`;
      ctx.fill();
      ctx.lineWidth = (size * 0.008) / scale;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();

    // Player arrow.
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(camYaw - playerYaw);
    const a = size * 0.045;
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.4);
    ctx.lineTo(a, a);
    ctx.lineTo(0, a * 0.4);
    ctx.lineTo(-a, a);
    ctx.closePath();
    ctx.fillStyle = '#ff4d4d';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, size * 0.008);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Rim.
    ctx.beginPath();
    ctx.arc(r, r, r - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = Math.max(2, size * 0.015);
    ctx.stroke();
  }
}

/** Top-down drawing of the whole city at 1 pixel per meter. */
function renderCity(city: CityLayout): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(city.halfX * 2);
  c.height = Math.ceil(city.halfZ * 2);
  const ctx = c.getContext('2d')!;
  const o = city.halfX;
  const oz = city.halfZ;

  ctx.fillStyle = '#2b313c'; // streets
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.fillStyle = '#4a5260';
  for (const s of city.sidewalks) ctx.fillRect(s.minX + o, s.minZ + oz, s.maxX - s.minX, s.maxZ - s.minZ);

  ctx.fillStyle = '#3f7a35';
  for (const p of city.parks) ctx.fillRect(p.minX + o, p.minZ + oz, p.maxX - p.minX, p.maxZ - p.minZ);

  // Taller buildings are lighter; draw shortest first so upper tiers sit on top.
  const sorted = [...city.buildings].sort((a, b) => a.maxY - b.maxY);
  for (const b of sorted) {
    const t = Math.min(1, b.maxY / 250);
    const l = Math.round(105 + t * 130);
    ctx.fillStyle = `rgb(${l},${l},${l + 10})`;
    ctx.fillRect(b.minX + o + 0.5, b.minZ + oz + 0.5, b.maxX - b.minX - 1, b.maxZ - b.minZ - 1);
  }
  return c;
}
