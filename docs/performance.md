# Performance

Numbers measured on this repository's synthetic scale-free graphs, on a single
cloud vCPU with software rendering. A real machine with a GPU is considerably
faster for anything involving the canvas; the CPU figures below transfer more or
less directly.

## Client engine (Node 22, `@kg3d/core` dist build)

|  Nodes |  Edges | Model build | Analytics | Insight summary | Force tick |
| -----: | -----: | ----------: | --------: | --------------: | ---------: |
|  1,000 |  1,274 |        4 ms |     58 ms |            4 ms |     2.3 ms |
|  5,000 |  6,482 |       11 ms |    171 ms |           11 ms |    15.7 ms |
| 20,000 | 25,975 |       36 ms |    779 ms |           53 ms |    69.1 ms |
| 50,000 | 64,830 |       92 ms |  2,186 ms |          134 ms |   100.2 ms |

_Analytics_ is PageRank + sampled Brandes betweenness + closeness + clustering +
multi-level Louvain community detection (Q ≈ 0.88 on these graphs, recovering
the planted domains). _Force tick_ is one Barnes-Hut iteration, and runs in a Web
Worker, so it costs the UI thread nothing — a 50k-node graph settles in roughly
45 seconds of worker time while the page stays at 60 fps and the camera follows
the layout in.

Above 20k nodes the engine widens the Barnes-Hut opening angle and lowers the
iteration cap automatically (θ 0.85 → 1.15, and → 1.35 above 40k). That is worth
2.4× at 50k — 270 ms → 113 ms per tick — for a layout that looks the same. Pass
your own `force.theta` or `force.maxIterations` to override.

## Graph service (Python 3.11, networkx + numpy, single vCPU)

|  Nodes |  Edges | Layout (150 it) | Analytics | Mode    |
| -----: | -----: | --------------: | --------: | ------- |
|  2,000 |  3,206 |           1.8 s |      ~1 s | sampled |
| 20,000 | 32,098 |          14.2 s |    10.6 s | sampled |
| 50,000 | 79,816 |          36.6 s |    26.4 s | sampled |

Below `KG3D_BETWEENNESS_EXACT_THRESHOLD` (default 1,200 nodes) betweenness and
closeness are exact; above it both are estimated from a degree-stratified sample
of BFS sources and the response sets `approximate: true`. Exact betweenness on
2,000 nodes costs about 12 s, which is why the threshold sits where it does.

Both results are cached (`KG3D_CACHE_TTL_SECONDS`, default 15 minutes), so the
cost above is paid once per graph, not once per viewer. That is most of the
argument for having a service at all.

## Rendering budget

The whole graph is four draw calls: nodes, halos, edges, environment. What
actually costs frame time, in order:

1. **Labels.** Projection, ranking and the declutter pass are per-frame CPU work
   proportional to the number of on-screen candidates. `labels.maxVisible` is
   the single most effective knob.
2. **Bloom.** About 1.5 ms at 1080p, more at higher pixel ratios.
3. **Fragment load.** Halos are large additive quads; on a retina display at
   `maxPixelRatio: 2` they dominate fill rate.
4. **Edge geometry updates.** With `edgeCurvature > 0` each edge is 10 segments;
   the engine drops to straight lines automatically above 25k edges.
5. **Instance matrix upload.** One `Float32Array` write per node per layout tick.

Picking is _not_ on this list: it is a 1×1 render-target readback, constant in
graph size, at most once per animation frame.

## Turning it down

In the order worth trying:

```ts
graph.updateLabels({ maxVisible: 40 });
graph.updateRendering({ bloom: false }); // ~1.5 ms/frame
graph.updateRendering({ edgeCurvature: 0 }); // 10× fewer edge vertices
graph.updateRendering({ glow: false }); // one fewer draw call, much less fill
graph.updateRendering({ maxPixelRatio: 1 }); // quarter of the fragments on retina
graph.updateForce({ theta: 1.4, maxIterations: 300 });
graph.updateRendering({ renderOnDemand: true }); // static views: stop drawing when nothing moves
```

## Memory

Roughly, per node: 12 B position + 12 B colour + 8 B state + 4 B radius, plus
three.js instance matrices at 64 B. Per edge with curvature on: 20 vertices ×
(12 B position + 12 B colour + 12 B attributes). A 50k-node / 65k-edge graph
sits around 120 MB of GPU-side buffers with curved edges, or about 25 MB with
straight ones.

## Choosing where to compute

|                 | Client                                      | Service                                              |
| --------------- | ------------------------------------------- | ---------------------------------------------------- |
| Up to ~5k nodes | Everything, comfortably                     | Not needed                                           |
| 5k–25k          | Fine; analytics ~0.2–1 s once               | Worth it if many viewers share the graph             |
| 25k–60k         | Renders and lays out well; analytics ~2.5 s | Recommended — compute once, cache, serve             |
| Above 60k       | Use levels of detail                        | Required: `?level=0`, then drill in by neighbourhood |
