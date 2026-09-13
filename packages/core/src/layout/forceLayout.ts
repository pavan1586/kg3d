import type { ForceLayoutOptions } from '../types.js';
import { mulberry32 } from '../util/math.js';

/**
 * Barnes-Hut force-directed layout in 3D.
 *
 * The simulation is written against flat typed arrays and has no DOM or three.js
 * dependency, which is what lets it run unchanged on the main thread or inside
 * the layout Web Worker. The octree keeps the repulsion pass at O(V log V), so
 * 50k nodes settle in a few seconds instead of the ~hour an O(V^2) pass costs.
 */

export interface ForceGraph {
  nodeCount: number;
  /** Flat [x,y,z] triples, mutated in place. */
  positions: Float32Array;
  /** Edge endpoints as index pairs. */
  edgeSources: Int32Array;
  edgeTargets: Int32Array;
  edgeWeights: Float32Array;
  /** Optional per-node community for cluster cohesion. */
  communities?: Int32Array;
  /** Non-zero means the node is pinned on that axis. */
  fixedMask?: Uint8Array;
  /** Repulsion multiplier per node — heavier nodes push harder. */
  masses?: Float32Array;
}

const OCTANT_COUNT = 8;

/**
 * Flat octree. Nodes are stored in parallel arrays rather than objects so the
 * whole tree is a handful of typed-array allocations we can reuse each tick.
 */
class Octree {
  private capacity: number;
  private count = 0;

  private cx: Float32Array;
  private cy: Float32Array;
  private cz: Float32Array;
  private half: Float32Array;
  private mass: Float32Array;
  private comX: Float32Array;
  private comY: Float32Array;
  private comZ: Float32Array;
  private body: Int32Array;
  private children: Int32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(64, capacity);
    this.cx = new Float32Array(this.capacity);
    this.cy = new Float32Array(this.capacity);
    this.cz = new Float32Array(this.capacity);
    this.half = new Float32Array(this.capacity);
    this.mass = new Float32Array(this.capacity);
    this.comX = new Float32Array(this.capacity);
    this.comY = new Float32Array(this.capacity);
    this.comZ = new Float32Array(this.capacity);
    this.body = new Int32Array(this.capacity);
    this.children = new Int32Array(this.capacity * OCTANT_COUNT);
  }

  private grow(): void {
    const next = this.capacity * 2;
    const copy = (src: Float32Array) => {
      const dst = new Float32Array(next);
      dst.set(src);
      return dst;
    };
    this.cx = copy(this.cx);
    this.cy = copy(this.cy);
    this.cz = copy(this.cz);
    this.half = copy(this.half);
    this.mass = copy(this.mass);
    this.comX = copy(this.comX);
    this.comY = copy(this.comY);
    this.comZ = copy(this.comZ);
    const b = new Int32Array(next);
    b.set(this.body);
    this.body = b;
    const c = new Int32Array(next * OCTANT_COUNT);
    c.set(this.children);
    this.children = c;
    this.capacity = next;
  }

  private allocate(cx: number, cy: number, cz: number, half: number): number {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.cx[i] = cx;
    this.cy[i] = cy;
    this.cz[i] = cz;
    this.half[i] = half;
    this.mass[i] = 0;
    this.comX[i] = 0;
    this.comY[i] = 0;
    this.comZ[i] = 0;
    this.body[i] = -1;
    this.children.fill(-1, i * OCTANT_COUNT, i * OCTANT_COUNT + OCTANT_COUNT);
    return i;
  }

  build(positions: Float32Array, nodeCount: number, masses?: Float32Array): void {
    this.count = 0;
    if (nodeCount === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < nodeCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3) * 0.5 + 1;
    const root = this.allocate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, half);
    for (let i = 0; i < nodeCount; i++) {
      this.insert(root, i, positions, masses ? masses[i] : 1);
    }
  }

  private octantOf(node: number, x: number, y: number, z: number): number {
    return (x > this.cx[node] ? 1 : 0) | (y > this.cy[node] ? 2 : 0) | (z > this.cz[node] ? 4 : 0);
  }

  private insert(node: number, bodyIndex: number, positions: Float32Array, mass: number): void {
    let current = node;
    let depth = 0;
    const x = positions[bodyIndex * 3];
    const y = positions[bodyIndex * 3 + 1];
    const z = positions[bodyIndex * 3 + 2];

    // Iterative descent; the depth cap stops coincident points recursing forever.
    while (depth++ < 48) {
      const total = this.mass[current] + mass;
      this.comX[current] = (this.comX[current] * this.mass[current] + x * mass) / total;
      this.comY[current] = (this.comY[current] * this.mass[current] + y * mass) / total;
      this.comZ[current] = (this.comZ[current] * this.mass[current] + z * mass) / total;
      this.mass[current] = total;

      const isLeaf = this.children[current * OCTANT_COUNT] === -1;
      if (isLeaf && this.body[current] === -1) {
        this.body[current] = bodyIndex;
        return;
      }

      if (isLeaf) {
        // Split: push the resident body one level down, then continue.
        const resident = this.body[current];
        this.body[current] = -1;
        const rx = positions[resident * 3];
        const ry = positions[resident * 3 + 1];
        const rz = positions[resident * 3 + 2];
        const octant = this.octantOf(current, rx, ry, rz);
        const child = this.childFor(current, octant);
        this.body[child] = resident;
        this.mass[child] = 1;
        this.comX[child] = rx;
        this.comY[child] = ry;
        this.comZ[child] = rz;
      }

      const octant = this.octantOf(current, x, y, z);
      current = this.childFor(current, octant);
    }
    this.body[current] = bodyIndex;
  }

  private childFor(node: number, octant: number): number {
    const slot = node * OCTANT_COUNT + octant;
    let child = this.children[slot];
    if (child !== -1) return child;
    const h = this.half[node] * 0.5;
    child = this.allocate(
      this.cx[node] + (octant & 1 ? h : -h),
      this.cy[node] + (octant & 2 ? h : -h),
      this.cz[node] + (octant & 4 ? h : -h),
      h,
    );
    // `allocate` may have grown (and reallocated) the arrays, so index after.
    this.children[node * OCTANT_COUNT + octant] = child;
    return child;
  }

  /** Accumulate repulsion on body `i` into `out` (length-3 scratch vector). */
  repulse(
    i: number,
    positions: Float32Array,
    theta: number,
    charge: number,
    out: Float32Array,
    stack: Int32Array,
  ): void {
    if (this.count === 0) return;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp];
      const mass = this.mass[node];
      if (mass === 0) continue;
      const dx = this.comX[node] - x;
      const dy = this.comY[node] - y;
      const dz = this.comZ[node] - z;
      const distSq = dx * dx + dy * dy + dz * dz + 0.35;
      const size = this.half[node] * 2;

      const isLeaf = this.children[node * OCTANT_COUNT] === -1;
      if (isLeaf || (size * size) / distSq < theta * theta) {
        if (isLeaf && this.body[node] === i) continue;
        const dist = Math.sqrt(distSq);
        const force = (charge * mass) / (distSq * dist);
        out[0] += dx * force;
        out[1] += dy * force;
        out[2] += dz * force;
      } else {
        for (let c = 0; c < OCTANT_COUNT; c++) {
          const child = this.children[node * OCTANT_COUNT + c];
          if (child !== -1) stack[sp++] = child;
        }
      }
    }
  }
}

