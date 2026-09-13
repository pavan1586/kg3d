import type { GraphInsights, NodeMetrics } from '../types.js';
import { mulberry32 } from '../util/math.js';
import type { GraphModel } from './GraphModel.js';

/**
 * Client-side graph analytics.
 *
 * These are the numbers that turn a pretty picture into an insight tool:
 * who is central, what holds the graph together, where the communities are.
 * Everything here is O(V+E) or an explicitly sampled approximation, so it runs
 * on 50k nodes inside a frame budget of a few hundred milliseconds. When the
 * FastAPI service is attached it computes exact values instead and the client
 * simply consumes them.
 */

export interface MetricsResult {
  degree: Float64Array;
  inDegree: Float64Array;
  outDegree: Float64Array;
  pagerank: Float64Array;
  betweenness: Float64Array;
  closeness: Float64Array;
  clustering: Float64Array;
  community: Int32Array;
  modularity: number;
}

export function computeMetrics(
  model: GraphModel,
  opts: { betweennessSamples?: number; pagerankIterations?: number } = {},
): MetricsResult {
  const n = model.nodeCount;
  const degree = new Float64Array(n);
  const inDegree = new Float64Array(n);
  const outDegree = new Float64Array(n);

  for (let i = 0; i < n; i++) degree[i] = model.degreeOf(i);
  for (const e of model.edges) {
    outDegree[e.sourceIndex]++;
    inDegree[e.targetIndex]++;
  }

  const pagerank = computePagerank(model, opts.pagerankIterations ?? 40);
  const { betweenness, closeness } = computeBetweennessAndCloseness(
    model,
    opts.betweennessSamples ?? Math.min(n, 220),
  );
  const clustering = computeClustering(model);
  const { community, modularity } = detectCommunities(model);

  return {
    degree,
    inDegree,
    outDegree,
    pagerank,
    betweenness,
    closeness,
    clustering,
    community,
    modularity,
  };
}

/* ------------------------------------------------------------- pagerank */

export function computePagerank(model: GraphModel, iterations = 40, damping = 0.85): Float64Array {
  const n = model.nodeCount;
  const rank = new Float64Array(n).fill(1 / Math.max(1, n));
  const next = new Float64Array(n);
  if (n === 0) return rank;

  const outDeg = new Float64Array(n);
  for (const e of model.edges) {
    outDeg[e.sourceIndex]++;
    if (!model.directed) outDeg[e.targetIndex]++;
  }

  for (let it = 0; it < iterations; it++) {
    next.fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outDeg[i] === 0) dangling += rank[i];
    const danglingShare = (damping * dangling) / n;

    for (const e of model.edges) {
      const s = e.sourceIndex;
      const t = e.targetIndex;
      const w = e.weight ?? 1;
      if (outDeg[s] > 0) next[t] += (damping * rank[s] * w) / outDeg[s];
      if (!model.directed && outDeg[t] > 0) next[s] += (damping * rank[t] * w) / outDeg[t];
    }
    for (let i = 0; i < n; i++) next[i] += danglingShare;

    let delta = 0;
    for (let i = 0; i < n; i++) {
      delta += Math.abs(next[i] - rank[i]);
      rank[i] = next[i];
    }
    if (delta < 1e-7) break;
  }
  return rank;
}

/* ------------------------------------------- betweenness (Brandes, sampled) */

