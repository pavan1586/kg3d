"""JSON file adapter.

Reads `{ "nodes": [...], "edges": [...] }` from disk. Also accepts the two other
shapes people actually have lying around: a JSON-lines file with one record per
line, and the `{"links": [...]}` spelling that d3 emits.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.adapters.base import GraphAdapter
from app.models.graph import Edge, GraphData, Node


class JsonFileAdapter(GraphAdapter):
    kind = "json"

    def __init__(
        self, graph_id: str, options: dict[str, Any] | None = None, directed: bool = False
    ):
        super().__init__(graph_id, options, directed)
        path = self.options.get("path")
        if not path:
            raise ValueError(f"graph '{graph_id}': json adapter requires options.path")
        self.path = Path(path)

    async def fetch(self) -> GraphData:
        if not self.path.exists():
            raise FileNotFoundError(f"graph '{self.graph_id}': {self.path} not found")

        text = self.path.read_text(encoding="utf-8")
        if self.path.suffix in {".jsonl", ".ndjson"}:
            payload = _from_jsonlines(text)
        else:
            payload = json.loads(text)

        raw_nodes = payload.get("nodes", [])
        raw_edges = payload.get("edges") or payload.get("links") or []

        nodes = [Node(**_normalize_node(n)) for n in raw_nodes]
        known = {n.id for n in nodes}
        edges = [
            Edge(**e)
            for e in (_normalize_edge(r) for r in raw_edges)
            # Dangling edges are dropped rather than raising: exports are often
            # filtered on the node side and it should still render.
            if e["source"] in known and e["target"] in known
        ]
        return GraphData(nodes=nodes, edges=edges)


def _from_jsonlines(text: str) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        if "source" in record and "target" in record:
            edges.append(record)
        else:
            nodes.append(record)
    return {"nodes": nodes, "edges": edges}


def _normalize_node(record: dict[str, Any]) -> dict[str, Any]:
    out = dict(record)
    out["id"] = str(out.get("id") or out.get("name") or out.get("key"))
    if "label" not in out and "name" in out:
        out["label"] = out["name"]
    # Anything the model doesn't know about is preserved under meta rather than
    # thrown away — the inspector panel shows it.
    known = {
        "id",
        "label",
        "type",
        "group",
        "weight",
        "size",
        "color",
        "level",
        "x",
        "y",
        "z",
        "meta",
    }
    extra = {k: v for k, v in out.items() if k not in known}
    if extra:
        meta = dict(out.get("meta") or {})
        meta.update(extra)
        out["meta"] = meta
        for key in extra:
            out.pop(key, None)
    return out


def _normalize_edge(record: dict[str, Any]) -> dict[str, Any]:
    out = dict(record)
    source = out.get("source")
    target = out.get("target")
    # d3 serialises resolved links as objects; accept both spellings.
    out["source"] = str(source.get("id") if isinstance(source, dict) else source)
    out["target"] = str(target.get("id") if isinstance(target, dict) else target)
    if "relation" in out and "type" not in out:
        out["type"] = out.pop("relation")
    known = {"id", "source", "target", "label", "type", "weight", "directed", "color", "meta"}
    extra = {k: v for k, v in out.items() if k not in known}
    if extra:
        meta = dict(out.get("meta") or {})
        meta.update(extra)
        out["meta"] = meta
        for key in extra:
            out.pop(key, None)
    return out
