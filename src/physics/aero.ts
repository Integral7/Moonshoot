// Aerodynamics and entry heating.

import { SUTTON_GRAVES_K } from './constants';

/** Dynamic pressure q = 1/2 rho v^2 (Pa). */
export const dynamicPressure = (rho: number, v: number): number => 0.5 * rho * v * v;

/** Drag force magnitude (N) for drag area Cd*A (m^2). */
export const dragForce = (rho: number, v: number, cdA: number): number => dynamicPressure(rho, v) * cdA;

/**
 * Sutton-Graves convective stagnation-point heat flux (W/m^2) for a blunt body
 * with nose radius rn (m) at density rho (kg/m^3) and speed v (m/s).
 */
export function suttonGraves(rho: number, v: number, rn: number, k = SUTTON_GRAVES_K): number {
  if (rho <= 0 || rn <= 0) return 0;
  return k * Math.sqrt(rho / rn) * v * v * v;
}

/** Ballistic coefficient beta = m / (Cd A), kg/m^2. */
export const ballisticCoefficient = (mass: number, cdA: number): number => mass / cdA;

/**
 * Allen-Eggers peak deceleration (in g0 units) for a ballistic entry through an
 * exponential atmosphere with scale height H (m), entry speed v (m/s) and
 * flight-path angle gamma (rad, magnitude). Independent of ballistic coefficient.
 */
export function allenEggersPeakG(v: number, gamma: number, H: number, g0 = 9.80665): number {
  return (v * v * Math.sin(Math.abs(gamma))) / (2 * Math.E * H * g0);
}

/**
 * Transonic drag-rise multiplier on a nominal Cd as a function of Mach.
 * Peaks ~1.6x near Mach 1.1 and settles to ~1.1x hypersonic.
 */
export function machDragFactor(mach: number): number {
  if (mach < 0.6) return 1;
  if (mach < 1.1) return 1 + 0.6 * ((mach - 0.6) / 0.5) ** 2;
  if (mach < 3) return 1.6 - 0.45 * ((mach - 1.1) / 1.9);
  return 1.15 - 0.05 * Math.min(1, (mach - 3) / 7);
}
