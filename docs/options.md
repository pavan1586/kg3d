# Engine reference

Everything `@kg3d/core` exposes. Types live in `packages/core/src/types.ts`.

## Constructing

```ts
const graph = new KnowledgeGraph3D(container, options);
```

`container` must be an element with a size. The engine sets `position: relative`
on it if it is `static`, and appends a WebGL canvas, a label canvas and (unless
disabled) the HUD.

## Options

### Data

| Option           | Type           | Default |                                                                                                    |
| ---------------- | -------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `data`           | `GraphData`    | –       | Nodes and edges up front                                                                           |
| `adapter`        | `GraphAdapter` | –       | Load (and optionally stream) from a backend                                                        |
| `directed`       | `boolean`      | `false` | Affects analytics and edge semantics                                                               |
| `computeMetrics` | `boolean`      | `true`  | Compute analytics on load. Server-supplied metrics in `node.meta` are adopted instead when present |

### Appearance

| Option    | Type                                                                  | Default            |                                                          |
| --------- | --------------------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| `theme`   | `'obsidian' \| 'nebula' \| 'slate' \| 'daylight'` or `Partial<Theme>` | `obsidian`         |                                                          |
| `colorBy` | `ColorEncoding`                                                       | `{ by: 'type' }`   | `type`, `community`, `metric`, `constant`, `custom`      |
| `sizeBy`  | `SizeEncoding`                                                        | `{ by: 'weight' }` | `weight`, `degree`, `metric`, `constant`, `custom`       |
| `hud`     | `boolean \| Partial<HudOptions>`                                      | `true`             | `{search, legend, inspector, stats, controls, insights}` |

### `rendering`

| Key                           | Default      |                                                                    |
| ----------------------------- | ------------ | ------------------------------------------------------------------ |
| `nodeBaseSize`                | `4.2`        | Radius of a weight-1 node                                          |
| `nodeSizeExponent`            | `0.5`        | Square-root scaling: 100× the weight is 10× the radius, not 100×   |
| `minNodeSize` / `maxNodeSize` | `1.6` / `26` |                                                                    |
| `edgeOpacity`                 | `0.34`       |                                                                    |
| `edgeCurvature`               | `0.18`       | 0 = straight. Arcs separate reciprocal pairs                       |
| `edgeFlow`                    | `true`       | Light pulse along _highlighted_ edges only                         |
| `glow`                        | `true`       | Additive halo behind each node                                     |
| `bloom`                       | `true`       | Post-processing bloom                                              |
| `maxPixelRatio`               | `2`          |                                                                    |
| `grid`                        | `true`       | Ground reference plane                                             |
| `depthFade`                   | `true`       | Fade distant elements into the background                          |
| `renderOnDemand`              | `false`      | Only redraw when something changed — saves battery on static views |

### `labels`

| Key                      | Default           |                                                    |
| ------------------------ | ----------------- | -------------------------------------------------- |
| `enabled`                | `true`            |                                                    |
| `maxVisible`             | `90`              | Hard cap per frame                                 |
| `minScreenSize`          | `7`               | Minimum on-screen node radius (px) to earn a label |
| `declutter`              | `true`            | Skip labels that would overlap one already placed  |
| `alwaysShowFocused`      | `true`            | Selection, hover and paths are always labelled     |
| `fontFamily`, `fontSize` | Inter stack, `13` |                                                    |

### `force`

| Key                          | Default          |                                                             |
| ---------------------------- | ---------------- | ----------------------------------------------------------- |
| `charge`                     | `-320`           | Repulsion; more negative spreads the graph                  |
| `linkDistance`               | `46`             | Ideal edge length                                           |
| `linkStrength`               | `0.55`           | Spring constant                                             |
| `gravity`                    | `0.035`          | Pull to the origin — keeps disconnected components in frame |
| `damping`                    | `0.86`           |                                                             |
| `theta`                      | `0.85`           | Barnes-Hut opening angle; higher is faster and coarser      |
| `clusterStrength`            | `0.12`           | Extra cohesion within a community                           |
| `alphaMin` / `maxIterations` | `0.0025` / `900` | Stopping conditions                                         |
| `useWorker`                  | `true`           | Falls back to a time-boxed main-thread loop automatically   |
| `dimensions`                 | `3`              | `2` for a flat layout with 3D camera                        |

### `interaction`

