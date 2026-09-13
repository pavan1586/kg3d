"""Live graph updates over WebSocket.

The client's `WebSocketAdapter` connects here and applies each patch
incrementally, so a graph that changes underneath a viewer grows in place rather
than being torn down and re-laid-out.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.adapters.registry import registry
from app.models.graph import GraphPatch

log = logging.getLogger("kg3d.stream")
router = APIRouter(tags=["stream"])

_subscribers: dict[str, set[WebSocket]] = defaultdict(set)
_lock = asyncio.Lock()


async def broadcast(graph_id: str, patch: GraphPatch) -> None:
    """Fan a patch out to everyone watching this graph."""
    async with _lock:
        targets = list(_subscribers.get(graph_id, ()))
    if not targets:
        return

    payload = patch.model_dump(exclude_none=True)
    dead: list[WebSocket] = []
    for socket in targets:
        try:
            await socket.send_json(payload)
        except Exception:  # noqa: BLE001 - a dead socket must not stop the fan-out
            dead.append(socket)

    if dead:
        async with _lock:
            for socket in dead:
                _subscribers[graph_id].discard(socket)


@router.websocket("/graphs/{graph_id}/stream")
async def stream(websocket: WebSocket, graph_id: str) -> None:
    if registry.get(graph_id) is None:
        # 1008 = policy violation; closing before accept would give the client
        # no way to tell "unknown graph" from "server down".
        await websocket.accept()
        await websocket.send_json({"error": f"graph '{graph_id}' is not registered"})
        await websocket.close(code=1008)
        return

    await websocket.accept()
    async with _lock:
        _subscribers[graph_id].add(websocket)
    log.info("stream opened for %s (%d watchers)", graph_id, len(_subscribers[graph_id]))

    try:
        while True:
            # The client has nothing to say; this read is how we notice it left.
            # A periodic ping keeps intermediaries from reaping an idle socket.
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.warning("stream error for %s: %s", graph_id, exc)
    finally:
        async with _lock:
            _subscribers[graph_id].discard(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
        log.info("stream closed for %s", graph_id)


def watcher_count(graph_id: str) -> int:
    return len(_subscribers.get(graph_id, ()))
