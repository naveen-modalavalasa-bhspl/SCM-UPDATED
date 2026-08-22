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
# A NEW database is built by bootstrap, not by Alembic: 46 tables (stock, the warehouse
# inbound/outbound documents, the masters chain, sys_doc_series, sys_local_credentials)
# were created by create_all or by hand and no migration creates them, and twelve later
# migrations then ALTER them — replaying that history from empty stops on the first one.
# bootstrap creates the tables from the models, stamps Alembic at head, seeds
# permissions/roles/menu, provisions each module and mints the `admin` login. No demo
# rows, no masters: log in, run the HCM sync, then load the masters. Idempotent.
.venv/Scripts/python -m scripts.bootstrap
# An EXISTING database is brought forward by Alembic, as before:
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
               logistics (lgs_),
               alerts   — no tables: the catalog of popup/confirm copy, served so
                          every screen announces the same event the same way
               reports  — no tables: read-only ledgers (`ledgers.py` LedgerSpec) over
                          indents, wf_actions, stk_ledger and the warehouse documents,
                          with Excel/CSV export. Registered last: it reads every
                          module and nothing reads it back
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

### Fulfilment: one desk, and a signed allocation is terminal (2026-08-21)

**The Fulfilment Queue and Allocation Approvals are ONE screen** — the **Fulfilment
Desk**, `/inventory/fulfilment`, page code `inv_fulfilment_desk`. They were two halves
of a single decision: the queue listed what an indent was still owed and took the
decision, and a second screen signed it. Where a project's ladder says `NO_APPROVAL`
that second screen was a page with one button on it; where a real ladder is configured
the approver had to leave the numbers behind to go find the document. It is two tabs
now — **To allocate** and **To approve** — over the same rows, gated separately on
`allocation.create` and `allocation.approve`, so a storekeeper who allocates but does
not approve still sees one tab. `FulfilmentDeskPage` renders the two original page
components with `embedded`; neither keeps a second copy of the other's rules.

This is **not** a way around the ladder. Every press still goes through
`allocations.create` / `allocations.act`, which ask `platform/workflow/ladder` who
signs. How many presses a fulfilment takes is decided on Settings > Approvals Config,
per project, per document type — never in the screen.

`inv_fulfillment` and `inv_allocation_approvals` are in `page_registry.RETIRED_PAGES`
(`is_active = 0`, every grant kept), and `page.inv_fulfilment_desk.view` inherits from
`page.inv_fulfillment.view` — the wider of the two, since the buttons are still gated
one by one. Both old paths redirect; `/inventory/allocation-approvals` redirects
through `LegacyAllocationApprovalsRedirect` because the notification for an allocation
carried `?review=<id>` and a plain `<Navigate>` would have dropped it. The review and
monthly-cycle screens (`/inventory/allocation-approvals/:id`, `/cycle/:cycle`) never
moved.

**An approved allocation is TERMINAL.** It is never reopened, topped up or
re-approved. An indent served in rounds collects one allocation per round, each with
its own ladder, reservations and issue draft. `AWAITING_PROCUREMENT` is retired
(`a1c2e3f4b5d6` renames the rows; the enum value survives so an unmigrated database
still reads its old rows as signed).

The invariant that replaces it: **what an indent is still owed is READ, never stored.**
It is `approved − allocated − on order`, computed by
`indents.list_indents(has_remainder=True)` and by `fulfilment_batches` for a monthly
cycle. Arriving stock changes that answer by existing, so the indent returns to the
desk on its own and nothing has to be notified. The whole reopen machinery —
`reopen_for_available_stock`, `reopen_for_receipt`, `_prefill_from_shelf`,
`ON_APPROVED_HOOK` — is gone, and with it six defects that were one per doorway stock
can reach a shelf through. **Do not reintroduce a "wake the document" path.** If an
allocation needs to come back, the answer is a new allocation off the desk.

