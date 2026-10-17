// Earth reentry of the crew capsule: banked lift (L/D ~0.3), Sutton-Graves
// stagnation heating against the heat shield's limits, g-load, skip-out,
// drogue and main parachutes, splashdown.

import { EARTH, earthRotation, rotationVelocity, type Ephemeris } from '../physics/bodies';
import { DEG, R_EARTH } from '../physics/constants';
import { bankedLiftDirection, computeForces, flightDerivative, STATE_SIZE, type FlightControls, type ForceSample } from '../physics/dynamics';
import { RK4 } from '../physics/integrator';
import { dot, len, norm, rotateZ, scale, vec, type Vec3 } from '../physics/vec';
import { isLand } from './earthSurface';
import { Vehicle, type VehicleState } from './vehicle';

export const ENTRY_STEP = 0.02;
/** Bank-angle slew rate, rad/s. */
export const BANK_RATE = 15 * DEG;
/** Crew limit for sustained deceleration, g. */
export const ENTRY_G_LIMIT = 12;
/** Maximum dynamic pressure for drogue / main deployment, Pa. */
export const DROGUE_MAX_Q = 10_000;
export const MAIN_MAX_Q = 4_000;
/** Canopy fill times (reefed inflation), s. */
export const DROGUE_FILL = 3;
export const MAIN_FILL = 8;

export interface EntryControls {
  /** Commanded bank angle, rad (0 = lift up). */
  bank: number;
  deployDrogue?: boolean;
  deployMain?: boolean;
}

export type EntryEventKind =
  | 'interface'
  | 'blackout'
  | 'blackout-end'
  | 'peak-g'
  | 'drogue'
  | 'main'
  | 'chute-fail'
  | 'skip'
  | 'burn-through'
  | 'g-limit'
  | 'splashdown';

export interface EntryEvent {
  t: number;
  kind: EntryEventKind;
  detail?: string;
}

export interface SplashReport {
  speed: number;
  lat: number;
  lon: number;
  ocean: boolean;
  outcome: 'nominal' | 'hard' | 'fatal';
}

export class EntrySim {
  readonly vehicle: Vehicle;
  readonly y = new Float64Array(STATE_SIZE);
  t: number;
  bank = 0;
  forces: ForceSample;
  heatLoad = 0;
  peakFlux = 0;
  peakG = 0;
  peakQ = 0;
  /** Flight-path angle at the 122 km entry interface, rad (NaN until crossed). */
  entryAngle = NaN;
  entrySpeed = NaN;
  minAltitude = Infinity;
  failed: string | null = null;
  splash: SplashReport | null = null;
  events: EntryEvent[] = [];
  private rk = new RK4(STATE_SIZE);
  private flags = new Set<string>();
  private inBlackout = false;
  /** Canopy inflation fractions (0..1). */
  drogueFill = 0;
  mainFill = 0;

  constructor(r: Vec3, v: Vec3, vehicle: VehicleState, readonly eph: Ephemeris, t: number) {
    this.vehicle = new Vehicle(vehicle);
    // Capsule separation: drop everything below the crew module.
    while (this.vehicle.separate()) void 0;
    this.t = t;
    this.y.set([r.x, r.y, r.z, v.x, v.y, v.z, this.vehicle.mass]);
    this.forces = computeForces(EARTH, r, v, this.vehicle.mass, this.controls());
  }

  get r(): Vec3 {
    return vec(this.y[0], this.y[1], this.y[2]);
  }

  get v(): Vec3 {
    return vec(this.y[3], this.y[4], this.y[5]);
  }

  get altitude(): number {
    return len(this.r) - R_EARTH;
  }

  get up(): Vec3 {
    return norm(this.r);
  }

  get airVelocity(): Vec3 {
    return this.forces.airVelocity;
  }

  get verticalSpeed(): number {
    return dot(this.v, this.up);
  }

  /** Flight-path angle relative to the rotating atmosphere, rad. */
  get flightPathAngle(): number {
    const a = this.forces.airVelocity;
    return Math.asin(Math.max(-1, Math.min(1, dot(norm(a), this.up))));
  }

  get chutes(): VehicleState['chutes'] {
    return this.vehicle.state.chutes;
  }

