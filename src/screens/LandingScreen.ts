import * as THREE from 'three';
import { MOON, moonPosition, type Ephemeris } from '../physics/bodies';
import { DEG, R_MOON } from '../physics/constants';
import { FixedStepper } from '../physics/integrator';
import { captureDeltaV } from '../physics/maneuver';
import type { OrbitState } from '../physics/patched';
import { add, cross, len, norm, scale, vec, type Vec3 } from '../physics/vec';
import { eciDirToScene } from '../render/coords';
import { SmokeSystem } from '../render/smoke';
import { setStarBrightness } from '../render/starfield';
import { TerrainTile } from '../render/terrainMesh';
import { SUN_DIRECTION_ECI } from '../render/World';
import { DESCENT_STEP, DescentSim, descentAutopilot, findSafeSite, type DescentControls } from '../sim/descent';
import type { Mission } from '../sim/mission';
import { OrbitalFlight, planDoi, refineNodeFinite } from '../sim/orbital';
import { landingPreset } from '../sim/presets';
import { buildResult, linearScore, type Metric } from '../sim/scoring';
import type { ChannelDef } from '../sim/telemetry';
import { formatDistance, formatDuration, formatSpeed } from '../sim/time';
import type { VehicleState } from '../sim/vehicle';
import type { TelemetryRow } from '../ui/Hud';
import type { Planner } from '../ui/ManeuverPanel';
import { h } from '../ui/dom';
import { OrbitalScreen } from './OrbitalScreen';

type Mode = 'orbit' | 'descent' | 'surface';

/** Phase 5: lunar orbit insertion, descent orbit, and the powered descent to touchdown. */
export class LandingScreen extends OrbitalScreen {
  readonly id = 'landing';
  private mode: Mode = 'orbit';
  private descent: DescentSim | null = null;
  private tile: TerrainTile | null = null;
  private dust: SmokeSystem | null = null;
  private stepper = new FixedStepper(DESCENT_STEP, 4000);
  private autopilot = false;
  private everManual = false;
  private pitch = 0; // deg, thrust tilted back (braking) positive
  private yaw = 0; // deg, thrust tilted right positive
  private hold: 'manual' | 'retrograde' | 'vertical' = 'retrograde';
  private heading: Vec3 = vec(0, 1, 0);
  private manualThrottle = 0;
  private idealLoi = 0;
  private orbitDv = 0;
  private pdiButton!: HTMLButtonElement;
  private apButton!: HTMLButtonElement;
  private suggested: { x: number; y: number; slope: number } | null = null;
  private suggestTimer = 0;
  private landedAt = Infinity;
  private fastDescent = false;

  constructor(mission: Mission) {
    super(mission);
  }

  // ---- Orbit mode --------------------------------------------------------------
  protected initialFlight(): OrbitalFlight {
    const carried = this.mission.carry.flight as { orbit: OrbitState; eph: Ephemeris } | undefined;
    const vehicle = this.mission.carry.vehicle as VehicleState | undefined;
    if (carried && vehicle) return new OrbitalFlight(carried.orbit, vehicle, carried.eph);
    const p = landingPreset();
    return new OrbitalFlight(p.orbit, p.vehicle, p.eph);
  }

  protected override phaseSetup(): void {
    const f = this.flight;
    this.map.setFocus('moon');
    this.map.cam.setDistance(R_MOON * 6, true);
    this.map.cam.setAngles(0.3, 0.9, true);
    if (f.s.body === 'moon') {
      const el = f.elements();
      const vInf = el.energy > 0 ? Math.sqrt(2 * el.energy) : 0;
      this.idealLoi = captureDeltaV(MOON.mu, vInf, el.rp);
    }
    this.pdiButton = h('button', { class: 'btn btn-small btn-primary', id: 'btn-pdi', text: 'Begin powered descent', disabled: true, onclick: () => this.beginDescent() }) as HTMLButtonElement;
    this.apButton = h('button', { class: 'btn btn-small', id: 'btn-autopilot', text: 'Landing autopilot: OFF', onclick: () => this.setAutopilot(!this.autopilot) }) as HTMLButtonElement;
    this.hud.controls.append(this.pdiButton);
    this.callouts.say(this.t, 'FIDO', `Flight, approaching the Moon. Periapsis ${formatDistance(f.elements().rp - R_MOON)}. Lunar orbit insertion is a retrograde burn at periapsis.`);
  }

