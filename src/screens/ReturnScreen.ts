import * as THREE from 'three';
import { MOON, earthRotation, moonRotation, type Ephemeris } from '../physics/bodies';
import { DEG, MU_MOON, R_EARTH, R_MOON } from '../physics/constants';
import { FixedStepper } from '../physics/integrator';
import { add, cross, dot, len, norm, rotateZ, scale, sub, vec, type Vec3 } from '../physics/vec';
import { eciDirToScene } from '../render/coords';
import { createPlasmaGlow, createSurfacePatch } from '../render/entryFx';
import { setStarBrightness } from '../render/starfield';
import { SurfaceScene } from '../render/SurfaceScene';
import { SUN_DIRECTION_ECI } from '../render/World';
import { DESCENT_STEP, DescentSim, lunarAscentAutopilot, type DescentControls } from '../sim/descent';
import { isLand } from '../sim/earthSurface';
import type { Mission } from '../sim/mission';
import { earthApproach, OrbitalFlight, planEarthCorrection, planTei } from '../sim/orbital';
import { returnPreset } from '../sim/presets';
import { ENTRY_STEP, EntrySim, entryAutopilot, type EntryControls } from '../sim/reentry';
import { buildResult, linearScore, toleranceScore, type Metric } from '../sim/scoring';
import type { ChannelDef } from '../sim/telemetry';
import { formatDistance, formatDuration, formatSpeed } from '../sim/time';
import type { VehicleState } from '../sim/vehicle';
import type { TelemetryRow } from '../ui/Hud';
import type { Planner } from '../ui/ManeuverPanel';
import { h } from '../ui/dom';
import { OrbitalScreen } from './OrbitalScreen';

type Mode = 'surface' | 'ascent' | 'orbit' | 'entry' | 'done';
const TARGET_GAMMA = -6.5 * DEG;

/** Phase 6: lunar liftoff, trans-Earth injection, return coast, reentry, and splashdown. */
export class ReturnScreen extends OrbitalScreen {
  readonly id = 'return';
  private mode: Mode = 'surface';
  private surfaceState!: { r: Vec3; t: number; eph: Ephemeris };
  private vehicle0!: VehicleState;
  private ascent!: DescentSim;
  private surfaceView: SurfaceScene | null = null;
  private entry: EntrySim | null = null;
  private stepper = new FixedStepper(DESCENT_STEP, 4000);
  private entryStepper = new FixedStepper(ENTRY_STEP, 6000);
  private autopilot = false;
  private everManual = false;
  private pitch = 0;
  private throttleCmd = 0;
  private bankCmd = 0;
  private east: Vec3 = vec(0, 1, 0);
  private glow: ReturnType<typeof createPlasmaGlow> | null = null;
  private patch: ReturnType<typeof createSurfacePatch> | null = null;
  private ascentDv = 0;
  private orbitDv0 = 0;
  private teiDv = 0;
  private fast = false;
  private skyLight = new THREE.HemisphereLight(0xbcd6ff, 0x404850, 0);
  private apButton!: HTMLButtonElement;

  constructor(mission: Mission) {
    super(mission);
  }

  // ---- Setup --------------------------------------------------------------------
  protected initialFlight(): OrbitalFlight {
    const carried = this.mission.carry.surface as { r: Vec3; t: number; eph: Ephemeris } | undefined;
    const vehicle = this.mission.carry.vehicle as VehicleState | undefined;
    if (carried && vehicle) {
      this.surfaceState = carried;
      this.vehicle0 = vehicle;
    } else {
      const p = returnPreset();
      this.surfaceState = p.surface;
      this.vehicle0 = p.vehicle;
    }
    const s = this.surfaceState;
    const r = rotateZ(s.r, moonRotation(s.t, s.eph));
    const w = MOON.rotationRate;
    // Placeholder orbital state (replaced after ascent); the base class needs a flight to build its scene.
    return new OrbitalFlight({ body: 'moon', t: s.t, r: scale(norm(r), R_MOON + 100e3), v: vec(-w * r.y, w * r.x, 0) }, structuredClone(this.vehicle0), s.eph);
  }

