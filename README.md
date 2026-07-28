# SCM ERP

Supply-chain ERP: **Indent → Purchase Order → GRN → Stock → Issue**, with a
config-driven approval engine, a rules engine, RBAC, and an HCM mirror for
people/org data.

FastAPI (async) + SQLAlchemy 2.0 + Alembic + MySQL · React 18 + Vite + TypeScript
+ TanStack Query + Tailwind v4 + HeroUI.

See **[CLAUDE.md](CLAUDE.md)** for architecture, the non-negotiable rules, and the
deviations from the spec docs in [docs/](docs/).

---

## 1. Before you start (prerequisites)

Install these first. The versions matter — the project is pinned to them.

| Tool | Version | Check with | Notes |
|---|---|---|---|
| Python | **3.11** | `py -3.11 --version` | 3.12+ is untested; some pins won't build |
| Node.js | **18+** (20 recommended) | `node -v` | ships with npm |
| MySQL Server | **8.0+** | `mysql --version` | must be running before step 2 |
| Git | any | `git --version` | |

There is **no SQLite fallback**. The app and the tests both need a real MySQL.

> **Windows note:** commands below are written for PowerShell in the repo root.
> On macOS/Linux replace `.venv/Scripts/python` with `.venv/bin/python`, and
> `copy` with `cp`.

---

## 2. Get the code

```powershell
git clone <repo-url> scm-erp
cd scm-erp
```

Repo has two apps side by side:

```
backend/    FastAPI service      -> runs on http://localhost:8000
frontend/   Vite + React SPA     -> runs on http://localhost:5173
docs/       spec documents, SQL handoffs, HCM sample payloads
dumps/      database dumps
```

You need **both running** to use the app. Start with the backend.

---

## 3. Environment and setup

Make sure the local environment is ready before continuing.

- Confirm Python 3.11, Node.js 18+, and MySQL 8.0+ are installed.
- Ensure MySQL is running and the required environment variables are prepared in
  `backend/.env`.
- Continue with the backend and frontend setup steps below.

---

## 4. Backend setup

All commands from the `backend/` folder:

```powershell
cd backend
```

### 4.1 Create the virtual environment and install dependencies

```powershell
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install --upgrade pip
.venv/Scripts/python -m pip install -r requirements.txt
```

Takes a few minutes the first time. You do **not** need to "activate" the venv —
every command below calls `.venv/Scripts/python` directly, which is the same thing
and avoids PowerShell execution-policy problems.

### 4.2 Create your `.env`

```powershell
copy .env.example .env
```

Then open `backend/.env` and set the values. **Nothing has a code default** — a
missing variable stops the server at startup on purpose, rather than silently
running on a baked-in value.

```ini
# --- Database (required) ---
DATABASE_URL=mysql+aiomysql://root:yourpassword@127.0.0.1:3306/scm_erp

# Points the test suite at a MySQL you can CREATE DATABASE on. Without it,
# every DB-backed test silently SKIPS. Usually the same server as above.
TEST_DATABASE_URL=mysql+aiomysql://root:yourpassword@127.0.0.1:3306/scm_erp

# --- Auth (required) ---
SECRET_KEY=any-long-random-string-at-least-32-chars
ACCESS_TOKEN_EXPIRE_MINUTES=480

# --- CORS ---
CORS_ORIGINS=http://localhost:5173
CORS_ALLOW_PRIVATE_NETWORK=false

# --- HCM integration (required) ---
HCM_BASE_URL=http://<hcm-host>:8001/api
HCM_API_KEY=sk_your_hcm_api_key
HCM_TIMEOUT_SECONDS=5
HCM_RETRIES=3
```

**If your MySQL password has special characters**, URL-encode them in the DSN:
`#` → `%23`, `@` → `%40`, `:` → `%3A`, `/` → `%2F`. A raw `@` in the password
splits the URL in the wrong place and you get a confusing "unknown host" error.

`HCM_BASE_URL` / `HCM_API_KEY` are required even for local work — put any
placeholder string in them if you have no HCM access. The app only calls HCM when
you trigger a sync.

### 4.3 Create the tables

```powershell
.venv/Scripts/python -m alembic upgrade head
```

Builds ~85 tables in `scm_erp`. Re-runnable; does nothing if already at head.

