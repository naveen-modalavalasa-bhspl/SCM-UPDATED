# RBAC / User-Groups — Implementation Plan (27 Jul 2026)

## Already built (QA pull) — DO NOT rebuild
- `backend/app/platform/admin/users.py`: paginated user list (`GET /api/admin/users?search=&with_access=&page=&size=`), KPI summary (`GET /api/admin/users/summary` → active_employees, users_with_access, active_roles), grant/revoke access, reset password, set roles (`PUT /api/admin/users/{id}/roles`).
- `backend/app/platform/admin/groups.py`: full group CRUD (`/api/admin/groups`), parent→child sub-groups (child = LOCATION type narrowing parent's role/position to an office), cycle validation, rule-based member resolution + explicit member add/remove (`/groups/{id}/members`).
- Group types: ROLE, HCM_ROLE, POSITION, LOCATION. Region = `hcm_offices` id in `location_id`.
- Audit via `settings.service.write_audit`; schema already supports everything — **no migrations**.

## Remaining work

### A. Backend (small)
1. Add `role_id` filter to `list_users` (`users.py`) — filter employees holding that SCM role via `rbac_user_roles`; pass through router query param. 3–5 line router change.
2. Tests: role filter returns only matching employees; existing tests keep passing.

### B. Frontend — the bulk (new pages in `frontend/src/modules/admin/`)
1. Extend `api.ts` + `types.ts`: usersApi (list/summary/grant/revoke/reset/setRoles), groupsApi (CRUD/members).
2. **UsersAccessPage.tsx** (reference image = layout only; our tokens/wording):
   - KPI row: existing summary endpoint, unchanged metrics (`StatCard` ×3).
   - `ResponsiveList` table: emp code, name, roles (`StatusPill`, HCM vs SCM source), department, email, access state.
   - Debounced search + role `Select` filter (new role_id param) + server pagination.
   - Row actions behind `<Can do="admin.roles.manage">`: grant access (shows one-time temp password), revoke, reset password, edit roles drawer.
3. **UserGroupsPage.tsx**:
   - Left: group tree (parents + LOCATION children indented, inactive dimmed).
   - Right: selected group — rule summary, paginated members, explicit add/remove.
   - Create/edit modal: type select drives which id field shows (role/position/location); LOCATION forces parent + office select.
4. Wire-up: one `<Route>` each in `App.tsx`; one `PAGE_TREE` child row each in `scripts/seed.py` under admin group (approved).
5. Vitest per page: api surface + filter → param mapping.

### C. Data task (after UI works)
Create groups via UI/API — per role (LT, OE, DM, RM…): one parent ROLE/HCM_ROLE group + one LOCATION child per district office (codes like `GRP-LT`, `GRP-LT-KRISHNA`). District list from live `hcm_offices`, never hardcoded.

## Rules
Frozen schema; `hcm_*` read-only; enums never raw strings; `NotFoundError`/`ValidationError` only; every endpoint permission-guarded (`admin.roles.manage`); lists paginated; routers 3–5 lines; audit every state change. Finish = rbac/admin pytest green + `npm run build` clean.
