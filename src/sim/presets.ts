// Canonical starting states for free-play phases (and fallbacks when a
// campaign phase is entered without carried state).

import type { Ephemeris } from '../physics/bodies';
import { DEG, MU_EARTH, R_EARTH } from '../physics/constants';
import { applyBurn, planTli, stateAt } from '../physics/planner';
import type { OrbitState } from '../physics/patched';
import { rotateZ, scale, vec, type Vec3 } from '../physics/vec';
import { moonRotation } from '../physics/bodies';
import { R_MOON } from '../physics/constants';
import { flyAscent } from './ascent';
import { DEFAULT_DESIGN, Vehicle, createVehicleState, type VehicleState } from './vehicle';
import { OrbitalFlight, lunarApproach, planLunarCorrection } from './orbital';

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

/**
 * Burn `dv` (m/s, vacuum) from a vehicle state using its stages in order,
 * staging when a stage runs dry. Used to build plausible free-play states.
 */
export function vehicleAfterDv(state: VehicleState, dv: number): VehicleState {
  const v = new Vehicle(structuredClone(state));
  let rem = dv;
  let guard = 0;
  while (rem > 0.01 && guard++ < 20) {
    const e = v.stageInfo?.engine;
    if (!e || v.prop <= 0) {
      if (!v.separate()) break;
      continue;
    }
    const ve = e.ispVac * 9.80665;
    const m0 = v.mass;
    const dvStage = ve * Math.log(m0 / (m0 - v.prop));
    if (dvStage >= rem) {
      v.consume(m0 * (1 - Math.exp(-rem / ve)));
      rem = 0;
    } else {
      rem -= dvStage;
      v.consume(v.prop);
    }
  }
  return v.state;
}

/** Vehicle state on the translunar coast (after ascent, circularization and TLI). */
export function cruiseVehicle(): VehicleState {
  return vehicleAfterDv(orbitPreset().vehicle, 3_160);
}

export interface LandingPreset {
  orbit: OrbitState;
  vehicle: VehicleState;
  eph: Ephemeris;
}

let landingCache: LandingPreset | null = null;

/** Free-play lunar arrival: the cruise preset after a mid-course correction, one hour before periapsis. */
export function landingPreset(): LandingPreset {
  if (!landingCache) {
    const p = cruisePreset();
    const f = new OrbitalFlight(p.orbit, cruiseVehicle(), p.eph);
    const mcc = planLunarCorrection(f, f.t + 1800);
    if (mcc) {
      f.setNode(mcc);
      f.executeNode();
      f.advance(mcc.t - f.t + 60);
    }
    const ap = lunarApproach(f.predict(9 * 86400));
    if (ap) f.advance(ap.time - 3600 - f.t);
    landingCache = { orbit: f.s, vehicle: structuredClone(f.vehicle.state), eph: p.eph };
  }
  return structuredClone(landingCache);
}

export interface ReturnPreset {
  surface: { r: Vec3; t: number; eph: Ephemeris };
  vehicle: VehicleState;
}

/**
 * Free-play return start: the recommended lander on the surface 3.3 days into
 * the mission, at a site with the Sun 25 deg up in the morning sky, with 10% of
 * its descent propellant left.
 */
export function returnPreset(): ReturnPreset {
  const eph = STANDARD_EPHEMERIS;
  const t = 3.3 * 86400;
  const a = -65 * DEG;
  const inertialDir = vec(Math.cos(a), Math.sin(a), 0);
  const fixed = rotateZ(inertialDir, -moonRotation(t, eph));
  const vehicle = createVehicleState({ name: DEFAULT_DESIGN.name, parts: DEFAULT_DESIGN.parts.slice(1, 15) });
  vehicle.design = { name: DEFAULT_DESIGN.name, parts: DEFAULT_DESIGN.parts.slice(1, 15) };
  vehicle.stages[0].prop *= 0.1;
  return { surface: { r: scale(fixed, R_MOON), t, eph }, vehicle };
}
