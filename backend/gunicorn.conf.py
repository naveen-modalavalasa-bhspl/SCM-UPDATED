"""How the API process is run in a container.

Until 2026-09-03 the image started a bare `uvicorn app.main:app` with no `--workers`.
Python's GIL means that is exactly ONE CPU core serving every request in the
deployment, forever, however large the host — and every other cost in the system is
multiplied by it: one slow query, one bcrypt, one Excel export blocks every other user
rather than the one who caused it. `gunicorn==23.0.0` was already in requirements.txt
and unused.

Workers default to `2 × cores + 1`, the usual starting point for a mixed I/O and CPU
workload, and are overridable because the right number depends on the host and on how
many replicas sit behind the proxy. Note that the DB pool is PER WORKER, so
`WEB_CONCURRENCY × replicas × (DB_POOL_SIZE + DB_MAX_OVERFLOW)` has to stay under the
server's `max_connections` — see `deploy/mysql.cnf`.

Running more than one worker is only safe because the schedulers moved out of the web
process (`RUN_SCHEDULERS`) and the rate limiter and caches moved into Redis. Do not
re-introduce process-local state that a second worker would duplicate.
"""
import multiprocessing
import os

wsgi_app = "app.main:app"
bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"
worker_class = "uvicorn.workers.UvicornWorker"
workers = int(os.getenv("WEB_CONCURRENCY") or (multiprocessing.cpu_count() * 2 + 1))

# Longer than nginx's proxy_read_timeout so the proxy is the one that gives up first
# and the client gets a 504 rather than a killed worker mid-response.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "90"))
graceful_timeout = 30
keepalive = 5

# Recycled periodically: a long-lived worker that leaks anything at all leaks it for
# the life of the deployment. The jitter stops every worker restarting at once.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "2000"))
max_requests_jitter = 200

accesslog = "-"
errorlog = "-"
# The request id the app already stamps on every response, so a proxy line and an
# application error can be joined up.
access_log_format = '%({x-forwarded-for}i)s %(m)s %(U)s %(s)s %(L)ss %({x-request-id}o)s'
forwarded_allow_ips = "*"
