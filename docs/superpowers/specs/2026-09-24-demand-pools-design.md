# Change: two demand pools — one desk's buying trail, one warehouse's outward trail

**Date:** 2026-09-24
**Status:** PROPOSED
**Owner:** procurement + warehouse modules (read-only feature — no new tables, no new writes)

---

## 1. What is being asked

The reference application has a **Demand Pool**: every outstanding indent quantity,
grouped item-wise, with each contributing indent line carrying the stage its quantity
is sitting at. The screen is a triage desk — expand a group, see the indent lines,
see where each one is stuck, act on it.

We need that twice, over the two halves of our flow:

**Procurement Demand Pool** — item-wise indent demand and where each quantity sits in
the BUYING chain:

```
to source → MR → requisition → consolidation → RFQ → PO → (goods received: leaves the pool)
```

When procurement buys against the indent and the goods reach stock, the quantity
leaves this pool — it is now the warehouse's.

**Warehouse Demand Pool** — item-wise indent demand being served FROM STOCK and where
each quantity sits in the OUTWARD chain:

```
to issue (allocated) → material issue → outward QC → consignment → in transit → delivered
→ (requester acknowledges the indent: leaves the pool)
```

A quantity exits the warehouse pool only when the indent's own acknowledgement covers
it (`ind_indent_items.received_quantity`), because that is the only fact that closes
an indent (`indents.acknowledge_receipt`).

Both pools group by item with the contributing indent lines expanded underneath —
the same shape as the reference screen's groups + `sources[]`.

---

## 2. The one invariant that makes this safe

> **Every outstanding quantity of every open indent line appears in EXACTLY ONE stage
> of EXACTLY ONE pool. The two pools together partition the demand. Nothing is
> stored; everything is READ.**

```
owed(line)  =  Σ warehouse stages  +  Σ procurement stages  +  received_quantity
```

This is the same discipline the system already runs on: "what an indent is still owed
is READ, never stored" (`inventory/allocations.py` module docstring). A demand pool
that WROTE its stage anywhere would be a sixth copy of a number that already lives in
six documents — and would drift from all of them. There is deliberately **no new
table, no new column, no status write, and no "wake the document" path**. Arriving
stock, a cancelled PO or an acknowledgement changes what the pools say by existing.

Conservation is test-enforced (§9). It is the load-bearing check: a quantity that
appears in two stages double-counts demand and somebody buys twice; a quantity that
appears in none silently vanishes.

---

## 3. Status tuples: IMPORT them, never re-declare them

Two answers that could disagree is how the PO double-receipt happened. Every stage
filter reads the SAME constants the owning screens read:

| Constant | File | Used for |
|---|---|---|
| `owed_quantity()` | `indents/service.py` | what the line is entitled to (approved, falling back to requested — 69 live lines carry 0) |
| `_SETTLED_MR_STATUSES` | `indents/service.py` | which material requests are still "on order" |
| `UNAPPROVED_ALLOCATION_STATUSES`, `SETTLED_ALLOCATION_STATUSES` | `inventory/allocations.py` | unsigned vs signed allocations |
| `REQ_SANCTIONED`, `PO_OPEN`, `PO_AT_VENDOR` | `procurement/stats.py` | live requisitions and open orders |
| `DEAD_ISSUE_STATUSES` | `warehouse/enums.py` | issues that hold nothing |
| `_GONE_OUT_STATUSES` | `warehouse/service.py` | promote to `warehouse/enums.py` as `GONE_OUT_ISSUE_STATUSES` so the pool file does not import a private name from the 23k-line service |
| `DispatchStatus`, `TransportStatus`, `IssueStatus`, `QcStatus` | `warehouse/enums.py`, `logistics/enums.py` | the outward leg's own statuses |

A status added to any of these changes a pool and its register in the same commit.

---

## 4. Where the code lives (import legality, rule 5)

Chain: `inventory → indents → procurement → logistics → warehouse`.

**Procurement pool — `modules/procurement/demand_pool.py`** (new file, beside
`stats.py` / `ledger.py`, same read-only character). It may import `indents` and
`inventory` (both earlier) and its own models. It needs nothing from later modules:
the "goods received" exit reads `MRStatus.RECEIVED` (inventory, earlier) and
`pro_po_items.received_quantity` — the cache `_sync_po_receipt_status` already
maintains as a materialised copy of the receipts sum.

**Warehouse pool — `modules/warehouse/demand_pool.py`** (new file). Warehouse sits
last, so it may read everything: indent lines, allocations, MRs, requisitions,
issues, `whs_inspections`, `out_dispatches` and `lgs_transport_requests`.

Neither pool imports `reports`; nothing imports the pools back. Each module keeps its
own 5-file shape — the pool is a second service file + router endpoints + schemas +
tests, no new module.

