import type { GraphData, GraphEdge, GraphNode } from '@kg3d/core';
import { mulberry32 } from '@kg3d/core';

/**
 * A synthetic but structurally honest enterprise knowledge graph.
 *
 * Random graphs make terrible demos because they have no structure to discover:
 * every node looks like every other node and the analytics say nothing. This
 * generator builds the shape real knowledge graphs have — a few dense domains,
 * a scale-free degree distribution inside each, sparse bridges between them and
 * a handful of genuine cross-domain connectors — so the community detection,
 * centrality and path-finding features have something true to find.
 */

const DOMAINS = [
  'Platform',
  'Data',
  'Security',
  'Product',
  'Research',
  'Operations',
  'Finance',
  'Customer',
];

const TYPES = ['Service', 'Dataset', 'Team', 'Person', 'Policy', 'Concept', 'Document'] as const;

const RELATIONS = [
  'depends_on',
  'owns',
  'produces',
  'governs',
  'references',
  'member_of',
  'derived_from',
];

const NOUNS = [
  'Ledger',
  'Gateway',
  'Index',
  'Registry',
  'Pipeline',
  'Vault',
  'Catalog',
  'Router',
  'Scheduler',
  'Broker',
  'Warehouse',
  'Sentinel',
  'Atlas',
  'Beacon',
  'Compass',
  'Forge',
  'Harbor',
  'Lattice',
  'Meridian',
  'Nexus',
  'Orbit',
  'Prism',
  'Quarry',
  'Relay',
  'Signal',
  'Summit',
  'Tidal',
  'Vector',
  'Willow',
  'Zenith',
  'Anchor',
  'Cascade',
];

const QUALIFIERS = [
  'Core',
  'Edge',
  'Realtime',
  'Batch',
  'Regional',
  'Global',
  'Internal',
  'Partner',
  'Legacy',
  'Next',
  'Unified',
  'Shared',
];

export interface SampleOptions {
  /** Approximate node count. */
  size?: number;
  /** How many distinct domains to generate. */
  domains?: number;
  /** Probability an edge crosses domains. Low values = crisper communities. */
  crossDomainRate?: number;
  seed?: number;
}

export function generateSampleGraph(options: SampleOptions = {}): GraphData {
  const size = options.size ?? 620;
  const domainCount = Math.min(options.domains ?? 6, DOMAINS.length);
  const crossRate = options.crossDomainRate ?? 0.06;
  const rand = mulberry32(options.seed ?? 20260908);

  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const domainMembers: number[][] = Array.from({ length: domainCount }, () => []);

  for (let i = 0; i < size; i++) {
    const domain = Math.floor(rand() * domainCount);
    const type = TYPES[Math.floor(rand() ** 1.6 * TYPES.length)];
    const label =
      type === 'Person'
        ? `${pick(['A.', 'B.', 'C.', 'D.', 'E.', 'J.', 'K.', 'M.', 'N.', 'R.', 'S.', 'T.'])} ${pick(NOUNS)}`
        : `${pick(QUALIFIERS)} ${pick(NOUNS)}${type === 'Dataset' ? ' Set' : ''}`;

    nodes.push({
      id: `n${i}`,
      label,
      type,
      group: domain,
      weight: 1,
      meta: {
        domain: DOMAINS[domain],
        owner: `${DOMAINS[domain]} ${type === 'Person' ? 'Guild' : 'Team'}`,
        criticality: ['low', 'medium', 'high'][Math.floor(rand() * 3)],
      },
    });
    domainMembers[domain].push(i);
  }

  const degree = new Int32Array(size);
  const seen = new Set<string>();

  const addEdge = (a: number, b: number, type?: string) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `e${edges.length}`,
      source: `n${a}`,
      target: `n${b}`,
      type: type ?? pick(RELATIONS),
      weight: 0.6 + rand() * 0.9,
    });
    degree[a]++;
    degree[b]++;
  };

  // Preferential attachment inside each domain produces the heavy-tailed degree
  // distribution real infrastructure graphs have: a few hubs, a long tail.
  for (const members of domainMembers) {
    if (members.length < 2) continue;
    addEdge(members[0], members[1], 'depends_on');
    for (let i = 2; i < members.length; i++) {
      const attachments = 1 + (rand() < 0.28 ? 1 : 0) + (rand() < 0.08 ? 1 : 0);
      for (let a = 0; a < attachments; a++) {
        // Sample a target with probability proportional to its degree.
        let total = 0;
        for (let k = 0; k < i; k++) total += degree[members[k]] + 1;
        let target = rand() * total;
        let chosen = members[0];
        for (let k = 0; k < i; k++) {
          target -= degree[members[k]] + 1;
          if (target <= 0) {
            chosen = members[k];
            break;
          }
        }
        addEdge(members[i], chosen);
      }
    }
    // A few local triangles so clustering coefficient is not artificially zero.
    for (let t = 0; t < members.length * 0.18; t++) {
      const a = pick(members);
      const b = pick(members);
      addEdge(a, b, 'references');
    }
  }

  // Cross-domain edges: rare, and biased toward each domain's hubs, which is
  // exactly what makes those hubs show up as high-betweenness bridges.
  const hubsPerDomain = domainMembers.map((members) =>
    [...members].sort((a, b) => degree[b] - degree[a]).slice(0, 6),
  );
  const crossCount = Math.floor(edges.length * crossRate);
  for (let i = 0; i < crossCount; i++) {
    const d1 = Math.floor(rand() * domainCount);
    let d2 = Math.floor(rand() * domainCount);
    if (d2 === d1) d2 = (d2 + 1) % domainCount;
    const a = rand() < 0.75 ? pick(hubsPerDomain[d1]) : pick(domainMembers[d1]);
    const b = rand() < 0.75 ? pick(hubsPerDomain[d2]) : pick(domainMembers[d2]);
    addEdge(a, b, 'references');
  }

  // Weight nodes by their final degree so size encoding has something to say
  // before any metrics have been computed.
  for (let i = 0; i < size; i++) {
    nodes[i].weight = 1 + degree[i];
    (nodes[i].meta as Record<string, unknown>).connections = degree[i];
  }

  return { nodes, edges };
}
