# Embedding guide

## 1. Plain page, one script tag

The browser bundle has three.js inside it, so there is no import map and nothing
to configure:

```html
<div id="graph" style="width: 100%; height: 100vh"></div>
<script src="https://cdn.jsdelivr.net/npm/@kg3d/core/dist/kg3d.global.js"></script>
<script>
  const graph = new kg3d.KnowledgeGraph3D(document.getElementById('graph'), {
    data: {
      nodes: [
        { id: 'api', label: 'Payments API', type: 'Service' },
        { id: 'db', label: 'Ledger DB', type: 'Dataset' },
        { id: 'team', label: 'Payments', type: 'Team' },
      ],
      edges: [
        { source: 'api', target: 'db', type: 'depends_on' },
        { source: 'team', target: 'api', type: 'owns' },
      ],
    },
  });

  graph.on('nodeClick', ({ node }) => console.log(node.label));
</script>
```

Everything on the `kg3d` global is what `@kg3d/core` exports. Working version:
[`examples/script-tag.html`](../examples/script-tag.html).

Two things to know about this build. It is ~600 kB minified because three.js
travels with it — use the ESM package in anything with a bundler. And a
script-tag page has no module context, so the layout worker cannot be located
and the force simulation runs on the main thread instead; it is time-boxed to
8 ms per frame, so the page stays responsive, but past ~10k nodes you want the
ESM build.

It also redistributes three.js, so the bundle ships with
`kg3d.global.js.LICENSE.txt` next to it. Keep the two together if you re-host or
re-minify.

### With an import map instead

If you would rather load the ESM build directly, the import map needs both the
bare specifier and the `examples/jsm/` prefix the bloom pass imports lazily:

```html
<script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
      "three/examples/jsm/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
    }
  }
</script>
<script type="module">
  import { KnowledgeGraph3D } from 'https://cdn.jsdelivr.net/npm/@kg3d/core/dist/index.js';
  new KnowledgeGraph3D(document.getElementById('graph'), { data: { nodes, edges } });
</script>
```

The trailing slash on the second entry matters. Working version:
[`examples/standalone.html`](../examples/standalone.html).

## 2. Bundled application

```bash
npm install @kg3d/core three
```

```ts
import { KnowledgeGraph3D } from '@kg3d/core';

const graph = new KnowledgeGraph3D(container, {
  data,
  colorBy: { by: 'community' },
  sizeBy: { by: 'metric', metric: 'pagerank' },
  labels: { maxVisible: 60 },
});

// Always dispose — it releases the WebGL context, the worker and the listeners.
window.addEventListener('beforeunload', () => graph.dispose());
```

The layout worker is resolved with `new URL('./layoutWorker.js', import.meta.url)`,
which Vite, webpack 5 and Rollup all understand. If your bundler doesn't, or a
strict CSP blocks workers, the engine logs a warning and falls back to a
time-boxed main-thread simulation — nothing breaks.

## 3. React

```tsx
import { KnowledgeGraph, useGraphInsights, useGraphSelection } from '@kg3d/react';

function Explorer({ data }) {
  const [graph, setGraph] = useState(null);
  const insights = useGraphInsights(graph);
  const { selected } = useGraphSelection(graph);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', height: '100vh' }}>
      <KnowledgeGraph data={data} onReady={setGraph} hud={{ search: true, legend: true }} />
      <aside>
        <h2>{insights?.communities} clusters</h2>
        {insights?.hubs.map((h) => (
          <button key={h.id} onClick={() => graph.focus(h.id)}>
            {h.label}
          </button>
        ))}
        {selected.map((n) => (
          <div key={n.id}>{n.label}</div>
        ))}
      </aside>
    </div>
  );
}
```

## 4. Your own UI

Pass `hud: false` and drive the public API. Everything the built-in HUD does is
available:

```ts
const graph = new KnowledgeGraph3D(el, { data, hud: false });

graph.on('nodeClick', ({ node }) => setInspected(node));
graph.on('selectionChange', ({ selected }) => setSelection(selected));
graph.on('nodeHover', ({ node }) => setTooltip(node));

await graph.search('ledger'); // adapter-backed if available
graph.focus('svc-12'); // fly + dim the rest
graph.showPath('team-a', 'policy-9'); // highlight the shortest path
graph.filterByTypes(['Service', 'Dataset']);
graph.setColorBy({ by: 'metric', metric: 'betweenness' });
graph.getInsights(); // hubs, bridges, clusters, modularity
```

