import * as THREE from 'three';
import { mulberry32 } from '../util/rng';

// The launch site is built in a local frame tangent to Earth at the pad:
// +X = local up, +Y = north, -Z = east (scene axes at lat 0, lon 0, where the
// body-fixed position is scene +X). The group is placed at radius R on the
// rotating Earth.

function valueNoise(seed: number) {
  const rng = mulberry32(seed);
  const G = 64;
  const grid = new Float32Array(G * G).map(() => rng());
  const at = (x: number, y: number) => grid[((y % G) + G) % G * G + (((x % G) + G) % G)];
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Procedural ground texture: coastal scrubland, beach, ocean to the east, roads. */
function groundTexture(size: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const n1 = valueNoise(3);
  const n2 = valueNoise(11);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const fbm = 0.5 * n1(u * 8, v * 8) + 0.25 * n1(u * 16, v * 16) + 0.125 * n2(u * 40, v * 40) + 0.0625 * n2(u * 90, v * 90);
      // Coastline runs north-south, east of the pad (u increases eastward).
      const coast = 0.6 + 0.06 * (n2(v * 6, 3.3) - 0.5) * 2;
      let r: number, gg: number, b: number;
      if (u > coast + 0.012) {
        const depth = Math.min(1, (u - coast) * 6);
        r = 10 + 20 * (1 - depth); gg = 50 + 50 * (1 - depth); b = 80 + 40 * (1 - depth);
      } else if (u > coast) {
        r = 194; gg = 178; b = 140;
      } else {
        const lush = fbm;
        r = 70 + 50 * (1 - lush); gg = 82 + 40 * lush; b = 48 + 10 * lush;
        if (n2(u * 30, v * 30) > 0.78) { r *= 0.8; gg *= 0.85; b *= 0.8; }
      }
      const k = (y * size + x) * 4;
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Roads and the crawlerway to the pad at the center.
  g.strokeStyle = 'rgba(150,150,145,0.9)';
  g.lineWidth = Math.max(1, size / 700);
  g.beginPath();
  g.moveTo(size * 0.5, size * 0.5);
  g.lineTo(size * 0.2, size * 0.62);
  g.lineTo(size * 0.05, size * 0.63);
  g.moveTo(size * 0.2, size * 0.62);
  g.lineTo(size * 0.22, size * 0.95);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface LaunchSite {
  group: THREE.Group;
  ground: THREE.Mesh;
  /** Swing arms, retracted at liftoff. */
  setArmsRetracted(f: number): void;
  /** Fade ground with altitude (1 = opaque). */
  setGroundOpacity(a: number): void;
  dispose(): void;
}

/**
 * Build the pad, tower, and a curved ground patch (spherical cap of radius
 * `planetRadius`, `extent` meters across) in the pad-local frame.
 */
export function createLaunchSite(planetRadius: number, vehicleHeight: number, textureSize = 1024, extent = 60_000): LaunchSite {
  const group = new THREE.Group();
  group.name = 'launch-site';
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // Ground cap, vertices relative to the pad (precise near the camera).
  const N = 96;
  const half = extent / 2;
  const geo = track(new THREE.BufferGeometry());
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const east = -half + (extent * i) / N;
      const north = -half + (extent * j) / N;
      const ang = Math.hypot(east, north) / planetRadius;
      const drop = planetRadius * (1 - Math.cos(ang));
      // Local frame: x = up, y = north, z = -east.
      verts.push(-drop - 2.0, north, -east);
      uvs.push(i / N, 1 - j / N);
    }
  }
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1);
    }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = track(groundTexture(textureSize));
  const groundMat = track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, transparent: true }));
  const ground = new THREE.Mesh(geo, groundMat);
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  // Pad: octagonal concrete hardstand with a flame trench.
  const concrete = track(new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.9 }));
  const dark = track(new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.8, metalness: 0.3 }));
  const red = track(new THREE.MeshStandardMaterial({ color: 0xb03a22, roughness: 0.6, metalness: 0.4 }));
  const pad = new THREE.Mesh(track(new THREE.CylinderGeometry(75, 85, 2, 8)), concrete);
  pad.rotation.z = Math.PI / 2; // cylinder axis along local up (+X)
  pad.position.x = -1;
  pad.receiveShadow = true;
  group.add(pad);
  const trench = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 14, 160)), dark);
  trench.position.set(-0.5, 0, 0);
  group.add(trench);
  const mount = new THREE.Mesh(track(new THREE.BoxGeometry(6, 22, 22)), dark);
  mount.position.x = -3;
  group.add(mount);

  // Lattice tower to the north of the vehicle (InstancedMesh beams).
  const towerH = vehicleHeight * 1.05 + 12;
  const towerY = 30; // north offset
  const w = 12;
  const beam = track(new THREE.BoxGeometry(1, 1, 1));
  const levels = Math.ceil(towerH / 8);
  const count = 4 + levels * 8;
  const inst = new THREE.InstancedMesh(beam, red, count);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let k = 0;
  for (const [cy, cz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    p.set(towerH / 2, towerY + (cy * w) / 2, (cz * w) / 2);
    s.set(towerH, 0.9, 0.9);
    inst.setMatrixAt(k++, m4.compose(p, q.identity(), s));
  }
  for (let l = 1; l <= levels; l++) {
    const x = l * 8;
    for (const [dy, dz, ly, lz] of [[0, -w / 2, w, 0.5], [0, w / 2, w, 0.5], [-w / 2, 0, 0.5, w], [w / 2, 0, 0.5, w]]) {
      p.set(x, towerY + dy, dz);
      s.set(0.5, ly, lz);
      inst.setMatrixAt(k++, m4.compose(p, q.identity(), s));
    }
    // Diagonal braces on the two broad faces.
    for (const dz of [-w / 2, w / 2]) {
      p.set(x - 4, towerY, dz);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(8, w));
      s.set(0.35, Math.hypot(8, w), 0.35);
      inst.setMatrixAt(k++, m4.compose(p, q, s));
      q.identity();
    }
    for (const dy of [-w / 2, w / 2]) {
      p.set(x - 4, towerY + dy, 0);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(8, w));
      s.set(0.35, 0.35, Math.hypot(8, w));
      inst.setMatrixAt(k++, m4.compose(p, q, s));
      q.identity();
    }
  }
  inst.count = k;
  inst.castShadow = true;
  group.add(inst);

  // Swing arms reaching to the vehicle at a few heights.
  const arms: THREE.Group[] = [];
  const armGeo = track(new THREE.BoxGeometry(2.2, towerY - w / 2 - 3, 2.2));
  for (const frac of [0.25, 0.55, 0.85]) {
    const pivot = new THREE.Group();
    pivot.position.set(vehicleHeight * frac, towerY - w / 2, 0);
    const arm = new THREE.Mesh(armGeo, dark);
    arm.position.y = -(towerY - w / 2 - 3) / 2;
    pivot.add(arm);
    group.add(pivot);
    arms.push(pivot);
  }

  return {
    group,
    ground,
    setArmsRetracted(f) {
      for (const a of arms) a.rotation.x = f * 1.2;
    },
    setGroundOpacity(a) {
      groundMat.opacity = a;
      groundMat.depthWrite = a > 0.99;
      ground.visible = a > 0.01;
    },
    dispose() {
      inst.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
