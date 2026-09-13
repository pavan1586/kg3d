/**
 * Public type surface for @kg3d/core.
 *
 * Everything the host application touches is declared here. The engine never
 * mutates the objects a caller passes in; it copies what it needs into typed
 * arrays and keeps the original records available for inspector panels.
 */

export type NodeId = string;

/** A single entity in the knowledge graph. */
export interface GraphNode {
  /** Stable unique identifier. Required. */
  id: NodeId;
  /** Human readable name shown in labels, search and the inspector. */
  label?: string;
  /**
   * Semantic class of the entity ("Person", "System", "Concept" ...).
   * Drives default colouring and legend grouping.
   */
  type?: string;
  /** Optional explicit community/cluster id. Computed if omitted. */
  group?: string | number;
  /** Arbitrary importance signal used by size/colour encodings. */
  weight?: number;
  /** Explicit radius override in world units. */
  size?: number;
  /** Explicit colour override (#rrggbb or css colour). */
  color?: string;
  /** Depth in a hierarchy, used by hierarchical / radial layouts. */
  level?: number;
  /** Seed or persisted position. */
  x?: number;
  y?: number;
  z?: number;
  /** Pinned position — layout will not move the node on this axis. */
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  /** Anything else you want to show in the inspector. */
  meta?: Record<string, unknown>;
}

