import * as THREE from 'three';
import { EARTH, earthRotation, rotationVelocity } from '../physics/bodies';
import { DEG, P0, R_EARTH } from '../physics/constants';
import { FixedStepper } from '../physics/integrator';
import { propagateKepler } from '../physics/kepler';
import { predictTrajectory } from '../physics/patched';
import { add, len, norm, scale, vec, type Vec3 } from '../physics/vec';
import { MU_EARTH } from '../physics/constants';
import { eciDirToScene, eciToScene, sceneDirToEci } from '../render/coords';
import { createLaunchSite, type LaunchSite } from '../render/launchSite';
import { MapView } from '../render/MapView';
import { createPlume, plumeColorFor, type Plume } from '../render/plume';
import { SmokeSystem } from '../render/smoke';
import { setStarBrightness } from '../render/starfield';
import { buildVehicleModel, type VehicleModel } from '../render/vehicleMesh';
import { SUN_DIRECTION_ECI } from '../render/World';
import { ASCENT_STEP, AscentSim, ascentAutopilot, DEFAULT_GUIDANCE, kickForTwr, TARGET_ALTITUDE, type AscentControls, type AscentGuidance } from '../sim/ascent';
import type { Mission } from '../sim/mission';
import { STANDARD_EPHEMERIS } from '../sim/presets';
import { buildResult, linearScore, toleranceScore, type Metric } from '../sim/scoring';
import type { ChannelDef } from '../sim/telemetry';
import { formatDistance, formatSpeed } from '../sim/time';
import { DEFAULT_DESIGN, type VehicleDesign, type VehicleState } from '../sim/vehicle';
import type { TelemetryRow } from '../ui/Hud';
import { h } from '../ui/dom';
import { FlightScreen } from './FlightScreen';
import type { TrackSample } from '../sim/replay';
import type { Ephemeris } from '../physics/bodies';

type CamMode = 'chase' | 'pad' | 'map';

interface Debris {
  obj: THREE.Object3D;
  r0: Vec3;
  v0: Vec3;
  t0: number;
  spin: THREE.Vector3;
}

interface LaunchSnapshot {
  aoa: number;
  q: number;
  g: number;
  alt: number;
  prop: number;
  stage: number;
}

/** Phase 2: launch and ascent to a parking orbit. */
export class LaunchScreen extends FlightScreen<LaunchSnapshot> {
  readonly id = 'launch';
  private sim!: AscentSim;
  private map!: MapView;
  private model!: VehicleModel;
  private site!: LaunchSite;
  private plumes: { stage: number; plume: Plume }[] = [];
  private smoke!: SmokeSystem;
  private trail!: THREE.Line;
  private trailPts: number[] = [];
  private trailTimer = 0;
  private debris: Debris[] = [];
  private stepper = new FixedStepper(ASCENT_STEP, 3000);
  private counting = false;
  private autopilot = false;
  private guidance: AscentGuidance = DEFAULT_GUIDANCE;
  private progradeAssist = false;
  private cmd: AscentControls = { throttle: 0, pitch: 0 };
  private keys = new Set<string>();
  private camMode: CamMode = 'chase';
  private renderedStage = 0;
  private lesShown = true;
  private time = 0;
  private predictTimer = 0;
  private lastCountdown = 99;
  private fastWarp = false;
  private lowPropWarned = new Set<number>();
  private apButton!: HTMLButtonElement;
  private launchButton!: HTMLButtonElement;
  private gauges!: HTMLElement;
  // Scattered skylight in the lower atmosphere (the Sun is overhead at launch).
  private skyLight = new THREE.HemisphereLight(0xbcd6ff, 0x5a5040, 0);

  constructor(mission: Mission) {
    super(mission);
  }

