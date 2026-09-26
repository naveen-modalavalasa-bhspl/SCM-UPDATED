# Quotation lifecycle — re-scoped registers, a Comparison Studio, amendments, quote chat, and the RFQ price lock

Status: **PLAN — not yet implemented.** Covers five business asks that land together
because they are one lifecycle: quote → compare → (optionally) negotiate → PO.
Written against the tree as of 2026-09-26. Read
`docs/04_SCM_BUSINESS_FLOW.md` (§ tender) before treating any name here as final.

## 0. The one-paragraph story

Today the RFQs page and the Quotations page both leak each other's job: the RFQ page
carries the supplier comparison and the award, and the Quotations register is a flat
cross-RFQ price list. This work splits the lifecycle into three rooms —

- **RFQs** — the tender room: what we asked, who we asked, what came back in counts.
- **Quotations** — the reading room: one supplier's priced answer, on its own paper.
- **Price Compare** (new tab) — the war room: every answer side by side, rank, award.

and then closes the loop the chain never had: a buyer who wants a better price asks
for it on the quotation itself (**amend → supplier accepts or declines → quote
re-prices**, exactly the machinery the PO amendment already has), negotiates in a
per-supplier thread beside the paper, and **locks the tender** before any PO can be
raised off it — after which prices are arithmetic, not opinions.

Naming, deliberately plain and user-brained: a buyer *sends a Change Request*, the
supplier *Accepts* or *Declines* it, the numbers that changed are a *Price Trail*, and
the lock is *Freeze Prices* — freeze reads faster on a button than "RFQ price lock",
and unfreezing is *Reopen Bidding*, which says what it hands back rather than what it
does to the row.

---

## 1. Where the work sits in the existing chain

```
Requisition → Consolidation → RFQ (PUBLISHED) → [quotes arrive]
    → (optional) Quote Change Request ⇄ supplier          ← NEW
    → Freeze Prices (rfq.is_price_frozen)                 ← NEW
    → Compare & award (moves to Price Compare tab)        ← MOVED
    → PO from quotation  ← gated on frozen + accepted     ← NEW GATE
```

Existing furniture this reuses, and must not duplicate:

- `platform/workflow` — untouched. A quote amendment is a contract negotiation with
  one counterparty, not a ladder.
- `amend_po` / `PORevision` / `_revert_rejected_amendment` / vendor
  accept-decline + `notifications.notify` — the **template** for quote amendments.
- `POComment` / `POApprovalChat` — the **template** for the quote thread.
- `_comparison_grid` / `comparison()` — the **only** comparison writer; the new tab
  renders it, nothing recomputes it.
- `create_po_from_quotation` — gains one guard, no new route.
- `vendor_submit_quotation` — already refuses non-PUBLISHED RFQs and past-due
  deadlines; the freeze rides this exact gate.

---

## 2. PART A — Re-scope the RFQs page (own the tender, not the answers)

**Problem.** `RFQDetailPage` fetches `rfqApi.comparison(...)` and embeds
`QuotationComparison` + award. A buyer opening an RFQ to check its deadline meets
every vendor's price — that is the `rfq.compare` permission leaking into a
`rfq.view` screen, and it makes the page unreadable once quotes arrive.

**Functional changes.**

