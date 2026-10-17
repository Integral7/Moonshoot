import * as THREE from 'three';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

/**
 * Plasma sheath: an additive, fresnel-bright shell stretched ahead of the heat
 * shield. `update(intensity)` with intensity ~ heat flux / 2 MW/m^2.
 */
export function createPlasmaGlow(radius: number): { mesh: THREE.Mesh; update(intensity: number, time: number): void; dispose(): void } {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        vY = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        ${LOGDEPTH_VERT}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_FRAG_PARS}
      uniform float uI;
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        ${LOGDEPTH_FRAG}
        float rim = pow(1.0 - abs(dot(vN, vV)), 1.6);
        float front = smoothstep(0.6, -1.0, vY);
        float flicker = 0.85 + 0.15 * sin(uTime * 37.0 + vY * 9.0);
        vec3 col = mix(vec3(1.0, 0.32, 0.1), vec3(1.0, 0.6, 0.3), front);
        gl_FragColor = vec4(col * (rim * 0.55 + front * 0.18) * uI * flicker, 1.0);
      }`,
    uniforms: { uI: { value: 0 }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  mat.toneMapped = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(radius * 1.25, radius * 2.2, radius * 1.25);
  mesh.position.y = -radius * 0.4;
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(i, time) {
      mat.uniforms.uI.value = Math.min(3, i);
      mat.uniforms.uTime.value = time;
      mesh.visible = i > 0.02;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * Local curved surface patch (ocean or land) under the descending capsule,
 * built relative to its center like the launch-site ground. Local frame:
 * +X up, +Y north, -Z east (scene axes at the patch point on the equator);
 * the caller orients the group.
 */
export function createSurfacePatch(planetRadius: number, ocean: boolean, extent = 80_000): { group: THREE.Group; setOpacity(a: number): void; dispose(): void } {
  const N = 64;
  const half = extent / 2;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const east = -half + (extent * i) / N;
      const north = -half + (extent * j) / N;
      const ang = Math.hypot(east, north) / planetRadius;
      verts.push(-planetRadius * (1 - Math.cos(ang)), north, -east);
    }
  }
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: ocean ? 0x0e3550 : 0x5a6440,
    roughness: ocean ? 0.25 : 0.95,
    metalness: ocean ? 0.15 : 0,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  return {
    group,
    setOpacity(a) {
      mat.opacity = a;
      mat.depthWrite = a > 0.99;
      mesh.visible = a > 0.01;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