What is load-bearing because of it, all failing SILENTLY if narrowed:
`list_indents(has_remainder=True)`, `indents._SETTLED_MR_STATUSES` (its "on order"
term — `DRAFT` counts as settled: nobody is buying an unsubmitted request),
`SETTLED_ALLOCATION_STATUSES`, and `mark_mrs_received` (closing the MR is what stops
the quantity counting as on order). The module docstring on
`inventory/allocations.py` carries the full list.

Four defects fixed alongside, on the first-approval path where they always lived:
`apply_to_stock` now reads `reserve()`'s return and corrects the line down when the
point held less than was promised (it reserved short and still reported the full
number, so an indent closed ALLOCATED over stock nobody held); the "is it genuinely
spare" check is **warehouse-tier only**, since LIP/MDP stock counted as spare and
suppressed the material request; the one-press path takes `_assert_still_available`
under row locks before settling, because with `NO_APPROVAL` there is no later locked
check; and `create_mr_from_shortfall` deduplicates per indent **line**, not per indent
— per indent was enough while a shortage was raised once, and rounds of serving mean a
later shortage on the same indent is a different shortage that was being dropped.

### The outward leg (doc Phase D+E), under Logistics

Logistics runs the whole outward leg, in the order it happens:

```
Consignments → Dispatch → Shipments → Provider Selection → Activity Ledger
```

**Consignments is the WAREHOUSE's document** (`out_dispatches`) and its own screen,
served at `/logistics/consignments` and re-exported from `modules/warehouse`, which
still owns the implementation. `/warehouse/consignments` renders the same component
inside the warehouse rail; nothing of the warehouse's is touched.

**The warehouse's own Dispatch door is retired** (2026-08-21). `/warehouse/dispatch/*`
was a rival lifecycle on the same table — create, submit, approve, packages, gate out
— and `gate_out` sets DISPATCHED without ever raising a transport request, so a load
left with no carrier, no freight, no LR and nothing in the activity ledger. 26 of the
30 consignments on the road went out that way. The screens are no longer rendered
(`Dispatch.tsx`, `DispatchForm.tsx` stay on disk, unimported), every `/warehouse/
dispatch/*` path redirects into `/logistics/*`, and `wh_consignments` / `wh_dispatch`
are in `page_registry.RETIRED_PAGES` — `is_active = 0`, grants kept, so an admin can
put them back. `/api/warehouse/dispatches/*` stays registered: existing rows must
still be readable, and the gate pass still prints from
`/warehouse/dispatches/{id}/print`. `_apply_gate_out` was always shared with the
logistics release hook, so the stock side never had two copies.

**Dispatch** (`DispatchPage.tsx`, the queue → `DispatchConfirmPage.tsx`, the press →
`POST /api/transport/dispatch-consignment`) is the one decision the floor makes: how
does this consignment travel, and with whom. Pick the consignment, write the gate
pass, pick the mode and the provider from the carrier vendors, press once — the
transport request is raised, filled in from the packing list and sent on. THIRD_PARTY
lands in that provider's portal for a price; every other mode is settled on the spot
and goes straight to READY. The desk accepts the price (`/accept-quote`) or sends it
back for another (`/ask-revised-quote`). Accepting is our half only: it lands on
`AWAITING_CARRIER` and the provider's own yes — their portal, or the desk recording
one via `/carrier-confirm` — makes it READY, because a price quoted for a lane is not
a promise of a vehicle on the day. No second APPROVAL, though: the consignment was
already approved and released by the warehouse, and approving the SPEND is the award.

The providers that fill that dropdown are `mst_vendors` rows of a carrier type, kept
on **Settings > Logistics Vendors** (`/settings/logistics-vendors`,
`/api/logistics-vendors`, `logistics/partners.py`). One screen: name the partner and
issue their portal login in the same press, because a partner with no account cannot
answer the quote request THIRD_PARTY exists to send them. Every route refuses a vendor
row that is not a carrier, so the logistics desk's permission can never reach a
material supplier's record or password. The account itself is procurement's
(`ensure_vendor_account`) — there is one kind of vendor login, and a carrier IS a
vendor.

