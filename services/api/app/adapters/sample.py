"""Synthetic sample graph.

Structurally honest rather than random: preferential attachment inside domains
gives a heavy-tailed degree distribution, sparse hub-to-hub links between
domains create genuine bridges, and triangle closure gives a non-zero clustering
coefficient. That means the analytics endpoints have something real to find,
which is the only way to tell whether they work.
"""

from __future__ import annotations

import random
from typing import Any

from app.adapters.base import GraphAdapter
from app.models.graph import Edge, GraphData, Node

DOMAINS = [
    "Platform",
    "Data",
    "Security",
    "Product",
    "Research",
    "Operations",
    "Finance",
    "Customer",
]
TYPES = ["Service", "Dataset", "Team", "Person", "Policy", "Concept", "Document"]
RELATIONS = ["depends_on", "owns", "produces", "governs", "references", "member_of", "derived_from"]
NOUNS = [
    "Ledger",
    "Gateway",
    "Index",
    "Registry",
    "Pipeline",
    "Vault",
    "Catalog",
    "Router",
    "Scheduler",
    "Broker",
    "Warehouse",
    "Sentinel",
    "Atlas",
    "Beacon",
    "Compass",
    "Forge",
    "Harbor",
    "Lattice",
    "Meridian",
    "Nexus",
    "Orbit",
    "Prism",
    "Quarry",
    "Relay",
    "Signal",
    "Summit",
    "Tidal",
    "Vector",
    "Willow",
    "Zenith",
    "Anchor",
    "Cascade",
]
QUALIFIERS = [
    "Core",
    "Edge",
    "Realtime",
    "Batch",
    "Regional",
    "Global",
    "Internal",
    "Partner",
    "Legacy",
    "Next",
    "Unified",
    "Shared",
]


class SampleAdapter(GraphAdapter):
    kind = "sample"

    def __init__(
        self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = False
    ):
        super().__init__(graph_id, options, directed)
        self.size = int(self.options.get("size", 1200))
        self.domain_count = min(int(self.options.get("domains", 6)), len(DOMAINS))
        self.cross_rate = float(self.options.get("cross_domain_rate", 0.06))
        self.seed = int(self.options.get("seed", 20260908))

    async def fetch(self) -> GraphData:
        rng = random.Random(self.seed)
        nodes: list[Node] = []
        domain_members: list[list[int]] = [[] for _ in range(self.domain_count)]

        for i in range(self.size):
            domain = rng.randrange(self.domain_count)
            # Bias toward the first few types so the graph is mostly services
            # and datasets, the way real infrastructure graphs are.
            node_type = TYPES[min(len(TYPES) - 1, int(rng.random() ** 1.6 * len(TYPES)))]
            if node_type == "Person":
                label = f"{rng.choice('ABCDEJKMNRST')}. {rng.choice(NOUNS)}"
            else:
                suffix = " Set" if node_type == "Dataset" else ""
                label = f"{rng.choice(QUALIFIERS)} {rng.choice(NOUNS)}{suffix}"

            group_noun = "Guild" if node_type == "Person" else "Team"
            nodes.append(
                Node(
                    id=f"n{i}",
                    label=label,
                    type=node_type,
                    group=domain,
                    weight=1,
                    meta={
                        "domain": DOMAINS[domain],
                        "owner": f"{DOMAINS[domain]} {group_noun}",
                        "criticality": rng.choice(["low", "medium", "high"]),
                    },
                )
            )
            domain_members[domain].append(i)

        degree = [0] * self.size
        seen: set[tuple[int, int]] = set()
        edges: list[Edge] = []

        def add_edge(a: int, b: int, rel: str | None = None) -> None:
            if a == b:
                return
            key = (a, b) if a < b else (b, a)
            if key in seen:
                return
            seen.add(key)
            edges.append(
                Edge(
                    id=f"e{len(edges)}",
                    source=f"n{a}",
                    target=f"n{b}",
                    type=rel or rng.choice(RELATIONS),
                    weight=round(0.6 + rng.random() * 0.9, 3),
                )
            )
            degree[a] += 1
            degree[b] += 1

        for members in domain_members:
            if len(members) < 2:
                continue
            add_edge(members[0], members[1], "depends_on")
            for i in range(2, len(members)):
                attachments = (
                    1 + (1 if rng.random() < 0.28 else 0) + (1 if rng.random() < 0.08 else 0)
                )
                for _ in range(attachments):
                    total = sum(degree[members[k]] + 1 for k in range(i))
                    pick = rng.random() * total
                    chosen = members[0]
                    for k in range(i):
                        pick -= degree[members[k]] + 1
                        if pick <= 0:
                            chosen = members[k]
                            break
                    add_edge(members[i], chosen)
            for _ in range(int(len(members) * 0.18)):
                add_edge(rng.choice(members), rng.choice(members), "references")

        hubs = [sorted(m, key=lambda i: degree[i], reverse=True)[:6] for m in domain_members]
        for _ in range(int(len(edges) * self.cross_rate)):
            d1 = rng.randrange(self.domain_count)
            d2 = (d1 + 1 + rng.randrange(max(1, self.domain_count - 1))) % self.domain_count
            if not domain_members[d1] or not domain_members[d2]:
                continue
            a = (
                rng.choice(hubs[d1] or domain_members[d1])
                if rng.random() < 0.75
                else rng.choice(domain_members[d1])
            )
            b = (
                rng.choice(hubs[d2] or domain_members[d2])
                if rng.random() < 0.75
                else rng.choice(domain_members[d2])
            )
            add_edge(a, b, "references")

        for i, node in enumerate(nodes):
            node.weight = 1 + degree[i]
            if node.meta is not None:
                node.meta["connections"] = degree[i]

        return GraphData(nodes=nodes, edges=edges)
