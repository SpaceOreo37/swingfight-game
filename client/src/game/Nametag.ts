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
  }

  /** Place above the head; keep a readable size and fade out far away. */
  update(head: THREE.Vector3, camera: THREE.Camera): void {
    this.sprite.position.set(head.x, head.y + 0.55, head.z);
    const d = camera.position.distanceTo(this.sprite.position);
    const s = BASE_HEIGHT * Math.max(1, d / SCALE_FROM);
    this.sprite.scale.set(s * this.aspect, s, 1);
    this.material.opacity = 1 - THREE.MathUtils.clamp((d - FADE_FROM) / (FADE_TO - FADE_FROM), 0, 1);
    this.sprite.visible = this.material.opacity > 0.01;
  }

  dispose(): void {
    this.material.map?.dispose();
    this.material.dispose();
  }
}