  protected override phaseSetup(): void {
    const s = this.surfaceState;
    const r = rotateZ(s.r, moonRotation(s.t, s.eph));
    const w = MOON.rotationRate;
    this.ascent = new DescentSim(r, vec(-w * r.y, w * r.x, 0), structuredClone(this.vehicle0), s.eph, s.t, 1969, true);
    this.t = s.t;
    this.east = norm(cross(vec(0, 0, 1), this.ascent.up));
    this.panel.root.style.display = 'none';
    this.map.showPrediction(false);
    this.map.setFocus('vessel');
    this.map.cam.minDistance = 8;
    this.map.cam.setDistance(60, true);
    this.map.cam.setAngles(Math.PI * 0.8, 0.2, true);
    this.surfaceView = new SurfaceScene(this.map, this.ascent, this.app.quality);
    this.map.world.scene.add(this.skyLight);
    this.apButton = h('button', { class: 'btn btn-small', id: 'btn-autopilot', text: 'Autopilot: OFF', onclick: () => this.setAutopilot(!this.autopilot) }) as HTMLButtonElement;
    this.hud.setControls(
      h('button', { class: 'btn btn-small btn-primary', id: 'btn-liftoff', text: 'Lift off', onclick: () => this.liftoff() }),
      this.apButton,
    );
    this.hud.setHint('Lift off, then W/S pitch toward the horizon · Shift/Ctrl throttle · Z/X full/cut · G autopilot');
    this.callouts.say(this.t, 'CAPCOM', 'You are cleared for liftoff whenever you are ready. Ascent is a pitch-over to a low lunar orbit.');
  }

  private setAutopilot(on: boolean): void {
    this.autopilot = on;
    this.apButton.textContent = `Autopilot: ${on ? 'ON' : 'OFF'}`;
    this.apButton.classList.toggle('active', on);
  }

  private liftoff(): void {
    if (this.mode !== 'surface') return;
    const v = this.ascent.vehicle;
    if (v.stageInfo?.hasLegs && v.separate()) this.callouts.say(this.t, 'CDR', 'Staging. The descent stage stays behind as our launch pad.');
    this.mode = 'ascent';
    this.throttleCmd = 1;
    this.ui.querySelector('#btn-liftoff')?.remove();
    this.callouts.say(this.t, 'CDR', 'Liftoff! Ascent engine burning.', 'good');
    this.telemetry.mark(this.t, 'Lunar liftoff');
  }

  // ---- Orbit (inherited) planners --------------------------------------------
  protected planners(): Planner[] {
    if (this.mode !== 'orbit') return [];
    const out: Planner[] = [];
    if (this.flight.s.body === 'moon' && this.flight.elements().e < 0.5) {
      out.push({
        id: 'tei',
        label: 'Plan TEI (-6.5° entry)',
        title: 'Prograde trans-Earth injection timed for a -6.5 deg entry flight-path angle',
        run: () => {
          const n = planTei(this.flight, TARGET_GAMMA);
          if (!n) return 'No TEI solution within one orbit.';
          this.callouts.say(this.t, 'RETRO', `TEI solution: ${Math.hypot(n.dv.prograde, n.dv.radial, n.dv.normal).toFixed(0)} m/s.`);
          return n;
        },
      });
    }
    out.push({
      id: 'rcc',
      label: 'Plan correction (-6.5°)',
      title: 'Small burn to put the entry angle in the middle of the corridor',
      run: () => planEarthCorrection(this.flight, Math.max(this.flight.node?.t ?? this.t + 900, this.t + 120), TARGET_GAMMA) ?? 'No correction found from here.',
    });
    return out;
  }

  protected predictionHorizon(): number {
    return this.flight.s.body === 'moon' && this.flight.elements().e < 1 && !this.flight.node ? this.flight.elements().period * 1.1 : 6 * 86400;
  }

  private approach() {
    return this.prediction ? earthApproach(this.prediction) : null;
  }

