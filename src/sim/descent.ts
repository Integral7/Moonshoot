// Powered descent and landing on procedural lunar terrain. Moon-centered
// inertial frame, fixed-step RK4, terrain-relative altitude, touchdown
// evaluation against the landing-leg limits.

import { MOON, moonRotation, type Ephemeris } from '../physics/bodies';
import { DEG, G0, MU_MOON, R_MOON } from '../physics/constants';
import { flightDerivative, STATE_SIZE, type FlightControls } from '../physics/dynamics';
import { RK4 } from '../physics/integrator';
import { add, cross, dot, len, norm, rotateAxis, rotateZ, scale, sub, vec, type Vec3 } from '../physics/vec';
import { LunarTerrain } from './terrain';
import { Vehicle, type VehicleState } from './vehicle';

export const DESCENT_STEP = 0.02;
/** Max attitude slew rate, rad/s (RCS). */
export const SLEW_RATE = 20 * DEG;

export interface DescentControls {
  throttle: number;
  /** Desired thrust direction, inertial unit vector. */
  dir: Vec3;
}

export interface TouchdownReport {
  vertical: number;
  horizontal: number;
  tilt: number;
  slope: number;
  boulder: number;
  outcome: 'landed' | 'hard' | 'tipped' | 'crashed';
  reasons: string[];
}

export type DescentEventKind = 'low-fuel' | 'fuel-60' | 'fuel-30' | 'out-of-fuel' | 'dust' | 'contact' | 'touchdown' | 'crash' | 'altitude';

export interface DescentEvent {
  t: number;
  kind: DescentEventKind;
  detail?: string;
}

export class DescentSim {
  readonly vehicle: Vehicle;
  readonly terrain: LunarTerrain;
  readonly y = new Float64Array(STATE_SIZE);
  t: number;
  /** Actual thrust direction (rate-limited), inertial unit. */
  dir: Vec3;
  throttle = 0;
  dvUsed = 0;
  touchdown: TouchdownReport | null = null;
  events: DescentEvent[] = [];
  private rk = new RK4(STATE_SIZE);
  private flags = new Set<string>();
  /** Next altitude mark for "N meters, down at X" callouts. */
  private lastCall = Infinity;
  /** Landing point chosen by hazard avoidance (map coordinates), once low enough. */
  site: { x: number; y: number; slope: number } | null = null;

  constructor(r: Vec3, v: Vec3, vehicle: VehicleState, readonly eph: Ephemeris, t: number, terrainSeed = 1969) {
    this.vehicle = new Vehicle(vehicle);
    this.t = t;
    this.y.set([r.x, r.y, r.z, v.x, v.y, v.z, this.vehicle.mass]);
    // Terrain map centered on the point below the vehicle at the start of the descent.
    this.terrain = new LunarTerrain(this.toFixed(r), terrainSeed);
    this.dir = norm(scale(v, -1));
  }

  get r(): Vec3 {
    return vec(this.y[0], this.y[1], this.y[2]);
  }

  get v(): Vec3 {
    return vec(this.y[3], this.y[4], this.y[5]);
  }

  get rotation(): number {
    return moonRotation(this.t, this.eph);
  }

  /** Inertial (Moon-centered) vector -> Moon-fixed. */
  toFixed(v: Vec3): Vec3 {
    return rotateZ(v, -this.rotation);
  }

  fromFixed(v: Vec3): Vec3 {
    return rotateZ(v, this.rotation);
  }

  /** Local map coordinates of the point below the vehicle. */
  get mapPos(): { x: number; y: number } {
    return this.terrain.toLocal(this.toFixed(this.r));
  }

  get terrainHeight(): number {
    const p = this.mapPos;
    return this.terrain.height(p.x, p.y);
  }

  /** Altitude above the terrain directly below (radar altitude), m. */
  get altitude(): number {
    return len(this.r) - R_MOON - this.terrainHeight;
  }

  get up(): Vec3 {
    return norm(this.r);
  }

