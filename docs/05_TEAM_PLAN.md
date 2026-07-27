# SCM ERP — Who Does What

Balu integrates everything. Nobody edits shared files.

---

## Sai Teja — Material Requests (Indents)

Folders: `backend/app/modules/indents/` and `frontend/src/modules/indents/`

**What you need to do:**

- Add search to the indent list — search by indent number, item name, item code, requester name, remarks.
- Add date filters — created date from/to, and required-by date from/to.
- Add more filters to the list — multi-select status, priority, department, project, warehouse, item, created-by.
- Add sorting — by date, by indent number, by value, by required-by.
- All of the above go into the existing `GET /api/indents`. Do not make a second list endpoint.
- Add CSV export that uses the exact same filters.
- Expand `GET /api/indents/stats` for KPIs: counts by status, counts by priority, counts by department, aging buckets (0-2 / 3-7 / 8-15 / 15+ days), average cycle time from created to approved and approved to fulfilled, SLA breaches past required-by, top 10 requested items, 12-month trend.
- Put the KPI cards on the dashboard page. Clicking a card should filter the list below it.
- Make the KPIs respect the same filters as the list, so numbers and rows always match.
- Finish the indent form — live stock availability shown while picking an item (Yashwanth gives you the endpoint), attachments, item search that works on partial codes.
- Finish the status board and acknowledgments screens on real data.
- Saved filter presets in the browser.
- Make every list screen work on mobile using `<ResponsiveList>`.

**What you don't touch:**

- `App.tsx`, `seed.py`, `permissions.py`, `enums.py`, `main.py`, alembic files, anything in `frontend/src/shared/`. Balu handles all of these — tell him what you need and he adds it.
- Any other module's folder. If you need something from Inventory, call the API, don't import their code.
- Allocation logic itself — the endpoints sit in your router but the actual working code is Yashwanth's `inventory/allocations.py`.

---

## Sai Teja — Approvals

Same folders as above.

**What you need to do:**

- Build the approvals inbox on `GET /api/workflow/pending`, which already returns doc type and doc id.
- Make a small map in your module: doc type → which endpoint approves it. Indents go to `/api/indents/{id}/approve`, material requests to `/api/material-requests/{id}/approve`, POs to `/api/pos/{id}/approve`. Each module approves its own document.
- Filters: document type, requester, department, date range, amount range, how long it's been waiting.
- Search across document number, requester name, item.
- KPI row: pending on me, overdue, approved by me this week, average time I take to decide.
- Bulk approve and bulk reject. Reject must force a comment. Show which rows succeeded and which failed.
- Approval history timeline per document from `GET /api/workflow/history/{doc_type}/{doc_id}`. Reuse the FlowStepper you already have.
- Delegate and Return buttons. Balu is adding those endpoints — build the UI now, wire it when it lands.
- Notification screen: mark as read, filter by type.
- Mobile view for the inbox.

**What you don't touch:**

- The workflow engine itself (`platform/workflow/`). You only call it.
- Don't write a generic "approve anything" endpoint. Each module owns its own status.
- Same shared-file list as above.

---

## Yashwanth — Inventory

Folders: `backend/app/modules/inventory/` and `frontend/src/modules/inventory/`

You are the base module. Everyone depends on you. Freeze your `schemas.py` early and tell people before you change any shape.

**What you need to do:**

- Add `POST /api/stock/adjust` — adjust stock with a reason (damage, expiry, count variance, found). Must go through `move_stock()` so a ledger row is written. Big adjustments need approval.
- Add `GET /api/stock/replenishment` — the screen already exists with nothing behind it. Return items where available is below reorder level, with suggested order quantity, lead time, last purchase price. Filter by warehouse, category, criticality.
- Add `GET /api/reservations` and `POST /api/reservations/{id}/release` — reservations get created today but there's no way to see or release them.
- Add `GET /api/stock/{item_id}/availability` — Sai Teja's indent form needs live availability while typing.
- Batch and expiry handling — make sure FEFO really picks the earliest expiry, and write the test that proves it.
- Add `GET /api/stock/ageing` — buckets by days in stock and days to expiry.
- Add `GET /api/stock/valuation` — moving average cost per item per warehouse. Cost comes from GRN lines, read only.
- Near-expiry alerts feed.
- Build STO (Stock Transfer Order). Today transfer moves stock instantly with no approval. Business needs: create STO → approval → dispatch → receive → stock moves only on receipt. New tables `inv_sto` and `inv_sto_items`.
- Build cycle count — plan a count, enter counted quantity, show variance, post the difference as an adjustment.
- Frontend: server-side pagination, search and filters on Stock Balance and Stock Ledger. The ledger will be the biggest table in the system, never load it all at once.
- Frontend KPI row on the inventory overview: total stock value, items below reorder, near expiry at 30/60/90 days, reserved vs available, dead stock with no movement in N days.
- CSV export on balance and ledger.
- Wire the barcode modal to scan-and-locate.

