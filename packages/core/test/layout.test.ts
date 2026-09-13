import { describe, expect, it } from 'vitest';
import { GraphModel } from '../src/graph/GraphModel.js';
import { computeMetrics } from '../src/graph/metrics.js';
import { ForceSimulation, type ForceGraph } from '../src/layout/forceLayout.js';
import { applyPreset, autoRadius, pickMostCentral } from '../src/layout/presets.js';
import { DEFAULT_FORCE, DEFAULT_RENDER } from '../src/constants.js';
import { buildLegend, computeColors, computeRadii } from '../src/state/encodings.js';
import { resolveTheme, THEMES, isLightTheme } from '../src/theme/themes.js';
import {
  clamp,
  easeInOutCubic,
  fibonacciSphere,
  lerp,
  mulberry32,
  normalize,
} from '../src/util/math.js';
import { luminance, mix, paletteFor, parseColor, sampleScheme, toHex } from '../src/util/color.js';
import { EventEmitter } from '../src/util/EventEmitter.js';
import { plantedCommunities, pathGraph } from './fixtures.js';

function buildForceGraph(model: GraphModel, communities?: Int32Array): ForceGraph {
  const edgeSources = new Int32Array(model.edgeCount);
  const edgeTargets = new Int32Array(model.edgeCount);
  const edgeWeights = new Float32Array(model.edgeCount);
  for (let i = 0; i < model.edgeCount; i++) {
    edgeSources[i] = model.edges[i].sourceIndex;
    edgeTargets[i] = model.edges[i].targetIndex;
    edgeWeights[i] = 1;
  }
  const positions = new Float32Array(model.nodeCount * 3);
  ForceSimulation.seed(positions, model.nodeCount, 200, 42);
  return {
    nodeCount: model.nodeCount,
    positions,
    edgeSources,
    edgeTargets,
    edgeWeights,
    communities,
    fixedMask: new Uint8Array(model.nodeCount),
    masses: new Float32Array(model.nodeCount).fill(1),
  };
}

describe('force simulation', () => {
  it('is deterministic for a fixed seed', () => {
    const model = new GraphModel(plantedCommunities(3, 25, 4));
    const runOnce = () => {
      const graph = buildForceGraph(model);
      const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
      for (let i = 0; i < 40; i++) sim.tick();
      return Array.from(graph.positions);
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it('keeps every coordinate finite', () => {
    const model = new GraphModel(plantedCommunities(4, 30, 11));
    const graph = buildForceGraph(model);
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
    for (let i = 0; i < 120; i++) sim.tick();
    expect(Array.from(graph.positions).every(Number.isFinite)).toBe(true);
  });

  it('separates nodes rather than collapsing them together', () => {
    const model = new GraphModel(plantedCommunities(3, 20, 6));
    const graph = buildForceGraph(model);
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
    for (let i = 0; i < 150; i++) sim.tick();

    let closest = Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      for (let j = i + 1; j < graph.nodeCount; j++) {
        const dx = graph.positions[i * 3] - graph.positions[j * 3];
        const dy = graph.positions[i * 3 + 1] - graph.positions[j * 3 + 1];
        const dz = graph.positions[i * 3 + 2] - graph.positions[j * 3 + 2];
        closest = Math.min(closest, Math.hypot(dx, dy, dz));
      }
    }
    expect(closest).toBeGreaterThan(0.5);
  });

  it('pulls connected nodes closer than unconnected ones', () => {
    // A dumbbell: two tight clusters joined by one edge.
    const model = new GraphModel(plantedCommunities(2, 20, 8));
    const communities = computeMetrics(model).community;
    const graph = buildForceGraph(model, communities);
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
    for (let i = 0; i < 250; i++) sim.tick();

    const distance = (a: number, b: number) =>
      Math.hypot(
        graph.positions[a * 3] - graph.positions[b * 3],
        graph.positions[a * 3 + 1] - graph.positions[b * 3 + 1],
        graph.positions[a * 3 + 2] - graph.positions[b * 3 + 2],
      );

    let linked = 0;
    for (const edge of model.edges) linked += distance(edge.sourceIndex, edge.targetIndex);
    linked /= model.edgeCount;

    const rand = mulberry32(3);
    let random = 0;
    const samples = 200;
    for (let s = 0; s < samples; s++) {
      random += distance(
        Math.floor(rand() * model.nodeCount),
        Math.floor(rand() * model.nodeCount),
      );
    }
    random /= samples;

    expect(linked).toBeLessThan(random);
  });

  it('never moves a pinned node', () => {
    const model = new GraphModel(plantedCommunities(2, 15, 12));
    const graph = buildForceGraph(model);
    graph.fixedMask![3] = 1;
    const before = [graph.positions[9], graph.positions[10], graph.positions[11]];
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
    for (let i = 0; i < 80; i++) sim.tick();
    expect([graph.positions[9], graph.positions[10], graph.positions[11]]).toEqual(before);
  });

  it('flattens the z axis in 2D mode', () => {
    const model = new GraphModel(plantedCommunities(2, 20, 21));
    const graph = buildForceGraph(model);
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false, dimensions: 2 });
    for (let i = 0; i < 200; i++) sim.tick();
    let maxZ = 0;
    for (let i = 0; i < graph.nodeCount; i++)
      maxZ = Math.max(maxZ, Math.abs(graph.positions[i * 3 + 2]));
    expect(maxZ).toBeLessThan(1);
  });

  it('cools down and reports as settled', () => {
    const model = new GraphModel(pathGraph(30));
    const graph = buildForceGraph(model);
    const sim = new ForceSimulation(graph, {
      ...DEFAULT_FORCE,
      useWorker: false,
      maxIterations: 50,
    });
    expect(sim.settled).toBe(false);
    for (let i = 0; i < 60; i++) sim.tick();
    expect(sim.settled).toBe(true);
    expect(sim.alpha).toBeLessThan(1);
  });

  it('reheats on demand', () => {
    const model = new GraphModel(pathGraph(20));
    const graph = buildForceGraph(model);
    const sim = new ForceSimulation(graph, { ...DEFAULT_FORCE, useWorker: false });
    for (let i = 0; i < 100; i++) sim.tick();
    const cooled = sim.alpha;
    sim.reheat(0.8);
    expect(sim.alpha).toBeGreaterThan(cooled);
  });

  it('handles an empty graph without dividing by zero', () => {
    const empty: ForceGraph = {
      nodeCount: 0,
      positions: new Float32Array(0),
      edgeSources: new Int32Array(0),
      edgeTargets: new Int32Array(0),
      edgeWeights: new Float32Array(0),
    };
    const sim = new ForceSimulation(empty, { ...DEFAULT_FORCE, useWorker: false });
    expect(sim.tick()).toBe(0);
  });
});

