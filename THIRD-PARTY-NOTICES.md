# Third-party notices

kg3d is built on the following open-source projects. All are permissively
licensed; none are copyleft, so using kg3d places no licensing obligation on
your own code.

## Browser packages

| Project                         | Licence                                      | How kg3d uses it                                                                                                                                                   |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [three.js](https://threejs.org) | MIT — Copyright © 2010–2024 three.js authors | The only runtime dependency of `@kg3d/core`. Declared as a **peer dependency**, so the published npm packages contain no three.js source; you install it yourself. |
| [React](https://react.dev)      | MIT — Copyright © Meta Platforms, Inc.       | Peer dependency of `@kg3d/react` only.                                                                                                                             |

`@kg3d/core` also imports four post-processing modules from three.js's own
`examples/jsm` tree (`EffectComposer`, `RenderPass`, `UnrealBloomPass`,
`OutputPass`). They ship inside the `three` package under the same MIT licence
and are loaded lazily, only when `rendering.bloom` is enabled.

### The browser bundle

`dist/kg3d.global.js` — the single-`<script>` build — is the one artefact that
_does_ embed three.js. Its accompanying `dist/kg3d.global.js.LICENSE.txt`
carries the three.js copyright notice, as MIT requires. If you re-bundle or
re-minify that file, keep the notice with it.

## Service packages

| Project                                                                                 | Licence                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [FastAPI](https://fastapi.tiangolo.com)                                                 | MIT                                                                |
| [pydantic](https://docs.pydantic.dev) / pydantic-settings                               | MIT                                                                |
| [uvicorn](https://www.uvicorn.org)                                                      | BSD-3-Clause                                                       |
| [NetworkX](https://networkx.org)                                                        | BSD-3-Clause                                                       |
| [NumPy](https://numpy.org)                                                              | BSD-3-Clause (with bundled 0BSD, MIT, Zlib and CC0-1.0 components) |
| [SQLAlchemy](https://www.sqlalchemy.org) — optional `[sql]` extra                       | MIT                                                                |
| [Neo4j Python Driver](https://neo4j.com/docs/python-manual/) — optional `[neo4j]` extra | Apache-2.0                                                         |

## Fonts

The demo application and the standalone `examples/kg3d-atlas.html` load Inter
and IBM Plex from Google Fonts at runtime. Both families are licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org). No font files are
redistributed in this repository; if you self-host them, ship the OFL text
alongside.

## Trademarks

three.js, React, Neo4j and the other names above are the trademarks of their
respective owners. kg3d is built on three.js; it is not affiliated with or
endorsed by the three.js project.
