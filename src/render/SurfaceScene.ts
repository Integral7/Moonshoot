import * as THREE from 'three';
import { moonPosition } from '../physics/bodies';
import { add, cross, len, norm, scale, vec } from '../physics/vec';
import type { DescentSim } from '../sim/descent';
import { eciDirToScene } from './coords';
import type { MapView } from './MapView';
import type { Plume } from './plume';
import { SmokeSystem } from './smoke';
import { setStarBrightness } from './starfield';
import { TerrainTile } from './terrainMesh';
import type { VehicleModel } from './vehicleMesh';
import type { QualityPreset } from './quality';

/**
 * Close-up lunar surface view around a DescentSim: streaming terrain tile,
 * boulders, landing-site marker, engine dust, and the vehicle model placed
 * with its footpads on the simulated contact point.
 */
export class SurfaceScene {
  readonly tile: TerrainTile;
  private dust: SmokeSystem;

  constructor(
    private map: MapView,
    sim: DescentSim,
    quality: QualityPreset,
  ) {
    this.tile = new TerrainTile(sim.terrain, quality.terrainResolution);
    map.world.moon.spin.add(this.tile.group);
    this.dust = new SmokeSystem(Math.max(60, quality.particleCount));
    map.world.scene.add(this.dust.points);
  }

  /**
   * Position everything for this frame and update the map view.
   * `site`: landing-point designator to show (map coordinates), or null.
   */
  update(sim: DescentSim, model: VehicleModel, plumes: { stage: number; plume: Plume }[], t: number, time: number, dt: number, site: { x: number; y: number } | null, appHeight: number): void {
    const map = this.map;
    const moonC = moonPosition(t, sim.eph);
    map.vesselEci = add(moonC, sim.r);
    const up = eciDirToScene(sim.up);
    map.cam.up.copy(up);
    const dirS = eciDirToScene(sim.dir);
    model.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirS);
    for (const p of plumes) p.plume.update(p.stage === sim.vehicle.state.stage ? sim.throttle : 0, 1, time);
    const mp = sim.mapPos;
    this.tile.update(mp.x, mp.y, sim.altitude);
    this.tile.setSite(site);
    map.world.moon.setSurfaceVisible(sim.altitude > 40_000);
    // Engine exhaust blowing dust off the surface at low altitude.
    if (sim.altitude < 25 && sim.throttle > 0.05) {
      const ground = add(moonC, scale(sim.up, len(sim.r) - sim.altitude));
      const a = Math.random() * Math.PI * 2;
      const e1 = norm(cross(sim.up, vec(0, 0, 1)));
      const e2 = cross(sim.up, e1);
      const spray = norm(add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a))));
      this.dust.emit(dt, 300 * sim.throttle * (1 - Math.max(0, sim.altitude) / 25), ground, vec(), spray, 40, 3, 2.5);
    }
    this.dust.setViewportHeight(appHeight, map.camera.fov);
    this.dust.setLight(0.8);
    this.dust.update(dt, map.origin(), vec());
    setStarBrightness(map.world.stars, 0.35);
    map.update(t, dt);
    // Keep the footpads of the current stage at the simulated contact point.
    const bottom = model.stageBottoms[sim.vehicle.state.stage] ?? 0;
    model.root.position.addScaledVector(dirS, -bottom);
  }

  dispose(): void {
    this.tile.group.parent?.remove(this.tile.group);
    this.tile.dispose();
    this.dust.points.parent?.remove(this.dust.points);
    this.dust.dispose();
  }
}