### 4.4 Seed demo data

```powershell
.venv/Scripts/python -m scripts.seed
```

Idempotent — safe to run again any time. It creates:

- all permissions, 5 roles, and the menu tree (`rbac_pages`)
- 6 demo users with logins, and mock `hcm_*` org data (positions, departments,
  one office, one facility) so you can log in before a real HCM sync exists
- 8 UOMs, 20 items, item categories, 5 vendors, packaging and attributes
- one active approval workflow per document type (INDENT / PO / GRN / ISSUE),
  including an amount-conditional Plant Head stage on PO

### 4.5 Start the server

```powershell
.venv/Scripts/python -m uvicorn app.main:app --reload --reload-dir app
```

`--reload-dir app` matters: without it the reloader also watches `.venv`, so a
single `pip install` triggers a several-hundred-file reload that can wedge the
server.

Check it's alive:

- http://localhost:8000/health → `{"status":"ok"}`
- http://localhost:8000/docs → interactive Swagger UI for every endpoint

Leave this terminal running.

---

## 5. Frontend setup

Open a **second terminal**, from the repo root:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

`frontend/.env` already exists with `VITE_API_URL=` (empty). Leave it empty for
local development — the axios client then uses a relative `/api`, and Vite proxies
it to `http://localhost:8000`. Only set it for a deployed build, to the backend's
public origin. To proxy at a different backend in dev, set `VITE_API_PROXY`
instead. Never hardcode a host in source.

---

## 6. Log in

Demo accounts, all with password **`Bavya@123`**:

| Username | Role | Can do |
|---|---|---|
| `admin` | Admin | everything, incl. masters, RBAC, rules, settings |
| `requester` | Requester | raise and submit indents |
| `approver` | Approver | approve/reject indents and POs |
| `procurement` | Procurement | create POs, send to vendor, vendor/item masters |
| `store` | Store | GRN, QC, stock, issues, warehouse/bin master |
| `planthead` | Approver | the high-value PO approval stage |

The username field accepts the employee code (`admin`), the email, or the numeric
employee id. Identity lives in `hcm_employees` — there is no `users` table.

> Note: `scripts/seed_foundation.py` is a **different, older** seed for the
> canonical `scm_rebuild` schema and uses password `password123`. For a fresh
> local database, use `scripts.seed` as in step 4.4.

---

## 7. Optional setup scripts

Run these only if you need the feature. All from `backend/`, all idempotent.

```powershell
# Full indent flow as data: raise -> manager approves -> inventory checks stock
# -> warehouse packs. Writes wf_stages, rbac_*, rule_* rows.
.venv/Scripts/python -m scripts.setup_indent_flow

# Makes indent -> inventory usable: seeds the rule_events catalogue, creates the
# LIP and MDP warehouses, grants allocation / material-request permissions.
.venv/Scripts/python -m scripts.setup_inventory_flow

# Employee portal access + the reporting-manager indent workflow (data only).
.venv/Scripts/python -m scripts.provision_employee_portal

# Export the master-data catalogue to Excel, read from the live database.
.venv/Scripts/python -m scripts.export_master_catalogue [output.xlsx]
```

Two scripts exist for databases maintained by the DB team, where Alembic has no
usable revision history. **Do not run them against a database you built with
`alembic upgrade head`** — they apply the same DDL a second way. Both take
`--check` to verify without writing:

```powershell
.venv/Scripts/python -m scripts.apply_admin_masters --check
.venv/Scripts/python -m scripts.apply_item_master_expansion --check
```

---

## 8. Running the tests

**Backend** (from `backend/`) — 228 tests:

```powershell
.venv/Scripts/python -m pytest
.venv/Scripts/python -m pytest app/modules/inventory   # one module
.venv/Scripts/python -m pytest -k reservation -x       # one topic, stop on first fail
```

Two things to know:

1. **`TEST_DATABASE_URL` must be set** in `.env` (step 4.2), pointing at a MySQL
   where your account can `CREATE DATABASE`. Without it, every DB-backed test
   **skips silently** and the run looks green while proving nothing.
2. A **full run takes ~10 minutes** — the suite drops and recreates ~85 tables per
   test for isolation. Use a path or `-k` filter while developing.

**Frontend** (from `frontend/`):

