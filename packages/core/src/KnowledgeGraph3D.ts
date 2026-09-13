import * as THREE from 'three';
import {
  DEFAULT_CAMERA,
  DEFAULT_FORCE,
  DEFAULT_HUD,
  DEFAULT_INTERACTION,
  DEFAULT_LABELS,
  DEFAULT_RENDER,
  DIM_FACTOR,
} from './constants.js';
import { GraphModel } from './graph/GraphModel.js';
import {
  computeMetrics,
  metricsForNode,
  modularityOf,
  summarize,
  type MetricsResult,
} from './graph/metrics.js';
import { LayoutController } from './layout/LayoutController.js';
import { OrbitControls } from './controls/OrbitControls.js';
import { EdgeLayer } from './render/EdgeLayer.js';
import { Environment } from './render/Environment.js';
import { LabelLayer } from './render/LabelLayer.js';
import { NodeLayer } from './render/NodeLayer.js';
import { Picker } from './render/Picker.js';
import { Stage } from './render/Stage.js';
import { buildLegend, computeColors, computeRadii, type LegendEntry } from './state/encodings.js';
import { resolveTheme } from './theme/themes.js';
import { Hud } from './ui/Hud.js';
import type {
  ColorEncoding,
  EventName,
  ForceLayoutOptions,
  GraphAdapter,
  GraphData,
  GraphInsights,
  GraphNode,
  GraphPatch,
  HudOptions,
  InteractionOptions,
  KnowledgeGraphEvents,
  KnowledgeGraphOptions,
  LabelOptions,
  LayoutName,
  NodeId,
  NodeMetrics,
  RenderOptions,
  SizeEncoding,
  Theme,
  ThemeName,
} from './types.js';
import { EventEmitter } from './util/EventEmitter.js';

/**
 * The engine.
 *
 * Responsibilities are split deliberately: `GraphModel` knows topology,
 * `LayoutController` owns positions, the render layers own GPU buffers, and this
 * class is the only thing that knows about all of them. Host applications talk
 * to this class and nothing else.
 */
export class KnowledgeGraph3D {
  readonly container: HTMLElement;

  private model: GraphModel;
  private stage: Stage;
  private nodeLayer!: NodeLayer;
  private edgeLayer!: EdgeLayer;
  private labelLayer: LabelLayer;
  private environment: Environment;
  private picker!: Picker;
  private controls: OrbitControls;
  private layoutController!: LayoutController;
  private hud: Hud | null = null;

  private emitter = new EventEmitter<KnowledgeGraphEvents>();
  private theme: Theme;
  private renderOptions: RenderOptions;
  private labelOptions: LabelOptions;
  private interactionOptions: InteractionOptions;
  private forceOptions: ForceLayoutOptions;
  private hudOptions: HudOptions;
  private colorEncoding: ColorEncoding;
  private sizeEncoding: SizeEncoding;
  private adapter: GraphAdapter | null;

  private metrics: MetricsResult | null = null;
  private insights: GraphInsights | null = null;
  private radii: Float32Array = new Float32Array(0);
  private colors: Float32Array = new Float32Array(0);
  private typeOrder: string[] = [];

  private hoveredIndex = -1;
  private selected = new Set<number>();
  private focusSet: Set<number> | null = null;
  private highlightedPath: number[] = [];
  private filterMask: Uint8Array = new Uint8Array(0);
  private hasFilter = false;

  private dragging = false;
  private dragIndex = -1;
  private dragPlane = new THREE.Plane();
  private dragOffset = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private lastPointerScreen = { x: 0, y: 0 };
  private pointerDownAt = { x: 0, y: 0, time: 0 };
  private lastClickTime = 0;

  private unsubscribeAdapter: (() => void) | null = null;
  private disposed = false;
  private statesDirty = true;

