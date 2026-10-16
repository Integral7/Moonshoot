// Telemetry recorder: fixed-interval samples of named numeric channels, used for
// the post-phase graphs and replays. Interval adapts to time warp so long
// coasts don't blow up memory.

export interface ChannelDef {
  id: string;
  label: string;
  unit: string;
  /** Display scale, e.g. 1/1000 to show meters as km. */
  scale?: number;
}

export interface TelemetryData {
  channels: ChannelDef[];
  t: number[];
  values: Record<string, number[]>;
  /** Discrete events for graph annotations. */
  marks: { t: number; label: string }[];
}

export class TelemetryRecorder {
  readonly data: TelemetryData;
  private lastT = -Infinity;

  constructor(
    channels: ChannelDef[],
    /** Base sample interval in mission seconds at 1x. */
    public interval = 0.5,
    public maxSamples = 20_000,
  ) {
    this.data = { channels, t: [], values: Object.fromEntries(channels.map((c) => [c.id, []])), marks: [] };
  }

  /** Record a sample if enough mission time has passed (scaled by warp). Returns true if recorded. */
  sample(t: number, values: Record<string, number>, warp = 1, force = false): boolean {
    const dt = this.interval * Math.max(1, warp);
    if (!force && t - this.lastT < dt) return false;
    this.lastT = t;
    this.data.t.push(t);
    for (const c of this.data.channels) this.data.values[c.id].push(values[c.id] ?? NaN);
    if (this.data.t.length > this.maxSamples) this.decimate();
    return true;
  }

  mark(t: number, label: string): void {
    this.data.marks.push({ t, label });
  }

  get length(): number {
    return this.data.t.length;
  }

  /** Halve resolution by dropping every other sample (keeps the newest). */
  private decimate(): void {
    const keep = (arr: number[]) => arr.filter((_, i) => i % 2 === 1 || i === arr.length - 1);
    this.data.t = keep(this.data.t);
    for (const c of this.data.channels) this.data.values[c.id] = keep(this.data.values[c.id]);
    this.interval *= 2;
  }
}

/** Value of a channel at time t by linear interpolation (for replay scrubbing). */
export function sampleAt(data: TelemetryData, channel: string, t: number): number {
  const ts = data.t;
  const vs = data.values[channel];
  if (!ts.length || !vs) return NaN;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
  return vs[lo] + (vs[hi] - vs[lo]) * f;
}
