import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { createStarfield, disposeObject, updateStarfield } from '../render/starfield';
import { createSettingsPanel } from '../ui/SettingsPanel';
import { h } from '../ui/dom';

export class MainMenuScreen implements Screen {
  readonly id = 'menu';
  private app!: App;
  private ui!: HTMLElement;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2e5);
  private stars: THREE.Points | null = null;
  private time = 0;

  enter(app: App, ui: HTMLElement): void {
    this.app = app;
    this.ui = ui;
    this.buildScene();
    this.buildUi();
  }

  exit(): void {
    disposeObject(this.scene);
  }

  update(dt: number): void {
    this.time += dt;
    this.camera.rotation.set(0.15 * Math.sin(this.time * 0.02), this.time * 0.01, 0);
    if (this.stars) updateStarfield(this.stars, this.time, this.camera);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  onQualityChange(): void {
    if (this.stars) {
      this.scene.remove(this.stars);
      disposeObject(this.stars);
    }
    this.stars = createStarfield(this.app.quality.starCount);
    this.scene.add(this.stars);
  }

  private buildScene(): void {
    this.onQualityChange();
  }

  private buildUi(): void {
    const menu = h(
      'div',
      { class: 'menu' },
      h('div', { class: 'title-block' },
        h('h1', { class: 'title', text: 'MOONSHOT' }),
        h('p', { class: 'subtitle', text: 'A lunar mission from the drawing board to splashdown' }),
      ),
      h('div', { class: 'menu-buttons' },
        h('button', { class: 'btn btn-primary', id: 'btn-campaign', text: 'Campaign', disabled: true, title: 'Coming in a later milestone' }),
        h('button', { class: 'btn', id: 'btn-freeplay', text: 'Free Play', disabled: true, title: 'Coming in a later milestone' }),
        h('button', { class: 'btn', id: 'btn-replays', text: 'Replays', disabled: true, title: 'Coming in a later milestone' }),
        h('button', { class: 'btn', id: 'btn-settings', text: 'Settings', onclick: () => this.openSettings() }),
      ),
      h('p', { class: 'muted small footer-note', text: 'Real constants. Patched conics. No assets: every pixel is procedural.' }),
    );
    this.ui.append(menu);
  }

  private openSettings(): void {
    const panel = createSettingsPanel(this.app, () => panel.remove());
    this.ui.append(panel);
  }
}
