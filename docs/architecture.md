# Architecture

## The shape of the system

```
┌──────────────────────── browser ────────────────────────┐
│                                                         │
│  @kg3d/react ── KnowledgeGraph3D ─┬─ GraphModel         │
│  (optional)     (orchestrator)    │   topology, CSR     │
│                                   │   adjacency, paths  │
│                                   │                     │
│                                   ├─ LayoutController   │
│                                   │   └─ Web Worker ────┼─ Barnes-Hut
│                                   │                     │   force sim
│                                   ├─ Stage (three.js)   │
│                                   │   ├─ NodeLayer      │  1 draw call
│                                   │   ├─ EdgeLayer      │  1 draw call
│                                   │   ├─ LabelLayer     │  2D overlay
│                                   │   ├─ Environment    │
│                                   │   └─ Picker         │  1×1 GPU readback
│                                   │                     │
│                                   ├─ OrbitControls      │
│                                   └─ Hud (optional DOM) │
│                                                         │
│                       GraphAdapter                      │
└──────────────────────────┬──────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────┴──────────────────────────────┐
│  FastAPI service                                        │
│    routes ── registry ── adapters (sample/json/sql/neo4j│
│                                    /memory)             │
│    services ── analytics (networkx)                     │
│             ── layout    (numpy)                        │
│             ── lod       (levels of detail)             │
│    core ── TTL cache                                    │
└─────────────────────────────────────────────────────────┘
```

## Why it is split this way

**The engine works without the service.** Drop `@kg3d/core` on a page with an
array of nodes and you get layout, analytics, search, focus and paths, all
client-side. The service is an optimisation and a scaling story, not a
dependency. This matters more than it sounds: a library that cannot render
anything until you stand up a backend does not get adopted.

**The service exists for what the browser shouldn't do.** Exact betweenness on
20k nodes, a layout computed once and shared by every viewer instead of once per
tab, and a graph too big to send in full. When the service is present, the client detects the analytics folded into
`node.meta` and skips its own computation entirely — so the two never disagree
about which node is the biggest hub.

**Positions live in exactly one place.** `LayoutController` owns a
`Float32Array` of positions. The worker writes to it, the render layers read
from it, nothing else touches it. Every "why did my graph jump" bug in a
visualisation of this kind traces back to two things believing they own the
coordinates.

**Topology is separate from geometry.** `GraphModel` knows about nodes, edges
and adjacency; it has never heard of three.js. That is what lets the same code
run in the worker, in a test, and on the server side of a Node process.

## Rendering

Nodes are a single `InstancedMesh` of a 16×12 sphere with three instanced
attributes: colour, state (emphasis + dim) and a colour-encoded id used by the
picker. The halo behind each node is a second instanced mesh of camera-facing
billboards with additive blending. Edges are one `LineSegments` with per-vertex
colour, a parametric `t` along each edge (which is what lets a light pulse
travel along a highlighted path), and per-vertex highlight/dim factors.

Two draw calls for the graph, one for the environment, one for the overlay.

**Picking** renders a single pixel under the cursor with an id-encoding material
into a 1×1 render target, using `camera.setViewOffset`, and reads it back. Cost
is constant in graph size, and it is exact for overlapping instances: whatever
the GPU drew on top is what the user clicked. A CPU raycast against 50k spheres
would be both slower and wrong about occlusion.

**Labels** are drawn on a 2D canvas over the WebGL canvas rather than as sprites
in the scene: text stays crisp at any zoom, it never blooms, and decluttering
becomes a cheap screen-space rectangle test. Candidates are ranked by on-screen
size (with focused nodes forced to the top) and drawn until they collide or the
budget runs out.

## Layout

The force simulation is a Barnes-Hut n-body with an octree stored in flat typed
arrays — no per-node objects, so the tree is a handful of allocations reused
each tick. It runs in a Web Worker and posts positions back on a ~30 Hz cadence
rather than every tick, so a hot simulation cannot flood the message queue and
starve rendering. If workers are unavailable (strict CSP, `file://`), it falls
back to a time-boxed main-thread loop that never holds the thread longer than
8 ms per frame.

The presets are not a lesser feature. A force layout answers "what is near
what"; a hierarchy answers "what sits above what"; a radial answers "how far is
everything from _this_"; a cluster layout answers "how big are my communities
and how coupled". Switching layouts on the same data is the cheapest analysis in
the library.

Server-side layout uses a different algorithm for a different reason: numpy is
fast at whole-array arithmetic and slow at tree walks, so repulsion there is
sampled at long range (each node against a fresh random sample every iteration,
scaled by _n/k_) and exact at short range (within each cell of a uniform grid).
The error from sampling averages out across iterations instead of biasing the
final shape.

## Analytics

Client-side: PageRank by power iteration, Brandes betweenness over sampled
sources, clustering coefficient, and Louvain communities — local moving, then
aggregate the graph and move again, until nothing improves. Two cheaper
algorithms were tried first and both produce a picture that misleads: label
propagation collapses half a sparse graph into one giant community, and local
moving on its own stops at dozens of fragments because it can move nodes but
never whole communities. On the repository's synthetic 700-node graph with seven
planted domains the three score Q ≈ 0.57 / 0.49 / 0.79 — only the last recovers
the domains. A final merge pass absorbs any remaining sub-threshold community
into its strongest neighbour, because a long tail of two-node "communities"
blows up the legend and hides the real structure.

Server-side: the same quantities via networkx, with Louvain for communities and
exact betweenness below a configurable node count. Above it, both betweenness
and closeness are estimated from a degree-stratified sample of BFS sources, and
the response sets `approximate: true`. Sampling uniformly on a scale-free graph
mostly picks leaves, which is why the sample is stratified.

## Levels of detail

A million-edge graph rendered in full is a grey sphere. `services/lod.py`
produces three levels: one node per community with edges weighted by coupling,
the top 25% of each community by influence, and the full graph. The backbone is
sampled _per community_ rather than globally, because a global top-N silently
drops small communities, and a map that loses a region is worse than a coarse
one.

## Data flow for a typical session

1. `KnowledgeGraph3D` constructs the model, computes or adopts metrics, builds
   the render layers, and starts the force layout.
2. Each worker tick writes positions; the engine pushes them into the instance
   matrices and the edge vertex buffer, and — until the user touches the camera
   — re-frames the graph so the structure forms on screen rather than off it.
3. Pointer moves trigger one GPU pick per animation frame; hover state changes
   the instance state attributes and the edge highlight buffer.
4. Focusing a node computes its neighbourhood from the CSR adjacency, dims
   everything else, and flies the camera to a framing that contains it.
5. If an adapter with `subscribe` is attached, patches arrive over the
   WebSocket, merge into the model, and re-heat the layout so the graph grows in
   place instead of being torn down and re-laid-out.

## Extension points

| I want to…                       | Do this                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Read from another backend        | Implement `GraphAdapter` (one required method: `load`)          |
| Add a data source to the service | Add a class in `app/adapters/` and one line in `ADAPTER_KINDS`  |
| Replace the UI entirely          | `hud: false`, drive the public API from your own components     |
| Change the look                  | Pass a partial `Theme`, or one of the four built-ins            |
| Add a layout                     | Add a case to `applyPreset` in `layout/presets.ts`              |
| Encode a custom field            | `colorBy: { by: 'custom', fn }`, `sizeBy: { by: 'custom', fn }` |
