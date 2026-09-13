import * as THREE from 'three';
import type { CameraOptions } from '../types.js';
import { clamp, easeInOutCubic } from '../util/math.js';

/**
 * Orbit / pan / dolly controls with inertia, written against pointer events so
 * mouse, pen and touch all take the same path.
 *
 * This is deliberately not three's example OrbitControls: the engine needs to
 * interrupt user input with programmatic camera flights, know when the user has
 * been idle, and expose the spherical state to the HUD. Owning ~200 lines is
 * cheaper than fighting a class that assumes it is the only thing driving the
 * camera.
 */
export class OrbitControls {
  target = new THREE.Vector3();
  enabled = true;

  /** Timestamp of the last user interaction — drives the idle orbit. */
  lastInteraction = performance.now();

  /**
   * True once the user has actually touched the camera. The engine uses this to
   * stop auto-framing a settling layout the moment the user takes over — a
   * camera that keeps snapping back while you are trying to look at something
   * is the fastest way to make a viewer distrust a visualisation.
   */
  hasUserInteracted = false;

  private camera: THREE.PerspectiveCamera;
  private element: HTMLElement;
  private options: CameraOptions;

  private spherical = new THREE.Spherical();
  private sphericalDelta = new THREE.Spherical(0, 0, 0);
  private panOffset = new THREE.Vector3();
  private scale = 1;

  private pointers = new Map<number, { x: number; y: number }>();
  private lastPointer = new THREE.Vector2();
  private mode: 'none' | 'rotate' | 'pan' = 'none';
  private pinchDistance = 0;

