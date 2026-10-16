import { describe, expect, it } from 'vitest';
import {
  MU_EARTH,
  MU_MOON,
  R_EARTH,
  R_MOON,
  RK4,
  elementsToState,
  len,
  meanToTrue,
  propagateKepler,
  stateToElements,
  sub,
  timeToApoapsis,
  timeToPeriapsis,
  trueToMean,
  twoBodyDerivative,
  vec,
  dot,
  cross,
  symplecticEulerStep,
} from '../../src/physics';

const DEG = Math.PI / 180;

describe('elements <-> state', () => {
  const cases = [
    { a: 7_000e3, e: 0.01, i: 28.5 * DEG, raan: 40 * DEG, argp: 75 * DEG, nu: 120 * DEG },
    { a: 26_600e3, e: 0.74, i: 63.4 * DEG, raan: 200 * DEG, argp: 270 * DEG, nu: 10 * DEG },
    { a: -20_000e3, e: 1.4, i: 10 * DEG, raan: 15 * DEG, argp: 30 * DEG, nu: 40 * DEG },
  ];
  for (const c of cases) {
    it(`round-trips a=${c.a / 1e3} km e=${c.e}`, () => {
      const s = elementsToState(c, MU_EARTH);
      const el = stateToElements(s.r, s.v, MU_EARTH);
      expect(el.a / c.a).toBeCloseTo(1, 9);
      expect(el.e).toBeCloseTo(c.e, 9);
      expect(el.i).toBeCloseTo(c.i, 9);
      expect(el.raan).toBeCloseTo(c.raan, 9);
      expect(el.argp).toBeCloseTo(c.argp, 9);
      expect(el.nu).toBeCloseTo(c.nu, 9);
    });
  }

  it('handles equatorial, circular orbits (true longitude)', () => {
    const r = vec(0, R_EARTH + 200e3, 0);
    const v = vec(-Math.sqrt(MU_EARTH / len(r)), 0, 0);
    const el = stateToElements(r, v, MU_EARTH);
    expect(el.i).toBeCloseTo(0, 12);
    expect(el.e).toBeLessThan(1e-9);
    expect(el.nu).toBeCloseTo(Math.PI / 2, 9);
  });

  it('Curtis example 4.3: r=[-6045,-3490,2500] km, v=[-3.457,6.618,2.533] km/s', () => {
    const el = stateToElements(vec(-6045e3, -3490e3, 2500e3), vec(-3457, 6618, 2533), MU_EARTH);
    expect(el.h / 1e6).toBeCloseTo(58310, -2); // km^2/s
    expect(el.i / DEG).toBeCloseTo(153.2, 1);
    expect(el.raan / DEG).toBeCloseTo(255.3, 1);
    expect(el.e).toBeCloseTo(0.1712, 3);
    expect(el.argp / DEG).toBeCloseTo(20.07, 1);
    expect(el.nu / DEG).toBeCloseTo(28.45, 1);
  });
});

describe('universal-variable propagation', () => {
  it('Curtis example 3.7: hyperbolic-free propagation by 1 hour', () => {
    // r0 = [7000, -12124, 0] km, v0 = [2.6679, 4.6210, 0] km/s, dt = 60 min -> r = [-3297.8, 7413.4, 0] km
    const { r, v } = propagateKepler(vec(7000e3, -12124e3, 0), vec(2667.9, 4621.0, 0), 3600, MU_EARTH);
    expect(r.x / 1e3).toBeCloseTo(-3297.8, -1);
    expect(r.y / 1e3).toBeCloseTo(7413.4, -1);
    expect(v.x).toBeCloseTo(-8297.6, -1);
    expect(v.y).toBeCloseTo(-963.1, -1);
  });

  it('returns to start after one period', () => {
    const s = elementsToState({ a: 9_000e3, e: 0.3, i: 0.4, raan: 1, argp: 2, nu: 0.5 }, MU_EARTH);
    const T = 2 * Math.PI * Math.sqrt(9_000e3 ** 3 / MU_EARTH);
    const p = propagateKepler(s.r, s.v, T, MU_EARTH);
    expect(len(sub(p.r, s.r))).toBeLessThan(1e-2);
    // and many periods
    const p2 = propagateKepler(s.r, s.v, 37 * T + 100, MU_EARTH);
    const p3 = propagateKepler(s.r, s.v, 100, MU_EARTH);
    expect(len(sub(p2.r, p3.r))).toBeLessThan(1);
  });

  it('is reversible (forward then backward)', () => {
    const r0 = vec(R_MOON + 15e3, 0, 0);
    const v0 = vec(0, 2500, 300); // hyperbolic about the Moon
    const f = propagateKepler(r0, v0, 5000, MU_MOON);
    const b = propagateKepler(f.r, f.v, -5000, MU_MOON);
    expect(len(sub(b.r, r0))).toBeLessThan(1e-3);
    expect(len(sub(b.v, v0))).toBeLessThan(1e-6);
  });

  it('agrees with RK4 numerical integration', () => {
    const s = elementsToState({ a: 12_000e3, e: 0.4, i: 0.3, raan: 0.2, argp: 1.0, nu: 0 }, MU_EARTH);
    const y = new Float64Array([s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z]);
    const rk = new RK4(6);
    const h = 1;
    const T = 7200;
    rk.integrate(twoBodyDerivative(MU_EARTH), 0, y, h, T / h);
    const k = propagateKepler(s.r, s.v, T, MU_EARTH);
    expect(len(sub(vec(y[0], y[1], y[2]), k.r))).toBeLessThan(1); // < 1 m after 2 h
  });
});

