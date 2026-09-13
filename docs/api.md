# Graph service API

Base path `/api/v1` (configurable via `KG3D_API_PREFIX`). Interactive docs at
`/docs`, machine-readable schema at `/openapi.json`.

All graph payloads use the same field names as the TypeScript types in
`@kg3d/core`, so a response can be handed straight to the renderer.

## Health

| Method | Path             | Purpose                                             |
| ------ | ---------------- | --------------------------------------------------- |
| GET    | `/health`        | Liveness plus version and registered graph count    |
| GET    | `/ready`         | Readiness — every adapter must load without raising |
| GET    | `/metrics/cache` | Cache entries, hits, misses                         |

## Graphs

### `GET /graphs`

Every registered graph with its size.

```json
[
  {
    "id": "demo",
    "name": "Sample",
    "kind": "sample",
    "directed": false,
    "node_count": 1200,
    "edge_count": 1937
  }
]
```

### `GET /graphs/{id}`

The main payload.

| Query     | Default | Meaning                                                                                         |
| --------- | ------- | ----------------------------------------------------------------------------------------------- |
| `metrics` | `true`  | Fold analytics into each node's `meta`, set `group` to the community and `weight` to degree+1   |
| `layout`  | `none`  | `force3d` or `layered` — precompute `x/y/z` server-side                                         |
| `limit`   | –       | Return only the `limit` most central nodes (by PageRank), keeping edges whose endpoints survive |
| `level`   | –       | Level of detail: `0` community overview, `1` backbone, `2` full                                 |

```bash
curl '/api/v1/graphs/demo?metrics=true&layout=force3d&limit=5000'
```

Returns `413` when the graph exceeds `KG3D_MAX_NODES_PER_RESPONSE` and neither
`limit` nor `level` was given — with a message telling you which to use.

### `GET /graphs/{id}/neighborhood`

Breadth-first expansion around a node. This is the progressive-exploration
endpoint: the cap is applied breadth-first, so what comes back is the _closest_
`limit` nodes rather than an arbitrary slice.

| Query        | Default  |                                          |
| ------------ | -------- | ---------------------------------------- |
| `node_id`    | required | Seed node                                |
| `depth`      | `1`      | 1–5 hops                                 |
| `limit`      | `250`    | Max nodes returned                       |
| `edge_types` | –        | Comma-separated relation types to follow |

### `GET /graphs/{id}/search`

`q` (required), `limit` (default 25). Substring match over label, id and type.

```json
{ "nodes": [{ "id": "n41", "label": "Core Ledger", "type": "Service" }], "total": 1 }
```

### `GET /graphs/{id}/path`

`from`, `to`. Shortest path, plus the node records so the client can render it
without a second lookup.

```json
{"path":["a","c","d","e","g"],"length":4,"found":true,"nodes":[…]}
```

### `GET /graphs/{id}/analytics`

The structural summary.

```json
{
  "node_count": 1200,
  "edge_count": 1937,
  "density": 0.0027,
  "average_degree": 3.23,
  "components": 1,
  "communities": 9,
  "modularity": 0.81,
  "diameter_estimate": 13,
  "hubs": [{ "id": "n4", "label": "Unified Warehouse", "score": 0.0135 }],
  "bridges": [{ "id": "n77", "label": "Edge Catalog", "score": 0.0421 }],
  "isolated": [],
  "clusters": [
    {
      "id": 0,
      "size": 214,
      "label": "Core Anchor",
      "internal_density": 0.021,
      "representative": "n13"
    }
  ],
  "approximate": false
}
```

`hubs` is PageRank — what the graph is organised around. `bridges` is
betweenness — what it falls apart without. `approximate` is `true` when
betweenness and closeness were estimated from sampled sources rather than
computed exactly (see `KG3D_BETWEENNESS_EXACT_THRESHOLD`).

### `GET /graphs/{id}/nodes/{node_id}` · `…/metrics`

One node, or its metrics: degree, in/out degree, pagerank, betweenness,
closeness, clustering, community.

### `GET /graphs/{id}/rank`

`metric` (`degree|pagerank|betweenness|closeness|clustering`), `limit`.
Top-N as `{id, label, score}`.

### `GET /graphs/{id}/histogram`

