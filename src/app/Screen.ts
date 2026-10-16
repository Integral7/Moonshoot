import type * as THREE from 'three';
import type { App } from './App';

/**
 * A full-screen mode of the game (main menu, vehicle design, a flight phase...).
 * The App owns the WebGL renderer and the DOM overlay; screens own their scene
 * and UI and are created fresh each time they are entered.
 */
export interface Screen {
  readonly id: string;
  /** Called once when the screen becomes active. `ui` is an empty overlay container. */
  enter(app: App, ui: HTMLElement): void;
  /** Called once when the screen is replaced. Must release GPU resources. */
  exit(): void;
  /** Per animation frame, `dt` in real seconds (clamped). */
  update(dt: number): void;
  /** Render the frame. Called after update. */
  render(renderer: THREE.WebGLRenderer): void;
  /** Viewport changed size. */
  resize?(width: number, height: number): void;
  /** Quality preset changed: rebuild expensive resources if needed. */
  onQualityChange?(): void;
  /** Debug/e2e state snapshot. */
  debugState?(): Record<string, unknown>;
  /** Debug/e2e commands (e.g. engage an autopilot, set warp). */
  debugCommand?(cmd: string, arg?: unknown): unknown;
}
