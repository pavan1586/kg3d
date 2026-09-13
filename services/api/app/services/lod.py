"""Level-of-detail.

A million-edge graph rendered in full is a grey sphere. The useful move is to
show the *shape* first and the detail on demand: level 0 is one node per
community with weighted links between them, level 1 keeps each community's
backbone, level 2 is everything.

This is what makes "show work for any level of graph" real rather than a claim:
the client asks for the level it can render, and drills down by neighbourhood.
"""

from __future__ import annotations

from app.models.graph import Edge, GraphData, LevelSummary, Node
from app.services.analytics import AnalyticsResult


def community_overview(data: GraphData, analytics: AnalyticsResult) -> GraphData:
    """Level 0 — one node per community, sized by membership."""
    members: dict[int, list[Node]] = {}
    for node in data.nodes:
        community = analytics.communities.get(node.id, 0)
        members.setdefault(community, []).append(node)

    cluster_labels = {c.id: c.label for c in analytics.insights.clusters}

    nodes = [
        Node(
            id=f"c{community}",
            label=cluster_labels.get(community, f"Cluster {community + 1}"),
            type="Cluster",
            group=community,
            weight=float(len(group)),
            meta={
                "members": len(group),
                "types": _type_breakdown(group),
                "representative": cluster_labels.get(community, ""),
            },
        )
        for community, group in sorted(members.items(), key=lambda kv: len(kv[1]), reverse=True)
    ]

    # Aggregate every cross-community edge into one weighted link, so edge
    # thickness reads as "how coupled are these two areas".
    weights: dict[tuple[int, int], float] = {}
    for edge in data.edges:
        a = analytics.communities.get(edge.source)
        b = analytics.communities.get(edge.target)
        if a is None or b is None or a == b:
            continue
        key = (a, b) if a < b else (b, a)
        weights[key] = weights.get(key, 0.0) + float(edge.weight or 1.0)

    edges = [
        Edge(id=f"c{a}-c{b}", source=f"c{a}", target=f"c{b}", type="coupling", weight=weight)
        for (a, b), weight in sorted(weights.items(), key=lambda kv: kv[1], reverse=True)
    ]
    return GraphData(nodes=nodes, edges=edges)


def backbone(data: GraphData, analytics: AnalyticsResult, keep_ratio: float = 0.25) -> GraphData:
    """Level 1 — the most central nodes of every community, plus their edges.

    Sampling *per community* rather than globally matters: a global top-N drops
    small communities entirely, and a map that silently loses a region is worse
    than a coarse one.
    """
    by_community: dict[int, list[str]] = {}
    for node in data.nodes:
        by_community.setdefault(analytics.communities.get(node.id, 0), []).append(node.id)

    keep: set[str] = set()
    for _, group in by_community.items():
        ranked = sorted(
            group,
            key=lambda node_id: analytics.metrics[node_id].pagerank if node_id in analytics.metrics else 0,
            reverse=True,
        )
        take = max(1, int(len(ranked) * keep_ratio))
        keep.update(ranked[:take])

    nodes = [node for node in data.nodes if node.id in keep]
    edges = [edge for edge in data.edges if edge.source in keep and edge.target in keep]
    return GraphData(nodes=nodes, edges=edges)


def describe_levels(data: GraphData, analytics: AnalyticsResult) -> list[LevelSummary]:
    overview = community_overview(data, analytics)
    mid = backbone(data, analytics)
    return [
        LevelSummary(
            level=0,
            node_count=len(overview.nodes),
            edge_count=len(overview.edges),
            description="One node per community, edges weighted by coupling.",
        ),
        LevelSummary(
            level=1,
            node_count=len(mid.nodes),
            edge_count=len(mid.edges),
            description="Top 25% of each community by influence — the backbone.",
        ),
        LevelSummary(
            level=2,
            node_count=len(data.nodes),
            edge_count=len(data.edges),
            description="Full graph.",
        ),
    ]


def level(data: GraphData, analytics: AnalyticsResult, index: int) -> GraphData:
    if index <= 0:
        return community_overview(data, analytics)
    if index == 1:
        return backbone(data, analytics)
    return data


def _type_breakdown(nodes: list[Node]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for node in nodes:
        key = node.type or "Node"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:5])
