# Logistics, consolidation and quote scoring

**Date:** 2026-08-16
**Status:** Built. Written after the code, from what was actually implemented.
**Drives:** `docs/04_SCM_BUSINESS_FLOW.md` Phase B (B7, B8) and Phase E; the roles
document's §3.2 and §3.3.

---

## Why

Three gaps in the flow document had no implementation at all:

1. **Phase E — Logistics Management.** The `modules/logistics` package owned GRN and
   issues, not transport. There was no Transport Request, no provider selection, no
   LR/docket record, no shipment tracking and no damage handling. Freight fields
   existed as loose columns on `out_dispatches` and nothing read them as a process.
2. **B7 — the consolidated buying sheet.** Forty requisitions a month were tendered
   one at a time. The CPO and SCM Head had no single document to sign.
3. **B8 — supplier evaluation.** Awarding an RFQ was a manual pick off a list sorted
   by `grand_total`. Nothing recorded *why* a vendor won.

Out of scope by explicit decision: **Accounts / payment** (not needed yet) and **all
email** (the system records that something happened; it does not send mail).

---

## The transport request

### Modes are the design

The business moves material four ways, and they are genuinely different documents:

| Mode | Carrier? | Tendered? | Must carry |
|---|---|---|---|
| `DIRECT` | no | no | who handed over, who received |
| `COURIER` | yes | no | carrier |
| `OWN_VEHICLE` | no | no | vehicle number, driver |
| `THIRD_PARTY` | yes | **yes** | carrier (chosen by award) |

Modelling these as four tables would have duplicated the same seven columns; modelling
them as four statuses would have made "approved" mean four different things. They are
one `mode` column plus a rule table (`logistics/enums.MODE_RULES`) that decides, in one
place, what each mode requires and how far through the flow it goes.

**That rule table is served to the frontend** at `GET /api/transport/modes`. The form
asks for exactly what the service will validate, so the screen cannot drift from the
rule. Nothing in the React code knows that a courier needs a carrier.

`_advance_after_approval` reads the same table: a quoted mode goes to `QUOTING`,
everything else straight to `READY`. This is what stops a hand-over sitting in a tender
queue nobody works.

### Not columns on `out_dispatches`

A dispatch is the warehouse saying "this left the building". A transport request is
logistics saying "this has to travel, and here is who is taking it". One dispatch can
be re-tendered after a carrier declines without the dispatch changing; a request can
exist before any dispatch does, because the warehouse asks for transport while it is
still packing. `dispatch_id` stays nullable for exactly that reason.

### A carrier is a vendor

`mst_vendors` with `vendor_type` in `TRANSPORT / LOGISTICS / COURIER`. This is the
single biggest simplification in the build:

- no second supplier master, no second rate history;
- **the carrier portal is the supplier portal** — same `pro_vendor_users` row, same
  `typ: "vendor"` token, same `get_current_vendor` guard, same Supplier Logins screen.
  The only new thing is three endpoints under `/api/carrier/*` that serve transport
  work instead of RFQs;
- `vendor.portal.manage` covers minting both, because it is the same act.

Vendors with **no** type set are deliberately not offered in the carrier dropdown —
otherwise every material supplier appears in the truck picker.

### Two doc types, because they are two decisions

- `TRANSPORT_REQUEST` sanctions the movement.
- `CARRIER_AWARD` sanctions the spend, and only ever runs on a tendered mode.

Same split, and the same reasoning, as `RFQ` vs `PO`: raising the request commits
nobody to money. A rejected award returns the request to `QUOTING` rather than to
rejected — the shipment still has to travel, so a different carrier is picked.

### Claims live on the shipment timeline

`lgs_shipment_events` holds progress scans *and* damage/shortage/delay. A separate
`lgs_exceptions` table would have duplicated `tr_id`, carrier, timestamp and
description to carry two extra columns, and "it arrived short" is answered by reading
the events in order. `is_exception` is a stored boolean rather than a derived one so
the Exceptions screen is an index on two columns, not a scan with an `IN` list.

A consignment cannot be closed with an open claim.

---

## The consolidated buying sheet

`pro_consolidations` + `pro_consolidation_items` + `pro_consolidation_sources`.

**Item-wise, not requisition-wise.** The same bandage asked for by nine districts is
one line with one quantity, which is what gets tendered. Aggregation key is
`(item_id, uom_code)` — two requisitions asking for the same item in different units
are separate lines, because 5 boxes and 5 pieces do not add up and silently summing
them tenders the wrong quantity.

Three quantity columns matter:

- `quantity` — what the requisitions asked for, summed. Never edited.
- `approved_qty` — what will actually be tendered. Defaults to `quantity`, and can
  only go **down**. Buying more than the approved requisitions asked for is demand
  nobody signed off, and would have to go back through the requisition ladder.
- `estimated_rate` is back-derived from amount ÷ quantity, because requisitions carry
  amounts rather than rates.

**Two source records, on purpose.** `ConsolidationItem.sources` is a human-readable
text blob ("REQ/2026-27/00012 x 40; …") read as one block and never filtered on.
`ConsolidationSource` is the queryable membership list that answers "is this
requisition already consolidated?" — which the blob deliberately cannot.

A requisition moves to `CONSOLIDATED` when the sheet is approved, so nobody can pick it
up individually and buy it twice; it returns to `APPROVED` if the sheet is rejected or
cancelled, so the demand is never stranded in a state no screen works.

Rebuilding a sheet re-aggregates from scratch rather than adding and removing
incrementally — the lines are a pure function of the membership, so recomputing is the
only way totals cannot drift from their sources.

---

## Quote scoring

`app/shared/evaluation.py`. Four methods, all normalised so **higher is always
better**: a reader of a comparison sheet never has to know which method produced it to
see who won.

