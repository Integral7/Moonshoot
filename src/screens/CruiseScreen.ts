import { MOON, moonPosition, type Ephemeris } from '../physics/bodies';
import { toEci, type OrbitState } from '../physics/patched';
import { len, sub } from '../physics/vec';
import type { Mission } from '../sim/mission';
import { OrbitalFlight, lunarApproach, planLunarCorrection } from '../sim/orbital';
import { cruisePreset, cruiseVehicle } from '../sim/presets';
import { buildResult, linearScore, toleranceScore, type Metric } from '../sim/scoring';
import { formatDistance, formatDuration } from '../sim/time';
import type { VehicleState } from '../sim/vehicle';
import type { TelemetryRow } from '../ui/Hud';
import type { Planner } from '../ui/ManeuverPanel';
import { OrbitalScreen } from './OrbitalScreen';

const LUNAR_TARGET = 110e3;

interface CruiseSnapshot {
  earthDist: number;
  moonDist: number;
  moonPe: number;
  impact: boolean;
  noEncounter: boolean;
}

/** Phase 4: translunar coast with time warp and mid-course corrections. */
export class CruiseScreen extends OrbitalScreen<CruiseSnapshot> {
  readonly id = 'cruise';
  private startPe = NaN;

  constructor(mission: Mission) {
    super(mission);
  }

  protected initialFlight(): OrbitalFlight {
    const carried = this.mission.carry.flight as { orbit: OrbitState; eph: Ephemeris } | undefined;
    const vehicle = this.mission.carry.vehicle as VehicleState | undefined;
    if (carried && vehicle) return new OrbitalFlight(carried.orbit, vehicle, carried.eph);
    const p = cruisePreset();
    return new OrbitalFlight(p.orbit, cruiseVehicle(), p.eph);
  }

  protected override phaseSetup(): void {
    this.map.setFocus('earth');
    this.map.cam.setDistance(9e8, true);
    this.map.cam.setAngles(0.4, 1.1, true);
    this.repredict();
    const ap = this.approach();
    this.startPe = ap ? ap.periapsis : NaN;
    if (!ap) this.callouts.say(this.t, 'FIDO', 'Flight, the trajectory does not reach the Moon. We need a correction.', 'bad');
    else if (ap.impact) this.callouts.say(this.t, 'FIDO', 'Flight, translunar trajectory confirmed, but it intersects the Moon. Recommend a mid-course correction.', 'warn');
    else this.callouts.say(this.t, 'FIDO', `Flight, translunar trajectory confirmed. Predicted lunar periapsis ${formatDistance(ap.periapsis)}.`);
    this.callouts.addRules([
      { id: 'halfway', role: 'CAPCOM', text: "You're now closer to the Moon than to the Earth.", when: (s) => s.moonDist < s.earthDist },
      {
        id: 'pe-low',
        role: 'FIDO',
        kind: 'warn',
        text: (s) => `Predicted periapsis is low at ${formatDistance(s.moonPe)}. Recommend a mid-course correction.`,
        when: (s) => !s.impact && Number.isFinite(s.moonPe) && s.moonPe < 60e3,
        rearm: (s) => s.moonPe > 80e3,
      },
      { id: 'impact', role: 'FIDO', kind: 'bad', text: 'Flight, current trajectory intersects the lunar surface.', when: (s) => s.impact, rearm: (s) => !s.impact },
    ]);
  }

