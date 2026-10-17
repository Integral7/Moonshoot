// Orbital flight: a vehicle on a patched-conic trajectory that can coast
// (exact Kepler, any time warp) or burn (fixed-step RK4 with finite thrust).
// Shared by the Earth-orbit, cruise, lunar-orbit and return phases.

import { BODIES, type Ephemeris } from '../physics/bodies';
import { G0 } from '../physics/constants';
import { flightDerivative, STATE_SIZE, type FlightControls } from '../physics/dynamics';
import { RK4 } from '../physics/integrator';
import { stateToElements, timeToApoapsis, timeToPeriapsis, type Elements } from '../physics/kepler';
import { circularizeDeltaV, inertialToNode, localFrame, nodeMagnitude, nodeToInertial, type NodeDeltaV } from '../physics/maneuver';
import { coast, normalizeFrame, predictTrajectory, type OrbitState, type Prediction, type TrajectoryEvent } from '../physics/patched';
import { add, len, neg, norm, vec, type Vec3 } from '../physics/vec';
import { Vehicle, type VehicleState } from './vehicle';

export const BURN_STEP = 0.05;

export type AttitudeMode = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radial' | 'antiradial' | 'node';

export interface ManeuverNode {
  /** Mission time of the (impulsive) maneuver, s. */
  t: number;
  dv: NodeDeltaV;
}

export interface FlightEvent {
  t: number;
  kind: 'burn-start' | 'burn-end' | 'flameout' | 'staging' | 'soi' | 'atmosphere' | 'impact' | 'escape';
  detail?: string;
}

export interface OrbitalCarry {
  orbit: OrbitState;
  eph: Ephemeris;
}

/** State propagated (coasting) to time t, across SOI boundaries. */
export function coastTo(s: OrbitState, t: number, eph: Ephemeris): OrbitState {
  if (t <= s.t) return s;
  return coast(s, t - s.t, { eph, stopAtAtmosphere: false }).state;
}

export class OrbitalFlight {
  readonly vehicle: Vehicle;
  s: OrbitState;
  node: ManeuverNode | null = null;
  attitude: AttitudeMode = 'prograde';
  /** Commanded throttle (manual). */
  throttle = 0;
  /** Actual throttle last step. */
  thrustLevel = 0;
  /** Automatic node execution. */
  autoBurn: { dv: NodeDeltaV; remaining: number; start: number; started: boolean; initial: number } | null = null;
  /** Integration step while thrusting, s (larger for fast planning simulations). */
  burnStep = BURN_STEP;
  /** Total delta-v expended in this flight, m/s. */
  dvUsed = 0;
  events: FlightEvent[] = [];
  /** Set when the trajectory reaches the atmosphere interface or a surface. */
  halted: TrajectoryEvent | null = null;
  autoStage = true;
  private rk = new RK4(STATE_SIZE);
  private y = new Float64Array(STATE_SIZE);
  private burning = false;

  constructor(
    orbit: OrbitState,
    vehicle: VehicleState,
    readonly eph: Ephemeris,
  ) {
    this.s = normalizeFrame(orbit, eph);
    this.vehicle = new Vehicle(vehicle);
  }

  get t(): number {
    return this.s.t;
  }

  get body() {
    return BODIES[this.s.body];
  }

  elements(): Elements {
    return stateToElements(this.s.r, this.s.v, this.body.mu);
  }

  get altitude(): number {
    return len(this.s.r) - this.body.radius;
  }

  /** Unit attitude vector (inertial) for the current mode. */
  attitudeVector(mode: AttitudeMode = this.attitude): Vec3 {
    const f = localFrame(this.s.r, this.s.v);
    switch (mode) {
      case 'prograde': return f.prograde;
      case 'retrograde': return neg(f.prograde);
      case 'normal': return f.normal;
      case 'antinormal': return neg(f.normal);
      case 'radial': return f.radial;
      case 'antiradial': return neg(f.radial);
      case 'node': {
        if (this.autoBurn) return norm(nodeToInertial(this.s.r, this.s.v, this.autoBurn.dv));
        const v = this.nodeVector();
        return v ? norm(v) : f.prograde;
      }
    }
  }

