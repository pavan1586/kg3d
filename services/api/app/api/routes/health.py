from __future__ import annotations

import time

from fastapi import APIRouter, Depends

from app.adapters.registry import registry
from app.api.deps import get_cache
from app.config import Settings, get_settings
from app.core.cache import TTLCache
from app.models.graph import HealthResponse

router = APIRouter(tags=["health"])
_started_at = time.monotonic()


@router.get("/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=settings.version,
        graphs=len(registry.ids()),
        uptime_seconds=round(time.monotonic() - _started_at, 1),
    )


@router.get("/ready")
async def ready() -> dict[str, bool]:
    """Readiness probe: every registered adapter must load without raising."""
    for graph_id in registry.ids():
        adapter = registry.get(graph_id)
        if adapter is None:
            return {"ready": False}
        await adapter.load()
    return {"ready": True}


@router.get("/metrics/cache")
async def cache_metrics(cache: TTLCache = Depends(get_cache)) -> dict[str, int]:
    return cache.stats()