describe('fixed-step integrators conserve invariants', () => {
  const r0 = R_EARTH + 400e3;
  const v0 = Math.sqrt(MU_EARTH / r0);
  const energy = (y: Float64Array) =>
    (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) / 2 - MU_EARTH / Math.hypot(y[0], y[1], y[2]);
  const angMom = (y: Float64Array) => len(cross(vec(y[0], y[1], y[2]), vec(y[3], y[4], y[5])));

  it('RK4 (dt = 1 s) over 10 orbits: relative energy drift < 1e-9', () => {
    const y = new Float64Array([r0, 0, 0, 0, v0 * 1.05, 0]);
    const e0 = energy(y);
    const h0 = angMom(y);
    new RK4(6).integrate(twoBodyDerivative(MU_EARTH), 0, y, 1, 10 * 5600);
    expect(Math.abs((energy(y) - e0) / e0)).toBeLessThan(1e-9);
    expect(Math.abs((angMom(y) - h0) / h0)).toBeLessThan(1e-9);
  });

  it('symplectic Euler energy error stays bounded', () => {
    const y = new Float64Array([r0, 0, 0, 0, v0, 0]);
    const e0 = energy(y);
    const accel = (r: Float64Array, out: Float64Array) => {
      const rr = Math.hypot(r[0], r[1], r[2]);
      const k = -MU_EARTH / rr ** 3;
      out[0] = k * r[0];
      out[1] = k * r[1];
      out[2] = k * r[2];
    };
    let maxErr = 0;
    for (let i = 0; i < 5600 * 5; i++) {
      symplecticEulerStep(accel, y, 1);
      maxErr = Math.max(maxErr, Math.abs((energy(y) - e0) / e0));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });
});

describe('anomalies and timing', () => {
  it('mean <-> true anomaly round-trip (elliptic and hyperbolic)', () => {
    for (const e of [0, 0.1, 0.7, 0.97]) {
      for (const nu of [0.1, 1, 2.5, 4, 6]) {
        expect(meanToTrue(trueToMean(nu, e), e)).toBeCloseTo(nu, 9);
      }
    }
    for (const nu of [0.2, 1.0, -0.8 + 2 * Math.PI]) {
      expect(meanToTrue(trueToMean(nu, 1.5), 1.5)).toBeCloseTo(nu, 9);
    }
  });

  it('time to periapsis/apoapsis brings the state to those points', () => {
    const s = elementsToState({ a: 10_000e3, e: 0.25, i: 0.1, raan: 0, argp: 0.3, nu: 2.0 }, MU_EARTH);
    const el = stateToElements(s.r, s.v, MU_EARTH);
    const pe = propagateKepler(s.r, s.v, timeToPeriapsis(el, MU_EARTH), MU_EARTH);
    const ap = propagateKepler(s.r, s.v, timeToApoapsis(el, MU_EARTH), MU_EARTH);
    expect(len(pe.r)).toBeCloseTo(el.rp, -1);
    expect(len(ap.r)).toBeCloseTo(el.ra, -1);
    expect(Math.abs(dot(pe.r, pe.v))).toBeLessThan(1e3 * len(pe.r) * 1e-6);
  });
});
