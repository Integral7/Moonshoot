import * as THREE from 'three';
import type { Vec3 } from '../physics/vec';

// Physics uses ECI with +Z north; Three.js is +Y up. Mapping (right-handed both):
//   scene.x = eci.x, scene.y = eci.z, scene.z = -eci.y
// A rotation about ECI +Z by angle a equals a rotation about scene +Y by a.
// Scene units are meters. Positions are rendered relative to a floating origin
// (double precision subtraction on the CPU) to keep GPU float32 precision.

export function eciToScene(v: Vec3, origin: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x - origin.x, v.z - origin.z, -(v.y - origin.y));
}

export function eciDirToScene(v: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}

export function sceneDirToEci(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: -v.z, z: v.y };
}

/** Fill a Float32Array of positions (scene axes) from ECI points relative to an anchor. */
export function eciPointsToScene(points: Vec3[], anchor: Vec3, out?: Float32Array): Float32Array {
  const arr = out && out.length >= points.length * 3 ? out : new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    arr[i * 3] = p.x - anchor.x;
    arr[i * 3 + 1] = p.z - anchor.z;
    arr[i * 3 + 2] = -(p.y - anchor.y);
  }
  return arr;
}
