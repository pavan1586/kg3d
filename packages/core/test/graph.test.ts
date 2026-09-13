import { describe, expect, it } from 'vitest';
import { GraphModel } from '../src/graph/GraphModel.js';
import {
  computeClustering,
  computeMetrics,
  computePagerank,
  detectCommunities,
  estimateDiameter,
  modularityOf,
  summarize,
} from '../src/graph/metrics.js';
import { bridgedTriangles, disconnectedPair, pathGraph, plantedCommunities } from './fixtures.js';

describe('GraphModel', () => {
  it('indexes nodes and edges', () => {
    const model = new GraphModel(bridgedTriangles());
    expect(model.nodeCount).toBe(7);
    expect(model.edgeCount).toBe(8);
    expect(model.indexOf('d')).toBeGreaterThanOrEqual(0);
    expect(model.indexOf('nope')).toBe(-1);
    expect(model.byId('a')?.label).toBe('A');
  });

  it('builds CSR adjacency that matches a brute-force scan', () => {
    const data = plantedCommunities(3, 20, 7);
    const model = new GraphModel(data);

    for (let i = 0; i < model.nodeCount; i++) {
      const id = model.nodes[i].id;
      const expected = new Set<string>();
      for (const edge of data.edges) {
        if (edge.source === id) expected.add(edge.target);
        if (edge.target === id) expected.add(edge.source);
      }
      const actual = new Set(Array.from(model.neighborsOf(i)).map((n) => model.nodes[n].id));
      expect(actual).toEqual(expected);
      expect(model.degreeOf(i)).toBe(expected.size);
    }
  });

  it('keeps edgesOf aligned with neighborsOf', () => {
    const model = new GraphModel(bridgedTriangles());
    for (let i = 0; i < model.nodeCount; i++) {
      const neighbors = model.neighborsOf(i);
      const edges = model.edgesOf(i);
      expect(edges.length).toBe(neighbors.length);
      for (let k = 0; k < neighbors.length; k++) {
        const edge = model.edges[edges[k]];
        // The k-th incident edge must be the one joining i to its k-th neighbour.
        const endpoints = [edge.sourceIndex, edge.targetIndex];
        expect(endpoints).toContain(i);
        expect(endpoints).toContain(neighbors[k]);
      }
    }
  });

  it('drops dangling edges instead of throwing', () => {
    const model = new GraphModel({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'ghost' },
      ],
    });
    expect(model.edgeCount).toBe(1);
  });

  it('expands a neighbourhood by hop count', () => {
    const model = new GraphModel(pathGraph(6));
    const start = model.indexOf('p0');
    expect(model.neighborhood(start, 1).size).toBe(2);
    expect(model.neighborhood(start, 2).size).toBe(3);
    expect(model.neighborhood(start, 99).size).toBe(6);
  });

  it('finds shortest paths of minimal length', () => {
    const model = new GraphModel(pathGraph(8));
    const path = model.shortestPath(model.indexOf('p0'), model.indexOf('p7'));
    expect(path).not.toBeNull();
    expect(path).toHaveLength(8);
    expect(model.nodes[path![0]].id).toBe('p0');
    expect(model.nodes[path![path!.length - 1]].id).toBe('p7');
    // Every consecutive pair must be a real edge.
    for (let i = 0; i < path!.length - 1; i++) {
      expect(Array.from(model.neighborsOf(path![i]))).toContain(path![i + 1]);
    }
  });

  it('returns a single-node path to itself and null across components', () => {
    const model = new GraphModel(disconnectedPair());
    const x1 = model.indexOf('x1');
    expect(model.shortestPath(x1, x1)).toEqual([x1]);
    expect(model.shortestPath(x1, model.indexOf('y1'))).toBeNull();
  });

  it('labels connected components', () => {
    const model = new GraphModel(disconnectedPair());
    const comp = model.components();
    expect(comp[model.indexOf('x1')]).toBe(comp[model.indexOf('x2')]);
    expect(comp[model.indexOf('x1')]).not.toBe(comp[model.indexOf('y1')]);
    expect(new Set(Array.from(comp)).size).toBe(2);
  });

  it('applies patches, dropping edges that lose an endpoint', () => {
    const model = new GraphModel(bridgedTriangles());
    model.applyPatch({
      addNodes: [{ id: 'h', label: 'H' }],
      addEdges: [{ source: 'g', target: 'h' }],
    });
    expect(model.nodeCount).toBe(8);
    expect(model.edgeCount).toBe(9);
    expect(model.degreeOf(model.indexOf('h'))).toBe(1);

    model.applyPatch({ removeNodes: ['h'] });
    expect(model.nodeCount).toBe(7);
    expect(model.edgeCount).toBe(8);
  });

  it('merges rather than duplicates on repeated node ids', () => {
    const model = new GraphModel(bridgedTriangles());
    model.applyPatch({ addNodes: [{ id: 'a', label: 'renamed' }] });
    expect(model.nodeCount).toBe(7);
    expect(model.byId('a')?.label).toBe('renamed');
  });

  it('reports node types in first-seen order', () => {
    const model = new GraphModel({
      nodes: [
        { id: '1', type: 'B' },
        { id: '2', type: 'A' },
        { id: '3', type: 'B' },
      ],
      edges: [],
    });
    expect(model.types()).toEqual(['B', 'A']);
  });

  it('round-trips through toJSON without index leakage', () => {
    const model = new GraphModel(bridgedTriangles());
    const json = model.toJSON();
    expect(json.nodes).toHaveLength(7);
    expect(json.edges[0]).not.toHaveProperty('sourceIndex');
    expect(new GraphModel(json).edgeCount).toBe(8);
  });

  it('handles an empty graph', () => {
    const model = new GraphModel({ nodes: [], edges: [] });
    expect(model.nodeCount).toBe(0);
    expect(model.components()).toHaveLength(0);
    expect(() => model.types()).not.toThrow();
  });
});

