from __future__ import annotations

import numpy as np

from app.adapters.sample import SampleAdapter
from app.models.graph import GraphData
from app.services.analytics import analyze, shortest_path, top_by_centrality
from app.services.layout import force_layout_3d, layered_layout
from app.services.lod import backbone, community_overview
from tests.conftest import tiny_graph


def test_bridge_node_tops_betweenness():
    """'d' is the only path between the two triangles, so it must rank first."""
    result = analyze(tiny_graph())
    ranked = sorted(result.metrics.items(), key=lambda kv: kv[1].betweenness, reverse=True)
    assert ranked[0][0] == "d"
    assert result.metrics["d"].betweenness > result.metrics["a"].betweenness


def test_communities_split_the_two_triangles():
    result = analyze(tiny_graph())
    communities = result.communities
    assert communities["a"] == communities["b"] == communities["c"]
    assert communities["e"] == communities["f"] == communities["g"]
    assert communities["a"] != communities["e"]
    assert result.insights.modularity > 0.2


def test_insights_shape():
    insights = analyze(tiny_graph()).insights
    assert insights.node_count == 7
    assert insights.edge_count == 8
    assert insights.components == 1
    assert insights.diameter_estimate >= 3
    assert insights.hubs and insights.bridges
    assert insights.approximate is False


def test_empty_graph_does_not_explode():
    result = analyze(GraphData(nodes=[], edges=[]))
    assert result.insights.node_count == 0
    assert result.metrics == {}


def test_shortest_path_and_missing_path():
    assert shortest_path(tiny_graph(), "a", "g") == ["a", "c", "d", "e", "g"] or shortest_path(
        tiny_graph(), "a", "g"
    ) == ["a", "b", "c", "d", "e", "g"]
    assert shortest_path(tiny_graph(), "a", "zz") == []


def test_top_by_centrality_keeps_the_hubs():
    data = _sample(400)
    reduced = top_by_centrality(data, 50)
    assert len(reduced.nodes) == 50
    # Every retained edge must still have both endpoints present.
    ids = {n.id for n in reduced.nodes}
    assert all(e.source in ids and e.target in ids for e in reduced.edges)


def test_force_layout_is_deterministic_and_bounded():
    data = _sample(300)
    first = force_layout_3d(data, iterations=60, seed=7)
    second = force_layout_3d(data, iterations=60, seed=7)
    assert np.allclose(first.positions, second.positions)
    assert np.isfinite(first.positions).all()
    # Positions are normalised into the requested scale.
    assert np.abs(first.positions).max() <= 520.0 + 1e-6
    assert first.positions.shape == (len(data.nodes), 3)


def test_force_layout_separates_disconnected_nodes():
    data = _sample(200)
    result = force_layout_3d(data, iterations=120, seed=1)
    # No two nodes should end up in exactly the same place.
    unique = np.unique(np.round(result.positions, 3), axis=0)
    assert unique.shape[0] > len(data.nodes) * 0.95


def test_layered_layout_uses_discrete_levels():
    data = _sample(150)
    result = layered_layout(data)
    ys = np.unique(np.round(result.positions[:, 1], 4))
    assert 1 < ys.size < len(data.nodes)


def test_lod_overview_is_smaller_than_the_graph():
    data = _sample(500)
    analytics = analyze(data)
    overview = community_overview(data, analytics)
    mid = backbone(data, analytics)
    assert len(overview.nodes) < len(mid.nodes) < len(data.nodes)
    # Overview edges only connect overview nodes.
    ids = {n.id for n in overview.nodes}
    assert all(e.source in ids and e.target in ids for e in overview.edges)


def test_two_dimensional_layout_is_flat():
    result = force_layout_3d(_sample(120), iterations=80, dimensions=2)
    assert np.abs(result.positions[:, 2]).max() < 1.0


def _sample(size: int) -> GraphData:
    import asyncio

    adapter = SampleAdapter("t", {"size": size, "domains": 4, "seed": 3})
    return asyncio.run(adapter.fetch())