---

## 5. Stage attribution — procurement pool

Per indent line `L` (skip `is_excluded` lines and `owed ≤ 0`; skip lines where
`received_quantity ≥ owed` — acknowledged demand is out of every pool):

Net later stages FIRST, then subtract downward. Every remainder is the document's own
written remainder, so rounds of buying shrink a stage by themselves.

1. **PO** — `Σ (po_item.quantity − po_item.received_quantity)` over lines carrying
   `indent_item_id = L.id` on POs in `PO_OPEN`. A part-received order contributes only
   its remainder; a received order contributes nothing.
2. **RFQ / CONSOLIDATION / REQUISITION** — `Σ (req_item.quantity − req_item.ordered_qty)`
   over sanctioned requisition lines carrying `L.id`, bucketed by the requisition's
   status: `RFQ_RAISED` → RFQ, `CONSOLIDATED` → CONSOLIDATION, `APPROVED` →
   REQUISITION. (`ordered_qty` is bumped at PO creation on both the indent and
   quotation paths, so this remainder is already net of what the PO took.)
3. **MR** — `Σ (mr_item.quantity − mr_item.ordered_quantity)` over live MR lines
   carrying `L.id` (status not in `_SETTLED_MR_STATUSES`).
   **Netting hazard, audit before coding:** `create_requisition_from_mrs` does not
   appear to bump `mr_item.ordered_quantity` when it carves the MR into a requisition —
   if so, the MR remainder and the requisition quantity are the same demand twice.
   The pool nets it regardless: `mr_net = max(0, mr_rem − requisition_qty_for_L)`,
   and the conservation test (§9) will fail loudly if the write-side is ever wrong.
4. **TO_SOURCE** — whatever is left of `owed`. No live claim anywhere: the quantity is
   waiting for the fulfilment desk to allocate or the desk to raise/buy.

The line's **current stage** (the chip the screen shows) is its largest bucket; the
per-stage breakdown is served alongside so a split line renders honestly.

`estimated_value` is deliberately **not** in v1 — the pool spans five document types
and no single scope owns a price for all of them. Adding money later is additive.

## 6. Stage attribution — warehouse pool

Per indent line, same owed/received gate. Quantities with any procurement-side claim
(§5 buckets) belong to the procurement pool and are excluded here — that is the
"moves out of procurement, moves to warehouse" handoff: when the MR goes RECEIVED or
the PO fills, the quantity drops out of §5 and surfaces here.

1. **Issued / in-issue** — `Σ` over live issue lines carrying `L.id`
   (`out_issue_items.indent_item_id`, direction OUT, status not in
   `DEAD_ISSUE_STATUSES`), bucketed by how far the covering documents got
   (furthest-stage netting, one unit appears once):
   - `DRAFT / PENDING_APPROVAL / APPROVED` (stock not posted) → **IN_ISSUE**
   - posted (`is_stock_posted`), no consignment → **ISSUED**
   - open outbound inspection (`whs_inspections` by `issue_id`, not finished) →
     **OUTWARD_QC**
   - consignment `PACKED` (`out_dispatches.ref_type = WH_ISSUE, ref_id = issue`) →
     **CONSIGNMENT**
   - transport leg `READY → IN_TRANSIT` (via `lgs_transport_requests.dispatch_id`) or
     dispatch `DISPATCHED / IN_TRANSIT` → **IN_TRANSIT**
   - transport/dispatch `DELIVERED` → **DELIVERED** (site signature pending)
   - issue `ACKNOWLEDGED` / dispatch `ACKNOWLEDGED` → that quantity is (or is being)
     acknowledged; it is counted only through `received_quantity`, never as a stage.
   Attribute at ISSUE-LINE level (the column that names the indent line), never the
   dispatch header — a consolidated issue serves many indents, and `post_issue` and
   `_already_issued` already read it per line for exactly that reason. Relay legs
   (`WH → MDP → LIP`) are excluded the way `_receiver_confirmed` excludes them
   (`~_relayed_onward()`): the same units travelling down the chain are ONE serving.
2. **TO_ISSUE (allocated)** — `max(0, L.allocated_quantity − Σ live issue qty)`.
   Signed allocations that nothing has drafted against yet. An unsigned allocation
   (DRAFT / PENDING_APPROVAL) is the Fulfilment Desk's "To approve" tab, not a pool
   stage — its quantity stays in TO_SOURCE of the procurement pool until signed, which
   is exactly how the desk's own arithmetic treats it.