  constructor(container: HTMLElement, options: KnowledgeGraphOptions = {}) {
    this.container = container;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.classList.add('kg3d-root');

    this.theme = resolveTheme(options.theme);
    this.renderOptions = { ...DEFAULT_RENDER, ...options.rendering };
    this.labelOptions = { ...DEFAULT_LABELS, ...options.labels };
    this.interactionOptions = { ...DEFAULT_INTERACTION, ...options.interaction };
    this.forceOptions = { ...DEFAULT_FORCE, ...options.force };
    this.hudOptions =
      options.hud === false
        ? {
            search: false,
            legend: false,
            inspector: false,
            stats: false,
            controls: false,
            insights: false,
          }
        : { ...DEFAULT_HUD, ...(typeof options.hud === 'object' ? options.hud : {}) };
    this.colorEncoding = options.colorBy ?? { by: 'type' };
    this.sizeEncoding = options.sizeBy ?? { by: 'weight' };
    this.adapter = options.adapter ?? null;

    const cameraOptions = { ...DEFAULT_CAMERA, ...options.camera };
    this.model = new GraphModel(options.data, options.directed ?? false);
    this.autoTuneForce(options);

    this.stage = new Stage(container, this.theme, this.renderOptions, cameraOptions);
    this.environment = new Environment(this.theme, this.renderOptions.grid);
    this.stage.scene.add(this.environment.group);

    this.labelLayer = new LabelLayer(container, this.theme, this.labelOptions);
    this.controls = new OrbitControls(this.stage.camera, this.stage.canvas, cameraOptions);
    this.controls.setChangeHandler(() => {
      this.stage.invalidate();
      this.emitter.emit('cameraChange', { distance: this.controls.distance });
    });

    // The scene is built before the HUD because the HUD reads live state from
    // the engine (current layout, encodings, insights) to render itself.
    this.buildScene(options.computeMetrics ?? true);

    if (options.hud !== false) {
      this.hud = new Hud(container, this, this.hudOptions, this.theme);
    }

    this.bindPointerEvents();
    this.stage.onFrame((dt, elapsed) => this.onFrame(dt, elapsed));
    this.stage.start();

    if (this.adapter) void this.loadFromAdapter();
    else this.emitReady();
  }

  /**
   * Scale the force defaults to the graph.
   *
   * Barnes-Hut cost per tick grows with both node count and accuracy, and past
   * ~20k nodes the accurate settings stop paying for themselves: a wider
   * opening angle and fewer iterations give a layout that looks the same and
   * settles in a quarter of the time. Anything the caller set explicitly is
   * left alone.
   */
  private autoTuneForce(options: KnowledgeGraphOptions): void {
    const n = this.model.nodeCount;
    if (n <= 20000) return;
    const provided = options.force ?? {};
    if (provided.theta === undefined) this.forceOptions.theta = n > 40000 ? 1.35 : 1.15;
    if (provided.maxIterations === undefined) this.forceOptions.maxIterations = 420;
    if (provided.alphaMin === undefined) this.forceOptions.alphaMin = 0.008;
  }

  /* ------------------------------------------------------------ lifecycle */

  private buildScene(computeMetricsNow: boolean): void {
    this.typeOrder = this.model.types();
    this.filterMask = new Uint8Array(this.model.nodeCount).fill(1);

    if (computeMetricsNow && this.model.nodeCount > 0) {
      // If the backend already computed analytics (the kg3d service folds them
      // into node.meta), adopt those instead of recomputing. They are exact
      // where ours are approximate, they are consistent across every viewer,
      // and skipping the recompute saves seconds on a large graph.
      this.metrics = this.adoptServerMetrics() ?? computeMetrics(this.model);
      this.insights = summarize(this.model, this.metrics);
    }

    this.nodeLayer = new NodeLayer(
      Math.max(1, this.model.nodeCount),
      this.theme,
      this.renderOptions,
    );
    this.edgeLayer = new EdgeLayer(this.model.edges, this.theme, this.renderOptions);
    this.stage.scene.add(this.nodeLayer.group, this.edgeLayer.object);
    this.picker = new Picker(this.stage, this.nodeLayer);

    this.layoutController = new LayoutController(this.model, this.forceOptions, {
      onTick: (positions, iteration, alpha) => {
        this.applyPositions(positions);
        // Follow the graph while it settles so the first thing a viewer sees is
        // the structure forming, framed — not a cloud drifting out of shot.
        // The moment they touch the camera, or focus something, we stop.
        if (
          !this.controls.hasUserInteracted &&
          this.focusSet === null &&
          this.selected.size === 0 &&
          alpha > 0.05 &&
          iteration % 8 === 0
        ) {
          this.frameAll(420);
        }
        this.emitter.emit('layoutTick', { iteration, alpha });
      },
      onEnd: (iterations, durationMs) => {
        this.emitter.emit('layoutEnd', { iterations, durationMs });
        this.frameAll(0);
      },
    });
    this.layoutController.setCommunities(this.metrics?.community);

    this.refreshEncodings();
    this.layoutController.run('force');
    this.emitter.emit('layoutStart', { layout: 'force' });
    this.hud?.refresh();
  }