| Method | Ranks on |
|---|---|
| `LOWEST_LANDED_COST` *(default)* | price + charges + tax |
| `LOWEST_PRICE` | headline figure only |
| `SHORTEST_LEAD_TIME` | days; price ignored |
| `WEIGHTED_SCORE` | landed cost 70 / lead time 30 |

**Why `shared/`, not `procurement/`:** logistics ranks carrier quotes with identical
arithmetic and sits *later* in the import chain, so it cannot be imported back
(rule 5). The alternative was two copies of a formula that decides who gets paid.
Callers flatten their own rows into `evaluation.Candidate`; the module takes no model.

**Normalised against the best quote received**, not an absolute — a 40 km run and a
900 km run are not comparable, and only the quotes in hand define what good looks like
for this job. The best quote always scores exactly 1.

Three rules worth stating because a test pins each:

- A quote that states **no** lead time is scored as `max(stated) + 1` — *strictly*
  worse than the slowest one that did. Using `max(stated)` made it tie, and a tie is
  broken by submission order, so a silent quote could still win "fastest". (This was a
  real bug, caught by `test_a_quote_with_no_lead_time_is_treated_as_the_worst`.)
- A zero-priced quote is dropped from scoring. Zero is a data-entry error, not a
  bargain, and it must not divide by zero either.
- Ties keep submission order: first to quote wins a dead heat. Defensible and stable.

The rank and score are **snapshotted onto the winning quote at award**, not recomputed
on read. The ranking that justified the award has to keep saying what it said after the
method changes or a vendor revises.

Previewing a different method on screen is a query parameter and is never written back.
Looking at the quotes another way is not choosing one.

The three-quote norm (doc B8) is **reported, not enforced** — a single-carrier lane and
a single-source item are both real, and blocking the award would stop the purchase.

---

## RBAC, approval config and doc types

Everything new is reachable through the existing configuration surfaces with no seed
run and no hand-written SQL:

- **Permissions** (`platform/rbac/permissions.py`): seven `transport.*` codes and three
  `consolidation.*` codes. `sync_permission_labels` inserts them on startup, granted to
  Admin and nobody else (fail-closed), and they appear on Job Profiles for an admin to
  tick on.
- **Pages** (`platform/rbac/page_registry.py`): a `grp_logistics` module row with
  Transport Requests, Provider Selection, Shipment Tracking, Exceptions, Consignments
  and Dispatch under it, plus Consolidation under Procurement. `sync_pages` inserts on
  startup and never deletes.
- **Approval config**: `TRANSPORT_REQUEST`, `CARRIER_AWARD` and `CONSOLIDATION` are in
  `DOC_TYPE_LABEL` and `MODULE_BY_DOC_TYPE`, and `Logistics` was added to
  `MODULE_ORDER`, so all three appear on Settings > Approvals Config as configurable
  ladders like every other document.
- **Numbering**: `TR` and `CONS` prefixes in `shared/numbering`. A missing
  `sys_doc_series` row still falls back and logs, as before.

**`PURCHASE_RETURN` moved from Warehouse to Returns** on the config screen. The table
is `pro_returns` and the service is the warehouse's, but an admin configuring "who
signs a return" looks under Returns, found only the two stock-return rows there, and a
purchase return silently kept whatever the reporting line gave it.

**Consignments and Dispatch now appear under Logistics as well as Warehouse.** The
warehouse routes, page rows and permissions are untouched, and the React components are
re-exported rather than moved. Retiring the warehouse copies later is then switching
two page rows off — no component moves and no import changes.

---

## What was NOT built, and why

- **Accounts / payment** — explicitly deferred. There is no payment table, no payment
  status and no acknowledgement back to the PO team. Doc B14 and §3.3 steps 7–8 remain
  unimplemented.
- **Email** — explicitly deferred. `share_tracking` *stamps* that the field was told
  (which is what the indent team's chase list needs) rather than sending anything.
  Supplier onboarding mail (B9) and the C4 discrepancy mail are not built.
- **Returns** needed less than expected: it was already on the approval engine with its
  own ladders. What it lacked was a report ledger and the doc-type filing above, both
  now done. A `Returns` ledger (field + purchase returns on one view) and a `Transport`
  ledger were added to `modules/reports`.

---

## Verification

- `app/modules/logistics/tests/test_evaluation.py` — 15 tests, pure functions, no DB.
- `app/modules/logistics/tests/test_transport_modes.py` — 14 tests on the mode rule
  table and the status machine, no DB.
- Migration `d7e8f9a0b1c2` verified column-for-column against the ORM models
  (7 tables, 150 columns, exact match). Every step is guarded on what already exists,
  so it is safe to re-run and safe on a bootstrap-built database.
- `npm run build` and `tsc --noEmit` clean.
- Frontend vitest: procurement, logistics and warehouse suites all pass (25 tests).
  The 42 failures elsewhere are in alerts, indents and inventory — modules this work
  did not touch, and none of those tests import anything that changed.

### Deploying

```
.venv/Scripts/python -m alembic upgrade head
```

Nothing else. Permissions and pages sync themselves on the next start; the ladders for
the three new document types are configured by an admin on Approvals Config.

---

## Known pre-existing issues found along the way (not fixed here)

- `return.view`, `return.create` and `return.approve` are each declared **twice** in
  `ALL_PERMISSIONS` — once under `warehouse`, once under `returns`. The dict build
  means the `returns` labels win; the warehouse copies are dead entries. Harmless, but
  relabelling live rows is not something to do as a side effect of this work.
- `DocType.ISSUE` has no entry in `DOC_TYPE_LABEL`, so it cannot be configured on the
  approvals screen. It belongs to the old `lgs_issues` surface.
