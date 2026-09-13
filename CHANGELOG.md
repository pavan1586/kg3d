# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/) — while it is pre-1.0, minor releases
may contain breaking changes.

## [Unreleased]

## [0.2.0] — 2026-09-13

First public release.

### Added

- **`@kg3d/core`** — framework-agnostic 3D knowledge graph engine.
  GPU-instanced node and edge layers (two draw calls for the whole graph),
  Barnes-Hut force layout in a Web Worker with a main-thread fallback, GPU
  picking, screen-space label decluttering, five instant layout presets, four
  themes, pluggable colour and size encodings, and an optional built-in HUD.
- **`@kg3d/react`** — declarative component plus `useGraphInsights`,
  `useGraphSelection`, `useGraphHover`, `useGraphSearch`, `useNodeMetrics` and
  `useLayoutProgress`.
- **Client-side analytics** — PageRank, Brandes betweenness, closeness,
  clustering coefficient, and multi-level Louvain community detection.
- **Graph service** (`services/api`) — FastAPI with adapters for sample, JSON,
  SQL, Neo4j and in-memory sources; exact or sampled analytics; server-side 3D
  layout; three levels of detail; REST plus WebSocket streaming; and an
  in-process TTL cache.
- **`dist/kg3d.global.js`** — a single-`<script>` browser bundle with three.js
  included, so a plain HTML page needs no import map. Ships with
  `kg3d.global.js.LICENSE.txt` carrying the bundled three.js notice.
- Adapter analytics adoption: when the service has already computed metrics,
  the client uses them instead of recomputing, so the two never disagree about
  which node is the biggest hub.
- 66 engine tests and 49 service tests, plus a headless render smoke test.

### Security

- CORS is now closed by default. `KG3D_CORS_ORIGINS` starts empty, and `*` is
  accepted only without credentials — the previous default emitted permissive
  headers alongside credentials, which lets any site make authenticated
  requests on a visitor's behalf.
- Write endpoints (`POST /graphs`, `PATCH /graphs/{id}`,
  `POST /graphs/{id}/refresh`) can be gated behind `KG3D_API_KEY`, compared in
  constant time. With no key set they stay open and the service warns at
  startup.
- Graph ingest is capped at `KG3D_MAX_INGEST_BYTES` (32 MB default).

### Fixed

- `normalize()` clipped at the wrong percentile index, so a single outlier
  flattened every other node to the bottom of the scale instead of being
  clipped. Size and colour encodings driven by a metric were visibly wrong on
  any graph with one dominant hub.
- `KG3D_CORS_ORIGINS` and `KG3D_SOURCES` crashed at startup when given the
  documented comma-separated form, because pydantic-settings JSON-decoded them
  before the validator ran.
- Community detection replaced twice: label propagation collapsed roughly half
  of a sparse graph into one community (Q ≈ 0.57), single-level local moving
  fragmented it (Q ≈ 0.49), and full multi-level Louvain recovers the planted
  structure (Q ≈ 0.88).
- Camera framing used half the bounding-box diagonal, which stranded elongated
  force layouts as a small blob in an empty frame. It now computes a true
  bounding sphere.

### Notes

- The packages are ESM-only. `require()` is not supported.
- Bloom post-processing is imported lazily, so `@kg3d/core`'s static import
  graph contains exactly one module: `three`.

[Unreleased]: https://github.com/pavan1586/kg3d/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pavan1586/kg3d/releases/tag/v0.2.0
