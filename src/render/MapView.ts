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
export type LayerId = 'current' | 'planned';

const LAYER_STYLE: Record<LayerId, { colors: Record<BodyId, number>; opacity: number }> = {
  current: { colors: { earth: 0x5cc8ff, moon: 0xffb547 }, opacity: 0.9 },
  planned: { colors: { earth: 0xf2f6ff, moon: 0x7dffb2 }, opacity: 0.95 },
};

interface EventMarker {
  mesh: THREE.Mesh;
  id: string;
  text: string;
}

interface Layer {
  lines: THREE.Line[];
  markers: EventMarker[];
  /** Moon-relative legs are drawn around the Moon's position at SOI entry (a "ghost" Moon). */
  ghost: THREE.Group;
  ghostTime: number;
}

const EVENT_TEXT = (ev: TrajectoryEvent): string => {
  switch (ev.kind) {
    case 'periapsis': return `Pe ${formatDistance(ev.altitude)}`;
    case 'impact': return 'IMPACT';
    case 'atmosphere': return 'Entry interface';
    case 'soi-enter': return 'Moon SOI';
    case 'soi-exit': return 'SOI exit';
    case 'escape': return 'Escape';
  }
};

/**
 * Map/orbit view: the celestial World, a vessel marker, current and planned
 * patched-conic trajectories with event markers, an optional maneuver node
 * marker, and an orbit camera with focus switching.
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
  /** Extra objects attached to the vessel marker. */
  readonly vesselAnchor = new THREE.Group();
  /** Optional camera override applied after the orbit camera (e.g. a fixed pad camera). */
  cameraOverride: ((camera: THREE.PerspectiveCamera, origin: Vec3) => void) | null = null;
  /** Hide the vessel marker when the camera is closer than this to the vessel, m. */
  markerHideDistance = 20_000;

  private marker: THREE.Mesh;
  private moonOrbit: THREE.LineLoop;
  private markerGeo = new THREE.SphereGeometry(1, 12, 8);
  private ghostGeo = new THREE.SphereGeometry(R_MOON, 32, 16);
  private ghostMat = new THREE.MeshBasicMaterial({ color: 0xffb547, wireframe: true, transparent: true, opacity: 0.12 });
  private layers: Record<LayerId, Layer>;
  private nodeMarker: THREE.Mesh;
  private nodeText = '';
  private t = 0;
  private vesselModel: THREE.Object3D | null = null;
  private predictionVisible = true;

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

    this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    this.marker.name = 'vessel-marker';
    scene.add(this.marker, this.vesselAnchor);

    const mkLayer = (): Layer => {
      const ghost = new THREE.Group();
      ghost.add(new THREE.Mesh(this.ghostGeo, this.ghostMat));
      ghost.visible = false;
      scene.add(ghost);
      return { lines: [], markers: [], ghost, ghostTime: NaN };
    };
    this.layers = { current: mkLayer(), planned: mkLayer() };

    this.nodeMarker = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0x7dffb2, wireframe: true }));
    this.nodeMarker.visible = false;

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

  /** Show or hide all trajectory layers and their markers. */
  showPrediction(v: boolean): void {
    this.predictionVisible = v;
    for (const layer of Object.values(this.layers)) {
      for (const l of layer.lines) l.visible = v;
      for (const m of layer.markers) m.mesh.visible = v;
      layer.ghost.visible = v && Number.isFinite(layer.ghostTime);
    }
    this.nodeMarker.visible = v && !!this.nodeText;
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

  /** Current (no-maneuver) trajectory. */
  setPrediction(pred: Prediction | null): void {
    this.setLayer('current', pred);
  }

  /** Trajectory after the planned maneuver (null to clear). Dims the current trajectory while shown. */
  setPlannedPrediction(pred: Prediction | null): void {
    this.setLayer('planned', pred);
    const dim = pred ? 0.35 : LAYER_STYLE.current.opacity;
    for (const l of this.layers.current.lines) (l.material as THREE.LineBasicMaterial).opacity = dim;
  }

  /** Mark a maneuver node at a body-relative position (null to clear). */
  setNode(r: Vec3 | null, body: BodyId = 'earth', text = ''): void {
    this.nodeMarker.parent?.remove(this.nodeMarker);
    this.labels.remove('node');
    this.nodeText = r ? text : '';
    if (!r) {
      this.nodeMarker.visible = false;
      return;
    }
    this.nodeMarker.position.set(r.x, r.z, -r.y);
    (body === 'earth' ? this.world.earthAnchor : this.world.moonAnchor).add(this.nodeMarker);
    this.nodeMarker.visible = this.predictionVisible;
    this.labels.set('node', text, 'label-node');
  }

  private clearLayer(layer: Layer): void {
    for (const l of layer.lines) {
      l.parent?.remove(l);
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    layer.lines = [];
    for (const m of layer.markers) {
      m.mesh.parent?.remove(m.mesh);
      (m.mesh.material as THREE.Material).dispose();
      this.labels.remove(m.id);
    }
    layer.markers = [];
    layer.ghostTime = NaN;
    layer.ghost.visible = false;
  }

  private setLayer(id: LayerId, pred: Prediction | null): void {
    const layer = this.layers[id];
    this.clearLayer(layer);
    if (!pred || !pred.segments.length) return;
    const startBody = pred.segments[0].body;
    const enter = pred.events.find((e) => e.kind === 'soi-enter');
    layer.ghostTime = startBody === 'earth' && enter ? enter.t : NaN;
    layer.ghost.visible = this.predictionVisible && Number.isFinite(layer.ghostTime);
    const style = LAYER_STYLE[id];
    const maxPts = this.app.quality.trailPoints;
    for (const seg of pred.segments) {
      if (seg.points.length < 2) continue;
      const stride = Math.max(1, Math.ceil(seg.points.length / maxPts));
      const pts = stride > 1 ? seg.points.filter((_, i) => i % stride === 0 || i === seg.points.length - 1) : seg.points;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(eciPointsToScene(pts, vec()), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: style.colors[seg.body], transparent: true, opacity: style.opacity }));
      line.frustumCulled = false;
      line.visible = this.predictionVisible;
      this.anchorFor(layer, seg.body).add(line);
      layer.lines.push(line);
    }
    pred.events.forEach((ev, i) => {
      const color = ev.kind === 'impact' ? 0xff5d5d : ev.kind === 'periapsis' ? 0x5ee08f : ev.kind === 'atmosphere' ? 0xff9a3d : 0xcfd8e3;
      const mesh = new THREE.Mesh(this.markerGeo, new THREE.MeshBasicMaterial({ color }));
      const p = ev.state.r;
      mesh.position.set(p.x, p.z, -p.y);
      mesh.visible = this.predictionVisible;
      this.anchorFor(layer, ev.body).add(mesh);
      const mid = `${id}-ev-${i}`;
      const text = (id === 'planned' ? '› ' : '') + EVENT_TEXT(ev);
      this.labels.set(mid, text, `label-event label-${ev.kind} label-${id}`);
      layer.markers.push({ mesh, id: mid, text });
    });
  }

  private anchorFor(layer: Layer, body: BodyId): THREE.Object3D {
    if (body === 'earth') return this.world.earthAnchor;
    return Number.isFinite(layer.ghostTime) ? layer.ghost : this.world.moonAnchor;
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
    for (const layer of Object.values(this.layers)) {
      if (Number.isFinite(layer.ghostTime)) eciToScene(moonPosition(layer.ghostTime, this.world.eph), origin, layer.ghost.position);
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
    for (const layer of Object.values(this.layers)) for (const m of layer.markers) pxScale(m.mesh, 4);
    if (this.nodeMarker.parent) pxScale(this.nodeMarker, 8);

    // Labels.
    this.labels.set('earth', 'Earth', 'label-body').copy(this.world.earth.group.position);
    this.labels.set('moon', 'Moon', 'label-body').copy(this.world.moon.group.position);
    this.labels.set('vessel', 'Spacecraft', 'label-vessel').copy(this.marker.position);
    for (const layer of Object.values(this.layers)) {
      for (const m of layer.markers) {
        this.labels.set(m.id, m.text).copy(m.mesh.getWorldPosition(tmpV));
        this.labels.show(m.id, this.predictionVisible);
      }
    }
    if (this.nodeText) {
      this.labels.set('node', this.nodeText, 'label-node').copy(this.nodeMarker.getWorldPosition(tmpV));
      this.labels.show('node', this.predictionVisible);
    }
    this.labels.show('vessel', this.marker.visible && (this.focus !== 'vessel' || this.cam.distance > 2e5));
    this.labels.update(camera, this.app.width, this.app.height);
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
    this.clearLayer(this.layers.current);
    this.clearLayer(this.layers.planned);
    this.fx.dispose();
    this.markerGeo.dispose();
    this.ghostGeo.dispose();
    this.ghostMat.dispose();
    this.world.dispose();
    this.labels.root.remove();
  }
}

const tmpV = new THREE.Vector3();
