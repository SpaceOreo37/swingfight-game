import * as THREE from 'three';

/** Tags are drawn through walls so you can always find your friends. */
const THROUGH_WALLS = true;
/** Height of the tag in world meters when close. */
const BASE_HEIGHT = 0.42;
/** Past this distance the tag stops shrinking on screen (stays readable). */
const SCALE_FROM = 14;
/** Past this distance the tag fades out. */
const FADE_FROM = 350;
const FADE_TO = 450;

/**
 * A name in a rounded rectangle, floating above a remote player's head.
 * Only other players get one, so you never see your own.
 */
export class Nametag {
  readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly aspect: number;
  /** Health bar under the name (hidden at full health). */
  private readonly bar: THREE.Sprite;
  private readonly barMaterial: THREE.SpriteMaterial;
  private readonly barCanvas = document.createElement('canvas');
  private readonly barTexture: THREE.CanvasTexture;
  private hp = 1;

  constructor(name: string, color: number) {
    const scale = 2; // render the canvas at 2x for crisp text
    const font = `700 ${26 * scale}px system-ui, -apple-system, sans-serif`;
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = font;
    const padX = 16 * scale;
    const h = 44 * scale;
    const w = Math.ceil(measure.measureText(name).width + padX * 2);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const border = 3 * scale;
    const r = 10 * scale;
    ctx.beginPath();
    ctx.roundRect(border / 2, border / 2, w - border, h - border, r);
    ctx.fillStyle = 'rgba(12, 18, 30, 0.78)';
    ctx.fill();
    ctx.lineWidth = border;
    ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2 + scale);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.material = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: !THROUGH_WALLS,
      depthWrite: false,
      fog: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = 998;
    this.aspect = w / h;

    this.barCanvas.width = 128;
    this.barCanvas.height = 14;
    this.barTexture = new THREE.CanvasTexture(this.barCanvas);
    this.barTexture.colorSpace = THREE.SRGBColorSpace;
    this.barMaterial = new THREE.SpriteMaterial({ map: this.barTexture, transparent: true, depthTest: !THROUGH_WALLS, depthWrite: false, fog: false });
    this.bar = new THREE.Sprite(this.barMaterial);
    this.bar.renderOrder = 998;
    this.bar.visible = false;
    this.drawBar();
  }

  /** The bar sprite (add it to the scene next to the tag). */
  get healthBar(): THREE.Sprite {
    return this.bar;
  }

  /** Health 0..1. Redraws only when it changes. */
  setHealth(frac: number): void {
    frac = Math.max(0, Math.min(1, frac));
    if (frac === this.hp) return;
    this.hp = frac;
    this.drawBar();
  }

  private drawBar(): void {
    const c = this.barCanvas.getContext('2d')!;
    const w = this.barCanvas.width;
    const h = this.barCanvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(12, 18, 30, 0.85)';
    c.beginPath();
    c.roundRect(0, 0, w, h, 4);
    c.fill();
    const color = this.hp > 0.5 ? '#3fd46b' : this.hp > 0.25 ? '#f0c040' : '#e0393e';
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(2, 2, Math.max(0, (w - 4) * this.hp), h - 4, 3);
    c.fill();
    this.barTexture.needsUpdate = true;
  }

  /** Place above the head; keep a readable size and fade out far away. */
  update(head: THREE.Vector3, camera: THREE.Camera): void {
    this.sprite.position.set(head.x, head.y + 0.55, head.z);
    const d = camera.position.distanceTo(this.sprite.position);
    const s = BASE_HEIGHT * Math.max(1, d / SCALE_FROM);
    this.sprite.scale.set(s * this.aspect, s, 1);
    this.material.opacity = 1 - THREE.MathUtils.clamp((d - FADE_FROM) / (FADE_TO - FADE_FROM), 0, 1);
    this.sprite.visible = this.material.opacity > 0.01;
    // Health bar just under the name, same scale.
    this.bar.position.set(head.x, head.y + 0.55 - s * 0.62, head.z);
    this.bar.scale.set(s * 2.6, s * 0.28, 1);
    this.barMaterial.opacity = this.material.opacity;
    this.bar.visible = this.sprite.visible && this.hp < 1;
  }

  dispose(): void {
    this.material.map?.dispose();
    this.material.dispose();
    this.barTexture.dispose();
    this.barMaterial.dispose();
  }
}
