"""Adapter registry.

Owns the lifetime of every configured adapter and is the single place the API
layer asks for a graph. Registering a new adapter kind is one entry in
`ADAPTER_KINDS`.
"""

from __future__ import annotations

from typing import Any

from app.adapters.base import GraphAdapter
from app.adapters.json_file import JsonFileAdapter
from app.adapters.memory import MemoryAdapter
from app.adapters.sample import SampleAdapter
from app.adapters.sql import SqlAdapter
from app.config import GraphSource, Settings
from app.models.graph import GraphSummary


def _neo4j_factory(graph_id: str, options: dict[str, Any], directed: bool) -> GraphAdapter:
    # Imported lazily so the neo4j driver stays an optional dependency.
    from app.adapters.neo4j_adapter import Neo4jAdapter

    return Neo4jAdapter(graph_id, options, directed)


ADAPTER_KINDS = {
    "sample": lambda gid, opts, directed: SampleAdapter(gid, opts, directed),
    "json": lambda gid, opts, directed: JsonFileAdapter(gid, opts, directed),
    "sql": lambda gid, opts, directed: SqlAdapter(gid, opts, directed),
    "memory": lambda gid, opts, directed: MemoryAdapter(gid, opts, directed),
    "neo4j": _neo4j_factory,
}


class GraphRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, GraphAdapter] = {}
        self._names: dict[str, str] = {}

    def configure(self, settings: Settings) -> None:
        for source in settings.sources:
            self.register(source)

    def register(self, source: GraphSource) -> GraphAdapter:
        factory = ADAPTER_KINDS.get(source.kind)
        if factory is None:
            raise ValueError(f"unknown adapter kind '{source.kind}' for graph '{source.id}'")
        adapter = factory(source.id, source.options, source.directed)
        self._adapters[source.id] = adapter
        self._names[source.id] = source.name or source.id
        return adapter

    def get(self, graph_id: str) -> GraphAdapter | None:
        return self._adapters.get(graph_id)

    def name_of(self, graph_id: str) -> str:
        return self._names.get(graph_id, graph_id)

    def ids(self) -> list[str]:
        return list(self._adapters)

    async def summaries(self) -> list[GraphSummary]:
        out: list[GraphSummary] = []
        for graph_id, adapter in self._adapters.items():
            data = await adapter.load()
            out.append(
                GraphSummary(
                    id=graph_id,
                    name=self.name_of(graph_id),
                    kind=adapter.kind,
                    directed=adapter.directed,
                    node_count=len(data.nodes),
                    edge_count=len(data.edges),
                )
            )
        return out

    async def close(self) -> None:
        for adapter in self._adapters.values():
            await adapter.close()
        self._adapters.clear()


registry = GraphRegistry()