export class ForceSimulation {
  readonly graph: ForceGraph;
  readonly options: ForceLayoutOptions;

  private velocities: Float32Array;
  private tree: Octree;
  private scratch = new Float32Array(3);
  private forces: Float32Array;
  private stack: Int32Array;
  private clusterCenters = new Map<number, Float32Array>();

  alpha = 1;
  iteration = 0;

  constructor(graph: ForceGraph, options: ForceLayoutOptions) {
    this.graph = graph;
    this.options = options;
    this.velocities = new Float32Array(graph.nodeCount * 3);
    // Reused every tick: at 50k nodes a fresh 600KB allocation per tick is
    // several milliseconds of pure garbage-collection pressure.
    this.forces = new Float32Array(graph.nodeCount * 3);
    this.tree = new Octree(Math.max(2048, graph.nodeCount * 3));
    this.stack = new Int32Array(4096);
  }

  /** Seed positions on a sphere when the caller supplied none. */
  static seed(positions: Float32Array, nodeCount: number, radius: number, seed = 42): void {
    const rand = mulberry32(seed);
    for (let i = 0; i < nodeCount; i++) {
      if (positions[i * 3] !== 0 || positions[i * 3 + 1] !== 0 || positions[i * 3 + 2] !== 0) {
        continue;
      }
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = Math.cbrt(rand()) * radius;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = r * s * Math.cos(theta);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * s * Math.sin(theta);
    }
  }