**What you don't touch:**

- Nothing from `app.modules.*` — you import zero other modules. If you need indent data, the caller passes it to you as an argument.
- Never write to `lgs_*` or `pro_*` tables. Read only.
- Never update or delete a `stk_ledger` row. Append only.
- Same shared-file list as everyone.

---

## Naveen — Warehouse

Folders: `backend/app/modules/warehouse/` (doesn't exist yet, you create it) and `frontend/src/modules/warehouse/`

Start clean. Balu is deleting the current warehouse frontend — it came from another project, uses antd and its own axios and calls `/api/v1` endpoints that don't exist here. Use the old screens as a picture of what to build, not as code. All your tables start with `whs_`.

**What you need to do:**

- Build the full warehouse structure: Warehouse → Floor → Line → Rack → Bin → Lot. Cold room and refrigerator are bin types. Tables `whs_floors`, `whs_lines`, `whs_racks`, and extend `whs_bins`.
- Mark warehouses as LIP or MDP.
- CRUD screens for all of it, plus a tree view.
- Show capacity and occupancy per bin, calculated from stock balance.
- Gate Pass IN and OUT in one table with a direction column, with its own numbering series.
- Material Inward — vehicle entry, gate entry, document check, unloading. Links to a GRN.
- Put-away — after QC passes, suggest a bin, confirm placement, stock moves into that bin. Put-away is the only place that decides where stock physically sits.
- Stock segregation — quarantine, rejected and good zones as bin types.
- Picklist — generated from an approved allocation or an issue. The FEFO order comes from Inventory, you just show and confirm it.
- Packing — pack picked lines into boxes, weights, labels.
- Consignment — group packages for one destination.
- Dispatch plan — pick the dispatch method (in person, own fleet, courier, 3PL).
- Gate Pass OUT, delivery, and delivery acknowledgment.
- Stock leaves the building on dispatch, not on picking. One movement call at the right moment.
- Returns — damaged, expired, unused against an indent, vendor return. Receive back, quality check, update stock, then scrap or send back to vendor.
- Warehouse dashboard.
- Frontend build order: Warehouse Tree, Material Inward, Put-away, Picklist, Packing, Dispatch, Gate Pass, Returns, Dashboard.

**What you don't touch:**

- GRN and QC — those already exist in logistics as `lgs_grn`. Call `/api/grn`, `/qc-pass`, `/qc-fail`. Don't build your own.
- Material Issue document — already exists in logistics. Call `/api/issues`.
- Stock balance — never write to it. Always call Inventory's `move_stock()`.
- Purchase orders — already done in procurement. Call `/api/pos`.
- Approvals — call the workflow engine, never write your own approval code.
- Same shared-file list as everyone.
- You're last in the chain so you'll feel other people's changes first. Rebase on `qa` every morning.

---

## Tirumala — RBAC

Folders: `backend/app/platform/rbac/` (only `service.py`, `router.py`, `schemas.py`, `models.py`, `tests/`) and `frontend/src/modules/rbac/`

**What you need to do:**

- Add role create, update and delete. Right now only listing works — you cannot make a role from the UI at all.
- Protect system roles from being deleted or renamed. Deleting a role that still has members must give a clean error message, not a database error.
- Add `PUT /api/rbac/roles/{id}/permissions` that saves the whole permission set in one call, not one at a time.
- Add clone role.
- Build the permission matrix screen — roles down one side, permissions across the top, grouped by module and resource. The grouping data is already there in the permission list.
- Matrix needs: bulk toggle by row, by column and by group, search, unsaved-changes indicator, one Save button.
- Show a diff before saving, like "granting 4, revoking 2". Permission changes are the most dangerous edit in the system.
- HCM role import. HCM has around 23 real roles, the 5 in the seed file are just test data. `GET /api/admin/hcm-roles` already lists them. Build an import that maps an HCM role to an SCM role, creates missing ones, and can be run twice without duplicating.
- Screen for that import: HCM roles on the left, SCM roles on the right, map or create per row.
- Build "why can this user see this" — an endpoint that returns every permission a user has and where it came from (which role, which group, which position).
- Reverse lookup — who can approve a PO, who can issue stock.
- "View as this user" — return the menu and permissions a given employee would see.
- Session management — list active sessions, force logout, last login per user. The `sys_sessions` table already exists.
- Write an audit row on every RBAC change using the existing `write_audit` function. Don't build a new audit system.
- Password policy settings, read from system settings.
- Delegation of authority — temporary role or permission grant with a start and end date. Sai Teja's Approvals screen has the Delegate button, your table holds the record. Agree the shape with him on day one.

**What you don't touch:**

- `permissions.py`. That file lives in your folder but it's Balu's. You build the machinery that assigns permissions; the list of permission codes stays with the lead. Need a new code, ask him.
- Don't change how `require_permission` works. Exact code match, no wildcards, no inheritance. Adding inheritance silently changes every endpoint in the app.
- Don't change the shape of what `GET /api/auth/me` returns. The whole frontend depends on it.
- `PAGE_TREE` in `seed.py` — that's Balu's. You control who can *access* a page, not whether it *exists*.
- Same shared-file list as everyone.

---

## Balu — Home, Settings, Masters, and integration

**What you need to do first, before anyone starts:**

- One commit on `qa` that pre-adds everything the team would otherwise fight over: every permission code, every enum, every route in `App.tsx` (pointing at a Placeholder where the screen doesn't exist yet), every `PAGE_TREE` menu row, every router registered in `main.py`.
- Create five empty alembic migration files with the chain already wired: initial → Balu → Tirumala → Yashwanth → Sai Teja → Naveen. Each dev fills only their own file and never touches the revision ids. This guarantees one head no matter what order branches merge in.
- Delete the old warehouse frontend and leave Naveen a clean empty module.
- Create `tirumala-rbac` branch, close `tirumala-logistics`.

**Platform gaps the team is blocked on:**

- `platform/settings` has a service but no router at all — settings are unreachable from the UI. Add `GET/PUT /api/settings`.
- Add workflow return and delegate endpoints. The enum values exist but there is no endpoint anywhere. Sai Teja needs these.
- Add the `stock.adjust` permission code and adjustment reason enum for Yashwanth.

**Home:**

- One endpoint `GET /api/home/summary` that returns everything the dashboard needs in a single call — my pending approvals, my open indents, things waiting on me, stock below reorder, MRs waiting for procurement, POs due, GRNs pending QC.
- Home screen with KPI cards and a "needs your attention" list, each row linking into the right module.
- Different content per role. A requester and a plant head must not see the same Home.

**Settings:**

- Settings screen: company details, fiscal year, default warehouse, currency, date format, timezone.
- HCM sync configuration (API already exists).
- Numbering defaults, notification channels, fallback behaviour toggles.
- Everything stored in `sys_settings`. No hardcoded config anywhere.

**Masters:**

- Missing masters: LIP/MDP location config, departments, cost centres, tax/HSN, currency, reorder-level defaults per item and warehouse.
- Search across all master tabs.
- CSV import and export per master.
- Soft delete and restore.
- "Where used" check — block deleting an item that sits on an open indent.
- Audit trail on every master row using the existing `write_audit`.
- Finish the item master attributes, features and specs tabs — they're stubbed.

**Integration:**

- Merge every branch into `qa`. Nobody merges into anyone else's branch.
- Handle every "integration request" from the team within the same day.

---

## Rules for everyone

- Branch off `qa`. Rebase on `qa` every morning. Never merge one dev branch into another.
- Before raising a PR: `pytest` green, `npm run build` clean, `npm test` green.
- Run `git status` before committing. If a file outside your folder shows up, you made a mistake — revert it.
- Day one of your module, push your `schemas.py`, `types.ts` and `api.ts` with just the shapes and function signatures, no logic. Then everyone else can build against your contract while you write it.
- If you change a shape after that, announce it in the group. A silent shape change is the only thing that actually breaks integration.
- Every module has the same five files: `models.py schemas.py service.py router.py tests/`.
- All logic in `service.py`. Routers are three to five lines with no `if`.
- Every endpoint has a permission check. Hiding a button is not security.
- Never a raw status string, always the enum.
- Lists always return `{items, total, page, size}`.
- All UI from `@/shared/components`, all HTTP through `@/shared/api/client`.
- Every list screen uses `<ResponsiveList>`, every status uses `<StatusPill>`.
- Tests live in your own module's `tests/` folder.

## The shared files nobody but Balu edits

`frontend/src/App.tsx`, `backend/scripts/seed.py`, `backend/app/platform/rbac/permissions.py`, `backend/app/shared/enums.py`, `backend/app/main.py`, `backend/alembic/versions/*`, anything in `frontend/src/shared/`.

Need something in one of these? Message Balu with what to add and why. He lands it on `qa` the same day.
