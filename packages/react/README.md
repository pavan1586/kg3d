# @kg3d/react

React bindings for [`@kg3d/core`](../core).

```bash
npm install @kg3d/react three
```

```tsx
import { KnowledgeGraph, useGraphInsights, useGraphSelection } from '@kg3d/react';

function Explorer({ data }) {
  const [graph, setGraph] = useState(null);
  const insights = useGraphInsights(graph);
  const { selected } = useGraphSelection(graph);

  return (
    <>
      <KnowledgeGraph
        data={data}
        theme="obsidian"
        colorBy={{ by: 'community' }}
        sizeBy={{ by: 'metric', metric: 'pagerank' }}
        onReady={setGraph}
        onNodeClick={(node) => console.log(node.id)}
      />
      <aside>
        {insights?.hubs.map((h) => (
          <button key={h.id} onClick={() => graph.focus(h.id)}>
            {h.label}
          </button>
        ))}
      </aside>
    </>
  );
}
```

The engine is created once and updated from props — recreating a WebGL context
on every render would be slow and visually jarring, so prop changes map onto the
imperative API rather than a remount. Pass a new `data` object only when the
graph genuinely changed.

**Hooks:** `useGraphInsights`, `useGraphSelection`, `useGraphHover`,
`useGraphSearch`, `useNodeMetrics`, `useLayoutProgress`.

**Ref handle:** `graph`, `focus`, `frameAll`, `showPath`, `search`, `toDataURL`.

Everything from `@kg3d/core` is re-exported, so this is the only package you
need to depend on.

MIT.