export function computeBetweennessAndCloseness(
  model: GraphModel,
  samples: number,
): { betweenness: Float64Array; closeness: Float64Array } {
  const n = model.nodeCount;
  const betweenness = new Float64Array(n);
  const closeness = new Float64Array(n);
  if (n === 0) return { betweenness, closeness };

  const rand = mulberry32(0x5eed);
  const sourceCount = Math.min(samples, n);
  const sources: number[] = [];
  if (sourceCount === n) {
    for (let i = 0; i < n; i++) sources.push(i);
  } else {
    const picked = new Set<number>();
    while (picked.size < sourceCount) picked.add(Math.floor(rand() * n));
    sources.push(...picked);
  }

  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const predecessors: number[][] = Array.from({ length: n }, () => []);

  for (const s of sources) {
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);
    for (let i = 0; i < n; i++) predecessors[i].length = 0;

    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    const order: number[] = [];

    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      order.push(v);
      const nb = model.neighborsOf(v);
      for (let k = 0; k < nb.length; k++) {
        const w = nb[k];
        if (dist[w] === -1) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          predecessors[w].push(v);
        }
      }
    }

    let reachable = 0;
    let totalDistance = 0;
    for (let i = 0; i < n; i++) {
      if (dist[i] > 0) {
        reachable++;
        totalDistance += dist[i];
      }
    }
    if (totalDistance > 0) closeness[s] = reachable / totalDistance;

    for (let i = order.length - 1; i > 0; i--) {
      const w = order[i];
      const preds = predecessors[w];
      for (let p = 0; p < preds.length; p++) {
        const v = preds[p];
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      betweenness[w] += delta[w];
    }
  }

  // Scale the sample back up to a full-graph estimate and normalise to 0..1.
  const scale = n > 2 ? n / sourceCount / ((n - 1) * (n - 2)) : 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    betweenness[i] *= scale;
    if (betweenness[i] > max) max = betweenness[i];
  }
  if (max > 0) for (let i = 0; i < n; i++) betweenness[i] /= max;

  // Closeness was only measured at sampled sources; interpolate the rest from
  // neighbours so the encoding stays continuous.
  if (sourceCount < n) {
    const sampled = new Uint8Array(n);
    for (const s of sources) sampled[s] = 1;
    for (let i = 0; i < n; i++) {
      if (sampled[i]) continue;
      const nb = model.neighborsOf(i);
      let sum = 0;
      let count = 0;
      for (let k = 0; k < nb.length; k++) {
        if (sampled[nb[k]]) {
          sum += closeness[nb[k]];
          count++;
        }
      }
      closeness[i] = count ? sum / count : 0;
    }
  }
  return { betweenness, closeness };
}

/* ----------------------------------------------------------- clustering */

export function computeClustering(model: GraphModel): Float64Array {
  const n = model.nodeCount;
  const out = new Float64Array(n);
  const mark = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const nb = model.neighborsOf(i);
    const k = nb.length;
    if (k < 2) continue;
    for (let a = 0; a < k; a++) mark[nb[a]] = i;
    let links = 0;
    for (let a = 0; a < k; a++) {
      const inner = model.neighborsOf(nb[a]);
      for (let b = 0; b < inner.length; b++) if (mark[inner[b]] === i) links++;
    }
    out[i] = links / (k * (k - 1));
  }
  return out;
}

/* --------------------------------------------------- community detection */

/**
 * Louvain community detection: local moving, then aggregate the graph and move
 * again, until nothing improves.
 *
 * Two cheaper algorithms were tried here first and both produce a picture that
 * misleads. Label propagation reliably collapses half of a sparse graph into
 * one giant community; local moving on its own stops at dozens of fragments,
 * because it can move nodes but never whole communities. On this repository's
 * synthetic 700-node graph with seven planted domains, the three approaches
 * score Q ≈ 0.57 / 0.49 / 0.79 — only the last one recovers the domains.
 *
 * Deterministic: the shuffle uses a fixed seed, so the same graph always yields
 * the same partition and the legend does not reshuffle between reloads.
 */