  /**
   * Read analytics out of `node.meta` when the backend supplied them.
   * Returns null when fewer than 80% of nodes carry them, so a partially
   * annotated graph falls back to a consistent client-side computation rather
   * than a mixture of the two.
   */
  private adoptServerMetrics(): MetricsResult | null {
    const n = this.model.nodeCount;
    let annotated = 0;
    for (const node of this.model.nodes) {
      const meta = node.meta;
      if (meta && typeof meta.pagerank === 'number' && typeof meta.community === 'number') {
        annotated++;
      }
    }
    if (annotated < n * 0.8) return null;

    const numeric = (value: unknown): number => (typeof value === 'number' ? value : 0);
    const degree = new Float64Array(n);
    const inDegree = new Float64Array(n);
    const outDegree = new Float64Array(n);
    const pagerank = new Float64Array(n);
    const betweenness = new Float64Array(n);
    const closeness = new Float64Array(n);
    const clustering = new Float64Array(n);
    const community = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const meta = (this.model.nodes[i].meta ?? {}) as Record<string, unknown>;
      degree[i] = numeric(meta.degree) || this.model.degreeOf(i);
      inDegree[i] = numeric(meta.in_degree) || degree[i];
      outDegree[i] = numeric(meta.out_degree) || degree[i];
      pagerank[i] = numeric(meta.pagerank);
      betweenness[i] = numeric(meta.betweenness);
      closeness[i] = numeric(meta.closeness);
      clustering[i] = numeric(meta.clustering);
      community[i] = numeric(meta.community);
    }