  /** Node delta-v as an inertial vector at the node time. */
  nodeVector(): Vec3 | null {
    if (!this.node) return null;
    const at = coastTo(this.s, this.node.t, this.eph);
    return nodeToInertial(at.r, at.v, this.node.dv);
  }

  /** Estimated full-thrust burn time for the node, s. */
  nodeBurnTime(): number {
    if (!this.node) return 0;
    return this.vehicle.burnTimeFor(nodeMagnitude(this.node.dv));
  }

  setNode(node: ManeuverNode | null): void {
    this.node = node;
    this.autoBurn = null;
  }

  /** Arm automatic execution of the current node (burn centered on the node time). */
  executeNode(): boolean {
    if (!this.node) return false;
    const mag = nodeMagnitude(this.node.dv);
    if (mag <= 0) return false;
    const tb = this.nodeBurnTime();
    if (!Number.isFinite(tb)) return false;
    // Steered in the local orbital frame (rotating with the orbit), centered on the node.
    this.autoBurn = { dv: { ...this.node.dv }, remaining: mag, start: this.node.t - tb / 2, started: false, initial: mag };
    this.attitude = 'node';
    return true;
  }

  /** Time until the next thing that warrants dropping out of time warp, s. */
  timeToNextEvent(): number {
    if (this.autoBurn && !this.autoBurn.started) return this.autoBurn.start - this.t;
    if (this.node && !this.autoBurn) return this.node.t - this.t;
    return Infinity;
  }

  get isBurning(): boolean {
    return this.burning;
  }

