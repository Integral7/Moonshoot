import { describe, expect, it } from 'vitest';
import {
  EARTH,
  FixedStepper,
  G0,
  R_EARTH,
  RK4,
  STATE_SIZE,
  allenEggersPeakG,
  bankedLiftDirection,
  computeForces,
  deltaV,
  flightDerivative,
  len,
  vec,
  type Body,
  type FlightControls,
} from '../../src/physics';

const DEG = Math.PI / 180;

/** Simulate a capsule entry and return peak g and final speed. */
function simulateEntry(liftToDrag: number, gammaDeg: number, bank = 0, v0 = 11_000) {
  const rEi = R_EARTH + 121.92e3;
  const gam = -gammaDeg * DEG;
  const y = new Float64Array([rEi, 0, 0, v0 * Math.sin(gam), v0 * Math.cos(gam), 0, 5_500]);
  const rk = new RK4(STATE_SIZE);
  let peakG = 0;
  let peakHeat = 0;
  let t = 0;
  const h = 0.05;
  for (let i = 0; i < 20_000; i++) {
    const r = vec(y[0], y[1], y[2]);
    const v = vec(y[3], y[4], y[5]);
    const controls: FlightControls = {
      propulsion: null,
      aero: { cdA: 1.3 * 12.0, liftToDrag, liftDir: null, noseRadius: 4.7, machEffects: false },
    };
    const f0 = computeForces(EARTH, r, v, y[6], controls);
    controls.aero!.liftDir = bankedLiftDirection(r, f0.airVelocity, bank);
    const f = computeForces(EARTH, r, v, y[6], controls);
    peakG = Math.max(peakG, f.gLoad);
    peakHeat = Math.max(peakHeat, f.heatFlux);
    if (f.altitude < 20e3 || f.altitude > 200e3) break;
    rk.step(flightDerivative(EARTH, controls), t, y, h);
    t += h;
  }
  return { peakG, peakHeat, speed: Math.hypot(y[3], y[4], y[5]) };
}

describe('entry dynamics', () => {
  it('steep ballistic entry matches Allen-Eggers peak deceleration within 15%', () => {
    // Allen-Eggers neglects gravity and curvature, so it is accurate for steep entries.
    const gamma = 25;
    const { peakG } = simulateEntry(0, gamma, 0, 7_000);
    const ae = allenEggersPeakG(7_000, gamma * DEG, 7_200);
    expect(Math.abs(peakG - ae) / ae).toBeLessThan(0.15);
  });

  it('shallow ballistic lunar-return entry (-6.5 deg) is harsh but well below flat-Earth theory', () => {
    // Shallow supercircular entries peak far below the Allen-Eggers estimate (~35 g).
    const { peakG, speed } = simulateEntry(0, 6.5);
    expect(peakG).toBeGreaterThan(8);
    expect(peakG).toBeLessThan(25);
    expect(speed).toBeLessThan(1000); // slowed to subsonic-ish by 20 km
  });

  it('a lifting entry (L/D 0.3, lift up) reduces peak g substantially', () => {
    const ballistic = simulateEntry(0, 6.5);
    const lifting = simulateEntry(0.3, 6.5, 0);
    expect(lifting.peakG).toBeLessThan(ballistic.peakG * 0.6);
    expect(lifting.peakHeat).toBeGreaterThan(1e6); // > 100 W/cm^2
  });
});

describe('powered flight', () => {
  it('a vacuum burn matches the rocket equation', () => {
    const deep: Body = { ...EARTH, mu: 0, atmosphereTop: 0 };
    const isp = 320;
    const m0 = 10_000;
    const thrust = 50_000;
    const y = new Float64Array([1e9, 0, 0, 0, 0, 0, m0]);
    const controls: FlightControls = {
      propulsion: { throttle: 1, thrustVac: thrust, ispVac: isp, ispSl: isp, dir: vec(0, 1, 0) },
      aero: null,
    };
    const rk = new RK4(STATE_SIZE);
    const burn = 200; // s
    rk.integrate(flightDerivative(deep, controls), 0, y, 0.02, burn / 0.02);
    const mf = m0 - (thrust / (isp * G0)) * burn;
    expect(y[6]).toBeCloseTo(mf, 6);
    expect(y[4]).toBeCloseTo(deltaV(isp, m0, mf), 4);
  });

  it('liftoff: thrust/weight > 1 climbs; sea-level Isp is applied', () => {
    const y = new Float64Array([R_EARTH, 0, 0, 0, EARTH.rotationRate * R_EARTH, 0, 100_000]);
    const controls: FlightControls = {
      propulsion: { throttle: 1, thrustVac: 1.6e6, ispVac: 300, ispSl: 260, dir: vec(1, 0, 0) },
      aero: { cdA: 10, liftToDrag: 0, liftDir: null, noseRadius: 1, machEffects: true },
    };
    const f = computeForces(EARTH, vec(y[0], y[1], y[2]), vec(y[3], y[4], y[5]), y[6], controls);
    expect(f.thrustMag).toBeCloseTo(1.6e6 * (260 / 300), 0);
    expect(f.airspeed).toBeLessThan(1e-6); // co-rotating atmosphere at rest
    const rk = new RK4(STATE_SIZE);
    rk.integrate(flightDerivative(EARTH, controls), 0, y, 0.02, 500);
    expect(len(vec(y[0], y[1], y[2])) - R_EARTH).toBeGreaterThan(100);
  });
});

describe('FixedStepper', () => {
  it('runs a whole number of fixed steps regardless of frame timing', () => {
    const fs = new FixedStepper(0.02);
    let steps = 0;
    for (let i = 0; i < 600; i++) fs.advance(1 / 60, () => steps++);
    expect(Math.abs(steps - 500)).toBeLessThanOrEqual(1);
  });

  it('caps steps per frame', () => {
    const fs = new FixedStepper(0.01, 100);
    expect(fs.advance(10, () => {})).toBe(100);
  });
});
