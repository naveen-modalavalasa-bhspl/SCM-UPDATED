# SCM ERP — Project Rules & Architecture

Doc precedence: **04 overrides 03 overrides 02 overrides 01** where they conflict.
Full specs: `docs/01_BUILD_GUIDE.md`, `docs/02_ADDENDUM.md`, `docs/03_HCM_AND_DB.md`,
`docs/04_SCM_BUSINESS_FLOW.md` (the business owner's end-to-end flow — the authority on
what the system must do). Read them before making structural changes.

Stack: FastAPI (async) + SQLAlchemy 2.0 async + Alembic + **MySQL** (prod) +
React 18 + Vite + TypeScript + TanStack Query + axios + Tailwind v4.

---

## How to run

**Backend** (from `backend/`) — MySQL only, no SQLite fallback:
```
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
copy .env.example .env          # set DATABASE_URL=mysql+aiomysql://root:<pw>@127.0.0.1:3306/scm_erp
# create the schema once (MySQL must be running):  CREATE DATABASE scm_erp;
.venv/Scripts/python -m alembic upgrade head
$env:ALLOW_DEMO_DATA="true"       # development only; demo seeds are blocked otherwise
.venv/Scripts/python -m scripts.seed
# --reload-dir app: without it the reloader also watches .venv, so a pip install
# triggers a several-hundred-file reload that can wedge the server.
.venv/Scripts/python -m uvicorn app.main:app --reload --reload-dir app   # :8000
# Reachable from other machines on the LAN (needs CORS_ALLOW_PRIVATE_NETWORK=true
# in .env, and a one-off inbound firewall rule for ports 8000 and 5173):
.venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
.venv/Scripts/python -m pytest                            # 29 tests, on MySQL scm_erp_test
```
Tests create/use a separate `scm_erp_test` database from the same `.env` credentials.

**Frontend** (from `frontend/`):
```
npm install
npm run dev      # http://localhost:5173  (proxies /api -> :8000)
npm run build
```
**Demo logins**: `requester`, `approver`, `procurement`, `store`, `planthead`,
`admin`. The seed prints a unique one-time password for each newly created account.

---

## Architecture (import direction: modules → platform → shared → core, never reverse)

```
backend/app/
  core/        config, database, security, dependencies, exceptions, pagination
  shared/      enums.py (ALL statuses), models/master.py (mst_), numbering.py,
               schemas, masters_router.py
  platform/    (lead-owned, same rule as core/shared)
    hcm/       client, mappers, sync, service, router  — mirror of HCM (hcm_*)
    rbac/      permissions.py, service, router          — roles/permissions (rbac_*)
    workflow/  engine.py, resolver.py, conditions.py    — approval engine (wf_*)
    auth/      login + /api/auth/me
    settings/  sys_ tables (settings, doc numbers, sync log, sessions, credentials)
  modules/     inventory (stk_/inv_), indents (ind_), procurement (pro_),
               logistics (lgs_)
               — each: models.py schemas.py service.py router.py tests/
               inventory is the BASE module: it imports nothing from app.modules, so
               indents can call allocate_for_indent() on approval without inverting
               the chain. It owns stock, reservations and material requests.
frontend/src/  shared/{api,auth,components,layout}, pages/, and
  modules/{indents,procurement,logistics}  — each mirrors the backend module:
               api.ts  types.ts  pages/  components/  tests/
```
Frontend modules mirror backend modules 1:1. Each frontend module owns a `tests/`
folder (Vitest) so a failure points at the module. Run: `npm test` (all) — tests
live beside the code they cover, never in a central folder.

### Frontend module pattern (so the team works in parallel)

- **UI comes from `@/shared/components`** (HeroUI-based kit): `Button, Card, StatCard,
  StatusPill, ResponsiveList, Can, PageHeader, Input, Select, Field`. Import these —
  never restyle primitives inside a module. HeroUI + the theme live in `hero.ts` /
  `src/index.css`; only the lead edits those and `src/shared/`.
- **A module dev only touches `src/modules/<name>/`.** Add a screen: create it in
  `pages/`, add a `<Route>` in `App.tsx`, and add a child row under the module's group
  in `scripts/seed.py` `PAGE_TREE`, then reseed. No shared files change.
- **Navigation is data-driven.** The left rail shows top-level modules only; a module's
  sub-pages surface as tabs, both derived from `rbac_pages` (`/api/auth/me` `menu[]`).
  To add/rename/reorder a screen in the menu, edit `PAGE_TREE` — not the layout.
