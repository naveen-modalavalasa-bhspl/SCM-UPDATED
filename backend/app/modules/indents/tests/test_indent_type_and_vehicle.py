"""Indent type + vehicle: the header fields the ORM had been ignoring.

`ind_indents.indent_type` and `vehicle_id`/`vehicle_number` already existed in the
database; only the model was behind. These tests pin the two things that reconciliation
must not break — an indent raised without a type is still REGULAR, and the vehicle is a
snapshot taken from another team's register — plus the new behaviour on top.
"""
import pytest
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select, text

from app.core.exceptions import ValidationError
from app.core.pagination import PageParams
from app.modules.indents import service
from app.modules.indents.enums import IndentType
from app.modules.indents.models import Indent
from app.modules.indents.schemas import IndentCreate, IndentItemIn, IndentUpdate
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom


# The column set this module reconciled the ORM to. `ind_indents` is written by more
# than one module, so a column quietly disappearing from the model is invisible until
# something reads a stale value. Listing them here makes that a test failure.
EXPECTED_INDENT_COLUMNS = {
    "id", "indent_no", "indent_type", "indent_date", "required_date",
    "requested_by_id", "requested_by_name", "requested_by_code",
    "position_id", "position_name", "department_id", "department_name",
    "section_id", "office_id", "office_name",
    # Phase 2: Region/Location, the requester's HCM location. Separate from
    # office_id, which resolves through the position chain.
    "region_id", "region_name",
    "warehouse_id", "warehouse_name",
    "project_id", "project_name", "vehicle_id", "vehicle_number",
    # A Stock Transfer Request's source point (2026-11-04).
    "source_warehouse_id", "source_warehouse_name", "source_warehouse_code",
    "consolidation_id",
    "bom_id", "bom_name", "status", "priority", "total_items", "total_qty",
    "approved_qty", "issued_qty", "ordered_qty", "estimated_value",
    "remarks", "rejected_reason", "current_stage_name", "current_approver_name",
    "approved_by_name", "approved_at", "is_bookmarked",
    "created_by_id", "created_by_name", "created_at", "updated_at",
}


def test_orm_maps_the_whole_indent_header():
    """Phase 0 guard: no DB needed, so it runs everywhere."""
    assert {c.name for c in Indent.__table__.columns} == EXPECTED_INDENT_COLUMNS


def test_indent_type_keeps_regular_as_a_member():
    """296 live indents carry REGULAR. Dropping it from the enum would make every one
    of them unfilterable and unserialisable."""
    assert IndentType.REGULAR.value == "REGULAR"
    assert {t.value for t in IndentType} == {"REGULAR", "MONTHLY", "STR"}


def test_validate_indent_type_rejects_anything_else():
    assert service._validate_indent_type(None) is None
    assert service._validate_indent_type("MONTHLY") == "MONTHLY"
    with pytest.raises(ValidationError):
        service._validate_indent_type("QUARTERLY")
    with pytest.raises(ValidationError):
        service._validate_indent_type("MEDICAL_EQUIPMENT")


async def _world(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Bolt", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    requester = HcmEmployee(id=2, full_name="Ravi Req", emp_code="E2",
                            is_active=True, synced_at=utcnow())
    db.add(requester)
    role = Role(code="R_REQ", name="Requester", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=requester.id, role_id=role.id))
    for code in ("indent.view", "indent.create", "indent.edit"):
        head, _, tail = code.partition(".")
        perm = Permission(code=code, module=head, resource=head, action=tail,
                          description=code)
        db.add(perm)
        await db.flush()
        db.add(RolePermission(role_id=role.id, permission_id=perm.id))
    await db.commit()
    return requester, item


def _payload(item, **overrides):
    body = dict(
        required_date=date.today() + timedelta(days=3),
        priority="NORMAL",
        items=[IndentItemIn(item_id=item.id, quantity=2)],
    )
    body.update(overrides)
    return IndentCreate(**body)


async def _vehicle_register(db, rows=((77, "AP39-TT-4512"),)):
    """`trn_vehicles` belongs to transport and is not on Base.metadata, so the test
    creates and drops it itself — create_all/drop_all never touch it."""
    await db.execute(text("DROP TABLE IF EXISTS trn_vehicles"))
    await db.execute(text(
        "CREATE TABLE trn_vehicles (id BIGINT PRIMARY KEY, "
        "vehicle_number VARCHAR(50)) CHARACTER SET utf8mb4"))
    for vehicle_id, number in rows:
        await db.execute(
            text("INSERT INTO trn_vehicles (id, vehicle_number) VALUES (:i, :n)"),
            {"i": vehicle_id, "n": number})
    await db.commit()


async def _drop_vehicle_register(db):
    await db.execute(text("DROP TABLE IF EXISTS trn_vehicles"))
    await db.commit()


# ---------------- indent type ----------------

async def test_create_without_a_type_is_regular(db):
    """The backward-compatibility contract: an existing caller that never heard of
    indent_type keeps producing exactly what it produced before."""
    requester, item = await _world(db)
    indent = await service.create_indent(db, _payload(item), requester)
    assert indent.indent_type == IndentType.REGULAR.value


async def test_create_with_the_new_type(db):
    requester, item = await _world(db)
    monthly = await service.create_indent(
        db, _payload(item, indent_type=IndentType.MONTHLY), requester)
    assert monthly.indent_type == "MONTHLY"


async def test_create_records_the_type_on_the_audit_row(db):
    requester, item = await _world(db)
    indent = await service.create_indent(
        db, _payload(item, indent_type=IndentType.MONTHLY), requester)
    from app.platform.settings.models import AuditLog
    audit = (await db.execute(
        select(AuditLog).where(AuditLog.entity_type == "ind_indents",
                               AuditLog.entity_id == indent.id)
    )).scalars().first()
    assert audit.changed_fields["indent_type"]["to"] == "MONTHLY"


