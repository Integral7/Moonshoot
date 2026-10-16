// Patched-conic propagation: Keplerian motion about whichever body's sphere of
// influence (SOI) the spacecraft is in, with frame changes at SOI boundaries.
// Used both for coasting (exact at any time warp) and for trajectory prediction.

import {
  BODIES,
  DEFAULT_EPHEMERIS,
  MOON,
  moonPosition,
  moonVelocity,
  type BodyId,
  type Ephemeris,
} from './bodies';
import { propagateKepler, stateToElements, timeToPeriapsis, type Elements } from './kepler';
import { add, cross, dot, len, sub, type Vec3 } from './vec';

export interface OrbitState {
  body: BodyId;
  /** Mission time, s. */
  t: number;
  /** Position relative to `body`, inertial axes, m. */
  r: Vec3;
  /** Velocity relative to `body`, m/s. */
  v: Vec3;
}

export type TrajectoryEventKind =
  | 'soi-enter'
  | 'soi-exit'
  | 'periapsis'
  | 'atmosphere'
  | 'impact'
  | 'escape';

export interface TrajectoryEvent {
  kind: TrajectoryEventKind;
  body: BodyId;
  t: number;
  /** State at the event, relative to `body`. */
  state: OrbitState;
  /** Altitude above `body` at the event, m. */
  altitude: number;
}

export interface TrajectorySegment {
  body: BodyId;
  t0: number;
  t1: number;
  elements: Elements;
  /** Sampled positions relative to `body`. */
  points: Vec3[];
  times: number[];
  end: TrajectoryEventKind | 'duration';
}

export interface Prediction {
  segments: TrajectorySegment[];
  events: TrajectoryEvent[];
  final: OrbitState;
}

export interface PatchedOptions {
  eph?: Ephemeris;
  /** Stop when entering Earth's atmosphere (altitude < atmosphereTop). Default true. */
  stopAtAtmosphere?: boolean;
  /** Extra altitude above the Moon's mean radius treated as impact, m. */
  moonImpactAltitude?: number;
  /** Max angle swept per sample (rad); controls point density and event resolution. */
  maxAngleStep?: number;
  /** Max time step, s. */
  maxTimeStep?: number;
  /** Max number of SOI segments. */
  maxSegments?: number;
  /** Max points recorded per segment (sampling thins out beyond this). */
  maxPointsPerSegment?: number;
}

// ---------------------------------------------------------------------------
// Frames

/** Convert a state to be relative to another body. */
export function changeFrame(s: OrbitState, to: BodyId, eph: Ephemeris = DEFAULT_EPHEMERIS): OrbitState {
  if (s.body === to) return s;
  const mr = moonPosition(s.t, eph);
  const mv = moonVelocity(s.t, eph);
  if (s.body === 'earth' && to === 'moon') {
    return { body: 'moon', t: s.t, r: sub(s.r, mr), v: sub(s.v, mv) };
  }
  return { body: 'earth', t: s.t, r: add(s.r, mr), v: add(s.v, mv) };
}

/** Earth-centered inertial position of a state (for rendering and distance checks). */
export function toEci(s: OrbitState, eph: Ephemeris = DEFAULT_EPHEMERIS): Vec3 {
  return s.body === 'earth' ? s.r : add(s.r, moonPosition(s.t, eph));
}

/** Which SOI contains this state (the Moon's SOI nests inside Earth's). */
export function soiBodyFor(s: OrbitState, eph: Ephemeris = DEFAULT_EPHEMERIS): BodyId {
  const eci = toEci(s, eph);
  return len(sub(eci, moonPosition(s.t, eph))) < MOON.soi ? 'moon' : 'earth';
}

/** Re-express the state in the body whose SOI it is actually in. */
export function normalizeFrame(s: OrbitState, eph: Ephemeris = DEFAULT_EPHEMERIS): OrbitState {
  const b = soiBodyFor(s, eph);
  return b === s.body ? s : changeFrame(s, b, eph);
}

// ---------------------------------------------------------------------------
// Core stepping

interface Boundary {
  kind: TrajectoryEventKind;
  /** Signed function, crosses from negative to positive when the event fires. */
  g: (s: OrbitState) => number;
  /** Whether propagation stops at this boundary. */
  terminal: boolean;
}

