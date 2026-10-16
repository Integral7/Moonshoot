// Two-body (Keplerian) orbit mechanics: classical elements, universal-variable
// propagation, and anomaly/time conversions. Follows Curtis, "Orbital Mechanics
// for Engineering Students", and Vallado, "Fundamentals of Astrodynamics".

import { add, cross, dot, len, scale, sub, vec, type Vec3, UNIT_Z } from './vec';

const TWO_PI = 2 * Math.PI;
const EPS = 1e-10;

export interface StateVector {
  r: Vec3;
  v: Vec3;
}

export interface Elements {
  /** Semi-major axis, m (negative for hyperbolic). */
  a: number;
  e: number;
  /** Inclination, rad. */
  i: number;
  /** Right ascension of ascending node, rad (0 for equatorial). */
  raan: number;
  /** Argument of periapsis, rad (longitude of periapsis for equatorial orbits). */
  argp: number;
  /** True anomaly, rad (true longitude / argument of latitude for circular orbits). */
  nu: number;
  /** Semi-latus rectum, m. */
  p: number;
  /** Specific angular momentum magnitude, m^2/s. */
  h: number;
  hVec: Vec3;
  eVec: Vec3;
  /** Specific orbital energy, J/kg. */
  energy: number;
  /** Periapsis radius, m. */
  rp: number;
  /** Apoapsis radius, m (Infinity if unbound). */
  ra: number;
  /** Orbital period, s (Infinity if unbound). */
  period: number;
}

export const circularVelocity = (mu: number, r: number): number => Math.sqrt(mu / r);
export const escapeVelocity = (mu: number, r: number): number => Math.sqrt((2 * mu) / r);
/** Vis-viva speed at radius r on an orbit with semi-major axis a. */
export const visViva = (mu: number, r: number, a: number): number => Math.sqrt(mu * (2 / r - 1 / a));
export const orbitalPeriod = (mu: number, a: number): number => TWO_PI * Math.sqrt((a * a * a) / mu);
export const specificEnergy = (mu: number, r: number, v: number): number => (v * v) / 2 - mu / r;

const wrap2pi = (x: number): number => {
  const y = x % TWO_PI;
  return y < 0 ? y + TWO_PI : y;
};
const clamp1 = (x: number): number => Math.min(1, Math.max(-1, x));

export function stateToElements(r: Vec3, v: Vec3, mu: number): Elements {
  const rm = len(r);
  const vm = len(v);
  const hVec = cross(r, v);
  const h = len(hVec);
  const nVec = cross(UNIT_Z, hVec);
  const n = len(nVec);
  const eVec = scale(sub(scale(r, vm * vm - mu / rm), scale(v, dot(r, v))), 1 / mu);
  const e = len(eVec);
  const energy = (vm * vm) / 2 - mu / rm;
  const a = Math.abs(1 - e) > 1e-12 ? -mu / (2 * energy) : Infinity;
  const p = (h * h) / mu;
  const i = Math.acos(clamp1(hVec.z / (h || 1)));
  const equatorial = n < EPS * Math.max(1, h);
  const circular = e < 1e-9;
  const retro = hVec.z < 0;

  let raan = 0;
  if (!equatorial) {
    raan = Math.acos(clamp1(nVec.x / n));
    if (nVec.y < 0) raan = TWO_PI - raan;
  }

  let argp = 0;
  if (!circular) {
    if (equatorial) {
      argp = Math.atan2(eVec.y, eVec.x);
      if (retro) argp = -argp;
      argp = wrap2pi(argp);
    } else {
      argp = Math.acos(clamp1(dot(nVec, eVec) / (n * e)));
      if (eVec.z < 0) argp = TWO_PI - argp;
    }
  }

  let nu: number;
  if (!circular) {
    nu = Math.acos(clamp1(dot(eVec, r) / (e * rm)));
    if (dot(r, v) < 0) nu = TWO_PI - nu;
  } else if (equatorial) {
    nu = Math.atan2(r.y, r.x);
    if (retro) nu = -nu;
    nu = wrap2pi(nu);
  } else {
    nu = Math.acos(clamp1(dot(nVec, r) / (n * rm)));
    if (r.z < 0) nu = TWO_PI - nu;
  }

  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;
  const period = e < 1 ? orbitalPeriod(mu, a) : Infinity;
  return { a, e, i, raan, argp, nu, p, h, hVec, eVec, energy, rp, ra, period };
}

/** Classical elements to state vector. Uses p = a(1-e^2); not valid for parabolic orbits. */
export function elementsToState(
  el: { a: number; e: number; i: number; raan: number; argp: number; nu: number },
  mu: number,
): StateVector {
  const { a, e, i, raan, argp, nu } = el;
  const p = a * (1 - e * e);
  const rPf = p / (1 + e * Math.cos(nu));
  const rp = vec(rPf * Math.cos(nu), rPf * Math.sin(nu), 0);
  const k = Math.sqrt(mu / p);
  const vp = vec(-k * Math.sin(nu), k * (e + Math.cos(nu)), 0);
  return { r: perifocalToInertial(rp, raan, i, argp), v: perifocalToInertial(vp, raan, i, argp) };
}

function perifocalToInertial(q: Vec3, raan: number, i: number, argp: number): Vec3 {
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  return vec(r11 * q.x + r12 * q.y, r21 * q.x + r22 * q.y, r31 * q.x + r32 * q.y);
}