describe('layout presets', () => {
  const model = new GraphModel(plantedCommunities(4, 20, 66));
  const communities = computeMetrics(model).community;

  it('places every sphere node on the same radius', () => {
    const positions = new Float32Array(model.nodeCount * 3);
    applyPreset('sphere', positions, { model, radius: 300 });
    for (let i = 0; i < model.nodeCount; i++) {
      const r = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      expect(r).toBeCloseTo(300, 3);
    }
  });

  it('lays a grid out on discrete axes', () => {
    const positions = new Float32Array(model.nodeCount * 3);
    applyPreset('grid', positions, { model, radius: 200 });
    const xs = new Set<number>();
    for (let i = 0; i < model.nodeCount; i++) xs.add(Math.round(positions[i * 3] * 1000));
    expect(xs.size).toBeLessThan(model.nodeCount);
    expect(xs.size).toBeGreaterThan(1);
  });

  it('stacks hierarchy layers on distinct heights', () => {
    const positions = new Float32Array(model.nodeCount * 3);
    applyPreset('hierarchy', positions, { model, radius: 200 });
    const levels = new Set<number>();
    for (let i = 0; i < model.nodeCount; i++) levels.add(Math.round(positions[i * 3 + 1] * 100));
    expect(levels.size).toBeGreaterThan(1);
    expect(levels.size).toBeLessThan(model.nodeCount);
  });

  it('groups communities into separated volumes', () => {
    const positions = new Float32Array(model.nodeCount * 3);
    applyPreset('cluster', positions, { model, communities, radius: 400 });

    const centroid = (community: number) => {
      let x = 0,
        y = 0,
        z = 0,
        n = 0;
      for (let i = 0; i < model.nodeCount; i++) {
        if (communities[i] !== community) continue;
        x += positions[i * 3];
        y += positions[i * 3 + 1];
        z += positions[i * 3 + 2];
        n++;
      }
      return n ? [x / n, y / n, z / n] : null;
    };

    const ids = Array.from(new Set(Array.from(communities)));
    const centres = ids.map(centroid).filter(Boolean) as number[][];
    for (let a = 0; a < centres.length; a++) {
      for (let b = a + 1; b < centres.length; b++) {
        const d = Math.hypot(
          centres[a][0] - centres[b][0],
          centres[a][1] - centres[b][1],
          centres[a][2] - centres[b][2],
        );
        expect(d).toBeGreaterThan(20);
      }
    }
  });

  it('puts the focus node at the centre of a radial layout', () => {
    const positions = new Float32Array(model.nodeCount * 3);
    const focus = pickMostCentral(model);
    applyPreset('radial', positions, { model, focus, radius: 300 });
    const r = Math.hypot(positions[focus * 3], positions[focus * 3 + 1], positions[focus * 3 + 2]);
    expect(r).toBeLessThan(1);
  });

  it('scales the default radius with graph size', () => {
    expect(autoRadius(10000)).toBeGreaterThan(autoRadius(100));
  });
});