function boundariesFor(body: BodyId, eph: Ephemeris, opts: PatchedOptions): Boundary[] {
  const b = BODIES[body];
  if (body === 'earth') {
    const list: Boundary[] = [
      { kind: 'soi-enter', g: (s) => MOON.soi - len(sub(s.r, moonPosition(s.t, eph))), terminal: true },
      { kind: 'impact', g: (s) => b.radius - len(s.r), terminal: true },
      { kind: 'escape', g: (s) => len(s.r) - b.soi, terminal: true },
    ];
    list.push({
      kind: 'atmosphere',
      g: (s) => b.radius + b.atmosphereTop - len(s.r),
      terminal: opts.stopAtAtmosphere ?? true,
    });
    return list;
  }
  return [
    { kind: 'soi-exit', g: (s) => len(s.r) - b.soi, terminal: true },
    { kind: 'impact', g: (s) => b.radius + (opts.moonImpactAltitude ?? 0) - len(s.r), terminal: true },
  ];
}

function propagate(s0: OrbitState, t: number): OrbitState {
  const mu = BODIES[s0.body].mu;
  const { r, v } = propagateKepler(s0.r, s0.v, t - s0.t, mu);
  return { body: s0.body, t, r, v };
}

/** Step size that limits the angle swept to about maxAngle. */
function adaptiveStep(s: OrbitState, maxAngle: number, maxDt: number): number {
  const r2 = s.r.x * s.r.x + s.r.y * s.r.y + s.r.z * s.r.z;
  const h = len(cross(s.r, s.v));
  const angRate = h / r2;
  let dt = angRate > 0 ? maxAngle / angRate : maxDt;
  // Also limit by fraction of the radial distance traversed (for near-radial paths).
  const speed = len(s.v);
  if (speed > 0) dt = Math.min(dt, (0.05 * Math.sqrt(r2)) / speed);
  return Math.min(Math.max(dt, 0.5), maxDt);
}

/** Bisect for the time in [ta, tb] where boundary g crosses zero. */
function refineCrossing(seg0: OrbitState, ta: number, tb: number, g: (s: OrbitState) => number): OrbitState {
  let lo = ta;
  let hi = tb;
  for (let k = 0; k < 60 && hi - lo > 1e-3; k++) {
    const mid = 0.5 * (lo + hi);
    if (g(propagate(seg0, mid)) >= 0) hi = mid;
    else lo = mid;
  }
  return propagate(seg0, hi);
}

interface SegmentResult {
  state: OrbitState;
  event: TrajectoryEvent | null;
  segment: TrajectorySegment;
}

function runSegment(
  start: OrbitState,
  tEnd: number,
  eph: Ephemeris,
  opts: PatchedOptions,
  record: boolean,
  events: TrajectoryEvent[],
): SegmentResult {
  const body = BODIES[start.body];
  const bounds = boundariesFor(start.body, eph, opts);
  const maxAngle = opts.maxAngleStep ?? (record ? 0.02 : 0.05);
  const maxDt = opts.maxTimeStep ?? (start.body === 'earth' ? 1800 : 300);
  const elements = stateToElements(start.r, start.v, body.mu);
  const segment: TrajectorySegment = {
    body: start.body,
    t0: start.t,
    t1: start.t,
    elements,
    points: record ? [start.r] : [],
    times: record ? [start.t] : [],
    end: 'duration',
  };

  // Periapsis event inside the segment window.
  const tPe = timeToPeriapsis(elements, body.mu);
  const peTime = start.t + tPe;

  let prev = start;
  let prevG = bounds.map((b) => b.g(start));
  let result: SegmentResult | null = null;
  let guard = 0;
  while (prev.t < tEnd && guard++ < 200_000) {
    const dt = Math.min(adaptiveStep(prev, maxAngle, maxDt), tEnd - prev.t);
    const next = propagate(start, prev.t + dt);
    const gs = bounds.map((b) => b.g(next));
    let fired: { idx: number; state: OrbitState } | null = null;
    for (let k = 0; k < bounds.length; k++) {
      if (prevG[k] < 0 && gs[k] >= 0) {
        const st = refineCrossing(start, prev.t, next.t, bounds[k].g);
        if (!fired || st.t < fired.state.t) fired = { idx: k, state: st };
      }
    }
    if (fired) {
      const b = bounds[fired.idx];
      const st = fired.state;
      const ev: TrajectoryEvent = {
        kind: b.kind,
        body: start.body,
        t: st.t,
        state: st,
        altitude: len(st.r) - body.radius,
      };
      if (record) {
        segment.points.push(st.r);
        segment.times.push(st.t);
      }
      if (b.terminal) {
        segment.t1 = st.t;
        segment.end = b.kind;
        result = { state: st, event: ev, segment };
        break;
      }
      events.push(ev);
      // Non-terminal: keep going from the event, but don't re-fire it.
      prevG = gs;
      prev = next;
      continue;
    }
    if (record) {
      segment.points.push(next.r);
      segment.times.push(next.t);
    }
    prevG = gs;
    prev = next;
  }
  if (!result) {
    segment.t1 = prev.t;
    result = { state: prev, event: null, segment };
  }
  if (tPe > 0 && peTime <= segment.t1 && elements.e > 1e-4) {
    const st = propagate(start, peTime);
    events.push({ kind: 'periapsis', body: start.body, t: peTime, state: st, altitude: len(st.r) - body.radius });
  }
  if (record && opts.maxPointsPerSegment && segment.points.length > opts.maxPointsPerSegment) {
    const stride = Math.ceil(segment.points.length / opts.maxPointsPerSegment);
    const pts: Vec3[] = [];
    const ts: number[] = [];
    for (let k = 0; k < segment.points.length; k += stride) {
      pts.push(segment.points[k]);
      ts.push(segment.times[k]);
    }
    pts.push(segment.points[segment.points.length - 1]);
    ts.push(segment.times[segment.times.length - 1]);
    segment.points = pts;
    segment.times = ts;
  }
  return result;
}

