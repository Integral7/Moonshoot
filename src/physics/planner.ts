// Transfer targeting on top of the patched-conic predictor: find burn timing
// and magnitude that achieve a desired periapsis at the Moon (or Earth).

import { BODIES, MOON, type BodyId, type Ephemeris } from './bodies';
import { MU_EARTH, MOON_ORBIT_RADIUS } from './constants';
import { propagateKepler, stateToElements } from './kepler';
import { injectionDeltaV, nodeToInertial, type NodeDeltaV } from './maneuver';
import { predictTrajectory, type OrbitState, type Prediction } from './patched';
import { add, len } from './vec';

/** Apply an impulsive local-frame burn to a state. */
export function applyBurn(s: OrbitState, dv: NodeDeltaV): OrbitState {
  return { ...s, v: add(s.v, nodeToInertial(s.r, s.v, dv)) };
}

/** Propagate a (coasting, same-SOI) state forward to time t. */
export function stateAt(s: OrbitState, t: number): OrbitState {
  const { r, v } = propagateKepler(s.r, s.v, t - s.t, BODIES[s.body].mu);
  return { body: s.body, t, r, v };
}

/**
 * Signed periapsis radius of the first segment about `body` in a prediction:
 * positive for prograde (counter-clockwise about +Z), negative for retrograde.
 * Continuous through a head-on impact, which makes it a good root-finding target.
 * Returns NaN if the trajectory never enters that body's SOI.
 */
export function signedPeriapsis(p: Prediction, body: BodyId): number {
  const seg = p.segments.find((s) => s.body === body && s !== p.segments[0]) ?? (p.segments[0].body === body ? p.segments[0] : undefined);
  if (!seg) return NaN;
  const el = seg.elements;
  return el.hVec.z >= 0 ? el.rp : -el.rp;
}

export interface TransferPlan {
  /** Mission time of the burn, s. */
  burnTime: number;
  dv: NodeDeltaV;
  prediction: Prediction;
  /** Achieved periapsis altitude at the target body, m. */
  periapsisAltitude: number;
  /** Time of arrival at periapsis, s (NaN if none). */
  arrivalTime: number;
}

export interface TliOptions {
  eph: Ephemeris;
  /** Desired periapsis altitude at the Moon, m (default 110 km). */
  targetAltitude?: number;
  /** Prograde (true) or retrograde lunar approach. */
  prograde?: boolean;
  /** Extra prograde delta-v over the Hohmann estimate, m/s (shortens the trip). */
  extraDv?: number;
  /** Search window for the burn time, s from s.t (default: one parking orbit). */
  window?: number;
  /** Prediction horizon, s. */
  horizon?: number;
  samples?: number;
}

/**
 * Plan a trans-lunar injection from a near-circular Earth parking orbit:
 * a prograde burn whose timing is solved so the lunar periapsis hits the target.
 */
export function planTli(s: OrbitState, opts: TliOptions): TransferPlan | null {
  const el = stateToElements(s.r, s.v, MU_EARTH);
  const rPark = len(s.r);
  const dvMag = injectionDeltaV(MU_EARTH, rPark, MOON_ORBIT_RADIUS) + (opts.extraDv ?? 20);
  const target = (MOON.radius + (opts.targetAltitude ?? 110e3)) * (opts.prograde === false ? -1 : 1);
  const window = opts.window ?? el.period;
  const horizon = opts.horizon ?? 8 * 86400;
  const samples = opts.samples ?? 120;
  const dv: NodeDeltaV = { prograde: dvMag, normal: 0, radial: 0 };

  const evalAt = (tb: number): { f: number; pred: Prediction } => {
    const burnState = applyBurn(stateAt(s, tb), dv);
    const pred = predictTrajectory(burnState, horizon, { eph: opts.eph, maxSegments: 2, maxAngleStep: 0.05 });
    return { f: signedPeriapsis(pred, 'moon') - target, pred };
  };

  // Scan for a sign change in the objective among burn times that reach the Moon.
  let prevT = NaN;
  let prevF = NaN;
  let bracket: [number, number] | null = null;
  for (let k = 0; k <= samples; k++) {
    const tb = s.t + (window * k) / samples;
    const { f } = evalAt(tb);
    if (Number.isFinite(f) && Number.isFinite(prevF) && Math.sign(f) !== Math.sign(prevF)) {
      // Reject the discontinuity between "barely miss SOI" samples: require a small jump.
      if (Math.abs(f - prevF) < 4 * MOON.soi) {
        bracket = [prevT, tb];
        break;
      }
    }
    prevT = tb;
    prevF = f;
  }
  if (!bracket) return null;
  let [lo, hi] = bracket;
  let fLo = evalAt(lo).f;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = evalAt(mid).f;
    if (Math.sign(fm) === Math.sign(fLo)) {
      lo = mid;
      fLo = fm;
    } else hi = mid;
    if (hi - lo < 1e-3) break;
  }
  const burnTime = 0.5 * (lo + hi);
  const burnState = applyBurn(stateAt(s, burnTime), dv);
  const prediction = predictTrajectory(burnState, horizon, { eph: opts.eph, maxSegments: 3 });
  const pe = prediction.events.find((e) => e.kind === 'periapsis' && e.body === 'moon');
  return {
    burnTime,
    dv,
    prediction,
    periapsisAltitude: pe ? pe.altitude : Math.abs(signedPeriapsis(prediction, 'moon')) - MOON.radius,
    arrivalTime: pe ? pe.t : NaN,
  };
}

/**
 * Generic 1-D correction: find the scalar burn component (e.g. a prograde or
 * radial mid-course correction) that drives `objective` to zero, by bisection
 * over [lo, hi]. Returns NaN if no sign change.
 */
export function solveScalar(objective: (x: number) => number, lo: number, hi: number, tol = 1e-4, iters = 60): number {
  let fLo = objective(lo);
  const fHi = objective(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || Math.sign(fLo) === Math.sign(fHi)) return NaN;
  for (let k = 0; k < iters; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = objective(mid);
    if (!Number.isFinite(fm)) return NaN;
    if (Math.sign(fm) === Math.sign(fLo)) {
      lo = mid;
      fLo = fm;
    } else hi = mid;
    if (hi - lo < tol) break;
  }
  return 0.5 * (lo + hi);
}
