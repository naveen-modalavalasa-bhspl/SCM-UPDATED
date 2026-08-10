"""Put the database on the new HCM org and nothing else. DESTRUCTIVE. Idempotent.

Run:  .venv/Scripts/python -m scripts.hcm_clean_slate

`hcm_cutover` switches the mirror over but leaves both generations in place — the old
positions merely deactivated, and every indent, approval and stock movement still
hanging off people HCM has re-keyed. That is fine for a migration and useless for a
test: half the screens read a name that no longer resolves.

This goes further. It DELETES:

* every transactional document — indents, approvals, allocations, stock, receipts,
  issues, dispatches, notifications, audit rows. All of it is tagged to an employee
  or a warehouse from the old org.
* the workflow CONFIG as well (`wf_workflows`/`wf_stages`), because a ladder rung is
  an HCM role id and every one of those is dead. The engine's fallback covers a
  missing workflow (rule 8), so documents still route while the ladders are rebuilt.
* the mirror rows the current feed does not serve.

It KEEPS masters (`mst_`), RBAC, the rule engine's definitions and settings: none of
them name an employee.

Then it rebuilds what the app needs to be usable:

* one warehouse per office that holds an LIP or MDP position — the stocking points
  the new feed describes and the old one could not.
* `inv_position_locations` joining each of those positions to its warehouse.
* a credential for every active employee, all on the same password. This is a TEST
  password on a test database; do not run this against anything real.
"""
import asyncio

from sqlalchemy import delete, func, select, text

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.client import HcmClient
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.settings.models import UserCredential
from app.shared.enums import WarehouseType
from app.shared.models.warehouse import Warehouse

TEST_PASSWORD = "Bavya@123"

# Employee ids at or above this are minted locally, not mirrored from HCM, and the
# prune below leaves them alone. See scripts.create_admin_login.
LOCAL_ID_FLOOR = 900000

# Ordered children-first so the FKs inside a module never block the delete. Everything
# here is a document or a log; nothing here is configuration a human typed.
WIPE = [
    # approvals
    "wf_pending", "wf_actions", "wf_instances", "wf_delegations",
    "wf_stage_conditions", "wf_stages", "wf_workflows",
    # indents
    "ind_indent_items", "ind_indents",
    # inventory documents
    "inv_allocation_items", "inv_allocations", "inv_reservations",
    "inv_material_request_items", "inv_material_requests",
    "inv_adjustment_items", "inv_adjustments", "inv_sto_items", "inv_sto",
    "inv_cycle_count_items", "inv_cycle_counts", "inv_position_locations",
    # stock itself — every balance and ledger row points at a warehouse that is
    # about to be replaced, and stk_ledger is append-only, so it cannot be corrected
    "stk_audit_items", "stk_audits", "stk_transfer_items", "stk_transfers",
    "stk_reservations", "stk_ledger", "stk_batches", "stk_balance",
    # warehouse documents
    "inb_inspection_items", "inb_inspections", "inb_receipt_items", "inb_receipts",
    "out_dispatch_events", "out_dispatch_items", "out_dispatch_packages",
    "out_dispatches", "out_picking_items", "out_picking", "out_issue_items",
    "out_issues",
    "whs_serial_numbers", "whs_warehouse_items", "whs_warehouse_storage_types",
    "whs_warehouse_locations", "whs_warehouses",
    # procurement / logistics are already empty, but a rerun must not leave a stray
    "pro_po_items", "pro_purchase_orders", "pro_return_items", "pro_returns",
    "pro_quotation_items", "pro_quotations", "pro_rfq_vendors", "pro_rfq_items",
    "pro_rfqs", "pro_requisition_items", "pro_requisitions",
    "trn_trip_stops", "trn_trips",
    "fin_invoice_items", "fin_invoices", "fin_ledger",
    # trails and noise
    "rule_executions", "sys_notifications", "sys_audit_log", "sys_app_logs",
    "sys_attachments", "sys_sessions",
]

# Section name -> the kind of stocking point that section's positions serve. HCM keeps
# exactly one section per rung; anything else ("104 sec") is ordinary org structure.
#
# Matched on letters only. HCM types these by hand and has already shipped both "M.D.P"
# and "M.D.P." — a lookup on the exact string silently found zero MDP positions the day
# a full stop appeared, and built no MDP stocking points at all.
SECTION_TIER = {
    "LIP": WarehouseType.LIP.value,
    "MDP": WarehouseType.MDP.value,
}

# HCM's own `office_type`, likewise hand-typed ("ware house"), for offices that ARE a
# store rather than a rung on the distribution chain.
WAREHOUSE_OFFICE_TYPE = "WAREHOUSE"


def _letters(value: str | None) -> str:
    return "".join(ch for ch in (value or "").upper() if ch.isalpha())


async def wipe_documents(db) -> None:
    await db.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
    for table in WIPE:
        await db.execute(text(f"DELETE FROM {table}"))
    await db.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
    await db.commit()
    print(f"wiped {len(WIPE)} document tables")


