# Bug Sheet — V1.22 QA Findings (SCM_0051–SCM_0065)

Investigated against the current `Sindhu` branch. Each entry has the reported
symptom, the actual root cause found in the code (with file/line references),
and the fix plan. Items are grouped by module and ordered by suggested
sequencing within a module (shared root causes first).

Legend: 🟢 confirmed root cause, clear fix · 🟡 root cause confirmed, fix needs
one judgment call · 🔴 needs reproduction/clarification before coding (listed
with the strongest hypothesis, so whoever picks it up can verify fast).

## Implementation status (2026-10-19)

**Fixed and verified** (frontend build + relevant test files pass; no
regressions found in any test file touched, confirmed by diffing pass/fail
counts against the unmodified code):
- SCM_0051 / SCM_0054 — Indent Type filter + column on the Requests list and
  the Fulfilment Desk/Queue; the monthly-cycle row is now labelled "Monthly
  cycle" so its own CYC/… number is never mistaken for an indent's number.
- SCM_0055 — Lock/Unlock buttons on the RFQ list gated on `rfq.approve`.
- SCM_0057 — Freeze Prices button added directly to Compare Quotations.
- SCM_0060 — "Lines" → "Number of Items" on Requisitions and RFQs lists.
- SCM_0061 — Save Consignment button now carries a tooltip naming the first
  blocking issue (also fixed the shared `Button` component silently dropping
  `title` everywhere — a real pre-existing defect affecting 30+ call sites).
- SCM_0065 — "Overall discount" relabelled "Overall discount (amount)" with a
  hint clarifying it is not a percentage.
- SCM_0052 / SCM_0053 — DC/DOD document: Vehicle/Licence/E-way/Carrier
  ref/LR/Docket collapsed into one "Tracking Number / Reference Number"
  field; Indent/Project/Distance removed from the metadata strip.
- SCM_0063 — the shared `act` mutation now resets on every new confirm
  dialog, so a stale error from a previous press can no longer display on a
  press that actually succeeded.

**Deliberately not coded — see the item's own section for why:**
- SCM_0053's "From" address — the backend captures no address for a
  shipment's origin anywhere today (only a bare `from_warehouse_name`); the
  "To" side already shows a full address because it's typed in at creation.
  Fixing "From" needs a real backend change (new column + migration +
  population logic) I can't verify runs cleanly without a live DB in this
  session, so I left it as a backend TODO rather than guessing at it blind.
- SCM_0059 / SCM_0063's underlying 500 — the generic "work not saved" message
  is confirmed to mean a real unhandled server error, but which line throws
  depends on data state at the moment of approval; needs one live repro with
  backend logs visible to catch the actual exception.
- SCM_0058, SCM_0062, SCM_0064 — still blocked on the clarifications in their
  own sections (a product decision, the exact error text, and a ladder-config
  check respectively). Coding a guess here risked papering over the real
  issue or masking a genuine permission gap.

---

## Indents module

### SCM_0051 — No Indent Type filter/column on the Requests list 🟢
**Report:** Filters don't identify Monthly (Fixed) vs Adapt indents; no
Indent Type column in the table.

**Root cause:**
- `Indent.indent_type` is a real, indexed, NOT-NULL backend column
  (`backend/app/modules/indents/models.py:76`, `ix_ind_type` at line 163) with
  values `REGULAR` (the ad-hoc/"Adapt" type) and `MONTHLY` (+`STR`) per
  `frontend/src/modules/indents/types.ts:20`.
- `ListPage.tsx`'s column array (`columns`, lines 176–243) has no `indent_type`
  column at all.
- `IndentFilterContext.tsx` has no `indent_type` filter key — grepped the
  whole file, zero matches.

**Fix:**
1. Add an `indent_type` filter (`FilterMenu`) to `ListPage.tsx` / 
   `IndentFilterContext.tsx`, options: "Adapt (Regular)", "Monthly (Fixed)",
   "Stock Transfer". Thread it into `normalizeIndentQueryParams` and the
   `indentApi.list` call like the existing status/region filters.
2. Add an "Indent Type" column to the `columns` array (render a short label —
   reuse the same label strings as the filter — plus the card view).
