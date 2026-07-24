# SCM ERP — Part 3: HCM Integration + Database Design

Read after `SCM_ERP_BUILD_GUIDE.md` and `SCM_ERP_ADDENDUM.md`.
This replaces Part 5 of the main guide (the schema) and Part C's user/position tables.

---

# 1. THE BIG DECISION: MIRROR, DON'T CALL LIVE

You have two ways to use HCM data. Only one of them works.

## ❌ Live calls (do not do this)

Every screen calls HCM to get employee names, department names, office names.

What goes wrong:
- Your indent list screen needs 20 employee names → 20 HTTP calls, or one call and manual matching in Python
- You cannot `ORDER BY employee_name` or `WHERE department = X` — that data isn't in your database
- Pagination breaks. Search breaks. Reports break.
- HCM goes down → your entire ERP goes down
- Every page load waits on another server

## ✅ Mirror locally (do this)

Sync the HCM entities you need into your own read-only tables. Then they're just normal tables you can join, filter, sort and index.

- SCM works even if HCM is down
- One SQL query serves a screen
- Search and sort work normally
- HCM stays the single source of truth — you never edit mirrored data

**The rule: `hcm_*` tables are READ-ONLY in SCM. Written by the sync job only. Never by a service function, never by a user.**

The `hcm_` prefix exists so this is obvious at a glance. If a dev writes `INSERT INTO hcm_employees`, the code review catches it instantly.

---

# 2. WHAT TO PULL FROM HCM (and what to leave alone)

## Mirror these — you need them

| HCM endpoint | Why SCM needs it |
|---|---|
| `employees` | Requester, approver, creator, receiver on every document |
| `offices` | Which office raised the indent; delivery destination |
| `facilities` | **Warehouses / stores — stock lives here.** Critical. |
| `facility-masters` | Facility types (warehouse / cold store / office store) |
| `departments` | Indent raiser, cost centre |
| `sections` | Sub-department, if your indents go to that granularity |
| `positions` | **Approval routing targets.** The workflow engine needs these. |
| `position-levels` | Hierarchy depth — escalation, "one level up" |
| `position-assignments` | Which employee holds which position. The join that makes routing work. |
| `organization-levels` | Org tree, if approval escalates up it |

## Fetch on demand, don't mirror

| Endpoint | Use |
|---|---|
| `locations` | Delivery addresses — pull when creating a dispatch, store a snapshot |
| `geo-states`, `geo-districts` | Only if vendor/delivery addresses need dropdowns. Cache for a day. |

## Ignore completely

`reactivations`, `login-hits`, `account-block-history`, `employee-archives`, `job-families`, `jobs`, `tasks`, `task-urls`, `position-activity-logs`, `projects`, `api-keys`, `document-types`, `employee-documents`, `employee-education`, `employee-experience`, `employee-employment-history`, `geo-continents`, `geo-countries`, `geo-mandals`, `geo-clusters`, `visiting-locations`, `landmarks`, `audit-logs`

## 🚨 NEVER pull these — sensitive HR data

```
employee-bank-details
employee-salary-details
employee-epfo-details
employee-health-details
```

These have no business purpose in a supply chain system. Pulling them means salary and medical data now lives in a second database, doubling your breach surface for zero benefit. If anyone asks for them, the answer is no.

## ⚠️ The trap: `roles` and `employee-permissions` from HCM

HCM's `roles` are **HR job roles** ("Store Supervisor", "Purchase Officer"). HCM's `employee-permissions` are permissions *for HCM*, not for SCM.

**SCM permissions are SCM's own.** Keep `rbac_roles` / `rbac_permissions` entirely local, as designed in the addendum.

You may mirror HCM roles as a *label* to help admins ("this user's HR role is Purchase Officer, suggest giving them the PROCUREMENT role in SCM") — but never derive SCM access from them. Two systems, two permission models, deliberately.

---

# 3. TABLE NAMING CONVENTION

Three-letter prefix = the module folder that owns the table.

| Prefix | Owner | Meaning |
|---|---|---|
| `hcm_` | platform/hcm | Mirrored from HCM. **Read-only.** |
| `mst_` | shared | SCM's own master data |
| `ind_` | modules/indents | Indents |
| `pro_` | modules/procurement | Purchase orders |
| `lgs_` | modules/logistics | GRN, issues, dispatch |
| `stk_` | modules/logistics | Stock and movements |
| `rbac_` | platform/rbac | Roles, permissions, pages |
| `wf_` | platform/workflow | Approval engine |
| `sys_` | platform | Settings, numbering, sync logs, audit |

