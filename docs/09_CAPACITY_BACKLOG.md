# Capacity and hardening — what is done, what is parked

Source: three read-only reviews dated 2026-09-02 — the load rating, the field
readiness review and the security review. They agreed on the shape of the problem:
the domain logic, the indexing (238 column + 27 composite indexes, on the right
columns), the workflow engine and the row-locked stock paths are sound. Everything
*around* them was a development setup. Measured ceiling was roughly **50–120
concurrent users** against a target of **1,000–2,000**.

Work was taken in two gates. Gate 0 was the data-loss and evidence-integrity set;
Gate 1 was the capacity set, which is almost entirely configuration.

---

## Done — Gate 0 (data loss, evidence, secrets)

| # | Item | Where |
|---|------|-------|
| 1 | Attachment authorization: one shared parent-scope check on every upload and delete route | `platform/settings/attachments.py`, `warehouse/service.py`, `indents/service.py`, `returns/service.py` |
| 2 | Upload whitelist by extension **and** leading bytes; 20 MB cap enforced while streaming; downloads served `Content-Disposition: attachment` with a server-decided MIME | `platform/settings/attachments.py` |
| 3 | `uploads_data` volume + `UPLOAD_DIR` — every attachment upload previously failed on the read-only container filesystem | `compose.yaml` |
| 4 | Scheduled `mysqldump` with retention, MySQL `my.cnf`, container resource limits | `deploy/backup.sh`, `deploy/mysql.cnf`, `compose.yaml` |
| 5 | `logs.json` (employee names, internal IPs, stack traces) untracked and ignored | `.gitignore` |

Also closed on the way past, because it was the same check: the indent
receipt-attachment **listing** route ran no visibility check, so `indent.view`
exposed file names, uploaders and timestamps for every indent in the company.

## Done — Gate 1 (capacity)

| # | Item | Where |
|---|------|-------|
| 11 | gunicorn, `2 × cores + 1` workers, 2 API replicas | `backend/gunicorn.conf.py`, `backend/Dockerfile`, `compose.yaml` |
| 12 | Schedulers moved to one single-replica `worker` container (`RUN_SCHEDULERS`) | `app/main.py`, `compose.yaml` |
| 13 | Integrations rate limiter and caches moved into Redis, with a per-process fallback | `app/core/cache.py`, `integrations/security.py` |
| 14 | DB pool sized from the environment (dev 5+5, prod 20+10, per worker) | `app/core/config.py`, `app/core/database.py` |
| 15 | `my.cnf`: buffer pool, `max_connections=500`, slow query log, 30 s statement timeout | `deploy/mysql.cnf` |
| 16 | bcrypt off the event loop at all ten call sites | `app/core/security.py` + callers |
| 17 | Auth throttling — nginx `limit_req` **and** an application per-address limit on all four unauthenticated doors | `frontend/nginx.conf`, `app/core/throttle.py` |
| 18 | Per-account lockout wired to the `failed_attempts` / `locked_until` columns that had never been incremented | `platform/auth/service.py` |
| 19 | gzip in nginx + `GZipMiddleware` on API responses | `frontend/nginx.conf`, `app/main.py` |
| 20 | Cross-request permission cache, invalidated by the existing grant flush hook | `platform/rbac/service.py` |
| 21 | Prometheus per-endpoint latency + connection-pool gauge on `/metrics` | `app/main.py` |

Measured effect of #19 alone, from `npm run build`: the 2.72 MB main chunk and
334 KB of CSS go over the wire at 709 KB and 44 KB.

---

## Parked, in the order they should be picked up

### Next — hot paths and the bundle (the load rating's Phase 3)

1. **Home dashboard runs one query per catalogue item.** `get_stock_replenishment`
   loops over every active item with a reorder level and issues a `SUM(available_qty)`
   per item, plus a `db.get(Item, ...)` per replenishment rule. No pagination, no
   limit. Invisible at today's 90 items; at 5,000 items × 500 sign-ins it is 2.5 M
   queries. Rewrite as one `GROUP BY` + one `WHERE id IN (...)`, then cache the
   payload 60–120 s. `inventory/service.py:2029-2100`, `home/service.py:99-107`.
2. **The dashboard fires 25+ queries, uncached.** Collapse the per-status counts into
   one `GROUP BY status` per document type; cache the whole response keyed by
   `(user, position, date_range)`. `home/service.py:262-482`.
3. **`pending_for_user` returns every pending row, unpaginated.** Where only the count
   and overdue count are wanted, issue two `COUNT`s. `workflow/engine.py:1549-1560`.
4. **Excel/CSV export builds the workbook on the event loop.** One 50 k-row export
   freezes the app for everyone. Short term `asyncio.to_thread` + a row cap; proper
   fix is a job queue (`arq` — Redis-backed, already deployed) also carrying imports,
   outbound mail, webhook delivery and the HCM sync.
   `reports/service.py:363-430`, `shared/masters/bulk.py:166-250`.
5. **Route-level `React.lazy`.** `App.tsx` has ~100 eager imports and zero `lazy`, so
   every user downloads all 120 screens. Expect 2.72 MB → 300–500 KB initial.
