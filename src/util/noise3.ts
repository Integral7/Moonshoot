// JavaScript port of the GLSL 3D simplex noise in src/render/glsl.ts
// ("webgl-noise" by Ian McEwan, Stefan Gustavson, Ashima Arts, MIT License),
// so simulation code can evaluate exactly the same procedural functions the
// GPU bakes (e.g. where Earth's oceans are).

const mod289 = (x: number) => x - Math.floor(x * (1 / 289)) * 289;
const permute = (x: number) => mod289((x * 34 + 1) * x);
const taylorInvSqrt = (r: number) => 1.79284291400159 - 0.85373472095314 * r;

export function snoise3(vx: number, vy: number, vz: number): number {
  const Cx = 1 / 6;
  const Cy = 1 / 3;
  const s = (vx + vy + vz) * Cy;
  let ix = Math.floor(vx + s);
  let iy = Math.floor(vy + s);
  let iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * Cx;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const x0z = vz - iz + t;
  // g = step(x0.yzx, x0.xyz); l = 1 - g
  const gx = x0x >= x0y ? 1 : 0;
  const gy = x0y >= x0z ? 1 : 0;
  const gz = x0z >= x0x ? 1 : 0;
  const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
  // i1 = min(g.xyz, l.zxy); i2 = max(g.xyz, l.zxy)
  const i1x = Math.min(gx, lz), i1y = Math.min(gy, lx), i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz), i2y = Math.max(gy, lx), i2z = Math.max(gz, ly);
  const x1x = x0x - i1x + Cx, x1y = x0y - i1y + Cx, x1z = x0z - i1z + Cx;
  const x2x = x0x - i2x + Cy, x2y = x0y - i2y + Cy, x2z = x0z - i2z + Cy;
  const x3x = x0x - 0.5, x3y = x0y - 0.5, x3z = x0z - 0.5;
  ix = mod289(ix);
  iy = mod289(iy);
  iz = mod289(iz);
  const pz = [0, i1z, i2z, 1].map((o) => permute(iz + o));
  const py = [0, i1y, i2y, 1].map((o, k) => permute(pz[k] + iy + o));
  const p = [0, i1x, i2x, 1].map((o, k) => permute(py[k] + ix + o));
  // Must be the float32 value: GLSL relies on 0.142857142857f rounding up past 1/7 so that
  // floor(7 * n_) == 1. In float64 it is just below 1/7 and yields invalid gradients.
  const n_ = Math.fround(0.142857142857);
  const nsx = n_ * 2, nsy = n_ * 0.5 - 1, nsz = n_;
  const xs: number[] = [], ys: number[] = [], hs: number[] = [];
  for (let k = 0; k < 4; k++) {
    const j = p[k] - 49 * Math.floor(p[k] * nsz * nsz);
    const x_ = Math.floor(j * nsz);
    const y_ = Math.floor(j - 7 * x_);
    const xx = x_ * nsx + nsy;
    const yy = y_ * nsx + nsy;
    xs.push(xx);
    ys.push(yy);
    hs.push(1 - Math.abs(xx) - Math.abs(yy));
  }
  const b0 = [xs[0], xs[1], ys[0], ys[1]];
  const b1 = [xs[2], xs[3], ys[2], ys[3]];
  const s0 = b0.map((b) => Math.floor(b) * 2 + 1);
  const s1 = b1.map((b) => Math.floor(b) * 2 + 1);
  const sh = hs.map((hh) => (hh <= 0 ? -1 : 0));
  // a0 = b0.xzyw + s0.xzyw * sh.xxyy; a1 = b1.xzyw + s1.xzyw * sh.zzww
  const a0 = [b0[0] + s0[0] * sh[0], b0[2] + s0[2] * sh[0], b0[1] + s0[1] * sh[1], b0[3] + s0[3] * sh[1]];
  const a1 = [b1[0] + s1[0] * sh[2], b1[2] + s1[2] * sh[2], b1[1] + s1[1] * sh[3], b1[3] + s1[3] * sh[3]];
  const g = [
    [a0[0], a0[1], hs[0]],
    [a0[2], a0[3], hs[1]],
    [a1[0], a1[1], hs[2]],
    [a1[2], a1[3], hs[3]],
  ];
  const xsv = [
    [x0x, x0y, x0z],
    [x1x, x1y, x1z],
    [x2x, x2y, x2z],
    [x3x, x3y, x3z],
  ];
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const gg = g[k];
    const nr = taylorInvSqrt(gg[0] * gg[0] + gg[1] * gg[1] + gg[2] * gg[2]);
    const xv = xsv[k];
    let m = Math.max(0.6 - (xv[0] * xv[0] + xv[1] * xv[1] + xv[2] * xv[2]), 0);
    m *= m;
    n += m * m * (gg[0] * nr * xv[0] + gg[1] * nr * xv[1] + gg[2] * nr * xv[2]);
  }
  return 42 * n;
}

export function fbm3(x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * snoise3(x * f, y * f, z * f);
    f *= lacunarity;
    amp *= gain;
  }
  return sum;
}

export function ridged3(x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(snoise3(x * f, y * f, z * f));
    sum += amp * n * n;
    f *= 2.1;
    amp *= 0.5;
  }
  return sum;
}
