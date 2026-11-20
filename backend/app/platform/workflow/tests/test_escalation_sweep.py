"""The escalation sweep on a real database (2026-11-20, MoM point 2).

A three-rung ladder frozen on a document. Waiting 25 h at rung 1 moves it to rung 2
(never to anybody's HCM parent), writes a system row in the history and tells both
sides; waiting 25 h at the LAST rung moves nothing and sends ONE urgent notification,
however many times the sweep runs; 5 h of waiting changes nothing at all.
"""
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.platform.hcm.models import HcmEmployee
from app.platform.settings.models import Notification
from app.platform.workflow import escalation
from app.platform.workflow.models import Action, Instance, Pending
from app.shared.enums import ApprovalAction, InstanceStatus
from app.shared.models.base import utcnow

pytestmark = pytest.mark.asyncio


async def _world(db, *, at_rung: int, waited_hours: float):
    for i, name in ((1, "Anita"), (2, "Ravi"), (3, "Padma"), (9, "Raiser")):
        db.add(HcmEmployee(id=i, full_name=name, emp_code=f"E{i}", is_active=True,
                           synced_at=utcnow()))
    chain = [{"sequence": i, "role_name": role, "approver_ids": [i],
              "approver_names": [name]}
             for i, role, name in ((1, "Regional Manager", "Anita"),
                                   (2, "District Manager", "Ravi"),
                                   (3, "SPH", "Padma"))]
    inst = Instance(doc_type="INDENT", doc_id=77, doc_no="IND-77", workflow_id=1,
                    resolved_chain=chain, current_sequence=at_rung,
                    current_stage_name=chain[at_rung - 1]["role_name"],
                    status=InstanceStatus.IN_PROGRESS.value, started_by_id=9,
                    started_by_name="Raiser")
    db.add(inst)
    await db.flush()
    db.add(Pending(instance_id=inst.id, stage_sequence=at_rung, approver_id=at_rung,
                   doc_type="INDENT", doc_id=77, doc_no="IND-77", doc_summary="2 items",
                   created_at=utcnow() - timedelta(hours=waited_hours)))
    await db.commit()
    return inst


async def test_a_long_wait_moves_it_one_rung_up_its_own_ladder(db):
    inst = await _world(db, at_rung=1, waited_hours=25)
    summary = await escalation.sweep(db)
    assert summary["moved"] == 1
    await db.refresh(inst)
    assert inst.current_sequence == 2
    waiting = (await db.execute(select(Pending.approver_id).where(
        Pending.instance_id == inst.id))).scalars().all()
    assert waiting == [2]
    row = (await db.execute(select(Action).where(Action.instance_id == inst.id))).scalars().one()
    assert row.action == ApprovalAction.ESCALATED.value
    assert "waited 25 h with Anita (Regional Manager)" in row.comments
    assert "Moved to District Manager" in row.comments
    told = set((await db.execute(select(Notification.employee_id))).scalars().all())
    assert {1, 2} <= told


async def test_the_clock_restarts_at_the_new_rung(db):
    inst = await _world(db, at_rung=1, waited_hours=25)
    await escalation.sweep(db)
    await escalation.sweep(db)
    await db.refresh(inst)
    assert inst.current_sequence == 2


async def test_the_last_rung_is_flagged_once_and_never_moved(db):
    inst = await _world(db, at_rung=3, waited_hours=30)
    first = await escalation.sweep(db)
    second = await escalation.sweep(db)
    await db.refresh(inst)
    assert inst.current_sequence == 3
    assert first["stuck"] == 1 and second["stuck"] == 0
    urgent = await db.scalar(select(func.count(Notification.id)).where(
        Notification.entity_type == escalation.STUCK))
    assert urgent == 1


async def test_a_short_wait_changes_nothing(db):
    inst = await _world(db, at_rung=1, waited_hours=5)
    assert (await escalation.sweep(db))["moved"] == 0
    await db.refresh(inst)
    assert inst.current_sequence == 1


async def test_the_home_card_counts_attention_and_stuck(db):
    await _world(db, at_rung=3, waited_hours=30)
    counts = await escalation.ageing_counts(db, [Pending.approver_id == 3])
    assert counts["stuck"] == 1 and counts["attention"] == 0