export function detectCommunities(
  model: GraphModel,
  maxRounds = 30,
): { community: Int32Array; modularity: number } {
  const n = model.nodeCount;
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;
  if (n === 0) return { community: labels, modularity: 0 };

  const rand = mulberry32(0xc0ffee);

  let sources = new Int32Array(model.edges.length);
  let targets = new Int32Array(model.edges.length);
  let weights = new Float64Array(model.edges.length);
  for (let e = 0; e < model.edges.length; e++) {
    sources[e] = model.edges[e].sourceIndex;
    targets[e] = model.edges[e].targetIndex;
    weights[e] = model.edges[e].weight ?? 1;
  }

  let count = n;
  for (let level = 0; level < 10; level++) {
    const result = localMoving(count, sources, targets, weights, rand, maxRounds);
    for (let i = 0; i < n; i++) labels[i] = result.labels[labels[i]];
    if (!result.moved || result.count === count) break;

    // Aggregate: one node per community, internal edges become self-loops.
    const bucket = new Map<number, number>();
    for (let e = 0; e < sources.length; e++) {
      const a = result.labels[sources[e]];
      const b = result.labels[targets[e]];
      const key = a <= b ? a * result.count + b : b * result.count + a;
      bucket.set(key, (bucket.get(key) ?? 0) + weights[e]);
    }
    const size = bucket.size;
    sources = new Int32Array(size);
    targets = new Int32Array(size);
    weights = new Float64Array(size);
    let w = 0;
    for (const [key, weight] of bucket) {
      sources[w] = Math.floor(key / result.count);
      targets[w] = key % result.count;
      weights[w] = weight;
      w++;
    }
    count = result.count;
  }

  // Louvain rarely leaves singletons, but a disconnected fringe can still
  // produce them. Absorb anything below the threshold into whichever
  // neighbouring community it is most strongly attached to: tiny communities
  // blow up the legend, waste palette slots and hide the real structure.
  mergeSmallCommunities(model, labels, Math.max(3, Math.round(Math.sqrt(n) / 5)));

  // Compact label ids to 0..k-1, ordered by community size (largest first) so
  // palette assignment is stable and the biggest clusters get the clearest hues.
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);
  const ranked = Array.from(sizes.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const remap = new Map<number, number>();
  ranked.forEach(([lab], i) => remap.set(lab, i));
  for (let i = 0; i < n; i++) labels[i] = remap.get(labels[i]) as number;

  return { community: labels, modularity: modularityOf(model, labels) };
}

/**
 * One Louvain level: repeatedly move each node into whichever neighbouring
 * community gains the most modularity, until nothing moves.
 *
 * Works on a weighted graph given as parallel arrays rather than on GraphModel,
 * because every level after the first runs on an aggregated graph that has no
 * GraphModel behind it. Self-loops (which aggregation creates) count twice
 * toward a node's weighted degree, as the modularity definition requires.
 */
function localMoving(
  n: number,
  src: Int32Array,
  dst: Int32Array,
  weight: Float64Array,
  rand: () => number,
  maxRounds: number,
): { labels: Int32Array; count: number; moved: boolean } {
  const k = new Float64Array(n);
  const degree = new Int32Array(n);

  for (let e = 0; e < src.length; e++) {
    if (src[e] === dst[e]) {
      k[src[e]] += 2 * weight[e];
      continue;
    }
    k[src[e]] += weight[e];
    k[dst[e]] += weight[e];
    degree[src[e]]++;
    degree[dst[e]]++;
  }

  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + degree[i];
  const neighbors = new Int32Array(offsets[n]);
  const neighborWeights = new Float64Array(offsets[n]);
  const cursor = Int32Array.from(offsets.subarray(0, n));
  for (let e = 0; e < src.length; e++) {
    if (src[e] === dst[e]) continue;
    neighbors[cursor[src[e]]] = dst[e];
    neighborWeights[cursor[src[e]]++] = weight[e];
    neighbors[cursor[dst[e]]] = src[e];
    neighborWeights[cursor[dst[e]]++] = weight[e];
  }

  let m2 = 0;
  for (let i = 0; i < n; i++) m2 += k[i];

  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;
  if (m2 === 0) return { labels, count: n, moved: false };

  const community = new Int32Array(n);
  const total = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    community[i] = i;
    total[i] = k[i];
  }

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const links = new Map<number, number>();
  let moved = false;

  for (let round = 0; round < maxRounds; round++) {
    // Shuffle each round: a fixed traversal order biases the partition.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    let changed = 0;
    for (let oi = 0; oi < n; oi++) {
      const v = order[oi];
      if (offsets[v] === offsets[v + 1]) continue;
      const own = community[v];
      const kv = k[v];
      total[own] -= kv;

      links.clear();
      links.set(own, 0);
      for (let j = offsets[v]; j < offsets[v + 1]; j++) {
        const c = community[neighbors[j]];
        links.set(c, (links.get(c) ?? 0) + neighborWeights[j]);
      }

      // ΔQ·m for moving v into c, with the terms constant across c dropped.
      let best = own;
      let bestGain = (links.get(own) as number) - (kv * total[own]) / m2;
      for (const [candidate, weightIn] of links) {
        const gain = weightIn - (kv * total[candidate]) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = candidate;
        }
      }

      total[best] += kv;
      if (best !== own) {
        community[v] = best;
        changed++;
        moved = true;
      }
    }
    if (changed === 0) break;
  }

  // Compact ids to 0..count-1.
  const remap = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < n; i++) {
    let id = remap.get(community[i]);
    if (id === undefined) {
      id = count++;
      remap.set(community[i], id);
    }
    labels[i] = id;
  }
  return { labels, count, moved };
}

