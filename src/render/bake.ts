import * as THREE from 'three';

/**
 * Bake a procedural function of direction into a cube map on the GPU. The
 * fragment shader receives `vec3 vDir` (unit direction, scene axes: +Y north)
 * and must write gl_FragColor. Rendering from the center of a box gives each
 * texel the exact direction of its view ray, so the result is seamless.
 */
export function bakeCube(
  renderer: THREE.WebGLRenderer,
  size: number,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform> = {},
): THREE.WebGLCubeRenderTarget {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  // Shared via cache: screen teardown must not dispose it.
  rt.texture.userData.shared = true;

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${fragmentShader}
    `,
  });
  material.toneMapped = false;
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const cam = new THREE.CubeCamera(0.1, 10, rt);
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  cam.update(renderer, scene);
  renderer.autoClear = prevAutoClear;
  geometry.dispose();
  material.dispose();
  return rt;
}

/**
 * Cache of baked textures per renderer (a new WebGL context invalidates them).
 */
const caches = new WeakMap<THREE.WebGLRenderer, Map<string, THREE.WebGLCubeRenderTarget>>();

export function cachedBake(
  renderer: THREE.WebGLRenderer,
  key: string,
  make: () => THREE.WebGLCubeRenderTarget,
): THREE.WebGLCubeRenderTarget {
  let m = caches.get(renderer);
  if (!m) {
    m = new Map();
    caches.set(renderer, m);
  }
  let rt = m.get(key);
  if (!rt) {
    rt = make();
    m.set(key, rt);
  }
  return rt;
}