    return {
      degree,
      inDegree,
      outDegree,
      pagerank,
      betweenness,
      closeness,
      clustering,
      community,
      modularity: modularityOf(this.model, community),
    };
  }

  private async loadFromAdapter(): Promise<void> {
    if (!this.adapter) return;
    try {
      const data = await this.adapter.load();
      this.setData(data);
      if (this.adapter.subscribe) {
        this.unsubscribeAdapter = this.adapter.subscribe((patch) => this.applyPatch(patch));
      }
    } catch (error) {
      this.emitter.emit('error', { error: error as Error, context: 'adapter.load' });
    }
  }

  private emitReady(): void {
    this.emitter.emit('ready', {
      nodeCount: this.model.nodeCount,
      edgeCount: this.model.edgeCount,
    });
  }

  /* --------------------------------------------------------------- frame */

  private onFrame(dt: number, elapsed: number): void {
    this.controls.update(dt);
    this.environment.update(dt);
    this.nodeLayer.update(elapsed);
    this.edgeLayer.update(elapsed);

    if (
      this.interactionOptions.idleOrbit &&
      this.controls.idleMs > this.interactionOptions.idleOrbitDelayMs &&
      !this.dragging
    ) {
      this.controls.idleOrbit(this.interactionOptions.idleOrbitSpeed, dt);
      this.stage.invalidate();
    }

    if (this.statesDirty) {
      this.nodeLayer.markStates();
      this.edgeLayer.markHighlights();
      this.statesDirty = false;
    }

    this.labelLayer.render(
      this.stage,
      this.model.nodes,
      this.layoutController.positions,
      this.radii,
      this.focusedIndices(),
      this.focusSet,
    );

    this.hud?.tick(this.stage.fps);
  }

  private focusedIndices(): Set<number> {
    const set = new Set<number>(this.selected);
    if (this.hoveredIndex >= 0) set.add(this.hoveredIndex);
    for (const i of this.highlightedPath) set.add(i);
    return set;
  }

  private applyPositions(positions: Float32Array): void {
    this.nodeLayer.updatePositions(positions, this.hoveredIndex, this.selected);
    this.edgeLayer.updatePositions(positions);
    this.stage.invalidate();
  }

  /* ------------------------------------------------------------ encoding */

  private refreshEncodings(): void {
    this.colors = computeColors(
      this.model,
      this.colorEncoding,
      this.theme,
      this.metrics,
      this.typeOrder,
    );
    this.radii = computeRadii(this.model, this.sizeEncoding, this.renderOptions, this.metrics);
    this.nodeLayer.setColors(this.colors);
    this.nodeLayer.setRadii(this.radii);
    this.refreshStates();
    this.stage.invalidate();
  }

  /** Recompute per-instance emphasis/dim from selection, hover, focus, filter. */
  private refreshStates(): void {
    const n = this.model.nodeCount;
    const focused = this.focusedIndices();
    const dimEverythingElse = this.focusSet !== null || this.hasFilter;

    for (let i = 0; i < n; i++) {
      const visible = this.filterMask[i] === 1;
      const inFocus = this.focusSet === null || this.focusSet.has(i);
      const emphasis = focused.has(i) ? 1 : 0;
      let dim = 0;
      if (!visible) dim = 1;
      else if (dimEverythingElse && !inFocus && emphasis === 0) dim = 1 - DIM_FACTOR;
      this.nodeLayer.setState(i, emphasis, dim);
    }

    const pathEdges = this.pathEdgeSet();
    for (let e = 0; e < this.model.edges.length; e++) {
      const edge = this.model.edges[e];
      const endpointsVisible =
        this.filterMask[edge.sourceIndex] === 1 && this.filterMask[edge.targetIndex] === 1;
      const inFocus =
        this.focusSet === null ||
        (this.focusSet.has(edge.sourceIndex) && this.focusSet.has(edge.targetIndex));
      const highlighted =
        pathEdges.has(e) ||
        (this.hoveredIndex >= 0 &&
          (edge.sourceIndex === this.hoveredIndex || edge.targetIndex === this.hoveredIndex)) ||
        this.selected.has(edge.sourceIndex) ||
        this.selected.has(edge.targetIndex);

      this.edgeLayer.setEdgeHighlight(e, highlighted ? 1 : 0);
      let dim = 0;
      if (!endpointsVisible) dim = 1;
      else if ((dimEverythingElse && !inFocus) || (pathEdges.size > 0 && !pathEdges.has(e))) {
        dim = 1 - DIM_FACTOR;
      }
      this.edgeLayer.setEdgeDim(e, dim);
    }

    this.statesDirty = true;
    this.stage.invalidate();
  }

  private pathEdgeSet(): Set<number> {
    const set = new Set<number>();
    if (this.highlightedPath.length < 2) return set;
    const pairs = new Set<string>();
    for (let i = 0; i < this.highlightedPath.length - 1; i++) {
      const a = this.highlightedPath[i];
      const b = this.highlightedPath[i + 1];
      pairs.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
    }
    for (let e = 0; e < this.model.edges.length; e++) {
      const edge = this.model.edges[e];
      const key = `${Math.min(edge.sourceIndex, edge.targetIndex)}:${Math.max(edge.sourceIndex, edge.targetIndex)}`;
      if (pairs.has(key)) set.add(e);
    }
    return set;
  }

  /* ---------------------------------------------------------- interaction */

  private bindPointerEvents(): void {
    const canvas = this.stage.canvas;

    const toLocal = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
    };

    let hoverRaf = 0;
    const onPointerMove = (e: PointerEvent) => {
      const { x, y, rect } = toLocal(e);
      this.lastPointerScreen = { x, y };
      this.pointerNdc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);

      if (this.dragging && this.dragIndex >= 0) {
        this.dragNode();
        return;
      }
      if (!this.interactionOptions.enableHover) return;
      // Picking is cheap but not free; one pick per animation frame is plenty.
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (this.disposed) return;
        const index = this.picker.pick(x, y);
        this.setHovered(index);
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      const { x, y } = toLocal(e);
      this.pointerDownAt = { x, y, time: performance.now() };
      if (!this.interactionOptions.enableDrag || e.button !== 0) return;
      const index = this.picker.pick(x, y);
      if (index < 0) return;
      // Grabbing a node takes precedence over orbiting.
      this.controls.enabled = false;
      this.dragging = true;
      this.dragIndex = index;
      const position = this.positionOf(index);
      this.dragPlane.setFromNormalAndCoplanarPoint(
        this.stage.camera.getWorldDirection(new THREE.Vector3()).negate(),
        position,
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.stage.camera);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, hit)) {
        this.dragOffset.copy(position).sub(hit);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const { x, y } = toLocal(e);
      const movedDistance = Math.hypot(x - this.pointerDownAt.x, y - this.pointerDownAt.y);
      const wasDrag = this.dragging && movedDistance > 3;

      if (this.dragging) {
        this.dragging = false;
        this.controls.enabled = true;
        if (wasDrag && this.dragIndex >= 0) {
          // A dragged node stays where it was put — an explicit user statement
          // about layout that the simulation must respect.
          const p = this.positionOf(this.dragIndex);
          this.layoutController.pin(this.dragIndex, p.x, p.y, p.z, true);
        }
        this.dragIndex = -1;
      }

      if (movedDistance > 4 || !this.interactionOptions.enableClick) return;

      const index = this.picker.pick(x, y);
      const now = performance.now();
      const isDoubleClick = now - this.lastClickTime < 320;
      this.lastClickTime = now;

      if (index < 0) {
        this.emitter.emit('backgroundClick', { event: e });
        if (!e.shiftKey) this.clearSelection();
        return;
      }

      const node = this.model.nodes[index];
      const payload = { node, index, event: e, screen: { x, y } };

      if (isDoubleClick) {
        this.emitter.emit('nodeDoubleClick', payload);
        if (this.interactionOptions.doubleClickAction === 'focus') this.focus(node.id);
        else if (this.interactionOptions.doubleClickAction === 'expand') void this.expand(node.id);
        return;
      }

      this.emitter.emit('nodeClick', payload);
      if (e.shiftKey) this.toggleSelection(node.id);
      else this.select([node.id]);
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== canvas) return;
      if (e.key === 'Escape') this.clearFocus();
      if (e.key === 'f' && this.selected.size) {
        const first = Array.from(this.selected)[0];
        this.focus(this.model.nodes[first].id);
      }
      if (e.key === 'r') this.frameAll();
    };
    canvas.addEventListener('keydown', onKeyDown);

    this.cleanupPointer = () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('keydown', onKeyDown);
    };
  }

  private cleanupPointer: (() => void) | null = null;

  private dragNode(): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.stage.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;
    hit.add(this.dragOffset);
    this.layoutController.pin(this.dragIndex, hit.x, hit.y, hit.z, true);
    this.layoutController.reheat(0.25);
    this.applyPositions(this.layoutController.positions);
  }

  private setHovered(index: number): void {
    if (index === this.hoveredIndex) return;
    this.hoveredIndex = index;
    this.stage.canvas.style.cursor = index >= 0 ? 'pointer' : 'default';
    this.refreshStates();
    this.applyPositions(this.layoutController.positions);
    this.emitter.emit('nodeHover', { node: index >= 0 ? this.model.nodes[index] : null });
    this.hud?.setHovered(index >= 0 ? this.model.nodes[index] : null, this.lastPointerScreen);
  }

  private positionOf(index: number): THREE.Vector3 {
    const p = this.layoutController.positions;
    return new THREE.Vector3(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
  }

  /* ------------------------------------------------------------ public API */

  /** Replace the entire graph. */
  setData(data: GraphData): void {
    this.layoutController.dispose();
    this.stage.scene.remove(this.nodeLayer.group, this.edgeLayer.object);
    this.nodeLayer.dispose();
    this.edgeLayer.dispose();
    this.picker.dispose();

    this.model = new GraphModel(data, this.model.directed);
    this.selected.clear();
    this.hoveredIndex = -1;
    this.focusSet = null;
    this.highlightedPath = [];
    this.hasFilter = false;

    this.buildScene(true);
    this.emitter.emit('dataChange', {
      nodeCount: this.model.nodeCount,
      edgeCount: this.model.edgeCount,
    });
    this.emitReady();
  }

  /** Incremental update — the path live backends use. */
  applyPatch(patch: GraphPatch): void {
    const previousCount = this.model.nodeCount;
    this.model.applyPatch(patch);
    const grew = this.model.nodeCount !== previousCount;

    if (grew || patch.addEdges?.length || patch.removeEdges?.length) {
      // Topology changed: buffers are sized per node/edge count, so rebuild.
      const data = this.model.toJSON();
      const positions = this.layoutController.positions;
      // Preserve the layout we already have — a live patch should feel like the
      // graph grew, not like it was thrown away and redrawn.
      data.nodes.forEach((node, i) => {
        if (i * 3 + 2 < positions.length) {
          node.x = positions[i * 3];
          node.y = positions[i * 3 + 1];
          node.z = positions[i * 3 + 2];
        }
      });
      this.setData(data);
      this.layoutController.reheat(0.35);
    } else {
      this.refreshEncodings();
    }
    this.emitter.emit('dataChange', {
      nodeCount: this.model.nodeCount,
      edgeCount: this.model.edgeCount,
    });
  }

  /** Pull a node's neighbourhood from the adapter and merge it in. */
  async expand(nodeId: NodeId, depth = 1): Promise<void> {
    if (!this.adapter?.neighborhood) return;
    try {
      const data = await this.adapter.neighborhood({ nodeId, depth });
      this.applyPatch({ addNodes: data.nodes, addEdges: data.edges });
    } catch (error) {
      this.emitter.emit('error', { error: error as Error, context: 'adapter.neighborhood' });
    }
  }

  getData(): GraphData {
    return this.model.toJSON();
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.model.byId(id);
  }

  getNodeMetrics(id: NodeId): NodeMetrics | null {
    const i = this.model.indexOf(id);
    if (i < 0 || !this.metrics) return null;
    return metricsForNode(this.metrics, i);
  }

  getInsights(): GraphInsights | null {
    return this.insights;
  }

  getLegend(): LegendEntry[] {
    return buildLegend(this.model, this.colorEncoding, this.theme, this.metrics, this.typeOrder);
  }

  getNeighbors(id: NodeId): GraphNode[] {
    const i = this.model.indexOf(id);
    if (i < 0) return [];
    return Array.from(this.model.neighborsOf(i)).map((n) => this.model.nodes[n]);
  }

  /* ------------------------------------------------------------ selection */

  select(ids: NodeId[]): void {
    this.selected.clear();
    for (const id of ids) {
      const i = this.model.indexOf(id);
      if (i >= 0) this.selected.add(i);
    }
    this.refreshStates();
    this.applyPositions(this.layoutController.positions);
    this.emitter.emit('selectionChange', { selected: this.selectedIds() });
    this.hud?.setSelection(this.selectedNodes());
  }

  toggleSelection(id: NodeId): void {
    const i = this.model.indexOf(id);
    if (i < 0) return;
    if (this.selected.has(i)) this.selected.delete(i);
    else this.selected.add(i);
    this.refreshStates();
    this.applyPositions(this.layoutController.positions);
    this.emitter.emit('selectionChange', { selected: this.selectedIds() });
    this.hud?.setSelection(this.selectedNodes());
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.refreshStates();
    this.applyPositions(this.layoutController.positions);
    this.emitter.emit('selectionChange', { selected: [] });
    this.hud?.setSelection([]);
  }

  selectedIds(): NodeId[] {
    return Array.from(this.selected).map((i) => this.model.nodes[i].id);
  }

  selectedNodes(): GraphNode[] {
    return Array.from(this.selected).map((i) => this.model.nodes[i]);
  }

  /* --------------------------------------------------------------- focus */

  /**
   * Focus a node: fly the camera to it and dim everything outside its
   * neighbourhood. This is the single most useful interaction in the engine —
   * it turns "a hairball" into "this thing and what it touches".
   */
  focus(id: NodeId, depth = this.interactionOptions.focusDepth): void {
    const index = this.model.indexOf(id);
    if (index < 0) return;
    this.selected.clear();
    this.selected.add(index);

    if (this.interactionOptions.focusDimming) {
      this.focusSet = this.model.neighborhood(index, depth);
    }
    this.refreshStates();
    this.applyPositions(this.layoutController.positions);

    const center = this.positionOf(index);
    const members = this.focusSet ?? new Set([index]);
    let radius = this.radii[index] * 4;
    for (const i of members) {
      radius = Math.max(radius, center.distanceTo(this.positionOf(i)) + this.radii[i] * 2);
    }
    void this.controls.frame(center, Math.max(radius, this.radii[index] * 6));
    this.emitter.emit('selectionChange', { selected: this.selectedIds() });
    this.hud?.setSelection(this.selectedNodes());
  }

  clearFocus(): void {
    this.focusSet = null;
    this.highlightedPath = [];
    this.refreshStates();
  }

  /** Highlight the shortest path between two nodes and frame it. */
  showPath(fromId: NodeId, toId: NodeId): NodeId[] | null {
    const from = this.model.indexOf(fromId);
    const to = this.model.indexOf(toId);
    if (from < 0 || to < 0) return null;
    const path = this.model.shortestPath(from, to);
    if (!path) {
      this.highlightedPath = [];
      this.refreshStates();
      return null;
    }
    this.highlightedPath = path;
    this.focusSet = new Set(path);
    this.refreshStates();

    const center = new THREE.Vector3();
    for (const i of path) center.add(this.positionOf(i));
    center.divideScalar(path.length);
    let radius = 40;
    for (const i of path) radius = Math.max(radius, center.distanceTo(this.positionOf(i)));
    void this.controls.frame(center, radius * 1.2);

    return path.map((i) => this.model.nodes[i].id);
  }

  /** Client-side substring search, or the adapter's if it provides one. */
  async search(query: string): Promise<GraphNode[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (this.adapter?.search) {
      try {
        return await this.adapter.search(query);
      } catch (error) {
        this.emitter.emit('error', { error: error as Error, context: 'adapter.search' });
      }
    }
    const results: GraphNode[] = [];
    for (const node of this.model.nodes) {
      const haystack = `${node.label ?? ''} ${node.id} ${node.type ?? ''}`.toLowerCase();
      if (haystack.includes(q)) results.push(node);
      if (results.length >= 40) break;
    }
    return results;
  }

  /* --------------------------------------------------------------- views */

  setLayout(layout: LayoutName): void {
    const focusIndex = this.selected.size ? Array.from(this.selected)[0] : undefined;
    this.emitter.emit('layoutStart', { layout });
    this.layoutController.run(layout, focusIndex);
    this.hud?.refresh();
  }

  get layout(): LayoutName {
    return this.layoutController.layout;
  }

  /** Current colour encoding — the HUD and host UIs read this to stay in sync. */
  get colorBy(): ColorEncoding {
    return this.colorEncoding;
  }

  get sizeBy(): SizeEncoding {
    return this.sizeEncoding;
  }

  get themeName(): string {
    return this.theme.name;
  }

  setColorBy(encoding: ColorEncoding): void {
    this.colorEncoding = encoding;
    this.refreshEncodings();
    this.hud?.refresh();
  }

  setSizeBy(encoding: SizeEncoding): void {
    this.sizeEncoding = encoding;
    this.refreshEncodings();
    this.applyPositions(this.layoutController.positions);
  }

  setTheme(theme: ThemeName | Partial<Theme>): void {
    this.theme = resolveTheme(theme);
    this.stage.applyTheme(this.theme);
    this.nodeLayer.applyTheme(this.theme);
    this.edgeLayer.applyTheme(this.theme);
    this.labelLayer.applyTheme(this.theme);
    this.environment.applyTheme(this.theme);
    this.hud?.applyTheme(this.theme);
    this.refreshEncodings();
  }

  /** Show only nodes matching the predicate. Edges follow their endpoints. */
  setFilter(predicate: ((node: GraphNode) => boolean) | null): void {
    if (!predicate) {
      this.filterMask.fill(1);
      this.hasFilter = false;
    } else {
      this.hasFilter = true;
      for (let i = 0; i < this.model.nodeCount; i++) {
        this.filterMask[i] = predicate(this.model.nodes[i]) ? 1 : 0;
      }
    }
    this.refreshStates();
  }

  /** Convenience filter: keep only these node types. */
  filterByTypes(types: string[] | null): void {
    if (!types || types.length === 0) {
      this.setFilter(null);
      return;
    }
    const set = new Set(types);
    this.setFilter((node) => set.has(node.type ?? 'Node'));
  }

  updateRendering(patch: Partial<RenderOptions>): void {
    Object.assign(this.renderOptions, patch);
    if (patch.edgeOpacity !== undefined) this.edgeLayer.setOpacity(patch.edgeOpacity);
    if (patch.edgeFlow !== undefined) this.edgeLayer.setFlow(patch.edgeFlow);
    if (patch.grid !== undefined) this.environment.setGridVisible(patch.grid);
    if (patch.maxPixelRatio !== undefined) this.stage.setPixelRatioCap(patch.maxPixelRatio);
    if (
      patch.nodeBaseSize !== undefined ||
      patch.minNodeSize !== undefined ||
      patch.maxNodeSize !== undefined ||
      patch.nodeSizeExponent !== undefined
    ) {
      this.refreshEncodings();
      this.applyPositions(this.layoutController.positions);
    }
    this.stage.invalidate();
  }

  updateLabels(patch: Partial<LabelOptions>): void {
    Object.assign(this.labelOptions, patch);
    this.labelLayer.setOptions(this.labelOptions);
    this.stage.invalidate();
  }

  updateForce(patch: Partial<ForceLayoutOptions>): void {
    Object.assign(this.forceOptions, patch);
    this.layoutController.updateOptions(patch);
  }

  updateInteraction(patch: Partial<InteractionOptions>): void {
    Object.assign(this.interactionOptions, patch);
  }

  /* -------------------------------------------------------------- camera */

  /** Frame the whole graph. */
  frameAll(duration?: number): void {
    const positions = this.layoutController.positions;
    const n = this.model.nodeCount;
    if (n === 0) return;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (this.filterMask[i] === 0) continue;
      point.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      box.expandByPoint(point);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    // A true bounding sphere, not half the box diagonal: for the elongated
    // shapes force layouts produce, the diagonal overestimates badly and the
    // graph ends up as a small blob in the middle of an empty frame.
    let radius = 0;
    for (let i = 0; i < n; i++) {
      if (this.filterMask[i] === 0) continue;
      point.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      radius = Math.max(radius, center.distanceTo(point) + this.radii[i]);
    }
    void this.controls.frame(center, Math.max(radius, 30), duration);
  }

  /** Reheat the force simulation, e.g. after unpinning nodes. */
  restartLayout(): void {
    this.layoutController.run('force');
    this.emitter.emit('layoutStart', { layout: 'force' });
  }

  /** Export the current frame as a PNG data URL. */
  toDataURL(type = 'image/png'): string {
    this.stage.render();
    return this.stage.renderer.domElement.toDataURL(type);
  }

  /* -------------------------------------------------------------- events */

  on<K extends EventName>(name: K, fn: (payload: KnowledgeGraphEvents[K]) => void): () => void {
    return this.emitter.on(name, fn);
  }

  off<K extends EventName>(name: K, fn: (payload: KnowledgeGraphEvents[K]) => void): void {
    this.emitter.off(name, fn);
  }

  /* ------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeAdapter?.();
    this.adapter?.dispose?.();
    this.cleanupPointer?.();
    this.layoutController.dispose();
    this.controls.dispose();
    this.picker.dispose();
    this.nodeLayer.dispose();
    this.edgeLayer.dispose();
    this.labelLayer.dispose();
    this.environment.dispose();
    this.hud?.dispose();
    this.stage.dispose();
    this.emitter.clear();
    this.container.classList.remove('kg3d-root');
  }
}