function crossOver(ev: TrajectoryEvent, eph: Ephemeris): OrbitState | null {
  if (ev.kind === 'soi-enter') return changeFrame(ev.state, 'moon', eph);
  if (ev.kind === 'soi-exit') return changeFrame(ev.state, 'earth', eph);
  return null;
}

/**
 * Predict the patched-conic trajectory for `duration` seconds from `s`.
 * Returns sampled segments (one per SOI) and the events encountered.
 */
export function predictTrajectory(s: OrbitState, duration: number, opts: PatchedOptions = {}): Prediction {
  const eph = opts.eph ?? DEFAULT_EPHEMERIS;
  const maxSegments = opts.maxSegments ?? 4;
  const tEnd = s.t + duration;
  const segments: TrajectorySegment[] = [];
  const events: TrajectoryEvent[] = [];
  let cur = normalizeFrame(s, eph);
  for (let n = 0; n < maxSegments; n++) {
    const res = runSegment(cur, tEnd, eph, opts, true, events);
    segments.push(res.segment);
    cur = res.state;
    if (!res.event) break;
    events.push(res.event);
    const next = crossOver(res.event, eph);
    if (!next) break;
    cur = next;
  }
  events.sort((a, b) => a.t - b.t);
  return { segments, events, final: cur };
}

export interface CoastResult {
  state: OrbitState;
  /** Terminal events reached during the coast (SOI changes, atmosphere, impact). */
  events: TrajectoryEvent[];
  /** True if coasting stopped early (atmosphere entry, impact, escape). */
  halted: boolean;
}

/**
 * Advance a coasting spacecraft by dt seconds, handling SOI transitions.
 * Stops early at atmosphere interface or impact so the caller can switch to
 * numerical integration.
 */
export function coast(s: OrbitState, dt: number, opts: PatchedOptions = {}): CoastResult {
  const eph = opts.eph ?? DEFAULT_EPHEMERIS;
  const tEnd = s.t + dt;
  const events: TrajectoryEvent[] = [];
  let cur = s;
  for (let n = 0; n < 6; n++) {
    const res = runSegment(cur, tEnd, eph, { ...opts, stopAtAtmosphere: opts.stopAtAtmosphere ?? true }, false, []);
    cur = res.state;
    if (!res.event) return { state: cur, events, halted: false };
    events.push(res.event);
    const next = crossOver(res.event, eph);
    if (!next) return { state: cur, events, halted: true };
    cur = next;
  }
  return { state: cur, events, halted: false };
}

/** Closest approach of a prediction to a body (altitude, m) and when. */
export function closestApproach(p: Prediction, body: BodyId): { altitude: number; t: number } | null {
  let best: { altitude: number; t: number } | null = null;
  for (const ev of p.events) {
    if (ev.body === body && (ev.kind === 'periapsis' || ev.kind === 'impact')) {
      if (!best || ev.altitude < best.altitude) best = { altitude: ev.altitude, t: ev.t };
    }
  }
  if (best) return best;
  const R = BODIES[body].radius;
  for (const seg of p.segments) {
    if (seg.body !== body) continue;
    for (let k = 0; k < seg.points.length; k++) {
      const alt = len(seg.points[k]) - R;
      if (!best || alt < best.altitude) best = { altitude: alt, t: seg.times[k] };
    }
  }
  return best;
}

/** Radial velocity (m/s), positive moving away from the body. */
export const radialVelocity = (s: OrbitState): number => dot(s.r, s.v) / len(s.r);