The confirm screen (`/logistics/dispatch/new?consignment_id=`) is where BOTH front
doors land — the queue's Dispatch button and a packed consignment's own Confirm
dispatch — so the decision is built once. A logistics day never crosses into the
warehouse module: `ConsignmentForm` reads which door it was opened from and keeps
every route it pushes on that side, because hardcoded `/warehouse/...` links handed
the logistics desk over to the warehouse module halfway through the flow.

**Shipments** is logistics' own document (`lgs_transport_requests`) and carries the
leg that moves a consignment. The screen is **Shipments** on `/logistics/shipments`
(2026-08-21): a row stops being a "transport request" the moment it is awarded and
spends the rest of its life as a load on a truck, which is what the register lists —
lane, load, LR/docket, freight, and the queues from DRAFT through CLOSED. Only the
USER-FACING name moved. The page code (`logistics_transport`), the permission codes
(`transport.*`), the table, `tr_no` and the `TR-` prefix are unchanged, so every grant
already issued still resolves; `sync_pages` refreshes an existing row's path and name
on the next start, and `/logistics/transport/*` redirects with its tail intact because
the approvals inbox deep-links straight at a leg:

```
TR  DRAFT → PENDING_APPROVAL → QUOTING* → AWAITING_CARRIER* → READY
    → IN_TRANSIT → DELIVERED → ACKNOWLEDGED → CLOSED         (* THIRD_PARTY only)
```

- The consignment link is `lgs_transport_requests.dispatch_id` plus a snapshot of its
  number. Logistics' BACKEND never touches `out_dispatches` — warehouse sits after
  logistics in the import chain (rule 5) — so the transport form reads the consignment
  over HTTP (`/api/warehouse/consignments`) and prefills its lines from the packing
  list, counting each carton once.
- **An award is an offer.** A won tender goes to `AWAITING_CARRIER` and only the
  carrier accepting it (their portal, or a desk confirmation recorded as one) makes it
  `READY`. A decline unwinds the award, marks that quote DECLINED, puts every other
  quote back to SUBMITTED and returns the shipment to the tender. The single-provider
  dispatch path (`accept_quote`) lands on the same rung for the same reason — the two
  differ in whether there was a tender, never in whether the carrier gets a say.
- **Delivered is the carrier's word; acknowledged is the site's.** A carrier can never
  set `ACKNOWLEDGED` — the receiving site signs, and SHORT/DAMAGED raises a claim on
  the same shipment timeline (`lgs_shipment_events`), which the Activity Ledger reads.
- **The Activity Ledger replaced Shipment Tracking and Exceptions** (2026-08-19).
  Those two each drew ONE slice of the same trail — where is it now, what went wrong —
  so a desk chasing a consignment read half the story on one tab and half on another,
  and neither said who awarded the job, at what price, or when the carrier agreed to
  it. `transport.activity_ledger` (`GET /api/transport/activity`) unions the four
  places a logistics event is ALREADY recorded — the request header, `wf_actions` for
  both doc types, `lgs_carrier_quotes` and `lgs_shipment_events` — so nothing is
  written for the ledger's benefit and it cannot show an event the documents do not
  carry. `?dispatch_id=` scopes it to one consignment's trail, which is how the
  Dispatch queue opens it per row. The wording of an event and the rung it puts the
  shipment on are SERVED from `enums.ACTIVITY_META` (`/activity-types` feeds the
  filter), never mapped in the screen. Closing a claim moved onto the claim itself,
  in `ShipmentTimeline` — a ledger is a record, not a work queue. Both retired paths
  redirect to `/logistics/activity`; `c5d6e7f8a9b2` parks their menu rows, and
  `page.logistics_activity.view` inherits its grants from
  `page.logistics_tracking.view` so the desk that worked the board keeps the screen
  that replaced it.
- The stepper and the mode rules are SERVED (`/api/transport/flow`, `/modes`), never
  duplicated in the screen.
