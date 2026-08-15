 # SCM → B-CAMS API

Answer to `SCM_ASK.md` (13-Aug-2026, incl. the Q6/Q6b/Q6c revision).
Implemented in `app/modules/integrations/cams/`.
No new tables, no schema change, no edits outside this module.

**Base URL:** `https://<scm-host>/api/ext/v1/cams`
**Auth:** `X-API-Key: <key>` on every call. Issue the key in SCM under
Settings → APIs → register an application (code `CAMS`) → Keys → Issue. The raw key is
shown once. Leave the key's scopes empty, or set the single scope `cams`.

Wire-up check: `GET /_ping` → `{"ok":true,"client":"CAMS","integration":"cams"}`.

---

## 1. Read endpoints (14 of 14)

| # | Endpoint | Filters (all optional) |
|---|---|---|
| 1 | `GET /items` | `item_type`, `is_active`, `updated_since` |
| 2 | `GET /item-categories` | `is_active`, `parent_id` |
| 3 | `GET /uom` | `is_active` |
| 4 | `GET /warehouses` | `is_active`, `tier` |
| 5 | `GET /batches` | `item_id`, `updated_since` |
| 6 | `GET /stock-balance` | `warehouse_id`, `item_id`, `updated_since` |
| 7 | `GET /material-issues` | `destination_warehouse_id`, `warehouse_id`, `status`, `updated_since` |
| 8 | `GET /material-issue-items` | `issue_id` |
| 9 | `GET /user-warehouses` | `warehouse_id`, `is_active` |
| 10 | `GET /users` | `is_active`, `employee_code` |
| 11 | `GET /indents` | `warehouse_id`, `status`, `updated_since` |
| 12 | `GET /indent-items` | `indent_id` |
| 13 | `GET /vehicles` | `warehouse_id` |
| 14 | `GET /serial-numbers` | `consumable_code`, `item_id`, `warehouse_id` |

Every id filter also takes a list: `?item_id=1042,1043`. `status` and `item_type` are
matched case-insensitively and also take a list.

Paging on every endpoint: `?page=1&page_size=500` (`size` works too). Ceiling 2000.

```json
{"items":[…], "total":1234, "page":1, "page_size":500, "size":500}
```

`total` is the full unpaged count. Every feed is ordered by its own primary key, so a
row can never appear on two pages.

---

## 2. Answers to §6