  /** Drag area including partially inflated canopies, m^2. */
  get cdA(): number {
    const v = this.vehicle;
    const d = v.diameter;
    const base = 1.3 * (Math.PI / 4) * d * d;
    const c = v.chutes;
    if (!c) return base;
    const s = this.chutes;
    if (s === 'drogue') return base + c.drogueCdA * this.drogueFill;
    if (s === 'main') return base + c.drogueCdA * (1 - this.mainFill) + c.mainCdA * this.mainFill;
    return base;
  }

  private controls(): FlightControls {
    const v = this.vehicle;
    const air = this.forces ? this.forces.airVelocity : this.v;
    return {
      propulsion: null,
      aero: {
        cdA: this.cdA,
        liftToDrag: v.liftToDrag,
        liftDir: bankedLiftDirection(this.r, air, this.bank),
        noseRadius: v.noseRadius,
        machEffects: false,
      },
    };
  }

  private emitOnce(kind: EntryEventKind, detail?: string): void {
    if (this.flags.has(kind)) return;
    this.flags.add(kind);
    this.events.push({ t: this.t, kind, detail });
  }

  step(c: EntryControls, h = ENTRY_STEP): void {
    if (this.failed || this.splash) return;
    const db = Math.max(-BANK_RATE * h, Math.min(BANK_RATE * h, wrapPi(c.bank - this.bank)));
    this.bank = wrapPi(this.bank + db);
    if (c.deployDrogue && this.chutes === 'stowed') this.deploy('drogue');
    if (c.deployMain && (this.chutes === 'drogue' || this.chutes === 'stowed')) this.deploy('main');
    if (this.chutes === 'drogue') this.drogueFill = Math.min(1, this.drogueFill + h / DROGUE_FILL);
    if (this.chutes === 'main') this.mainFill = Math.min(1, this.mainFill + h / MAIN_FILL);
    this.rk.step(flightDerivative(EARTH, this.controls()), this.t, this.y, h);
    this.t += h;
    const f = computeForces(EARTH, this.r, this.v, this.y[6], this.controls());
    this.forces = f;
    this.monitor(f, h);
  }

  private deploy(kind: 'drogue' | 'main'): void {
    const q = this.forces.q;
    const limit = kind === 'drogue' ? DROGUE_MAX_Q : MAIN_MAX_Q;
    if (q > limit) {
      this.vehicle.state.chutes = 'cut';
      this.events.push({ t: this.t, kind: 'chute-fail', detail: `${kind} shredded at ${(q / 1000).toFixed(1)} kPa (limit ${(limit / 1000).toFixed(1)})` });
      return;
    }
    this.vehicle.state.chutes = kind;
    this.events.push({ t: this.t, kind });
  }

  private monitor(f: ForceSample, h: number): void {
    const alt = f.altitude;
    this.minAltitude = Math.min(this.minAltitude, alt);
    if (!Number.isFinite(this.entryAngle) && alt < 121_920) {
      this.entryAngle = Math.asin(Math.max(-1, Math.min(1, dot(norm(this.v), this.up))));
      this.entrySpeed = len(this.v);
      this.events.push({ t: this.t, kind: 'interface', detail: `${(this.entryAngle / DEG).toFixed(2)} deg at ${(this.entrySpeed / 1000).toFixed(2)} km/s` });
    }
    this.heatLoad += f.heatFlux * h;
    this.vehicle.state.heatLoad = this.heatLoad;
    this.peakFlux = Math.max(this.peakFlux, f.heatFlux);
    this.peakQ = Math.max(this.peakQ, f.q);
    if (f.gLoad > this.peakG) this.peakG = f.gLoad;
    // Communications blackout while the plasma sheath is dense.
    if (!this.inBlackout && f.heatFlux > 4e5 && alt < 100_000) {
      this.inBlackout = true;
      this.emitOnce('blackout');
    } else if (this.inBlackout && f.heatFlux < 1.5e5) {
      this.inBlackout = false;
      this.emitOnce('blackout-end');
    }
    const shield = this.vehicle.heatShield;
    if (!shield) {
      this.failed = 'No heat shield: the capsule was destroyed by entry heating.';
      this.events.push({ t: this.t, kind: 'burn-through' });
      return;
    }
    if (f.heatFlux > shield.maxFlux) {
      this.failed = `Heat shield burn-through: peak heat flux ${(f.heatFlux / 1e4).toFixed(0)} W/cm² exceeded the ${(shield.maxFlux / 1e4).toFixed(0)} W/cm² rating. The entry was too steep.`;
      this.events.push({ t: this.t, kind: 'burn-through' });
      return;
    }
    if (this.heatLoad > shield.maxLoad) {
      this.failed = `Heat shield ablated through: total heat load ${(this.heatLoad / 1e7).toFixed(1)} kJ/cm² exceeded ${(shield.maxLoad / 1e7).toFixed(1)}. The entry was too long and shallow.`;
      this.events.push({ t: this.t, kind: 'burn-through' });
      return;
    }
    if (f.gLoad > ENTRY_G_LIMIT) {
      this.failed = `Deceleration reached ${f.gLoad.toFixed(1)} g (crew limit ${ENTRY_G_LIMIT} g). The entry was too steep.`;
      this.events.push({ t: this.t, kind: 'g-limit' });
      return;
    }
    // Skip-out / miss: past perigee and climbing back out of the atmosphere, still fast.
    if (alt > this.minAltitude + 10_000 && alt > 130_000 && this.verticalSpeed > 0 && len(this.v) > 7_000) {
      this.failed = `Skip-out: the capsule bounced off the atmosphere at ${(len(this.v) / 1000).toFixed(1)} km/s. The entry was too shallow (or too much lift up).`;
      this.events.push({ t: this.t, kind: 'skip' });
      return;
    }
    if (alt <= 0) this.splashdown();
  }