| Key                                          | Default   |                                                        |
| -------------------------------------------- | --------- | ------------------------------------------------------ |
| `enableHover` / `enableClick` / `enableDrag` | `true`    |                                                        |
| `focusDimming`                               | `true`    | Dim everything outside the focused neighbourhood       |
| `focusDepth`                                 | `1`       | Hops kept bright when focusing                         |
| `idleOrbit`                                  | `true`    | Slow orbit after `idleOrbitDelayMs` (12 s) of no input |
| `doubleClickAction`                          | `'focus'` | or `'expand'` (adapter neighbourhood) or `'none'`      |

### `camera`

`fov` 52, `near` 1, `far` 12000, `minDistance` 18, `maxDistance` 4200,
`damping` 0.09, `rotateSpeed`/`zoomSpeed`/`panSpeed` 1, `flightDurationMs` 900.

## Methods

**Data** — `setData(data)`, `applyPatch(patch)`, `expand(id, depth?)`,
`getData()`, `getNode(id)`, `getNeighbors(id)`, `getNodeMetrics(id)`,
`getInsights()`, `getLegend()`

**Selection** — `select(ids)`, `toggleSelection(id)`, `clearSelection()`,
`selectedIds()`, `selectedNodes()`

**Focus** — `focus(id, depth?)`, `clearFocus()`, `showPath(from, to)`,
`search(query)`

**View** — `setLayout(name)`, `setColorBy(encoding)`, `setSizeBy(encoding)`,
`setTheme(theme)`, `setFilter(predicate | null)`, `filterByTypes(types | null)`,
`updateRendering(patch)`, `updateLabels(patch)`, `updateForce(patch)`,
`updateInteraction(patch)`

**Camera** — `frameAll(duration?)`, `restartLayout()`, `toDataURL(type?)`

**Lifecycle** — `on(event, fn)` (returns an unsubscribe), `off`, `dispose()`

**Getters** — `layout`, `colorBy`, `sizeBy`, `themeName`

## Events

| Event                                      | Payload                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `ready`                                    | `{ nodeCount, edgeCount }`                                           |
| `nodeHover`                                | `{ node \| null }`                                                   |
| `nodeClick` / `nodeDoubleClick`            | `{ node, index, event, screen }`                                     |
| `backgroundClick`                          | `{ event }`                                                          |
| `selectionChange`                          | `{ selected: NodeId[] }`                                             |
| `layoutStart` / `layoutTick` / `layoutEnd` | `{ layout }` / `{ iteration, alpha }` / `{ iterations, durationMs }` |
| `dataChange`                               | `{ nodeCount, edgeCount }`                                           |
| `cameraChange`                             | `{ distance }`                                                       |
| `error`                                    | `{ error, context }`                                                 |

## Keyboard

With the canvas focused: `f` frames the selection, `r` frames everything,
`Escape` clears focus. Shift-click adds to the selection; shift-drag pans;
right-drag pans; two-finger pinch zooms.

## React

```tsx
<KnowledgeGraph
  data={data} adapter={adapter}
  theme="obsidian" layout="force"
  colorBy={{ by: 'community' }} sizeBy={{ by: 'metric', metric: 'pagerank' }}
  selected={selectedIds} focusId={focusId}
  onReady={setGraph} onNodeClick={n => …} onSelectionChange={setSelectedIds}
  onInsights={setInsights} onError={(e, ctx) => …}
/>
```

The engine is created once and _updated_ from props — recreating a WebGL context
on every render would be slow and visually jarring. Pass a new `data` object only
when the graph genuinely changed.

Hooks: `useGraphInsights`, `useGraphSelection`, `useGraphHover`,
`useGraphSearch`, `useNodeMetrics`, `useLayoutProgress`. The ref handle exposes
`graph`, `focus`, `frameAll`, `showPath`, `search`, `toDataURL`.

## Adapters

```ts
interface GraphAdapter {
  load(signal?): Promise<GraphData>; // required
  neighborhood?(query, signal?): Promise<GraphData>;
  search?(query, signal?): Promise<GraphNode[]>;
  path?(from, to, signal?): Promise<NodeId[]>;
  subscribe?(handler): () => void;
  dispose?(): void;
}
```

Only `load` is required; anything you omit falls back to a client-side
implementation over the loaded graph. Built-ins: `StaticAdapter`, `RestAdapter`,
`WebSocketAdapter`.