| Q | Answer |
|---|---|
| Q1 `warehouse.tier` | **Yes.** `WH` / `MDP` / `LIP`, derived from `whs_warehouses.warehouse_type`, which already carries those values. Also filterable: `?tier=LIP`. Stop inferring it. |
| Q2 `warehouse.hcm_office_id` | **Yes.** Plus `hcm_facility_id`, and `city`/`state` resolved from that office. |
| Q3 `updated_since` | **Where the table has a change column** — items, stock-balance, material-issues, indents, batches, serial-numbers. `mst_uom` and `mst_item_categories` carry no timestamp: the parameter is accepted and ignored there, so a delta pull returns those (small) masters whole rather than empty. Format `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`. Timestamps are **IST wall clock, naive** — an offset you send is dropped, not converted. |
| Q4 stable ids | **Confirmed.** Ids are MySQL auto-increment primary keys and are never re-issued; retirement is `is_active=false`. |
| Q5 users / user-warehouses | **Replaced, not dropped — and the two halves have different owners.** SCM has no `users` table: identity *is* the HCM employee. So `/users` is SCM's read-only HCM mirror (`hcm_employees`, filled by our HCM sync) — `id` is HCM's employee id, `employee_code` is HCM's `emp_code`, `user_type` is HCM's org role. **It is HCM's data, served for convenience.** If you want live person detail, call HCM directly and join on `employee_code`; nothing in this feed set depends on you using our copy. `/user-warehouses` is the opposite case — it is the **one thing HCM cannot answer**, because the employee → warehouse mapping is an SCM table (`inv_position_locations`), flattened through `hcm_position_assignments` to a person. It carries `user_id`, `employee_code`, `warehouse_id`, `position_id`, `is_default`, `is_active`, and is keyed on the **post**, not the person — an OE covering four MDPs gets four rows, which one-office-one-warehouse guessing would never give you. Live counts today: 1921 employees, 2002 person↔warehouse pairs across 956 LIPs. |
| Q6 `pack_size`, `pack_size_text`, `pack_volume_ml`, `tests_per_kit`, `shelf_life_days` | **All five are in the feed.** `pack_size` is the level-1 rung of the item's packing ladder (`mst_item_packaging`), in the item's own UOM. `shelf_life_days` was already on the item master (falling back to the item's spec row where the master's own value is 0 — that column is NOT NULL DEFAULT 0, so 0 means "never set"). The three kit-sheet fields come from `mst_item_specs.specifications`, the per-item JSON keyed by attribute code that the masters overhaul made the one tagging surface — no migration, and the item form carries them as ordinary category tags. **They are null until masters tags them**: the plumbing is done, populating the ~40 reagent rows from the CHS-104 sheet is a data job. Tag keys accepted (any case, spaces or underscores): `pack_size_text`, `pack_volume_ml`, `tests_per_kit` (also `tests_per_pack`, `volume_ml`). A value typed with its unit — `"160 ml"`, `"548 tests"` — is read as the number. |
| Q6b panel categories | **The feed is faithful, the restructure is a masters job.** `/item-categories` serves whatever `mst_item_categories` holds, now with `parent_name` and `level` so the shape of the tree is visible from your end, and `?parent_id=` to walk it. SCM has ~60 categories today and some of them are item names; collapsing them into the nine panel groups in your §2 table is a masters change on our side and is not something an integration endpoint can paper over. Flagged to the masters owner. |
| Q6c assets excluded | **Confirmed, and enforced by two gates in the query.** `/items` serves **only** items typed `Consumable` or `Reagent`, and separately excludes every `mst_items.is_asset` row. Both are needed: the live master also holds `ASSET`, `Acessories`, `material`, `ICLS-AST` and `TESTCLASS` in that column, and an item typed `ASSET` whose flag was never set would otherwise slip through. An analyser, centrifuge, printer or battery cannot reach this feed by any route, and `?item_type=asset` returns an empty page rather than assets. `item_type` goes out in exactly the two spellings you pinned, normalised from whatever case the column holds. |
| Q7 `base_uom_id`, `conversion_factor` | **Yes.** From `mst_uom_conversions`. A UOM with no conversion row is its own base at factor 1. |
| Q8 batch inline on stock-balance | **Confirmed.** `batch_number` and `expiry_date` are columns on `stk_balance` itself — no join, cannot go missing. `batch_id` is `null` (not `0`) when a row carries no batch. |
| Q9 `valuation_rate` | **Real column, largely zero today.** The live costing columns are 0 across most rows; the feed sends the real value rather than inventing one. Source rates from `items.purchase_price` (also in the feed) until costing is populated. |
| Q10 base URL / key / secret | Base URL above. Key: issued in the console, handed over out of band. HMAC secret: `POST /api/apis/cams/secret` mints it, shown once. |

### §3 behaviour rules

1. Response shape — as above. 2. `page`/`page_size` — supported, `total` unpaged.
3. `X-API-Key` — one key, all resources. 4. Performance — plain indexed SELECTs, one
COUNT + one page. 5. Errors — real status codes (`401` bad key, `403` out of scope,
`404` unknown path, `422` bad parameter, `429` rate limit), body `{"success":false,"error":"…"}`.
6. **`is_active` is fixed** — `true` returns active rows only; absent returns everything.
7. `item_type` — matched case-insensitively against `mst_items.item_type`; send
`?item_type=consumable,reagent` in ONE call and neither class can go missing.
8. Stable ids — see Q4. 9. Status vocabulary — below. 10. Clean text — every `name`
has newlines and tabs collapsed to single spaces before it goes out.
11. `updated_since` — see Q3. 12. `valuation_rate` — see Q9.

