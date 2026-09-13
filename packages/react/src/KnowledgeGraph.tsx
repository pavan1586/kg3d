import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { KnowledgeGraph3D } from '@kg3d/core';
import type {
  ColorEncoding,
  GraphData,
  GraphInsights,
  GraphNode,
  KnowledgeGraphOptions,
  LayoutName,
  NodeId,
  SizeEncoding,
  ThemeName,
} from '@kg3d/core';

export interface KnowledgeGraphProps extends Omit<
  KnowledgeGraphOptions,
  'data' | 'theme' | 'layout' | 'colorBy' | 'sizeBy'
> {
  data?: GraphData;
  theme?: ThemeName;
  layout?: LayoutName;
  colorBy?: ColorEncoding;
  sizeBy?: SizeEncoding;
  /** Controlled selection. */
  selected?: NodeId[];
  /** Focus a node — flies the camera and dims the rest of the graph. */
  focusId?: NodeId | null;
  className?: string;
  style?: CSSProperties;
  onReady?: (graph: KnowledgeGraph3D) => void;
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null) => void;
  onSelectionChange?: (ids: NodeId[]) => void;
  onInsights?: (insights: GraphInsights | null) => void;
  onError?: (error: Error, context: string) => void;
}

export interface KnowledgeGraphHandle {
  /** Escape hatch to the imperative engine. */
  readonly graph: KnowledgeGraph3D | null;
  focus(id: NodeId): void;
  frameAll(): void;
  showPath(from: NodeId, to: NodeId): NodeId[] | null;
  search(query: string): Promise<GraphNode[]>;
  toDataURL(): string | null;
}

const containerStyle: CSSProperties = { width: '100%', height: '100%', position: 'relative' };

/**
 * Declarative wrapper around the engine.
 *
 * The engine is created once and then *updated* from props — recreating a WebGL
 * context on every render would be both slow and visually jarring, so prop
 * changes map onto the imperative API instead of a remount. Only `data` is
 * treated as identity: pass a new object when the graph genuinely changed.
 */
export const KnowledgeGraph = forwardRef<KnowledgeGraphHandle, KnowledgeGraphProps>(
  function KnowledgeGraph(props, ref) {
    const {
      data,
      theme,
      layout,
      colorBy,
      sizeBy,
      selected,
      focusId,
      className,
      style,
      onReady,
      onNodeClick,
      onNodeHover,
      onSelectionChange,
      onInsights,
      onError,
      ...engineOptions
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const graphRef = useRef<KnowledgeGraph3D | null>(null);
    const [, forceUpdate] = useState(0);

    // Latest-callback refs keep the engine's listeners stable across renders
    // without re-subscribing on every parent re-render.
    const handlers = useRef({ onNodeClick, onNodeHover, onSelectionChange, onInsights, onError });
    handlers.current = { onNodeClick, onNodeHover, onSelectionChange, onInsights, onError };

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const graph = new KnowledgeGraph3D(container, {
        ...engineOptions,
        data,
        theme,
        layout,
        colorBy,
        sizeBy,
      });
      graphRef.current = graph;
      forceUpdate((n) => n + 1);

      const offs = [
        graph.on('nodeClick', ({ node }) => handlers.current.onNodeClick?.(node)),
        graph.on('nodeHover', ({ node }) => handlers.current.onNodeHover?.(node)),
        graph.on('selectionChange', ({ selected: ids }) =>
          handlers.current.onSelectionChange?.(ids),
        ),
        graph.on('ready', () => handlers.current.onInsights?.(graph.getInsights())),
        graph.on('dataChange', () => handlers.current.onInsights?.(graph.getInsights())),
        graph.on('error', ({ error, context }) => handlers.current.onError?.(error, context)),
      ];

      onReady?.(graph);

      return () => {
        for (const off of offs) off();
        graph.dispose();
        graphRef.current = null;
      };
      // The engine is intentionally created once; prop changes are applied by
      // the effects below rather than by tearing down the WebGL context.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (data && graphRef.current) graphRef.current.setData(data);
    }, [data]);

    useEffect(() => {
      if (theme && graphRef.current) graphRef.current.setTheme(theme);
    }, [theme]);

    useEffect(() => {
      if (layout && graphRef.current) graphRef.current.setLayout(layout);
    }, [layout]);

    useEffect(() => {
      if (colorBy && graphRef.current) graphRef.current.setColorBy(colorBy);
    }, [colorBy]);

    useEffect(() => {
      if (sizeBy && graphRef.current) graphRef.current.setSizeBy(sizeBy);
    }, [sizeBy]);

    useEffect(() => {
      if (selected && graphRef.current) graphRef.current.select(selected);
    }, [selected]);

    useEffect(() => {
      if (!graphRef.current) return;
      if (focusId) graphRef.current.focus(focusId);
      else graphRef.current.clearFocus();
    }, [focusId]);

    useImperativeHandle(
      ref,
      (): KnowledgeGraphHandle => ({
        get graph() {
          return graphRef.current;
        },
        focus: (id) => graphRef.current?.focus(id),
        frameAll: () => graphRef.current?.frameAll(),
        showPath: (from, to) => graphRef.current?.showPath(from, to) ?? null,
        search: async (query) => (await graphRef.current?.search(query)) ?? [],
        toDataURL: () => graphRef.current?.toDataURL() ?? null,
      }),
      [],
    );

    const mergedStyle = useCallback(() => ({ ...containerStyle, ...style }), [style]);

    return <div ref={containerRef} className={className} style={mergedStyle()} />;
  },
);