  protected nodeResult(): { text: string; cls?: string }[] {
    const ap = this.planned ? earthApproach(this.planned) : null;
    if (!this.planned) return [];
    if (!ap) return [{ text: 'Does not reach Earth', cls: 'bad' }];
    const g = ap.gamma / DEG;
    return [{ text: Number.isFinite(g) ? `Entry angle ${g.toFixed(2)}° (corridor −5.5 to −7.5)` : `Misses: perigee ${formatDistance(ap.perigee)}`, cls: Number.isFinite(g) && g < -5.5 && g > -7.5 ? 'good' : 'bad' }];
  }

  protected phaseRows(): TelemetryRow[] {
    const ap = this.approach();
    if (!ap) return [];
    const g = ap.gamma / DEG;
    return [
      { id: 'gamma', label: 'Entry angle', value: Number.isFinite(g) ? `${g.toFixed(2)}°` : 'MISS', cls: Number.isFinite(g) && g < -5.5 && g > -7.5 ? 'good' : 'bad' },
      { id: 'tei', label: 'Time to entry', value: Number.isFinite(ap.time) ? formatDuration(ap.time - this.t) : '--' },
    ];
  }

  protected statusText(): string {
    return this.flight.s.body === 'moon' ? (this.flight.elements().e < 1 ? 'LUNAR ORBIT' : 'LEAVING THE MOON') : 'TRANS-EARTH COAST';
  }

  protected override onHalt(kind: 'atmosphere' | 'impact' | 'escape'): void {
    if (this.mode !== 'orbit') return;
    if (kind === 'atmosphere') this.beginEntry();
    else if (kind === 'impact') this.fail(this.flight.s.body === 'moon' ? 'Struck the Moon after liftoff.' : 'Struck the Earth.', []);
    else this.fail('Escaped the Earth-Moon system.', []);
  }

  protected checkPhase(): void {
    if (this.mode !== 'orbit') return;
    const ap = this.approach();
    if (ap && !this.callouts.hasFired('go-home')) this.callouts.sayOnce('go-home', this.t, 'RETRO', `Flight, we are on our way home. Entry angle ${(ap.gamma / DEG).toFixed(2)}°.`, Number.isFinite(ap.gamma) ? 'good' : 'warn');
    // Plan to stop warping before the atmosphere.
    this.phaseEndTime = Infinity;
  }

  // ---- Ascent --------------------------------------------------------------------
  private ascentControls(dt: number): DescentControls {
    const sim = this.ascent;
    if (this.autopilot) {
      const c = lunarAscentAutopilot(sim, this.east);
      this.throttleCmd = c.throttle;
      return c;
    }
    const k = this.keys;
    if (k.has('shift')) this.throttleCmd = Math.min(1, this.throttleCmd + dt * 0.6);
    if (k.has('control')) this.throttleCmd = Math.max(0, this.throttleCmd - dt * 0.6);
    if (k.has('w')) this.pitch = Math.min(95, this.pitch + 12 * dt);
    if (k.has('s')) this.pitch = Math.max(0, this.pitch - 12 * dt);
    const up = sim.up;
    const fwd = norm(sub(this.east, scale(up, dot(this.east, up))));
    const p = this.pitch * DEG;
    return { throttle: this.throttleCmd, dir: norm(add(scale(up, Math.cos(p)), scale(fwd, Math.sin(p)))) };
  }

  private simulateAscent(dt: number): void {
    const sim = this.ascent;
    this.stepper.advance(dt, (hh) => {
      if (this.mode !== 'ascent' || sim.landed) return;
      const c = this.ascentControls(hh);
      sim.step(c, hh);
      // Orbit achieved: engine off with a periapsis clear of the terrain.
      if (c.throttle === 0 && sim.altitude > 3_000) this.checkOrbit();
    });
    this.t = sim.t;
    for (const e of sim.events.splice(0)) {
      if (e.kind === 'liftoff') this.callouts.say(e.t, 'CAPCOM', 'We have liftoff from the Moon.', 'good');
      if (e.kind === 'out-of-fuel') this.callouts.say(e.t, 'CONTROL', 'Ascent propellant depleted!', 'bad');
    }
    if (sim.landed) this.fail('The ascent stage came back down onto the Moon.', ['Pitch over more gradually and burn until horizontal speed reaches orbital speed.']);
    if (this.mode === 'ascent' && sim.altitude > 3_000 && this.throttleCmd === 0 && !this.autopilot) this.checkOrbit();
  }

