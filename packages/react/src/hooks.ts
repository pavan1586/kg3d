import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeGraph3D } from '@kg3d/core';
import type { GraphInsights, GraphNode, NodeId, NodeMetrics } from '@kg3d/core';

/** Live insights for a graph instance, refreshed whenever the data changes. */
export function useGraphInsights(graph: KnowledgeGraph3D | null): GraphInsights | null {
  const [insights, setInsights] = useState<GraphInsights | null>(null);
  useEffect(() => {
    if (!graph) return;
    setInsights(graph.getInsights());
    const off = graph.on('dataChange', () => setInsights(graph.getInsights()));
    return off;
  }, [graph]);
  return insights;
}

/** Current selection as node records. */
export function useGraphSelection(graph: KnowledgeGraph3D | null): {
  selected: GraphNode[];
  select: (ids: NodeId[]) => void;
  clear: () => void;
} {
  const [selected, setSelected] = useState<GraphNode[]>([]);
  useEffect(() => {
    if (!graph) return;
    const off = graph.on('selectionChange', () => setSelected(graph.selectedNodes()));
    return off;
  }, [graph]);

  const select = useCallback((ids: NodeId[]) => graph?.select(ids), [graph]);
  const clear = useCallback(() => graph?.clearSelection(), [graph]);
  return { selected, select, clear };
}

/** Hovered node, throttled to render only on change. */
export function useGraphHover(graph: KnowledgeGraph3D | null): GraphNode | null {
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  useEffect(() => {
    if (!graph) return;
    return graph.on('nodeHover', ({ node }) => setHovered(node));
  }, [graph]);
  return hovered;
}

/** Debounced search against the engine (adapter-backed when one is attached). */
export function useGraphSearch(
  graph: KnowledgeGraph3D | null,
  delayMs = 140,
): {
  query: string;
  setQuery: (value: string) => void;
  results: GraphNode[];
  loading: boolean;
} {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!graph) return;
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    timer.current = setTimeout(async () => {
      const found = await graph.search(query);
      // Ignore responses that arrive out of order.
      if (id === requestId.current) {
        setResults(found);
        setLoading(false);
      }
    }, delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [graph, query, delayMs]);

  return { query, setQuery, results, loading };
}

/** Metrics for one node, recomputed when the graph changes. */
export function useNodeMetrics(
  graph: KnowledgeGraph3D | null,
  id: NodeId | null,
): NodeMetrics | null {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!graph) return;
    return graph.on('dataChange', () => setVersion((v) => v + 1));
  }, [graph]);
  return useMemo(() => (graph && id ? graph.getNodeMetrics(id) : null), [graph, id, version]);
}

/** Layout progress, useful for a loading bar on large graphs. */
export function useLayoutProgress(graph: KnowledgeGraph3D | null): {
  running: boolean;
  iteration: number;
  alpha: number;
} {
  const [state, setState] = useState({ running: false, iteration: 0, alpha: 0 });
  useEffect(() => {
    if (!graph) return;
    const offs = [
      graph.on('layoutStart', () => setState({ running: true, iteration: 0, alpha: 1 })),
      graph.on('layoutTick', ({ iteration, alpha }) =>
        setState({ running: true, iteration, alpha }),
      ),
      graph.on('layoutEnd', ({ iterations }) =>
        setState({ running: false, iteration: iterations, alpha: 0 }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [graph]);
  return state;
}
