# kg3d graph service

FastAPI service that feeds the kg3d WebGL client: pluggable data adapters, exact
graph analytics, server-side 3D layout, levels of detail and live streaming.

```bash
pip install -e '.[dev]'
uvicorn app.main:app --reload         # http://localhost:8000/docs
pytest -q
```

The client works without this service. It exists for what the browser should not
do: exact betweenness on a large graph, Louvain instead of label propagation, a
layout computed once and shared by every viewer instead of once per tab, and
graphs too big to send in full.

## Configure

Everything is an environment variable prefixed `KG3D_` — see `.env.example`.
Pointing the service at a data source is a config change, not a code change:

```bash
KG3D_SOURCES='[{"id":"assets","kind":"sql","directed":true,"options":{
  "dsn":"postgresql+psycopg://user:pass@db/inventory",
  "node_query":"SELECT id, name AS label, kind AS type, owner FROM assets",
  "edge_query":"SELECT src AS source, dst AS target, relation AS type FROM asset_links"}}]'
```

Adapter kinds: `sample` (synthetic), `json` (file), `sql` (SQLAlchemy), `neo4j`,
`memory` (pushed in over the API). Any column your query returns that isn't a
known field lands in `meta` and shows up in the client's inspector.

## Adding an adapter

Subclass `GraphAdapter`, implement `fetch()`, add one entry to `ADAPTER_KINDS`.
Search, neighbourhood expansion and paths fall back to generic implementations
over the loaded graph, so a five-line adapter gets the full feature set; override
a method only when your store does it better.

```python
class MyAdapter(GraphAdapter):
    kind = "mine"

    async def fetch(self) -> GraphData:
        rows = await my_client.query(...)
        return GraphData(nodes=[...], edges=[...])
```

## Endpoints

`/graphs`, `/graphs/{id}`, `/neighborhood`, `/search`, `/path`, `/analytics`,
`/rank`, `/histogram`, `/layout`, `/levels`, `/types`, `PATCH /graphs/{id}`,
`WS /graphs/{id}/stream`. Full reference in [`docs/api.md`](../../docs/api.md).

## Notes

* Analytics and layout results are cached in-process with a TTL. Scale with
  replicas behind a shared cache rather than with uvicorn workers — the cache is
  per-process and extra workers multiply the misses.
* Above `KG3D_BETWEENNESS_EXACT_THRESHOLD` nodes, betweenness and closeness are
  estimated from a degree-stratified sample of BFS sources and every response
  says `approximate: true`.
* Measured timings are in [`docs/performance.md`](../../docs/performance.md).

MIT.