Open any DB tool, sort alphabetically, and the tables group themselves by module. A new developer sees `pro_purchase_orders` and knows to look in `modules/procurement/`.

**Rule: a module may only create tables with its own prefix.** Dev B never creates an `ind_` table. If procurement needs something in indents, it goes through the indents service.

---

# 4. HCM MIRROR TABLES

## The pattern

Every mirrored table follows the same shape:

```sql
hcm_employees (
    id              BIGINT PRIMARY KEY,      -- HCM's id, used directly. No mapping table.
    emp_code        VARCHAR(50) UNIQUE,
    full_name       VARCHAR(200) NOT NULL,
    email           VARCHAR(200),
    mobile          VARCHAR(20),
    department_id   BIGINT,                  -- HCM dept id, NOT a hard FK
    section_id      BIGINT,
    office_id       BIGINT,
    is_active       BOOLEAN DEFAULT TRUE,
    raw             JSONB,                   -- full HCM payload
    synced_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON hcm_employees (department_id);
CREATE INDEX ON hcm_employees (office_id);
CREATE INDEX ON hcm_employees (is_active);
CREATE INDEX ON hcm_employees (full_name);
```

Three design choices worth understanding:

**HCM's id is your primary key.** No local id, no mapping table. One less thing to get wrong.

**`raw JSONB` holds the complete payload.** When someone asks in month three for a field you didn't map, it's already there — no re-sync, no migration to backfill. This is your main defence against changing requirements.

**Foreign keys between `hcm_` tables are soft (no DB constraint).** HCM may send an employee whose department hasn't synced yet. A hard FK would make the sync fail; a soft one just leaves a gap you can fix on the next run. Index them, don't constrain them.

## The tables

```sql
hcm_offices (
    id, code, name, office_type, address, city, state,
    is_active, raw, synced_at
)

hcm_facilities (                         -- warehouses / stores
    id, code, name, facility_type_id, office_id, address,
    is_stock_location BOOLEAN,           -- SCM's own flag, set by admin
    is_active, raw, synced_at
)

hcm_facility_types (
    id, code, name, is_active, raw, synced_at
)

hcm_departments (
    id, code, name, office_id, head_employee_id,
    is_active, raw, synced_at
)

hcm_sections (
    id, code, name, department_id, is_active, raw, synced_at
)

hcm_positions (
    id, code, name, level_id, parent_position_id,
    department_id, office_id, is_active, raw, synced_at
)

hcm_position_levels (
    id, code, name, level_order, is_active, raw, synced_at
)

hcm_position_assignments (               -- who holds which position
    id, employee_id, position_id, department_id, office_id,
    is_primary, valid_from, valid_to, is_active, raw, synced_at
)
```

`hcm_position_assignments` is the most important table for your workflow engine. `resolve_approvers()` reads it to turn "Stage 2 goes to the Plant Head" into actual user rows.

**One SCM-owned column:** `hcm_facilities.is_stock_location`. HCM doesn't know which facilities hold inventory — that's an SCM concept. The sync job must **not** overwrite this column. Write the sync as an explicit column-list upsert, never `UPDATE SET everything`.

## Sync tracking

```sql
sys_hcm_sync_log (
    id, entity, started_at, finished_at, status,
    records_fetched, records_upserted, error_message
)
```

## Sync strategy

| When | What |
|---|---|
| Nightly (2 AM cron) | Full sync of all mirrored entities |
| Admin button | "Sync from HCM now" per entity — you'll use this constantly during the build |
| On login | Refresh that one employee's record |
| On cache miss | Employee id referenced but not in mirror → fetch that one record, insert, continue |

Order matters — parents first: offices → facility_types → facilities → departments → sections → position_levels → positions → employees → position_assignments.

Wrap each entity in its own transaction. One entity failing shouldn't roll back the rest.

## Where the sync code lives

```
backend/app/platform/hcm/
├── client.py       # httpx async client, auth, retries, timeouts
├── models.py       # the hcm_* tables
├── mappers.py      # HCM JSON -> your columns. ALL field mapping lives here.
├── sync.py         # the sync jobs, ordering, upsert logic
├── service.py      # read helpers used by other modules
├── router.py       # admin sync endpoints
└── tests/
```

**Every HCM field name appears in exactly one file: `mappers.py`.** When HCM renames a field, you change one file. This is worth insisting on.