  private checkOrbit(): void {
    const sim = this.ascent;
    const f = new OrbitalFlight({ body: 'moon', t: sim.t, r: sim.r, v: sim.v }, sim.vehicle.state, sim.eph);
    const el = f.elements();
    if (el.rp - R_MOON < 4_000) return; // not yet safe
    this.ascentDv = sim.dvUsed;
    this.flight = f;
    this.orbitDv0 = 0;
    this.mode = 'orbit';
    this.surfaceView?.dispose();
    this.surfaceView = null;
    this.map.world.moon.setSurfaceVisible(true);
    this.map.showPrediction(true);
    this.map.setFocus('moon');
    this.map.cam.minDistance = 30;
    this.panel.root.style.display = '';
    this.hud.setControls(
      h('button', { class: 'btn btn-small', id: 'btn-focus', text: 'Focus (Tab)', onclick: () => this.map.cycleFocus() }),
      h('button', { class: 'btn btn-small', id: 'btn-stage', text: 'Stage (Space)', onclick: () => this.flight.stage() }),
    );
    this.hud.setHint('Plan TEI in the maneuver panel · , . warp · Tab focus · Esc menu');
    this.callouts.say(this.t, 'FIDO', `Good orbit: ${formatDistance(el.ra - R_MOON)} by ${formatDistance(el.rp - R_MOON)}. Plan trans-Earth injection.`, 'good');
    this.setAutopilot(false);
    this.repredict();
  }

  // ---- Entry ----------------------------------------------------------------------
  private beginEntry(): void {
    const f = this.flight;
    this.teiDv = f.dvUsed - this.orbitDv0;
    this.entry = new EntrySim(f.s.r, f.s.v, f.vehicle.state, f.eph, f.t);
    this.mode = 'entry';
    this.panel.root.style.display = 'none';
    this.map.showPrediction(false);
    this.map.setFocus('vessel');
    this.map.cam.minDistance = 6;
    this.map.cam.setDistance(40, true);
    this.map.cam.setAngles(0.5, 0.25, true);
    this.syncModelStages(this.entry.vehicle);
    this.glow = createPlasmaGlow(this.entry.vehicle.diameter * 0.55);
    this.model.root.add(this.glow.mesh);
    this.apButton = h('button', { class: 'btn btn-small', id: 'btn-autopilot', text: 'Entry autopilot: OFF', onclick: () => this.setEntryAutopilot(!this.autopilot) }) as HTMLButtonElement;
    this.setEntryAutopilot(this.autopilot);
    this.hud.setControls(
      this.apButton,
      h('button', { class: 'btn btn-small', id: 'btn-drogue', text: 'Drogues (1)', onclick: () => this.entryCmd({ deployDrogue: true }) }),
      h('button', { class: 'btn btn-small', id: 'btn-main', text: 'Mains (2)', onclick: () => this.entryCmd({ deployMain: true }) }),
    );
    this.hud.setHint('A/D roll the lift vector (bank) · U lift up · J lift down · 1 drogues · 2 mains · G autopilot');
    this.callouts.say(this.t, 'CAPCOM', 'Service module separation confirmed. Entry interface in a few minutes.');
    this.telemetry.mark(this.t, 'Entry');
  }

  private setEntryAutopilot(on: boolean): void {
    this.autopilot = on;
    this.apButton.textContent = `Entry autopilot: ${on ? 'ON' : 'OFF'}`;
    this.apButton.classList.toggle('active', on);
  }

