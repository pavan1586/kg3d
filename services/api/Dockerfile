# syntax=docker/dockerfile:1

# --- build layer: resolve dependencies once, cached independently of source ---
FROM python:3.12-slim AS deps
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY pyproject.toml ./
# Installing from pyproject alone means a source-only change never re-resolves
# the dependency tree.
RUN pip install --prefix=/install ".[sql]" && rm -rf /root/.cache

# --- runtime ---
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KG3D_API_PREFIX=/api/v1

RUN useradd --create-home --uid 10001 kg3d
WORKDIR /srv

COPY --from=deps /install /usr/local
COPY --chown=kg3d:kg3d app ./app

USER kg3d
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3).status==200 else 1)"

# One worker per CPU is wrong here: analytics is CPU-bound and cached per
# process, so extra workers multiply the cache misses. Scale with replicas and
# a shared cache in front instead.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
