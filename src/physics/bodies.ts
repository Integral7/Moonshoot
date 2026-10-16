// Celestial bodies and the simplified ephemeris used by the game.
//
// Frame: Earth-centered inertial (ECI), +Z along Earth's spin axis. The Moon is
// modeled on a circular orbit in the XY (equatorial) plane, and is tidally
// locked. These are the documented simplifications of the game model.

import {
  EARTH_ROTATION_RATE,
  MOON_MEAN_MOTION,
  MOON_ORBIT_RADIUS,
  MOON_SOI,
  MU_EARTH,
  MU_MOON,
  R_EARTH,
  R_MOON,
  ATMOSPHERE_TOP,
  EARTH_SOI,
} from './constants';
import { vec, type Vec3 } from './vec';

export type BodyId = 'earth' | 'moon';

export interface Body {
  id: BodyId;
  name: string;
  mu: number;
  radius: number;
  /** Sidereal rotation rate about +Z, rad/s. */
  rotationRate: number;
  /** Sphere of influence radius, m. */
  soi: number;
  /** Top of the sensible atmosphere, m altitude (0 if airless). */
  atmosphereTop: number;
}

export const EARTH: Body = {
  id: 'earth',
  name: 'Earth',
  mu: MU_EARTH,
  radius: R_EARTH,
  rotationRate: EARTH_ROTATION_RATE,
  soi: EARTH_SOI,
  atmosphereTop: ATMOSPHERE_TOP,
};

export const MOON: Body = {
  id: 'moon',
  name: 'Moon',
  mu: MU_MOON,
  radius: R_MOON,
  rotationRate: MOON_MEAN_MOTION, // tidally locked
  soi: MOON_SOI,
  atmosphereTop: 0,
};

export const BODIES: Record<BodyId, Body> = { earth: EARTH, moon: MOON };

/** Initial angles that place the Moon and the Earth's prime meridian at mission t = 0. */
export interface Ephemeris {
  /** Moon's longitude in ECI at t = 0, rad. */
  moonAngle0: number;
  /** Earth's rotation angle (prime meridian vs +X) at t = 0, rad. */
  earthAngle0: number;
}

export const DEFAULT_EPHEMERIS: Ephemeris = { moonAngle0: 0, earthAngle0: 0 };

export function moonAngle(t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): number {
  return eph.moonAngle0 + MOON_MEAN_MOTION * t;
}

/** Moon position in ECI at mission time t (s). */
export function moonPosition(t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): Vec3 {
  const th = moonAngle(t, eph);
  return vec(MOON_ORBIT_RADIUS * Math.cos(th), MOON_ORBIT_RADIUS * Math.sin(th), 0);
}

/** Moon velocity in ECI at mission time t (s). */
export function moonVelocity(t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): Vec3 {
  const th = moonAngle(t, eph);
  const s = MOON_MEAN_MOTION * MOON_ORBIT_RADIUS;
  return vec(-s * Math.sin(th), s * Math.cos(th), 0);
}

/** Earth rotation angle at time t (rad). */
export function earthRotation(t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): number {
  return eph.earthAngle0 + EARTH_ROTATION_RATE * t;
}

/**
 * Moon rotation angle at time t. Tidally locked: the Moon's body-fixed -X axis
 * (selenographic 0,0, the near side) always points at Earth.
 */
export function moonRotation(t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): number {
  return moonAngle(t, eph) + Math.PI;
}

/** Body rotation angle at time t. */
export function bodyRotation(body: BodyId, t: number, eph: Ephemeris = DEFAULT_EPHEMERIS): number {
  return body === 'earth' ? earthRotation(t, eph) : moonRotation(t, eph);
}

/** Inertial (body-centered) position of a surface point at lat/lon (rad), altitude h. */
export function surfacePosition(body: Body, lat: number, lon: number, h: number, rotation: number): Vec3 {
  const r = body.radius + h;
  const L = lon + rotation;
  return vec(r * Math.cos(lat) * Math.cos(L), r * Math.cos(lat) * Math.sin(L), r * Math.sin(lat));
}

/** Latitude/longitude (rad) of a body-centered inertial position, accounting for body rotation. */
export function toLatLon(r: Vec3, rotation: number): { lat: number; lon: number } {
  const rm = Math.hypot(r.x, r.y, r.z);
  const lat = Math.asin(r.z / rm);
  let lon = Math.atan2(r.y, r.x) - rotation;
  lon = ((((lon + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return { lat, lon };
}

/** Surface velocity due to body rotation at inertial position r: omega x r. */
export function rotationVelocity(body: Body, r: Vec3): Vec3 {
  const w = body.rotationRate;
  return vec(-w * r.y, w * r.x, 0);
}