Log-spaced degree distribution — a scale-free graph shows a straight line here.

### `GET /graphs/{id}/layout`

Positions only, so a client can reuse a layout without refetching the graph.

| Query        | Default     |                         |
| ------------ | ----------- | ----------------------- |
| `algorithm`  | `force3d`   | or `layered`            |
| `iterations` | from config | 10–2000                 |
| `dimensions` | `3`         | `2` flattens to a plane |

```json
{
  "algorithm": "force3d",
  "dimensions": 3,
  "ids": ["n0", "n1"],
  "positions": [
    [12.4, -8.1, 50.2],
    [-3.0, 44.9, -12.7]
  ],
  "iterations": 200,
  "duration_ms": 1740.2
}
```

Cached — the second identical request is free.

### `GET /graphs/{id}/levels` · `GET /graphs/{id}/types`

What each level of detail would cost to render, and the node-type histogram that
drives legends and filters.

## Mutation

> **The three endpoints in this section mutate state.** When `KG3D_API_KEY` is
> set they require an `X-API-Key` header (401 without one, 403 if it is wrong).
> With no key configured they are open and the service warns at startup. See
> [SECURITY.md](../SECURITY.md).

### `POST /graphs?id=…&name=…&directed=…`

Register a graph in memory from a posted `{nodes, edges}` body. For pipelines
that already compute a graph and just need it rendered. Bodies larger than
`KG3D_MAX_INGEST_BYTES` (32 MB by default) are rejected with 413.

### `PATCH /graphs/{id}`

Apply a `GraphPatch` to an in-memory graph and broadcast it to live viewers.
Returns `409` for read-only adapters.

```json
{
  "addNodes": [{ "id": "z", "label": "Z" }],
  "addEdges": [{ "source": "y", "target": "z" }],
  "removeNodes": ["q"],
  "removeEdges": ["e17"],
  "updateNodes": [{ "id": "a", "label": "A′" }]
}
```

Removing a node also drops every edge that referenced it, so the client never
sees a dangling reference.

### `POST /graphs/{id}/refresh`

Drop the adapter's cached snapshot and reload from the source.

## Live updates

### `WS /graphs/{id}/stream`

Each message is a `GraphPatch`. The client's `WebSocketAdapter` applies them
incrementally, so a changing graph grows in place rather than being re-laid-out.
The server sends `{"type":"ping"}` every 30 s of silence to keep intermediaries
from reaping the socket. An unknown graph id gets one `{"error": …}` message and
close code 1008.

```ts
import { RestAdapter, WebSocketAdapter } from '@kg3d/core';

new KnowledgeGraph3D(el, {
  adapter: new WebSocketAdapter({
    url: 'wss://graph.internal/api/v1/graphs/demo/stream',
    base: new RestAdapter({ baseUrl: '/api/v1', graphId: 'demo' }),
  }),
});
```

## Configuration

Every setting is an environment variable prefixed `KG3D_`; see
`services/api/.env.example` for the annotated list. The one that matters most:

```bash
KG3D_SOURCES='[{"id":"assets","kind":"sql","directed":true,"options":{
  "dsn":"postgresql+psycopg://user:pass@db/inventory",
  "node_query":"SELECT id, name AS label, kind AS type FROM assets",
  "edge_query":"SELECT src AS source, dst AS target, relation AS type FROM asset_links"}}]'
```

Adapter kinds: `sample`, `json`, `sql`, `neo4j`, `memory`. Any column your query
returns that isn't a known field is carried through into `meta` and shown in the
inspector.

`node_query` and `edge_query` are executed verbatim. They come from your
environment configuration and never from request input, so API callers have no
injection surface — but treat the configuration itself as privileged, and give
the database user read-only access to just what the graph needs.

Both `KG3D_SOURCES` and `KG3D_CORS_ORIGINS` accept either JSON or a
comma-separated list.

## Errors

| Status | When                                                            |
| ------ | --------------------------------------------------------------- |
| 400    | Adapter misconfiguration (the message names the missing option) |
| 404    | Unknown graph or node                                           |
| 409    | Mutating a read-only adapter                                    |
| 413    | Graph larger than the response ceiling — use `level` or `limit` |
| 422    | Query parameter validation                                      |
