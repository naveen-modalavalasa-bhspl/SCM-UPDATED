"""Allocation: the human decision, and the material request that follows it.

REWRITTEN 2026-07-26. The previous version of this file tested
`service.allocate_for_indent()` — approval automatically reserving everything
available and raising an MR for the rest. Those tests were not wrong for the
requirement they were written against; the requirement changed. Deciding how much
stock an indent gets, and out of which warehouse, is a judgement somebody makes:
sixty bags of cement with four projects wanting it is not a rule. See
docs/superpowers/specs/2026-07-26-allocation-is-a-decision-CHANGE.md.

What these assert now: approval reserves NOTHING, and stock moves only when a
person's allocation is approved.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.inventory import allocations
from app.modules.warehouse import service as warehouse_service
from app.modules.warehouse.models import MaterialIssue, MaterialIssueLine
from app.modules.inventory.models import (
    NO_BIN, NO_PROJECT, Allocation, MaterialRequest, Reservation, Stock,
)
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Role, UserRole
from app.shared.enums import (
    AllocationStatus, ApprovalAction, MRStatus, RefType, UserRole as RoleCode,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom
from app.shared.models.warehouse import Warehouse


@pytest.fixture
def actor():
    return SimpleNamespace(id=1, full_name="Tester", emp_code="T1")


async def _world(db):
    """Items, two warehouses, and an admin who can approve.

    The allocation goes into the approval engine. With no ALLOCATION workflow
    configured the engine falls back to the reporting ladder, and with no reporting
    line it falls back again to the ADMIN role. A world with neither is a broken
    installation, not a scenario worth testing.
    """
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    stocked = Item(code="IT-STK", name="Cement", uom_id=uom.id, uom_code="NOS")
    bare = Item(code="IT-NIL", name="Butterfly Valve", uom_id=uom.id, uom_code="NOS")
    db.add_all([stocked, bare])
    main = Warehouse(code="WH-MAIN", name="Main", warehouse_type="MAIN", is_active=True)
    lip = Warehouse(code="LIP-1", name="Site Point", warehouse_type="LIP", is_active=True)
    db.add_all([main, lip])

    admin = HcmEmployee(id=99, full_name="System Admin", emp_code="admin",
                        is_active=True, synced_at=utcnow())
    db.add(admin)
    role = Role(code=RoleCode.ADMIN.value, name="Admin", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=admin.id, role_id=role.id))
    await db.flush()
    return stocked, bare, main, lip, admin


async def _stock(db, item, wh, qty):
    row = Stock(item_id=item.id, item_code=item.code, item_name=item.name,
                warehouse_id=wh.id, warehouse_name=wh.name, bin_id=NO_BIN,
                batch_id=0, project_id=NO_PROJECT,
                available_qty=Decimal(str(qty)), reserved_qty=Decimal("0"),
                total_qty=Decimal(str(qty)))
    db.add(row)
    await db.flush()
    return row


def _decision(line_id, item, qty, wh, requested):
    return {"indent_item_id": line_id, "item_id": item.id, "item_code": item.code,
            "item_name": item.name, "uom_code": item.uom_code,
            "requested_qty": Decimal(str(requested)),
            "quantity": Decimal(str(qty)),
            "warehouse_id": wh.id if wh else None, "project_id": NO_PROJECT}


async def _reload(db, item):
    return (await db.execute(
        select(Stock).where(Stock.item_id == item.id))).scalars().first()


# ---------------- proposing reserves nothing ----------------

async def test_proposing_reserves_nothing(db):
    """The screen's data must be read-only. If merely looking at an indent locked
    stock, opening two tabs would starve the warehouse."""
    stocked, _bare, main, _lip, _admin = await _world(db)
    await _stock(db, stocked, main, 60)

    proposal = await allocations.propose(db, 1, [
        {"indent_item_id": 1, "item_id": stocked.id, "requested_qty": Decimal("100"),
         "project_id": NO_PROJECT}])

    row = await _reload(db, stocked)
    assert row.available_qty == Decimal("60")
    assert row.reserved_qty == Decimal("0")
    assert proposal[0]["available_total"] == Decimal("60")


async def test_proposal_splits_availability_by_warehouse(db):
    """The allocator has to see WHERE the stock is before choosing."""
    stocked, _bare, main, lip, _admin = await _world(db)
    await _stock(db, stocked, main, 40)
    await _stock(db, stocked, lip, 20)

    proposal = await allocations.propose(db, 1, [
        {"indent_item_id": 1, "item_id": stocked.id, "requested_qty": Decimal("100"),
         "project_id": NO_PROJECT}])

    by_name = {w["warehouse_name"]: w["available_qty"] for w in proposal[0]["warehouses"]}
    assert by_name == {"Main": Decimal("40"), "Site Point": Decimal("20")}
    assert proposal[0]["available_total"] == Decimal("60")


# ---------------- the decision ----------------

async def test_creating_an_allocation_reserves_nothing_until_approved(db, actor):
    """The whole point. A proposal in flight must not lock stock — the approver may
    still refuse it."""
    stocked, _bare, main, _lip, _admin = await _world(db)
    await _stock(db, stocked, main, 60)

    alloc = await allocations.create(db, 1, "IND-1", [
        _decision(1, stocked, 40, main, 100)], actor)

    assert alloc.status == AllocationStatus.PENDING_APPROVAL.value
    row = await _reload(db, stocked)
    assert row.available_qty == Decimal("60")
    assert row.reserved_qty == Decimal("0")


async def test_allocation_fallback_routes_to_allocator_reporting_manager(db, actor):
    stocked, _bare, main, _lip, _admin = await _world(db)
    await _stock(db, stocked, main, 60)
    db.add_all([
        HcmPosition(id=701, name="Inventory Manager", is_active=True, synced_at=utcnow()),
        HcmPosition(id=702, name="Inventory Executive", parent_position_id=701,
                    is_active=True, synced_at=utcnow()),
        HcmEmployee(id=703, full_name="Inventory Manager", emp_code="INV-MGR",
                    is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(
            id=704, employee_id=703, position_id=701, is_active=True,
            is_primary=True, synced_at=utcnow(),
        ),
    ])
    await db.flush()

    alloc = await allocations.create(
        db, 20, "IND-20", [_decision(1, stocked, 40, main, 100)], actor,
        ctx={"requester_position_id": 702},
    )

    assert alloc.current_approver_name == "Inventory Manager"


async def test_approving_reserves_exactly_what_was_decided(db, actor):
    """Asked 100, on hand 60, person chose 40. Forty is what gets reserved — not the
    60 that happened to be available."""
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    alloc = await allocations.create(db, 2, "IND-2", [
        _decision(1, stocked, 40, main, 100)], actor)

    await allocations.act(db, alloc.id, ApprovalAction.APPROVED.value, admin, "ok")

    row = await _reload(db, stocked)
    assert row.reserved_qty == Decimal("40")
    assert row.available_qty == Decimal("20")
    assert row.total_qty == Decimal("60")   # nothing physically moved


async def test_the_shortfall_becomes_one_material_request(db, actor):
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    alloc = await allocations.create(db, 3, "IND-3", [
        _decision(1, stocked, 40, main, 100)], actor)

    await allocations.act(db, alloc.id, ApprovalAction.APPROVED.value, admin, "ok")

    mr = (await db.execute(
        select(MaterialRequest).where(MaterialRequest.indent_id == 3))).scalars().first()
    assert mr is not None
    assert mr.status == MRStatus.PENDING_APPROVAL.value
    assert [i.quantity for i in mr.items] == [Decimal("60")]   # 100 asked - 40 given


async def test_giving_nothing_is_a_valid_decision(db, actor):
    """"Hold it all for the Eluru site on Monday" must be expressible."""
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    alloc = await allocations.create(db, 4, "IND-4", [
        _decision(1, stocked, 0, None, 100)], actor)

    await allocations.act(db, alloc.id, ApprovalAction.APPROVED.value, admin, "ok")

    row = await _reload(db, stocked)
    assert row.reserved_qty == Decimal("0")
    assert row.available_qty == Decimal("60")
    mr = (await db.execute(
        select(MaterialRequest).where(MaterialRequest.indent_id == 4))).scalars().first()
    assert [i.quantity for i in mr.items] == [Decimal("100")]


async def test_one_line_can_be_split_across_two_warehouses(db, actor):
    stocked, _bare, main, lip, admin = await _world(db)
    await _stock(db, stocked, main, 40)
    await _stock(db, stocked, lip, 20)

    alloc = await allocations.create(db, 5, "IND-5", [
        _decision(1, stocked, 40, main, 100),
        _decision(1, stocked, 20, lip, 0),
    ], actor)
    await allocations.act(db, alloc.id, ApprovalAction.APPROVED.value, admin, "ok")

    rows = (await db.execute(
        select(Stock).where(Stock.item_id == stocked.id))).scalars().all()
    assert sum(r.reserved_qty for r in rows) == Decimal("60")
    assert all(r.available_qty == Decimal("0") for r in rows)


async def test_approval_generates_one_issue_draft_per_warehouse(db, actor):
    """Allocation approval opens the draft chain at the ISSUE, not the picklist.

    The picklist is raised later, by post_issue, once the stock has actually come
    off the shelf — see warehouse.service._raise_picking_for_issue.
    """
    stocked, _bare, main, lip, admin = await _world(db)
    await _stock(db, stocked, main, 40)
    await _stock(db, stocked, lip, 20)

    alloc = await allocations.create(db, 55, "IND-55", [
        _decision(1, stocked, 40, main, 60),
        _decision(1, stocked, 20, lip, 0),
    ], actor)
    await allocations.act(
        db,
        alloc.id,
        ApprovalAction.APPROVED.value,
        admin,
        "ok",
        on_approved=warehouse_service.create_fulfilment_drafts_for_allocation,
    )

    drafts = (await db.execute(
        select(MaterialIssue).where(MaterialIssue.indent_id == 55)
        .order_by(MaterialIssue.warehouse_id)
    )).scalars().all()
    assert len(drafts) == 2
    assert {draft.warehouse_id for draft in drafts} == {main.id, lip.id}
    assert all(draft.status == "DRAFT" for draft in drafts)
    assert all(not draft.is_stock_posted for draft in drafts)

    quantities = (await db.execute(
        select(MaterialIssue.warehouse_id, MaterialIssueLine.issued_qty)
        .join(MaterialIssueLine, MaterialIssueLine.issue_id == MaterialIssue.id)
        .where(MaterialIssue.indent_id == 55)
    )).all()
    assert {warehouse_id: qty for warehouse_id, qty in quantities} == {
        main.id: Decimal("40"),
        lip.id: Decimal("20"),
    }
    # No picklist yet — nothing has been issued off the shelf.
    assert (await warehouse_service.dashboard(db))["open_picklists"] == 0


async def test_rejecting_an_allocation_reserves_nothing(db, actor):
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    alloc = await allocations.create(db, 6, "IND-6", [
        _decision(1, stocked, 40, main, 100)], actor)

    alloc = await allocations.act(db, alloc.id, ApprovalAction.REJECTED.value,
                                  admin, "hold it")

    assert alloc.status == AllocationStatus.REJECTED.value
    row = await _reload(db, stocked)
    assert row.available_qty == Decimal("60")
    assert row.reserved_qty == Decimal("0")


async def test_indent_cannot_be_submitted_twice_while_allocation_is_pending(db, actor):
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    first = await allocations.create(db, 61, "IND-61", [
        _decision(1, stocked, 40, main, 40)], actor)

    with pytest.raises(ValidationError, match="already awaiting approval"):
        await allocations.create(db, 61, "IND-61", [
            _decision(1, stocked, 40, main, 40)], actor)

    await allocations.act(
        db, first.id, ApprovalAction.REJECTED.value, admin, "revise allocation",
    )
    replacement = await allocations.create(db, 61, "IND-61", [
        _decision(1, stocked, 30, main, 40)], actor)
    assert replacement.status == AllocationStatus.PENDING_APPROVAL.value


async def test_reservation_is_tagged_to_the_indent_line(db, actor):
    """ref_line_id is what lets one line be released or issued on its own."""
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)
    alloc = await allocations.create(db, 7, "IND-7", [
        _decision(9, stocked, 25, main, 25)], actor)
    await allocations.act(db, alloc.id, ApprovalAction.APPROVED.value, admin, "ok")

    res = (await db.execute(select(Reservation).where(
        Reservation.ref_type == RefType.RESERVATION.value,
        Reservation.ref_id == 7))).scalars().all()
    assert len(res) == 1
    assert res[0].ref_line_id == 9
    assert res[0].quantity == Decimal("25")


async def test_a_second_allocation_sees_what_the_first_took(db, actor):
    """Two allocators working at once must not both promise the same 60 bags."""
    stocked, _bare, main, _lip, admin = await _world(db)
    await _stock(db, stocked, main, 60)

    first = await allocations.create(db, 8, "IND-8", [
        _decision(1, stocked, 50, main, 50)], actor)
    await allocations.act(db, first.id, ApprovalAction.APPROVED.value, admin, "ok")

    proposal = await allocations.propose(db, 9, [
        {"indent_item_id": 2, "item_id": stocked.id, "requested_qty": Decimal("50"),
         "project_id": NO_PROJECT}])

    assert proposal[0]["available_total"] == Decimal("10")


async def test_the_decision_is_recorded_with_who_made_it(db, actor):
    """"Why did this project get 40 and not 60" has to have an answer."""
    stocked, _bare, main, _lip, _admin = await _world(db)
    await _stock(db, stocked, main, 60)

    alloc = await allocations.create(
        db, 10, "IND-10", [_decision(1, stocked, 40, main, 100)], actor,
        ctx={"remarks": "holding 20 for Eluru on Monday"})

    saved = await db.get(Allocation, alloc.id)
    assert saved.allocated_by_name == "Tester"
    assert saved.remarks == "holding 20 for Eluru on Monday"
    assert saved.items[0].quantity == Decimal("40")
    assert saved.items[0].requested_qty == Decimal("100")
