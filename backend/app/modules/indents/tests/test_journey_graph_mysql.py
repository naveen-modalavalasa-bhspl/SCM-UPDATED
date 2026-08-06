"""Model-backed MySQL coverage for the Indent Journey document graph."""
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.indents import service
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory.models import Allocation, AllocationItem
from app.modules.warehouse.models import (
    Dispatch, DispatchItem, MaterialIssue, MaterialIssueLine,
)
from app.platform.settings.models import AuditLog
from app.platform.workflow.models import Action, Instance
from app.shared.models.master import Item, Uom


async def _indent_with_lines(db, *, number: str, requested_by_id: int = 77):
    uom = Uom(code=f"U{number[-4:]}", name=f"Units {number}")
    db.add(uom)
    await db.flush()
    items = [
        Item(code=f"{number}-A", name="Journey A", uom_id=uom.id, uom_code=uom.code),
        Item(code=f"{number}-B", name="Journey B", uom_id=uom.id, uom_code=uom.code),
    ]
    db.add_all(items)
    await db.flush()
    indent = Indent(
        indent_no=number,
        indent_date=date.today(),
        requested_by_id=requested_by_id,
        requested_by_name="Journey Requester",
        status="CLOSED",
        total_items=2,
        total_qty=Decimal("5"),
    )
    db.add(indent)
    await db.flush()
    lines = [
        IndentItem(
            indent_id=indent.id, line_no=1, item_id=items[0].id,
            quantity=Decimal("2"), approved_quantity=Decimal("2"),
            received_quantity=Decimal("2"), status="RECEIVED",
        ),
        IndentItem(
            indent_id=indent.id, line_no=2, item_id=items[1].id,
            quantity=Decimal("3"), approved_quantity=Decimal("3"),
            received_quantity=Decimal("3"), status="RECEIVED",
        ),
    ]
    db.add_all(lines)
    await db.flush()
    return indent, lines


def _workflow(instance_id: int, names: list[str], started: datetime):
    actions = [Action(
        instance_id=instance_id, stage_sequence=0, stage_name="Submitted",
        actor_id=501, actor_name="Document Creator", actor_position="Controller",
        action="SUBMITTED", acted_at=started,
    )]
    actions.extend(
        Action(
            instance_id=instance_id, stage_sequence=index, stage_name=name,
            actor_id=501 + index, actor_name=f"Approver {index}",
            actor_position=name, action="APPROVED",
            acted_at=started + timedelta(seconds=index),
        )
        for index, name in enumerate(names, start=1)
    )
    return actions


