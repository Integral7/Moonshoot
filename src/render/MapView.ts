import * as THREE from 'three';
import type { App } from '../app/App';
import { moonPosition, type BodyId } from '../physics/bodies';
import { MOON_ORBIT_RADIUS, R_EARTH, R_MOON } from '../physics/constants';
import type { Prediction, TrajectoryEvent } from '../physics/patched';
import { vec, type Vec3 } from '../physics/vec';
import { formatDistance } from '../sim/time';
import { Labels } from '../ui/Labels';
import { eciPointsToScene, eciToScene } from './coords';
import { OrbitCamera } from './OrbitCamera';
import { PostFX } from './PostFX';
import { World } from './World';

export type FocusId = 'vessel' | 'earth' | 'moon';

const SEGMENT_COLORS: Record<BodyId, number> = { earth: 0x5cc8ff, moon: 0xffb547 };

interface EventMarker {
  mesh: THREE.Mesh;
  id: string;
  text: string;
}

/**
 * Map/orbit view: the celestial World, a vessel marker, the predicted
 * patched-conic trajectory, event markers, and an orbit camera with focus
 * switching. Used by the Earth-orbit, cruise, and return phases.
 */
export class MapView {
  readonly world: World;
  readonly cam: OrbitCamera;
  readonly labels: Labels;
  readonly fx: PostFX;
  focus: FocusId = 'vessel';
  /** Vessel position, ECI meters. */
  vesselEci: Vec3 = vec();
  /** The body whose frame the vessel is currently in. */
  vesselBody: BodyId = 'earth';
  /** Extra objects attached to the vessel marker (e.g. maneuver node gizmo). */
  readonly vesselAnchor = new THREE.Group();

  private marker: THREE.Mesh;
  private lines: THREE.Line[] = [];
  private ghostAnchor = new THREE.Group();
  private ghostMoon: THREE.Mesh;
  private ghostTime = NaN;
  private moonOrbit: THREE.LineLoop;
  private eventMarkers: EventMarker[] = [];
  private markerGeo = new THREE.SphereGeometry(1, 12, 8);
  private t = 0;
  private vesselModel: THREE.Object3D | null = null;
  private predictionVisible = true;
  /** Optional camera override applied after the orbit camera (e.g. a fixed pad camera). */
  cameraOverride: ((camera: THREE.PerspectiveCamera, origin: Vec3) => void) | null = null;
  /** Hide the vessel marker when the camera is closer than this to the vessel, m. */
  markerHideDistance = 20_000;

