# Logistics Module — Daily Status Log

Developer: Tirumala Velaga · Module: Logistics · Branch: `tirumala-logistics`

---

## 24 Jul 2026 — Analysis & Setup (no code changes)

- Pulled base SCM ERP code and set up on the `tirumala-logistics` branch; reviewed the overall architecture (FastAPI + React, module-per-developer structure).
- Studied the two documents shared by the manager — *BHSPL SCM Process Flow* and *Item Definition* — and mapped the end-to-end lifecycle (Indent → PO → GRN → QC → Warehouse → Logistics → Consumption).
- Completed a full code walkthrough of the logistics module:
  - Backend (GRN, stock, issues) already implemented with 5 passing tests — GRN creation from PO, QC pass/fail into stock, issue-out flow, and the `move_stock()` ledger.
  - Frontend has the API layer and types ready, but all three pages (GRN, Stock, Issues) are placeholders — development work starts here.
- Prepared a gap list between the manager's documents and the current code: stock adjustment, inter-warehouse transfer, stock reservation, gate pass, dispatch/acknowledgement, FIFO/FEFO picking, return-to-vendor — all currently missing.
- Noted working constraints for the module: frozen DB schema, work only inside the logistics folders, all business logic in the service layer, permissions on every endpoint.
- Open questions for the manager (blocking start of development):
  1. Should module status enums live in a module-level `enums.py` or continue from shared `app/shared/enums.py`?
  2. Which feature to pick up first — GRN screens, stock screens, issues end-to-end, or stock adjustment?

**Next:** Get answers to the open questions and begin development.

---

## 27 Jul 2026 — Pulled latest code from QA branch

- Updated the local `tirumala-logistics` branch with the latest code from the QA branch (up to date with `origin/tirumala-logistics`, latest commit `9479477`).
- The codebase has evolved significantly since the initial analysis: inventory is now the base module and owns `stk_balance`, `stk_ledger` and `move_stock()`; stock reservation with FEFO, availability lookup, material-request tables and a deep bin hierarchy have been added; indent and inventory modules are now connected through the workflows/rules engine.
- Fresh checkout — setting up the environment (Python venv, `.env`, DB migration, seed, npm install) to run the application locally.

**Next:** Bring the app up locally, re-verify the logistics module against the updated inventory-owned stock layer.

---

## 27 Jul 2026 (later) — RBAC: role filter + pagination on the users list

- Brought the app up locally: created the Python 3.12 virtualenv, installed backend requirements, started the API on :8000 and the frontend on :5173. Confirmed login works (`admin`).
- Reviewed the RBAC code pulled from QA and found most of the planned work already built — the Users/Roles and User Groups screens, their backend endpoints, page- and feature-access matrices, and the role/region sub-group model all exist. Re-scoped to the genuine gaps.
- Added a **filter by role** to the user list: new `role_id` parameter on `GET /api/admin/users`, resolving role holders from HCM positions or SCM role assignments so the filter matches the roles shown in the table. Added a role dropdown and server-side pagination (Previous / Next) to the Roles & Access screen. Left the existing KPI cards unchanged as requested.
- Wrote three backend tests (SCM-role filter, HCM-role filter, unknown-role 404). Frontend build compiles clean and the RBAC frontend tests pass.
- **Blocked:** backend pytest can't run — the local MySQL test database rejects the configured `root` password, so the suite can't build `SCM_REBUILD_test`. Needs the correct local MySQL credentials in `TEST_DATABASE_URL`.

**Next:** Fix the local test-DB password and run the admin test suite.

---

## 27 Jul 2026 (final) — RBAC role filter + pagination, kept inside the RBAC module

- Reworked the role-filter change so every edit stays inside the RBAC module (backend `platform/rbac`, frontend `modules/rbac`) — no other module is touched. The earlier version had edited `platform/admin`, which owns the user-list endpoint; that was fully reverted.
- Added a self-contained, paginated user directory in the RBAC service (`GET /api/rbac/users`) supporting search, access filter and a **role filter**. Role holders are resolved from HCM positions or SCM role assignments, matching the roles shown in each row. Guarded by the existing `admin.users.manage` permission.
- Frontend Roles & Access screen now points its user list at the RBAC endpoint and adds a **Filter by role** dropdown and Previous/Next **pagination**. KPI cards left unchanged.
- Tests: 4 new RBAC backend tests (SCM-role filter, HCM-role filter, unknown-role 404, pagination + permission guard). Full RBAC suite 14 passed. Frontend build compiles clean and RBAC frontend tests pass.

**Files changed (all inside RBAC):** `platform/rbac/router.py`, `platform/rbac/service.py`, `platform/rbac/tests/test_auth_rbac.py`, `modules/rbac/api.ts`, `modules/rbac/pages/UsersPage.tsx`.

**Next:** Confirm with the team that a second user-list endpoint under `/api/rbac/users` is acceptable (it parallels the existing `/api/admin/users`), or fold it back once module ownership is settled.

---

## 27 Jul 2026 (evening) — User groups rebuilt in RBAC with district regions; smoke test

