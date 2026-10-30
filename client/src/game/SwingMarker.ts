import * as THREE from 'three';

export type MarkerMode = 'idle' | 'ready' | 'anchor';

/** Size on screen (fraction of screen height). */
const SIZE = 0.1;
/** Tints: faded when you can't fire, white when you can, gold when C is held (zip / launch). */
const COLORS: Record<MarkerMode, number> = { idle: 0xffffff, ready: 0xffffff, anchor: 0xffd23f };

/**
 * Shows where a web will stick if fired now. Drawn on top of everything,
 * always the same size on screen, with a pulsing ring when you can fire.
 */
export class SwingMarker {
  readonly sprite: THREE.Sprite;
  private readonly ring: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly ringMaterial: THREE.SpriteMaterial;
  private readonly shown = new THREE.Vector3();
  private time = 0;
  private visible = false;

  constructor() {
    const mat = (map: THREE.Texture) =>
      new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, fog: false });
    this.material = mat(markerTexture());
    this.ringMaterial = mat(ringTexture());
    this.sprite = new THREE.Sprite(this.material);
    this.ring = new THREE.Sprite(this.ringMaterial);
    this.sprite.add(this.ring);
    this.sprite.renderOrder = 999;
    this.ring.renderOrder = 999;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
    this.ring.frustumCulled = false;
  }

  update(target: THREE.Vector3 | null, mode: MarkerMode, dt: number): void {
    this.time += dt;
    if (!target) {
      this.sprite.visible = this.visible = false;
      return;
    }
    // Glide between nearby points, snap to far ones.
    if (!this.visible || this.shown.distanceTo(target) > 12) this.shown.copy(target);
    else this.shown.lerp(target, Math.min(1, dt * 30));
    this.sprite.visible = this.visible = true;
    this.sprite.position.copy(this.shown);

    const active = mode !== 'idle';
    const pulse = active ? 1 + Math.sin(this.time * 9) * 0.07 : 1;
    this.sprite.scale.setScalar(SIZE * pulse);
    this.material.opacity = active ? 1 : 0.45;
    this.material.color.setHex(COLORS[mode]);

    // Ring: expands and fades, over and over, while you can fire.
    const t = (this.time * 1.6) % 1;
    this.ring.visible = active;
    this.ring.scale.setScalar(1 + t * 0.9); // relative to the marker
    this.ringMaterial.opacity = (1 - t) * 0.8;
    this.ringMaterial.color.setHex(COLORS[mode]);
  }
}

/** Bold diamond with a dark outline and a red center: readable on sky and buildings. */
function markerTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.translate(s / 2, s / 2);
  const diamond = (size: number) => {
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size, 0);
    ctx.closePath();
  };
  // Dark outline, then white stroke, then a soft inner fill.
  diamond(40);
  ctx.lineWidth = 16;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
  // Center dot.
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#ff3b3b';
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ringTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