describe('centrality', () => {
  it('ranks the bridge node highest for betweenness', () => {
    const model = new GraphModel(bridgedTriangles());
    const metrics = computeMetrics(model);
    const ranked = Array.from(metrics.betweenness)
      .map((score, i) => ({ id: model.nodes[i].id, score }))
      .sort((a, b) => b.score - a.score);
    expect(ranked[0].id).toBe('d');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('ranks the middle of a path highest for betweenness', () => {
    const model = new GraphModel(pathGraph(9));
    const metrics = computeMetrics(model);
    let best = 0;
    for (let i = 1; i < model.nodeCount; i++) {
      if (metrics.betweenness[i] > metrics.betweenness[best]) best = i;
    }
    expect(model.nodes[best].id).toBe('p4');
    // Endpoints lie on no shortest path between other nodes.
    expect(metrics.betweenness[model.indexOf('p0')]).toBe(0);
  });

  it('produces a pagerank distribution that sums to one', () => {
    const model = new GraphModel(plantedCommunities(4, 25, 99));
    const rank = computePagerank(model, 60);
    const total = Array.from(rank).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 4);
    expect(Math.min(...Array.from(rank))).toBeGreaterThan(0);
  });

  it('gives a higher pagerank to a hub than to a leaf', () => {
    const model = new GraphModel({
      nodes: [{ id: 'hub' }, { id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }],
      edges: [
        { source: 'hub', target: 'l1' },
        { source: 'hub', target: 'l2' },
        { source: 'hub', target: 'l3' },
        { source: 'hub', target: 'l4' },
      ],
    });
    const rank = computePagerank(model);
    expect(rank[model.indexOf('hub')]).toBeGreaterThan(rank[model.indexOf('l1')]);
  });

  it('computes clustering coefficients of 1 inside a triangle and 0 on a path', () => {
    const triangle = new GraphModel({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'a' },
      ],
    });
    expect(Array.from(computeClustering(triangle))).toEqual([1, 1, 1]);

    const path = new GraphModel(pathGraph(5));
    expect(Array.from(computeClustering(path)).every((v) => v === 0)).toBe(true);
  });

  it('estimates the diameter of a path exactly', () => {
    expect(estimateDiameter(new GraphModel(pathGraph(10)))).toBe(9);
  });
});

