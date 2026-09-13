"""SQL adapter.

Two queries, configured per graph — one returning nodes, one returning edges.
That keeps the adapter honest about what it does: it does not try to infer your
schema, it runs the SQL you already know is correct.

Required columns
    nodes: id  (plus optional label, type, group, weight, level, color, ...)
    edges: source, target  (plus optional id, type, weight, label, ...)

Any additional column is carried through into `meta` and shown in the inspector.
"""

from __future__ import annotations

from typing import Any

from app.adapters.base import GraphAdapter
from app.models.graph import Edge, GraphData, Node

NODE_FIELDS = {"id", "label", "type", "group", "weight", "size", "color", "level", "x", "y", "z"}
EDGE_FIELDS = {"id", "source", "target", "label", "type", "weight", "directed", "color"}


class SqlAdapter(GraphAdapter):
    kind = "sql"

    def __init__(
        self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = False
    ):
        super().__init__(graph_id, options, directed)
        self.dsn = self.options.get("dsn")
        self.node_query = self.options.get("node_query")
        self.edge_query = self.options.get("edge_query")
        if not (self.dsn and self.node_query and self.edge_query):
            raise ValueError(
                f"graph '{graph_id}': sql adapter requires options.dsn, options.node_query "
                "and options.edge_query"
            )
        self._engine = None

    def _get_engine(self):
        if self._engine is None:
            try:
                from sqlalchemy import create_engine
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise RuntimeError(
                    "SQLAlchemy is required for the sql adapter: pip install 'kg3d-api[sql]'"
                ) from exc
            # pool_pre_ping keeps long-lived deployments from serving 500s after
            # the database restarts underneath them.
            self._engine = create_engine(self.dsn, pool_pre_ping=True, future=True)
        return self._engine

    async def fetch(self) -> GraphData:
        from sqlalchemy import text

        engine = self._get_engine()
        with engine.connect() as connection:
            node_rows = [dict(row) for row in connection.execute(text(self.node_query)).mappings()]
            edge_rows = [dict(row) for row in connection.execute(text(self.edge_query)).mappings()]

        nodes = [Node(**_split(row, NODE_FIELDS, id_field="id")) for row in node_rows]
        known = {n.id for n in nodes}
        edges: list[Edge] = []
        for row in edge_rows:
            payload = _split(row, EDGE_FIELDS)
            payload["source"] = str(payload.get("source"))
            payload["target"] = str(payload.get("target"))
            if payload["source"] in known and payload["target"] in known:
                edges.append(Edge(**payload))
        return GraphData(nodes=nodes, edges=edges)

    async def close(self) -> None:
        if self._engine is not None:
            self._engine.dispose()
            self._engine = None


def _split(row: dict[str, Any], fields: set[str], id_field: str | None = None) -> dict[str, Any]:
    """Split a row into model fields plus a `meta` bag of everything else."""
    payload = {k: v for k, v in row.items() if k in fields}
    meta = {k: v for k, v in row.items() if k not in fields}
    if id_field and id_field in payload:
        payload[id_field] = str(payload[id_field])
    if meta:
        payload["meta"] = meta
    return payload
