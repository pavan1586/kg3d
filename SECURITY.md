# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/kg3d/kg3d/security/advisories/new)
rather than opening a public issue. You should get an acknowledgement within a
few days.

Please include what you were running (package version or image tag), what you
observed, and the smallest reproduction you can manage.

## Supported versions

kg3d is pre-1.0. Fixes land on the latest minor release only; there are no
backports to earlier 0.x lines.

## What the browser packages do

`@kg3d/core` and `@kg3d/react` render data you give them. They make no network
requests of their own unless you attach `RestAdapter` or `WebSocketAdapter` and
point them at a URL, and they read no browser storage.

Node labels and metadata are rendered as **text**, never as HTML: the label
layer draws to a 2D canvas and the built-in HUD escapes every interpolated
value. Graph data from an untrusted source cannot inject markup.

## What the graph service does — read this before deploying it

The service in `services/api` is designed to run **behind your own gateway on a
private network**. Two defaults matter:

**Write endpoints are unauthenticated unless you set a key.** `POST /graphs`,
`PATCH /graphs/{id}` and `POST /graphs/{id}/refresh` mutate in-memory graphs and
broadcast to every connected viewer. Set `KG3D_API_KEY` and send it as
`X-API-Key`, or keep the service unreachable from the public internet. With no
key configured the service logs a warning on every start.

**CORS is closed by default.** `KG3D_CORS_ORIGINS` is empty, so no
`Access-Control-*` headers are emitted at all — correct for the normal
deployment where the browser reaches the API through the same origin as the page
(the bundled nginx and Vite configs both proxy `/api`). Setting it to `*` is
honoured for local development but credentials are then refused, because a
wildcard origin plus credentials lets any website make authenticated requests on
a visitor's behalf.

Other things worth knowing before you expose it:

- **Adapter queries are operator-trusted.** The `sql` adapter runs the
  `node_query` and `edge_query` you configure verbatim, and the `neo4j` adapter
  does the same with Cypher. These come from your environment configuration,
  never from request input, so there is no injection surface from API callers —
  but treat the configuration itself as privileged, and give the database user
  read-only access to only what the graph needs.
- **Analytics and layout are CPU-bound.** A large graph can occupy a worker for
  seconds. Results are cached (`KG3D_CACHE_TTL_SECONDS`), but there is no rate
  limiting; put one in your gateway if the service is reachable by many clients.
- **Ingest is capped** at `KG3D_MAX_INGEST_BYTES` (32 MB by default) and
  responses are capped at `KG3D_MAX_NODES_PER_RESPONSE`.
- **No secrets are logged.** Adapter options, including DSNs, are never written
  to the log.

## Dependencies

Dependabot watches npm, pip and GitHub Actions. The browser packages have a
single runtime dependency (three.js, a peer dependency), which keeps the
supply-chain surface small by design.