/**
 * Absorb communities smaller than `minSize` into their strongest neighbour.
 * Runs to a fixed point so a chain of tiny communities collapses in one call.
 */
function mergeSmallCommunities(model: GraphModel, labels: Int32Array, minSize: number): void {
  const n = model.nodeCount;
  for (let pass = 0; pass < 6; pass++) {
    const sizes = new Map<number, number>();
    for (let i = 0; i < n; i++) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);

    const small = new Set<number>();
    for (const [label, size] of sizes) if (size < minSize) small.add(label);
    if (small.size === 0) return;

    // Strength of each small community's links into every other community.
    const affinity = new Map<number, Map<number, number>>();
    for (const edge of model.edges) {
      const cs = labels[edge.sourceIndex];
      const ct = labels[edge.targetIndex];
      if (cs === ct) continue;
      const w = edge.weight ?? 1;
      if (small.has(cs)) {
        const row = affinity.get(cs) ?? new Map<number, number>();
        row.set(ct, (row.get(ct) ?? 0) + w);
        affinity.set(cs, row);
      }
      if (small.has(ct)) {
        const row = affinity.get(ct) ?? new Map<number, number>();
        row.set(cs, (row.get(cs) ?? 0) + w);
        affinity.set(ct, row);
      }
    }

    const remap = new Map<number, number>();
    for (const label of small) {
      const row = affinity.get(label);
      if (!row || row.size === 0) continue; // isolated: leave it alone
      let best = label;
      let bestScore = -1;
      for (const [other, score] of row) {
        // Prefer a bigger destination when two candidates tie.
        const size = sizes.get(other) ?? 0;
        if (score > bestScore || (score === bestScore && size > (sizes.get(best) ?? 0))) {
          best = other;
          bestScore = score;
        }
      }
      if (best !== label) remap.set(label, best);
    }
    if (remap.size === 0) return;

    for (let i = 0; i < n; i++) {
      let label = labels[i];
      // Follow the chain, with a hop cap in case of a cycle.
      for (let hop = 0; hop < 4 && remap.has(label); hop++) label = remap.get(label) as number;
      labels[i] = label;
    }
  }
}

export function modularityOf(model: GraphModel, labels: Int32Array): number {
  const m = model.edges.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  if (m === 0) return 0;
  const internal = new Map<number, number>();
  const total = new Map<number, number>();
  for (const e of model.edges) {
    const w = e.weight ?? 1;
    const cs = labels[e.sourceIndex];
    const ct = labels[e.targetIndex];
    if (cs === ct) internal.set(cs, (internal.get(cs) ?? 0) + w);
    total.set(cs, (total.get(cs) ?? 0) + w);
    total.set(ct, (total.get(ct) ?? 0) + w);
  }
  let q = 0;
  for (const [c, tot] of total) {
    q += (internal.get(c) ?? 0) / m - (tot / (2 * m)) ** 2;
  }
  return q;
}

