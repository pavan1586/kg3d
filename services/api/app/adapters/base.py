"""Adapter contract.

An adapter turns *some* data source into a `GraphData`. That is the whole
interface. Anything an adapter cannot do (search, incremental neighbourhoods,
live updates) falls back to a generic in-memory implementation over the loaded
graph, so a five-line adapter is enough to get the full feature set — you only
override a method when the backing store can do it better than we can.
"""

from __future__ import annotations

import abc
from collections import deque
from typing import Any

from app.models.graph import Edge, GraphData, Node


class GraphAdapter(abc.ABC):
    """Base class for every data source."""

    kind: str = "base"

    def __init__(
        self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = False
    ):
        self.graph_id = graph_id
        self.options = options or {}
        self.directed = directed
        self._cache: GraphData | None = None

    # ---------------------------------------------------------------- load

    @abc.abstractmethod
    async def fetch(self) -> GraphData:
        """Load the full graph from the underlying store."""

    async def load(self, refresh: bool = False) -> GraphData:
        """Cached `fetch`. Adapters over slow stores get this for free."""
        if self._cache is None or refresh:
            self._cache = await self.fetch()
        return self._cache

    def invalidate(self) -> None:
        self._cache = None

    # ------------------------------------------------------------ queries

    async def search(self, query: str, limit: int = 25) -> list[Node]:
        """Substring match over label, id and type.

        Override when the store has a real index — this scan is fine to a few
        hundred thousand nodes and wrong past that.
        """
        data = await self.load()
        needle = query.strip().lower()
        if not needle:
            return []
        results: list[Node] = []
        for node in data.nodes:
            haystack = f"{node.label or ''} {node.id} {node.type or ''}".lower()
            if needle in haystack:
                results.append(node)
                if len(results) >= limit:
                    break
        return results

    async def neighborhood(
        self,
        node_id: str,
        depth: int = 1,
        limit: int = 250,
        edge_types: list[str] | None = None,
    ) -> GraphData:
        """BFS expansion around a node, capped at `limit` nodes.

        The cap is applied breadth-first, so what comes back is the *closest*
        `limit` nodes rather than an arbitrary slice — which is what makes
        progressive exploration feel predictable.
        """
        data = await self.load()
        adjacency: dict[str, list[tuple[str, Edge]]] = {}
        for edge in data.edges:
            if edge_types and (edge.type or "related") not in edge_types:
                continue
            adjacency.setdefault(edge.source, []).append((edge.target, edge))
            adjacency.setdefault(edge.target, []).append((edge.source, edge))

        keep: set[str] = {node_id}
        edges_kept: dict[str, Edge] = {}
        frontier: deque[tuple[str, int]] = deque([(node_id, 0)])
        while frontier and len(keep) < limit:
            current, level = frontier.popleft()
            if level >= depth:
                continue
            for neighbor, edge in adjacency.get(current, []):
                edge_key = edge.id or f"{edge.source}->{edge.target}"
                edges_kept[edge_key] = edge
                if neighbor not in keep:
                    keep.add(neighbor)
                    frontier.append((neighbor, level + 1))
                    if len(keep) >= limit:
                        break

        nodes = [n for n in data.nodes if n.id in keep]
        edges = [e for e in edges_kept.values() if e.source in keep and e.target in keep]
        return GraphData(nodes=nodes, edges=edges)

    async def close(self) -> None:
        """Release any connections. Called on application shutdown."""
        return None
