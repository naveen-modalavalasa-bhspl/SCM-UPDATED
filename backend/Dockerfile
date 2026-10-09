FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini .
COPY gunicorn.conf.py .
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts

RUN chown -R app:app /app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)" || exit 1

# gunicorn, not a bare uvicorn: see gunicorn.conf.py. A single uvicorn process is one
# CPU core for the whole deployment regardless of the host, and it was the ceiling
# every other bottleneck was multiplied by.
#
# NO MIGRATION HERE (fixed 2026-09-03). This used to be
# `alembic upgrade head && exec uvicorn ...`, which is correct for exactly one
# container and a race for any more than that: with replicas, every backend starts at
# once and they all run `alembic upgrade head` against the same database
# concurrently. Alembic takes no lock of its own, so two workers can read the same
# current revision and both try to apply the next one -- a half-applied schema, and
# the version table saying the migration succeeded.
#
# Migration is now its own one-shot step that runs exactly once before any app
# container starts: the `migrate` service in compose.yaml, or a Job/initContainer
# under Kubernetes. And it is still only right for an EXISTING database -- a fresh
# schema is built by `python -m scripts.bootstrap` (see CLAUDE.md).
CMD ["sh", "-c", "python scripts/wait_for_db.py && exec gunicorn -c gunicorn.conf.py"]
