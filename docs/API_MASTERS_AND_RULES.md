# Masters & Rules Engine — API for module developers

For the Inventory and Warehouse developers. Everything below is live on the running
backend; interactive docs are at `/docs`.

All list endpoints return `{items, total, page, size}` and accept `?page=&size=`
(size max 100). All errors return `{"success": false, "error": "<message>"}` with the
status code. Every request needs `Authorization: Bearer <token>` from
`POST /api/auth/login`.

---

## 1. Masters lookups

Reading any master needs only a valid login — every module's dropdowns depend on them.
Writing needs the master's own permission.

| Path | Manage permission | Notes |
| --- | --- | --- |
| `/api/items` | `master.item.manage` | `?search=` matches name or code |
| `/api/item-categories` | `master.category.manage` | tree via `parent_id`; `level` is derived |
| `/api/uom` | `master.uom.manage` | unpaginated, returns `{items}` |
| `/api/uom-conversions` | `master.uom.manage` | unpaginated |
| `/api/warehouses` | `master.location.manage` | `whs_warehouses` |
| `/api/bins` | `master.location.manage` | `whs_bins`; `path`/`level` derived |
| `/api/projects` | `master.project.manage` | `mst_projects` |
| `/api/vendors` | `master.vendor.manage` | |
| `/api/departments` | — | read-only HCM mirror |
| `/api/facilities` | — | read-only HCM mirror |
| `/api/admin/roles` | — | read-only role list |

Each of the first eight supports the same four verbs:

```
GET    /api/<master>?search=&page=&size=&include_inactive=false
POST   /api/<master>            -> the created row
PUT    /api/<master>/{id}       -> the updated row
DELETE /api/<master>/{id}       -> {"success": true, "id": n, "is_active": false}
```

`DELETE` **deactivates**; it never removes the row. Documents snapshot master names but
still carry the id, so a hard delete would orphan them. Deactivated rows disappear from
the default list and come back with `?include_inactive=true`.

### Snapshots

Masters copy their parent's display fields onto the row at write time — `item.uom_code`,
`item.category_name`, `warehouse.facility_name`, `bin.path`. Read them straight off the
row: a list screen should not need a join per line.

### Items

```jsonc
// GET /api/items?search=bolt&size=20
{"items": [{
  "id": 31, "code": "101010-0039", "name": "Hex Bolt M8",
  "short_name": "HEX M8", "category_id": 10, "category_name": "Fasteners",
  "uom_id": 3, "uom_code": "PCS", "item_type": "CONSUMABLE",
  "hsn_code": "7318", "tax_percent": 18.0,
  "is_batch_tracked": false, "is_serial_tracked": false, "is_active": true
}], "total": 1, "page": 1, "size": 20}
```

**Items are project-agnostic by design.** There is no `project_id` on `mst_items`.
Ownership lives on the stock ledger so stock can move between projects without editing
the item master.

### Warehouses and bins

`whs_warehouses` is the stocking point; `whs_bins` nests inside it through `parent_id`.
`path` and `level` are computed from the parent on save — do not send them.

```jsonc
// POST /api/bins
{"warehouse_id": 1, "code": "A-01", "name": "Rack 1",
 "bin_type": "RACK", "parent_id": 1}
// -> {"id": 2, "path": "A/A-01", "level": 2, ...}
```

`warehouse_type`: `MAIN | TRANSIT | QUARANTINE | SCRAP`.
`bin_type`: `ZONE | RACK | SHELF | STORAGE | STAGING`.
Both trees reject a parent that would create a loop, with a 400.

### Stock

`stk_balance` is keyed **item + warehouse + bin + batch + project**; `stk_ledger` is
append-only. `bin_id`, `batch_id` and `project_id` use `0` for "not set" rather than
NULL, because MySQL allows repeated NULLs inside a unique index.

```
GET /api/stock?item_id=&warehouse_id=&project_id=&bin_id=
GET /api/stock/movements?item_id=
```

Change stock **only** through `logistics.service.move_stock()` (CLAUDE.md rule 7).
Never assign a quantity directly, and never update or delete a ledger row.

