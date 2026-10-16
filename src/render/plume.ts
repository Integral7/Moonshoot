import * as THREE from 'three';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

const VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float uTime;
uniform float uThrottle;
uniform float uVacuum;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec2 vUv;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  ${LOGDEPTH_FRAG}
  // vUv.y = 1 at the nozzle, 0 at the tail (CylinderGeometry convention).
  float along = 1.0 - vUv.y;
  float facing = abs(dot(normalize(vNormalV), normalize(-vViewPos)));
  float core = pow(facing, 1.5);
  float fade = pow(1.0 - along, 1.6);
  // Shock diamonds in the dense atmosphere, gone in vacuum.
  float diamonds = (1.0 - uVacuum) * 0.55 * pow(max(0.0, sin(along * 34.0 - uTime * 2.0)), 6.0) * (1.0 - along);
  float flicker = 0.88 + 0.12 * sin(uTime * 47.0 + along * 23.0) * sin(uTime * 31.0 + vUv.x * 40.0);
  vec3 col = mix(uEdge, uCore, core * (1.0 - along * 0.7));
  float intensity = (core * 0.9 + 0.25) * fade * flicker * uThrottle * mix(1.0, 0.45, uVacuum) + diamonds * uThrottle;
  gl_FragColor = vec4(col * intensity * 3.0, 1.0);
}
`;

export interface Plume {
  mesh: THREE.Mesh;
  /** throttle 0..1, vacuum 0 (sea level) .. 1 (vacuum), time s. */
  update(throttle: number, vacuum: number, time: number): void;
  dispose(): void;
}

/** Additive cone plume hanging below a nozzle of the given exit radius (local -Y). */
export function createPlume(exitRadius: number, color: 'kerolox' | 'hydrolox' | 'hypergolic' = 'kerolox'): Plume {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  geo.translate(0, -0.5, 0); // top at y=0 (nozzle), extends down to y=-1
  const palette = {
    kerolox: { core: new THREE.Color(1.0, 0.92, 0.7), edge: new THREE.Color(1.0, 0.42, 0.08) },
    hydrolox: { core: new THREE.Color(0.85, 0.9, 1.0), edge: new THREE.Color(0.55, 0.45, 1.0) },
    hypergolic: { core: new THREE.Color(1.0, 0.85, 0.65), edge: new THREE.Color(0.95, 0.5, 0.25) },
  }[color];
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uVacuum: { value: 0 },
      uCore: { value: palette.core },
      uEdge: { value: palette.edge },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  mat.toneMapped = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'plume';
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  // Scale the unit cone: bottom radius 1, top radius set via a morph-free trick:
  // we scale x/z by the tail radius and pinch the nozzle end in the vertex positions.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const base = Float32Array.from(pos.array as Float32Array);
  return {
    mesh,
    update(throttle, vacuum, time) {
      mat.uniforms.uThrottle.value = throttle;
      mat.uniforms.uVacuum.value = vacuum;
      mat.uniforms.uTime.value = time;
      mesh.visible = throttle > 0.01;
      if (!mesh.visible) return;
      // Plume shape: under-expanded in vacuum (wide), tight at sea level.
      const length = exitRadius * (7 + 22 * vacuum) * (0.6 + 0.4 * throttle);
      const tail = exitRadius * (1.15 + 6.5 * vacuum);
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const t = -base[i + 1]; // 0 at nozzle, 1 at tail
        const r = exitRadius + (tail - exitRadius) * Math.pow(t, 0.7);
        arr[i] = base[i] * r;
        arr[i + 2] = base[i + 2] * r;
        arr[i + 1] = base[i + 1] * length;
      }
      pos.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/** Propellant family of an engine part, for plume color. */
export function plumeColorFor(engineId: string): 'kerolox' | 'hydrolox' | 'hypergolic' {
  if (engineId === 'eng-j2' || engineId === 'eng-rl10') return 'hydrolox';
  if (engineId === 'eng-sps' || engineId === 'eng-dps') return 'hypergolic';
  return 'kerolox';
}
