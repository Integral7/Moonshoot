// Lambert's problem (single revolution) by the universal-variable method
// (Curtis, Algorithm 5.2), solved for z by bracketed bisection/Newton for robustness.

import { stumpffC, stumpffS } from './kepler';
import { cross, dot, len, scale, sub, type Vec3, UNIT_Z } from './vec';

export interface LambertSolution {
  v1: Vec3;
  v2: Vec3;
}

/**
 * Velocities at r1 and r2 for a transfer taking tof seconds. `prograde` picks
 * the short or long way so the motion is counter-clockwise about `normal`.
 * Returns null if no single-revolution solution exists.
 */
export function solveLambert(
  r1: Vec3,
  r2: Vec3,
  tof: number,
  mu: number,
  prograde = true,
  normal: Vec3 = UNIT_Z,
): LambertSolution | null {
  if (tof <= 0) return null;
  const r1m = len(r1);
  const r2m = len(r2);
  const c12 = cross(r1, r2);
  let dTheta = Math.acos(Math.min(1, Math.max(-1, dot(r1, r2) / (r1m * r2m))));
  const ccw = dot(c12, normal) >= 0;
  if (prograde !== ccw) dTheta = 2 * Math.PI - dTheta;

  const A = Math.sin(dTheta) * Math.sqrt((r1m * r2m) / (1 - Math.cos(dTheta)));
  if (!Number.isFinite(A) || Math.abs(A) < 1e-12) return null;

  const sqmu = Math.sqrt(mu);
  const y = (z: number) => r1m + r2m + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return -Infinity;
    return Math.pow(yz / stumpffC(z), 1.5) * stumpffS(z) + A * Math.sqrt(yz) - sqmu * tof;
  };

  // F(z) increases monotonically for single-revolution transfers. Bracket the root.
  let lo = -4 * Math.PI * Math.PI;
  let hi = 4 * Math.PI * Math.PI - 1e-6;
  // Move `lo` up until y(lo) >= 0 (only matters when A > 0).
  let guard = 0;
  while (y(lo) < 0 && guard++ < 200) lo = lo + (hi - lo) * 0.05;
  // Ensure lo really brackets from below (hyperbolic side may need to go more negative).
  guard = 0;
  while (F(lo) > 0 && guard++ < 60) lo *= 2;
  if (F(lo) > 0 || F(hi) < 0) return null;

  let z = 0;
  for (let k = 0; k < 200; k++) {
    z = 0.5 * (lo + hi);
    const fz = F(z);
    if (!Number.isFinite(fz) || fz < 0) lo = z;
    else hi = z;
    if (hi - lo < 1e-12) break;
  }

  const yz = y(z);
  const f = 1 - yz / r1m;
  const g = A * Math.sqrt(yz / mu);
  const gdot = 1 - yz / r2m;
  const v1 = scale(sub(r2, scale(r1, f)), 1 / g);
  const v2 = scale(sub(scale(r2, gdot), r1), 1 / g);
  return { v1, v2 };
}
