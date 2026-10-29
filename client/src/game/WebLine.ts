import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/** A thin white strand from the hand to the anchor point. */
export class WebLine {
  readonly mesh: THREE.Mesh;

  constructor() {
    const geo = new THREE.CylinderGeometry(0.03, 0.03, 1, 5, 1, true);
    geo.translate(0, 0.5, 0); // pivot at one end
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf4f4f4 }));
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  update(from: THREE.Vector3, to: THREE.Vector3 | null): void {
    if (!to) {
      this.mesh.visible = false;
      return;
    }
    _dir.subVectors(to, from);
    const len = _dir.length();
    this.mesh.visible = true;
    this.mesh.position.copy(from);
    this.mesh.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
    this.mesh.scale.set(1, len, 1);
  }
}