`client.py` needs: timeout (5s), retry with backoff (3 attempts), and a circuit breaker so a dead HCM doesn't hang your workers.

---

# 5. THE DENORMALISATION RULE (your "don't make me join everything")

You're right to worry, and there's a correct way to do it.

## Snapshot display fields on every transaction table

```sql
ind_indents (
    ...
    requested_by_id        BIGINT,        -- FK to hcm_employees
    requested_by_name      VARCHAR(200),  -- SNAPSHOT
    requested_by_code      VARCHAR(50),   -- SNAPSHOT
    department_id          BIGINT,
    department_name        VARCHAR(200),  -- SNAPSHOT
    office_id              BIGINT,
    office_name            VARCHAR(200),  -- SNAPSHOT
    ...
)
```

The list screen becomes one query with zero joins:

```sql
SELECT indent_no, requested_by_name, department_name, status, created_at
FROM ind_indents
WHERE status = 'PENDING_APPROVAL'
ORDER BY created_at DESC
LIMIT 20;
```

## This isn't a shortcut — it's correct ERP practice

Snapshots aren't just faster, they're more *accurate*. If an employee transfers department next year, an indent they raised in March must still show the department it was raised under. A live join would silently rewrite history. Auditors care about this.

## The three rules

1. **Snapshot fields are written once, at document creation.** Never updated by the HCM sync. A document records the world as it was.
2. **Keep the id alongside the name.** The id is for filtering and linking; the name is for display.
3. **Snapshot only what appears on list screens.** Name, code, department, office. Not the whole employee record.

## Where you still keep real relations

Don't drop relations everywhere — that's the opposite mistake.

**Keep hard FKs within a module:** `ind_indent_items.indent_id → ind_indents.id` with `ON DELETE CASCADE`. Losing this means orphaned line items and corrupt totals.

**Keep hard FKs to SCM masters:** `ind_indent_items.item_id → mst_items.id`. You control both sides.

**Use soft FKs (no constraint) to HCM data:** the mirror may lag. Index them, don't constrain them.

Short version: **hard FKs for data you own, soft for data you mirror, snapshots for anything you display in a list.**

---

# 6. THE FULL SCHEMA

## `mst_` — SCM master data

```sql
mst_uom (
    id, code, name, is_active, created_at
)

mst_item_categories (
    id, code, name, parent_id, is_active, created_at
)

mst_items (
    id, code UNIQUE, name, description,
    category_id      -> mst_item_categories,
    category_name    VARCHAR(200),       -- snapshot
    uom_id           -> mst_uom,
    uom_code         VARCHAR(20),        -- snapshot
    hsn_code, reorder_level, is_active,
    created_at, updated_at
)
CREATE INDEX ON mst_items (category_id);
CREATE INDEX ON mst_items (is_active);
CREATE INDEX ON mst_items USING gin (to_tsvector('english', name));  -- search

mst_vendors (
    id, code UNIQUE, name, contact_person, phone, email,
    address, city, state, gstin, pan,
    payment_terms, is_active, created_at, updated_at
)
CREATE INDEX ON mst_vendors (is_active);
CREATE INDEX ON mst_vendors (name);

mst_vendor_items (                       -- which vendor supplies what, at what rate
    id, vendor_id, item_id, last_rate, lead_time_days, is_preferred
)
```

## `ind_` — Indents

```sql
ind_indents (
    id BIGSERIAL PK,
    indent_no VARCHAR(30) UNIQUE,
    indent_date DATE,
    required_date DATE,

    -- who (soft FK + snapshot)
    requested_by_id BIGINT,
    requested_by_name VARCHAR(200),
    requested_by_code VARCHAR(50),
    department_id BIGINT,
    department_name VARCHAR(200),
    section_id BIGINT,
    office_id BIGINT,
    office_name VARCHAR(200),
    facility_id BIGINT,                  -- deliver to which store
    facility_name VARCHAR(200),

    -- state
    status VARCHAR(30),                  -- IndentStatus enum
    priority VARCHAR(20),                -- NORMAL | URGENT
    total_items INT,                     -- denormalised count
    remarks TEXT,

    -- approval summary (denormalised from wf_ so the list screen needs no join)
    current_approver_name VARCHAR(200),
    approved_at TIMESTAMPTZ,

    created_at, updated_at
)
CREATE INDEX ON ind_indents (status);
CREATE INDEX ON ind_indents (department_id, status);
CREATE INDEX ON ind_indents (requested_by_id);
CREATE INDEX ON ind_indents (created_at DESC);

ind_indent_items (
    id, indent_id -> ind_indents ON DELETE CASCADE,
    item_id -> mst_items,
    item_code VARCHAR(50),               -- snapshot
    item_name VARCHAR(300),              -- snapshot
    uom_code VARCHAR(20),                -- snapshot
    quantity NUMERIC(14,3),
    approved_quantity NUMERIC(14,3),
    ordered_quantity NUMERIC(14,3),      -- rolled up from POs
    received_quantity NUMERIC(14,3),     -- rolled up from GRNs
    remarks
)
CREATE INDEX ON ind_indent_items (indent_id);
CREATE INDEX ON ind_indent_items (item_id);
```

