import * as THREE from 'three';
import { bakeCube, cachedBake } from './bake';
import { CRATERS, LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, OUTPUT_FRAG, SIMPLEX_3D } from './glsl';
import type { QualityPreset } from './quality';

const MOON_FUNCS = /* glsl */ `
${SIMPLEX_3D}
${CRATERS}
float maria(vec3 p) {
  // Large dark basaltic plains, concentrated on the near side (+X in body axes faces Earth).
  float m = fbm(p * 1.4 + 4.0, 5, 2.0, 0.5);
  float nearSide = smoothstep(-0.2, 0.6, p.x);
  return smoothstep(0.02, 0.16, m + 0.12 * nearSide - 0.05);
}
float moonHeight(vec3 p, out float freshness) {
  float h = 0.0;
  h += craterLayer(p, 2.2, 0.25, 1.0) * 1.6;
  h += craterLayer(p, 5.0, 0.45, 2.0) * 0.8;
  h += craterLayer(p, 11.0, 0.55, 3.0) * 0.45;
  h += craterLayer(p, 26.0, 0.6, 4.0) * 0.22;
  h += craterLayer(p, 60.0, 0.65, 5.0) * 0.1;
  freshness = clamp(craterLayer(p, 11.0, 0.15, 9.0) * 4.0, 0.0, 1.0);
  h += fbm(p * 6.0, 5, 2.1, 0.5) * 0.08;
  h -= maria(p) * 0.12;
  return h;
}
`;

const MOON_COLOR_FRAG = /* glsl */ `
${MOON_FUNCS}
void main() {
  vec3 p = normalize(vDir);
  float fresh;
  float h = moonHeight(p, fresh);
  float m = maria(p);
  vec3 highland = vec3(0.62, 0.60, 0.57);
  vec3 mare = vec3(0.26, 0.26, 0.27);
  vec3 col = mix(highland, mare, m * 0.85);
  col *= 0.88 + 0.24 * (fbm(p * 30.0, 3, 2.0, 0.5) * 0.5 + 0.5);
  // Young crater rims and ejecta are brighter.
  col = mix(col, vec3(0.8, 0.79, 0.77), clamp(fresh * 0.6, 0.0, 0.6));
  gl_FragColor = vec4(col, 1.0);
}
`;

const MOON_HEIGHT_FRAG = /* glsl */ `
${MOON_FUNCS}
void main() {
  vec3 p = normalize(vDir);
  float fresh;
  float h = moonHeight(p, fresh);
  gl_FragColor = vec4(vec3(clamp(h * 0.35 + 0.5, 0.0, 1.0)), 1.0);
}
`;

const MOON_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vObjDir;
varying vec3 vWorldPos;
void main() {
  vObjDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGDEPTH_VERT}
}
`;

const MOON_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform samplerCube uColor;
uniform samplerCube uHeight;
uniform vec3 uSunDir;
uniform float uBump;
uniform float uTexel;
uniform mat3 uRot;
varying vec3 vObjDir;
varying vec3 vWorldPos;
void main() {
  ${LOGDEPTH_FRAG}
  vec3 n = normalize(vObjDir);
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  float e = uTexel;
  float h0 = textureCube(uHeight, n).r;
  float h1 = textureCube(uHeight, normalize(n + t1 * e)).r;
  float h2 = textureCube(uHeight, normalize(n + t2 * e)).r;
  vec3 nObj = normalize(n - uBump * ((h1 - h0) * t1 + (h2 - h0) * t2) / e);
  vec3 nW = normalize(uRot * nObj);
  vec3 nGeo = normalize(uRot * n);
  vec3 l = normalize(uSunDir);
  vec3 v = normalize(cameraPosition - vWorldPos);
  float mu0 = max(dot(nW, l), 0.0);
  float mu = max(dot(nGeo, v), 0.001);
  // Lunar-Lambert: blend of Lommel-Seeliger (no limb darkening) and Lambert.
  float ls = 2.0 * mu0 / (mu0 + mu);
  float lum = mix(mu0, ls, 0.55) * smoothstep(-0.02, 0.05, dot(nGeo, l));
  vec3 albedo = textureCube(uColor, n).rgb;
  vec3 earthshine = albedo * 0.012;
  gl_FragColor = vec4(albedo * lum * 1.9 + earthshine, 1.0);
  ${OUTPUT_FRAG}
}
`;

export interface MoonVisual {
  group: THREE.Group;
  spin: THREE.Group;
  setSunDirection(dir: THREE.Vector3): void;
  update(rotation: number): void;
  /** Show or hide the sphere itself (children of `spin`, like terrain tiles, stay visible). */
  setSurfaceVisible(v: boolean): void;
  dispose(): void;
}

export function createMoon(renderer: THREE.WebGLRenderer, q: QualityPreset, radius: number): MoonVisual {
  const face = q.planetTextureSize / 2;
  const color = cachedBake(renderer, `moon-color-${face}`, () => bakeCube(renderer, face, MOON_COLOR_FRAG));
  const height = cachedBake(renderer, `moon-height-${face}`, () => bakeCube(renderer, face, MOON_HEIGHT_FRAG));
  const sunDir = new THREE.Vector3(1, 0, 0);
  const group = new THREE.Group();
  group.name = 'moon';
  const spin = new THREE.Group();
  group.add(spin);
  const seg = q.sphereSegments;
  const mat = new THREE.ShaderMaterial({
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    uniforms: {
      uColor: { value: color.texture },
      uHeight: { value: height.texture },
      uSunDir: { value: sunDir },
      uBump: { value: 0.06 },
      uTexel: { value: 1.5 / face },
      uRot: { value: new THREE.Matrix3() },
    },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, seg, seg / 2), mat);
  mesh.onBeforeRender = () => {
    mat.uniforms.uRot.value.setFromMatrix4(mesh.matrixWorld);
  };
  mesh.name = 'moon-surface';
  spin.add(mesh);
  return {
    group,
    spin,
    setSunDirection(dir) {
      sunDir.copy(dir).normalize();
    },
    update(rotation) {
      spin.rotation.y = rotation;
    },
    setSurfaceVisible(v) {
      mesh.visible = v;
    },
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
