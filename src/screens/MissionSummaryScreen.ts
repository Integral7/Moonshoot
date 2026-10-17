import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { createStarfield, disposeObject, updateStarfield } from '../render/starfield';
import { PHASES, PHASE_IDS, type Mission } from '../sim/mission';
import { rate } from '../sim/scoring';
import { formatMET } from '../sim/time';
import { h } from '../ui/dom';

/** End-of-campaign debrief: every phase's score and the mission total. */
export class MissionSummaryScreen implements Screen {
  readonly id = 'summary';
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2e5);
  private stars: THREE.Points | null = null;
  private time = 0;

  constructor(private mission: Mission) {}

  enter(app: App, ui: HTMLElement): void {
    this.stars = createStarfield(app.quality.starCount);
    this.scene.add(this.stars);
    const m = this.mission;
    const byPhase = new Map(m.results.map((r) => [r.phase, r]));
    const total = m.totalScore;
    const max = PHASE_IDS.length * 1000;
    const avgRating = rate(total / PHASE_IDS.length, m.results.every((r) => r.success));
    const splash = m.carry.splash as { lat: number; lon: number; ocean: boolean; speed: number } | undefined;
    const lastT = Math.max(0, ...m.results.map((r) => r.t));
    const rows = PHASE_IDS.map((id) => {
      const r = byPhase.get(id);
      return h(
        'tr',
        {},
        h('td', { text: `${PHASES[id].index}. ${PHASES[id].title}` }),
        h('td', { class: 'mono', text: r ? String(r.score) : '--' }),
        h('td', {}, r ? h('span', { class: `rating rating-${r.rating}`, text: r.rating.toUpperCase() }) : null),
      );
    });
    ui.append(
      h(
        'div',
        { class: 'modal-backdrop' },
        h(
          'div',
          { class: 'panel modal results', id: 'mission-summary' },
          h('div', { class: 'results-banner good', text: 'MISSION COMPLETE' }),
          h('h2', { text: 'Moonshot debrief' }),
          h(
            'div',
            { class: 'score-row' },
            h('div', { class: 'score mono', id: 'mission-total', text: total.toLocaleString('en-US') }),
            h('div', {}, h('div', { class: `rating rating-${avgRating}`, text: avgRating.toUpperCase() }), h('div', { class: 'muted small', text: `of ${max.toLocaleString('en-US')} · mission time ${formatMET(lastT)}` })),
          ),
          splash ? h('p', { class: 'summary', text: `Splashdown at ${splash.lat.toFixed(2)}°, ${splash.lon.toFixed(2)}° ${splash.ocean ? 'in the ocean' : 'on land'} at ${splash.speed.toFixed(1)} m/s. The crew is home.` }) : null,
          h('table', { class: 'budget summary-table' }, h('tr', {}, h('th', { text: 'Phase' }), h('th', { text: 'Score' }), h('th', { text: 'Rating' })), ...rows),
          h(
            'div',
            { class: 'row end results-actions' },
            h('button', { class: 'btn', id: 'summary-replays', text: 'Replays', onclick: () => app.go('replays') }),
            h('button', { class: 'btn btn-primary', id: 'summary-menu', text: 'Main menu', onclick: () => app.go('menu') }),
          ),
        ),
      ),
    );
  }

  exit(): void {
    disposeObject(this.scene);
  }

  update(dt: number): void {
    this.time += dt;
    this.camera.rotation.set(0.05, this.time * 0.01, 0);
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
    return { total: this.mission.totalScore, phases: this.mission.results.length };
  }
}