Quantities and rates are JSON **numbers**. Dates are `YYYY-MM-DD`; timestamps are ISO
without an offset (IST wall clock).

### §9 status vocabulary

`material_issue.status` (UPPER CASE): `DRAFT`, `PENDING_APPROVAL`, `APPROVED`,
`REJECTED`, `ISSUED`, `DISPATCHED`, `ACKNOWLEDGED`, `PARTIALLY_RETURNED`, `RETURNED`,
`CANCELLED`.

`indent.status` (UPPER CASE): `DRAFT`, `SUBMITTED`, `PENDING_APPROVAL`, `APPROVED`,
`REJECTED`, `AWAITING_ALLOCATION`, `ALLOCATED`, `PARTIALLY_FULFILLED`,
`PENDING_PROCUREMENT`, `PARTIALLY_ORDERED`, `ORDERED`, `CLOSED`, `CANCELLED`.

### Three things to know about the data, not the API

- **`item.category_id` can be null.** Your §2 marks it must-never-be-NULL. 69 of ~90
  live items predate the mandatory-category rule and hold NULLs there. The feed sends
  the real null rather than inventing a category; the fix is in the item master.
- **The kit-sheet fields are null until masters is tagged** — see Q6.

- **`/material-issues.destination_warehouse_id` is derived.** SCM keeps the
  destination on the consignment (`out_dispatches.to_warehouse_id`), not on the issue.
  The feed resolves the issue's most recent consignment and falls back to the
  originating indent's warehouse. An issue collected at the counter with neither will
  come back `null`.
- **`/vehicles` is derived, not a master.** SCM has no vehicle master (`trn_vehicles`
  belongs to the transport team and is not mirrored). The feed lists every vehicle that
  has actually carried an indent or an issue, with the point it served. Per §7, HCM
  remains the owner of vehicle → unit allocation.

---

## 3. Write endpoints (5 of 5)

Both path shapes work, so either base URL is fine:

```
POST /api/ext/v1/cams/material-issue-ack      POST /api/ext/v1/cams/cams/material-issue-ack
POST /api/ext/v1/cams/consumption             POST /api/ext/v1/cams/cams/consumption
POST /api/ext/v1/cams/stock-balance           POST /api/ext/v1/cams/cams/stock-balance
POST /api/ext/v1/cams/stock-transfer          POST /api/ext/v1/cams/cams/stock-transfer
POST /api/ext/v1/cams/wastage                 POST /api/ext/v1/cams/cams/wastage
```

Headers: `X-API-Key`, `X-CAMS-Signature: sha256=<HMAC-SHA256(raw_body, shared_secret)>`,
`Content-Type: application/json`. The HMAC is over the **raw bytes** of the body.

Payloads are exactly as written in §4 of the ask. Unknown extra fields are accepted and
stored, so B-CAMS can add one without a coordinated release.

Success:

```json
{"ok": true, "event_id": "<echo>", "received_at": "2026-08-14T12:23:31"}
```

`received_at` is **naive IST** — the wall clock this business runs on, no offset and no
`Z`. Do not read it as UTC or every logged time lands 5h30 out. `generated_at` on the way
in may carry any offset (`…T06:53:31Z` is fine); SCM converts it to IST on arrival.

Replay of an `event_id` already seen: `200 {"ok":true,"duplicate":true,…}`, nothing
changes. The de-duplication window is the last 5000 events.

Failures: `401` bad key or bad signature, `422` payload the schema rejects (the message
names the field), `429` rate limit. Retry on any non-2xx — the same `event_id` is safe.

### The 14-Aug-2026 real-time feed

