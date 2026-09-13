"""A small TTL + LRU cache.

Analytics and layout are the expensive endpoints and their inputs change far
less often than they are requested. Keeping this in-process (rather than reaching
for Redis) is deliberate: the payloads are large, the hit rate is dominated by
repeat requests from the same browser session, and a cache that adds a network
hop to save a CPU-bound computation often loses.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TTLCache:
    def __init__(self, ttl_seconds: int = 900, max_entries: int = 64) -> None:
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self.misses += 1
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                self._store.pop(key, None)
                self.misses += 1
                return None
            self._store.move_to_end(key)
            self.hits += 1
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + self.ttl, value)
            self._store.move_to_end(key)
            while len(self._store) > self.max_entries:
                self._store.popitem(last=False)

    def get_or_compute(self, key: str, factory: Callable[[], T]) -> T:
        cached = self.get(key)
        if cached is not None:
            return cached
        # Computed outside the lock on purpose: a 50k-node analytics pass takes
        # seconds, and blocking every other request behind it is worse than
        # occasionally computing the same thing twice.
        value = factory()
        self.set(key, value)
        return value

    def invalidate(self, prefix: str | None = None) -> None:
        with self._lock:
            if prefix is None:
                self._store.clear()
                return
            for key in [k for k in self._store if k.startswith(prefix)]:
                self._store.pop(key, None)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"entries": len(self._store), "hits": self.hits, "misses": self.misses}