// ---------------------------------------------------------------------------
// Universal-variable propagation

export function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720 - (z * z * z) / 40320;
}

export function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880;
}

/**
 * Propagate a two-body state by dt seconds (positive or negative). Exact up to
 * solver tolerance for elliptic, parabolic and hyperbolic orbits.
 */
export function propagateKepler(r0: Vec3, v0: Vec3, dt: number, mu: number): StateVector {
  if (dt === 0) return { r: { ...r0 }, v: { ...v0 } };
  const r0m = len(r0);
  const v0m2 = dot(v0, v0);
  const sqmu = Math.sqrt(mu);
  const rdv = dot(r0, v0);
  const vr0 = rdv / r0m;
  const alpha = 2 / r0m - v0m2 / mu;

  // Reduce elliptic propagation to within one period for conditioning.
  if (alpha > 1e-15) {
    const period = TWO_PI / (sqmu * Math.pow(alpha, 1.5));
    if (Math.abs(dt) > period) dt = dt % period;
    if (dt === 0) return { r: { ...r0 }, v: { ...v0 } };
  }

  let chi: number;
  if (alpha > 1e-12) {
    chi = sqmu * dt * alpha;
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const sgn = Math.sign(dt);
    const arg = (-2 * mu * alpha * dt) / (rdv + sgn * Math.sqrt(-mu * a) * (1 - r0m * alpha));
    chi = arg > 0 ? sgn * Math.sqrt(-a) * Math.log(arg) : sqmu * Math.abs(alpha) * dt;
  } else {
    chi = (sqmu * dt) / r0m;
  }

  let z = 0, C = 0.5, S = 1 / 6;
  for (let iter = 0; iter < 200; iter++) {
    z = alpha * chi * chi;
    C = stumpffC(z);
    S = stumpffS(z);
    const chi2 = chi * chi;
    const F = ((r0m * vr0) / sqmu) * chi2 * C + (1 - alpha * r0m) * chi2 * chi * S + r0m * chi - sqmu * dt;
    const dF = ((r0m * vr0) / sqmu) * chi * (1 - z * S) + (1 - alpha * r0m) * chi2 * C + r0m;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-9 * Math.max(1, Math.abs(chi))) break;
  }
  z = alpha * chi * chi;
  C = stumpffC(z);
  S = stumpffS(z);
  const chi2 = chi * chi;
  const f = 1 - (chi2 / r0m) * C;
  const g = dt - (chi2 * chi * S) / sqmu;
  const r = add(scale(r0, f), scale(v0, g));
  const rm = len(r);
  const fdot = (sqmu / (rm * r0m)) * (z * S - 1) * chi;
  const gdot = 1 - (chi2 / rm) * C;
  const v = add(scale(r0, fdot), scale(v0, gdot));
  return { r, v };
}

// ---------------------------------------------------------------------------
// Anomalies and timing

/** Mean anomaly from true anomaly. Elliptic: M in [0, 2pi). Hyperbolic: signed hyperbolic mean anomaly. */
export function trueToMean(nu: number, e: number): number {
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    return wrap2pi(E - e * Math.sin(E));
  }
  const nuS = nu > Math.PI ? nu - TWO_PI : nu;
  const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nuS / 2));
  return e * Math.sinh(F) - F;
}

/** True anomaly from mean anomaly (Newton solve of Kepler's equation). */
export function meanToTrue(M: number, e: number): number {
  if (e < 1) {
    M = wrap2pi(M);
    let E = e < 0.8 ? M : Math.PI;
    for (let k = 0; k < 50; k++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-13) break;
    }
    return wrap2pi(2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)));
  }
  let F = Math.asinh(M / e);
  for (let k = 0; k < 100; k++) {
    const d = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
    F -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return wrap2pi(2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(F / 2)));
}

/**
 * Time from the current true anomaly to a target true anomaly (always forward
 * in time for elliptic orbits; may be negative/NaN if unreachable on a hyperbola).
 */
export function timeToTrueAnomaly(el: Elements, nuTarget: number, mu: number): number {
  const e = el.e;
  if (e < 1) {
    const n = Math.sqrt(mu / (el.a * el.a * el.a));
    const dM = wrap2pi(trueToMean(nuTarget, e) - trueToMean(el.nu, e));
    return dM / n;
  }
  const n = Math.sqrt(mu / -(el.a * el.a * el.a));
  return (trueToMean(nuTarget, e) - trueToMean(el.nu, e)) / n;
}

/** Time until next periapsis passage (negative on an outbound hyperbola: periapsis already passed). */
export function timeToPeriapsis(el: Elements, mu: number): number {
  return timeToTrueAnomaly(el, 0, mu);
}

/** Time until next apoapsis (Infinity if unbound). */
export function timeToApoapsis(el: Elements, mu: number): number {
  if (el.e >= 1) return Infinity;
  return timeToTrueAnomaly(el, Math.PI, mu);
}

/** True anomaly at which the conic reaches radius r (positive branch), or NaN if never. */
export function trueAnomalyAtRadius(el: Elements, r: number): number {
  if (el.e < 1e-12) return NaN;
  const c = (el.p / r - 1) / el.e;
  if (c < -1 || c > 1) return NaN;
  return Math.acos(c);
}
