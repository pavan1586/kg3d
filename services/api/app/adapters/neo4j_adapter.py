"""Neo4j adapter.

Ships with a default Cypher pair that works on any graph, and lets you override
both when you want to scope, filter or project. Labels become node `type` and
relationship types become edge `type`, which is what the client's colouring and
legend expect.
"""

from __future__ import annotations

from typing import Any

from app.adapters.base import GraphAdapter
from app.models.graph import Edge, GraphData, Node

DEFAULT_NODE_QUERY = """
MATCH (n)
RETURN elementId(n) AS id,
       coalesce(n.name, n.title, n.label, elementId(n)) AS label,
       head(labels(n)) AS type,
       properties(n) AS props
LIMIT $limit
"""

DEFAULT_EDGE_QUERY = """
MATCH (a)-[r]->(b)
RETURN elementId(r) AS id,
       elementId(a) AS source,
       elementId(b) AS target,
       type(r) AS type,
       coalesce(r.weight, 1.0) AS weight
LIMIT $limit
"""


class Neo4jAdapter(GraphAdapter):
    kind = "neo4j"

    def __init__(self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = True):
        super().__init__(graph_id, options, directed)
        self.uri = self.options.get("uri")
        self.user = self.options.get("user", "neo4j")
        self.password = self.options.get("password", "")
        self.database = self.options.get("database")
        self.node_query = self.options.get("node_query", DEFAULT_NODE_QUERY)
        self.edge_query = self.options.get("edge_query", DEFAULT_EDGE_QUERY)
        self.limit = int(self.options.get("limit", 50_000))
        if not self.uri:
            raise ValueError(f"graph '{graph_id}': neo4j adapter requires options.uri")
        self._driver = None

    def _get_driver(self):
        if self._driver is None:
            try:
                from neo4j import GraphDatabase
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise RuntimeError(
                    "neo4j is required for this adapter: pip install 'kg3d-api[neo4j]'"
                ) from exc
            self._driver = GraphDatabase.driver(self.uri, auth=(self.user, self.password))
        return self._driver

    async def fetch(self) -> GraphData:
        driver = self._get_driver()
        with driver.session(database=self.database) as session:
            node_records = list(session.run(self.node_query, limit=self.limit))
            edge_records = list(session.run(self.edge_query, limit=self.limit))

        nodes: list[Node] = []
        for record in node_records:
            props = dict(record.get("props") or {})
            # Neo4j temporal/spatial types don't serialise to JSON; stringify
            # anything that isn't a primitive rather than failing the request.
            meta = {k: v if isinstance(v, (str, int, float, bool)) else str(v) for k, v in props.items()}
            nodes.append(
                Node(
                    id=str(record["id"]),
                    label=str(record.get("label") or record["id"]),
                    type=record.get("type") or "Node",
                    weight=float(props.get("weight", 1) or 1),
                    meta=meta or None,
                )
            )

        known = {n.id for n in nodes}
        edges = [
            Edge(
                id=str(record["id"]),
                source=str(record["source"]),
                target=str(record["target"]),
                type=record.get("type"),
                weight=float(record.get("weight") or 1),
                directed=True,
            )
            for record in edge_records
            if str(record["source"]) in known and str(record["target"]) in known
        ]
        return GraphData(nodes=nodes, edges=edges)

    async def close(self) -> None:
        if self._driver is not None:
            self._driver.close()
            self._driver = None
