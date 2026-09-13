import type { GraphModel } from '../graph/GraphModel.js';
import type { ForceLayoutOptions, LayoutName } from '../types.js';
import { ForceSimulation, type ForceGraph } from './forceLayout.js';
import { applyPreset, autoRadius } from './presets.js';

/**
 * Whether a worker URL can be resolved at all.
 *
 * The IIFE browser bundle has no module context, so `import.meta.url` is
 * undefined there and the worker can never be located. Detecting that up front
 * is cleaner than letting `new URL()` throw and recovering from the exception —
 * and it keeps the console free of a scary-looking error on a path we expect.
 */
function workerUrlAvailable(): boolean {
  try {
    return typeof import.meta.url === 'string' && import.meta.url.length > 0;
  } catch {
    return false;
  }
}

export interface LayoutCallbacks {
  onTick(positions: Float32Array, iteration: number, alpha: number): void;
  onEnd(iterations: number, durationMs: number): void;
}

/**
 * Owns the node position buffer and decides who writes to it: a worker-backed
 * force simulation, a main-thread fallback, or an instant preset. The rest of
 * the engine only ever reads `positions`.
 */
export class LayoutController {
  positions: Float32Array;

  private model: GraphModel;
  private options: ForceLayoutOptions;
  private callbacks: LayoutCallbacks;
  private worker: Worker | null = null;
  private simulation: ForceSimulation | null = null;
  private rafHandle: number | null = null;
  private startedAt = 0;
  private communities?: Int32Array;
  private fixedMask: Uint8Array;
  private masses: Float32Array;
  private currentLayout: LayoutName = 'force';
  private disposed = false;

  constructor(model: GraphModel, options: ForceLayoutOptions, callbacks: LayoutCallbacks) {
    this.model = model;
    this.options = options;
    this.callbacks = callbacks;
    this.positions = new Float32Array(model.nodeCount * 3);
    this.fixedMask = new Uint8Array(model.nodeCount);
    this.masses = new Float32Array(model.nodeCount).fill(1);
    this.hydrateFromData();
  }