  protected planners(): Planner[] {
    if (this.mode !== 'orbit') return [];
    return [
      {
        id: 'loi',
        label: 'LOI: circularize at Pe',
        title: 'Retrograde burn at periapsis into a circular lunar orbit (finite-burn corrected)',
        run: () => {
          const n = this.flight.circularizeNode('periapsis');
          if (!n) return 'No periapsis ahead.';
          return refineNodeFinite(this.flight, n);
        },
      },
      {
        id: 'doi',
        label: 'DOI: Pe 15 km, morning sun',
        title: 'Lower periapsis to 15 km over terrain lit by a low morning sun (~20 deg)',
        run: () => planDoi(this.flight, SUN_DIRECTION_ECI) ?? 'Circularize in lunar orbit first.',
      },
    ];
  }

  protected predictionHorizon(): number {
    const el = this.flight.elements();
    return this.flight.s.body === 'moon' && el.e < 1 ? el.period * 1.2 : 2 * 86400;
  }

  protected nodeResult(): { text: string; cls?: string }[] {
    const p = this.planned;
    if (!p) return [];
    const seg = p.segments.find((s) => s.body === 'moon');
    if (!seg) return [{ text: 'Leaves lunar SOI', cls: 'bad' }];
    const el = seg.elements;
    if (p.events.some((e) => e.kind === 'impact')) return [{ text: 'IMPACT trajectory', cls: 'bad' }];
    return [{ text: el.e < 1 ? `Lunar orbit ${formatDistance(el.ra - R_MOON)} x ${formatDistance(el.rp - R_MOON)}` : `Hyperbolic, Pe ${formatDistance(el.rp - R_MOON)}`, cls: el.e < 1 ? 'good' : 'warn' }];
  }

  protected phaseRows(): TelemetryRow[] {
    return [];
  }

  protected statusText(): string {
    const f = this.flight;
    if (f.s.body !== 'moon') return 'LUNAR APPROACH';
    return f.elements().e < 1 ? 'LUNAR ORBIT' : 'LUNAR APPROACH';
  }

  protected override onHalt(kind: 'atmosphere' | 'impact' | 'escape'): void {
    if (this.mode !== 'orbit') return;
    if (kind === 'impact') this.fail('The spacecraft struck the Moon without a powered descent.', ['Begin powered descent below 25 km altitude.']);
    else this.fail('Lost the Moon.', []);
  }

  protected checkPhase(): void {
    if (this.mode !== 'orbit') return;
    const f = this.flight;
    const ok = f.s.body === 'moon' && f.altitude < 25e3 && !f.isBurning && !f.autoBurn;
    this.pdiButton.disabled = !ok;
    if (ok && !this.callouts.hasFired('go-pdi')) this.callouts.sayOnce('go-pdi', this.t, 'CAPCOM', 'You are GO for powered descent.', 'good');
    if (f.s.body === 'earth' && this.t > 3600) this.fail('Missed lunar orbit insertion: the spacecraft left the Moon\'s sphere of influence.', []);
  }

