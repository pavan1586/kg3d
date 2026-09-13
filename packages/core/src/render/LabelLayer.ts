import * as THREE from 'three';
import type { GraphNode, LabelOptions, Theme } from '../types.js';
import type { Stage } from './Stage.js';

interface PlacedLabel {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Labels are drawn on a 2D canvas layered over the WebGL canvas rather than as
 * sprites in the scene. Three reasons: text stays pixel-crisp at any zoom, it
 * never blooms, and decluttering is a cheap screen-space problem instead of an
 * expensive world-space one.
 *
 * The declutter pass is what makes a 50k-node graph readable — without it the
 * frame is a solid block of overlapping words. Priority order is: focused nodes,
 * then the largest on screen, which is the same order a reader's eye uses.
 */
export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: LabelOptions;
  private theme: Theme;
  private placed: PlacedLabel[] = [];
  private projected = new THREE.Vector3();
  private dpr = 1;

  constructor(container: HTMLElement, theme: Theme, options: LabelOptions) {
    this.theme = theme;
    this.options = options;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '2',
    } as CSSStyleDeclaration);
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[kg3d] 2D context unavailable for labels');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  applyTheme(theme: Theme): void {
    this.theme = theme;
  }

  setOptions(options: LabelOptions): void {
    this.options = options;
  }

  clear(): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width / this.dpr, height / this.dpr);
  }

  /**
   * @param focused indices that must always be labelled (selection, hover, pins)
   * @param dimmed  indices that should render muted, or null when nothing is dimmed
   */
  render(
    stage: Stage,
    nodes: GraphNode[],
    positions: Float32Array,
    radii: Float32Array,
    focused: Set<number>,
    dimmed: Set<number> | null,
  ): void {
    this.clear();
    if (!this.options.enabled) return;

    const { width, height } = stage.size;
    const dpr = stage.renderer.getPixelRatio();
    if (this.canvas.width !== Math.floor(width * dpr)) this.resize(width, height, dpr);

    const ctx = this.ctx;
    const camera = stage.camera;
    const cameraPosition = camera.position;
    this.placed.length = 0;

    type Candidate = { index: number; x: number; y: number; screenSize: number; priority: number };
    const candidates: Candidate[] = [];

    // Frustum cull once per frame, then rank by on-screen size.
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const point = new THREE.Vector3();

    for (let i = 0; i < nodes.length; i++) {
      point.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      if (!frustum.containsPoint(point)) continue;
      const distance = point.distanceTo(cameraPosition);
      const screenSize = radii[i] * stage.pixelsPerUnit(distance);
      const isFocused = focused.has(i);
      if (!isFocused && screenSize < this.options.minScreenSize) continue;

      this.projected.copy(point).project(camera);
      if (this.projected.z > 1) continue;
      const sx = ((this.projected.x + 1) / 2) * width;
      const sy = ((1 - this.projected.y) / 2) * height;
      if (sx < -80 || sx > width + 80 || sy < -30 || sy > height + 30) continue;

      candidates.push({
        index: i,
        x: sx,
        y: sy,
        screenSize,
        priority: isFocused ? 1e9 : screenSize,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    const limit = Math.min(candidates.length, this.options.maxVisible + focused.size);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    let drawn = 0;
    for (let c = 0; c < candidates.length && drawn < limit; c++) {
      const cand = candidates[c];
      const node = nodes[cand.index];
      const text = node.label ?? node.id;
      const isFocused = focused.has(cand.index);
      const isDimmed = dimmed !== null && !dimmed.has(cand.index) && !isFocused;
      if (isDimmed && !isFocused) continue;

      const fontSize = isFocused ? this.options.fontSize + 1 : this.options.fontSize;
      ctx.font = `${isFocused ? 600 : 500} ${fontSize}px ${this.options.fontFamily}`;
      const metrics = ctx.measureText(text);
      const padX = 6;
      const boxWidth = metrics.width + padX * 2;
      const boxHeight = fontSize + 8;
      const offset = Math.min(26, Math.max(9, cand.screenSize + 6));
      const bx = cand.x + offset;
      const by = cand.y - boxHeight / 2;

      if (this.options.declutter && !isFocused && this.collides(bx, by, boxWidth, boxHeight)) {
        continue;
      }
      this.placed.push({ x: bx, y: by, width: boxWidth, height: boxHeight });

      // A soft plate behind the text is the difference between "readable over a
      // bright cluster" and "unreadable over a bright cluster".
      if (isFocused) {
        ctx.fillStyle = this.theme.labelHaloColor;
        roundRect(ctx, bx - padX * 0.5, by, boxWidth, boxHeight, 5);
        ctx.fill();
      }

      ctx.globalAlpha = isFocused ? 1 : 0.86;
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.theme.labelHaloColor;
      ctx.strokeText(text, bx + padX * 0.5, cand.y);
      ctx.fillStyle = isFocused ? this.theme.selectionColor : this.theme.labelColor;
      ctx.fillText(text, bx + padX * 0.5, cand.y);
      ctx.globalAlpha = 1;
      drawn++;
    }
  }

  private collides(x: number, y: number, w: number, h: number): boolean {
    for (let i = 0; i < this.placed.length; i++) {
      const p = this.placed[i];
      if (x < p.x + p.width && x + w > p.x && y < p.y + p.height && y + h > p.y) return true;
    }
    return false;
  }

  dispose(): void {
    this.canvas.remove();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
