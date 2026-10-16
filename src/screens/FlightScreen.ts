import type * as THREE from 'three';
import type { App } from '../app/App';
import type { Screen } from '../app/Screen';
import { createPhaseScreen } from '../app/phases';
import { phaseEndActions } from '../app/flow';
import { CalloutSystem } from '../sim/callouts';
import { Mission, PHASES } from '../sim/mission';
import type { PhaseResult } from '../sim/scoring';
import { TelemetryRecorder, type ChannelDef } from '../sim/telemetry';
import { Hud, type TelemetryRow } from '../ui/Hud';
import { createResultsPanel } from '../ui/ResultsPanel';
import { createSettingsPanel } from '../ui/SettingsPanel';
import { h } from '../ui/dom';

export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 1_000, 10_000, 100_000];

/**
 * Base class for every flight phase: mission clock, time warp, pause menu,
 * mission control HUD and callouts, telemetry recording, and the end-of-phase
 * debrief. Subclasses implement the physics and scene.
 */
export abstract class FlightScreen<Snapshot = Record<string, number>> implements Screen {
  abstract readonly id: string;
  protected app!: App;
  protected ui!: HTMLElement;
  protected hud!: Hud;
  protected callouts = new CalloutSystem<Snapshot>();
  protected telemetry!: TelemetryRecorder;
  /** Mission elapsed time, s. */
  t = 0;
  protected warpIndex = 0;
  protected paused = false;
  protected ended = false;
  protected result: PhaseResult | null = null;
  private hudTimer = 0;
  private overlay: HTMLElement | null = null;

  constructor(protected mission: Mission) {
    this.t = mission.carry.t ?? 0;
  }

  // ---- Subclass hooks -------------------------------------------------------
  /** Build scene, initial state, controls. */
  protected abstract setup(): void;
  /** Advance the simulation by dt mission-seconds (already multiplied by warp). */
  protected abstract simulate(dt: number): void;
  /** Highest warp currently allowed (e.g. 1-4x while thrusting). */
  protected abstract maxWarp(): number;
  protected abstract telemetryRows(): TelemetryRow[];
  protected abstract telemetryChannels(): ChannelDef[];
  protected abstract telemetrySample(): Record<string, number>;
  protected abstract snapshot(): Snapshot;
  /** Per-frame visuals (dt real seconds). */
  protected abstract updateVisuals(dt: number): void;
  abstract render(renderer: THREE.WebGLRenderer): void;
  protected teardown(): void {}
  protected onKey(_e: KeyboardEvent, _down: boolean): void {}
  protected extraDebug(): Record<string, unknown> {
    return {};
  }
  /** Debug/e2e commands (e.g. engage an autopilot). */
  debugCommand(_cmd: string, _arg?: unknown): unknown {
    return undefined;
  }

  // ---- Screen ---------------------------------------------------------------
  enter(app: App, ui: HTMLElement): void {
    this.app = app;
    this.ui = ui;
    const info = PHASES[this.mission.phase];
    this.hud = new Hud(ui, {
      phaseLabel: `Phase ${info.index}: ${info.title}${this.mission.mode === 'freeplay' ? ' (free play)' : ''}`,
      onMenu: () => this.openPauseMenu(),
      onPause: () => this.togglePause(),
      onWarp: (d) => this.changeWarp(d),
      showToasts: () => app.settings.callouts,
      toast: (text, kind) => app.toast(text, kind),
    });
    this.callouts.onCallout((c) => this.hud.addCallout(c));
    this.telemetry = new TelemetryRecorder(this.telemetryChannels(), 0.5);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    this.setup();
    this.refreshHud();
  }

  exit(): void {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    this.teardown();
  }