## 5. Custom data source

```ts
import { KnowledgeGraph3D } from '@kg3d/core';
import type { GraphAdapter } from '@kg3d/core';

class CmdbAdapter implements GraphAdapter {
  async load() {
    const res = await fetch('/cmdb/graph');
    const { items, relations } = await res.json();
    return {
      nodes: items.map((i) => ({
        id: i.sys_id,
        label: i.name,
        type: i.class,
        weight: i.impact,
        meta: { owner: i.owner, env: i.environment },
      })),
      edges: relations.map((r) => ({
        source: r.parent,
        target: r.child,
        type: r.type,
      })),
    };
  }

  // Optional: only implement what your backend does better than we can.
  async neighborhood({ nodeId, depth = 1 }) {
    const res = await fetch(`/cmdb/graph/${nodeId}?depth=${depth}`);
    return res.json();
  }
}

new KnowledgeGraph3D(el, { adapter: new CmdbAdapter() });
```

Anything you leave out — `search`, `path`, `subscribe` — falls back to a
client-side implementation over the loaded graph.

## 6. Live updates

```ts
import { RestAdapter, WebSocketAdapter } from '@kg3d/core';

const adapter = new WebSocketAdapter({
  url: `wss://${location.host}/api/v1/graphs/demo/stream`,
  base: new RestAdapter({ baseUrl: '/api/v1', graphId: 'demo', withMetrics: true }),
});

new KnowledgeGraph3D(el, { adapter });
```

Patches merge into the existing model and re-heat the layout, so the graph grows
in place. The socket reconnects with exponential backoff and re-fetches the
snapshot on reconnect, because a socket that has been down for a minute cannot be
trusted to have delivered every patch.

## 7. Very large graphs

Ask the service what a level costs, then load the level you can render:

```ts
const levels = await fetch('/api/v1/graphs/big/levels').then((r) => r.json());
// [{level:0, node_count:14}, {level:1, node_count:4200}, {level:2, node_count:180000}]

const overview = await fetch('/api/v1/graphs/big?level=0').then((r) => r.json());
const graph = new KnowledgeGraph3D(el, { data: overview });

// Drill into a cluster on double-click.
graph.updateInteraction({ doubleClickAction: 'none' });
graph.on('nodeDoubleClick', async ({ node }) => {
  const detail = await fetch(
    `/api/v1/graphs/big/neighborhood?node_id=${node.meta.representative}&depth=2&limit=800`,
  ).then((r) => r.json());
  graph.applyPatch({ addNodes: detail.nodes, addEdges: detail.edges });
});
```

## 8. Theming

```ts
graph.setTheme({
  name: 'obsidian', // start from a built-in
  background: '#05070d',
  palette: ['#4a7df0', '#2ec5ad', '#9d6ff0', '#e89a45', '#ec6076'],
  bloomStrength: 0.4,
});
```

Only the keys you pass are overridden. The palettes are chosen for hue
separation within a narrow lightness band — if you replace them, keep the
lightness consistent or the classes stop reading as equally important.

For a light UI, use `daylight`: it flips edge blending to normal, disables
bloom and ambient particles, and swaps the metric ramp.

## 9. Server-side rendering / testing

The engine needs a DOM and WebGL, so guard construction:

```ts
if (typeof window !== 'undefined') {
  graph = new KnowledgeGraph3D(el, { data });
}
```

The analytical parts have no such requirement and are unit-testable on their own:

```ts
import { GraphModel, computeMetrics, summarize } from '@kg3d/core';

const model = new GraphModel(data);
const insights = summarize(model, computeMetrics(model));
expect(insights.hubs[0].id).toBe('api-gateway');
```

## Performance checklist

Reach for these in order when a graph feels heavy:

1. `labels: { maxVisible: 40 }` — text is the most expensive per-frame work
2. `rendering: { bloom: false }` — saves ~1.5 ms/frame at 1080p
3. `rendering: { edgeCurvature: 0 }` — 10× fewer edge vertices
4. `rendering: { glow: false }` — removes the second instanced draw call
5. `rendering: { maxPixelRatio: 1 }` — a quarter of the fragments on a retina display
6. `force: { theta: 1.2, maxIterations: 400 }` — a faster, coarser settle
7. `rendering: { renderOnDemand: true }` — for static views, stop drawing when nothing moves
