// Replays: a compact recording of a flight phase (vehicle track + telemetry)
// that can be played back with a scrubber. Stored in localStorage (guarded).

import type { BodyId, Ephemeris } from '../physics/bodies';
import type { Vec3 } from '../physics/vec';
import type { TelemetryData } from './telemetry';
import type { VehicleDesign } from './vehicle';

export interface TrackSample {
  body: BodyId;
  /** Position relative to `body`, inertial axes, m. */
  r: Vec3;
  /** Vehicle axis (thrust direction), inertial unit vector. */
  dir: Vec3;
  throttle: number;
  stage: number;
}

export interface Track {
  t: number[];
  /** 0 = Earth, 1 = Moon. */
  body: number[];
  x: number[];
  y: number[];
  z: number[];
  dx: number[];
  dy: number[];
  dz: number[];
  thr: number[];
  stage: number[];
}

export interface Replay {
  id: string;
  phase: string;
  title: string;
  /** ISO date of recording. */
  date: string;
  score: number;
  success: boolean;
  design: VehicleDesign;
  eph: Ephemeris;
  track: Track;
  telemetry: TelemetryData;
}

const emptyTrack = (): Track => ({ t: [], body: [], x: [], y: [], z: [], dx: [], dy: [], dz: [], thr: [], stage: [] });

/** Fixed-interval track recorder (interval scales with time warp, decimates when full). */
export class TrackRecorder {
  readonly track: Track = emptyTrack();
  private lastT = -Infinity;

  constructor(
    public interval = 0.5,
    public maxSamples = 6_000,
  ) {}

  sample(t: number, s: TrackSample, warp = 1, force = false): void {
    if (!force && t - this.lastT < this.interval * Math.max(1, warp)) return;
    this.lastT = t;
    const k = this.track;
    k.t.push(t);
    k.body.push(s.body === 'moon' ? 1 : 0);
    k.x.push(s.r.x);
    k.y.push(s.r.y);
    k.z.push(s.r.z);
    k.dx.push(s.dir.x);
    k.dy.push(s.dir.y);
    k.dz.push(s.dir.z);
    k.thr.push(s.throttle);
    k.stage.push(s.stage);
    if (k.t.length > this.maxSamples) {
      decimateTrack(k, 2);
      this.interval *= 2;
    }
  }

  get length(): number {
    return this.track.t.length;
  }
}

/** Keep every `n`th sample (always the last). Mutates. */
export function decimateTrack(k: Track, n: number): void {
  const keep = (a: number[]) => a.filter((_, i) => i % n === 0 || i === a.length - 1);
  for (const key of Object.keys(k) as (keyof Track)[]) k[key] = keep(k[key]);
}

/** Linear interpolation of the track at time t. Body switches are not interpolated across. */
export function trackAt(k: Track, t: number): TrackSample & { index: number } {
  const n = k.t.length;
  let i = 0;
  if (t >= k.t[n - 1]) i = n - 2;
  else if (t > k.t[0]) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (k.t[mid] <= t) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  i = Math.max(0, Math.min(n - 2, i));
  const j = Math.min(n - 1, i + 1);
  const span = k.t[j] - k.t[i] || 1;
  let f = Math.max(0, Math.min(1, (t - k.t[i]) / span));
  if (k.body[i] !== k.body[j]) f = f < 0.5 ? 0 : 1;
  const L = (a: number[]) => a[i] + (a[j] - a[i]) * f;
  const pick = f < 0.5 ? i : j;
  return {
    body: k.body[pick] === 1 ? 'moon' : 'earth',
    r: { x: L(k.x), y: L(k.y), z: L(k.z) },
    dir: { x: L(k.dx), y: L(k.dy), z: L(k.dz) },
    throttle: L(k.thr),
    stage: k.stage[pick],
    index: pick,
  };
}

// ---------------------------------------------------------------------------
// Compaction and storage

const roundArr = (a: number[], digits: number) => a.map((v) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : 0));
const sigArr = (a: number[]) => a.map((v) => (Number.isFinite(v) ? Number(v.toPrecision(5)) : 0));

/** Shrink a replay for storage: decimate to `maxSamples` and round values. */
export function compactReplay(r: Replay, maxSamples = 1_500): Replay {
  const track: Track = structuredClone(r.track);
  if (track.t.length > maxSamples) decimateTrack(track, Math.ceil(track.t.length / maxSamples));
  const tel: TelemetryData = structuredClone(r.telemetry);
  if (tel.t.length > maxSamples) {
    const n = Math.ceil(tel.t.length / maxSamples);
    const keep = (a: number[]) => a.filter((_, i) => i % n === 0 || i === a.length - 1);
    tel.t = keep(tel.t);
    for (const c of tel.channels) tel.values[c.id] = keep(tel.values[c.id]);
  }
  return {
    ...r,
    track: {
      t: roundArr(track.t, 2),
      body: track.body,
      x: roundArr(track.x, 0),
      y: roundArr(track.y, 0),
      z: roundArr(track.z, 0),
      dx: roundArr(track.dx, 3),
      dy: roundArr(track.dy, 3),
      dz: roundArr(track.dz, 3),
      thr: roundArr(track.thr, 2),
      stage: track.stage,
    },
    telemetry: { ...tel, t: roundArr(tel.t, 2), values: Object.fromEntries(Object.entries(tel.values).map(([k, v]) => [k, sigArr(v)])) },
  };
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'moonshot.replays.v1';
const MAX_STORED = 8;
/** Replays recorded this session (also the fallback when storage is unavailable). */
const session: Replay[] = [];

function store(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function listReplays(s: KeyValueStore | null = store()): Replay[] {
  let saved: Replay[] = [];
  try {
    const raw = s?.getItem(KEY);
    if (raw) saved = JSON.parse(raw) as Replay[];
  } catch {
    saved = [];
  }
  const ids = new Set(saved.map((r) => r.id));
  return [...session.filter((r) => !ids.has(r.id)), ...saved].sort((a, b) => b.date.localeCompare(a.date));
}

export function saveReplay(r: Replay, s: KeyValueStore | null = store()): Replay {
  const c = compactReplay(r);
  session.unshift(c);
  if (session.length > MAX_STORED) session.length = MAX_STORED;
  if (!s) return c;
  let list = listReplays(s).filter((x) => x.id !== c.id);
  list = [c, ...list].slice(0, MAX_STORED);
  // Drop the oldest until it fits.
  while (list.length) {
    try {
      s.setItem(KEY, JSON.stringify(list));
      break;
    } catch {
      list.pop();
    }
  }
  return c;
}

export function deleteReplay(id: string, s: KeyValueStore | null = store()): void {
  const i = session.findIndex((r) => r.id === id);
  if (i >= 0) session.splice(i, 1);
  if (!s) return;
  try {
    const list = listReplays(s).filter((x) => x.id !== id);
    s.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function getReplay(id: string, s: KeyValueStore | null = store()): Replay | null {
  return listReplays(s).find((r) => r.id === id) ?? null;
}