  // ---- Descent mode -------------------------------------------------------------
  private beginDescent(): void {
    if (this.mode !== 'orbit') return;
    const f = this.flight;
    this.orbitDv = f.dvUsed;
    // Jettison spent stages below the landing stage.
    while (!f.vehicle.stageInfo?.hasLegs && f.vehicle.hasLegs && f.vehicle.separate()) {
      this.callouts.say(this.t, 'BOOSTER', 'Jettisoning the spent stage below the lander.');
    }
    if (!f.vehicle.stageInfo?.hasLegs) this.callouts.say(this.t, 'FLIGHT', 'Flight, this vehicle has no landing legs. Good luck.', 'bad');
    this.descent = new DescentSim(f.s.r, f.s.v, f.vehicle.state, f.eph, f.t);
    this.heading = norm(this.descent.horizontalVelocity);
    this.mode = 'descent';
    this.panel.root.style.display = 'none';
    this.map.showPrediction(false);
    this.map.setFocus('vessel');
    this.map.cam.minDistance = 8;
    this.map.cam.setDistance(70, true);
    this.map.cam.setAngles(Math.PI, 0.25, true);
    this.tile = new TerrainTile(this.descent.terrain, this.app.quality.terrainResolution);
    this.map.world.moon.spin.add(this.tile.group);
    this.dust = new SmokeSystem(Math.max(60, this.app.quality.particleCount));
    this.map.world.scene.add(this.dust.points);
    this.pdiButton.remove();
    this.hud.setControls(
      this.apButton,
      h('button', { class: 'btn btn-small', id: 'btn-hold-retro', text: 'Retrograde (R)', onclick: () => (this.hold = 'retrograde') }),
      h('button', { class: 'btn btn-small', id: 'btn-hold-vert', text: 'Vertical (V)', onclick: () => (this.hold = 'vertical') }),
    );
    this.hud.setHint('Shift/Ctrl throttle · Z/X full/cut · W/S tilt forward/back · A/D tilt left/right · R retrograde · V vertical · G autopilot · drag to look');
    this.callouts.say(this.t, 'CAPCOM', 'Powered descent initiated. Throttle up.', 'good');
    this.telemetry.mark(this.t, 'PDI');
  }

  private setAutopilot(on: boolean): void {
    this.autopilot = on;
    this.apButton.textContent = `Landing autopilot: ${on ? 'ON' : 'OFF'}`;
    this.apButton.classList.toggle('active', on);
  }

  private manualControls(dt: number): DescentControls {
    const sim = this.descent!;
    const k = this.keys;
    if (k.has('shift')) this.manualThrottle = Math.min(1, this.manualThrottle + dt * 0.6);
    if (k.has('control')) this.manualThrottle = Math.max(0, this.manualThrottle - dt * 0.6);
    const rate = 15 * dt;
    if (k.has('w') || k.has('s') || k.has('a') || k.has('d')) {
      if (this.hold !== 'manual') {
        // Start manual attitude from the current direction.
        this.hold = 'manual';
        const up = sim.up;
        const tiltBack = Math.atan2(-(sim.dir.x * this.heading.x + sim.dir.y * this.heading.y + sim.dir.z * this.heading.z), sim.dir.x * up.x + sim.dir.y * up.y + sim.dir.z * up.z);
        this.pitch = tiltBack / DEG;
        this.yaw = 0;
      }
      if (k.has('s')) this.pitch = Math.min(85, this.pitch + rate);
      if (k.has('w')) this.pitch = Math.max(-85, this.pitch - rate);
      if (k.has('d')) this.yaw = Math.min(45, this.yaw + rate);
      if (k.has('a')) this.yaw = Math.max(-45, this.yaw - rate);
    }
    const up = sim.up;
    if (sim.horizontalSpeed > 3) this.heading = norm(sim.horizontalVelocity);
    const right = norm(cross(this.heading, up));
    let dir: Vec3;
    if (this.hold === 'retrograde' && sim.horizontalSpeed + Math.abs(sim.verticalSpeed) > 0.5) dir = norm(scale(sim.surfaceVelocity, -1));
    else if (this.hold === 'vertical' || this.hold === 'retrograde') dir = up;
    else {
      const p = this.pitch * DEG;
      const y = this.yaw * DEG;
      dir = norm(add(add(scale(up, Math.cos(p) * Math.cos(y)), scale(this.heading, -Math.sin(p))), scale(right, Math.sin(y))));
    }
    return { throttle: this.manualThrottle, dir };
  }

