import * as THREE from 'three';
import { BODIES, MOON, moonPosition } from '../physics/bodies';
import { stateToElements, timeToApoapsis, timeToPeriapsis } from '../physics/kepler';
import { toEci, type Prediction } from '../physics/patched';
import { len, sub } from '../physics/vec';
import { eciDirToScene } from '../render/coords';
import { MapView } from '../render/MapView';
import { createPlume, plumeColorFor, type Plume } from '../render/plume';
import { buildVehicleModel, type VehicleModel } from '../render/vehicleMesh';
import { coastTo, OrbitalFlight, simulateNode, type AttitudeMode, type ManeuverNode } from '../sim/orbital';
import type { ChannelDef } from '../sim/telemetry';
import { formatDistance, formatDuration, formatSpeed } from '../sim/time';
import type { TelemetryRow } from '../ui/Hud';
import { ManeuverPanel, type Planner } from '../ui/ManeuverPanel';
import { h } from '../ui/dom';
import { FlightScreen, WARP_LEVELS } from './FlightScreen';

const ATTITUDES: { id: AttitudeMode; label: string }[] = [
  { id: 'prograde', label: 'PRO' },
  { id: 'retrograde', label: 'RETRO' },
  { id: 'normal', label: 'NRM' },
  { id: 'antinormal', label: 'ANTI' },
  { id: 'radial', label: 'RAD+' },
  { id: 'antiradial', label: 'RAD−' },
  { id: 'node', label: 'NODE' },
];

/**
 * Base for phases flown on patched conics with maneuver nodes: map view,
 * vessel model + plume, maneuver panel, manual attitude/throttle, warp-to-node,
 * periodic re-prediction, burn callouts.
 */
export abstract class OrbitalScreen<S = Record<string, number>> extends FlightScreen<S> {
  protected flight!: OrbitalFlight;
  protected map!: MapView;
  protected model!: VehicleModel;
  protected panel!: ManeuverPanel;
  protected prediction: Prediction | null = null;
  protected planned: Prediction | null = null;
  protected plumes: { stage: number; plume: Plume }[] = [];
  private predictTimer = 0;
  private dirty = true;
  private warpingToNode = false;
  protected keys = new Set<string>();
  private attButtons = new Map<AttitudeMode, HTMLButtonElement>();
  protected time = 0;
  private shownStage = -1;
  /** Phase end time for warp limiting (Infinity if none). */
  protected phaseEndTime = Infinity;
  /** Debug (e2e): allow 100x warp during burns. */
  private fastBurns = false;

  protected abstract initialFlight(): OrbitalFlight;
  protected abstract planners(): Planner[];
  /** Phase-specific end conditions, called after each simulation step. */
  protected abstract checkPhase(): void;
  protected abstract predictionHorizon(): number;
  /** Text shown under the maneuver node (predicted outcome). */
  protected abstract nodeResult(): { text: string; cls?: string }[];
  protected abstract phaseRows(): TelemetryRow[];
  protected abstract statusText(): string;

  protected setup(): void {
    this.flight = this.initialFlight();
    this.t = this.flight.t;
    this.map = new MapView(this.app, this.ui);
    this.map.world.eph = this.flight.eph;
    this.map.markerHideDistance = 5_000;
    this.model = buildVehicleModel(this.flight.vehicle.state.design, { segments: this.app.quality.level === 'low' ? 16 : 28 });
    this.map.setVesselModel(this.model.root);
    for (const n of this.model.nozzles) {
      const eng = this.flight.vehicle.analysis.stages[n.stage].parts.find((p) => p.engine);
      const plume = createPlume(n.radius, plumeColorFor(eng?.id ?? ''));
      plume.mesh.position.copy(n.position);
      this.model.stages[n.stage].add(plume.mesh);
      this.plumes.push({ stage: n.stage, plume });
    }
    this.panel = new ManeuverPanel(this.ui.querySelector('.hud') as HTMLElement, {
      now: () => this.t,
      node: () => this.flight.node,
      setNode: (n) => this.setNode(n),
      burnTime: () => this.flight.nodeBurnTime(),
      resultText: () => this.nodeResult(),
      planners: () => this.planners(),
      executing: () => !!this.flight.autoBurn,
      execute: () => this.executeNode(),
      warpToNode: () => (this.warpingToNode = true),
      defaultNodeTime: () => this.t + 600,
      busy: (msg, work) => this.busy(msg, work),
    });
    const att = h('div', { class: 'att-buttons', id: 'attitude-buttons' });
    for (const a of ATTITUDES) {
      const b = h('button', { class: 'icon-btn wide', text: a.label, title: `Point ${a.id}`, onclick: () => this.setAttitude(a.id) }) as HTMLButtonElement;
      this.attButtons.set(a.id, b);
      att.append(b);
    }
    this.hud.setControls(
      att,
      h('button', { class: 'btn btn-small', id: 'btn-focus', text: 'Focus (Tab)', onclick: () => this.map.cycleFocus() }),
      h('button', { class: 'btn btn-small', id: 'btn-stage', text: 'Stage (Space)', onclick: () => this.flight.stage() }),
    );
    this.hud.setHint('Wheel/drag: camera · Tab focus · Shift/Ctrl/Z/X throttle · Space stage · , . warp · Esc menu');
    this.setAttitude('prograde');
    this.phaseSetup();
  }

