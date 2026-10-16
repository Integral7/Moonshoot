import * as THREE from 'three';
import { getPart, type PartDef } from '../sim/parts';
import { splitStages, type VehicleDesign } from '../sim/vehicle';

export interface NozzleInfo {
  stage: number;
  /** Exit-plane center in stage-group local coordinates (y up). */
  position: THREE.Vector3;
  radius: number;
}

export interface VehicleModel {
  root: THREE.Group;
  /** One group per stage, index 0 = bottom (first to fire). Positioned within root. */
  stages: THREE.Group[];
  nozzles: NozzleInfo[];
  les: THREE.Object3D | null;
  /** Parachute canopies (hidden until deployed). */
  chutes: THREE.Group | null;
  /** Height of the full stack, m (y from 0 at the lowest nozzle exit to the tip). */
  height: number;
  /** Lowest point (y) of each stage in root coordinates, for camera framing/separation. */
  stageBottoms: number[];
  /** Part meshes by design part index (for highlighting in the editor). */
  partMeshes: Map<number, THREE.Mesh[]>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Materials (procedural textures)

function panelTexture(base: string, line: string, roll: boolean): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  if (roll) {
    // Saturn-style black/white roll pattern quadrants.
    g.fillStyle = '#151515';
    g.fillRect(0, 0, w / 4, h / 2);
    g.fillRect(w / 2, 0, w / 4, h / 2);
    g.fillRect(w / 4, h / 2, w / 4, h / 2);
    g.fillRect((3 * w) / 4, h / 2, w / 4, h / 2);
  }
  g.strokeStyle = line;
  g.globalAlpha = 0.35;
  g.lineWidth = 1;
  for (let x = 0; x <= w; x += w / 16) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, h);
    g.stroke();
  }
  g.globalAlpha = 0.55;
  g.lineWidth = 2;
  for (const y of [2, h / 2, h - 2]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function foilTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 400; i++) {
    const v = 150 + Math.floor(Math.random() * 90);
    g.fillStyle = `rgb(${v + 40},${v}, ${Math.floor(v * 0.35)})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 6 + Math.random() * 18, 4 + Math.random() * 14);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

type Paint = NonNullable<PartDef['paint']>;

class MaterialSet {
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private textures: THREE.Texture[] = [];

  get(paint: Paint): THREE.MeshStandardMaterial {
    let m = this.cache.get(paint);
    if (m) return m;
    switch (paint) {
      case 'white': {
        const t = panelTexture('#eeeeea', '#8a8a86', false);
        this.textures.push(t);
        m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.05 });
        break;
      }
      case 'roll': {
        const t = panelTexture('#efefeb', '#7a7a76', true);
        this.textures.push(t);
        m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.05 });
        break;
      }
      case 'metal': {
        const t = panelTexture('#c9ced6', '#7c8590', false);
        this.textures.push(t);
        m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.32, metalness: 0.85 });
        break;
      }
      case 'gold': {
        const t = foilTexture();
        this.textures.push(t);
        m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.35, metalness: 0.9 });
        break;
      }
      case 'dark':
      default:
        m = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide });
    }
    this.cache.set(paint, m);
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers

function bellGeometry(exitRadius: number, length: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const throat = exitRadius * 0.28;
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Parabolic-ish bell from throat (top) to exit (bottom).
    const r = throat + (exitRadius - throat) * Math.pow(t, 0.6);
    pts.push(new THREE.Vector2(r, -t * length));
  }
  return new THREE.LatheGeometry(pts, 24);
}

/** Engine positions for a cluster of n engines (diameter ed) under a stage of diameter D. */
export function clusterLayout(n: number, ed: number, D: number): { x: number; z: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, z: 0 }];
  const s = ed * 1.06;
  let rOuter = Math.max(D / 2 - ed / 2, s / 2);
  for (let attempt = 0; attempt < 60; attempt++) {
    const out: { x: number; z: number }[] = [];
    let remaining = n;
    let r = rOuter;
    let ring = 0;
    let lastRing = Infinity;
    while (remaining > 0) {
      if (remaining === 1) {
        // A center engine needs the surrounding ring at least one spacing away.
        if (lastRing < s) break;
        out.push({ x: 0, z: 0 });
        remaining = 0;
        break;
      }
      if (r < s * 0.5) break;
      const cap = Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, s / (2 * r)))));
      // Leave a single engine for the center when that makes the ring symmetric.
      let k = Math.min(cap, remaining);
      if (remaining - k === 0 && remaining > 4 && remaining % 2 === 1 && ring === 0 && cap >= remaining - 1) k = remaining - 1;
      const phase = ring % 2 ? Math.PI / k : 0;
      for (let i = 0; i < k; i++) {
        const a = phase + (i / k) * Math.PI * 2;
        out.push({ x: r * Math.cos(a), z: r * Math.sin(a) });
      }
      remaining -= k;
      lastRing = r;
      r -= s;
      ring++;
    }
    if (remaining === 0) return out;
    rOuter *= 1.08; // overhang (flared skirt) if they do not fit
  }
  return Array.from({ length: n }, (_, i) => ({ x: Math.cos(i) * rOuter, z: Math.sin(i) * rOuter }));
}

interface Slot {
  part: PartDef;
  index: number;
  stage: number;
}

/**
 * Build a procedural 3D model of a vehicle design. Units are meters, +Y is up
 * along the stack, y = 0 at the bottom of the lowest engine.
 */
export function buildVehicleModel(design: VehicleDesign, opts: { segments?: number } = {}): VehicleModel {
  const seg = opts.segments ?? 32;
  const mats = new MaterialSet();
  const geometries: THREE.BufferGeometry[] = [];
  const extraMats: THREE.Material[] = [];
  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const root = new THREE.Group();
  root.name = 'vehicle';
  const partMeshes = new Map<number, THREE.Mesh[]>();
  const addMesh = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, partIndex: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partIndex = partIndex;
    parent.add(mesh);
    let list = partMeshes.get(partIndex);
    if (!list) partMeshes.set(partIndex, (list = []));
    list.push(mesh);
    return mesh;
  };

  const parts = design.parts.map((id) => getPart(id));
  // Map each design part to its stage index (bottom = 0).
  const groups = splitStages(parts);
  const slots: Slot[] = [];
  {
    let idx = 0;
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      for (const p of groups[gi]) slots.push({ part: p, index: idx++, stage: gi });
    }
  }

  const stageGroups = groups.map((_, i) => {
    const g = new THREE.Group();
    g.name = `stage-${i}`;
    root.add(g);
    return g;
  });
  const nozzles: NozzleInfo[] = [];
  let les: THREE.Object3D | null = null;
  let chutes: THREE.Group | null = null;

  // Lay out top-down: y decreases as we go down the stack.
  let y = 0;
  let prevRadius = 0;
  const stageTop: number[] = new Array(groups.length).fill(-Infinity);
  const stageBottom: number[] = new Array(groups.length).fill(Infinity);
  const stageRadius: number[] = new Array(groups.length).fill(0);

  // Pre-pass: diameter of each structural slot (for decoupler/adapter shaping).
  const structural = (p: PartDef) => p.category !== 'engine' && p.category !== 'legs';
  const nextStructuralRadius = (k: number): number => {
    for (let j = k + 1; j < slots.length; j++) if (structural(slots[j].part) && slots[j].part.category !== 'decoupler') return slots[j].part.diameter / 2;
    return prevRadius;
  };

  for (let k = 0; k < slots.length; k++) {
    const { part, index, stage } = slots[k];
    const sg = stageGroups[stage];
    const r = part.diameter / 2;
    if (!structural(part)) continue;
    const L = part.length;
    let topY = y;
    switch (part.category) {
      case 'les': {
        // Tower sits on top of the stack (base at y), extending upward.
        const tower = new THREE.Group();
        const motorR = 0.38;
        const strut = geo(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6));
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const m = addMesh(tower, strut, mats.get('dark'), index);
          m.position.set(Math.cos(a) * 0.42, 1.4, Math.sin(a) * 0.42);
        }
        addMesh(tower, geo(new THREE.CylinderGeometry(motorR, motorR, 4.2, 16)), mats.get('white'), index).position.y = 2.8 + 2.1;
        addMesh(tower, geo(new THREE.ConeGeometry(motorR, 1.4, 16)), mats.get('white'), index).position.y = 7.0 + 0.7;
        tower.position.y = y;
        sg.add(tower);
        les = tower;
        topY = y + 8.4;
        break;
      }
      case 'chutes': {
        const cap = slots[k + 1]?.part.category === 'capsule' ? slots[k + 1].part.diameter * 0.17 : r;
        addMesh(sg, geo(new THREE.CylinderGeometry(cap * 0.9, cap, L, seg)), mats.get('white'), index).position.y = y - L / 2;
        // Canopies, hidden until deployed.
        chutes = new THREE.Group();
        chutes.visible = false;
        const canopyGeo = geo(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2));
        const canopyMat = new THREE.MeshStandardMaterial({ color: 0xf4f0ea, roughness: 0.8, side: THREE.DoubleSide });
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd9542a, roughness: 0.8, side: THREE.DoubleSide });
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const c = new THREE.Mesh(canopyGeo, i % 2 ? stripeMat : canopyMat);
          c.scale.set(12, 7, 12);
          c.position.set(Math.cos(a) * 9, 34, Math.sin(a) * 9);
          chutes.add(c);
        }
        chutes.position.y = y;
        extraMats.push(canopyMat, stripeMat);
        sg.add(chutes);
        y -= L;
        break;
      }
      case 'capsule': {
        const topR = r * 0.17;
        addMesh(sg, geo(new THREE.CylinderGeometry(topR, r, L, seg, 1)), mats.get('metal'), index).position.y = y - L / 2;
        // Windows.
        const win = new THREE.MeshStandardMaterial({ color: 0x0b1a2a, roughness: 0.1, metalness: 0.2, emissive: 0x05101c });
        extraMats.push(win);
        for (let i = 0; i < 2; i++) {
          const w = new THREE.Mesh(geo(new THREE.BoxGeometry(0.35, 0.3, 0.05)), win);
          const a = -0.25 + i * 0.5;
          const rr = r * 0.55;
          w.position.set(Math.sin(a) * rr, y - L * 0.55, Math.cos(a) * rr);
          w.lookAt(w.position.x * 2, w.position.y + 0.6, w.position.z * 2);
          sg.add(w);
        }
        y -= L;
        break;
      }
      case 'shield': {
        addMesh(sg, geo(new THREE.CylinderGeometry(r, r * 0.92, L, seg)), mats.get('dark'), index).position.y = y - L / 2;
        y -= L;
        break;
      }
      case 'decoupler': {
        const above = prevRadius || r;
        const below = nextStructuralRadius(k) || r;
        const len = Math.max(L, Math.abs(below - above) * 1.4);
        addMesh(sg, geo(new THREE.CylinderGeometry(above, below, len, seg, 1, true)), mats.get('dark'), index).position.y = y - len / 2;
        y -= len;
        prevRadius = below;
        break;
      }
      case 'tank': {
        if (prevRadius && Math.abs(prevRadius - r) > 0.05 && slots[k - 1]?.part.category !== 'decoupler') {
          const len = Math.abs(prevRadius - r) * 1.4;
          addMesh(sg, geo(new THREE.CylinderGeometry(prevRadius, r, len, seg, 1, true)), mats.get(part.paint ?? 'white'), index).position.y = y - len / 2;
          y -= len;
        }
        const mat = mats.get(part.paint ?? 'white');
        const mesh = addMesh(sg, geo(new THREE.CylinderGeometry(r, r, L, seg)), mat, index);
        mesh.position.y = y - L / 2;
        y -= L;
        break;
      }
    }
    if (part.category !== 'les') stageRadius[stage] = Math.max(stageRadius[stage], r);
    if (part.category !== 'decoupler') prevRadius = r;
    stageTop[stage] = Math.max(stageTop[stage], topY);
    stageBottom[stage] = Math.min(stageBottom[stage], y);

    // After the last structural part of a stage: hang engines, legs.
    const lastOfStage = !slots.slice(k + 1).some((s) => s.stage === stage && structural(s.part));
    if (lastOfStage) {
      const engs = slots.filter((s) => s.stage === stage && s.part.category === 'engine');
      if (engs.length) {
        // Group identical engines: one cluster per engine type, concentric.
        const byType = new Map<string, Slot[]>();
        for (const e of engs) byType.set(e.part.id, [...(byType.get(e.part.id) ?? []), e]);
        let maxLen = 0;
        const D = (stageRadius[stage] || 1) * 2;
        for (const list of byType.values()) {
          const p = list[0].part;
          const layout = clusterLayout(list.length, p.diameter, D);
          const bell = geo(bellGeometry(p.diameter / 2 * 0.95, p.length * 0.78));
          const head = geo(new THREE.CylinderGeometry(p.diameter * 0.22, p.diameter * 0.28, p.length * 0.22, 12));
          list.forEach((slot, i) => {
            const pos = layout[i];
            const b = addMesh(sg, bell, mats.get('dark'), slot.index);
            b.position.set(pos.x, y - p.length * 0.22, pos.z);
            const hd = addMesh(sg, head, mats.get('dark'), slot.index);
            hd.position.set(pos.x, y - p.length * 0.11, pos.z);
            nozzles.push({ stage, position: new THREE.Vector3(pos.x, y - p.length, pos.z), radius: p.diameter / 2 * 0.95 });
          });
          maxLen = Math.max(maxLen, p.length);
        }
        // Thrust structure skirt.
        const skirt = addMesh(sg, geo(new THREE.CylinderGeometry(D / 2, D / 2 * 1.02, 0.6, seg, 1, true)), mats.get('dark'), engs[0].index);
        skirt.position.y = y - 0.3;
        y -= maxLen;
        stageBottom[stage] = Math.min(stageBottom[stage], y);
      }
      const legSlot = slots.find((s) => s.stage === stage && s.part.category === 'legs');
      if (legSlot) {
        const R = stageRadius[stage] || 2;
        const legMat = mats.get('gold');
        const strut = geo(new THREE.CylinderGeometry(0.09, 0.09, 4.2, 8));
        const pad = geo(new THREE.CylinderGeometry(0.5, 0.55, 0.12, 16));
        const footY = stageBottom[stage] - 0.4;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const top = new THREE.Vector3(Math.cos(a) * R * 0.95, footY + 3.4, Math.sin(a) * R * 0.95);
          const foot = new THREE.Vector3(Math.cos(a) * (R + 2.2), footY + 0.06, Math.sin(a) * (R + 2.2));
          const mid = top.clone().add(foot).multiplyScalar(0.5);
          const m = addMesh(sg, strut, legMat, legSlot.index);
          m.position.copy(mid);
          m.scale.y = top.distanceTo(foot) / 4.2;
          m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize());
          const p = addMesh(sg, pad, mats.get('dark'), legSlot.index);
          p.position.copy(foot);
        }
        stageBottom[stage] = Math.min(stageBottom[stage], footY);
      }
    }
  }

  // Shift so the lowest point is at y = 0.
  const minY = Math.min(y, ...stageBottom.filter(Number.isFinite));
  for (const g of stageGroups) g.position.y = -minY;
  const top = Math.max(...stageTop.filter(Number.isFinite), 0);

  return {
    root,
    stages: stageGroups,
    nozzles,
    les,
    chutes,
    height: top - minY,
    stageBottoms: stageBottom.map((b) => b - minY),
    partMeshes,
    dispose() {
      for (const g of geometries) g.dispose();
      mats.dispose();
      for (const m of extraMats) m.dispose();
    },
  };
}
