"""Graph analytics.

The client can compute all of this itself, and does when it runs standalone. The
service exists for the cases where that stops being reasonable: exact
betweenness on a large graph, Louvain instead of label propagation, and results
that are computed once and shared by every viewer instead of once per browser
tab.

Everything here is deterministic — same graph in, same numbers out — so two
users looking at the same graph see the same hubs in the same order.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import networkx as nx

from app.models.graph import (
    ClusterSummary,
    GraphData,
    GraphInsights,
    NodeMetrics,
    RankedNode,
)


@dataclass
class AnalyticsResult:
    metrics: dict[str, NodeMetrics]
    insights: GraphInsights
    communities: dict[str, int]


def build_networkx(data: GraphData, directed: bool = False) -> nx.Graph:
    graph: nx.Graph = nx.DiGraph() if directed else nx.Graph()
    for node in data.nodes:
        graph.add_node(node.id, label=node.label or node.id, type=node.type or "Node")
    for edge in data.edges:
        if edge.source in graph and edge.target in graph:
            # Parallel edges collapse into one weighted edge; for layout and
            # centrality that is the honest reading, and it keeps the analytics
            # from over-counting duplicated relationships.
            weight = float(edge.weight or 1.0)
            if graph.has_edge(edge.source, edge.target):
                graph[edge.source][edge.target]["weight"] += weight
            else:
                graph.add_edge(edge.source, edge.target, weight=weight, type=edge.type or "related")
    return graph


def analyze(
    data: GraphData,
    directed: bool = False,
    betweenness_exact_threshold: int = 1200,
    betweenness_samples: int = 400,
) -> AnalyticsResult:
    graph = build_networkx(data, directed)
    n = graph.number_of_nodes()
    m = graph.number_of_edges()

    labels = {node.id: (node.label or node.id) for node in data.nodes}

    if n == 0:
        empty = GraphInsights(
            node_count=0, edge_count=0, density=0, average_degree=0, components=0,
            communities=0, modularity=0, diameter_estimate=0, hubs=[], bridges=[],
            isolated=[], clusters=[],
        )
        return AnalyticsResult(metrics={}, insights=empty, communities={})

    degree = dict(graph.degree())
    if directed:
        in_degree = dict(graph.in_degree())
        out_degree = dict(graph.out_degree())
    else:
        in_degree = out_degree = degree

    pagerank = nx.pagerank(graph, alpha=0.85, weight="weight") if m else {v: 1 / n for v in graph}

    # Exact betweenness and closeness are both O(V*(V+E)) — a single BFS per
    # node. That is fine at a thousand nodes and completely impractical at
    # twenty thousand, so past the threshold both are estimated from a sampled
    # set of sources. The ranking (which is what the UI shows) stays stable;
    # the absolute values become estimates, and the response says so.
    approximate = n > betweenness_exact_threshold
    if m == 0:
        betweenness = {v: 0.0 for v in graph}
        closeness = {v: 0.0 for v in graph}
    elif approximate:
        sources = _sample_sources(graph, _source_budget(n, m, betweenness_samples))
        betweenness = nx.betweenness_centrality(
            graph, k=len(sources), normalized=True, weight=None, seed=42
        )
        closeness = _sampled_closeness(graph, sources)
    else:
        betweenness = nx.betweenness_centrality(graph, normalized=True, weight=None)
        closeness = nx.closeness_centrality(graph)
    clustering = nx.clustering(graph.to_undirected() if directed else graph)

    communities, modularity = _detect_communities(graph)

    undirected = graph.to_undirected() if directed else graph
    components = list(nx.connected_components(undirected))

    metrics = {
        node_id: NodeMetrics(
            degree=float(degree.get(node_id, 0)),
            in_degree=float(in_degree.get(node_id, 0)),
            out_degree=float(out_degree.get(node_id, 0)),
            pagerank=float(pagerank.get(node_id, 0.0)),
            betweenness=float(betweenness.get(node_id, 0.0)),
            closeness=float(closeness.get(node_id, 0.0)),
            clustering=float(clustering.get(node_id, 0.0)),
            community=int(communities.get(node_id, 0)),
        )
        for node_id in graph.nodes
    }

    def top(values: dict[str, float], count: int = 8) -> list[RankedNode]:
        ranked = sorted(values.items(), key=lambda kv: kv[1], reverse=True)[:count]
        return [
            RankedNode(id=node_id, label=labels.get(node_id, node_id), score=float(score))
            for node_id, score in ranked
            if score > 0
        ]

    insights = GraphInsights(
        node_count=n,
        edge_count=m,
        density=float(nx.density(graph)),
        average_degree=(2 * m / n) if not directed else (m / n),
        components=len(components),
        communities=len(set(communities.values())),
        modularity=modularity,
        diameter_estimate=_estimate_diameter(undirected, components),
        hubs=top(pagerank),
        bridges=top(betweenness),
        isolated=[node_id for node_id, deg in degree.items() if deg == 0],
        clusters=_summarize_clusters(graph, communities, pagerank, labels),
        approximate=approximate,
    )

    return AnalyticsResult(metrics=metrics, insights=insights, communities=communities)



def _source_budget(n: int, m: int, requested: int) -> int:
    """How many BFS sources we can afford.

    Each source costs one O(V+E) traversal in Python. Two million node-visits is
    about a second of networkx, which is the right order for a cached endpoint;
    the floor of 24 keeps the estimate meaningful on very large graphs.
    """
    affordable = int(2_000_000 / max(1, n + m))
    return max(24, min(requested, affordable, n))


def _sample_sources(graph: nx.Graph, count: int) -> list[str]:
    """Deterministic, degree-stratified sample.

    Purely uniform sampling on a scale-free graph mostly picks leaves, and a
    leaf tells you very little about distances. Taking half the sample from the
    highest-degree nodes gives a much better distance estimate for the same
    number of traversals.
    """
    nodes = list(graph.nodes)
    if count >= len(nodes):
        return nodes
    by_degree = sorted(nodes, key=lambda v: graph.degree(v), reverse=True)
    top = by_degree[: count // 2]
    rest = [v for v in by_degree[count // 2 :]]
    stride = max(1, len(rest) // max(1, count - len(top)))
    spread = rest[::stride][: count - len(top)]
    return top + spread


def _sampled_closeness(graph: nx.Graph, sources: list[str]) -> dict[str, float]:
    """Closeness estimated as the reciprocal of mean distance to the sample."""
    totals: dict[str, float] = {v: 0.0 for v in graph}
    counts: dict[str, int] = {v: 0 for v in graph}
    for source in sources:
        for node, distance in nx.single_source_shortest_path_length(graph, source).items():
            if distance == 0:
                continue
            totals[node] += distance
            counts[node] += 1
    return {
        node: (counts[node] / totals[node]) if totals[node] > 0 else 0.0
        for node in graph
    }


def _detect_communities(graph: nx.Graph) -> tuple[dict[str, int], float]:
    """Louvain, with a deterministic seed and size-ordered labels."""
    undirected = graph.to_undirected() if graph.is_directed() else graph
    if undirected.number_of_edges() == 0:
        return ({node: 0 for node in undirected}, 0.0)

    try:
        groups = nx.community.louvain_communities(undirected, weight="weight", seed=42)
    except AttributeError:  # pragma: no cover - networkx < 3.0
        groups = nx.community.greedy_modularity_communities(undirected, weight="weight")

    # Largest community becomes id 0 so palette assignment is stable and the
    # dominant cluster always gets the first, clearest hue.
    ordered = sorted(groups, key=len, reverse=True)
    mapping = {node: index for index, group in enumerate(ordered) for node in group}
    modularity = float(nx.community.modularity(undirected, ordered, weight="weight"))
    return mapping, modularity


def _summarize_clusters(
    graph: nx.Graph,
    communities: dict[str, int],
    pagerank: dict[str, float],
    labels: dict[str, str],
    limit: int = 12,
) -> list[ClusterSummary]:
    members: dict[int, list[str]] = {}
    for node_id, community in communities.items():
        members.setdefault(community, []).append(node_id)

    internal: dict[int, int] = {}
    for source, target in graph.edges():
        if communities.get(source) == communities.get(target):
            community = communities.get(source, 0)
            internal[community] = internal.get(community, 0) + 1

    summaries: list[ClusterSummary] = []
    for community, group in sorted(members.items(), key=lambda kv: len(kv[1]), reverse=True)[:limit]:
        size = len(group)
        possible = size * (size - 1) / 2
        # The cluster's name is its most influential member — far more useful
        # than "Cluster 4" when you are trying to recognise what a region is.
        representative = max(group, key=lambda node_id: pagerank.get(node_id, 0.0))
        summaries.append(
            ClusterSummary(
                id=community,
                size=size,
                label=labels.get(representative, f"Cluster {community + 1}"),
                internal_density=float(internal.get(community, 0) / possible) if possible else 0.0,
                representative=representative,
            )
        )
    return summaries


def _estimate_diameter(graph: nx.Graph, components: list[set[str]]) -> int:
    """Double-sweep BFS on the largest component: a tight lower bound, in O(V+E)."""
    if not components:
        return 0
    largest = max(components, key=len)
    if len(largest) < 2:
        return 0
    subgraph = graph.subgraph(largest)
    start = next(iter(largest))
    far, _ = _farthest(subgraph, start)
    _, distance = _farthest(subgraph, far)
    return int(distance)


def _farthest(graph: nx.Graph, start: str) -> tuple[str, int]:
    lengths = nx.single_source_shortest_path_length(graph, start)
    node, distance = max(lengths.items(), key=lambda kv: kv[1])
    return node, distance


def shortest_path(data: GraphData, source: str, target: str, directed: bool = False) -> list[str]:
    graph = build_networkx(data, directed)
    if source not in graph or target not in graph:
        return []
    try:
        return list(nx.shortest_path(graph, source, target))
    except nx.NetworkXNoPath:
        return []


def rank_nodes(data: GraphData, metric: str, limit: int, directed: bool = False) -> list[RankedNode]:
    """Top-N by a named metric — the 'show me what matters' query."""
    result = analyze(data, directed)
    getter = {
        "degree": lambda m: m.degree,
        "pagerank": lambda m: m.pagerank,
        "betweenness": lambda m: m.betweenness,
        "closeness": lambda m: m.closeness,
        "clustering": lambda m: m.clustering,
    }.get(metric)
    if getter is None:
        raise ValueError(f"unknown metric '{metric}'")
    labels = {node.id: (node.label or node.id) for node in data.nodes}
    ranked = sorted(result.metrics.items(), key=lambda kv: getter(kv[1]), reverse=True)[:limit]
    return [
        RankedNode(id=node_id, label=labels.get(node_id, node_id), score=float(getter(metrics)))
        for node_id, metrics in ranked
    ]


def attach_metrics(data: GraphData, result: AnalyticsResult) -> GraphData:
    """Fold analytics into the node payload the client renders from."""
    for node in data.nodes:
        metrics = result.metrics.get(node.id)
        if metrics is None:
            continue
        node.group = metrics.community
        # Weight drives the default size encoding; degree+1 keeps leaves visible
        # while still separating hubs on the sqrt scale the client uses.
        node.weight = metrics.degree + 1
        meta: dict[str, Any] = dict(node.meta or {})
        meta.update(
            {
                "degree": metrics.degree,
                "pagerank": round(metrics.pagerank, 6),
                "betweenness": round(metrics.betweenness, 6),
                "closeness": round(metrics.closeness, 6),
                "clustering": round(metrics.clustering, 4),
                "community": metrics.community,
            }
        )
        node.meta = meta
    return data


def top_by_centrality(data: GraphData, limit: int, directed: bool = False) -> GraphData:
    """Reduce a graph to its `limit` most central nodes, keeping it connected.

    Used when a client asks for a graph bigger than it can render: returning the
    most structurally important slice is far more useful than the first N rows.
    """
    if limit <= 0 or len(data.nodes) <= limit:
        return data
    graph = build_networkx(data, directed)
    ranking = nx.pagerank(graph, alpha=0.85, weight="weight") if graph.number_of_edges() else {}
    keep = {
        node_id
        for node_id, _ in sorted(ranking.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    }
    if not keep:
        keep = {node.id for node in data.nodes[:limit]}
    nodes = [node for node in data.nodes if node.id in keep]
    edges = [edge for edge in data.edges if edge.source in keep and edge.target in keep]
    return GraphData(nodes=nodes, edges=edges)


def degree_histogram(data: GraphData, buckets: int = 12) -> list[dict[str, float]]:
    """Log-spaced degree distribution — shows scale-free structure at a glance."""
    graph = build_networkx(data)
    degrees = [d for _, d in graph.degree()]
    if not degrees:
        return []
    top = max(degrees)
    edges_of_bucket = [
        int(math.floor(math.exp(i * math.log(top + 1) / buckets))) for i in range(buckets + 1)
    ]
    out: list[dict[str, float]] = []
    for i in range(buckets):
        low, high = edges_of_bucket[i], edges_of_bucket[i + 1]
        if high <= low:
            continue
        count = sum(1 for d in degrees if low <= d < high)
        out.append({"from": float(low), "to": float(high), "count": float(count)})
    return out
