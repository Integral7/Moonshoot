// Launch and ascent simulation: a vehicle on an equatorial pad, flown by the
// player (pitch + throttle + staging) or by the ascent autopilot. Pure logic,
// fixed-step RK4, no rendering.

import { EARTH, earthRotation, surfacePosition, rotationVelocity, type Ephemeris } from '../physics/bodies';
import { DEG, G0, MU_EARTH, R_EARTH, ATMOSPHERE_TOP } from '../physics/constants';
import { computeForces, flightDerivative, STATE_SIZE, type FlightControls, type ForceSample } from '../physics/dynamics';
import { RK4 } from '../physics/integrator';
import { stateToElements, type Elements } from '../physics/kepler';
import type { OrbitState } from '../physics/patched';
import { add, cross, dot, len, norm, scale, sub, vec, type Vec3, UNIT_Z } from '../physics/vec';
import { Vehicle, createVehicleState, type VehicleDesign, type VehicleState } from './vehicle';

export const ASCENT_STEP = 0.02;
export const TARGET_ALTITUDE = 185e3;
/** Structural limit on dynamic pressure times angle of attack, Pa*deg. */
export const Q_ALPHA_LIMIT = 200_000;
/** Crew g-load limit. */
export const G_LIMIT = 9;

export interface AscentControls {
  /** Commanded throttle 0..1. */
  throttle: number;
  /** Commanded pitch from vertical, degrees (0 = up, 90 = horizontal east). */
  pitch: number;
}

export type AscentEventKind =
  | 'ignition'
  | 'liftoff'
  | 'tower-clear'
  | 'pitch-program'
  | 'mach1'
  | 'max-q'
  | 'staging'
  | 'les-jettison'
  | 'flameout'
  | 'meco'
  | 'space'
  | 'go-orbit'
  | 'breakup'
  | 'crash'
  | 'g-limit'
  | 'no-liftoff';

export interface AscentEvent {
  t: number;
  kind: AscentEventKind;
  detail?: string;
}

export interface LaunchSite {
  lat: number;
  lon: number;
}

export const DEFAULT_SITE: LaunchSite = { lat: 0, lon: 0 };

/** Local vertical/east/north unit vectors at position r (ECI). */
export function localFrame(r: Vec3): { up: Vec3; east: Vec3; north: Vec3 } {
  const up = norm(r);
  let east = cross(UNIT_Z, up);
  if (len(east) < 1e-9) east = vec(0, 1, 0);
  east = norm(east);
  const north = cross(up, east);
  return { up, east, north };
}

export class AscentSim {
  readonly vehicle: Vehicle;
  readonly y = new Float64Array(STATE_SIZE);
  t: number;
  launched = false;
  /** Actual pitch from vertical, deg (rate-limited toward the command). */
  pitch = 0;
  throttle = 0;
  /** Max pitch rate, deg/s. */
  pitchRate = 8;
  forces: ForceSample;
  maxQ = 0;
  maxQTime = 0;
  maxG = 0;
  /** Ideal delta-v expended (integral of thrust acceleration), m/s. */
  dvUsed = 0;
  failed: string | null = null;
  events: AscentEvent[] = [];
  private rk = new RK4(STATE_SIZE);
  private flags = new Set<string>();
  private lastQ = 0;
  private cutoffTime = -Infinity;
  private flameoutTime = -Infinity;
  aoa = 0;

