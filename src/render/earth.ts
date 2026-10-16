import * as THREE from 'three';
import { bakeCube, cachedBake } from './bake';
import {
  LOGDEPTH_FRAG,
  LOGDEPTH_FRAG_PARS,
  LOGDEPTH_VERT,
  LOGDEPTH_VERT_PARS,
  OUTPUT_FRAG,
  SIMPLEX_3D,
} from './glsl';
import type { QualityPreset } from './quality';

// Continents: shared between the color and aux bakes.
const EARTH_FUNCS = /* glsl */ `
${SIMPLEX_3D}
float continent(vec3 p) {
  vec3 w = p + 0.35 * vec3(fbm(p * 1.3 + 11.0, 4, 2.0, 0.5), fbm(p * 1.3 + 23.0, 4, 2.0, 0.5), fbm(p * 1.3 + 37.0, 4, 2.0, 0.5));
  float c = fbm(w * 1.15, 7, 2.05, 0.52);
  c += 0.12 * ridged(w * 3.0 + 5.0, 4) - 0.06;
  return c;
}
`;

const SEA_LEVEL = 0.035;

const EARTH_COLOR_FRAG = /* glsl */ `
${EARTH_FUNCS}
void main() {
  vec3 p = normalize(vDir);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float c = continent(p);
  float land = smoothstep(${SEA_LEVEL}, ${SEA_LEVEL + 0.012}, c);
  float elev = max(c - ${SEA_LEVEL}, 0.0);

  // Ocean: deep to shallow near coasts.
  float shallow = smoothstep(${SEA_LEVEL - 0.12}, ${SEA_LEVEL}, c);
  vec3 ocean = mix(vec3(0.004, 0.025, 0.09), vec3(0.02, 0.13, 0.22), shallow);

  // Land biomes: latitude belt + moisture noise.
  float alat = abs(lat) / 1.5708;
  float moist = fbm(p * 3.0 + 71.0, 4, 2.0, 0.5) * 0.5 + 0.5;
  float desertBelt = exp(-pow((alat - 0.28) / 0.12, 2.0));
  vec3 forest = vec3(0.05, 0.14, 0.035);
  vec3 grass = vec3(0.16, 0.24, 0.07);
  vec3 desert = vec3(0.52, 0.40, 0.24);
  vec3 tundra = vec3(0.26, 0.25, 0.20);
  vec3 rock = vec3(0.30, 0.27, 0.24);
  vec3 col = mix(grass, forest, smoothstep(0.45, 0.7, moist) * (1.0 - alat * 0.6));
  col = mix(col, desert, smoothstep(0.35, 0.75, desertBelt * (1.2 - moist)));
  col = mix(col, tundra, smoothstep(0.55, 0.72, alat));
  col = mix(col, rock, smoothstep(0.12, 0.25, elev));
  // Detail variation.
  col *= 0.85 + 0.3 * (fbm(p * 18.0, 3, 2.0, 0.5) * 0.5 + 0.5);

  vec3 surface = mix(ocean, col, land);
  // Ice caps and high snow.
  float ice = smoothstep(0.80, 0.84, alat + 0.04 * snoise(p * 6.0));
  float snow = smoothstep(0.22, 0.3, elev) * land;
  surface = mix(surface, vec3(0.85, 0.88, 0.92), max(ice, snow));
  // Alpha = specular (open water).
  float spec = (1.0 - land) * (1.0 - ice);
  gl_FragColor = vec4(surface, spec);
}
`;

const EARTH_AUX_FRAG = /* glsl */ `
${EARTH_FUNCS}
void main() {
  vec3 p = normalize(vDir);
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float alat = abs(lat) / 1.5708;
  float c = continent(p);
  float land = smoothstep(${SEA_LEVEL}, ${SEA_LEVEL + 0.012}, c);
  float coast = 1.0 - smoothstep(0.0, 0.08, c - ${SEA_LEVEL});
  // City lights: clustered noise, more near coasts, none at the poles or in deserts.
  float cluster = smoothstep(0.15, 0.55, fbm(p * 7.0 + 3.0, 4, 2.0, 0.5));
  float specks = smoothstep(0.55, 0.85, snoise(p * 140.0) * 0.5 + 0.5);
  float lights = land * cluster * specks * (0.4 + 0.6 * coast) * (1.0 - smoothstep(0.55, 0.7, alat));
  // Clouds: warped fbm with banding by latitude (ITCZ, mid-latitude storms).
  vec3 q = p + 0.5 * vec3(fbm(p * 2.0 + 91.0, 3, 2.0, 0.5), fbm(p * 2.0 + 47.0, 3, 2.0, 0.5), fbm(p * 2.0 + 13.0, 3, 2.0, 0.5));
  float cl = fbm(q * 3.2, 6, 2.1, 0.52) * 0.5 + 0.5;
  float band = 0.25 + 0.2 * exp(-pow(alat / 0.08, 2.0)) + 0.25 * exp(-pow((alat - 0.6) / 0.15, 2.0));
  float clouds = smoothstep(0.62 - band * 0.3, 0.85, cl);
  gl_FragColor = vec4(lights, clouds, max(c - ${SEA_LEVEL}, 0.0) * 3.0, land);
}
`;

