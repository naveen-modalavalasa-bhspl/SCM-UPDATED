# SCM ERP v1.11 — Change Log

**Released:** 2026-08-29 · **Branch:** `qa` · **Head:** `a030c63` · **Migration head:** `0d4e5f6a7b8c`

Everything since v1.10 (2026-08-26). Two new things — outside systems can now talk to
SCM — and six fixes found while testing a real delivery that travelled through an MDP.

---

## New: outside systems can push into SCM

### 1. B-CAMS can read our data and report what the field used

B-CAMS (the clinic app) now has its own API. It reads 14 things from SCM — items,
categories, UOM, warehouses, batches, stock balance, material issues and their lines,
user-warehouse mapping, users, indents and their lines, vehicles, serial numbers — and
it can write back five kinds of report.

Two of those five actually move stock. When a LIP or MDP reports **consumption** or
**wastage**, SCM deducts it from that point's stock and writes a stock ledger row with
transaction type `CONSUMPTION` or `WASTAGE`. So the field's usage now shows up in SCM
without anyone typing it in. The other three (issue acknowledgement, field stock
balance, stock transfer) are recorded and queued, not yet applied.

Every write is signed. If one line in a batch cannot be posted — unknown item code, no
warehouse named, not enough stock — that line is refused **by name** and the rest of
the batch still goes through. Sending the same report twice changes nothing.

### 2. HCM can push employee changes instead of waiting for a sync

HCM can now POST to SCM the moment something changes: a new joiner, an updated
employee, a deactivation, a position change or an office change. The mirror updates
immediately rather than at the next scheduled sync.

It is locked down four ways: an API key says who is calling, a signature proves the
message was not altered, a timestamp older than 5 minutes is refused, and every push
carries a sequence number so a missed or out-of-order message is caught instead of
silently applied. Retrying is always safe — a repeat is answered "duplicate".

There is a **Settings → Integrations** screen to register an application, issue and
revoke keys, and read the connection instructions for whoever is sending.

---

## Fixed

### 3. A delivery that stops at an MDP no longer says it went to the LIP

**What you saw.** Stock goes Warehouse → MDP → LIP. The first leg's shipment showed the
LIP as its destination, even though the lorry was driving to the MDP.

**Why.** The shipment took its destination from the **indent** — which always names the
point that raised the request — instead of from the consignment it was carrying. On a
direct Warehouse → LIP run those are the same place, so nobody noticed. On a relay they
are not. The value is saved once when the shipment is created, so the wrong destination
stuck for the life of the document.

**Now.** Each leg takes the destination off its own consignment. Leg 1 says MDP, leg 2
says LIP.

The indent itself was never wrongly closed — that check was already comparing the right
things. Only the display was wrong. **Shipments created before this keep their old
value**; it is saved data, not something the screen recalculates.

### 4. You can only acknowledge deliveries that are coming to you

**What you saw.** The SCM head was shown deliveries arriving at points he is nowhere
near, and could sign for them. A store keeper saw consignments his own dock had *sent
out* rather than ones arriving.

**Why.** The Acknowledge Delivery queue was filtering on the **sending** warehouse.

**Now.** It filters on the **receiving** warehouse, against the points you are actually
attached to. Reading a document company-wide is a reporting question; signing for a
lorry means standing where it stopped. In testing this took the SCM head's queue from
54 down to 0, and a real MDP receiver's to the 2 genuinely addressed to him.

This also fixed a quiet truncation: the screen used to fetch 100 rows and filter them
in the browser, so past 100 consignments a real inbound delivery could drop off the
list.

### 5. One carton no longer shows as ten rows

**What you saw.** A single package holding 10 of one item appeared as 10 separate rows
of "1 NOS", with 10 boxes to type into.

**Why.** Serial-tracked items are stored one line per unit. True, but not what anyone
counts when they open a box.

**Now.** Lines are grouped by item and batch — one row, "10 NOS". Type the count once
and it spreads across the units underneath. A **"Count each serial"** link switches to
the old per-unit view, which you need when something is short: a grouped row tells you
how many are missing but not *which* serial.

### 6. The Activity ledger filter now offers every event

**What you saw.** The Event filter had 7 options while the EVENT column showed 13. You
could see a rejected or returned request in the list but could not filter to it.

**Now.** The filter is built from the same list the ledger uses, so all 13 are there —
including rejected, returned, auto-routed, procurement-created and the two bookmark
events. Anything added in future appears automatically.

Also on these screens: the **Region** filter is now labelled **Department** on
Dashboard, All Requests and Reports; the REGION column has been removed from the
Activity ledger (the Department column already shows the office underneath); and Recent
Indents on the dashboard shows 7 rows instead of 5.

### 7. The webhook instructions dialog scrolls

**What you saw.** "How HCM pushes to SCM" was cut off partway down the example, with no
way to scroll to the rest.

**Why.** It was using a component built for scrolling wide tables sideways, so there
was no up-and-down scrolling at all.

**Now.** It scrolls properly.

### 8. Two HCM sync problems

- **A short reply from HCM is no longer read as "everybody left."** If HCM returned
  fewer records than expected, the sync could treat the missing ones as deleted.
- **A re-keyed project no longer takes its documents down with it.** When HCM gives an
  existing project a new id, the old row used to be switched off automatically — and it
  was still the row that every indent, stock balance, workflow and job profile pointed
  at, so a whole project could disappear from every screen at once with no way to bring
  it back. The old row is now only retired when **nothing** points at it; otherwise it
  stays visible and the problem is logged loudly.

---

## For whoever deploys this

- **Run `alembic upgrade head`** — the migration head is `0d4e5f6a7b8c`.
- **B-CAMS needs two secrets that do not travel with the code**: an API key and a shared
  signing secret. Both are generated in Settings → Integrations and each is shown once.
  Without them every B-CAMS write is refused.
- **Check Approvals Config and Job Profiles after the first HCM sync** on a new
  database. The approval rungs are HCM role ids, and a different HCM instance uses
  different ids.

## Known, not fixed in this release

- The Department filter on the indent screens is a **label change only** — it still
  filters by region behind the scenes.
- 30 tests in the indent UI test file were already failing before this release. They are
  unrelated to the work above and are still failing.
