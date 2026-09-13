import type { GraphAdapter, GraphData, GraphPatch } from '../types.js';

export interface WebSocketAdapterOptions {
  url: string;
  /** Adapter that provides the initial snapshot. */
  base: GraphAdapter;
  /** Reconnect backoff ceiling, ms. */
  maxBackoffMs?: number;
  protocols?: string | string[];
}

/**
 * Layers a live update stream on top of any snapshot adapter.
 *
 * Reconnects with exponential backoff and re-emits the snapshot on reconnect,
 * because a socket that has been down for a minute cannot be trusted to have
 * delivered every patch.
 */
export class WebSocketAdapter implements GraphAdapter {
  private socket: WebSocket | null = null;
  private handlers = new Set<(patch: GraphPatch) => void>();
  private backoff = 500;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: WebSocketAdapterOptions) {}

  load(signal?: AbortSignal): Promise<GraphData> {
    return this.options.base.load(signal);
  }

  neighborhood: GraphAdapter['neighborhood'] = (q, signal) =>
    this.options.base.neighborhood
      ? this.options.base.neighborhood(q, signal)
      : Promise.resolve({ nodes: [], edges: [] });

  search: GraphAdapter['search'] = (query, signal) =>
    this.options.base.search ? this.options.base.search(query, signal) : Promise.resolve([]);

  path: GraphAdapter['path'] = (from, to, signal) =>
    this.options.base.path ? this.options.base.path(from, to, signal) : Promise.resolve([]);

  subscribe(handler: (patch: GraphPatch) => void): () => void {
    this.handlers.add(handler);
    if (!this.socket) this.connect();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.disconnect();
    };
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.socket = new WebSocket(this.options.url, this.options.protocols);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.backoff = 500;
    };
    this.socket.onmessage = (event) => {
      try {
        const patch = JSON.parse(event.data as string) as GraphPatch;
        for (const handler of this.handlers) handler(patch);
      } catch (err) {
        console.warn('[kg3d] dropped malformed patch', err);
      }
    };
    this.socket.onclose = () => {
      this.socket = null;
      if (this.handlers.size > 0) this.scheduleReconnect();
    };
    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.backoff, this.options.maxBackoffMs ?? 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 15000);
      this.connect();
    }, delay);
  }

  private disconnect(): void {
    this.socket?.close();
    this.socket = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  dispose(): void {
    this.closed = true;
    this.handlers.clear();
    this.disconnect();
    this.options.base.dispose?.();
  }
}