- The carrier portal is the vendor account (`/carrier/*`, served under `/api/supplier`
  so the shared axios client attaches the vendor token; also mounted at `/api/carrier`).
  Every function takes the carrier id from the token, and past the award only the
  winner can WRITE the shipment. **Losing a tender is an answer, and the portal gives
  it**: `_carrier_scope(..., lost=True)` is a second, read-only scope — a request past
  QUOTING, carrying a quote of theirs, awarded to somebody else — served as its own
  queue (`?status=NOT_AWARDED`, plus `not_awarded` on the summary) and never mixed into
  the live ones, so an unawarded shipment can't surface under "collect". It reads over
  `CARRIER_OUTCOME_STATUSES`, which is the live set plus CLOSED: closing ends the
  WINNER's work, but to the carrier who lost it closed is the final answer, and most
  tenders end there — leaving it out was the whole queue coming up empty. Rows on it are
  redacted to `WINNER_ONLY_FIELDS` on a detached schema: the loser keeps the lane, the
  load and their own quote, and is shown neither the winning price nor the carrier nor
  the tracking. Which of outbid / declined / never-priced it was comes from THEIR quote
  status, because past the award the shipment's status describes another carrier's
  truck. Before this the shipment simply vanished off their board with nothing said —
  and the "you won this shipment" panel keyed on AWAITING_CARRIER alone, so it drew for
  the loser too.

**What the merge into `qa` changed** (2026-08-17), on top of the branch as delivered:

- **One Alembic head again.** The logistics branch carried its own mergepoint
  (`b2d3e4f5a6c7`), cut when the procurement branch still ended at `f2a3b4c5d6e8`;
  that branch has since grown to `c4d5e6f7a8b0`, so the two sides were two heads and
  `alembic upgrade head` refused to run at all. `a9b8c7d6e5f4` joins them. No schema
  of its own.
- **The one-press dispatch asks the ladder.** `dispatch_consignment` skipped approval
  outright. It now calls `ladder.find_ladder` first: nothing configured (every project
  today) and it lands exactly where it did before, straight to QUOTING or READY. A
  configured TRANSPORT_REQUEST ladder is honoured. It does NOT call `engine.start`
  unconditionally — with nothing configured the engine climbs the raiser's reporting
  line, which would have put every dispatch into a stranger's queue.
- **The logistics pages are in `PAGE_VIEW_CODES`.** They were being invented by
  `sync_pages`, which grants Admin and nothing else and never revisits the row. Now
  catalogued, so `page.logistics_acknowledgements.view` inherits from
  `page.logistics_tracking.view` — the new screen lands with the desk that already
  works Tracking, matching `transport.acknowledge` inheriting `transport.track`.
  `settings_logistics_vendors` stays Admin-only on purpose: it mints an outside login,
  and the Dispatch dropdown reads carrier names from `transport.view` instead.
- **`sync_permission_labels` runs BEFORE `sync_pages`** in `main.py` for that to work:
  whichever runs first creates the row, and only the first of the two honours
  `INHERITS_GRANTS_FROM`.
- **The rank abbreviation map in `IndentStatusBadge` was taken back out.** RM/DM/OE/
  SPH/COO hardcoded in the frontend is wrong twice — the rungs are HCM role ids that a
  cutover re-keys, and an admin picks them per project on Approvals Config — and it hid
  the approver's name behind their rank.
- Still true after the merge: the `/logistics/consignments` screens read
  `/api/warehouse/consignments`, which is guarded by `dispatch.view`. A Logistics job
  profile needs `dispatch.view` (and `dispatch.create` to edit one) on top of the
  `transport.*` codes. That is unchanged by this work, not introduced by it.

---

## Non-negotiable rules

1. Every module = same 5 files: `models.py schemas.py service.py router.py tests/`.
2. ALL business logic in `service.py`. Routers are 3–5 lines, no `if`.
3. Never a raw status string — always the enum from `app/shared/enums.py`.
4. Only the lead edits `core/`, `shared/`, `platform/`.
5. Imports one way: modules → platform → shared → core. Modules may import
   earlier modules in the chain, never later. The chain is:
   `inventory → indents → procurement → logistics → warehouse → returns`.
   `integrations` sits outside the chain with `reports`: it reads every module
   and nothing reads it back.
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

