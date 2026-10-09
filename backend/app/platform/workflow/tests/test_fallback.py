"""The floor underneath the engines.

Both triggers, the ladder itself, and the terminal safety net. If these break, a
misconfigured workflow silently strands documents — which is the exact failure this
module exists to prevent.
"""
from sqlalchemy import select

from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Role, UserRole
from app.platform.workflow import engine, fallback
from app.platform.workflow.models import Action, Stage, Workflow
from app.shared.enums import (
    ApprovalAction, ApproverType, InstanceStatus, UserRole as RoleCode,
)
from app.shared.models.base import utcnow


async def _emp(db, id, name="Emp", position_id=None):
    e = HcmEmployee(id=id, full_name=f"{name}{id}", emp_code=f"E{id}",
                    is_active=True, synced_at=utcnow())
    db.add(e)
    await db.flush()
    if position_id is not None:
        db.add(HcmPositionAssignment(id=10_000 + id, employee_id=id,
                                     position_id=position_id, is_active=True,
                                     is_primary=True, synced_at=utcnow()))
        await db.flush()
    return e


async def _tree(db):
    """junior(103) -> supervisor(102) -> manager(101) -> head(100)."""
    db.add_all([
        HcmPosition(id=100, name="Head", is_active=True, synced_at=utcnow()),
        HcmPosition(id=101, name="Manager", parent_position_id=100,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=102, name="Supervisor", parent_position_id=101,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=103, name="Junior", parent_position_id=102,
                    is_active=True, synced_at=utcnow()),
    ])
    await db.flush()
    junior = await _emp(db, 1, "Junior", position_id=103)
    supervisor = await _emp(db, 2, "Supervisor", position_id=102)
    manager = await _emp(db, 3, "Manager", position_id=101)
    head = await _emp(db, 4, "Head", position_id=100)
    return junior, supervisor, manager, head


async def _admin(db, id=99):
    admin = await _emp(db, id, "Admin")
    role = Role(code=RoleCode.ADMIN.value, name="Admin", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=admin.id, role_id=role.id))
    await db.flush()
    return admin


# ---------------- the ladder ----------------

async def test_ladder_walks_three_levels_and_stops_at_the_top(db):
    junior, supervisor, manager, head = await _tree(db)

    approvers = await fallback.ladder_approvers(db, junior.id, 103)

    assert [a.id for a in approvers] == [supervisor.id, manager.id, head.id]


async def test_ladder_stops_early_at_the_top_of_the_tree(db):
    _junior, _supervisor, manager, head = await _tree(db)

    approvers = await fallback.ladder_approvers(db, manager.id, 101)

    assert [a.id for a in approvers] == [head.id]


async def test_ladder_never_returns_the_requester(db):
    """A cyclic or self-parented position must not make someone approve their own
    request."""
    db.add(HcmPosition(id=200, name="Solo", parent_position_id=200,
                       is_active=True, synced_at=utcnow()))
    await db.flush()
    solo = await _emp(db, 7, "Solo", position_id=200)

    approvers = await fallback.ladder_approvers(db, solo.id, 200)

    assert solo.id not in [a.id for a in approvers]


async def test_requester_with_no_position_routes_to_admin(db):
    admin = await _admin(db)

    approvers, reason = await fallback.resolve(db, requester_id=555,
                                               requester_position_id=None)

    assert reason == fallback.REASON_ADMIN
    assert admin.id in [a.id for a in approvers]


# ---------------- trigger 1: no workflow at all ----------------

async def test_missing_workflow_materialises_the_ladder(db):
    junior, supervisor, *_ = await _tree(db)

    instance = await engine.start(db, "MR", 1,
                                  {"requester_position_id": 103}, junior)

    assert instance.status == InstanceStatus.IN_PROGRESS.value
    wf = await db.get(Workflow, instance.workflow_id)
    assert wf.code == "WF-FALLBACK-MR"
    approvers = await engine.current_approvers(db, "MR", 1)
    assert supervisor.id in [a.id for a in approvers]


async def test_the_auto_created_workflow_is_reused_not_duplicated(db):
    """Second document of the same type must not create a second fallback workflow."""
    junior, *_ = await _tree(db)

    first = await engine.start(db, "MR", 1, {"requester_position_id": 103}, junior)
    second = await engine.start(db, "MR", 2, {"requester_position_id": 103}, junior)

    assert first.workflow_id == second.workflow_id
    rows = (await db.execute(select(Workflow).where(
        Workflow.doc_type == "MR"))).scalars().all()
    assert len(rows) == 1


# ---------------- trigger 2: a stage that resolves to nobody ----------------

async def test_empty_stage_is_substituted_by_the_ladder(db):
    """The position on stage 1 is vacant. The stage still gets an approver."""
    junior, supervisor, *_ = await _tree(db)
    wf = Workflow(code="WF_MR_REAL", name="MR", doc_type="MR", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Vacant Post",
                 approver_type=ApproverType.POSITION.value, position_id=999))
    await db.flush()

    instance = await engine.start(db, "MR", 5, {"requester_position_id": 103}, junior)

    approvers = await engine.current_approvers(db, "MR", 5)
    assert supervisor.id in [a.id for a in approvers]
    assert instance.workflow_id == wf.id      # the real workflow, not a fallback one


async def test_every_fallback_writes_an_action_row_and_an_audit_entry(db):
    from app.platform.settings.models import AuditLog

    junior, *_ = await _tree(db)

    instance = await engine.start(db, "MR", 8, {"requester_position_id": 103}, junior)

    actions = (await db.execute(select(Action).where(
        Action.instance_id == instance.id,
        Action.action == ApprovalAction.FALLBACK.value))).scalars().all()
    audits = (await db.execute(select(AuditLog).where(
        AuditLog.entity_type == "wf_instances"))).scalars().all()

    assert actions, "the document's own history must show the fallback"
    assert audits, "and it must be findable across all documents on one screen"
