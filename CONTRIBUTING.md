# Contributing to kg3d

Thanks for taking a look. Issues, reproductions and pull requests are all
welcome.

## Getting set up

```bash
git clone https://github.com/pavan1586/kg3d.git
cd kg3d
npm install
npm run build        # the demo will not start until the packages are built
npm run dev          # http://localhost:5173
```

The one gotcha: **the demo consumes the packages from `dist/`, not from
source.** That is deliberate — the layout worker is resolved with
`new URL('./layoutWorker.js', import.meta.url)`, which only points at a real
file once tsc has emitted it, and it means the demo exercises exactly what a
consumer installs from npm. `npm run dev` rebuilds the packages first; if you
are editing engine source, re-run it (or run `npm run build -w @kg3d/core` in a
second terminal).

The service is optional — the demo runs on generated sample data without it:

```bash
pip install -e 'services/api[dev]'
uvicorn app.main:app --reload --app-dir services/api   # http://localhost:8000/docs
```

## Before you open a pull request

```bash
npm run verify          # format check, typecheck, build, tests
cd services/api && ruff check . && pytest -q
```

`npm run verify` is what CI runs, plus a headless render smoke test you can run
locally with `node scripts/smoke-render.mjs` after building the demo.

## Where things live

| Path                        | What it is                                                     |
| --------------------------- | -------------------------------------------------------------- |
| `packages/core/src/graph`   | Topology and analytics. Pure, DOM-free, well covered by tests. |
| `packages/core/src/layout`  | Force simulation, presets, the worker.                         |
| `packages/core/src/render`  | three.js layers. Not unit tested — covered by the smoke test.  |
| `packages/core/src/ui`      | The built-in HUD. Optional at runtime (`hud: false`).          |
| `packages/react`            | Thin binding. Should stay thin: logic belongs in core.         |
| `services/api/app/adapters` | One file per data source.                                      |
| `services/api/app/services` | Analytics, layout, levels of detail.                           |

## House style

- **Comments explain why, not what.** If a line needs a comment to say what it
  does, rename something instead. Comments earn their place by recording a
  decision, a constraint, or a trap someone would otherwise fall into.
- **Tests assert behaviour you can reason about independently.** The community
  tests check that Louvain recovers a _planted_ structure, not that it produces
  the same numbers it produced yesterday. Prefer a fixture with a known right
  answer over a snapshot.
- Prettier settles formatting; ruff settles it on the Python side. Don't argue
  with either in review.
- New public API needs a docs entry in `docs/options.md` and a line in the
  changelog.

## Performance changes

The engine has measured numbers in `docs/performance.md`. If you change
anything in the hot paths — the force tick, the metrics pass, the render
layers — re-measure and update that table in the same pull request. A
performance claim without a number under it is not a claim.

## Reporting a rendering bug

WebGL bugs are hardware-specific, so please include:

- browser and version, OS, and GPU (`chrome://gpu` → "GL Renderer")
- roughly how many nodes and edges
- what you see versus what you expected, ideally a screenshot
- anything in the console

## Security

Please don't open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the MIT
licence, the same terms as the project.
