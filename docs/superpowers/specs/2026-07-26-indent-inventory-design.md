# Indent + Inventory — Design

**Date:** 2026-07-26
**Status:** approved (design), pending implementation plan
**Scope:** the Indent and Inventory halves of `docs/04_SCM_BUSINESS_FLOW.md`.
Warehouse is deliberately last and is not covered here.

---

## 1. Problem

`docs/04_SCM_BUSINESS_FLOW.md` §3 steps 3–5 describe the pivot of the whole system:
an approved indent is checked against stock, and either issues from the warehouse or
turns into a procurement request. That fork does not exist in the codebase.

Supporting gaps found during the survey on 2026-07-26:

- `modules/inventory` is a 40-line stub returning `{"status": "ready_for_development"}`.
  It has no models and no tables.
- `frontend/src/modules/inventory/api.ts` runs entirely on in-memory mock arrays. The
  Stock Balance, Ledger, Replenishment and Transfer screens show data that does not
  survive a page refresh.
- `platform/rules` is complete — evaluator, conditions, conflict detection, audit
  table, admin GUI — and has **zero callers**. `rules.fire()` has never been invoked
  by any module. Two `INDENT_APPROVED` rules seeded by `scripts/setup_indent_flow.py`
  never execute.
- Both engines are configuration-driven, so a missing or misconfigured row strands a
  document with no recovery path.

## 2. Goals

1. An approved indent is automatically checked against stock, line by line, and routed.
2. Stock that is promised to one indent cannot be promised to another.
3. Items with a batch or expiry date are picked nearest-expiry-first.
4. Short lines become a Material Request that reaches procurement.
5. No document can be stranded by missing or broken engine configuration.
6. The inventory screens run on real data.

### Non-goals

RFQ and quotations; gate pass, packing, consignment, dispatch; the returns flow; the
F&A handoff; costing and valuation; a reservation-expiry sweeper. Each is deferred to
a later delivery and named in §9.

## 3. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | `stk_balance`, `stk_ledger` and `move_stock()` move from `logistics` to `inventory` | Stock belongs to the module named after it; Inventory is its own department in §2 of the flow doc |
| D2 | **Inventory becomes the base module**, importing nothing | Lets `indents` call `inventory.allocate_for_indent()` directly without violating the import rule |
| D3 | LIP and MDP are `whs_warehouses` rows with `warehouse_type` of `LIP`/`MDP` | Both hold stock and can be a fulfilment source; needs no new table |
| D4 | Fallback fires on **both** no-workflow and empty-stage | An empty stage is the common failure (vacant position, inactive employee) and today it strands documents silently |
| D5 | Per-line split fulfilment **with** reservation | Real indents mix in-stock and short lines; without reservation two indents can be promised the same unit |
| D6 | MR lives in `inventory` as `inv_material_requests` | The flow doc says MR is raised at inventory/warehouse level, and it keeps the import chain one-directional |
| D7 | No event bus, job queue or action dispatcher | A direct call expresses a dependency that is real; indirection would hide it |

D2 was chosen over a `platform/` action-dispatcher (~25 lines) that would have let
`indents` trigger fulfilment without naming `inventory`. Rejected: the dependency is
genuine, and the dispatcher would make the next step unreadable from the indent code.

## 4. Architecture

### 4.1 Import chain

```
inventory → indents → procurement → logistics → warehouse
(base)                                          (last, to be rewritten)
```

Later modules import earlier ones, never the reverse (CLAUDE.md rule 5).

| Module | Owns | Imports |
|---|---|---|
| `inventory` | `stk_balance`, `stk_ledger`, `move_stock()`, availability, allocation, `inv_reservations`, `inv_material_requests`, transfers, replenishment | nothing |
| `indents` | `ind_*`, fires `INDENT_APPROVED`, calls inventory to allocate | inventory |
| `procurement` | `pro_*`, reads approved MRs to build POs | inventory, indents |
| `logistics` | `lgs_grn`, `lgs_issues` | inventory, indents, procurement |
| `warehouse` | later: `whs_*` structure, gate pass, packing, consignment, dispatch | all of the above |

