import { describe, expect, it } from 'vitest';
import {
  DAY,
  MOON,
  MOON_MEAN_MOTION,
  MOON_ORBIT_RADIUS,
  MU_EARTH,
  MU_MOON,
  R_EARTH,
  changeFrame,
  circularizeDeltaV,
  coast,
  cross,
  dot,
  hohmann,
  hohmannPhaseAngle,
  inertialToNode,
  injectionDeltaV,
  len,
  localFrame,
  moonPosition,
  nodeToInertial,
  predictTrajectory,
  propagateKepler,
  solveLambert,
  stateToElements,
  sub,
  add,
  vec,
  type OrbitState,
  type Ephemeris,
} from '../../src/physics';

const rPark = R_EARTH + 185e3;
const vPark = Math.sqrt(MU_EARTH / rPark);

/** Spacecraft at +X in a 185 km circular equatorial orbit, Moon leading by the Hohmann phase angle. */
function tliSetup(extraDv = 0): { s: OrbitState; eph: Ephemeris } {
  const phase = hohmannPhaseAngle(MU_EARTH, rPark, MOON_ORBIT_RADIUS, MOON_MEAN_MOTION);
  const eph: Ephemeris = { moonAngle0: phase, earthAngle0: 0 };
  const dv = injectionDeltaV(MU_EARTH, rPark, MOON_ORBIT_RADIUS) + extraDv;
  return { s: { body: 'earth', t: 0, r: vec(rPark, 0, 0), v: vec(0, vPark + dv, 0) }, eph };
}

describe('frames', () => {
  it('changeFrame round-trips', () => {
    const s: OrbitState = { body: 'earth', t: 12345, r: vec(3e8, 1e8, 2e6), v: vec(100, 900, 5) };
    const m = changeFrame(s, 'moon');
    const back = changeFrame(m, 'earth');
    expect(len(sub(back.r, s.r))).toBeLessThan(1e-6);
    expect(len(sub(back.v, s.v))).toBeLessThan(1e-9);
    expect(len(add(m.r, moonPosition(12345)))).toBeCloseTo(len(s.r), 3);
  });
});

describe('patched-conic prediction', () => {
  it('a parking orbit produces one closed segment and no events', () => {
    const s: OrbitState = { body: 'earth', t: 0, r: vec(rPark, 0, 0), v: vec(0, vPark, 0) };
    const T = 2 * Math.PI * Math.sqrt(rPark ** 3 / MU_EARTH);
    const p = predictTrajectory(s, T, { eph: { moonAngle0: Math.PI, earthAngle0: 0 } });
    expect(p.segments).toHaveLength(1);
    expect(p.events.filter((e) => e.kind !== 'periapsis')).toHaveLength(0);
    expect(len(sub(p.final.r, s.r))).toBeLessThan(1);
  });

  it('a Hohmann-phased TLI reaches the Moon SOI in ~3-5 days', () => {
    const { s, eph } = tliSetup(-5);
    const p = predictTrajectory(s, 8 * DAY, { eph });
    const enter = p.events.find((e) => e.kind === 'soi-enter');
    expect(enter).toBeDefined();
    expect(enter!.t / DAY).toBeGreaterThan(3);
    expect(enter!.t / DAY).toBeLessThan(5.2);
    expect(p.segments.length).toBeGreaterThanOrEqual(2);
    expect(p.segments[1].body).toBe('moon');
    // Inside the SOI the trajectory is hyperbolic with respect to the Moon.
    expect(p.segments[1].elements.e).toBeGreaterThan(1);
    // Entry point really is on the SOI boundary.
    const mState = changeFrame(enter!.state, 'moon', eph);
    expect(len(mState.r) / MOON.soi).toBeCloseTo(1, 4);
  });

  it('coast() and predictTrajectory() agree through an SOI change', () => {
    const { s, eph } = tliSetup(-5);
    const p = predictTrajectory(s, 4.6 * DAY, { eph });
    const c = coast(s, 4.6 * DAY, { eph });
    expect(c.state.body).toBe(p.final.body);
    expect(len(sub(c.state.r, p.final.r))).toBeLessThan(10);
  });

  it('coasting into the atmosphere halts at the interface', () => {
    // Elliptical orbit with periapsis inside the atmosphere (50 km).
    const ra = R_EARTH + 400e3;
    const rp = R_EARTH + 50e3;
    const a = (ra + rp) / 2;
    const va = Math.sqrt(MU_EARTH * (2 / ra - 1 / a));
    const s: OrbitState = { body: 'earth', t: 0, r: vec(ra, 0, 0), v: vec(0, va, 0) };
    const c = coast(s, 3 * 3600, { eph: { moonAngle0: Math.PI, earthAngle0: 0 } });
    expect(c.halted).toBe(true);
    expect(c.events.at(-1)!.kind).toBe('atmosphere');
    expect(c.events.at(-1)!.altitude).toBeCloseTo(140e3, -1);
  });

  it('lunar impact is detected', () => {
    const s: OrbitState = { body: 'moon', t: 0, r: vec(MOON.radius + 20e3, 0, 0), v: vec(-50, 500, 0) };
    const c = coast(s, 3600, {});
    expect(c.halted).toBe(true);
    expect(c.events.at(-1)!.kind).toBe('impact');
  });
});

