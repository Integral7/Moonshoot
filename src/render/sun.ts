import * as THREE from 'three';

/** Radial glare texture drawn on a canvas (procedural). */
function glareTexture(size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.06, 'rgba(255,250,235,1)');
  grad.addColorStop(0.15, 'rgba(255,225,170,0.45)');
  grad.addColorStop(0.4, 'rgba(255,180,90,0.08)');
  grad.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // Faint diffraction spikes.
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,240,210,0.18)';
  g.lineWidth = 2;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 4;
    g.beginPath();
    g.moveTo(r - Math.cos(a) * r, r - Math.sin(a) * r);
    g.lineTo(r + Math.cos(a) * r, r + Math.sin(a) * r);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface SunVisual {
  light: THREE.DirectionalLight;
  sprite: THREE.Sprite;
  ambient: THREE.AmbientLight;
  /** Direction toward the Sun in scene axes (unit). */
  direction: THREE.Vector3;
  /** Place the sun sprite far along `direction` from the camera, and aim the light. */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

export function createSun(scene: THREE.Scene, direction: THREE.Vector3): SunVisual {
  const dir = direction.clone().normalize();
  const light = new THREE.DirectionalLight(0xfff4e6, 3.2);
  light.position.copy(dir);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);
  const ambient = new THREE.AmbientLight(0x223044, 0.08);
  scene.add(ambient);
  const mat = new THREE.SpriteMaterial({
    map: glareTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    sizeAttenuation: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.12, 0.12, 1);
  sprite.renderOrder = -5;
  sprite.frustumCulled = false;
  scene.add(sprite);
  return {
    light,
    sprite,
    ambient,
    direction: dir,
    update(camera) {
      light.position.copy(dir);
      sprite.position.copy(camera.position).addScaledVector(dir, 1e9);
    },
    dispose() {
      mat.map?.dispose();
      mat.dispose();
      scene.remove(light, light.target, ambient, sprite);
    },
  };
}