`allocate_for_indent()` takes plain data — `indent_id`, `indent_no`, and a list of
`(item_id, quantity, project_id)` — not the `Indent` ORM object. Inventory must not
learn the shape of an indent.

### 4.2 New files

| File | Purpose |
|---|---|
| `platform/workflow/fallback.py` | the reporting-manager ladder |
| `modules/inventory/models.py` | `Stock`, `StockMovement` (moved), `Reservation`, `MaterialRequest`, `MaterialRequestItem` |
| `modules/inventory/availability.py` | per-line stock lookup across warehouses |
| `modules/inventory/allocation.py` | reserve / release / consume, FEFO and FIFO |
| `modules/inventory/service.py` | `move_stock`, `transfer_stock`, `allocate_for_indent`, MR lifecycle, replenishment |
| `modules/inventory/schemas.py`, `router.py`, `tests/` | the standard module five |

### 4.3 New tables

**`inv_reservations`** — one row per promised quantity.

| Column | Notes |
|---|---|
| `id` | pk |
| `stock_id` | FK `stk_balance.id` |
| `item_id`, `warehouse_id`, `bin_id`, `batch_id`, `project_id` | denormalised for querying |
| `quantity` | reserved amount |
| `ref_type`, `ref_id`, `ref_no` | what holds it — `INDENT` today |
| `status` | `ReservationStatus`: ACTIVE / RELEASED / CONSUMED |
| `created_by_id`, `created_at`, `released_at` | |

The row exists so `stk_balance.reserved_qty` is explainable. A reserved quantity with
no matching reservation row is a bug the system can detect.

**`inv_material_requests`** — header: `mr_no` (via `sys_doc_series`), `indent_id`,
`indent_no`, `requester_id`/`_name`, `department_id`, `facility_id`, `status`
(`MRStatus`), `required_by`, `remarks`, audit columns.

**`inv_material_request_items`** — `mr_id`, `item_id` + snapshot code/name/uom,
`quantity`, `project_id`, `indent_item_id`.

No new tables for the warehouse hierarchy. `whs_bins` already nests through
`parent_id`, `path` and `level`, so Floor → Line → Rack → Bin → Lot are rows at
different levels; Cold Room is a `bin_type`.

### 4.4 New enum values

`app/shared/enums.py` gains: `WarehouseType` (MAIN/LIP/MDP), `BinType`
(FLOOR/LINE/RACK/BIN/LOT/COLD_ROOM), `MRStatus`, `ReservationStatus`, `PickStrategy`
(FEFO/FIFO), `DocType.MR`, `RefType.RESERVATION`, the indent-line status `ALLOCATED`,
and the indent statuses `FULFILLED`, `PARTIALLY_FULFILLED`, `PENDING_PROCUREMENT`.

Per CLAUDE.md rule 3, no status string is ever written literally.

## 5. The fork

```
indent approved
  │
  ├─ rules.fire("INDENT_APPROVED", ctx)        # returns actions, executes nothing
  │     no match → default ROUTE_FULFILLMENT to INVENTORY, logged
  │
  └─ inventory.allocate_for_indent(indent_id, indent_no, lines, user)
        for each line:
          candidate warehouses = active, type in (rule params or MAIN/LIP/MDP)
          strategy = FEFO if item is batch-tracked or has expiry, else FIFO
          walk candidate stock rows, reserving until the line is met or stock runs out
            reserved → inv_reservations row; available_qty -= q; reserved_qty += q
            short    → collect the shortfall
        reserved lines → indent line status ALLOCATED
        short lines    → one MR, all shortfalls, workflow-approved, procurement queue
        indent status  → FULFILLED | PARTIALLY_FULFILLED | PENDING_PROCUREMENT
```

Reservations are released on indent reject, indent cancel, or MR cancel, and consumed
at issue time. Release and consume are service calls that adjust `stk_balance` and the
reservation row in the same transaction, so `available_qty` cannot drift.

Reserving is **not** a stock movement. It shifts quantity between `available_qty` and
`reserved_qty`, leaves `total_qty` untouched, and writes no `stk_ledger` row, because
nothing has physically moved. It therefore does not go through `move_stock()`.