  /** Velocity relative to the rotating surface. */
  get surfaceVelocity(): Vec3 {
    const w = MOON.rotationRate;
    const r = this.r;
    return sub(this.v, vec(-w * r.y, w * r.x, 0));
  }

  get verticalSpeed(): number {
    return dot(this.surfaceVelocity, this.up);
  }

  get horizontalVelocity(): Vec3 {
    const vs = this.surfaceVelocity;
    return sub(vs, scale(this.up, dot(vs, this.up)));
  }

  get horizontalSpeed(): number {
    return len(this.horizontalVelocity);
  }

  get maxAccel(): number {
    const e = this.vehicle.engine;
    return e ? e.thrustVac / this.vehicle.mass : 0;
  }

  get gravity(): number {
    return MU_MOON / (len(this.r) ** 2);
  }

  /** Seconds of propellant left at the current throttle (or hover throttle). */
  get fuelTime(): number {
    const e = this.vehicle.stageInfo?.engine;
    if (!e) return 0;
    const thr = Math.max(this.throttle, (this.gravity * this.vehicle.mass) / e.thrustVac, e.minThrottle);
    const mdot = (thr * e.thrustVac) / (e.ispVac * G0);
    return this.vehicle.prop / mdot;
  }

  /** Tilt of the vehicle axis from local vertical (rad). */
  get tilt(): number {
    return Math.acos(Math.max(-1, Math.min(1, dot(this.dir, this.up))));
  }

  get landed(): boolean {
    return !!this.touchdown;
  }

  private emitOnce(kind: DescentEventKind, detail?: string): void {
    if (this.flags.has(kind)) return;
    this.flags.add(kind);
    this.events.push({ t: this.t, kind, detail });
  }

