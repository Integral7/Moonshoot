import * as THREE from 'three';
import { gaussian, mulberry32 } from '../util/rng';

/** Approximate blackbody color for a star temperature in Kelvin (Tanner Helland fit). */
export function starColor(tempK: number): THREE.Color {
  const t = tempK / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color(c(r), c(g), c(b));
}

const vertexShader = /* glsl */ `
  attribute float size;
  attribute float phase;
  varying vec3 vColor;
  varying float vTwinkle;
  uniform float uTime;
  uniform float uPixelRatio;
  void main() {
    vColor = color;
    vTwinkle = 0.85 + 0.15 * sin(uTime * (1.3 + phase) + phase * 40.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * uPixelRatio;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 6.0);
    float halo = exp(-r2 * 2.0) * 0.35;
    gl_FragColor = vec4(vColor * (core + halo) * vTwinkle, 1.0);
  }
`;

/**
 * Procedural starfield on a large sphere. Stars are concentrated toward a
 * tilted galactic plane to suggest the Milky Way. Render it with a camera-
 * following transform (position copied each frame) so it appears at infinity.
 */
export function createStarfield(count: number, radius = 1e5, seed = 1969): THREE.Points {
  const rng = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  // Galactic plane normal, tilted ~60 degrees.
  const galNormal = new THREE.Vector3(0.0, Math.cos(1.05), Math.sin(1.05)).normalize();
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // 45% of stars hug the galactic band.
    v.set(gaussian(rng), gaussian(rng), gaussian(rng)).normalize();
    if (rng() < 0.45) {
      // Squash the out-of-plane component so the star lands near the band.
      v.addScaledVector(galNormal, -0.88 * v.dot(galNormal)).normalize();
    }
    positions[i * 3] = v.x * radius;
    positions[i * 3 + 1] = v.y * radius;
    positions[i * 3 + 2] = v.z * radius;
    // Temperature skewed toward cooler stars.
    const temp = 2800 + Math.pow(rng(), 2.2) * 22000;
    const mag = Math.pow(rng(), 6); // most stars faint
    const c = starColor(temp).multiplyScalar(0.25 + 1.6 * mag);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    sizes[i] = 1.2 + mag * 4.5;
    phases[i] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  points.name = 'starfield';
  return points;
}

export function updateStarfield(stars: THREE.Points, time: number, camera: THREE.Camera): void {
  (stars.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  stars.position.copy(camera.position);
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
  });
}

function disposeMaterial(m: THREE.Material): void {
  for (const value of Object.values(m)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k of Object.keys(u)) if (u[k].value instanceof THREE.Texture) u[k].value.dispose();
  m.dispose();
}