  /** Additional per-phase setup after the base scene exists. */
  protected phaseSetup(): void {}

  protected setNode(n: ManeuverNode | null): void {
    this.flight.setNode(n);
    this.dirty = true;
    this.panel.render(true);
  }

  protected executeNode(): void {
    if (this.flight.executeNode()) {
      this.warpingToNode = true;
      this.callouts.say(this.t, 'CAPCOM', `Burn armed: ${this.flight.autoBurn!.initial.toFixed(1)} m/s, ignition in ${formatDuration(this.flight.autoBurn!.start - this.t)}.`);
      this.panel.render(true);
    }
  }

  private setAttitude(a: AttitudeMode): void {
    if (this.flight.autoBurn && a !== 'node') return;
    this.flight.attitude = a;
    for (const [id, b] of this.attButtons) b.classList.toggle('active', id === a);
  }

  /** Run a slow planning computation after letting the UI paint a notice. */
  protected busy(msg: string, work: () => void): void {
    this.app.toast(msg, 'info', 1500);
    setTimeout(() => {
      try {
        work();
      } catch (e) {
        this.app.toast((e as Error).message, 'warn', 3500);
      }
    }, 40);
  }

  // ---- Simulation -------------------------------------------------------------
  protected maxWarp(): number {
    const f = this.flight;
    if (f.isBurning || f.throttle > 0 || (f.autoBurn && f.autoBurn.started)) return this.fastBurns ? 100 : 10;
    let next = Math.min(f.timeToNextEvent() - 15, this.phaseEndTime - this.t);
    for (const ev of this.prediction?.events ?? []) if (ev.t > this.t + 1 && ev.kind !== 'periapsis') next = Math.min(next, ev.t - this.t);
    let max = 1;
    for (const w of WARP_LEVELS) if (w * 0.5 < next) max = w;
    return max;
  }

  protected simulate(dt: number): void {
    if (dt <= 0) return;
    const f = this.flight;
    // Never step past the phase end.
    const step = Math.min(dt, Math.max(0, this.phaseEndTime - f.t));
    if (step > 0) f.advance(step);
    this.t = f.t;
    for (const e of f.events.splice(0)) {
      switch (e.kind) {
        case 'burn-start':
          this.callouts.say(e.t, 'BOOSTER', `Ignition. Burning ${e.detail}.`);
          this.telemetry.mark(e.t, 'Ignition');
          break;
        case 'burn-end':
          this.callouts.say(e.t, 'BOOSTER', `Cutoff, ${e.detail}.`, 'good');
          this.telemetry.mark(e.t, 'Cutoff');
          this.dirty = true;
          this.onBurnComplete();
          break;
        case 'flameout':
          this.callouts.say(e.t, 'BOOSTER', `Propellant depletion. ${e.detail ?? ''}`, 'warn');
          this.dirty = true;
          this.onBurnComplete();
          break;
        case 'staging':
          this.callouts.say(e.t, 'BOOSTER', `Staging: ${e.detail}.`);
          break;
        case 'soi':
          this.callouts.say(e.t, 'FIDO', e.detail === 'moon' ? 'Entering the lunar sphere of influence.' : 'Leaving the lunar sphere of influence.', 'good');
          this.telemetry.mark(e.t, 'SOI change');
          this.dirty = true;
          break;
        case 'atmosphere':
        case 'impact':
        case 'escape':
          this.onHalt(e.kind);
          break;
      }
    }
    if (this.warpingToNode && this.flight.timeToNextEvent() < 20) this.warpingToNode = false;
    if (!this.ended) this.checkPhase();
  }