  step(c: DescentControls, h = DESCENT_STEP): void {
    if (this.touchdown) return;
    // Slew the vehicle toward the commanded direction.
    const want = norm(c.dir);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(this.dir, want))));
    if (ang > 1e-6) {
      const axis = cross(this.dir, want);
      const al = len(axis);
      const turn = Math.min(ang, SLEW_RATE * h);
      this.dir = al > 1e-9 ? norm(rotateAxis(this.dir, scale(axis, 1 / al), turn)) : want;
    }
    this.throttle = this.vehicle.effectiveThrottle(c.throttle);
    const e = this.vehicle.engine;
    const ctl: FlightControls = {
      propulsion: e && this.throttle > 0 ? { throttle: this.throttle, thrustVac: e.thrustVac, ispVac: e.ispVac, ispSl: e.ispSl, dir: this.dir } : null,
      aero: null,
    };
    const m0 = this.vehicle.mass;
    this.y[6] = m0;
    this.rk.step(flightDerivative(MOON, ctl), this.t, this.y, h);
    const burned = m0 - this.y[6];
    this.vehicle.consume(burned);
    if (e && burned > 0) this.dvUsed += e.ispVac * G0 * Math.log(m0 / (m0 - burned));
    this.y[6] = this.vehicle.mass;
    this.t += h;
    this.monitor(c);
  }

  private monitor(c: DescentControls): void {
    const alt = this.altitude;
    const prop = this.vehicle.prop;
    const info = this.vehicle.stageInfo;
    if (info && info.propMass > 0) {
      const ft = this.fuelTime;
      if (prop / info.propMass < 0.1) this.emitOnce('low-fuel');
      if (ft < 60 && alt < 3000) this.emitOnce('fuel-60');
      if (ft < 30 && alt < 3000) this.emitOnce('fuel-30');
    }
    if (c.throttle > 0 && !this.vehicle.engine) this.emitOnce('out-of-fuel');
    if (alt < 30) this.emitOnce('dust');
    // Altitude/descent-rate callouts every so often below 1 km.
    if (alt < 1000) {
      const step = alt > 300 ? 100 : alt > 60 ? 20 : 10;
      const mark = Math.ceil(alt / step) * step;
      if (mark < this.lastCall) {
        this.lastCall = mark;
        this.events.push({ t: this.t, kind: 'altitude', detail: `${mark} m, down at ${Math.max(0, -this.verticalSpeed).toFixed(1)}, forward ${this.horizontalSpeed.toFixed(1)}` });
      }
    }
    if (alt < 1.5) this.emitOnce('contact');
    if (alt <= 0) this.evaluateTouchdown();
  }

  /** Evaluate the touchdown against the leg limits and hazards. */
  evaluateTouchdown(): TouchdownReport {
    const legs = this.vehicle.legs ?? { maxVertical: 0, maxHorizontal: 0, maxTilt: 0 };
    const vertical = Math.max(0, -this.verticalSpeed);
    const horizontal = this.horizontalSpeed;
    const p = this.mapPos;
    const slope = this.terrain.slope(p.x, p.y);
    // Vehicle tilt relative to the local terrain normal.
    const nl = this.terrain.normalLocal(p.x, p.y);
    const t = this.terrain;
    const nFixed = norm(add(add(scale(t.east, nl.x), scale(t.north, nl.y)), scale(norm(this.toFixed(this.r)), nl.z)));
    const n = this.fromFixed(nFixed);
    const tilt = Math.acos(Math.max(-1, Math.min(1, dot(this.dir, n))));
    const boulders = t.bouldersNear(p.x, p.y, 4.5);
    const boulder = boulders.reduce((m, b) => Math.max(m, b.radius), 0);
    const reasons: string[] = [];
    let outcome = 'landed' as TouchdownReport['outcome'];
    const worse = (o: TouchdownReport['outcome']) => {
      const order = ['landed', 'hard', 'tipped', 'crashed'];
      if (order.indexOf(o) > order.indexOf(outcome)) outcome = o;
    };
    if (!this.vehicle.hasLegs) {
      reasons.push('No landing legs: the stage came down on its engine bell.');
      worse('crashed');
    }
    if (vertical > legs.maxVertical * 2) {
      reasons.push(`Vertical speed ${vertical.toFixed(1)} m/s far exceeds the ${legs.maxVertical} m/s leg limit.`);
      worse('crashed');
    } else if (vertical > legs.maxVertical) {
      reasons.push(`Vertical speed ${vertical.toFixed(1)} m/s exceeds the ${legs.maxVertical} m/s leg limit: legs crushed.`);
      worse('hard');
    }
    if (horizontal > legs.maxHorizontal * 3) {
      reasons.push(`Horizontal speed ${horizontal.toFixed(1)} m/s: the lander tumbled.`);
      worse('crashed');
    } else if (horizontal > legs.maxHorizontal) {
      reasons.push(`Horizontal speed ${horizontal.toFixed(1)} m/s exceeds the ${legs.maxHorizontal} m/s limit: a leg caught and the lander tipped.`);
      worse('tipped');
    }
    if (tilt > legs.maxTilt) {
      reasons.push(`Touched down ${(tilt / DEG).toFixed(0)} deg off the surface normal (limit ${(legs.maxTilt / DEG).toFixed(0)}) on a ${(slope / DEG).toFixed(0)} deg slope.`);
      worse('tipped');
    }
    if (boulder > 1.2) {
      reasons.push(`Landed on a ${(boulder * 2).toFixed(1)} m boulder.`);
      worse(boulder > 2 ? 'crashed' : 'tipped');
    }
    const report: TouchdownReport = { vertical, horizontal, tilt, slope, boulder, outcome, reasons };
    this.touchdown = report;
    // Settle on the surface.
    const surfR = R_MOON + this.terrainHeight;
    const u = this.up;
    const rr = scale(u, surfR);
    const w = MOON.rotationRate;
    this.y.set([rr.x, rr.y, rr.z, -w * rr.y, w * rr.x, 0, this.vehicle.mass]);
    this.throttle = 0;
    this.events.push({ t: this.t, kind: outcome === 'crashed' ? 'crash' : 'touchdown', detail: outcome });
    return report;
  }
}

/**
 * Find the safest spot near (x, y): low slope, no boulders over 0.6 m within the
 * leg footprint, close to the current track. Returns null if nothing is acceptable.
 */
