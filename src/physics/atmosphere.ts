// U.S. Standard Atmosphere 1976. Exact layer equations up to 86 km geometric,
// log-linear interpolation of the published density table above that.

import { G0, GAMMA_AIR, P0, R_AIR } from './constants';

/** Effective Earth radius used by US76 for geopotential altitude, m. */
const R0_GEOPOTENTIAL = 6_356_766;

interface Layer {
  /** Base geopotential altitude, m. */
  h: number;
  /** Base temperature, K. */
  T: number;
  /** Lapse rate, K/m. */
  L: number;
  /** Base pressure, Pa. */
  P: number;
}

// Base pressures follow from integrating the hydrostatic equation layer by layer.
const LAYERS: Layer[] = (() => {
  const defs: [number, number][] = [
    [0, -0.0065],
    [11_000, 0],
    [20_000, 0.001],
    [32_000, 0.0028],
    [47_000, 0],
    [51_000, -0.0028],
    [71_000, -0.002],
  ];
  const out: Layer[] = [];
  let T = 288.15;
  let P = P0;
  for (let k = 0; k < defs.length; k++) {
    const [h, L] = defs[k];
    out.push({ h, T, L, P });
    const hNext = k + 1 < defs.length ? defs[k + 1][0] : 84_852;
    const dh = hNext - h;
    const Tn = T + L * dh;
    P = L === 0 ? P * Math.exp((-G0 * dh) / (R_AIR * T)) : P * Math.pow(T / Tn, G0 / (R_AIR * L));
    T = Tn;
  }
  return out;
})();

/** Geometric altitude (km) and density (kg/m^3), US76 table above 86 km. */
const UPPER_TABLE: [number, number][] = [
  [86, 6.958e-6],
  [90, 3.416e-6],
  [100, 5.604e-7],
  [110, 9.708e-8],
  [120, 2.222e-8],
  [130, 8.152e-9],
  [140, 3.831e-9],
  [150, 2.076e-9],
  [180, 5.194e-10],
  [200, 2.541e-10],
  [250, 6.073e-11],
  [300, 1.916e-11],
  [400, 2.803e-12],
  [500, 5.215e-13],
  [600, 1.137e-13],
  [800, 1.136e-14],
  [1000, 3.561e-15],
];

export interface AtmosphereSample {
  /** Temperature, K. */
  T: number;
  /** Pressure, Pa. */
  P: number;
  /** Density, kg/m^3. */
  rho: number;
  /** Speed of sound, m/s. */
  a: number;
}

export function geopotentialAltitude(z: number): number {
  return (R0_GEOPOTENTIAL * z) / (R0_GEOPOTENTIAL + z);
}

/** Atmospheric properties at geometric altitude z (m). Vacuum above 1000 km. */
export function atmosphere(z: number): AtmosphereSample {
  if (z < 0) z = 0;
  if (z <= 86_000) {
    const h = geopotentialAltitude(z);
    let layer = LAYERS[0];
    for (let k = LAYERS.length - 1; k >= 0; k--) {
      if (h >= LAYERS[k].h) {
        layer = LAYERS[k];
        break;
      }
    }
    const dh = h - layer.h;
    const T = layer.T + layer.L * dh;
    const P =
      layer.L === 0
        ? layer.P * Math.exp((-G0 * dh) / (R_AIR * layer.T))
        : layer.P * Math.pow(layer.T / T, G0 / (R_AIR * layer.L));
    const rho = P / (R_AIR * T);
    return { T, P, rho, a: Math.sqrt(GAMMA_AIR * R_AIR * T) };
  }
  const T = 186.87;
  const a = Math.sqrt(GAMMA_AIR * R_AIR * T);
  const km = z / 1000;
  if (km >= 1000) return { T, P: 0, rho: 0, a };
  let k = 0;
  while (k < UPPER_TABLE.length - 2 && km > UPPER_TABLE[k + 1][0]) k++;
  const [z0, d0] = UPPER_TABLE[k];
  const [z1, d1] = UPPER_TABLE[k + 1];
  const f = (km - z0) / (z1 - z0);
  const rho = Math.exp(Math.log(d0) + f * (Math.log(d1) - Math.log(d0)));
  return { T, P: rho * R_AIR * T, rho, a };
}

export const density = (z: number): number => atmosphere(z).rho;
export const pressure = (z: number): number => atmosphere(z).P;
