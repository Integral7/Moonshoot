import * as THREE from 'three';

/**
 * Orbit camera around a focus point. The focus is the floating origin, so the
 * camera sits at `offset` from (0,0,0) in scene space. Drag to rotate, wheel to
 * zoom (exponential), with smoothing.
 */
export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0.6;
  pitch = 0.35;
  distance: number;
  minDistance: number;
  maxDistance: number;
  private targetYaw = this.yaw;
  private targetPitch = this.pitch;
  private targetDistance: number;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private el: HTMLElement | null = null;
  /** Rotate with the world "up" (scene +Y) by default; can be set to a local up vector. */
  up = new THREE.Vector3(0, 1, 0);

  constructor(fov = 50, distance = 2e7, minDistance = 10, maxDistance = 2e9) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.5, 1e12);
    this.distance = this.targetDistance = distance;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
  }

  attach(el: HTMLElement): void {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContext);
  }

  detach(): void {
    if (!this.el) return;
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContext);
    this.el = null;
  }

  setDistance(d: number, immediate = false): void {
    this.targetDistance = THREE.MathUtils.clamp(d, this.minDistance, this.maxDistance);
    if (immediate) this.distance = this.targetDistance;
  }

  setAngles(yaw: number, pitch: number, immediate = false): void {
    this.targetYaw = yaw;
    this.targetPitch = THREE.MathUtils.clamp(pitch, -1.5, 1.5);
    if (immediate) {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
    }
  }

  get desiredDistance(): number {
    return this.targetDistance;
  }

  zoom(factor: number): void {
    this.setDistance(this.targetDistance * factor);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.targetDistance) - Math.log(this.distance)) * k);
    // Build an orthonormal basis around `up`.
    const up = this.up.clone().normalize();
    const ref = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const east = new THREE.Vector3().crossVectors(ref, up).normalize();
    const north = new THREE.Vector3().crossVectors(up, east).normalize();
    const cp = Math.cos(this.pitch);
    const off = new THREE.Vector3()
      .addScaledVector(east, cp * Math.sin(this.yaw))
      .addScaledVector(north, cp * Math.cos(this.yaw))
      .addScaledVector(up, Math.sin(this.pitch))
      .multiplyScalar(this.distance);
    this.camera.position.copy(off);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    // Keep the near plane proportional to distance for depth precision.
    this.camera.near = Math.max(0.05, this.distance * 1e-3);
    this.camera.updateProjectionMatrix();
  }

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.panel, button, input, .hud-block')) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.targetYaw -= dx * 0.005;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * 0.005, -1.5, 1.5);
  };

  private onUp = () => {
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest('.panel')) return;
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0012));
  };

  private onContext = (e: Event) => e.preventDefault();
}