```python
from app.modules.logistics import service as stock

await stock.move_stock(
    db, item_id=42, qty=10, direction=StockDirection.IN.value,
    ref_type=RefType.GRN.value, ref_id=grn.id, ref_no=grn.grn_no, user=user,
    warehouse_id=1,        # or facility_id=..., which resolves to its warehouse
    bin_id=0, batch_id=0, project_id=0,
)

# Moving between projects or warehouses: two balanced ledger rows, item master untouched.
await stock.transfer_stock(
    db, item_id=42, qty=10, user=user,
    from_warehouse_id=1, to_warehouse_id=2,
    from_project_id=0, to_project_id=7,
)
```

---

## 2. Rules engine

A business rule is rows, not a branch in code: **event → conditions → actions**. Adding
a rule is an insert, so routing changes without a deploy. The engine covers approval
routing *and* fulfillment routing.

### Firing an event from your module

This is the only call you need:

```python
from app.platform.rules import fire, actions_of_type

actions = await fire(
    db, "INDENT_SUBMITTED",
    {"indent_id": 42, "category_code": "CONSUMABLE", "quantity": 150,
     "requester_position_id": 7, "warehouse_id": 3, "project_id": 0},
    doc_type="INDENT", doc_id=42,
)

for a in actions_of_type(actions, RuleActionType.ROUTE_FULFILLMENT.value):
    target = a.params["target"]      # INVENTORY | WAREHOUSE | PROCUREMENT
```

`fire()` returns `list[Action]`, each with `.action_type`, `.params`, `.rule_id`,
`.rule_name`. It writes one `rule_executions` row per call **even when nothing matched**,
because "no rule covered this" is the case you will actually need to debug.

**The engine decides what should happen; it does not do it.** Carrying out a
`ROUTE_APPROVAL` belongs to the workflow engine (rule 8) and setting a document's status
belongs to the module that owns the document (rule 2). Read the actions and act on them.

### Registered events

`GET /api/rules/events` returns the catalogue plus the valid operators, logics and
action types — that is what the admin GUI builds its editor from.

| Event | Context fields |
| --- | --- |
| `INDENT_SUBMITTED` | indent_id, indent_no, category_code, item_id, quantity, estimated_value, requester_id, requester_position_id, department_id, warehouse_id, project_id, priority |
| `INDENT_APPROVED` | indent_id, indent_no, quantity, estimated_value, warehouse_id, project_id |
| `PO_SUBMITTED` | po_id, po_no, vendor_id, total_amount, buyer_id, department_id |
| `GRN_RECEIVED` | grn_id, po_id, warehouse_id, item_id, accepted_quantity |
| `STOCK_BELOW_THRESHOLD` | item_id, item_code, warehouse_id, project_id, available_qty, reorder_level |

Need a new event? Insert a `rule_events` row with its `context_schema`, then fire it.
`create_rule` rejects an unregistered event code, so the catalogue cannot drift from
what the code actually sends.

### Rule shape

```jsonc
// POST /api/rules      (permission: admin.rules.manage)
{
  "event_code": "INDENT_SUBMITTED",
  "name": "Bulk consumables go to the warehouse",
  "priority": 100,                 // lower runs first
  "stop_on_match": false,          // true = no later rule is evaluated
  "is_active": true,
  "effective_from": null, "effective_to": null,
  "conditions": [
    {"field_name": "quantity",      "operator": "GT", "field_value": "100", "logic": "AND"},
    {"field_name": "category_code", "operator": "EQ", "field_value": "CONSUMABLE", "logic": "AND"}
  ],
  "actions": [
    {"seq": 1, "action_type": "ROUTE_FULFILLMENT", "params": {"target": "WAREHOUSE"}},
    {"seq": 2, "action_type": "ROUTE_APPROVAL",    "params": {"workflow_code": "WF_INDENT_HIGH"}}
  ],
  "force": false
}
```

**Operators** — `EQ, NEQ, GT, GTE, LT, LTE, IN, NOT_IN, BETWEEN`.
`IN`/`NOT_IN` take a comma-separated list; `BETWEEN` takes `"lo,hi"`.
Conditions combine left to right, each using its own `logic`. No conditions means the
rule always matches.

**Action types**

