"""Shared request dependencies."""

from __future__ import annotations

import hashlib
import json
import secrets
from typing import Any

from fastapi import Depends, Header, HTTPException, Path, Request, status

from app.adapters.base import GraphAdapter
from app.adapters.registry import registry
from app.config import Settings, get_settings
from app.core.cache import TTLCache

_cache: TTLCache | None = None


def get_cache(settings: Settings = Depends(get_settings)) -> TTLCache:
    global _cache
    if _cache is None:
        _cache = TTLCache(settings.cache_ttl_seconds, settings.cache_max_entries)
    return _cache


def reset_cache() -> None:
    """Used by tests and by the ingest endpoints after a graph changes."""
    global _cache
    if _cache is not None:
        _cache.invalidate()


async def get_adapter(graph_id: str = Path(..., description="Registered graph id")) -> GraphAdapter:
    adapter = registry.get(graph_id)
    if adapter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"graph '{graph_id}' is not registered",
        )
    return adapter


def cache_key(*parts: Any) -> str:
    """Stable key for a set of request parameters."""
    payload = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


async def require_write_access(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    settings: Settings = Depends(get_settings),
) -> None:
    """Gate the mutating endpoints behind a shared secret when one is configured.

    With no key set the endpoints stay open, which is the right default for a
    service running on a private network behind a gateway — and the application
    logs a warning at startup so that choice is never silent.
    """
    if settings.api_key is None:
        return
    if x_api_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This endpoint requires an X-API-Key header.",
            headers={"WWW-Authenticate": "X-API-Key"},
        )
    # Constant-time comparison: a plain == leaks the key one byte at a time.
    if not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid API key.",
        )


async def enforce_ingest_limit(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> None:
    """Reject oversized graph uploads before they are parsed into memory."""
    header = request.headers.get("content-length")
    if header is None:
        return
    try:
        length = int(header)
    except ValueError:
        return
    if length > settings.max_ingest_bytes:
        raise HTTPException(
            # Literal 413: starlette renamed this constant, and pinning to
            # either spelling breaks on the other side of that change.
            status_code=413,
            detail=(
                f"Graph body is {length} bytes, above the "
                f"{settings.max_ingest_bytes} byte limit. Raise "
                "KG3D_MAX_INGEST_BYTES, or push the graph in smaller patches."
            ),
        )
