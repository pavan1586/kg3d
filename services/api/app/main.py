"""kg3d graph service.

    uvicorn app.main:app --reload

Serves the graph, its analytics and (optionally) its layout to the kg3d WebGL
client. See `docs/api.md` for the endpoint reference.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.adapters.registry import registry
from app.api.routes import graphs, health, stream
from app.config import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("kg3d")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    registry.configure(settings)
    log.info("registered %d graph source(s): %s", len(registry.ids()), ", ".join(registry.ids()))
    try:
        yield
    finally:
        await registry.close()
        log.info("shutdown complete")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description=__doc__,
        lifespan=lifespan,
    )

    if settings.cors_origins:
        # A wildcard origin and credentials together mean any site on the
        # internet can make authenticated requests on a visitor's behalf —
        # Starlette echoes the caller's Origin back, so "*" is not the inert
        # value it looks like. Allow the wildcard for local development, but
        # never with credentials.
        wildcard = "*" in settings.cors_origins
        if wildcard:
            log.warning(
                "CORS is open to every origin; credentials are disabled. "
                "Set KG3D_CORS_ORIGINS to an explicit list before deploying."
            )
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=not wildcard,
            allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
            allow_headers=["Accept", "Content-Type", "Authorization", "X-API-Key"],
        )

    if settings.api_key is None:
        log.warning(
            "KG3D_API_KEY is not set: POST /graphs, PATCH /graphs/{id} and "
            "POST /graphs/{id}/refresh accept unauthenticated requests. "
            "Set it, or keep this service on a private network."
        )
    # Graph payloads are highly repetitive JSON; gzip typically cuts them by 80%.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    app.include_router(health.router, prefix=settings.api_prefix)
    app.include_router(graphs.router, prefix=settings.api_prefix)
    app.include_router(stream.router, prefix=settings.api_prefix)

    @app.exception_handler(ValueError)
    async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
        # Adapter misconfiguration surfaces as ValueError; a 400 with the real
        # message is far more useful to an operator than a bare 500.
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {
            "service": settings.app_name,
            "version": settings.version,
            "docs": "/docs",
            "api": settings.api_prefix,
        }

    return app


app = create_app()