To keep CLAUDE.md rule 7 meaningful, the rule is restated for this module: physical
quantity changes go only through `inventory.move_stock()`, and reservation-column
changes go only through `inventory.allocation.py`. No other code assigns to
`stk_balance` columns. The ledger row for a reserved quantity is written when the issue
posts and the goods actually leave.

## 6. Fallback

```
engine.start(doc_type, doc_id, ctx, user)
  ├─ no active workflow for doc_type ──────────> ladder for the whole chain
  └─ workflow found
       └─ per stage: resolve_approvers() == [] ─> ladder for that stage only,
                                                  the rest of the chain continues
```

The ladder walks `hcm_positions.parent_position_id` up from the requester's position,
**three levels maximum**, stopping early at the top of the tree. `resolver.py` already
does one level in `_reporting_manager()`; the ladder is that logic in a loop.

Rules:

- Every activation writes a `wf_actions` row flagged `FALLBACK` **and** a
  warning-level `sys_audit_log` entry.
- If the ladder finds nobody — the requester has no position, or is at the top — the
  document routes to holders of the ADMIN role. Terminal safety net; a document is
  never left with zero approvers.
- An admin screen lists recent fallback activations so misconfiguration is visible in
  one place rather than discovered by its consequences.

On the rules side, a routing event that matches no rule falls back to a hardcoded
default path and logs it. `rule_executions` already records no-match rows.

The fallback chain is defined in code, not in the database. A database-driven fallback
would share the failure mode it exists to protect against.

## 7. Frontend

`frontend/src/modules/inventory/api.ts` loses its mock arrays and calls real endpoints
through `@/shared/api/client`. The existing views — Stock Balance, Ledger,
Replenishment, Transfers — keep their shape; only the data source changes.

New screens: a **fulfilment queue** (approved indents awaiting allocation, with per-line
availability), an **MR list and detail**, and the **fallback activation log** under
Settings. All use `<ResponsiveList>`, `<StatusPill>`, `<Can>` and the shared kit; no
module restyles a primitive.

Menu entries are added to `PAGE_TREE` in `scripts/seed.py` only — it is the single
source of truth after the 2026-07-26 fix that removed the duplicate tree from
`seed_foundation.py`.

## 8. Testing

Reservation and picking are money paths and get real tests:

1. Two indents cannot reserve the same unit — the second sees the reduced availability.
2. FEFO picks the nearest expiry across batches; FIFO applies when no expiry exists.
3. A rejected indent returns `available_qty` to exactly its pre-allocation value.
4. A partially-available indent reserves what it can and raises an MR for the rest.
5. Fallback fires when no workflow exists; fires for a single empty stage while the
   rest of the chain survives; routes to ADMIN when the requester has no position.
6. Every fallback activation writes both the `wf_actions` row and the audit entry.

The 80 existing tests must stay green through the stock move. That migration is
mechanical, and the existing suite is the evidence it was done correctly.

## 9. Deferred

| Deferred | Comes with |
|---|---|
| RFQ, vendor quotations, comparison, selection | procurement, next delivery |
| Gate pass IN/OUT, packing, consignment, dispatch plan, delivery | warehouse, last |
| Returns flow (damaged, expired, indent returns, scrap) | warehouse — needs receiving |
| STO / SMO | warehouse |
| F&A handoff | after warehouse |
| Costing and valuation | not this build; `valuation_rate` stays unmapped |
| Reservation-expiry sweeper | only if a leak is measured |
| Warehouse frontend rewrite | warehouse, last |

## 10. Risks

**The stock move blocks everything.** Nothing else starts until `stk_*` is under
`inventory` and the suite is green. Mitigated by doing it as its own first phase with
no behaviour change — a pure move, verified by the existing tests.

**The live schema is the DB team's.** `stk_balance` and `stk_ledger` already exist with
more columns than the ORM maps. New tables (`inv_reservations`,
`inv_material_requests`) must be agreed with them before the migration is written, or
they will collide with whatever the DB team plans for the same concepts.

**Reserved quantity can drift** if any code path adjusts `stk_balance` without a
matching reservation row. Mitigated by routing every change through `move_stock()` and
`allocation.py`, and by a consistency check that sums reservations per stock row.