1. `RFQDetailPage` drops the comparison and award from the RFQ view entirely. In
   their place, a **Quotes strip** (read from the RFQ detail payload, no new
   endpoint): one summary card per invited vendor — vendor name, response pill
   (Awaited / Quoted / Declined / Won), grand total **band** not price ("₹1.2–1.4 L
   band" when comparison is not permitted, exact figure when it is), submitted date,
   and a single affordance: **View quote →** to `/procurement/quotations/:id`.
2. A **"Compare & Award" hero button** on the RFQ detail header routes to
   `/procurement/compare?rfq=<id>` — comparison lives in the new tab only. Gated on
   `rfq.compare` (hidden, not disabled, when absent).
3. `RFQListPage` keeps its KPIs and filters but the columns become tender-shaped:
   `RFQ · Title`, `Vendors invited`, `Quotes in`, `Due`, `Status`, `Awarded to`
   (name only, `—` until award). No per-vendor pricing anywhere in the list.
4. Response counts must not lie: `response_count` is already written at submit;
   the strip's Declined state reads `Quotation.status == REJECTED` on that RFQ.

**UI aesthetics.** RFQ detail keeps its two-column card layout; the new strip is a
row of `Card`s in a `ResponsiveList` card band under a small "Supplier responses"
eyebrow. Each card: 44px-min vendor row, `StatusPill` for the response state, muted
monospace for numbers. Empty state: "No supplier responses yet — vendors see this
tender on their portal." (quiet instruction, not a dead panel).

---

## 3. PART B — Re-scope the Quotations page (one supplier's paper, one RFQ)

**Problem.** `QuotationListPage` lists every quote across every RFQ with grand
totals and ranks — a cross-tender price sheet, which is the comparison's job, and it
shows it to anyone holding `rfq.compare`-scoped rows without an RFQ in sight.

**Functional changes.**

1. **The register becomes an inbox of priced answers**, grouped by RFQ. New layout:
   - `PageHeader` "Quotations" with subtitle "Supplier offers against your tenders".
   - **RFQ switcher** at top: a `Select` of the caller's own RFQs that have at least
     one response (`?rfq=` in the URL, persisted via `useUrlFilters`), defaulting to
     the most recent. Supplier-portal callers (`/supplier/*` scope) skip the
     switcher — they always see their own quote for the RFQ they opened.
   - Below it, **one card per quotation against that RFQ**: supplier name +
     snapshot logo initial, quote no, submitted date, validity, status pill,
     grand total (respecting `rfq.compare` scoping server-side, unchanged), and
     per-line count. **No rank, no "best price" chips, no comparison table.**
   - Selecting a card (or `/procurement/quotations/:id`) opens the **Quotation
     Detail** view described in §6 — which is where the amendment and chat UI live.
2. `list_quotations` already takes `rfq_id`; the page simply always passes it. The
   old all-RFQs view stays reachable only via a "All quotes" footer link gated on
   `rfq.compare` (kept for auditors; flagged as an escape hatch in the UI copy).
3. Rank columns/chips are removed from this page's columns; `rank_position` remains
   in the schema and is rendered only inside Price Compare.

**UI aesthetics.** Cards on a soft `bg-surface-2/40`, supplier initial in a rounded
tile, money right-aligned in `font-mono`, status as `StatusPill`. The switcher row
carries the RFQ number, due date chip and a mini progress "3 of 5 suppliers
responded" bar — the reading room should answer "what came back on this tender"
before the first card. Empty state: "No supplier has quoted this RFQ yet."

---

## 4. PART C — The Comparison Studio (new tab, after Quotations)

**Naming.** Page: **Price Compare** (`pro_price_compare`). Route
`/procurement/compare` (+ `?rfq=`). Menu sort_order **28.5** — after Quotations
(28), before Suppliers. Icon `git-compare-arrows`. Permission code: **new
`rfq.compare` reuse is tempting but wrong for the page row** — the page's own view
code is `page.pro_price_compare.view` (via `P.page_view_code`), with
`INHERITS_GRANTS_FROM = page.pro_quotations.view`'s wider parent
(`page.pro_rfqs.view`) so existing desks land on it; the *data* inside stays
gated by `rfq.compare` exactly as today (KPI strip already does this).

**Functional changes.**

1. `comparison()` is untouched and remains the single writer of the sheet.
2. Page anatomy, top to bottom:
   - **RFQ selector** — a sticky `Select` of the caller's RFQs in
     `PUBLISHED`/`CLOSED`/`AWARDED` with ≥1 submitted quote; shows
     `RFQ-2026-27/0042 · Title · 4 quotes`. Selection writes `?rfq=`; deep links
     from RFQ detail land pre-selected.
   - **Verdict band** (only when ≥2 quotes): evaluation method chip (from
     `evaluation.method_of()`), suggested winner card (rank 1: vendor, grand total,
     score), and delta line "next best is ₹X (+3.2%)" — all SERVED by extending
     `comparison()`'s payload with `suggested` and `delta_to_next`; the screen
     never re-ranks. Award buttons stay per-column (the sheet never decides).
   - **The sheet** — `QuotationComparison` as-is, moved into this page unmodified:
     pinned item column, per-vendor cells with full breakup, best-price highlight,
     vendor chips windowing, split-award panel.
   - **Award panel** — the award flow (whole or split) moves here from
     `RFQDetailPage` unchanged in behaviour; on success it routes back to the RFQ
     detail with a toast "Awarded to {vendor} — raise the PO from the Quotation".
3. `RFQDetailPage`'s "Compare & Award" button links here (§2).
4. The retired embed keeps no stub: `RFQDetailPage` imports neither
   `QuotationComparison` nor `rfqApi.comparison` afterwards (a dangling import is
   how the old page half-alive bug class starts).

**UI aesthetics.** The selector bar is a full-width `Card` with the RFQ identity on
the left (mono number, title) and the verdict chips on the right, sticky under the
page header so the method and suggested winner stay visible while scrolling ten
vendor columns. Delta reads as "+3.2% vs best" in `text-warning` when >0, success
when 0. All money in `font-mono`; all verdict wording comes from the payload.

---

## 5. PART D — Quotation amendments (Change Request on a quote)

**Problem / ask.** After a supplier quotes, the buyer may want a better price or a
different quantity *before* award. Today the only lever is re-quote-until-deadline
by the supplier's own initiative, or nothing. This ports the PO amendment pattern —
snapshot → propose → counterparty decides → versions trail — onto quotations.

**Naming (user-brained, used in UI copy, API, and audit).**

- Buyer's proposal: **Change Request** (CR). Endpoint verbs: `propose`, `accept`,
  `decline`. Status words on screen: `Awaiting supplier`, `Accepted`, `Declined`,
  `Superseded`, `Withdrawn`.
- The trail of versions: **Price Trail** (what changed, version by version).
- Badge on a quote with an open CR: **"Under negotiation"**.

### 5.1 Schema (migration `q7a8b9c0d1e2`, one Alembic head)

```python
class QuoteChangeRequest(Base):
    """`pro_quote_change_requests` — the buyer's ask on a supplier's quotation.

    Modelled on PORevision's discipline: the quote as the supplier priced it is
    snapshotted BEFORE anything is proposed, so the Price Trail always has a
    version that still exists to diff against. Append-only; nothing deletes a row.
    """
    __tablename__ = "pro_quote_change_requests"
    id = pk()
    quotation_id = Column(ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    rfq_id = Column(ForeignKey("pro_rfqs.id"), index=True, nullable=False)
    cr_no = Column(String(30), unique=True, nullable=False)   # CR-2026-27/0001
    # DRAFT (buyer typing) → AWAITING_SUPPLIER → ACCEPTED | DECLINED | SUPERSEDED
    # | WITHDRAWN. SUPERSEDED: a newer CR on the same quote was accepted first.
    status = Column(String(30), nullable=False, index=True)
    reason = Column(Text, nullable=False)          # "Say why" — same rule as amend_po
    # The buyer's proposed lines: full replacement set, one entry per RFQ line the
    # buyer is touching. {quotation_item_id, item_id, proposed_quantity,
    # proposed_rate, proposed_discount_percent, note}
    proposed_lines = Column(JSON, nullable=False)
    # BEFORE proposing, the quote's own header+lines land here — the Price Trail's
    # "from" version. Same shape as _po_snapshot's output.
    snapshot_before = Column(JSON, nullable=False)
    proposed_by_id = soft_fk(); proposed_by_name = snapshot
    supplier_decision_note = Column(Text, nullable=True)
    supplier_decided_at = Column(DateTime, nullable=True)
    created_at = created_at_col(); updated_at = updated_at_col()
```

Plus on `pro_quotations`: `under_negotiation` (bool, default false) — the badge is
a column, not a `status` value, so every existing `QuotationStatus` filter, KPI and
report keeps its meaning; and `accepted_revision` (int, default 0) — how many CRs
the supplier has accepted, so "v2 pricing" is a number, not archaeology.

Snapshot reuses `_po_snapshot`'s shape via a new `_quote_snapshot(quote)` beside it
in `service.py` — **never a second serializer in a screen**.

### 5.2 Service functions (all in `procurement/service.py`; router stays 3–5 lines)

- `propose_quote_change(db, quotation_id, data, user)` — gates: quote
  `SUBMITTED`/`REVISED`; RFQ `PUBLISHED` and **not frozen** (§7); quote not already
  carrying a `AWAITING_SUPPLIER` CR (one open CR per quote — two parallel asks on
  one price is how contracts get two truths); reason required; at least one
  proposed line; proposed quantities ≥ 0 and rates ≥ 0 (0 quantity = drop the line
  from the ask); **proposed totals re-derived through `_quote_totals`** so the CR
  states totals the same arithmetic the quote does. Writes `snapshot_before`,
  sets `quotation.under_negotiation = True`, notifies the vendor account
  (`notifications.notify`, entity `QUOTATION`, deep link `/supplier/rfqs/:id`).
  Buyer may `WITHDRAW` an awaiting CR (`withdraw_quote_change`).
- `accept_quote_change(db, quotation_id, cr_id, vendor_id, note)` — vendor-side.
  Re-validates **against the live quote**: RFQ still PUBLISHED and not frozen;
  CR still `AWAITING_SUPPLIER`. On accept: file a `QuoteRevision`-style trail row
  (below), apply `proposed_lines` to the quotation (recompute line `amount`s and
  header totals through `_quote_totals`), `revision_count += 1`,
  `status = REVISED`, `under_negotiation = False`, `accepted_revision += 1`,
  mark other open CRs `SUPERSEDED`, notify the buyer. This is the PO
  accept-revision path, ported line for line.
- `decline_quote_change(db, quotation_id, cr_id, vendor_id, note)` — mirrors
  `_revert_rejected_amendment`'s philosophy: **nothing to revert** (the quote was
  never rewritten — the CR carries the "before" snapshot), so decline only files
  the decision, clears `under_negotiation`, and notifies the buyer with the
  supplier's note. Cheaper than the PO case precisely because we never pre-applied.