  private simulateDescent(dt: number): void {
    const sim = this.descent!;
    this.stepper.advance(dt, (hh) => {
      if (sim.landed) return;
      let c: DescentControls;
      if (this.autopilot) {
        c = descentAutopilot(sim);
        this.manualThrottle = c.throttle;
      } else c = this.manualControls(hh);
      sim.step(c, hh);
    });
    this.t = sim.t;
    for (const e of sim.events.splice(0)) {
      switch (e.kind) {
        case 'altitude':
          this.callouts.say(e.t, 'CDR', e.detail!);
          break;
        case 'low-fuel':
          this.callouts.say(e.t, 'CONTROL', 'Low level. Descent propellant under 10 percent.', 'warn');
          break;
        case 'fuel-60':
          this.callouts.say(e.t, 'CAPCOM', '60 seconds.', 'warn');
          break;
        case 'fuel-30':
          this.callouts.say(e.t, 'CAPCOM', '30 seconds.', 'bad');
          break;
        case 'out-of-fuel':
          this.callouts.say(e.t, 'CONTROL', 'Descent propellant depleted!', 'bad');
          break;
        case 'dust':
          this.callouts.say(e.t, 'CDR', 'Picking up some dust.');
          break;
        case 'contact':
          this.callouts.say(e.t, 'CDR', 'Contact light.', 'good');
          break;
        case 'touchdown':
        case 'crash':
          this.telemetry.mark(e.t, 'Touchdown');
          this.landedAt = this.t;
          break;
      }
    }
    if (sim.landed && this.t >= this.landedAt) this.finishLanding();
  }

  private finishLanding(): void {
    const sim = this.descent!;
    const td = sim.touchdown!;
    this.mode = 'surface';
    const legsSlope = td.slope / DEG;
    const fuelFrac = sim.vehicle.stageInfo?.propMass ? sim.vehicle.prop / sim.vehicle.stageInfo.propMass : 0;
    if (td.outcome === 'landed') this.callouts.say(this.t, 'CDR', 'Engine stop. Touchdown! The lander is down and safe.', 'good');
    else this.callouts.say(this.t, 'FLIGHT', td.outcome === 'crashed' ? 'We have lost the lander.' : 'The lander is down but not stable.', 'bad');
    const success = td.outcome === 'landed';
    const metrics: Metric[] = [
      { label: 'Touchdown vertical speed', value: `${td.vertical.toFixed(2)} m/s`, score: linearScore(td.vertical, 1.0, 3.0), weight: 2, target: 'Leg limit 3 m/s; under 1 is excellent' },
      { label: 'Touchdown horizontal speed', value: `${td.horizontal.toFixed(2)} m/s`, score: linearScore(td.horizontal, 0.3, 1.5), weight: 2, target: 'Leg limit 1.5 m/s' },
      { label: 'Tilt vs surface', value: `${(td.tilt / DEG).toFixed(1)}°`, score: linearScore(td.tilt / DEG, 2, 12), weight: 1 },
      { label: 'Site slope', value: `${legsSlope.toFixed(1)}°`, score: linearScore(legsSlope, 2, 12), weight: 1, target: 'Flat ground; avoid crater walls and boulders' },
      { label: 'Descent fuel remaining', value: `${(fuelFrac * 100).toFixed(0)}%`, score: linearScore(fuelFrac, 0.2, 0), weight: 2 },
      { label: 'Orbit insertion Δv', value: `${this.orbitDv.toFixed(0)} m/s (ideal ${this.idealLoi.toFixed(0)})`, score: this.idealLoi > 0 ? linearScore(this.orbitDv / (this.idealLoi + 25), 1.02, 1.4) : 0.8, weight: 2, target: 'Ideal: capture at periapsis + ~25 m/s DOI' },
      { label: 'Piloting', value: this.everManual ? 'Hand-flown' : 'Autopilot', score: this.everManual ? 1 : 0.6, weight: 1 },
    ];
    const findings = [...td.reasons];
    if (fuelFrac < 0.05 && success) findings.push('Landed with under 5% descent propellant: dangerously close to an abort.');
    const lat = Math.asin(norm(sim.toFixed(sim.r)).z) / DEG;
    const lon = Math.atan2(sim.toFixed(sim.r).y, sim.toFixed(sim.r).x) / DEG;
    this.finish(
      buildResult('landing', this.t, success, metrics, findings, success ? `Touchdown at ${lat.toFixed(2)}°, ${lon.toFixed(2)}° (selenographic) on a ${legsSlope.toFixed(1)}° slope.` : 'The landing failed.'),
      success ? { vehicle: structuredClone(sim.vehicle.state), surface: { r: sim.toFixed(sim.r), t: this.t, eph: sim.eph } } : undefined,
    );
  }

