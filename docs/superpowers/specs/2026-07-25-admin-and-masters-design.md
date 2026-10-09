# Admin & Masters Modules — Design

Date: 2026-07-25
Status: approved

## Goal

Complete the Admin and Masters modules for SCM ERP so the Inventory and Warehouse
developers have master data, locations, a stock ledger with a project dimension, logins,
and a data-driven rules engine to integrate against.

## Context: what already exists

The repository already ships most of the Masters surface and all of the RBAC and
approval-workflow surface. This design covers only the gaps.

| Spec item | Existing | Gap |
| --- | --- | --- |
| Item / Category / UOM master | `mst_items`, `mst_item_categories`, `mst_uom` + CRUD | deactivate endpoint, UOM conversions |
| Vendor master | `mst_vendors` + CRUD | none |
| Unified Masters screen | `frontend/src/modules/masters/` (WIP) | 4 more tabs |
| Position / Role master | `rbac_roles`; positions mirrored from HCM | user groups |
| Document numbering | `sys_doc_series` + `shared/numbering.py` | reset policy, admin GUI |
| Page / feature RBAC | `rbac_permissions/roles/pages/user_roles` | none |
| Approval routing | `wf_*` engine | fulfillment routing |
| Location / Warehouse master | — | everything |
| User management | `sys_local_credentials` | admin API + GUI |
| Rules engine | — | everything |
| Audit log / notifications / HRMS sync config | `sys_hcm_sync_log` only | everything |

## Decisions

### D1. Table prefixes follow the repository, not the source brief

The brief asked for `master_*`, `admin_*`, `inventory_*`. The live `SCM_REBUILD`
database and this codebase use `mst_`, `rbac_`, `sys_`, `stk_`, `wf_`. The repository
convention wins: renaming live tables costs days and the brief itself says not to
reinvent masters that already exist. New tables use existing prefixes plus a new
`rule_` prefix for the rules engine. The brief's actual intent — every table carries a
module prefix — is satisfied.

### D2. A new `rule_` engine; the `wf_` engine becomes one of its consumers

The `wf_` tables model approval routing specifically (stage → approver). The brief wants
one configurable engine covering approval *and* fulfillment routing. Overloading `wf_`
with fulfillment semantics would distort an approval-shaped schema owned by the DB team.

New `rule_*` tables hold event → conditions → actions. `ROUTE_APPROVAL` is one action
type, and it delegates to `platform/workflow/engine.py`. Existing approvals keep working
untouched, and CLAUDE.md rule 8 (approvals only through the workflow engine) still holds.

### D3. `mst_locations` is a self-referencing tree; the stock ledger gains location + project

Facilities come from HCM and are read-only (rule 10), so they cannot host warehouse or
zone structure. One SCM-owned `mst_locations` table models SITE → WAREHOUSE → ZONE → BIN
through `parent_id` + `location_type`, soft-linked to `hcm_facility_id`.

Separate tables per level were rejected: three tables means three CRUD screens and more
joins per render, which fights the brief's "one screen should not require many calls".

`stk_stock` and `stk_movements` gain `location_id` and `project_id`, so stock is keyed
item + location + project. `mst_items` gains no project column — a transfer between
projects moves ledger rows and never touches the item master, per the brief.

### D4. A "user" is an HCM employee granted SCM access

There is no `users` table; identity is `hcm_employees` (a read-only mirror) plus
`sys_local_credentials`. Admin therefore searches synced employees and grants access:
write a credential row, assign roles and groups. Deactivate revokes the credential and
all `sys_sessions`. Nothing is written back to HCM, and the brief's "do not build
employee management here" constraint holds.

An `admin_users` table was rejected — it duplicates identity and drifts against the
~2,800 synced employees.

### D5. Group membership resolves dynamically

The brief says user groups are grouped by position and role, and sub-groups by place.
Membership is therefore *derived* from `role_id` / `position_id` / `location_id` rather
than stored, so an HCM sync never leaves a stale roster. Explicit
`rbac_user_group_members` rows are an additive override for exceptions.

## Structure

```
backend/app/
  shared/masters/            masters_router.py becomes a package
    crud.py                  declarative CRUD factory
    defs.py                  one MasterDef per master
    router.py                loops defs.py
  shared/models/master.py    + Location, UomConversion
  platform/rules/            NEW  models schemas service router evaluator conflicts tests
  platform/admin/            NEW  users groups audit notifications hrms-config
  platform/rbac/models.py    + UserGroup, UserGroupMember
  platform/settings/models.py + AuditLog, NotificationRule
frontend/src/modules/
  masters/                   8 tabs over one <MasterCrud>
  admin/                     users groups roles rules-builder audit notifications sync
```

