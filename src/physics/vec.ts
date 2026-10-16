// Minimal immutable 3-vector math for the physics module (no Three.js dependency).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const UNIT_X: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });
export const UNIT_Y: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
export const UNIT_Z: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });
/** a + b * s */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len2 = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: Vec3): number => Math.sqrt(len2(a));
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const d = dot(a, b) / (len(a) * len(b) || 1);
  return Math.acos(Math.min(1, Math.max(-1, d)));
};
/** Rotate about +Z by angle (radians). */
export const rotateZ = (a: Vec3, ang: number): Vec3 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c, z: a.z };
};
/** Rotate vector `a` about unit axis `k` by angle (Rodrigues). */
export const rotateAxis = (a: Vec3, k: Vec3, ang: number): Vec3 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kxa = cross(k, a);
  const kda = dot(k, a);
  return {
    x: a.x * c + kxa.x * s + k.x * kda * (1 - c),
    y: a.y * c + kxa.y * s + k.y * kda * (1 - c),
    z: a.z * c + kxa.z * s + k.z * kda * (1 - c),
  };
};
