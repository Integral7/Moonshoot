import { sampleAt, type TelemetryData } from '../sim/telemetry';
import { formatMET } from '../sim/time';
import { clear, h } from './dom';

// One channel at a time (no dual axes); channel chips pick it. Colors follow the
// reference data-viz palette (dark surface): series slot 1, recessive grid,
// text in text tokens, accent for the replay cursor.
const SERIES = '#3987e5';
const GRID = 'rgba(195, 194, 183, 0.12)';
const AXIS_TEXT = '#c3c2b7';
const MARK = 'rgba(195, 194, 183, 0.45)';
const CURSOR = '#ffb547';

export interface GraphOptions {
  height?: number;
  /** Called when the user clicks/drags on the plot (replay scrubbing). */
  onScrub?: (t: number) => void;
}

/** Canvas line chart of a telemetry recording with hover tooltip and optional cursor. */
export class TelemetryGraph {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tooltip: HTMLElement;
  private chips: HTMLElement;
  private table: HTMLElement;
  private channel: string;
  private cursor = NaN;
  private hoverX = NaN;
  private showTable = false;
  private height: number;
  private dragging = false;

  constructor(private data: TelemetryData, private opts: GraphOptions = {}) {
    this.height = opts.height ?? 170;
    const usable = data.channels.filter((c) => (data.values[c.id] ?? []).some((v) => Number.isFinite(v) && v !== 0));
    this.channel = (usable[0] ?? data.channels[0])?.id ?? '';
    this.chips = h('div', { class: 'graph-chips' });
    this.canvas = h('canvas', { class: 'graph-canvas' }) as HTMLCanvasElement;
    this.canvas.style.height = `${this.height}px`;
    this.tooltip = h('div', { class: 'graph-tooltip mono' });
    this.table = h('div', { class: 'graph-table mono' });
    const tableBtn = h('button', { class: 'icon-btn wide', text: 'Table', title: 'Show the data as a table', onclick: () => this.toggleTable() });
    this.root = h(
      'div',
      { class: 'telemetry-graph', id: 'telemetry-graph' },
      h('div', { class: 'row between' }, this.chips, tableBtn),
      h('div', { class: 'graph-plot' }, this.canvas, this.tooltip),
      this.table,
    );
    for (const c of usable.length ? usable : data.channels) {
      this.chips.append(
        h('button', {
          class: `chip ${c.id === this.channel ? 'active' : ''}`,
          dataset: { ch: c.id },
          text: c.label,
          onclick: () => this.setChannel(c.id),
        }),
      );
    }
    this.canvas.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      if (this.dragging) this.scrub(e.offsetX);
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = NaN;
      this.dragging = false;
      this.draw();
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.opts.onScrub) return;
      this.dragging = true;
      this.scrub(e.offsetX);
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    requestAnimationFrame(() => this.draw());
  }

  setChannel(id: string): void {
    this.channel = id;
    for (const b of this.chips.querySelectorAll<HTMLButtonElement>('.chip')) b.classList.toggle('active', b.dataset.ch === id);
    if (this.showTable) this.renderTable();
    this.draw();
  }

  setCursor(t: number): void {
    this.cursor = t;
    this.draw();
  }

  private toggleTable(): void {
    this.showTable = !this.showTable;
    if (this.showTable) this.renderTable();
    else clear(this.table);
  }

  private renderTable(): void {
    clear(this.table);
    const d = this.data;
    const def = d.channels.find((c) => c.id === this.channel)!;
    const vals = d.values[this.channel] ?? [];
    const n = d.t.length;
    const rows = Math.min(24, n);
    const tbl = h('table', { class: 'budget' }, h('tr', {}, h('th', { text: 'MET' }), h('th', { text: `${def.label} (${def.unit})` })));
    for (let k = 0; k < rows; k++) {
      const i = Math.round((k / Math.max(1, rows - 1)) * (n - 1));
      tbl.append(h('tr', {}, h('td', { text: formatMET(d.t[i]) }), h('td', { text: fmt(vals[i] * (def.scale ?? 1)) })));
    }
    this.table.append(tbl);
  }

  private geometry() {
    const d = this.data;
    const t0 = d.t[0] ?? 0;
    const t1 = d.t[d.t.length - 1] ?? 1;
    const def = d.channels.find((c) => c.id === this.channel);
    const s = def?.scale ?? 1;
    const vals = (d.values[this.channel] ?? []).map((v) => v * s);
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0 && lo < hi * 0.3) lo = 0;
    if (hi === lo) { hi = lo + 1; }
    const pad = (hi - lo) * 0.06;
    return { t0, t1: Math.max(t1, t0 + 1e-6), lo: lo - (lo === 0 ? 0 : pad), hi: hi + pad, vals, def };
  }

  private scrub(px: number): void {
    const w = this.canvas.clientWidth;
    const L = 52, R = 10;
    const g = this.geometry();
    const t = g.t0 + ((px - L) / Math.max(1, w - L - R)) * (g.t1 - g.t0);
    this.opts.onScrub?.(Math.max(g.t0, Math.min(g.t1, t)));
  }

  draw(): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (w < 10 || hh < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(hh * dpr)) c.height = Math.round(hh * dpr);
    const g2 = c.getContext('2d')!;
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, w, hh);
    const d = this.data;
    if (!d.t.length) return;
    const L = 52, R = 10, T = 14, B = 20;
    const g = this.geometry();
    const X = (t: number) => L + ((t - g.t0) / (g.t1 - g.t0)) * (w - L - R);
    const Y = (v: number) => T + (1 - (v - g.lo) / (g.hi - g.lo)) * (hh - T - B);
    // Grid + y labels.
    g2.font = '11px ui-monospace, Consolas, monospace';
    g2.fillStyle = AXIS_TEXT;
    g2.strokeStyle = GRID;
    g2.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = g.lo + ((g.hi - g.lo) * k) / 4;
      const y = Math.round(Y(v)) + 0.5;
      g2.beginPath();
      g2.moveTo(L, y);
      g2.lineTo(w - R, y);
      g2.stroke();
      g2.textAlign = 'right';
      g2.textBaseline = 'middle';
      g2.fillText(fmt(v), L - 6, y);
    }
    // X labels.
    g2.textAlign = 'center';
    g2.textBaseline = 'top';
    for (let k = 0; k <= 4; k++) {
      const t = g.t0 + ((g.t1 - g.t0) * k) / 4;
      g2.fillText(formatMET(t).replace('T+', ''), Math.min(w - R - 30, Math.max(L + 30, X(t))), hh - B + 5);
    }
    // Event marks.
    g2.setLineDash([3, 4]);
    g2.strokeStyle = MARK;
    g2.textAlign = 'left';
    g2.textBaseline = 'top';
    let lastLabelX = -Infinity;
    for (const m of d.marks) {
      if (m.t < g.t0 || m.t > g.t1) continue;
      const x = Math.round(X(m.t)) + 0.5;
      g2.beginPath();
      g2.moveTo(x, T);
      g2.lineTo(x, hh - B);
      g2.stroke();
      if (x - lastLabelX > 60) {
        g2.fillText(m.label, x + 3, 1);
        lastLabelX = x;
      }
    }
    g2.setLineDash([]);
    // Series line, 2px.
    g2.strokeStyle = SERIES;
    g2.lineWidth = 2;
    g2.lineJoin = 'round';
    g2.beginPath();
    let pen = false;
    for (let i = 0; i < d.t.length; i++) {
      const v = g.vals[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = X(d.t[i]);
      const y = Y(v);
      if (pen) g2.lineTo(x, y);
      else g2.moveTo(x, y);
      pen = true;
    }
    g2.stroke();
    // Replay cursor.
    if (Number.isFinite(this.cursor)) {
      const x = Math.round(X(this.cursor)) + 0.5;
      g2.strokeStyle = CURSOR;
      g2.lineWidth = 1.5;
      g2.beginPath();
      g2.moveTo(x, T);
      g2.lineTo(x, hh - B);
      g2.stroke();
    }
    // Hover crosshair + tooltip.
    if (Number.isFinite(this.hoverX) && this.hoverX >= L && this.hoverX <= w - R) {
      const t = g.t0 + ((this.hoverX - L) / (w - L - R)) * (g.t1 - g.t0);
      const v = sampleAt(d, this.channel, t) * (g.def?.scale ?? 1);
      const x = this.hoverX;
      g2.strokeStyle = 'rgba(240, 239, 236, 0.5)';
      g2.lineWidth = 1;
      g2.beginPath();
      g2.moveTo(x + 0.5, T);
      g2.lineTo(x + 0.5, hh - B);
      g2.stroke();
      if (Number.isFinite(v)) {
        g2.fillStyle = SERIES;
        g2.strokeStyle = '#0b111b';
        g2.lineWidth = 2;
        g2.beginPath();
        g2.arc(x, Y(v), 4.5, 0, Math.PI * 2);
        g2.fill();
        g2.stroke();
      }
      this.tooltip.style.display = 'block';
      this.tooltip.style.left = `${Math.min(w - 150, x + 10)}px`;
      this.tooltip.textContent = `${formatMET(t)} · ${fmt(v)} ${g.def?.unit ?? ''}`;
    } else this.tooltip.style.display = 'none';
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 10_000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
