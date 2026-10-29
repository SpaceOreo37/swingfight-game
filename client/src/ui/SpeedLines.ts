/** Speed at which wind effects start, and where they're at full strength (m/s). */
const START = 16;
const FULL = 50;
const COUNT = 70;

interface Streak {
  angle: number;
  /** Distance from the screen center, 0..1 of the half-diagonal. */
  r: number;
  len: number;
  speed: number;
}

/**
 * Wind: white streaks rushing past the edges of the screen plus a darkening
 * vignette, both scaling with speed. A 2D canvas at half resolution, so it
 * costs almost nothing.
 */
export class SpeedLines {
  private readonly canvas = document.getElementById('speedlines') as HTMLCanvasElement;
  private readonly vignette = document.getElementById('vignette')!;
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly streaks: Streak[] = [];
  private strength = 0;
  private lastVignette = -1;

  constructor() {
    for (let i = 0; i < COUNT; i++) this.streaks.push(this.spawn(Math.random()));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.canvas.width = Math.ceil(window.innerWidth / 2);
    this.canvas.height = Math.ceil(window.innerHeight / 2);
  }

  private spawn(r = 0.35 + Math.random() * 0.2): Streak {
    return { angle: Math.random() * Math.PI * 2, r, len: 0.05 + Math.random() * 0.12, speed: 0.6 + Math.random() * 0.8 };
  }

  /** @param boost extra intensity (0..1) for a moment, e.g. right after a launch. */
  update(speed: number, dt: number, boost = 0): void {
    const target = Math.min(1, Math.max(0, (speed - START) / (FULL - START)) + boost);
    this.strength += (target - this.strength) * Math.min(1, dt * 4);
    const s = this.strength;

    // Vignette via CSS opacity (only touch the DOM when it changes visibly).
    const v = Math.round(s * 100) / 100;
    if (v !== this.lastVignette) {
      this.vignette.style.opacity = String(v * 0.75);
      this.lastVignette = v;
    }

    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (s < 0.02) return;

    const cx = w / 2;
    const cy = h / 2;
    const half = Math.hypot(cx, cy);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    for (const st of this.streaks) {
      st.r += st.speed * (0.8 + s * 2.2) * dt;
      if (st.r > 1.1) Object.assign(st, this.spawn());
      // Streaks only near the edges; fade in as they move out.
      const fade = Math.min(1, (st.r - 0.35) / 0.25);
      if (fade <= 0) continue;
      const c = Math.cos(st.angle);
      const sn = Math.sin(st.angle);
      const r0 = st.r * half;
      const r1 = (st.r + st.len * (0.5 + s)) * half;
      ctx.globalAlpha = s * 0.45 * fade;
      ctx.lineWidth = 1 + s * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + c * r0, cy + sn * r0);
      ctx.lineTo(cx + c * r1, cy + sn * r1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
