// Canonical starting states for free-play phases (and fallbacks when a
// campaign phase is entered without carried state).

import type { Ephemeris } from '../physics/bodies';
import { DEG, MU_EARTH, R_EARTH } from '../physics/constants';
import { applyBurn, planTli, stateAt } from '../physics/planner';
import type { OrbitState } from '../physics/patched';
import { vec } from '../physics/vec';
import { flyAscent } from './ascent';
import { DEFAULT_DESIGN, type VehicleState } from './vehicle';

export const PARKING_ALTITUDE = 185e3;

/**
 * Ephemeris for the standard mission: the Moon is placed so that it arrives
 * near -100 deg ECI longitude after a ~4 day coast, putting the lunar near
 * side at low morning sun (Sun along +X).
 */
export const STANDARD_EPHEMERIS: Ephemeris = { moonAngle0: -160 * DEG, earthAngle0: 0 };

/** Circular equatorial parking orbit at t = 0, spacecraft on +X. */
export function parkingOrbit(t = 0, altitude = PARKING_ALTITUDE): OrbitState {
  const r = R_EARTH + altitude;
  return { body: 'earth', t, r: vec(r, 0, 0), v: vec(0, Math.sqrt(MU_EARTH / r), 0) };
}

export interface CruisePreset {
  orbit: OrbitState;
  eph: Ephemeris;
  /** The nominal (perfect) post-TLI periapsis altitude, m. */
  nominalPeriapsis: number;
}

let cruiseCache: CruisePreset | null = null;

/**
 * Translunar coast 20 minutes after a TLI aimed at a conservative 900 km lunar
 * periapsis (TLI errors amplify enormously: 1 m/s at TLI is ~1000 km at the Moon),
 * so a mid-course correction is needed for the ideal 110 km.
 */
export function cruisePreset(): CruisePreset {
  if (cruiseCache) return structuredClone(cruiseCache);
  const eph = STANDARD_EPHEMERIS;
  const park = parkingOrbit(0);
  const plan = planTli(park, { eph, targetAltitude: 900e3, extraDv: 20 });
  if (!plan) throw new Error('cruisePreset: TLI planning failed');
  const postBurn = applyBurn(stateAt(park, plan.burnTime), plan.dv);
  const orbit = stateAt(postBurn, plan.burnTime + 20 * 60);
  cruiseCache = { orbit, eph, nominalPeriapsis: plan.periapsisAltitude };
  return structuredClone(cruiseCache);
}

export interface OrbitPreset {
  orbit: OrbitState;
  vehicle: VehicleState;
  eph: Ephemeris;
}

let orbitCache: OrbitPreset | null = null;

/** Free-play Earth-orbit start: the default vehicle just after an autopilot ascent. */
export function orbitPreset(): OrbitPreset {
  if (!orbitCache) {
    const sim = flyAscent(DEFAULT_DESIGN, STANDARD_EPHEMERIS);
    orbitCache = { orbit: sim.orbitState(), vehicle: structuredClone(sim.vehicle.state), eph: STANDARD_EPHEMERIS };
  }
  return structuredClone(orbitCache);
}
