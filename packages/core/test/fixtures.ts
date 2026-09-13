import type { GraphData } from '../src/types.js';
import { mulberry32 } from '../src/util/math.js';

/**
 * Two triangles joined by a single bridge node.
 *
 *      a───b          e───f
 *       \ /            \ /
 *        c──── d ───────g
 *
 * Small enough to reason about by hand, and structured enough that every
 * analytic has a known right answer: `d` is the only articulation point, so it
 * must top betweenness, and the two triangles must fall out as two communities.
 */
export function bridgedTriangles(): GraphData {
  return {
    nodes: 'abcdefg'.split('').map((id) => ({ id, label: id.toUpperCase(), type: 'Concept' })),
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'e' },
      { source: 'e', target: 'f' },
      { source: 'f', target: 'g' },
      { source: 'g', target: 'e' },
    ],
  };
}

/**
 * A graph with `groups` planted communities: dense inside, sparse between.
 *
 * This is the fixture community detection is judged against — we know the right
 * answer because we built it, so "did Louvain recover the planted structure?"
 * is a real assertion rather than a snapshot of whatever the code happened to
 * produce.
 */
export function plantedCommunities(
  groups = 5,
  perGroup = 40,
  seed = 1234,
): GraphData & { truth: number[] } {
  const rand = mulberry32(seed);
  const nodes: GraphData['nodes'] = [];
  const truth: number[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < perGroup; i++) {
      nodes.push({ id: `g${g}n${i}`, label: `G${g} N${i}`, type: `Type${g % 3}` });
      truth.push(g);
    }
  }

  const edges: GraphData['edges'] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: nodes[a].id, target: nodes[b].id });
  };

  for (let g = 0; g < groups; g++) {
    const base = g * perGroup;
    // A ring guarantees connectivity, plus chords for density.
    for (let i = 0; i < perGroup; i++) add(base + i, base + ((i + 1) % perGroup));
    for (let i = 0; i < perGroup * 2; i++) {
      add(base + Math.floor(rand() * perGroup), base + Math.floor(rand() * perGroup));
    }
  }
  // Sparse inter-group links: enough to connect the graph, few enough that the
  // communities remain the dominant structure.
  for (let g = 0; g < groups; g++) {
    const next = (g + 1) % groups;
    for (let k = 0; k < 2; k++) {
      add(
        g * perGroup + Math.floor(rand() * perGroup),
        next * perGroup + Math.floor(rand() * perGroup),
      );
    }
  }

  return { nodes, edges, truth };
}

/** A path graph: predictable distances, diameter and betweenness ordering. */
export function pathGraph(length: number): GraphData {
  const nodes = Array.from({ length }, (_, i) => ({ id: `p${i}`, label: `P${i}` }));
  const edges = Array.from({ length: length - 1 }, (_, i) => ({
    source: `p${i}`,
    target: `p${i + 1}`,
  }));
  return { nodes, edges };
}

/** Two components that share no edge — for component and path assertions. */
export function disconnectedPair(): GraphData {
  return {
    nodes: ['x1', 'x2', 'y1', 'y2'].map((id) => ({ id })),
    edges: [
      { source: 'x1', target: 'x2' },
      { source: 'y1', target: 'y2' },
    ],
  };
}