const SURFACE_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vObjDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  vObjDir = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGDEPTH_VERT}
}
`;

const EARTH_SURFACE_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform samplerCube uColor;
uniform samplerCube uAux;
uniform vec3 uSunDir;
varying vec3 vObjDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  ${LOGDEPTH_FRAG}
  vec4 c = textureCube(uColor, vObjDir);
  vec4 aux = textureCube(uAux, vObjDir);
  vec3 n = normalize(vWorldNormal);
  vec3 l = normalize(uSunDir);
  vec3 v = normalize(cameraPosition - vWorldPos);
  float ndl = dot(n, l);
  float day = smoothstep(-0.12, 0.2, ndl);
  vec3 lit = c.rgb * max(ndl, 0.0) * 1.7;
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 80.0) * c.a * smoothstep(0.0, 0.1, ndl);
  vec3 night = vec3(1.0, 0.72, 0.38) * aux.r * (1.0 - day) * 2.5;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  vec3 haze = vec3(0.28, 0.5, 1.0) * fres * smoothstep(-0.25, 0.4, ndl) * 0.9;
  vec3 col = lit + spec * vec3(1.0, 0.9, 0.75) * 0.55 + night + haze;
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_FRAG}
}
`;

const CLOUD_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform samplerCube uAux;
uniform vec3 uSunDir;
varying vec3 vObjDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  ${LOGDEPTH_FRAG}
  float a = textureCube(uAux, vObjDir).g;
  vec3 n = normalize(vWorldNormal);
  float ndl = dot(n, normalize(uSunDir));
  float lightAmt = smoothstep(-0.15, 0.35, ndl);
  vec3 sunset = mix(vec3(1.0, 0.55, 0.3), vec3(1.0), smoothstep(0.0, 0.35, ndl));
  gl_FragColor = vec4(sunset * lightAmt * 0.85, a * 0.9);
  ${OUTPUT_FRAG}
}
`;

/** Atmosphere glow shell: integrates an exponential haze along the view ray's closest approach. */
export const ATMOSPHERE_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uR;
uniform float uRa;
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vWorldPos;
void main() {
  ${LOGDEPTH_FRAG}
  vec3 ro = cameraPosition - uCenter;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  float tca = -dot(ro, rd);
  vec3 pc = ro + rd * max(tca, 0.0);
  float d = length(pc);
  if (d > uRa) discard;
  float hNorm = clamp((d - uR) / (uRa - uR), 0.0, 1.0);
  float dens = exp(-hNorm * 5.5);
  if (d < uR) dens *= 0.0;
  float sunDot = dot(normalize(pc), normalize(uSunDir));
  float lit = smoothstep(-0.35, 0.25, sunDot);
  vec3 sunset = vec3(1.0, 0.45, 0.18);
  vec3 col = mix(sunset, uColor, smoothstep(-0.05, 0.35, sunDot));
  gl_FragColor = vec4(col * dens * lit * uIntensity, 1.0);
  ${OUTPUT_FRAG}
}
`;

export const ATMOSPHERE_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGDEPTH_VERT}
}
`;

export interface EarthVisual {
  /** Non-rotating container; position it at Earth's center (relative to floating origin). */
  group: THREE.Group;
  /** Rotating surface (apply Earth rotation angle to rotation.y). */
  spin: THREE.Group;
  setSunDirection(dir: THREE.Vector3): void;
  /** Scale the atmosphere glow (dim it when the camera is inside the atmosphere). */
  setAtmosphereIntensity(x: number): void;
  /** Animate clouds; `rotation` is the Earth rotation angle (rad). */
  update(rotation: number, time: number): void;
  dispose(): void;
}

export function createEarth(renderer: THREE.WebGLRenderer, q: QualityPreset, radius: number): EarthVisual {
  const face = q.planetTextureSize / 2;
  const color = cachedBake(renderer, `earth-color-${face}`, () => bakeCube(renderer, face, EARTH_COLOR_FRAG));
  const aux = cachedBake(renderer, `earth-aux-${face}`, () => bakeCube(renderer, face, EARTH_AUX_FRAG));
  const sunDir = new THREE.Vector3(1, 0, 0);

  const group = new THREE.Group();
  group.name = 'earth';
  const spin = new THREE.Group();
  group.add(spin);

  const seg = q.sphereSegments;
  const geo = new THREE.SphereGeometry(radius, seg, seg / 2);
  const surfaceMat = new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERT,
    fragmentShader: EARTH_SURFACE_FRAG,
    uniforms: { uColor: { value: color.texture }, uAux: { value: aux.texture }, uSunDir: { value: sunDir } },
  });
  const surface = new THREE.Mesh(geo, surfaceMat);
  surface.name = 'earth-surface';
  spin.add(surface);

  let clouds: THREE.Mesh | null = null;
  if (q.clouds) {
    const cloudMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: { uAux: { value: aux.texture }, uSunDir: { value: sunDir } },
      transparent: true,
      depthWrite: false,
    });
    clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.0012, seg, seg / 2), cloudMat);
    clouds.name = 'earth-clouds';
    clouds.renderOrder = 1;
    spin.add(clouds);
  }

  const atmoMat = new THREE.ShaderMaterial({
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
    uniforms: {
      uSunDir: { value: sunDir },
      uCenter: { value: new THREE.Vector3() },
      uR: { value: radius },
      uRa: { value: radius * 1.025 },
      uColor: { value: new THREE.Color(0.32, 0.58, 1.0) },
      uIntensity: { value: 1.6 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.025, Math.max(32, seg / 2), Math.max(16, seg / 4)), atmoMat);
  atmo.name = 'earth-atmosphere';
  atmo.renderOrder = 2;
  atmo.onBeforeRender = () => {
    atmo.getWorldPosition(atmoMat.uniforms.uCenter.value);
  };
  group.add(atmo);

  return {
    group,
    spin,
    setSunDirection(dir) {
      sunDir.copy(dir).normalize();
    },
    setAtmosphereIntensity(x) {
      atmoMat.uniforms.uIntensity.value = 1.6 * x;
    },
    update(rotation, time) {
      spin.rotation.y = rotation;
      // Clouds drift slowly relative to the surface.
      if (clouds) clouds.rotation.y = time * 2e-6;
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    },
  };
}