describe('community detection', () => {
  it('recovers planted communities', () => {
    const data = plantedCommunities(5, 40, 2024);
    const model = new GraphModel(data);
    const { community, modularity } = detectCommunities(model);

    expect(modularity).toBeGreaterThan(0.6);
    expect(new Set(Array.from(community)).size).toBe(5);

    // Every planted group must land in exactly one detected community.
    const mapping = new Map<number, Set<number>>();
    for (let i = 0; i < model.nodeCount; i++) {
      const planted = data.truth[i];
      if (!mapping.has(planted)) mapping.set(planted, new Set());
      mapping.get(planted)!.add(community[i]);
    }
    for (const detected of mapping.values()) expect(detected.size).toBe(1);
  });

  it('separates the two triangles', () => {
    const model = new GraphModel(bridgedTriangles());
    const { community } = detectCommunities(model);
    const of = (id: string) => community[model.indexOf(id)];
    expect(of('a')).toBe(of('b'));
    expect(of('b')).toBe(of('c'));
    expect(of('e')).toBe(of('f'));
    expect(of('a')).not.toBe(of('e'));
  });

  it('is deterministic across runs', () => {
    const model = new GraphModel(plantedCommunities(4, 30, 555));
    const first = Array.from(detectCommunities(model).community);
    const second = Array.from(detectCommunities(model).community);
    expect(second).toEqual(first);
  });

  it('numbers communities largest-first so palettes stay stable', () => {
    const model = new GraphModel(plantedCommunities(4, 30, 31));
    const { community } = detectCommunities(model);
    const sizes = new Map<number, number>();
    for (const c of community) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const ordered = Array.from(sizes.entries()).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i - 1][1]).toBeGreaterThanOrEqual(ordered[i][1]);
    }
  });

  it('scores a good partition above a deliberately bad one', () => {
    const data = plantedCommunities(4, 30, 808);
    const model = new GraphModel(data);
    const good = detectCommunities(model).community;
    const everythingTogether = new Int32Array(model.nodeCount);
    const everyoneAlone = new Int32Array(model.nodeCount).map((_, i) => i);

    expect(modularityOf(model, good)).toBeGreaterThan(modularityOf(model, everythingTogether));
    expect(modularityOf(model, good)).toBeGreaterThan(modularityOf(model, everyoneAlone));
  });

  it('handles a graph with no edges', () => {
    const model = new GraphModel({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] });
    const { community, modularity } = detectCommunities(model);
    expect(community).toHaveLength(2);
    expect(modularity).toBe(0);
  });
});

describe('insight summary', () => {
  it('summarises the bridged triangles correctly', () => {
    const model = new GraphModel(bridgedTriangles());
    const insights = summarize(model, computeMetrics(model));

    expect(insights.nodeCount).toBe(7);
    expect(insights.edgeCount).toBe(8);
    expect(insights.components).toBe(1);
    expect(insights.isolated).toEqual([]);
    expect(insights.averageDegree).toBeCloseTo((2 * 8) / 7, 5);
    expect(insights.bridges[0]?.id).toBe('d');
    expect(insights.hubs.length).toBeGreaterThan(0);
    expect(insights.diameterEstimate).toBeGreaterThanOrEqual(3);
  });

  it('reports isolated nodes and multiple components', () => {
    const model = new GraphModel({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'lonely' }],
      edges: [{ source: 'a', target: 'b' }],
    });
    const insights = summarize(model, computeMetrics(model));
    expect(insights.isolated).toEqual(['lonely']);
    expect(insights.components).toBe(2);
  });

  it('names each cluster after its most influential member', () => {
    const model = new GraphModel(plantedCommunities(3, 30, 17));
    const insights = summarize(model, computeMetrics(model));
    expect(insights.clusters.length).toBeGreaterThan(0);
    for (const cluster of insights.clusters) {
      expect(cluster.size).toBeGreaterThan(0);
      expect(cluster.label).toBeTruthy();
      expect(model.byId(cluster.representative)).toBeDefined();
      expect(cluster.internalDensity).toBeGreaterThanOrEqual(0);
      expect(cluster.internalDensity).toBeLessThanOrEqual(1);
    }
    // Clusters are listed largest first.
    const sizes = insights.clusters.map((c) => c.size);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('survives an empty graph', () => {
    const model = new GraphModel({ nodes: [], edges: [] });
    const insights = summarize(model, computeMetrics(model));
    expect(insights.nodeCount).toBe(0);
    expect(insights.density).toBe(0);
    expect(insights.hubs).toEqual([]);
  });
});
