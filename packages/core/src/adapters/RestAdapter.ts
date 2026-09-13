import type { GraphAdapter, GraphData, GraphNode, NeighborhoodQuery, NodeId } from '../types.js';

export interface RestAdapterOptions {
  /** Base URL of the kg3d FastAPI service, e.g. https://graph.internal/api/v1 */
  baseUrl: string;
  /** Graph identifier registered with the service. */
  graphId: string;
  /** Extra headers — auth tokens, tenant ids. */
  headers?: Record<string, string>;
  /** Server-side layout: ask the API for precomputed 3D coordinates. */
  serverLayout?: boolean;
  /** Ask the service to include analytics on every node. */
  withMetrics?: boolean;
  /** Cap on the initial payload; the service returns its most central slice. */
  limit?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Talks to the bundled FastAPI service.
 *
 * The contract is intentionally small (four endpoints), so pointing this at an
 * existing internal graph API usually means writing a thin route shim rather
 * than reimplementing the adapter.
 */
export class RestAdapter implements GraphAdapter {
  private options: RestAdapterOptions;
  private fetchImpl: typeof fetch;

  constructor(options: RestAdapterOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private url(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): string {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path}`, globalThis.location?.href ?? 'http://localhost');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(
      this.url(path, params as Record<string, string | number | boolean | undefined>),
      {
        signal,
        headers: { Accept: 'application/json', ...(this.options.headers ?? {}) },
      },
    );
    if (!response.ok) {
      throw new Error(`[kg3d] ${path} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  async load(signal?: AbortSignal): Promise<GraphData> {
    return this.request<GraphData>(
      `/graphs/${encodeURIComponent(this.options.graphId)}`,
      {
        layout: this.options.serverLayout ? 'force3d' : undefined,
        metrics: this.options.withMetrics ?? true,
        limit: this.options.limit,
      },
      signal,
    );
  }

  async neighborhood(q: NeighborhoodQuery, signal?: AbortSignal): Promise<GraphData> {
    return this.request<GraphData>(
      `/graphs/${encodeURIComponent(this.options.graphId)}/neighborhood`,
      {
        node_id: q.nodeId,
        depth: q.depth ?? 1,
        limit: q.limit ?? 250,
        edge_types: q.edgeTypes?.join(','),
      },
      signal,
    );
  }

  async search(query: string, signal?: AbortSignal): Promise<GraphNode[]> {
    const result = await this.request<{ nodes: GraphNode[] }>(
      `/graphs/${encodeURIComponent(this.options.graphId)}/search`,
      { q: query, limit: 25 },
      signal,
    );
    return result.nodes;
  }

  async path(from: NodeId, to: NodeId, signal?: AbortSignal): Promise<NodeId[]> {
    const result = await this.request<{ path: NodeId[] }>(
      `/graphs/${encodeURIComponent(this.options.graphId)}/path`,
      { from, to },
      signal,
    );
    return result.path;
  }
}