3. Backend: confirm `GET /api/indents` already accepts `indent_type` as a
   query param (likely yes, given the indexed column) — `backend/app/modules/indents/router.py`.

---

### SCM_0054 — Fulfilment Desk: no Indent Type signal, and indent number mismatch 🟢
**Report:** Same filter/column gap as SCM_0051, plus "the indent number shown
for a Monthly (Fixed) Indent differs from the number created for that indent."

**Root cause (two parts, same screen):**
1. Same missing filter/column gap as SCM_0051, on
   `frontend/src/modules/inventory/pages/FulfillmentQueuePage.tsx`.
2. The number mismatch is **by design, but mislabelled**. A monthly indent is
   deliberately never shown as its own row — it's folded into its monthly
   cycle, because a cycle can bundle hundreds of indents
   (`FulfillmentQueuePage.tsx:139`, `singles = raw.filter((r) => r.indent_type !== "MONTHLY")`).
   The row standing in for the whole cycle then does this at line 149:
   ```ts
   indent_no: b.consolidation_no
   ```
   — it puts the **cycle's own document number** (`consolidation_no`) into the
   field the UI renders as `indent_no` (rendered at lines 201 and 388). A user
   searching for the indent number they were given will not find it here,
   because what's on screen is a different document's number wearing the same
   label.

**Fix:**
1. Filter/column: same as SCM_0051.
2. Don't overwrite `indent_no` — keep the row's own `cycle_no`/`consolidation_no`
   in its own field, and change the label from "Indent No" to "Cycle No" (or
   similar) specifically for cycle rows, so the screen is honest about which
   number it's showing. Optionally surface the count of underlying indents
   ("Cycle CYC/2026-27/0004 — covers 14 indents") so a user can still confirm
   their own indent is in there without a number collision.

---

## Procurement module

### SCM_0055 — RFQ "Locked" button error on reopen bidding 🟢
**Report:** Clicking Locked → attempting to reopen bidding shows an error.

**Root cause:** Both `freeze`/`unfreeze` endpoints require `rfq.approve`
(`backend/app/modules/procurement/router.py:550,560`). On
`RFQDetailPage.tsx` the Lock/Unlock buttons are correctly wrapped in
`<Can do="rfq.approve">` (lines 325–340). On
**`RFQListPage.tsx` they are not** — the "Locked"/"Lock RFQ" buttons in both
the table column (lines 156–192) and the card view (lines 244–274) render
unconditionally. A user with view-only RFQ access sees and can click
"Locked", the modal lets them type a reason and confirm, and the request is
then rejected server-side with a permission error — which reads exactly like
"an error message" with no indication that it's a permissions issue, not a
reopen-bidding issue.

**Fix:** Wrap the lock-column renderer and the card-view buttons in
`<Can do="rfq.approve">` in `RFQListPage.tsx`, matching the gating already
present on `RFQDetailPage.tsx`.

---

### SCM_0057 — Compare Quotations: Award & Generate POs errors; Freeze Prices button missing 🟢
**Report:** Award & Generate POs errors out; no Freeze Prices button on the
submodule.

**Root cause:** The two symptoms are one cause. `award_rfq` hard-refuses an
award unless the tender is frozen:
```python
# backend/app/modules/procurement/service.py:4589
if not rfq.is_price_frozen:
    raise ValidationError(f"Freeze prices on {rfq.rfq_no} before awarding...")
```
But the **Compare Quotations** screen (`PriceComparePage.tsx`) only has a
"Frozen" badge (line 194–198) and a warning paragraph telling the buyer to go
"freeze them on the RFQ page" (lines 257–262) — there is no Freeze Prices
**action** on this screen. The actual Freeze/Unfreeze buttons only exist on
`RFQDetailPage.tsx` (lines 325–340), a different page. So a buyer comparing
quotes and clicking Award gets the "freeze first" `ValidationError`, with no
way to act on it from where they are.

**Fix:** Add a "Freeze Prices" button directly on `PriceComparePage.tsx`,
visible when `!rfq?.is_price_frozen`, calling the already-existing
`rfqApi.freeze(rfqId)` (same mutation pattern as `RFQDetailPage.tsx:153-156`).
Gate it with `<Can do="rfq.approve">`. This removes the round trip to another
screen and the award then succeeds on the first press.