- Colors/status come from the design tokens in `index.css` + `hero.ts`; use
  `StatusPill` for any document status and `StatCard` for KPIs.

Table prefixes = owning module: `hcm_ mst_ ind_ pro_ lgs_ stk_ rbac_ wf_ sys_`.
A module only creates tables with its own prefix.

## The business flow (each doc points BACKWARD to the previous)
Indent → PO (`indent_id`) → GRN (`po_id`) → Stock → Issue (`grn_id`/`indent_id`).
Handoffs: `create_po_from_indent`, `create_grn_from_po`, `qc_pass → move_stock`.

---

## Non-negotiable rules

1. Every module = same 5 files: `models.py schemas.py service.py router.py tests/`.
2. ALL business logic in `service.py`. Routers are 3–5 lines, no `if`.
3. Never a raw status string — always the enum from `app/shared/enums.py`.
4. Only the lead edits `core/`, `shared/`, `platform/`.
5. Imports one way: modules → platform → shared → core. Modules may import
   earlier modules in the chain, never later. The chain is:
   `inventory → indents → procurement → logistics → warehouse`.
6. Every endpoint has `Depends(require_permission("<code>"))`. Hiding a button is
   not security — the backend check is. Permission codes live only in
   `platform/rbac/permissions.py`; never invent one inline.
7. Physical stock changes ONLY through `inventory.service.move_stock()`, which
   always writes a `stk_ledger` row. Reservation columns (`available_qty` <->
   `reserved_qty`) change ONLY through `inventory.allocation`. Nothing else
   assigns to `stk_balance`. `stk_ledger` is append-only. Reserving is not a
   movement: `total_qty` is untouched and no ledger row is written.
8. Approvals ONLY through `platform/workflow/engine.py` (`start`, `act`,
   `current_approvers`, `pending_for_user`, `history`). No approval logic in a
   module. Engine owns the chain; the module owns the document status.
   Configuration must never strand a document: a missing workflow, a stage that
   resolves to nobody, and a missing `sys_doc_series` row all fall back
   (`platform/workflow/fallback.py`, `shared/numbering.py`) and log loudly.
   Who approves is configured per project per document type as a **ladder**
   (`platform/workflow/ladder.py`, Settings > Approvals Config). A ladder rung is a
   RANK — `hcm_positions.role_id`, HCM's org role — not a position and not a person.
   The approver is found at submit time by climbing the raiser's own
   `parent_position_id` chain and keeping the ancestors whose rank is switched on, so
   a five-region project routes each request to its own Regional Manager. The result
   is frozen onto `wf_instances.resolved_chain`, so editing a ladder never moves a
   document already in approval. No ladder for a project → the company-wide one → the
   old fallback. Not `level_id` (COO and SPH share a band) and not
   `hcm_positions.project_id` (empty in the live mirror — the project is on the
   employee).
9. Every state change: load → validate current status → change → write audit
   row → commit. Never delete a `wf_actions` row.
10. Async everywhere. `hcm_*` tables are READ-ONLY — written only by
    `platform/hcm/sync.py`. Every HCM field name lives only in `hcm/mappers.py`.
    Soft FKs (indexed, unconstrained) to `hcm_*`; hard FKs with CASCADE within a
    module and to `mst_*`. Snapshot display fields (name/code) at creation, never
    updated by sync. Never fetch bank/salary/EPFO/health data from HCM.
11. Lists always paginated: `{items, total, page, size}`. Errors: raise
    `AppException` subclasses → one shape `{success:false, error}`.
12. Frontend: each module has `api.ts types.ts pages/ components/ tests/` and mirrors
    a backend module. All HTTP through `src/shared/api/client.ts`. Every list screen
    uses `<ResponsiveList>` (table desktop, cards <768px). `<Can do="code">` for UX
    gating. 44px tap targets.
13. **No hardcoded config or secrets.** DB URL, SECRET_KEY, HCM base URL + key come
    only from `backend/.env` (required, no code defaults). Frontend API host comes
    from `VITE_API_URL` / `VITE_API_PROXY`, never a literal in code. No credentials,
    hosts, or keys baked into source. (Enums, permission codes, status maps are
    intentional constants, not config.)

## Before finishing any task
Run `pytest` (must pass) and `npm run build` (must compile). Don't create files
outside the structure above.