- Built user groups fully inside the RBAC module: group CRUD under `/api/rbac/groups`, a `/api/rbac/regions` endpoint (districts from HRMS offices), and rule-based member resolution where a region sub-group intersects its parent — "Krishna District — Lab Technicians" returns only the lab technicians in Krishna. Group tables (`rbac_user_groups`) are RBAC-owned, so no other module was touched.
- Rebuilt the User Groups screen as a parent → region tree: role groups expand to show their district sub-groups, each row has Members and an "add region" shortcut, and the create form picks a real district (HRMS office) instead of a warehouse. This also removed the page's cross-module import of the masters API.
- Tests: RBAC backend suite 20/20 green (6 new group tests incl. region narrowing and validation); frontend build clean; RBAC frontend tests pass.
- Smoke-tested the running app and logged bugs: `/api/pos`, `/api/grn`, `/api/issues` return 500 because the shared `SCM_REBUILD` database is missing the `pro_*`/`lgs_*` tables (needs lead/DBA migration); unhandled DB errors leak a raw 500; one inventory route 404s; intermittent "Too many connections" on the shared MySQL.
- Received the manager's full RBAC assignment (role CRUD + clone, permission matrix with diff preview, HCM role import, permission provenance, sessions, delegation). Saved and planned; flagged that delegation needs a new table (schema frozen) and the Sai Teja contract.

**Next:** Start the manager's list with role CRUD + `PUT /roles/{id}/permissions`; get the delegation table approved.

---

## 27 Jul 2026 (night) — Role lifecycle + permission matrix; full-suite verdict

- **Role lifecycle (backend, RBAC only):** create / update / delete, clone-with-permissions, and `PUT /api/rbac/roles/{id}/permissions` that replaces the whole set in one call and returns the granted/revoked diff. System and HCM-mirrored roles cannot be renamed or deleted; deleting a role still assigned to users gives a clean message with the member count. Every change writes an audit row through the shared `write_audit`.
- **Permission matrix screen:** new tab under RBAC → Roles & Access. Roles down the side, permissions grouped by module across the top; bulk toggle by row, column and module group; search; unsaved-changes indicator; single Save with a per-role diff confirmation ("granting 4, revoking 2"). New role / clone / delete from the same screen.
- Fixed en route: audit rows overflowing the 50-char `entity_no` column (now passes the role code), and two tests that read through the db fixture's REPEATABLE READ snapshot instead of the API.
- RBAC test suite: **28/28 green.** Frontend build clean.
- **Full backend suite verdict: 208 passed, 31 failed — none in RBAC.** Root cause of ~25 failures: `core/exceptions.py` sets `ValidationError` to HTTP **422**, while module tests (masters, rules, procurement, admin) still assert **400**. One-line decision for the lead: revert the status code or update the tests. Remaining: audit-log expectations in platform/admin, one HCM sync mapping test, one e2e assertion.

**Next:** HCM role import (idempotent, ~23 real roles) + mapping screen; then provenance endpoints; delegation still parked on table approval.

---

## 27 Jul 2026 (late night) — Reporting hierarchy (who reports to whom)

- New `GET /api/rbac/users/{id}/reporting`, derived live from the HCM position tree (`hcm_positions.parent_position_id` + active assignments) — nothing stored, so it always reflects the latest HR sync. Returns the manager chain above a person (nearest first) and their full team tree below: RM → DMs → OEs → SKs/LTs, with vacant positions shown as vacant.
- New **Reporting** tab on Roles & Access: search a person, see "Reports to" (direct manager, then each level up) and their expandable team tree with role badges (RM/DM/OE/SK/LT).
- Tests: seeded a six-person org (1 RM, 2 DMs, 1 OE, 1 SK, 1 LT) and asserted the tree downward from the RM, the chain upward from the SK, and the 404 case. RBAC suite now **31/31 green**; frontend build clean, module tests 4/4.

**Next:** unchanged — HCM role import + mapping screen, then provenance/sessions; delegation parked.

---

## 27 Jul 2026 (contd.) — Reverse lookup + "View as this user" (brief items 11, 12)

- `GET /api/rbac/permissions/{code}/holders` — pick a permission (e.g. approve PO) and get every role that grants it plus the people holding each role, resolved the same way the permission check itself works (SCM roles via assignments, HCM roles via positions).
- `GET /api/rbac/users/{id}/view-as` — the roles, permissions and menu a given employee would see on login, using the same resolution as the real login without touching `/api/auth/me`.
- New **Access lookup** tab on Roles & Access with both: "Who can do this?" (permission picker → roles → people) and "View as this user" (person search → their roles, menu, permission chips).
- Tests: 5 new (holders happy path, unknown permission 404, view-as content, permission guards). RBAC backend **35/35 green**, frontend build clean, module tests 4/4.

**Remaining from brief:** HCM role import + mapping screen (8, 9), provenance "why can this user see this" (10), sessions (13), password policy (14); delegation (15) parked on table approval + Sai Teja. **Per discussion, these are not required for now — RBAC work parked at this point.**

---

## 27 Jul 2026 (contd.) — Reporting screen rebuilt properly

- Reworked the reporting screen into a real org-chart tool. New `GET /api/rbac/org-tree` returns the whole organisation top-down (root positions with nested subtrees); `get_reporting` now also returns team-size counts so each node shows "N direct · M total".
- Frontend: two modes on the Reporting tab. Default shows the whole organisation as an expandable tree; searching or clicking anyone focuses on them — their reporting line renders as a clickable breadcrumb (top of org → them), their card, and their team tree. Every person in the tree is clickable to re-focus. Avatars with initials, role badges (RM/DM/OE/SK/LT), vacant seats shown.
- Tests: added org-tree assertions (RM has 2 direct / 5 total; Krishna DM has 3 total). RBAC backend **36/36 green**; frontend build clean, module tests 4/4. All changes inside `platform/rbac` + `modules/rbac`.
