import { describe, expect, it } from 'vitest';
import { continentField, isLand } from '../src/sim/earthSurface';
import { snoise3 } from '../src/util/noise3';
import { vec } from '../src/physics/vec';

describe('procedural Earth land mask', () => {
  it('3D simplex port is bounded and deterministic', () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const n = snoise3(i * 0.137, i * 0.071 - 3, i * 0.023 + 5);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThan(-1.05);
    expect(hi).toBeLessThan(1.05);
    expect(hi - lo).toBeGreaterThan(1);
    expect(snoise3(1.5, 2.5, 3.5)).toBe(snoise3(1.5, 2.5, 3.5));
  });

  it('roughly a quarter to a half of the globe is land', () => {
    let land = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      // Fibonacci sphere sampling.
      const y = 1 - (2 * (i + 0.5)) / N;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      if (isLand(vec(r * Math.cos(a), r * Math.sin(a), y))) land++;
    }
    expect(land / N).toBeGreaterThan(0.15);
    expect(land / N).toBeLessThan(0.55);
    expect(Number.isFinite(continentField(0.3, 0.4, 0.5))).toBe(true);
  });
});
