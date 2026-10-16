import * as THREE from 'three';
import { R_EARTH, R_MOON } from '../physics/constants';
import { earthRotation, moonPosition, moonRotation, type Ephemeris, DEFAULT_EPHEMERIS } from '../physics/bodies';
import type { Vec3 } from '../physics/vec';
import { eciDirToScene, eciToScene } from './coords';
import { createEarth, type EarthVisual } from './earth';
import { createMoon, type MoonVisual } from './moon';
import type { QualityPreset } from './quality';
import { createStarfield, disposeObject, updateStarfield } from './starfield';
import { createSun, type SunVisual } from './sun';

/** Direction to the Sun in ECI (fixed over a mission: the Sun moves ~1 deg/day). */
export const SUN_DIRECTION_ECI: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * The shared celestial backdrop: stars, Sun, Earth, Moon, positioned each frame
 * relative to a floating origin (ECI meters).
 */
export class World {
  readonly scene = new THREE.Scene();
  earth!: EarthVisual;
  moon!: MoonVisual;
  sun!: SunVisual;
  stars!: THREE.Points;
  /** Non-rotating anchors for drawing things in body frames (e.g. trajectories). */
  readonly earthAnchor = new THREE.Group();
  readonly moonAnchor = new THREE.Group();
  eph: Ephemeris = DEFAULT_EPHEMERIS;
  private time = 0;
  private sunScene = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private quality: QualityPreset,
  ) {
    this.scene.add(this.earthAnchor, this.moonAnchor);
    this.build();
  }

  private build(): void {
    eciDirToScene(SUN_DIRECTION_ECI, this.sunScene).normalize();
    this.stars = createStarfield(this.quality.starCount);
    this.scene.add(this.stars);
    this.sun = createSun(this.scene, this.sunScene);
    this.earth = createEarth(this.renderer, this.quality, R_EARTH);
    this.earth.setSunDirection(this.sunScene);
    this.moon = createMoon(this.renderer, this.quality, R_MOON);
    this.moon.setSunDirection(this.sunScene);
    this.scene.add(this.earth.group, this.moon.group);
  }

  /** Rebuild GPU resources for a new quality preset or renderer. */
  rebuild(renderer: THREE.WebGLRenderer, quality: QualityPreset): void {
    this.disposeVisuals();
    this.renderer = renderer;
    this.quality = quality;
    this.build();
  }

  /** Position bodies for mission time t relative to `origin` (ECI). */
  update(t: number, origin: Vec3, camera: THREE.Camera, realDt: number): void {
    this.time += realDt;
    eciToScene({ x: 0, y: 0, z: 0 }, origin, this.earth.group.position);
    this.earthAnchor.position.copy(this.earth.group.position);
    const mp = moonPosition(t, this.eph);
    eciToScene(mp, origin, this.moon.group.position);
    this.moonAnchor.position.copy(this.moon.group.position);
    this.earth.update(earthRotation(t, this.eph), t);
    this.moon.update(moonRotation(t, this.eph));
    this.sun.update(camera);
    updateStarfield(this.stars, this.time, camera);
  }

  private disposeVisuals(): void {
    this.earth.dispose();
    this.moon.dispose();
    this.sun.dispose();
    this.scene.remove(this.earth.group, this.moon.group, this.stars);
    disposeObject(this.stars);
  }

  dispose(): void {
    this.disposeVisuals();
    disposeObject(this.scene);
  }
}