  constructor(
    vehicle: VehicleDesign | VehicleState,
    readonly eph: Ephemeris,
    t0 = -10,
    readonly site: LaunchSite = DEFAULT_SITE,
  ) {
    this.vehicle = new Vehicle('stages' in vehicle ? vehicle : createVehicleState(vehicle));
    this.t = t0;
    this.holdOnPad();
    this.forces = computeForces(EARTH, this.r, this.v, this.y[6], this.controls(0, vec(1, 0, 0)));
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

  get frame() {
    return localFrame(this.r);
  }

  /** Thrust direction for a pitch angle (deg from vertical), in the equatorial plane heading east. */
  directionFor(pitchDeg: number): Vec3 {
    const { up, east } = this.frame;
    const p = pitchDeg * DEG;
    return norm(add(scale(up, Math.cos(p)), scale(east, Math.sin(p))));
  }

  get thrustDirection(): Vec3 {
    return this.directionFor(this.pitch);
  }

  orbitState(): OrbitState {
    return { body: 'earth', t: this.t, r: this.r, v: this.v };
  }

  elements(): Elements {
    return stateToElements(this.r, this.v, MU_EARTH);
  }

  get apoapsisAltitude(): number {
    const el = this.elements();
    return el.e < 1 ? el.ra - R_EARTH : Infinity;
  }

  get periapsisAltitude(): number {
    return this.elements().rp - R_EARTH;
  }

  get verticalSpeed(): number {
    return dot(this.v, this.frame.up);
  }

  get surfaceSpeed(): number {
    return len(sub(this.v, rotationVelocity(EARTH, this.r)));
  }

  /** Downrange distance from the pad along the surface, m. */
  get downrange(): number {
    const pad = surfacePosition(EARTH, this.site.lat, this.site.lon, 0, earthRotation(this.t, this.eph));
    const a = Math.acos(Math.min(1, dot(norm(pad), norm(this.r))));
    return a * R_EARTH;
  }

  get engineOn(): boolean {
    return this.throttle > 0 && !!this.vehicle.engine;
  }

  private holdOnPad(): void {
    const p = surfacePosition(EARTH, this.site.lat, this.site.lon, 0, earthRotation(this.t, this.eph));
    const vel = rotationVelocity(EARTH, p);
    this.y.set([p.x, p.y, p.z, vel.x, vel.y, vel.z, this.vehicle.mass]);
  }

  private controls(throttle: number, dir: Vec3): FlightControls {
    const e = this.vehicle.engine;
    const v = this.vehicle;
    return {
      propulsion: e && throttle > 0 ? { throttle, thrustVac: e.thrustVac, ispVac: e.ispVac, ispSl: e.ispSl, dir } : null,
      aero: { cdA: v.cdA, liftToDrag: 0, liftDir: null, noseRadius: v.noseRadius, machEffects: true },
    };
  }

  private emit(kind: AscentEventKind, detail?: string): void {
    this.events.push({ t: this.t, kind, detail });
  }

  private once(kind: AscentEventKind, detail?: string): void {
    if (this.flags.has(kind)) return;
    this.flags.add(kind);
    this.emit(kind, detail);
  }

  /** Separate the current stage (player or autopilot). */
  stage(): boolean {
    if (this.failed) return false;
    const hadLes = this.vehicle.state.lesAttached;
    const prev = this.vehicle.state.stage;
    if (!this.vehicle.separate()) return false;
    this.emit('staging', `Stage ${prev + 1} separation`);
    if (hadLes && !this.vehicle.state.lesAttached) this.emit('les-jettison');
    this.y[6] = this.vehicle.mass;
    this.flameoutTime = -Infinity;
    return true;
  }

  /** Advance one fixed step with the given controls. */
  step(c: AscentControls, h = ASCENT_STEP): void {
    if (this.failed) return;
    // Attitude: rate-limited slew toward the commanded pitch.
    const dp = Math.max(-this.pitchRate * h, Math.min(this.pitchRate * h, c.pitch - this.pitch));
    this.pitch = Math.max(-10, Math.min(180, this.pitch + dp));
    // Engines may be ignited a few seconds before liftoff.
    const wantThrottle = this.t < -3 ? 0 : c.throttle;
    if (wantThrottle > 0 && !this.flags.has('ignition')) this.once('ignition');
    this.throttle = this.vehicle.effectiveThrottle(wantThrottle);
    const dir = this.thrustDirection;
    const ctl = this.controls(this.throttle, dir);

    if (!this.launched) {
      this.holdOnPad();
      const f = computeForces(EARTH, this.r, this.v, this.y[6], ctl);
      this.forces = f;
      const thrustAcc = f.thrustMag / this.y[6];
      const g = MU_EARTH / (len(this.r) ** 2);
      if (this.t >= 0 && thrustAcc > g * 1.01) {
        this.launched = true;
        this.emit('liftoff');
      } else {
        // Burn propellant on the pad during spool-up.
        if (f.mdot > 0) this.vehicle.consume(f.mdot * h);
        if (this.t > 10 && !this.launched) {
          this.failed = 'Thrust-to-weight below 1: the vehicle never left the pad.';
          this.emit('no-liftoff');
        }
        this.t += h;
        return;
      }
    }

    const m0 = this.vehicle.mass;
    this.y[6] = m0;
    this.rk.step(flightDerivative(EARTH, ctl), this.t, this.y, h);
    const burned = m0 - this.y[6];
    const used = this.vehicle.consume(burned);
    this.y[6] = this.vehicle.mass;
    this.t += h;

    const f = computeForces(EARTH, this.r, this.v, this.y[6], ctl);
    this.forces = f;
    if (f.thrustMag > 0 && used > 0) this.dvUsed += (f.thrustMag / this.y[6]) * h;
    this.monitor(f, dir, c);
  }

  private monitor(f: ForceSample, dir: Vec3, c: AscentControls): void {
    const alt = f.altitude;
    if (alt < -2) {
      this.failed = 'The vehicle impacted the ground.';
      this.emit('crash');
      return;
    }
    if (alt > 150) this.once('tower-clear');
    if (this.pitch > 1 && alt > 150) this.once('pitch-program');
    if (f.mach > 1) this.once('mach1');
    if (f.q > this.maxQ) {
      this.maxQ = f.q;
      this.maxQTime = this.t;
    }
    if (!this.flags.has('max-q') && this.maxQ > 8_000 && f.q < this.lastQ && f.q < this.maxQ * 0.97) this.once('max-q', `${(this.maxQ / 1000).toFixed(1)} kPa`);
    this.lastQ = f.q;
    this.maxG = Math.max(this.maxG, f.gLoad);
    // Angle of attack relative to the airflow.
    this.aoa = f.airspeed > 20 ? Math.acos(Math.max(-1, Math.min(1, dot(dir, norm(f.airVelocity))))) / DEG : 0;
    if (f.q * this.aoa > Q_ALPHA_LIMIT && f.q > 3_000) {
      this.failed = `Structural breakup: ${this.aoa.toFixed(0)} deg angle of attack at ${(f.q / 1000).toFixed(1)} kPa dynamic pressure (limit ${Q_ALPHA_LIMIT / 1000} kPa*deg). Fly closer to prograde in the dense atmosphere.`;
      this.emit('breakup');
      return;
    }
    if (f.gLoad > G_LIMIT) {
      this.failed = `Crew g-load reached ${f.gLoad.toFixed(1)} g (limit ${G_LIMIT} g). Throttle back on the upper stages.`;
      this.emit('g-limit');
      return;
    }
    if (alt > 100_000) this.once('space');
    if (this.apoapsisAltitude > ATMOSPHERE_TOP && alt > 60_000) this.once('go-orbit');
    // Engine state transitions.
    if (c.throttle > 0 && !this.vehicle.engine && this.vehicle.state.stages[this.vehicle.state.stage]?.prop === 0) {
      if (this.flameoutTime === -Infinity) {
        this.flameoutTime = this.t;
        this.emit('flameout', `Stage ${this.vehicle.state.stage + 1}`);
      }
    }
    if (c.throttle === 0 && this.launched && this.cutoffTime === -Infinity && this.flags.has('go-orbit')) {
      this.cutoffTime = this.t;
      this.once('meco');
    } else if (c.throttle > 0) this.cutoffTime = -Infinity;
  }

  /** Seconds since engines were cut with an orbit-capable trajectory (for phase end). */
  get coastTime(): number {
    return this.cutoffTime === -Infinity ? 0 : this.t - this.cutoffTime;
  }

  get flameoutAge(): number {
    return this.flameoutTime === -Infinity ? 0 : this.t - this.flameoutTime;
  }
}

// ---------------------------------------------------------------------------
// Autopilot

export interface AscentGuidance {
  targetAltitude: number;
  /** Pitch-over angle, deg. */
  kick: number;
  /** Altitude at which closed-loop guidance takes over from the gravity turn, m. */
  closedLoopAltitude: number;
  /** Acceleration limit (throttleable engines), g. */
  maxG: number;
}

export const DEFAULT_GUIDANCE: AscentGuidance = {
  targetAltitude: TARGET_ALTITUDE,
  kick: 7,
  closedLoopAltitude: 38_000,
  maxG: 4,
};

/**
 * Ascent autopilot: vertical rise, pitch kick, zero-lift gravity turn through
 * the dense atmosphere, then closed-loop pitch steering that drives vertical
 * speed to zero at the target altitude, cutting off at circular-orbit energy.
 * Stages automatically on flameout.
 */
/** Pitch-over angle suited to a liftoff thrust-to-weight ratio (higher TWR can turn harder). */
export function kickForTwr(twr: number): number {
  return Math.max(3, Math.min(9, 5 + 8 * (twr - 1)));
}

export function ascentAutopilot(sim: AscentSim, g: AscentGuidance = DEFAULT_GUIDANCE): AscentControls {
  const r = sim.r;
  const v = sim.v;
  const rm = len(r);
  const alt = rm - R_EARTH;
  const { up } = localFrame(r);
  const f = sim.forces;
  const air = f.airVelocity;

  // Auto-staging after flameout.
  if (sim.flameoutAge > 0.6 && !sim.vehicle.isLastStage) sim.stage();

  // Cutoff at (target) circular-orbit energy.
  const energy = dot(v, v) / 2 - MU_EARTH / rm;
  const targetR = R_EARTH + g.targetAltitude;
  if (sim.launched && energy >= -MU_EARTH / (2 * targetR) && alt > 100_000) return { throttle: 0, pitch: sim.pitch };

  let pitch = 0;
  const speed = len(air);
  if (!sim.launched || alt < 250 || speed < 60) {
    pitch = 0;
  } else if (alt < 2_000) {
    pitch = Math.min(g.kick, g.kick * ((alt - 250) / 1_500));
  } else if (alt < g.closedLoopAltitude || sim.vehicle.state.stage === 0) {
    // Open loop through the first stage (like Saturn V), closed loop on the upper stages.
    // Gravity turn: point along the airflow (zero angle of attack), never steeper than the kick.
    const pro = Math.acos(Math.max(-1, Math.min(1, dot(norm(air), up)))) / DEG;
    pitch = Math.max(pro, g.kick);
  } else {
    pitch = linearTangentPitch(sim, g.targetAltitude) ?? pitch;
    // Stay within half the structural q-alpha limit while the air is still thick.
    if (f.q > 500 && speed > 50) {
      const pro = Math.acos(Math.max(-1, Math.min(1, dot(norm(air), up)))) / DEG;
      const maxAoa = (0.5 * Q_ALPHA_LIMIT) / f.q;
      pitch = Math.max(pro - maxAoa, Math.min(pro + maxAoa, pitch));
    }
  }

  // Throttle: full, but limit acceleration where the engine can throttle.
  let throttle = 1;
  const e = sim.vehicle.engine;
  if (e && e.minThrottle < 1) {
    const full = e.thrustVac / sim.y[6];
    const lim = (g.maxG * G0) / full;
    throttle = Math.max(e.minThrottle, Math.min(1, lim));
  }
  return { throttle, pitch };
}

/** Fly a complete autopilot ascent (for tests and presets). Returns the sim at cutoff. */
export function flyAscent(design: VehicleDesign, eph: Ephemeris, maxTime = 1200): AscentSim {
  const sim = new AscentSim(design, eph);
  const g = { ...DEFAULT_GUIDANCE, kick: kickForTwr(sim.vehicle.analysis.liftoffTwr) };
  while (sim.t < maxTime && !sim.failed) {
    const c = ascentAutopilot(sim, g);
    sim.step(c);
    if (sim.coastTime > 2) break;
  }
  return sim;
}

// ---------------------------------------------------------------------------
// Linear-tangent closed-loop guidance (Saturn IGM-style)

interface LtSolution {
  A: number;
  B: number;
  t: number;
}

const ltCache = new WeakMap<AscentSim, LtSolution>();

/**
 * Predict the rest of the ascent under the steering law tan(theta) = A - B*t
 * (theta = thrust angle above the local horizontal), burning the remaining
 * stages at full thrust in a planar point-mass model. Stops when horizontal
 * speed reaches circular speed. Returns final altitude and climb rate.
 */
export function predictLinearTangent(sim: AscentSim, A: number, B: number): { h: number; vr: number; ok: boolean } {
  const v = sim.vehicle;
  const st = v.analysis.stages;
  const up = norm(sim.r);
  let h = sim.altitude;
  let vr = dot(sim.v, up);
  let vh = len(sub(sim.v, scale(up, vr)));
  let stage = v.state.stage;
  let prop = v.state.stages[stage]?.prop ?? 0;
  let m = v.mass;
  let t = 0;
  const dt = 2;
  for (let k = 0; k < 2000; k++) {
    while (stage < st.length && (!st[stage].engine || prop <= 0)) {
      // Drop the spent stage and move to the next one.
      m -= st[stage].dryMass + prop;
      stage++;
      prop = v.state.stages[stage]?.prop ?? 0;
      if (stage >= st.length) return { h, vr, ok: false };
    }
    const e = st[stage].engine!;
    const ve = e.ispVac * G0;
    const mdot = e.thrustVac / ve;
    const a = e.thrustVac / m;
    const rr = R_EARTH + h;
    const vc = Math.sqrt(MU_EARTH / rr);
    const th = Math.atan(A - B * t);
    const gEff = MU_EARTH / (rr * rr) - (vh * vh) / rr;
    const ah = a * Math.cos(th);
    const step = Math.min(dt, prop / mdot);
    if (vh + ah * step >= vc) {
      const f = (vc - vh) / Math.max(ah * step, 1e-9);
      const s2 = step * f;
      vr += (a * Math.sin(th) - gEff) * s2;
      h += vr * s2;
      return { h, vr, ok: true };
    }
    vr += (a * Math.sin(th) - gEff) * step;
    vh += ah * step;
    h += vr * step;
    m -= mdot * step;
    prop -= mdot * step;
    t += step;
    if (h < -200_000) return { h, vr, ok: false };
  }
  return { h, vr, ok: false };
}

/** Solve (A, B) by Newton's method for zero climb rate at the target altitude. Returns commanded pitch from vertical (deg). */
function linearTangentPitch(sim: AscentSim, targetAltitude: number): number | null {
  let sol = ltCache.get(sim);
  if (sol) {
    // Shift the previous solution to the current time.
    const dt = sim.t - sol.t;
    sol = { A: sol.A - sol.B * dt, B: sol.B, t: sim.t };
    if (dt < 1.0) {
      ltCache.set(sim, { ...sol, t: sim.t });
      return 90 - Math.atan(sol.A) / DEG;
    }
  } else {
    const up = norm(sim.r);
    const gamma = Math.asin(Math.max(-1, Math.min(1, dot(norm(sim.v), up))));
    sol = { A: Math.tan(gamma), B: Math.tan(gamma) / 400, t: sim.t };
  }
  let { A, B } = sol;
  const resid = (a: number, b: number) => {
    const p = predictLinearTangent(sim, a, b);
    return [(p.h - targetAltitude) / 1000, p.vr / 10, p.ok ? 1 : 0] as const;
  };
  for (let it = 0; it < 6; it++) {
    const [f1, f2] = resid(A, B);
    if (Math.abs(f1) < 0.2 && Math.abs(f2) < 0.2) break;
    const dA = 1e-3;
    const dB = 1e-6;
    const [a1, a2] = resid(A + dA, B);
    const [b1, b2] = resid(A, B + dB);
    const j11 = (a1 - f1) / dA, j12 = (b1 - f1) / dB;
    const j21 = (a2 - f2) / dA, j22 = (b2 - f2) / dB;
    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    let sA = (j22 * f1 - j12 * f2) / det;
    let sB = (-j21 * f1 + j11 * f2) / det;
    // Damp large steps.
    const lim = 0.3;
    const scaleStep = Math.max(1, Math.abs(sA) / lim);
    sA /= scaleStep;
    sB /= scaleStep;
    A -= sA;
    B -= sB;
    A = Math.max(-0.6, Math.min(4, A));
  }
  ltCache.set(sim, { A, B, t: sim.t });
  // Thrust angle above horizon right now, limited to a sensible range.
  const theta = Math.max(-12, Math.min(65, Math.atan(A) / DEG));
  return 90 - theta;
}
