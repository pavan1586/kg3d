export { KnowledgeGraph } from './KnowledgeGraph.js';
export type { KnowledgeGraphProps, KnowledgeGraphHandle } from './KnowledgeGraph.js';
export {
  useGraphInsights,
  useGraphSelection,
  useGraphHover,
  useGraphSearch,
  useNodeMetrics,
  useLayoutProgress,
} from './hooks.js';

// Re-export the engine surface so consumers need a single dependency.
export * from '@kg3d/core';