- `quote_change_requests(db, quotation_id, user)` and
  `vendor_quote_change_requests(db, vendor_id, rfq_id)` — the Price Trail readers.
- `quote_price_trail(db, quotation_id)` — walks quote snapshots + CRs and returns
  version rows: `{version, effective_at, source: ORIGINAL|REQUOTE|CHANGE_REQUEST,
  totals, lines, changed_by}` — **one function, one answer**, consumed by both
  tabs and the vendor portal so two readers can never disagree.

### 5.3 Router additions (all under existing prefixes; supplier under `/api/supplier`)

```
POST   /api/rfqs/quotations/{id}/change-requests          buyer propose   rfq.edit
GET    /api/rfqs/quotations/{id}/change-requests          buyer list      rfq.view
POST   /api/rfqs/quotations/{id}/change-requests/{cr}/withdraw   buyer   rfq.edit
GET    /api/rfqs/quotations/{id}/price-trail              both            rfq.view
POST   /api/supplier/rfqs/{rfq}/quotation/change-requests/{cr}/accept   supplier
POST   /api/supplier/rfqs/{rfq}/quotation/change-requests/{cr}/decline  supplier
GET    /api/supplier/rfqs/{rfq}/quotation/change-requests supplier scope
```

Every route: `require_permission(...)` (rule 6), vendor identity from the token,
`entity_type` stated on any attachment route (rule 4).