async def prune_mirror(db, live: dict[str, set[int]]) -> None:
    """Drop mirror rows the current feed does not serve. Nothing points at them any
    more — the documents that did were deleted above."""
    for model, key in ((HcmPositionAssignment, "positions"), (HcmPosition, "positions"),
                       (HcmEmployee, "employees"), (HcmOffice, "offices"),
                       (HcmDepartment, "departments")):
        ids = live[key]
        column = (HcmPositionAssignment.position_id
                  if model is HcmPositionAssignment else model.id)
        where = column.notin_(ids)
        if model is HcmEmployee:
            # Accounts minted locally live above the HCM id space (scripts.
            # create_admin_login) and must survive a prune — HCM will never list them.
            where = where & (column < LOCAL_ID_FLOOR)
        removed = (await db.execute(
            delete(model).where(where)
            .execution_options(synchronize_session=False)
        )).rowcount
        print(f"  pruned {removed:>5} from {model.__tablename__}")
    await db.commit()


async def build_stocking_points(db) -> None:
    """One warehouse per office that holds an LIP or MDP position, plus the
    position -> warehouse rows the allocator reads.

    Keyed on the office, not the position: two store keepers (the DEO and the driver)
    share one vehicle, and that vehicle is one place stock sits, not two.
    """
    all_positions = (await db.execute(
        select(HcmPosition.section_name, HcmPosition.office_id, HcmPosition.id,
               HcmPosition.project_id, HcmPosition.project_name)
        .where(HcmPosition.is_active.is_(True))
    )).all()
    rows = [(SECTION_TIER[_letters(r.section_name)], *r[1:]) for r in all_positions
            if _letters(r.section_name) in SECTION_TIER]

    offices = {o.id: (o.name, o.office_mode) for o in (await db.execute(
        select(HcmOffice.id, HcmOffice.name, HcmOffice.office_mode)
    )).all()}

    # Rebuilt from scratch every run: HCM re-keys its offices and positions on every
    # rebuild, so yesterday's rows point at ids that no longer exist. Only the ones
    # this script derives are dropped — a warehouse someone created by hand stays.
    derived = (await db.execute(
        select(Warehouse.id).where(Warehouse.code.regexp_match("^(LIP|MDP|WH)-[0-9]+$"))
    )).scalars().all()
    if derived:
        await db.execute(delete(PositionLocation)
                         .where(PositionLocation.warehouse_id.in_(derived)))
        await db.execute(delete(Warehouse).where(Warehouse.id.in_(derived)))
        await db.flush()

    warehouses: dict[int, Warehouse] = {}

    def add(office_id: int, kind: str, prefix: str | None = None) -> None:
        if office_id is None or office_id in warehouses:
            return
        name, _mode = offices.get(office_id, (str(office_id), None))
        warehouses[office_id] = Warehouse(
            code=f"{prefix or kind}-{office_id}",
            name=f"{name} - {prefix or kind}",
            office_id=office_id,
            office_name=offices.get(office_id, (None, None))[0],
            warehouse_type=kind,
            is_bin_managed=False,
            is_active=True,
        )

    for kind, office_id, _, _, _ in rows:
        add(office_id, kind)
    # An office HCM marks as a store is a stocking point in its own right, whether or
    # not anybody is posted to it yet.
    for office_id, (_name, mode) in offices.items():
        if _letters(mode) == WAREHOUSE_OFFICE_TYPE:
            # MAIN, not a rung: a store is where stock enters from outside, which is
            # exactly what locations.tier_of() reads the top of the chain as.
            add(office_id, WarehouseType.MAIN.value, prefix="WH")
    db.add_all(warehouses.values())
    await db.flush()

    for _, office_id, position_id, project_id, project_name in rows:
        warehouse = warehouses.get(office_id)
        if warehouse is None:
            continue
        db.add(PositionLocation(
            position_id=position_id,
            warehouse_id=warehouse.id,
            project_id=project_id or 0,
            project_name=project_name,
            is_primary=1,
            is_active=1,
        ))
    await db.commit()

    by_type = (await db.execute(
        select(Warehouse.warehouse_type, func.count(Warehouse.id))
        .group_by(Warehouse.warehouse_type)
    )).all()
    print(f"  built {len(warehouses)} warehouses {dict(by_type)}, "
          f"{len(rows)} position locations")


async def reset_credentials(db) -> None:
    """One password for every active employee. Test data, stated as such."""
    await db.execute(delete(UserCredential))
    digest = hash_password(TEST_PASSWORD)      # hashed once; bcrypt is deliberately slow
    ids = (await db.execute(
        select(HcmEmployee.id).where(HcmEmployee.is_active.is_(True))
    )).scalars().all()
    db.add_all(UserCredential(employee_id=i, password_hash=digest, must_change=False)
               for i in ids)
    await db.commit()
    print(f"  issued {len(ids)} credentials, all '{TEST_PASSWORD}'")


async def main() -> None:
    client = HcmClient()
    print(f"HCM: {client.base_url}")
    live = {
        "positions": {r["id"] for r in await client.fetch_all("positions") if r.get("id")},
        "employees": {r["id"] for r in await client.fetch_all("employees") if r.get("id")},
        "offices": {r["id"] for r in await client.fetch_all("offices") if r.get("id")},
        "departments": {r["id"] for r in await client.fetch_all("departments") if r.get("id")},
    }
    if not all(live.values()):
        raise RuntimeError("HCM returned an empty feed — refusing to prune the mirror")
    print({k: len(v) for k, v in live.items()})

    async with SessionLocal() as db:
        await wipe_documents(db)
        await prune_mirror(db, live)
        await build_stocking_points(db)
        await reset_credentials(db)
    print("\nclean slate ready")


if __name__ == "__main__":
    asyncio.run(main())
