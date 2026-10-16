// Equations of motion for a powered/aerodynamic vehicle about a single central
// body (patched-conic: only the body whose SOI we are in attracts us).
// State vector y = [rx, ry, rz, vx, vy, vz, m] in the body-centered inertial frame.

import { atmosphere } from './atmosphere';
import { dynamicPressure, machDragFactor, suttonGraves } from './aero';
import type { Body } from './bodies';
import { rotationVelocity } from './bodies';
import { G0 } from './constants';
import type { Derivative } from './integrator';
import { ispAtPressure } from './rocket';
import { cross, len, norm, scale, sub, vec, type Vec3 } from './vec';

export const STATE_SIZE = 7;

export interface PropulsionInput {
  /** 0..1 */
  throttle: number;
  /** Total vacuum thrust at full throttle, N. */
  thrustVac: number;
  ispVac: number;
  ispSl: number;
  /** Unit thrust direction in the inertial frame. */
  dir: Vec3;
}

export interface AeroInput {
  /** Drag area Cd*A at low subsonic speed, m^2. */
  cdA: number;
  /** Lift-to-drag ratio (capsules ~0.3 trimmed). */
  liftToDrag: number;
  /**
   * Unit lift direction in the inertial frame, perpendicular to the airflow.
   * null for zero lift.
   */
  liftDir: Vec3 | null;
  /** Nose radius for stagnation heating, m. */
  noseRadius: number;
  /** Apply the transonic drag-rise curve. */
  machEffects: boolean;
}

export interface FlightControls {
  propulsion: PropulsionInput | null;
  aero: AeroInput | null;
}

export interface ForceSample {
  altitude: number;
  gravity: Vec3;
  thrust: Vec3;
  drag: Vec3;
  lift: Vec3;
  /** Thrust magnitude actually produced, N. */
  thrustMag: number;
  /** Mass flow, kg/s (positive = consumed). */
  mdot: number;
  /** Velocity relative to the (co-rotating) atmosphere. */
  airVelocity: Vec3;
  airspeed: number;
  rho: number;
  ambientPressure: number;
  q: number;
  mach: number;
  /** Stagnation heat flux, W/m^2. */
  heatFlux: number;
  /** Non-gravitational acceleration magnitude in g0 (what the crew feels). */
  gLoad: number;
}

/** Evaluate all forces on the vehicle. */
export function computeForces(body: Body, r: Vec3, v: Vec3, m: number, c: FlightControls): ForceSample {
  const rm = len(r);
  const altitude = rm - body.radius;
  const gravity = scale(r, -body.mu / (rm * rm * rm));

  const hasAir = body.atmosphereTop > 0 && altitude < body.atmosphereTop;
  const atm = hasAir ? atmosphere(altitude) : null;
  const rho = atm ? atm.rho : 0;
  const ambientPressure = atm ? atm.P : 0;

  const airVelocity = hasAir ? sub(v, rotationVelocity(body, r)) : v;
  const airspeed = len(airVelocity);
  const mach = atm ? airspeed / atm.a : 0;
  const q = dynamicPressure(rho, airspeed);

  let thrust = vec();
  let thrustMag = 0;
  let mdot = 0;
  const p = c.propulsion;
  if (p && p.throttle > 0 && p.thrustVac > 0) {
    mdot = (p.throttle * p.thrustVac) / (p.ispVac * G0);
    const isp = ispAtPressure(p.ispVac, p.ispSl, ambientPressure);
    thrustMag = mdot * isp * G0;
    thrust = scale(p.dir, thrustMag / m);
  }

  let drag = vec();
  let lift = vec();
  let heatFlux = 0;
  const a = c.aero;
  if (a && q > 0 && airspeed > 1e-6) {
    const cdA = a.cdA * (a.machEffects ? machDragFactor(mach) : 1);
    const D = q * cdA;
    drag = scale(airVelocity, -D / (airspeed * m));
    if (a.liftDir && a.liftToDrag !== 0) {
      lift = scale(a.liftDir, (D * a.liftToDrag) / m);
    }
    heatFlux = suttonGraves(rho, airspeed, a.noseRadius);
  }

  const ng = vec(thrust.x + drag.x + lift.x, thrust.y + drag.y + lift.y, thrust.z + drag.z + lift.z);
  return {
    altitude,
    gravity,
    thrust,
    drag,
    lift,
    thrustMag,
    mdot,
    airVelocity,
    airspeed,
    rho,
    ambientPressure,
    q,
    mach,
    heatFlux,
    gLoad: len(ng) / G0,
  };
}

/** Build a derivative function for RK4 with controls held constant over the step. */
export function flightDerivative(body: Body, controls: FlightControls): Derivative {
  return (_t, y, out) => {
    const r = vec(y[0], y[1], y[2]);
    const v = vec(y[3], y[4], y[5]);
    const f = computeForces(body, r, v, y[6], controls);
    out[0] = y[3];
    out[1] = y[4];
    out[2] = y[5];
    out[3] = f.gravity.x + f.thrust.x + f.drag.x + f.lift.x;
    out[4] = f.gravity.y + f.thrust.y + f.drag.y + f.lift.y;
    out[5] = f.gravity.z + f.thrust.z + f.drag.z + f.lift.z;
    out[6] = -f.mdot;
  };
}

/** Point-mass two-body derivative for y = [r, v] (6 components). */
export function twoBodyDerivative(mu: number): Derivative {
  return (_t, y, out) => {
    const r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
    const k = -mu / (r2 * Math.sqrt(r2));
    out[0] = y[3];
    out[1] = y[4];
    out[2] = y[5];
    out[3] = k * y[0];
    out[4] = k * y[1];
    out[5] = k * y[2];
  };
}

/**
 * Lift direction for a bank angle (rad): bank 0 = lift "up" (away from the
 * body, perpendicular to airflow), positive bank rolls lift toward the orbit
 * normal (left of track for a prograde orbit).
 */
export function bankedLiftDirection(r: Vec3, airVelocity: Vec3, bank: number): Vec3 | null {
  const vhat = norm(airVelocity);
  const side = norm(cross(vhat, r)); // horizontal, perpendicular to velocity
  if (len(side) < 0.5) return null;
  const up = norm(cross(side, vhat)); // perpendicular to v, toward +r
  return norm(vec(
    up.x * Math.cos(bank) - side.x * Math.sin(bank),
    up.y * Math.cos(bank) - side.y * Math.sin(bank),
    up.z * Math.cos(bank) - side.z * Math.sin(bank),
  ));
}
