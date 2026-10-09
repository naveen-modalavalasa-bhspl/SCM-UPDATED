# Indent module — functional sweep

Everything the Indent module does, driven through the real UI in a real browser,
by **one login**. One command replaces a manual pass over the module.

```powershell
cd playwright-tests
npm run test:indents            # headless
npm run test:indents:headed     # watch it click (set SLOW_MO=400 in .env)
```

Both servers must be up (backend `:8000`, frontend `:5173`) and `users.json` must
hold one account under `tester` (falling back to `raiser`). Nothing else is
needed — no approver pool, no ladder. See the main [README](../../README.md).

## How it decides whether something is right

A filter test that says *"click Urgent, the list changed"* passes when the list
changes to the wrong thing. Every filter here is checked three ways instead:

1. **State** — the control wrote the right query into the URL (or, on Overview,
   into the request it fired).
2. **Rendering** — the rows on screen are exactly what the API returns for that
   query, asked independently as the same account, compared row for row and in
   order.
3. **Predicate** — the rows actually satisfy the filter, checked locally. A
   Draft-filtered list is inspected for non-drafts; an Urgent filter is checked
   against the run's own urgent and normal drafts, by name.

The URL-to-API translations live in [`support/oracle.ts`](support/oracle.ts) and
are written out by hand rather than imported from the app, so a change to the
app's query building shows up here as a failure instead of being silently agreed
with.

Nothing waits on the clock. Every action is followed by *the app's query state
accepted it* and *the `aria-busy` flag cleared*, which are facts, rather than by a
timeout, which is a guess.

## The data it stands on

The run raises its own spread first (`support/dataset.ts`), because on a thin
database whole controls go silently unverified — an earlier version of this suite
reported *"the list holds 1 indent, paging could not be exercised"* and still went
green.

| Axis | Spread | What it lets a filter prove |
| --- | --- | --- |
| count | `SEED_COUNT` (24), above the page size | Page 2 exists and holds different rows |
| priority | every 4th URGENT | Priority both keeps and drops rows |
| required by | today / +5 days / +40 days | Today, Next 7 and Next 30 each cut differently |
| quantity | all different | A line reads back as itself |
| item | rotates over three catalogue items | Rows are distinguishable |

Everything seeded is a DRAFT owned by the testing account and is deleted in
teardown, which runs on a red run too. Nothing is ever submitted: a submitted
indent cannot be deleted and would park itself in a real person's queue.

## What each file sweeps

| File | Screen | Sweep |
| --- | --- | --- |
| `01-overview.spec.ts` | Overview | Eight KPI tiles, donut total, legend counts and the Recent Indents card, all against `/api/indents/stats` and `/api/indents`. Search on all four fields the list actually searches, plus a no-match. Raised date (Today / This week / This month / custom / backwards-range refusal). Required by (Today / Next 7 / Next 30). Status, priority, combinations, chips, Clear all. A recent row opens its indent; *View all* goes to All requests. |
| `02-all-requests.spec.ts` | All requests → indent → journey | Columns, first page, pager totals. The same filter sweep, plus multi-select status, and URL state: reload, share the link, junk values dropped. Real pagination — page 1 and 2 disjoint, Previous/Next disabled at the ends, deep links, out-of-range page clamped. Then an indent: heading, status, line items and quantities against the API, the seven-phase status bar and its states, the complete journey against `/api/indents/{id}/journey`, and the way back with the filter intact. |
| `03-new-indent-and-draft.spec.ts` | New request → draft | Every control and every rule the form claims: disabled Create and quantity, the un-removable last line, read-only *Raised as* and delivery location, item search and no-match, UOM on the quantity field, add/remove lines, the duplicate-item block, mandatory and past required date, missing and zero quantity, priority, remarks, Choose BOM, and Cancel creating nothing. Then create → read back → edit → delete, including dismissing the delete confirmation and proving the deleted draft is gone from both the API and the list. |
| `04-acknowledgements.spec.ts` | Acknowledgements | Search, status and *Ready to confirm* against `/api/warehouse/acknowledgements/mine`; row summaries, and the Confirm button present exactly where `can_acknowledge` says. The modal's arithmetic line by line; *Arrived now* capped at what was sent but not yet received, and disabled where nothing is waiting. Photo and bill upload and removal, verified on the server. The photo rule proved by letting the server refuse a confirm with no photo — and by checking nothing was written. |
| `05-activity-ledger.spec.ts` | Activity ledger | Seven columns, rows against `/api/indents/activity`, every seeded draft present as a *Request created* event. Search by indent, event, department and actor. Activity-date presets and custom ranges. The Event filter, including that it takes one value at a time. Pagination, URL state, and the row that opens an indent and returns with its filter. |
| `06-alerts-and-notifications.spec.ts` | Alert & Notification | Controls present and absent (no priority, no required-by, no *New indent*). Alerts and their messages against `/api/indents/notifications`. Search, notification date, status — including that two statuses widen rather than narrow, and that a Draft filter returns nothing because drafts raise no alert. Pagination, URL state, and the alert that opens its indent. |

Acknowledgments is deliberately out of scope and is never visited.

## What it will not do to your data

- It never submits an indent, so nothing lands in anyone's approval queue.
- It never approves or rejects. The ladder journey lives in
  `tests/indent-approval-flow/`.
- It never confirms a delivery unless you ask. Confirming writes received
  quantities and can close a real indent, and cannot be undone. Set
  `ALLOW_DELIVERY_CONFIRM=true` in `.env` to include it; without it the run still
  covers the modal, the arithmetic, attachments and the photo rule.

## When the data cannot answer

Acknowledgements and Alert & Notification cannot be seeded by one account — a
delivery needs someone else to approve, allocate and dispatch it, and an alert
only exists for an indent past DRAFT. When the account has none, the run records
a finding naming exactly which paths were **not** exercised, rather than passing
quietly. An empty screen is a fact about the data; it is never evidence the screen
works.

## Reading the result

Each run writes `reports/run-<timestamp>/summary.md`:

- **Result** — pass/fail per scenario, and the total checks passed and failed.
- **What the run did** — every named step, in order, with timings.
- **Every check, by scenario** — the full roster, passed and failed. This is what
  answers *"what was actually covered"*, which a list of failures alone cannot.
- **Findings** — failed checks with their detail, observations, JavaScript errors,
  console errors and warnings, failed API calls, slow responses and screens, and
  accessibility violations.
- `screens/` — a numbered full-page screenshot of every step, in order.

One broken control does not hide the rest: checks record and the run carries on,
then the scenario fails once at the end with everything that broke listed
together.
