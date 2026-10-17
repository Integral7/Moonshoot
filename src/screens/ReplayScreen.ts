import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { MOON, moonPosition } from '../physics/bodies';
import { R_EARTH } from '../physics/constants';
import { add } from '../physics/vec';
import { eciDirToScene } from '../render/coords';
import { MapView } from '../render/MapView';
import { createPlume, plumeColorFor, type Plume } from '../render/plume';
import { buildVehicleModel, type VehicleModel } from '../render/vehicleMesh';
import { trackAt, type Replay } from '../sim/replay';
import { analyzeDesign } from '../sim/vehicle';
import { formatDuration, formatMET } from '../sim/time';
import { TelemetryGraph } from '../ui/TelemetryGraph';
import { h } from '../ui/dom';

const SPEEDS = [1, 10, 100, 1_000, 10_000, 100_000];
const CLOSE_PHASES = new Set(['launch', 'landing']);

/** Plays back a recorded phase: vehicle on its track, trail, scrubber, synced telemetry graph. */
export class ReplayScreen implements Screen {
  readonly id = 'replay';
  private map!: MapView;
  private model: VehicleModel | null = null;
  private plumes: { stage: number; plume: Plume }[] = [];
  private trails: THREE.Line[] = [];
  private graph!: TelemetryGraph;
  private tau = 0;
  private t0 = 0;
  private t1 = 1;
  private speed = 1;
  private playing = true;
  private time = 0;
  private scrubber!: HTMLInputElement;
  private clock!: HTMLElement;
  private speedSel!: HTMLSelectElement;
  private playBtn!: HTMLButtonElement;
  private graphTimer = 0;
  private shownStage = -1;

  constructor(readonly replay: Replay) {}

