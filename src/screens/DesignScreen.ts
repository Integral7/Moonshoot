import * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { goToPhase, phaseEndActions } from '../app/flow';
import { OrbitCamera } from '../render/OrbitCamera';
import { PostFX } from '../render/PostFX';
import { buildVehicleModel, type VehicleModel } from '../render/vehicleMesh';
import type { Mission } from '../sim/mission';
import { CATEGORY_LABELS, PARTS, getPart, type PartCategory, type PartDef } from '../sim/parts';
import { buildResult, linearScore, toleranceScore, type Metric } from '../sim/scoring';
import {
  DEFAULT_DESIGN,
  TEMPLATES,
  allocateBudget,
  analyzeDesign,
  type BudgetAllocation,
  type DesignAnalysis,
  type VehicleDesign,
} from '../sim/vehicle';
import { createResultsPanel } from '../ui/ResultsPanel';
import { clear, h } from '../ui/dom';

const STORAGE_KEY = 'moonshot.design.v1';

interface Run {
  id: string;
  start: number;
  count: number;
}

function runsOf(parts: string[]): Run[] {
  const runs: Run[] = [];
  parts.forEach((id, i) => {
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.count++;
    else runs.push({ id, start: i, count: 1 });
  });
  return runs;
}

const fmtMass = (kg: number) => (kg >= 10_000 ? `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} t` : `${(kg / 1000).toFixed(2)} t`);
const fmtKn = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MN` : `${(n / 1000).toFixed(0)} kN`);
const fmtDv = (v: number) => `${Math.round(v).toLocaleString('en-US')} m/s`;

function partStats(p: PartDef): string {
  const bits = [fmtMass(p.mass)];
  if (p.prop) bits.push(`${fmtMass(p.prop)} prop`);
  if (p.engine) bits.push(`${fmtKn(p.engine.thrustVac)} vac`, `Isp ${p.engine.ispSl}/${p.engine.ispVac} s`, p.engine.minThrottle >= 1 ? 'fixed' : `${Math.round(p.engine.minThrottle * 100)}-100%`);
  if (p.crew) bits.push(`${p.crew} crew`);
  if (p.chutes) bits.push(`max ${fmtMass(p.chutes.maxMass)}`);
  bits.push(`${p.diameter} m`);
  return bits.join(' · ');
}

/** Phase 1: assemble the vehicle from parts with live mass, thrust, and delta-v budget. */
export class DesignScreen implements Screen {
  readonly id = 'design';
  private app!: App;
  private ui!: HTMLElement;
  private design!: VehicleDesign;
  private analysis!: DesignAnalysis;
  private budget!: BudgetAllocation;
  private selected = -1; // part index of the selected run start
  private scene = new THREE.Scene();
  private cam = new OrbitCamera(40, 120, 8, 2000);
  private fx!: PostFX;
  private model: VehicleModel | null = null;
  private highlight: THREE.Box3Helper | null = null;
  private stackEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private approveBtn!: HTMLButtonElement;
  private rebuildPending = true;
  private time = 0;
  private ended = false;
  private keyLight!: THREE.DirectionalLight;
  // Floor + vehicle; offset so the vehicle center sits at the camera focus.
  private content = new THREE.Group();

  constructor(private mission: Mission) {}

  enter(app: App, ui: HTMLElement): void {
    this.app = app;
    this.ui = ui;
    const carried = this.mission.carry.design as VehicleDesign | undefined;
    this.design = structuredClone(carried ?? this.loadSaved() ?? DEFAULT_DESIGN);
    this.buildScene();
    this.buildUi();
    this.refresh();
  }

  private loadSaved(): VehicleDesign | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as VehicleDesign;
      if (!Array.isArray(d.parts) || !d.parts.every((id) => PARTS.some((p) => p.id === id))) return null;
      return d;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.design));
    } catch {
      /* not persisted */
    }
  }

  // ---- Scene ----------------------------------------------------------------
  private buildScene(): void {
    const q = this.app.quality;
    this.scene.background = new THREE.Color(0x0a0f17);
    this.scene.fog = new THREE.Fog(0x0a0f17, 400, 1600);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20252c, 0.9));
    const key = new THREE.DirectionalLight(0xfff1dd, 2.6);
    key.position.set(60, 120, 80);
    key.castShadow = q.shadows;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -80;
    sc.right = sc.top = 80;
    sc.far = 400;
    this.keyLight = key;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.0);
    rim.position.set(-80, 40, -60);
    this.scene.add(rim);
    // Pad and floor grid.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(400, 64),
      new THREE.MeshStandardMaterial({ color: 0x151a21, roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.content.add(floor);
    const grid = new THREE.GridHelper(400, 80, 0x2a3646, 0x1a2230);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = 0.02;
    this.content.add(grid);
    this.scene.add(this.content);
    this.app.renderer.shadowMap.enabled = q.shadows;
    this.cam.attach(this.app.root);
    this.cam.setAngles(0.7, 0.18, true);
    this.fx = new PostFX(this.scene, this.cam.camera, () => this.app.quality, 0.25);
  }

  private rebuildModel(): void {
    if (this.model) {
      this.content.remove(this.model.root);
      this.model.dispose();
      this.model = null;
    }
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.dispose();
      this.highlight = null;
    }
    if (!this.design.parts.length) return;
    try {
      this.model = buildVehicleModel(this.design, { segments: this.app.quality.level === 'low' ? 20 : 40 });
    } catch {
      return;
    }
    this.content.add(this.model.root);
    this.content.position.y = -this.model.height * 0.5;
    const target = this.model.height * 1.9 + 20;
    this.cam.setDistance(Math.max(target, 30));
    this.updateHighlight();
  }

  private updateHighlight(): void {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.dispose();
      this.highlight = null;
    }
    if (!this.model || this.selected < 0) return;
    const run = runsOf(this.design.parts).find((r) => r.start === this.selected);
    if (!run) return;
    const box = new THREE.Box3();
    let any = false;
    this.scene.updateMatrixWorld(true);
    for (let i = run.start; i < run.start + run.count; i++) {
      for (const m of this.model.partMeshes.get(i) ?? []) {
        box.expandByObject(m);
        any = true;
      }
    }
    if (!any) return;
    box.expandByScalar(0.4);
    this.highlight = new THREE.Box3Helper(box, new THREE.Color(0xffb547));
    this.scene.add(this.highlight);
  }

  // ---- UI -------------------------------------------------------------------
  private buildUi(): void {
    const cats: PartCategory[] = ['capsule', 'shield', 'chutes', 'les', 'tank', 'engine', 'decoupler', 'legs'];
    const palette = h(
      'div',
      { class: 'panel design-palette', id: 'design-palette' },
      h('h3', { text: 'Parts' }),
      h('p', { class: 'muted small', text: 'Click a part to add it below the selected row.' }),
      ...cats.map((c) =>
        h(
          'div',
          { class: 'palette-section' },
          h('div', { class: 'palette-cat', text: CATEGORY_LABELS[c] }),
          ...PARTS.filter((p) => p.category === c).map((p) =>
            h(
              'button',
              { class: 'part-card', dataset: { part: p.id }, title: p.description, onclick: () => this.addPart(p.id) },
              h('div', { class: 'part-name', text: p.name }),
              h('div', { class: 'part-stats mono', text: partStats(p) }),
            ),
          ),
        ),
      ),
    );
    const templateSel = h('select', { class: 'select', id: 'template-select' }) as HTMLSelectElement;
    templateSel.append(h('option', { text: 'Load template...', value: '' }));
    TEMPLATES.forEach((t, i) => templateSel.append(h('option', { text: t.name, value: String(i) })));
    templateSel.addEventListener('change', () => {
      const i = Number(templateSel.value);
      if (templateSel.value !== '' && TEMPLATES[i]) {
        this.design = structuredClone(TEMPLATES[i]);
        this.selected = -1;
        this.refresh();
      }
      templateSel.value = '';
    });
    this.stackEl = h('div', { class: 'stack-list', id: 'stack-list' });
    this.statsEl = h('div', { class: 'design-stats', id: 'design-stats' });
    this.approveBtn = h('button', { class: 'btn btn-primary', id: 'btn-approve', text: 'Approve design', onclick: () => this.approve() });
    const right = h(
      'div',
      { class: 'panel design-right' },
      h('div', { class: 'row between' }, h('h3', { text: 'Stack (top to bottom)' }), templateSel),
      this.stackEl,
    );
    const stats = h('div', { class: 'panel design-bottom' }, this.statsEl, h('div', { class: 'row end' }, this.approveBtn));
    const top = h(
      'div',
      { class: 'hud-top' },
      h('div', { class: 'hud-phase' }, h('span', { class: 'brand', text: 'MOONSHOT' }), h('span', { class: 'muted', text: ' / ' }), h('span', { text: `Phase 1: Vehicle Design${this.mission.mode === 'freeplay' ? ' (free play)' : ''}` })),
      h('div', { class: 'muted small', text: 'Drag to rotate · wheel to zoom' }),
      h('button', { class: 'btn btn-small', id: 'btn-design-menu', text: 'Main menu', onclick: () => this.app.go('menu') }),
    );
    this.ui.append(h('div', { class: 'design' }, top, palette, right, stats));
  }

  private addPart(id: string): void {
    const parts = this.design.parts;
    let at = parts.length;
    if (this.selected >= 0) {
      const run = runsOf(parts).find((r) => r.start === this.selected);
      if (run) at = run.start + run.count;
    }
    parts.splice(at, 0, id);
    this.selectIndex(at);
    this.refresh();
  }

  /** Select the run containing part index i. */
  private selectIndex(i: number): void {
    const run = runsOf(this.design.parts).find((r) => i >= r.start && i < r.start + r.count);
    this.selected = run ? run.start : -1;
  }

  private runOp(run: Run, op: 'inc' | 'dec' | 'up' | 'down' | 'del'): void {
    const parts = this.design.parts;
    const runs = runsOf(parts);
    const k = runs.findIndex((r) => r.start === run.start);
    switch (op) {
      case 'inc':
        parts.splice(run.start + run.count, 0, run.id);
        this.selected = run.start;
        break;
      case 'dec':
        parts.splice(run.start + run.count - 1, 1);
        this.selected = run.count > 1 ? run.start : -1;
        break;
      case 'del':
        parts.splice(run.start, run.count);
        this.selected = -1;
        break;
      case 'up':
      case 'down': {
        const other = runs[op === 'up' ? k - 1 : k + 1];
        if (!other) return;
        const block = parts.splice(run.start, run.count);
        const otherStart = op === 'up' ? other.start : other.start - run.count;
        const insertAt = op === 'up' ? otherStart : otherStart + other.count;
        parts.splice(insertAt, 0, ...block);
        this.selectIndex(insertAt);
        break;
      }
    }
    this.refresh();
  }

  private refresh(): void {
    this.analysis = analyzeDesign(this.design);
    this.budget = allocateBudget(this.analysis);
    this.renderStack();
    this.renderStats();
    this.rebuildPending = true;
    this.save();
  }

  private stageRoles(): Map<number, string[]> {
    const roles = new Map<number, string[]>();
    for (const l of this.budget.legs) for (const s of l.stages) roles.set(s, [...(roles.get(s) ?? []), l.leg.label]);
    return roles;
  }

  private renderStack(): void {
    clear(this.stackEl);
    const parts = this.design.parts;
    if (!parts.length) {
      this.stackEl.append(h('p', { class: 'muted', text: 'Empty. Add a capsule from the parts list, or load a template.' }));
      return;
    }
    const stages = this.analysis.stages;
    const roles = this.stageRoles();
    const runs = runsOf(parts);
    // Stage of each part index (stage boundaries at decouplers; display top-down).
    let stageNo = stages.length - 1;
    const stageOf: number[] = [];
    parts.forEach((id, i) => {
      if (getPart(id).category === 'decoupler' && i > 0) stageNo--;
      stageOf.push(stageNo);
    });
    let lastStage = -2;
    for (const run of runs) {
      const st = stageOf[run.start];
      if (st !== lastStage) {
        lastStage = st;
        const info = stages[st];
        const isTop = st === stages.length - 1;
        const role = isTop ? 'Crew return' : st === this.budget.landingStage ? 'Lands, stays on Moon' : (roles.get(st) ?? ['Unused']).join(', ');
        this.stackEl.append(
          h(
            'div',
            { class: 'stage-header', dataset: { stage: String(st) } },
            h('span', { class: 'mono', text: `STAGE ${st + 1}` }),
            h('span', { class: 'muted small', text: role }),
            info && info.engine ? h('span', { class: 'mono small', text: `${fmtDv(st === 0 ? info.dvAscent : info.dvVac)} · TWR ${st === 0 ? info.twrEarth.toFixed(2) : info.twrMoon.toFixed(1) + ' (Moon)'}` }) : h('span', { class: 'mono small muted', text: info ? fmtMass(info.dryMass + info.propMass) : '' }),
          ),
        );
      }
      const p = getPart(run.id);
      const sel = run.start === this.selected;
      const btn = (label: string, op: Parameters<DesignScreen['runOp']>[1], title: string) =>
        h('button', {
          class: 'icon-btn',
          text: label,
          title,
          onclick: (e) => {
            e.stopPropagation();
            this.runOp(run, op);
          },
        });
      this.stackEl.append(
        h(
          'div',
          {
            class: `stack-row ${sel ? 'selected' : ''} cat-${p.category}`,
            dataset: { start: String(run.start), part: run.id },
            onclick: () => {
              this.selected = sel ? -1 : run.start;
              this.renderStack();
              this.updateHighlight();
            },
          },
          h('span', { class: 'stack-name', text: run.count > 1 ? `${p.name} ×${run.count}` : p.name }),
          h('span', { class: 'stack-btns' }, btn('+', 'inc', 'Add another'), btn('−', 'dec', 'Remove one'), btn('▲', 'up', 'Move up'), btn('▼', 'down', 'Move down'), btn('✕', 'del', 'Delete')),
        ),
      );
    }
  }

  private renderStats(): void {
    clear(this.statsEl);
    const a = this.analysis;
    const b = this.budget;
    const landing = b.landingStage >= 0 ? a.stages[b.landingStage] : null;
    const kv = (k: string, v: string, cls = '') => h('div', { class: 'kv' }, h('span', { class: 'muted', text: k }), h('span', { class: `mono ${cls}`, text: v }));
    const summary = h(
      'div',
      { class: 'kv-grid' },
      kv('Liftoff mass', fmtMass(a.totalMass)),
      kv('Height', `${a.totalLength.toFixed(1)} m`),
      kv('Liftoff TWR', a.liftoffTwr.toFixed(2), a.liftoffTwr < 1 ? 'bad' : a.liftoffTwr < 1.15 ? 'warn' : 'good'),
      kv('Stages', String(a.stages.length)),
      kv('Total Δv', fmtDv(b.totalDv)),
      kv('Mission margin', `${fmtDv(b.margin)} (${(b.marginFraction * 100).toFixed(0)}%)`, b.feasible ? (b.marginFraction < 0.05 ? 'warn' : 'good') : 'bad'),
      kv('Landing TWR', landing ? `${landing.twrMoon.toFixed(2)} (Moon)` : '--'),
      kv('Crew', String(a.crew)),
    );
    const legs = h(
      'table',
      { class: 'budget', id: 'budget-table' },
      h('tr', {}, h('th', { text: 'Mission leg' }), h('th', { text: 'Δv' }), h('th', { text: 'Stages' }), h('th', { text: '' })),
      ...b.legs.map((l) =>
        h(
          'tr',
          { class: l.ok ? '' : 'bad' },
          h('td', { text: l.leg.label }),
          h('td', { class: 'mono', text: fmtDv(l.leg.dv) }),
          h('td', { class: 'mono', text: l.stages.map((s) => s + 1).join(', ') || '--' }),
          h('td', { text: l.ok ? '✓' : '✗', class: l.ok ? 'good' : 'bad' }),
        ),
      ),
    );
    const problems = [...a.errors.map((e) => ['bad', e] as const), ...b.issues.filter((s) => !a.errors.includes(s)).map((e) => ['bad', e] as const), ...a.warnings.map((w) => ['warn', w] as const)];
    const list = problems.length
      ? h('ul', { class: 'design-issues', id: 'design-issues' }, ...problems.map(([c, t]) => h('li', { class: c, text: t })))
      : h('p', { class: 'good small', id: 'design-issues', text: 'All checks pass. The vehicle can fly the full mission.' });
    this.statsEl.append(h('div', { class: 'design-stats-cols' }, h('div', {}, summary, list), legs));
    this.approveBtn.disabled = !b.feasible;
    this.approveBtn.title = b.feasible ? 'Lock the design and roll out to the pad' : 'Fix the issues listed first';
  }

  private approve(): void {
    if (this.ended || !this.budget.feasible) return;
    this.ended = true;
    const a = this.analysis;
    const b = this.budget;
    const landing = a.stages[b.landingStage];
    const metrics: Metric[] = [
      { label: 'Delta-v margin', value: `${fmtDv(b.margin)} (${(b.marginFraction * 100).toFixed(0)}%)`, score: toleranceScore(b.marginFraction, 0.17, 0.09, 0.6), weight: 3, target: '8-26% of the post-landing requirement is ideal' },
      { label: 'Liftoff TWR', value: a.liftoffTwr.toFixed(2), score: toleranceScore(a.liftoffTwr, 1.35, 0.15, 0.6), weight: 2, target: '1.2-1.5 balances gravity loss and max-Q' },
      { label: 'Liftoff mass', value: fmtMass(a.totalMass), score: linearScore(a.totalMass, 3_000_000, 9_000_000), weight: 2, target: 'Lighter is cheaper (3,000 t is excellent)' },
      { label: 'Landing TWR', value: landing.twrMoon.toFixed(2), score: toleranceScore(landing.twrMoon, 2.2, 0.6, 1.5), weight: 1, target: '1.6-2.8 in lunar gravity gives good control' },
      { label: 'Crew safety', value: a.hasLes ? 'Escape tower fitted' : 'No escape tower', score: a.hasLes ? 1 : 0.3, weight: 1 },
    ];
    const result = buildResult('design', this.mission.carry.t, true, metrics, a.warnings, `Design approved: ${a.stages.length} stages, ${fmtMass(a.totalMass)} at liftoff, ${fmtDv(b.margin)} of mission margin.`);
    this.mission.complete(result);
    Object.assign(this.mission.carry, { design: structuredClone(this.design) });
    const actions = phaseEndActions(this.app, this.mission, result, () => {
      this.mission.retry();
      goToPhase(this.app, this.mission);
    });
    this.ui.append(createResultsPanel(result, 'Vehicle Design', actions));
  }

  // ---- Screen loop ----------------------------------------------------------
  exit(): void {
    this.cam.detach();
    this.model?.dispose();
    this.fx.dispose();
    this.highlight?.dispose();
    for (const o of this.content.children) {
      const m = o as THREE.Mesh;
      if (o !== this.model?.root && m.geometry) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    }
    this.app.renderer.shadowMap.enabled = false;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.rebuildPending) {
      this.rebuildPending = false;
      this.rebuildModel();
    }
    // Vehicle sits on the floor; the content group is offset by half its height.
    this.cam.setAspect(this.app.aspect);
    this.cam.update(dt);
    this.keyLight.target.position.set(0, 0, 0);
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.fx.setSize(this.app.width, this.app.height);
    this.fx.render(renderer);
  }

  onQualityChange(): void {
    this.app.renderer.shadowMap.enabled = this.app.quality.shadows;
    this.keyLight.castShadow = this.app.quality.shadows;
    this.rebuildPending = true;
  }

  debugState(): Record<string, unknown> {
    return {
      parts: this.design.parts.length,
      stages: this.analysis.stages.length,
      feasible: this.budget.feasible,
      margin: this.budget.margin,
      errors: this.analysis.errors.length,
      liftoffTwr: this.analysis.liftoffTwr,
      ended: this.ended,
    };
  }

  debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'template') {
      this.design = structuredClone(TEMPLATES[Number(arg)]);
      this.selected = -1;
      this.refresh();
    }
    return this.debugState();
  }
}