  update(dt: number): void {
    if (!this.paused && !this.ended) {
      const max = this.maxWarp();
      while (this.warpIndex > 0 && WARP_LEVELS[this.warpIndex] > max) this.warpIndex--;
      const simDt = dt * this.warp;
      this.simulate(simDt);
      if (!this.ended) {
        this.telemetry.sample(this.t, this.telemetrySample(), this.warp);
        this.callouts.evaluate(this.t, this.snapshot());
      }
    }
    this.updateVisuals(dt);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.refreshHud();
    }
  }

  get warp(): number {
    return WARP_LEVELS[this.warpIndex];
  }

  debugState(): Record<string, unknown> {
    return {
      phase: this.mission.phase,
      mode: this.mission.mode,
      t: this.t,
      warp: this.warp,
      paused: this.paused,
      ended: this.ended,
      success: this.result?.success ?? null,
      score: this.result?.score ?? null,
      callouts: this.callouts.log.length,
      samples: this.telemetry?.length ?? 0,
      ...this.extraDebug(),
    };
  }

  // ---- Helpers --------------------------------------------------------------
  protected refreshHud(): void {
    this.hud.setClock(this.t);
    this.hud.setWarp(this.warp, this.maxWarp(), this.paused);
    this.hud.setTelemetry(this.telemetryRows());
  }

  setWarpLevel(level: number): void {
    const idx = WARP_LEVELS.indexOf(level);
    if (idx >= 0 && level <= this.maxWarp()) this.warpIndex = idx;
  }

  protected changeWarp(delta: number): void {
    const next = Math.max(0, Math.min(WARP_LEVELS.length - 1, this.warpIndex + delta));
    if (WARP_LEVELS[next] > this.maxWarp()) {
      this.app.toast(`Warp limited to ${this.maxWarp().toLocaleString('en-US')}x right now`, 'warn', 1800);
      return;
    }
    this.warpIndex = next;
  }

  protected togglePause(): void {
    if (this.ended) return;
    this.paused = !this.paused;
    this.refreshHud();
  }

  private keyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === ',' || e.key === '<') this.changeWarp(-1);
    else if (e.key === '.' || e.key === '>') this.changeWarp(1);
    else if (e.key === '/' ) this.warpIndex = 0;
    else if (e.key === 'p' || e.key === 'P') this.togglePause();
    else if (e.key === 'Escape') {
      if (this.overlay) this.closeOverlay();
      else this.openPauseMenu();
    }
    this.onKey(e, true);
  };

  private keyUp = (e: KeyboardEvent) => this.onKey(e, false);

  protected closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  protected showOverlay(el: HTMLElement): void {
    this.closeOverlay();
    this.overlay = el;
    this.ui.append(el);
  }

  protected openPauseMenu(): void {
    if (this.ended) return;
    const wasPaused = this.paused;
    this.paused = true;
    const resume = () => {
      this.closeOverlay();
      this.paused = wasPaused;
    };
    this.showOverlay(
      h(
        'div',
        { class: 'modal-backdrop' },
        h(
          'div',
          { class: 'panel modal pause-menu', id: 'pause-menu' },
          h('h2', { text: 'Paused' }),
          h(
            'div',
            { class: 'menu-buttons' },
            h('button', { class: 'btn btn-primary', id: 'pm-resume', text: 'Resume', onclick: resume }),
            h('button', { class: 'btn', id: 'pm-restart', text: 'Restart phase', onclick: () => this.restartPhase() }),
            h('button', {
              class: 'btn',
              id: 'pm-settings',
              text: 'Settings',
              onclick: () => {
                const panel = createSettingsPanel(this.app, () => panel.remove());
                this.ui.append(panel);
              },
            }),
            h('button', { class: 'btn', id: 'pm-quit', text: 'Quit to main menu', onclick: () => this.app.go('menu') }),
          ),
        ),
      ),
    );
  }

  protected restartPhase(): void {
    this.mission.retry();
    const s = createPhaseScreen(this.mission);
    if (s) this.app.go(s);
  }

  /** End the phase and show the debrief. */
  protected finish(result: PhaseResult, carry?: Record<string, unknown>): void {
    if (this.ended) return;
    this.ended = true;
    this.result = result;
    this.mission.complete(result);
    if (result.success && carry) Object.assign(this.mission.carry, carry, { t: this.t });
    this.telemetry.sample(this.t, this.telemetrySample(), 1, true);
    this.callouts.say(this.t, 'FLIGHT', result.success ? 'Phase complete. Good work, everyone.' : 'We have a failure. Lock your consoles, record your data.', result.success ? 'good' : 'bad');
    const actions = phaseEndActions(this.app, this.mission, result, () => this.restartPhase());
    this.showOverlay(createResultsPanel(result, PHASES[this.mission.phase].title, actions, this.debriefExtras()));
  }

  /** Extra debrief content (telemetry graphs etc.). */
  protected debriefExtras(): HTMLElement | undefined {
    return undefined;
  }
}