Eight masters times sixty lines of near-identical router code is the duplication to
avoid. `defs.py` is a table of `MasterDef` rows; master number nine is one row.

## Schema

New tables:

```
mst_locations(id, code, name, location_type SITE|WAREHOUSE|ZONE|BIN,
              parent_id -> self, hcm_facility_id soft, is_stock_point, is_active)
mst_uom_conversions(id, from_uom_id, to_uom_id, factor)

rbac_user_groups(id, code, name, parent_id -> self,
                 group_type ROLE|POSITION|LOCATION,
                 role_id, position_id, location_id, is_active)
rbac_user_group_members(group_id, employee_id)

rule_events(code, name, module, context_schema JSON)
rule_rules(id, event_code, name, priority, is_active, effective_from, effective_to)
rule_conditions(id, rule_id, field_name, operator, field_value, logic)
rule_actions(id, rule_id, seq, action_type, params JSON)
rule_executions(id, rule_id, event_code, doc_type, doc_id, matched, acted_at)

sys_audit_log(id, entity, entity_id, action, actor_id, actor_name,
              before JSON, after JSON, at)
sys_notification_rules(id, event_code, stage, recipient_type, recipient_id,
                       channel, is_active)
```

Widened existing tables (live-data migration):

```
stk_stock      + location_id, project_id
stk_movements  + location_id, project_id
sys_doc_series + reset_policy NEVER|YEARLY|MONTHLY
```

Backfill: one `mst_locations` row is auto-created per active `hcm_facility`; existing
`stk_*` rows take that row's id as `location_id` and `NULL` as `project_id`.

## Rules engine contract

Consumed by the Inventory and Warehouse modules:

```python
await rules.fire("INDENT_SUBMITTED", ctx={
    "indent_id": 42,
    "category_code": "CONSUMABLE",
    "quantity": 150,
    "requester_position_id": 7,
    "location_id": 3,
})
# -> [Action(ROUTE_FULFILLMENT, {"target": "WAREHOUSE"}),
#     Action(ROUTE_APPROVAL,    {"workflow_code": "WF_INDENT_HIGH"})]
```

Action types: `ROUTE_APPROVAL`, `ROUTE_FULFILLMENT`, `SPLIT_FULFILLMENT`, `NOTIFY`,
`SET_FIELD`. Operators reuse `ConditionOperator` from `shared/enums.py`; no raw status
strings anywhere (rule 3).

Evaluation: load active rules for the event ordered by `priority`, evaluate each rule's
conditions against `ctx`, collect the actions of every rule that matches, and write one
`rule_executions` row per evaluation.

Conflict detection runs when a rule is saved. Two active rules conflict when they share
an `event_code`, their condition sets overlap, and they carry the same `action_type`.
Same `priority` is an error; different `priority` is a warning, since priority resolves
the order. Overlap is a numeric range intersection for `>`, `<` and `between`, and a set
intersection for `=` and `in`.

## Testing

- `pytest` per module under `tests/`, covering CRUD, permission denial, group
  resolution, rule matching, and conflict detection.
- Vitest per frontend module under `tests/`.
- `scripts/verify_live.py` performs a real insert and select against `SCM_REBUILD` for
  every new table and widened column.

The live check is not optional. `conftest` builds the test schema from `Base.metadata`
rather than from migrations, so pytest stayed green while the live application returned
500 with "Unknown column" the last time the schemas drifted.

## Deliverables

- One Alembic migration, plus a plain `.sql` DDL file the DB team applies to live.
- Seed data for every master so other developers can integrate immediately.
- `docs/API_MASTERS_AND_RULES.md` documenting the masters lookups and the rules engine
  event / condition / action schema.

## Sequence

1. `mst_locations`, stock-ledger widen, seed — unblocks the Inventory and Warehouse
   developers.
2. User groups, admin user management, the eight-tab Masters screen.
3. Rules engine tables, `fire()` API, contract doc, document-numbering GUI, UOM
   conversions.
4. Rules-builder GUI, audit log, notification settings, HRMS sync configuration.

## Risks

- Widening `stk_stock` is DDL against live data. No other developer is writing to it
  yet, so the migration lands cleanly now; later it needs a manual backfill.
- `sys_doc_series.reset_policy` and the `stk_` widen touch a DB-team-owned schema.
  This design generates the `.sql`; someone with access runs it.
- Dynamic group membership over ~2,800 employees needs the resolution query indexed on
  `role_id`, `position_id` and `location_id`, or the Admin group screen degrades.
