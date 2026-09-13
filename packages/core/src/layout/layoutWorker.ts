/// <reference lib="webworker" />
import type { ForceLayoutOptions } from '../types.js';
import { ForceSimulation, type ForceGraph } from './forceLayout.js';

/**
 * Layout worker.
 *
 * Positions travel back to the main thread as a transferable Float32Array copy
 * on a fixed cadence rather than every tick, so a heavy simulation never floods
 * the message queue and stalls rendering.
 */

type InitMessage = {
  type: 'init';
  nodeCount: number;
  positions: ArrayBuffer;
  edgeSources: ArrayBuffer;
  edgeTargets: ArrayBuffer;
  edgeWeights: ArrayBuffer;
  communities?: ArrayBuffer;
  fixedMask?: ArrayBuffer;
  masses?: ArrayBuffer;
  options: ForceLayoutOptions;
};

type WorkerMessage =
  | InitMessage
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'reheat'; alpha?: number }
  | { type: 'pin'; index: number; x: number; y: number; z: number; pinned: boolean }
  | { type: 'options'; options: Partial<ForceLayoutOptions> };

let simulation: ForceSimulation | null = null;
let running = false;
let lastEmit = 0;
const EMIT_INTERVAL_MS = 33; // ~30 position updates a second is plenty.

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      const graph: ForceGraph = {
        nodeCount: msg.nodeCount,
        positions: new Float32Array(msg.positions),
        edgeSources: new Int32Array(msg.edgeSources),
        edgeTargets: new Int32Array(msg.edgeTargets),
        edgeWeights: new Float32Array(msg.edgeWeights),
        communities: msg.communities ? new Int32Array(msg.communities) : undefined,
        fixedMask: msg.fixedMask ? new Uint8Array(msg.fixedMask) : undefined,
        masses: msg.masses ? new Float32Array(msg.masses) : undefined,
      };
      simulation = new ForceSimulation(graph, msg.options);
      ForceSimulation.seed(graph.positions, graph.nodeCount, Math.cbrt(graph.nodeCount) * 46);
      break;
    }
    case 'start':
      running = true;
      loop();
      break;
    case 'stop':
      running = false;
      break;
    case 'reheat':
      simulation?.reheat(msg.alpha ?? 0.6);
      if (!running) {
        running = true;
        loop();
      }
      break;
    case 'pin': {
      if (!simulation) break;
      const g = simulation.graph;
      if (!g.fixedMask) g.fixedMask = new Uint8Array(g.nodeCount);
      g.fixedMask[msg.index] = msg.pinned ? 1 : 0;
      g.positions[msg.index * 3] = msg.x;
      g.positions[msg.index * 3 + 1] = msg.y;
      g.positions[msg.index * 3 + 2] = msg.z;
      simulation.reheat(0.35);
      break;
    }
    case 'options':
      if (simulation) Object.assign(simulation.options, msg.options);
      simulation?.reheat(0.5);
      break;
  }
};

function loop(): void {
  if (!simulation || !running) return;

  // Batch several ticks per frame while the layout is hot; the first seconds
  // are where the structure forms and the user is waiting for it.
  const ticksThisFrame = simulation.alpha > 0.4 ? 3 : simulation.alpha > 0.1 ? 2 : 1;
  let energy = 0;
  for (let i = 0; i < ticksThisFrame; i++) energy = simulation.tick();

  const now = Date.now();
  if (now - lastEmit >= EMIT_INTERVAL_MS || simulation.settled) {
    lastEmit = now;
    const copy = simulation.graph.positions.slice();
    ctx.postMessage(
      {
        type: 'tick',
        positions: copy.buffer,
        iteration: simulation.iteration,
        alpha: simulation.alpha,
        energy,
      },
      [copy.buffer],
    );
  }

  if (simulation.settled) {
    running = false;
    ctx.postMessage({ type: 'end', iterations: simulation.iteration });
    return;
  }
  setTimeout(loop, 0);
}

export {};