  protected planners(): Planner[] {
    return [
      {
        id: 'mcc',
        label: 'Plan MCC (110 km)',
        title: 'Smallest correction (prograde, radial or normal) for a 110 km prograde lunar periapsis',
        run: () => {
          const t = this.flight.node?.t ?? this.t + 900;
          const n = planLunarCorrection(this.flight, Math.max(t, this.t + 120), LUNAR_TARGET);
          if (!n) return 'No correction under 120 m/s found from this point.';
          const mag = Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial);
          this.callouts.say(this.t, 'FIDO', `Mid-course correction: ${mag.toFixed(2)} m/s.`);
          return n;
        },
      },
    ];
  }

  protected predictionHorizon(): number {
    return 9 * 86400;
  }

  protected nodeResult(): { text: string; cls?: string }[] {
    if (!this.planned) return [];
    const ap = lunarApproach(this.planned);
    if (!ap) return [{ text: 'No lunar encounter', cls: 'bad' }];
    return [{ text: ap.impact ? 'Moon: IMPACT' : `Moon periapsis ${formatDistance(ap.periapsis)}${ap.signedRadius < 0 ? ' (retrograde)' : ''}`, cls: ap.impact ? 'bad' : Math.abs(ap.periapsis - LUNAR_TARGET) < 20e3 ? 'good' : 'warn' }];
  }

  private approach() {
    return this.prediction ? lunarApproach(this.prediction) : null;
  }

  protected phaseRows(): TelemetryRow[] {
    const eci = toEci(this.flight.s, this.flight.eph);
    const moonD = len(sub(eci, moonPosition(this.t, this.flight.eph))) - MOON.radius;
    const ap = this.approach();
    return [
      { id: 'moon', label: 'Moon distance', value: formatDistance(moonD) },
      { id: 'moonpe', label: 'Lunar periapsis', value: !ap ? 'NO ENCOUNTER' : ap.impact ? 'IMPACT' : formatDistance(ap.periapsis), cls: !ap || ap.impact ? 'bad' : ap.periapsis < 60e3 ? 'warn' : 'good' },
      { id: 'tpe', label: 'Time to periapsis', value: ap ? formatDuration(ap.time - this.t) : '--' },
    ];
  }

  protected statusText(): string {
    return this.flight.s.body === 'moon' ? 'LUNAR APPROACH' : 'TRANSLUNAR COAST';
  }

  protected override onHalt(kind: 'atmosphere' | 'impact' | 'escape'): void {
    if (kind === 'impact') this.fail('The spacecraft impacted the lunar surface.');
    else if (kind === 'atmosphere') this.fail("The spacecraft fell back into Earth's atmosphere.");
    else this.fail("The spacecraft left Earth's sphere of influence.");
  }

  protected checkPhase(): void {
    const ap = this.approach();
    // Hand over to lunar orbit insertion one hour before periapsis.
    this.phaseEndTime = ap ? ap.time - 3600 : Infinity;
    if (ap && this.t >= this.phaseEndTime - 1e-6 && !this.flight.isBurning && !this.flight.autoBurn) this.complete(ap);
    if (!ap && this.flight.s.body === 'earth' && this.t > 10 * 86400) this.fail('The spacecraft missed the Moon.');
  }

  private fail(reason: string): void {
    this.finish(buildResult('cruise', this.t, false, [], [reason], 'The translunar coast ended in a loss of mission.'));
  }

  private complete(ap: { periapsis: number; impact: boolean; signedRadius: number }): void {
    const pe = ap.periapsis;
    const findings: string[] = [];
    const success = !ap.impact && pe > 15e3;
    if (ap.impact) findings.push('Trajectory intersected the Moon: a mid-course correction was required.');
    else if (pe < 15e3) findings.push(`Periapsis of ${formatDistance(pe)} is below safe terrain clearance (15 km).`);
    if (ap.signedRadius < 0) findings.push('Retrograde lunar approach: insertion works, but the landing site lighting will differ.');
    if (Number.isFinite(pe) && Math.abs(pe - LUNAR_TARGET) > 30e3) findings.push(`Periapsis ${formatDistance(pe)} vs 110 km target: lunar orbit insertion will cost extra delta-v.`);
    const metrics: Metric[] = [
      { label: 'Lunar periapsis', value: formatDistance(pe), score: toleranceScore(pe, LUNAR_TARGET, 10e3, 300e3), weight: 3, target: 'Target 110 km (full marks within 10 km)' },
      { label: 'Correction delta-v', value: `${this.flight.dvUsed.toFixed(1)} m/s`, score: linearScore(this.flight.dvUsed, 10, 80), weight: 2, target: 'Budget 60 m/s; under 10 is excellent' },
    ];
    this.finish(
      buildResult('cruise', this.t, success, metrics, findings, success ? `Arrived at the Moon on a ${formatDistance(pe)} approach, ready for lunar orbit insertion.` : 'The approach is not survivable.'),
      { vehicle: structuredClone(this.flight.vehicle.state), flight: { orbit: this.flight.s, eph: this.flight.eph } },
    );
  }

  protected snapshot(): CruiseSnapshot {
    const eci = toEci(this.flight.s, this.flight.eph);
    const ap = this.approach();
    return {
      earthDist: len(eci),
      moonDist: len(sub(eci, moonPosition(this.t, this.flight.eph))),
      moonPe: ap ? ap.periapsis : NaN,
      impact: !!ap?.impact,
      noEncounter: !ap,
    };
  }

  protected override extraDebug(): Record<string, unknown> {
    const ap = this.approach();
    return { ...super.extraDebug(), moonPe: ap?.periapsis ?? null, impact: ap?.impact ?? false, startPe: this.startPe };
  }
}
