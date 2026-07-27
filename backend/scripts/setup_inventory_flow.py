"""Make the indent -> inventory flow usable on a real database. Idempotent.

Run:  .venv/Scripts/python -m scripts.setup_inventory_flow

Does four things, none of which belong in the demo seed:

1. Seeds the rule_events catalogue. Without these rows the admin Rules screen offers
   a free-text box instead of a field list, so every rule anyone writes silently
   never matches.
2. Creates LIP and MDP warehouses so routing has somewhere to route to.
3. Grants the new allocation / material-request permissions to the roles that need
   them, including every HCM-sourced role, since those are the real ones.
4. Registers document series for ALLOCATION and MR so the numbers look deliberate
   rather than falling back to the auto-created default.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Permission, Role, RolePermission
from app.platform.rules.models import RuleEvent
from app.platform.settings.models import DocSeries
from app.shared.enums import WarehouseType
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import DEFAULT_PATTERN, _fiscal_year

# (code, name, module, description, context_schema)
RULE_EVENTS = [
    ("INDENT_APPROVED", "Indent approved", "indents",
     "Fires when an indent clears its approval chain and reaches inventory",
     {"indent_id": "number", "department_id": "number", "project_id": "number",
      "total_qty": "number", "priority": "text"}),
    ("ALLOCATION_APPROVED", "Stock allocation approved", "inventory",
     "Fires when inventory's decision on how much to give is approved",
     {"allocation_id": "number", "indent_id": "number", "given_qty": "number"}),
    ("INDENT_SHORT", "Indent short of stock", "inventory",
     "Fires when an allocation gives less than the indent asked for",
     {"indent_id": "number", "short_lines": "number"}),
    ("MR_RAISED", "Material request raised", "inventory",
     "Fires when a shortfall becomes a material request for procurement",
     {"mr_id": "number", "indent_id": "number"}),
]

# code, name, type
WAREHOUSES = [
    ("LIP-CENTRAL", "Local Inventory Point — Central", WarehouseType.LIP.value),
    ("MDP-SOUTH", "Material Distribution Point — South", WarehouseType.MDP.value),
]

# Everyone who touches stock needs to see it; deciding and approving are narrower.
STOCK_VIEWERS = [P.STOCK_VIEW, P.MR_VIEW, P.ALLOCATION_VIEW]
ALLOCATORS = [P.STOCK_RESERVE, P.STOCK_TRANSFER, P.ALLOCATION_CREATE]
ALLOCATION_APPROVERS = [P.ALLOCATION_APPROVE, P.ALLOCATION_REJECT,
                        P.MR_APPROVE, P.MR_REJECT]

DOC_SERIES = [("allocation", "ALC"), ("mr", "MR")]


async def _permission_id(db, code: str) -> int | None:
    return (await db.execute(
        select(Permission.id).where(Permission.code == code))).scalars().first()


async def main() -> None:
    async with SessionLocal() as db:
        # 1. rule events
        for code, name, module, desc, schema in RULE_EVENTS:
            row = (await db.execute(
                select(RuleEvent).where(RuleEvent.code == code))).scalar_one_or_none()
            if row is None:
                db.add(RuleEvent(code=code, name=name, module=module,
                                 description=desc, context_schema=schema,
                                 is_active=True))
                print(f"  rule event {code}")
            else:
                row.name, row.module, row.description = name, module, desc
                row.context_schema, row.is_active = schema, True
        await db.flush()

        # 2. LIP / MDP
        for code, name, wtype in WAREHOUSES:
            row = (await db.execute(
                select(Warehouse).where(Warehouse.code == code))).scalar_one_or_none()
            if row is None:
                db.add(Warehouse(code=code, name=name, warehouse_type=wtype,
                                 is_active=True))
                print(f"  warehouse {code} ({wtype})")
        await db.flush()

        # 3. permissions. Every active role gets read access -- a storekeeper who
        #    cannot see stock cannot do their job -- while the decision and its
        #    approval stay with inventory and admin roles.
        roles = (await db.execute(select(Role).where(Role.is_active.is_(True)))).scalars().all()
        granted = 0
        for role in roles:
            wanted = list(STOCK_VIEWERS)
            code = (role.code or "").upper()
            if any(k in code for k in ("STORE", "INVENTORY", "WAREHOUSE", "ADMIN")):
                wanted += ALLOCATORS
            if any(k in code for k in ("MANAGER", "ADMIN", "HEAD", "COO")):
                wanted += ALLOCATION_APPROVERS
            for perm_code in dict.fromkeys(wanted):
                pid = await _permission_id(db, perm_code)
                if pid is None:
                    continue
                exists = (await db.execute(select(RolePermission).where(
                    RolePermission.role_id == role.id,
                    RolePermission.permission_id == pid))).scalar_one_or_none()
                if exists is None:
                    db.add(RolePermission(role_id=role.id, permission_id=pid))
                    granted += 1
        print(f"  granted {granted} role-permissions across {len(roles)} roles")

        # 4. document series
        fy = _fiscal_year()
        for doc_type, prefix in DOC_SERIES:
            row = (await db.execute(select(DocSeries).where(
                DocSeries.doc_type == doc_type))).scalars().first()
            if row is None:
                db.add(DocSeries(doc_type=doc_type, fiscal_year=fy, prefix=prefix,
                                 pattern=DEFAULT_PATTERN, last_number=0,
                                 is_active=True))
                print(f"  doc series {doc_type} -> {prefix}")

        await db.commit()
        print("inventory flow ready")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