  private fail(reason: string, extra: string[]): void {
    this.finish(buildResult('landing', this.t, false, [], [reason, ...extra], 'The landing phase failed.'));
  }

  // ---- Overrides that switch on mode -------------------------------------------
  protected override simulate(dt: number): void {
    if (this.mode === 'orbit') super.simulate(dt);
    else if (this.mode === 'descent') this.simulateDescent(dt);
  }

  protected override maxWarp(): number {
    if (this.mode === 'orbit') return super.maxWarp();
    if (this.mode === 'descent') return this.fastDescent ? 20 : 4;
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
    const manualKeys = ['w', 'a', 's', 'd', 'shift', 'control', 'z', 'x'];
    if (manualKeys.includes(k) && this.autopilot) {
      this.setAutopilot(false);
      this.app.toast('Autopilot disengaged', 'warn', 1400);
    }
    if (manualKeys.includes(k)) this.everManual = true;
    if (k === 'z') this.manualThrottle = 1;
    else if (k === 'x') this.manualThrottle = 0;
    else if (k === 'r') this.hold = 'retrograde';
    else if (k === 'v') this.hold = 'vertical';
    else if (k === 'g') this.setAutopilot(!this.autopilot);
  }

  protected override telemetryRows(): TelemetryRow[] {
    if (this.mode === 'orbit') return super.telemetryRows();
    const sim = this.descent!;
    const p = sim.mapPos;
    const slope = sim.terrain.slope(p.x, p.y) / DEG;
    const fuelFrac = sim.vehicle.stageInfo?.propMass ? sim.vehicle.prop / sim.vehicle.stageInfo.propMass : 0;
    const site = sim.site ?? this.suggested;
    return [
      { id: 'ralt', label: 'Radar altitude', value: formatDistance(sim.altitude), cls: sim.altitude < 100 ? 'warn' : '' },
      { id: 'vz', label: 'Vertical speed', value: formatSpeed(sim.verticalSpeed), cls: sim.verticalSpeed < -3 && sim.altitude < 50 ? 'bad' : '' },
      { id: 'vh', label: 'Horizontal speed', value: formatSpeed(sim.horizontalSpeed), cls: sim.horizontalSpeed > 1.5 && sim.altitude < 30 ? 'bad' : '' },
      { id: 'thr', label: 'Throttle', value: `${Math.round(sim.throttle * 100)}%` },
      { id: 'tilt', label: 'Tilt', value: `${(sim.tilt / DEG).toFixed(1)}°` },
      { id: 'fuel', label: 'Descent fuel', value: `${(fuelFrac * 100).toFixed(1)}% (${formatDuration(sim.fuelTime)})`, cls: fuelFrac < 0.1 ? 'bad' : fuelFrac < 0.2 ? 'warn' : '' },
      { id: 'slope', label: 'Slope below', value: `${slope.toFixed(1)}°`, cls: slope > 10 ? 'bad' : slope > 6 ? 'warn' : 'good' },
      { id: 'site', label: 'Safe site', value: site ? `${formatDistance(Math.hypot(site.x - p.x, site.y - p.y))} away` : '--', cls: 'good' },
      { id: 'mass', label: 'Mass', value: `${(sim.vehicle.mass / 1000).toFixed(1)} t` },
      { id: 'dv', label: 'Δv used (descent)', value: `${sim.dvUsed.toFixed(0)} m/s` },
    ];
  }

  protected override telemetryChannels(): ChannelDef[] {
    return [...super.telemetryChannels(), { id: 'ralt', label: 'Radar altitude', unit: 'm' }, { id: 'vz', label: 'Vertical speed', unit: 'm/s' }];
  }