  private splashdown(): void {
    const v = this.v;
    const air = rotationVelocity(EARTH, this.r);
    const rel = vec(v.x - air.x, v.y - air.y, v.z - air.z);
    const speed = len(rel);
    const fixed = rotateZ(this.r, -earthRotation(this.t, this.eph));
    const lat = Math.asin(fixed.z / len(fixed)) / DEG;
    const lon = Math.atan2(fixed.y, fixed.x) / DEG;
    const ocean = !isLand(fixed);
    const outcome: SplashReport['outcome'] = speed < 10 ? 'nominal' : speed < 16 ? 'hard' : 'fatal';
    this.splash = { speed, lat, lon, ocean, outcome };
    if (outcome === 'fatal') this.failed = `Impact at ${speed.toFixed(0)} m/s: ${this.chutes === 'main' ? 'the parachutes were not enough for this mass' : 'the main parachutes were not deployed'}.`;
    this.events.push({ t: this.t, kind: 'splashdown', detail: `${speed.toFixed(1)} m/s, ${ocean ? 'ocean' : 'land'}` });
  }
}

const wrapPi = (a: number): number => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

/**
 * Entry autopilot (constant-drag tracking, in the spirit of Apollo entry guidance):
 * fly lift-down until deceleration builds to the 4 g reference (ensuring capture
 * at supercircular speed), then modulate the bank angle to hold it, damped with a
 * constant-drag altitude-rate reference (hdot = -2 H D / v). Lift up once slow.
 * Auto-deploys drogues and mains (like the Apollo baroswitches) within their limits.
 */
export function entryAutopilot(sim: EntrySim): EntryControls {
  const f = sim.forces;
  const speed = len(f.airVelocity);
  const hdot = sim.verticalSpeed;
  const D = f.gLoad * 9.80665;
  const Dref = 4 * 9.80665;
  const H = 7_200;
  let bank = 0;
  if (speed > 1_800) {
    const hdotRef = (-2 * H * D) / Math.max(speed, 1);
    const cosb = Math.max(-1, Math.min(1, 0.3 + (1.5 * (D - Dref)) / Dref - 0.004 * (hdot - hdotRef)));
    bank = Math.acos(cosb);
  }
  const alt = sim.altitude;
  const deployDrogue = alt < 7_300 && f.q < DROGUE_MAX_Q * 0.8;
  const deployMain = alt < 3_000 && f.q < MAIN_MAX_Q * 0.8;
  return { bank, deployDrogue, deployMain };
}

/** Entry flight-path angle (rad) a capsule would have at radius r with velocity v. */
export function flightPathAngle(r: Vec3, v: Vec3): number {
  return Math.asin(dot(norm(r), norm(v)));
}

/** Build an entry state at altitude `alt` with speed `speed` and flight-path angle `gamma` (rad), heading east. */
export function entryState(alt: number, speed: number, gamma: number): { r: Vec3; v: Vec3 } {
  const r = vec(R_EARTH + alt, 0, 0);
  const v = vec(speed * Math.sin(gamma), speed * Math.cos(gamma), 0);
  return { r, v: scale(v, 1) };
}
