"""Indents module tests: creation rules, the DRAFT->PENDING->AWAITING_ALLOCATION flow through
the engine, edit locking, and an API smoke test with permissions."""
import pytest
from datetime import date, datetime, timedelta, timezone
from time import perf_counter

from sqlalchemy import event, select

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.core.security import hash_password
from app.modules.indents import service
from app.modules.indents.models import IndentItem
from app.modules.indents.schemas import IndentCreate, IndentItemIn, IndentUpdate
from app.modules.indents.enums import (
    AllocationStatus, ApprovalAction, IndentItemStatus, IndentStatus,
)
from app.modules.inventory.models import Allocation, AllocationItem
from app.modules.inventory.schemas import AllocationIn
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.platform.workflow.models import Action, Instance, Pending, Stage, Workflow
from app.shared.enums import ApproverType
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom


async def _count_queries(db, fn):
    bind = db.get_bind()
    target = bind.sync_engine if hasattr(bind, "sync_engine") else bind
    queries = 0

    def before_cursor_execute(*_args):
        nonlocal queries
        queries += 1

    event.listen(target, "before_cursor_execute", before_cursor_execute)
    started = perf_counter()
    try:
        result = await fn()
    finally:
        elapsed_ms = (perf_counter() - started) * 1000
        event.remove(target, "before_cursor_execute", before_cursor_execute)
    return result, queries, elapsed_ms


async def _grant_login(db, employee, username: str, permissions: list[str]):
    employee.emp_code = username
    db.add(UserCredential(employee_id=employee.id, password_hash=hash_password("pw")))
    role = Role(code=f"R_{username}", name=username, is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=employee.id, role_id=role.id))
    for code in permissions:
        perm = (await db.execute(
            select(Permission).where(Permission.code == code)
        )).scalar_one_or_none()
        if perm is None:
            head, _, tail = code.partition(".")
            perm = Permission(
                code=code, module=head, resource=head,
                action=tail or "view", description=code,
            )
            db.add(perm)
            await db.flush()
        db.add(RolePermission(role_id=role.id, permission_id=perm.id))
    await db.commit()


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
    requester.active_position_id = 101
    approver.active_position_id = 100
    return requester, approver, it1, it2


async def _visibility_world(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    db.add_all([
        HcmOffice(id=701, name="Regional Office", is_active=True, synced_at=utcnow()),
        HcmDepartment(id=501, name="Mechanical", synced_at=utcnow()),
    ])
    db.add_all([
        HcmPosition(id=100, name="RM", department_id=501, office_id=701,
                    project_id=900, is_active=True, synced_at=utcnow()),
        HcmPosition(id=110, name="DM", parent_position_id=100, department_id=501,
                    office_id=701, project_id=900, is_active=True, synced_at=utcnow()),
        HcmPosition(id=120, name="OE-1", parent_position_id=110, department_id=501,
                    office_id=701, project_id=900, is_active=True, synced_at=utcnow()),
        HcmPosition(id=130, name="OE-2", parent_position_id=110, department_id=501,
                    office_id=701, project_id=900, is_active=True, synced_at=utcnow()),
        HcmPosition(id=121, name="TL-1", parent_position_id=120, department_id=501,
                    office_id=701, project_id=900, is_active=True, synced_at=utcnow()),
        HcmPosition(id=122, name="Technician-1", parent_position_id=121,
                    department_id=501, office_id=701, project_id=900,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=131, name="Technician-2", parent_position_id=130,
                    department_id=501, office_id=701, project_id=900,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=123, name="Other Project Tech", parent_position_id=120,
                    department_id=501, office_id=701, project_id=901,
                    is_active=True, synced_at=utcnow()),
    ])
    employees = {
        "rm": HcmEmployee(id=20, full_name="RM", emp_code="RM", department_id=501,
                          office_id=701, project_id=900, is_active=True,
                          synced_at=utcnow()),
        "dm": HcmEmployee(id=21, full_name="DM", emp_code="DM", department_id=501,
                          office_id=701, project_id=900, is_active=True,
                          synced_at=utcnow()),
        "oe1": HcmEmployee(id=22, full_name="OE One", emp_code="OE1",
                           department_id=501, office_id=701, project_id=900,
                           is_active=True, synced_at=utcnow()),
        "oe2": HcmEmployee(id=23, full_name="OE Two", emp_code="OE2",
                           department_id=501, office_id=701, project_id=900,
                           is_active=True, synced_at=utcnow()),
        "tech1": HcmEmployee(id=24, full_name="Tech One", emp_code="TECH1",
                             department_id=501, office_id=701, project_id=900,
                             is_active=True, synced_at=utcnow()),
        "tech2": HcmEmployee(id=25, full_name="Tech Two", emp_code="TECH2",
                             department_id=501, office_id=701, project_id=900,
                             is_active=True, synced_at=utcnow()),
        "other_project": HcmEmployee(id=26, full_name="Other Project",
                                     emp_code="PTECH", department_id=501,
                                     office_id=701, project_id=901,
                                     is_active=True, synced_at=utcnow()),
    }
    db.add_all(employees.values())
    assignments = [
        ("rm", 100), ("dm", 110), ("oe1", 120), ("oe2", 130),
        ("tech1", 122), ("tech2", 131), ("other_project", 123),
    ]
    db.add_all([
        HcmPositionAssignment(
            id=index, employee_id=employees[key].id, employee_name=employees[key].full_name,
            position_id=position_id, department_id=501, office_id=701,
            is_primary=True, is_active=True, synced_at=utcnow(),
        )
        for index, (key, position_id) in enumerate(assignments, start=1)
    ])
    wf = Workflow(code="WF-INDENT", name="Indent", doc_type="INDENT", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Reporting Manager",
                 approver_type=ApproverType.REPORTING_MANAGER.value,
                 approval_mode="ANY_ONE"))
    await db.commit()

    for key, position_id in assignments:
        employees[key].active_position_id = position_id

    indents = {
        key: await service.create_indent(db, _create_data(item.id), employee)
        for key, employee in employees.items()
    }
    return {**employees, "item": item, "indents": indents}


async def _production_visibility_world(db):
    uom = Uom(code="NOS-PROD", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-PROD", name="Bolt", uom_id=uom.id, uom_code="NOS-PROD")
    db.add(item)
    db.add_all([
        HcmOffice(id=1701, name="Branch One Office", is_active=True, synced_at=utcnow()),
        HcmOffice(id=1702, name="Branch Two Office", is_active=True, synced_at=utcnow()),
        HcmOffice(id=1710, name="Region One Office", is_active=True, synced_at=utcnow()),
        HcmOffice(id=1711, name="District One Office", is_active=True, synced_at=utcnow()),
        HcmOffice(id=1712, name="OE One Office", is_active=True, synced_at=utcnow()),
        HcmOffice(id=1713, name="Pilot One Office", is_active=True, synced_at=utcnow()),
        HcmDepartment(id=1501, name="Operations", synced_at=utcnow()),
    ])
    positions = {
        "sph": HcmPosition(id=1900, name="STATE PROJECT HEAD-AP",
                           department_id=1501, office_id=1701, project_id=19000,
                           is_active=True, synced_at=utcnow()),
        "coo": HcmPosition(id=1901, name="CHIEF OPERATING OFFICER-AP",
                           department_id=1501, office_id=1701, project_id=19000,
                           is_active=True, synced_at=utcnow()),
        "rm1": HcmPosition(id=1910, name="REGIONAL MANAGER-AP-104",
                           parent_position_id=1900, department_id=1501,
                           office_id=1710, project_id=19000,
                           is_active=True, synced_at=utcnow()),
        "rm2": HcmPosition(id=1920, name="REGIONAL MANAGER-AP-205",
                           parent_position_id=1900, department_id=1501,
                           office_id=1702, project_id=29000,
                           is_active=True, synced_at=utcnow()),
        "dm1": HcmPosition(id=1911, name="DISTRICT MANAGER-AP-104-HINDUPUR",
                           parent_position_id=1910, department_id=1501,
                           office_id=1711, project_id=19000,
                           is_active=True, synced_at=utcnow()),
        "dm2": HcmPosition(id=1921, name="DISTRICT MANAGER-AP-205-ANANTAPUR",
                           parent_position_id=1920, department_id=1501,
                           office_id=1702, project_id=29000,
                           is_active=True, synced_at=utcnow()),
        "oe1": HcmPosition(id=1912, name="OPERATION EXECUTIVE-AP-104-MMU",
                           parent_position_id=1911, department_id=1501,
                           office_id=1712, project_id=19000,
                           is_active=True, synced_at=utcnow()),
        "oe2": HcmPosition(id=1922, name="OPERATIONS EXECUTIVE-AP-205-MMU",
                           parent_position_id=1921, department_id=1501,
                           office_id=1702, project_id=29000,
                           is_active=True, synced_at=utcnow()),
        "pilot1": HcmPosition(id=1913, name="PILOT-AP-104-MMU",
                              parent_position_id=1912, department_id=1501,
                              office_id=1713, project_id=19000,
                              is_active=True, synced_at=utcnow()),
        "driver1": HcmPosition(id=1914, name="DRIVER-AP-104-MMU",
                               parent_position_id=1912, department_id=1501,
                               office_id=1701, project_id=19000,
                               is_active=True, synced_at=utcnow()),
        "tl2": HcmPosition(id=1923, name="TL-AP-205-MMU",
                           parent_position_id=1922, department_id=1501,
                           office_id=1702, project_id=29000,
                           is_active=True, synced_at=utcnow()),
    }
    db.add_all(positions.values())
    employees = {
        key: HcmEmployee(
            id=1800 + index,
            full_name=key.upper(),
            emp_code=key.upper(),
            department_id=1501,
            office_id=position.office_id,
            project_id=position.project_id,
            is_active=True,
            synced_at=utcnow(),
        )
        for index, (key, position) in enumerate(positions.items(), start=1)
    }
    db.add_all(employees.values())
    db.add_all([
        HcmPositionAssignment(
            id=1800 + index,
            employee_id=employees[key].id,
            employee_name=employees[key].full_name,
            position_id=position.id,
            position_name=position.name,
            department_id=1501,
            office_id=position.office_id,
            is_primary=True,
            is_active=True,
            synced_at=utcnow(),
        )
        for index, (key, position) in enumerate(positions.items(), start=1)
    ])
    wf = Workflow(code="WF-INDENT-PROD", name="Indent Prod", doc_type="INDENT", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Reporting Manager",
                 approver_type=ApproverType.REPORTING_MANAGER.value,
                 approval_mode="ANY_ONE"))
    await db.commit()
    for key, position in positions.items():
        employees[key].active_position_id = position.id
    indents = {
        key: await service.create_indent(db, _create_data(item.id), employees[key])
        for key in ("rm1", "rm2", "dm1", "dm2", "oe1", "oe2", "pilot1", "driver1", "tl2")
    }
    return {**employees, "item": item, "positions": positions, "indents": indents}


