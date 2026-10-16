import * as THREE from 'three';
import type { Vec3 } from '../physics/vec';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { mulberry32 } from '../util/rng';

const VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;
uniform float uScale;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 1.0, 512.0);
  ${LOGDEPTH_VERT}
}
`;

const FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 uColor;
varying float vAlpha;
void main() {
  ${LOGDEPTH_FRAG}
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  float a = (1.0 - r) * (1.0 - r) * vAlpha;
  gl_FragColor = vec4(uColor, a);
}
`;

/**
 * Exhaust smoke / steam particles. Positions are kept in double precision
 * (ECI meters) and re-based to the floating origin every frame.
 */
export class SmokeSystem {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float64Array;
  private vel: Float64Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private next = 0;
  private emitAcc = 0;
  private rng = mulberry32(7);

  constructor(count: number) {
    this.n = Math.max(1, count);
    this.pos = new Float64Array(this.n * 3);
    this.vel = new Float64Array(this.n * 3);
    this.age = new Float32Array(this.n).fill(1e9);
    this.life = new Float32Array(this.n).fill(1);
    this.size0 = new Float32Array(this.n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.n), 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(this.n), 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 600 }, uColor: { value: new THREE.Color(0.85, 0.84, 0.82) } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  setViewportHeight(px: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = px / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  setLight(brightness: number): void {
    const b = Math.max(0.08, Math.min(1, brightness));
    this.mat.uniforms.uColor.value.setRGB(0.86 * b, 0.85 * b, 0.83 * b);
  }

  /**
   * Emit particles at `at` (ECI) with base velocity `baseVel` (ECI, usually the
   * local air velocity) and spray along `dir` at `speed`.
   */
  emit(dt: number, rate: number, at: Vec3, baseVel: Vec3, dir: Vec3, speed: number, size: number, life: number): void {
    this.emitAcc += rate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      const j = (this.rng() - 0.5) * 0.6;
      const k = (this.rng() - 0.5) * 0.6;
      this.pos[i * 3] = at.x;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z;
      const s = speed * (0.5 + this.rng());
      this.vel[i * 3] = baseVel.x + dir.x * s + j * speed;
      this.vel[i * 3 + 1] = baseVel.y + dir.y * s + k * speed;
      this.vel[i * 3 + 2] = baseVel.z + dir.z * s + (j - k) * speed * 0.5;
      this.age[i] = 0;
      this.life[i] = life * (0.6 + 0.8 * this.rng());
      this.size0[i] = size * (0.7 + 0.6 * this.rng());
    }
  }

  /** Advance particles; `drag` relaxes velocity toward `airVel(pos)` (here: a constant). */
  update(dt: number, origin: Vec3, airVel: Vec3): void {
    const p = this.geo.attributes.position as THREE.BufferAttribute;
    const sz = this.geo.attributes.aSize as THREE.BufferAttribute;
    const al = this.geo.attributes.aAlpha as THREE.BufferAttribute;
    const pa = p.array as Float32Array;
    const sa = sz.array as Float32Array;
    const aa = al.array as Float32Array;
    const relax = 1 - Math.exp(-dt * 0.8);
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const f = this.age[i] / this.life[i];
      if (f >= 1) {
        aa[i] = 0;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = this.vel[i * 3 + c];
        const target = c === 0 ? airVel.x : c === 1 ? airVel.y : airVel.z;
        this.vel[i * 3 + c] = v + (target - v) * relax;
        this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      }
      pa[i * 3] = this.pos[i * 3] - origin.x;
      pa[i * 3 + 1] = this.pos[i * 3 + 2] - origin.z;
      pa[i * 3 + 2] = -(this.pos[i * 3 + 1] - origin.y);
      sa[i] = this.size0[i] * (1 + 5 * f);
      aa[i] = Math.min(1, f * 8) * (1 - f) * 0.55;
    }
    p.needsUpdate = true;
    sz.needsUpdate = true;
    al.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