  /** Advance by dt seconds. Coasts exactly unless thrusting, then integrates finite burns. */
  advance(dt: number): void {
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 100_000) {
      if (this.halted) return;
      const ab = this.autoBurn;
      if (ab && !ab.started) {
        const until = ab.start - this.t;
        if (until > 0) {
          const step = Math.min(until, remaining);
          this.coastFor(step);
          remaining -= step;
          continue;
        }
        ab.started = true;
        this.events.push({ t: this.t, kind: 'burn-start', detail: `${ab.initial.toFixed(1)} m/s` });
      }
      const wantThrust = ab ? ab.started : this.throttle > 0;
      if (!wantThrust) {
        this.coastFor(remaining);
        remaining = 0;
        break;
      }
      const h = Math.min(this.burnStep, remaining);
      this.integrateBurn(h);
      remaining -= h;
    }
  }

  private coastFor(dt: number): void {
    if (this.burning) this.burning = false;
    const res = coast(this.s, dt, { eph: this.eph, stopAtAtmosphere: true });
    this.s = res.state;
    for (const ev of res.events) {
      if (ev.kind === 'soi-enter' || ev.kind === 'soi-exit') this.events.push({ t: ev.t, kind: 'soi', detail: this.s.body });
    }
    if (res.halted) {
      const ev = res.events[res.events.length - 1];
      this.halted = ev;
      this.events.push({ t: ev.t, kind: ev.kind === 'atmosphere' ? 'atmosphere' : ev.kind === 'impact' ? 'impact' : 'escape' });
    }
  }

  private integrateBurn(h: number): void {
    const v = this.vehicle;
    if (!v.engine) {
      if (this.autoStage && !v.isLastStage && v.stageInfo && v.prop <= 0) {
        v.separate();
        this.events.push({ t: this.t, kind: 'staging', detail: `Stage ${v.state.stage}` });
        if (!v.engine) {
          this.endBurn('flameout');
          return;
        }
      } else {
        this.endBurn('flameout');
        this.coastFor(h);
        return;
      }
    }
    const e = v.engine!;
    let throttle = this.throttle;
    const ab = this.autoBurn;
    let dir = this.attitudeVector();
    if (ab) {
      dir = norm(nodeToInertial(this.s.r, this.s.v, ab.dv));
      const rem = ab.remaining;
      const accFull = e.thrustVac / v.mass;
      // Throttle down for the last second of the burn when possible.
      throttle = Math.min(1, Math.max(e.minThrottle, rem / Math.max(accFull * 1.0, 1e-6)));
      if (rem < 1e-3) {
        this.endBurn('burn-end');
        this.coastFor(h);
        return;
      }
    }
    throttle = v.effectiveThrottle(throttle);
    if (throttle <= 0) {
      this.coastFor(h);
      return;
    }
    if (!this.burning) this.burning = true;
    const ctl: FlightControls = {
      propulsion: { throttle, thrustVac: e.thrustVac, ispVac: e.ispVac, ispSl: e.ispSl, dir },
      aero: null,
    };
    const s = this.s;
    const m0 = v.mass;
    this.y.set([s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z, m0]);
    const mdot = (throttle * e.thrustVac) / (e.ispVac * G0);
    // Don't burn more than is left, and end the final auto-burn step exactly at cutoff
    // (1 m/s at TLI moves the lunar periapsis by ~1000 km, so step quantization matters).
    let hh = Math.min(h, v.prop / Math.max(mdot, 1e-9));
    if (ab) {
      const acc = (throttle * e.thrustVac) / m0;
      hh = Math.min(hh, ab.remaining / Math.max(acc, 1e-9));
    }
    this.rk.step(flightDerivative(this.body, ctl), s.t, this.y, hh);
    const burned = m0 - this.y[6];
    v.consume(burned);
    const dvStep = e.ispVac * G0 * Math.log(m0 / Math.max(1, m0 - burned));
    this.dvUsed += dvStep;
    if (ab) ab.remaining -= dvStep;
    this.thrustLevel = throttle;
    this.s = normalizeFrame({ body: s.body, t: s.t + hh, r: vec(this.y[0], this.y[1], this.y[2]), v: vec(this.y[3], this.y[4], this.y[5]) }, this.eph);
    if (hh < h) this.coastFor(h - hh);
  }

  private endBurn(kind: 'burn-end' | 'flameout'): void {
    this.thrustLevel = 0;
    this.burning = false;
    if (this.autoBurn) {
      const rem = this.autoBurn.remaining;
      this.events.push({ t: this.t, kind, detail: `${rem.toFixed(1)} m/s remaining` });
      this.autoBurn = null;
      this.node = null;
      this.attitude = 'prograde';
    } else if (kind === 'flameout') {
      this.events.push({ t: this.t, kind });
      this.throttle = 0;
    }
  }

  stage(): boolean {
    const ok = this.vehicle.separate();
    if (ok) this.events.push({ t: this.t, kind: 'staging', detail: `Stage ${this.vehicle.state.stage}` });
    return ok;
  }

  // ---- Planning -------------------------------------------------------------

  /** Trajectory prediction from now (no node). */
  predict(duration: number, maxSegments = 3): Prediction {
    return predictTrajectory(this.s, duration, { eph: this.eph, maxSegments });
  }

  /** Prediction after applying the node impulsively, starting at the node time. */
  predictWithNode(duration: number, maxSegments = 3): Prediction | null {
    if (!this.node) return null;
    const at = coastTo(this.s, this.node.t, this.eph);
    const after: OrbitState = { ...at, v: add(at.v, nodeToInertial(at.r, at.v, this.node.dv)) };
    return predictTrajectory(after, duration, { eph: this.eph, maxSegments });
  }

  /** Node that circularizes at the next apoapsis (or periapsis). */
  circularizeNode(at: 'apoapsis' | 'periapsis' = 'apoapsis'): ManeuverNode | null {
    const el = this.elements();
    const mu = this.body.mu;
    const dt = at === 'apoapsis' ? timeToApoapsis(el, mu) : timeToPeriapsis(el, mu);
    if (!Number.isFinite(dt) || dt < 0) return null;
    const tn = this.t + Math.max(dt, 1);
    const st = coastTo(this.s, tn, this.eph);
    const dv = circularizeDeltaV(mu, st.r, st.v);
    return { t: tn, dv: inertialToNode(st.r, st.v, dv) };
  }
}

/** Lunar approach summary of a prediction, or null if it never enters the Moon SOI. */
export function lunarApproach(p: Prediction): { periapsis: number; signedRadius: number; time: number; impact: boolean } | null {
  const seg = p.segments.find((s) => s.body === 'moon');
  if (!seg) return null;
  const imp = p.events.find((e) => e.kind === 'impact' && e.body === 'moon');
  const pe = p.events.find((e) => e.kind === 'periapsis' && e.body === 'moon');
  const R = BODIES.moon.radius;
  return {
    periapsis: seg.elements.rp - R,
    // Signed periapsis radius (prograde +): continuous through a head-on impact, for root finding.
    signedRadius: seg.elements.rp * (seg.elements.hVec.z >= 0 ? 1 : -1),
    time: pe?.t ?? imp?.t ?? seg.t0,
    impact: !!imp,
  };
}

