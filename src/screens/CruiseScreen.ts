import type * as THREE from 'three';
import { BODIES, MOON, moonPosition, type Ephemeris } from '../physics/bodies';
import { coast, predictTrajectory, toEci, type OrbitState, type Prediction } from '../physics/patched';
import { timeToPeriapsis, stateToElements } from '../physics/kepler';
import { len, sub } from '../physics/vec';
import { MapView } from '../render/MapView';
import type { Mission } from '../sim/mission';
import { cruisePreset } from '../sim/presets';
import { buildResult, toleranceScore, type Metric } from '../sim/scoring';
import type { ChannelDef } from '../sim/telemetry';
import { formatDistance, formatDuration, formatSpeed } from '../sim/time';
import type { TelemetryRow } from '../ui/Hud';
import { h } from '../ui/dom';
import { FlightScreen, WARP_LEVELS } from './FlightScreen';

interface CruiseSnapshot {
  body: 'earth' | 'moon';
  earthDist: number;
  moonDist: number;
  moonPe: number;
  impact: boolean;
}

/** Phase 4: translunar coast with patched conics and time warp. */
export class CruiseScreen extends FlightScreen<CruiseSnapshot> {
  readonly id = 'cruise';
  private map!: MapView;
  private s!: OrbitState;
  private eph!: Ephemeris;
  private prediction: Prediction | null = null;
  private predictTimer = 0;
  private moonPe = NaN;
  private moonPeTime = NaN;
  private impact = false;
  private nextEventTime = Infinity;

  constructor(mission: Mission) {
    super(mission);
  }

  protected setup(): void {
    const carried = this.mission.carry.flight as { orbit: OrbitState; eph: Ephemeris } | undefined;
    const start = carried ?? cruisePreset();
    this.s = start.orbit;
    this.eph = start.eph;
    this.t = this.s.t;
    this.map = new MapView(this.app, this.ui);
    this.map.world.eph = this.eph;
    this.map.setFocus('earth');
    this.map.cam.setDistance(9e8, true);
    this.map.cam.setAngles(0.4, 1.1, true);
    this.repredict();

    this.hud.setControls(
      h('button', { class: 'btn btn-small', id: 'btn-focus', text: 'Focus: Earth', onclick: (e) => this.cycleFocus(e.currentTarget as HTMLButtonElement) }),
      h('button', { class: 'btn btn-small', id: 'btn-warp-max', text: 'Warp to Moon', onclick: () => this.setWarpLevel(this.maxWarp()) }),
    );
    this.hud.setHint('Drag to orbit, wheel to zoom. Tab: change focus. , and . change time warp. Esc: menu.');

    const pe = this.moonPe;
    if (this.impact) this.callouts.say(this.t, 'FIDO', 'Flight, translunar trajectory confirmed, but it intersects the Moon.', 'warn');
    else if (Number.isFinite(pe)) this.callouts.say(this.t, 'FIDO', `Flight, translunar trajectory confirmed. Predicted lunar periapsis ${formatDistance(pe)}.`);
    else this.callouts.say(this.t, 'FIDO', 'Flight, the trajectory does not reach the Moon.', 'warn');
    this.callouts.addRules([
      {
        id: 'halfway',
        role: 'CAPCOM',
        text: "You're now closer to the Moon than to the Earth.",
        when: (s) => s.moonDist < s.earthDist,
      },
      {
        id: 'pe-low',
        role: 'FIDO',
        kind: 'warn',
        text: (s) => `Predicted periapsis is low at ${formatDistance(s.moonPe)}. Recommend a mid-course correction.`,
        when: (s) => !s.impact && Number.isFinite(s.moonPe) && s.moonPe < 60e3,
      },
      {
        id: 'impact',
        role: 'FIDO',
        kind: 'bad',
        text: 'Flight, current trajectory intersects the lunar surface.',
        when: (s) => s.impact,
      },
    ]);
  }

  private cycleFocus(btn: HTMLButtonElement): void {
    const f = this.map.cycleFocus();
    btn.textContent = `Focus: ${f === 'vessel' ? 'Spacecraft' : f === 'earth' ? 'Earth' : 'Moon'}`;
  }

  private repredict(): void {
    this.prediction = predictTrajectory(this.s, 10 * 86400, { eph: this.eph, maxSegments: 3 });
    const pe = this.prediction.events.find((e) => e.kind === 'periapsis' && e.body === 'moon');
    const imp = this.prediction.events.find((e) => e.kind === 'impact' && e.body === 'moon');
    this.impact = !!imp;
    this.moonPe = pe ? pe.altitude : imp ? 0 : NaN;
    this.moonPeTime = pe ? pe.t : imp ? imp.t : NaN;
    const future = this.prediction.events.filter((e) => e.t > this.t + 1).map((e) => e.t);
    this.nextEventTime = future.length ? Math.min(...future) : Infinity;
    this.map.vesselBody = this.s.body;
    this.map.setPrediction(this.prediction);
  }

  protected maxWarp(): number {
    // Drop out of warp ahead of events (SOI change, periapsis, end of phase).
    const endT = this.endTime();
    const nextT = Math.min(this.nextEventTime, endT);
    const dt = nextT - this.t;
    let max = 1;
    // Coasting is exact at any warp; this only gives the player ~0.5 s to see the event coming.
    for (const w of WARP_LEVELS) if (w * 0.5 < dt) max = w;
    return max;
  }

  /** Phase ends one hour before lunar periapsis (handover to LOI). */
  private endTime(): number {
    return Number.isFinite(this.moonPeTime) ? this.moonPeTime - 3600 : Infinity;
  }

