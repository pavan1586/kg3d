from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.adapters.registry import registry
from app.api.deps import reset_cache
from app.config import GraphSource, get_settings
from app.main import create_app
from app.models.graph import Edge, GraphData, Node


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@pytest.fixture()
def client(settings):
    """A client over a small deterministic graph plus a writable memory graph."""
    app = create_app()
    with TestClient(app) as test_client:
        registry.register(
            GraphSource(id="tiny", name="Tiny", kind="memory", options={"data": tiny_graph().model_dump()})
        )
        reset_cache()
        yield test_client


def tiny_graph() -> GraphData:
    """Two triangles joined by a single bridge node.

    Small enough to reason about by hand, and structured enough that every
    analytic has a known right answer: 'd' is the only articulation point, so it
    must top betweenness; the two triangles must come out as two communities.
    """
    nodes = [Node(id=n, label=n.upper(), type="Concept", weight=1) for n in "abcdefg"]
    edges = [
        Edge(source="a", target="b"),
        Edge(source="b", target="c"),
        Edge(source="c", target="a"),
        Edge(source="c", target="d"),
        Edge(source="d", target="e"),
        Edge(source="e", target="f"),
        Edge(source="f", target="g"),
        Edge(source="g", target="e"),
    ]
    return GraphData(nodes=nodes, edges=edges)