async def _approval_ladder_world(db, *, correction_ladder: bool = False):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    db.add(HcmOffice(id=801, name="Branch Office", is_active=True, synced_at=utcnow()))
    db.add(HcmDepartment(id=601, name="Operations", synced_at=utcnow()))
    db.add_all([
        HcmPosition(id=1000, name="Pilot", role_id=6, role_name="Pilot",
                    parent_position_id=1001, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=1001, name="OE", role_id=5, role_name="OE",
                    parent_position_id=1002, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=1002, name="DM", role_id=4, role_name="DM",
                    parent_position_id=1003, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=1003, name="RM", role_id=3, role_name="RM",
                    parent_position_id=1004, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=1004, name="SPH", role_id=2, role_name="SPH",
                    parent_position_id=1005, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
        HcmPosition(id=1005, name="COO", role_id=1, role_name="COO",
                    department_id=601, office_id=801, is_active=True,
                    synced_at=utcnow()),
        HcmPosition(id=1006, name="Sibling OE", role_id=5, role_name="OE",
                    parent_position_id=1002, department_id=601, office_id=801,
                    is_active=True, synced_at=utcnow()),
    ])
    employees = {
        "pilot": HcmEmployee(id=51, full_name="Pilot", emp_code="PILOT",
                             department_id=601, office_id=801, is_active=True,
                             synced_at=utcnow()),
        "oe": HcmEmployee(id=52, full_name="OE", emp_code="OE",
                          department_id=601, office_id=801, is_active=True,
                          synced_at=utcnow()),
        "dm": HcmEmployee(id=53, full_name="DM", emp_code="DM",
                          department_id=601, office_id=801, is_active=True,
                          synced_at=utcnow()),
        "rm": HcmEmployee(id=54, full_name="RM", emp_code="RM",
                          department_id=601, office_id=801, is_active=True,
                          synced_at=utcnow()),
        "sph": HcmEmployee(id=55, full_name="SPH", emp_code="SPH",
                           department_id=601, office_id=801, is_active=True,
                           synced_at=utcnow()),
        "coo": HcmEmployee(id=56, full_name="COO", emp_code="COO",
                           department_id=601, office_id=801, is_active=True,
                           synced_at=utcnow()),
        "sibling_oe": HcmEmployee(id=57, full_name="Sibling OE", emp_code="SIBOE",
                                  department_id=601, office_id=801,
                                  is_active=True, synced_at=utcnow()),
    }
    db.add_all(employees.values())
    assignments = [
        ("pilot", 1000), ("oe", 1001), ("dm", 1002), ("rm", 1003),
        ("sph", 1004), ("coo", 1005), ("sibling_oe", 1006),
    ]
    db.add_all([
        HcmPositionAssignment(
            id=2000 + index, employee_id=employees[key].id,
            employee_name=employees[key].full_name, position_id=position_id,
            department_id=601, office_id=801, is_primary=True,
            is_active=True, synced_at=utcnow(),
        )
        for index, (key, position_id) in enumerate(assignments, start=1)
    ])
    wf = Workflow(code="WF-INDENT", name="Indent", doc_type="INDENT", is_active=True)
    db.add(wf)
    await db.flush()
    if correction_ladder:
        for sequence, role_id, name in [
            (1, 5, "OE"),
            (2, 4, "DM"),
            (3, 3, "RM"),
            (4, 2, "SPH"),
            (5, 1, "COO"),
        ]:
            db.add(Stage(
                workflow_id=wf.id, sequence=sequence, name=name,
                approver_type=ApproverType.REPORTING_MANAGER.value,
                position_role_id=role_id, approval_mode="ANY_ONE",
            ))
    else:
        db.add(Stage(workflow_id=wf.id, sequence=1, name="Reporting Manager",
                     approver_type=ApproverType.REPORTING_MANAGER.value,
                     approval_mode="ANY_ONE"))
    await db.commit()

    for key, position_id in assignments:
        employees[key].active_position_id = position_id
    await _grant_login(
        db, employees["pilot"], "pilot",
        ["indent.view", "indent.submit", "indent.edit"],
    )
    for key in ("oe", "dm", "rm", "sph", "coo", "sibling_oe"):
        await _grant_login(
            db, employees[key], key, ["indent.view", "indent.approve", "indent.reject"],
        )
    for key, position_id in assignments:
        employees[key].active_position_id = position_id

    indent = await service.create_indent(db, _create_data(item.id), employees["pilot"])
    return {**employees, "item": item, "indent": indent}


def _create_data(item_id):
    return IndentCreate(
        items=[IndentItemIn(item_id=item_id, quantity=5)],
        required_date=date.today(),
        remarks="test",
    )


def test_unique_item_id_validation_helper():
    service._validate_unique_item_ids([
        IndentItemIn(item_id=1, quantity=2),
        IndentItemIn(item_id=2, quantity=3),
    ])

    with pytest.raises(ValidationError) as exc:
        service._validate_unique_item_ids([
            IndentItemIn(item_id=1, quantity=2),
            IndentItemIn(item_id=1, quantity=3),
        ])

    assert str(exc.value) == service.DUPLICATE_ITEM_ERROR


async def _draft_chain_world(db, *, depth: int, id_base: int):
    uom = Uom(code=f"NOS{id_base}", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code=f"IT-{id_base}", name="Bolt", uom_id=uom.id, uom_code=uom.code)
    requester = HcmEmployee(
        id=id_base,
        full_name=f"Requester {id_base}",
        emp_code=f"REQ{id_base}",
        is_active=True,
        synced_at=utcnow(),
    )
    db.add_all([item, requester])
    positions = [
        HcmPosition(
            id=id_base + index,
            name=f"Position {index}",
            parent_position_id=(id_base + index + 1) if index < depth else None,
            is_active=True,
            synced_at=utcnow(),
        )
        for index in range(depth + 1)
    ]
    db.add_all(positions)
    employees = [
        HcmEmployee(
            id=id_base + 100 + index,
            full_name=f"Holder {index}",
            emp_code=f"H{id_base}{index}",
            is_active=True,
            synced_at=utcnow(),
        )
        for index in range(1, depth + 1)
    ]
    db.add_all(employees)
    db.add(HcmPositionAssignment(
        id=id_base,
        employee_id=requester.id,
        position_id=id_base,
        is_primary=True,
        is_active=True,
        synced_at=utcnow(),
    ))
    db.add_all([
        HcmPositionAssignment(
            id=id_base + index,
            employee_id=employees[index - 1].id,
            employee_name=employees[index - 1].full_name,
            position_id=id_base + index,
            is_primary=True,
            is_active=True,
            synced_at=utcnow(),
        )
        for index in range(1, depth + 1)
    ])
    await db.commit()
    requester.active_position_id = id_base
    indent = await service.create_indent(db, _create_data(item.id), requester)
    return requester, indent


async def test_create_requires_items(db):
    requester, *_ = await _world(db)
    with pytest.raises(ValidationError):
        await service.create_indent(
            db,
            IndentCreate(items=[], required_date=date.today()),
            requester,
        )


async def test_create_rejects_duplicate_item_ids(db):
    requester, _approver, it1, _it2 = await _world(db)
    data = IndentCreate(
        items=[
            IndentItemIn(item_id=it1.id, quantity=2),
            IndentItemIn(item_id=it1.id, quantity=3),
        ],
        required_date=date.today(),
    )

    with pytest.raises(ValidationError) as exc:
        await service.create_indent(db, data, requester)

    assert str(exc.value) == service.DUPLICATE_ITEM_ERROR


async def test_create_rejects_item_with_zero_quantity(db):
    requester, _approver, it1, it2 = await _world(db)
    # Pydantic Field(gt=0) already blocks quantity=0 at schema level;
    # verify the service-level guard also raises ValidationError for any
    # quantity that somehow passes (e.g. after a schema relaxation).
    with pytest.raises(Exception):
        # quantity=0 is rejected at Pydantic level (Field gt=0), which is correct
        IndentItemIn(item_id=it1.id, quantity=0)


async def test_create_rejects_item_with_negative_quantity(db):
    requester, _approver, it1, _it2 = await _world(db)
    with pytest.raises(Exception):
        # negative quantity is rejected at Pydantic level (Field gt=0)
        IndentItemIn(item_id=it1.id, quantity=-5)


async def test_create_accepts_valid_item_quantities(db):
    requester, _approver, it1, it2 = await _world(db)
    data = IndentCreate(
        items=[
            IndentItemIn(item_id=it1.id, quantity=3),
            IndentItemIn(item_id=it2.id, quantity=7),
        ],
        required_date=date.today(),
    )
    indent = await service.create_indent(db, data, requester)
    assert indent.total_items == 2
    assert float(indent.total_qty) == 10


async def test_update_rejects_item_with_zero_quantity(db):
    requester, _approver, it1, it2 = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    with pytest.raises(Exception):
        # Pydantic Field(gt=0) blocks quantity=0 — correct defence-in-depth
        IndentItemIn(item_id=it2.id, quantity=0)


async def test_update_rejects_item_with_negative_quantity(db):
    requester, _approver, it1, it2 = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    with pytest.raises(Exception):
        IndentItemIn(item_id=it2.id, quantity=-1)


async def test_update_accepts_valid_item_quantities(db):
    requester, _approver, it1, it2 = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    updated = await service.update_indent(
        db, indent.id,
        IndentUpdate(
            required_date=date.today(),
            items=[
                IndentItemIn(item_id=it1.id, quantity=10),
                IndentItemIn(item_id=it2.id, quantity=20),
            ],
        ),
        requester,
    )
    assert updated.total_items == 2
    assert float(updated.total_qty) == 30


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
    assert indent.items[0].uom_code == it1.uom_code      # UOM snapshot


async def test_create_rejects_past_required_date(db):
    requester, _approver, it1, _ = await _world(db)

    with pytest.raises(ValidationError, match="Required date cannot be earlier than today"):
        await service.create_indent(
            db,
            IndentCreate(
                items=[IndentItemIn(item_id=it1.id, quantity=5)],
                required_date=date.today() - timedelta(days=1),
            ),
            requester,
        )


async def test_create_rejects_missing_required_date(db):
    requester, _approver, it1, _ = await _world(db)

    with pytest.raises(ValidationError, match="Required date is mandatory."):
        await service.create_indent(
            db,
            IndentCreate(items=[IndentItemIn(item_id=it1.id, quantity=5)]),
            requester,
        )


async def test_update_rejects_missing_required_date(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)

    with pytest.raises(ValidationError, match="Required date is mandatory."):
        await service.update_indent(
            db,
            indent.id,
            IndentUpdate(remarks="Missing required date"),
            requester,
        )


async def test_create_accepts_today_and_future_required_dates(db):
    requester, _approver, it1, _ = await _world(db)
    today = date.today()

    today_indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today,
        ),
        requester,
    )
    future_indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today + timedelta(days=1),
        ),
        requester,
    )

    assert today_indent.required_date == today
    assert future_indent.required_date == today + timedelta(days=1)