  protected simulate(dt: number): void {
    if (dt <= 0) return;
    const endT = this.endTime();
    const step = Math.min(dt, Math.max(0, endT - this.t));
    if (step > 0) {
      const res = coast(this.s, step, { eph: this.eph });
      const prevBody = this.s.body;
      this.s = res.state;
      this.t = this.s.t;
      for (const ev of res.events) {
        if (ev.kind === 'soi-enter') {
          this.callouts.say(ev.t, 'FIDO', 'Flight, we have crossed into the lunar sphere of influence.', 'good');
          this.telemetry.mark(ev.t, 'Lunar SOI');
        } else if (ev.kind === 'impact') {
          this.fail('The spacecraft impacted the lunar surface.');
          return;
        }
      }
      if (prevBody !== this.s.body) this.repredict();
    }
    if (this.t >= endT - 1e-6) this.complete();
  }

  private fail(reason: string): void {
    const result = buildResult('cruise', this.t, false, [], [reason], 'The translunar coast ended in a loss of vehicle.');
    this.finish(result);
  }

  private complete(): void {
    const pe = this.moonPe;
    const findings: string[] = [];
    const success = !this.impact && Number.isFinite(pe) && pe > 15e3;
    if (this.impact) findings.push('Trajectory intersected the Moon; a mid-course correction was required.');
    else if (pe < 15e3) findings.push(`Periapsis of ${formatDistance(pe)} is below safe terrain clearance (15 km).`);
    if (Number.isFinite(pe) && Math.abs(pe - 110e3) > 30e3) findings.push(`Periapsis ${formatDistance(pe)} vs 110 km target: LOI will cost extra delta-v.`);
    const metrics: Metric[] = [
      { label: 'Lunar periapsis', value: formatDistance(pe), score: toleranceScore(pe, 110e3, 10e3, 200e3), weight: 3, target: 'Target 110 km (full marks within 10 km)' }
    ];
    this.finish(
      buildResult('cruise', this.t, success, metrics, findings, success ? 'Arrived at the Moon on a safe approach trajectory, ready for lunar orbit insertion.' : 'The approach is not survivable.'),
      { flight: { orbit: this.s, eph: this.eph } },
    );
  }

  protected telemetryRows(): TelemetryRow[] {
    const body = BODIES[this.s.body];
    const eci = toEci(this.s, this.eph);
    const moonD = len(sub(eci, moonPosition(this.t, this.eph))) - MOON.radius;
    const el = stateToElements(this.s.r, this.s.v, body.mu);
    const tPe = this.s.body === 'moon' ? timeToPeriapsis(el, body.mu) : this.moonPeTime - this.t;
    return [
      { id: 'frame', label: 'Reference', value: `${body.name} SOI` },
      { id: 'alt', label: 'Altitude', value: formatDistance(len(this.s.r) - body.radius) },
      { id: 'spd', label: 'Speed', value: formatSpeed(len(this.s.v)) },
      { id: 'moon', label: 'Moon distance', value: formatDistance(moonD) },
      { id: 'pe', label: 'Lunar periapsis', value: this.impact ? 'IMPACT' : formatDistance(this.moonPe), cls: this.impact ? 'bad' : this.moonPe < 60e3 ? 'warn' : 'good' },
      { id: 'tpe', label: 'Time to periapsis', value: formatDuration(tPe) },
    ];
  }

  protected telemetryChannels(): ChannelDef[] {
    return [
      { id: 'earthAlt', label: 'Earth altitude', unit: 'km', scale: 1e-3 },
      { id: 'moonDist', label: 'Moon distance', unit: 'km', scale: 1e-3 },
      { id: 'speed', label: 'Speed (frame)', unit: 'm/s' },
    ];
  }

  protected telemetrySample(): Record<string, number> {
    const eci = toEci(this.s, this.eph);
    return {
      earthAlt: len(eci) - BODIES.earth.radius,
      moonDist: len(sub(eci, moonPosition(this.t, this.eph))) - MOON.radius,
      speed: len(this.s.v),
    };
  }

  protected snapshot(): CruiseSnapshot {
    const eci = toEci(this.s, this.eph);
    return {
      body: this.s.body,
      earthDist: len(eci),
      moonDist: len(sub(eci, moonPosition(this.t, this.eph))),
      moonPe: this.moonPe,
      impact: this.impact,
    };
  }

  protected updateVisuals(dt: number): void {
    this.predictTimer -= dt;
    if (this.predictTimer <= 0) {
      this.predictTimer = 2;
      this.repredict();
    }
    this.map.vesselEci = toEci(this.s, this.eph);
    this.map.update(this.t, dt);
    this.hud.setStatus(this.ended ? '' : this.s.body === 'moon' ? 'LUNAR APPROACH' : 'TRANSLUNAR COAST', 'info');
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.map.render(renderer);
  }

  onQualityChange(): void {
    this.map.onQualityChange();
    this.repredict();
  }

  protected override onKey(e: KeyboardEvent, down: boolean): void {
    if (down && e.key === 'Tab') {
      e.preventDefault();
      const btn = this.ui.querySelector<HTMLButtonElement>('#btn-focus');
      if (btn) this.cycleFocus(btn);
    }
  }

  protected override teardown(): void {
    this.map.dispose();
  }

  protected override extraDebug(): Record<string, unknown> {
    return { body: this.s.body, moonPe: this.moonPe, impact: this.impact, maxWarp: this.maxWarp() };
  }

  override debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'warp') this.setWarpLevel(Number(arg));
    else if (cmd === 'focus') this.map.setFocus(arg as 'vessel' | 'earth' | 'moon');
    else if (cmd === 'view') {
      const v = arg as { distance: number; yaw?: number; pitch?: number };
      this.map.cam.setDistance(v.distance, true);
      if (v.yaw !== undefined) this.map.cam.setAngles(v.yaw, v.pitch ?? 0.3, true);
    }
    return this.debugState();
  }
}
