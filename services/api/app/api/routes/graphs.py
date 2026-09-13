"""Graph endpoints.

The contract the `RestAdapter` in `@kg3d/core` speaks. Every response is shaped
so the client can hand it straight to the renderer with no translation.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.adapters.base import GraphAdapter
from app.adapters.memory import MemoryAdapter
from app.adapters.registry import registry
from app.api.deps import (
    cache_key,
    enforce_ingest_limit,
    get_adapter,
    get_cache,
    require_write_access,
    reset_cache,
)
from app.config import GraphSource, Settings, get_settings
from app.core.cache import TTLCache
from app.models.graph import (
    GraphData,
    GraphInsights,
    GraphPatch,
    GraphSummary,
    LayoutResponse,
    LevelSummary,
    Node,
    NodeMetrics,
    PathResponse,
    RankedNode,
    SearchResponse,
)
from app.services import lod
from app.services.analytics import (
    AnalyticsResult,
    analyze,
    attach_metrics,
    degree_histogram,
    rank_nodes,
    shortest_path,
    top_by_centrality,
)
from app.services.layout import apply_positions, force_layout_3d, layered_layout

router = APIRouter(prefix="/graphs", tags=["graphs"])


async def _analytics(
    adapter: GraphAdapter,
    cache: TTLCache,
    settings: Settings,
) -> AnalyticsResult:
    data = await adapter.load()
    key = cache_key("analytics", adapter.graph_id, len(data.nodes), len(data.edges))
    return cache.get_or_compute(
        key,
        lambda: analyze(
            data,
            adapter.directed,
            settings.betweenness_exact_threshold,
            settings.betweenness_samples,
        ),
    )


@router.get("", response_model=list[GraphSummary])
async def list_graphs() -> list[GraphSummary]:
    """Every registered graph, with its size."""
    return await registry.summaries()


@router.post(
    "",
    response_model=GraphSummary,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_write_access), Depends(enforce_ingest_limit)],
)
async def create_graph(
    graph_id: str = Query(..., alias="id", description="Identifier to register the graph under"),
    name: str = Query("", description="Human readable name"),
    directed: bool = Query(False),
    data: GraphData = Body(...),
) -> GraphSummary:
    """Push a graph into the service as an in-memory source.

    Useful for pipelines that already compute a graph and just need it rendered,
    and for embedding the service in a notebook.
    """
    source = GraphSource(
        id=graph_id,
        name=name or graph_id,
        kind="memory",
        directed=directed,
        options={"data": data.model_dump()},
    )
    registry.register(source)
    reset_cache()
    return GraphSummary(
        id=graph_id,
        name=source.name,
        kind="memory",
        directed=directed,
        node_count=len(data.nodes),
        edge_count=len(data.edges),
    )


@router.get("/{graph_id}", response_model=GraphData)
async def get_graph(
    adapter: GraphAdapter = Depends(get_adapter),
    cache: TTLCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
    metrics: bool = Query(True, description="Fold analytics into each node"),
    layout: Literal["none", "force3d", "layered"] = Query(
        "none", description="Precompute node positions server-side"
    ),
    limit: int | None = Query(
        None,
        ge=1,
        description="Return only the most central `limit` nodes. Omit for the whole graph.",
    ),
    level: int | None = Query(
        None,
        ge=0,
        le=2,
        description="Level of detail: 0 = community overview, 1 = backbone, 2 = full",
    ),
) -> GraphData:
    """The main payload: nodes, edges, and optionally analytics and positions."""
    data = await adapter.load()

    if len(data.nodes) > settings.max_nodes_per_response and limit is None and level is None:
        raise HTTPException(
            # Literal 413: starlette renamed this constant, and pinning to
            # either spelling breaks on the other side of that change.
            status_code=413,
            detail=(
                f"graph has {len(data.nodes)} nodes, above the "
                f"{settings.max_nodes_per_response} limit. Request a `level`, a `limit`, "
                "or explore by neighbourhood."
            ),
        )

    analytics = await _analytics(adapter, cache, settings) if (metrics or level is not None) else None

    if level is not None and analytics is not None:
        data = lod.level(data, analytics, level)
    elif limit is not None:
        data = top_by_centrality(data, limit, adapter.directed)

    # Work on a copy: the adapter caches the loaded graph and must not be
    # mutated by per-request enrichment.
    result = GraphData(**data.model_dump())

    if metrics and analytics is not None and level is None:
        result = attach_metrics(result, analytics)

    if layout != "none":
        computed = (
            layered_layout(result, settings.layout_scale)
            if layout == "layered"
            else force_layout_3d(
                result, settings.layout_iterations, settings.layout_scale
            )
        )
        result = apply_positions(result, computed)

    return result


@router.get("/{graph_id}/neighborhood", response_model=GraphData)
async def get_neighborhood(
    node_id: str = Query(..., description="Seed node"),
    depth: int = Query(1, ge=1, le=5),
    limit: int = Query(250, ge=1, le=5000),
    edge_types: str | None = Query(None, description="Comma-separated relation types"),
    adapter: GraphAdapter = Depends(get_adapter),
) -> GraphData:
    """Breadth-first expansion around a node — the progressive exploration path."""
    types = [t.strip() for t in edge_types.split(",")] if edge_types else None
    data = await adapter.neighborhood(node_id, depth=depth, limit=limit, edge_types=types)
    if not data.nodes:
        raise HTTPException(status_code=404, detail=f"node '{node_id}' not found")
    return data


@router.get("/{graph_id}/search", response_model=SearchResponse)
async def search_graph(
    q: str = Query(..., min_length=1),
    limit: int = Query(25, ge=1, le=200),
    adapter: GraphAdapter = Depends(get_adapter),
) -> SearchResponse:
    nodes = await adapter.search(q, limit)
    return SearchResponse(nodes=nodes, total=len(nodes))


@router.get("/{graph_id}/path", response_model=PathResponse)
async def get_path(
    from_id: str = Query(..., alias="from"),
    to_id: str = Query(..., alias="to"),
    adapter: GraphAdapter = Depends(get_adapter),
) -> PathResponse:
    """Shortest path between two nodes — 'how are these two things related?'."""
    data = await adapter.load()
    path = shortest_path(data, from_id, to_id, adapter.directed)
    lookup = {node.id: node for node in data.nodes}
    return PathResponse(
        path=path,
        length=max(0, len(path) - 1),
        found=bool(path),
        nodes=[lookup[node_id] for node_id in path if node_id in lookup],
    )


@router.get("/{graph_id}/analytics", response_model=GraphInsights)
async def get_analytics(
    adapter: GraphAdapter = Depends(get_adapter),
    cache: TTLCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> GraphInsights:
    """Structural summary: hubs, bridges, clusters, density, modularity."""
    return (await _analytics(adapter, cache, settings)).insights


@router.get("/{graph_id}/nodes/{node_id}/metrics", response_model=NodeMetrics)
async def get_node_metrics(
    node_id: str,
    adapter: GraphAdapter = Depends(get_adapter),
    cache: TTLCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> NodeMetrics:
    analytics = await _analytics(adapter, cache, settings)
    metrics = analytics.metrics.get(node_id)
    if metrics is None:
        raise HTTPException(status_code=404, detail=f"node '{node_id}' not found")
    return metrics


@router.get("/{graph_id}/rank", response_model=list[RankedNode])
async def get_ranking(
    metric: Literal["degree", "pagerank", "betweenness", "closeness", "clustering"] = Query(
        "pagerank"
    ),
    limit: int = Query(20, ge=1, le=200),
    adapter: GraphAdapter = Depends(get_adapter),
) -> list[RankedNode]:
    data = await adapter.load()
    return rank_nodes(data, metric, limit, adapter.directed)


@router.get("/{graph_id}/histogram")
async def get_histogram(adapter: GraphAdapter = Depends(get_adapter)) -> list[dict[str, float]]:
    """Log-spaced degree distribution — shows scale-free structure at a glance."""
    return degree_histogram(await adapter.load())


@router.get("/{graph_id}/layout", response_model=LayoutResponse)
async def get_layout(
    algorithm: Literal["force3d", "layered"] = Query("force3d"),
    iterations: int | None = Query(None, ge=10, le=2000),
    dimensions: int = Query(3, ge=2, le=3),
    adapter: GraphAdapter = Depends(get_adapter),
    cache: TTLCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> LayoutResponse:
    """Positions only, so a client can reuse a layout without refetching nodes."""
    data = await adapter.load()
    steps = iterations or settings.layout_iterations
    key = cache_key("layout", adapter.graph_id, algorithm, steps, dimensions, len(data.nodes))

    def compute():
        if algorithm == "layered":
            return layered_layout(data, settings.layout_scale)
        return force_layout_3d(
            data, steps, settings.layout_scale, dimensions=dimensions
        )

    result = cache.get_or_compute(key, compute)
    return LayoutResponse(
        algorithm=result.algorithm,
        dimensions=dimensions,
        ids=result.ids,
        positions=[[float(v) for v in row] for row in result.positions],
        iterations=result.iterations,
        duration_ms=round(result.duration_ms, 2),
    )


@router.get("/{graph_id}/levels", response_model=list[LevelSummary])
async def get_levels(
    adapter: GraphAdapter = Depends(get_adapter),
    cache: TTLCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
) -> list[LevelSummary]:
    """What each level of detail would cost to render."""
    data = await adapter.load()
    analytics = await _analytics(adapter, cache, settings)
    return lod.describe_levels(data, analytics)


@router.get("/{graph_id}/types", response_model=dict[str, int])
async def get_types(adapter: GraphAdapter = Depends(get_adapter)) -> dict[str, int]:
    """Node type histogram — drives legends and type filters."""
    data = await adapter.load()
    counts: dict[str, int] = {}
    for node in data.nodes:
        key = node.type or "Node"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: kv[1], reverse=True))


@router.patch(
    "/{graph_id}",
    response_model=GraphSummary,
    dependencies=[Depends(require_write_access), Depends(enforce_ingest_limit)],
)
async def patch_graph(
    patch: GraphPatch,
    adapter: GraphAdapter = Depends(get_adapter),
) -> GraphSummary:
    """Mutate an in-memory graph and broadcast the change to live viewers."""
    if not isinstance(adapter, MemoryAdapter):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"graph '{adapter.graph_id}' is read-only (adapter: {adapter.kind})",
        )
    data = adapter.apply_patch(patch)
    reset_cache()

    from app.api.routes.stream import broadcast

    await broadcast(adapter.graph_id, patch)

    return GraphSummary(
        id=adapter.graph_id,
        name=registry.name_of(adapter.graph_id),
        kind=adapter.kind,
        directed=adapter.directed,
        node_count=len(data.nodes),
        edge_count=len(data.edges),
    )


@router.post(
    "/{graph_id}/refresh",
    response_model=GraphSummary,
    dependencies=[Depends(require_write_access)],
)
async def refresh_graph(adapter: GraphAdapter = Depends(get_adapter)) -> GraphSummary:
    """Drop the adapter's cached snapshot and reload from the source."""
    data = await adapter.load(refresh=True)
    reset_cache()
    return GraphSummary(
        id=adapter.graph_id,
        name=registry.name_of(adapter.graph_id),
        kind=adapter.kind,
        directed=adapter.directed,
        node_count=len(data.nodes),
        edge_count=len(data.edges),
    )


@router.get("/{graph_id}/nodes/{node_id}", response_model=Node)
async def get_node(node_id: str, adapter: GraphAdapter = Depends(get_adapter)) -> Node:
    data = await adapter.load()
    for node in data.nodes:
        if node.id == node_id:
            return node
    raise HTTPException(status_code=404, detail=f"node '{node_id}' not found")
