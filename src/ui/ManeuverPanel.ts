import type { ManeuverNode } from '../sim/orbital';
import { formatDuration, formatMET } from '../sim/time';
import type { NodeDeltaV } from '../physics/maneuver';
import { clear, h } from './dom';

export interface Planner {
  id: string;
  label: string;
  title?: string;
  /** Returns a node, or a string explaining why it could not plan. */
  run: () => ManeuverNode | string | null;
}

export interface ManeuverPanelHost {
  now(): number;
  node(): ManeuverNode | null;
  setNode(n: ManeuverNode | null): void;
  burnTime(): number;
  /** One or two lines describing the predicted result of the node. */
  resultText(): { text: string; cls?: string }[];
  planners(): Planner[];
  executing(): boolean;
  execute(): void;
  warpToNode(): void;
  /** Default time for a brand-new node. */
  defaultNodeTime(): number;
  busy(msg: string, work: () => void): void;
}

const COMPONENTS: { key: keyof NodeDeltaV; label: string }[] = [
  { key: 'prograde', label: 'Prograde' },
  { key: 'normal', label: 'Normal' },
  { key: 'radial', label: 'Radial' },
];

/** Maneuver node editor: timing, local-frame delta-v, auto-planners, execution. */
export class ManeuverPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private lastKey = '';

  constructor(parent: HTMLElement, private host: ManeuverPanelHost) {
    this.body = h('div', { class: 'mnv-body' });
    this.root = h('div', { class: 'panel hud-block maneuver-panel', id: 'maneuver-panel' }, h('h3', { text: 'Maneuver node' }), this.body);
    parent.append(this.root);
    this.render(true);
  }

  /** Re-render if anything visible changed (cheap to call every HUD tick). */
  render(force = false): void {
    const n = this.host.node();
    const res = this.host.resultText();
    const key = JSON.stringify([n, Math.floor(this.host.now()), res, this.host.executing()]);
    if (!force && key === this.lastKey) return;
    // Don't rebuild while the user is typing into a field.
    if (!force && this.root.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    this.lastKey = key;
    clear(this.body);
    const planners = this.host.planners();
    this.body.append(
      h(
        'div',
        { class: 'mnv-planners' },
        ...planners.map((p) =>
          h('button', {
            class: 'btn btn-small',
            id: `plan-${p.id}`,
            text: p.label,
            title: p.title ?? '',
            onclick: () =>
              this.host.busy(`Computing ${p.label.toLowerCase()}...`, () => {
                const r = p.run();
                if (typeof r === 'string') throw new Error(r);
                if (r) this.host.setNode(r);
              }),
          }),
        ),
        n ? null : h('button', { class: 'btn btn-small', id: 'btn-new-node', text: '+ New node', onclick: () => this.host.setNode({ t: this.host.defaultNodeTime(), dv: { prograde: 0, normal: 0, radial: 0 } }) }),
      ),
    );
    if (!n) {
      this.body.append(h('p', { class: 'muted small', text: 'No node. Add one, or let an auto-planner compute it.' }));
      return;
    }
    const now = this.host.now();
    const shift = (dt: number) => this.host.setNode({ t: Math.max(now + 5, n.t + dt), dv: n.dv });
    this.body.append(
      h(
        'div',
        { class: 'mnv-row' },
        h('span', { class: 'muted', text: 'Time' }),
        h('span', { class: 'mono', id: 'node-time', text: `${formatMET(n.t)} (in ${formatDuration(n.t - now)})` }),
      ),
      h(
        'div',
        { class: 'mnv-row mnv-shift' },
        ...[-600, -60, -10, -1, 1, 10, 60, 600].map((d) =>
          h('button', { class: 'icon-btn wide', text: `${d > 0 ? '+' : '−'}${Math.abs(d) >= 60 ? `${Math.abs(d) / 60}m` : `${Math.abs(d)}s`}`, onclick: () => shift(d) }),
        ),
      ),
    );
    for (const c of COMPONENTS) {
      const input = h('input', { class: 'mnv-input mono', type: 'number', value: n.dv[c.key].toFixed(1), attrs: { step: '0.1', 'data-comp': c.key } }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) this.host.setNode({ t: n.t, dv: { ...n.dv, [c.key]: v } });
      });
      const adj = (d: number) => this.host.setNode({ t: n.t, dv: { ...n.dv, [c.key]: n.dv[c.key] + d } });
      this.body.append(
        h(
          'div',
          { class: 'mnv-row mnv-comp' },
          h('span', { class: `mnv-label comp-${c.key}`, text: c.label }),
          ...[-100, -10, -1, -0.1].map((d) => h('button', { class: 'icon-btn', text: d === -0.1 ? '−.1' : String(d), onclick: () => adj(d) })),
          input,
          ...[0.1, 1, 10, 100].map((d) => h('button', { class: 'icon-btn', text: d === 0.1 ? '+.1' : `+${d}`, onclick: () => adj(d) })),
        ),
      );
    }
    const mag = Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial);
    const tb = this.host.burnTime();
    this.body.append(
      h('div', { class: 'mnv-row' }, h('span', { class: 'muted', text: 'Total' }), h('span', { class: 'mono', id: 'node-dv', text: `${mag.toFixed(1)} m/s · burn ${Number.isFinite(tb) ? formatDuration(tb) : 'NOT ENOUGH Δv'}` })),
      ...res.map((r) => h('div', { class: `mnv-result mono ${r.cls ?? ''}`, text: r.text })),
      h(
        'div',
        { class: 'row mnv-actions' },
        h('button', { class: 'btn btn-small', id: 'btn-warp-node', text: 'Warp to node', onclick: () => this.host.warpToNode() }),
        h('button', { class: 'btn btn-small btn-primary', id: 'btn-execute', text: this.host.executing() ? 'Executing...' : 'Execute burn', disabled: this.host.executing() || !Number.isFinite(tb), onclick: () => this.host.execute() }),
        h('button', { class: 'btn btn-small btn-danger', id: 'btn-delete-node', text: 'Delete', onclick: () => this.host.setNode(null) }),
      ),
    );
  }
}