async def test_cannot_approve_before_submit(db):
    requester, approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    with pytest.raises(NotFoundError):
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


async def test_self_approval_is_rejected(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)

    with pytest.raises(ValidationError):
        await service.act_on_indent(
            db, indent.id, ApprovalAction.APPROVED, "self", requester,
        )


async def test_pilot_submit_routes_to_oe_current_approver(db):
    world = await _approval_ladder_world(db)

    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    pending = (await db.execute(
        select(Pending).where(Pending.doc_id == world["indent"].id)
    )).scalars().all()

    assert submitted.status == IndentStatus.PENDING_APPROVAL.value
    assert submitted.current_approver_name == "OE"
    assert {row.approver_id for row in pending} == {world["oe"].id}


async def test_reject_requires_and_exposes_trimmed_reason_in_journey(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    with pytest.raises(ValidationError, match=service.REJECTION_REASON_REQUIRED_ERROR):
        await service.act_on_indent(
            db,
            world["indent"].id,
            ApprovalAction.REJECTED,
            "   ",
            world["oe"],
        )

    rejected = await service.act_on_indent(
        db,
        world["indent"].id,
        ApprovalAction.REJECTED,
        "  Incorrect quantity  ",
        world["oe"],
    )
    journey = await service.indent_journey(db, world["indent"].id, world["pilot"])
    rejected_stage = next(stage for stage in journey["stages"] if stage["status"] == "REJECTED")

    assert rejected.status == IndentStatus.REJECTED.value
    assert rejected_stage["title"] == "OE Review"
    assert rejected_stage["approver_name"] == "OE"
    assert rejected_stage["comments"] == "Incorrect quantity"


async def test_reporting_manager_ladder_advances_oe_to_dm_to_rm_to_final_group(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    after_oe = await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "oe", world["oe"],
    )
    assert after_oe.status == IndentStatus.PENDING_APPROVAL.value
    assert after_oe.current_approver_name == "DM"

    after_dm = await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "dm", world["dm"],
    )
    assert after_dm.status == IndentStatus.PENDING_APPROVAL.value
    assert after_dm.current_approver_name == "RM"

    after_rm = await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "rm", world["rm"],
    )
    assert after_rm.status == IndentStatus.PENDING_APPROVAL.value
    assert set(after_rm.current_approver_name.split(", ")) == {"SPH", "COO"}
    pending = (await db.execute(
        select(Pending).where(Pending.doc_id == world["indent"].id)
    )).scalars().all()
    assert {row.approver_id for row in pending} == {world["sph"].id, world["coo"].id}


async def test_first_stage_return_for_correction_assigns_requester_and_no_pending(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    instance_id = (await db.execute(
        select(Instance.id).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == submitted.id,
        )
    )).scalar_one()

    returned = await service.return_indent_for_correction(
        db, submitted.id, "fix quantity", world["oe"],
    )
    state = await service.engine.get_correction_state(db, "INDENT", submitted.id)
    pending = (await db.execute(
        select(Pending).where(Pending.doc_id == submitted.id)
    )).scalars().all()
    requester_detail = await service.get_indent(db, submitted.id, world["pilot"])
    requester_can_edit = requester_detail.can_edit_correction
    requester_can_resubmit = requester_detail.can_resubmit_correction
    requester_can_approve = requester_detail.can_approve
    requester_can_reject = requester_detail.can_reject
    oe_detail = await service.get_indent(db, submitted.id, world["oe"])
    same_instance_id = (await db.execute(
        select(Instance.id).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == submitted.id,
        )
    )).scalar_one()

    assert returned.status == IndentStatus.RETURNED_FOR_CORRECTION.value
    assert state["correction_owner_employee_id"] == world["pilot"].id
    assert state["correction_owner_position_id"] == 1000
    assert state["resubmit_target_sequence"] == 1
    assert state["correction_comment"] == "fix quantity"
    assert pending == []
    assert requester_can_edit is True
    assert requester_can_resubmit is True
    assert requester_can_approve is False
    assert requester_can_reject is False
    assert oe_detail.can_edit_correction is False
    assert oe_detail.can_resubmit_correction is False
    assert same_instance_id == instance_id