  enter(app: App, ui: HTMLElement): void {
    const r = this.replay;
    const k = r.track;
    this.t0 = k.t[0];
    this.t1 = k.t[k.t.length - 1];
    this.tau = this.t0;
    // Auto speed: the whole recording in about a minute.
    const dur = this.t1 - this.t0;
    this.speed = SPEEDS.reduce((best, s) => (Math.abs(Math.log(dur / s / 60)) < Math.abs(Math.log(dur / best / 60)) ? s : best), 1);

    this.map = new MapView(app, ui);
    this.map.world.eph = r.eph;
    this.map.markerHideDistance = 8_000;
    try {
      this.model = buildVehicleModel(r.design, { segments: app.quality.level === 'low' ? 14 : 24 });
      this.map.setVesselModel(this.model.root);
      const a = analyzeDesign(r.design);
      for (const n of this.model.nozzles) {
        const eng = a.stages[n.stage]?.parts.find((p) => p.engine);
        const plume = createPlume(n.radius, plumeColorFor(eng?.id ?? ''));
        plume.mesh.position.copy(n.position);
        this.model.stages[n.stage].add(plume.mesh);
        this.plumes.push({ stage: n.stage, plume });
      }
    } catch {
      this.model = null;
    }
    this.buildTrails();
    const close = CLOSE_PHASES.has(r.phase);
    if (close) {
      this.map.setFocus('vessel');
      this.map.cam.minDistance = 10;
      this.map.cam.setDistance(r.phase === 'launch' ? 400 : 120, true);
      this.map.cam.setAngles(-0.9, 0.2, true);
    } else {
      const moonish = k.body[0] === 1;
      this.map.setFocus(moonish ? 'moon' : 'earth');
      this.map.cam.setDistance(moonish ? MOON.radius * 7 : r.phase === 'orbit' ? R_EARTH * 4 : 9e8, true);
      this.map.cam.setAngles(0.4, 0.9, true);
    }

    this.graph = new TelemetryGraph(r.telemetry, { height: 120, onScrub: (t) => this.seek(t) });
    this.scrubber = h('input', { type: 'range', class: 'replay-scrub', id: 'replay-scrub', attrs: { min: '0', max: '1000', step: '1' }, value: '0' }) as HTMLInputElement;
    this.scrubber.addEventListener('input', () => this.seek(this.t0 + (Number(this.scrubber.value) / 1000) * (this.t1 - this.t0)));
    this.clock = h('span', { class: 'mono met', id: 'replay-clock', text: formatMET(this.tau) });
    this.speedSel = h('select', { class: 'select', id: 'replay-speed' }) as HTMLSelectElement;
    for (const s of SPEEDS) this.speedSel.append(h('option', { value: String(s), text: `${s.toLocaleString('en-US')}x` }));
    this.speedSel.value = String(this.speed);
    this.speedSel.addEventListener('change', () => (this.speed = Number(this.speedSel.value)));
    this.playBtn = h('button', { class: 'btn btn-small', id: 'replay-play', text: 'Pause', onclick: () => this.togglePlay() }) as HTMLButtonElement;
    ui.append(
      h(
        'div',
        { class: 'hud-top' },
        h('div', { class: 'hud-phase' }, h('span', { class: 'brand', text: 'REPLAY' }), h('span', { class: 'muted', text: ' / ' }), h('span', { text: `${r.title} · ${r.success ? `score ${r.score}` : 'failed'} · ${new Date(r.date).toLocaleString()}` })),
        this.clock,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-small', id: 'replay-focus', text: 'Focus', onclick: () => this.map.cycleFocus() }),
          h('button', { class: 'btn btn-small', id: 'replay-back', text: 'Back', onclick: () => app.go('replays') }),
        ),
      ),
      h(
        'div',
        { class: 'panel replay-panel' },
        h('div', { class: 'row' }, this.playBtn, this.speedSel, this.scrubber, h('span', { class: 'muted small mono', text: formatDuration(dur) })),
        this.graph.root,
      ),
    );
  }

  private buildTrails(): void {
    const k = this.replay.track;
    let start = 0;
    const flush = (end: number) => {
      if (end - start < 1) return;
      const body = k.body[start];
      const pts = new Float32Array((end - start + 1) * 3);
      for (let i = start; i <= end; i++) {
        const o = (i - start) * 3;
        pts[o] = k.x[i];
        pts[o + 1] = k.z[i];
        pts[o + 2] = -k.y[i];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: body === 1 ? 0xffb547 : 0x5cc8ff, transparent: true, opacity: 0.75 }));
      line.frustumCulled = false;
      (body === 1 ? this.map.world.moonAnchor : this.map.world.earthAnchor).add(line);
      this.trails.push(line);
    };
    for (let i = 1; i < k.t.length; i++) {
      if (k.body[i] !== k.body[i - 1]) {
        flush(i - 1);
        start = i;
      }
    }
    flush(k.t.length - 1);
  }

  private seek(t: number): void {
    this.tau = Math.max(this.t0, Math.min(this.t1, t));
  }

  private togglePlay(): void {
    if (this.tau >= this.t1) this.tau = this.t0;
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
  }

  exit(): void {
    for (const l of this.trails) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    for (const p of this.plumes) p.plume.dispose();
    this.model?.dispose();
    this.map.dispose();
  }

  update(dt: number): void {
    this.time += dt;
    if (this.playing) {
      this.tau += dt * this.speed;
      if (this.tau >= this.t1) {
        this.tau = this.t1;
        this.playing = false;
        this.playBtn.textContent = 'Play';
      }
    }
    const s = trackAt(this.replay.track, this.tau);
    const eph = this.replay.eph;
    this.map.vesselBody = s.body;
    this.map.vesselEci = s.body === 'moon' ? add(moonPosition(this.tau, eph), s.r) : s.r;
    if (this.model) {
      const len = Math.hypot(s.dir.x, s.dir.y, s.dir.z) || 1;
      const d = eciDirToScene({ x: s.dir.x / len, y: s.dir.y / len, z: s.dir.z / len });
      this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      if (s.stage !== this.shownStage) {
        this.shownStage = s.stage;
        this.model.stages.forEach((g, i) => (g.visible = i >= s.stage));
        if (this.model.les) this.model.les.visible = s.stage === 0;
      }
      for (const p of this.plumes) p.plume.update(p.stage === s.stage ? s.throttle : 0, 0.8, this.time);
      this.map.cam.up.copy(this.map.focus === 'vessel' ? eciDirToScene(s.r).normalize() : new THREE.Vector3(0, 1, 0));
    }
    this.map.update(this.tau, dt);
    this.clock.textContent = formatMET(this.tau);
    if (document.activeElement !== this.scrubber) this.scrubber.value = String(Math.round(((this.tau - this.t0) / Math.max(1e-6, this.t1 - this.t0)) * 1000));
    this.graphTimer -= dt;
    if (this.graphTimer <= 0) {
      this.graphTimer = 0.1;
      this.graph.setCursor(this.tau);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.map.render(renderer);
  }

  onQualityChange(): void {
    this.map.onQualityChange();
  }

  debugState(): Record<string, unknown> {
    return { replay: this.replay.id, tau: this.tau, t0: this.t0, t1: this.t1, playing: this.playing, samples: this.replay.track.t.length };
  }

  debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'seek') this.seek(this.t0 + Number(arg) * (this.t1 - this.t0));
    else if (cmd === 'speed') this.speed = Number(arg);
    return this.debugState();
  }
}