6. **Drop dead dependencies** — `three`, `antd`, `@ant-design/*`, `@react-three/*`:
   94 MB that nothing imports. Replace client-side `xlsx` (known advisories, freezes
   the tab on a large file) with the server export that already exists.
7. **Five-second polling on six logistics screens** — ~60 req/s of background noise
   against unbounded list endpoints. Raise to 20–30 s and pause on a hidden tab, or
   one SSE stream.
8. **No list virtualisation**, and twelve screens request 500 rows. Add
   `@tanstack/react-virtual` inside `ResponsiveList` — one shared component, no module
   code changes.

### Then — prove it, then hold it

9. **Load test with k6 or Locust against a production-sized dataset.** Everything
   above is derived from reading the code, not from measurement, and item 1 in
   particular is invisible at the 90 items currently in the system. This is what turns
   the estimates into facts.
10. **Read replica for the reports module** — already read-only and isolated, so it is
    the natural first candidate.
11. **Request-timeout middleware** (504 rather than holding a pooled connection). The
    MySQL side is done (`max_execution_time`); FastAPI's is not.
12. **Short JWT + refresh + `jti` revocation, httpOnly cookie instead of
    localStorage.** Today a token lives 8 hours with no way to invalidate it, so a
    revoked user keeps working until it expires. Note the interaction: the permission
    cache TTL is now the lag on a *grant* revocation — that part is already bounded.
13. **CSP, HSTS, TLS termination**, and `HCM_BASE_URL` from `http://` to `https://` —
    the API key is currently sniffable on the network path.
14. **CI**: `pytest`, `npm run build`, `alembic check`, a smoke `scripts.bootstrap` on
    an ephemeral DB, and gitleaks. None exists today.
15. **Per-route error boundary** — one module crash whitescreens the whole app.

### Security items not in either gate

16. **Shared vendor password.** `DEFAULT_VENDOR_PASSWORD = "Bavya@123"` in
    `procurement/service.py:2941`, and the same literal as `REVEAL_PASSWORD` in
    `integrations/service.py:54` and `webhooks.py:66`. Every supplier and carrier
    account is created with it and nothing forces a change. Rated Critical.
17. **HCM joiners share one password** with `must_change=False` (`hcm/sync.py:352`) —
    about 1,900 accounts.
18. **The infrastructure credential reveal screen** returns database, mail and HCM
    credentials in readable form to a privileged browser session.
19. **Data scope fails open**: a position with no configured scope defaults to
    company-wide visibility. It should fail closed and alert an administrator.
20. `logs.json` is out of the working tree but **still in git history** — decide
    between a history rewrite and rotating what it exposed.

---

## Rules this work established — do not undo them

- **`sys_attachments` is a shared table with a soft key.** A route that takes an
  `attachment_id` and cannot name the document it hangs on has authorised nothing.
  `delete_attachment` refuses to run without an `entity_type` for exactly that reason.
- **bcrypt never runs on the event loop.** Use `hash_password_async` /
  `verify_password_async` in anything reached by a request.
- **No process-local state in a web worker.** A dict that a second worker would
  duplicate is a scaling bug; `app/core/cache.py` is where that state goes.
- **`RUN_SCHEDULERS` is true in exactly one process.** Scaling the worker needs a
  leader lock, not a second replica.
- **The pool is per worker.** `WEB_CONCURRENCY × BACKEND_REPLICAS ×
  (DB_POOL_SIZE + DB_MAX_OVERFLOW)` must stay under the server's `max_connections`.
- **`PERMISSION_CACHE_SECONDS` is a security parameter**, not a performance one: it is
  the lag on a revoked grant. Keep it under 15 minutes.


---

## Resilience review (2026-09-03) — durable jobs

A separate whole-application review rated resilience MODERATE with critical gaps. Its
finding is one architecture, not a list of fixes: **long-running work runs inside the
web process with no durable record**, so a restart, deploy or crash silently drops
work the user has already clicked, and nobody can tell what remains.

Closed by the capacity work above: the single-process bottleneck, scheduled jobs
running in every replica, exports blocking the event loop, and the absence of any
backup. Closed by `app/shared/limits.py`: unbounded request lists.

**Still open, and it is the next architecture:**

1. **Transactional outbox + durable job table in MySQL.** A command commits its
   business change and its outbox event in ONE transaction and returns a job id.
2. **A broker and separate worker processes.** The `worker` container already exists
   from the capacity work; it runs APScheduler, not a queue.
3. **Move `asyncio.create_task` off the request path.** HCM "Sync now" is fire and
   forget today — a restart loses it with no record that it was ever asked for.
4. **Client idempotency keys.** A timed-out click must be resolvable to its original
   operation, not retried blindly into a duplicate document.
5. **Parent/child batch jobs** for monthly allocations, bulk approvals, issue posting
   and procurement consolidation, with per-document keys and partial-success UI.
6. **Queue the exports and imports.** They are off the event loop now (threads), which
   is not the same as durable.
7. **Backups are not yet a recovery plan.** Binary logs / PITR, off-host storage
   (`BACKUP_HOST_DIR`), an agreed RPO/RTO and a quarterly restore drill.

Suggested order: limits (done) → job/outbox foundation + move HCM sync and reminders
onto it → batch orchestration → outbox for mail, notifications and webhooks.