async def test_correction_owner_can_edit_same_indent_items_and_quantities(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.return_indent_for_correction(
        db, submitted.id, "increase quantity", world["oe"],
    )

    updated = await service.update_indent(
        db,
        submitted.id,
        IndentUpdate(
            required_date=date.today(),
            remarks="corrected",
            items=[IndentItemIn(item_id=world["item"].id, quantity=9)],
        ),
        world["pilot"],
    )

    assert updated.id == submitted.id
    assert updated.status == IndentStatus.RETURNED_FOR_CORRECTION.value
    assert updated.remarks == "corrected"
    assert float(updated.total_qty) == 9
    assert [float(line.quantity) for line in updated.items] == [9]


async def test_non_owner_cannot_edit_or_resubmit_and_wrong_position_is_blocked(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.return_indent_for_correction(
        db, submitted.id, "requester correction", world["oe"],
    )

    with pytest.raises(NotFoundError):
        await service.update_indent(
            db,
            submitted.id,
            IndentUpdate(required_date=date.today(), remarks="not mine"),
            world["sibling_oe"],
        )
    with pytest.raises(NotFoundError):
        await service.resubmit_indent_correction(db, submitted.id, world["sibling_oe"])

    world["pilot"].active_position_id = 1001
    with pytest.raises(NotFoundError):
        await service.resubmit_indent_correction(db, submitted.id, world["pilot"])


async def test_correction_blocks_delete_normal_submit_approve_and_reject(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.return_indent_for_correction(
        db, submitted.id, "requester correction", world["oe"],
    )

    with pytest.raises(ValidationError):
        await service.delete_indent(db, submitted.id, world["pilot"])
    with pytest.raises(ValidationError):
        await service.submit_indent(db, submitted.id, world["pilot"])
    with pytest.raises(ValidationError):
        await service.act_on_indent(
            db, submitted.id, ApprovalAction.APPROVED, "approve", world["oe"],
        )
    with pytest.raises(ValidationError):
        await service.act_on_indent(
            db, submitted.id, ApprovalAction.REJECTED, "reject", world["oe"],
        )


async def test_resubmit_correction_reopens_returning_stage_on_same_instance(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    instance_id = (await db.execute(
        select(Instance.id).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == submitted.id,
        )
    )).scalar_one()
    await service.return_indent_for_correction(
        db, submitted.id, "requester correction", world["oe"],
    )

    resubmitted = await service.resubmit_indent_correction(
        db, submitted.id, world["pilot"],
    )
    pending = (await db.execute(
        select(Pending).where(Pending.doc_id == submitted.id)
    )).scalars().all()
    same_instance_id = (await db.execute(
        select(Instance.id).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == submitted.id,
        )
    )).scalar_one()

    assert resubmitted.status == IndentStatus.PENDING_APPROVAL.value
    assert resubmitted.current_approver_name == "OE"
    assert {row.approver_id for row in pending} == {world["oe"].id}
    assert same_instance_id == instance_id
    assert await service.engine.get_correction_state(db, "INDENT", submitted.id) is None


async def test_later_stage_return_assigns_exact_dm_actor_and_preserves_history(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    alternate_dm = HcmEmployee(
        id=58, full_name="Alternate DM", emp_code="ALTDM",
        department_id=601, office_id=801, is_active=True, synced_at=utcnow(),
    )
    db.add(alternate_dm)
    db.add(HcmPositionAssignment(
        id=2010, employee_id=alternate_dm.id,
        employee_name=alternate_dm.full_name, position_id=1002,
        department_id=601, office_id=801, is_primary=True,
        is_active=True, synced_at=utcnow(),
    ))
    alternate_dm.active_position_id = 1002
    await db.commit()
    alternate_dm.active_position_id = 1002

    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.act_on_indent(
        db, submitted.id, ApprovalAction.APPROVED, "oe ok", world["oe"],
    )
    await service.act_on_indent(
        db, submitted.id, ApprovalAction.APPROVED, "dm ok", world["dm"],
    )

    returned = await service.return_indent_for_correction(
        db, submitted.id, "dm must correct", world["rm"],
    )
    state = await service.engine.get_correction_state(db, "INDENT", submitted.id)
    instance_id = (await db.execute(
        select(Instance.id).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == submitted.id,
        )
    )).scalar_one()
    actions = (await db.execute(
        select(Action).where(Action.instance_id == instance_id).order_by(Action.id)
    )).scalars().all()
    approval_actions = [
        row for row in actions
        if row.action in {ApprovalAction.APPROVED.value, ApprovalAction.RETURNED.value}
    ]

    assert returned.status == IndentStatus.RETURNED_FOR_CORRECTION.value
    assert state["correction_owner_employee_id"] == world["dm"].id
    assert state["correction_owner_employee_id"] != alternate_dm.id
    assert state["correction_owner_position_id"] == 1002
    assert state["resubmit_target_sequence"] == 3
    assert [row.action for row in approval_actions] == [
        ApprovalAction.APPROVED.value,
        ApprovalAction.APPROVED.value,
        ApprovalAction.RETURNED.value,
    ]
    assert [row.comments for row in approval_actions] == [
        "oe ok", "dm ok", "dm must correct",
    ]


async def test_dm_return_gives_oe_dynamic_correction_edit_and_resubmit(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.act_on_indent(
        db, submitted.id, ApprovalAction.APPROVED, "oe ok", world["oe"],
    )

    returned = await service.return_indent_for_correction(
        db, submitted.id, "oe must correct", world["dm"],
    )
    state = await service.engine.get_correction_state(db, "INDENT", submitted.id)
    oe_detail = await service.get_indent(db, submitted.id, world["oe"])

    edited = await service.update_indent(
        db,
        submitted.id,
        IndentUpdate(required_date=date.today(), remarks="corrected by oe"),
        world["oe"],
    )
    resubmitted = await service.resubmit_indent_correction(
        db, submitted.id, world["oe"],
    )

    assert returned.status == IndentStatus.RETURNED_FOR_CORRECTION.value
    assert state["correction_owner_employee_id"] == world["oe"].id
    assert state["correction_owner_position_id"] == 1001
    assert state["resubmit_target_sequence"] == 2
    assert oe_detail.can_edit_correction is True
    assert oe_detail.can_resubmit_correction is True
    assert edited.remarks == "corrected by oe"
    assert resubmitted.status == IndentStatus.PENDING_APPROVAL.value
    assert resubmitted.current_approver_name == "DM"


async def test_repeated_return_resubmit_refreshes_correction_state_and_blocks_duplicate(db):
    world = await _approval_ladder_world(db, correction_ladder=True)
    submitted = await service.submit_indent(db, world["indent"].id, world["pilot"])
    await service.return_indent_for_correction(
        db, submitted.id, "first correction", world["oe"],
    )
    first_state = await service.engine.get_correction_state(db, "INDENT", submitted.id)
    await service.resubmit_indent_correction(db, submitted.id, world["pilot"])

    with pytest.raises(ValidationError):
        await service.resubmit_indent_correction(db, submitted.id, world["pilot"])

    await service.return_indent_for_correction(
        db, submitted.id, "second correction", world["oe"],
    )
    second_state = await service.engine.get_correction_state(db, "INDENT", submitted.id)

    assert second_state["return_action_id"] != first_state["return_action_id"]
    assert second_state["correction_comment"] == "second correction"
    assert second_state["resubmit_target_sequence"] == 1


async def test_sph_final_approval_moves_to_allocation(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])
    for key in ("oe", "dm", "rm"):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, key, world[key],
        )

    result = await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "final", world["sph"],
    )
    instance = (await db.execute(
        select(Instance).where(Instance.doc_type == "INDENT", Instance.doc_id == world["indent"].id)
    )).scalar_one()

    assert instance.status == "APPROVED"
    assert result.status == IndentStatus.AWAITING_ALLOCATION.value


async def test_coo_can_complete_final_any_one_first(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])
    for key in ("oe", "dm", "rm"):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, key, world[key],
        )

    result = await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "final", world["coo"],
    )

    assert result.status == IndentStatus.AWAITING_ALLOCATION.value


async def test_journey_uses_requester_specific_stages_and_final_any_one(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])
    for key in ("oe", "dm", "rm"):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, key, world[key],
        )
    await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "final", world["sph"],
    )

    journey = await service.indent_journey(db, world["indent"].id, world["pilot"])

    titles = [stage["title"] for stage in journey["stages"]]
    assert titles[:6] == [
        "Draft created", "Request submitted", "OE Review", "DM Review", "RM Review",
        "Final Approval - SPH or COO",
    ]
    assert [phase["title"] for phase in journey["phases"]] == [
        "Draft", "Submitted", "Approvals", "Allocation", "Warehouse",
        "Delivery", "Acknowledgement",
    ]
    assert any(
        stage["status"] == "NOT_REQUIRED" and stage["approver_name"] == "COO"
        for stage in journey["stages"]
    )
    assert journey["final_any_one_outcome"] == "Approved by SPH"
    assert any(event["event_type"] == "APPROVED" for event in journey["history"])


async def test_journey_marks_only_active_pending_stage_current(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    journey = await service.indent_journey(db, world["indent"].id, world["pilot"])
    current_stages = [stage for stage in journey["stages"] if stage.get("is_current")]

    assert len(current_stages) == 1
    assert current_stages[0]["title"] == "OE Review"
    assert all(
        not stage.get("is_current")
        for stage in journey["stages"]
        if stage["title"] in {"DM Review", "RM Review", "Final Approval - SPH or COO"}
    )


async def test_final_any_one_journey_uses_successful_final_approver(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])
    instance = (await db.execute(
        select(Instance).where(
            Instance.doc_type == "INDENT",
            Instance.doc_id == world["indent"].id,
        )
    )).scalar_one()
    db.add_all([
        Action(
            instance_id=instance.id,
            stage_sequence=4,
            stage_name="Final Approval",
            actor_id=world["sph"].id,
            actor_name="SPH",
            actor_position="SPH",
            action=ApprovalAction.REJECTED.value,
            comments="not this route",
            acted_at=utcnow(),
        ),
        Action(
            instance_id=instance.id,
            stage_sequence=4,
            stage_name="Final Approval",
            actor_id=world["coo"].id,
            actor_name="COO",
            actor_position="COO",
            action=ApprovalAction.APPROVED.value,
            comments="approved by coo",
            acted_at=utcnow() + timedelta(minutes=5),
        ),
    ])
    await db.commit()

    journey = await service.indent_journey(db, world["indent"].id, world["pilot"])

    assert journey["final_any_one_outcome"] == "Approved by COO"
    final_stage = next(stage for stage in journey["stages"] if stage["stage_type"] == "final")
    assert final_stage["status"] == "APPROVED"
    assert final_stage["approver_name"] == "COO"
    assert not any(
        stage["stage_type"] == "final_any_one_peer"
        and stage["approver_name"] == "SPH"
        and stage["status"] == "NOT_REQUIRED"
        for stage in journey["stages"]
    )


async def test_journey_attaches_utc_to_naive_timestamps(db):
    world = await _approval_ladder_world(db)
    naive_created = datetime(2026, 7, 27, 16, 49, 0)
    world["indent"].created_at = naive_created
    await db.commit()

    journey = await service.indent_journey(db, world["indent"].id, world["pilot"])

    assert journey["created_at"].tzinfo is not None
    assert journey["created_at"].isoformat().endswith("+00:00")
    assert journey["stages"][0]["timestamp"].tzinfo is not None


async def test_journey_query_count_does_not_grow_per_hierarchy_level(db):
    shallow_user, shallow_indent = await _draft_chain_world(db, depth=3, id_base=7000)
    deep_user, deep_indent = await _draft_chain_world(db, depth=8, id_base=8000)

    _, shallow_queries, shallow_ms = await _count_queries(
        db,
        lambda: service.indent_journey(db, shallow_indent.id, shallow_user),
    )
    _, deep_queries, deep_ms = await _count_queries(
        db,
        lambda: service.indent_journey(db, deep_indent.id, deep_user),
    )

    assert deep_queries <= shallow_queries + 2
    assert shallow_ms >= 0
    assert deep_ms >= 0


async def test_final_transition_and_fulfilment_run_once(db, monkeypatch):
    world = await _approval_ladder_world(db)
    calls = 0
    original_fulfil = service._fulfil

    async def counted_fulfil(db_arg, indent, user):
        nonlocal calls
        calls += 1
        await original_fulfil(db_arg, indent, user)

    monkeypatch.setattr(service, "_fulfil", counted_fulfil)
    await service.submit_indent(db, world["indent"].id, world["pilot"])
    for key in ("oe", "dm", "rm"):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, key, world[key],
        )
    assert calls == 0

    await service.act_on_indent(
        db, world["indent"].id, ApprovalAction.APPROVED, "final", world["sph"],
    )
    assert calls == 1

    with pytest.raises(ValidationError):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, "late", world["coo"],
        )
    assert calls == 1