## The HCM cutover (2026-08-10)

HCM was rebuilt and now serves `:8009` with a new key. Two things came with it: the
**sections** that say which distribution rung a post serves (`L I P`, `M.D.P` — the
only place the org states that a position is a stocking point), and a **populated
reporting tree**. The old `:8001` feed is still up and both payload shapes are still
read, so the base URL is the only switch.

What does NOT survive the switch is identity. HCM re-keyed everything except
employees: **0 of 3733 position ids and only 461 of 1504 office ids** carry over, and
8 employee ids came back holding a different person. So:

- Approval **ladders and any `POSITION`-pinned `wf_stages` row must be reconfigured**
  after a cutover; the rungs are role ids and those are new too (7 roles: SPH,
  Regional Manager, District Manager, OE, Driver, DEO, Store Keeper).
- `sys_local_credentials` is keyed on the employee id, and a sync never re-issues it.
  Where an id changed hands, that person's old password now opens a session as the
  new holder — `scripts/hcm_cutover.py` prints every one; re-issue them by hand.
- `hcm_position_assignments` is derived from the `assigned_employee` on each position,
  never from HCM's own `position-assignments` feed: the two id ranges overlap and
  would silently reseat people. That feed is out of `sync.NEEDED_ENTITIES` on purpose.

**Deploying it** is a `.env` change plus two commands, in this order, on whichever
database `DATABASE_URL` points at:

```
.venv/Scripts/python -m alembic upgrade head      # adds hcm_positions.section_id/
                                                  # section_name, hcm_offices.office_mode
.venv/Scripts/python -m scripts.hcm_cutover       # sync + retire the old generation
```

Both are idempotent — re-running the cutover retires 0 and reports 0 moves. Note that
pointing `DATABASE_URL` somewhere else does **not** carry data with it: each database
is brought up to date by running these two commands against it.

Stocking points are no longer a backfill: `inventory.locations.rebuild_stocking_points`
is registered in `hcm.sync.POST_SYNC_HOOKS`, so every sync derives the warehouses from
the sections and links the positions to them. On a database synced from empty that is
948 LIP + 33 MDP + 2 MAIN warehouses and 4004 `inv_position_locations` rows, built
without anyone asking for it.

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
  A general name carries its brands the same way (`mst_brand_general_names`), so the
  item form narrows the whole chain: Category → General Name → Brand → Manufacturer.
  An **unmapped** general name falls back to every brand rather than to none — the
  mapping starts empty, and narrowing strictly would block every item create.
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
  Price lists left the API entirely; the tables remain, and are staying out.
- **Every master gets template/export/import for free** (`shared/masters/bulk.py`):
  `GET {base}/template`, `GET {base}/export`, `POST {base}/import`, all derived from
  the same Pydantic schema CRUD validates against. Import is **all-or-nothing** — every
  row is validated first and a single bad row rejects the file with the full problem
  list, because a half-applied master cannot be re-uploaded safely. An empty cell means
  "say nothing about this column" (the schema default applies), never `None`.
- `GET {base}/{id}/usage` counts what points at a row before it is deactivated.
  Declared in `MasterDef.usage` as `(label, table, column)` strings, not models —
  most referents live in `app.modules` and shared may not import a module (rule 5).
- `mst_vendor_items` (vendor rate, lead time, MOQ, preferred supplier) is a master
  with a screen. At most one preferred vendor per item, enforced in `apply_vendor_item`
  — "at most one TRUE per item" is not something a unique index can express.
- **69 of 90 live items predate the mandatory general-name/brand/manufacturer rule**
  and hold NULLs, so exporting the item master and re-importing it rejects those rows
  with "Field required". That is the data being incomplete, not the importer.
