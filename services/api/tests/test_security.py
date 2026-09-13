"""Security posture of the write path and the CORS defaults.

These are the two things that would be wrong by default on a public deployment,
so they get their own tests rather than riding along in the API suite.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.adapters.registry import registry
from app.api.deps import reset_cache
from app.config import GraphSource, get_settings
from app.main import create_app

SMALL_GRAPH = {"nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"source": "a", "target": "b"}]}


@pytest.fixture()
def keyed_client(monkeypatch):
    """A service configured with an API key and an explicit CORS origin."""
    monkeypatch.setenv("KG3D_API_KEY", "s3cret-key")
    monkeypatch.setenv("KG3D_CORS_ORIGINS", "https://graphs.example.com")
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as client:
        registry.register(GraphSource(id="guarded", kind="memory", options={"data": SMALL_GRAPH}))
        reset_cache()
        yield client
    get_settings.cache_clear()


@pytest.fixture()
def wildcard_client(monkeypatch):
    """A service configured the way a careless operator would configure it."""
    monkeypatch.delenv("KG3D_API_KEY", raising=False)
    monkeypatch.setenv("KG3D_CORS_ORIGINS", "*")
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


class TestWriteAuthentication:
    def test_create_without_key_is_401(self, keyed_client):
        response = keyed_client.post("/api/v1/graphs", params={"id": "nope"}, json=SMALL_GRAPH)
        assert response.status_code == 401
        assert "X-API-Key" in response.json()["detail"]

    def test_create_with_wrong_key_is_403(self, keyed_client):
        response = keyed_client.post(
            "/api/v1/graphs",
            params={"id": "nope"},
            json=SMALL_GRAPH,
            headers={"X-API-Key": "wrong"},
        )
        assert response.status_code == 403

    def test_create_with_correct_key_succeeds(self, keyed_client):
        response = keyed_client.post(
            "/api/v1/graphs",
            params={"id": "authorised"},
            json=SMALL_GRAPH,
            headers={"X-API-Key": "s3cret-key"},
        )
        assert response.status_code == 201
        assert response.json()["node_count"] == 2

    def test_patch_is_guarded(self, keyed_client):
        assert keyed_client.patch("/api/v1/graphs/guarded", json={}).status_code == 401
        assert (
            keyed_client.patch(
                "/api/v1/graphs/guarded",
                json={"addNodes": [{"id": "c"}]},
                headers={"X-API-Key": "s3cret-key"},
            ).status_code
            == 200
        )

    def test_refresh_is_guarded(self, keyed_client):
        assert keyed_client.post("/api/v1/graphs/guarded/refresh").status_code == 401

    def test_reads_stay_open(self, keyed_client):
        """Authentication covers mutation only — reading needs no key."""
        assert keyed_client.get("/api/v1/graphs/guarded").status_code == 200
        assert keyed_client.get("/api/v1/health").status_code == 200

    def test_writes_are_open_when_no_key_configured(self, wildcard_client):
        response = wildcard_client.post("/api/v1/graphs", params={"id": "open"}, json=SMALL_GRAPH)
        assert response.status_code == 201


class TestCors:
    def test_configured_origin_is_allowed_with_credentials(self, keyed_client):
        response = keyed_client.get(
            "/api/v1/health", headers={"Origin": "https://graphs.example.com"}
        )
        assert response.headers["access-control-allow-origin"] == "https://graphs.example.com"
        assert response.headers.get("access-control-allow-credentials") == "true"

    def test_unknown_origin_gets_no_allow_header(self, keyed_client):
        response = keyed_client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in response.headers

    def test_wildcard_never_grants_credentials(self, wildcard_client):
        """The combination that lets any site make authenticated requests."""
        response = wildcard_client.get(
            "/api/v1/health", headers={"Origin": "https://anywhere.example"}
        )
        assert response.headers.get("access-control-allow-origin") == "*"
        assert response.headers.get("access-control-allow-credentials") is None

    def test_no_cors_headers_by_default(self, monkeypatch):
        """Out of the box the service emits no CORS headers at all."""
        monkeypatch.delenv("KG3D_CORS_ORIGINS", raising=False)
        monkeypatch.delenv("KG3D_API_KEY", raising=False)
        get_settings.cache_clear()
        with TestClient(create_app()) as client:
            response = client.get("/api/v1/health", headers={"Origin": "https://anywhere.example"})
            assert "access-control-allow-origin" not in response.headers
        get_settings.cache_clear()


class TestIngestLimit:
    def test_oversized_body_is_rejected(self, monkeypatch):
        monkeypatch.setenv("KG3D_MAX_INGEST_BYTES", "512")
        monkeypatch.delenv("KG3D_API_KEY", raising=False)
        get_settings.cache_clear()
        with TestClient(create_app()) as client:
            big = {
                "nodes": [{"id": f"n{i}", "label": "x" * 40} for i in range(200)],
                "edges": [],
            }
            response = client.post("/api/v1/graphs", params={"id": "huge"}, json=big)
            assert response.status_code == 413
            assert "byte limit" in response.json()["detail"]
        get_settings.cache_clear()

    def test_small_body_passes(self, monkeypatch):
        monkeypatch.setenv("KG3D_MAX_INGEST_BYTES", "1048576")
        monkeypatch.delenv("KG3D_API_KEY", raising=False)
        get_settings.cache_clear()
        with TestClient(create_app()) as client:
            response = client.post("/api/v1/graphs", params={"id": "small"}, json=SMALL_GRAPH)
            assert response.status_code == 201
        get_settings.cache_clear()