  private pending: Partial<EntryControls> = {};
  private entryCmd(c: Partial<EntryControls>): void {
    Object.assign(this.pending, c);
  }

  private simulateEntry(dt: number): void {
    const sim = this.entry!;
    this.entryStepper.advance(dt, (hh) => {
      if (sim.failed || sim.splash) return;
      const k = this.keys;
      if (k.has('a')) this.bankCmd -= 25 * DEG * hh;
      if (k.has('d')) this.bankCmd += 25 * DEG * hh;
      const c: EntryControls = this.autopilot ? entryAutopilot(sim) : { bank: this.bankCmd };
      if (this.autopilot) this.bankCmd = c.bank;
      sim.step({ ...c, ...this.pending }, hh);
      this.pending = {};
    });
    this.t = sim.t;
    for (const e of sim.events.splice(0)) {
      switch (e.kind) {
        case 'interface':
          this.callouts.say(e.t, 'RETRO', `Entry interface: ${e.detail}.`, 'good');
          break;
        case 'blackout':
          this.callouts.say(e.t, 'CAPCOM', 'Expect loss of signal. See you on the other side.');
          break;
        case 'blackout-end':
          this.callouts.say(e.t, 'CAPCOM', 'We have acquisition of signal.', 'good');
          break;
        case 'drogue':
          this.callouts.say(e.t, 'CDR', 'Drogues out.', 'good');
          break;
        case 'main':
          this.callouts.say(e.t, 'CDR', 'Three good mains!', 'good');
          break;
        case 'chute-fail':
          this.callouts.say(e.t, 'CDR', `Chute failure: ${e.detail}.`, 'bad');
          break;
        case 'splashdown':
          this.callouts.say(e.t, 'CONTROL', `Splashdown! ${e.detail}.`, 'good');
          break;
      }
    }
    if (sim.peakG > 5 && !this.callouts.hasFired('gwarn')) this.callouts.sayOnce('gwarn', this.t, 'SURGEON', `Crew at ${sim.forces.gLoad.toFixed(1)} g.`, 'warn');
    if (sim.failed) this.fail(sim.failed, []);
    else if (sim.splash) this.complete();
  }

  private complete(): void {
    const sim = this.entry!;
    const sp = sim.splash!;
    this.mode = 'done';
    const shield = sim.vehicle.heatShield;
    const loadFrac = shield ? sim.heatLoad / shield.maxLoad : 1;
    const g = sim.entryAngle / DEG;
    const success = sp.outcome !== 'fatal';
    const metrics: Metric[] = [
      { label: 'Entry flight-path angle', value: `${g.toFixed(2)}°`, score: toleranceScore(g, -6.5, 0.25, 1.5), weight: 3, target: '−6.5° (corridor −5.5 to −7.5)' },
      { label: 'Peak deceleration', value: `${sim.peakG.toFixed(1)} g`, score: linearScore(sim.peakG, 5, 11), weight: 2, target: 'Apollo flew ~6-7 g' },
      { label: 'Heat shield used', value: `${(loadFrac * 100).toFixed(0)}%`, score: linearScore(loadFrac, 0.6, 1), weight: 1 },
      { label: 'Splashdown speed', value: `${sp.speed.toFixed(1)} m/s`, score: linearScore(sp.speed, 9, 16), weight: 2 },
      { label: 'Recovery', value: sp.ocean ? 'Ocean' : 'Land', score: sp.ocean ? 1 : 0.4, weight: 1, target: 'Capsules are built to splash down' },
      { label: 'Lunar ascent Δv', value: `${this.ascentDv.toFixed(0)} m/s`, score: linearScore(this.ascentDv, 1_850, 2_500), weight: 1, target: 'Budget 1,870 m/s' },
      { label: 'Trans-Earth Δv', value: `${this.teiDv.toFixed(0)} m/s`, score: linearScore(this.teiDv, 900, 1_400), weight: 1 },
      { label: 'Piloting', value: this.everManual ? 'Hand-flown' : 'Autopilot', score: this.everManual ? 1 : 0.6, weight: 1 },
    ];
    const findings: string[] = [];
    if (!sp.ocean) findings.push('Came down on land: survivable for this model, but rough on the crew and capsule.');
    if (sp.outcome === 'hard') findings.push(`Hard splashdown at ${sp.speed.toFixed(1)} m/s.`);
    if (Math.abs(g + 6.5) > 0.5) findings.push(`Entry angle ${g.toFixed(2)}°: use the return correction to center the corridor.`);
    this.finish(
      buildResult('return', this.t, success, metrics, findings, `Splashdown at ${sp.lat.toFixed(2)}°, ${sp.lon.toFixed(2)}° ${sp.ocean ? 'in the ocean' : 'on land'}, ${sp.speed.toFixed(1)} m/s. Welcome home.`),
      { splash: sp },
    );
  }