That last pair — `ordered_quantity` and `received_quantity` maintained on the indent line — is what lets you show indent progress without querying procurement and logistics. Procurement updates it when a PO is created; logistics updates it on GRN.

## `pro_` — Procurement

```sql
pro_purchase_orders (
    id, po_no UNIQUE, po_date, expected_date,

    indent_id -> ind_indents,
    indent_no VARCHAR(30),               -- snapshot

    vendor_id -> mst_vendors,
    vendor_name VARCHAR(200),            -- snapshot
    vendor_gstin VARCHAR(20),            -- snapshot

    created_by_id BIGINT,
    created_by_name VARCHAR(200),        -- snapshot
    office_id BIGINT,
    facility_id BIGINT,                  -- deliver to
    facility_name VARCHAR(200),

    status VARCHAR(30),
    sub_total NUMERIC(16,2),
    tax_amount NUMERIC(16,2),
    total_amount NUMERIC(16,2),
    current_approver_name VARCHAR(200),
    approved_at TIMESTAMPTZ,
    remarks, created_at, updated_at
)
CREATE INDEX ON pro_purchase_orders (status);
CREATE INDEX ON pro_purchase_orders (vendor_id);
CREATE INDEX ON pro_purchase_orders (indent_id);
CREATE INDEX ON pro_purchase_orders (po_date DESC);

pro_po_items (
    id, po_id -> pro_purchase_orders ON DELETE CASCADE,
    indent_item_id -> ind_indent_items,
    item_id, item_code, item_name, uom_code,   -- snapshots
    quantity NUMERIC(14,3),
    rate NUMERIC(14,2),
    tax_percent NUMERIC(5,2),
    amount NUMERIC(16,2),
    received_quantity NUMERIC(14,3) DEFAULT 0
)
```

## `lgs_` and `stk_` — Logistics and Stock

```sql
lgs_grn (
    id, grn_no UNIQUE, grn_date,
    po_id -> pro_purchase_orders,
    po_no VARCHAR(30),                   -- snapshot
    vendor_id, vendor_name,              -- snapshot
    facility_id BIGINT,
    facility_name VARCHAR(200),          -- snapshot
    invoice_no, invoice_date, vehicle_no, transporter,
    received_by_id BIGINT,
    received_by_name VARCHAR(200),
    status VARCHAR(30),
    total_items INT,
    remarks, created_at, updated_at
)
CREATE INDEX ON lgs_grn (po_id);
CREATE INDEX ON lgs_grn (status);
CREATE INDEX ON lgs_grn (facility_id, grn_date DESC);

lgs_grn_items (
    id, grn_id ON DELETE CASCADE,
    po_item_id, item_id, item_code, item_name, uom_code,
    ordered_quantity, received_quantity,
    accepted_quantity, rejected_quantity,
    batch_no, expiry_date, remarks
)

lgs_issues (
    id, issue_no UNIQUE, issue_date,
    indent_id, indent_no,                -- snapshot
    facility_id, facility_name,          -- issued from
    department_id, department_name,      -- issued to
    issued_to_id BIGINT, issued_to_name VARCHAR(200),
    issued_by_id BIGINT, issued_by_name VARCHAR(200),
    status VARCHAR(30), remarks, created_at
)

lgs_issue_items (
    id, issue_id ON DELETE CASCADE,
    item_id, item_code, item_name, uom_code,
    quantity, batch_no
)

stk_stock (                              -- current balance, one row per item+facility
    id, facility_id BIGINT, item_id -> mst_items,
    item_code VARCHAR(50), item_name VARCHAR(300),   -- snapshot
    quantity NUMERIC(16,3) DEFAULT 0,
    reserved_quantity NUMERIC(16,3) DEFAULT 0,
    updated_at,
    UNIQUE (facility_id, item_id)
)
CREATE INDEX ON stk_stock (facility_id);
CREATE INDEX ON stk_stock (item_id);

stk_movements (                          -- append-only ledger. Never update or delete.
    id BIGSERIAL, facility_id, item_id,
    direction VARCHAR(3),                -- IN | OUT
    quantity NUMERIC(16,3),
    balance_after NUMERIC(16,3),
    ref_type VARCHAR(20),                -- GRN | ISSUE | ADJUSTMENT | TRANSFER
    ref_id BIGINT, ref_no VARCHAR(30),
    created_by_id BIGINT, created_by_name VARCHAR(200),
    remarks, created_at
)
CREATE INDEX ON stk_movements (item_id, created_at DESC);
CREATE INDEX ON stk_movements (facility_id, item_id);
CREATE INDEX ON stk_movements (ref_type, ref_id);
```

