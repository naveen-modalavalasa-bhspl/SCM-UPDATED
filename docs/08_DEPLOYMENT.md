# Production deployment

The repository ships as three containers:

- `frontend`: the compiled React application served by Nginx; it is the only
  service exposed on the host.
- `backend`: the FastAPI API. It waits for MySQL, applies Alembic migrations,
  and then starts Uvicorn.
- `db`: MySQL 8.4 with data stored in the `mysql_data` Docker volume.

The backend and database are kept on a private Docker network. Browser requests
to `/api/` and `/health/ready` are proxied by Nginx.

## Prerequisites

- A Linux host or VM with Docker Engine and Docker Compose v2.
- A DNS name pointing at the host.
- TLS termination in a load balancer or reverse proxy in front of port 80.
- A reachable HCM API and its API key.

Do not expose MySQL port 3306 publicly.

## First deployment

From the repository root:

```sh
cp .env.deploy.example .env.deploy
```

Replace every `CHANGE_ME` value in `.env.deploy`. Generate the application
secret with:

```sh
python -c "import secrets; print(secrets.token_urlsafe(64))"
```

Set `CORS_ORIGINS` to the public browser origin, for example
`https://scm.example.com`, without a trailing slash. URL-encode any special
characters in the database password when copying it into `DATABASE_URL`.
Never commit `.env.deploy`; it is ignored by Git.

Validate, build, and start:

```sh
docker compose --env-file .env.deploy config
docker compose --env-file .env.deploy build
docker compose --env-file .env.deploy up -d
docker compose --env-file .env.deploy ps
```

The backend automatically runs `alembic upgrade head` before serving traffic.
It does not seed demo users or demo business data.

For a fresh production database, identity, role, organization, and master data
must be provisioned through the approved production process or imported from
the existing environment. The local `scripts.seed` and `seed_foundation`
commands are demo-data tools and are deliberately disabled because the
container sets `ALLOW_DEMO_DATA=false`.

## Verification

From a machine that can reach the deployment:

```sh
curl --fail http://HOST/healthz
curl --fail http://HOST/health/ready
```

`/healthz` proves that Nginx is serving. `/health/ready` also proves that the
API can query MySQL. Inspect startup or migration failures with:

```sh
docker compose --env-file .env.deploy logs --tail=200 backend
docker compose --env-file .env.deploy logs --tail=200 db
```

## Upgrade

Back up the database first, then deploy the new source:

```sh
docker compose --env-file .env.deploy build
docker compose --env-file .env.deploy up -d
docker compose --env-file .env.deploy ps
```

Keep a database backup and the previous application image/tag together for
rollback. Application rollback does not automatically reverse database
migrations.

## Backups

The stack now runs its own backup: the `backup` service loops on
`BACKUP_INTERVAL_SECONDS` (daily by default) and writes a gzipped
`mysqldump --single-transaction` per run, pruning anything older than
`BACKUP_KEEP_DAYS`. See `deploy/backup.sh`.

**Set `BACKUP_HOST_DIR`.** Left at its default the dumps land in a named volume
on the same host as the database they protect, which survives a dropped table
and not a dead machine. Point it at mounted off-host storage.

The named Docker volume protects data across normal container recreation and is
not a backup. Test a restore regularly — a directory of dumps nobody has ever
restored is not a proven backup — and take an on-demand one before every
application upgrade:

```
docker compose --env-file .env.deploy exec backup sh /usr/local/bin/backup.sh
```

## Operating notes

- **The API scales out; the schedulers do not.** `backend` runs
  `BACKEND_REPLICAS` containers of `WEB_CONCURRENCY` gunicorn workers each, all
  with `RUN_SCHEDULERS=false`. The `worker` service is the single process that
  runs the HCM sync and the overdue-approval reminders, and it must stay at one
  replica — two would run concurrent syncs against the same mirror tables and
  deliver every reminder twice to a real person. Scaling it needs a leader lock
  in Redis, not a second replica.
- **Size the pool and `max_connections` together.** The SQLAlchemy pool is per
  worker process, so the ceiling is
  `WEB_CONCURRENCY x BACKEND_REPLICAS x (DB_POOL_SIZE + DB_MAX_OVERFLOW)` plus
  headroom for the worker, the backup job and a DBA session. `deploy/mysql.cnf`
  sets `max_connections=500` against a default of 300 in use.
- **`innodb_buffer_pool_size` and `DB_MEMORY_LIMIT` are one decision.** Keep the
  pool at 50-70% of the container limit; larger and it is OOM-killed.
- **Redis is required for more than one worker**, and only for that. With
  `REDIS_URL` unset the rate limiter, the permission cache and the introspection
  cache fall back to per-process dicts — correct in a single process, and wrong
  the moment there are two (a per-process limiter multiplies the configured
  ceiling by the worker count).
- **Attachments need the `uploads_data` volume and `UPLOAD_DIR` set to its mount
  point.** The container filesystem is read-only; without both, every upload
  fails with "Read-only file system" on the deployed app while working perfectly
  in development. Verify by uploading a GRN attachment after `compose up`.
- **`/metrics` is not proxied.** It is unauthenticated and names every route in
  the system, so nginx returns 404 for it; scrape `backend:8000/metrics` from
  inside the compose network. Turn it off with `METRICS_ENABLED=false`.
- Terminate HTTPS before this Compose stack and forward the original host and
  protocol headers. Nginx passes these headers to FastAPI.
- The containers run with read-only application filesystems and
  `no-new-privileges`; MySQL data is the only persistent volume.
- Change secrets through `.env.deploy`, then recreate the affected containers.
- Review container and dependency updates regularly; image tags are explicit
  (`python:3.12-slim`, `node:22-alpine`, `nginx:1.27-alpine`, `mysql:8.4`).
