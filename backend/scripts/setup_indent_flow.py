"""Define the three-step indent flow as DATA, and register it in the rules engine.

    .venv/Scripts/python.exe -m scripts.setup_indent_flow

    Raise indent -> Reporting manager approves -> Inventory checks stock
                 -> Warehouse packs

Data only. It writes wf_stages, rbac_role_permissions, rbac_user_roles and rule_*
rows. It creates no table and touches no inventory or warehouse code — those modules
belong to other developers.

Two engines are involved and they do different jobs:

  * platform/workflow drives the chain. It is already wired into
    indents/service.py, so adding a stage row genuinely changes how the app behaves.
  * platform/rules records WHY a document takes a path, and answers "who fulfils
    this". Nothing calls it yet, so its rows are documentation and a GUI surface
    until the inventory module calls rules.fire(). That call is one line, later.

Safe to re-run.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.rules.models import Rule, RuleAction, RuleCondition, RuleEvent
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import (
    ApprovalMode, ApproverType, DocType, FulfillmentTarget, RuleActionType,
    UserRole as RoleCode,
)

WORKFLOW_CODE = "WF-INDENT-REPORTING-MANAGER"

# (sequence, name, approver_type, role_code)
# Sequence 1 already exists and stays as it is: the requester's reporting manager,
# resolved from the position they had selected when they raised the indent.
STAGES = [
    (1, "Reporting Manager", ApproverType.REPORTING_MANAGER.value, None),
]

# Removed 2026-07-26, and deliberately not replaced:
#
#   (2, "Inventory — stock check", ROLE, "STORE")
#   (3, "Warehouse — packing",     ROLE, "storekeeper")
#
# Neither was a sign-off. Stage 2 was a placeholder for the availability check, which
# is now code that runs the instant approval completes (modules/inventory
# allocate_for_indent) — leaving it as an approval stage meant a real manager approved
# an indent and it then sat waiting on the demo seed user "Sunil Store", who is the
# only holder of the STORE role. Stage 3 is worse: packing is work someone does, not a
# decision someone signs.
#
# The inventory judgement — how much to give, from where — DOES need a human, but it
# is its own document, not a stage on the indent's chain. See
# docs/superpowers/specs/2026-07-26-allocation-is-a-decision-CHANGE.md.

# Everyone may raise an indent, so every role gets the requester permissions.
# approve/reject are also broad on purpose: the workflow engine decides who may
# actually act (act() rejects anyone not in wf_pending), so the permission only
# controls who may call the endpoint at all.
REQUESTER_PERMS = [P.INDENT_VIEW, P.INDENT_CREATE, P.INDENT_EDIT, P.INDENT_SUBMIT]
APPROVER_PERMS = [P.INDENT_VIEW, P.INDENT_APPROVE, P.INDENT_REJECT]


async def _permission_ids(db, codes: list[str]) -> list[int]:
    return list((await db.execute(
        select(Permission.id).where(Permission.code.in_(codes))
    )).scalars().all())


async def _grant(db, role: Role, permission_ids: list[int]) -> int:
    """The caller passes overlapping lists (INDENT_VIEW is in both), and the primary
    key is (role_id, permission_id), so the incoming ids are de-duplicated too — not
    just checked against what the role already holds."""
    held = set((await db.execute(
        select(RolePermission.permission_id)
        .where(RolePermission.role_id == role.id)
    )).scalars().all())
    added = 0
    for permission_id in dict.fromkeys(permission_ids):
        if permission_id not in held:
            db.add(RolePermission(role_id=role.id, permission_id=permission_id))
            held.add(permission_id)
            added += 1
    return added


async def setup_stages(db) -> None:
    workflow = (await db.execute(
        select(Workflow).where(Workflow.code == WORKFLOW_CODE)
    )).scalars().first()
    if workflow is None:
        raise SystemExit(f"Workflow {WORKFLOW_CODE} not found — run "
                         f"scripts.provision_employee_portal first.")

    print(f"Workflow {workflow.code} (doc_type={workflow.doc_type})")
    for sequence, name, approver_type, role_code in STAGES:
        role = None
        if role_code:
            role = (await db.execute(
                select(Role).where(Role.code == role_code)
            )).scalars().first()
            if role is None:
                print(f"  ! role {role_code} missing, skipping stage {sequence}")
                continue

        stage = (await db.execute(
            select(Stage).where(Stage.workflow_id == workflow.id,
                                Stage.sequence == sequence)
        )).scalars().first()
        if stage is None:
            stage = Stage(workflow_id=workflow.id, sequence=sequence)
            db.add(stage)
            verb = "+ added"
        else:
            verb = "= updated"
        stage.name = name
        stage.approver_type = approver_type
        stage.role_id = role.id if role else None
        stage.approval_mode = ApprovalMode.ANY_ONE.value
        stage.is_optional = False
        print(f"  {verb} stage {sequence}: {name}"
              f"{f' (role {role_code})' if role_code else ''}")
    await db.flush()


async def setup_permissions(db) -> None:
    """Give every role requester access without turning REQUESTER into an approver."""
    requester_ids = await _permission_ids(db, REQUESTER_PERMS)
    approver_ids = await _permission_ids(db, APPROVER_PERMS)
    roles = (await db.execute(select(Role).where(Role.is_active.is_(True)))).scalars().all()

    total = 0
    for role in roles:
        granted_ids = requester_ids
        if role.code != RoleCode.REQUESTER.value:
            granted_ids = requester_ids + approver_ids
        total += await _grant(db, role, granted_ids)
        if role.code == RoleCode.REQUESTER.value:
            stale = list((await db.execute(
                select(RolePermission).where(
                    RolePermission.role_id == role.id,
                    RolePermission.permission_id.in_(approver_ids),
                )
            )).scalars().all())
            for row in stale:
                await db.delete(row)
    print(f"  + {total} role-permission links added across {len(roles)} roles")
    await db.flush()


async def ensure_role_holder(db, role_code: str, employee_id: int) -> None:
    """A ROLE stage resolves through rbac_user_roles, so the role needs a holder.

    Without this the stage would have no approver and the document would stall.
    """
    role = (await db.execute(
        select(Role).where(Role.code == role_code))).scalars().first()
    if role is None:
        print(f"  ! role {role_code} missing")
        return
    existing = (await db.execute(
        select(UserRole).where(UserRole.role_id == role.id,
                               UserRole.employee_id == employee_id)
    )).scalars().first()
    if existing is None:
        db.add(UserRole(employee_id=employee_id, role_id=role.id))
        print(f"  + employee {employee_id} now holds {role_code}")
    else:
        print(f"  = employee {employee_id} already holds {role_code}")
    await db.flush()


async def setup_rules(db) -> None:
    """Mirror the flow in the rules engine so it is visible and editable in the GUI.

    These rows change nothing on their own — no module calls rules.fire() yet. They
    exist so the routing decision lives in one place the moment inventory wires it up.
    """
    event = await db.get(RuleEvent, "INDENT_APPROVED")
    if event is None:
        print("  ! rule event INDENT_APPROVED missing")
        return

    existing = (await db.execute(
        select(Rule).where(Rule.event_code == "INDENT_APPROVED",
                           Rule.name == "Fulfil approved indents from the warehouse")
    )).scalars().first()
    if existing is not None:
        print("  = fulfilment rule already present")
        return

    rule = Rule(
        event_code="INDENT_APPROVED",
        name="Fulfil approved indents from the warehouse",
        description=("Once every approval stage is done, the warehouse picks and "
                     "packs. Change the target here to send work elsewhere."),
        priority=100, is_active=True,
    )
    db.add(rule)
    await db.flush()
    db.add(RuleAction(
        rule_id=rule.id, seq=1,
        action_type=RuleActionType.ROUTE_FULFILLMENT.value,
        params={"target": FulfillmentTarget.WAREHOUSE.value},
    ))

    # A second rule showing how the path can differ by value. Higher priority runs
    # first and stops, so large indents go to procurement instead of the shelf.
    big = Rule(
        event_code="INDENT_APPROVED",
        name="Large indents go to procurement instead",
        description="Over 100 units, buy rather than issue from stock.",
        priority=50, stop_on_match=True, is_active=False,
    )
    db.add(big)
    await db.flush()
    db.add(RuleCondition(rule_id=big.id, field_name="quantity",
                         operator="GT", field_value="100", logic="AND"))
    db.add(RuleAction(rule_id=big.id, seq=1,
                      action_type=RuleActionType.ROUTE_FULFILLMENT.value,
                      params={"target": FulfillmentTarget.PROCUREMENT.value}))
    print("  + 2 fulfilment rules registered (the second is inactive, as an example)")
    await db.flush()


async def main() -> None:
    async with SessionLocal() as db:
        print("Stages")
        await setup_stages(db)
        print("\nPermissions")
        await setup_permissions(db)
        print("\nRole holders for the ROLE stages")
        # Sunil Store already holds STORE; storekeeper needs a real holder so the
        # warehouse stage resolves to somebody.
        await ensure_role_holder(db, "STORE", 900005)
        await ensure_role_holder(db, "storekeeper", 900004)
        print("\nRules engine")
        await setup_rules(db)
        await db.commit()
    print("\nDone. Raise an indent to walk the chain.")


if __name__ == "__main__":
    asyncio.run(main())