@pytest.mark.asyncio
async def test_document_graph_and_complete_journey_use_real_linked_models(db):
    base = datetime(2026, 8, 3, 8, 0, 0)
    indent, lines = await _indent_with_lines(db, number="IND/JOURNEY/0001")
    indent.created_at = base

    direct = Allocation(
        allocation_no="ALC/JOURNEY/0001", indent_id=indent.id,
        status="APPROVED", allocated_by_name="Allocator",
        approved_at=base + timedelta(minutes=3),
    )
    legacy = Allocation(
        allocation_no="ALC/JOURNEY/0002", indent_id=999999,
        status="APPROVED", allocated_by_name="Allocator",
        approved_at=base + timedelta(minutes=4),
    )
    db.add_all([direct, legacy])
    await db.flush()
    db.add_all([
        AllocationItem(
            allocation_id=direct.id, indent_item_id=lines[0].id,
            item_id=lines[0].item_id, requested_qty=2, quantity=2,
        ),
        AllocationItem(
            allocation_id=legacy.id, indent_item_id=lines[1].id,
            item_id=lines[1].item_id, requested_qty=3, quantity=3,
        ),
    ])

    issue_from_line = MaterialIssue(
        issue_no="WHI/JOURNEY/0001", issue_date=date.today(), indent_id=None,
        warehouse_id=1, direction="OUT", status="ISSUED", is_stock_posted=True,
        posted_at=base + timedelta(minutes=7), issued_by_name="Warehouse Poster",
    )
    issue_direct = MaterialIssue(
        issue_no="WHI/JOURNEY/0002", issue_date=date.today(), indent_id=indent.id,
        warehouse_id=1, direction="OUT", status="ISSUED", is_stock_posted=True,
        posted_at=base + timedelta(minutes=8), issued_by_name="Warehouse Poster",
    )
    db.add_all([issue_from_line, issue_direct])
    await db.flush()
    db.add_all([
        MaterialIssueLine(
            issue_id=issue_from_line.id, line_no=1, indent_item_id=lines[0].id,
            item_id=lines[0].item_id, requested_qty=2, issued_qty=2,
        ),
        MaterialIssueLine(
            issue_id=issue_direct.id, line_no=1, indent_item_id=lines[1].id,
            item_id=lines[1].item_id, requested_qty=3, issued_qty=3,
        ),
    ])

    indirect_dispatch = Dispatch(
        dispatch_no="DSP/JOURNEY/0001", dispatch_date=date.today(), warehouse_id=1,
        ref_type="WH_ISSUE", ref_id=issue_from_line.id,
        ref_no=issue_from_line.issue_no, status="DELIVERED",
        gate_out_at=base + timedelta(minutes=10),
        delivered_at=base + timedelta(minutes=11), created_by_name="Dispatcher",
    )
    shared_dispatch = Dispatch(
        dispatch_no="DSP/JOURNEY/0002", dispatch_date=date.today(), warehouse_id=1,
        ref_type="WH_ISSUE", ref_id=issue_direct.id,
        ref_no=issue_direct.issue_no, status="DELIVERED",
        gate_out_at=base + timedelta(minutes=12),
        delivered_at=base + timedelta(minutes=13), created_by_name="Dispatcher",
    )
    db.add_all([indirect_dispatch, shared_dispatch])
    await db.flush()
    db.add_all([
        DispatchItem(
            dispatch_id=indirect_dispatch.id, line_no=1, indent_id=None,
            item_id=lines[0].item_id, quantity=2, delivered_qty=2,
        ),
        DispatchItem(
            dispatch_id=shared_dispatch.id, line_no=1, indent_id=indent.id,
            item_id=lines[1].item_id, quantity=3, delivered_qty=3,
        ),
        DispatchItem(
            dispatch_id=shared_dispatch.id, line_no=2, indent_id=888888,
            item_id=lines[1].item_id, quantity=90, delivered_qty=90,
        ),
    ])

    indent_instance = Instance(
        doc_type="INDENT", doc_id=indent.id, doc_no=indent.indent_no,
        workflow_id=1, resolved_chain=[{
            "sequence": 1, "position_name": "Request Approver",
            "approval_mode": "ANY_ONE",
        }], status="APPROVED", started_by_id=77, started_at=base + timedelta(minutes=1),
        completed_at=base + timedelta(minutes=2),
    )
    allocation_instance = Instance(
        doc_type="ALLOCATION", doc_id=direct.id, doc_no=direct.allocation_no,
        workflow_id=2, resolved_chain=[
            {"sequence": 1, "position_name": "Allocation Controller"},
            {"sequence": 2, "position_name": "Inventory Authority"},
        ], status="APPROVED", started_at=base + timedelta(minutes=2),
    )
    issue_instance = Instance(
        doc_type="WH_ISSUE", doc_id=issue_from_line.id, doc_no=issue_from_line.issue_no,
        workflow_id=3, resolved_chain=[
            {"sequence": 1, "position_name": "Warehouse Manager"},
        ], status="APPROVED", started_at=base + timedelta(minutes=5),
    )
    dispatch_instance = Instance(
        doc_type="DISPATCH", doc_id=indirect_dispatch.id,
        doc_no=indirect_dispatch.dispatch_no, workflow_id=4,
        resolved_chain=[{"sequence": 1, "position_name": "Dispatch Manager"}],
        status="APPROVED", started_at=base + timedelta(minutes=9),
    )
    db.add_all([indent_instance, allocation_instance, issue_instance, dispatch_instance])
    await db.flush()
    db.add_all(_workflow(indent_instance.id, ["Request Approver"], base + timedelta(minutes=1)))
    db.add_all(_workflow(
        allocation_instance.id,
        ["Allocation Controller", "Inventory Authority"],
        base + timedelta(minutes=2),
    ))
    db.add_all(_workflow(
        issue_instance.id, ["Warehouse Manager"], base + timedelta(minutes=5),
    ))
    db.add_all(_workflow(
        dispatch_instance.id, ["Dispatch Manager"], base + timedelta(minutes=9),
    ))

    ready_audit = AuditLog(
        entity_type="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action="UPDATE", changed_fields={
            "status": {"from": "PENDING_APPROVAL", "to": "AWAITING_ALLOCATION"},
        }, actor_id=502, actor_name="Request Approver",
        created_at=base + timedelta(minutes=2, seconds=30),
    )
    closed_audit = AuditLog(
        entity_type="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action="UPDATE", changed_fields={
            str(lines[0].id): {"from": 0, "to": 2},
            str(lines[1].id): {"from": 0, "to": 3},
            "status": {"from": "PARTIALLY_FULFILLED", "to": "CLOSED"},
        }, actor_id=77, actor_name="Journey Requester",
        created_at=base + timedelta(minutes=14),
    )
    db.add_all([ready_audit, closed_audit])
    await db.commit()

    graph = await service._resolve_journey_document_graph(db, indent)
    assert graph.allocation_ids == {direct.id, legacy.id}
    assert graph.material_issue_ids == {issue_from_line.id, issue_direct.id}
    assert graph.dispatch_ids == {indirect_dispatch.id, shared_dispatch.id}

    audits = list((await db.execute(
        select(AuditLog).where(
            AuditLog.entity_type == "ind_indents",
            AuditLog.entity_id == indent.id,
        ).order_by(AuditLog.created_at, AuditLog.id)
    )).scalars().all())
    operational = await service._journey_operational_evidence(db, indent, audits)
    assert operational["allocation_complete"] is True
    assert operational["issue_complete"] is True
    assert operational["delivery_complete"] is True
    assert operational["is_complete"] is True
    events = operational["events"]
    assert sum(
        event["event_type"] == "ALLOCATION_APPROVAL_APPROVED"
        for event in events
    ) == 2
    assert any(
        event["event_type"] == "WAREHOUSE_APPROVAL_APPROVED"
        for event in events
    )
    assert len({event["id"] for event in events}) == len(events)
    shared_gate_out = next(
        event for event in events if event["id"] == f"dispatch:{shared_dispatch.id}"
    )
    assert shared_gate_out["quantity_summary"] == "3 of 5"
    completed = next(event for event in events if event["event_type"] == "COMPLETED")
    assert completed["id"] == f"completion:audit:{closed_audit.id}"
    assert completed["timestamp"] == closed_audit.created_at

    journey = await service.indent_journey(
        db, indent.id, SimpleNamespace(id=77, active_position_id=None),
    )
    titles = [stage["title"] for stage in journey["stages"]]
    assert journey["contract_version"] == 5
    assert journey["current_stage_message"] == "Completed"
    assert titles[0] == "Draft created"
    assert "Allocation Controller approved" in titles
    assert "Inventory Authority approved" in titles
    assert "Allocation completed" in titles
    assert "Warehouse Manager approved" in titles
    assert "Warehouse issue completed" in titles
    assert "Dispatched" in titles
    assert "Delivered" in titles
    assert "Acknowledgement submitted" in titles
    assert "Fully received" in titles
    assert titles[-1] == "Completed"
    assert all(stage["timestamp"] is not None for stage in journey["stages"])
    assert all(stage["event_id"] for stage in journey["stages"])
    assert all(stage["status"] != "PENDING" for stage in journey["stages"])


@pytest.mark.asyncio
async def test_per_line_allocation_shortage_is_not_hidden_by_an_excess(db):
    indent, lines = await _indent_with_lines(db, number="IND/JOURNEY/0002")
    lines[0].received_quantity = 0
    lines[1].received_quantity = 0
    allocation = Allocation(
        allocation_no="ALC/JOURNEY/SHORT", indent_id=indent.id,
        status="APPROVED", approved_at=datetime(2026, 8, 3, 9, 0, 0),
    )
    db.add(allocation)
    await db.flush()
    db.add_all([
        AllocationItem(
            allocation_id=allocation.id, indent_item_id=lines[0].id,
            item_id=lines[0].item_id, requested_qty=2, quantity=10,
        ),
        AllocationItem(
            allocation_id=allocation.id, indent_item_id=lines[1].id,
            item_id=lines[1].item_id, requested_qty=3, quantity=1,
        ),
    ])
    await db.commit()

    operational = await service._journey_operational_evidence(db, indent, [])
    assert operational["allocation_complete"] is False
    assert not any(
        event["event_type"] == "ALLOCATION_COMPLETED"
        for event in operational["events"]
    )