---

### SCM_0059 — RFQ "Approve & Publish" shows "Your work was not saved" 🟡
**Report:** Clicking Approve & Publish shows a generic failure toast.

**Root cause:** `"Your work was not saved"` is the frontend's **generic
fallback for any HTTP ≥500** (`frontend/src/shared/api/errors.ts:97-104`,
`statusDefault`) — it is never a validation message, so this is a genuine
unhandled server error on `act_on_rfq`
(`backend/app/modules/procurement/service.py:3394-3411`).

Traced the two things that run after the state change:
- `email_rfq_copies` (the vendor-notification email, called at line 3410 when
  status becomes `PUBLISHED`) **does** have a `try/except Exception` around
  the actual send (service.py:3504-3514) — ruled out as the cause.
- Everything else in `act_on_rfq`/`_publish_rfq` is plain ORM work inside the
  same transaction as the commit at line 3408.

**What this means:** the 500 is real but its exact trigger wasn't
reproducible from static reading alone — it depends on data state at the
moment of approval (e.g. a vendor row, an item mapping, or a quotation
relationship that `_publish_rfq`'s loop over `rfq.vendors` touches,
`service.py:3414-3450`). 

**Fix plan:**
1. Reproduce once with backend logs/traceback visible (run `uvicorn` in the
   foreground, hit Approve & Publish on the RFQ from the screenshot) to get
   the actual exception — this turns 🟡 into 🟢 immediately.
2. Whatever it is, the bigger structural fix is: **don't return a bare 500
   on the frontend when the state change already committed.** Either (a) fix
   the actual exception so publish fully succeeds, or (b) if the failure is in
   genuinely optional post-commit work (notifications, etc.), wrap it the same
   way `email_rfq_copies`'s mail-send already is, so a secondary failure never
   masks a successful approval.

---

### SCM_0058 — Approved MRs not visible in the RFQs table 🔴 (needs clarification)
**Report:** Approved MR records show in Requisitions but not in RFQs.

**What's actually true in the code, and why this may be working as designed:**
RFQs and Requisitions are different documents on purpose — an RFQ doesn't
exist until a buyer explicitly creates one. The real chain is:
1. MR approved in Inventory →
2. `ensure_mr_drafts` (`service.py:2548-2589`) lazily creates a **DRAFT**
   requisition the next time anyone opens the Requisitions list
   (`service.py:2633`) — this is why it already shows there.
