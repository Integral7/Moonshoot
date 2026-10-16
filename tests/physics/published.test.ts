// Checks the physics module against published reference values.
import { describe, expect, it } from 'vitest';
import {
  DAY,
  G0,
  MOON_ORBIT_RADIUS,
  MOON_SOI,
  MU_EARTH,
  MU_MOON,
  R_EARTH,
  R_MOON,
  captureDeltaV,
  circularVelocity,
  escapeVelocity,
  hohmann,
  injectionDeltaV,
  orbitalPeriod,
  visViva,
  deltaV,
  MOON_MEAN_MOTION,
  EARTH_ROTATION_RATE,
} from '../../src/physics';

const km = 1000;

describe('Earth orbit reference values', () => {
  it('LEO circular velocity at 185 km is ~7.79 km/s', () => {
    expect(circularVelocity(MU_EARTH, R_EARTH + 185 * km) / km).toBeCloseTo(7.793, 2);
  });

  it('ISS orbit (408 km) period is ~92.7 min', () => {
    const T = orbitalPeriod(MU_EARTH, R_EARTH + 408 * km) / 60;
    expect(T).toBeGreaterThan(92.4);
    expect(T).toBeLessThan(93.0);
  });

  it('Earth surface escape velocity is 11.19 km/s', () => {
    expect(escapeVelocity(MU_EARTH, R_EARTH) / km).toBeCloseTo(11.18, 1);
  });

  it('geostationary radius is 42,164 km for one sidereal day', () => {
    const Tsid = (2 * Math.PI) / EARTH_ROTATION_RATE;
    const a = Math.cbrt((MU_EARTH * Tsid * Tsid) / (4 * Math.PI * Math.PI));
    expect(a / km).toBeCloseTo(42164, -1);
  });

  it('equatorial surface rotation speed is ~465 m/s', () => {
    expect(EARTH_ROTATION_RATE * R_EARTH).toBeCloseTo(465.1, 0);
  });
});

describe('Earth-Moon transfer (patched conic)', () => {
  const rPark = R_EARTH + 185 * km;

  it('trans-lunar injection from 185 km LEO is ~3.1 km/s', () => {
    const dv = injectionDeltaV(MU_EARTH, rPark, MOON_ORBIT_RADIUS);
    expect(dv / km).toBeGreaterThan(3.05);
    expect(dv / km).toBeLessThan(3.2);
  });

  it('TLI burnout speed is ~10.9 km/s (just under escape)', () => {
    const a = (rPark + MOON_ORBIT_RADIUS) / 2;
    const v = visViva(MU_EARTH, rPark, a);
    expect(v / km).toBeCloseTo(10.93, 1);
    expect(v).toBeLessThan(escapeVelocity(MU_EARTH, rPark));
  });

  it('minimum-energy (Hohmann) transfer to the Moon takes ~5 days', () => {
    const { tof } = hohmann(MU_EARTH, rPark, MOON_ORBIT_RADIUS);
    expect(tof / DAY).toBeGreaterThan(4.8);
    expect(tof / DAY).toBeLessThan(5.1);
  });

  it('Moon orbital speed is ~1.02 km/s and period ~27.3 days', () => {
    expect((MOON_MEAN_MOTION * MOON_ORBIT_RADIUS) / km).toBeCloseTo(1.02, 2);
    expect((2 * Math.PI) / MOON_MEAN_MOTION / DAY).toBeCloseTo(27.3, 0);
  });

  it('Moon sphere of influence is ~66,100 km', () => {
    expect(MOON_SOI / km).toBeGreaterThan(65_500);
    expect(MOON_SOI / km).toBeLessThan(66_500);
  });

  it('lunar orbit insertion into 110 km circular orbit is ~0.8-0.9 km/s', () => {
    // Arrival speed relative to the Moon for a Hohmann transfer: Moon speed minus apogee speed.
    const a = (rPark + MOON_ORBIT_RADIUS) / 2;
    const vApo = visViva(MU_EARTH, MOON_ORBIT_RADIUS, a);
    const vInf = MOON_MEAN_MOTION * MOON_ORBIT_RADIUS - vApo;
    const dv = captureDeltaV(MU_MOON, vInf, R_MOON + 110 * km);
    expect(dv / km).toBeGreaterThan(0.75);
    expect(dv / km).toBeLessThan(0.95);
  });

  it('lunar-return entry speed at 122 km is ~11 km/s', () => {
    const rEi = R_EARTH + 121.92 * km;
    const a = (rEi + MOON_ORBIT_RADIUS) / 2;
    expect(visViva(MU_EARTH, rEi, a) / km).toBeCloseTo(11.0, 1);
  });
});

describe('Lunar reference values', () => {
  it('low lunar orbit (110 km) period is ~2 hours', () => {
    const T = orbitalPeriod(MU_MOON, R_MOON + 110 * km) / 3600;
    expect(T).toBeGreaterThan(1.9);
    expect(T).toBeLessThan(2.05);
  });

  it('lunar surface escape velocity is 2.38 km/s', () => {
    expect(escapeVelocity(MU_MOON, R_MOON) / km).toBeCloseTo(2.38, 2);
  });

  it('lunar surface gravity is ~1.62 m/s^2', () => {
    expect(MU_MOON / R_MOON ** 2).toBeCloseTo(1.62, 2);
  });

  it('LLO circular speed at 110 km is ~1.63 km/s', () => {
    expect(circularVelocity(MU_MOON, R_MOON + 110 * km) / km).toBeCloseTo(1.63, 2);
  });
});

describe('Rocket equation', () => {
  it('mass ratio e gives delta-v = Isp * g0', () => {
    expect(deltaV(300, Math.E * 1000, 1000)).toBeCloseTo(300 * G0, 6);
  });

  it('Apollo LM ascent stage (~4.7 t wet, 2.2 t dry, Isp 311 s) has ~2.2 km/s', () => {
    const dv = deltaV(311, 4700, 2150);
    expect(dv / km).toBeGreaterThan(2.1);
    expect(dv / km).toBeLessThan(2.5);
  });
});
