import type { Callout } from '../sim/callouts';
import { formatMET } from '../sim/time';
import { clear, h } from './dom';

export interface TelemetryRow {
  id: string;
  label: string;
  value: string;
  cls?: string;
}

export interface HudOptions {
  phaseLabel: string;
  onMenu: () => void;
  onPause: () => void;
  onWarp: (delta: number) => void;
  showToasts: () => boolean;
  toast: (text: string, kind: 'info' | 'warn' | 'good' | 'bad') => void;
}

/** Mission control heads-up display: clock, warp, telemetry, callout log, controls. */
export class Hud {
  readonly root: HTMLElement;
  readonly controls: HTMLElement;
  readonly left: HTMLElement;
  readonly center: HTMLElement;
  private clock: HTMLElement;
  private warpLabel: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private telemetry: HTMLElement;
  private rows = new Map<string, { row: HTMLElement; value: HTMLElement }>();
  private log: HTMLElement;
  private status: HTMLElement;
  private hint: HTMLElement;

  constructor(parent: HTMLElement, private opts: HudOptions) {
    this.clock = h('div', { class: 'met mono', id: 'met', text: formatMET(0) });
    this.warpLabel = h('span', { class: 'mono warp-label', id: 'warp-label', text: '1x' });
    this.pauseBtn = h('button', { class: 'btn btn-small', id: 'btn-pause', text: 'Pause', onclick: () => opts.onPause() });
    const top = h(
      'div',
      { class: 'hud-top hud-block' },
      h('div', { class: 'hud-phase' }, h('span', { class: 'brand', text: 'MOONSHOT' }), h('span', { class: 'muted', text: ' / ' }), h('span', { id: 'phase-label', text: opts.phaseLabel })),
      this.clock,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-small', id: 'btn-warp-down', text: '<<', title: 'Slower (,)', onclick: () => opts.onWarp(-1) }),
        this.warpLabel,
        h('button', { class: 'btn btn-small', id: 'btn-warp-up', text: '>>', title: 'Faster (.)', onclick: () => opts.onWarp(1) }),
        this.pauseBtn,
        h('button', { class: 'btn btn-small', id: 'btn-menu', text: 'Menu', onclick: () => opts.onMenu() }),
      ),
    );
    this.telemetry = h('div', { class: 'telemetry mono' });
    this.status = h('div', { class: 'hud-status mono', id: 'hud-status' });
    this.left = h('div', { class: 'hud-left hud-block panel' }, h('h3', { text: 'Telemetry' }), this.telemetry);
    this.log = h('div', { class: 'callout-log mono', id: 'callout-log' });
    const right = h('div', { class: 'hud-right hud-block panel' }, h('h3', { text: 'Mission Control' }), this.log);
    this.controls = h('div', { class: 'hud-controls hud-block' });
    this.hint = h('div', { class: 'hud-hint muted small' });
    this.center = h('div', { class: 'hud-center passthrough' }, this.status);
    this.root = h('div', { class: 'hud' }, top, this.left, right, this.center, this.controls, this.hint);
    parent.append(this.root);
  }

  setPhaseLabel(text: string): void {
    const el = this.root.querySelector('#phase-label');
    if (el) el.textContent = text;
  }

  setClock(t: number): void {
    const s = formatMET(t);
    if (this.clock.textContent !== s) this.clock.textContent = s;
  }

  setWarp(warp: number, maxWarp: number, paused: boolean): void {
    const txt = paused ? 'PAUSED' : `${warp.toLocaleString('en-US')}x`;
    if (this.warpLabel.textContent !== txt) this.warpLabel.textContent = txt;
    this.warpLabel.classList.toggle('warn', warp > 1 || paused);
    this.warpLabel.title = `Max warp now: ${maxWarp.toLocaleString('en-US')}x`;
    this.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  }

  setTelemetry(rows: TelemetryRow[]): void {
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      let e = this.rows.get(r.id);
      if (!e) {
        const value = h('span', { class: 'tv' });
        const row = h('div', { class: 'trow', dataset: { id: r.id } }, h('span', { class: 'tl', text: r.label }), value);
        this.telemetry.append(row);
        e = { row, value };
        this.rows.set(r.id, e);
      }
      if (e.value.textContent !== r.value) e.value.textContent = r.value;
      const cls = `tv ${r.cls ?? ''}`;
      if (e.value.className !== cls) e.value.className = cls;
    }
    for (const [id, e] of this.rows) {
      if (!seen.has(id)) {
        e.row.remove();
        this.rows.delete(id);
      }
    }
  }

  addCallout(c: Callout): void {
    const line = h(
      'div',
      { class: `callout callout-${c.kind}` },
      h('span', { class: 'ct', text: formatMET(c.t) }),
      h('span', { class: 'cr', text: c.role }),
      h('span', { class: 'cx', text: c.text }),
    );
    this.log.append(line);
    while (this.log.children.length > 120) this.log.firstChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    if (this.opts.showToasts()) this.opts.toast(`${c.role}: ${c.text}`, c.kind);
  }

  setStatus(text: string, kind: 'info' | 'warn' | 'good' | 'bad' = 'info'): void {
    if (this.status.textContent !== text) this.status.textContent = text;
    const cls = `hud-status mono status-${kind}`;
    if (this.status.className !== cls) this.status.className = cls;
  }

  setHint(text: string): void {
    if (this.hint.textContent !== text) this.hint.textContent = text;
  }

  setControls(...nodes: HTMLElement[]): void {
    clear(this.controls);
    this.controls.append(...nodes);
  }
}
