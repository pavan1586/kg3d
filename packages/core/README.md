# @kg3d/core

Framework-agnostic 3D knowledge graph engine. WebGL rendering, Barnes-Hut layout
in a worker, graph analytics, GPU picking and an optional HUD — in one class.

```bash
npm install @kg3d/core three
```

```ts
import { KnowledgeGraph3D } from '@kg3d/core';

const graph = new KnowledgeGraph3D(document.getElementById('app')!, {
  data: { nodes, edges },
  colorBy: { by: 'community' },
  sizeBy: { by: 'metric', metric: 'pagerank' },
});

graph.on('nodeClick', ({ node }) => console.log(node.id));
graph.focus('service-42');
graph.showPath('team-a', 'policy-9');
graph.dispose();
```

- Two draw calls for the graph; 50k nodes at interactive frame rates.
- Force layout in a Web Worker, with an automatic main-thread fallback.
- PageRank, betweenness, closeness, clustering, communities — client-side, or
  adopted from a backend that already computed them.
- Focus-and-dim, path tracing, type filtering, search, node pinning.
- Four themes, five layout presets, pluggable colour and size encodings.
- No framework dependency. `three` is the only peer dependency.

`three` must be ≥0.160. The HUD styles are injected at runtime; import
`@kg3d/core/styles.css` instead if you prefer to bundle them.

Full reference: [`docs/options.md`](../../docs/options.md).
Embedding recipes: [`docs/embedding.md`](../../docs/embedding.md).

MIT.