  /** One simulation step. Returns the average kinetic energy. */
  tick(): number {
    const { positions, edgeSources, edgeTargets, edgeWeights, nodeCount } = this.graph;
    const o = this.options;
    if (nodeCount === 0) return 0;

    const forces = this.forces;
    forces.fill(0);
    this.tree.build(positions, nodeCount, this.graph.masses);

    // Repulsion — every node against the octree.
    for (let i = 0; i < nodeCount; i++) {
      this.scratch[0] = 0;
      this.scratch[1] = 0;
      this.scratch[2] = 0;
      this.tree.repulse(i, positions, o.theta, o.charge, this.scratch, this.stack);
      forces[i * 3] += this.scratch[0];
      forces[i * 3 + 1] += this.scratch[1];
      forces[i * 3 + 2] += this.scratch[2];
    }

    // Springs — edges pull toward the ideal length.
    for (let e = 0; e < edgeSources.length; e++) {
      const s = edgeSources[e];
      const t = edgeTargets[e];
      const dx = positions[t * 3] - positions[s * 3];
      const dy = positions[t * 3 + 1] - positions[s * 3 + 1];
      const dz = positions[t * 3 + 2] - positions[s * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      const weight = edgeWeights[e] || 1;
      const displacement = (dist - o.linkDistance) / dist;
      const k = o.linkStrength * weight * displacement * 0.5;
      forces[s * 3] += dx * k;
      forces[s * 3 + 1] += dy * k;
      forces[s * 3 + 2] += dz * k;
      forces[t * 3] -= dx * k;
      forces[t * 3 + 1] -= dy * k;
      forces[t * 3 + 2] -= dz * k;
    }

    // Gravity toward the origin keeps disconnected components in frame.
    for (let i = 0; i < nodeCount; i++) {
      forces[i * 3] -= positions[i * 3] * o.gravity;
      forces[i * 3 + 1] -= positions[i * 3 + 1] * o.gravity;
      forces[i * 3 + 2] -= positions[i * 3 + 2] * o.gravity;
    }

    // Community cohesion: an extra pull toward each cluster's centroid, which
    // is what makes communities read as distinct volumes rather than a mush.
    if (this.graph.communities && o.clusterStrength > 0) {
      this.applyClusterForces(forces);
    }

    // Integrate.
    const damping = o.damping;
    const fixed = this.graph.fixedMask;
    let energy = 0;
    const step = Math.min(1, this.alpha * 2.2);
    for (let i = 0; i < nodeCount; i++) {
      if (fixed && fixed[i]) {
        this.velocities[i * 3] = 0;
        this.velocities[i * 3 + 1] = 0;
        this.velocities[i * 3 + 2] = 0;
        continue;
      }
      for (let a = 0; a < 3; a++) {
        const idx = i * 3 + a;
        if (o.dimensions === 2 && a === 2) {
          positions[idx] *= 0.85;
          this.velocities[idx] = 0;
          continue;
        }
        let v = (this.velocities[idx] + forces[idx] * step) * damping;
        // Velocity clamp: without it a dense cluster can explode on tick 1.
        const limit = o.linkDistance * 1.5;
        if (v > limit) v = limit;
        else if (v < -limit) v = -limit;
        this.velocities[idx] = v;
        positions[idx] += v;
        energy += v * v;
      }
    }

    this.iteration++;
    this.alpha *= 0.985;
    return energy / nodeCount;
  }

  private applyClusterForces(forces: Float32Array): void {
    const communities = this.graph.communities as Int32Array;
    const { positions, nodeCount } = this.graph;
    this.clusterCenters.clear();
    const counts = new Map<number, number>();
    for (let i = 0; i < nodeCount; i++) {
      const c = communities[i];
      let acc = this.clusterCenters.get(c);
      if (!acc) {
        acc = new Float32Array(3);
        this.clusterCenters.set(c, acc);
      }
      acc[0] += positions[i * 3];
      acc[1] += positions[i * 3 + 1];
      acc[2] += positions[i * 3 + 2];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const [c, acc] of this.clusterCenters) {
      const n = counts.get(c) ?? 1;
      acc[0] /= n;
      acc[1] /= n;
      acc[2] /= n;
    }
    const k = this.options.clusterStrength;
    for (let i = 0; i < nodeCount; i++) {
      const acc = this.clusterCenters.get(communities[i]);
      if (!acc) continue;
      forces[i * 3] += (acc[0] - positions[i * 3]) * k;
      forces[i * 3 + 1] += (acc[1] - positions[i * 3 + 1]) * k;
      forces[i * 3 + 2] += (acc[2] - positions[i * 3 + 2]) * k;
    }
  }

  /** Re-heat the simulation, e.g. after the user drags a node. */
  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  get settled(): boolean {
    return this.alpha <= this.options.alphaMin || this.iteration >= this.options.maxIterations;
  }
}
