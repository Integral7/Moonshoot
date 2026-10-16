// Shared GLSL snippets.

/**
 * 3D simplex noise. Based on "webgl-noise" by Ian McEwan, Stefan Gustavson
 * (Ashima Arts), MIT License: https://github.com/ashima/webgl-noise
 */
export const SIMPLEX_3D = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p * freq);
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

float ridged(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p * freq));
    sum += amp * n * n;
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
`;

/**
 * Crater field via 3D cellular placement. Returns height contribution
 * (negative bowls, positive rims) for one layer at frequency freq.
 */
export const CRATERS = /* glsl */ `
float craterProfile(float d) {
  // d = distance / radius. Bowl inside, raised rim near 1, ejecta falloff outside.
  float bowl = d < 1.0 ? (d * d - 1.0) * 0.7 : 0.0;
  float rim = exp(-pow((d - 1.0) / 0.22, 2.0)) * 0.32;
  float ejecta = d > 1.0 ? exp(-(d - 1.0) * 3.0) * 0.06 : 0.0;
  return bowl + rim + ejecta;
}

float craterLayer(vec3 p, float freq, float density, float seed) {
  vec3 q = p * freq;
  vec3 cell = floor(q);
  vec3 f = fract(q);
  float h = 0.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 c = cell + o + seed;
    vec3 rnd = hash33(c);
    if (rnd.z > density) continue;
    vec3 center = o + hash33(c + 17.17);
    float r = mix(0.12, 0.5, rnd.x * rnd.x);
    float d = length(f - center) / r;
    if (d < 2.2) h += craterProfile(d) * r;
  }
  return h;
}
`;

/** Vertex/fragment includes for logarithmic depth (the renderer uses a log depth buffer). */
export const LOGDEPTH_VERT_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export const LOGDEPTH_VERT = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const LOGDEPTH_FRAG_PARS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
`;
export const LOGDEPTH_FRAG = /* glsl */ `
#include <logdepthbuf_fragment>
`;
/** Tone mapping + output color space conversion for custom ShaderMaterials. */
export const OUTPUT_FRAG = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;