```powershell
npm test           # vitest, one pass
npm run test:watch # re-runs on change
npm run build      # tsc -b && vite build — must compile
```

Tests live beside the code they cover, in each module's `tests/` folder, never in
a central directory.

**Before finishing any task**: `pytest` must pass and `npm run build` must compile.

---

## 9. What works end to end

`backend/tests/e2e/test_full_flow.py` walks the real business flow:

indent → submit → approve → PO → approve → send-to-vendor → GRN → QC pass →
**stock increases**.

Green = the system works. That test is the honest answer to "is it working".

---

## 10. Running on the local network (phones, other machines)

For demos and mobile testing:

1. In `backend/.env` set `CORS_ALLOW_PRIVATE_NETWORK=true` (a private-IP regex,
   never a wildcard — the API sends credentials).
2. Add a one-off inbound Windows Firewall rule for TCP **8000** and **5173**.
3. Start the backend bound to all interfaces:
   ```powershell
   .venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
   ```
4. The Vite dev server already listens on all interfaces. Open
   `http://<your-lan-ip>:5173` from the other device.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pydantic_settings ... field required (DATABASE_URL)` at startup | `.env` missing or a required key is absent. Required: `DATABASE_URL`, `SECRET_KEY`, `HCM_BASE_URL`, `HCM_API_KEY`. |
| `Can't connect to MySQL server` / unknown host | MySQL isn't running, or the password in the DSN has an unencoded special character. See step 4.2. |
| `Unknown database 'scm_erp'` | You skipped step 3 — `CREATE DATABASE scm_erp;`. |
| `1054 Unknown column '...'` on a SELECT | The model maps a column the live table lacks. The schema is database-first in places; run the matching `scripts/apply_*.py --check`, or see `docs/sql/`. |
| Every test says SKIPPED | `TEST_DATABASE_URL` is unset, or the account can't `CREATE DATABASE`. |
| Server reloads forever after `pip install` | You omitted `--reload-dir app`, so uvicorn is watching `.venv`. |
| `Port 5173 is already in use` | Vite uses `strictPort` deliberately. Stop the other dev server; don't let it drift to another port, the CORS list names 5173. |
| Frontend loads but every call is 401/404 | Backend isn't running on :8000, or `VITE_API_URL` is set when it should be empty. |
| Login rejected for a demo user | Password is `Bavya@123`, not `password123`. Re-run `python -m scripts.seed`. |

---

## 12. Repository layout

```
backend/
  app/
    core/        config, database, security, dependencies, exceptions, pagination
    shared/      enums, mst_ models, numbering, masters API
    platform/    hcm/ rbac/ workflow/ rules/ auth/ settings/ admin/
    modules/     inventory/ indents/ procurement/ logistics/
                 each: models.py schemas.py service.py router.py tests/
  alembic/       migrations
  scripts/       seed + setup/handoff scripts
  tests/         e2e and smoke tests
frontend/
  src/shared/    api client, auth, layout, component kit
  src/modules/   indents/ inventory/ procurement/ logistics/ masters/ admin/ rbac/
                 each: api.ts types.ts pages/ components/ tests/
docs/
  01_BUILD_GUIDE.md  02_ADDENDUM.md  03_HCM_AND_DB.md  04_SCM_BUSINESS_FLOW.md
  API_MASTERS_AND_RULES.md  DB_SCHEMA.md  sql/  hcm-samples/
```

Table prefixes mark the owning module: `mst_ hcm_ rbac_ wf_ rule_ sys_ stk_ inv_
ind_ pro_ lgs_ whs_`. A module only creates tables with its own prefix.

---

## 13. Where to read next

1. **[CLAUDE.md](CLAUDE.md)** — the rules every change must follow, and why the
   build deviates from the docs. Read this before writing code.
2. **[docs/04_SCM_BUSINESS_FLOW.md](docs/04_SCM_BUSINESS_FLOW.md)** — the business
   owner's end-to-end flow; the authority on what the system must do.
3. **[docs/DB_SCHEMA.md](docs/DB_SCHEMA.md)** — the tables.
4. **[docs/API_MASTERS_AND_RULES.md](docs/API_MASTERS_AND_RULES.md)** — the masters
   API and the rules engine.

Doc precedence when they conflict: **04 > 03 > 02 > 01**.