  // ---- Setup ------------------------------------------------------------------
  protected setup(): void {
    const vehicleState = this.mission.carry.vehicle as VehicleState | undefined;
    const design = (this.mission.carry.design as VehicleDesign | undefined) ?? DEFAULT_DESIGN;
    this.sim = new AscentSim(vehicleState ?? design, STANDARD_EPHEMERIS, -10);
    this.guidance = { ...DEFAULT_GUIDANCE, kick: kickForTwr(this.sim.vehicle.analysis.liftoffTwr) };
    this.t = this.sim.t;

    this.map = new MapView(this.app, this.ui);
    this.map.world.eph = this.sim.eph;
    this.map.focus = 'vessel';
    this.map.markerHideDistance = 3e5;
    this.map.showPrediction(false);

    this.model = buildVehicleModel(this.sim.vehicle.state.design, { segments: this.app.quality.level === 'low' ? 16 : 32 });
    this.map.setVesselModel(this.model.root);
    for (const n of this.model.nozzles) {
      const stageParts = this.sim.vehicle.analysis.stages[n.stage].parts;
      const eng = stageParts.find((p) => p.engine);
      const plume = createPlume(n.radius, plumeColorFor(eng?.id ?? ''));
      plume.mesh.position.copy(n.position);
      this.model.stages[n.stage].add(plume.mesh);
      this.plumes.push({ stage: n.stage, plume });
    }
    this.site = createLaunchSite(R_EARTH, this.model.height, this.app.quality.level === 'low' ? 512 : 1024);
    this.attachToEarth();
    this.smoke = new SmokeSystem(this.app.quality.particleCount * 2);
    this.map.world.scene.add(this.smoke.points, this.skyLight);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.app.quality.trailPoints * 3), 3));
    trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.55 }));
    this.trail.frustumCulled = false;
    this.attachTrail();

    const cam = this.map.cam;
    cam.minDistance = 15;
    cam.setDistance(this.model.height * 1.4 + 40, true);
    cam.setAngles(-0.9, 0.12, true);

    this.apButton = h('button', { class: 'btn btn-small', id: 'btn-autopilot', text: 'Autopilot: OFF', onclick: () => this.setAutopilot(!this.autopilot) });
    this.launchButton = h('button', { class: 'btn btn-small btn-primary', id: 'btn-launch', text: 'Start countdown (Space)', onclick: () => this.startCountdown() });
    this.gauges = h('div', { class: 'gauges mono' });
    this.hud.setControls(
      this.launchButton,
      this.apButton,
      h('button', { class: 'btn btn-small', id: 'btn-stage', text: 'Stage (Space)', onclick: () => this.doStage() }),
      h('button', { class: 'btn btn-small', id: 'btn-prograde', text: 'Prograde assist (T)', onclick: () => this.toggleAssist() }),
      h('button', { class: 'btn btn-small', id: 'btn-camera', text: 'Camera (C)', onclick: () => this.cycleCamera() }),
      this.gauges,
    );
    this.hud.setHint('W/S pitch over/up · Shift/Ctrl throttle · Z full · X cut · Space stage · T prograde assist · G autopilot · C camera · M map');
    this.callouts.say(this.t, 'FLIGHT', 'All stations, this is Flight. We are holding at T-minus 10 seconds. Go for launch on your call.');
    this.callouts.addRules([
      { id: 'aoa', role: 'GUIDO', kind: 'warn', text: (s) => `High angle of attack: ${s.aoa.toFixed(0)} deg at ${(s.q / 1000).toFixed(0)} kPa!`, when: (s) => s.q > 8_000 && s.aoa > 7, rearm: (s) => s.aoa < 3 },
      { id: 'g', role: 'SURGEON', kind: 'warn', text: (s) => `Crew is pulling ${s.g.toFixed(1)} g.`, when: (s) => s.g > 5.5, rearm: (s) => s.g < 4.5 },
    ]);
  }

  private attachToEarth(): void {
    this.site.group.position.set(R_EARTH, 0, 0); // body-fixed lat 0, lon 0 (scene axes)
    this.map.world.earth.spin.add(this.site.group);
  }

  private attachTrail(): void {
    this.map.world.earth.spin.add(this.trail);
  }

  // ---- Controls ---------------------------------------------------------------
  private startCountdown(): void {
    if (this.counting) return;
    this.counting = true;
    this.launchButton.disabled = true;
    this.launchButton.textContent = 'Counting down';
    this.callouts.say(this.t, 'CONTROL', 'T-minus 10 and counting.');
  }

  private setAutopilot(on: boolean): void {
    this.autopilot = on;
    this.apButton.textContent = `Autopilot: ${on ? 'ON' : 'OFF'}`;
    this.apButton.classList.toggle('active', on);
    if (on) this.progradeAssist = false;
  }

  private toggleAssist(): void {
    this.progradeAssist = !this.progradeAssist;
    if (this.progradeAssist) this.setAutopilot(false);
    this.app.toast(`Prograde assist ${this.progradeAssist ? 'on' : 'off'}`, 'info', 1200);
  }

  private doStage(): void {
    if (!this.counting) {
      this.startCountdown();
      return;
    }
    if (this.sim.launched) this.sim.stage();
  }

  private cycleCamera(): void {
    const order: CamMode[] = ['chase', 'pad', 'map'];
    this.setCamera(order[(order.indexOf(this.camMode) + 1) % order.length]);
  }

  private setCamera(m: CamMode): void {
    this.camMode = m;
    this.map.cameraOverride = m === 'pad' ? this.padCamera : null;
    if (m === 'map') {
      this.map.setFocus('earth');
      this.map.cam.setDistance(R_EARTH * 3.2);
      this.map.showPrediction(true);
      this.predictTimer = 0;
    } else {
      this.map.focus = 'vessel';
      this.map.showPrediction(false);
      if (m === 'chase') this.map.cam.setDistance(this.model.height * 1.4 + 40);
    }
  }

  /** Fixed ground camera 900 m from the pad, tracking the vehicle with a zoom lens. */
  private padCamera = (camera: THREE.PerspectiveCamera, origin: Vec3): void => {
    const rot = earthRotation(this.t, this.sim.eph);
    const c = Math.cos(rot), s = Math.sin(rot);
    // Body-fixed camera position: 900 m south-west of the pad, 3 m up.
    const bx = R_EARTH + 3, by = -700, bz = -560;
    const eci = { x: bx * c - by * s, y: bx * s + by * c, z: bz };
    const p = eciToScene(eci, origin);
    camera.position.copy(p);
    camera.up.copy(eciDirToScene(norm(eci)));
    camera.lookAt(0, this.model.height * 0.35, 0);
    const d = p.length();
    camera.fov = THREE.MathUtils.clamp((2 * Math.atan((this.model.height * 0.9) / d)) / DEG, 0.5, 50);
    camera.near = 1;
    camera.updateProjectionMatrix();
  };

  protected override onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    if (e.key === ' ') {
      e.preventDefault();
      this.doStage();
    } else if (k === 'z') {
      this.manual();
      this.cmd.throttle = 1;
    } else if (k === 'x') {
      this.manual();
      this.cmd.throttle = 0;
    } else if (k === 'g') this.setAutopilot(!this.autopilot);
    else if (k === 't') this.toggleAssist();
    else if (k === 'c') this.cycleCamera();
    else if (k === 'm') this.setCamera(this.camMode === 'map' ? 'chase' : 'map');
  }

  /** Any manual input disengages the autopilot. */
  private manual(): void {
    this.everManual = true;
    if (this.autopilot) {
      this.setAutopilot(false);
      this.app.toast('Autopilot disengaged', 'warn', 1500);
    }
  }

  private readManual(dt: number): void {
    const k = this.keys;
    if (k.has('w') || k.has('s')) {
      this.manual();
      this.progradeAssist = false;
      this.cmd.pitch = Math.max(0, Math.min(110, this.cmd.pitch + (k.has('w') ? 10 : -10) * dt));
    }
    if (k.has('shift') || k.has('control')) {
      this.manual();
      this.cmd.throttle = Math.max(0, Math.min(1, this.cmd.throttle + (k.has('shift') ? 0.7 : -0.7) * dt));
    }
  }

  // ---- Simulation -------------------------------------------------------------
  protected maxWarp(): number {
    if (!this.counting) return 1;
    return this.fastWarp ? 100 : 10;
  }

  protected simulate(dt: number): void {
    if (!this.counting) return;
    this.stepper.advance(dt, (hh) => {
      if (this.ended || this.sim.failed) return;
      let c: AscentControls;
      if (this.autopilot) {
        c = ascentAutopilot(this.sim, this.guidance);
        this.cmd = { ...c };
      } else {
        // Automatic ignition at T-3 for a manual launch.
        if (this.sim.t >= -3 && !this.sim.launched && this.cmd.throttle === 0 && this.sim.t < 0) this.cmd.throttle = 1;
        if (this.progradeAssist && this.sim.launched && this.sim.altitude > 300) {
          const f = this.sim.forces;
          const up = this.sim.frame.up;
          const air = len(f.airVelocity) > 50 ? f.airVelocity : this.sim.v;
          const pro = Math.acos(Math.max(-1, Math.min(1, (air.x * up.x + air.y * up.y + air.z * up.z) / len(air)))) / DEG;
          this.cmd.pitch = pro;
        }
        c = this.cmd;
      }
      this.sim.step(c, hh);
    });
    this.t = this.sim.t;
    this.handleEvents();
    if (this.sim.failed) {
      this.fail(this.sim.failed);
      return;
    }
    // Countdown callouts.
    if (!this.sim.launched && this.sim.t < 0) {
      const sec = Math.ceil(-this.sim.t);
      if (sec !== this.lastCountdown && (sec <= 5 || sec === 10)) {
        this.lastCountdown = sec;
        if (sec < 10) this.callouts.say(this.t, 'CONTROL', `${sec}...`);
      }
    }
    // Low propellant warnings.
    const st = this.sim.vehicle.state.stage;
    const info = this.sim.vehicle.stageInfo;
    if (info && info.propMass > 0 && this.sim.vehicle.prop / info.propMass < 0.08 && !this.lowPropWarned.has(st) && this.sim.launched) {
      this.lowPropWarned.add(st);
      this.callouts.say(this.t, 'BOOSTER', `Stage ${st + 1} propellant low.`, 'warn');
    }
    // Suborbital: fell back into the atmosphere after reaching space.
    if (this.sim.launched && this.sim.altitude < 45_000 && this.sim.verticalSpeed < -100 && !this.sim.engineOn && this.sim.apoapsisAltitude < 140_000 && this.t > 120) {
      this.fail('Suborbital: the vehicle ran out of energy and fell back into the atmosphere. Stage earlier, fly a flatter trajectory, or add delta-v.');
      return;
    }
    if (this.sim.coastTime > 3) this.complete();
  }

  private handleEvents(): void {
    const evs = this.sim.events.splice(0);
    for (const e of evs) {
      const t = e.t;
      switch (e.kind) {
        case 'ignition':
          this.callouts.say(t, 'CONTROL', 'Ignition sequence start.');
          break;
        case 'liftoff':
          this.callouts.say(t, 'CONTROL', 'Liftoff! We have liftoff.', 'good');
          this.telemetry.mark(t, 'Liftoff');
          break;
        case 'tower-clear':
          this.callouts.say(t, 'CAPCOM', 'Tower cleared.');
          break;
        case 'pitch-program':
          this.callouts.say(t, 'GUIDO', 'Pitch program initiated.');
          break;
        case 'mach1':
          this.callouts.say(t, 'BOOSTER', 'Mach one.');
          break;
        case 'max-q':
          this.callouts.say(t, 'FLIGHT', `Max Q, ${e.detail}. Vehicle is performing nominally.`, 'good');
          this.telemetry.mark(t, 'Max Q');
          break;
        case 'staging':
          this.callouts.say(t, 'BOOSTER', `Staging. ${e.detail}, next stage ignition.`);
          this.telemetry.mark(t, 'Staging');
          break;
        case 'les-jettison':
          this.callouts.say(t, 'CAPCOM', 'Tower jettison confirmed.');
          break;
        case 'flameout':
          this.callouts.say(t, 'BOOSTER', `${e.detail} propellant depletion, cutoff.`, 'warn');
          break;
        case 'space':
          this.callouts.say(t, 'CAPCOM', "100 kilometers. You're in space.");
          break;
        case 'go-orbit':
          this.callouts.say(t, 'FIDO', 'Flight, we are GO for orbit.', 'good');
          break;
        case 'meco':
          this.callouts.say(t, 'BOOSTER', 'Engine cutoff.');
          break;
        default:
          break;
      }
    }
  }

  private fail(reason: string): void {
    const metrics: Metric[] = [
      { label: 'Altitude reached', value: formatDistance(this.sim.altitude), score: linearScore(this.sim.altitude, 185e3, 0), weight: 1 },
    ];
    this.finish(buildResult('launch', this.t, false, metrics, [reason], 'The ascent ended in a loss of vehicle.'));
  }

  private complete(): void {
    const sim = this.sim;
    const apo = sim.apoapsisAltitude;
    const pe = sim.periapsisAltitude;
    const ra = R_EARTH + apo;
    const el = sim.elements();
    const va = Math.sqrt(MU_EARTH * (2 / ra - 1 / el.a));
    const circDv = Math.max(0, Math.sqrt(MU_EARTH / ra) - va);
    const findings: string[] = [];
    if (sim.maxQ > 40_000) findings.push(`Max Q reached ${(sim.maxQ / 1000).toFixed(1)} kPa (target under 35): throttle down or pitch later through the transonic region.`);
    if (sim.maxG > 5) findings.push(`Peak g-load ${sim.maxG.toFixed(1)} g: throttle the upper stages to keep the crew under 4.5 g.`);
    if (circDv > 150) findings.push(`Periapsis ${formatDistance(pe)}: circularizing at apoapsis will cost ${circDv.toFixed(0)} m/s.`);
    if (sim.dvUsed > 9_800) findings.push(`Ascent used ${(sim.dvUsed / 1000).toFixed(2)} km/s against a 9.40 km/s allocation: steeper-than-needed climb or late pitch-over.`);
    if (Math.abs(apo - TARGET_ALTITUDE) > 40e3) findings.push(`Apoapsis ${formatDistance(apo)} vs 185 km target.`);
    const metrics: Metric[] = [
      { label: 'Ascent delta-v', value: `${(sim.dvUsed / 1000).toFixed(2)} km/s`, score: linearScore(sim.dvUsed, 9_200, 10_600), weight: 3, target: 'Allocation 9.40 km/s; 9.2 or less is excellent' },
      { label: 'Apoapsis', value: formatDistance(apo), score: toleranceScore(apo, TARGET_ALTITUDE, 15e3, 120e3), weight: 2, target: '185 km parking orbit' },
      { label: 'Circularization needed', value: `${circDv.toFixed(0)} m/s`, score: linearScore(circDv, 30, 500), weight: 2 },
      { label: 'Max Q', value: `${(sim.maxQ / 1000).toFixed(1)} kPa`, score: linearScore(sim.maxQ, 35_000, 65_000), weight: 1 },
      { label: 'Peak g-load', value: `${sim.maxG.toFixed(2)} g`, score: linearScore(sim.maxG, 4.5, 8), weight: 1 },
      { label: 'Piloting', value: this.flownByAutopilot ? 'Autopilot' : 'Manual', score: this.flownByAutopilot ? 0.6 : 1, weight: 1 },
    ];
    this.finish(
      buildResult('launch', this.t, true, metrics, findings, `Insertion: ${formatDistance(apo)} x ${formatDistance(pe)}, ${(sim.dvUsed / 1000).toFixed(2)} km/s used, stage ${sim.vehicle.state.stage + 1} of ${sim.vehicle.stageCount} still attached.`),
      { vehicle: structuredClone(sim.vehicle.state), flight: { orbit: sim.orbitState(), eph: sim.eph } },
    );
  }

  // Any manual pitch/throttle input marks the flight as hand-flown (scored higher).
  private everManual = false;
  private get flownByAutopilot(): boolean {
    return !this.everManual;
  }

  // ---- HUD --------------------------------------------------------------------
  protected telemetryRows(): TelemetryRow[] {
    const s = this.sim;
    const f = s.forces;
    const v = s.vehicle;
    const status = !this.counting ? 'HOLD T-10' : !s.launched ? 'COUNTDOWN' : s.engineOn ? 'POWERED FLIGHT' : 'COAST';
    return [
      { id: 'status', label: 'Status', value: status, cls: s.launched ? 'good' : '' },
      { id: 'alt', label: 'Altitude', value: formatDistance(s.altitude) },
      { id: 'vs', label: 'Vertical speed', value: formatSpeed(s.verticalSpeed) },
      { id: 'ss', label: 'Surface speed', value: formatSpeed(s.surfaceSpeed) },
      { id: 'os', label: 'Orbital speed', value: formatSpeed(len(s.v)) },
      { id: 'apo', label: 'Apoapsis', value: s.altitude > 1000 ? formatDistance(s.apoapsisAltitude) : '--', cls: s.apoapsisAltitude > 140e3 ? 'good' : '' },
      { id: 'pe', label: 'Periapsis', value: s.altitude > 1000 ? formatDistance(Math.max(-R_EARTH, s.periapsisAltitude)) : '--', cls: s.periapsisAltitude > 140e3 ? 'good' : '' },
      { id: 'dr', label: 'Downrange', value: formatDistance(s.downrange) },
      { id: 'q', label: 'Dyn. pressure', value: `${(f.q / 1000).toFixed(1)} kPa (max ${(s.maxQ / 1000).toFixed(1)})`, cls: f.q > 40_000 ? 'warn' : '' },
      { id: 'mach', label: 'Mach', value: f.mach.toFixed(2) },
      { id: 'g', label: 'G-load', value: `${f.gLoad.toFixed(2)} g`, cls: f.gLoad > 5 ? 'warn' : '' },
      { id: 'aoa', label: 'Angle of attack', value: `${s.aoa.toFixed(1)}°`, cls: s.aoa > 6 && f.q > 8000 ? 'bad' : '' },
      { id: 'stage', label: 'Stage', value: `${v.state.stage + 1} / ${v.stageCount}` },
      { id: 'prop', label: 'Stage propellant', value: v.stageInfo?.propMass ? `${((100 * v.prop) / v.stageInfo.propMass).toFixed(0)}%` : '--' },
      { id: 'sdv', label: 'Stage Δv', value: `${v.stageDv.toFixed(0)} m/s` },
      { id: 'tdv', label: 'Total Δv', value: `${v.totalDv.toFixed(0)} m/s` },
    ];
  }

  private updateGauges(): void {
    const thr = Math.round(this.sim.throttle * 100);
    const cmdThr = Math.round(this.cmd.throttle * 100);
    this.gauges.innerHTML = '';
    this.gauges.append(
      h('div', { class: 'gauge' }, h('span', { class: 'muted', text: 'THR' }), h('div', { class: 'gbar' }, h('div', { class: 'gfill', style: { width: `${thr}%` } })), h('span', { text: `${thr}%${cmdThr !== thr ? ` (${cmdThr})` : ''}` })),
      h('div', { class: 'gauge' }, h('span', { class: 'muted', text: 'PITCH' }), h('div', { class: 'gbar' }, h('div', { class: 'gfill pitch', style: { width: `${Math.min(100, (this.sim.pitch / 90) * 100)}%` } })), h('span', { text: `${this.sim.pitch.toFixed(1)}° → ${this.cmd.pitch.toFixed(0)}°` })),
    );
  }

  protected telemetryChannels(): ChannelDef[] {
    return [
      { id: 'alt', label: 'Altitude', unit: 'km', scale: 1e-3 },
      { id: 'speed', label: 'Speed', unit: 'm/s' },
      { id: 'q', label: 'Dynamic pressure', unit: 'kPa', scale: 1e-3 },
      { id: 'g', label: 'G-load', unit: 'g' },
      { id: 'pitch', label: 'Pitch', unit: 'deg' },
      { id: 'throttle', label: 'Throttle', unit: '%', scale: 100 },
      { id: 'apo', label: 'Apoapsis', unit: 'km', scale: 1e-3 },
    ];
  }

  protected telemetrySample(): Record<string, number> {
    const s = this.sim;
    return { alt: s.altitude, speed: len(s.v), q: s.forces.q, g: s.forces.gLoad, pitch: s.pitch, throttle: s.throttle, apo: s.altitude > 1000 ? s.apoapsisAltitude : 0 };
  }

  protected override replaySample(): TrackSample | null {
    const s = this.sim;
    return { body: 'earth', r: s.r, dir: s.thrustDirection, throttle: s.throttle, stage: s.vehicle.state.stage };
  }

  protected override replayContext(): { design: VehicleDesign; eph: Ephemeris } {
    return { design: this.sim.vehicle.state.design, eph: this.sim.eph };
  }

  protected snapshot(): LaunchSnapshot {
    const s = this.sim;
    return { aoa: s.aoa, q: s.forces.q, g: s.forces.gLoad, alt: s.altitude, prop: s.vehicle.prop, stage: s.vehicle.state.stage };
  }

  // ---- Visuals ----------------------------------------------------------------
  protected updateVisuals(dt: number): void {
    this.time += dt;
    if (!this.autopilot && this.counting) this.readManual(dt);
    const s = this.sim;
    const eci = s.r;
    this.map.vesselEci = eci;
    const up = eciDirToScene(s.frame.up);
    if (this.camMode === 'chase') this.map.cam.up.copy(up);
    // Vehicle attitude: +Y along the thrust axis.
    const dir = eciDirToScene(s.thrustDirection);
    this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    // Stage separation visuals.
    while (this.renderedStage < s.vehicle.state.stage) {
      this.detach(this.model.stages[this.renderedStage], vec());
      this.renderedStage++;
    }
    if (this.lesShown && !s.vehicle.state.lesAttached && this.model.les) {
      this.lesShown = false;
      this.detach(this.model.les, scale(s.thrustDirection, 60));
    }
    this.site.setArmsRetracted(s.launched ? Math.min(1, (s.t + 0.5) / 2) : 0);

    // Engines.
    const amb = s.forces.ambientPressure / P0;
    const vac = Math.max(0, Math.min(1, 1 - Math.pow(amb, 0.35)));
    for (const p of this.plumes) p.plume.update(p.stage === s.vehicle.state.stage ? s.throttle : 0, vac, this.time);

    // Smoke near the ground and in the lower atmosphere.
    const origin = this.map.origin();
    const air = rotationVelocity(EARTH, eci);
    if (s.throttle > 0 && s.altitude < 14_000 && this.app.quality.particleCount > 0) {
      const back = scale(s.thrustDirection, -1);
      const at = add(eci, scale(back, s.altitude < 30 ? 0 : 6));
      const onPad = !s.launched || s.altitude < 60;
      const spray = onPad ? scale(norm(add(back, scale(s.frame.east, 0.9))), 1) : back;
      this.smoke.emit(dt, onPad ? 260 : 120 * (1 - s.altitude / 14_000) + 20, at, onPad ? air : add(s.v, scale(back, 40)), spray, onPad ? 60 : 30, this.model.nozzles[0]?.radius * 6 || 20, onPad ? 9 : 14);
    }
    this.smoke.setViewportHeight(this.app.height, this.map.camera.fov);
    const sunUp = eciDirToScene(SUN_DIRECTION_ECI).dot(up);
    this.smoke.setLight(0.35 + 0.65 * Math.max(0, sunUp));
    this.smoke.update(dt, origin, air);

    // Trail (body-fixed coordinates in the rotating Earth group).
    this.trailTimer -= dt;
    if (s.launched && this.trailTimer <= 0 && s.altitude > 50) {
      this.trailTimer = 0.25;
      const rot = earthRotation(s.t, s.eph);
      const c = Math.cos(-rot), sn = Math.sin(-rot);
      const bx = eci.x * c - eci.y * sn, by = eci.x * sn + eci.y * c, bz = eci.z;
      this.trailPts.push(bx, bz, -by);
      const maxPts = this.app.quality.trailPoints;
      if (this.trailPts.length > maxPts * 3) this.trailPts.splice(0, this.trailPts.length - maxPts * 3);
      const attr = this.trail.geometry.attributes.position as THREE.BufferAttribute;
      (attr.array as Float32Array).set(this.trailPts);
      attr.needsUpdate = true;
      this.trail.geometry.setDrawRange(0, this.trailPts.length / 3);
    }

    // Debris.
    for (const d of this.debris) {
      const st = propagateKepler(d.r0, d.v0, s.t - d.t0, MU_EARTH);
      eciToScene(st.r, origin, d.obj.position);
      d.obj.rotateX(d.spin.x * dt);
      d.obj.rotateZ(d.spin.z * dt);
      if (len(st.r) < R_EARTH || s.t - d.t0 > 120) d.obj.visible = false;
    }

    // Sky: blue near the ground on the day side, fading to black with altitude.
    const day = THREE.MathUtils.clamp(sunUp * 2 + 0.25, 0, 1);
    const airF = 1 - THREE.MathUtils.smoothstep(s.altitude, 2_000, 70_000);
    const sky = new THREE.Color(0.24, 0.45, 0.82).multiplyScalar(day * airF);
    this.map.world.scene.background = sky;
    this.skyLight.intensity = 1.6 * day * airF;
    this.skyLight.position.copy(up);
    const camAlt = this.map.camera.position.clone().sub(this.map.world.earth.group.position).length() - R_EARTH;
    this.map.world.earth.setAtmosphereIntensity(0.12 + 0.88 * THREE.MathUtils.smoothstep(camAlt, 5_000, 90_000));
    setStarBrightness(this.map.world.stars, 1 - Math.max(0, Math.min(1, day * airF * 1.6)));
    this.site.setGroundOpacity(1 - THREE.MathUtils.smoothstep(s.altitude, 6_000, 40_000));

    // Map-mode trajectory.
    if (this.camMode === 'map') {
      this.predictTimer -= dt;
      if (this.predictTimer <= 0 && s.altitude > 20_000) {
        this.predictTimer = 0.5;
        const pred = predictTrajectory(s.orbitState(), 6000, { eph: s.eph, maxSegments: 1, stopAtAtmosphere: false });
        this.map.vesselBody = 'earth';
        this.map.setPrediction(pred);
      }
    }

    this.map.update(this.t, dt);
    this.updateGauges();
    const statusText = !this.counting ? 'HOLDING AT T-10' : !s.launched ? `T${s.t < 0 ? '-' : '+'}${Math.abs(s.t).toFixed(0)}` : this.autopilot ? 'AUTOPILOT' : this.progradeAssist ? 'PROGRADE ASSIST' : 'MANUAL';
    this.hud.setStatus(this.ended ? '' : statusText, this.autopilot ? 'good' : 'info');
  }

  /** Detach part of the model as free-falling debris. */
  private detach(obj: THREE.Object3D, extraVel: Vec3): void {
    const scene = this.map.world.scene;
    const vesselScene = this.model.root.position.clone();
    scene.attach(obj);
    const off = sceneDirToEci(obj.position.clone().sub(vesselScene));
    const r0 = add(this.sim.r, off);
    this.debris.push({ obj, r0, v0: add(this.sim.v, extraVel), t0: this.sim.t, spin: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4) });
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.map.render(renderer);
  }

  onQualityChange(): void {
    this.map.onQualityChange();
    this.attachToEarth();
    this.attachTrail();
  }

  protected override teardown(): void {
    for (const p of this.plumes) p.plume.dispose();
    this.smoke.dispose();
    this.trail.geometry.dispose();
    (this.trail.material as THREE.Material).dispose();
    this.site.dispose();
    this.model.dispose();
    this.map.dispose();
  }

  protected override extraDebug(): Record<string, unknown> {
    const s = this.sim;
    return {
      launched: s.launched,
      altitude: s.altitude,
      apoapsis: s.apoapsisAltitude,
      periapsis: s.periapsisAltitude,
      stage: s.vehicle.state.stage,
      autopilot: this.autopilot,
      failed: s.failed,
      dvUsed: s.dvUsed,
      camera: this.camMode,
    };
  }

  override debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'autopilot') this.setAutopilot(Boolean(arg));
    else if (cmd === 'launch') this.startCountdown();
    else if (cmd === 'fast') this.fastWarp = Boolean(arg);
    else if (cmd === 'warp') this.setWarpLevel(Number(arg));
    else if (cmd === 'camera') this.setCamera(arg as CamMode);
    return this.debugState();
  }
}

