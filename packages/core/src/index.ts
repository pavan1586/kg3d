/**
 * @kg3d/core — a framework-agnostic 3D interactive knowledge graph engine.
 *
 * Quick start:
 * ```ts
 * import { KnowledgeGraph3D } from '@kg3d/core';
 *
 * const graph = new KnowledgeGraph3D(document.getElementById('app')!, {
 *   data: { nodes, edges },
 *   colorBy: { by: 'community' },
 *   sizeBy: { by: 'metric', metric: 'pagerank' },
 * });
 *
 * graph.on('nodeClick', ({ node }) => console.log(node.id));
 * ```
 */

export { KnowledgeGraph3D } from './KnowledgeGraph3D.js';

export { GraphModel } from './graph/GraphModel.js';
export type { EdgeRecord } from './graph/GraphModel.js';
export {
  computeMetrics,
  computePagerank,
  computeClustering,
  computeBetweennessAndCloseness,
  detectCommunities,
  modularityOf,
  estimateDiameter,
  summarize,
  metricsForNode,
} from './graph/metrics.js';
export type { MetricsResult } from './graph/metrics.js';

export { ForceSimulation } from './layout/forceLayout.js';
export type { ForceGraph } from './layout/forceLayout.js';
export { LayoutController } from './layout/LayoutController.js';
export { applyPreset, autoRadius, pickMostCentral } from './layout/presets.js';

export { Stage } from './render/Stage.js';
export { NodeLayer } from './render/NodeLayer.js';
export { EdgeLayer } from './render/EdgeLayer.js';
export { LabelLayer } from './render/LabelLayer.js';
export { Environment } from './render/Environment.js';
export { Picker } from './render/Picker.js';
export { OrbitControls } from './controls/OrbitControls.js';

export { StaticAdapter } from './adapters/StaticAdapter.js';
export { RestAdapter } from './adapters/RestAdapter.js';
export type { RestAdapterOptions } from './adapters/RestAdapter.js';
export { WebSocketAdapter } from './adapters/WebSocketAdapter.js';
export type { WebSocketAdapterOptions } from './adapters/WebSocketAdapter.js';

export {
  THEMES,
  resolveTheme,
  isLightTheme,
  METRIC_SCHEME_DARK,
  METRIC_SCHEME_LIGHT,
} from './theme/themes.js';
export { buildLegend, computeColors, computeRadii, metricValues } from './state/encodings.js';
export type { LegendEntry } from './state/encodings.js';
export { Hud, HUD_CSS } from './ui/Hud.js';

export {
  DEFAULT_CAMERA,
  DEFAULT_FORCE,
  DEFAULT_HUD,
  DEFAULT_INTERACTION,
  DEFAULT_LABELS,
  DEFAULT_RENDER,
} from './constants.js';

export { EventEmitter } from './util/EventEmitter.js';
export { parseColor, toHex, mix, sampleScheme, paletteFor, luminance } from './util/color.js';
export {
  clamp,
  lerp,
  easeInOutCubic,
  easeOutCubic,
  mulberry32,
  fibonacciSphere,
  normalize,
} from './util/math.js';

export type {
  CameraOptions,
  ColorEncoding,
  EventName,
  ForceLayoutOptions,
  GraphAdapter,
  GraphData,
  GraphEdge,
  GraphInsights,
  GraphNode,
  GraphPatch,
  HudOptions,
  InteractionOptions,
  KnowledgeGraphEvents,
  KnowledgeGraphOptions,
  LabelOptions,
  LayoutName,
  MetricName,
  NeighborhoodQuery,
  NodeEventPayload,
  NodeId,
  NodeMetrics,
  RenderOptions,
  SizeEncoding,
  Theme,
  ThemeName,
} from './types.js';
