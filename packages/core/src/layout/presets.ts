import type { GraphModel } from '../graph/GraphModel.js';
import type { LayoutName } from '../types.js';
import { fibonacciSphere, mulberry32 } from '../util/math.js';

/**
 * Deterministic, instant layouts. These are not competitors to the force
 * simulation — they are the *readable* alternatives: a hierarchy answers
 * "what reports to what", a radial answers "how far is everything from here",
 * a cluster layout answers "how big are my communities". Switching between them
 * on the same graph is where a lot of the insight actually comes from.
 */

export interface PresetContext {
  model: GraphModel;
  /** Community per node index, when available. */
  communities?: Int32Array;
  /** Focus node index for radial layouts. */
  focus?: number;
  /** Overall scale in world units. */
  radius?: number;
}

export function applyPreset(layout: LayoutName, positions: Float32Array, ctx: PresetContext): void {
  const radius = ctx.radius ?? autoRadius(ctx.model.nodeCount);
  switch (layout) {
    case 'sphere':
      spherePreset(positions, ctx.model.nodeCount, radius);
      break;
    case 'grid':
      gridPreset(positions, ctx.model.nodeCount, radius);
      break;
    case 'radial':
      radialPreset(positions, ctx, radius);
      break;
    case 'hierarchy':
      hierarchyPreset(positions, ctx, radius);
      break;
    case 'cluster':
      clusterPreset(positions, ctx, radius);
      break;
    default:
      break;
  }
}

export function autoRadius(nodeCount: number): number {
  // Keeps average node separation roughly constant as the graph grows.
  return Math.max(120, Math.cbrt(Math.max(1, nodeCount)) * 46);
}

function spherePreset(positions: Float32Array, count: number, radius: number): void {
  const points = fibonacciSphere(count, radius);
  positions.set(points.subarray(0, count * 3));
}

function gridPreset(positions: Float32Array, count: number, radius: number): void {
  const side = Math.ceil(Math.cbrt(Math.max(1, count)));
  const spacing = (radius * 2) / Math.max(1, side - 1 || 1);
  const offset = ((side - 1) * spacing) / 2;
  for (let i = 0; i < count; i++) {
    const x = i % side;
    const y = Math.floor(i / side) % side;
    const z = Math.floor(i / (side * side));
    positions[i * 3] = x * spacing - offset;
    positions[i * 3 + 1] = y * spacing - offset;
    positions[i * 3 + 2] = z * spacing - offset;
  }
}

/** Concentric shells by BFS distance from the focus node. */
function radialPreset(positions: Float32Array, ctx: PresetContext, radius: number): void {
  const { model } = ctx;
  const n = model.nodeCount;
  const focus = ctx.focus ?? pickMostCentral(model);
  const dist = new Int32Array(n).fill(-1);
  if (n === 0) return;
  dist[focus] = 0;
  const queue = [focus];
  let maxDist = 0;
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const nb = model.neighborsOf(v);
    for (let k = 0; k < nb.length; k++) {
      if (dist[nb[k]] === -1) {
        dist[nb[k]] = dist[v] + 1;
        maxDist = Math.max(maxDist, dist[nb[k]]);
        queue.push(nb[k]);
      }
    }
  }
  const shells = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const d = dist[i] === -1 ? maxDist + 1 : dist[i];
    const list = shells.get(d) ?? [];
    list.push(i);
    shells.set(d, list);
  }
  const shellCount = Math.max(1, Math.max(...shells.keys()));
  for (const [d, members] of shells) {
    const r = (d / shellCount) * radius;
    const points = fibonacciSphere(members.length, r || 0.001);
    members.forEach((nodeIndex, k) => {
      positions[nodeIndex * 3] = points[k * 3];
      positions[nodeIndex * 3 + 1] = points[k * 3 + 1];
      positions[nodeIndex * 3 + 2] = points[k * 3 + 2];
    });
  }
}

/** Layered by `node.level` (or BFS depth), spread on rings per layer. */
function hierarchyPreset(positions: Float32Array, ctx: PresetContext, radius: number): void {
  const { model } = ctx;
  const n = model.nodeCount;
  if (n === 0) return;
  const levels = new Int32Array(n);
  let hasExplicit = false;
  for (let i = 0; i < n; i++) {
    const lvl = model.nodes[i].level;
    if (typeof lvl === 'number') {
      levels[i] = lvl;
      hasExplicit = true;
    } else {
      levels[i] = -1;
    }
  }
  if (!hasExplicit) {
    const root = pickMostCentral(model);
    levels.fill(-1);
    levels[root] = 0;
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      const nb = model.neighborsOf(v);
      for (let k = 0; k < nb.length; k++) {
        if (levels[nb[k]] === -1) {
          levels[nb[k]] = levels[v] + 1;
          queue.push(nb[k]);
        }
      }
    }
    for (let i = 0; i < n; i++) if (levels[i] === -1) levels[i] = 0;
  } else {
    for (let i = 0; i < n; i++) if (levels[i] === -1) levels[i] = 0;
  }

  const byLevel = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const list = byLevel.get(levels[i]) ?? [];
    list.push(i);
    byLevel.set(levels[i], list);
  }
  const depths = Array.from(byLevel.keys()).sort((a, b) => a - b);
  const layerGap = (radius * 1.6) / Math.max(1, depths.length - 1 || 1);
  const top = ((depths.length - 1) * layerGap) / 2;

  depths.forEach((depth, li) => {
    const members = byLevel.get(depth) as number[];
    const ringRadius = Math.max(40, Math.sqrt(members.length) * 26);
    const y = top - li * layerGap;
    members.forEach((nodeIndex, k) => {
      // Golden-angle spiral inside each layer: even spacing, no visible rings.
      const angle = k * 2.399963;
      const r = ringRadius * Math.sqrt((k + 0.5) / members.length);
      positions[nodeIndex * 3] = Math.cos(angle) * r;
      positions[nodeIndex * 3 + 1] = y;
      positions[nodeIndex * 3 + 2] = Math.sin(angle) * r;
    });
  });
}

/** Communities become separated globes — the clearest read of group structure. */
function clusterPreset(positions: Float32Array, ctx: PresetContext, radius: number): void {
  const { model, communities } = ctx;
  const n = model.nodeCount;
  if (n === 0) return;
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = communities ? communities[i] : 0;
    const list = groups.get(c) ?? [];
    list.push(i);
    groups.set(c, list);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  const centers = fibonacciSphere(ordered.length, radius);
  const rand = mulberry32(7);
  ordered.forEach(([, members], gi) => {
    const localRadius = Math.max(24, Math.cbrt(members.length) * 26);
    const local = fibonacciSphere(members.length, localRadius);
    members.forEach((nodeIndex, k) => {
      positions[nodeIndex * 3] = centers[gi * 3] + local[k * 3] * (0.7 + rand() * 0.3);
      positions[nodeIndex * 3 + 1] = centers[gi * 3 + 1] + local[k * 3 + 1] * (0.7 + rand() * 0.3);
      positions[nodeIndex * 3 + 2] = centers[gi * 3 + 2] + local[k * 3 + 2] * (0.7 + rand() * 0.3);
    });
  });
}

export function pickMostCentral(model: GraphModel): number {
  let best = 0;
  let bestDegree = -1;
  for (let i = 0; i < model.nodeCount; i++) {
    const d = model.degreeOf(i);
    if (d > bestDegree) {
      bestDegree = d;
      best = i;
    }
  }
  return best;
}