/** Deep copy of a flight for planning simulations (no shared mutable state). */
export function cloneFlight(f: OrbitalFlight): OrbitalFlight {
  const c = new OrbitalFlight(f.s, structuredClone(f.vehicle.state), f.eph);
  c.node = f.node ? { t: f.node.t, dv: { ...f.node.dv } } : null;
  return c;
}

/** Simulate executing `node` with finite thrust; returns the flight just after cutoff. */
export function simulateNode(f: OrbitalFlight, node: ManeuverNode, step = 0.5): OrbitalFlight | null {
  const c = cloneFlight(f);
  c.burnStep = step;
  c.setNode(node);
  if (!c.executeNode()) return null;
  const tb = c.nodeBurnTime();
  c.advance(Math.max(0, node.t - c.t) + tb * 0.75 + 5);
  let guard = 0;
  while (c.autoBurn && guard++ < 200) c.advance(10);
  return c.halted ? null : c;
}

/**
 * Adjust an impulsive node so that its finite-thrust execution reproduces the
 * impulsive result: first match orbital energy (gravity-loss compensation),
 * then (optionally) re-solve the node time against an objective with bisection.
 */
export function refineNodeFinite(
  f: OrbitalFlight,
  node: ManeuverNode,
  objective?: (after: OrbitalFlight) => number,
  window = 240,
): ManeuverNode {
  const mu = BODIES[f.s.body].mu;
  const energyOf = (s: OrbitState) => (s.v.x ** 2 + s.v.y ** 2 + s.v.z ** 2) / 2 - mu / len(s.r);
  // Impulsive reference energy.
  const at = coastTo(f.s, node.t, f.eph);
  const impulsive: OrbitState = { ...at, v: add(at.v, nodeToInertial(at.r, at.v, node.dv)) };
  const eRef = energyOf(impulsive);
  let n: ManeuverNode = { t: node.t, dv: { ...node.dv } };
  for (let k = 0; k < 4; k++) {
    const after = simulateNode(f, n);
    if (!after || after.s.body !== f.s.body) break;
    const dE = eRef - energyOf(after.s);
    const corr = dE / len(after.s.v);
    if (Math.abs(corr) < 0.05) break;
    const mag = nodeMagnitude(n.dv);
    const k2 = (mag + corr) / mag;
    n = { t: n.t, dv: { prograde: n.dv.prograde * k2, normal: n.dv.normal * k2, radial: n.dv.radial * k2 } };
  }
  if (!objective) return n;
  const evalAt = (t: number) => {
    const after = simulateNode(f, { t, dv: n.dv });
    return after ? objective(after) : NaN;
  };
  // Search outward from the nominal time, alternating sides, for a sign change.
  const samples = 24;
  let bracket: [number, number] | null = null;
  const f0 = evalAt(n.t);
  if (Number.isFinite(f0) && Math.abs(f0) < 1) return n;
  for (let i = 1; i <= samples && !bracket && Number.isFinite(f0); i++) {
    const dt = (window * i) / samples;
    const fp = evalAt(n.t + dt);
    if (Number.isFinite(fp) && Math.sign(fp) !== Math.sign(f0)) bracket = [n.t, n.t + dt];
    else {
      const fm = evalAt(n.t - dt);
      if (Number.isFinite(fm) && Math.sign(fm) !== Math.sign(f0)) bracket = [n.t - dt, n.t];
    }
  }
  if (!bracket) return n;
  let [lo, hi] = bracket;
  let fLo = evalAt(lo);
  for (let k = 0; k < 24 && hi - lo > 0.05; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = evalAt(mid);
    if (!Number.isFinite(fm)) break;
    if (Math.sign(fm) === Math.sign(fLo)) {
      lo = mid;
      fLo = fm;
    } else hi = mid;
  }
  // Final secant polish at the flight integration step (the coarse search used 0.5 s steps).
  const fine = (t: number) => {
    const after = simulateNode(f, { t, dv: n.dv }, BURN_STEP);
    return after ? objective(after) : NaN;
  };
  let t0 = 0.5 * (lo + hi) - 0.3;
  let t1 = 0.5 * (lo + hi) + 0.3;
  let g0 = fine(t0);
  let g1 = fine(t1);
  for (let k = 0; k < 4 && Number.isFinite(g0) && Number.isFinite(g1) && g1 !== g0; k++) {
    const t2 = t1 - (g1 * (t1 - t0)) / (g1 - g0);
    if (!Number.isFinite(t2) || Math.abs(t2 - t1) > window) break;
    t0 = t1;
    g0 = g1;
    t1 = t2;
    g1 = fine(t1);
    if (Math.abs(g1) < 2_000) break;
  }
  return { t: Number.isFinite(g1) ? t1 : 0.5 * (lo + hi), dv: n.dv };
}

