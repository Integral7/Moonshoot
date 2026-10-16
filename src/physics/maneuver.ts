// Impulsive maneuvers: local orbital frame, Hohmann transfers, injection and
// insertion delta-v estimates.

import { orbitalPeriod } from './kepler';
import { add, cross, dot, len, norm, scale, sub, type Vec3 } from './vec';

/** Maneuver delta-v in the local orbital frame (m/s). */
export interface NodeDeltaV {
  prograde: number;
  normal: number;
  radial: number;
}

export interface LocalFrame {
  prograde: Vec3;
  normal: Vec3;
  /** Radial-out: in the orbit plane, perpendicular to velocity, away from the body. */
  radial: Vec3;
}

export function localFrame(r: Vec3, v: Vec3): LocalFrame {
  const prograde = norm(v);
  const normal = norm(cross(r, v));
  const radial = norm(cross(prograde, normal));
  return { prograde, normal, radial };
}

/** Convert a local-frame burn into an inertial delta-v vector. */
export function nodeToInertial(r: Vec3, v: Vec3, dv: NodeDeltaV): Vec3 {
  const f = localFrame(r, v);
  return add(add(scale(f.prograde, dv.prograde), scale(f.normal, dv.normal)), scale(f.radial, dv.radial));
}

/** Convert an inertial delta-v vector into local-frame components. */
export function inertialToNode(r: Vec3, v: Vec3, dv: Vec3): NodeDeltaV {
  const f = localFrame(r, v);
  return { prograde: dot(dv, f.prograde), normal: dot(dv, f.normal), radial: dot(dv, f.radial) };
}

export const nodeMagnitude = (dv: NodeDeltaV): number => Math.hypot(dv.prograde, dv.normal, dv.radial);

export interface HohmannResult {
  dv1: number;
  dv2: number;
  total: number;
  /** Transfer time (half the transfer-orbit period), s. */
  tof: number;
  /** Transfer orbit semi-major axis, m. */
  a: number;
}

/** Coplanar Hohmann transfer between circular orbits of radius r1 and r2. */
export function hohmann(mu: number, r1: number, r2: number): HohmannResult {
  const a = (r1 + r2) / 2;
  const v1 = Math.sqrt(mu / r1);
  const v2 = Math.sqrt(mu / r2);
  const vp = Math.sqrt(mu * (2 / r1 - 1 / a));
  const va = Math.sqrt(mu * (2 / r2 - 1 / a));
  const dv1 = Math.abs(vp - v1);
  const dv2 = Math.abs(v2 - va);
  return { dv1, dv2, total: dv1 + dv2, tof: orbitalPeriod(mu, a) / 2, a };
}

/**
 * Trans-lunar injection delta-v (m/s) from a circular parking orbit of radius
 * rPark to a transfer ellipse with apoapsis rApo (the classic patched-conic
 * estimate; ~3.1 km/s from 185 km LEO to lunar distance).
 */
export function injectionDeltaV(mu: number, rPark: number, rApo: number): number {
  return hohmann(mu, rPark, rApo).dv1;
}

/**
 * Phase angle (rad) by which the target must lead the spacecraft at departure
 * for a Hohmann transfer to arrive at the target: pi - n_target * tof.
 */
export function hohmannPhaseAngle(mu: number, r1: number, r2: number, targetMeanMotion?: number): number {
  const { tof } = hohmann(mu, r1, r2);
  const n2 = targetMeanMotion ?? Math.sqrt(mu / (r2 * r2 * r2));
  return Math.PI - n2 * tof;
}

/**
 * Delta-v to capture from a hyperbolic approach (excess speed vInf) into an
 * orbit with periapsis rp and apoapsis ra (ra = rp for circular).
 */
export function captureDeltaV(mu: number, vInf: number, rp: number, ra = rp): number {
  const vHyp = Math.sqrt(vInf * vInf + (2 * mu) / rp);
  const a = (rp + ra) / 2;
  const vOrbit = Math.sqrt(mu * (2 / rp - 1 / a));
  return vHyp - vOrbit;
}

/** Hyperbolic excess speed for a given specific energy (J/kg); NaN if bound. */
export function excessSpeed(energy: number): number {
  return energy > 0 ? Math.sqrt(2 * energy) : NaN;
}

/** Inertial delta-v that would make the current orbit circular at the current radius. */
export function circularizeDeltaV(mu: number, r: Vec3, v: Vec3): Vec3 {
  const rm = len(r);
  const h = cross(r, v);
  const horiz = norm(cross(h, r)); // horizontal direction of motion
  const vc = scale(horiz, Math.sqrt(mu / rm));
  return sub(vc, v);
}
