import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { createStarfield, disposeObject, updateStarfield } from '../render/starfield';
import { deleteReplay, listReplays } from '../sim/replay';
import { formatDuration } from '../sim/time';
import { clear, h } from '../ui/dom';
import { ReplayScreen } from './ReplayScreen';

/** Saved replays: open or delete. */
export class ReplayListScreen implements Screen {
  readonly id = 'replays';
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2e5);
  private stars: THREE.Points | null = null;
  private time = 0;
  private listEl!: HTMLElement;
  private app!: App;

  enter(app: App, ui: HTMLElement): void {
    this.app = app;
    this.stars = createStarfield(app.quality.starCount);
    this.scene.add(this.stars);
    this.listEl = h('div', { class: 'phase-grid', id: 'replay-list' });
    ui.append(
      h(
        'div',
        { class: 'freeplay' },
        h('div', { class: 'row between' }, h('h1', { text: 'Replays' }), h('button', { class: 'btn', id: 'replays-back', text: 'Back', onclick: () => app.go('menu') })),
        h('p', { class: 'muted', text: 'Every flight phase you finish is recorded. The newest eight are kept in this browser.' }),
        this.listEl,
      ),
    );
    this.render_();
  }

  private render_(): void {
    clear(this.listEl);
    const list = listReplays();
    if (!list.length) {
      this.listEl.append(h('p', { class: 'muted', text: 'No replays yet. Fly a phase from Campaign or Free Play.' }));
      return;
    }
    for (const r of list) {
      const dur = r.track.t[r.track.t.length - 1] - r.track.t[0];
      this.listEl.append(
        h(
          'div',
          { class: 'phase-card replay-card', dataset: { id: r.id } },
          h('div', { class: 'phase-title', text: r.title }),
          h('div', { class: `small ${r.success ? 'good' : 'bad'}`, text: r.success ? `Score ${r.score}` : 'Failed' }),
          h('div', { class: 'muted small', text: `${new Date(r.date).toLocaleString()} · ${formatDuration(dur)}` }),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn btn-small btn-primary', text: 'Play', onclick: () => this.app.go(new ReplayScreen(r)) }),
            h('button', {
              class: 'btn btn-small btn-danger',
              text: 'Delete',
              onclick: () => {
                deleteReplay(r.id);
                this.render_();
              },
            }),
          ),
        ),
      );
    }
  }

  exit(): void {
    disposeObject(this.scene);
  }

  update(dt: number): void {
    this.time += dt;
    this.camera.rotation.set(-0.1, this.time * 0.006, 0);
    if (this.stars) updateStarfield(this.stars, this.time, this.camera);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(w: number, hh: number): void {
    this.camera.aspect = w / Math.max(1, hh);
    this.camera.updateProjectionMatrix();
  }

  debugState(): Record<string, unknown> {
    return { count: listReplays().length };
  }
}
