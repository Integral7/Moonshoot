// Where the procedural Earth has land and ocean: the same continent function
// the GPU bakes into the Earth texture (see render/earth.ts), evaluated in JS.

import { fbm3, ridged3 } from '../util/noise3';
import type { Vec3 } from '../physics/vec';

/** Continent field threshold for land (shared with the GPU bake). */
export const SEA_LEVEL = 0.035;

/** Continent field at a direction given in the Earth texture's object axes (scene axes, +Y north). */
export function continentField(px: number, py: number, pz: number): number {
  const l = Math.hypot(px, py, pz) || 1;
  const x = px / l, y = py / l, z = pz / l;
  const wx = x + 0.35 * fbm3(x * 1.3 + 11, y * 1.3 + 11, z * 1.3 + 11, 4, 2, 0.5);
  const wy = y + 0.35 * fbm3(x * 1.3 + 23, y * 1.3 + 23, z * 1.3 + 23, 4, 2, 0.5);
  const wz = z + 0.35 * fbm3(x * 1.3 + 37, y * 1.3 + 37, z * 1.3 + 37, 4, 2, 0.5);
  let c = fbm3(wx * 1.15, wy * 1.15, wz * 1.15, 7, 2.05, 0.52);
  c += 0.12 * ridged3(wx * 3 + 5, wy * 3 + 5, wz * 3 + 5, 4) - 0.06;
  return c;
}

/**
 * Is the Earth-fixed position (physics axes: +Z north, X through the prime
 * meridian) on land? Converts to the texture's scene axes (x, z, -y).
 */
export function isLand(earthFixed: Vec3): boolean {
  return continentField(earthFixed.x, earthFixed.z, -earthFixed.y) > SEA_LEVEL;
}
