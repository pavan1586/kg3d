"""Wire models.

These mirror the TypeScript types in `@kg3d/core` exactly — same field names,
same optionality — so the client can consume a response with no translation
layer. When you change one side, change the other.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Node(BaseModel):
    id: str
    label: str | None = None
    type: str | None = None
    group: int | str | None = None
    weight: float | None = None
    size: float | None = None
    color: str | None = None
    level: int | None = None
    x: float | None = None
    y: float | None = None
    z: float | None = None
    meta: dict[str, Any] | None = None


class Edge(BaseModel):
    id: str | None = None
    source: str
    target: str
    label: str | None = None
    type: str | None = None
    weight: float | None = None
    directed: bool | None = None
    color: str | None = None
    meta: dict[str, Any] | None = None


class GraphData(BaseModel):
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)


class GraphSummary(BaseModel):
    id: str
    name: str
    kind: str
    directed: bool
    node_count: int
    edge_count: int


class NodeMetrics(BaseModel):
    degree: float = 0
    in_degree: float = 0
    out_degree: float = 0
    pagerank: float = 0
    betweenness: float = 0
    closeness: float = 0
    clustering: float = 0
    community: int = 0


class ClusterSummary(BaseModel):
    id: int
    size: int
    label: str
    internal_density: float
    representative: str


class RankedNode(BaseModel):
    id: str
    label: str
    score: float


class GraphInsights(BaseModel):
    """The analytical answer to 'what is this graph actually like?'."""

    node_count: int
    edge_count: int
    density: float
    average_degree: float
    components: int
    communities: int
    modularity: float
    diameter_estimate: int
    #: Highest PageRank — what the graph is organised around.
    hubs: list[RankedNode]
    #: Highest betweenness — what the graph would fall apart without.
    bridges: list[RankedNode]
    #: Highest clustering with low degree — tight, self-contained pockets.
    isolated: list[str]
    clusters: list[ClusterSummary]
    #: True when betweenness was sampled rather than computed exactly.
    approximate: bool = False


class SearchResponse(BaseModel):
    nodes: list[Node]
    total: int


class PathResponse(BaseModel):
    path: list[str]
    length: int
    found: bool
    #: The nodes along the path, so the client can render it without a lookup.
    nodes: list[Node] = Field(default_factory=list)


class LayoutResponse(BaseModel):
    algorithm: str
    dimensions: int
    #: Parallel arrays: positions[i] belongs to ids[i].
    ids: list[str]
    positions: list[list[float]]
    iterations: int
    duration_ms: float


class LevelSummary(BaseModel):
    """One level of the level-of-detail pyramid."""

    level: int
    node_count: int
    edge_count: int
    description: str


class GraphPatch(BaseModel):
    """Live mutation pushed over the WebSocket."""

    addNodes: list[Node] | None = None
    addEdges: list[Edge] | None = None
    removeNodes: list[str] | None = None
    removeEdges: list[str] | None = None
    updateNodes: list[Node] | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    graphs: int
    uptime_seconds: float