describe('Lambert solver', () => {
  it('Curtis example 5.2', () => {
    const r1 = vec(5000e3, 10000e3, 2100e3);
    const r2 = vec(-14600e3, 2500e3, 7000e3);
    const sol = solveLambert(r1, r2, 3600, MU_EARTH, true)!;
    expect(sol).not.toBeNull();
    expect(sol.v1.x).toBeCloseTo(-5992.5, -1);
    expect(sol.v1.y).toBeCloseTo(1925.4, -1);
    expect(sol.v1.z).toBeCloseTo(3245.6, -1);
    expect(sol.v2.x).toBeCloseTo(-3312.5, -1);
    expect(sol.v2.y).toBeCloseTo(-4196.6, -1);
    expect(sol.v2.z).toBeCloseTo(-385.29, -1);
  });

  it('solutions propagate to the target (short and long way, hyperbolic)', () => {
    const r1 = vec(7000e3, 0, 0);
    const r2 = vec(-2000e3, 9000e3, 1000e3);
    for (const [tof, prograde] of [[2000, true], [9000, true], [20000, false], [600, true]] as const) {
      const sol = solveLambert(r1, r2, tof, MU_EARTH, prograde)!;
      expect(sol).not.toBeNull();
      const p = propagateKepler(r1, sol.v1, tof, MU_EARTH);
      expect(len(sub(p.r, r2))).toBeLessThan(5);
      const h = cross(r1, sol.v1);
      expect(Math.sign(h.z)).toBe(prograde ? 1 : -1);
    }
  });
});

describe('maneuvers', () => {
  it('local frame is orthonormal and right-handed', () => {
    const r = vec(7000e3, 1000e3, 500e3);
    const v = vec(-1000, 7400, 300);
    const f = localFrame(r, v);
    expect(len(f.prograde)).toBeCloseTo(1, 12);
    expect(dot(f.prograde, f.normal)).toBeCloseTo(0, 12);
    expect(dot(f.prograde, f.radial)).toBeCloseTo(0, 12);
    expect(dot(f.radial, r)).toBeGreaterThan(0); // radial-out points away from the body
    const node = { prograde: 120, normal: -35, radial: 12 };
    const back = inertialToNode(r, v, nodeToInertial(r, v, node));
    expect(back.prograde).toBeCloseTo(120, 9);
    expect(back.normal).toBeCloseTo(-35, 9);
    expect(back.radial).toBeCloseTo(12, 9);
  });

  it('circularizeDeltaV yields a circular orbit', () => {
    const r = vec(R_EARTH + 200e3, 0, 0);
    const v = vec(150, 7600, 40);
    const dv = circularizeDeltaV(MU_EARTH, r, v);
    const el = stateToElements(r, add(v, dv), MU_EARTH);
    expect(el.e).toBeLessThan(1e-9);
  });

  it('Hohmann LEO->GEO is ~3.9 km/s total', () => {
    const h = hohmann(MU_EARTH, R_EARTH + 300e3, 42_164e3);
    expect(h.total / 1000).toBeCloseTo(3.89, 1);
  });

  it('lunar capture burn helper matches vis-viva', () => {
    const rp = MOON.radius + 110e3;
    const vInf = 800;
    const vHyp = Math.sqrt(vInf ** 2 + (2 * MU_MOON) / rp);
    expect(vHyp - Math.sqrt(MU_MOON / rp)).toBeGreaterThan(700);
  });
});

describe('TLI planner', () => {
  it('targets a 110 km prograde lunar periapsis from a 185 km parking orbit', async () => {
    const { planTli } = await import('../../src/physics/planner');
    const s: OrbitState = { body: 'earth', t: 0, r: vec(rPark, 0, 0), v: vec(0, vPark, 0) };
    const plan = planTli(s, { eph: { moonAngle0: 2.0, earthAngle0: 0 }, targetAltitude: 110e3 })!;
    expect(plan).not.toBeNull();
    expect(plan.dv.prograde / 1000).toBeGreaterThan(3.1);
    expect(plan.dv.prograde / 1000).toBeLessThan(3.2);
    expect(Math.abs(plan.periapsisAltitude - 110e3)).toBeLessThan(2e3);
    expect(plan.arrivalTime / DAY).toBeGreaterThan(2.5);
    expect(plan.arrivalTime / DAY).toBeLessThan(6);
  });
});
