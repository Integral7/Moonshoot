// Procedural lunar terrain for the landing phase. Defined in a local 2D map
// (azimuthal-equidistant projection around a reference direction in the
// Moon-fixed frame) so it is cheap to sample: rolling mare, craters at three
// scales with raised rims, fine roughness, and discrete boulders.

import { R_MOON } from '../physics/constants';
import { add, cross, dot, len, norm, scale, sub, vec, type Vec3, UNIT_Z } from '../physics/vec';
import { Simplex2, hash2 } from '../util/noise';

export interface Boulder {
  x: number;
  y: number;
  radius: number;
}

interface CraterLayer {
  /** Cell size, m. */
  cell: number;
  /** Probability a cell holds a crater. */
  density: number;
  /** Depth as a fraction of crater radius. */
  depth: number;
  seed: number;
}

const LAYERS: CraterLayer[] = [
  { cell: 6_000, density: 0.35, depth: 0.25, seed: 11 },
  { cell: 900, density: 0.45, depth: 0.22, seed: 23 },
  { cell: 120, density: 0.5, depth: 0.2, seed: 37 },
  { cell: 25, density: 0.35, depth: 0.15, seed: 41 },
];

/** Radial crater profile (fraction of radius): bowl, raised rim, ejecta apron. */
export function craterProfile(d: number): number {
  const bowl = d < 1 ? d * d - 1 : 0;
  const rim = Math.exp(-(((d - 1) / 0.22) ** 2)) * 0.35;
  const ejecta = d > 1 ? Math.exp(-(d - 1) * 3) * 0.05 : 0;
  return bowl + rim + ejecta;
}

export class LunarTerrain {
  readonly origin: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  private noise: Simplex2;
  /** Boulder cell size, m. */
  readonly boulderCell = 30;

  /** `origin`: unit reference direction in the Moon-fixed frame. */
  constructor(origin: Vec3, readonly seed = 1969) {
    this.origin = norm(origin);
    let e = cross(UNIT_Z, this.origin);
    if (len(e) < 1e-6) e = vec(0, 1, 0);
    this.east = norm(e);
    this.north = cross(this.origin, this.east);
    this.noise = new Simplex2(seed);
  }

  /** Moon-fixed unit direction -> local map coordinates (m). */
  toLocal(dir: Vec3): { x: number; y: number } {
    const d = norm(dir);
    const c = Math.max(-1, Math.min(1, dot(d, this.origin)));
    const theta = Math.acos(c);
    const perp = sub(d, scale(this.origin, c));
    const pl = len(perp);
    if (pl < 1e-12) return { x: 0, y: 0 };
    const rho = theta * R_MOON;
    return { x: (rho * dot(perp, this.east)) / pl, y: (rho * dot(perp, this.north)) / pl };
  }

  /** Local map coordinates (m) -> Moon-fixed unit direction. */
  toDir(x: number, y: number): Vec3 {
    const rho = Math.hypot(x, y);
    if (rho < 1e-9) return this.origin;
    const theta = rho / R_MOON;
    const t = add(scale(this.east, x / rho), scale(this.north, y / rho));
    return add(scale(this.origin, Math.cos(theta)), scale(t, Math.sin(theta)));
  }

  /** Terrain height above the mean radius at map coordinates (m). */
  height(x: number, y: number): number {
    const n = this.noise;
    let h = 900 * n.fbm(x / 60_000, y / 60_000, 4) + 120 * n.fbm(x / 8_000 + 31, y / 8_000 - 17, 3);
    for (const L of LAYERS) h += this.craters(x, y, L);
    h += 1.2 * n.fbm(x / 9 + 5, y / 9 + 9, 3);
    return h;
  }

  private craters(x: number, y: number, L: CraterLayer): number {
    const cx = Math.floor(x / L.cell);
    const cy = Math.floor(y / L.cell);
    let h = 0;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        if (hash2(i, j, L.seed) > L.density) continue;
        const px = (i + 0.15 + 0.7 * hash2(i, j, L.seed + 1)) * L.cell;
        const py = (j + 0.15 + 0.7 * hash2(i, j, L.seed + 2)) * L.cell;
        const r = L.cell * (0.08 + 0.32 * hash2(i, j, L.seed + 3) ** 2);
        const d = Math.hypot(x - px, y - py) / r;
        if (d < 2.5) h += craterProfile(d) * r * L.depth;
      }
    }
    return h;
  }

  /** Surface normal in local map axes (x east, y north, z up), unit. */
  normalLocal(x: number, y: number, eps = 1.5): { x: number; y: number; z: number } {
    const hx = (this.height(x + eps, y) - this.height(x - eps, y)) / (2 * eps);
    const hy = (this.height(x, y + eps) - this.height(x, y - eps)) / (2 * eps);
    const l = Math.hypot(hx, hy, 1);
    return { x: -hx / l, y: -hy / l, z: 1 / l };
  }

  /** Local slope angle (rad). */
  slope(x: number, y: number, eps = 1.5): number {
    return Math.acos(this.normalLocal(x, y, eps).z);
  }

  /** Boulders whose footprint intersects a circle of radius `r` around (x, y). */
  bouldersNear(x: number, y: number, r: number): Boulder[] {
    const out: Boulder[] = [];
    const c = this.boulderCell;
    const i0 = Math.floor((x - r) / c) - 1;
    const i1 = Math.floor((x + r) / c) + 1;
    const j0 = Math.floor((y - r) / c) - 1;
    const j1 = Math.floor((y + r) / c) + 1;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const b = this.boulderInCell(i, j);
        if (b && Math.hypot(b.x - x, b.y - y) < r + b.radius) out.push(b);
      }
    }
    return out;
  }

  /** The boulder in grid cell (i, j), if any. Denser near fresh crater rims. */
  boulderInCell(i: number, j: number): Boulder | null {
    const c = this.boulderCell;
    const p = hash2(i, j, this.seed + 101);
    const bx = (i + hash2(i, j, this.seed + 102)) * c;
    const by = (j + hash2(i, j, this.seed + 103)) * c;
    const rough = 0.5 + 0.5 * this.noise.noise(bx / 400, by / 400);
    if (p > 0.07 + 0.25 * rough * rough) return null;
    const radius = 0.4 + 2.6 * hash2(i, j, this.seed + 104) ** 3;
    return { x: bx, y: by, radius };
  }

  /** Radius (m) of the Moon surface along a Moon-fixed direction. */
  surfaceRadius(dir: Vec3): number {
    const { x, y } = this.toLocal(dir);
    return R_MOON + this.height(x, y);
  }
}