3. **Stock cap on TO_ISSUE** — the pool must not promise the same shelf twice. Per
   (item, uom) bucket, cap total TO_ISSUE at what the points can serve and distribute
   it across the competing lines with `indents.service.split_demand` (urgent first,
   pro-rata, whole unit steps) — the SAME helper the allocation screen proposes with,
   so the pool and the desk can never propose different numbers for the same shelf.
   Overflow above the shelf stays TO_SOURCE in the procurement pool.

Exits: full acknowledgement (`received ≥ owed`). Partial receipts keep the row with
the remainder — an indent served in rounds is the common case.

---

## 7. API

New endpoints, each pool owned by its module, both gated and scoped:

```
GET /api/procurement/demand-pool            # require_permission("requisition.view")
GET /api/procurement/demand-pool/stages     # same gate — served stage metadata
GET /api/warehouse/demand-pool              # require_permission("issue.view")
GET /api/warehouse/demand-pool/stages       # same gate
```

- `stages` returns the ordered list `{stage, label, tone, hint}` — the same
  served-meta pattern as `enums.ACTIVITY_META` / `TRACKING_META`. **No stage map is
  hardcoded in any screen**; the reference app's hardcoded `IDENT_STATUS_CONFIG` is
  the thing our rules exist to prevent.
- Query params both pools share: `?page=&size=&search=&item_id=&warehouse_id=`
  (procurement also `?project_id=`), plus `?stage=` to narrow to one bucket — the
  KPI tiles set it, so a tile's count and its filtered list agree by construction
  (the `stats.py` filters pattern).
- Scope: indents through `_indent_visibility`; procurement documents through
  `scope_condition` exactly as `stats.demand_pool` scopes today. A tile counting rows
  the list would not show is a leak.

Payload (identical shape for both pools, so the screens are twins):

```jsonc
{
  "groups": [{
    "item_id": 12, "item_code": "…", "item_name": "…", "uom_code": "NOS",
    "total_qty": 40.0, "indent_count": 3,
    "stage_summary": {"TO_SOURCE": 10.0, "PO": 30.0},   // served, per group
    "earliest_required": "2026-10-02",
    "sources": [{
      "indent_id": 99, "indent_no": "IND/2026-27/00661", "indent_item_id": 301,
      "requested_qty": 10, "owed_qty": 10,
      "stage": "TO_SOURCE",                               // largest bucket
      "stages": {"TO_SOURCE": 10.0},                      // per-line breakdown
      "required_date": "…", "priority": "URGENT",
      "requested_by_name": "…", "department_name": "…", "project_name": "…",
      "docs": [{"kind": "PO", "id": 7, "no": "BHS/…/PO0013", "status": "SENT_TO_VENDOR", "qty": 30}]
    }]
  }],
  "group_count": 41, "indent_count": 87,
  "stage_totals": {"TO_SOURCE": 120.0, "PO": 340.0},      // served, for the KPI strip
  "page": 1, "size": 50, "total": 41
}
```

`docs[]` is served so a row deep-links straight to the paper holding its quantity —
the screen never runs a second call per row.

**Deep links** (the pool is a triage desk; every stage leads to the screen that owns
the work): TO_SOURCE → `/inventory/fulfilment`; MR → `/inventory/material-requests`;
REQUISITION / CONSOLIDATION / RFQ / PO → their registers by id; TO_ISSUE /
IN_ISSUE → `/inventory/fulfilment` + `/warehouse/material-issues`; OUTWARD_QC →
`/warehouse/qc-outward`; CONSIGNMENT / IN_TRANSIT / DELIVERED →
`/logistics/activity?dispatch_id=`; DELIVERED also points the requester at
`/indents/acknowledgements/:id`.

**Pagination AFTER grouping** (BUG-PRO-075 precedent — pre-group paging loses buckets
that straddle the boundary), with a stable key order. Every grouped query is one
GROUP BY over the document family per line-id set — the `_committed_by_lines` /
`_on_order_by_lines` shape — never a query loop. Grouped output sorts on `item_id`
(an indexed column), never `created_at`, per the filesort rule.

---

## 8. Migration (indexes the pool will lean on)

One Alembic revision on head `f7a1c3e5d9b2` (verify `alembic heads` first — the
outage rule). The link columns the pool filters on:

- `out_issue_items.indent_item_id` — **currently unindexed** (plain `BigInteger`).
  Every warehouse-pool query and several existing guards (`_already_issued`,
  `_receiver_confirmed`) scan on it.
- `out_dispatch_items.indent_id` — same.
- optional composite `out_dispatches (ref_type, ref_id)` — the issue→consignment join
  the pool and four existing guards all run.

A missing index raises nothing until the list gets big; adding it now is one revision
instead of a slow-screen mystery later. New databases get it through bootstrap's
`create_all`; existing ones through `alembic upgrade head`.

---

## 9. Test plan (the failing-silently list)