  constructor(
    private app: App,
    ui: HTMLElement,
  ) {
    this.world = new World(app.renderer, app.quality);
    this.cam = new OrbitCamera(50, 3e7, 30, 4e9);
    this.cam.attach(app.root);
    this.fx = new PostFX(this.world.scene, this.cam.camera, () => app.quality);
    this.labels = new Labels(ui);
    const scene = this.world.scene;

    this.marker = new THREE.Mesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    this.marker.name = 'vessel-marker';
    scene.add(this.marker, this.vesselAnchor);

    this.ghostMoon = new THREE.Mesh(
      new THREE.SphereGeometry(R_MOON, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xffb547, wireframe: true, transparent: true, opacity: 0.12 }),
    );
    this.ghostAnchor.add(this.ghostMoon);
    this.ghostAnchor.visible = false;
    scene.add(this.ghostAnchor);

    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 256; k++) {
      const a = (k / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(MOON_ORBIT_RADIUS * Math.cos(a), 0, -MOON_ORBIT_RADIUS * Math.sin(a)));
    }
    this.moonOrbit = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.18 }),
    );
    this.world.earthAnchor.add(this.moonOrbit);
  }

  /** Attach a detailed vessel model (positioned at the vessel each frame; caller sets orientation). */
  setVesselModel(obj: THREE.Object3D | null): void {
    if (this.vesselModel) this.world.scene.remove(this.vesselModel);
    this.vesselModel = obj;
    if (obj) this.world.scene.add(obj);
  }

  /** Show or hide the predicted trajectory and its event markers. */
  showPrediction(v: boolean): void {
    this.predictionVisible = v;
    for (const l of this.lines) l.visible = v;
    for (const m of this.eventMarkers) m.mesh.visible = v;
    this.ghostAnchor.visible = v && Number.isFinite(this.ghostTime);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.cam.camera;
  }

  setFocus(f: FocusId): void {
    this.focus = f;
    if (f === 'earth') this.cam.setDistance(R_EARTH * 5);
    else if (f === 'moon') this.cam.setDistance(R_MOON * 8);
  }

  cycleFocus(): FocusId {
    const order: FocusId[] = ['vessel', 'earth', 'moon'];
    this.setFocus(order[(order.indexOf(this.focus) + 1) % order.length]);
    return this.focus;
  }

  /** Replace the drawn trajectory with a new prediction. */
  setPrediction(pred: Prediction | null): void {
    for (const l of this.lines) {
      l.parent?.remove(l);
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.lines = [];
    for (const m of this.eventMarkers) {
      m.mesh.parent?.remove(m.mesh);
      (m.mesh.material as THREE.Material).dispose();
      this.labels.remove(m.id);
    }
    this.eventMarkers = [];
    if (!pred) {
      this.ghostAnchor.visible = false;
      return;
    }
    // When approaching from Earth's frame, draw Moon-relative legs around the
    // Moon's position at SOI entry (a "ghost" Moon) so the path is continuous.
    const enter = pred.events.find((e) => e.kind === 'soi-enter');
    this.ghostTime = this.vesselBody === 'earth' && enter ? enter.t : NaN;
    this.ghostAnchor.visible = this.predictionVisible && Number.isFinite(this.ghostTime);

    const maxPts = this.app.quality.trailPoints;
    for (const seg of pred.segments) {
      if (seg.points.length < 2) continue;
      const stride = Math.max(1, Math.ceil(seg.points.length / maxPts));
      const pts = stride > 1 ? seg.points.filter((_, i) => i % stride === 0 || i === seg.points.length - 1) : seg.points;
      const arr = eciPointsToScene(pts, vec());
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: SEGMENT_COLORS[seg.body], transparent: true, opacity: 0.9 }),
      );
      line.frustumCulled = false;
      line.visible = this.predictionVisible;
      this.anchorFor(seg.body).add(line);
      this.lines.push(line);
    }
    pred.events.forEach((ev, i) => this.addEventMarker(ev, i));
  }

  private anchorFor(body: BodyId): THREE.Object3D {
    if (body === 'earth') return this.world.earthAnchor;
    return Number.isFinite(this.ghostTime) ? this.ghostAnchor : this.world.moonAnchor;
  }

  private addEventMarker(ev: TrajectoryEvent, i: number): void {
    const color = ev.kind === 'impact' ? 0xff5d5d : ev.kind === 'periapsis' ? 0x5ee08f : ev.kind === 'atmosphere' ? 0xff9a3d : 0xcfd8e3;
    const mesh = new THREE.Mesh(this.markerGeo, new THREE.MeshBasicMaterial({ color }));
    const p = ev.state.r;
    mesh.position.set(p.x, p.z, -p.y);
    mesh.userData.kind = ev.kind;
    mesh.visible = this.predictionVisible;
    this.anchorFor(ev.body).add(mesh);
    const id = `ev-${i}`;
    const text =
      ev.kind === 'periapsis'
        ? `Pe ${formatDistance(ev.altitude)}`
        : ev.kind === 'impact'
          ? 'IMPACT'
          : ev.kind === 'atmosphere'
            ? 'Entry interface'
            : ev.kind === 'soi-enter'
              ? 'Moon SOI'
              : ev.kind === 'soi-exit'
                ? 'SOI exit'
                : ev.kind === 'escape'
                  ? 'Escape'
                  : ev.kind;
    this.labels.set(id, text, `label-event label-${ev.kind}`);
    this.eventMarkers.push({ mesh, id, text });
  }

  /** Current floating origin (ECI). */
  origin(): Vec3 {
    if (this.focus === 'earth') return vec();
    if (this.focus === 'moon') return moonPosition(this.t, this.world.eph);
    return this.vesselEci;
  }

  update(t: number, dt: number): void {
    this.t = t;
    this.cam.setAspect(this.app.aspect);
    this.cam.update(dt);
    const origin = this.origin();
    const camera = this.cam.camera;
    if (this.cameraOverride) this.cameraOverride(camera, origin);
    this.world.update(t, origin, camera, dt);
    if (Number.isFinite(this.ghostTime)) {
      eciToScene(moonPosition(this.ghostTime, this.world.eph), origin, this.ghostAnchor.position);
    }
    eciToScene(this.vesselEci, origin, this.marker.position);
    this.vesselAnchor.position.copy(this.marker.position);
    if (this.vesselModel) this.vesselModel.position.copy(this.marker.position);
    this.marker.visible = !this.vesselModel || this.marker.position.distanceTo(camera.position) > this.markerHideDistance;

    // Keep markers a constant apparent size.
    const pxScale = (obj: THREE.Object3D, px: number) => {
      const wp = obj.getWorldPosition(tmpV);
      const d = wp.distanceTo(camera.position);
      const s = (d * Math.tan((camera.fov * Math.PI) / 360) * 2 * px) / Math.max(1, this.app.height);
      obj.scale.setScalar(Math.max(s, 1e-3));
    };
    pxScale(this.marker, 7);
    for (const m of this.eventMarkers) pxScale(m.mesh, 4);

    // Labels.
    const w = this.app.width;
    const hgt = this.app.height;
    this.labels.set('earth', 'Earth', 'label-body').copy(this.world.earth.group.position);
    this.labels.set('moon', 'Moon', 'label-body').copy(this.world.moon.group.position);
    this.labels.set('vessel', 'Spacecraft', 'label-vessel').copy(this.marker.position);
    for (const m of this.eventMarkers) {
      this.labels.set(m.id, m.text).copy(m.mesh.getWorldPosition(tmpV));
      this.labels.show(m.id, this.predictionVisible);
    }
    this.labels.show('vessel', this.marker.visible && (this.focus !== 'vessel' || this.cam.distance > 2e5));
    this.labels.update(camera, w, hgt);
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.fx.setSize(this.app.width, this.app.height);
    this.fx.render(renderer);
  }

  onQualityChange(): void {
    this.world.rebuild(this.app.renderer, this.app.quality);
  }

  dispose(): void {
    this.cam.detach();
    this.setPrediction(null);
    this.fx.dispose();
    this.markerGeo.dispose();
    this.world.dispose();
    this.labels.root.remove();
  }
}

const tmpV = new THREE.Vector3();