async def test_requester_detail_capabilities_never_allow_self_approval(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    detail = await service.get_indent(db, world["indent"].id, world["pilot"])

    assert detail.can_submit is False
    assert detail.can_approve is False
    assert detail.can_reject is False


async def test_current_approver_detail_capabilities_allow_actions(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    detail = await service.get_indent(db, world["indent"].id, world["oe"])

    assert detail.can_approve is True
    assert detail.can_reject is True


async def test_same_position_pending_holder_can_approve(db):
    requester, _approver, it1, _ = await _world(db)
    observer = HcmEmployee(id=4, full_name="Other Manager", emp_code="E4",
                           is_active=True, synced_at=utcnow())
    db.add(observer)
    db.add(HcmPositionAssignment(id=3, employee_id=observer.id, position_id=100,
                                 is_primary=True, is_active=True, synced_at=utcnow()))
    await db.commit()
    observer.active_position_id = 100

    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)

    result = await service.act_on_indent(
        db, indent.id, ApprovalAction.APPROVED, "same position holder", observer,
    )
    assert result.status == IndentStatus.AWAITING_ALLOCATION.value


async def test_cannot_edit_after_submit(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)
    with pytest.raises(ValidationError):
        await service.update_indent(db, indent.id, IndentUpdate(remarks="late edit"), requester)


async def test_update_draft_delivery_office(db):
    requester, _approver, it1, _ = await _world(db)
    db.add(HcmOffice(id=702, name="Branch Office", is_active=True, synced_at=utcnow()))
    await db.commit()
    indent = await service.create_indent(db, _create_data(it1.id), requester)

    updated = await service.update_indent(
        db,
        indent.id,
        IndentUpdate(required_date=date.today(), office_id=702),
        requester,
    )

    assert updated.office_id == 702
    assert updated.office_name == "Branch Office"


async def test_requester_can_delete_draft(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    indent_id = indent.id

    await service.delete_indent(db, indent_id, requester)

    with pytest.raises(NotFoundError):
        await service.get_indent(db, indent_id)


async def test_cannot_delete_after_submit(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)

    with pytest.raises(ValidationError):
        await service.delete_indent(db, indent.id, requester)


async def test_update_rejects_duplicate_item_ids(db):
    requester, _approver, it1, it2 = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)

    with pytest.raises(ValidationError) as exc:
        await service.update_indent(
            db,
            indent.id,
            IndentUpdate(
                required_date=date.today(),
                items=[
                    IndentItemIn(item_id=it2.id, quantity=2),
                    IndentItemIn(item_id=it2.id, quantity=3),
                ],
            ),
            requester,
        )

    assert str(exc.value) == service.DUPLICATE_ITEM_ERROR
    unchanged = await service.get_indent(db, indent.id, requester)
    assert [line.item_id for line in unchanged.items] == [it1.id]


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

    r = await client.post(
        "/api/indents",
        json={
            "required_date": date.today().isoformat(),
            "items": [{"item_id": item.id, "quantity": 5}],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "DRAFT"
    assert r.json()["indent_no"].startswith("IND/")

    lst = await client.get("/api/indents", headers=headers)
    assert lst.status_code == 200
    assert lst.json()["total"] >= 1


async def test_required_date_api_validation_for_create_and_update(
    client, db, make_user, login,
):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    await db.commit()

    await make_user(
        employee_id=2,
        username="req",
        password="pw",
        permissions=["indent.view", "indent.create", "indent.edit"],
    )
    headers = await login("req", "pw")
    items = [{"item_id": item.id, "quantity": 5}]

    missing_create = await client.post(
        "/api/indents",
        json={"items": items},
        headers=headers,
    )
    assert missing_create.status_code == 422
    assert missing_create.json() == {
        "success": False,
        "error": service.REQUIRED_DATE_MANDATORY_ERROR,
    }

    created = await client.post(
        "/api/indents",
        json={"required_date": date.today().isoformat(), "items": items},
        headers=headers,
    )
    assert created.status_code == 200, created.text

    missing_update = await client.put(
        f"/api/indents/{created.json()['id']}",
        json={"items": items},
        headers=headers,
    )
    assert missing_update.status_code == 422
    assert missing_update.json() == {
        "success": False,
        "error": service.REQUIRED_DATE_MANDATORY_ERROR,
    }


async def test_duplicate_item_api_validation_for_create_and_update(
    client, db, make_user, login,
):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item1 = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    item2 = Item(code="IT-0002", name="Nut", uom_id=uom.id, uom_code="NOS")
    db.add_all([item1, item2])
    await db.commit()

    await make_user(
        employee_id=2,
        username="req",
        password="pw",
        permissions=["indent.view", "indent.create", "indent.edit"],
    )
    headers = await login("req", "pw")
    unique_items = [
        {"item_id": item1.id, "quantity": 2},
        {"item_id": item2.id, "quantity": 3},
    ]
    required_date = date.today().isoformat()

    created = await client.post(
        "/api/indents",
        json={"required_date": required_date, "items": unique_items},
        headers=headers,
    )
    assert created.status_code == 200, created.text

    updated = await client.put(
        f"/api/indents/{created.json()['id']}",
        json={"required_date": required_date, "items": list(reversed(unique_items))},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text

    duplicate_items = [
        {"item_id": item1.id, "quantity": 2},
        {"item_id": item1.id, "quantity": 3},
    ]
    duplicate_create = await client.post(
        "/api/indents",
        json={"required_date": required_date, "items": duplicate_items},
        headers=headers,
    )
    duplicate_update = await client.put(
        f"/api/indents/{created.json()['id']}",
        json={"required_date": required_date, "items": duplicate_items},
        headers=headers,
    )

    expected = {"success": False, "error": service.DUPLICATE_ITEM_ERROR}
    assert duplicate_create.status_code == 422
    assert duplicate_create.json() == expected
    assert duplicate_update.status_code == 422
    assert duplicate_update.json() == expected


async def test_draft_update_and_delete_via_api(client, db, make_user, login):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item1 = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    item2 = Item(code="IT-0002", name="Nut", uom_id=uom.id, uom_code="NOS")
    db.add_all([item1, item2])
    await db.commit()

    await make_user(
        employee_id=2,
        username="draft-owner",
        password="pw",
        permissions=[
            "indent.view",
            "indent.create",
            "indent.edit",
        ],
    )
    headers = await login("draft-owner", "pw")
    required_date = (date.today() + timedelta(days=2)).isoformat()
    created = await client.post(
        "/api/indents",
        json={
            "required_date": required_date,
            "items": [{"item_id": item1.id, "quantity": 5}],
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    indent_id = created.json()["id"]

    updated = await client.put(
        f"/api/indents/{indent_id}",
        json={
            "required_date": required_date,
            "priority": "URGENT",
            "remarks": "Edited draft",
            "items": [{"item_id": item2.id, "quantity": 7}],
        },
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["id"] == indent_id
    assert updated.json()["required_date"] == required_date
    assert updated.json()["priority"] == "URGENT"
    assert updated.json()["remarks"] == "Edited draft"
    assert [(line["item_id"], line["quantity"]) for line in updated.json()["items"]] == [
        (item2.id, 7),
    ]

    detail = await client.get(f"/api/indents/{indent_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == indent_id
    assert [(line["item_id"], line["quantity"]) for line in detail.json()["items"]] == [
        (item2.id, 7),
    ]

    deleted = await client.delete(f"/api/indents/{indent_id}", headers=headers)
    assert deleted.status_code == 204, deleted.text
    assert (await client.get(f"/api/indents/{indent_id}", headers=headers)).status_code == 404
    listed = await client.get("/api/indents", headers=headers)
    assert listed.status_code == 200, listed.text
    assert indent_id not in {indent["id"] for indent in listed.json()["items"]}


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


async def test_allocation_before_final_approval_is_rejected(db):
    requester, _approver, it1, _ = await _world(db)
    draft = await service.create_indent(db, _create_data(it1.id), requester)

    with pytest.raises(ValidationError):
        await service.allocation_proposal(db, draft.id)
    with pytest.raises(ValidationError):
        await service.decide_allocation(db, AllocationIn(indent_id=draft.id, decisions=[]), requester)

    pending = await service.submit_indent(db, draft.id, requester)
    assert pending.status == IndentStatus.PENDING_APPROVAL.value

    with pytest.raises(ValidationError):
        await service.allocation_proposal(db, draft.id)
    with pytest.raises(ValidationError):
        await service.decide_allocation(db, AllocationIn(indent_id=draft.id, decisions=[]), requester)


async def test_cumulative_allocation_status_uses_all_approved_allocations(db):
    requester, _approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    line = indent.items[0]
    line.approved_quantity = line.quantity
    indent.status = IndentStatus.AWAITING_ALLOCATION.value
    await db.flush()

    first = Allocation(
        allocation_no="ALLOC-CUM-1",
        indent_id=indent.id,
        indent_no=indent.indent_no,
        status=AllocationStatus.APPROVED.value,
        allocated_by_id=requester.id,
        allocated_by_name=requester.full_name,
    )
    second = Allocation(
        allocation_no="ALLOC-CUM-2",
        indent_id=indent.id,
        indent_no=indent.indent_no,
        status=AllocationStatus.APPROVED.value,
        allocated_by_id=requester.id,
        allocated_by_name=requester.full_name,
    )
    db.add_all([first, second])
    await db.flush()
    db.add_all([
        AllocationItem(
            allocation_id=first.id,
            indent_item_id=line.id,
            item_id=it1.id,
            requested_qty=5,
            quantity=2,
        ),
        AllocationItem(
            allocation_id=second.id,
            indent_item_id=line.id,
            item_id=it1.id,
            requested_qty=5,
            quantity=3,
        ),
    ])
    await db.commit()

    await service._recalculate_indent_allocation_state(db, indent)
    await db.commit()
    await db.refresh(indent)
    await db.refresh(line)

    assert float(line.allocated_quantity) == 5
    assert line.status == IndentItemStatus.ALLOCATED.value
    assert indent.status == IndentStatus.ALLOCATED.value


async def test_leaf_user_sees_only_own_indents(db):
    world = await _visibility_world(db)
    page = await service.list_indents(db, PageParams(page=1, size=50), user=world["tech1"])

    assert {row.id for row in page["items"]} == {world["indents"]["tech1"].id}


async def test_leaf_tl_does_not_inherit_child_position_visibility(db):
    world = await _visibility_world(db)
    tl = HcmEmployee(id=27, full_name="TL One", emp_code="TL1",
                     department_id=501, office_id=701, project_id=900,
                     is_active=True, synced_at=utcnow())
    db.add(tl)
    db.add(HcmPositionAssignment(id=27, employee_id=tl.id,
                                 employee_name=tl.full_name,
                                 position_id=121, department_id=501,
                                 office_id=701, is_primary=True,
                                 is_active=True, synced_at=utcnow()))
    await db.commit()
    tl.active_position_id = 121
    tl_indent = await service.create_indent(db, _create_data(world["item"].id), tl)

    page = await service.list_indents(db, PageParams(page=1, size=50), user=tl)

    assert {row.id for row in page["items"]} == {tl_indent.id}
    assert world["indents"]["tech1"].id not in {row.id for row in page["items"]}


async def test_operational_permission_does_not_grant_unrelated_status_visibility(db):
    world = await _visibility_world(db)
    await _grant_login(
        db,
        world["tech2"],
        "stocktech",
        ["indent.view", "allocation.view", "stock.view"],
    )
    await service.submit_indent(db, world["indents"]["tech1"].id, world["tech1"])
    await service.act_on_indent(
        db,
        world["indents"]["tech1"].id,
        ApprovalAction.APPROVED,
        "branch ok",
        world["oe1"],
    )

    page = await service.list_indents(db, PageParams(page=1, size=50), user=world["tech2"])

    ids = {row.id for row in page["items"]}
    assert world["indents"]["tech2"].id in ids
    assert world["indents"]["tech1"].id not in ids


async def test_oe_sees_own_branch_but_not_sibling_branch(db):
    world = await _visibility_world(db)
    page = await service.list_indents(db, PageParams(page=1, size=50), user=world["oe1"])
    ids = {row.id for row in page["items"]}

    assert world["indents"]["oe1"].id in ids
    assert world["indents"]["tech1"].id in ids
    assert world["indents"]["oe2"].id not in ids
    assert world["indents"]["tech2"].id not in ids


async def test_real_district_manager_position_sees_oe_subtree(db):
    world = await _production_visibility_world(db)

    page = await service.list_indents(db, PageParams(page=1, size=100), user=world["dm1"])
    ids = {row.id for row in page["items"]}

    assert world["indents"]["dm1"].id in ids
    assert world["indents"]["oe1"].id in ids
    assert world["indents"]["pilot1"].id in ids
    assert world["indents"]["driver1"].id in ids
    assert world["indents"]["dm2"].id not in ids
    assert world["indents"]["oe2"].id not in ids


async def test_real_regional_manager_position_sees_dm_subtree(db):
    world = await _production_visibility_world(db)

    page = await service.list_indents(db, PageParams(page=1, size=100), user=world["rm1"])
    ids = {row.id for row in page["items"]}

    assert world["indents"]["rm1"].id in ids
    assert world["indents"]["dm1"].id in ids
    assert world["indents"]["oe1"].id in ids
    assert world["indents"]["pilot1"].id in ids
    assert world["indents"]["rm2"].id not in ids
    assert world["indents"]["dm2"].id not in ids


async def test_same_project_reporting_branch_visible_across_different_offices(db):
    world = await _production_visibility_world(db)

    assert world["positions"]["rm1"].office_id != world["positions"]["dm1"].office_id
    assert world["positions"]["dm1"].office_id != world["positions"]["oe1"].office_id
    assert world["positions"]["oe1"].office_id != world["positions"]["pilot1"].office_id
    assert {
        world["positions"]["rm1"].project_id,
        world["positions"]["dm1"].project_id,
        world["positions"]["oe1"].project_id,
        world["positions"]["pilot1"].project_id,
    } == {19000}

    oe_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["oe1"]))["items"]
    }
    dm_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["dm1"]))["items"]
    }
    rm_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["rm1"]))["items"]
    }

    assert world["indents"]["pilot1"].id in oe_ids
    assert world["indents"]["pilot1"].id in dm_ids
    assert world["indents"]["pilot1"].id in rm_ids