/**
 * Plan a small correction burn at `tNode` that puts the lunar periapsis at
 * `targetAltitude` on a prograde (counter-clockwise) approach. Tries prograde,
 * then radial, then normal components and picks the smallest burn that works.
 */
export function planLunarCorrection(f: OrbitalFlight, tNode: number, targetAltitude = 110e3, maxDv = 120): ManeuverNode | null {
  const at = coastTo(f.s, tNode, f.eph);
  const target = BODIES.moon.radius + targetAltitude;
  let best: ManeuverNode | null = null;
  for (const comp of ['prograde', 'radial', 'normal'] as const) {
    const objective = (x: number) => {
      const dv: NodeDeltaV = { prograde: 0, normal: 0, radial: 0 };
      dv[comp] = x;
      const after: OrbitState = { ...at, v: add(at.v, nodeToInertial(at.r, at.v, dv)) };
      const ap = lunarApproach(predictTrajectory(after, 9 * 86400, { eph: f.eph, maxSegments: 2, maxAngleStep: 0.05 }));
      return ap ? ap.signedRadius - target : NaN;
    };
    // Samples densest near zero, both signs.
    const xs: number[] = [0];
    for (let a = 0.05; a <= maxDv; a *= 1.35) xs.push(a, -a);
    xs.sort((p, q) => p - q);
    const fs = xs.map(objective);
    let bracket: [number, number] | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      if (!Number.isFinite(fs[i]) || !Number.isFinite(fs[i + 1]) || Math.sign(fs[i]) === Math.sign(fs[i + 1])) continue;
      // Reject jumps across the SOI-miss discontinuity.
      if (Math.abs(fs[i] - fs[i + 1]) > 3 * BODIES.moon.soi) continue;
      if (!bracket || Math.min(Math.abs(xs[i]), Math.abs(xs[i + 1])) < Math.min(Math.abs(bracket[0]), Math.abs(bracket[1]))) bracket = [xs[i], xs[i + 1]];
    }
    if (!bracket) continue;
    let [lo, hi] = bracket;
    let fLo = objective(lo);
    for (let k = 0; k < 50 && hi - lo > 1e-4; k++) {
      const mid = 0.5 * (lo + hi);
      const fm = objective(mid);
      if (!Number.isFinite(fm)) break;
      if (Math.sign(fm) === Math.sign(fLo)) {
        lo = mid;
        fLo = fm;
      } else hi = mid;
    }
    const x = 0.5 * (lo + hi);
    const dv: NodeDeltaV = { prograde: 0, normal: 0, radial: 0 };
    dv[comp] = x;
    if (!best || Math.abs(x) < nodeMagnitude(best.dv)) best = { t: tNode, dv };
    if (Math.abs(x) < 5) break; // good enough, skip the other axes
  }
  return best;
}

/**
 * Descent orbit insertion: from a near-circular lunar orbit, lower periapsis to
 * `periapsisAltitude`, choosing the periapsis point where the Sun stands
 * `sunElevation` above the horizon on the morning side (Sun rising), like Apollo.
 * `sun` is the unit direction to the Sun (inertial).
 */
