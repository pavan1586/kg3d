import * as THREE from 'three';
import type { NodeLayer } from './NodeLayer.js';
import type { Stage } from './Stage.js';

/**
 * GPU picking.
 *
 * Rather than ray-casting against 50k spheres on the CPU, we render a single
 * pixel under the cursor with an id-encoding material and read the colour back.
 * Cost is constant in graph size and exact even for overlapping instances —
 * whatever the GPU drew on top is what the user clicked.
 */
export class Picker {
  private target: THREE.WebGLRenderTarget;
  private pixel = new Uint8Array(4);
  private pickCamera: THREE.PerspectiveCamera;

  constructor(
    private stage: Stage,
    private nodeLayer: NodeLayer,
  ) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    this.pickCamera = stage.camera.clone() as THREE.PerspectiveCamera;
  }

  /**
   * @param x  pointer x in CSS pixels, relative to the canvas
   * @param y  pointer y in CSS pixels, relative to the canvas
   * @returns node index, or -1 for background
   */
  pick(x: number, y: number): number {
    const { renderer, scene, camera } = this.stage;
    const { width, height } = this.stage.size;
    const dpr = renderer.getPixelRatio();

    // A 1x1 view offset turns the full-frame projection into just the pixel we
    // care about — no full-resolution picking pass, no readback stall.
    this.pickCamera.copy(camera);
    this.pickCamera.setViewOffset(
      Math.floor(width * dpr),
      Math.floor(height * dpr),
      Math.floor(x * dpr),
      Math.floor(y * dpr),
      1,
      1,
    );

    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const previousFog = scene.fog;

    this.nodeLayer.beginPicking();
    scene.background = null;
    scene.fog = null;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.pickCamera);
    renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixel);

    renderer.setRenderTarget(previousTarget);
    scene.background = previousBackground;
    scene.fog = previousFog;
    this.nodeLayer.endPicking();
    this.pickCamera.clearViewOffset();

    const id = (this.pixel[0] << 16) | (this.pixel[1] << 8) | this.pixel[2];
    return id === 0 ? -1 : id - 1;
  }

  dispose(): void {
    this.target.dispose();
  }
}
