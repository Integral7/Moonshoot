import { MOON, type Ephemeris } from '../physics/bodies';
import { MU_EARTH, MOON_ORBIT_RADIUS, R_EARTH } from '../physics/constants';
import { visViva } from '../physics/kepler';
import { injectionDeltaV } from '../physics/maneuver';
import type { OrbitState } from '../physics/patched';
import { planTli } from '../physics/planner';
import type { Mission } from '../sim/mission';
import { OrbitalFlight, lunarApproach, refineNodeFinite } from '../sim/orbital';
import { orbitPreset } from '../sim/presets';
import { buildResult, linearScore, toleranceScore, type Metric } from '../sim/scoring';
import { formatDistance, formatDuration } from '../sim/time';
import type { VehicleState } from '../sim/vehicle';
import type { TelemetryRow } from '../ui/Hud';
import type { Planner } from '../ui/ManeuverPanel';
import { OrbitalScreen } from './OrbitalScreen';

const LUNAR_TARGET = 110e3;

/** Phase 3: Earth parking orbit, circularization, and trans-lunar injection. */
export class OrbitScreen extends OrbitalScreen {
  readonly id = 'orbit';
  private idealDv = 0;
  private confirmAt = Infinity;
  private reportedEncounter = false;
  private wasBurning = false;

  constructor(mission: Mission) {
    super(mission);
  }

  protected initialFlight(): OrbitalFlight {
    const carried = this.mission.carry.flight as { orbit: OrbitState; eph: Ephemeris } | undefined;
    const vehicle = this.mission.carry.vehicle as VehicleState | undefined;
    if (carried && vehicle) return new OrbitalFlight(carried.orbit, vehicle, carried.eph);
    const p = orbitPreset();
    return new OrbitalFlight(p.orbit, p.vehicle, p.eph);
  }

  protected override phaseSetup(): void {
    const el = this.flight.elements();
    // Ideal: circularize at apoapsis (impulsive), then an impulsive TLI from that orbit.
    const va = visViva(MU_EARTH, el.ra, el.a);
    const circ = Math.sqrt(MU_EARTH / el.ra) - va;
    this.idealDv = Math.max(0, circ) + injectionDeltaV(MU_EARTH, el.ra, MOON_ORBIT_RADIUS);
    this.map.setFocus('earth');
    this.map.cam.setDistance(R_EARTH * 4, true);
    this.map.cam.setAngles(0.5, 0.9, true);
    this.callouts.say(this.t, 'FIDO', `Flight, we have a parking orbit of ${formatDistance(el.ra - R_EARTH)} by ${formatDistance(el.rp - R_EARTH)}.`);
    this.callouts.say(this.t, 'FLIGHT', 'Circularize when ready, then plan TLI. Take your time, we have consumables for several orbits.');
  }

  protected planners(): Planner[] {
    return [
      { id: 'circ-apo', label: 'Circularize at Ap', run: () => this.flight.circularizeNode('apoapsis') ?? 'No apoapsis ahead.' },
      { id: 'circ-pe', label: 'Circularize at Pe', run: () => this.flight.circularizeNode('periapsis') ?? 'No periapsis ahead.' },
      {
        id: 'tli',
        label: 'Plan TLI (auto)',
        title: 'Solve a prograde TLI burn for a 110 km lunar periapsis, corrected for finite burn time',
        run: () => {
          const f = this.flight;
          const tb = f.vehicle.burnTimeFor(3200);
          const lead = Math.max(300, tb / 2 + 120);
          // Plan from a state a little ahead so the burn can start in time.
          const ahead = f.predict(lead, 1).final;
          const plan = planTli(ahead, { eph: f.eph, targetAltitude: LUNAR_TARGET });
          if (!plan) return 'No TLI solution within one orbit.';
          const target = MOON.radius + LUNAR_TARGET;
          const node = refineNodeFinite(f, { t: plan.burnTime, dv: plan.dv }, (after) => {
            const ap = lunarApproach(after.predict(8 * 86400, 2));
            return ap ? ap.signedRadius - target : NaN;
          });
          this.callouts.say(this.t, 'FIDO', `TLI solution: ${Math.hypot(node.dv.prograde, node.dv.radial, node.dv.normal).toFixed(0)} m/s, ignition in ${formatDuration(node.t - this.t - f.vehicle.burnTimeFor(node.dv.prograde) / 2)}.`);
          return node;
        },
      },
    ];
  }

  protected predictionHorizon(): number {
    return this.flight.node || this.flight.elements().e > 0.5 ? 9 * 86400 : this.flight.elements().period * 1.05;
  }