  /** Called when an automatic burn ends or the engine flames out. */
  protected onBurnComplete(): void {}

  /** Trajectory reached the atmosphere / a surface / escape. Default: fail. */
  protected onHalt(kind: 'atmosphere' | 'impact' | 'escape'): void {
    void kind;
  }

  // ---- HUD ----------------------------------------------------------------------
  protected telemetryRows(): TelemetryRow[] {
    const f = this.flight;
    const body = BODIES[f.s.body];
    const el = stateToElements(f.s.r, f.s.v, body.mu);
    const v = f.vehicle;
    const rows: TelemetryRow[] = [
      { id: 'frame', label: 'Reference', value: `${body.name} SOI` },
      { id: 'alt', label: 'Altitude', value: formatDistance(f.altitude) },
      { id: 'spd', label: 'Speed', value: formatSpeed(len(f.s.v)) },
    ];
    if (el.e < 1) {
      rows.push(
        { id: 'apo', label: 'Apoapsis', value: `${formatDistance(el.ra - body.radius)} (${formatDuration(timeToApoapsis(el, body.mu))})` },
        { id: 'pe', label: 'Periapsis', value: `${formatDistance(el.rp - body.radius)} (${formatDuration(timeToPeriapsis(el, body.mu))})`, cls: f.s.body === 'earth' && el.rp - body.radius < 140e3 ? 'warn' : '' },
        { id: 'per', label: 'Period', value: formatDuration(el.period) },
      );
    } else {
      rows.push({ id: 'pe', label: 'Periapsis', value: formatDistance(el.rp - body.radius) }, { id: 'ecc', label: 'Eccentricity', value: el.e.toFixed(3) });
    }
    rows.push(...this.phaseRows());
    rows.push(
      { id: 'thr', label: 'Throttle', value: `${Math.round(f.thrustLevel * 100)}%` },
      { id: 'stage', label: 'Stage', value: `${v.state.stage + 1} / ${v.stageCount}` },
      { id: 'sdv', label: 'Stage Δv', value: `${v.stageDv.toFixed(0)} m/s` },
      { id: 'tdv', label: 'Total Δv', value: `${v.totalDv.toFixed(0)} m/s` },
      { id: 'used', label: 'Δv used (phase)', value: `${f.dvUsed.toFixed(0)} m/s` },
    );
    return rows;
  }

  protected telemetryChannels(): ChannelDef[] {
    return [
      { id: 'alt', label: 'Altitude', unit: 'km', scale: 1e-3 },
      { id: 'speed', label: 'Speed', unit: 'm/s' },
      { id: 'moonDist', label: 'Moon distance', unit: 'km', scale: 1e-3 },
      { id: 'dv', label: 'Δv used', unit: 'm/s' },
    ];
  }

  protected telemetrySample(): Record<string, number> {
    const eci = toEci(this.flight.s, this.flight.eph);
    return {
      alt: this.flight.altitude,
      speed: len(this.flight.s.v),
      moonDist: len(sub(eci, moonPosition(this.t, this.flight.eph))) - MOON.radius,
      dv: this.flight.dvUsed,
    };
  }

  // ---- Visuals --------------------------------------------------------------
  private readKeys(dt: number): void {
    const f = this.flight;
    if (f.autoBurn) return;
    if (this.keys.has('shift')) f.throttle = Math.min(1, f.throttle + dt * 0.8);
    if (this.keys.has('control')) f.throttle = Math.max(0, f.throttle - dt * 0.8);
  }

