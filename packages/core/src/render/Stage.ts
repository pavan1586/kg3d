import * as THREE from 'three';
// Type-only imports are erased at compile time, so the post-processing modules
// are *not* part of this package's static import graph. They are pulled in with
// a dynamic import the first time bloom is actually switched on — which keeps
// `@kg3d/core`'s runtime import surface to exactly one module, `three`.
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { CameraOptions, RenderOptions, Theme } from '../types.js';
import { clamp } from '../util/math.js';

/**
 * Owns the WebGL context, camera, render loop and post-processing chain.
 *
 * Bloom is the single effect that makes a graph read as luminous rather than
 * plasticky, but it is also the one that turns a professional visualisation
 * into a neon toy if overdriven — the defaults keep the threshold high so only
 * emissive cores bloom, never labels or edges.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private composerLoading = false;
  private resizeObserver: ResizeObserver | null = null;
  private frameHandle: number | null = null;
  private updaters: Array<(dt: number, elapsed: number) => void> = [];
  private clock = new THREE.Clock();
  private needsRender = true;
  private renderOptions: RenderOptions;
  private disposed = false;

  /** Frame timing exposed for the stats HUD. */
  fps = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;

  constructor(
    container: HTMLElement,
    theme: Theme,
    renderOptions: RenderOptions,
    cameraOptions: CameraOptions,
  ) {
    this.container = container;
    this.renderOptions = renderOptions;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, renderOptions.maxPixelRatio),
    );
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(new THREE.Color(theme.background), 1);

    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.outline = 'none';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(theme.background);
    this.scene.fog = new THREE.Fog(theme.backgroundDeep, theme.fogNear, theme.fogFar);

    this.camera = new THREE.PerspectiveCamera(
      cameraOptions.fov,
      this.aspect,
      cameraOptions.near,
      cameraOptions.far,
    );
    this.camera.position.set(0, 120, 620);

    // Lighting is deliberately soft: nodes are mostly emissive, the lights only
    // give the spheres enough shading to read as volumes rather than discs.
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1.4, 0.8);
    const rim = new THREE.DirectionalLight(new THREE.Color(theme.palette[0]), 0.45);
    rim.position.set(-1, -0.6, -1);
    this.scene.add(ambient, key, rim);

    if (renderOptions.bloom && theme.bloomStrength > 0) {
      // Fire and forget: until the composer resolves, `render()` falls back to
      // a direct render, so the first frames are simply un-bloomed rather than
      // missing.
      void this.setupComposer(theme);
    }

    this.observeResize();
  }

  private async setupComposer(theme: Theme): Promise<void> {
    if (this.composer || this.composerLoading) return;
    this.composerLoading = true;
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] =
        await Promise.all([
          import('three/examples/jsm/postprocessing/EffectComposer.js'),
          import('three/examples/jsm/postprocessing/RenderPass.js'),
          import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
          import('three/examples/jsm/postprocessing/OutputPass.js'),
        ]);
      // The stage can be disposed while the modules are in flight.
      if (this.disposed) return;

      const size = this.size;
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.width, size.height),
        theme.bloomStrength,
        theme.bloomRadius,
        theme.bloomThreshold,
      );
      composer.addPass(this.bloomPass);
      composer.addPass(new OutputPass());
      composer.setPixelRatio(this.renderer.getPixelRatio());
      composer.setSize(size.width, size.height);
      this.composer = composer;
      this.invalidate();
    } catch (error) {
      // A bundler that cannot resolve three's example modules, or an offline
      // import map, must degrade to a plain render rather than a blank canvas.
      console.warn('[kg3d] bloom unavailable; rendering without post-processing', error);
    } finally {
      this.composerLoading = false;
    }
  }

  get size(): { width: number; height: number } {
    return {
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
    };
  }

  get aspect(): number {
    const { width, height } = this.size;
    return width / height;
  }

  applyTheme(theme: Theme): void {
    this.scene.background = new THREE.Color(theme.background);
    this.scene.fog = new THREE.Fog(theme.backgroundDeep, theme.fogNear, theme.fogFar);
    this.renderer.setClearColor(new THREE.Color(theme.background), 1);
    if (this.bloomPass) {
      this.bloomPass.strength = theme.bloomStrength;
      this.bloomPass.radius = theme.bloomRadius;
      this.bloomPass.threshold = theme.bloomThreshold;
    } else if (this.renderOptions.bloom && theme.bloomStrength > 0) {
      void this.setupComposer(theme);
    }
    this.invalidate();
  }

  /** Register a per-frame callback. Returns an unsubscribe function. */
  onFrame(fn: (dt: number, elapsed: number) => void): () => void {
    this.updaters.push(fn);
    return () => {
      this.updaters = this.updaters.filter((u) => u !== fn);
    };
  }

  /** Mark the scene dirty when running in render-on-demand mode. */
  invalidate(): void {
    this.needsRender = true;
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.frameHandle = requestAnimationFrame(loop);
      const dt = Math.min(0.1, this.clock.getDelta());
      const elapsed = this.clock.getElapsedTime();

      for (const update of this.updaters) update(dt, elapsed);

      if (!this.renderOptions.renderOnDemand || this.needsRender) {
        this.render();
        this.needsRender = false;
      }

      this.fpsAccumulator += dt;
      this.fpsFrames++;
      if (this.fpsAccumulator >= 0.5) {
        this.fps = this.fpsFrames / this.fpsAccumulator;
        this.fpsAccumulator = 0;
        this.fpsFrames = 0;
      }
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private observeResize(): void {
    const apply = () => {
      const { width, height } = this.size;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, this.renderOptions.maxPixelRatio),
      );
      this.renderer.setSize(width, height, false);
      this.composer?.setSize(width, height);
      this.composer?.setPixelRatio(this.renderer.getPixelRatio());
      this.invalidate();
    };
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(apply);
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', apply);
    }
    apply();
  }

  /** World-space units per screen pixel at a given distance — label sizing. */
  pixelsPerUnit(distance: number): number {
    const { height } = this.size;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const worldHeight = 2 * Math.tan(vFov / 2) * Math.max(1e-3, distance);
    return height / worldHeight;
  }

  projectToScreen(point: THREE.Vector3, target: THREE.Vector2): THREE.Vector2 {
    const projected = point.clone().project(this.camera);
    const { width, height } = this.size;
    target.set(((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height);
    return target;
  }

  setPixelRatioCap(cap: number): void {
    this.renderOptions.maxPixelRatio = clamp(cap, 0.5, 3);
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.renderOptions.maxPixelRatio),
    );
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.updaters = [];
    this.composer?.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