/* ------------------------------------------------------------- insights */

/** Roll the raw metrics up into the numbers a human actually reads. */
export function summarize(model: GraphModel, metrics: MetricsResult): GraphInsights {
  const n = model.nodeCount;
  const e = model.edgeCount;
  const label = (i: number) => model.nodes[i]?.label ?? model.nodes[i]?.id ?? '';

  const topBy = (values: Float64Array, count: number) =>
    Array.from(values)
      .map((score, i) => ({ i, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .filter((x) => x.score > 0)
      .map((x) => ({ id: model.nodes[x.i].id, label: label(x.i), score: x.score }));

  const comp = model.components();
  const componentCount = comp.length ? Math.max(...Array.from(comp)) + 1 : 0;

  const clusterSizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = metrics.community[i];
    clusterSizes.set(c, (clusterSizes.get(c) ?? 0) + 1);
  }

  const internalEdges = new Map<number, number>();
  for (const edge of model.edges) {
    const cs = metrics.community[edge.sourceIndex];
    if (cs === metrics.community[edge.targetIndex]) {
      internalEdges.set(cs, (internalEdges.get(cs) ?? 0) + 1);
    }
  }

  const clusters = Array.from(clusterSizes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id, size]) => {
      // The representative is the highest-pagerank member: the cluster's name.
      let best = -1;
      let bestScore = -1;
      for (let i = 0; i < n; i++) {
        if (metrics.community[i] === id && metrics.pagerank[i] > bestScore) {
          bestScore = metrics.pagerank[i];
          best = i;
        }
      }
      const possible = (size * (size - 1)) / 2;
      return {
        id,
        size,
        label: best >= 0 ? label(best) : `Cluster ${id + 1}`,
        internalDensity: possible ? (internalEdges.get(id) ?? 0) / possible : 0,
        representative: best >= 0 ? model.nodes[best].id : '',
      };
    });

  const isolated: string[] = [];
  for (let i = 0; i < n; i++) if (metrics.degree[i] === 0) isolated.push(model.nodes[i].id);

  const avgDegree = n ? (2 * e) / n : 0;
  const density = n > 1 ? (2 * e) / (n * (n - 1)) : 0;

  return {
    nodeCount: n,
    edgeCount: e,
    density,
    averageDegree: avgDegree,
    components: componentCount,
    communities: clusterSizes.size,
    modularity: metrics.modularity,
    diameterEstimate: estimateDiameter(model),
    hubs: topBy(metrics.pagerank, 8),
    bridges: topBy(metrics.betweenness, 8),
    isolated,
    clusters,
  };
}

/** Double-sweep BFS: a tight lower bound on the diameter, in O(V+E). */
export function estimateDiameter(model: GraphModel): number {
  const n = model.nodeCount;
  if (n === 0) return 0;
  const sweep = (start: number) => {
    const dist = new Int32Array(n).fill(-1);
    dist[start] = 0;
    const queue = [start];
    let far = start;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      if (dist[v] > dist[far]) far = v;
      const nb = model.neighborsOf(v);
      for (let k = 0; k < nb.length; k++) {
        if (dist[nb[k]] === -1) {
          dist[nb[k]] = dist[v] + 1;
          queue.push(nb[k]);
        }
      }
    }
    return { far, dist: dist[far] };
  };
  const first = sweep(0);
  return sweep(first.far).dist;
}

export function metricsForNode(m: MetricsResult, i: number): NodeMetrics {
  return {
    degree: m.degree[i] ?? 0,
    inDegree: m.inDegree[i] ?? 0,
    outDegree: m.outDegree[i] ?? 0,
    pagerank: m.pagerank[i] ?? 0,
    betweenness: m.betweenness[i] ?? 0,
    closeness: m.closeness[i] ?? 0,
    clustering: m.clustering[i] ?? 0,
    community: m.community[i] ?? 0,
  };
}