### 5.4 Frontend

**Buyer — on Quotation Detail (§3's drill-in).** A **"Request change"** button
(gated `rfq.edit`) opens a `QuoteChangeRequestModal`: lines prefilled with the
supplier's own numbers, editable qty/rate/discount with inline delta chips
(`−₹1,200` green when the buyer's ask is cheaper), reason textarea, and a live
"New total" strip that recomputes on the client but states it is a preview — the
server's `_quote_totals` is the truth. Submitting flips the quote card to an
**Under negotiation** amber `StatusPill` with "Change request CR-2026-27/0007 —
awaiting supplier".

**Buyer — Price Trail.** A timeline component `QuotePriceTrail` on the quote
detail: one entry per version, each a two-column diff — struck-through old value →
new value in green/red, deltas right-aligned; totals row at the bottom with the
same treatment. Served by `quote_price_trail`; the screen formats, never computes.

**Supplier — portal.** On their quotation view: an amber **"The buyer has proposed
changes"** banner with qty/rate deltas and a note, and two buttons, **Accept
changes** / **Decline** (optionally with a note). Accept/decline hit the supplier
routes; on accept the form re-renders with their new numbers and a "You accepted
CR-… on {date}" line. The banner names the buyer so the supplier knows who is
asking.

**UI aesthetics.** The CR modal is a two-pane sheet: left = the quote as sent
(read-only, muted), right = proposed (editable inputs, delta chips). The Price
Trail uses a vertical rail with version dots; current version's card is elevated
(`shadow-lg`), older ones collapsed to one-line summaries that expand on click.
All deltas green (down/cheaper for buyer) or red (up) — colour meaning stated once
in a legend, never assumed.

---

## 6. PART E — Quotation chat, unique to the supplier

**Problem / ask.** PO has `POComment`/`POApprovalChat`; quotations have nothing,
so price negotiation happens over WhatsApp where the audit can't see it. The
thread must be **per quotation** (which is per supplier per RFQ by construction —
`pro_quotations` is unique on (rfq_id, vendor_id) in practice via one quote per
vendor per RFQ), not per RFQ: comparing vendor A while chatting vendor B must not
mix threads.

**Schema.** `pro_quotation_comments` — copy of `POComment` with
`quotation_id = ForeignKey("pro_quotations.id", ondelete="CASCADE")`, same
`Index("ix_pro_quotation_comments_q_created", QuotationComment.quotation_id,
QuotationComment.created_at)`. No new ideas; a second idea here would be one.

**Service / router.** `quotation_comments(db, quotation_id, user)` +
`add_quotation_comment(db, quotation_id, message, user)` — the PO pair, ported;
append-only, author snapshot, no deletes (rule 9). Routes:

```
GET  /api/rfqs/quotations/{id}/comments    rfq.view
POST /api/rfqs/quotations/{id}/comments    rfq.edit
GET  /api/supplier/rfqs/{rfq}/quotation/comments    supplier scope
POST /api/supplier/rfqs/{rfq}/quotation/comments    supplier scope
```

Both buyer and supplier post to the same thread; `author_name` + a `side`
derivation (`is_buyer = author is not a vendor account`) lets the UI bubble left
or right. The supplier's thread is the same table — "unique to that supplier"
falls out of the quotation being the supplier's, not from a per-supplier table.

**Frontend.** `QuotationChat` — `POApprovalChat` restyled: same gradient card,
poll 15s, same composer; bubbles carry the author's name and buyer/supplier tint.
Lives on the buyer's Quotation Detail and the supplier's portal quote view. Header
copy: "Price discussion · with {vendor_name} · stays with this quotation".

---

## 7. PART F — Freeze Prices (RFQ lock) before POs

**Problem / ask.** Prices must not move while buyers compare, and no PO may be
raised against an unfrozen RFQ. One boolean carries the whole rule; the gates hang
off the doors that already exist.

**Schema (same migration).** On `pro_rfqs`:

```python
is_price_frozen = Column(Boolean, nullable=False, default=False, server_default="0")
frozen_at = Column(DateTime, nullable=True)
frozen_by_id = soft_fk(); frozen_by_name = snapshot
frozen_at_revision = Column(Integer, nullable=True)  # quotes-in count at freeze
```

`frozen_at_revision` is what makes "you froze at 4 quotes, there are 5 now" a
checkable sentence instead of a memory.

**The five gates (fail LOUD, name the door).**

1. **Supplier quote submit / re-quote** (`vendor_submit_quotation`): if
   `rfq.is_price_frozen` → refuse: "This RFQ is closed for pricing — prices are
   frozen for comparison. Contact the buyer." (The existing PUBLISHED +
   deadline guards stay; freeze is the third lock, and the freeze button itself
   is what a buyer presses instead of waiting for the deadline.)
2. **Supplier CR accept** (§5.2): same refusal — a frozen RFQ cannot re-price,
   accept included.
3. **Buyer CR propose** (§5.2): also refused on a frozen RFQ — negotiation ends at
   freeze; the way to change a price afterwards is a new RFQ or award-and-amend
   the PO (which has its own machinery).
4. **PO from quotation** (`create_po_from_quotation`): refuse unless
   `rfq.is_price_frozen` AND quote `status in (SUBMITTED, REVISED)` AND no open
   (AWAITING_SUPPLIER) CR on the quote. Message names all three: "Freeze prices
   on RFQ-… first — POs can only be raised from a frozen comparison."
   Split awards / multiple POs per RFQ: every PO's source quote must be frozen
   AND CR-clean; the guard is per quotation, so per-PO is automatic.
5. **Award** (`award_rfq`): allowed only when frozen. You compare frozen prices
   and you award from the same sheet — awarding from unfrozen prices is comparing
   a moving target. `close_rfq`/`cancel_rfq` clear nothing (freeze is history,
   audit-first); unfreeze sets the columns false/None and writes one audit line
   via `write_audit`.

**Endpoints.**

```
POST /api/rfqs/{id}/freeze      rfq.approve   (body: {note?})
POST /api/rfqs/{id}/unfreeze    rfq.approve   (body: {reason} — required)
```

Both idempotent-hostile (freeze on frozen → a friendly "already frozen" 409-style
`AppException`), both audited, both notify the buyer desk.

**Frontend.**

- RFQ detail header gains a **Freeze Prices** button (`rfq.approve`), with a
  confirm dialog that states the consequence plainly: "Suppliers can no longer
  quote, re-quote or change prices on this RFQ. POs can now be raised against
  its quotations." After freeze, the button becomes a **Frozen 🔒** state chip +
  **Reopen bidding** (unfreeze, reason-prompted).
- RFQ list rows show a small lock glyph when frozen.
- Price Compare shows a "Prices frozen {date} · {by}" chip in the verdict band —
  the sheet states whether it is comparing a moving target.
- PO form-from-quotation: the disabled Raise PO button's helper text names the
  freeze (never a bare disabled button).

**UI aesthetics.** Frozen = deep-amber lock chip with the freeze date; the freeze
confirm modal lists what freezes (quotes, re-quotes, CRs) and what unlocks (POs,
award). A "why can't I" message from any gate always names the next action for
the person reading it — buyer sees "Reopen bidding", supplier sees "contact the
buyer".

---

## 8. Sequence & file map

| # | Work | Files |
|---|------|-------|
| 1 | Schema + migration | `procurement/models.py`, `alembic/versions/q7a8b9c0d1e2_quote_lifecycle.py` |
| 2 | Freeze + CR + trail + comments service | `procurement/service.py`, `schemas.py` |
| 3 | Routes (buyer + supplier) | `procurement/router.py` |
| 4 | PO gate + award gate | `procurement/service.py` (`create_po_from_quotation`, `award_rfq`) |
| 5 | RFQ page re-scope | `frontend/.../pages/RFQDetailPage.tsx`, `RFQListPage.tsx` |
| 6 | Quotations page re-scope + detail | `frontend/.../pages/QuotationListPage.tsx`, new `QuotationDetailPage.tsx`, `types.ts`, `api.ts` |
| 7 | Price Compare tab | new `pages/PriceComparePage.tsx`, `page_registry.py` (`pro_price_compare`, sort 28.5), `App.tsx` route, `QuotationComparison.tsx` moved in |
| 8 | CR modal + Price Trail + chat | new `components/QuoteChangeRequestModal.tsx`, `QuotePriceTrail.tsx`, `QuotationChat.tsx`; portal equivalents under `modules/supplier` |
| 9 | Seed/menu + tests | `scripts/seed.py` (PAGE_TREE row), `page_registry.PAGE_VIEW_CODES`, `procurement/tests/` (CR accept/decline/freeze gates/chat), `masters` untouched |

Migration note: new tables/columns only, all additive — `create_all` databases get
them from the models, Alembic databases from `q7a8b9c0d1e2`; no backfill is needed
(the flags default false and the trail starts empty), which is why this is one
revision and not two.

## 9. Tests (backend `procurement/tests/`, Vitest frontend)

- Freeze gates: submit-while-frozen refused; PO-from-quote before freeze refused,
  after freeze allowed; award before freeze refused; unfreeze then re-quote works.
- CR lifecycle: propose → totals re-derived (assert against `_quote_totals`),
  accept applies lines + bumps `revision_count`, second CR superseded, decline
  preserves the quote byte-for-byte, withdraw clears `under_negotiation`.
- Chat: append-only, buyer and supplier see the same thread, no cross-quotation
  leakage.
- Page anatomy: RFQ detail renders no comparison; Price Compare is the only
  consumer of `comparison()` (a grep test in the frontend suite, matching the
  house style of structural tests).

## 10. Out of scope, deliberately

- No workflow ladder on quotations (negotiation is two-party, not a chain).
- No PO amendment changes — that machinery is the template, not the target.
- No auto-freeze on deadline (a buyer may want to compare unfrozen in a
  pinch-frozen world? no — auto-freeze is tempting but hides the decision from
  the person accountable; the deadline already stops quoting, freeze stops
  *pricing*).
