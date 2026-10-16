import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { QualityPreset } from './quality';

/**
 * Optional bloom post-processing. Falls back to a direct render when the
 * quality preset disables bloom. Rebuilds itself if the renderer changes.
 */
export class PostFX {
  private composer: EffectComposer | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private width = 1;
  private height = 1;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private quality: () => QualityPreset,
    public bloomStrength = 0.4,
  ) {}

  setSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.composer?.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer): void {
    const q = this.quality();
    if (!q.bloom) {
      this.disposeComposer();
      renderer.render(this.scene, this.camera);
      return;
    }
    if (!this.composer || this.renderer !== renderer) this.build(renderer);
    if (this.bloom) this.bloom.strength = this.bloomStrength;
    this.composer!.render();
  }

  private build(renderer: THREE.WebGLRenderer): void {
    this.disposeComposer();
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    this.width = size.x;
    this.height = size.y;
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(this.width, this.height);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), this.bloomStrength, 0.5, 0.88);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private disposeComposer(): void {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.bloom = null;
    }
  }

  dispose(): void {
    this.disposeComposer();
  }
}