async def test_update_changes_the_type_while_draft(db):
    requester, item = await _world(db)
    indent = await service.create_indent(db, _payload(item), requester)
    updated = await service.update_indent(
        db, indent.id,
        IndentUpdate(required_date=date.today() + timedelta(days=4),
                     indent_type=IndentType.MONTHLY),
        requester,
    )
    assert updated.indent_type == "MONTHLY"


async def test_update_leaves_the_type_alone_when_not_sent(db):
    requester, item = await _world(db)
    indent = await service.create_indent(
        db, _payload(item, indent_type=IndentType.MONTHLY), requester)
    updated = await service.update_indent(
        db, indent.id,
        IndentUpdate(required_date=date.today() + timedelta(days=4)),
        requester,
    )
    assert updated.indent_type == "MONTHLY"


async def test_list_filters_by_indent_type(db):
    requester, item = await _world(db)
    await service.create_indent(db, _payload(item), requester)
    await service.create_indent(
        db, _payload(item, indent_type=IndentType.MONTHLY), requester)

    everything = await service.list_indents(db, PageParams(page=1, size=50))
    assert everything["total"] == 2

    monthly = await service.list_indents(
        db, PageParams(page=1, size=50), indent_types=[IndentType.MONTHLY])
    assert monthly["total"] == 1
    assert monthly["items"][0].indent_type == "MONTHLY"

    # Legacy rows stay reachable through the same filter.
    regular = await service.list_indents(
        db, PageParams(page=1, size=50), indent_types=[IndentType.REGULAR])
    assert regular["total"] == 1

    both = await service.list_indents(
        db, PageParams(page=1, size=50),
        indent_types=[IndentType.MONTHLY, IndentType.REGULAR])
    assert both["total"] == 2


async def test_stats_filter_by_indent_type(db):
    requester, item = await _world(db)
    await service.create_indent(db, _payload(item), requester)
    await service.create_indent(
        db, _payload(item, indent_type=IndentType.MONTHLY), requester)
    stats = await service.indent_stats(db, indent_types=[IndentType.MONTHLY])
    assert stats["total"] == 1


# ---------------- vehicle ----------------

async def test_vehicle_is_snapshotted_from_the_register(db):
    requester, item = await _world(db)
    await _vehicle_register(db)
    try:
        indent = await service.create_indent(
            db, _payload(item, vehicle_id=77), requester)
        assert indent.vehicle_id == 77
        assert indent.vehicle_number == "AP39-TT-4512"
    finally:
        await _drop_vehicle_register(db)


async def test_vehicle_is_optional(db):
    requester, item = await _world(db)
    indent = await service.create_indent(db, _payload(item), requester)
    assert indent.vehicle_id is None
    assert indent.vehicle_number is None


async def test_unknown_vehicle_is_rejected(db):
    requester, item = await _world(db)
    await _vehicle_register(db)
    try:
        with pytest.raises(ValidationError):
            await service.create_indent(
                db, _payload(item, vehicle_id=999), requester)
    finally:
        await db.rollback()
        await _drop_vehicle_register(db)


async def test_update_attaches_and_clears_a_vehicle(db):
    requester, item = await _world(db)
    await _vehicle_register(db)
    try:
        indent = await service.create_indent(db, _payload(item), requester)
        attached = await service.update_indent(
            db, indent.id,
            IndentUpdate(required_date=date.today() + timedelta(days=4),
                         vehicle_id=77),
            requester,
        )
        assert attached.vehicle_number == "AP39-TT-4512"

        cleared = await service.update_indent(
            db, indent.id,
            IndentUpdate(required_date=date.today() + timedelta(days=4),
                         vehicle_id=None),
            requester,
        )
        assert cleared.vehicle_id is None
        assert cleared.vehicle_number is None
    finally:
        await _drop_vehicle_register(db)


async def test_vehicle_picker_is_empty_when_the_register_is_missing(db):
    """Transport's table may not exist in an environment. The dropdown degrades to
    empty rather than 500-ing the indent form."""
    await _drop_vehicle_register(db)
    assert await service.vehicle_options(db) == []


async def test_vehicle_picker_searches_by_number(db):
    await _vehicle_register(db, rows=((77, "AP39-TT-4512"), (78, "TS09-XX-1000")))
    try:
        assert [v["name"] for v in await service.vehicle_options(db, "TS09")] == [
            "TS09-XX-1000"]
        assert len(await service.vehicle_options(db)) == 2
    finally:
        await _drop_vehicle_register(db)


async def test_missing_register_blocks_attaching_rather_than_storing_a_guess(db):
    """Unlike the picker, resolution does not swallow the failure: an unverifiable id
    with no registration number beside it is worse than a refusal."""
    requester, item = await _world(db)
    await _drop_vehicle_register(db)
    # Read through the ORM objects now: the rollback below expires them, and reloading
    # one while building the next payload would be lazy IO outside the async context.
    item_id, requester_id = item.id, requester.id

    with pytest.raises(ValidationError):
        await service.create_indent(
            db, _payload(item, vehicle_id=77), requester)
    await db.rollback()

    # …and the indent still saves without one, on the same session.
    requester = await db.get(HcmEmployee, requester_id)
    payload = IndentCreate(
        required_date=date.today() + timedelta(days=3),
        priority="NORMAL",
        items=[IndentItemIn(item_id=item_id, quantity=2)],
    )
    indent = await service.create_indent(db, payload, requester)
    assert indent.vehicle_id is None
    assert indent.indent_type == IndentType.REGULAR.value
