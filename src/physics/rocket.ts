// Rocket propulsion relations.

import { G0, P0 } from './constants';

/** Tsiolkovsky rocket equation: delta-v (m/s) for Isp (s) and initial/final mass. */
export function deltaV(isp: number, m0: number, mf: number): number {
  if (mf <= 0 || m0 <= mf) return 0;
  return isp * G0 * Math.log(m0 / mf);
}

/** Final mass after expending delta-v dv from initial mass m0. */
export function massAfterBurn(isp: number, m0: number, dv: number): number {
  return m0 / Math.exp(dv / (isp * G0));
}

/** Propellant mass required for delta-v dv starting from mass m0. */
export function propellantForDeltaV(isp: number, m0: number, dv: number): number {
  return m0 - massAfterBurn(isp, m0, dv);
}

/** Mass flow rate (kg/s) for thrust (N) at specific impulse (s). */
export function massFlow(thrust: number, isp: number): number {
  return thrust / (isp * G0);
}

/** Burn time (s) to expend from m0 to mf at constant thrust and Isp. */
export function burnTime(thrust: number, isp: number, m0: number, mf: number): number {
  return (m0 - mf) / massFlow(thrust, isp);
}

/**
 * Isp at ambient pressure p (Pa), interpolating linearly between the
 * sea-level and vacuum values (thrust loss is ~linear in back-pressure).
 */
export function ispAtPressure(ispVac: number, ispSl: number, p: number): number {
  const f = Math.min(Math.max(p / P0, 0), 1.5);
  return Math.max(1, ispVac - (ispVac - ispSl) * f);
}

/** Thrust-to-weight ratio against a local gravity g (default standard gravity). */
export function twr(thrust: number, mass: number, g = G0): number {
  return thrust / (mass * g);
}