`procurement/tests/test_demand_pool.py`, `warehouse/tests/test_demand_pool.py`:

1. **Conservation (the load-bearing one).** Walk one indent line through the whole
   journey — approved → allocation signed → issue drafted → posted → consignment →
   transport → delivered → acknowledged — asserting at every step that
   `Σ pool buckets + received = owed`, and that the quantity appears in exactly one
   stage of exactly one pool.
2. **Stage progression.** The same walk asserts the stage moves: ALLOCATION-signed →
   TO_ISSUE; issue approved → IN_ISSUE; posted → ISSUED; consignment packed →
   CONSIGNMENT; gate out → IN_TRANSIT; delivered → DELIVERED; acknowledged → gone.
3. **Procurement stages.** MR → requisition → consolidation → RFQ → PO, one step per
   document, asserting the bucket follows and the previous stage empties — including
   the MR/requisition netting (a requisition carved from an MR must not double-count).
4. **Rounds.** A part-delivered order leaves the PO remainder; a part-acknowledged
   indent keeps its remainder in the pool.
5. **Dead documents free demand.** Cancelled PO, rejected MR, dead issue: the
   quantity falls back to TO_SOURCE / TO_ISSUE in the same read.
6. **Scope.** A scoped-out indent contributes to no group and no stage total — the
   count itself is the disclosure.
7. **Stock cap.** Two competing lines against one shelf: `split_demand` caps the
   TO_ISSUE total at availability; overflow lands in TO_SOURCE.
8. **Excluded / zero-owed lines never appear.**

Pure netting functions are tested without a database first (the `_fefo_swap_allowed`
pattern), then the DB-backed suite proves the queries agree with them.

---

## 10. Frontend

One page per module, twins by construction:

- `modules/procurement/pages/ProcurementDemandPoolPage.tsx`
- `modules/warehouse/pages/WarehouseDemandPoolPage.tsx`
- each: `api.ts` + `types.ts` additions + `tests/` — the module mirror rule (rule 12)

Both use `PageHeader`, `StatCard` (one per served stage + groups/indents totals),
`ResponsiveList` (table desktop, cards <768px), `<Can>` for the deep-link actions,
`StatusPill` toned from the served stage metadata. Group rows expand to the
`sources[]` lines with per-stage quantity chips — the reference screen's
`SourcesPanel`, on our component kit. 44px tap targets.

Routes in `App.tsx` (lazy), menu rows in `scripts/seed.py` `PAGE_TREE`:

```
("pro_demand_pool", "/procurement/demand-pool", "Demand Pool", "layers",
 P.page_view_code("pro_demand_pool"), 33, "grp_purchasing")   # gated requisition.view
("wh_demand_pool", "/warehouse/demand-pool", "Demand Pool", "layers",
 P.page_view_code("wh_demand_pool"), 52, "grp_warehouse")     # gated issue.view
```

`sync_permission_labels` runs before `sync_pages` (existing order in `main.py`), so
the PAGE_VIEW_CODES entries mint the page codes with the right gates and existing
grants are untouched. No shared files change.

---

## 11. Relationship to what already exists

- **`GET /api/requisitions/demand-pool`** (the requisition-first pool on the
  Procurement Overview): the new procurement pool supersedes it as a SCREEN. The old
  endpoint stays until the Overview tile moves over, then is retired — one demand
  pool per desk, not two answers that can drift.
- **Fulfilment Desk** (`/inventory/fulfilment`): unchanged and untouched. The pools
  are READ-ONLY triage over the same rows; TO_SOURCE deep-links to the desk, which
  remains the only place an allocation decision is made. Nothing in the pools writes,
  reserves, approves or wakes anything.
- **Activity Ledger**: the warehouse pool's IN_TRANSIT/DELIVERED figures come from the
  same transport statuses the ledger unions; the pool adds the indent-line view the
  ledger deliberately does not keep.

---

## 12. Build order

1. Stage enums + served metadata (shared/enums.py + the two `stages` endpoints).
2. `procurement/demand_pool.py`: pure netting function + grouped queries + endpoint +
   schemas; the MR/requisition netting audit on `create_requisition_from_mrs`.
3. `warehouse/demand_pool.py`: same shape, reading indents/inventory/procurement/
   logistics/own tables.
4. Migration: the three indexes.
5. Both test files; conservation first.
6. Frontend twins + PAGE_TREE + Overview tile cutover.
7. `pytest` (must pass) and `npm run build` (must compile); a short section in
   `CLAUDE.md` naming the two pools and the invariant, with the failing-silently
   list carried in each pool file's module docstring.

Estimated: ~2–3 days of focused work, Phases 2–3 parallelisable across two
developers because the modules do not touch.
