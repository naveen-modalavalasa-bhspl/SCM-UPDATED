"""Indents module tests: creation rules, the DRAFT->PENDING->AWAITING_ALLOCATION flow through
the engine, edit locking, and an API smoke test with permissions."""
import pytest

from app.core.exceptions import ValidationError
from app.core.pagination import PageParams
from app.modules.indents import service
from app.modules.indents.schemas import IndentCreate, IndentItemIn, IndentUpdate
from app.modules.indents.enums import ApprovalAction
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import ApproverType, IndentStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom


async def _world(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    it1 = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    it2 = Item(code="IT-0002", name="Nut", uom_id=uom.id, uom_code="NOS")
    db.add_all([it1, it2])
    requester = HcmEmployee(id=2, full_name="Ravi Req", emp_code="E2",
                            department_id=501, office_id=701,
                            is_active=True, synced_at=utcnow())
    approver = HcmEmployee(id=3, full_name="Anita Appr", emp_code="E3",
                           is_active=True, synced_at=utcnow())
    db.add_all([requester, approver])
    db.add(HcmOffice(id=701, name="Regional Office", is_active=True, synced_at=utcnow()))
    db.add(HcmDepartment(id=501, name="Mechanical", head_employee_id=3, synced_at=utcnow()))
    db.add_all([
        HcmPosition(id=100, name="Regional Manager", is_active=True, synced_at=utcnow()),
        HcmPosition(id=101, name="District Officer", parent_position_id=100,
                    department_id=501, office_id=701, is_active=True, synced_at=utcnow()),
    ])
    db.add_all([
        HcmPositionAssignment(id=1, employee_id=requester.id, position_id=101,
                              department_id=501, office_id=701, is_primary=True,
                              is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(id=2, employee_id=approver.id, position_id=100,
                              is_primary=True, is_active=True, synced_at=utcnow()),
    ])
    approver.active_position_id = 100
    wf = Workflow(code="WF-INDENT", name="Indent", doc_type="INDENT", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Reporting Manager",
                 approver_type=ApproverType.REPORTING_MANAGER.value,
                 approval_mode="ANY_ONE"))
    await db.commit()
    return requester, approver, it1, it2


def _create_data(item_id):
    return IndentCreate(items=[IndentItemIn(item_id=item_id, quantity=5)], remarks="test")


async def test_create_requires_items(db):
    requester, *_ = await _world(db)
    with pytest.raises(ValidationError):
        await service.create_indent(db, IndentCreate(items=[]), requester)


async def test_create_sets_snapshots_and_number(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    assert indent.status == IndentStatus.DRAFT.value
    assert indent.indent_no.startswith("IND/")
    assert indent.requested_by_name == "Ravi Req"
    assert indent.department_name == "Mechanical"        # snapshot resolved
    assert indent.position_name == "District Officer"
    assert indent.office_name == "Regional Office"
    assert float(indent.total_qty) == 5
    assert indent.items[0].item_code == "IT-0001"        # item snapshot


async def test_cannot_approve_before_submit(db):
    requester, approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    with pytest.raises(ValidationError):
        await service.act_on_indent(db, indent.id, ApprovalAction.APPROVED, "", approver)


async def test_submit_then_dept_head_approves(db):
    requester, approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)

    await service.submit_indent(db, indent.id, requester)
    assert (await service.get_indent(db, indent.id)).status == IndentStatus.PENDING_APPROVAL.value

    result = await service.act_on_indent(
        db, indent.id, ApprovalAction.APPROVED, "ok", approver,
    )
    # Was APPROVED. Clearing the approval chain now hands the indent to inventory
    # rather than finishing it: a person decides how much stock it actually gets
    # (see the allocation change spec). APPROVED no longer appears as a resting
    # state for an indent that has cleared its chain.
    assert result.status == IndentStatus.AWAITING_ALLOCATION.value
    assert result.approved_at is not None


async def test_cannot_edit_after_submit(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)
    with pytest.raises(ValidationError):
        await service.update_indent(db, indent.id, IndentUpdate(remarks="late edit"), requester)


async def test_indent_create_and_list_via_api(client, db, make_user, login):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    await db.commit()

    await make_user(employee_id=2, username="req", password="pw",
                    permissions=["indent.view", "indent.create"])
    headers = await login("req", "pw")

    r = await client.post("/api/indents",
                          json={"items": [{"item_id": item.id, "quantity": 5}]},
                          headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "DRAFT"
    assert r.json()["indent_no"].startswith("IND/")

    lst = await client.get("/api/indents", headers=headers)
    assert lst.status_code == 200
    assert lst.json()["total"] >= 1


async def test_indent_stats_counts(db):
    requester, approver, it1, _ = await _world(db)
    await service.create_indent(db, _create_data(it1.id), requester)          # DRAFT
    approved = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, approved.id, requester)
    await service.act_on_indent(
        db, approved.id, ApprovalAction.APPROVED, "", approver,
    )      # -> AWAITING_ALLOCATION

    stats = await service.indent_stats(db)
    assert stats["total"] == 2
    assert stats["draft"] == 1
    assert stats["approved_active"] == 1
    assert stats["this_month"] == 2
    assert stats["total_items"] == 2
    assert stats["total_qty"] == 10
    assert stats["approval_rate"] == 100
    assert stats["by_status"]["AWAITING_ALLOCATION"] == 1


async def test_activity_acknowledgments_and_notifications(db):
    requester, approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)
    await service.act_on_indent(
        db, indent.id, ApprovalAction.APPROVED, "Approved for issue", approver,
    )
    params = PageParams(page=1, size=20)

    activity = await service.activity_ledger(db, params, search=indent.indent_no)
    assert activity["total"] >= 2
    assert {row["transaction_type"] for row in activity["items"]} == {
        "RAISED", "ACKNOWLEDGED",
    }

    acknowledgments = await service.list_acknowledgments(db, params)
    assert any(row["indent_no"] == indent.indent_no for row in acknowledgments["items"])

    notifications = await service.list_notifications(db, params, requester)
    assert notifications["items"][0]["title"] == "Request approved"


async def test_create_without_permission_forbidden(client, make_user, login):
    await make_user(employee_id=9, username="noperm", password="pw", permissions=["indent.view"])
    headers = await login("noperm", "pw")
    r = await client.post("/api/indents", json={"items": [{"item_id": 1, "quantity": 1}]},
                          headers=headers)
    assert r.status_code == 403
