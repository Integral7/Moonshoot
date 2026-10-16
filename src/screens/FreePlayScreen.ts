import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { createPhaseScreen, phaseAvailable } from '../app/phases';
import { Mission, PHASES, PHASE_IDS } from '../sim/mission';
import { createStarfield, disposeObject, updateStarfield } from '../render/starfield';
import { h } from '../ui/dom';

/** Free play: start any phase directly from a canonical state. */
export class FreePlayScreen implements Screen {
  readonly id = 'freeplay';
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2e5);
  private stars: THREE.Points | null = null;
  private time = 0;

  enter(app: App, ui: HTMLElement): void {
    this.stars = createStarfield(app.quality.starCount);
    this.scene.add(this.stars);
    const cards = PHASE_IDS.map((id) => {
      const p = PHASES[id];
      const ok = phaseAvailable(id);
      return h(
        'button',
        {
          class: 'phase-card',
          id: `fp-${id}`,
          disabled: !ok,
          onclick: () => {
            const s = createPhaseScreen(new Mission('freeplay', id));
            if (s) app.go(s);
          },
        },
        h('div', { class: 'phase-num mono', text: `0${p.index}` }),
        h('div', { class: 'phase-title', text: p.title }),
        h('div', { class: 'muted small', text: ok ? p.description : 'Coming in a later milestone.' }),
      );
    });
    ui.append(
      h(
        'div',
        { class: 'freeplay' },
        h('div', { class: 'row between' }, h('h1', { text: 'Free Play' }), h('button', { class: 'btn', id: 'fp-back', text: 'Back', onclick: () => app.go('menu') })),
        h('p', { class: 'muted', text: 'Jump into any phase of the mission from a standard starting state.' }),
        h('div', { class: 'phase-grid' }, ...cards),
      ),
    );
  }

  exit(): void {
    disposeObject(this.scene);
  }

  update(dt: number): void {
    this.time += dt;
    this.camera.rotation.set(0.1, this.time * 0.008, 0);
    if (this.stars) updateStarfield(this.stars, this.time, this.camera);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(w: number, hh: number): void {
    this.camera.aspect = w / Math.max(1, hh);
    this.camera.updateProjectionMatrix();
  }
}