export function findSafeSite(terrain: LunarTerrain, x: number, y: number, radius = 220, spacing = 9, maxSlope = 7 * DEG): { x: number; y: number; slope: number } | null {
  let best: { x: number; y: number; slope: number } | null = null;
  let bestScore = Infinity;
  for (let dx = -radius; dx <= radius; dx += spacing) {
    for (let dy = -radius; dy <= radius; dy += spacing) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const px = x + dx;
      const py = y + dy;
      const s = Math.max(terrain.slope(px, py, 2), terrain.slope(px, py, 5));
      if (s > maxSlope) continue;
      if (terrain.bouldersNear(px, py, 6).some((b) => b.radius > 0.6)) continue;
      const score = s / DEG + d * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = { x: px, y: py, slope: s };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Landing autopilot

/**
 * Landing guidance with vertical priority: first allocate thrust to hold the
 * descent-rate target (which is paced by how long horizontal braking will take),
 * then spend what is left braking horizontal speed toward ~0.06 x altitude.
 * Near the ground it settles into a vertical 1.2 m/s descent.
 */
export function descentAutopilot(sim: DescentSim): DescentControls {
  const up = sim.up;
  const alt = Math.max(0, sim.altitude);
  const vz = sim.verticalSpeed;
  const vh = sim.horizontalVelocity;
  const vhMag = len(vh);
  const fwd = vhMag > 1e-3 ? scale(vh, 1 / vhMag) : vec(0, 0, 0);
  const amax = sim.maxAccel || 1;
  const gEff = sim.gravity - (vhMag * vhMag) / len(sim.r);
  const tBrake = vhMag / Math.max(0.5, 0.8 * amax);
  const vzTarget = -Math.max(1.2, Math.min(60, alt / (tBrake + 25)));
  let vhTargetVec = scale(fwd, Math.min(vhMag, 0.06 * alt));
  // Hazard avoidance: below 400 m pick a safe spot near the predicted landing point and steer to it.
  if (alt < 400) {
    const p = sim.mapPos;
    if (!sim.site) {
      const tStop = Math.max(5, alt / Math.max(2, -vz));
      const ahead = sim.terrain.toLocal(sim.toFixed(add(sim.r, scale(vh, tStop * 0.5))));
      sim.site = findSafeSite(sim.terrain, ahead.x, ahead.y) ?? findSafeSite(sim.terrain, p.x, p.y, 400, 12, 10 * DEG);
    }
    if (sim.site) {
      const t = sim.terrain;
      // Map-plane offset to the site, expressed as an inertial horizontal vector.
      const dx = sim.site.x - p.x;
      const dy = sim.site.y - p.y;
      const offFixed = add(scale(t.east, dx), scale(t.north, dy));
      const off = sim.fromFixed(offFixed);
      const offH = sub(off, scale(up, dot(off, up)));
      const dist = len(offH);
      const vmax = Math.min(0.06 * alt + 1.5, 25);
      const speed = Math.min(vmax, 0.12 * dist);
      vhTargetVec = dist > 0.3 ? scale(offH, speed / dist) : vec(0, 0, 0);
    }
  }
  // Vertical channel first.
  let aV = (vzTarget - vz) * 0.35 + gEff;
  aV = Math.max(0, Math.min(0.98 * amax, aV));
  // Horizontal channel gets the remaining thrust.
  const kh = alt > 300 ? 0.15 : 0.5;
  let aH = scale(sub(vhTargetVec, vh), kh);
  const avail = Math.sqrt(Math.max(0, amax * amax - aV * aV));
  const aHm = len(aH);
  if (aHm > avail) aH = scale(aH, avail / aHm);
  const a = add(scale(up, aV), aH);
  const throttle = Math.min(1, len(a) / amax);
  let dir = len(a) > 1e-6 ? norm(a) : up;
  if (alt < 8) dir = norm(add(scale(up, 3), dir));
  return { throttle, dir };
}

