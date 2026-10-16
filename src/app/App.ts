import * as THREE from 'three';
import { Emitter } from './events';
import { loadSettings, saveSettings, type Settings } from './settings';
import { QUALITY_PRESETS, type QualityLevel, type QualityPreset } from '../render/quality';
import type { Screen } from './Screen';
import { h } from '../ui/dom';

type AppEvents = {
  quality: QualityPreset;
  screen: string;
};

/**
 * Owns the canvas, WebGL renderer, DOM overlay, settings, and the active screen.
 * Exposes a small debug surface on `window.__moonshot` used by headless tests.
 */
export class App {
  readonly root: HTMLElement;
  readonly events = new Emitter<AppEvents>();
  settings: Settings;
  renderer!: THREE.WebGLRenderer;

  private canvasHost: HTMLElement;
  private uiHost: HTMLElement;
  private toastHost: HTMLElement;
  private screen: Screen | null = null;
  private lastTime = 0;
  private frames = 0;
  private rafId = 0;
  private screenFactories = new Map<string, () => Screen>();
  private rendererAntialias = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
    this.canvasHost = h('div', { class: 'canvas-host' });
    this.uiHost = h('div', { class: 'ui-host' });
    this.toastHost = h('div', { class: 'toast-host' });
    root.append(this.canvasHost, this.uiHost, this.toastHost);
    this.createRenderer();
    window.addEventListener('resize', () => this.handleResize());
  }

  get quality(): QualityPreset {
    return QUALITY_PRESETS[this.settings.quality];
  }

  get width(): number {
    return this.canvasHost.clientWidth || window.innerWidth;
  }

  get height(): number {
    return this.canvasHost.clientHeight || window.innerHeight;
  }

  get aspect(): number {
    return this.width / Math.max(1, this.height);
  }

  registerScreen(id: string, factory: () => Screen): void {
    this.screenFactories.set(id, factory);
  }

  /** Switch to a registered screen by id, or to a provided screen instance. */
  go(target: string | Screen): void {
    const next = typeof target === 'string' ? this.screenFactories.get(target)?.() : target;
    if (!next) throw new Error(`Unknown screen: ${String(target)}`);
    if (this.screen) {
      this.screen.exit();
    }
    this.uiHost.replaceChildren();
    const ui = h('div', { class: `screen screen-${next.id}` });
    this.uiHost.append(ui);
    this.screen = next;
    next.enter(this, ui);
    next.resize?.(this.width, this.height);
    this.events.emit('screen', next.id);
  }

  get currentScreen(): Screen | null {
    return this.screen;
  }

  setQuality(level: QualityLevel): void {
    if (level === this.settings.quality) return;
    this.settings.quality = level;
    saveSettings(this.settings);
    if (this.quality.antialias !== this.rendererAntialias) this.createRenderer();
    else this.applyPixelRatio();
    this.screen?.onQualityChange?.();
    this.events.emit('quality', this.quality);
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' | 'bad' = 'info', ms = 3500): void {
    const el = h('div', { class: `toast toast-${kind}`, text });
    this.toastHost.append(el);
    setTimeout(() => el.classList.add('toast-out'), ms);
    setTimeout(() => el.remove(), ms + 600);
  }

  start(): void {
    this.lastTime = performance.now();
    const loop = (t: number) => {
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (t - this.lastTime) / 1000));
      this.lastTime = t;
      this.frame(dt);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  /** Advance one frame (also used by headless tests to step deterministically). */
  frame(dt: number): void {
    const s = this.screen;
    if (!s) return;
    s.update(dt);
    s.render(this.renderer);
    this.frames++;
  }

  debugState(): Record<string, unknown> {
    return {
      frames: this.frames,
      screen: this.screen?.id ?? null,
      quality: this.settings.quality,
      webgl: this.renderer.getContext() ? true : false,
      ...(this.screen?.debugState?.() ?? {}),
    };
  }

  private createRenderer(): void {
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    const q = this.quality;
    this.rendererAntialias = q.antialias;
    this.renderer = new THREE.WebGLRenderer({
      antialias: q.antialias,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);
    this.canvasHost.append(this.renderer.domElement);
    this.applyPixelRatio();
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatioCap));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
  }

  private handleResize(): void {
    this.applyPixelRatio();
    this.screen?.resize?.(this.width, this.height);
  }
}
