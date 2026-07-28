"""The most important tests in the system: the engine and the resolver.

Covers a 3-stage flow, a conditional stage skipped/included, rejection at stage 2,
an ALL-mode stage with two approvers, and every resolver approver_type + delegation.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.core.exceptions import PermissionError_, ValidationError
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import Role, UserRole
from app.platform.workflow import engine, fallback, resolver
from app.platform.workflow.models import (
    Action, Delegation, Instance, Pending, Stage, StageCondition, Workflow,
)
from app.shared.enums import (
    ApprovalAction, ApproverType, ApprovalMode, ConditionOperator, InstanceStatus,
)
from app.shared.models.base import utcnow


async def _emp(db, id, name="Emp", position_id=None):
    e = HcmEmployee(id=id, full_name=f"{name}{id}", emp_code=f"E{id}",
                    is_active=True, synced_at=utcnow())
    db.add(e)
    await db.flush()
    if position_id is not None:
        db.add(HcmPositionAssignment(
            id=10_000 + id, employee_id=id, position_id=position_id,
            is_active=True, is_primary=True, synced_at=utcnow(),
        ))
        await db.flush()
    return e


async def _workflow(db, doc_type, stages):
    """stages = list of approver configuration dictionaries."""
    wf = Workflow(code=f"WF_{doc_type}", name=doc_type, doc_type=doc_type, is_active=True)
    db.add(wf)
    await db.flush()
    made = []
    for s in stages:
        stage = Stage(
            workflow_id=wf.id, sequence=s["seq"], name=s.get("name", f"S{s['seq']}"),
            approver_type=s["approver_type"], approval_mode=s.get("mode", ApprovalMode.ANY_ONE.value),
            position_id=s.get("position_id"), role_id=s.get("role_id"),
            employee_id=s.get("employee_id"),
        )
        db.add(stage)
        await db.flush()
        for c in s.get("conditions", []):
            db.add(StageCondition(
                stage_id=stage.id, field_name=c[0], operator=c[1],
                field_value=str(c[2]),
            ))
        made.append(stage)
    await db.flush()
    return wf, made


# ---------------- engine ----------------

async def test_three_stage_specific_user_flow(db):
    e1, e2, e3, e4 = [await _emp(db, i) for i in (1, 2, 3, 4)]
    await _workflow(db, "INDENT", [
        {"seq": 1, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e2.id},
        {"seq": 2, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e3.id},
        {"seq": 3, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e4.id},
    ])

    inst = await engine.start(db, "INDENT", 100, {}, e1)
    assert inst.status == InstanceStatus.IN_PROGRESS.value
    assert inst.current_sequence == 1

    # wrong approver at stage 1 is rejected
    with pytest.raises(PermissionError_):
        await engine.act(db, "INDENT", 100, "APPROVE", e3)

    await engine.act(db, "INDENT", 100, "APPROVE", e2)
    assert (await engine._load_instance(db, "INDENT", 100)).current_sequence == 2
    await engine.act(db, "INDENT", 100, "APPROVE", e3)
    assert (await engine._load_instance(db, "INDENT", 100)).current_sequence == 3
    final = await engine.act(db, "INDENT", 100, "APPROVE", e4)
    assert final.status == InstanceStatus.APPROVED.value

    hist = await engine.history(db, "INDENT", 100)
    assert [h.action for h in hist] == ["SUBMITTED", "APPROVED", "APPROVED", "APPROVED"]


async def test_conditional_stage_skipped_when_amount_low(db):
    e1, e2, e3 = [await _emp(db, i) for i in (1, 2, 3)]
    await _workflow(db, "PO", [
        {"seq": 1, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e2.id},
        {"seq": 2, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e3.id,
         "conditions": [("total_amount", ConditionOperator.GT.value, 500000)]},
    ])
    # amount below threshold -> stage 2 skipped -> approving stage 1 completes it
    inst = await engine.start(db, "PO", 1, {"total_amount": 100000}, e1)
    assert inst.current_sequence == 1
    final = await engine.act(db, "PO", 1, "APPROVE", e2)
    assert final.status == InstanceStatus.APPROVED.value


async def test_conditional_stage_included_when_amount_high(db):
    e1, e2, e3 = [await _emp(db, i) for i in (1, 2, 3)]
    await _workflow(db, "PO", [
        {"seq": 1, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e2.id},
        {"seq": 2, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e3.id,
         "conditions": [("total_amount", ConditionOperator.GT.value, 500000)]},
    ])
    await engine.start(db, "PO", 2, {"total_amount": 600000}, e1)
    context = {"total_amount": 600000}
    mid = await engine.act(db, "PO", 2, "APPROVE", e2, context=context)
    assert mid.status == InstanceStatus.IN_PROGRESS.value
    assert mid.current_sequence == 2
    final = await engine.act(db, "PO", 2, "APPROVE", e3, context=context)
    assert final.status == InstanceStatus.APPROVED.value


async def test_rejection_at_stage_two(db):
    e1, e2, e3 = [await _emp(db, i) for i in (1, 2, 3)]
    await _workflow(db, "INDENT", [
        {"seq": 1, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e2.id},
        {"seq": 2, "approver_type": ApproverType.SPECIFIC_USER.value, "employee_id": e3.id},
    ])
    await engine.start(db, "INDENT", 5, {}, e1)
    await engine.act(db, "INDENT", 5, "APPROVE", e2)
    final = await engine.act(db, "INDENT", 5, "REJECT", e3, comments="not needed")
    assert final.status == InstanceStatus.REJECTED.value


async def test_all_mode_needs_every_approver(db):
    e1 = await _emp(db, 1)
    a1, a2 = await _emp(db, 2), await _emp(db, 3)
    role = Role(code="APPROVERS", name="Approvers", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=a1.id, role_id=role.id))
    db.add(UserRole(employee_id=a2.id, role_id=role.id))
    await db.flush()
    await _workflow(db, "INDENT", [
        {"seq": 1, "approver_type": ApproverType.ROLE.value, "role_id": role.id,
         "mode": ApprovalMode.ALL.value},
    ])
    await engine.start(db, "INDENT", 9, {}, e1)
    mid = await engine.act(db, "INDENT", 9, "APPROVE", a1)
    assert mid.status == InstanceStatus.IN_PROGRESS.value   # still waiting on a2
    final = await engine.act(db, "INDENT", 9, "APPROVE", a2)
    assert final.status == InstanceStatus.APPROVED.value


async def test_single_reporting_manager_stage_climbs_to_final_top_pair(db):
    requester = await _emp(db, 50, "Pilot", position_id=1000)
    oe = await _emp(db, 51, "OE", position_id=1001)
    dm = await _emp(db, 52, "DM", position_id=1002)
    rm = await _emp(db, 53, "RM", position_id=1003)
    sph = await _emp(db, 54, "SPH", position_id=1004)
    coo = await _emp(db, 55, "COO", position_id=1005)
    db.add_all([
        HcmPosition(id=1000, name="Pilot", parent_position_id=1001,
                    synced_at=utcnow()),
        HcmPosition(id=1001, name="OE", parent_position_id=1002,
                    synced_at=utcnow()),
        HcmPosition(id=1002, name="DM", parent_position_id=1003,
                    synced_at=utcnow()),
        HcmPosition(id=1003, name="RM", parent_position_id=1004,
                    synced_at=utcnow()),
        HcmPosition(id=1004, name="SPH", parent_position_id=1005,
                    synced_at=utcnow()),
        HcmPosition(id=1005, name="COO", synced_at=utcnow()),
    ])
    await db.flush()
    for employee, position_id in (
        (requester, 1000), (oe, 1001), (dm, 1002), (rm, 1003), (sph, 1004), (coo, 1005),
    ):
        employee.active_position_id = position_id
    await _workflow(db, "INDENT", [
        {"seq": 1, "approver_type": ApproverType.REPORTING_MANAGER.value},
    ])

    instance = await engine.start(
        db, "INDENT", 44, {"requester_position_id": 1000}, requester,
    )
    assert instance.status == InstanceStatus.IN_PROGRESS.value
    assert {row.approver_id for row in (await db.execute(
        select(Pending).where(Pending.doc_id == 44)
    )).scalars().all()} == {oe.id}

    await engine.act(db, "INDENT", 44, "APPROVE", oe, context={"requester_position_id": 1000})
    assert {row.approver_id for row in (await db.execute(
        select(Pending).where(Pending.doc_id == 44)
    )).scalars().all()} == {dm.id}

    await engine.act(db, "INDENT", 44, "APPROVE", dm, context={"requester_position_id": 1000})
    assert {row.approver_id for row in (await db.execute(
        select(Pending).where(Pending.doc_id == 44)
    )).scalars().all()} == {rm.id}

    await engine.act(db, "INDENT", 44, "APPROVE", rm, context={"requester_position_id": 1000})
    assert {row.approver_id for row in (await db.execute(
        select(Pending).where(Pending.doc_id == 44)
    )).scalars().all()} == {sph.id, coo.id}

    final = await engine.act(
        db, "INDENT", 44, "APPROVE", coo, context={"requester_position_id": 1000},
    )
    assert final.status == InstanceStatus.APPROVED.value


async def test_no_active_workflow_falls_back_instead_of_failing(db):
    """Replaces test_no_active_workflow_fails_loudly.

    That test asserted engine.start() raises when a doc type has no configured
    workflow. The requirement changed deliberately: missing configuration must never
    strand a document, so the engine now materialises the hardcoded reporting ladder
    (platform/workflow/fallback.py) and records that it did. Failing loudly is still
    the behaviour for a stage that resolves to literally nobody, admins included.
    """
    # A valid installation always has an admin; the ladder's terminal safety net
    # routes to them when the requester has no reporting line.
    admin = await _emp(db, 90, "Admin")
    role = Role(code="ADMIN", name="Admin", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=admin.id, role_id=role.id))
    await db.flush()

    e1 = await _emp(db, 1)
    instance = await engine.start(db, "GRN", 1, {}, e1)

    assert instance.status == InstanceStatus.IN_PROGRESS.value
    wf = await db.get(Workflow, instance.workflow_id)
    assert wf.code == "WF-FALLBACK-GRN"

    # and it is visible, not silent
    logged = (await db.execute(select(Action).where(
        Action.instance_id == instance.id,
        Action.action == ApprovalAction.FALLBACK.value))).scalars().all()
    assert logged, "a fallback that fires silently is one nobody ever fixes"
    assert any(fallback.REASON_NO_WORKFLOW in (a.comments or "") for a in logged)


# ---------------- resolver ----------------

async def test_resolver_dept_head(db):
    head = await _emp(db, 10, "Head")
    db.add(HcmDepartment(id=3, name="Mech", head_employee_id=head.id, synced_at=utcnow()))
    await db.flush()
    stage = Stage(workflow_id=1, sequence=1, name="s", approver_type=ApproverType.DEPT_HEAD.value)
    inst = Instance(doc_type="INDENT", doc_id=1, workflow_id=1, started_by_id=999)
    approvers = await resolver.resolve_approvers(db, stage, inst, {"department_id": 3})
    assert [a.id for a in approvers] == [head.id]


async def test_resolver_reporting_manager(db):
    mgr = await _emp(db, 20, "Mgr")
    db.add(HcmPosition(id=100, name="Parent", synced_at=utcnow()))
    db.add(HcmPosition(id=101, name="Child", parent_position_id=100, synced_at=utcnow()))
    db.add(HcmPositionAssignment(id=1, employee_id=mgr.id, position_id=100,
                                 is_active=True, synced_at=utcnow()))
    requester = await _emp(db, 21, "Req", position_id=101)
    await db.flush()
    stage = Stage(workflow_id=1, sequence=1, name="s",
                  approver_type=ApproverType.REPORTING_MANAGER.value)
    inst = Instance(doc_type="INDENT", doc_id=1, workflow_id=1, started_by_id=requester.id)
    approvers = await resolver.resolve_approvers(
        db, stage, inst, {"requester_position_id": 101},
    )
    assert [a.id for a in approvers] == [mgr.id]


async def test_resolver_expands_delegation(db):
    approver = await _emp(db, 30, "Appr")
    delegate = await _emp(db, 31, "Deleg")
    db.add(Delegation(
        from_employee_id=approver.id, to_employee_id=delegate.id,
        valid_from=date.today() - timedelta(days=1),
        valid_to=date.today() + timedelta(days=1), is_active=True,
    ))
    await db.flush()
    stage = Stage(workflow_id=1, sequence=1, name="s",
                  approver_type=ApproverType.SPECIFIC_USER.value,
                  employee_id=approver.id)
    inst = Instance(doc_type="INDENT", doc_id=1, workflow_id=1, started_by_id=999)
    approvers = await resolver.resolve_approvers(db, stage, inst, {})
    ids = {a.id for a in approvers}
    assert approver.id in ids and delegate.id in ids
