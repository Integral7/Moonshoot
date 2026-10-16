import { describe, expect, it } from 'vitest';
import { allenEggersPeakG, atmosphere, ispAtPressure, machDragFactor, suttonGraves } from '../../src/physics';

// US Standard Atmosphere 1976 published table values.
const TABLE: [number, number, number, number][] = [
  // z (m), T (K), P (Pa), rho (kg/m^3)
  [0, 288.15, 101325, 1.225],
  [5_000, 255.68, 54048, 0.73643],
  [11_000, 216.77, 22700, 0.36480],
  [20_000, 216.65, 5529.3, 0.088910],
  [32_000, 228.49, 889.06, 0.013555],
  [50_000, 270.65, 79.779, 0.0010269],
  [70_000, 219.59, 5.2209, 8.2829e-5],
  [86_000, 186.87, 0.3734, 6.958e-6],
];

describe('US Standard Atmosphere 1976', () => {
  for (const [z, T, P, rho] of TABLE) {
    it(`matches the table at ${z / 1000} km`, () => {
      const a = atmosphere(z);
      expect(Math.abs(a.T - T)).toBeLessThan(0.1);
      expect(Math.abs(a.P - P) / P).toBeLessThan(0.005);
      expect(Math.abs(a.rho - rho) / rho).toBeLessThan(0.005);
    });
  }

  it('upper atmosphere density at 100/200 km', () => {
    expect(atmosphere(100_000).rho).toBeCloseTo(5.604e-7, 9);
    expect(Math.abs(atmosphere(200_000).rho - 2.541e-10) / 2.541e-10).toBeLessThan(1e-6);
  });

  it('density decreases monotonically and is zero in vacuum', () => {
    let prev = Infinity;
    for (let z = 0; z <= 1_000_000; z += 2_500) {
      const r = atmosphere(z).rho;
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
    expect(atmosphere(2_000_000).rho).toBe(0);
  });

  it('speed of sound at sea level is 340.3 m/s', () => {
    expect(atmosphere(0).a).toBeCloseTo(340.3, 0);
  });
});

describe('aero and propulsion helpers', () => {
  it('Isp interpolates between sea level and vacuum', () => {
    expect(ispAtPressure(311, 263, 101325)).toBeCloseTo(263, 6);
    expect(ispAtPressure(311, 263, 0)).toBeCloseTo(311, 6);
  });

  it('Sutton-Graves flux for Apollo-like entry is O(100s W/cm^2)', () => {
    // ~11 km/s at ~60 km (rho ~3e-4), effective nose radius ~4.7 m.
    const q = suttonGraves(3.1e-4, 11_000, 4.7) / 1e4; // W/cm^2
    expect(q).toBeGreaterThan(100);
    expect(q).toBeLessThan(400);
  });

  it('Allen-Eggers: ballistic lunar return at -6.5 deg peaks near 35 g', () => {
    const g = allenEggersPeakG(11_000, 6.5 * (Math.PI / 180), 7_200);
    expect(g).toBeGreaterThan(30);
    expect(g).toBeLessThan(40);
  });

  it('transonic drag rise peaks near Mach 1.1', () => {
    expect(machDragFactor(0.3)).toBe(1);
    expect(machDragFactor(1.1)).toBeGreaterThan(machDragFactor(0.8));
    expect(machDragFactor(1.1)).toBeGreaterThan(machDragFactor(2.5));
  });
});