**Facility-wise stock is not optional.** If HCM gives you multiple facilities, stock has to be per facility or the numbers are meaningless. The unique constraint on `(facility_id, item_id)` is what makes the upsert in `move_stock()` safe under concurrency.

## `wf_`, `rbac_`, `sys_`

As designed in the addendum, renamed to the convention:

```sql
wf_workflows, wf_stages, wf_stage_conditions,
wf_instances, wf_actions, wf_delegations

rbac_permissions, rbac_roles, rbac_role_permissions,
rbac_user_roles, rbac_pages

sys_settings, sys_doc_numbers, sys_hcm_sync_log, sys_audit_log
```

Two changes from the addendum, now that HCM owns people:

- `rbac_user_roles.user_id` → `employee_id`, soft FK to `hcm_employees`
- `wf_stages.position_id` → soft FK to `hcm_positions`. `resolve_approvers()` reads `hcm_position_assignments`.

## Users and login

There is **no `users` table in SCM.** Identity comes from HCM.

```sql
sys_user_sessions (
    id, employee_id BIGINT, token_jti VARCHAR(64),
    issued_at, expires_at, revoked BOOLEAN, ip, user_agent
)
```

⚠️ **Confirm with the HCM team before Day 0:** does SCM authenticate against HCM's login API, or is there SSO / a shared JWT? This decides your whole auth flow. Default plan if nobody answers: SCM posts credentials to HCM's login endpoint, and on success issues its own SCM JWT carrying `employee_id`.

---

# 7. DESIGNED FOR CHANGE

You said the schema will keep changing. Four things make that cheap:

**1. `raw JSONB` on every `hcm_` table.** New HCM field needed? It's already stored. Add a column and backfill from `raw` — no re-sync.

**2. Additive migrations only.** Add nullable columns. Never rename or drop in a live system; deprecate instead. Every change goes through Alembic — nobody ever runs ALTER TABLE by hand.

**3. `extra JSONB` on transaction tables.** Space for genuinely unpredictable per-client fields.
⚠️ Only for data you *display*. The moment you need to filter, sort or report on something, promote it to a real column. JSONB filtering at scale is a trap.

**4. All HCM field names in `mappers.py` only.** HCM changes their API → you edit one file.

---

# 8. MOBILE-FRIENDLY

Not "responsive as an afterthought" — decide which screens are genuinely mobile-first.

## The three that matter on a phone

| Screen | Who | Why |
|---|---|---|
| **My Approvals inbox** | Managers, Plant Head | They approve from their phone. This is the #1 mobile screen. |
| **Stock enquiry** | Store staff | Standing in the warehouse, checking a number |
| **GRN entry** | Gate/store staff | Recording material at the gate, phone in hand |

Everything else (creating POs, admin config, reports) is a desktop job. Make it *usable* on mobile, not optimised for it.

## Rules

**Tables become cards below 768px.** Don't horizontal-scroll a table on a phone. One shared component:

```tsx
<ResponsiveList
  data={indents}
  columns={[...]}                  // desktop table
  renderCard={(i) => <IndentCard indent={i} />}   // mobile card
/>
```

Build this once in `src/shared/components/`. All nine list screens use it. This is the single highest-leverage mobile decision.

**Approval actions get large fixed bottom buttons on mobile.** Approve / Reject, full width, thumb-reachable. Not a small button in a corner.

**Bottom tab bar on mobile, sidebar on desktop.** Both driven by the same `menu[]` from `/api/auth/me`.

**Multi-column forms collapse to single column.** Inputs minimum 44px tall — anything smaller is hard to tap accurately.