| Type | Params | Meaning |
| --- | --- | --- |
| `ROUTE_APPROVAL` | `workflow_code` | start that approval workflow |
| `ROUTE_FULFILLMENT` | `target` | `INVENTORY` \| `WAREHOUSE` \| `PROCUREMENT` |
| `SPLIT_FULFILLMENT` | `targets` | comma-separated, fulfil from several |
| `NOTIFY` | `recipient` | role or group code |
| `SET_FIELD` | `value` | `field=value` on the document |

### Conflict detection

Checked on every save. Two rules conflict when they share an event, their conditions can
both be true at once, and they carry the same `action_type` with different params.

- **Same priority → 400.** Which rule wins would be arbitrary. Resend with
  `"force": true` to override deliberately.
- **Different priority → saved, returned in `warnings[]`.** Priority is a deliberate
  answer to the overlap.

Overlap is decided per field: numeric range intersection for `GT/LT/BETWEEN`, set
intersection for `EQ/IN`. Exclusions (`NEQ`, `NOT_IN`) and `OR` are open-ended, so the
check treats them as overlapping rather than wrongly clearing the pair.

```
POST /api/rules/check-conflicts?rule_id=  -> {"conflicts": [...]}   // before saving
POST /api/rules/simulate                  -> {"matched": bool, "actions": [...]}
GET  /api/rules/executions?event_code=&doc_id=                      // history
```

`simulate` is a dry run: it records nothing and touches no document.

---

## 3. Admin

| Path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/admin/users?search=&with_access=` | `admin.users.manage` | browse HCM employees, see who can sign in |
| `POST /api/admin/users/grant` | `admin.users.manage` | give an employee a login; returns a one-time password |
| `DELETE /api/admin/users/{id}/access` | `admin.users.manage` | revoke and end live sessions |
| `PUT /api/admin/users/{id}/roles` | `admin.users.manage` | replace that employee's roles |
| `GET/POST/PUT/DELETE /api/admin/groups` | `admin.groups.manage` | user groups |
| `GET /api/admin/groups/{id}/members` | — | resolved membership |
| `GET/POST/PUT/DELETE /api/admin/doc-series` | `admin.numbering.manage` | numbering |
| `GET /api/admin/audit?entity=&action=` | `admin.audit.view` | audit log |
| `GET/POST/PUT/DELETE /api/admin/notifications` | `admin.notifications.manage` | who gets told |
| `GET/PUT /api/admin/hcm-schedule` | `admin.users.manage` | HRMS sync interval |

**There is no users table.** Identity is `hcm_employees`, a read-only mirror, plus
`sys_local_credentials`. "Creating a user" means granting an existing employee access.
Nothing here writes back to HCM.

**Group membership is derived, never stored** — from `role_id`, `position_id` or
`location_id` at query time, so an HRMS sync cannot leave a stale roster. A `LOCATION`
group is a sub-group: it intersects with its parent, so "Approvers" + "Chennai" means
the approvers in Chennai, not everyone in Chennai. `rbac_user_group_members` rows are an
additive override for exceptions.

### Document numbering

`pattern` accepts both `{PREFIX}/{FY}/{SEQ:5}` (the DB team's style) and
`{prefix}/{fy}/{num:04d}`; `{SEQ:5}` means pad to five digits. `reset_policy` is
`NEVER | YEARLY | MONTHLY`, and the reset happens under the same row lock as the
increment, so two documents at a period boundary cannot both take number 1.
`last_number` is deliberately not editable through the API — rewinding it would reissue
a number a live document already carries. Every series returns a server-rendered
`preview` of the next number.

---

## 4. Rules that apply to your code too

1. Every endpoint carries `Depends(require_permission("<code>"))`. Hiding a button is
   not security. Permission codes live only in `platform/rbac/permissions.py`.
2. Never write a raw status string — use the enum in `app/shared/enums.py`.
3. Stock changes only through `move_stock()`; `stk_ledger` is append-only.
4. Approvals only through `platform/workflow/engine.py`.
5. `hcm_*` tables are read-only, written only by `platform/hcm/sync.py`.
6. **Map only the columns your model actually uses.** The live schema is the DB team's,
   and a mapped column the table lacks makes every `SELECT` on that model fail with
   error 1054. `conftest` builds the test schema from `Base.metadata`, so pytest cannot
   catch this. Run the checker instead:

   ```
   .venv/Scripts/python -m scripts.apply_admin_masters --check
   ```

   It compares every mapped model against the live database and names any mismatch.