describe('visual encodings', () => {
  const model = new GraphModel(plantedCommunities(4, 25, 77));
  const metrics = computeMetrics(model);
  const theme = THEMES.obsidian;
  const typeOrder = model.types();

  it('gives one colour per node and reuses it for a type', () => {
    const colors = computeColors(model, { by: 'type' }, theme, metrics, typeOrder);
    expect(colors).toHaveLength(model.nodeCount * 3);

    const byType = new Map<string, string>();
    for (let i = 0; i < model.nodeCount; i++) {
      const key = model.nodes[i].type ?? 'Node';
      const hex = toHex({ r: colors[i * 3], g: colors[i * 3 + 1], b: colors[i * 3 + 2] });
      if (byType.has(key)) expect(byType.get(key)).toBe(hex);
      else byType.set(key, hex);
    }
    expect(byType.size).toBe(typeOrder.length);
  });

  it('honours an explicit node colour over the palette', () => {
    const custom = new GraphModel({
      nodes: [
        { id: 'a', type: 'X', color: '#ff0000' },
        { id: 'b', type: 'X' },
      ],
      edges: [],
    });
    const colors = computeColors(custom, { by: 'type' }, theme, null, custom.types());
    expect(toHex({ r: colors[0], g: colors[1], b: colors[2] })).toBe('#ff0000');
  });

  it('maps a metric onto a continuous ramp', () => {
    const colors = computeColors(
      model,
      { by: 'metric', metric: 'pagerank' },
      theme,
      metrics,
      typeOrder,
    );
    const distinct = new Set<string>();
    for (let i = 0; i < model.nodeCount; i++) {
      distinct.add(toHex({ r: colors[i * 3], g: colors[i * 3 + 1], b: colors[i * 3 + 2] }));
    }
    // A continuous encoding should not collapse to a handful of buckets.
    expect(distinct.size).toBeGreaterThan(typeOrder.length);
  });

  it('keeps radii inside the configured bounds and monotonic in the metric', () => {
    const radii = computeRadii(model, { by: 'metric', metric: 'degree' }, DEFAULT_RENDER, metrics);
    for (const r of radii) {
      expect(r).toBeGreaterThanOrEqual(DEFAULT_RENDER.minNodeSize - 1e-6);
      expect(r).toBeLessThanOrEqual(DEFAULT_RENDER.maxNodeSize + 1e-6);
    }
    let low = 0,
      high = 0;
    for (let i = 0; i < model.nodeCount; i++) {
      if (metrics.degree[i] < metrics.degree[low]) low = i;
      if (metrics.degree[i] > metrics.degree[high]) high = i;
    }
    expect(radii[high]).toBeGreaterThan(radii[low]);
  });

  it('uses a flat radius for the constant encoding', () => {
    const radii = computeRadii(model, { by: 'constant' }, DEFAULT_RENDER, metrics);
    expect(new Set(Array.from(radii)).size).toBe(1);
  });

  it('builds a legend whose counts add up', () => {
    const legend = buildLegend(model, { by: 'type' }, theme, metrics, typeOrder);
    expect(legend.reduce((sum, entry) => sum + entry.count, 0)).toBe(model.nodeCount);
    expect(legend.every((entry) => entry.color.startsWith('#'))).toBe(true);
  });

  it('returns no swatches for a continuous encoding', () => {
    expect(
      buildLegend(model, { by: 'metric', metric: 'pagerank' }, theme, metrics, typeOrder),
    ).toEqual([]);
  });
});