**Line-item entry needs a mobile layout.** A 6-column grid of item/qty/rate/tax works on desktop and is unusable on a phone. On mobile, each line becomes a stacked card with an edit sheet.

**Test on a real phone, not just the browser's device toolbar.** Especially the GRN screen — that's someone standing at a gate in daylight.

**Skip:** offline mode, PWA install, camera/barcode scanning. All reasonable v2 features, none of them week-1 features.

---

# 9. DO THIS BEFORE DAY 0

**1. Dump one sample response from every endpoint you're mirroring.**

```bash
for e in employees offices facilities facility-masters departments sections \
         positions position-levels position-assignments organization-levels; do
  curl -s "http://<hcm-host>/api/$e/?limit=2" > "docs/hcm-samples/$e.json"
done
```

Commit these to `docs/hcm-samples/`. You cannot write `mappers.py` from endpoint names alone, and Claude Code will invent field names if you don't give it the real ones.

**2. Get answers to these five questions.** Each one changes the design:

- How does SCM authenticate a user — HCM login API, SSO, or shared JWT?
- Are `facilities` the warehouses, or is there a separate concept?
- Does `position-assignments` reliably tell you who currently holds a position, including acting/temporary?
- How does HCM paginate, and is there an `updated_since` filter? (Without it, every sync is a full pull.)
- How does SCM authenticate *to* HCM — the `api-keys` endpoint, or something else?

**3. Then design the schema.** Not before.

---

# 10. WHAT TO TELL CLAUDE CODE

Add to `CLAUDE.md`:

```markdown
## Database rules

- Table prefixes: hcm_ (mirrored, READ-ONLY), mst_, ind_, pro_, lgs_,
  stk_, rbac_, wf_, sys_. A module only creates tables with its prefix.
- NEVER write to an hcm_* table outside app/platform/hcm/sync.py.
- HCM ids are the primary keys of hcm_* tables. No mapping tables.
- Soft FKs (no DB constraint) to hcm_* tables — index them, don't
  constrain them. Hard FKs with CASCADE within a module and to mst_*.
- Snapshot display fields (name, code) onto transaction tables at
  creation time. Written once, never updated by the HCM sync.
- Every hcm_* table has raw JSONB and synced_at.
- stk_movements is append-only. Never UPDATE or DELETE a row.
- Stock changes only through move_stock().
- All HCM field mapping lives in app/platform/hcm/mappers.py and
  nowhere else.
- Never fetch or store employee bank, salary, EPFO or health data.

## Frontend rules

- Mobile-first for: My Approvals, Stock enquiry, GRN entry.
- All list screens use <ResponsiveList> — table on desktop, cards
  under 768px. Never horizontal-scroll a table on mobile.
- Tap targets minimum 44px.
```

Then run this session before the module sessions:

```
Read docs/SCM_ERP_PART3_HCM_AND_DB.md and the sample payloads in
docs/hcm-samples/.

Build app/platform/hcm/:
- client.py: async httpx client with 5s timeout, 3 retries with
  exponential backoff, and a circuit breaker
- models.py: the hcm_* tables exactly as specified in section 4
- mappers.py: map the real fields from docs/hcm-samples/ to columns.
  Every HCM field name must appear only in this file.
- sync.py: per-entity upsert in dependency order (offices ->
  facility_types -> facilities -> departments -> sections ->
  position_levels -> positions -> employees -> position_assignments).
  Each entity in its own transaction, logged to sys_hcm_sync_log.
  The upsert must use an explicit column list — it must NOT overwrite
  hcm_facilities.is_stock_location.
- service.py: read helpers (get_employee, get_position_holders,
  get_department_head)
- router.py: admin endpoints to trigger sync per entity
- tests/ with mocked HCM responses

Do not create module tables yet. Show me the sync running against
mocked data.
```

---

# 11. WHAT THIS CHANGES IN THE EARLIER DOCS

| Doc | Change |
|---|---|
| Guide Part 5 (schema) | Replaced by section 6 here |
| Guide Part 2 (ownership) | Add: you own `platform/hcm/` too |
| Guide Part 14 (Day 0) | Add: sample dumps + the 5 questions, *before* schema design |
| Addendum Part C | `users`/`positions` tables are now HCM-mirrored; RBAC stays local |
| Addendum Part D | `wf_stages.position_id` → `hcm_positions`; resolver reads `hcm_position_assignments` |
| Rules sheet | Add: never write to `hcm_*` outside sync.py; append-only `stk_movements` |