  /** Adopt any x/y/z or fx/fy/fz the caller supplied. */
  private hydrateFromData(): void {
    const nodes = this.model.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (typeof n.x === 'number') this.positions[i * 3] = n.x;
      if (typeof n.y === 'number') this.positions[i * 3 + 1] = n.y;
      if (typeof n.z === 'number') this.positions[i * 3 + 2] = n.z;
      const pinned =
        typeof n.fx === 'number' || typeof n.fy === 'number' || typeof n.fz === 'number';
      if (pinned) {
        this.fixedMask[i] = 1;
        if (typeof n.fx === 'number') this.positions[i * 3] = n.fx;
        if (typeof n.fy === 'number') this.positions[i * 3 + 1] = n.fy;
        if (typeof n.fz === 'number') this.positions[i * 3 + 2] = n.fz;
      }
      this.masses[i] = Math.max(0.4, Math.sqrt(n.weight ?? 1));
    }
  }

  setCommunities(communities: Int32Array | undefined): void {
    this.communities = communities;
  }

  /** Resize buffers after the graph gained or lost nodes. */
  resize(): void {
    const previous = this.positions;
    const previousMask = this.fixedMask;
    this.positions = new Float32Array(this.model.nodeCount * 3);
    this.positions.set(previous.subarray(0, Math.min(previous.length, this.positions.length)));
    this.fixedMask = new Uint8Array(this.model.nodeCount);
    this.fixedMask.set(
      previousMask.subarray(0, Math.min(previousMask.length, this.fixedMask.length)),
    );
    const previousMasses = this.masses;
    this.masses = new Float32Array(this.model.nodeCount).fill(1);
    this.masses.set(
      previousMasses.subarray(0, Math.min(previousMasses.length, this.masses.length)),
    );
    this.hydrateFromData();
  }

  get layout(): LayoutName {
    return this.currentLayout;
  }

  /** Switch layout. Presets apply instantly; `force` starts the simulation. */
  run(layout: LayoutName, focusIndex?: number): void {
    this.stop();
    this.currentLayout = layout;
    this.startedAt = performance.now();

    if (layout !== 'force') {
      applyPreset(layout, this.positions, {
        model: this.model,
        communities: this.communities,
        focus: focusIndex,
        radius: autoRadius(this.model.nodeCount),
      });
      this.callbacks.onTick(this.positions, 0, 0);
      this.callbacks.onEnd(0, performance.now() - this.startedAt);
      return;
    }

    const graph = this.buildForceGraph();
    ForceSimulation.seed(graph.positions, graph.nodeCount, autoRadius(graph.nodeCount) * 0.6);

    if (this.options.useWorker && typeof Worker !== 'undefined' && workerUrlAvailable()) {
      try {
        this.startWorker(graph);
        return;
      } catch (err) {
        // A blocked worker (strict CSP, file:// origin) must degrade, not fail.
        console.warn('[kg3d] layout worker unavailable, falling back to main thread', err);
      }
    }
    this.startMainThread(graph);
  }

  private buildForceGraph(): ForceGraph {
    const edges = this.model.edges;
    const edgeSources = new Int32Array(edges.length);
    const edgeTargets = new Int32Array(edges.length);
    const edgeWeights = new Float32Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
      edgeSources[i] = edges[i].sourceIndex;
      edgeTargets[i] = edges[i].targetIndex;
      edgeWeights[i] = edges[i].weight ?? 1;
    }
    return {
      nodeCount: this.model.nodeCount,
      positions: this.positions,
      edgeSources,
      edgeTargets,
      edgeWeights,
      communities: this.communities,
      fixedMask: this.fixedMask,
      masses: this.masses,
    };
  }

  private startWorker(graph: ForceGraph): void {
    // `new URL(..., import.meta.url)` is what lets bundlers (Vite, webpack 5,
    // Rollup) emit the worker chunk automatically without extra config.
    this.worker = new Worker(new URL('./layoutWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: 'tick'; positions: ArrayBuffer; iteration: number; alpha: number }
        | { type: 'end'; iterations: number };
      if (this.disposed) return;
      if (data.type === 'tick') {
        this.positions = new Float32Array(data.positions);
        this.callbacks.onTick(this.positions, data.iteration, data.alpha);
      } else {
        this.callbacks.onEnd(data.iterations, performance.now() - this.startedAt);
      }
    };
    this.worker.onerror = (err) => {
      console.warn('[kg3d] layout worker error, falling back to main thread', err);
      this.worker?.terminate();
      this.worker = null;
      this.startMainThread(this.buildForceGraph());
    };

    const positionsCopy = graph.positions.slice();
    this.worker.postMessage(
      {
        type: 'init',
        nodeCount: graph.nodeCount,
        positions: positionsCopy.buffer,
        edgeSources: graph.edgeSources.buffer,
        edgeTargets: graph.edgeTargets.buffer,
        edgeWeights: graph.edgeWeights.buffer,
        communities: graph.communities?.slice().buffer,
        fixedMask: graph.fixedMask?.slice().buffer,
        masses: graph.masses?.slice().buffer,
        options: this.options,
      },
      [
        positionsCopy.buffer,
        graph.edgeSources.buffer,
        graph.edgeTargets.buffer,
        graph.edgeWeights.buffer,
      ],
    );
    this.worker.postMessage({ type: 'start' });
  }

  private startMainThread(graph: ForceGraph): void {
    this.simulation = new ForceSimulation(graph, this.options);
    const step = () => {
      if (!this.simulation || this.disposed) return;
      // Time-boxed: never hold the main thread longer than ~8ms per frame.
      const deadline = performance.now() + 8;
      let iterations = 0;
      do {
        this.simulation.tick();
        iterations++;
      } while (performance.now() < deadline && !this.simulation.settled && iterations < 12);

      this.positions = this.simulation.graph.positions;
      this.callbacks.onTick(this.positions, this.simulation.iteration, this.simulation.alpha);

      if (this.simulation.settled) {
        this.callbacks.onEnd(this.simulation.iteration, performance.now() - this.startedAt);
        this.rafHandle = null;
        return;
      }
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  reheat(alpha = 0.6): void {
    if (this.currentLayout !== 'force') return;
    if (this.worker) {
      this.worker.postMessage({ type: 'reheat', alpha });
    } else if (this.simulation) {
      this.simulation.reheat(alpha);
      if (this.rafHandle === null) this.startMainThread(this.simulation.graph);
    } else {
      this.run('force');
    }
  }

  pin(index: number, x: number, y: number, z: number, pinned: boolean): void {
    this.fixedMask[index] = pinned ? 1 : 0;
    this.positions[index * 3] = x;
    this.positions[index * 3 + 1] = y;
    this.positions[index * 3 + 2] = z;
    if (this.worker) {
      this.worker.postMessage({ type: 'pin', index, x, y, z, pinned });
    } else if (this.simulation) {
      const g = this.simulation.graph;
      if (g.fixedMask) g.fixedMask[index] = pinned ? 1 : 0;
      g.positions[index * 3] = x;
      g.positions[index * 3 + 1] = y;
      g.positions[index * 3 + 2] = z;
      this.simulation.reheat(0.3);
    }
  }

  updateOptions(patch: Partial<ForceLayoutOptions>): void {
    Object.assign(this.options, patch);
    if (this.worker) this.worker.postMessage({ type: 'options', options: patch });
    else this.reheat(0.5);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    this.simulation = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
