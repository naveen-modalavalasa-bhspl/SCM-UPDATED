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

The named Docker volume protects data across normal container recreation, but
it is not a backup. Schedule an encrypted MySQL logical backup or volume
snapshot outside this Compose project, copy it off-host, and regularly test a
restore. Take an on-demand backup before every application upgrade.

## Operating notes

- Run one backend container. The HCM synchronization scheduler currently runs
  inside the API process; multiple replicas would execute the same scheduled
  job unless a distributed scheduler/lock is added.
- Terminate HTTPS before this Compose stack and forward the original host and
  protocol headers. Nginx passes these headers to FastAPI.
- The containers run with read-only application filesystems and
  `no-new-privileges`; MySQL data is the only persistent volume.
- Change secrets through `.env.deploy`, then recreate the affected containers.
- Review container and dependency updates regularly; image tags are explicit
  (`python:3.12-slim`, `node:22-alpine`, `nginx:1.27-alpine`, `mysql:8.4`).