  private fail(reason: string, extra: string[]): void {
    if (this.ended) return;
    this.mode = 'done';
    this.finish(buildResult('return', this.t, false, [], [reason, ...extra], 'The crew did not make it home.'));
  }

  // ---- Mode switching overrides -----------------------------------------------------
  protected override simulate(dt: number): void {
    if (this.mode === 'orbit') super.simulate(dt);
    else if (this.mode === 'ascent') this.simulateAscent(dt);
    else if (this.mode === 'entry') this.simulateEntry(dt);
  }

  protected override maxWarp(): number {
    if (this.mode === 'orbit') return super.maxWarp();
    if (this.mode === 'ascent') return this.fast ? 50 : 5;
    if (this.mode === 'entry') {
      const alt = this.entry!.altitude;
      return this.fast ? 50 : alt > 125_000 ? 10 : 5;
    }
    return 1;
  }

  protected override onKey(e: KeyboardEvent, down: boolean): void {
    if (this.mode === 'orbit') {
      super.onKey(e, down);
      return;
    }
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    if (['w', 's', 'a', 'd', 'shift', 'control', 'z', 'x', 'u', 'j'].includes(k)) {
      this.everManual = true;
      if (this.autopilot && k !== 'shift') {
        this.autopilot = false;
        if (this.mode === 'entry') this.setEntryAutopilot(false);
        else this.setAutopilot(false);
        this.app.toast('Autopilot disengaged', 'warn', 1400);
      }
    }
    if (k === 'z') this.throttleCmd = 1;
    else if (k === 'x') this.throttleCmd = 0;
    else if (k === 'u') this.bankCmd = 0;
    else if (k === 'j') this.bankCmd = Math.PI;
    else if (k === '1') this.entryCmd({ deployDrogue: true });
    else if (k === '2') this.entryCmd({ deployMain: true });
    else if (k === 'g') (this.mode === 'entry' ? this.setEntryAutopilot(!this.autopilot) : this.setAutopilot(!this.autopilot));
    else if (k === ' ' && this.mode === 'surface') {
      e.preventDefault();
      this.liftoff();
    }
  }

