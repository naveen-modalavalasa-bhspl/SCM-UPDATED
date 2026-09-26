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
# In a CONTAINER it is gunicorn, not uvicorn: one uvicorn process is one CPU core for
# the whole deployment (backend/gunicorn.conf.py). Locally the single process is fine
# and RUN_SCHEDULERS defaults true, so the HCM sync still runs.
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

### An order is received ONCE, and what it still owes is READ (2026-09-08)

BHS/104/2026-27/PO0013 was received in full by REC0031 and then, the next day, in full
again by REC0033 — nineteen lines, every one at the whole ordered quantity, for goods
that were ordered once. Two independent causes, one per door, and neither was a
business rule that had been decided wrongly: there was no rule at all.

**`po_lines` was defined TWICE in `service.py`.** The second definition is the one
Python keeps, and it read `pro_po_items.received_quantity` — a column written by
exactly one path (`logistics.receive_grn`, the original build's rival GRN table) and by
nothing in this module, so it still reads `0.000` on every order received through
Material Inward. The first definition, which summed the receipts and dropped settled
lines, had been unreachable since the day the second was added. Two `async def` of one
name is an error nothing reports: the shadowed one simply stops running, and the only
symptom is a screen answering from the wrong code.
`test_only_one_po_lines_survives_the_module` now walks the module's AST for repeated
top-level names, because the class of bug is worth catching, not just the instance.

**And nothing at the save asked the order whether it still owed any of it.**
`_apply_receipt_lines` wrote `ordered_qty` straight through from the client.
`_assert_po_fulfilment` now refuses a receipt that takes more off a line than the order
still owes — per LINE, because a part delivery is normal and a settled line must not
stop the rest of the order arriving, and accumulated across the lines of THIS receipt
too, since the same PO line entered twice on one GRN is the same over-receipt in one
document. The message names what is left and which receipts took the rest; "already
received" on its own sends a storekeeper hunting through a list of GRNs.

`po_received_by_line` is the one definition of "what has this order already had", read
by the guard, by the PO prefill and by the despatch-note prefill. **Two answers that
could disagree is how the first one came to be wrong.**

- **Drafts count.** A receipt being written is a claim on the order — two storekeepers
  working one delivery must not each be offered the whole of it — and the way to
  release that claim is to CANCEL the receipt, which is the one status left out.
- **A document is capped by what was claimed BEFORE it existed** (`only_before`).
  Without that, the duplicate draft written today blocks an edit to the submitted
  receipt that legitimately took the goods last week, and the wrong one of the two is
  the one that cannot be saved.
- **A receipt is never counted against itself** (`exclude_receipt_id`, threaded through
  `?receipt_id=` on both prefill routes), or a saved receipt re-filling from its own
  order would be told the order owes nothing, by itself.
- **A line the order does not name is not capped by anything.** A delivery can carry a
  replacement or a sample, and refusing it would stop real goods at the gate over a
  paperwork mismatch.

**The despatch note is the second door and needed the same cap.** That prefill REPLACES
the form's lines with a complete statement of one delivery, so re-opening the same note
against a received order filled a whole second receipt with it. `_despatch_prefill_line`
caps the vendor's own figure at the outstanding quantity and drops a line with nothing
outstanding — a ceiling, never a floor: a vendor who sent 4 of the 15 still owed has
sent 4, and prefilling 15 would have the gate confirm goods that are not there.

**A settled order leaves the Material Inward dropdown, on two independent tests.**

`_sync_po_receipt_status` is the writer, and it derives BOTH figures from the receipts
— `pro_po_items.received_quantity` per line (set, never incremented: it is a cache of
the same sum `po_received_by_line` reads, so it cannot drift) and the order's own
status. It used to count only receipts where `is_stock_posted`, which is the wrong test
for an ORDER: a delivery booked in and waiting on QC or put-away is not a delivery
still to come, so the order sat at ACCEPTED_BY_SUPPLIER and went on offering itself for
a second receipt for as long as the first was in QC. It now counts every receipt from
SUBMITTED onward (`RECEIVED_RECEIPT_STATUSES`) and runs on **submit** as well as on
posting — and on **cancel**, because the way back matters as much as the way forward:
an order stuck at RECEIVED has left the dropdown, and the delivery that actually turns
up then has nowhere to be booked in. `_po_status_after` is that rule, pure and tested:
an order nothing has arrived against keeps the status it has (PARTIALLY_RECEIVED on a
zero total tells a buyer a delivery has started when none has), and a receipt never
reopens an order a person cancelled or closed.

`po_options` then filters on the status AND, separately, on whether anything is still
outstanding — derived off the same rows `_assert_po_fulfilment` reads, drafts included.
The derived half is not redundant: an order received before this landed still reads
ACCEPTED_BY_SUPPLIER and no migration is going to walk history, and a DRAFT receipt
claims goods without moving the order at all, which is right — a draft is a claim, not
a delivery. Together they hold the property that matters: **the dropdown offers exactly
the orders the save would accept.**

`scripts/sync_po_receipts.py` brings history forward (`--apply`; idempotent, and a bare
run only says what would change).

**A settled order a storekeeper reaches anyway says so on the form** — a saved
receipt's own order stays visible through the picker's fallback — in a banner naming
the receipts that took it, rather than through a toast that scrolls away.

### A material issue is one ask per item, split over the bins that serve it (2026-09-03)

An issue LINE names one batch and one bin. The shelf frequently does not: fifteen
monitors sitting five in one bay and ten in another are two picks. The form could
express only one of them, so a storekeeper wrote 15 against a bin holding 5, the unit
picker — correctly scoped to that line's own batch and bin — then offered 5 codes for a
line claiming 15, and the gap between "codes selected" and "issued quantity" was the
only hint anything was wrong. It was read as a defect in the picker. It was the
document being unable to say what was happening.

**A split is a sibling LINE, not a new table.** `out_issue_items` already carries
`indent_item_id`, already allows several rows per item, and every downstream reader is
already per line — the reservation stamp, `_issue_unit_supply`, `move_stock_out`, the
occupancy preview, `stk_ledger`. So two bins are two lines against one indent line and
nothing behind the screen changed.

**The invariant, which fails silently if narrowed:** `requested_qty` is DISTRIBUTED
across a group's splits, never repeated. `_apply_issue_lines` refuses a line requesting
nothing and refuses a line issuing more than it requests, and `out_issues.total_qty` is
a plain SUM over lines — so a group asking for 15 must have splits whose requested
quantities add to 15. Put the full ask on each split instead and the document silently
asks for double, and nothing downstream will say so.

**The SCREEN half is `issueSplits.ts` + `IssueSplitEditor`**: the flat line array read
as one row per item — the ask on the left, every pick that serves it stacked on the
right, under ONE set of column headings for the whole document. `normalizeSplits` puts
the group's ask back onto its picks once, on the way OUT to the server, so the number in
the Issue qty box stays the storekeeper's until Save. **There is deliberately no
automatic split**: which bay a quantity comes out of is the decision of the person
standing at the shelf, and the screen's job is to say what is there. The client
normalising the ask does not make `_apply_issue_lines` optional — it is still the only
thing standing between a mistyped split and a document that asks for double.

`GET /api/warehouse/issues/stock-sources` is where the splits come from — every
(batch, bin) an item can be drawn from, ordered expiry-then-batch-then-bin, so a screen
taking them in order is doing FIFO without knowing what FIFO is. Read off `stk_balance`
alone, NEVER off `whs_serial_numbers`: that table is one row per physical unit and holds
773k of them. It honours `_stock_offerable(indent_id)` for the same reason `bin_options`
does.

**The same shelf is stated at three widths, and each figure carries the word for which
one it is** (2026-09-08): the warehouse (`item_total_qty` / `item_available_qty`), the
batch (`batch_total_qty` / `batch_available_qty`) and the location (the row's own
`total_qty` / `drawable_qty`). The two outer ones are SERVED, denormalised onto every
row of the item, and must never be summed out of the list on screen: a location another
document has reserved outright is not offered as a source at all, so adding the rows up
reports a stocked shelf as empty. They are read off `stk_balance` unfiltered by
`_stock_offerable`, in one extra grouped query. A bare number beside a dropdown is the
thing that gets read as the wrong quantity, so the grid says "40 in this batch" and "10
at this location", never "40" and "10" — and the drawable column is "Can give **here**",
because it is the one figure that is only about the bay the pick names.

**Which identifier is being asked for is SERVED, never inferred in a screen.**
`enums.TRACKING_META` (`GET /api/warehouse/tracking-types`) names each kind, and
`IssueItemRead.tracking_type` says which one a line wants. A serial, an IMEI, an asset
tag and a consumable lot code are fifteen characters of upper case and digits apiece —
indistinguishable by eye — so a storekeeper holding a handset could not tell which of
its two printed numbers the line wanted. `_tracking_type` is deliberately WIDER than
`_unit_mode`: the latter answers "which column does the matcher validate against" and
folds an asset tag and a lot code into one CODE, because to a matcher they are the same
column. On the shelf they are two different labels in two different places. Do not
collapse the two — `test_an_asset_tag_and_a_lot_code_are_not_the_same_label` exists to
catch it.

The picker is scoped to one pick's own batch and bin (it always was) and now SAYS so,
because a correctly short list reads as missing stock otherwise. Parity is checked per
PICK: ten units over two bins with all ten codes on the first used to look complete.

### A pick may move; FEFO decides how far (2026-09-08)

An issue drafted from an approved allocation names the batch and the bay inventory
reserved. The storekeeper standing at the shelf routinely finds neither: the pallet is
behind another, the bay was consolidated overnight. **Both may be changed, and the
hold follows** — but the two are not the same freedom.

**The storage location is his call.** One batch sitting in two bays is one batch;
FEFO cannot tell them apart, and which bay he walks to is not a decision the system
should be making. `LocationPicker` offers every location holding **that batch of that
item**, and the server checks only that the stock is there.

**The batch is FEFO's call.** The allocated batch was chosen earliest-expiry-first, so
a swap is allowed **only onto a batch expiring on the same day** — the single swap FEFO
cannot see. Reaching past an earlier batch onto a later one leaves the earlier stock to
expire and says nothing, which is why "no later than" is not the rule and neither is
"any batch with stock". A batch with **no recorded expiry matches only another with
none**: that is nobody having written a date down, not "never expires", and reading it
as a distant date makes an undated batch swappable for anything on the shelf.
`service._fefo_swap_allowed` is that rule, pure and tested without a database;
`_assert_issue_sources` applies it, and `issueSplits.allowedExpiries` states it in the
screen off the same rows. **A manual issue is not held to it** — nothing was signed to
depart from — so its batches are merely offered oldest-first, with the older one named
in a hint.

**`_assert_issue_sources` is also the first thing that ever checked the stock exists.**
A line may take what is free at its (batch, location) plus what THIS indent already
holds there — the same `drawable_qty` the screen shows — summed **per (item, batch,
location) across the picks**, because two picks on one bay each passing on their own is
how a bay gets over-drawn. Before it, a manual issue could promise a hundred units of
an item the point holds none of, and the mistake surfaced at `post_issue`, against a
document that had been through the whole ladder. Two reads for the document, never one
per line.

**Changing either frees the hold that was left.** `_realign_issue_reservations` runs on
create and on update: the reservation at the abandoned (bin, batch) is **released back
to `available_qty`, free to anybody**, and the same quantity is taken where the picks
now point (`allocation.relocate`, which owns the arithmetic — rule 7). The total held
never changes, so an issue drawing less than was allocated keeps the rest exactly where
it is; that is not a way to hand stock back. The grid says so before the press, per
item and once at the top.

**The pickers are built from `stock-sources`, not from `/options/batches` and
`/options/bins`.** Those return an id and a code, so the two decisions that actually
matter at the shelf — which batch expires first, how much is in the bay — were
invisible at the moment they were being taken. `BatchPicker` and `LocationPicker`
(`components/SourcePicker.tsx`) render expiry, days left, quantity and the walk down to
the location on every option, and the same detail on hover of the closed field. They
fetch nothing: the whole document's sources are already loaded once, where two Lookups
per pick over fifty picks were a hundred cached queries.

**`POST /api/warehouse/issues/unit-supply`** answers the OTHER question about a pick,
off the other table: how many physical units at that (batch, location) carry a serial,
IMEI or code the line could name. `stock-sources` is a quantity on `stk_balance`; this
is identity, on `whs_serial_numbers`. A pick can be sound on one and impossible on the
other. It exists because `units_available` on a saved line describes the bay the line
named **when it was last saved** — the moment a pick is repointed that number belongs
somewhere the storekeeper is no longer standing. **Bounded exactly as `_issue_unit_supply`
is**: the count stops at `need + 1`, so a figure equal to that means "at least", and it
never becomes the unbounded COUNT over 773k rows that CLAUDE.md warns about everywhere
else. One call for the whole grid, debounced 400 ms, deduplicated per combination
keeping the largest `need`.

**Lowering an issue quantity takes the surplus identifiers with it** (`trimUnits`, from
the tail — the last codes scanned are the ones still in the picker's hand).
`_reserve_issue_serials` refuses a pick naming more units than it issues, so before
this a storekeeper correcting 10 to 6 was sent back into the picker to unpick four by
hand.

**An issue can be raised with no indent at all.** `_build_issue` always allowed it —
only a LIP, the bottom of the chain where everything held arrived against a request, is
refused — but `IssueSplitEditor` was never given `onAddItem`, so the item picker
existed with no way to create the empty line it picks into. A main store issues to
departments, writes off scrap and moves stock for reasons no indent covers.

**And the item picker on an issue lists what the POINT holds, not the catalogue.**
`item_options` takes `warehouse_id` (decorates every row with `on_hand`, `batch_count`,
`location_count`) and `in_stock` (narrows to what can actually be issued). Both are
opt-in, so the GRN, put-away and inspection callers get exactly the list they had —
goods arrive for items a shelf has never seen, which is why the plain catalogue is
right there and wrong here. `on_hand` is DRAWABLE, by the same rule
`issue_stock_sources` uses, so the item list and the batch list underneath it can never
disagree about whether there is anything to take. **The whole catalogue stays one press
away** (`ItemPicker`'s "Show every item"): naming an item the system does not think is
there is a real thing a storekeeper has to do, and a picker that simply refuses is one
he works around. An item with nothing here is drawn "None here", and the row it lands
on says so in a sentence — the live database has 87 items in the master and 22 on the
main warehouse's floor, and picking one of the other 65 used to dead-end three
decisions deep: batch reading "nothing on the shelf" over location reading "pick the
batch first", with nothing anywhere saying **this point has never held that item**.
That band needs `sourcesReady`, because an empty source list means two different things
— still loading, and nothing here — and drawing the second before the first has settled
accuses a stocked warehouse of being empty.

### A delivery is acknowledged in STOPS, and each stop keeps its own proof (2026-09-19)

`/indents/acknowledgements/:id` is a journey, not a page of nested lists: the handover,
then one stop per package. One stop is on screen at a time and the rail above says
where you are — but nothing is locked, because a delivery is not a wizard and somebody
re-checking package two is not doing anything wrong. The receipt action itself is
unchanged and still SINGLE: one Acknowledge press in the footer, over everything
counted at every stop, enabled only once EVERY package is finished (counted, each item
photographed in that package, codes matched). There is no sign-off stop and no
Back/Next (2026-09-26); the bill moved onto the first consignment stop. A load gated
out with no transport request is named by its DSP number off the packing list, never
by the indent's.

**A photo belongs to the thing it is a photo OF.** The proof of a sealed load and the
proof of what was inside a particular carton are different evidence, and they used to
land in one pile — both packages read "1 photo" when one of them had been photographed,
and a dispute about carton two was answered with a picture of carton one. The package
rides on `doc_category` behind a separator (`RECEIPT_PHOTO::P-DISPATCH-4-PACKAGE-9`),
because `sys_attachments` is one flat table for every module with no column for it and
adding one is a platform change for a fact only this screen has (rule 4).

Both sides read the BASE and neither compares the whole string:
`service.ack_category_base` / `ack_category_scope` on the server,
`attachmentBase` / `attachmentScope` on the screen. That is what keeps every receipt
photo filed before this — all of them unscoped — a photo. Two consequences that fail
silently if narrowed: `add_receipt_attachment` validates the base and refuses a
malformed scope rather than trimming it (a shortened scope files proof against a
package nobody can find again), and `acknowledge_receipt`'s "is there any proof" check
reads the base too — matching the bare category counted only the handover, so a
requester who photographed every package and not the outside of the load was refused
for having no proof. Unscoped rows show at the FIRST handover stop, so nothing an
earlier receipt attached disappears from view.

What an approved item NOT in the opened package says is the list screen's own
vocabulary (`lineStage` / `STAGE` / `STAGE_HINT` in `acknowledgementParts`), so "On
order 8" carries its quantity here exactly as it does there. "With procurement" on its
own answers where the goods are and not how much of the line is there, and an indent
served in rounds — two of ten off the shelf, eight being bought in — is the common
case, not the exception.

### A receipt is proved ITEM by item, once each (2026-09-21)

A photo of the sealed pallet proves a delivery happened and nothing about what was in
it — and every dispute three weeks later is about one line: the wrong model of
handset, one crushed box of four. One package holding three items collected a single
photograph, so an argument about the second of them was answered with a picture of
the first.

So each line being acknowledged now needs a picture of ITSELF, and the rule is per
LINE and never per unit: sixty cables are photographed once. A rule that scaled with
the quantity would be satisfied by sixty pictures of one bundle — sixty times the
effort for no more evidence, and the storekeeper who learns that lesson stops looking
at what they are photographing. More than one is allowed and never asked for; the
second shot is the damaged corner.

The scope is `RECEIPT_PHOTO::I-<indent_item_id>-<packageHash>`, on `doc_category`
beside the consignment (`C-`) and package (`P-`) scopes already there, for the same
reason they are: `sys_attachments` is one flat table for every module with no column
for it, and adding one is a platform change for a fact only this screen has (rule 4).
The item id comes FIRST and is the only half the server reads
(`service.ack_category_item`, anchored so `IMAGE-9` is never mistaken for line 9);
the package half is the screen's, so the picture is filed against the carton it was
taken in. The SERVER matches on the id alone; the SCREEN, since 2026-09-26, matches
the whole scope — an item split over two cartons of five is photographed, and its
codes matched, once per carton, because a photo taken while the first was open was
ticking the second off before anybody had opened it. The screen is the stricter of
the two, so the save can never refuse what the screen let through.

`acknowledge_receipt` refuses a receipt whose lines are not all photographed and
**names the ones that are not**; "1 item still needs a photo" on a delivery of eleven
sends somebody back through every carton to find out which. `add_receipt_attachment`
refuses an item scope naming a line that is not on this indent, for the same reason
it refuses a malformed package scope: proof filed where nobody can find it again.

What this replaced: **the package photo is no longer required** (`PhotoStrip
optional`) and the consignment photo says "(recommended)" out loud. A step whose
every task is optional is its own rail state (`StopState` `optional`, a dashed ring),
never "unfinished". The BILL is the delivery's, not a carton's: it is added once, on
the first consignment stop, unscoped, and every bill filed at any stop is listed there. Both are still
there and still worth taking — they are what a claim against a carrier is argued from
— but the gate moved onto the items, and a step that reads exactly like a required
one and is not is the reason somebody stops believing any of them.

On the screen it is `ItemProofStrip`, one per line in `PackageLineRow`: amber until
there is a picture, green after, with the shots themselves at thumbnail size and one
`capture="environment"` press that opens the rear camera on a phone.


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

## Running at scale, and the attachment rule (2026-09-03)

Three read-only reviews (load rating, field readiness, security) rated the system at
roughly **50–120 concurrent users against a target of 1,000–2,000**. The domain logic,
the indexing, the workflow engine and the row-locked stock paths were not the problem;
everything AROUND them was. What changed:

**A file belongs to a document, and every route must say which.** `sys_attachments` is
one table keyed by `(entity_type, entity_id)` — a soft key nothing enforces — so a
route taking a bare `attachment_id` was acting on the whole store. Warehouse's
`DELETE /attachments/{id}` and indents' `DELETE /receipt-attachments/{id}` would delete
any file in the system, and warehouse's `POST /attachments` filed bytes wherever its
form fields said. `attachments.delete_attachment` now REFUSES to run without a stated
`entity_type` (keyword-only, no default), so a new route cannot forget;
`require_attachment` returns the row so the caller can then run its own module's
visibility check on `row.entity_id`. Uploads are whitelisted by extension AND by the
file's own leading bytes — `content_type` is written by the client — and the 20 MB cap
is enforced WHILE the bytes stream to disk. `.svg` and `.html` are refused for the same
reason `.exe` is: served back from our own origin they are stored XSS.

**bcrypt never runs on the event loop.** `hash_password_async` / `verify_password_async`
are what request handlers call; the sync pair stays for scripts and tests. A `verify`
called from an `async def` stopped the whole application for 250 ms, which capped the
system at about four sign-ins per second — a shift change could not get through.

**One process runs the schedulers.** `RUN_SCHEDULERS` is true on exactly one
single-replica `worker` container and false on every web worker. Two schedulers means
two concurrent HCM syncs writing the same mirror tables and every reminder delivered
twice to a real person. Do not start APScheduler from a web worker.

**Shared state lives in Redis, and Redis is optional.** `core/cache.py` carries the
permission cache, the integrations rate limiter and the login throttle. With
`REDIS_URL` unset every one of them falls back to a per-process dict with the same
semantics, so development needs nothing installed — but a per-process limiter
multiplies the configured ceiling by the worker count, which is why more than one
worker requires it. Nothing in `cache.py` may fail a request; `allow()` is the one
deliberate exception, and it fails closed.

**The permission cache TTL is a security parameter.** `get_user_permissions` now
caches across requests, which removes most of the database traffic — every
authenticated request re-derived the set in 4–6 queries. That TTL is now the lag
between an admin revoking a grant and the revocation biting, so keep
`PERMISSION_CACHE_SECONDS` under 15 minutes. A write to any grant model drops the
whole prefix through the existing `after_flush` hook; the TTL is only the backstop.

**Sized from the environment, not from code.** `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` default
to the development 5+5 (several developers share one MySQL capped at 151) and
production sets 20+10. The pool is PER WORKER, so
`WEB_CONCURRENCY × BACKEND_REPLICAS × (size + overflow)` must stay under the server's
`max_connections` — `deploy/mysql.cnf` raises it to 500 and sets the buffer pool, the
slow query log and a 30 s statement timeout.

**Login is throttled twice.** Per account (`failed_attempts`/`locked_until` — columns
that had existed since the beginning with nothing incrementing them) and per address
(`core/throttle.py`, plus nginx `limit_req`). The lock is checked BEFORE the hash, so a
locked account stops costing a bcrypt per attempt.

**There is a backup.** `deploy/backup.sh` in the `backup` service. Set
`BACKUP_HOST_DIR` to off-host storage — the default named volume sits on the same
machine as the database it protects.

**There are metrics.** `METRICS_ENABLED` exposes per-endpoint latency and a
connection-pool gauge on `/metrics`, which nginx deliberately does not proxy.

Still open, in payoff order: route-level `React.lazy` (one 2.7 MB chunk), the Home
dashboard's per-item query loop, synchronous Excel export on the event loop, a job
queue for exports/imports/mail/webhooks, and a load test against a production-sized
dataset — the numbers above are derived from code, not measured.

---

## How much one request may carry (2026-09-03)

`app/shared/limits.py`. Ninety-five request-body list fields had no maximum length —
indent lines, allocation and issue batches, serial and IMEI lists, workflow stages,
every `*_ids` selection. A resilience review traced a crash to it: a quantity of
200,000–300,000 is one harmless `NUMERIC(16,3)` write, but a SERIAL-TRACKED line
expands it into that many individual unit records (`_claim_units`, `_land_units`,
`_ship_units`, `_mark_serials` all call `int(quantity)` and work per unit), so one
document locks hundreds of thousands of rows in a single request, holds the pool and
runs past nginx's 60-second read timeout. The screen dies and the user cannot tell
whether it worked.

The caps: 500 document lines, 500 batch ids, 200 whole documents in one batch, 1,000
serials per line, **5,000 serials per request** and 100 configuration entries. The
last one is the load-bearing check — the per-line cap alone still permits 500 × 1,000
with every individual line legal, so `assert_serial_budget` counts the whole request
in a `model_validator` on the six warehouse schemas that nest serial lines.

**These are REQUEST limits, not business limits.** A site that genuinely needs to
issue 50,000 serials uploads a manifest and lets a worker process it in chunks.
Raising a number in `limits.py` to make a screen work is almost always the wrong fix —
the right one is the durable job queue that is still outstanding
(`docs/09_CAPACITY_BACKLOG.md`).

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
14. **Capacity and Occupancy, in HANDLING UNITS** (`modules/warehouse/capacity.py`).
    A bin holds packs, not a puddle of cubic metres: space is
    `ceil(qty / units per pack) x volume of one pack`, measured at a rung of the item's
    own ladder (`mst_item_packaging`), because half a case still occupies a case's
    footprint. `mst_items` carries NO dimensions and no unit volume — `qty x
    volume_per_each` reports a full bin as nearly empty and was removed for it
    (`b8e4f1c7a2d9`).
    A location is checked on **four independent gates** — cube (derated by its void
    factor), payload against GROSS weight, the bounding box (does one unit physically
    enter it), and the discrete limit ("one euro-pallet, or four totes"), stated or
    slotted. Passing three and failing one is failing.
    Occupancy is **read, never stored** — computed on demand from stock through each
    item's default putaway unit, so a putaway, an issue or a correction changes the
    answer by existing. Capacity **warns, never blocks**: the goods are on the floor
    whether or not the master data says they fit, and refusing only means stock sits in
    a bin nobody wrote down. Every verdict's wording is SERVED (`status`, `headline`,
    `detail`, and each gate's own sentence), never composed in a screen.
    An unmeasured pack has NO volume, not zero — zero reads as "there is room".
    **Stock sits wherever it was put down, at any rung of the tree** (2026-09-04).
    `confirm_putaway` takes a floor, a lane, a rack, a shelf or a bay; only `is_active`
    and "in this warehouse" are checked. Refusing anything above a BIN never stopped a
    pallet of drums standing at the end of a lane, or a delivery landing before its bay
    was built — it only stopped the system being told, and stock nobody wrote down is
    worse than stock in the wrong shape of location. The four gates still measure
    whatever was chosen, and still warn rather than block. Movement and material-issue
    locations follow the same rule, or stock that CAN be put on a rack could never be
    taken off one; `_apply_issue_lines` validates the LOCATION (exists, this warehouse,
    active) and never its rung.
    **Nothing suggests a location.** `_suggest_bin`, `suggested_bins`,
    `GET /putaways/{id}/suggested-bins`, `capacity.suggestion_fit` and
    `SUGGESTION_RANK` are gone, and a task is raised with no bin on it
    (`putaway_type` MANUAL, `suggested_bin_id` NULL). A shortlist of eight ranked bays
    only makes sense while a putaway can go nowhere else; in front of somebody who may
    correctly choose any of nine hundred locations it is a wrong answer with an
    ordering on it. `whs_warehouse_items.suggested_bin_id` stays on the table and is
    still read back, so tasks raised before this keep the only record of where they
    were sent.
    **Every storage location carries a cube, and contains what is inside it.**
    `length_cm`, `width_cm`, `height_cm` and `capacity_volume` are on
    `whs_warehouse_locations`, which is ONE table for the whole tree — so a floor, a
    lane and a rack are each measured exactly as a bay is. `capacity.gross_volume` is
    that cube: stated, else derived from the three sides, and **never derated** — the
    void factor answers "how much stock goes in here", containment answers "does this
    box enclose those boxes", and a rack derated to 80% still physically encloses all
    of its shelves.
    The rule: **a location is at least as big as the sum of the locations directly
    inside it**, enforced by `_assert_volume_contains` on every `create_bin` and
    `update_bin`, in both directions — shrinking a rack below its shelves is refused as
    well as growing a shelf beyond its rack. Checking each EDGE on each write is what
    makes it hold for N levels; a floor contains everything under it by induction, and
    no write re-reads the building to prove it. `>=`, not `>`: three 1 m3 shelves in a
    3 m3 rack is how racking is built. An **unmeasured** location claims nothing rather
    than zero, is counted separately, and is said out loud — a budget that silently
    treats four unmeasured shelves as taking no space is worse than one that admits it
    cannot answer. `GET /bins/{id}/volume-budget` serves that arithmetic to the form,
    so the sentence on screen and the rule the save enforces cannot drift apart.

### What a storage location IS, is a master (2026-09-05)

The kinds of storage location — floor, lane, rack, shelf, bin, cold room, refrigerator
— were an enum in three places at once: `shared.enums.BinType`, a `STORAGE_TYPES` tuple
the write schema validated against, and a `BIN_TYPES` array in `BinForm.tsx` with a
`defaultChildType` ladder beside it. They never fully agreed, and the live data has
always used **STAGING**, which the write schema rejected — so those locations could be
read and never saved from the form that owns them.

They are rows now. **Warehouse > Masters > Storage types** (was "Refrigeration types",
`/warehouse/masters/storage-types`), over `whs_warehouse_storage_types` and the new
`whs_storage_type_parents`. A cold room is a KIND OF LOCATION, not a separate idea,
which is what the old screen made it — there is no second "refrigeration type" to pick
on a bin any more, and `whs_warehouse_locations.storage_type_id` now means the kind.
`storage_type` still carries that row's code, denormalised, so every query already
reading the code keeps working; only `service._resolved_kind` writes the pair.

Four flags carry what used to be hardcoded about a kind, and all four fail SILENTLY if
they drift: `is_pickable` (the `BIN_TYPES` tuple, as data — what a bin picker offers),
`is_temperature_controlled` (was the browser asking whether the code contained "COLD"),
`allow_top_level`, and `sort_order` (the rung's depth, so every list reads floor, lane,
rack, shelf, bin rather than alphabetically).

**A kind sits where the master says it sits.** `whs_storage_type_parents` is which
kinds may hold which, and it is the SAME list on both sides: the location form offers
only locations of an allowed kind as a parent (`storageTypes.eligibleParents`), and
`storage_types.assert_can_sit_under` refuses the save. A screen that offers only racks
over a server that accepts anything is a screen nobody trusts twice. A kind with no
parents configured is NOT constrained — the list starts empty for a kind somebody has
just added, and refusing everything would make a new rung unusable on the day it exists.

`is_pickable` on a location row reads a per-process registry in
`shared/models/warehouse.py`, refreshed from the master by `storage_types.pickable_codes`
whenever the module reads or writes one. That is deliberate: it is a plain property on
an ORM row, so it cannot go to the database and a lazy relationship would raise
MissingGreenlet. Every QUERY that filters on pickability reads the master directly and
is therefore always right; the registry only decorates rows already loaded, and it
starts life holding the old tuple.

`StorageType` and `StorageTypeParent` are mapped in `shared/models/warehouse.py`, beside
`Bin` and for the same reason: the shared masters API (`/api/bins`,
`masters/defs.apply_bin`) has to check a location's kind, and shared may not import a
module (rule 5). The rules live in `modules/warehouse/storage_types.py`.

`c1a7d3f9b2e5` adds the columns and the table, seeds the standard ladder, seeds a kind
for every `storage_type` the DATA already uses that the ladder does not name, and
backfills `storage_type_id` from the code. It is **also the merge point** for the two
Alembic heads this tree had grown (`92c9c40ec9d7` and `fb6b1c0ef043`) — see the section
below for what two heads cost the last time. `bootstrap` seeds the ladder through
`provision_warehouse`, the test `engine` fixture through the same call, and
`POST /api/warehouse/storage-types/seed-defaults` puts it back on a site whose master
is empty. All three are idempotent and none of them corrects an edited row.

**The floor plan is a tree** (`/warehouse/masters/floor-plan`). It was a flat table,
which is what a list of `whs_warehouse_locations` looks like if you forget that
`parent_location_id` is the whole point — `F1-A1-R1-B2` sorted next to `F1-A1-R1-B1`
says nothing about which end of which floor either is on, and the codes are
near-identical by design. `list_locations` now serves `path`, `path_names`, `level`,
`parent_code`, `child_count`, `is_pickable` and the kind's `storage_type_name`, all
DERIVED on the way out: a stored path goes stale the day somebody re-parents a rack and
nothing tells you it has. It is still not a drawing — the table carries no surveyed
coordinates, and an invented layout would look authoritative while being fiction.

### A 500 on a screen that worked yesterday is usually an UNAPPLIED MIGRATION

Two outages on 2026-09-03, one cause: the database was behind the models.

`sys_audit_log` was missing `location`, `device_type`, `browser`, `os` and
`user_agent`. Every `write_audit` INSERT names all five, so **approving a material
request 500'd**, and so did the home dashboard. The migration that adds them
(`fb6b1c0ef043`) already existed, already idempotent — it had simply never been run,
because it sat on the second of two Alembic heads and `alembic upgrade head` refuses
to move with more than one.

So when a screen 500s, check drift BEFORE reading code:

```
.venv/Scripts/python -m alembic heads     # more than one? nothing is upgrading
.venv/Scripts/python -m alembic current
```

Compare the models to the live schema directly — SQLAlchemy's metadata against
`information_schema` — rather than guessing from the traceback. A missing COLUMN
raises 1054 the moment anybody opens that screen; a missing INDEX raises nothing at
all until a sort gets big enough or a JSON column widens the sort record (see the
section below).

As of 2026-09-09 the tree is back to **one head** (`f7a1c3e5d9b2`), so
`alembic upgrade head` moves again. Check `alembic heads` before assuming otherwise.
Three merge revisions now stand in that lineage, each of them schema-free and each
cut for the same reason — a branch and `qa` grew a migration apiece and neither side
would apply while there were two heads: `c1a7d3f9b2e5` joins `92c9c40ec9d7` and
`fb6b1c0ef043` (and adds the storage-type master), `b3e7c9a1d4f6` joins that to the
qa floor-access lineage, and `f7a1c3e5d9b2` joins THAT to `e4f5a6b7c8d9`, the indent
line-exclusion columns. A merge revision every time, never a re-pointed
`down_revision`: a database already stamped at one side would treat the other side's
revisions as ancestors it had passed and skip them in silence.

As of 2026-09-03 this database has **0 missing tables and 0 missing columns**, and 54
missing single-column indexes, all on `lgs_*` and `pro_*` tables that were created by
hand rather than by `create_all` (the bootstrap note explains why those exist). Those
are a performance matter, not a correctness one — but they are the reason a
`pro_*` list screen can be slow for no visible reason.

### Never sort a list on a non-indexed column of a JSON-bearing table (2026-09-03)

The stock ledger returned a 500 on every load. The cause was `ORDER BY created_at
DESC` over `SELECT *` on `stk_ledger`, which raised MySQL 1038, "Out of sort memory".

It is NOT a volume problem, and diagnosing it as one sends you looking in the wrong
place: the table held **333 rows**. `stk_ledger.serial_numbers` is a `json` column;
MySQL sizes a filesort record by each column's MAXIMUM possible width, a JSON
column's maximum is enormous, and one sort record alone therefore exceeds the default
`sort_buffer_size` of 256 KB. It fails identically at three rows and three million.

**Twenty-five tables here carry a JSON column** — `stk_ledger`, `stk_balance`, every
`hcm_*` mirror (`raw`), `wf_instances` (`resolved_chain`), `sys_audit_log`,
`sys_app_logs`, `inb_receipt_items`, the inspection items, `pro_po_revisions`. A list
query over any of them must order by an INDEXED column, and the primary key is
already indexed on every one.

Order by `id`, not by `created_at`, and it fixes a second defect at the same time:
`created_at` is not unique (a posting writes its whole batch in one transaction — 333
ledger rows share 168 distinct timestamps), so ordering on it leaves ties undefined
between one page and the next and rows repeat on page 2 or vanish. An auto-increment
primary key is the insert order AND unique, and reading it backwards is an index scan
with no sort at all.

Raising `sort_buffer_size` would also stop the error, and is the wrong fix: it hides a
full-table filesort behind a bigger buffer instead of removing it.

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
- A package (`mst_packaging`) is a container type **and its own physical spec**: the
  outer box empty, the TARE weight, and the handling rules that follow from how it is
  built (stackable, max tiers, may it be turned, void factor). None of that depends on
  the contents, so it is configured once and inherited.
  How much of an item one holds lives on `mst_item_packaging`, one row per level, and
  the breakdown is multiplied up on read so totals cannot drift from their rungs. A
  rung is a full **packaging unit**: the conversion factor, an optional dimension
  OVERRIDE (blank means the container type's), the GROSS weight — item-specific, hence
  not on the container — and `is_default_putaway_unit`, at most one per item and
  enforced in `apply_item_packaging` for the reason `apply_vendor_item` gives about its
  preferred vendor. This is what `modules/warehouse/capacity.py` checks a bin against
  (rule 14); an item with no measured rung is one no location can report a fill for.
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