export function planDoi(f: OrbitalFlight, sun: Vec3, sunElevation = 20 * (Math.PI / 180), periapsisAltitude = 15e3, minLead = 120): ManeuverNode | null {
  if (f.s.body !== 'moon') return null;
  const mu = BODIES.moon.mu;
  const el = f.elements();
  if (el.e >= 0.3) return null;
  const T = el.period;
  const target = Math.sin(sunElevation);
  // Sample one orbit for the rising crossing of the target sun elevation.
  const N = 720;
  let tP = NaN;
  let prev = NaN;
  for (let k = 0; k <= N * 2; k++) {
    const t = f.t + minLead + T / 2 + (T * k) / N;
    const st = coastTo(f.s, t, f.eph);
    const e = (st.r.x * sun.x + st.r.y * sun.y + st.r.z * sun.z) / len(st.r);
    if (Number.isFinite(prev) && prev < target && e >= target) {
      tP = t;
      break;
    }
    prev = e;
  }
  if (!Number.isFinite(tP)) return null;
  const tN = tP - T / 2;
  const at = coastTo(f.s, tN, f.eph);
  const rn = len(at.r);
  const rp = BODIES.moon.radius + periapsisAltitude;
  const vNew = Math.sqrt(mu * (2 / rn - 2 / (rn + rp)));
  // Horizontal speed now; the burn is (nearly) prograde/retrograde.
  const vr = (at.r.x * at.v.x + at.r.y * at.v.y + at.r.z * at.v.z) / rn;
  const vh = Math.sqrt(Math.max(0, len(at.v) ** 2 - vr * vr));
  return { t: tN, dv: { prograde: vNew - vh, normal: 0, radial: -vr } };
}

/** Entry interface radius, m (122 km). */
export const ENTRY_RADIUS = BODIES.earth.radius + 121_920;

/**
 * Vacuum perigee radius of an Earth-return conic with specific energy `energy`
 * that crosses the entry interface at flight-path angle `gamma` (rad, negative).
 */
export function perigeeForEntryAngle(energy: number, gamma: number): number {
  const mu = BODIES.earth.mu;
  const v = Math.sqrt(2 * (energy + mu / ENTRY_RADIUS));
  const hh = ENTRY_RADIUS * v * Math.cos(gamma);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * hh * hh) / (mu * mu)));
  return (hh * hh) / mu / (1 + e);
}

/** Flight-path angle (rad) at the entry interface for an Earth conic, or NaN if it misses. */
export function entryAngleOf(el: { energy: number; h: number }): number {
  const mu = BODIES.earth.mu;
  const v = Math.sqrt(2 * (el.energy + mu / ENTRY_RADIUS));
  const c = el.h / (ENTRY_RADIUS * v);
  return c > 1 ? NaN : -Math.acos(c);
}

/** The Earth-centered leg of a prediction that starts away from Earth (after leaving the Moon), or the first leg if Earth-bound. */
export function earthApproach(p: Prediction): { signedRadius: number; perigee: number; energy: number; gamma: number; time: number } | null {
  const segs = p.segments;
  const seg = segs[0].body === 'earth' ? segs[0] : segs.find((s, i) => i > 0 && s.body === 'earth');
  if (!seg) return null;
  const el = seg.elements;
  if (el.e < 1 && el.ra < 300_000e3 && segs[0].body === 'moon') return null; // still bound near the Moon's region? (not a return)
  const sgn = el.hVec.z >= 0 ? 1 : -1;
  const ev = p.events.find((e) => (e.kind === 'atmosphere' || e.kind === 'impact') && e.body === 'earth');
  return { signedRadius: el.rp * sgn, perigee: el.rp - BODIES.earth.radius, energy: el.energy, gamma: entryAngleOf(el), time: ev?.t ?? NaN };
}

const DEG_RAD = Math.PI / 180;

/**
 * Trans-Earth injection from a near-circular lunar orbit: a prograde burn whose
 * timing is solved so the return conic crosses the entry interface at `gamma`.
 */
