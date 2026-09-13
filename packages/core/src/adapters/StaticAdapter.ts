import type { GraphAdapter, GraphData, GraphNode, NodeId } from '../types.js';

/** Wraps an in-memory graph. Useful for tests, demos and small datasets. */
export class StaticAdapter implements GraphAdapter {
  constructor(private data: GraphData) {}

  async load(): Promise<GraphData> {
    return this.data;
  }

  async search(query: string): Promise<GraphNode[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.data.nodes
      .filter((n) => (n.label ?? n.id).toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .slice(0, 50);
  }

  async neighborhood({
    nodeId,
    depth = 1,
  }: {
    nodeId: NodeId;
    depth?: number;
  }): Promise<GraphData> {
    const keep = new Set<NodeId>([nodeId]);
    let frontier: NodeId[] = [nodeId];
    for (let d = 0; d < depth; d++) {
      const next: NodeId[] = [];
      for (const edge of this.data.edges) {
        if (frontier.includes(edge.source) && !keep.has(edge.target)) {
          keep.add(edge.target);
          next.push(edge.target);
        }
        if (frontier.includes(edge.target) && !keep.has(edge.source)) {
          keep.add(edge.source);
          next.push(edge.source);
        }
      }
      frontier = next;
    }
    return {
      nodes: this.data.nodes.filter((n) => keep.has(n.id)),
      edges: this.data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }
}