  protected override telemetryRows(): TelemetryRow[] {
    if (this.mode === 'orbit') return super.telemetryRows();
    if (this.mode === 'surface' || this.mode === 'ascent') {
      const s = this.ascent;
      const r = len(s.r);
      const vh = len(sub(s.v, scale(s.up, dot(s.v, s.up))));
      return [
        { id: 'alt', label: 'Altitude', value: formatDistance(s.altitude) },
        { id: 'vz', label: 'Vertical speed', value: formatSpeed(s.verticalSpeed) },
        { id: 'vh', label: 'Orbital speed', value: `${formatSpeed(vh)} / ${formatSpeed(Math.sqrt(MU_MOON / r))}` },
        { id: 'thr', label: 'Throttle', value: `${Math.round(s.throttle * 100)}%` },
        { id: 'pitch', label: 'Pitch from vertical', value: `${(s.tilt / DEG).toFixed(1)}°` },
        { id: 'fuel', label: 'Propellant', value: s.vehicle.stageInfo?.propMass ? `${((100 * s.vehicle.prop) / s.vehicle.stageInfo.propMass).toFixed(0)}%` : '--' },
        { id: 'dv', label: 'Δv remaining', value: `${s.vehicle.totalDv.toFixed(0)} m/s` },
      ];
    }
    const e = this.entry;
    if (!e) return [];
    const f = e.forces;
    const shield = e.vehicle.heatShield;
    return [
      { id: 'alt', label: 'Altitude', value: formatDistance(e.altitude) },
      { id: 'spd', label: 'Airspeed', value: formatSpeed(f.airspeed) },
      { id: 'fpa', label: 'Flight-path angle', value: `${(e.flightPathAngle / DEG).toFixed(2)}°` },
      { id: 'g', label: 'G-load', value: `${f.gLoad.toFixed(2)} g (peak ${e.peakG.toFixed(1)})`, cls: f.gLoad > 8 ? 'bad' : f.gLoad > 5 ? 'warn' : '' },
      { id: 'heat', label: 'Heat flux', value: `${(f.heatFlux / 1e4).toFixed(0)} W/cm²`, cls: shield && f.heatFlux > shield.maxFlux * 0.8 ? 'bad' : '' },
      { id: 'load', label: 'Shield used', value: shield ? `${((100 * e.heatLoad) / shield.maxLoad).toFixed(0)}%` : 'NONE', cls: shield && e.heatLoad > shield.maxLoad * 0.8 ? 'bad' : '' },
      { id: 'bank', label: 'Bank (lift)', value: `${(e.bank / DEG).toFixed(0)}° ${Math.abs(e.bank) < 60 ? '(up)' : Math.abs(e.bank) > 120 ? '(down)' : ''}` },
      { id: 'q', label: 'Dyn. pressure', value: `${(f.q / 1000).toFixed(1)} kPa` },
      { id: 'chutes', label: 'Parachutes', value: e.chutes.toUpperCase() },
    ];
  }

  protected override telemetryChannels(): ChannelDef[] {
    return [...super.telemetryChannels(), { id: 'g', label: 'G-load', unit: 'g' }, { id: 'heat', label: 'Heat flux', unit: 'W/cm²', scale: 1e-4 }];
  }

  protected override telemetrySample(): Record<string, number> {
    if (this.mode === 'orbit') return super.telemetrySample();
    if (this.mode === 'entry' && this.entry) return { alt: this.entry.altitude, speed: this.entry.forces.airspeed, moonDist: NaN, dv: NaN, g: this.entry.forces.gLoad, heat: this.entry.forces.heatFlux };
    return { alt: this.ascent.altitude, speed: len(this.ascent.v), moonDist: 0, dv: this.ascent.dvUsed };
  }

  protected snapshot(): Record<string, number> {
    return {};
  }