describe('themes', () => {
  it('resolves built-ins by name and falls back safely', () => {
    expect(resolveTheme('nebula').name).toBe('nebula');
    expect(resolveTheme(undefined).name).toBe('obsidian');
  });

  it('merges a partial override onto a base theme', () => {
    const theme = resolveTheme({ name: 'daylight', background: '#123456' });
    expect(theme.background).toBe('#123456');
    expect(theme.labelColor).toBe(THEMES.daylight.labelColor);
  });

  it('identifies the light theme and gives every theme a full palette', () => {
    expect(isLightTheme(THEMES.daylight)).toBe(true);
    expect(isLightTheme(THEMES.obsidian)).toBe(false);
    for (const theme of Object.values(THEMES)) {
      expect(theme.palette.length).toBeGreaterThanOrEqual(8);
      expect(theme.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
    }
  });

  it('keeps label and background luminance far enough apart to read', () => {
    for (const theme of Object.values(THEMES)) {
      const contrast = Math.abs(
        luminance(parseColor(theme.labelColor)) - luminance(parseColor(theme.background)),
      );
      expect(contrast).toBeGreaterThan(0.3);
    }
  });
});

describe('utilities', () => {
  it('produces a repeatable pseudo-random sequence', () => {
    const a = Array.from({ length: 5 }, mulberry32(7));
    const b = Array.from({ length: 5 }, mulberry32(7));
    expect(a).toEqual(b);
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('spreads fibonacci sphere points evenly on the radius', () => {
    const points = fibonacciSphere(64, 10);
    for (let i = 0; i < 64; i++) {
      expect(Math.hypot(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])).toBeCloseTo(10, 5);
    }
  });

  it('clamps, interpolates and eases within bounds', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });

  it('normalises while resisting a single outlier', () => {
    // 1..99 plus one absurd hub. Without percentile clipping the whole body of
    // the distribution collapses to ~0 and every node renders the same size.
    const values = [...Array.from({ length: 99 }, (_, i) => i + 1), 1_000_000];
    const scaled = normalize(values);

    expect(scaled[49]).toBeGreaterThan(0.35);
    expect(scaled[49]).toBeLessThan(0.65);
    expect(scaled[98]).toBeCloseTo(1, 2);
    expect(scaled[99]).toBe(1);
    expect(Math.min(...Array.from(scaled))).toBe(0);
  });

  it('maps a flat distribution to zero rather than dividing by zero', () => {
    const scaled = normalize(Array.from({ length: 10 }, () => 42));
    expect(Array.from(scaled).every((v) => v === 0)).toBe(true);
  });

  it('parses every colour notation it claims to', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseColor('rgb(0, 0, 255)').b).toBe(1);
    expect(parseColor('nonsense')).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('mixes colours and samples ramp endpoints exactly', () => {
    expect(toHex(mix(parseColor('#000000'), parseColor('#ffffff'), 0.5))).toBe('#808080');
    const scheme = ['#000000', '#ffffff'];
    expect(toHex(sampleScheme(scheme, 0))).toBe('#000000');
    expect(toHex(sampleScheme(scheme, 1))).toBe('#ffffff');
  });

  it('assigns a stable palette colour per key', () => {
    const palette = ['#111111', '#222222', '#333333'];
    expect(paletteFor('service', palette)).toBe(paletteFor('service', palette));
  });
});

describe('EventEmitter', () => {
  it('subscribes, emits and unsubscribes', () => {
    const emitter = new EventEmitter<{ ping: { n: number } }>();
    const seen: number[] = [];
    const off = emitter.on('ping', ({ n }) => seen.push(n));
    emitter.emit('ping', { n: 1 });
    off();
    emitter.emit('ping', { n: 2 });
    expect(seen).toEqual([1]);
  });

  it('fires a once listener exactly once', () => {
    const emitter = new EventEmitter<{ ping: null }>();
    let count = 0;
    emitter.once('ping', () => count++);
    emitter.emit('ping', null);
    emitter.emit('ping', null);
    expect(count).toBe(1);
  });

  it('keeps running when a listener throws', () => {
    const emitter = new EventEmitter<{ ping: null }>();
    const seen: string[] = [];
    emitter.on('ping', () => {
      throw new Error('listener blew up');
    });
    emitter.on('ping', () => seen.push('second'));
    expect(() => emitter.emit('ping', null)).not.toThrow();
    expect(seen).toEqual(['second']);
  });
});