  protected override telemetrySample(): Record<string, number> {
    const base = super.telemetrySample();
    if (this.descent) Object.assign(base, { ralt: this.descent.altitude, vz: this.descent.verticalSpeed, alt: this.descent.altitude });
    return base;
  }

  protected snapshot(): Record<string, number> {
    return { alt: this.mode === 'orbit' ? this.flight.altitude : this.descent!.altitude };
  }

  protected override updateVisuals(dt: number): void {
    if (this.mode === 'orbit') {
      super.updateVisuals(dt);
      return;
    }
    this.time += dt;
    const sim = this.descent!;
    const moonC = moonPosition(this.t, sim.eph);
    const eci = add(moonC, sim.r);
    this.map.vesselEci = eci;
    const up = eciDirToScene(sim.up);
    this.map.cam.up.copy(up);
    const dirS = eciDirToScene(sim.dir);
    this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirS);
    this.syncModelStages(sim.vehicle);
    // Keep the landing-leg pads at the simulated contact point.
    const bottom = this.model.stageBottoms[sim.vehicle.state.stage] ?? 0;
    for (const p of this.plumes) p.plume.update(p.stage === sim.vehicle.state.stage ? sim.throttle : 0, 1, this.time);
    // Terrain and hazards.
    const mp = sim.mapPos;
    this.tile!.update(mp.x, mp.y, sim.altitude);
    this.suggestTimer -= dt;
    if (!this.autopilot && sim.altitude < 600 && this.suggestTimer <= 0 && !sim.landed) {
      this.suggestTimer = 1.5;
      this.suggested = findSafeSite(sim.terrain, mp.x, mp.y, 150, 10);
    }
    this.tile!.setSite(sim.site ?? (sim.altitude < 600 ? this.suggested : null));
    this.map.world.moon.setSurfaceVisible(sim.altitude > 40_000);
    // Dust blown off the surface at low altitude.
    if (this.dust) {
      if (sim.altitude < 25 && sim.throttle > 0.05 && !sim.landed) {
        const ground = add(moonC, scale(sim.up, len(sim.r) - sim.altitude));
        const rnd = Math.random() * Math.PI * 2;
        const e1 = norm(cross(sim.up, vec(0, 0, 1)));
        const e2 = cross(sim.up, e1);
        const spray = norm(add(scale(e1, Math.cos(rnd)), scale(e2, Math.sin(rnd))));
        this.dust.emit(dt, 300 * sim.throttle * (1 - sim.altitude / 25), ground, vec(), spray, 40, 3, 2.5);
      }
      this.dust.setViewportHeight(this.app.height, this.map.camera.fov);
      this.dust.setLight(0.8);
      this.dust.update(dt, this.map.origin(), vec());
    }
    setStarBrightness(this.map.world.stars, 0.35);
    this.map.update(this.t, dt);
    // Offset the model after the map placed it at the vessel point.
    this.model.root.position.addScaledVector(dirS, -bottom);
    const status = sim.landed ? 'TOUCHDOWN' : this.autopilot ? 'LANDING AUTOPILOT' : this.hold === 'retrograde' ? 'RETROGRADE HOLD' : this.hold === 'vertical' ? 'VERTICAL HOLD' : 'MANUAL ATTITUDE';
    this.hud.setStatus(status, sim.altitude < 100 ? 'warn' : 'info');
  }

  protected override teardown(): void {
    this.tile?.dispose();
    this.dust?.dispose();
    super.teardown();
  }

  protected override extraDebug(): Record<string, unknown> {
    const base = super.extraDebug();
    if (!this.descent) return { ...base, mode: this.mode };
    const s = this.descent;
    return { ...base, mode: this.mode, altitude: s.altitude, vz: s.verticalSpeed, vh: s.horizontalSpeed, landed: s.landed, outcome: s.touchdown?.outcome ?? null, maxWarp: this.maxWarp() };
  }

  override debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'pdi') this.beginDescent();
    else if (cmd === 'autopilot') this.setAutopilot(Boolean(arg));
    else if (cmd === 'fastDescent') this.fastDescent = Boolean(arg);
    else return super.debugCommand(cmd, arg);
    return this.debugState();
  }
}