  protected nodeResult(): { text: string; cls?: string }[] {
    const p = this.planned;
    if (!p) return [];
    const ap = lunarApproach(p);
    const out: { text: string; cls?: string }[] = [];
    if (ap) {
      out.push({ text: ap.impact ? 'Moon: IMPACT trajectory' : `Moon periapsis ${formatDistance(ap.periapsis)}${ap.signedRadius < 0 ? ' (retrograde)' : ''}`, cls: ap.impact ? 'bad' : Math.abs(ap.periapsis - LUNAR_TARGET) < 100e3 ? 'good' : 'warn' });
      out.push({ text: `Arrival in ${formatDuration(ap.time - this.t)}` });
    } else {
      const seg = p.segments[0];
      const el = seg.elements;
      out.push({ text: el.e < 1 ? `Orbit ${formatDistance(el.ra - R_EARTH)} x ${formatDistance(el.rp - R_EARTH)}` : 'Escape trajectory', cls: el.rp - R_EARTH < 140e3 ? 'bad' : '' });
      if (el.ra > 200_000e3) out.push({ text: 'No lunar encounter', cls: 'warn' });
    }
    return out;
  }

  protected phaseRows(): TelemetryRow[] {
    const ap = this.prediction ? lunarApproach(this.prediction) : null;
    return ap ? [{ id: 'moonpe', label: 'Lunar periapsis', value: ap.impact ? 'IMPACT' : formatDistance(ap.periapsis), cls: ap.impact ? 'bad' : 'good' }] : [];
  }

  protected statusText(): string {
    const ap = this.prediction ? lunarApproach(this.prediction) : null;
    return ap ? 'TRANSLUNAR TRAJECTORY' : 'EARTH PARKING ORBIT';
  }

  protected override onBurnComplete(): void {
    this.confirmAt = this.t + 60;
  }

  protected override onHalt(kind: 'atmosphere' | 'impact' | 'escape'): void {
    if (kind === 'atmosphere') this.fail('The orbit decayed into the atmosphere: periapsis was below 140 km.');
    else if (kind === 'escape') this.fail('The spacecraft escaped Earth: the injection burn was far too large.');
    else this.fail('Impact.');
  }

  protected checkPhase(): void {
    const f = this.flight;
    const ap = this.prediction ? lunarApproach(this.prediction) : null;
    if (ap && !this.reportedEncounter && !f.isBurning) {
      this.reportedEncounter = true;
      this.callouts.say(this.t, 'FIDO', `Flight, we have a lunar encounter. Periapsis ${ap.impact ? 'intersects the surface' : formatDistance(ap.periapsis)}.`, ap.impact ? 'warn' : 'good');
    }
    if (!ap) this.reportedEncounter = false;
    // A manual burn (no node) ending also starts the confirmation window.
    if (this.wasBurning && !f.isBurning) this.confirmAt = Math.min(this.confirmAt, this.t + 60);
    this.wasBurning = f.isBurning;
    // Complete one minute after the injection burn if the trajectory reaches the Moon.
    if (this.t >= this.confirmAt && !f.isBurning && !f.autoBurn) {
      this.confirmAt = Infinity;
      if (ap) this.complete();
    }
    if (!ap && f.vehicle.totalDv < 30 && !f.isBurning) this.fail('Out of delta-v without a lunar trajectory.');
  }

  private fail(reason: string): void {
    this.finish(buildResult('orbit', this.t, false, [], [reason], 'The mission cannot continue to the Moon.'));
  }

  private complete(): void {
    const f = this.flight;
    const ap = lunarApproach(f.predict(9 * 86400))!;
    const findings: string[] = [];
    const pe = ap.impact ? 0 : ap.periapsis;
    if (ap.impact) findings.push('Trajectory impacts the Moon: plan a mid-course correction during the coast.');
    else if (Math.abs(pe - LUNAR_TARGET) > 100e3) findings.push(`Lunar periapsis ${formatDistance(pe)} is off the 110 km target: a mid-course correction will be needed.`);
    if (f.dvUsed > this.idealDv * 1.03) findings.push(`Used ${f.dvUsed.toFixed(0)} m/s vs ${this.idealDv.toFixed(0)} m/s ideal (impulsive) for circularization + TLI.`);
    const metrics: Metric[] = [
      { label: 'Lunar periapsis', value: ap.impact ? 'Impact' : formatDistance(pe), score: ap.impact ? 0.1 : toleranceScore(pe, LUNAR_TARGET, 30e3, 3_000e3), weight: 3, target: '110 km; a mid-course correction can fix small errors' },
      { label: 'Delta-v efficiency', value: `${f.dvUsed.toFixed(0)} / ${this.idealDv.toFixed(0)} m/s`, score: linearScore(f.dvUsed / this.idealDv, 1.01, 1.15), weight: 3, target: 'Within 1% of the impulsive ideal is excellent' },
      { label: 'Flight time to Moon', value: formatDuration(ap.time - this.t), score: toleranceScore((ap.time - this.t) / 86400, 3.5, 1.5, 3), weight: 1, target: '2-5 days' },
    ];
    this.finish(
      buildResult('orbit', this.t, true, metrics, findings, `Trans-lunar injection complete. ${ap.impact ? 'The current path hits the Moon.' : `Lunar periapsis ${formatDistance(pe)}`}, arrival in ${formatDuration(ap.time - this.t)}.`),
      { vehicle: structuredClone(f.vehicle.state), flight: { orbit: f.s, eph: f.eph } },
    );
  }

  protected snapshot(): Record<string, number> {
    return { alt: this.flight.altitude };
  }
}