  private flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    start: number;
    duration: number;
    resolve: () => void;
  } | null = null;

  private onChange: (() => void) | null = null;
  private disposers: Array<() => void> = [];

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, options: CameraOptions) {
    this.camera = camera;
    this.element = element;
    this.options = options;

    const offset = camera.position.clone().sub(this.target);
    this.spherical.setFromVector3(offset);

    this.bind();
  }

  setChangeHandler(fn: () => void): void {
    this.onChange = fn;
  }

  private bind(): void {
    const el = this.element;
    const onPointerDown = (e: PointerEvent) => {
      if (!this.enabled) return;
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.lastInteraction = performance.now();
      this.hasUserInteracted = true;
      this.flight = null;
      if (this.pointers.size === 1) {
        this.mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
        this.lastPointer.set(e.clientX, e.clientY);
      } else if (this.pointers.size === 2) {
        this.mode = 'pan';
        this.pinchDistance = this.currentPinchDistance();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!this.enabled || !this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.lastInteraction = performance.now();

      if (this.pointers.size === 2) {
        const distance = this.currentPinchDistance();
        if (this.pinchDistance > 0) {
          this.scale *= this.pinchDistance / Math.max(1, distance);
        }
        this.pinchDistance = distance;
        return;
      }

      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.set(e.clientX, e.clientY);
      const { width, height } = el.getBoundingClientRect();

      if (this.mode === 'rotate') {
        this.sphericalDelta.theta -= (2 * Math.PI * dx * this.options.rotateSpeed) / width;
        this.sphericalDelta.phi -= (2 * Math.PI * dy * this.options.rotateSpeed) / height;
      } else if (this.mode === 'pan') {
        this.pan(dx, dy, height);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      if (this.pointers.size === 0) this.mode = 'none';
      this.lastInteraction = performance.now();
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.lastInteraction = performance.now();
      this.hasUserInteracted = true;
      this.flight = null;
      // Normalise across line/pixel/page delta modes so a trackpad and a mouse
      // wheel feel like the same control.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const delta = clamp((e.deltaY * unit) / 500, -0.5, 0.5);
      this.scale *= Math.exp(delta * this.options.zoomSpeed);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);

    this.disposers.push(() => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
    });
  }

  private currentPinchDistance(): number {
    const points = Array.from(this.pointers.values());
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  private pan(dx: number, dy: number, height: number): void {
    const offset = this.camera.position.clone().sub(this.target);
    const distance = offset.length() * Math.tan(((this.camera.fov / 2) * Math.PI) / 180) * 2;
    const matrix = this.camera.matrix.elements;
    const right = new THREE.Vector3(matrix[0], matrix[1], matrix[2]);
    const up = new THREE.Vector3(matrix[4], matrix[5], matrix[6]);
    const speed = (distance / height) * this.options.panSpeed;
    this.panOffset.add(right.multiplyScalar(-dx * speed));
    this.panOffset.add(up.multiplyScalar(dy * speed));
  }

  /** Programmatic flight. Resolves when the camera arrives. */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, duration?: number): Promise<void> {
    return new Promise((resolve) => {
      this.flight = {
        from: this.camera.position.clone(),
        to: position.clone(),
        fromTarget: this.target.clone(),
        toTarget: target.clone(),
        start: performance.now(),
        duration: duration ?? this.options.flightDurationMs,
        resolve,
      };
    });
  }

  /** Frame a bounding sphere with a comfortable margin. */
  frame(center: THREE.Vector3, radius: number, duration?: number): Promise<void> {
    const fov = (this.camera.fov * Math.PI) / 180;
    // 1.35 leaves a comfortable margin without stranding the graph in space.
    const distance = clamp(
      (radius * 1.35) / Math.tan(fov / 2),
      this.options.minDistance,
      this.options.maxDistance,
    );
    const direction = this.camera.position.clone().sub(this.target).normalize();
    if (direction.lengthSq() < 1e-6) direction.set(0, 0.35, 1).normalize();
    const position = center.clone().add(direction.multiplyScalar(distance));
    return this.flyTo(position, center, duration);
  }

  /** Slow automatic orbit used when the user has been idle. */
  idleOrbit(speed: number, dt: number): void {
    this.sphericalDelta.theta -= speed * dt;
  }

  get distance(): number {
    return this.camera.position.distanceTo(this.target);
  }

  update(dt: number): boolean {
    if (this.flight) {
      const elapsed = performance.now() - this.flight.start;
      const t = clamp(elapsed / this.flight.duration, 0, 1);
      const eased = easeInOutCubic(t);
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, eased);
      this.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased);
      this.camera.lookAt(this.target);
      if (t >= 1) {
        const done = this.flight.resolve;
        this.flight = null;
        // Re-derive spherical state so the next drag continues smoothly.
        this.spherical.setFromVector3(this.camera.position.clone().sub(this.target));
        done();
      }
      this.onChange?.();
      return true;
    }

    const damping = clamp(this.options.damping, 0.01, 1);
    const offset = this.camera.position.clone().sub(this.target);
    this.spherical.setFromVector3(offset);

    this.spherical.theta += this.sphericalDelta.theta;
    this.spherical.phi += this.sphericalDelta.phi;
    // Clamp phi just inside the poles; hitting them flips the up vector.
    this.spherical.phi = clamp(this.spherical.phi, 0.05, Math.PI - 0.05);
    this.spherical.radius = clamp(
      this.spherical.radius * this.scale,
      this.options.minDistance,
      this.options.maxDistance,
    );

    this.target.add(this.panOffset);
    offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    const moved =
      Math.abs(this.sphericalDelta.theta) > 1e-5 ||
      Math.abs(this.sphericalDelta.phi) > 1e-5 ||
      Math.abs(this.scale - 1) > 1e-5 ||
      this.panOffset.lengthSq() > 1e-6;

    // Inertia: decay the accumulated deltas instead of zeroing them.
    const decay = 1 - damping;
    this.sphericalDelta.theta *= decay;
    this.sphericalDelta.phi *= decay;
    this.panOffset.multiplyScalar(decay);
    this.scale = 1 + (this.scale - 1) * decay;

    if (moved) this.onChange?.();
    return moved;
  }

  get idleMs(): number {
    return performance.now() - this.lastInteraction;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