---

## Deviations from the docs (and why)

The docs are Postgres + "HCM has no data yet"; reality differed. Precedence 03>02>01
was applied; these are the resolved conflicts:

- **DB is MySQL, not Postgres** (per request), and there is **no SQLite fallback** —
  the app and the tests both run on MySQL. No `JSONB`/`gin`/partial-unique-index/
  `ON CONFLICT`. Uses portable `JSON`, plain indexes, app-level "one active workflow
  per doc_type", row-lock numbering, ORM upserts. One Alembic migration
  (`alembic/versions/*_initial_schema.py`). Tests run against a `scm_erp_test`
  database (conftest derives it from `DATABASE_URL`, drop/create per test).
- **No `users` table** (doc 03). Identity = `hcm_employees`; JWT carries `employee_id`;
  `get_current_user` returns an employee.
- **Auth without an HCM login endpoint**: SCM verifies against local
  `sys_user_credentials` and issues its own JWT. Swap `auth.service.authenticate`
  for an HCM call later — token/`/me`/`require_permission` are unchanged.
- **Enums extended** beyond guide Part 6 (higher docs require them): `IndentStatus/
  POStatus.PENDING_APPROVAL`; `ApprovalAction.RETURNED/DELEGATED`; new
  `DocType, InstanceStatus, ApproverType, ApprovalMode, ConditionOperator/Logic, RefType`.
- **Positions are HCM-mirrored** (doc 03 §11): no local `positions` table; resolver
  reads `hcm_position_assignments`. HCM's positions carry `assigned_employee` inline
  (its own assignments feed is empty), so sync derives assignments from positions.
- **`seed.py` bootstraps mock `hcm_*` rows** (employees, positions, assignments,
  departments, facility) because HCM's facilities/assignments feeds are empty. Real
  HCM data arrives via `POST /api/hcm/sync/{entity}` (live at the configured
  `HCM_BASE_URL` with `X-API-Key`). Item search uses `LIKE` (no Postgres full-text).
- **e2e** includes the `send-to-vendor` step (the GRN guard requires
  `SENT_TO_VENDOR`), which the doc's short arrow-chain omitted.

- **Tests need a local MySQL.** The live `SCM` account cannot `CREATE DATABASE`, so
  the suite cannot build its `_test` schema on the shared server. Set
  `TEST_DATABASE_URL` in `backend/.env` to a MySQL you own; without it every
  DB-backed test silently skips. The suite drops and recreates ~85 tables per test,
  so a full run takes ~10 minutes.

Frontend built: shared client/auth/layout, `<Can>`, `<ResponsiveList>`, the indents
pages, admin/masters/rbac, and the inventory screens (stock balance, ledger, transfers,
fulfilment queue, material requests) on real endpoints. Procurement screens and the
warehouse module are still to come — the warehouse frontend currently in the repo was
built against a different backend contract and is to be rewritten (see
`docs/04_SCM_BUSINESS_FLOW.md`).

**Masters, after the 2026-07-28 overhaul** (`docs/superpowers/specs/2026-07-28-masters-overhaul-design.md`):

- Item codes are `L1L2L3-GEN-BRAND-MFR-0001`. The serial is a locked `MAX+1` per
  prefix, assigned once at create and **never** regenerated on an edit — stock,
  ledger rows and documents point at the code the item was created with.
- Tax lives on `mst_hsn_codes` and is read at PO/GRN time, never copied onto an item.
  `mst_items.purchase_price` survives as the stock-valuation cost fallback, fed by
  GRN and hidden from the item form.
- A brand carries its manufacturers inline; there is no Brand-Manufacturer screen.
  Category names are unique **within a parent** (checked in Python — MySQL counts
  NULL `parent_id` values as distinct, so an index cannot do it).
- `mst_category_tags` is the one tagging surface for attributes, specs and features.
  `mst_attribute_mappings` is dead but not dropped; the migration copied it across.
- A package (`mst_packaging`) is a container type only. How much of an item one holds
  lives on `mst_item_packaging`, one row per level, and the breakdown is multiplied
  up on read so totals cannot drift from their rungs.
- Asset vs consumable is a per-item flag. The asset/consumable **code** is generated
  during putaway in the warehouse module, never in masters.
- Projects are read-only (HCM owns them): the write routes are not registered.
  Price lists left the API entirely; the tables remain.
