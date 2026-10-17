import * as THREE from 'three';
import { R_MOON } from '../physics/constants';
import type { LunarTerrain } from '../sim/terrain';
import { hash2 } from '../util/noise';

/** Moon-fixed vector -> scene axes (x, z, -y). */
const toScene = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, z, -y);

/**
 * Streaming terrain tile: a polar grid centered under the vehicle with
 * quadratic ring spacing (fine near the center, reaching to the horizon).
 * Vertices are relative to the tile center for float32 precision; the mesh
 * lives in the Moon's rotating (body-fixed) group.
 */
export class TerrainTile {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private n: number;
  private cx = NaN;
  private cy = NaN;
  private extent = 0;
  private boulders: THREE.InstancedMesh;
  private boulderGeo: THREE.BufferGeometry;
  private boulderMat: THREE.MeshStandardMaterial;
  private bx = NaN;
  private by = NaN;
  private siteMarker: THREE.Mesh;
  /** Map position of the tile center and its Moon-fixed position (for placing objects). */
  private centerFixed = new THREE.Vector3();

  constructor(private terrain: LunarTerrain, resolution: number) {
    // Square grid, radially stretched (p = q|q|): fine cells under the lander, reaching the horizon,
    // with cell aspect ~2:1 everywhere (a polar grid makes long thin spokes near the center).
    this.n = Math.max(48, resolution) | 1;
    const nv = this.n * this.n;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    const idx: number[] = [];
    const n = this.n;
    // Counter-clockwise seen from above (east, north, up is right-handed), so normals point up.
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    this.geo.setIndex(idx);
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'terrain';
    this.group.add(this.mesh);

    // Low-poly rock, randomly lumped.
    const rock = new THREE.IcosahedronGeometry(1, 1);
    const p = rock.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const f = 0.75 + 0.5 * hash2(i, 7, 3);
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.75, p.getZ(i) * f);
    }
    rock.computeVertexNormals();
    this.boulderGeo = rock;
    this.boulderMat = new THREE.MeshStandardMaterial({ color: 0x8f8c87, roughness: 0.95, flatShading: true });
    this.boulders = new THREE.InstancedMesh(rock, this.boulderMat, 600);
    this.boulders.count = 0;
    this.boulders.frustumCulled = false;
    this.group.add(this.boulders);

    this.siteMarker = new THREE.Mesh(
      new THREE.RingGeometry(5, 6.5, 40),
      new THREE.MeshBasicMaterial({ color: 0x5ee08f, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
    );
    this.siteMarker.visible = false;
    this.siteMarker.renderOrder = 10;
    this.group.add(this.siteMarker);
  }

  /** Recenter/rebuild if the vehicle moved or the desired extent changed. Returns true if rebuilt. */
  update(x: number, y: number, altitude: number): boolean {
    const horizon = Math.sqrt(2 * R_MOON * Math.max(altitude, 20));
    const want = Math.min(420_000, Math.max(2_500, horizon * 2.2));
    const moved = Math.hypot(x - this.cx, y - this.cy);
    const rebuild = !Number.isFinite(this.cx) || moved > this.extent * 0.06 || want > this.extent * 1.35 || want < this.extent / 1.8;
    if (rebuild) this.build(x, y, want);
    if (altitude < 1_500 && (!Number.isFinite(this.bx) || Math.hypot(x - this.bx, y - this.by) > 25)) this.placeBoulders(x, y, Math.min(450, altitude * 3 + 80));
    else if (altitude >= 1_500 && this.boulders.count) this.boulders.count = 0;
    return rebuild;
  }

  private build(cx: number, cy: number, extent: number): void {
    const t = this.terrain;
    this.cx = cx;
    this.cy = cy;
    this.extent = extent;
    const h0 = t.height(cx, cy);
    const d0 = t.toDir(cx, cy);
    const c0 = { x: d0.x * (R_MOON + h0), y: d0.y * (R_MOON + h0), z: d0.z * (R_MOON + h0) };
    toScene(c0.x, c0.y, c0.z, this.centerFixed);
    this.group.position.copy(this.centerFixed);
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const col = this.geo.attributes.color as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const put = (i: number, mx: number, my: number) => {
      const h = t.height(mx, my);
      const d = t.toDir(mx, my);
      const r = R_MOON + h;
      toScene(d.x * r - c0.x, d.y * r - c0.y, d.z * r - c0.z, v);
      pos.setXYZ(i, v.x, v.y, v.z);
      // Albedo: highland gray with noise; bright fresh rims, darker bowls.
      const local = h - t.height(mx + 37, my - 23) * 0.5 - t.height(mx - 41, my + 29) * 0.5;
      const n = hash2(Math.floor(mx / 7), Math.floor(my / 7), 5) * 0.06;
      const g = Math.max(0.25, Math.min(0.8, 0.5 + n + local * 0.004));
      col.setXYZ(i, g, g * 0.985, g * 0.96);
    };
    const n = this.n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const qx = (2 * i) / (n - 1) - 1;
        const qy = (2 * j) / (n - 1) - 1;
        const q = Math.hypot(qx, qy);
        put(j * n + i, cx + extent * qx * q, cy + extent * qy * q);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.bx = NaN;
  }

  /** Position (relative to the tile group) of a map point on the surface, raised by `lift`. */
  pointAt(mx: number, my: number, lift = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.terrain;
    const h = t.height(mx, my) + lift;
    const d = t.toDir(mx, my);
    const r = R_MOON + h;
    toScene(d.x * r, d.y * r, d.z * r, out);
    return out.sub(this.centerFixed);
  }

  private placeBoulders(x: number, y: number, radius: number): void {
    this.bx = x;
    this.by = y;
    const t = this.terrain;
    const c = t.boulderCell;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3();
    let n = 0;
    const max = (this.boulders.instanceMatrix.array.length / 16) | 0;
    for (let i = Math.floor((x - radius) / c); i <= Math.floor((x + radius) / c) && n < max; i++) {
      for (let j = Math.floor((y - radius) / c); j <= Math.floor((y + radius) / c) && n < max; j++) {
        const b = t.boulderInCell(i, j);
        if (!b || Math.hypot(b.x - x, b.y - y) > radius) continue;
        this.pointAt(b.x, b.y, b.radius * 0.25, p);
        const d = t.toDir(b.x, b.y);
        toScene(d.x, d.y, d.z, up);
        q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(i, j, 9) * 6.28));
        s.setScalar(b.radius);
        m.compose(p, q, s);
        this.boulders.setMatrixAt(n++, m);
      }
    }
    this.boulders.count = n;
    this.boulders.instanceMatrix.needsUpdate = true;
  }

  /** Show the landing-point designator at a map position (null to hide). */
  setSite(site: { x: number; y: number } | null): void {
    this.siteMarker.visible = !!site;
    if (!site) return;
    this.pointAt(site.x, site.y, 0.4, this.siteMarker.position);
    const d = this.terrain.toDir(site.x, site.y);
    const up = new THREE.Vector3();
    toScene(d.x, d.y, d.z, up);
    this.siteMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.boulderGeo.dispose();
    this.boulderMat.dispose();
    this.boulders.dispose();
    this.siteMarker.geometry.dispose();
    (this.siteMarker.material as THREE.Material).dispose();
  }
}