/** A directed or undirected relationship. */
export interface GraphEdge {
  /** Stable id. Generated as `${source}->${target}` when omitted. */
  id?: string;
  source: NodeId;
  target: NodeId;
  label?: string;
  /** Semantic class of the relation ("depends_on", "authored" ...). */
  type?: string;
  /** Strength: pulls harder in the layout and renders thicker. */
  weight?: number;
  /** Defaults to the graph-level `directed` option. */
  directed?: boolean;
  color?: string;
  meta?: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* ------------------------------------------------------------------ theme */

export interface Theme {
  name: string;
  /** Deep background colour. */
  background: string;
  /** Secondary background used for the depth gradient / fog. */
  backgroundDeep: string;
  fogNear: number;
  fogFar: number;
  /** Ordered categorical palette. Node types map onto this in order. */
  palette: string[];
  nodeDefault: string;
  edgeColor: string;
  edgeHighlight: string;
  labelColor: string;
  labelHaloColor: string;
  selectionColor: string;
  hoverColor: string;
  gridColor: string;
  /** 0 disables the ambient star/dust field. */
  ambientParticles: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
}

export type ThemeName = 'obsidian' | 'nebula' | 'daylight' | 'slate';

/* ----------------------------------------------------------------- layout */

export type LayoutName = 'force' | 'sphere' | 'radial' | 'hierarchy' | 'grid' | 'cluster';

export interface ForceLayoutOptions {
  /** Repulsion between every pair of nodes (Barnes-Hut approximated). */
  charge: number;
  /** Ideal edge length in world units. */
  linkDistance: number;
  /** Spring constant for edges, 0..1. */
  linkStrength: number;
  /** Pull toward the origin, keeps the graph framed. */
  gravity: number;
  /** Velocity retained per tick, 0..1. */
  damping: number;
  /** Barnes-Hut opening angle. Higher = faster, less accurate. */
  theta: number;
  /** Extra attraction between members of the same community. */
  clusterStrength: number;
  /** Simulation stops below this average kinetic energy. */
  alphaMin: number;
  /** Hard cap on iterations. */
  maxIterations: number;
  /** Run the simulation in a Web Worker (recommended). */
  useWorker: boolean;
  /** Constrain the layout to a plane (2.5D mode). */
  dimensions: 2 | 3;
}

/* -------------------------------------------------------------- rendering */

export interface RenderOptions {
  /** Radius applied to a node of weight 1. */
  nodeBaseSize: number;
  /** Node radius is baseSize * (weight ** nodeSizeExponent). */
  nodeSizeExponent: number;
  minNodeSize: number;
  maxNodeSize: number;
  edgeOpacity: number;
  edgeWidth: number;
  /** Curve edges into arcs; 0 = straight lines. */
  edgeCurvature: number;
  /** Animate light pulses travelling along highlighted edges. */
  edgeFlow: boolean;
  /** Render the additive halo behind each node. */
  glow: boolean;
  /** Enable the bloom composer. Costs ~1.5ms/frame at 1080p. */
  bloom: boolean;
  /** Cap device pixel ratio; 2 is plenty on retina displays. */
  maxPixelRatio: number;
  /** Draw the ground reference grid. */
  grid: boolean;
  /** Fade distant nodes into the background. */
  depthFade: boolean;
  /** Stop rendering when nothing has changed. Saves battery. */
  renderOnDemand: boolean;
}

export interface LabelOptions {
  enabled: boolean;
  /** Never draw more than this many labels in one frame. */
  maxVisible: number;
  /** Only label nodes whose screen radius exceeds this (px). */
  minScreenSize: number;
  fontFamily: string;
  fontSize: number;
  /** Hide labels that would overlap an already placed label. */
  declutter: boolean;
  /** Always show labels for selected / hovered / pinned nodes. */
  alwaysShowFocused: boolean;
}

/* ------------------------------------------------------------ interaction */

export interface InteractionOptions {
  enableHover: boolean;
  enableClick: boolean;
  enableDrag: boolean;
  /** Dim everything that is not in the neighbourhood of the focus node. */
  focusDimming: boolean;
  /** Hops of neighbourhood kept bright when focusing. */
  focusDepth: number;
  /** Slowly orbit the camera when the user is idle. */
  idleOrbit: boolean;
  idleOrbitDelayMs: number;
  idleOrbitSpeed: number;
  /** Double click behaviour. */
  doubleClickAction: 'focus' | 'expand' | 'none';
}

export interface CameraOptions {
  fov: number;
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
  /** Inertia applied to orbit/pan, 0..1. */
  damping: number;
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  /** Duration of programmatic camera flights, ms. */
  flightDurationMs: number;
}

/* ------------------------------------------------------------- encodings */

export type ColorEncoding =
  | { by: 'type' }
  | { by: 'community' }
  | { by: 'metric'; metric: MetricName; scheme?: string[] }
  | { by: 'constant'; color: string }
  | { by: 'custom'; fn: (node: GraphNode) => string };

export type SizeEncoding =
  | { by: 'weight' }
  | { by: 'degree' }
  | { by: 'metric'; metric: MetricName }
  | { by: 'constant' }
  | { by: 'custom'; fn: (node: GraphNode) => number };

export type MetricName =
  | 'degree'
  | 'inDegree'
  | 'outDegree'
  | 'pagerank'
  | 'betweenness'
  | 'closeness'
  | 'clustering'
  | 'community';

/* ------------------------------------------------------------- top level */

export interface KnowledgeGraphOptions {
  data?: GraphData;
  adapter?: GraphAdapter;
  theme?: ThemeName | Partial<Theme>;
  layout?: LayoutName;
  directed?: boolean;
  force?: Partial<ForceLayoutOptions>;
  rendering?: Partial<RenderOptions>;
  labels?: Partial<LabelOptions>;
  interaction?: Partial<InteractionOptions>;
  camera?: Partial<CameraOptions>;
  colorBy?: ColorEncoding;
  sizeBy?: SizeEncoding;
  /** Compute centrality/community metrics on load. */
  computeMetrics?: boolean;
  /** Render the built-in HUD (search, legend, inspector, stats). */
  hud?: boolean | Partial<HudOptions>;
}

export interface HudOptions {
  search: boolean;
  legend: boolean;
  inspector: boolean;
  stats: boolean;
  controls: boolean;
  insights: boolean;
}

/* --------------------------------------------------------------- adapters */

export interface NeighborhoodQuery {
  nodeId: NodeId;
  depth?: number;
  limit?: number;
  edgeTypes?: string[];
}

/**
 * Data source contract. Implement this to stream any backend into the engine.
 * `RestAdapter` speaks the bundled FastAPI service; `StaticAdapter` wraps an
 * in-memory object; `WebSocketAdapter` layers live updates on top of either.
 */
export interface GraphAdapter {
  /** Initial payload. May be a sampled top-level view of a huge graph. */
  load(signal?: AbortSignal): Promise<GraphData>;
  /** Lazily expand a node. Optional — enables progressive exploration. */
  neighborhood?(q: NeighborhoodQuery, signal?: AbortSignal): Promise<GraphData>;
  /** Server-side search. Falls back to client-side matching when absent. */
  search?(query: string, signal?: AbortSignal): Promise<GraphNode[]>;
  /** Shortest path between two nodes. */
  path?(from: NodeId, to: NodeId, signal?: AbortSignal): Promise<NodeId[]>;
  /** Subscribe to live mutations. Return an unsubscribe function. */
  subscribe?(handler: (patch: GraphPatch) => void): () => void;
  dispose?(): void;
}

export interface GraphPatch {
  addNodes?: GraphNode[];
  addEdges?: GraphEdge[];
  removeNodes?: NodeId[];
  removeEdges?: string[];
  updateNodes?: Array<Partial<GraphNode> & { id: NodeId }>;
}

/* ----------------------------------------------------------------- events */

export interface NodeEventPayload {
  node: GraphNode;
  index: number;
  event: PointerEvent | MouseEvent;
  screen: { x: number; y: number };
}

export interface KnowledgeGraphEvents {
  ready: { nodeCount: number; edgeCount: number };
  nodeHover: { node: GraphNode | null };
  nodeClick: NodeEventPayload;
  nodeDoubleClick: NodeEventPayload;
  backgroundClick: { event: PointerEvent | MouseEvent };
  selectionChange: { selected: NodeId[] };
  layoutStart: { layout: LayoutName };
  layoutTick: { iteration: number; alpha: number };
  layoutEnd: { iterations: number; durationMs: number };
  dataChange: { nodeCount: number; edgeCount: number };
  cameraChange: { distance: number };
  error: { error: Error; context: string };
}

export type EventName = keyof KnowledgeGraphEvents;

/** Per-node analytics produced by `graph/metrics`. */
export interface NodeMetrics {
  degree: number;
  inDegree: number;
  outDegree: number;
  pagerank: number;
  betweenness: number;
  closeness: number;
  clustering: number;
  community: number;
}

export interface GraphInsights {
  nodeCount: number;
  edgeCount: number;
  density: number;
  averageDegree: number;
  components: number;
  communities: number;
  modularity: number;
  diameterEstimate: number;
  /** Highest pagerank nodes — the "who matters" answer. */
  hubs: Array<{ id: NodeId; label: string; score: number }>;
  /** Highest betweenness nodes — the "what breaks if this goes" answer. */
  bridges: Array<{ id: NodeId; label: string; score: number }>;
  /** Nodes with no edges. */
  isolated: NodeId[];
  /** Community summary. */
  clusters: Array<{
    id: number;
    size: number;
    label: string;
    internalDensity: number;
    representative: NodeId;
  }>;
}