export function planTei(f: OrbitalFlight, gamma = -6.5 * DEG_RAD, vInf = 950): ManeuverNode | null {
  if (f.s.body !== 'moon') return null;
  const el = f.elements();
  if (el.e >= 0.5) return null;
  const mu = BODIES.moon.mu;
  const r = len(f.s.r);
  const dvMag = Math.sqrt(vInf * vInf + (2 * mu) / r) - len(f.s.v);
  const T = el.period;
  const t0 = f.t + Math.max(300, f.vehicle.burnTimeFor(dvMag) / 2 + 120);
  const objective = (tb: number, sgn: number) => {
    const at = coastTo(f.s, tb, f.eph);
    const after: OrbitState = { ...at, v: add(at.v, nodeToInertial(at.r, at.v, { prograde: dvMag, normal: 0, radial: 0 })) };
    const ap = earthApproach(predictTrajectory(after, 6 * 86400, { eph: f.eph, maxSegments: 3, maxAngleStep: 0.05 }));
    if (!ap) return NaN;
    return ap.signedRadius - sgn * perigeeForEntryAngle(ap.energy, gamma);
  };
  for (const sgn of [1, -1]) {
    const N = 120;
    let prevT = NaN;
    let prevF = NaN;
    for (let k = 0; k <= N; k++) {
      const tb = t0 + (T * k) / N;
      const fv = objective(tb, sgn);
      if (Number.isFinite(fv) && Number.isFinite(prevF) && Math.sign(fv) !== Math.sign(prevF) && Math.abs(fv - prevF) < 2e8) {
        let lo = prevT, hi = tb, fLo = prevF;
        for (let it = 0; it < 50 && hi - lo > 1e-3; it++) {
          const mid = 0.5 * (lo + hi);
          const fm = objective(mid, sgn);
          if (!Number.isFinite(fm)) break;
          if (Math.sign(fm) === Math.sign(fLo)) { lo = mid; fLo = fm; } else hi = mid;
        }
        const node: ManeuverNode = { t: 0.5 * (lo + hi), dv: { prograde: dvMag, normal: 0, radial: 0 } };
        return refineNodeFinite(f, node, (afterF) => {
          const ap = earthApproach(afterF.predict(6 * 86400, 3));
          return ap ? ap.signedRadius - sgn * perigeeForEntryAngle(ap.energy, gamma) : NaN;
        }, 120);
      }
      prevT = tb;
      prevF = fv;
    }
  }
  return null;
}

/** Small correction on the way home to put the entry angle at `gamma` (impulsive, smallest axis). */
export function planEarthCorrection(f: OrbitalFlight, tNode: number, gamma = -6.5 * DEG_RAD, maxDv = 150): ManeuverNode | null {
  const at = coastTo(f.s, tNode, f.eph);
  let best: ManeuverNode | null = null;
  for (const comp of ['radial', 'prograde', 'normal'] as const) {
    const objective = (x: number) => {
      const dv: NodeDeltaV = { prograde: 0, normal: 0, radial: 0 };
      dv[comp] = x;
      const after: OrbitState = { ...at, v: add(at.v, nodeToInertial(at.r, at.v, dv)) };
      const ap = earthApproach(predictTrajectory(after, 6 * 86400, { eph: f.eph, maxSegments: 3, maxAngleStep: 0.05 }));
      if (!ap) return NaN;
      const sgn = Math.sign(ap.signedRadius) || 1;
      return ap.signedRadius - sgn * perigeeForEntryAngle(ap.energy, gamma);
    };
    const xs: number[] = [0];
    for (let a = 0.02; a <= maxDv; a *= 1.35) xs.push(a, -a);
    xs.sort((p, q) => p - q);
    const fs = xs.map(objective);
    let bracket: [number, number] | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      if (!Number.isFinite(fs[i]) || !Number.isFinite(fs[i + 1]) || Math.sign(fs[i]) === Math.sign(fs[i + 1])) continue;
      if (Math.abs(fs[i] - fs[i + 1]) > 5e7) continue;
      if (!bracket || Math.min(Math.abs(xs[i]), Math.abs(xs[i + 1])) < Math.min(Math.abs(bracket[0]), Math.abs(bracket[1]))) bracket = [xs[i], xs[i + 1]];
    }
    if (!bracket) continue;
    let [lo, hi] = bracket;
    let fLo = objective(lo);
    for (let k = 0; k < 50 && hi - lo > 1e-4; k++) {
      const mid = 0.5 * (lo + hi);
      const fm = objective(mid);
      if (!Number.isFinite(fm)) break;
      if (Math.sign(fm) === Math.sign(fLo)) { lo = mid; fLo = fm; } else hi = mid;
    }
    const x = 0.5 * (lo + hi);
    const dv: NodeDeltaV = { prograde: 0, normal: 0, radial: 0 };
    dv[comp] = x;
    if (!best || Math.abs(x) < nodeMagnitude(best.dv)) best = { t: tNode, dv };
    if (Math.abs(x) < 5) break;
  }
  return best;
}