  protected override onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    const f = this.flight;
    if (k === 'tab') {
      e.preventDefault();
      this.map.cycleFocus();
    } else if (k === ' ') {
      e.preventDefault();
      f.stage();
    } else if (k === 'z' && !f.autoBurn) f.throttle = 1;
    else if (k === 'x') {
      f.throttle = 0;
      if (f.autoBurn) {
        f.autoBurn = null;
        this.app.toast('Burn aborted', 'warn');
      }
    }
  }

  protected updateVisuals(dt: number): void {
    this.time += dt;
    this.readKeys(dt);
    const f = this.flight;
    this.predictTimer -= dt;
    if (this.dirty || this.predictTimer <= 0) {
      this.predictTimer = f.isBurning ? 0.25 : 1.5;
      this.dirty = false;
      this.repredict();
    }
    if (this.warpingToNode) this.setWarpLevel(this.maxWarp());
    // Vessel.
    this.map.vesselBody = f.s.body;
    this.map.vesselEci = toEci(f.s, f.eph);
    const dir = eciDirToScene(f.attitudeVector());
    this.model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.syncModelStages(f.vehicle);
    for (const p of this.plumes) p.plume.update(p.stage === f.vehicle.state.stage ? f.thrustLevel * (f.isBurning ? 1 : 0) : 0, 1, this.time);
    this.map.update(this.t, dt);
    for (const [id, b] of this.attButtons) b.classList.toggle('active', id === f.attitude);
    this.panel.render();
    this.hud.setStatus(this.ended ? '' : f.isBurning ? 'BURN IN PROGRESS' : f.autoBurn ? `BURN IN ${formatDuration(f.autoBurn.start - this.t)}` : this.statusText(), f.isBurning ? 'warn' : 'info');
  }

  /** Hide model stages that have been jettisoned. */
  protected syncModelStages(v: { state: { stage: number; lesAttached: boolean } }): void {
    if (this.shownStage === v.state.stage) return;
    this.shownStage = v.state.stage;
    this.model.stages.forEach((g, i) => (g.visible = i >= this.shownStage));
    if (this.model.les) this.model.les.visible = v.state.lesAttached;
  }

  protected repredict(): void {
    const f = this.flight;
    this.prediction = f.predict(this.predictionHorizon());
    this.planned = f.node && !f.autoBurn?.started ? this.plannedPrediction() : null;
    this.map.vesselBody = f.s.body;
    this.map.setPrediction(this.prediction);
    this.map.setPlannedPrediction(this.planned);
    if (f.node) {
      const at = coastTo(f.s, f.node.t, f.eph);
      const mag = Math.hypot(f.node.dv.prograde, f.node.dv.normal, f.node.dv.radial);
      this.map.setNode(at.r, at.body, `Node Δv ${mag.toFixed(0)} m/s`);
    } else this.map.setNode(null);
  }

  private plannedKey = '';
  private plannedAt = -Infinity;
  private plannedCache: Prediction | null = null;

  /**
   * Trajectory after the node, from a quick finite-burn simulation (so the preview
   * matches what execution will actually produce), cached per node.
   */
  private plannedPrediction(): Prediction | null {
    const f = this.flight;
    if (!f.node) return null;
    const key = JSON.stringify(f.node);
    if (key === this.plannedKey && this.t - this.plannedAt < 30 && this.plannedCache) return this.plannedCache;
    const after = simulateNode(f, f.node, 0.5);
    this.plannedCache = after ? after.predict(this.predictionHorizon()) : f.predictWithNode(this.predictionHorizon());
    this.plannedKey = key;
    this.plannedAt = this.t;
    return this.plannedCache;
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.map.render(renderer);
  }

  onQualityChange(): void {
    this.map.onQualityChange();
    this.dirty = true;
  }

  protected override teardown(): void {
    for (const p of this.plumes) p.plume.dispose();
    this.model.dispose();
    this.map.dispose();
  }

  protected override extraDebug(): Record<string, unknown> {
    const f = this.flight;
    return {
      body: f.s.body,
      altitude: f.altitude,
      node: f.node ? { t: f.node.t, dv: f.node.dv } : null,
      burning: f.isBurning,
      autoBurn: !!f.autoBurn,
      maxWarp: this.maxWarp(),
      dvUsed: f.dvUsed,
      totalDv: f.vehicle.totalDv,
    };
  }

  override debugCommand(cmd: string, arg?: unknown): unknown {
    if (cmd === 'warp') this.setWarpLevel(Number(arg));
    else if (cmd === 'plan') {
      const p = this.planners().find((x) => x.id === arg);
      const r = p?.run();
      if (r && typeof r !== 'string') this.setNode(r);
      else return { error: r ?? 'no planner' };
    } else if (cmd === 'execute') this.executeNode();
    else if (cmd === 'warpToNode') this.warpingToNode = true;
    else if (cmd === 'focus') this.map.setFocus(arg as 'vessel' | 'earth' | 'moon');
    else if (cmd === 'view') {
      const v = arg as { distance: number; yaw?: number; pitch?: number };
      this.map.cam.setDistance(v.distance, true);
      if (v.yaw !== undefined) this.map.cam.setAngles(v.yaw, v.pitch ?? 0.3, true);
    }
    return this.debugState();
  }
}