B-CAMS pushes within ~60s of the stock moving rather than nightly. Accepted as sent; no
change to the interval is wanted — 1,440 pushes/day against a 120/min key ceiling is
about 1% of the budget.

| What arrives | How SCM takes it |
|---|---|
| `scope`: `partial` / `full` | Recorded on the receipt. Any other word is recorded too, never a 422 |
| `basis`: `stock_balance` / `eod_closing` | Recorded, **never merged or averaged** — the gap between the two is the reconciliation signal |
| `tier`, `warehouse_code`, `is_vehicle` | Recorded. SCM derives tier itself from `whs_warehouses` for the read feeds |
| `on_hand_qty` + `closing_qty` | Both kept as sent. Keep sending both |
| `batches[]`, `lt_drawn_qty`, `sk_held_qty` | Recorded per line |
| A date field stamped with a time (`as_of: "2026-08-14T06:52:20"`) | Reduced to the day it names, **in IST**. A UTC-stamped evening therefore lands on the next day here — `2026-08-14T19:00:00Z` is the 15th |
| `sac: null` | Fine. SCM has no `sac` column; it is stored on the receipt and matched on nothing |

Three things B-CAMS still has to change:

1. **`warehouse_id` must not be null on `consumption` or `wastage` records.** The
   captures in their 14-Aug doc show `null` on both while `stock-balance` correctly sends
   `78`. `warehouse_id` + `item_code` is the only key SCM matches on — `facility_name` is
   free text and matches nothing.
2. **`item_code` must be SCM's item code** (`131111-0001`), never a B-CAMS-local one.
3. **Chunk the nightly `full` sweep to ~30 facilities per push.** 104 MMUs × ~49 items is
   far past the 40 KB receipt store (see below); a distinct `event_id` per chunk keeps
   de-duplication working.

### U5 wastage

Sent separately from consumption because `consumption.wastage_qty` carries the quantity
but not the reason or the value, and a spoiled unit costs against a different head from a
used one. The two feeds overlap by design — the same quantity appears in both.

`wastage_qty` is the one required field on a row; `reason`, `rate` and `wastage_value` are
optional. An expiry write-off needs no separate feed: send it here with
`reason: "Expired"`.

```json
{"event": "facility.wastage", "event_id": "waste-20260814T065756-3f00a232",
 "scope": "full", "wastage_date": "2026-08-14",
 "records": [{"warehouse_id": 78, "item_code": "141010-0002", "uom": "ml",
              "wastage_qty": 1.0, "reason": "Spillage", "rate": 99.0,
              "wastage_value": 99.0}]}
```

### What SCM does with a write, today

It authenticates it, verifies the signature, refuses replays, validates it and stores
it as a durable receipt. It does **not** yet post the numbers onto `out_issues` or
`stk_balance`: physical stock changes only through `inventory.move_stock()` and an
issue's status only through the warehouse module, and neither can be reached from an
integration endpoint. So B4 currently records the acknowledgement rather than closing
the issue. Applying the receipts is warehouse/inventory work and is the next piece.

This is why the 60-second cadence costs SCM nothing today, and why the nightly `full`
sweep overlapping the real-time pushes is harmless: a receipt is written once per
`event_id` and no quantity is added anywhere.

SCM-side visibility (JWT + `admin.settings.manage`):

```
POST /api/apis/cams/secret        mint/rotate the shared secret — shown once
GET  /api/apis/cams/events        what arrived, newest first (?event=facility.consumption)
GET  /api/apis/cams/events/{id}   one receipt, with its payload
```

A payload over 40 KB is receipted by digest and row count, with the body written to the
application log — `sys_settings.setting_value` is a MySQL TEXT and a truncated receipt
reads back as corrupt. Split very large nightly batches if you want them stored whole.

---

## 4. §5 webhook on dispatch

Not built. Poll `/material-issues?destination_warehouse_id=…&updated_since=…`.