async def test_sibling_dm_and_rm_branches_remain_isolated(db):
    world = await _production_visibility_world(db)

    dm2_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["dm2"]))["items"]
    }
    rm2_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["rm2"]))["items"]
    }

    assert world["indents"]["pilot1"].id not in dm2_ids
    assert world["indents"]["driver1"].id not in rm2_ids
    assert world["indents"]["tl2"].id in dm2_ids
    assert world["indents"]["dm2"].id in rm2_ids


async def test_sph_and_coo_have_global_read_without_approval_power(db):
    world = await _production_visibility_world(db)

    sph_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["sph"]))["items"]
    }
    coo_ids = {
        row.id for row in
        (await service.list_indents(db, PageParams(page=1, size=100), user=world["coo"]))["items"]
    }

    all_ids = {indent.id for indent in world["indents"].values()}
    assert all_ids <= sph_ids
    assert all_ids <= coo_ids

    await service.submit_indent(db, world["indents"]["pilot1"].id, world["pilot1"])
    with pytest.raises(PermissionError_):
        await service.act_on_indent(
            db, world["indents"]["pilot1"].id, ApprovalAction.APPROVED, "global read only",
            world["sph"],
        )
    with pytest.raises(PermissionError_):
        await service.act_on_indent(
            db, world["indents"]["pilot1"].id, ApprovalAction.APPROVED, "global read only",
            world["coo"],
        )


async def test_manager_cannot_update_or_submit_subordinate_draft(db):
    world = await _production_visibility_world(db)

    await service.get_indent(db, world["indents"]["pilot1"].id, world["dm1"])
    with pytest.raises(PermissionError_):
        await service.update_indent(
            db,
            world["indents"]["pilot1"].id,
            IndentUpdate(remarks="manager edit"),
            world["dm1"],
        )
    with pytest.raises(PermissionError_):
        await service.submit_indent(db, world["indents"]["pilot1"].id, world["dm1"])


async def test_invalid_active_assignment_grants_no_subtree_visibility(db):
    world = await _production_visibility_world(db)
    world["dm1"].active_position_id = world["positions"]["rm1"].id

    page = await service.list_indents(db, PageParams(page=1, size=100), user=world["dm1"])

    assert {row.id for row in page["items"]} == set()


async def test_missing_manager_project_context_grants_no_subtree_visibility(db):
    world = await _production_visibility_world(db)
    world["positions"]["dm1"].project_id = None
    await db.commit()

    page = await service.list_indents(db, PageParams(page=1, size=100), user=world["dm1"])
    ids = {row.id for row in page["items"]}

    assert ids == {world["indents"]["dm1"].id}


async def test_null_indent_project_does_not_widen_manager_access_but_office_does_not_constrain(db):
    world = await _production_visibility_world(db)
    null_project = world["indents"]["pilot1"]
    null_office = world["indents"]["driver1"]
    null_project.project_id = None
    null_office.office_id = None
    await db.commit()

    page = await service.list_indents(db, PageParams(page=1, size=100), user=world["dm1"])
    ids = {row.id for row in page["items"]}

    assert null_project.id not in ids
    assert null_office.id in ids
    assert world["indents"]["oe1"].id in ids


async def test_dm_and_rm_see_only_their_descendant_branches(db):
    world = await _visibility_world(db)
    dm_page = await service.list_indents(db, PageParams(page=1, size=50), user=world["dm"])
    rm_page = await service.list_indents(db, PageParams(page=1, size=50), user=world["rm"])

    dm_ids = {row.id for row in dm_page["items"]}
    rm_ids = {row.id for row in rm_page["items"]}
    assert world["indents"]["dm"].id in dm_ids
    assert world["indents"]["oe1"].id in dm_ids
    assert world["indents"]["tech2"].id in dm_ids
    assert world["indents"]["rm"].id not in dm_ids
    assert world["indents"]["rm"].id in rm_ids
    assert world["indents"]["dm"].id in rm_ids
    assert world["indents"]["tech1"].id in rm_ids


async def test_cross_project_descendant_is_not_visible(db):
    world = await _visibility_world(db)
    page = await service.list_indents(db, PageParams(page=1, size=50), user=world["oe1"])

    assert world["indents"]["other_project"].id not in {row.id for row in page["items"]}


async def test_direct_detail_cross_branch_access_is_blocked(db):
    world = await _visibility_world(db)

    with pytest.raises(NotFoundError):
        await service.get_indent(db, world["indents"]["tech2"].id, world["oe1"])


async def test_sibling_manager_cannot_view_or_act_on_indent(db):
    world = await _approval_ladder_world(db)
    await service.submit_indent(db, world["indent"].id, world["pilot"])

    with pytest.raises(NotFoundError):
        await service.get_indent(db, world["indent"].id, world["sibling_oe"])
    with pytest.raises(NotFoundError):
        await service.act_on_indent(
            db, world["indent"].id, ApprovalAction.APPROVED, "sibling",
            world["sibling_oe"],
        )


