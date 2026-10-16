import * as THREE from 'three';
import { h } from './dom';

interface Label {
  el: HTMLElement;
  position: THREE.Vector3;
  visible: boolean;
}

/** DOM labels projected from scene positions each frame. */
export class Labels {
  readonly root: HTMLElement;
  private labels = new Map<string, Label>();
  private tmp = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'labels passthrough' });
    parent.append(this.root);
  }

  set(id: string, text: string, cls = ''): THREE.Vector3 {
    let l = this.labels.get(id);
    if (!l) {
      l = { el: h('div', { class: `label ${cls}` }), position: new THREE.Vector3(), visible: true };
      this.root.append(l.el);
      this.labels.set(id, l);
    }
    if (l.el.textContent !== text) l.el.textContent = text;
    return l.position;
  }

  show(id: string, visible: boolean): void {
    const l = this.labels.get(id);
    if (l) l.visible = visible;
  }

  remove(id: string): void {
    this.labels.get(id)?.el.remove();
    this.labels.delete(id);
  }

  update(camera: THREE.Camera, width: number, height: number): void {
    for (const l of this.labels.values()) {
      this.tmp.copy(l.position).project(camera);
      const onScreen = l.visible && this.tmp.z < 1 && this.tmp.z > -1 && Math.abs(this.tmp.x) < 1.2 && Math.abs(this.tmp.y) < 1.2;
      l.el.style.display = onScreen ? '' : 'none';
      if (onScreen) {
        const x = (this.tmp.x * 0.5 + 0.5) * width;
        const y = (-this.tmp.y * 0.5 + 0.5) * height;
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  }
}