  // ---- Visuals ---------------------------------------------------------------------
  protected override updateVisuals(dt: number): void {
    if (this.mode === 'orbit') {
      super.updateVisuals(dt);
      return;
    }
    this.time += dt;
    if (this.mode === 'surface' || this.mode === 'ascent') {
      this.syncModelStages(this.ascent.vehicle);
      this.surfaceView?.update(this.ascent, this.model, this.plumes, this.t, this.time, dt, null, this.app.height);
      this.hud.setStatus(this.mode === 'surface' ? 'ON THE SURFACE' : this.autopilot ? 'ASCENT AUTOPILOT' : 'MANUAL ASCENT');
      return;
    }
    const e = this.entry;
    if (!e) return;
    this.syncModelStages(e.vehicle);
    this.map.vesselEci = e.r;
    const up = eciDirToScene(e.up);
    this.map.cam.up.copy(up);
    // Heat shield forward: the capsule's +Y axis points away from the airflow, rolled with the bank angle.
    const back = eciDirToScene(norm(scale(e.forces.airVelocity, -1)));
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), back);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.bank));
    this.model.root.quaternion.copy(q);
    for (const p of this.plumes) p.plume.update(0, 1, this.time);
    this.glow?.update(e.forces.heatFlux / 2e6, this.time);
    // Parachutes.
    const ch = this.model.chutes;
    if (ch) {
      ch.visible = e.chutes === 'drogue' || e.chutes === 'main';
      const s = e.chutes === 'main' ? 0.3 + 0.7 * e.mainFill : 0.25 * e.drogueFill;
      ch.scale.setScalar(Math.max(0.05, s));
      if (ch.visible) this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    }
    // Sky and local surface.
    const sunUp = eciDirToScene(SUN_DIRECTION_ECI).dot(up);
    const day = THREE.MathUtils.clamp(sunUp * 2 + 0.25, 0, 1);
    const airF = 1 - THREE.MathUtils.smoothstep(e.altitude, 2_000, 70_000);
    this.map.world.scene.background = new THREE.Color(0.24, 0.45, 0.82).multiplyScalar(day * airF);
    this.skyLight.intensity = 1.6 * day * airF;
    this.skyLight.position.copy(up);
    setStarBrightness(this.map.world.stars, 1 - Math.min(1, day * airF * 1.6));
    const camAlt = this.map.camera.position.clone().sub(this.map.world.earth.group.position).length() - R_EARTH;
    this.map.world.earth.setAtmosphereIntensity(0.12 + 0.88 * THREE.MathUtils.smoothstep(camAlt, 5_000, 90_000));
    if (e.altitude < 45_000 && !this.patch) this.placePatch(e);
    this.patch?.setOpacity(1 - THREE.MathUtils.smoothstep(e.altitude, 15_000, 45_000));
    this.map.update(this.t, dt);
    const hdg = e.chutes === 'main' ? 'UNDER MAINS' : e.chutes === 'drogue' ? 'DROGUES' : this.autopilot ? 'ENTRY AUTOPILOT' : 'MANUAL BANK';
    this.hud.setStatus(hdg, e.forces.gLoad > 5 ? 'warn' : 'info');
  }

  /** Put a local ocean/land patch under the capsule's predicted splash point. */
  private placePatch(e: EntrySim): void {
    const rot = earthRotation(this.t, e.eph);
    const fixed = norm(rotateZ(e.r, -rot));
    const ocean = !isLand(fixed);
    this.patch = createSurfacePatch(R_EARTH, ocean);
    const toS = (v: Vec3) => new THREE.Vector3(v.x, v.z, -v.y);
    const upB = fixed;
    let eastB = cross(vec(0, 0, 1), upB);
    if (len(eastB) < 1e-6) eastB = vec(0, 1, 0);
    eastB = norm(eastB);
    const northB = cross(upB, eastB);
    const m = new THREE.Matrix4().makeBasis(toS(upB), toS(northB), toS(scale(eastB, -1)));
    this.patch.group.quaternion.setFromRotationMatrix(m);
    this.patch.group.position.copy(toS(scale(upB, R_EARTH - 1)));
    this.map.world.earth.spin.add(this.patch.group);
  }

  protected override teardown(): void {
    this.surfaceView?.dispose();
    this.glow?.dispose();
    this.patch?.dispose();
    super.teardown();
  }

  protected override extraDebug(): Record<string, unknown> {
    const base = super.extraDebug();
    const e = this.entry;
    return {
      ...base,
      mode: this.mode,
      altitude: this.mode === 'entry' && e ? e.altitude : this.mode === 'orbit' ? this.flight.altitude : this.ascent?.altitude,
      gamma: this.approach()?.gamma ?? null,
      peakG: e?.peakG ?? null,
      splash: e?.splash ?? null,
      maxWarp: this.maxWarp(),
    };
  }

  override debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'liftoff') this.liftoff();
    else if (cmd === 'autopilot') (this.mode === 'entry' ? this.setEntryAutopilot(Boolean(arg)) : this.setAutopilot(Boolean(arg)));
    else if (cmd === 'fastAscent') this.fast = Boolean(arg);
    else return super.debugCommand(cmd, arg);
    return this.debugState();
  }
}
