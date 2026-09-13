"""Service configuration.

Everything is environment-driven so the same image runs in every environment.
The adapter registry is intentionally declarative: pointing the service at a new
data source is a config change, not a code change.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

AdapterKind = Literal["sample", "json", "sql", "neo4j", "memory"]


class GraphSource(BaseModel):
    """One registered graph and the adapter that backs it."""

    id: str
    name: str = ""
    kind: AdapterKind = "sample"
    #: Adapter-specific settings (file path, DSN, cypher queries, ...).
    options: dict[str, Any] = Field(default_factory=dict)
    #: Treat relationships as directed for analytics and rendering.
    directed: bool = False


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KG3D_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "kg3d graph service"
    version: str = "0.2.0"
    api_prefix: str = "/api/v1"
    debug: bool = False

    #: Browser origins allowed to call this service, e.g.
    #: "https://graphs.example.com,http://localhost:5173".
    #:
    #: Empty by default, and deliberately so: no CORS headers are emitted at
    #: all, which is correct for the common deployment where the browser
    #: reaches the API through the same origin as the page (the bundled nginx
    #: and Vite configs both proxy /api). Opening this up is an explicit act.
    #:
    #: "*" is honoured for local development, but credentials are then refused
    #: — a wildcard origin combined with credentials lets any website on the
    #: internet make authenticated requests on a visitor's behalf.
    #: `NoDecode` hands the raw environment string to the validator below.
    #: Without it pydantic-settings JSON-decodes every list-typed field first,
    #: and the documented CSV form ("a,b") dies with a JSONDecodeError before
    #: the service finishes starting.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    #: Shared secret required by the write endpoints (POST /graphs,
    #: PATCH /graphs/{id}, POST /graphs/{id}/refresh), sent as X-API-Key.
    #: Unset means the write endpoints are open — fine behind a gateway on a
    #: private network, never on a public address. The service logs a warning
    #: at startup when it is unset.
    api_key: str | None = None

    #: Largest graph body accepted by POST /graphs. The read path already has a
    #: ceiling; without this the write path is an easy accidental OOM.
    max_ingest_bytes: int = 32 * 1024 * 1024

    #: Hard ceiling on nodes returned by a single request. Protects both the
    #: service and the browser: past this the client should be paging or
    #: exploring by neighbourhood instead of loading everything.
    max_nodes_per_response: int = 60_000
    max_edges_per_response: int = 250_000

    #: Analytics cache TTL in seconds. Metrics on a 50k-node graph cost real
    #: CPU, and the underlying data rarely changes between two page loads.
    cache_ttl_seconds: int = 900
    cache_max_entries: int = 64

    #: Betweenness is O(V*E) exactly; above this node count the service samples.
    betweenness_exact_threshold: int = 1_200
    betweenness_samples: int = 400

    #: Server-side layout.
    layout_iterations: int = 200
    layout_scale: float = 520.0

    #: Registered graphs. Provide as JSON in KG3D_SOURCES, e.g.
    #: [{"id":"demo","kind":"sample","options":{"size":2000}}]
    sources: Annotated[list[GraphSource], NoDecode] = Field(
        default_factory=lambda: [
            GraphSource(
                id="demo",
                name="Sample enterprise knowledge graph",
                kind="sample",
                options={"size": 1200, "domains": 7, "seed": 20260908},
            )
        ]
    )

    @field_validator("cors_origins", "sources", mode="before")
    @classmethod
    def _parse_json_env(cls, value: Any) -> Any:
        # Environment variables arrive as strings; accept JSON or CSV so both
        # `KG3D_CORS_ORIGINS='["https://a"]'` and `KG3D_CORS_ORIGINS=https://a`
        # behave sensibly.
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                return json.loads(stripped)
            return [part.strip() for part in stripped.split(",") if part.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
