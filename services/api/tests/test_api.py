from __future__ import annotations


def test_health(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["graphs"] >= 1


def test_list_graphs_includes_the_demo(client):
    response = client.get("/api/v1/graphs")
    assert response.status_code == 200
    ids = {g["id"] for g in response.json()}
    assert "demo" in ids and "tiny" in ids


def test_get_graph_returns_nodes_and_edges(client):
    response = client.get("/api/v1/graphs/tiny")
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 7
    assert len(body["edges"]) == 8
    # Metrics are folded into meta by default.
    assert "pagerank" in body["nodes"][0]["meta"]


def test_get_graph_without_metrics(client):
    response = client.get("/api/v1/graphs/tiny", params={"metrics": False})
    assert response.status_code == 200
    node = response.json()["nodes"][0]
    assert node.get("meta") in (None, {}) or "pagerank" not in (node.get("meta") or {})


def test_server_side_layout_sets_positions(client):
    response = client.get("/api/v1/graphs/tiny", params={"layout": "force3d"})
    assert response.status_code == 200
    nodes = response.json()["nodes"]
    assert all(n["x"] is not None and n["z"] is not None for n in nodes)


def test_unknown_graph_is_404(client):
    assert client.get("/api/v1/graphs/nope").status_code == 404


def test_neighborhood_expansion(client):
    response = client.get(
        "/api/v1/graphs/tiny/neighborhood", params={"node_id": "d", "depth": 1}
    )
    assert response.status_code == 200
    ids = {n["id"] for n in response.json()["nodes"]}
    assert ids == {"c", "d", "e"}


def test_neighborhood_respects_limit(client):
    response = client.get(
        "/api/v1/graphs/tiny/neighborhood", params={"node_id": "d", "depth": 3, "limit": 4}
    )
    assert len(response.json()["nodes"]) <= 4


def test_search(client):
    response = client.get("/api/v1/graphs/tiny/search", params={"q": "a"})
    assert response.status_code == 200
    assert response.json()["total"] >= 1


def test_path_between_triangles(client):
    response = client.get("/api/v1/graphs/tiny/path", params={"from": "a", "to": "g"})
    body = response.json()
    assert body["found"] is True
    assert body["path"][0] == "a" and body["path"][-1] == "g"
    assert body["length"] == len(body["path"]) - 1
    assert len(body["nodes"]) == len(body["path"])


def test_path_to_unknown_node_is_not_found(client):
    body = client.get("/api/v1/graphs/tiny/path", params={"from": "a", "to": "zz"}).json()
    assert body["found"] is False and body["path"] == []


def test_analytics_endpoint(client):
    body = client.get("/api/v1/graphs/tiny/analytics").json()
    assert body["node_count"] == 7
    assert body["communities"] >= 2
    assert body["bridges"][0]["id"] == "d"


def test_node_metrics(client):
    body = client.get("/api/v1/graphs/tiny/nodes/d/metrics").json()
    assert body["degree"] == 2
    assert body["betweenness"] > 0


def test_node_metrics_404(client):
    assert client.get("/api/v1/graphs/tiny/nodes/zz/metrics").status_code == 404


def test_ranking(client):
    body = client.get("/api/v1/graphs/tiny/rank", params={"metric": "betweenness", "limit": 3}).json()
    assert body[0]["id"] == "d"
    assert len(body) == 3


def test_levels_describe_a_pyramid(client):
    body = client.get("/api/v1/graphs/demo/levels").json()
    assert [level["level"] for level in body] == [0, 1, 2]
    assert body[0]["node_count"] < body[1]["node_count"] < body[2]["node_count"]


def test_level_zero_returns_the_overview(client):
    body = client.get("/api/v1/graphs/demo", params={"level": 0}).json()
    assert all(node["type"] == "Cluster" for node in body["nodes"])
    assert len(body["nodes"]) < 100


def test_types_histogram(client):
    body = client.get("/api/v1/graphs/demo/types").json()
    assert sum(body.values()) == 1200


def test_layout_endpoint_returns_parallel_arrays(client):
    body = client.get("/api/v1/graphs/tiny/layout", params={"iterations": 40}).json()
    assert len(body["ids"]) == len(body["positions"]) == 7
    assert len(body["positions"][0]) == 3


def test_limit_returns_most_central_slice(client):
    body = client.get("/api/v1/graphs/demo", params={"limit": 100}).json()
    assert len(body["nodes"]) == 100


def test_create_and_patch_a_memory_graph(client):
    payload = {
        "nodes": [{"id": "x", "label": "X"}, {"id": "y", "label": "Y"}],
        "edges": [{"source": "x", "target": "y"}],
    }
    created = client.post("/api/v1/graphs", params={"id": "scratch"}, json=payload)
    assert created.status_code == 201
    assert created.json()["node_count"] == 2

    patched = client.patch(
        "/api/v1/graphs/scratch",
        json={"addNodes": [{"id": "z", "label": "Z"}], "addEdges": [{"source": "y", "target": "z"}]},
    )
    assert patched.status_code == 200
    assert patched.json()["node_count"] == 3
    assert patched.json()["edge_count"] == 2

    removed = client.patch("/api/v1/graphs/scratch", json={"removeNodes": ["y"]})
    # Removing y must also drop both edges that used it.
    assert removed.json()["node_count"] == 2
    assert removed.json()["edge_count"] == 0


def test_patching_a_read_only_graph_conflicts(client):
    response = client.patch("/api/v1/graphs/demo", json={"removeNodes": ["n0"]})
    assert response.status_code == 409


def test_websocket_receives_patches(client):
    client.post(
        "/api/v1/graphs",
        params={"id": "live"},
        json={"nodes": [{"id": "a"}], "edges": []},
    )
    with client.websocket_connect("/api/v1/graphs/live/stream") as socket:
        client.patch("/api/v1/graphs/live", json={"addNodes": [{"id": "b", "label": "B"}]})
        message = socket.receive_json()
        assert message["addNodes"][0]["id"] == "b"


def test_websocket_rejects_unknown_graph(client):
    with client.websocket_connect("/api/v1/graphs/nope/stream") as socket:
        assert "error" in socket.receive_json()


def test_openapi_schema_is_valid(client):
    schema = client.get("/openapi.json").json()
    assert "/api/v1/graphs/{graph_id}" in schema["paths"]