3. That draft has to be filled in (stocking point, rates) and pushed through
   its own approval (or auto-approved via `create_requisition_from_mrs` if
   consolidated, `service.py:2379` — "approved on arrival... skips one rung,
   not the chain").
4. Only once the **Requisition** itself is `APPROVED` does
   `RequisitionDetailPage.tsx:153-158` show a "Create RFQ" button
   (gated on `isApproved && !req.has_rfq && !req.has_consolidation`), which is
   the only door into `RFQFormPage.tsx` (cold-start or
   `?requisition=<id>`/`?consolidation=<id>` — there is no "pick straight from
   an MR" entry point into the RFQ form, confirmed reading
   `RFQFormPage.tsx:1-70`).

So an approved MR legitimately will **not** appear as an RFQ until someone
has walked it through steps 2–4. Before writing any code here:

**Needs clarification (screenshots referenced in the ticket would resolve
this in one look):**
- Was the underlying Requisition actually `APPROVED` at the time, with no
  RFQ/consolidation already claiming it (`req.has_rfq`/`has_consolidation`,
  `service.py:2528-2544`)? If yes and "Create RFQ" was still missing, that's a
  real bug in the `has_rfq`/`has_consolidation` computation worth chasing.
- Or did the tester expect the RFQ list/creation screen to directly surface
  eligible approved MRs (skipping the Requisition step)? If so this is a
  product/workflow gap, not a defect — flag for a product decision rather than
  a code fix.

---

### SCM_0060 — Requisitions column "Lines" → "Number of Items" 🟢
**Report:** Rename column label for clarity.

**Root cause:** `RequisitionListPage.tsx:103`:
```tsx
{ key: "lines", header: "Lines", className: "text-right", render: (r) => r.total_items },
```
Trivial label fix. (Same `"Lines"` header also exists on
`RFQListPage.tsx:143` — not explicitly asked for, but worth renaming together
for consistency since it's the same column meaning the same thing.)

**Fix:** Change `header: "Lines"` → `header: "Number of Items"` in both
files.

---

## Logistics module

### SCM_0052 & SCM_0053 — DC/DOD document fields 🟢 (one document, one fix)
**Report (0052):** Remove Vehicle Number, Licence Number, E-way Bill Number,
Carrier Reference, LR Number, Docket Number; add a Tracking/Reference Number
field.
**Report (0053):** Remove Indent, Project, Distance; show full From/To
addresses with the LIP/MDP/Warehouse name.

**Root cause:** Both reports are about the same screen —
`frontend/src/modules/logistics/pages/GatePassPrintPage.tsx`, which literally
titles itself `"DC/DOD - Document of Deliverable"` (line 80).

- **0052's fields** come from `gatePassFields.ts`'s `allocated()` function
  (lines 95-131). For a third-party carrier (`rule.needs_carrier`, lines
  101-109) it allocates exactly the six fields the ticket wants gone —
  `vehicle_number, driver_licence_no, lr_no, docket_no, eway_bill_no,
  carrier_reference` — alongside `carrier_name`, `driver_name`,
  `driver_phone`, `expected_delivery`. A `tracking_url` field
  ("Tracking link") already exists in the type (`gatePassFields.ts:23,40`) but
  isn't part of this allocation.
- **0053's fields** are the `metadata` array on `GatePassPrintPage.tsx:88-97`
  (`Indent` line 91, `Project` line 92, `Distance` line 95) and the "Where it
  is going" block (lines 100-114): `From`/`To` currently render only
  `doc.from_warehouse_name` / `doc.to_location_name` (bare names, lines
  103-104) — `delivery_address` (full address) is only wired up for the
  destination (line 106-109), not the origin.

**Fix:**
1. In `gatePassFields.ts`'s `needs_carrier` branch, drop
   `vehicle_number, driver_licence_no, lr_no, docket_no, eway_bill_no,
   carrier_reference` and keep/promote a single `tracking_url`-style field,
   relabelled "Tracking Number / Reference Number" in `CARRYING_LABEL`. Check
   with the business whether `tracking_url` is the right backing field or
   whether it needs a new generic `reference_no` the carrier can fill with
   whichever of LR/docket/e-way they actually have (likely a new backend
   field feeding this one slot, since right now LR/docket/e-way are three
   separate columns being collapsed into one on the document).
2. In `GatePassPrintPage.tsx`, remove the `Indent`, `Project`, `Distance`
   entries from `metadata` (lines 91, 92, 95).
3. Add a `from_address` (or equivalent) to the "Where it is going" block
   alongside `from_warehouse_name`, mirroring how `delivery_address` already
   works for the `To` side — so both From and To show "LIP/MDP/Warehouse name
   + full address". Needs a backend field check: does the transport-request
   read model (`transportApi`) currently carry the origin's full address at
   all, or only its name? If not, that's the actual backend addition needed
   here.

---

### SCM_0061 — Save Consignment inactive with no validation message 🟢
**Report:** Save button inactive; no message explaining what's missing.

**Root cause:** `ConsignmentForm.tsx:1157`:
```tsx
<Button onClick={() => save.mutate()} disabled={save.isPending || formIssues.length > 0}>
```
`formIssues` (computed at lines 822-838 — missing issue selection, missing
expected delivery, unlocked packages, under/over-packed lines, duplicate
serials) **is** rendered, but only inside the "Packages" section far down the
page (lines 1355-1367: "Complete these before saving"). The Save button
itself sits in the page header near the top (line ~1157) with **no `title`
tooltip** — unlike the equivalent pattern already used elsewhere in the
codebase, e.g. `MaterialIssueForm.tsx`:
```tsx
disabled={blocking.length > 0}
title={blocking.length > 0 ? blocking[0].message : undefined}
```
So a user who hasn't scrolled down (or whose blocking issue is something
near the top of the form, like "Select a material issue") sees a greyed-out
button with zero explanation at the point of interaction.

**Fix:** Add a `title={formIssues.length > 0 ? formIssues[0] : undefined}`
(or a small inline hint) to the Save button itself, matching the
`MaterialIssueForm.tsx` pattern. Optionally also surface the first blocking
issue as a small inline banner right under the page header, not only inside
the Packages section.

---

### SCM_0064 — SCM Head gets a permission error approving Shipments 🔴 (needs ladder-config verification)
**Report:** SCM Head clicks Approve on a shipment and gets an error, despite
having the expected permissions.

**Root cause hypothesis:** This is almost certainly **two separate systems
being conflated**, not one bug:
- RBAC (`transport.approve` permission) controls whether the **Approve
  button renders**.
- The workflow engine separately checks whether *this specific user* is in
  the **resolved approval chain for this specific document**:
  ```python
  # backend/app/platform/workflow/engine.py:773-774
  if user.id not in {row.approver_id for row in pending}:
      raise PermissionError_("You are not a valid approver for the current stage")
  ```
  That chain is built at submit time by climbing the raiser's HCM
  `parent_position_id` chain and keeping ancestors whose rank is switched on
  for that project's ladder (CLAUDE.md rule 8). "SCM Head" is one of the
  **synthetic, non-HCM roles** (`platform/rbac/profiles.py:460`, "SCM Head,
  Indent Team, Logistics, Director..."), wired into a ladder via
  `ApprovalPost`/`rbac_role_id` (Settings > Approvals Config), not via the
  raiser's reporting line.

  If the TRANSPORT_REQUEST ladder for the project in question was never
  configured to include an SCM Head rung — or SCM Head sits outside that
  particular raiser's resolved chain — having the `transport.approve`
  **permission** is exactly what makes the button visible while the engine
  still, correctly, refuses the action. That reads to a user as "I have
  permission, so why am I refused" even though permission and ladder
  membership are orthogonal.

**Before writing code:**
1. Check Settings > Approvals Config for the project the failing shipment
   belongs to — is SCM Head actually added to the TRANSPORT_REQUEST ladder?
   If not, this is a configuration gap, not a defect, and the fix is adding
   the rung, not changing code.
2. If SCM Head **is** configured and still refused, the next thing to check
   is whether `wf_instances.resolved_chain` for that document actually
   contains an SCM Head entry (it's frozen at submit time per rule 8 — a
   ladder edited afterward never moves an in-flight document, so an SCM Head
   added to the ladder *after* this shipment was submitted would legitimately
   still refuse them). Re-submit a fresh shipment after confirming the ladder
   and see if it resolves.
3. Only if both of those check out and it still fails is there a genuine
   resolver bug to chase in `platform/workflow/ladder.py`/`resolver.py`.

---

### SCM_0065 — Overall Discount field: amount or percentage? 🟢
**Report:** Field doesn't say whether it's an amount or a percentage.

**Root cause:** `SupplierRFQDetailPage.tsx:749-754`:
```tsx
<Field label="Overall discount">
  <Input type="number" min="0" step="0.01" value={header.discount_amount} ...
```
It's bound to `discount_amount` — **always an amount**, never a percentage.
There's no ambiguity in the data model, only in the label.

**Fix:** Relabel to `"Overall discount (₹)"` or add helper text ("Enter a
flat amount, not a percentage") — one-line change, consistent with how
`Freight` right next to it (line 743) is already unambiguous because it's
obviously a currency field.

---

## Warehouse module

### SCM_0063 — Material Issue "Submit for Approval" shows error despite success 🟡
**Report:** Confirming Submit in the popup shows an error, but the issue is
approved and updated in the list anyway.

**Root cause hypothesis:** The confirm modal and the mutation are **shared
across five different actions** (submit/approve/reject/post/ack/cancel) on
one `act` mutation object (`MaterialIssueForm.tsx:989-1018`), and the modal
reads `error={act.error}` directly off that shared object
(`MaterialIssueForm.tsx:1909`). `act.error` is **not reset** when a different
action's confirm dialog is opened (no `act.reset()` call found anywhere
before `setConfirming(...)`). So the most likely sequence:
1. An earlier action on this document (or a double-click/race on Submit
   itself) fails and sets `act.error`.
2. The user tries Submit again (or the retried request actually succeeds on
   the backend — `submit_issue`, `backend/app/modules/warehouse/service.py:10991-11043`,
   is a single atomic commit-then-return with nothing risky after the
   commit).
3. If the *first* of two near-simultaneous calls already errored and the
   second succeeded, React Query can still be holding the stale `error` from
   the first on `act.error`, which the modal keeps displaying even though the
   state change the user is now looking at in the list is from the call that
   succeeded.

**Fix plan:**
1. Call `act.reset()` whenever a new confirm dialog is opened
   (`setConfirming("submit")` etc.), so a stale error from a previous action
   never bleeds into the next one's dialog.
2. Reproduce once with network tab open to confirm whether there are two
   overlapping requests (e.g. the button isn't disabled fast enough and a
   double-click fires `act.mutate("submit")` twice) — if so, also disable the
   Submit button the instant it's pressed (`act.isPending` already exists;
   confirm it's actually wired to `disabled` on the Confirm button inside the
   modal, not only on the trigger button).
3. This is the same class of issue as SCM_0059 (a UI showing a stale/generic
   error after a write that actually succeeded) — worth fixing both with the
   same discipline: never let an error state outlive the request that set it.

---

## Supplier Portal

### SCM_0062 — Entering a GST value causes an error 🔴 (needs reproduction)
**Report:** Entering a GST value in the Supplier Portal results in an error.

**Important finding first:** the GSTIN on the supplier's own **profile**
(`SupplierProfilePage.tsx`) is **read-only by design** — there's no input to
type into:
```tsx
/** Read-only. The vendor master belongs to procurement — a supplier correcting
 *  their own GSTIN would silently change what every past PO was raised against. */
```
So this report is almost certainly about the **per-line GST rate field on a
quotation**, `SupplierRFQDetailPage.tsx:690-697` (`gst_rate`, mapped to
`tax_percent` on submit), not the vendor's GSTIN.

**What the code does there (working as designed):**
- Each line shows a ceiling (`line.max_gst`, from the item's HSN code) and a
  hint "Up to X%" (line 689).
- On submit, `_checked_gst_percent`
  (`backend/app/modules/procurement/service.py:5035-5050`) refuses any rate
  **above** the HSN-notified ceiling:
  ```python
  raise ValidationError(f"{label}: GST may not exceed {allowed}% — the rate
  notified for HSN {limits['hsn_code']}. Quote at or below it.")
  ```
  This is intentional, named behaviour — not a bug — if that's the message
  the tester saw.

**Needs reproduction before coding:** capture the exact error text and the
GST value typed. Two branches:
1. If the message is the `_checked_gst_percent` ceiling message above → not a
   defect, but possibly a UX gap (the ceiling hint at line 689 may not be
   prominent enough, or the vendor's OTP step
   (`quote_otp.verify`, `service.py:5072`) may be failing first and getting
   misread as a GST error because it happens in the same submit flow).
2. If the message is something else entirely (a raw 500, a NaN, a field-name
   mismatch) → re-open this with the actual error text; the field mapping
   itself (`gst_rate` ↔ `tax_percent` ↔ `max_gst` ↔ `max_gst_rate`) was
   checked line-by-line and is consistent, so a fresh repro is needed to find
   where it actually breaks.

---

## Suggested sequencing

1. **Quick, independently-shippable UI fixes** (no backend risk):
   SCM_0060 (label), SCM_0065 (label), SCM_0055 (permission gate),
   SCM_0057 (add Freeze button), SCM_0061 (tooltip).
2. **Print template rework** (one screen, two tickets): SCM_0052 + SCM_0053
   together on `GatePassPrintPage.tsx` / `gatePassFields.ts` — confirm with
   the business what the single "Tracking/Reference Number" field should be
   backed by before touching the backend.
3. **Filter/column additions** (same shape, two screens): SCM_0051 + SCM_0054
   (indent type), plus the Fulfilment Desk cycle-number relabel.
4. **Needs a live repro session** before coding: SCM_0059, SCM_0063 (likely
   related — "error shown after a write that actually succeeded" pattern),
   SCM_0062, SCM_0064 (config check first), SCM_0058 (needs a product
   decision, not just a repro).