async def test_scoped_stats_activity_and_workflow_events_do_not_leak_into_acknowledgments(db):
    world = await _visibility_world(db)
    await service.submit_indent(db, world["indents"]["tech1"].id, world["tech1"])
    await service.act_on_indent(
        db, world["indents"]["tech1"].id, ApprovalAction.APPROVED, "branch ok",
        world["oe1"],
    )
    await service.submit_indent(db, world["indents"]["tech2"].id, world["tech2"])
    await service.act_on_indent(
        db, world["indents"]["tech2"].id, ApprovalAction.APPROVED, "sibling ok",
        world["oe2"],
    )

    params = PageParams(page=1, size=50)
    stats = await service.indent_stats(db, user=world["oe1"])
    activity = await service.activity_ledger(db, params, user=world["oe1"])
    acknowledgments = await service.list_acknowledgments(db, params, user=world["oe1"])

    assert stats["total"] == 2
    assert {row["indent_id"] for row in activity["items"]} == {
        world["indents"]["oe1"].id,
        world["indents"]["tech1"].id,
    }
    assert acknowledgments["items"] == []


async def test_manager_own_indent_starts_approval_above_them(db):
    world = await _visibility_world(db)
    await service.submit_indent(db, world["indents"]["dm"].id, world["dm"])

    pending = (await db.execute(
        select(Pending).where(Pending.doc_id == world["indents"]["dm"].id)
    )).scalars().all()
    assert {row.approver_id for row in pending} == {world["rm"].id}


async def test_any_one_final_approval_still_completes_with_one_approver(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    requester = HcmEmployee(id=41, full_name="Requester", emp_code="REQ",
                            is_active=True, synced_at=utcnow())
    approver_one = HcmEmployee(id=42, full_name="SPH", emp_code="SPH",
                               is_active=True, synced_at=utcnow())
    approver_two = HcmEmployee(id=43, full_name="COO", emp_code="COO",
                               is_active=True, synced_at=utcnow())
    db.add_all([item, requester, approver_one, approver_two])
    db.add_all([
        HcmPosition(id=410, name="Requester", is_active=True, synced_at=utcnow()),
        HcmPosition(id=500, name="Final Approver", is_active=True, synced_at=utcnow()),
    ])
    db.add_all([
        HcmPositionAssignment(id=41, employee_id=requester.id, position_id=410,
                              is_primary=True, is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(id=42, employee_id=approver_one.id, position_id=500,
                              is_primary=True, is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(id=43, employee_id=approver_two.id, position_id=500,
                              is_primary=True, is_active=True, synced_at=utcnow()),
    ])
    wf = Workflow(code="WF-INDENT", name="Indent", doc_type="INDENT", is_active=True)
    db.add(wf)
    await db.flush()
    db.add(Stage(workflow_id=wf.id, sequence=1, name="Final approval",
                 approver_type=ApproverType.POSITION.value, position_id=500,
                 approval_mode="ANY_ONE"))
    await db.commit()
    requester.active_position_id = 410
    approver_one.active_position_id = 500

    indent = await service.create_indent(db, _create_data(item.id), requester)
    await service.submit_indent(db, indent.id, requester)
    result = await service.act_on_indent(
        db, indent.id, ApprovalAction.APPROVED, "one final approval", approver_one,
    )

    assert result.status == IndentStatus.AWAITING_ALLOCATION.value


async def test_activity_workflow_events_do_not_become_acknowledgments(db):
    requester, approver, it1, _ = await _world(db)
    indent = await service.create_indent(db, _create_data(it1.id), requester)
    await service.submit_indent(db, indent.id, requester)
    await service.act_on_indent(
        db, indent.id, ApprovalAction.APPROVED, "Approved for issue", approver,
    )
    params = PageParams(page=1, size=20)

    activity = await service.activity_ledger(db, params, search=indent.indent_no)
    assert activity["total"] >= 2
    assert {row["event_type"] for row in activity["items"]} == {
        "REQUEST_CREATED", "REQUEST_SUBMITTED", "APPROVAL_COMPLETED",
    }
    assert {row["result_label"] for row in activity["items"]} == {
        "Draft", "Submitted", "Approved",
    }

    acknowledgments = await service.list_acknowledgments(db, params)
    assert acknowledgments["items"] == []

    notifications = await service.list_notifications(db, params, requester)
    assert notifications["items"][0]["title"] == "Request approved"


async def test_create_without_permission_forbidden(client, make_user, login):
    await make_user(employee_id=9, username="noperm", password="pw", permissions=["indent.view"])
    headers = await login("noperm", "pw")
    r = await client.post("/api/indents", json={"items": [{"item_id": 1, "quantity": 1}]},
                          headers=headers)
    assert r.status_code == 403


async def test_indent_list_filters(client, db, login):
    requester, _approver, it1, it2 = await _world(db)
    today = utcnow().date()
    i1 = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=10)],
            priority="URGENT",
            required_date=today,
            remarks="Bolt request",
        ),
        requester,
    )
    i2 = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it2.id, quantity=20)],
            priority="NORMAL",
            required_date=today + timedelta(days=10),
            remarks="Nut request",
        ),
        requester,
    )

    i1.indent_no = "IND/2026/0012"
    i1.requested_by_name = "Visible Requester"
    i1.department_name = "Field Operations"
    i1.status = IndentStatus.AWAITING_ALLOCATION.value

    i2.indent_no = "IND/2026/0099"
    i2.requested_by_name = "Other Requester"
    i2.department_name = "Finance"
    i2.requested_by_code = "HiddenEmployeeCode12"
    i2.position_name = "HiddenPosition12"
    i2.office_name = "HiddenOffice12"
    i2.project_name = "HiddenProject12"
    i2.remarks = "HiddenIndentRemarks12"
    i2.total_qty = 12
    i2_line = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == i2.id)
    )).scalar_one()
    i2_line.item_code = "HiddenItemCode12"
    i2_line.item_name = "HiddenItemName12"
    i2_line.uom_code = "HiddenUom12"
    i2_line.remarks = "HiddenLineRemarks12"
    i2_line.quantity = 12
    await db.commit()

    await _grant_login(db, requester, "filteruser", ["indent.view"])
    headers = await login("filteruser", "pw")

    r = await client.get(
        "/api/indents",
        params={"search": "  0012  ", "page": 1, "size": 1},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == i1.id
    assert r.json()["page"] == 1
    assert r.json()["size"] == 1

    for term in ("visible requester", "FIELD OPERATIONS", "aWaItInG aLlOcAtIoN"):
        r = await client.get("/api/indents", params={"search": term}, headers=headers)
        assert r.status_code == 200
        assert r.json()["total"] == 1
        assert r.json()["items"][0]["id"] == i1.id

    hidden_terms = (
        "HiddenEmployeeCode12",
        "HiddenPosition12",
        "HiddenOffice12",
        "HiddenProject12",
        "HiddenIndentRemarks12",
        "HiddenItemCode12",
        "HiddenItemName12",
        "HiddenUom12",
        "HiddenLineRemarks12",
    )
    for term in hidden_terms:
        r = await client.get("/api/indents", params={"search": term}, headers=headers)
        assert r.status_code == 200
        assert r.json()["total"] == 0

    r = await client.get("/api/indents", params={"search": "12"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == i1.id

    r = await client.get("/api/indents?priority=URGENT", headers=headers)
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == i1.id

    r = await client.get("/api/indents?status=DRAFT", headers=headers)
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == i2.id

    r = await client.get(
        "/api/indents",
        params={
            "search": "awaiting allocation",
            "created_date_from": today.isoformat(),
            "created_date_to": today.isoformat(),
            "status": IndentStatus.AWAITING_ALLOCATION.value,
            "priority": "URGENT",
            "page": 1,
            "size": 1,
        },
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["items"][0]["id"] == i1.id
    assert r.json()["page"] == 1
    assert r.json()["size"] == 1

    r = await client.get(f"/api/indents?required_by_to={today.isoformat()}", headers=headers)
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()["items"]}
    assert i1.id in ids
    assert i2.id not in ids

    r_stats = await client.get(f"/api/indents/stats?search={i1.indent_no}", headers=headers)
    assert r_stats.status_code == 200
    data = r_stats.json()
    assert data["total"] == 1
    assert data["by_status"] == {IndentStatus.AWAITING_ALLOCATION.value: 1}


async def test_allocation_does_not_create_fulfillment_acknowledgments(client, db, login):
    requester, approver, it1, _ = await _world(db)
    today_date = utcnow().date()
    indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today_date,
        ),
        requester,
    )
    future_indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today_date + timedelta(days=10),
        ),
        requester,
    )
    await service.submit_indent(db, indent.id, requester)
    await service.act_on_indent(db, indent.id, ApprovalAction.APPROVED, "Approved for issue", approver)
    await service.submit_indent(db, future_indent.id, requester)
    await service.act_on_indent(db, future_indent.id, ApprovalAction.APPROVED, "Approved for issue", approver)
    for row, allocation_no, allocated_qty, lifecycle_status in (
        (indent, "ALLOC/ACK/001", 5, IndentStatus.ALLOCATED.value),
        (
            future_indent,
            "ALLOC/ACK/002",
            2,
            IndentStatus.PARTIALLY_FULFILLED.value,
        ),
    ):
        row.items[0].allocated_quantity = allocated_qty
        row.status = lifecycle_status
        db.add(Allocation(
            allocation_no=allocation_no,
            indent_id=row.id,
            indent_no=row.indent_no,
            status=AllocationStatus.APPROVED.value,
            allocated_by_id=approver.id,
            allocated_by_name=approver.full_name,
            remarks="Fulfilled for issue",
            approved_at=utcnow(),
        ))
    await db.commit()

    await _grant_login(db, requester, "ackuser", ["indent.view"])
    headers = await login("ackuser", "pw")

    today = utcnow().date().isoformat()
    requests = [
        "/api/indents/acknowledgments",
        "/api/indents/acknowledgments?search=Fulfilled%20for%20issue",
        f"/api/indents/acknowledgments?date_from={today}&date_to={today}",
        f"/api/indents/acknowledgments?required_from={today}&required_to={today}",
        "/api/indents/acknowledgments?status=FULFILLED",
        "/api/indents/acknowledgments?status=PARTIALLY_FULFILLED",
    ]
    for path in requests:
        r = await client.get(path, headers=headers)
        assert r.status_code == 200
        assert r.json() == {
            "items": [],
            "total": 0,
            "page": 1,
            "size": 20,
        }

    r = await client.get(
        "/api/indents/acknowledgments?status=ALLOCATED",
        headers=headers,
    )
    assert r.status_code == 422


