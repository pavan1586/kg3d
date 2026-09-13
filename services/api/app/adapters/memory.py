"""In-memory adapter.

Backs graphs pushed in over the API (`POST /graphs`) and is the target for live
patches. It is also what the tests use, because it makes the whole request path
exercisable without any external service.
"""

from __future__ import annotations

from typing import Any

from app.adapters.base import GraphAdapter
from app.models.graph import Edge, GraphData, GraphPatch, Node


class MemoryAdapter(GraphAdapter):
    kind = "memory"

    def __init__(self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = False):
        super().__init__(graph_id, options, directed)
        payload = self.options.get("data") or {"nodes": [], "edges": []}
        if isinstance(payload, GraphData):
            self._data = payload
        else:
            self._data = GraphData(**payload)

    async def fetch(self) -> GraphData:
        return self._data

    def replace(self, data: GraphData) -> None:
        self._data = data
        self.invalidate()

    def apply_patch(self, patch: GraphPatch) -> GraphData:
        """Apply a mutation and return the new graph state."""
        nodes: dict[str, Node] = {n.id: n for n in self._data.nodes}
        edges: dict[str, Edge] = {
            (e.id or f"{e.source}->{e.target}"): e for e in self._data.edges
        }

        for node in patch.addNodes or []:
            nodes[node.id] = node
        for update in patch.updateNodes or []:
            existing = nodes.get(update.id)
            if existing is None:
                nodes[update.id] = update
            else:
                # Merge rather than replace: a patch carries only what changed.
                merged = existing.model_dump()
                merged.update({k: v for k, v in update.model_dump().items() if v is not None})
                nodes[update.id] = Node(**merged)
        for edge in patch.addEdges or []:
            key = edge.id or f"{edge.source}->{edge.target}"
            if edge.source in nodes and edge.target in nodes:
                edges[key] = edge

        for edge_id in patch.removeEdges or []:
            edges.pop(edge_id, None)
        for node_id in patch.removeNodes or []:
            nodes.pop(node_id, None)
            # Drop edges that lost an endpoint, otherwise the client sees
            # dangling references.
            for key, edge in list(edges.items()):
                if edge.source == node_id or edge.target == node_id:
                    edges.pop(key, None)

        self._data = GraphData(nodes=list(nodes.values()), edges=list(edges.values()))
        self.invalidate()
        return self._data
