import * as THREE from 'three';

/**
 * Shows where a web will stick if fired now. Drawn on top of everything and
 * always the same size on screen. Bright when you can fire (in the air),
 * faded when you can't (on the ground).
 */
export class SwingMarker {
  readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly shown = new THREE.Vector3();
  private time = 0;
  private visible = false;

  constructor() {
    this.material = new THREE.SpriteMaterial({
      map: markerTexture(),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = 999;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
  }

  update(target: THREE.Vector3 | null, ready: boolean, dt: number): void {
    this.time += dt;
    if (!target) {
      this.sprite.visible = this.visible = false;
      return;
    }
    // Glide between nearby points, snap to far ones.
    if (!this.visible || this.shown.distanceTo(target) > 12) this.shown.copy(target);
    else this.shown.lerp(target, Math.min(1, dt * 25));
    this.sprite.visible = this.visible = true;
    this.sprite.position.copy(this.shown);

    const pulse = ready ? 1 + Math.sin(this.time * 8) * 0.08 : 1;
    this.sprite.scale.setScalar(0.035 * pulse);
    this.material.opacity = ready ? 1 : 0.35;
  }
}

/** Diamond with a dot in the middle, drawn in code (no image to download). */
function markerTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const h = s / 2;
  ctx.translate(h, h);
  ctx.rotate(Math.PI / 4);
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeRect(-17, -17, 34, 34);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(-17, -17, 34, 34);
  ctx.rotate(-Math.PI / 4);
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4d4d';
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