async def test_activity_filters(client, db, login):
    requester, approver, it1, _ = await _world(db)
    today_date = utcnow().date()
    indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today_date,
        ),
        requester,
    )
    future_indent = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=5)],
            required_date=today_date + timedelta(days=10),
        ),
        requester,
    )
    await service.submit_indent(db, indent.id, requester)
    await service.act_on_indent(db, indent.id, ApprovalAction.APPROVED, "Approved for issue", approver)

    await _grant_login(db, requester, "activityuser", ["indent.view"])
    headers = await login("activityuser", "pw")

    r = await client.get(
        f"/api/indents/activity?search={indent.indent_no}"
        "&transaction_type=REQUEST_CREATED",
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] >= 1
    assert {row["event_type"] for row in r.json()["items"]} == {"REQUEST_CREATED"}
    assert {row["result_label"] for row in r.json()["items"]} == {"Draft"}

    r = await client.get(f"/api/indents/activity?item_id={it1.id}", headers=headers)
    assert r.status_code == 200
    assert r.json()["total"] == 0

    r = await client.get(
        "/api/indents/activity?search=Approved%20for%20issue"
        "&transaction_type=APPROVAL_COMPLETED",
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0

    for visible_term in (
        "Approval completed",
        "Approved",
        approver.full_name,
        indent.department_name,
    ):
        r = await client.get(
            "/api/indents/activity",
            params={
                "search": visible_term,
                "transaction_type": "APPROVAL_COMPLETED",
            },
            headers=headers,
        )
        assert r.status_code == 200
        assert r.json()["total"] >= 1

    indent.office_name = "HiddenActivityOffice"
    indent.project_name = "HiddenActivityProject"
    await db.commit()
    for hidden_term in ("HiddenActivityOffice", "HiddenActivityProject"):
        r = await client.get(
            "/api/indents/activity", params={"search": hidden_term}, headers=headers,
        )
        assert r.status_code == 200
        assert r.json()["total"] == 0

    r = await client.get(
        "/api/indents/activity",
        params={
            "status": IndentStatus.AWAITING_ALLOCATION.value,
            "date_from": today_date.isoformat(),
            "date_to": today_date.isoformat(),
            "page": 1,
            "size": 1,
        },
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] >= 1
    assert r.json()["size"] == 1

    invalid = await client.get(
        "/api/indents/activity",
        params={"date_from": "2026-08-01", "date_to": "2026-07-31"},
        headers=headers,
    )
    assert invalid.status_code == 422
    assert "date_from" in invalid.json()["error"]

    today = today_date.isoformat()
    r = await client.get(
        f"/api/indents/activity?required_from={today}&required_to={today}"
        "&transaction_type=REQUEST_CREATED",
        headers=headers,
    )
    assert r.status_code == 200
    ids = {row["indent_id"] for row in r.json()["items"]}
    assert indent.id in ids
    assert future_indent.id not in ids


async def test_notification_filters_visible_content_before_pagination(client, db, login):
    requester, approver, it1, _ = await _world(db)
    today = utcnow().date()
    approved = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=2)],
            required_date=today,
        ),
        requester,
    )
    rejected = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=3)],
            required_date=today,
        ),
        requester,
    )
    await service.submit_indent(db, approved.id, requester)
    await service.act_on_indent(db, approved.id, ApprovalAction.APPROVED, "hidden approval note", approver)
    rejected.status = IndentStatus.REJECTED.value
    approved.updated_at = datetime(2026, 7, 31, 23, 59, 59, tzinfo=timezone.utc)
    rejected.updated_at = datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)
    approved.office_name = "HiddenNotificationOffice"
    approved.project_name = "HiddenNotificationProject"
    approved.remarks = "HiddenNotificationRemarks"
    await db.commit()

    await _grant_login(db, requester, "notificationfilteruser", ["indent.view"])
    headers = await login("notificationfilteruser", "pw")

    for visible_term in (
        approved.indent_no,
        "Request approved",
        "approved and with inventory",
        "awaiting allocation",
    ):
        response = await client.get(
            "/api/indents/notifications", params={"search": visible_term}, headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert response.json()["items"][0]["indent_id"] == approved.id

    for hidden_term in (
        "HiddenNotificationOffice",
        "HiddenNotificationProject",
        "HiddenNotificationRemarks",
        "hidden approval note",
    ):
        response = await client.get(
            "/api/indents/notifications", params={"search": hidden_term}, headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["total"] == 0

    response = await client.get(
        "/api/indents/notifications",
        params={
            "date_from": "2026-07-31",
            "date_to": "2026-07-31",
            "status": IndentStatus.AWAITING_ALLOCATION.value,
            "page": 1,
            "size": 1,
        },
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["indent_id"] == approved.id

    rejected_response = await client.get(
        "/api/indents/notifications",
        params={"status": IndentStatus.REJECTED.value},
        headers=headers,
    )
    assert rejected_response.status_code == 200
    assert {row["indent_id"] for row in rejected_response.json()["items"]} == {
        rejected.id,
    }

    invalid = await client.get(
        "/api/indents/notifications",
        params={"date_from": "2026-08-01", "date_to": "2026-07-31"},
        headers=headers,
    )
    assert invalid.status_code == 422
    assert "date_from" in invalid.json()["error"]


async def test_indent_list_and_stats_date_ranges_are_validated_inclusive_and_combined(
    client, db, login,
):
    requester, other_user, it1, _ = await _world(db)
    rows = []
    for required_date in (date.today(), date.today() + timedelta(days=1), date.today() + timedelta(days=1)):
        rows.append(await service.create_indent(
            db,
            IndentCreate(
                items=[IndentItemIn(item_id=it1.id, quantity=1)],
                required_date=required_date,
            ),
            requester,
        ))
    hidden = await service.create_indent(
        db,
        IndentCreate(
            items=[IndentItemIn(item_id=it1.id, quantity=1)],
            required_date=date.today(),
        ),
        other_user,
    )

    rows[0].created_at = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)
    rows[0].required_date = date(2026, 8, 1)
    rows[1].created_at = datetime(2026, 7, 31, 23, 59, 59, tzinfo=timezone.utc)
    rows[1].required_date = date(2026, 8, 10)
    rows[2].created_at = datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)
    rows[2].required_date = date(2026, 8, 10)
    hidden.created_at = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    hidden.required_date = date(2026, 8, 5)
    await db.commit()

    await _grant_login(db, requester, "daterangeuser", ["indent.view"])
    headers = await login("daterangeuser", "pw")

    july = {
        "created_date_from": "2026-07-01",
        "created_date_to": "2026-07-31",
        "page": 1,
        "size": 1,
    }
    response = await client.get("/api/indents", params=july, headers=headers)
    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert response.json()["size"] == 1
    assert response.json()["items"][0]["id"] in {rows[0].id, rows[1].id}
    assert hidden.id not in {item["id"] for item in response.json()["items"]}

    same_raised_day = await client.get(
        "/api/indents",
        params={"created_date_from": "2026-07-31", "created_date_to": "2026-07-31"},
        headers=headers,
    )
    assert same_raised_day.status_code == 200
    assert {item["id"] for item in same_raised_day.json()["items"]} == {rows[1].id}

    same_required_day = await client.get(
        "/api/indents",
        params={"required_by_from": "2026-08-10", "required_by_to": "2026-08-10"},
        headers=headers,
    )
    assert same_required_day.status_code == 200
    assert {item["id"] for item in same_required_day.json()["items"]} == {
        rows[1].id, rows[2].id,
    }

    combined = {
        "created_date_from": "2026-07-01",
        "created_date_to": "2026-07-31",
        "required_by_from": "2026-08-01",
        "required_by_to": "2026-08-10",
    }
    combined_list = await client.get("/api/indents", params=combined, headers=headers)
    combined_stats = await client.get("/api/indents/stats", params=combined, headers=headers)
    assert combined_list.status_code == 200
    assert combined_stats.status_code == 200
    assert {item["id"] for item in combined_list.json()["items"]} == {
        rows[0].id, rows[1].id,
    }
    assert combined_stats.json()["total"] == combined_list.json()["total"] == 2

    invalid_requests = [
        ("/api/indents", {
            "created_date_from": "2026-08-01",
            "created_date_to": "2026-07-31",
        }, "created_date_from"),
        ("/api/indents/stats", {
            "created_date_from": "2026-08-01",
            "created_date_to": "2026-07-31",
        }, "created_date_from"),
        ("/api/indents", {
            "required_by_from": "2026-08-11",
            "required_by_to": "2026-08-10",
        }, "required_by_from"),
        ("/api/indents/stats", {
            "required_by_from": "2026-08-11",
            "required_by_to": "2026-08-10",
        }, "required_by_from"),
    ]
    for path, params, field in invalid_requests:
        invalid = await client.get(path, params=params, headers=headers)
        assert invalid.status_code == 422
        assert field in invalid.json()["error"]


async def test_read_endpoints_require_indent_view(client, make_user, login):
    await make_user(employee_id=13, username="noview", password="pw", permissions=[])
    headers = await login("noview", "pw")

    for path in [
        "/api/indents",
        "/api/indents/stats",
        "/api/indents/acknowledgments",
        "/api/indents/activity",
    ]:
        r = await client.get(path, headers=headers)
        assert r.status_code == 403


