"""Indents business logic. THE reference module — copy this shape.

Every state change follows: load -> validate current status -> change -> commit.
Approvals go ONLY through the workflow engine; there is no approval logic here.
"""
import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Numeric, String, and_, case, cast, exists, false, func, literal, or_, select, text, union_all
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only, selectinload

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams, paginate
# inventory is the base module (imports nothing from app.modules), so calling it from
# here is the legal direction. This is the §3 stock-availability fork.
from app.modules.inventory import allocations
from app.modules.inventory import service as inventory_service
from app.modules.inventory.models import (
    Allocation, AllocationItem, MaterialRequest, MaterialRequestItem,
)
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rules import evaluator as rules
from app.platform.workflow import engine, ladder
from app.platform.workflow.models import Action, Instance, Stage
from app.platform.workflow.models import Pending
from app.platform.settings import attachments
from app.platform.settings.service import write_audit
from app.platform.settings.models import AuditLog
from app.platform.rbac import service as rbac_service
from app.platform.rbac import permissions as perms
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number
from app.modules.indents.enums import (
    AcknowledgmentStatus, AllocationStatus, ApprovalAction, AuditAction, DocType,
    IndentActivityType, IndentItemStatus, IndentStatus, IndentType, InstanceStatus,
    MRStatus, MaterialDirection, Priority, RuleActionType,
)
from app.modules.indents.models import Indent, IndentItem
from app.modules.indents.schemas import IndentCreate, IndentUpdate


logger = logging.getLogger(__name__)

PAST_REQUIRED_DATE_ERROR = "Required date cannot be earlier than today"
REQUIRED_DATE_MANDATORY_ERROR = "Required date is mandatory."
DUPLICATE_ITEM_ERROR = "The same item cannot be added more than once in a single indent."
REJECTION_REASON_REQUIRED_ERROR = "Rejection reason is required."
RAISED_DATE_RANGE_ERROR = (
    "created_date_from must be the same as or earlier than created_date_to."
)
REQUIRED_BY_DATE_RANGE_ERROR = (
    "required_by_from must be the same as or earlier than required_by_to."
)
FILTER_DATE_RANGE_ERROR = "date_from must be the same as or earlier than date_to."


@dataclass(frozen=True)
class _JourneyDocumentGraph:
    """Deterministic IDs for documents genuinely connected to one indent."""

    indent_items: tuple[IndentItem, ...]
    allocation_ids: frozenset[int]
    material_request_ids: frozenset[int]
    picking_ids: frozenset[int]
    material_issue_ids: frozenset[int]
    dispatch_ids: frozenset[int]


def _validate_required_date(required_date: date | None) -> None:
    if required_date is None:
        raise ValidationError(REQUIRED_DATE_MANDATORY_ERROR)
    if required_date < date.today():
        raise ValidationError(PAST_REQUIRED_DATE_ERROR)


def _validate_indent_date_ranges(
    date_from: date | None,
    date_to: date | None,
    required_by_from: date | None,
    required_by_to: date | None,
) -> None:
    if date_from and date_to and date_from > date_to:
        raise ValidationError(RAISED_DATE_RANGE_ERROR)
    if required_by_from and required_by_to and required_by_from > required_by_to:
        raise ValidationError(REQUIRED_BY_DATE_RANGE_ERROR)


def _validate_filter_date_range(date_from: date | None, date_to: date | None) -> None:
    if date_from and date_to and date_from > date_to:
        raise ValidationError(FILTER_DATE_RANGE_ERROR)


def _validate_priority(priority: str | None) -> str | None:
    if priority is None:
        return None
    allowed = {option.value for option in Priority}
    if priority not in allowed:
        raise ValidationError(f"Invalid indent priority: {priority}")
    return priority


def _validate_unique_item_ids(items) -> None:
    item_ids = [line.item_id for line in items]
    if len(item_ids) != len(set(item_ids)):
        raise ValidationError(DUPLICATE_ITEM_ERROR)


MISSING_QTY_ERROR = "Quantity is required for every selected item."


def _validate_item_quantities(items) -> None:
    """Reject any line where quantity is missing, zero, or negative."""
    for line in items:
        if not line.quantity or line.quantity <= 0:
            raise ValidationError(MISSING_QTY_ERROR)


async def _items_by_id(db: AsyncSession, item_ids: list[int]) -> dict[int, Item]:
    if not item_ids:
        return {}
    rows = (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    return {i.id: i for i in rows}


async def list_office_options(db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(HcmOffice).where(HcmOffice.is_active.is_(True)).order_by(HcmOffice.name)
    )).scalars().all()
    return {"items": [{"id": office.id, "name": office.name} for office in rows]}


async def list_region_options(db: AsyncSession, user=None) -> dict:
    """The Region/Location values actually present on the indents the caller can see.

    Not the whole 1504-row office master: a filter offering 1,500 locations of which a
    handful ever appear is unusable, and every option here is guaranteed to return
    rows. Indents with no region are filtered with the explicit "Unassigned" choice on
    the client rather than an entry in this list.
    """
    stmt = (
        select(Indent.region_id, Indent.region_name)
        .where(Indent.region_id.is_not(None))
        .distinct()
        .order_by(Indent.region_name)
    )
    if user is not None:
        stmt = stmt.where(await indent_access_condition(db, user))
    rows = (await db.execute(stmt)).all()
    return {"items": [{"id": region_id, "name": name} for region_id, name in rows]}


# ---------------- indent type + vehicle ----------------

INVALID_INDENT_TYPE_ERROR = "Invalid indent type: {value}"
UNKNOWN_VEHICLE_ERROR = "Unknown vehicle id: {value}"
VEHICLE_REGISTER_UNAVAILABLE_ERROR = (
    "The vehicle register is unavailable, so a vehicle cannot be attached right now. "
    "Save the indent without one and add it later."
)
VEHICLE_LOOKUP_LIMIT = 200


def _validate_indent_type(indent_type) -> str | None:
    """Same shape as _validate_priority.

    The router parses the enum, but the service is also called directly (tests, and
    any future module), so nothing may reach the column that IndentType has no member
    for — rule 3, applied to a classification rather than a status.
    """
    if indent_type is None:
        return None
    value = getattr(indent_type, "value", indent_type)
    if value not in {option.value for option in IndentType}:
        raise ValidationError(INVALID_INDENT_TYPE_ERROR.format(value=value))
    return value


# `trn_vehicles` belongs to the transport team. It is read by raw text and not mapped,
# for the reason warehouse.service.vehicle_options gives: declaring a second model for
# another team's table is a mapper that has to be kept in step for a dropdown's sake.
# The query is duplicated here rather than imported because warehouse sits AFTER
# indents in the module chain (inventory -> indents -> procurement -> logistics ->
# warehouse) and importing it would invert the dependency.
_VEHICLE_SELECT = "SELECT id, vehicle_number FROM trn_vehicles"


async def vehicle_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    """Vehicles for the indent form's picker."""
    sql = (f"{_VEHICLE_SELECT} "
           "WHERE (:search IS NULL OR vehicle_number LIKE :like) "
           "ORDER BY vehicle_number LIMIT :limit")
    try:
        rows = (await db.execute(text(sql), {
            "search": search, "like": f"%{search or ''}%",
            "limit": VEHICLE_LOOKUP_LIMIT,
        })).all()
    except Exception:  # noqa: BLE001 — another team's table; it may not exist yet
        logger.warning("trn_vehicles is not available; the vehicle picker will be empty")
        return []
    return [{"id": row[0], "code": row[1], "name": row[1]} for row in rows]


async def _resolve_vehicle(db: AsyncSession, vehicle_id: int | None) -> tuple:
    """(id, registration number) for the snapshot, or (None, None).

    Unlike the picker this does NOT swallow a missing table: silently storing an id
    nobody could verify, with no number beside it, is worse than telling the raiser
    the register is down. A vehicle is optional, so they can still save.
    """
    if vehicle_id is None:
        return None, None
    try:
        row = (await db.execute(
            text(f"{_VEHICLE_SELECT} WHERE id = :id"), {"id": vehicle_id},
        )).first()
    except Exception:  # noqa: BLE001 — see above
        logger.warning("trn_vehicles is not available; cannot attach vehicle %s",
                       vehicle_id)
        # A failed statement leaves the session unusable, and this one is raised
        # mid-request: without the rollback the caller's next query dies somewhere
        # far less obvious than here.
        await db.rollback()
        raise ValidationError(VEHICLE_REGISTER_UNAVAILABLE_ERROR)
    if row is None:
        raise ValidationError(UNKNOWN_VEHICLE_ERROR.format(value=vehicle_id))
    return row[0], row[1]


async def _name(db: AsyncSession, model, pk) -> str | None:
    if pk is None:
        return None
    row = await db.get(model, pk)
    return row.name if row else None


async def _requester_context(db: AsyncSession, user) -> dict:
    position_id = getattr(user, "active_position_id", None)
    stmt = select(HcmPositionAssignment).where(
        HcmPositionAssignment.employee_id == user.id,
        HcmPositionAssignment.is_active.is_(True),
    )
    if position_id is not None:
        stmt = stmt.where(HcmPositionAssignment.position_id == position_id)
    else:
        stmt = stmt.order_by(HcmPositionAssignment.is_primary.desc())
    assignment = (await db.execute(stmt.limit(1))).scalar_one_or_none()
    position = (
        await db.get(HcmPosition, assignment.position_id) if assignment else None
    )
    department_id = (
        (assignment.department_id if assignment else None)
        or (position.department_id if position else None)
        or user.department_id
    )
    office_id = (
        (assignment.office_id if assignment else None)
        or (position.office_id if position else None)
        or user.office_id
    )
    project_id = (position.project_id if position else None) or user.project_id
    # Region/Location comes from the employee record and ONLY from it: HCM tags each
    # employee to a location on `hcm_employees.office_id`, and that tag is what monthly
    # indents are grouped by. It is deliberately not the assignment/position office
    # resolved above (those disagree on 5 of 296 live indents), and never a position
    # name parsed for a place.
    region_id = user.office_id
    region_name = getattr(user, "office_name", None)
    if region_id is not None and not region_name:
        region_name = await _name(db, HcmOffice, region_id)
    return {
        "position_id": position.id if position else None,
        "position_name": position.name if position else None,
        "department_id": department_id,
        "department_name": await _name(db, HcmDepartment, department_id),
        "office_id": office_id,
        "office_name": await _name(db, HcmOffice, office_id),
        "region_id": region_id,
        "region_name": region_name if region_id is not None else None,
        "project_id": project_id,
        "project_name": (position.project_name if position else None) or user.project_name,
    }


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    _validate_required_date(data.required_date)
    priority = _validate_priority(data.priority) or Priority.NORMAL.value
    indent_type = _validate_indent_type(
        getattr(data, "indent_type", None)) or IndentType.REGULAR.value

    if not data.items:
        raise ValidationError("Indent must have at least one item")
    _validate_item_quantities(data.items)
    _validate_unique_item_ids(data.items)

    items_map = await _items_by_id(db, [line.item_id for line in data.items])
    missing = {line.item_id for line in data.items} - set(items_map)
    if missing:
        raise ValidationError(f"Unknown item ids: {sorted(missing)}")

    # Ahead of next_number(): a rejected vehicle must not burn a document number.
    vehicle_id, vehicle_number = await _resolve_vehicle(
        db, getattr(data, "vehicle_id", None))

    context = await _requester_context(db, user)
    total_qty = sum(line.quantity for line in data.items)
    indent = Indent(
        indent_no=await next_number(db, "indent"),
        indent_type=indent_type,
        indent_date=utcnow().date(),
        required_date=data.required_date,
        vehicle_id=vehicle_id,
        vehicle_number=vehicle_number,
        requested_by_id=user.id,
        requested_by_name=user.full_name,
        requested_by_code=user.emp_code,
        position_id=context["position_id"],
        position_name=context["position_name"],
        department_id=context["department_id"],
        department_name=context["department_name"],
        office_id=context["office_id"],
        office_name=context["office_name"],
        region_id=context["region_id"],
        region_name=context["region_name"],
        project_id=context["project_id"],
        project_name=context["project_name"],
        status=IndentStatus.DRAFT.value,
        priority=priority,
        total_items=len(data.items),
        total_qty=total_qty,
        remarks=data.remarks,
        created_by_id=user.id,
        created_by_name=user.full_name,
    )
    db.add(indent)
    await db.flush()

    for line_no, line in enumerate(data.items, start=1):
        item = items_map[line.item_id]
        db.add(IndentItem(
            indent_id=indent.id, line_no=line_no, item_id=item.id, item_code=item.code,
            item_name=item.name, uom_code=item.uom_code,
            quantity=line.quantity, remarks=line.remarks,
        ))
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": indent.status, "total_items": indent.total_items,
               "indent_type": indent.indent_type,
               "vehicle_number": indent.vehicle_number},
    )
    await db.commit()
    await db.refresh(indent)
    return indent


def _values(values) -> list[str]:
    return [value.value for value in values or []]


def unknown_indent_statuses(statuses) -> set[str]:
    known = {status.value for status in IndentStatus}
    return {str(status) for status in statuses if status is not None and str(status) not in known}


def _workflow_context_for_indent(indent: Indent) -> dict:
    return {
        "doc_no": indent.indent_no,
        "doc_summary": f"Indent {indent.indent_no}",
        "department_id": indent.department_id,
        "project_id": getattr(indent, "project_id", None),
        "requester_position_id": indent.position_id,
        "requester_position_name": indent.position_name,
        "total_quantity": float(indent.total_qty or 0),
    }


async def _indent_correction_state(db: AsyncSession, indent: Indent) -> dict | None:
    return await engine.get_correction_state(db, DocType.INDENT.value, indent.id)


def _correction_owner_payload(state: dict | None) -> dict | None:
    if not state:
        return None
    employee_id = state.get("correction_owner_employee_id")
    if employee_id is None:
        return None
    return {
        "employee_id": int(employee_id),
        "employee_name": state.get("correction_owner_name"),
        "position_id": state.get("correction_owner_position_id"),
    }


def _is_correction_owner(state: dict | None, user) -> bool:
    if not state:
        return False
    if int(state.get("correction_owner_employee_id") or 0) != int(user.id):
        return False
    position_id = state.get("correction_owner_position_id")
    return position_id is None or getattr(user, "active_position_id", None) == int(position_id)


def _clean_search(search: str | None) -> str | None:
    term = search.strip() if search else ""
    return term or None


def _like_pattern(term: str) -> str:
    escaped = (
        term
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return f"%{escaped}%"


def _matches(column, pattern: str):
    return column.ilike(pattern, escape="\\")


def _indent_item_exists(pattern: str):
    return exists(
        select(1)
        .select_from(IndentItem)
        .where(IndentItem.indent_id == Indent.id)
        .where(or_(
            _matches(IndentItem.item_code, pattern),
            _matches(IndentItem.item_name, pattern),
            _matches(IndentItem.uom_code, pattern),
            _matches(IndentItem.remarks, pattern),
        ))
    )


def _indent_search_conditions(pattern: str):
    return [
        _matches(Indent.indent_no, pattern),
        _matches(Indent.requested_by_name, pattern),
        _matches(Indent.requested_by_code, pattern),
        _matches(Indent.position_name, pattern),
        _matches(Indent.department_name, pattern),
        _matches(Indent.project_name, pattern),
        _matches(Indent.office_name, pattern),
        _matches(Indent.remarks, pattern),
    ]


def _main_indent_search_conditions(term: str, pattern: str):
    """Search only fields displayed by the main Indents list/overview."""
    if term.isdigit():
        return [_matches(Indent.indent_no, pattern)]
    return [
        _matches(Indent.indent_no, pattern),
        _matches(Indent.requested_by_name, pattern),
        _matches(Indent.department_name, pattern),
        _matches(func.replace(Indent.status, "_", " "), pattern),
    ]


def _indent_sort(sort_by: str, sort_dir: str):
    columns = {
        "created_at": Indent.created_at,
        "indent_no": Indent.indent_no,
        "required_date": Indent.required_date,
        "status": Indent.status,
        "priority": Indent.priority,
    }
    column = columns.get(sort_by)
    if column is None:
        raise ValidationError(f"Unsupported indent sort field: {sort_by}")
    return column.asc() if sort_dir.lower() == "asc" else column.desc()


async def _current_assignment(db: AsyncSession, user):
    position_id = getattr(user, "active_position_id", None)
    if position_id is None:
        return None, None
    today = utcnow().date()
    assignment = (await db.execute(
        select(HcmPositionAssignment).where(
            HcmPositionAssignment.employee_id == user.id,
            HcmPositionAssignment.position_id == position_id,
            HcmPositionAssignment.is_active.is_(True),
            or_(
                HcmPositionAssignment.valid_from.is_(None),
                HcmPositionAssignment.valid_from <= today,
            ),
            or_(
                HcmPositionAssignment.valid_to.is_(None),
                HcmPositionAssignment.valid_to >= today,
            ),
        ).limit(1)
    )).scalar_one_or_none()
    position = await db.get(HcmPosition, position_id) if assignment else None
    return assignment, position


async def _descendant_position_ids(db: AsyncSession, position_id: int | None) -> list[int]:
    if position_id is None:
        return []
    descendants: list[int] = []
    frontier = [position_id]
    seen = {position_id}
    while frontier:
        rows = (await db.execute(
            select(HcmPosition.id).where(
                HcmPosition.parent_position_id.in_(frontier),
                HcmPosition.is_active.is_(True),
            )
        )).scalars().all()
        frontier = []
        for row_id in rows:
            if row_id in seen:
                continue
            seen.add(row_id)
            descendants.append(row_id)
            frontier.append(row_id)
    return descendants


def _normalised_scope_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(
        "".join(char.upper() if char.isalnum() else " " for char in value).split()
    )


def _scope_from_text(value: str | None, *, allow_prefix: bool) -> str | None:
    text = _normalised_scope_text(value)
    if not text:
        return None
    aliases = {
        "OE": "OE",
        "OPERATION EXECUTIVE": "OE",
        "OPERATIONS EXECUTIVE": "OE",
        "DM": "DM",
        "DISTRICT MANAGER": "DM",
        "RM": "RM",
        "REGIONAL MANAGER": "RM",
        "SPH": "SPH",
        "STATE PROJECT HEAD": "SPH",
        "COO": "COO",
        "CHIEF OPERATING OFFICER": "COO",
    }
    exact = aliases.get(text)
    if exact or not allow_prefix:
        return exact
    prefix_aliases = {
        "OE ": "OE",
        "OPERATION EXECUTIVE ": "OE",
        "OPERATIONS EXECUTIVE ": "OE",
        "DM ": "DM",
        "DISTRICT MANAGER ": "DM",
        "RM ": "RM",
        "REGIONAL MANAGER ": "RM",
        "SPH ": "SPH",
        "STATE PROJECT HEAD ": "SPH",
        "CHIEF OPERATING OFFICER ": "COO",
    }
    for prefix, scope in prefix_aliases.items():
        if text.startswith(prefix):
            return scope
    return None


def _scope_from_role_codes(role_codes: set[str]) -> str | None:
    for role_code in role_codes:
        scope = _scope_from_text(role_code, allow_prefix=True)
        if scope:
            return scope
    return None


def _position_scope_code(
    assignment: HcmPositionAssignment | None,
    position: HcmPosition | None,
) -> str | None:
    if position is None:
        return None
    canonical_candidates = [
        position.code,
        position.role_name,
        position.job_name,
        (position.raw or {}).get("position_code") if isinstance(position.raw, dict) else None,
        (position.raw or {}).get("role_code") if isinstance(position.raw, dict) else None,
        (assignment.raw or {}).get("position_code") if assignment and isinstance(assignment.raw, dict) else None,
        (assignment.raw or {}).get("role_code") if assignment and isinstance(assignment.raw, dict) else None,
    ]
    for candidate in canonical_candidates:
        scope = _scope_from_text(candidate, allow_prefix=False)
        if scope:
            return scope
    for candidate in [
        assignment.position_name if assignment else None,
        position.name,
    ]:
        scope = _scope_from_text(candidate, allow_prefix=True)
        if scope:
            return scope
    return None


def _canonical_position_scope_code(
    assignment: HcmPositionAssignment | None,
    position: HcmPosition | None,
) -> str | None:
    if position is None:
        return None
    canonical_candidates = [
        position.code,
        position.role_name,
        position.job_name,
        (position.raw or {}).get("position_code") if isinstance(position.raw, dict) else None,
        (position.raw or {}).get("role_code") if isinstance(position.raw, dict) else None,
        (assignment.raw or {}).get("position_code") if assignment and isinstance(assignment.raw, dict) else None,
        (assignment.raw or {}).get("role_code") if assignment and isinstance(assignment.raw, dict) else None,
    ]
    for candidate in canonical_candidates:
        scope = _scope_from_text(candidate, allow_prefix=True)
        if scope:
            return scope
    return None


def _acknowledgment_scope_code(
    assignment: HcmPositionAssignment | None,
    position: HcmPosition | None,
) -> str | None:
    return (
        _canonical_position_scope_code(assignment, position)
        or _position_scope_code(assignment, position)
    )


def _acknowledgment_stage_name(
    stage_name: str | None,
    action: str | None,
    actor_scope_code: str | None,
) -> str | None:
    if (
        actor_scope_code == "DM"
        and action in {ApprovalAction.SUBMITTED.value, ApprovalAction.APPROVED.value}
    ):
        return "District Manager"
    return stage_name


def _is_admin_role(role_codes: set[str]) -> bool:
    for role_code in role_codes:
        normalized = _normalised_scope_text(role_code)
        if role_code.upper() in {"ADMIN", "SUPER_ADMIN", "SUPERADMIN"}:
            return True
        if normalized in {"ADMIN", "SUPER ADMIN", "SUPERADMIN"}:
            return True
    return False


async def _authenticated_role_codes(db: AsyncSession, user) -> set[str]:
    roles = await rbac_service.get_user_roles(
        db, user.id, getattr(user, "active_position_id", None),
    )
    return {str(role.code) for role in roles if getattr(role, "code", None)}


def _can_view_reporting_subtree(scope_code: str | None) -> bool:
    return scope_code in {"OE", "DM", "RM"}


def _has_global_indent_read(scope_code: str | None, role_codes: set[str]) -> bool:
    return scope_code in {"SPH", "COO"} or _is_admin_role(role_codes)


async def _scm_stage_statuses(db: AsyncSession, user) -> list[str]:
    user_perms = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    scm_codes = {
        perms.ALLOCATION_VIEW,
        perms.STOCK_VIEW,
        perms.MR_VIEW,
    }
    if not (user_perms & scm_codes):
        return []
    return [
        IndentStatus.APPROVED.value,
        IndentStatus.AWAITING_ALLOCATION.value,
        IndentStatus.ALLOCATED.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.PARTIALLY_ORDERED.value,
        IndentStatus.ORDERED.value,
        IndentStatus.CLOSED.value,
    ]


async def indent_access_condition(db: AsyncSession, user):
    """Central visibility scope for indents.

    Role permissions open endpoints and UI actions. This SQL predicate limits which
    records the authenticated employee may actually see.
    """
    assignment, position = await _current_assignment(db, user)
    position_id = getattr(user, "active_position_id", None)
    role_codes = await _authenticated_role_codes(db, user)
    role_scope_code = _scope_from_role_codes(role_codes)
    canonical_position_scope_code = _canonical_position_scope_code(assignment, position)
    scope_code = role_scope_code or canonical_position_scope_code or _position_scope_code(assignment, position)
    descendant_ids = await _descendant_position_ids(db, position_id) if assignment else []
    project_id = position.project_id if position else None

    # An employee can hold multiple positions.  The requester id identifies the
    # person, while position_id identifies the capacity in which the indent was
    # raised; both must match for "my indents" visibility.  Without the position
    # predicate, switching from (for example) LT to Storekeeper leaked the LT
    # indents into the Storekeeper session.
    requester_scope = and_(
        Indent.requested_by_id == user.id,
        Indent.position_id == position_id,
    )
    visible = [requester_scope]

    if _has_global_indent_read(scope_code, role_codes):
        visible.append(literal(True))
    elif descendant_ids and _can_view_reporting_subtree(scope_code) and project_id is not None:
        visible.append(and_(
            Indent.position_id.in_(descendant_ids),
            Indent.project_id == project_id,
        ))

    participant_conditions = [
        Instance.id.in_(select(Pending.instance_id).where(Pending.approver_id == user.id)),
    ]
    # Workflow actions snapshot the position name used for the decision.  Match
    # that snapshot to the selected position so a submit/approve action performed
    # in one capacity does not make the document visible in another capacity.
    if position is not None:
        participant_conditions.append(Instance.id.in_(
            select(Action.instance_id).where(
                Action.actor_id == user.id,
                Action.actor_position == position.name,
            )
        ))
    participant_instances = select(Instance.doc_id).where(
        Instance.doc_type == DocType.INDENT.value,
        or_(*participant_conditions),
    )
    visible.append(Indent.id.in_(participant_instances))

    # Inventory works the fulfilment queue for requests it neither raised nor approved,
    # and the SCM department sits on posts with no children, so no branch above can ever
    # show them one. Holding the SCM read permissions does — and only from the point the
    # request reaches inventory, never before approval.
    scm_statuses = await _scm_stage_statuses(db, user)
    if scm_statuses:
        visible.append(Indent.status.in_(scm_statuses))

    return or_(*visible)


async def _assert_can_view_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    stmt = (
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
        .where(await indent_access_condition(db, user))
    )
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


async def _has_pending_approval(db: AsyncSession, indent_id: int, user_id: int) -> bool:
    return bool(await db.scalar(
        select(func.count())
        .select_from(Pending)
        .where(
            Pending.doc_type == DocType.INDENT.value,
            Pending.doc_id == indent_id,
            Pending.approver_id == user_id,
        )
    ))


async def _assert_active_workflow_task(db: AsyncSession, indent_id: int, user_id: int) -> None:
    if not await _has_pending_approval(db, indent_id, user_id):
        raise PermissionError_("This indent is not currently assigned to you for approval")


def _current_workflow_link(instance: Instance) -> dict | None:
    for link in instance.resolved_chain or []:
        if not isinstance(link, dict):
            continue
        try:
            sequence = int(link.get("sequence", 0))
        except (TypeError, ValueError):
            continue
        if sequence == int(instance.current_sequence or 0):
            return link
    return None


async def _pending_indent_return_instance(
    db: AsyncSession, indent_id: int, user_id: int,
) -> Instance | None:
    return (await db.execute(
        select(Instance)
        .join(Pending, Pending.instance_id == Instance.id)
        .where(
            Instance.doc_type == DocType.INDENT.value,
            Instance.doc_id == indent_id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
            Pending.doc_type == DocType.INDENT.value,
            Pending.doc_id == indent_id,
            Pending.stage_sequence == Instance.current_sequence,
            Pending.approver_id == user_id,
        )
        .limit(1)
    )).scalar_one_or_none()


async def _active_position_matches_return_task(
    db: AsyncSession, instance: Instance, user,
) -> bool:
    active_position_id = getattr(user, "active_position_id", None)
    if active_position_id is None:
        return False
    assignment, position = await _current_assignment(db, user)
    if assignment is None or position is None or not position.is_active:
        return False

    link = _current_workflow_link(instance)
    if link is None:
        return False

    allowed_positions = ladder.allowed_position_ids(link)
    approver_ids = {int(value) for value in link.get("approver_ids", [])}
    if allowed_positions and int(user.id) in approver_ids:
        return int(active_position_id) in allowed_positions
    return True


async def can_return_indent_for_correction(
    db: AsyncSession, indent: Indent, user, user_perms: set[str] | None = None,
) -> bool:
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        return False
    if indent.requested_by_id == user.id:
        return False
    if await _indent_correction_state(db, indent):
        return False

    user_perms = user_perms or await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    if perms.INDENT_APPROVE not in user_perms:
        return False

    instance = await _pending_indent_return_instance(db, indent.id, user.id)
    if instance is None:
        return False
    return await _active_position_matches_return_task(db, instance, user)


async def _attach_capabilities(db: AsyncSession, indent: Indent, user) -> Indent:
    user_perms = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    correction_state = None
    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        correction_state = await _indent_correction_state(db, indent)
    is_correction_owner = _is_correction_owner(correction_state, user)
    is_requester = indent.requested_by_id == user.id
    is_pending_user = (
        indent.status == IndentStatus.PENDING_APPROVAL.value
        and not is_requester
        and await _has_pending_approval(db, indent.id, user.id)
    )
    indent.can_submit = (
        indent.status == IndentStatus.DRAFT.value
        and is_requester
        and perms.INDENT_SUBMIT in user_perms
    )
    indent.can_approve = is_pending_user and perms.INDENT_APPROVE in user_perms
    indent.can_reject = is_pending_user and perms.INDENT_REJECT in user_perms
    indent.can_return_for_correction = await can_return_indent_for_correction(
        db, indent, user, user_perms,
    )
    indent.can_edit_correction = (
        indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value
        and is_correction_owner
    )
    indent.can_resubmit_correction = (
        indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value
        and is_correction_owner
    )
    indent.correction_owner = _correction_owner_payload(correction_state)
    indent.returned_from_stage = (
        correction_state or {}
    ).get("returned_from_stage")
    indent.resubmit_target_stage = (
        correction_state or {}
    ).get("resubmit_target_stage")
    indent.correction_comment = (
        correction_state or {}
    ).get("correction_comment")
    return indent


async def get_indent(db: AsyncSession, indent_id: int, user=None) -> Indent:
    if user is not None:
        indent = await _assert_can_view_indent(db, indent_id, user)
        return await _attach_capabilities(db, indent, user)
    indent = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


async def _get_indent_for_journey(db: AsyncSession, indent_id: int, user) -> Indent:
    stmt = (
        select(Indent)
        .options(load_only(
            Indent.id,
            Indent.indent_no,
            Indent.status,
            Indent.requested_by_name,
            Indent.position_id,
            Indent.position_name,
            Indent.created_at,
            Indent.approved_at,
            Indent.remarks,
        ))
        .where(Indent.id == indent_id)
        .where(await indent_access_condition(db, user))
    )
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


def _region_predicate(column, region_ids, include_unassigned: bool):
    """The one place Region/Location narrowing is expressed.

    Region is nullable — every indent raised before this field existed, and every
    indent whose requester HCM has no location for, reads back NULL. `IN (...)` drops
    those rows silently, so "Unassigned" is an explicit opt-in choice rather than
    something a user has to discover by noticing the totals do not add up.
    """
    clauses = []
    if region_ids:
        clauses.append(column.in_(region_ids))
    if include_unassigned:
        clauses.append(column.is_(None))
    if not clauses:
        return None
    return clauses[0] if len(clauses) == 1 else or_(*clauses)


def _apply_region_filter(stmt, region_ids, include_unassigned: bool):
    predicate = _region_predicate(Indent.region_id, region_ids, include_unassigned)
    return stmt if predicate is None else stmt.where(predicate)


def _apply_indent_filters(
    stmt,
    *,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    required_by_from: date | None = None,
    required_by_to: date | None = None,
    statuses: list[IndentStatus] | None = None,
    priorities: list[Priority] | None = None,
    indent_types: list[IndentType] | None = None,
    department_ids: list[int] | None = None,
    region_ids: list[int] | None = None,
    include_unassigned_region: bool = False,
    is_bookmarked: str | None = None,
):
    term = _clean_search(search)
    if term:
        pattern = _like_pattern(term)
        stmt = stmt.where(or_(*_main_indent_search_conditions(term, pattern)))
    if date_from:
        stmt = stmt.where(
            Indent.created_at >= datetime.combine(date_from, time.min, timezone.utc)
        )
    if date_to:
        stmt = stmt.where(
            Indent.created_at
            < datetime.combine(date_to + timedelta(days=1), time.min, timezone.utc)
        )
    if required_by_from:
        stmt = stmt.where(Indent.required_date >= required_by_from)
    if required_by_to:
        stmt = stmt.where(Indent.required_date <= required_by_to)
    if statuses:
        stmt = stmt.where(Indent.status.in_(_values(statuses)))
    if priorities:
        stmt = stmt.where(Indent.priority.in_(_values(priorities)))
    if indent_types:
        stmt = stmt.where(Indent.indent_type.in_(_values(indent_types)))
    if department_ids:
        stmt = stmt.where(Indent.department_id.in_(department_ids))
    stmt = _apply_region_filter(stmt, region_ids, include_unassigned_region)
    if is_bookmarked:
        bookmark_value = is_bookmarked.strip().upper()
        if bookmark_value not in {"YES", "NO"}:
            raise ValidationError("is_bookmarked must be YES or NO")
        stmt = stmt.where(Indent.is_bookmarked == bookmark_value)
    return stmt


async def list_indents(
    db: AsyncSession,
    params: PageParams,
    *,
    user=None,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    required_by_from: date | None = None,
    required_by_to: date | None = None,
    statuses: list[IndentStatus] | None = None,
    priorities: list[Priority] | None = None,
    indent_types: list[IndentType] | None = None,
    department_ids: list[int] | None = None,
    region_ids: list[int] | None = None,
    include_unassigned_region: bool = False,
    is_bookmarked: str | None = None,
    has_remainder: bool = False,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
) -> dict:
    _validate_indent_date_ranges(
        date_from, date_to, required_by_from, required_by_to,
    )
    stmt = select(Indent).options(selectinload(Indent.items))
    if user is not None:
        stmt = stmt.where(await indent_access_condition(db, user))
    stmt = _apply_indent_filters(
        stmt, search=search, date_from=date_from, date_to=date_to,
        required_by_from=required_by_from, required_by_to=required_by_to,
        statuses=statuses, priorities=priorities, indent_types=indent_types,
        department_ids=department_ids, region_ids=region_ids,
        include_unassigned_region=include_unassigned_region,
        is_bookmarked=is_bookmarked,
    )
    if has_remainder:
        # At least one line still owes something. EXISTS rather than a join, so an
        # indent with three unfulfilled lines is still one row in the queue.
        stmt = stmt.where(exists(
            select(IndentItem.id).where(
                IndentItem.indent_id == Indent.id,
                IndentItem.approved_quantity > IndentItem.allocated_quantity,
            ).correlate(Indent)
        ))
    id_tie_breaker = Indent.id.asc() if sort_dir.lower() == "asc" else Indent.id.desc()
    stmt = stmt.order_by(_indent_sort(sort_by, sort_dir), id_tie_breaker)
    return await paginate(db, stmt, params)


async def set_indent_bookmark(
    db: AsyncSession,
    indent_id: int,
    user,
    *,
    is_bookmarked: bool,
) -> Indent:
    indent = await get_indent(db, indent_id, user)
    before = {"is_bookmarked": indent.is_bookmarked}
    indent.is_bookmarked = "YES" if is_bookmarked else "NO"
    await write_audit(
        db,
        entity="ind_indents",
        entity_id=indent.id,
        entity_no=indent.indent_no,
        action=AuditAction.UPDATE,
        actor=user,
        before=before,
        after={"is_bookmarked": indent.is_bookmarked},
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def update_indent(db: AsyncSession, indent_id: int, data: IndentUpdate, user) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.status == IndentStatus.DRAFT.value:
        if indent.requested_by_id != user.id:
            raise PermissionError_("Only the requester can edit this indent")
        user_perms = await rbac_service.get_user_permissions(
            db, user, getattr(user, "active_position_id", None),
        )
        if perms.INDENT_EDIT not in user_perms:
            raise PermissionError_(f"Missing permission: {perms.INDENT_EDIT}")
    elif indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        correction_state = await _indent_correction_state(db, indent)
        if not _is_correction_owner(correction_state, user):
            raise ValidationError(f"Cannot edit an indent in {indent.status} status")
    else:
        raise ValidationError(f"Cannot edit an indent in {indent.status} status")

    _validate_required_date(data.required_date)

    before = {
        "required_date": indent.required_date.isoformat() if indent.required_date else None,
        "priority": indent.priority,
        "indent_type": indent.indent_type,
        "vehicle_id": indent.vehicle_id,
        "vehicle_number": indent.vehicle_number,
        "office_id": indent.office_id,
        "office_name": indent.office_name,
        "remarks": indent.remarks,
        "total_items": indent.total_items,
        "total_qty": float(indent.total_qty or 0),
    }
    indent.required_date = data.required_date
    if data.priority is not None:
        indent.priority = _validate_priority(data.priority)
    if data.indent_type is not None:
        indent.indent_type = _validate_indent_type(data.indent_type)
    # Explicitly sent, so a null clears the vehicle. Omitting the key leaves whatever
    # is already attached — the same contract office_id follows below.
    if "vehicle_id" in data.model_fields_set:
        indent.vehicle_id, indent.vehicle_number = await _resolve_vehicle(
            db, data.vehicle_id)
    # region_id/region_name are absent from IndentUpdate on purpose. Region is the
    # requester's HCM location, snapshotted at create; an edit must never move an
    # indent into another region's monthly grouping, so there is no branch for it here.
    if "office_id" in data.model_fields_set:
        office = await db.get(HcmOffice, data.office_id) if data.office_id is not None else None
        if data.office_id is not None and (office is None or not office.is_active):
            raise ValidationError(f"Unknown or inactive office id: {data.office_id}")
        indent.office_id = office.id if office else None
        indent.office_name = office.name if office else None
    if "remarks" in data.model_fields_set:
        indent.remarks = data.remarks

    if data.items is not None:
        if not data.items:
            raise ValidationError("Indent must have at least one item")
        _validate_item_quantities(data.items)
        _validate_unique_item_ids(data.items)
        items_map = await _items_by_id(db, [l.item_id for l in data.items])
        indent.items.clear()
        for line_no, line in enumerate(data.items, start=1):
            item = items_map.get(line.item_id)
            if not item:
                raise ValidationError(f"Unknown item id: {line.item_id}")
            indent.items.append(IndentItem(
                line_no=line_no, item_id=item.id, item_code=item.code, item_name=item.name,
                uom_code=item.uom_code, quantity=line.quantity, remarks=line.remarks,
            ))
        indent.total_items = len(data.items)
        indent.total_qty = sum(line.quantity for line in data.items)

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user, before=before,
        after={
            "required_date": indent.required_date.isoformat() if indent.required_date else None,
            "priority": indent.priority,
            "indent_type": indent.indent_type,
            "vehicle_id": indent.vehicle_id,
            "vehicle_number": indent.vehicle_number,
            "office_id": indent.office_id,
            "office_name": indent.office_name,
            "remarks": indent.remarks,
            "total_items": indent.total_items,
            "total_qty": float(indent.total_qty or 0),
        },
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def delete_indent(db: AsyncSession, indent_id: int, user) -> None:
    indent = await get_indent(db, indent_id, user)
    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError("Cannot delete an indent returned for correction")
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot delete an indent in {indent.status} status")
    if indent.requested_by_id != user.id:
        user_perms = await rbac_service.get_user_permissions(
            db, user, getattr(user, "active_position_id", None),
        )
        if perms.INDENT_DELETE not in user_perms:
            raise PermissionError_("Only the requester can delete this indent")

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.DEACTIVATE, actor=user,
        before={
            "status": indent.status,
            "total_items": indent.total_items,
            "total_qty": float(indent.total_qty or 0),
        },
    )
    await db.delete(indent)
    await db.commit()


def _seed_approval_quantities(indent: Indent, *, only_uninitialised: bool = False) -> None:
    """Put the raised quantity on the table before the first approver sees it.

    `approved_qty` is what one level passes to the next, and every rung reads it as
    its own ceiling. Left at 0 until an approver edits a quantity, an approval taken
    through the plain approve endpoint — the indent screen's one-click Approve, or an
    API client — recorded nothing at all, and the NEXT approver opened a screen whose
    ceiling had collapsed to zero: a number nobody entered, wiping out the request
    between two people who both meant to pass it on.

    Seeding here makes the column mean one thing at every rung: the quantity currently
    on the table. An approval that changes nothing passes it through unchanged, and 0
    can only mean a level deliberately approved none of that line.

    `only_uninitialised` is for the resubmit-after-correction path, where a rung below
    may already have cut a line: correcting an indent must not hand back quantity an
    approver had taken off it. Only lines the correction rebuilt from scratch (and so
    reset to 0) are seeded there.
    """
    for line in indent.items:
        if only_uninitialised and _d(line.approved_quantity) > 0:
            continue
        line.approved_quantity = line.quantity


async def submit_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError("Use correction resubmit for an indent returned for correction")
    if indent.requested_by_id != user.id:
        raise PermissionError_("Only the requester can submit this indent")
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit an indent in {indent.status} status")

    _seed_approval_quantities(indent)
    workflow_context = _workflow_context_for_indent(indent)
    await engine.start(
        db, doc_type=DocType.INDENT.value, doc_id=indent.id,
        context=workflow_context,
        user=user,
    )
    await rules.safe_fire(
        db,
        "INDENT_SUBMITTED",
        {
            "indent_id": indent.id,
            "indent_no": indent.indent_no,
            "quantity": float(indent.total_qty or 0),
            "priority": indent.priority,
            "department_id": indent.department_id,
            "project_id": indent.project_id,
        },
        doc_type=DocType.INDENT.value,
        doc_id=indent.id,
    )
    indent.status = IndentStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, indent)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": IndentStatus.DRAFT.value},
        after={"status": indent.status},
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


def _d(value) -> Decimal:
    """Decimal or zero. MySQL DECIMALs arrive as strings and a bad one must not 500."""
    try:
        return Decimal(str(value or 0))
    except (ArithmeticError, ValueError):
        return Decimal("0")


# Statuses an indent may still be receiving goods in. Anything else is either not yet
# approved or already finished, and has nothing to acknowledge.
_RECEIVABLE_STATUSES = frozenset({
    IndentStatus.ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PARTIALLY_ORDERED.value,
    IndentStatus.ORDERED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
})

# The photo is the proof the goods landed, which is the whole point of the step. The
# bill is uploaded only when the requester was handed one.
ACK_PHOTO_CATEGORY = "RECEIPT_PHOTO"
ACK_BILL_CATEGORY = "RECEIPT_BILL"
ACK_ENTITY_TYPE = "INDENT_RECEIPT"


def owed_quantity(item) -> Decimal:
    """What the requester is entitled to on this line.

    What the approver granted, falling back to what was asked for. The fallback is not
    cosmetic: most live indent lines predate the approval flow and carry `approved_qty`
    0, and treating that as "owed nothing" would close an indent the moment anyone
    acknowledged it. Same rule the allocation code already uses.
    """
    return _d(item.approved_quantity) or _d(item.quantity)


def _fulfilment_status(items) -> str:
    """CLOSED once every line is fully received, else PARTIALLY_FULFILLED."""
    if all(_d(i.received_quantity) >= owed_quantity(i) for i in items):
        return IndentStatus.CLOSED.value
    return IndentStatus.PARTIALLY_FULFILLED.value


async def add_receipt_attachment(db: AsyncSession, indent_id: int, upload, *,
                                 doc_category: str, user):
    """Store a delivery photo or bill against an indent.

    Gated the same way as the acknowledgement itself: only the requester, and only while
    the indent is still expecting goods. Otherwise anyone with view rights could attach
    "proof" to somebody else's receipt.
    """
    # Loaded unscoped, then gated on the raiser alone. The usual visibility scope also
    # matches on the position the indent was raised in, which would stop somebody who
    # has since changed posts from confirming goods they themselves asked for.
    indent = await get_indent(db, indent_id)
    if indent.requested_by_id != user.id:
        raise PermissionError_(
            "Only the person who raised this indent can attach its delivery proof")
    if indent.status not in _RECEIVABLE_STATUSES:
        raise ValidationError(
            f"{indent.indent_no} is not awaiting delivery (status {indent.status})")
    if doc_category not in {ACK_PHOTO_CATEGORY, ACK_BILL_CATEGORY}:
        raise ValidationError("A delivery attachment is either a photo or a bill")
    return await attachments.add_attachment(
        db, entity_type=ACK_ENTITY_TYPE, entity_id=indent.id,
        upload=upload, doc_category=doc_category, user=user)


async def acknowledge_receipt(db: AsyncSession, indent_id: int,
                              lines: dict[int, Decimal], user) -> Indent:
    """The requester confirms what physically reached them.

    This is the only thing that closes an indent. The warehouse issuing and dispatching
    stock says the goods left; only the person who asked for them can say they arrived,
    so `received_qty` is written here and nowhere else.

    Receipts accumulate: 6 of 10 today and 4 next week are two acknowledgements against
    the same line, which is how goods actually turn up. The status is recomputed from
    the totals every time rather than stepped forward, so a correction cannot strand an
    indent in the wrong state.
    """
    # Unscoped load, raiser-only gate — see add_receipt_attachment. Changing post must
    # not orphan the goods you are still waiting for.
    indent = await get_indent(db, indent_id)
    if indent.requested_by_id != user.id:
        raise PermissionError_(
            "Only the person who raised this indent can acknowledge its delivery")
    if indent.status not in _RECEIVABLE_STATUSES:
        raise ValidationError(
            f"{indent.indent_no} is not awaiting delivery (status {indent.status})")
    if not lines:
        raise ValidationError("Enter what you received on at least one line")

    photos = [
        row for row in await attachments.list_attachments(db, ACK_ENTITY_TYPE, indent.id)
        if row.doc_category == ACK_PHOTO_CATEGORY
    ]
    if not photos:
        raise ValidationError(
            "Attach a photo of the goods you received before acknowledging")

    by_id = {item.id: item for item in indent.items}
    before = {str(i.id): float(_d(i.received_quantity)) for i in indent.items}
    for line_id, quantity in lines.items():
        item = by_id.get(line_id)
        if item is None:
            raise ValidationError(f"Line {line_id} is not on {indent.indent_no}")
        received = _d(quantity)
        if received <= 0:
            raise ValidationError(
                f"{item.item_name or item.item_code}: received quantity must be more "
                "than zero")
        running = _d(item.received_quantity) + received
        owed = owed_quantity(item)
        if running > owed:
            raise ValidationError(
                f"{item.item_name or item.item_code}: {running} received is more than "
                f"the {owed} approved. Acknowledge only what you were given.")
        item.received_quantity = running
        if running >= owed:
            item.status = IndentItemStatus.ISSUED.value

    indent.status = _fulfilment_status(indent.items)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before=before,
        after={"status": indent.status,
               **{str(i.id): float(_d(i.received_quantity)) for i in indent.items}},
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def act_on_indent(db: AsyncSession, indent_id: int, action: ApprovalAction,
                        comments: str, user) -> Indent:
    """APPROVE / REJECT / RETURN. Engine owns the chain; the module owns the status."""
    indent = await get_indent(db, indent_id, user)
    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError("Indent is returned for correction")
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot approve or reject their own indent")
    await _assert_active_workflow_task(db, indent.id, user.id)
    if action == ApprovalAction.REJECTED:
        comments = (comments or "").strip()
        if not comments:
            raise ValidationError(REJECTION_REASON_REQUIRED_ERROR)

    before_status = indent.status
    context = _workflow_context_for_indent(indent)
    instance = await engine.act(
        db, DocType.INDENT.value, indent.id, action.value, user, comments,
        context=context,
    )

    if instance.status == InstanceStatus.APPROVED.value:
        indent.status = IndentStatus.APPROVED.value
        indent.approved_at = utcnow()
        indent.current_approver_name = None
        await _fulfil(db, indent, user)
    elif instance.status == InstanceStatus.REJECTED.value:
        indent.status = IndentStatus.REJECTED.value
        indent.current_approver_name = None
        # Whatever this indent was holding goes back on the shelf immediately —
        # otherwise a rejected request quietly keeps stock out of everyone's reach.
        await inventory_service.release_for_indent(db, indent.id)
    else:
        await _refresh_current_approver(db, indent)

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": indent.status},
        summary=f"{action.value.title()} indent",
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def return_indent_for_correction(
    db: AsyncSession, indent_id: int, comments: str, user,
) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot return their own indent for correction")
    await _assert_active_workflow_task(db, indent.id, user.id)

    before_status = indent.status
    await engine.return_for_correction(
        db,
        DocType.INDENT.value,
        indent.id,
        user,
        comments,
        context=_workflow_context_for_indent(indent),
    )
    indent.status = IndentStatus.RETURNED_FOR_CORRECTION.value
    indent.current_approver_name = None
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": indent.status},
        summary="Returned indent for correction",
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def resubmit_indent_correction(
    db: AsyncSession, indent_id: int, user,
) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.status != IndentStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"Indent is not returned for correction (status {indent.status})")

    before_status = indent.status
    # A correction that edited the lines rebuilt them, which resets approved_qty to 0.
    # Without this the rung the document returns to would open at a zero ceiling.
    _seed_approval_quantities(indent, only_uninitialised=True)
    await engine.resubmit_correction(
        db,
        DocType.INDENT.value,
        indent.id,
        user,
        context=_workflow_context_for_indent(indent),
    )
    indent.status = IndentStatus.PENDING_APPROVAL.value
    await _refresh_current_approver(db, indent)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": indent.status},
        summary="Resubmitted indent correction",
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_capabilities(db, indent, user)


async def approved_pending_po(db: AsyncSession, params: PageParams, user=None) -> dict:
    """Approved indents not yet fully converted to POs — the procurement screen.

    Includes the allocation outcomes: an indent inventory could not fill is precisely
    the one procurement needs to see. Filtering on APPROVED alone would leave this
    screen permanently empty now that approval hands off to allocation.
    """
    stmt = (
        select(Indent).options(selectinload(Indent.items))
        .where(Indent.status.in_([
            IndentStatus.APPROVED.value,
            IndentStatus.PENDING_PROCUREMENT.value,
            IndentStatus.PARTIALLY_FULFILLED.value,
            IndentStatus.PARTIALLY_ORDERED.value,
        ]))
        .where(or_(
            Indent.status == IndentStatus.APPROVED.value,
            Indent.status == IndentStatus.PARTIALLY_ORDERED.value,
            exists(select(1).where(
                MaterialRequest.indent_id == Indent.id,
                MaterialRequest.status == MRStatus.APPROVED.value,
            )),
        ))
    )
    if user is not None:
        stmt = stmt.where(await indent_access_condition(db, user))
    stmt = stmt.order_by(Indent.created_at.desc())
    return await paginate(db, stmt, params)


def _fulfilment_warehouse_types(actions) -> list[str] | None:
    """Which warehouse types may fulfil this indent. None means "any".

    A routing event that matches no rule must not strand the document: we fall through
    to "any warehouse", and the no-match row rules.fire() already wrote to
    rule_executions records that we did. Configuration failing is not the document's
    problem.
    """
    routes = rules.actions_of_type(actions, RuleActionType.ROUTE_FULFILLMENT.value)
    for action in routes:
        types = (action.params or {}).get("warehouse_types")
        if types:
            return list(types)
    return None


def _fulfilment_target(actions) -> str:
    """Configured destination, with the non-negotiable code-level safety default.

    The current product boundary requires every approved indent to be seen by an
    inventory person before Warehouse or Procurement. A missing, malformed or
    premature route therefore resolves to INVENTORY instead of stranding or skipping
    the human allocation decision.
    """
    routes = rules.actions_of_type(actions, RuleActionType.ROUTE_FULFILLMENT.value)
    for action in routes:
        target = str((action.params or {}).get("target") or "").upper()
        if target == "INVENTORY":
            return target
    return "INVENTORY"


async def _fulfil(db: AsyncSession, indent: Indent, user) -> None:
    """Flow doc §3 step 3: hand the approved indent to inventory. Reserve NOTHING.

    An earlier version allocated here automatically — it reserved everything available
    and raised an MR for the rest. That was wrong. Sixty bags of cement with four
    projects wanting it is a judgement somebody makes: how much this project gets, out
    of which warehouse, and what waits. Doing it by rule makes the system a queue.

    So this only records where the indent should go (the rule engine's routing) and
    parks it in the Fulfilment Queue for a person. Stock moves when that person's
    allocation is approved — see modules/inventory/allocations.py.
    """
    ctx = {
        "indent_id": indent.id,
        "department_id": indent.department_id,
        "department_name": indent.department_name,
        "facility_id": indent.office_id,
        "project_id": indent.project_id,
        "project_name": indent.project_name,
        "priority": indent.priority,
        "required_by": indent.required_date,
        "requester_position_id": indent.position_id,
        "total_qty": float(indent.total_qty or 0),
    }
    actions = await rules.safe_fire(
        db, "INDENT_APPROVED", ctx,
        doc_type=DocType.INDENT.value, doc_id=indent.id,
    )

    # Rules are an override layer, never the floor. Until Warehouse exists, every
    # safe route enters the Inventory queue and a person decides the quantity.
    _fulfilment_target(actions)
    _fulfilment_warehouse_types(actions)

    for line in indent.items:
        # allocated_quantity is NOT reset here. It used to be, back when nothing could
        # be served before the ladder finished, so zeroing was just clearing a field
        # that had to be 0 anyway. An approver can now issue from their own point
        # part-way up (approvals/fulfilment.py), and wiping it here told inventory the
        # line was untouched — so the units already handed over would be issued a
        # second time, with the stk_ledger rows for the first lot still on file.
        line.status = (
            IndentItemStatus.ISSUED.value
            if line.allocated_quantity and line.allocated_quantity >= line.approved_quantity
            else IndentItemStatus.PENDING.value
        )
    indent.status = IndentStatus.AWAITING_ALLOCATION.value


async def _refresh_current_approver(db: AsyncSession, indent: Indent) -> None:
    approvers = await engine.current_approvers(db, DocType.INDENT.value, indent.id)
    indent.current_approver_name = ", ".join(a.full_name for a in approvers) or None


_POST_APPROVAL_STATUSES = {
    IndentStatus.APPROVED.value,
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
    IndentStatus.PARTIALLY_ORDERED.value,
    IndentStatus.ORDERED.value,
    IndentStatus.CLOSED.value,
}


def _position_label(name: str | None) -> str:
    if not name:
        return "Approval"
    head = name.split("-", 1)[0].strip()
    return head or name


def _duration_seconds(start: datetime | None, end: datetime | None) -> int | None:
    start = _utc_datetime(start)
    end = _utc_datetime(end)
    if not start or not end or end < start:
        return None
    return int((end - start).total_seconds())


def _utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class _JourneyPositionHolder:
    id: int
    full_name: str | None


def _supports_recursive_cte(db: AsyncSession) -> bool:
    dialect = db.get_bind().dialect
    version = getattr(dialect, "server_version_info", None) or ()
    if dialect.name == "mysql":
        return not version or version >= (8, 0)
    if dialect.name == "mariadb":
        return not version or version >= (10, 2)
    return True


async def _position_chain_cte(db: AsyncSession, requester_position_id: int) -> list[dict]:
    positions = HcmPosition.__table__
    chain = select(
        positions.c.id,
        positions.c.name,
        positions.c.parent_position_id,
        literal(0).label("depth"),
    ).where(
        positions.c.id == requester_position_id,
        positions.c.is_active.is_(True),
    ).cte("position_chain", recursive=True)

    parent = positions.alias("parent_position")
    chain = chain.union_all(
        select(
            parent.c.id,
            parent.c.name,
            parent.c.parent_position_id,
            (chain.c.depth + 1).label("depth"),
        ).where(
            parent.c.id == chain.c.parent_position_id,
            parent.c.is_active.is_(True),
            chain.c.depth < 50,
        )
    )

    rows = (await db.execute(
        select(chain.c.id, chain.c.name, chain.c.parent_position_id, chain.c.depth)
        .where(chain.c.depth > 0)
        .order_by(chain.c.depth.asc())
    )).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "holders": [],
            "is_top": row.parent_position_id is None,
        }
        for row in rows
    ]


async def _position_chain_iterative(db: AsyncSession, requester_position_id: int) -> list[dict]:
    rows: list[dict] = []
    current = (await db.execute(
        select(HcmPosition.id, HcmPosition.parent_position_id).where(
            HcmPosition.id == requester_position_id,
            HcmPosition.is_active.is_(True),
        )
    )).one_or_none()
    seen: set[int] = set()
    while current and current.parent_position_id and current.id not in seen:
        seen.add(current.id)
        parent = (await db.execute(
            select(HcmPosition.id, HcmPosition.name, HcmPosition.parent_position_id)
            .where(
                HcmPosition.id == current.parent_position_id,
                HcmPosition.is_active.is_(True),
            )
        )).one_or_none()
        if parent is None:
            break
        rows.append({
            "id": parent.id,
            "name": parent.name,
            "holders": [],
            "is_top": parent.parent_position_id is None,
        })
        current = parent
    return rows


async def _holders_by_position(
    db: AsyncSession,
    position_ids: list[int],
) -> dict[int, list[_JourneyPositionHolder]]:
    if not position_ids:
        return {}
    rows = (await db.execute(
        select(
            HcmPositionAssignment.position_id,
            HcmEmployee.id,
            HcmEmployee.full_name,
        )
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(
            HcmPositionAssignment.position_id.in_(position_ids),
            HcmPositionAssignment.is_active.is_(True),
            HcmEmployee.is_active.is_(True),
        )
        .order_by(
            HcmPositionAssignment.position_id.asc(),
            HcmPositionAssignment.is_primary.desc(),
            HcmEmployee.full_name.asc(),
        )
    )).all()
    holders: dict[int, list[_JourneyPositionHolder]] = defaultdict(list)
    for position_id, employee_id, full_name in rows:
        holders[position_id].append(_JourneyPositionHolder(employee_id, full_name))
    return holders


async def _approval_positions(db: AsyncSession, requester_position_id: int | None) -> list[dict]:
    if requester_position_id is None:
        return []
    try:
        positions = (
            await _position_chain_cte(db, requester_position_id)
            if _supports_recursive_cte(db)
            else await _position_chain_iterative(db, requester_position_id)
        )
    except DBAPIError:
        positions = await _position_chain_iterative(db, requester_position_id)
    holders = await _holders_by_position(db, [position["id"] for position in positions])
    for position in positions:
        position["holders"] = holders.get(position["id"], [])
    return positions


def _same_position_snapshot(left: str | None, right: str | None) -> bool:
    return bool(left and right and _normalised_scope_text(left) == _normalised_scope_text(right))


def _matching_actor_position(
    records: list[tuple[HcmPositionAssignment, HcmPosition]],
    actor_position: str | None,
) -> tuple[HcmPositionAssignment, HcmPosition] | None:
    if not records:
        return None
    for assignment, position in records:
        if (
            _same_position_snapshot(assignment.position_name, actor_position)
            or _same_position_snapshot(position.name, actor_position)
        ):
            return assignment, position
    primary = next((record for record in records if record[0].is_primary), None)
    return primary or records[0]


async def _acknowledgment_actor_scope_codes(
    db: AsyncSession,
    rows: list[dict],
) -> dict[tuple[int, str | None], str]:
    actor_ids = sorted({
        row["actor_id"] for row in rows
        if row.get("actor_id") is not None
    })
    if not actor_ids:
        return {}
    assignment_rows = (await db.execute(
        select(HcmPositionAssignment, HcmPosition)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(
            HcmPositionAssignment.employee_id.in_(actor_ids),
            HcmPositionAssignment.is_active.is_(True),
            HcmPosition.is_active.is_(True),
        )
        .order_by(
            HcmPositionAssignment.employee_id.asc(),
            HcmPositionAssignment.is_primary.desc(),
            HcmPosition.name.asc(),
        )
    )).all()
    by_actor: dict[int, list[tuple[HcmPositionAssignment, HcmPosition]]] = defaultdict(list)
    for assignment, position in assignment_rows:
        by_actor[assignment.employee_id].append((assignment, position))

    scopes: dict[tuple[int, str | None], str] = {}
    for row in rows:
        actor_id = row.get("actor_id")
        if actor_id is None:
            continue
        matched = _matching_actor_position(by_actor.get(actor_id, []), row.get("actor_position"))
        if not matched:
            continue
        scope = _acknowledgment_scope_code(*matched)
        if scope:
            scopes[(actor_id, row.get("actor_position"))] = scope
    return scopes


def _apply_acknowledgment_stage_names(
    rows: list[dict],
    actor_scope_codes: dict[tuple[int, str | None], str],
) -> list[dict]:
    for row in rows:
        actor_id = row.get("actor_id")
        actor_scope_code = (
            actor_scope_codes.get((actor_id, row.get("actor_position")))
            if actor_id is not None else None
        )
        actor_scope_code = actor_scope_code or _scope_from_text(
            row.get("actor_position"),
            allow_prefix=True,
        )
        row["stage_name"] = _acknowledgment_stage_name(
            row.get("stage_name"),
            row.get("action"),
            actor_scope_code,
        )
        row.pop("actor_id", None)
        row.pop("actor_position", None)
    return rows


def _action_for_holders(actions: list[Action], holder_ids: set[int]) -> Action | None:
    for action in actions:
        if action.actor_id in holder_ids and action.action in {
            ApprovalAction.APPROVED.value,
            ApprovalAction.REJECTED.value,
        }:
            return action
    return None


def _final_any_one_actions(
    actions: list[Action],
    holder_ids: set[int],
) -> tuple[Action | None, Action | None]:
    decisions = [
        action for action in actions
        if action.actor_id in holder_ids
        and action.action in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}
    ]
    if not decisions:
        return None, None
    successful = [
        action for action in decisions
        if action.action == ApprovalAction.APPROVED.value
    ]
    return (successful[-1] if successful else None), decisions[-1]


async def _workflow_rows(db: AsyncSession, indent_id: int) -> tuple[Instance | None, list[Action], list[Pending]]:
    instance = (await db.execute(
        select(Instance)
        .options(load_only(
            Instance.id, Instance.status, Instance.resolved_chain,
            Instance.current_sequence, Instance.current_stage_name,
        ))
        .where(Instance.doc_type == DocType.INDENT.value, Instance.doc_id == indent_id)
        .order_by(Instance.id.desc())
    )).scalars().first()
    if instance is None:
        return None, [], []
    actions = list((await db.execute(
        select(Action)
        .options(load_only(
            Action.id, Action.stage_sequence, Action.actor_id, Action.actor_name,
            Action.actor_position, Action.action, Action.stage_name,
            Action.comments, Action.acted_at,
        ))
        .where(Action.instance_id == instance.id)
        .order_by(Action.acted_at.asc(), Action.id.asc())
    )).scalars().all())
    pending = list((await db.execute(
        select(Pending)
        .options(load_only(
            Pending.id, Pending.approver_id, Pending.stage_sequence, Pending.created_at,
        ))
        .where(Pending.instance_id == instance.id)
        .order_by(Pending.created_at.asc(), Pending.id.asc())
    )).scalars().all())
    return instance, actions, pending


def _submitted_action(actions: list[Action]) -> Action | None:
    return next((a for a in actions if a.action == ApprovalAction.SUBMITTED.value), None)


def _journey_history(
    indent: Indent,
    actions: list[Action],
    audits: list[AuditLog],
    operational_events: list[dict] | None = None,
    resolved_chain: list[dict] | None = None,
) -> list[dict]:
    events: list[dict] = []
    seen_ids: set[str] = set()

    def add(event: dict) -> None:
        timestamp = event.get("timestamp")
        if timestamp is None:
            return
        timestamp = _utc_datetime(timestamp)
        event["timestamp"] = timestamp
        event_id = event["id"]
        if event_id in seen_ids:
            return
        seen_ids.add(event_id)
        events.append(event)

    chain_by_sequence = {
        int(link.get("sequence", index + 1)): link
        for index, link in enumerate(resolved_chain or [])
        if isinstance(link, dict)
    }

    add({
        "id": f"indent:{indent.id}:created",
        "event_type": "CREATED",
        "title": "Draft created",
        "description": f"{indent.indent_no} created",
        "actor_name": indent.requested_by_name,
        "position_name": indent.position_name,
        "timestamp": indent.created_at,
        "comments": indent.remarks,
        "stage_type": "draft",
        "approval_mode": None,
        "_sort_order": 10,
    })
    for action in actions:
        link = chain_by_sequence.get(int(getattr(action, "stage_sequence", 0)))
        if action.action == ApprovalAction.SUBMITTED.value:
            title = "Request submitted"
            event_type = "SUBMITTED"
        elif action.action == ApprovalAction.APPROVED.value:
            title = _occurred_action_title(action, link, "Request")
            event_type = "APPROVED"
        elif action.action == ApprovalAction.REJECTED.value:
            title = "Request rejected"
            event_type = "REJECTED"
        elif action.action == ApprovalAction.RETURNED.value:
            title = "Request returned"
            event_type = "RETURNED"
        else:
            continue
        add({
            "id": f"workflow:{action.id}",
            "event_type": event_type,
            "title": title,
            "description": (
                f"{event_type.title()} by {action.actor_name}"
                if action.actor_name else title
            ),
            "actor_name": action.actor_name,
            "position_name": action.actor_position,
            "timestamp": action.acted_at,
            "comments": action.comments,
            "workflow_sequence": getattr(action, "stage_sequence", None),
            "stage_type": "submission" if event_type == "SUBMITTED" else "approval",
            "approval_mode": (link or {}).get("approval_mode"),
            "_sort_order": 20 if event_type == "SUBMITTED" else 30,
        })
    for audit in audits:
        changed = audit.changed_fields if isinstance(audit.changed_fields, dict) else {}
        status_change = changed.get("status")
        new_status = status_change.get("to") if isinstance(status_change, dict) else None
        if new_status == IndentStatus.AWAITING_ALLOCATION.value:
            add({
                "id": f"ready-for-allocation:{audit.id}",
                "event_type": "READY_FOR_ALLOCATION",
                "title": "Ready for allocation",
                "description": f"{indent.indent_no} sent to inventory",
                "actor_name": audit.actor_name,
                "position_name": None,
                "timestamp": audit.created_at,
                "comments": None,
                "reference_no": None,
                "quantity_summary": None,
                "stage_type": "allocation",
                "approval_mode": None,
                "_sort_order": 40,
            })
    for event in operational_events or []:
        add(dict(event))

    # Ascending order makes this a journey rather than an activity feed.  The source
    # identifier is a stable tie-breaker for actions recorded in the same DB tick.
    ordered = sorted(
        events,
        key=lambda row: (row["timestamp"], row.get("_sort_order", 50), row["id"]),
    )
    for event in ordered:
        event.pop("_sort_order", None)
    return ordered


def _workflow_stage_sequence(row) -> int:
    stage_sequence = getattr(row, "stage_sequence", None)
    if stage_sequence is None:
        raise ValidationError("Workflow stage_sequence is required to build indent journey")
    return int(stage_sequence)


def _is_final_stage_name(name: str | None) -> bool:
    return "FINAL" in _normalised_scope_text(name)


def _stage_status_from_action(action: Action) -> str:
    if action.action == ApprovalAction.APPROVED.value:
        return "APPROVED"
    if action.action == ApprovalAction.REJECTED.value:
        return "REJECTED"
    if action.action == ApprovalAction.RETURNED.value:
        return "RETURNED"
    return action.action


def _display_action_for_stage(actions: list[Action]) -> Action:
    approved = [action for action in actions if action.action == ApprovalAction.APPROVED.value]
    return approved[-1] if approved and _is_final_stage_name(approved[-1].stage_name) else actions[-1]


def _latest_action_for_stage(
    actions: list[Action],
    action_value: str,
) -> Action | None:
    return next((row for row in reversed(actions) if row.action == action_value), None)


def _terminal_or_active_stage_action(
    actions: list[Action],
    indent_status: str,
) -> Action | None:
    if indent_status == IndentStatus.REJECTED.value:
        return _latest_action_for_stage(actions, ApprovalAction.REJECTED.value)
    if indent_status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        return _latest_action_for_stage(actions, ApprovalAction.RETURNED.value)
    return None


def _positions_for_approvers(positions: list[dict], approver_ids: set[int]) -> list[dict]:
    if not approver_ids:
        return []
    return [
        position for position in positions
        if {holder.id for holder in position["holders"]} & approver_ids
    ]


def _fallback_stage_title(positions: list[dict], *, final: bool) -> str:
    labels = [_position_label(position["name"]) for position in positions]
    if final:
        return "Final Approval" + (f" - {' or '.join(labels)}" if labels else "")
    if labels:
        return f"{labels[0]} Review"
    return "Approval"


def _resolved_stage_title(link: dict, action: Action | None, *, final: bool) -> str:
    """Format a frozen workflow rung without inventing a role not present in it."""
    action_title = action.stage_name if action and action.stage_name else None
    source_title = action_title or link.get("role_name") or link.get("position_name")
    if not source_title:
        return "Final Approval" if final else "Approval"
    normalized = _normalised_scope_text(source_title)
    if final:
        if "FINAL" in normalized:
            return source_title
        return f"Final Approval - {_position_label(source_title)}"
    if "REVIEW" in normalized or "APPROVAL" in normalized:
        return source_title
    return f"{_position_label(source_title)} Review"


def _waiting_for_stage(title: str) -> str:
    display_title = (
        f"{title[:-len(' Review')]} review"
        if title.endswith(" Review") else title
    )
    return f"Waiting for {display_title}"


def _resolved_approver_names(link: dict) -> str | None:
    names = link.get("approver_names")
    if not isinstance(names, list):
        return None
    return ", ".join(str(name) for name in names if name) or None


def _split_reporting_ladder(positions: list[dict]) -> tuple[list[dict], list[dict]]:
    if not positions:
        return [], []
    if len(positions) == 1:
        return ([], positions) if positions[0].get("is_top") else (positions, [])
    if positions[-1].get("is_top"):
        return positions[:-2], positions[-2:]
    return positions, []


def _holder_ids(positions: list[dict]) -> set[int]:
    return {holder.id for position in positions for holder in position["holders"]}


def _holder_names_for_ids(positions: list[dict], holder_ids: set[int]) -> str | None:
    names = [
        holder.full_name
        for position in positions
        for holder in position["holders"]
        if holder.id in holder_ids
    ]
    return ", ".join(name for name in names if name) or None


def _quantity_text(moved: Decimal, total: Decimal) -> str:
    return f"{float(moved):g} of {float(total):g}"


def _occurred_action_title(action: Action, link: dict | None, domain: str) -> str:
    """Name an occurred workflow action from its frozen/action snapshots."""
    action_label = action.stage_name
    frozen_label = (link or {}).get("role_name") or (link or {}).get("position_name")
    if action_label and _normalised_scope_text(action_label) in {
        "APPROVAL", "REPORTING MANAGER", f"{domain.upper()} APPROVAL",
    }:
        action_label = None
    label = (
        action_label
        or frozen_label
        or f"{domain} approval"
    )
    if action.action == ApprovalAction.APPROVED.value:
        generic_labels = {
            "approval", domain.lower(), f"{domain.lower()} approval",
        }
        if str(label).strip().lower() in generic_labels:
            return (
                "Approval completed"
                if domain == "Request" else f"{domain} approval completed"
            )
        return label if str(label).lower().endswith("approved") else f"{label} approved"
    if action.action == ApprovalAction.REJECTED.value:
        return f"{domain} rejected"
    if action.action == ApprovalAction.RETURNED.value:
        return f"{domain} returned"
    return f"{domain} submitted"


async def _resolve_journey_document_graph(
    db: AsyncSession,
    indent: Indent,
) -> _JourneyDocumentGraph:
    """Resolve downstream documents through every persisted linkage available.

    Header links are useful but not universal in legacy data, so line links and
    fulfilment/source references are resolved in batches as equal evidence.  The
    returned frozen sets make duplicate paths harmless and keep later queries stable.
    """
    from app.modules.warehouse.models import (
        Dispatch, DispatchItem, MaterialIssue, MaterialIssueLine, Picking,
    )

    indent_items = tuple((await db.execute(
        select(IndentItem)
        .where(IndentItem.indent_id == indent.id)
        .order_by(IndentItem.id.asc())
    )).scalars().all())
    indent_item_ids = {row.id for row in indent_items}

    allocation_rows = (await db.execute(
        select(Allocation.id, Allocation.allocation_no)
        .outerjoin(AllocationItem, AllocationItem.allocation_id == Allocation.id)
        .where(or_(
            Allocation.indent_id == indent.id,
            AllocationItem.indent_item_id.in_(indent_item_ids),
        ))
        .distinct()
        .order_by(Allocation.id.asc())
    )).all()
    allocation_ids = {int(row.id) for row in allocation_rows}
    allocation_nos = {row.allocation_no for row in allocation_rows if row.allocation_no}

    mr_rows = (await db.execute(
        select(MaterialRequest.id, MaterialRequest.mr_no)
        .outerjoin(
            MaterialRequestItem,
            MaterialRequestItem.mr_id == MaterialRequest.id,
        )
        .where(or_(
            MaterialRequest.indent_id == indent.id,
            MaterialRequestItem.indent_item_id.in_(indent_item_ids),
        ))
        .distinct()
        .order_by(MaterialRequest.id.asc())
    )).all()
    material_request_ids = {int(row.id) for row in mr_rows}
    material_request_nos = {row.mr_no for row in mr_rows if row.mr_no}

    picking_conditions = [
        and_(Picking.ref_type == "INDENT", Picking.ref_id == indent.id),
        Picking.ref_no == indent.indent_no,
    ]
    if allocation_ids:
        picking_conditions.append(and_(
            func.upper(Picking.ref_type).in_(("ALLOCATION", "ALLOC")),
            Picking.ref_id.in_(allocation_ids),
        ))
    if material_request_ids:
        picking_conditions.append(and_(
            func.upper(Picking.ref_type).in_(("MATERIAL_REQUEST", "MR")),
            Picking.ref_id.in_(material_request_ids),
        ))
    source_nos = allocation_nos | material_request_nos
    if source_nos:
        picking_conditions.append(Picking.ref_no.in_(source_nos))
    picking_ids = set((await db.execute(
        select(Picking.id)
        .where(or_(*picking_conditions))
        .distinct()
        .order_by(Picking.id.asc())
    )).scalars().all())

    issue_conditions = [
        MaterialIssue.indent_id == indent.id,
        MaterialIssueLine.indent_item_id.in_(indent_item_ids),
    ]
    if picking_ids:
        issue_conditions.append(MaterialIssue.picking_id.in_(picking_ids))
    issue_rows = (await db.execute(
        select(MaterialIssue.id, MaterialIssue.issue_no)
        .outerjoin(
            MaterialIssueLine,
            MaterialIssueLine.issue_id == MaterialIssue.id,
        )
        .where(or_(*issue_conditions))
        .distinct()
        .order_by(MaterialIssue.id.asc())
    )).all()
    material_issue_ids = {int(row.id) for row in issue_rows}
    issue_nos = {row.issue_no for row in issue_rows if row.issue_no}

    dispatch_conditions = [DispatchItem.indent_id == indent.id]
    if material_issue_ids:
        dispatch_conditions.append(and_(
            func.upper(Dispatch.ref_type).in_(("ISSUE", "WH_ISSUE")),
            Dispatch.ref_id.in_(material_issue_ids),
        ))
    if issue_nos:
        dispatch_conditions.append(Dispatch.ref_no.in_(issue_nos))
    dispatch_ids = set((await db.execute(
        select(Dispatch.id)
        .outerjoin(DispatchItem, DispatchItem.dispatch_id == Dispatch.id)
        .where(or_(*dispatch_conditions))
        .distinct()
        .order_by(Dispatch.id.asc())
    )).scalars().all())

    return _JourneyDocumentGraph(
        indent_items=indent_items,
        allocation_ids=frozenset(allocation_ids),
        material_request_ids=frozenset(material_request_ids),
        picking_ids=frozenset(int(row) for row in picking_ids),
        material_issue_ids=frozenset(material_issue_ids),
        dispatch_ids=frozenset(int(row) for row in dispatch_ids),
    )


async def _related_workflow_events(
    db: AsyncSession,
    *,
    doc_type: str | None = None,
    doc_ids: list[int],
    domain: str,
    stage_type: str,
    include_submission: bool,
    sort_order: int,
    references: dict[int, str] | None = None,
) -> tuple[list[dict], set[int]]:
    """Return only timestamped actions for related frozen workflow instances."""
    if not doc_ids:
        return [], set()
    exact_document_conditions = [
        and_(Instance.doc_id == doc_id, Instance.doc_no == reference_no)
        for doc_id, reference_no in (references or {}).items()
        if doc_id in doc_ids and reference_no
    ]
    instance_conditions = list(exact_document_conditions)
    if doc_type:
        legacy_type_condition = and_(
            Instance.doc_type == doc_type,
            Instance.doc_id.in_(doc_ids),
        )
        if exact_document_conditions:
            legacy_type_condition = and_(
                legacy_type_condition,
                Instance.doc_no.is_(None),
            )
        instance_conditions.append(legacy_type_condition)
    if not instance_conditions:
        return [], set()
    instances = list((await db.execute(
        select(Instance)
        .options(load_only(
            Instance.id, Instance.doc_type, Instance.doc_id, Instance.doc_no,
            Instance.resolved_chain,
        ))
        .where(or_(*instance_conditions))
        .order_by(Instance.id.asc())
    )).scalars().all())
    if not instances:
        return [], set()

    by_instance = {row.id: row for row in instances}
    submitted_doc_ids: set[int] = set()
    events: list[dict] = []
    actions = list((await db.execute(
        select(Action)
        .options(load_only(
            Action.id, Action.instance_id, Action.stage_sequence,
            Action.stage_name, Action.actor_name, Action.actor_position,
            Action.action, Action.comments, Action.acted_at,
        ))
        .where(Action.instance_id.in_(list(by_instance)))
        .order_by(Action.acted_at.asc(), Action.id.asc())
    )).scalars().all())
    for action in actions:
        instance = by_instance[action.instance_id]
        if action.action == ApprovalAction.SUBMITTED.value:
            submitted_doc_ids.add(instance.doc_id)
            if not include_submission:
                continue
        elif action.action not in {
            ApprovalAction.APPROVED.value,
            ApprovalAction.REJECTED.value,
            ApprovalAction.RETURNED.value,
        }:
            continue

        chain = [
            link for link in (instance.resolved_chain or [])
            if isinstance(link, dict)
        ]
        link = next((
            row for index, row in enumerate(chain)
            if int(row.get("sequence", index + 1)) == action.stage_sequence
        ), None)
        event_type = {
            ApprovalAction.SUBMITTED.value: f"{stage_type.upper()}_SUBMITTED",
            ApprovalAction.APPROVED.value: f"{stage_type.upper()}_APPROVED",
            ApprovalAction.REJECTED.value: f"{stage_type.upper()}_REJECTED",
            ApprovalAction.RETURNED.value: f"{stage_type.upper()}_RETURNED",
        }[action.action]
        events.append({
            "id": f"workflow:{action.instance_id}:{action.id}",
            "event_type": event_type,
            "title": _occurred_action_title(action, link, domain),
            "description": f"{domain} workflow action recorded",
            "actor_name": action.actor_name,
            "position_name": action.actor_position or (link or {}).get("position_name"),
            "timestamp": action.acted_at,
            "comments": action.comments,
            "reference_no": (references or {}).get(instance.doc_id),
            "quantity_summary": None,
            "stage_type": stage_type,
            "approval_mode": (link or {}).get("approval_mode"),
            "_sort_order": sort_order,
        })
    return events, submitted_doc_ids


def _receipt_audit_events(
    indent: Indent,
    audits: list[AuditLog],
    required_total: Decimal = Decimal("0"),
    target_item_ids: set[int] | frozenset[int] | None = None,
) -> list[dict]:
    """Recover every requester acknowledgement from the immutable indent audit rows."""
    events: list[dict] = []
    for audit in audits:
        changed = audit.changed_fields if isinstance(audit.changed_fields, dict) else {}
        received = Decimal("0")
        for field, change in changed.items():
            if not str(field).isdigit() or not isinstance(change, dict):
                continue
            if target_item_ids is not None and int(field) not in target_item_ids:
                continue
            before = _d(change.get("from"))
            after = _d(change.get("to"))
            if after > before:
                received += after - before
        if received <= 0:
            continue
        status_change = changed.get("status")
        new_status = status_change.get("to") if isinstance(status_change, dict) else None
        fully_received = new_status == IndentStatus.CLOSED.value
        shared = {
            "description": f"{float(received):g} units confirmed received",
            "actor_name": audit.actor_name,
            "position_name": None,
            "timestamp": audit.created_at,
            "comments": None,
            "reference_no": None,
            "quantity_summary": (
                _quantity_text(received, required_total)
                if required_total > 0 else f"{float(received):g} received"
            ),
            "stage_type": "acknowledgement",
            "approval_mode": None,
        }
        events.append({
            "id": f"acknowledgement:{audit.id}",
            "event_type": "ACKNOWLEDGEMENT_SUBMITTED",
            "title": "Acknowledgement submitted",
            **shared,
            "_sort_order": 100,
        })
        events.append({
            "id": f"receipt:{audit.id}",
            "event_type": "FULLY_RECEIVED" if fully_received else "PARTIALLY_RECEIVED",
            "title": "Fully received" if fully_received else "Partially received",
            **shared,
            "_sort_order": 110,
        })
    return events


def _closed_transition_audit(audits: list[AuditLog]) -> AuditLog | None:
    """Return the latest exact audit transition that put the indent in CLOSED."""
    matches = []
    for audit in audits:
        changed = audit.changed_fields if isinstance(audit.changed_fields, dict) else {}
        status_change = changed.get("status")
        if (
            isinstance(status_change, dict)
            and status_change.get("to") == IndentStatus.CLOSED.value
        ):
            matches.append(audit)
    return matches[-1] if matches else None


async def _journey_operational_evidence(
    db: AsyncSession,
    indent: Indent,
    audits: list[AuditLog],
) -> dict:
    """Aggregate genuine downstream records without treating lifecycle status as proof.

    Imports stay local because Indents does not own the Inventory/Warehouse models.  The
    Journey endpoint has already applied the normal indent visibility predicate before
    this function runs, so these joins cannot broaden access to another indent.
    """
    from app.modules.warehouse.enums import DispatchStatus, IssueDirection
    from app.modules.warehouse.models import Dispatch, MaterialIssue

    graph = await _resolve_journey_document_graph(db, indent)
    target_item_ids = {row.id for row in graph.indent_items}
    target_line_by_item_id = {row.item_id: row.id for row in graph.indent_items}
    required_by_line = {
        row.id: (_d(row.approved_quantity) or _d(row.quantity))
        for row in graph.indent_items
    }
    received_by_line = {
        row.id: _d(row.received_quantity) for row in graph.indent_items
    }

    allocations = list((await db.execute(
        select(Allocation)
        .options(selectinload(Allocation.items))
        .where(Allocation.id.in_(graph.allocation_ids))
        .order_by(Allocation.created_at.asc(), Allocation.id.asc())
    )).scalars().all())
    allocations_found = [
        row for row in allocations
        if row.status == AllocationStatus.APPROVED.value and row.approved_at is not None
    ]
    material_requests = list((await db.execute(
        select(MaterialRequest)
        .options(selectinload(MaterialRequest.items))
        .where(
            MaterialRequest.id.in_(graph.material_request_ids),
            MaterialRequest.status.notin_((
                MRStatus.REJECTED.value, MRStatus.CANCELLED.value,
            )),
        )
        .order_by(MaterialRequest.created_at.asc(), MaterialRequest.id.asc())
    )).scalars().all())
    all_issues = list((await db.execute(
        select(MaterialIssue)
        .options(selectinload(MaterialIssue.items))
        .where(
            MaterialIssue.id.in_(graph.material_issue_ids),
            MaterialIssue.direction == IssueDirection.OUT.value,
        )
        .order_by(MaterialIssue.created_at.asc(), MaterialIssue.id.asc())
    )).scalars().all())
    issues = [
        row for row in all_issues
        if row.is_stock_posted and row.posted_at is not None
    ]

    dispatches = list((await db.execute(
        select(Dispatch)
        .options(selectinload(Dispatch.items))
        .where(Dispatch.id.in_(graph.dispatch_ids))
        .order_by(Dispatch.created_at.asc(), Dispatch.id.asc())
    )).scalars().all())

    approved_total = sum(required_by_line.values(), Decimal("0"))
    received_total = sum(received_by_line.values(), Decimal("0"))

    events: list[dict] = []
    stages: list[dict] = []
    missing_sources: list[str] = []

    allocation_workflow_events, submitted_allocation_ids = await _related_workflow_events(
        db,
        doc_ids=[row.id for row in allocations],
        domain="Allocation",
        stage_type="allocation_approval",
        include_submission=True,
        sort_order=45,
        references={row.id: row.allocation_no for row in allocations},
    )
    events.extend(allocation_workflow_events)
    for row in allocations:
        if row.id in submitted_allocation_ids:
            continue
        events.append({
            "id": f"allocation-created:{row.id}",
            "event_type": "ALLOCATION_CREATED",
            "title": "Allocation created",
            "description": "Allocation document recorded",
            "actor_name": row.allocated_by_name,
            "position_name": None,
            "timestamp": row.created_at,
            "comments": row.remarks,
            "reference_no": row.allocation_no,
            "quantity_summary": None,
            "stage_type": "allocation",
            "approval_mode": None,
            "_sort_order": 40,
        })

    warehouse_workflow_events, _ = await _related_workflow_events(
        db,
        doc_ids=[row.id for row in all_issues],
        domain="Warehouse",
        stage_type="warehouse_approval",
        include_submission=False,
        sort_order=55,
        references={row.id: row.issue_no for row in all_issues},
    )
    events.extend(warehouse_workflow_events)
    for row in all_issues:
        events.append({
            "id": f"material-issue-created:{row.id}",
            "event_type": "MATERIAL_ISSUE_CREATED",
            "title": "Material issue created",
            "description": "Warehouse material issue recorded",
            "actor_name": row.created_by_name,
            "position_name": None,
            "timestamp": row.created_at,
            "comments": row.remarks,
            "reference_no": row.issue_no,
            "quantity_summary": None,
            "stage_type": "warehouse",
            "approval_mode": None,
            "_sort_order": 50,
        })

    dispatch_workflow_events, _ = await _related_workflow_events(
        db,
        doc_ids=[row.id for row in dispatches],
        domain="Dispatch",
        stage_type="dispatch_approval",
        include_submission=False,
        sort_order=65,
        references={row.id: row.dispatch_no for row in dispatches},
    )
    events.extend(dispatch_workflow_events)
    for row in dispatches:
        events.append({
            "id": f"dispatch-created:{row.id}",
            "event_type": "DISPATCH_CREATED",
            "title": "Dispatch created",
            "description": "Dispatch document recorded",
            "actor_name": row.created_by_name,
            "position_name": None,
            "timestamp": row.created_at,
            "comments": row.remarks,
            "reference_no": row.dispatch_no,
            "quantity_summary": None,
            "stage_type": "delivery",
            "approval_mode": None,
            "_sort_order": 60,
        })

    def stage(
        title: str,
        status: str,
        stage_type: str,
        *,
        current: bool = False,
        actor: str | None = None,
        timestamp: datetime | None = None,
        comments: str | None = None,
        reference: str | None = None,
        quantity: str | None = None,
        source: str,
    ) -> None:
        stages.append({
            "title": title,
            "status": status,
            "is_current": current,
            "approver_name": actor,
            "position_name": None,
            "timestamp": _utc_datetime(timestamp),
            "comments": comments,
            "duration_seconds": None,
            "stage_type": stage_type,
            "approval_mode": None,
            "reference_no": reference,
            "quantity_summary": quantity,
            "evidence_source": source,
        })

    def lines_complete(actual_by_line: dict[int, Decimal]) -> bool:
        return bool(required_by_line) and all(
            actual_by_line.get(line_id, Decimal("0")) >= required
            for line_id, required in required_by_line.items()
        )

    allocation_by_line: dict[int, Decimal] = defaultdict(Decimal)
    allocation_completed_by = None
    for row in sorted(
        allocations_found,
        key=lambda value: (value.approved_at or value.created_at, value.id),
    ):
        for item in row.items:
            if item.indent_item_id in target_item_ids:
                allocation_by_line[item.indent_item_id] += _d(item.quantity)
        if allocation_completed_by is None and lines_complete(allocation_by_line):
            allocation_completed_by = row
    allocated_total = sum(allocation_by_line.values(), Decimal("0"))
    allocation_complete = lines_complete(allocation_by_line)
    if allocations_found:
        latest = allocations_found[-1]
        stage(
            "Stock allocated",
            "COMPLETED",
            "allocation",
            actor=latest.allocated_by_name,
            timestamp=latest.approved_at,
            comments=latest.remarks,
            reference=", ".join(row.allocation_no for row in allocations_found),
            quantity=_quantity_text(allocated_total, approved_total),
            source="inv_allocations.status=APPROVED",
        )
        for row in allocations_found:
            quantity = sum((
                _d(item.quantity) for item in row.items
                if item.indent_item_id in target_item_ids
            ), Decimal("0"))
            if row.approved_at is None:
                continue
            events.append({
                "id": f"allocation:{row.id}",
                "event_type": "STOCK_ALLOCATED",
                "title": "Stock allocated",
                "description": f"{float(quantity):g} units allocated",
                "actor_name": row.allocated_by_name,
                "position_name": None,
                "timestamp": row.approved_at,
                "comments": row.remarks,
                "reference_no": row.allocation_no,
                "quantity_summary": _quantity_text(quantity, approved_total),
                "stage_type": "allocation",
                "approval_mode": None,
                "_sort_order": 50,
            })
        if allocation_completed_by and allocation_completed_by.approved_at is not None:
            events.append({
                "id": f"allocation-completed:{allocation_completed_by.id}",
                "event_type": "ALLOCATION_COMPLETED",
                "title": "Allocation completed",
                "description": "Required quantity fully allocated",
                "actor_name": allocation_completed_by.allocated_by_name,
                "position_name": None,
                "timestamp": allocation_completed_by.approved_at,
                "comments": None,
                "reference_no": allocation_completed_by.allocation_no,
                "quantity_summary": _quantity_text(allocated_total, approved_total),
                "stage_type": "allocation",
                "approval_mode": None,
                "_sort_order": 51,
            })

    def issue_target_line(row: MaterialIssue, item) -> int | None:
        if item.indent_item_id in target_item_ids:
            return int(item.indent_item_id)
        if item.indent_item_id is None and row.indent_id == indent.id:
            return target_line_by_item_id.get(item.item_id)
        return None

    issued_by_line: dict[int, Decimal] = defaultdict(Decimal)
    issue_completed_by = None
    for row in sorted(
        issues,
        key=lambda value: (value.posted_at or value.created_at, value.id),
    ):
        for item in row.items:
            line_id = issue_target_line(row, item)
            if line_id is not None:
                issued_by_line[line_id] += _d(item.issued_qty) - _d(item.returned_qty)
        if issue_completed_by is None and lines_complete(issued_by_line):
            issue_completed_by = row
    issued_total = sum(issued_by_line.values(), Decimal("0"))
    issue_complete = lines_complete(issued_by_line)
    if issues:
        latest = issues[-1]
        stage(
            "Issued from warehouse",
            "COMPLETED",
            "warehouse",
            actor=latest.issued_by_name,
            timestamp=latest.posted_at,
            comments=latest.remarks,
            reference=", ".join(row.issue_no for row in issues),
            quantity=_quantity_text(issued_total, approved_total),
            source="out_issues.is_stock_posted=true",
        )
        for row in issues:
            quantity = sum(
                (
                    _d(item.issued_qty) - _d(item.returned_qty)
                    for item in row.items
                    if issue_target_line(row, item) is not None
                ),
                Decimal("0"),
            )
            if row.posted_at is None:
                continue
            events.append({
                "id": f"warehouse-issue:{row.id}",
                "event_type": "WAREHOUSE_ISSUED",
                "title": "Issued from warehouse",
                "description": f"{float(quantity):g} units issued",
                "actor_name": row.issued_by_name,
                "position_name": None,
                "timestamp": row.posted_at,
                "comments": row.remarks,
                "reference_no": row.issue_no,
                "quantity_summary": _quantity_text(quantity, approved_total),
                "stage_type": "warehouse",
                "approval_mode": None,
                "_sort_order": 60,
            })
            if row.acknowledged_at is not None:
                events.append({
                    "id": f"issue-acknowledgement:{row.id}",
                    "event_type": "ACKNOWLEDGEMENT_SUBMITTED",
                    "title": "Acknowledgement submitted",
                    "description": "Recipient acknowledged the warehouse issue",
                    "actor_name": row.acknowledged_by_name,
                    "position_name": None,
                    "timestamp": row.acknowledged_at,
                    "comments": row.remarks,
                    "reference_no": row.issue_no,
                    "quantity_summary": _quantity_text(quantity, approved_total),
                    "stage_type": "acknowledgement",
                    "approval_mode": None,
                    "_sort_order": 90,
                })
        if issue_completed_by and issue_completed_by.posted_at is not None:
            events.append({
                "id": f"warehouse-issue-completed:{issue_completed_by.id}",
                "event_type": "WAREHOUSE_ISSUE_COMPLETED",
                "title": "Warehouse issue completed",
                "description": "Required quantity fully issued",
                "actor_name": issue_completed_by.issued_by_name,
                "position_name": None,
                "timestamp": issue_completed_by.posted_at,
                "comments": None,
                "reference_no": issue_completed_by.issue_no,
                "quantity_summary": _quantity_text(issued_total, approved_total),
                "stage_type": "warehouse",
                "approval_mode": None,
                "_sort_order": 61,
            })

    active_dispatch_statuses = {
        DispatchStatus.DISPATCHED.value,
        DispatchStatus.IN_TRANSIT.value,
        DispatchStatus.DELIVERED.value,
        DispatchStatus.ACKNOWLEDGED.value,
    }
    dispatched = [
        row for row in dispatches
        if row.status in active_dispatch_statuses and row.gate_out_at is not None
    ]
    issues_by_id = {row.id: row for row in all_issues}

    def dispatch_target_line(row: Dispatch, item) -> int | None:
        if item.indent_id == indent.id:
            return target_line_by_item_id.get(item.item_id)
        if item.indent_id is not None:
            return None
        if str(row.ref_type or "").upper() not in {"ISSUE", "WH_ISSUE"}:
            return None
        source_issue = issues_by_id.get(row.ref_id)
        if source_issue is None:
            return None
        matching_target_lines = {
            issue_target_line(source_issue, source_item)
            for source_item in source_issue.items
            if source_item.item_id == item.item_id
            and issue_target_line(source_issue, source_item) is not None
        }
        contains_other_indent = any(
            source_item.item_id == item.item_id
            and source_item.indent_item_id is not None
            and source_item.indent_item_id not in target_item_ids
            for source_item in source_issue.items
        )
        if contains_other_indent or len(matching_target_lines) != 1:
            return None
        return matching_target_lines.pop()

    dispatched_by_line: dict[int, Decimal] = defaultdict(Decimal)
    for row in dispatched:
        for item in row.items:
            line_id = dispatch_target_line(row, item)
            if line_id is not None:
                dispatched_by_line[line_id] += _d(item.quantity)
    dispatched_total = sum(dispatched_by_line.values(), Decimal("0"))
    if dispatched:
        latest = dispatched[-1]
        stage(
            "Dispatched",
            "COMPLETED",
            "delivery",
            actor=latest.security_by_name or latest.created_by_name,
            timestamp=latest.gate_out_at,
            comments=latest.remarks,
            reference=", ".join(row.dispatch_no for row in dispatched),
            quantity=_quantity_text(dispatched_total, approved_total),
            source="out_dispatches.gate_out_at",
        )
        for row in dispatched:
            quantity = sum((
                _d(item.quantity) for item in row.items
                if dispatch_target_line(row, item) is not None
            ), Decimal("0"))
            events.append({
                "id": f"dispatch:{row.id}",
                "event_type": "DISPATCHED",
                "title": "Dispatched",
                "description": "Goods left the warehouse",
                "actor_name": row.security_by_name or row.created_by_name,
                "position_name": None,
                "timestamp": row.gate_out_at,
                "comments": row.remarks,
                "reference_no": row.dispatch_no,
                "quantity_summary": _quantity_text(quantity, approved_total),
                "stage_type": "delivery",
                "approval_mode": None,
                "_sort_order": 70,
            })

    delivered = [row for row in dispatches if row.delivered_at is not None]
    delivered_by_line: dict[int, Decimal] = defaultdict(Decimal)
    for row in delivered:
        for item in row.items:
            line_id = dispatch_target_line(row, item)
            if line_id is not None:
                delivered_by_line[line_id] += _d(item.delivered_qty)
    delivered_total = sum(delivered_by_line.values(), Decimal("0"))
    delivery_complete = lines_complete(delivered_by_line)
    if delivered:
        latest = delivered[-1]
        stage(
            "Delivered",
            "COMPLETED",
            "delivery",
            actor=latest.acknowledged_by_name,
            timestamp=latest.delivered_at,
            comments=latest.remarks,
            reference=", ".join(row.dispatch_no for row in delivered),
            quantity=_quantity_text(delivered_total, approved_total),
            source="out_dispatches.delivered_at",
        )
        for row in delivered:
            quantity = sum((
                _d(item.delivered_qty) for item in row.items
                if dispatch_target_line(row, item) is not None
            ), Decimal("0"))
            events.append({
                "id": f"delivery:{row.id}",
                "event_type": "DELIVERED",
                "title": "Delivered",
                "description": "Delivery recorded",
                "actor_name": None,
                "position_name": None,
                "timestamp": row.delivered_at,
                "comments": row.remarks,
                "reference_no": row.dispatch_no,
                "quantity_summary": _quantity_text(quantity, approved_total),
                "stage_type": "delivery",
                "approval_mode": None,
                "_sort_order": 80,
            })
            if row.acknowledged_at is not None:
                events.append({
                    "id": f"delivery-acknowledgement:{row.id}",
                    "event_type": "ACKNOWLEDGEMENT_SUBMITTED",
                    "title": "Acknowledgement submitted",
                    "description": "Receiver acknowledged the dispatch",
                    "actor_name": row.acknowledged_by_name,
                    "position_name": None,
                    "timestamp": row.acknowledged_at,
                    "comments": row.remarks,
                    "reference_no": row.dispatch_no,
                    "quantity_summary": None,
                    "stage_type": "acknowledgement",
                    "approval_mode": None,
                    "_sort_order": 90,
                })

    receipt_events = _receipt_audit_events(
        indent, audits, approved_total, target_item_ids,
    )
    events.extend(receipt_events)
    fully_received = lines_complete(received_by_line)
    if received_total > 0:
        latest_receipt = receipt_events[-1] if receipt_events else None
        stage(
            "Fully received" if fully_received else "Partially received",
            "APPROVED" if fully_received else "PENDING",
            "acknowledgement",
            current=not fully_received,
            actor=latest_receipt.get("actor_name") if latest_receipt else None,
            timestamp=latest_receipt.get("timestamp") if latest_receipt else None,
            quantity=_quantity_text(received_total, approved_total),
            source="ind_indent_items.received_qty",
        )

    closed_audit = _closed_transition_audit(audits)
    has_genuine_closure = (
        indent.status == IndentStatus.CLOSED.value and closed_audit is not None
    )
    if has_genuine_closure:
        stage(
            "Completed",
            "APPROVED",
            "completion",
            actor=closed_audit.actor_name,
            timestamp=closed_audit.created_at,
            quantity=_quantity_text(received_total, approved_total),
            source=f"sys_audit_log.id={closed_audit.id} status.to=CLOSED",
        )
        events.append({
            "id": f"completion:audit:{closed_audit.id}",
            "event_type": "COMPLETED",
            "title": "Completed",
            "description": f"{indent.indent_no} closed",
            "actor_name": closed_audit.actor_name,
            "position_name": None,
            "timestamp": closed_audit.created_at,
            "comments": None,
            "reference_no": None,
            "quantity_summary": _quantity_text(received_total, approved_total),
            "stage_type": "completion",
            "approval_mode": None,
            "_sort_order": 120,
        })
    is_complete = has_genuine_closure
    if not allocations_found:
        missing_sources.append("inv_allocations.status=APPROVED and approved_at")
    elif not issues:
        missing_sources.append("out_issues.is_stock_posted=true and posted_at")
    elif not issue_complete:
        missing_sources.append("remaining posted out_issue_items.issued_qty")
    elif not dispatched:
        missing_sources.append("out_dispatches.gate_out_at")
    elif not delivered:
        missing_sources.append("out_dispatches.delivered_at")
    elif not delivery_complete:
        missing_sources.append("remaining out_dispatch_items.delivered_qty")
    elif received_total <= 0:
        missing_sources.append(
            "ind_indent_items.received_qty and acknowledgement audit"
        )
    elif not fully_received:
        missing_sources.append("remaining ind_indent_items.received_qty")
    elif indent.status == IndentStatus.CLOSED.value and closed_audit is None:
        missing_sources.append("sys_audit_log status.to=CLOSED")
    elif not is_complete:
        missing_sources.append("ind_indents.status=CLOSED audit transition")

    return {
        "stages": stages,
        "events": events,
        "missing_sources": missing_sources,
        "has_allocation": bool(allocations_found),
        "allocation_complete": allocation_complete,
        "has_material_request": bool(material_requests),
        "has_issue": bool(issues),
        "issue_complete": issue_complete,
        "has_dispatch": bool(dispatched),
        "has_delivery": bool(delivered),
        "delivery_complete": delivery_complete,
        "has_acknowledgement": (
            bool(receipt_events)
            or any(row.acknowledged_at is not None for row in dispatches)
            or (
                not dispatches
                and any(row.acknowledged_at is not None for row in issues)
            )
        ),
        "has_receipt": received_total > 0,
        "receipt_complete": fully_received,
        "is_complete": is_complete,
    }


async def indent_journey(db: AsyncSession, indent_id: int, user) -> dict:
    indent = await _get_indent_for_journey(db, indent_id, user)
    instance, actions, pending = await _workflow_rows(db, indent.id)
    resolved_chain = getattr(instance, "resolved_chain", None) if instance else None
    # A submitted document's actions/pending rows and resolved_chain are its historical
    # evidence.  Re-reading today's HCM ladder here used to rewrite old journeys when a
    # position was disabled, renamed, or moved.
    positions: list[dict] = []
    has_workflow_detail = bool(pending) or any(
        action.action != ApprovalAction.SUBMITTED.value for action in actions
    )
    if resolved_chain is None and instance is not None and has_workflow_detail:
        positions = await _approval_positions(db, indent.position_id)
    audits = list((await db.execute(
        select(AuditLog)
        .options(load_only(
            AuditLog.id, AuditLog.actor_name, AuditLog.changed_fields,
            AuditLog.created_at,
        ))
        .where(AuditLog.entity_type == "ind_indents", AuditLog.entity_id == indent.id)
        .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
    )).scalars().all())

    submitted = _submitted_action(actions)
    if submitted:
        _workflow_stage_sequence(submitted)
    stages: list[dict] = [{
        "sequence": 1,
        "title": "Draft created",
        "status": "APPROVED" if submitted else "PENDING",
        "approver_name": indent.requested_by_name,
        "position_name": indent.position_name,
        "timestamp": _utc_datetime(indent.created_at),
        "comments": indent.remarks,
        "duration_seconds": _duration_seconds(
            indent.created_at,
            indent.created_at,
        ),
        "stage_type": "draft",
        "is_current": indent.status == IndentStatus.DRAFT.value,
        "approval_mode": None,
        "reference_no": None,
        "quantity_summary": None,
        "evidence_source": "ind_indents.created_at",
    }, {
        "sequence": 2,
        "title": "Request submitted",
        "status": "SUBMITTED" if submitted else "PENDING",
        "approver_name": submitted.actor_name if submitted else None,
        "position_name": submitted.actor_position if submitted else None,
        "timestamp": _utc_datetime(submitted.acted_at) if submitted else None,
        "comments": submitted.comments if submitted else None,
        "duration_seconds": _duration_seconds(
            indent.created_at,
            submitted.acted_at if submitted else None,
        ),
        "stage_type": "submission",
        "is_current": False,
        "approval_mode": None,
        "reference_no": None,
        "quantity_summary": None,
        "evidence_source": "wf_actions.action=SUBMITTED" if submitted else None,
    }]

    previous_at = stages[1]["timestamp"] or stages[0]["timestamp"]
    current_stage = (
        "Draft — submit the indent to begin approval"
        if indent.status == IndentStatus.DRAFT.value else None
    )
    final_any_one_outcome = None
    has_final_stage = False

    stage_actions: dict[int, list[Action]] = defaultdict(list)
    for action in actions:
        stage_sequence = _workflow_stage_sequence(action)
        if action.action == ApprovalAction.SUBMITTED.value:
            continue
        if action.action in {
            ApprovalAction.APPROVED.value,
            ApprovalAction.REJECTED.value,
            ApprovalAction.RETURNED.value,
        }:
            stage_actions[stage_sequence].append(action)

    pending_by_sequence: dict[int, list[Pending]] = defaultdict(list)
    for row in pending:
        pending_by_sequence[_workflow_stage_sequence(row)].append(row)

    pending_approver_ids = {row.approver_id for rows in pending_by_sequence.values() for row in rows}
    if resolved_chain is not None:
        chain = sorted(
            (link for link in resolved_chain if isinstance(link, dict)),
            key=lambda link: int(link.get("sequence", 0)),
        )
        for index, link in enumerate(chain):
            workflow_sequence = int(link.get("sequence", index + 1))
            actions_for_sequence = stage_actions.get(workflow_sequence, [])
            pending_for_sequence = pending_by_sequence.get(workflow_sequence, [])
            is_final = index == len(chain) - 1
            explicit_status = str(link.get("status") or "").upper()
            terminal_or_active_action = _terminal_or_active_stage_action(
                actions_for_sequence,
                indent.status,
            )
            approved = _latest_action_for_stage(
                actions_for_sequence,
                ApprovalAction.APPROVED.value,
            )
            any_one_satisfied = (
                str(link.get("approval_mode") or "").upper() == "ANY_ONE"
                and approved is not None
            )
            if explicit_status in {"NOT_REQUIRED", "SKIPPED"}:
                status = "NOT_REQUIRED"
            elif any_one_satisfied:
                status = "APPROVED"
            elif pending_for_sequence:
                # Important for ALL/MAJORITY stages: one action is not completion while
                # the workflow still has materialized approvers for this same rung.
                # A prior RETURNED action is only history after correction resubmission.
                status = "PENDING"
            elif terminal_or_active_action:
                status = _stage_status_from_action(terminal_or_active_action)
            elif approved:
                status = "APPROVED"
            else:
                status = "PENDING"
            action = (
                approved
                if status == "APPROVED"
                else terminal_or_active_action
                if status in {"REJECTED", "RETURNED"}
                else approved
                if status == "PENDING" and approved
                else None
            )
            is_current = (
                status != "NOT_REQUIRED"
                and (
                    bool(pending_for_sequence)
                    or (
                        instance.status == InstanceStatus.IN_PROGRESS.value
                        and instance.current_sequence == workflow_sequence
                    )
                )
            )
            title = _resolved_stage_title(link, action, final=is_final)
            timestamp = _utc_datetime(action.acted_at) if action else None
            if current_stage is None and is_current:
                current_stage = (
                    "Waiting for final approval"
                    if is_final else _waiting_for_stage(title)
                )
            if is_final:
                has_final_stage = True
                if status == "APPROVED" and action:
                    final_any_one_outcome = f"Approved by {action.actor_name}"
            stages.append({
                "sequence": len(stages) + 1,
                "title": title,
                "status": status,
                "is_current": is_current,
                "approver_name": (
                    action.actor_name if action else _resolved_approver_names(link)
                ),
                "position_name": (
                    action.actor_position if action else link.get("position_name")
                ),
                "timestamp": timestamp,
                "comments": action.comments if action else None,
                "duration_seconds": _duration_seconds(previous_at, timestamp),
                "stage_type": "final" if is_final else "approval",
                "approval_mode": link.get("approval_mode"),
                "reference_no": None,
                "quantity_summary": None,
                "evidence_source": "wf_instances.resolved_chain",
            })
            if timestamp:
                previous_at = timestamp

        if not chain:
            self_actions = [
                action for action in stage_actions.get(0, [])
                if action.action in {
                    ApprovalAction.APPROVED.value,
                    ApprovalAction.REJECTED.value,
                    ApprovalAction.RETURNED.value,
                }
            ]
            if self_actions:
                action = self_actions[-1]
                timestamp = _utc_datetime(action.acted_at)
                status = _stage_status_from_action(action)
                has_final_stage = True
                if status == "APPROVED":
                    final_any_one_outcome = f"Approved by {action.actor_name}"
                stages.append({
                    "sequence": len(stages) + 1,
                    "title": action.stage_name or "Final Approval",
                    "status": status,
                    "is_current": False,
                    "approver_name": action.actor_name,
                    "position_name": action.actor_position,
                    "timestamp": timestamp,
                    "comments": action.comments,
                    "duration_seconds": _duration_seconds(previous_at, timestamp),
                    "stage_type": "final",
                    "approval_mode": None,
                    "reference_no": None,
                    "quantity_summary": None,
                    "evidence_source": "wf_actions",
                })
                if timestamp:
                    previous_at = timestamp
    elif positions:
        approval_positions, final_positions = _split_reporting_ladder(positions)
        for position in approval_positions:
            holder_ids = _holder_ids([position])
            action = _action_for_holders(actions, holder_ids)
            is_current = bool(holder_ids & pending_approver_ids)
            timestamp = _utc_datetime(action.acted_at) if action else None
            fallback_title = _fallback_stage_title([position], final=False)
            current_title = (
                instance.current_stage_name
                if is_current
                and instance
                and instance.current_stage_name
                and instance.current_stage_name not in {
                    "Reporting Manager", "Approval", "Final authority",
                }
                else None
            )
            if current_title:
                title = current_title
            elif (
                action
                and action.stage_name
                and action.stage_name not in {"Reporting Manager", "Approval"}
            ):
                title = action.stage_name
            else:
                title = fallback_title
            if current_stage is None and is_current:
                current_stage = _waiting_for_stage(title)
            stages.append({
                "sequence": len(stages) + 1,
                "title": title,
                "status": _stage_status_from_action(action) if action else "PENDING",
                "is_current": is_current,
                "approver_name": action.actor_name if action else _holder_names_for_ids([position], holder_ids),
                "position_name": action.actor_position if action else position["name"],
                "timestamp": timestamp,
                "comments": action.comments if action else None,
                "duration_seconds": _duration_seconds(previous_at, timestamp),
                "stage_type": "approval",
            })
            if timestamp:
                previous_at = timestamp

        if final_positions:
            final_holder_ids = _holder_ids(final_positions)
            final_success, final_decision = _final_any_one_actions(actions, final_holder_ids)
            display_action = final_success or final_decision
            final_pending_ids = final_holder_ids & pending_approver_ids
            is_current = bool(final_pending_ids)
            timestamp = _utc_datetime(display_action.acted_at) if display_action else None
            status = _stage_status_from_action(display_action) if display_action else "PENDING"
            title = _fallback_stage_title(final_positions, final=True)
            has_final_stage = True
            if status == "APPROVED" and display_action:
                final_any_one_outcome = f"Approved by {display_action.actor_name}"
            if current_stage is None and is_current:
                current_stage = "Waiting for final approval"
            stages.append({
                "sequence": len(stages) + 1,
                "title": title,
                "status": status,
                "is_current": is_current,
                "approver_name": (
                    display_action.actor_name if display_action
                    else _holder_names_for_ids(final_positions, final_pending_ids or final_holder_ids)
                ),
                "position_name": (
                    display_action.actor_position if display_action
                    else " / ".join(position["name"] for position in final_positions)
                ),
                "timestamp": timestamp,
                "comments": display_action.comments if display_action else None,
                "duration_seconds": _duration_seconds(previous_at, timestamp),
                "stage_type": "final",
            })
            if timestamp:
                previous_at = timestamp

            acted_final_ids = {
                action.actor_id
                for action in actions
                if action.actor_id in final_holder_ids
                and action.action in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}
            }
            if final_success:
                for position in final_positions:
                    for holder in position["holders"]:
                        if holder.id not in acted_final_ids:
                            stages.append({
                                "sequence": len(stages) + 1,
                                "title": f"{_position_label(position['name'])} Final Approval",
                                "status": "NOT_REQUIRED",
                                "is_current": False,
                                "approver_name": holder.full_name,
                                "position_name": position["name"],
                                "timestamp": None,
                                "comments": None,
                                "duration_seconds": None,
                                "stage_type": "final_any_one_peer",
                            })
    else:
        represented_sequences = set(stage_actions) | set(pending_by_sequence)
        for workflow_sequence in sorted(represented_sequences):
            actions_for_sequence = stage_actions.get(workflow_sequence, [])
            pending_for_sequence = pending_by_sequence.get(workflow_sequence, [])
            if pending_for_sequence:
                approved = _latest_action_for_stage(
                    actions_for_sequence,
                    ApprovalAction.APPROVED.value,
                )
                action = approved
                approver_ids = {row.approver_id for row in pending_for_sequence}
                pending_positions: list[dict] = []
                is_final = False
                has_final_stage = has_final_stage or is_final
                title = (
                    getattr(instance, "current_stage_name", None)
                    if instance and getattr(instance, "current_sequence", None) == workflow_sequence
                    else None
                ) or (action.stage_name if action and action.stage_name else None) or "Approval"
                if current_stage is None:
                    current_stage = "Waiting for final approval" if is_final else _waiting_for_stage(title)
                timestamp = _utc_datetime(action.acted_at) if action else None
                stages.append({
                    "sequence": len(stages) + 1,
                    "title": title,
                    "status": "PENDING",
                    "is_current": True,
                    "approver_name": (
                        action.actor_name if action
                        else _holder_names_for_ids(pending_positions, approver_ids)
                    ),
                    "position_name": (
                        action.actor_position if action
                        else " / ".join(position["name"] for position in pending_positions) or None
                    ),
                    "timestamp": timestamp,
                    "comments": action.comments if action else None,
                    "duration_seconds": _duration_seconds(previous_at, timestamp),
                    "stage_type": "final" if is_final else "approval",
                    "approval_mode": None,
                    "reference_no": None,
                    "quantity_summary": None,
                    "evidence_source": "wf_pending plus wf_instances.current_stage_name",
                })
                if timestamp:
                    previous_at = timestamp
                continue

            if actions_for_sequence:
                display_action = (
                    _terminal_or_active_stage_action(actions_for_sequence, indent.status)
                    or _display_action_for_stage(actions_for_sequence)
                )
                stage_type = (
                    "final"
                    if instance
                    and instance.status == InstanceStatus.APPROVED.value
                    and workflow_sequence == max(represented_sequences)
                    else "approval"
                )
                has_final_stage = has_final_stage or stage_type == "final"
                timestamp = _utc_datetime(display_action.acted_at)
                status = _stage_status_from_action(display_action)
                if stage_type == "final" and status == "APPROVED":
                    final_any_one_outcome = f"Approved by {display_action.actor_name}"
                stages.append({
                    "sequence": len(stages) + 1,
                    "title": display_action.stage_name or ("Final Approval" if stage_type == "final" else "Approval"),
                    "status": status,
                    "is_current": False,
                    "approver_name": display_action.actor_name,
                    "position_name": display_action.actor_position,
                    "timestamp": timestamp,
                    "comments": display_action.comments,
                    "duration_seconds": _duration_seconds(previous_at, timestamp),
                    "stage_type": stage_type,
                })
                if timestamp:
                    previous_at = timestamp
                continue

    operational = {
        "stages": [], "events": [], "missing_sources": [],
        "has_allocation": False, "allocation_complete": False,
        "has_material_request": False, "has_issue": False, "issue_complete": False,
        "has_dispatch": False, "has_delivery": False, "delivery_complete": False,
        "has_acknowledgement": False,
        "has_receipt": False,
        "receipt_complete": False, "is_complete": False,
    }
    if indent.status in _POST_APPROVAL_STATUSES:
        operational = await _journey_operational_evidence(db, indent, audits)

    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        current_stage = "Returned for correction"
    elif indent.status == IndentStatus.REJECTED.value:
        current_stage = "Request rejected"
    elif indent.status not in {
        IndentStatus.DRAFT.value,
        IndentStatus.PENDING_APPROVAL.value,
        IndentStatus.REJECTED.value,
        IndentStatus.RETURNED_FOR_CORRECTION.value,
        *_POST_APPROVAL_STATUSES,
    }:
        current_stage = "Status unavailable"
    elif current_stage is None:
        current_stage = "Approval completed"

    approval_stages = [
        row for row in stages if row["stage_type"] in {"approval", "final"}
    ]
    terminal_rejected = indent.status == IndentStatus.REJECTED.value
    active_returned_for_correction = (
        indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value
    )
    approval_rejected = any(
        row["status"] == "REJECTED" for row in approval_stages
    ) and terminal_rejected
    approval_returned = any(
        row["status"] == "RETURNED" for row in approval_stages
    ) and active_returned_for_correction
    approval_current = next(
        (
            row for row in approval_stages
            if row.get("is_current") and row["status"] == "PENDING"
        ),
        None,
    )
    approvals_complete = bool(instance) and instance.status == InstanceStatus.APPROVED.value
    request_submitted = submitted is not None

    def phase(sequence: int, title: str, status: str, *, current: bool = False,
              message: str | None = None) -> dict:
        return {
            "sequence": sequence,
            "title": title,
            "status": status,
            "is_current": current,
            "approver_name": message,
            "position_name": None,
            "timestamp": None,
            "comments": None,
            "duration_seconds": None,
            "stage_type": "phase",
            "approval_mode": None,
            "reference_no": None,
            "quantity_summary": None,
            "evidence_source": None,
        }

    if approval_rejected:
        approval_status, approval_is_current = "REJECTED", False
    elif approval_returned:
        approval_status, approval_is_current = "RETURNED", False
    elif approvals_complete:
        approval_status, approval_is_current = "APPROVED", False
    elif approval_current:
        approval_status, approval_is_current = "PENDING", True
    else:
        approval_status, approval_is_current = "PENDING", False

    draft_current = indent.status == IndentStatus.DRAFT.value
    submitted_current = (
        request_submitted
        and not draft_current
        and not approval_rejected
        and not approval_returned
        and not approvals_complete
        and not approval_is_current
    )
    stages[0]["is_current"] = draft_current

    allocation_done = bool(operational["has_allocation"])
    warehouse_done = bool(operational["issue_complete"])
    delivery_done = bool(operational["delivery_complete"])
    acknowledgement_done = bool(operational["is_complete"])
    allocation_current = approvals_complete and not allocation_done
    warehouse_current = allocation_done and not warehouse_done
    delivery_current = warehouse_done and not delivery_done and not operational["has_receipt"]
    acknowledgement_current = (
        (delivery_done or operational["has_receipt"]) and not acknowledgement_done
    )

    phases = [
        phase(1, "Draft", "APPROVED" if request_submitted else "PENDING",
              current=draft_current),
        phase(2, "Submitted", "APPROVED" if request_submitted else "PENDING",
              current=submitted_current),
        phase(
            3, "Approvals", approval_status, current=approval_is_current,
            message=(approval_current or {}).get("title") if approval_current else None,
        ),
        phase(4, "Allocation", "APPROVED" if allocation_done else "PENDING",
              current=allocation_current),
        phase(5, "Warehouse", "APPROVED" if warehouse_done else "PENDING",
              current=warehouse_current),
        phase(6, "Delivery", "APPROVED" if delivery_done else "PENDING",
              current=delivery_current),
        phase(7, "Acknowledgement", "APPROVED" if acknowledgement_done else "PENDING",
              current=acknowledgement_current),
    ]

    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        current_stage = "Returned for correction"
    elif approval_rejected:
        current_stage = "Request rejected"
    elif draft_current:
        current_stage = "Draft — submit the indent to begin approval"
    elif submitted_current:
        current_stage = "Request submitted — waiting for approval"
    elif approval_is_current and approval_current:
        current_stage = _waiting_for_stage(approval_current["title"])
    elif allocation_current:
        current_stage = "Waiting for allocation"
    elif warehouse_current:
        current_stage = "Waiting for warehouse issue"
    elif delivery_current:
        current_stage = "In delivery" if operational["has_dispatch"] else "Waiting for dispatch"
    elif acknowledgement_current:
        current_stage = (
            "Partially received"
            if operational["has_receipt"] else "Waiting for acknowledgement"
        )
    elif acknowledgement_done:
        current_stage = "Completed"

    history = _journey_history(
        indent,
        actions,
        audits,
        operational["events"],
        resolved_chain,
    )
    chain_by_sequence = {
        int(link.get("sequence", index + 1)): link
        for index, link in enumerate(resolved_chain or [])
        if isinstance(link, dict)
    }
    final_sequence = max(chain_by_sequence, default=None)
    stage_type_by_event = {
        "CREATED": "draft",
        "SUBMITTED": "submission",
        "APPROVED": "approval",
        "REJECTED": "approval",
        "RETURNED": "approval",
        "READY_FOR_ALLOCATION": "allocation",
        "STOCK_ALLOCATED": "allocation",
        "WAREHOUSE_ISSUED": "warehouse",
        "DISPATCHED": "delivery",
        "DELIVERED": "delivery",
        "ACKNOWLEDGEMENT_SUBMITTED": "acknowledgement",
        "PARTIALLY_RECEIVED": "acknowledgement",
        "FULLY_RECEIVED": "acknowledgement",
        "COMPLETED": "completion",
    }

    # Timeline cards are projections of immutable history events. They remain useful
    # internally, but the public `stages` contract is the detailed journey assembled
    # above: every resolved workflow rung, including pending and skipped rungs, must
    # stay visible rather than being collapsed into evidence-only actions.
    evidence_stages: list[dict] = []
    evidence_previous_at: datetime | None = None
    for event in history:
        event_type = event["event_type"]
        workflow_sequence = event.get("workflow_sequence")
        link = chain_by_sequence.get(int(workflow_sequence)) if workflow_sequence is not None else None
        event_stage_type = event.get("stage_type") or stage_type_by_event.get(
            event_type, "activity",
        )
        if event_type == "APPROVED" and final_sequence == workflow_sequence:
            event_stage_type = "final"
        status = {
            "CREATED": "COMPLETED",
            "SUBMITTED": "SUBMITTED",
            "REJECTED": "REJECTED",
            "RETURNED": "RETURNED",
            "APPROVED": "APPROVED",
            "ACKNOWLEDGEMENT_SUBMITTED": "ACKNOWLEDGED",
        }.get(event_type)
        if status is None:
            if event_type.endswith("_REJECTED"):
                status = "REJECTED"
            elif event_type.endswith("_RETURNED"):
                status = "RETURNED"
            elif event_type.endswith("_SUBMITTED"):
                status = "SUBMITTED"
            elif event_type.endswith("_APPROVED"):
                status = "APPROVED"
            else:
                status = "COMPLETED"
        timestamp = event["timestamp"]
        evidence_stages.append({
            "event_id": event["id"],
            "sequence": len(evidence_stages) + 1,
            "title": event["title"],
            "status": status,
            "is_current": False,
            "approver_name": event.get("actor_name"),
            "position_name": event.get("position_name"),
            "timestamp": timestamp,
            "comments": event.get("comments"),
            "duration_seconds": _duration_seconds(evidence_previous_at, timestamp),
            "stage_type": event_stage_type,
            "approval_mode": event.get("approval_mode") or (
                link.get("approval_mode") if link else None
            ),
            "reference_no": event.get("reference_no"),
            "quantity_summary": event.get("quantity_summary"),
            "evidence_source": event.get("id"),
        })
        evidence_previous_at = timestamp

    return {
        "contract_version": 5,
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "status": indent.status,
        "requested_by_name": indent.requested_by_name,
        "requested_by_position": indent.position_name,
        "created_at": _utc_datetime(indent.created_at),
        "current_stage": current_stage,
        "current_stage_message": current_stage,
        "final_any_one_outcome": final_any_one_outcome,
        "stages": stages,
        "phases": phases,
        "history": history,
        "missing_sources": operational["missing_sources"],
    }


async def indent_stats(
    db: AsyncSession,
    *,
    user=None,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    required_by_from: date | None = None,
    required_by_to: date | None = None,
    statuses: list[IndentStatus] | None = None,
    priorities: list[Priority] | None = None,
    indent_types: list[IndentType] | None = None,
    department_ids: list[int] | None = None,
    region_ids: list[int] | None = None,
    include_unassigned_region: bool = False,
    is_bookmarked: str | None = None,
) -> dict:
    """KPIs for the indent dashboard: counts by status + a few derived numbers."""
    _validate_indent_date_ranges(
        date_from, date_to, required_by_from, required_by_to,
    )
    base = select(Indent.id)
    if user is not None:
        base = base.where(await indent_access_condition(db, user))
    filtered_ids = _apply_indent_filters(
        base, search=search, date_from=date_from, date_to=date_to,
        required_by_from=required_by_from, required_by_to=required_by_to,
        statuses=statuses, priorities=priorities, indent_types=indent_types,
        department_ids=department_ids, region_ids=region_ids,
        include_unassigned_region=include_unassigned_region,
        is_bookmarked=is_bookmarked,
    ).subquery()

    stmt = (
        select(Indent.status, func.count())
        .join(filtered_ids, filtered_ids.c.id == Indent.id)
        .group_by(Indent.status)
    )
    counts = {status: n for status, n in (await db.execute(stmt)).all()}

    # Counts per Region/Location, which is what "group the monthly indents by location"
    # asks the dashboard for. NULL regions are reported under their own bucket rather
    # than dropped, so the rows always sum back to `total`.
    region_stmt = (
        select(Indent.region_id, Indent.region_name, func.count())
        .join(filtered_ids, filtered_ids.c.id == Indent.id)
        .group_by(Indent.region_id, Indent.region_name)
        .order_by(func.count().desc())
    )
    by_region = [
        {"region_id": region_id, "region_name": region_name, "count": n}
        for region_id, region_name, n in (await db.execute(region_stmt)).all()
    ]

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_stmt = (
        select(func.count())
        .select_from(Indent)
        .join(filtered_ids, filtered_ids.c.id == Indent.id)
        .where(Indent.created_at >= month_start)
    )
    this_month = await db.scalar(month_stmt)

    S = IndentStatus
    # "Cleared its approval chain and is still moving." An indent no longer rests at
    # APPROVED -- it goes to AWAITING_ALLOCATION and on through the allocation
    # outcomes -- so counting only APPROVED would report zero approvals forever.
    approved_active = sum(counts.get(v, 0) for v in (
        S.APPROVED.value, S.AWAITING_ALLOCATION.value, S.ALLOCATED.value,
        S.PARTIALLY_FULFILLED.value, S.PENDING_PROCUREMENT.value,
        S.ORDERED.value, S.PARTIALLY_ORDERED.value,
    ))
    line_totals = (
        select(func.count(IndentItem.id), func.coalesce(func.sum(IndentItem.quantity), 0))
        .join(Indent, Indent.id == IndentItem.indent_id)
        .join(filtered_ids, filtered_ids.c.id == Indent.id)
    )
    total_items, total_qty = (await db.execute(line_totals)).one()
    decided = approved_active + counts.get(S.REJECTED.value, 0)
    return {
        "total": sum(counts.values()),
        "draft": counts.get(S.DRAFT.value, 0),
        "awaiting_approval": counts.get(S.PENDING_APPROVAL.value, 0),
        "approved_active": approved_active,
        "rejected": counts.get(S.REJECTED.value, 0),
        "ordered": counts.get(S.ORDERED.value, 0),
        "this_month": this_month or 0,
        "total_items": total_items or 0,
        "total_qty": float(total_qty or 0),
        "approval_rate": round((approved_active / decided) * 100, 1) if decided else 0,
        "by_status": counts,
        "by_region": by_region,
    }


_ACTIVITY_RESPONSE_FIELDS = (
    "event_id",
    "indent_id",
    "indent_no",
    "event_type",
    "event_label",
    "result",
    "result_label",
    "occurred_at",
    "actor_id",
    "actor_name",
    "actor_position",
    "item_id",
    "item_code",
    "item_name",
    "quantity",
    "requested_quantity",
    "uom_code",
    "department_name",
    "office_name",
    "region_id",
    "region_name",
    "remarks",
    "source_type",
    "source_id",
)


def _activity_value(value, sql_type=None):
    if value is None:
        return cast(literal(None), sql_type)
    if isinstance(value, (str, int)):
        return literal(value)
    return value


def _activity_event_columns(
    visible,
    *,
    event_id,
    event_type,
    event_label,
    result,
    result_label,
    occurred_at,
    actor_id=None,
    actor_name=None,
    actor_position=None,
    item_id=None,
    item_code=None,
    item_name=None,
    quantity=None,
    requested_quantity=None,
    uom_code=None,
    remarks=None,
    source_type,
    source_id,
    source_rank,
    event_key,
    search_position=None,
    search_stage=None,
    search_remarks=None,
):
    """Keep every UNION branch type-compatible and in the exact same order."""
    return (
        _activity_value(event_id, String).label("event_id"),
        visible.c.indent_id,
        visible.c.indent_no,
        _activity_value(event_type, String).label("event_type"),
        _activity_value(event_label, String).label("event_label"),
        _activity_value(result, String).label("result"),
        _activity_value(result_label, String).label("result_label"),
        occurred_at.label("occurred_at"),
        _activity_value(actor_id, BigInteger).label("actor_id"),
        _activity_value(actor_name, String).label("actor_name"),
        _activity_value(actor_position, String).label("actor_position"),
        _activity_value(item_id, BigInteger).label("item_id"),
        _activity_value(item_code, String).label("item_code"),
        _activity_value(item_name, String).label("item_name"),
        _activity_value(quantity, Numeric(16, 3)).label("quantity"),
        _activity_value(requested_quantity, Numeric(16, 3)).label("requested_quantity"),
        _activity_value(uom_code, String).label("uom_code"),
        visible.c.department_name,
        visible.c.office_name,
        visible.c.region_id,
        visible.c.region_name,
        _activity_value(remarks, String).label("remarks"),
        _activity_value(source_type, String).label("source_type"),
        _activity_value(source_id, BigInteger).label("source_id"),
        _activity_value(source_rank, BigInteger).label("_source_rank"),
        _activity_value(event_key, BigInteger).label("_event_key"),
        visible.c.requested_by_name.label("_requester_name"),
        visible.c.project_name.label("_project_name"),
        _activity_value(search_position, String).label("_search_position"),
        _activity_value(search_stage, String).label("_search_stage"),
        _activity_value(search_remarks if search_remarks is not None else remarks, String).label(
            "_search_remarks"
        ),
    )


def _activity_business_stage(stage_name):
    """Translate persisted workflow stages without returning internal workflow codes."""
    normalized = func.upper(func.coalesce(stage_name, literal("")))
    return case(
        (
            or_(
                normalized.like("%FINAL%"),
                normalized.like("%STATE%PROJECT%HEAD%"),
                normalized.like("%CHIEF%OPERATING%OFFICER%"),
                normalized.in_(("SPH", "COO", "SPH REVIEW", "COO REVIEW")),
            ),
            literal("Final Approval"),
        ),
        (
            or_(
                normalized.like("%REGIONAL%MANAGER%"),
                normalized.in_(("RM", "RM REVIEW")),
            ),
            literal("Regional Manager Review"),
        ),
        (
            or_(
                normalized.like("%DISTRICT%MANAGER%"),
                normalized.in_(("DM", "DM REVIEW")),
            ),
            literal("District Manager Review"),
        ),
        (
            or_(
                normalized.like("%OPERATION%EXECUTIVE%"),
                normalized.in_(("OE", "OE REVIEW")),
            ),
            literal("OE Review"),
        ),
        else_=literal("Approval Review"),
    )


async def activity_ledger(
    db: AsyncSession,
    params: PageParams,
    *,
    user=None,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    required_from: date | None = None,
    required_to: date | None = None,
    item_id: int | None = None,
    statuses: list[IndentStatus] | None = None,
    priorities: list[Priority] | None = None,
    region_ids: list[int] | None = None,
    include_unassigned_region: bool = False,
    transaction_type: IndentActivityType | None = None,
    direction: MaterialDirection | None = None,
) -> dict:
    """Read-only, source-normalized audit trail over visible indents."""
    _validate_filter_date_range(date_from, date_to)
    visible_stmt = select(
        Indent.id.label("indent_id"),
        Indent.indent_no,
        Indent.status.label("current_status"),
        Indent.priority,
        Indent.required_date,
        Indent.requested_by_id,
        Indent.requested_by_name,
        Indent.position_name,
        Indent.department_name,
        Indent.office_name,
        Indent.region_id,
        Indent.region_name,
        Indent.project_name,
        Indent.created_at,
    )
    if user is not None:
        visible_stmt = visible_stmt.where(await indent_access_condition(db, user))
    # Narrowed on the CTE, not after the UNION: every branch fans one indent out into
    # many rows, so filtering the source keeps the four joins off the excluded indents.
    visible_stmt = _apply_region_filter(
        visible_stmt, region_ids, include_unassigned_region)
    if required_from:
        visible_stmt = visible_stmt.where(Indent.required_date >= required_from)
    if required_to:
        visible_stmt = visible_stmt.where(Indent.required_date <= required_to)
    if statuses:
        visible_stmt = visible_stmt.where(Indent.status.in_(_values(statuses)))
    if priorities:
        visible_stmt = visible_stmt.where(Indent.priority.in_(_values(priorities)))
    visible = visible_stmt.cte("visible_indents")

    created = select(*_activity_event_columns(
        visible,
        event_id=literal("indent:") + cast(visible.c.indent_id, String),
        event_type=IndentActivityType.REQUEST_CREATED.value,
        event_label="Request created",
        result="DRAFT",
        result_label="Draft",
        occurred_at=visible.c.created_at,
        actor_id=visible.c.requested_by_id,
        actor_name=visible.c.requested_by_name,
        actor_position=visible.c.position_name,
        source_type="ind_indents",
        source_id=visible.c.indent_id,
        source_rank=10,
        event_key=visible.c.indent_id,
        search_position=visible.c.position_name,
    )).select_from(visible)

    workflow_event_type = case(
        {
            ApprovalAction.SUBMITTED.value: IndentActivityType.REQUEST_SUBMITTED.value,
            ApprovalAction.APPROVED.value: IndentActivityType.APPROVAL_COMPLETED.value,
            ApprovalAction.REJECTED.value: IndentActivityType.REQUEST_REJECTED.value,
            ApprovalAction.RETURNED.value: IndentActivityType.REQUEST_RETURNED.value,
            ApprovalAction.FALLBACK.value: (
                IndentActivityType.APPROVAL_ROUTED_AUTOMATICALLY.value
            ),
        },
        value=Action.action,
    )
    workflow_event_label = case(
        {
            ApprovalAction.SUBMITTED.value: "Request submitted",
            ApprovalAction.APPROVED.value: "Approval completed",
            ApprovalAction.REJECTED.value: "Request rejected",
            ApprovalAction.RETURNED.value: "Request returned",
            ApprovalAction.FALLBACK.value: "Approval routed automatically",
        },
        value=Action.action,
    )
    workflow_result = case(
        {
            ApprovalAction.SUBMITTED.value: "SUBMITTED",
            ApprovalAction.APPROVED.value: "APPROVED",
            ApprovalAction.REJECTED.value: "REJECTED",
            ApprovalAction.RETURNED.value: "RETURNED",
            ApprovalAction.FALLBACK.value: "ROUTED_AUTOMATICALLY",
        },
        value=Action.action,
    )
    workflow_result_label = case(
        {
            ApprovalAction.SUBMITTED.value: "Submitted",
            ApprovalAction.APPROVED.value: "Approved",
            ApprovalAction.REJECTED.value: "Rejected",
            ApprovalAction.RETURNED.value: "Returned",
            ApprovalAction.FALLBACK.value: "Routed Automatically",
        },
        value=Action.action,
    )
    business_stage = _activity_business_stage(Action.stage_name)
    workflow_context = case(
        (
            Action.action == ApprovalAction.SUBMITTED.value,
            literal("Request Submission"),
        ),
        else_=business_stage,
    )
    workflow_actor_name = case(
        (
            Action.action == ApprovalAction.FALLBACK.value,
            literal("System"),
        ),
        else_=Action.actor_name,
    )
    workflow_actor_id = case(
        (
            Action.action == ApprovalAction.FALLBACK.value,
            cast(literal(None), BigInteger),
        ),
        else_=Action.actor_id,
    )
    workflow_remarks = case(
        (
            Action.action.in_((
                ApprovalAction.REJECTED.value,
                ApprovalAction.RETURNED.value,
            )),
            Action.comments,
        ),
        else_=cast(literal(None), String),
    )
    workflow = (
        select(*_activity_event_columns(
            visible,
            event_id=literal("workflow:") + cast(Action.id, String),
            event_type=workflow_event_type,
            event_label=workflow_event_label,
            result=workflow_result,
            result_label=workflow_result_label,
            occurred_at=Action.acted_at,
            actor_id=workflow_actor_id,
            actor_name=workflow_actor_name,
            actor_position=workflow_context,
            remarks=workflow_remarks,
            source_type="wf_actions",
            source_id=Action.id,
            source_rank=20,
            event_key=Action.id,
            search_position=Action.actor_position,
            search_stage=Action.stage_name,
            search_remarks=Action.comments,
        ))
        .select_from(visible)
        .join(
            Instance,
            and_(
                Instance.doc_id == visible.c.indent_id,
                Instance.doc_type == DocType.INDENT.value,
            ),
        )
        .join(Action, Action.instance_id == Instance.id)
        .where(Action.action.in_((
            ApprovalAction.SUBMITTED.value,
            ApprovalAction.APPROVED.value,
            ApprovalAction.REJECTED.value,
            ApprovalAction.RETURNED.value,
            ApprovalAction.FALLBACK.value,
        )))
    )

    allocation_approval_rows = (
        select(
            Instance.doc_id.label("allocation_id"),
            Action.actor_id,
            Action.actor_name,
            Action.actor_position,
            func.row_number().over(
                partition_by=Instance.doc_id,
                order_by=(Action.acted_at.desc(), Action.id.desc()),
            ).label("approval_rank"),
        )
        .join(Action, Action.instance_id == Instance.id)
        .where(
            Instance.doc_type == DocType.ALLOCATION.value,
            Action.action == ApprovalAction.APPROVED.value,
        )
        .subquery("allocation_approval_rows")
    )
    allocation_approval = (
        select(allocation_approval_rows)
        .where(allocation_approval_rows.c.approval_rank == 1)
        .subquery("allocation_approval")
    )
    allocated_quantity = func.sum(AllocationItem.quantity)
    requested_quantity = func.max(AllocationItem.requested_qty)
    allocation_result = case(
        (allocated_quantity == requested_quantity, literal("ALLOCATED")),
        else_=literal("PARTIALLY_ALLOCATED"),
    )
    allocation_result_label = case(
        (allocated_quantity == requested_quantity, literal("Allocated")),
        else_=literal("Partially Allocated"),
    )
    allocation_remarks = func.coalesce(
        func.max(AllocationItem.remarks),
        Allocation.remarks,
    )
    allocation = (
        select(*_activity_event_columns(
            visible,
            event_id=(
                literal("allocation:")
                + cast(Allocation.id, String)
                + literal(":")
                + cast(AllocationItem.indent_item_id, String)
            ),
            event_type=IndentActivityType.STOCK_ALLOCATED.value,
            event_label="Stock allocated",
            result=allocation_result,
            result_label=allocation_result_label,
            occurred_at=Allocation.approved_at,
            actor_id=allocation_approval.c.actor_id,
            actor_name=allocation_approval.c.actor_name,
            actor_position=allocation_approval.c.actor_position,
            item_id=func.max(AllocationItem.item_id),
            item_code=func.max(AllocationItem.item_code),
            item_name=func.max(AllocationItem.item_name),
            quantity=allocated_quantity,
            requested_quantity=requested_quantity,
            uom_code=func.max(AllocationItem.uom_code),
            remarks=allocation_remarks,
            source_type="inv_allocations",
            source_id=Allocation.id,
            source_rank=30,
            event_key=AllocationItem.indent_item_id,
            search_position=allocation_approval.c.actor_position,
            search_remarks=allocation_remarks,
        ))
        .select_from(visible)
        .join(Allocation, Allocation.indent_id == visible.c.indent_id)
        .join(AllocationItem, AllocationItem.allocation_id == Allocation.id)
        .outerjoin(
            allocation_approval,
            allocation_approval.c.allocation_id == Allocation.id,
        )
        .where(
            Allocation.status == AllocationStatus.APPROVED.value,
            Allocation.approved_at.is_not(None),
        )
        .group_by(
            visible.c.indent_id,
            visible.c.indent_no,
            visible.c.department_name,
            visible.c.office_name,
            visible.c.region_id,
            visible.c.region_name,
            visible.c.requested_by_name,
            visible.c.project_name,
            Allocation.id,
            Allocation.approved_at,
            Allocation.remarks,
            AllocationItem.indent_item_id,
            allocation_approval.c.actor_id,
            allocation_approval.c.actor_name,
            allocation_approval.c.actor_position,
        )
    )

    material_request = (
        select(*_activity_event_columns(
            visible,
            event_id=(
                literal("material-request:")
                + cast(MaterialRequest.id, String)
                + literal(":")
                + cast(MaterialRequestItem.id, String)
            ),
            event_type=IndentActivityType.PROCUREMENT_REQUEST_CREATED.value,
            event_label="Procurement request created",
            result="PENDING_APPROVAL",
            result_label="Pending Approval",
            occurred_at=MaterialRequest.created_at,
            actor_id=MaterialRequest.requested_by_id,
            actor_name=MaterialRequest.requested_by_name,
            actor_position=MaterialRequest.mr_no,
            item_id=MaterialRequestItem.item_id,
            item_code=MaterialRequestItem.item_code,
            item_name=MaterialRequestItem.item_name,
            quantity=MaterialRequestItem.quantity,
            requested_quantity=MaterialRequestItem.quantity,
            uom_code=MaterialRequestItem.uom_code,
            remarks=func.coalesce(MaterialRequestItem.remarks, MaterialRequest.remarks),
            source_type="inv_material_requests",
            source_id=MaterialRequest.id,
            source_rank=40,
            event_key=MaterialRequestItem.id,
            search_remarks=func.coalesce(
                MaterialRequestItem.remarks,
                MaterialRequest.remarks,
            ),
        ))
        .select_from(visible)
        .join(MaterialRequest, MaterialRequest.indent_id == visible.c.indent_id)
        .join(
            MaterialRequestItem,
            MaterialRequestItem.mr_id == MaterialRequest.id,
        )
    )

    bookmark_to = AuditLog.changed_fields["is_bookmarked"]["to"].as_string()
    bookmark_from = AuditLog.changed_fields["is_bookmarked"]["from"].as_string()
    bookmark_event_type = case(
        (bookmark_to == "YES", literal(IndentActivityType.BOOKMARK_ADDED.value)),
        else_=literal(IndentActivityType.BOOKMARK_REMOVED.value),
    )
    bookmark_event_label = case(
        (bookmark_to == "YES", literal("Bookmark added")),
        else_=literal("Bookmark removed"),
    )
    bookmark_result = case(
        (bookmark_to == "YES", literal("BOOKMARKED")),
        else_=literal("BOOKMARK_REMOVED"),
    )
    bookmark_result_label = case(
        (bookmark_to == "YES", literal("Bookmarked")),
        else_=literal("Bookmark Removed"),
    )
    bookmark = (
        select(*_activity_event_columns(
            visible,
            event_id=literal("audit:") + cast(AuditLog.id, String),
            event_type=bookmark_event_type,
            event_label=bookmark_event_label,
            result=bookmark_result,
            result_label=bookmark_result_label,
            occurred_at=AuditLog.created_at,
            actor_id=AuditLog.actor_id,
            actor_name=AuditLog.actor_name,
            actor_position="Bookmark",
            source_type="sys_audit_log",
            source_id=AuditLog.id,
            source_rank=50,
            event_key=AuditLog.id,
        ))
        .select_from(visible)
        .join(
            AuditLog,
            and_(
                AuditLog.entity_id == visible.c.indent_id,
                AuditLog.entity_type == "ind_indents",
            ),
        )
        .where(
            AuditLog.action == AuditAction.UPDATE.value,
            bookmark_to.in_(("YES", "NO")),
            bookmark_from != bookmark_to,
        )
    )

    combined_rows = union_all(
        created,
        workflow,
        allocation,
        material_request,
        bookmark,
    ).subquery("activity_events")
    filtered = select(combined_rows)

    term = _clean_search(search)
    if term:
        pattern = _like_pattern(term)
        filtered = filtered.where(or_(
            _matches(combined_rows.c.indent_no, pattern),
            _matches(combined_rows.c.actor_name, pattern),
            _matches(combined_rows.c.actor_position, pattern),
            _matches(combined_rows.c.item_code, pattern),
            _matches(combined_rows.c.item_name, pattern),
            _matches(combined_rows.c.event_label, pattern),
            _matches(combined_rows.c.result_label, pattern),
            _matches(combined_rows.c.department_name, pattern),
            _matches(combined_rows.c.remarks, pattern),
        ))
    if date_from:
        filtered = filtered.where(
            combined_rows.c.occurred_at >= datetime.combine(date_from, time.min)
        )
    if date_to:
        filtered = filtered.where(
            combined_rows.c.occurred_at
            < datetime.combine(date_to + timedelta(days=1), time.min)
        )
    if item_id is not None:
        filtered = filtered.where(combined_rows.c.item_id == item_id)
    if transaction_type is not None:
        filtered = filtered.where(
            combined_rows.c.event_type == transaction_type.value
        )
    if direction is not None:
        filtered = filtered.where(false())

    filtered_rows = filtered.subquery("filtered_activity_events")
    stmt = (
        select(*(filtered_rows.c[field] for field in _ACTIVITY_RESPONSE_FIELDS))
        .order_by(
            filtered_rows.c.occurred_at.desc(),
            filtered_rows.c._source_rank.desc(),
            filtered_rows.c.source_id.desc(),
            filtered_rows.c._event_key.desc(),
        )
    )
    total = await db.scalar(select(func.count()).select_from(filtered_rows))
    result = (
        await db.execute(stmt.offset(params.offset).limit(params.size))
    ).mappings().all()
    return {
        "items": [dict(row) for row in result],
        "total": total or 0,
        "page": params.page,
        "size": params.size,
    }


async def list_acknowledgments(
    db: AsyncSession,
    params: PageParams,
    *,
    user=None,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    required_from: date | None = None,
    required_to: date | None = None,
    statuses: list[AcknowledgmentStatus] | None = None,
    priorities: list[Priority] | None = None,
) -> dict:
    # No posted, indent-linked warehouse issue/dispatch evidence exists yet.
    # Keep the endpoint contract and security/filter clauses intact, but make the
    # evidence relation explicitly empty. Allocation and lifecycle state are not
    # physical fulfillment proof and must never produce an acknowledgment row.
    # Future implementation starts only from posted out_issues.indent_id and
    # out_issue_items.indent_item_id evidence; net quantity is issued minus
    # returned. Do not add that calculation until linked, posted rows exist.
    fulfillment_evidence = (
        select(
            cast(literal(None), BigInteger).label("indent_id"),
            cast(literal(None), String).label("action"),
            cast(literal(None), String).label("actor_name"),
            cast(literal(None), String).label("comments"),
            cast(literal(None), DateTime(timezone=True)).label("acted_at"),
        )
        .where(literal(0) == literal(1))
        .subquery("fulfillment_evidence")
    )
    occurred_at = fulfillment_evidence.c.acted_at
    stmt = (
        select(
            Indent.id,
            Indent.id.label("indent_id"),
            Indent.indent_no,
            fulfillment_evidence.c.action,
            cast(literal(None), String).label("stage_name"),
            fulfillment_evidence.c.actor_name,
            fulfillment_evidence.c.comments,
            occurred_at,
        )
        .join(
            fulfillment_evidence,
            fulfillment_evidence.c.indent_id == Indent.id,
        )
    )
    if user is not None:
        stmt = stmt.where(await indent_access_condition(db, user))
    term = _clean_search(search)
    if term:
        pattern = _like_pattern(term)
        stmt = stmt.where(or_(
            *_indent_search_conditions(pattern),
            _matches(
                func.coalesce(fulfillment_evidence.c.actor_name, literal("System")),
                pattern,
            ),
            _matches(fulfillment_evidence.c.action, pattern),
            _matches(fulfillment_evidence.c.comments, pattern),
            _indent_item_exists(pattern),
        ))
    if date_from:
        stmt = stmt.where(func.date(occurred_at) >= date_from)
    if date_to:
        stmt = stmt.where(func.date(occurred_at) <= date_to)
    if required_from:
        stmt = stmt.where(Indent.required_date >= required_from)
    if required_to:
        stmt = stmt.where(Indent.required_date <= required_to)
    if statuses:
        stmt = stmt.where(fulfillment_evidence.c.action.in_(_values(statuses)))
    if priorities:
        stmt = stmt.where(Indent.priority.in_(_values(priorities)))
    stmt = stmt.order_by(occurred_at.desc(), Indent.id.desc())
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = [
        dict(row)
        for row in (await db.execute(stmt.offset(params.offset).limit(params.size))).mappings().all()
    ]
    return {"items": rows, "total": total or 0, "page": params.page, "size": params.size}


async def list_notifications(
    db: AsyncSession,
    params: PageParams,
    user,
    *,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    statuses: list[IndentStatus] | None = None,
) -> dict:
    _validate_filter_date_range(date_from, date_to)

    supported_statuses = [
        IndentStatus.PENDING_APPROVAL.value, IndentStatus.APPROVED.value,
        IndentStatus.AWAITING_ALLOCATION.value, IndentStatus.ALLOCATED.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.REJECTED.value, IndentStatus.RETURNED_FOR_CORRECTION.value,
        IndentStatus.PARTIALLY_ORDERED.value,
        IndentStatus.ORDERED.value, IndentStatus.CLOSED.value,
    ]
    title = case(
        (Indent.status == IndentStatus.PENDING_APPROVAL.value, "Awaiting approval"),
        (Indent.status == IndentStatus.APPROVED.value, "Request approved"),
        (Indent.status == IndentStatus.AWAITING_ALLOCATION.value, "Request approved"),
        (Indent.status == IndentStatus.ALLOCATED.value, "Stock set aside"),
        (
            Indent.status == IndentStatus.PARTIALLY_FULFILLED.value,
            "Part of it is coming from stock",
        ),
        (Indent.status == IndentStatus.PENDING_PROCUREMENT.value, "Going to procurement"),
        (Indent.status == IndentStatus.REJECTED.value, "Request rejected"),
        (Indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value, "Correction requested"),
        (Indent.status == IndentStatus.PARTIALLY_ORDERED.value, "Ordering started"),
        (Indent.status == IndentStatus.ORDERED.value, "Items ordered"),
        (Indent.status == IndentStatus.CLOSED.value, "Request completed"),
        else_="",
    )
    pending_message = (
        Indent.indent_no
        + literal(" is awaiting approval")
        + case(
            (
                Indent.current_approver_name.is_not(None),
                literal(" from ") + Indent.current_approver_name + literal("."),
            ),
            else_=literal("."),
        )
    )
    message = case(
        (Indent.status == IndentStatus.PENDING_APPROVAL.value, pending_message),
        (
            Indent.status == IndentStatus.APPROVED.value,
            Indent.indent_no + literal(" has been approved."),
        ),
        (
            Indent.status == IndentStatus.AWAITING_ALLOCATION.value,
            Indent.indent_no + literal(" is approved and with inventory."),
        ),
        (
            Indent.status == IndentStatus.ALLOCATED.value,
            literal("Stock for ") + Indent.indent_no + literal(" has been set aside."),
        ),
        (
            Indent.status == IndentStatus.PARTIALLY_FULFILLED.value,
            literal("Some of ") + Indent.indent_no
            + literal(" is from stock; the rest is on order."),
        ),
        (
            Indent.status == IndentStatus.PENDING_PROCUREMENT.value,
            Indent.indent_no + literal(" is being bought in."),
        ),
        (
            Indent.status == IndentStatus.REJECTED.value,
            Indent.indent_no + literal(" has been rejected."),
        ),
        (
            Indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value,
            Indent.indent_no + literal(" has been returned for correction."),
        ),
        (
            Indent.status == IndentStatus.PARTIALLY_ORDERED.value,
            literal("Items for ") + Indent.indent_no + literal(" are being ordered."),
        ),
        (
            Indent.status == IndentStatus.ORDERED.value,
            literal("All items for ") + Indent.indent_no + literal(" have been ordered."),
        ),
        (
            Indent.status == IndentStatus.CLOSED.value,
            Indent.indent_no + literal(" is complete."),
        ),
        else_="",
    )
    stmt = (
        select(
            (
                literal("indent:") + cast(Indent.id, String)
                + literal(":") + Indent.status
            ).label("id"),
            Indent.id.label("indent_id"),
            Indent.indent_no,
            title.label("title"),
            message.label("message"),
            Indent.current_approver_name.label("_approver_name"),
            Indent.status,
            Indent.updated_at.label("created_at"),
        )
        .where(await indent_access_condition(db, user))
        .where(Indent.status.in_(supported_statuses))
    )
    term = _clean_search(search)
    if term:
        pattern = _like_pattern(term)
        stmt = stmt.where(or_(
            _matches(Indent.indent_no, pattern),
            _matches(title, pattern),
            _matches(message, pattern),
            _matches(func.replace(Indent.status, "_", " "), pattern),
        ))
    if date_from:
        stmt = stmt.where(
            Indent.updated_at >= datetime.combine(date_from, time.min, timezone.utc)
        )
    if date_to:
        stmt = stmt.where(
            Indent.updated_at
            < datetime.combine(date_to + timedelta(days=1), time.min, timezone.utc)
        )
    if statuses:
        stmt = stmt.where(Indent.status.in_(_values(statuses)))
    stmt = stmt.order_by(Indent.updated_at.desc(), Indent.id.desc())

    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (
        await db.execute(stmt.offset(params.offset).limit(params.size))
    ).mappings().all()

    items = [dict(row) for row in rows]
    pending_items = {
        row["indent_id"]: row
        for row in items
        if row["status"] == IndentStatus.PENDING_APPROVAL.value
        and row["_approver_name"]
    }
    if pending_items:
        instance_rows = (await db.execute(
            select(
                Instance.doc_id,
                Instance.id,
                Instance.current_sequence,
                Instance.resolved_chain,
                HcmPosition.name.label("configured_position_name"),
            )
            .outerjoin(
                Stage,
                and_(
                    Stage.workflow_id == Instance.workflow_id,
                    Stage.sequence == Instance.current_sequence,
                ),
            )
            .outerjoin(HcmPosition, HcmPosition.id == Stage.position_id)
            .where(
                Instance.doc_type == DocType.INDENT.value,
                Instance.doc_id.in_(pending_items),
                Instance.status == InstanceStatus.IN_PROGRESS.value,
            )
            .order_by(Instance.doc_id, Instance.id.desc())
        )).mappings().all()
        positioned: set[int] = set()
        for instance_row in instance_rows:
            indent_id = instance_row["doc_id"]
            if indent_id in positioned:
                continue
            positioned.add(indent_id)
            position_name = instance_row["configured_position_name"]
            for link in instance_row["resolved_chain"] or []:
                if int(link.get("sequence", 0)) == instance_row["current_sequence"]:
                    position_name = link.get("position_name") or position_name
                    break
            if not position_name:
                continue
            row = pending_items[indent_id]
            row["message"] = (
                f"{row['indent_no']} is awaiting approval from "
                f"{position_name} - {row['_approver_name']}."
            )
    for row in items:
        row.pop("_approver_name", None)
    return {
        "items": items,
        "total": total or 0,
        "page": params.page,
        "size": params.size,
    }


# ---------------- allocation endpoints' service layer ----------------
#
# Allocation is a decision ABOUT an indent, so it lives here. The mechanics --
# proposing, reserving, raising the MR -- live in modules/inventory/allocations.py.
# Indents may import inventory (the base module); inventory must never import indents.

_ALLOCATION_ELIGIBLE_STATUSES = {
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
}


def _ensure_allocation_eligible(indent: Indent) -> None:
    if indent.status not in _ALLOCATION_ELIGIBLE_STATUSES:
        raise ValidationError(
            f"Indent {indent.indent_no} is not eligible for allocation in status {indent.status}"
        )


async def allocation_proposal(db: AsyncSession, indent_id: int) -> dict:
    """What the allocation screen needs: the indent lines, what is on the shelf for
    each, split by warehouse, and how much other indents are already waiting on.

    Read-only. Reserves nothing.
    """
    stmt = select(Indent).options(selectinload(Indent.items)).where(
        Indent.id == indent_id)
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")
    _ensure_allocation_eligible(indent)

    lines = [{
        "indent_item_id": line.id,
        "item_id": line.item_id,
        "item_code": line.item_code,
        "item_name": line.item_name,
        "uom_code": line.uom_code,
        "requested_qty": float(line.approved_quantity or line.quantity or 0),
        "already_allocated": float(line.allocated_quantity or 0),
        "project_id": indent.project_id,
    } for line in indent.items]

    proposal = await allocations.propose(db, indent_id, lines)
    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "department_name": indent.department_name,
        "requested_by_name": indent.requested_by_name,
        "status": indent.status,
        "lines": [{**p, "available_total": float(p["available_total"]),
                   "competing_demand": float(p["competing_demand"]),
                   "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                                  for w in p["warehouses"]]}
                  for p in proposal],
    }


async def decide_allocation(db: AsyncSession, body, user):
    """A person has decided how much to give. Record it and send it for approval."""
    indent = await db.get(Indent, body.indent_id)
    if indent is None:
        raise NotFoundError(f"Indent {body.indent_id} not found")
    _ensure_allocation_eligible(indent)

    # Imported here, not at module load: warehouse sits after indents in the import
    # chain, so a top-level import would run it backwards.
    from app.modules.warehouse import service as warehouse_service

    alloc = await allocations.create(
        db, indent.id, indent.indent_no,
        [d.model_dump() for d in body.decisions], user,
        ctx={
            "department_id": indent.department_id,
            "project_id": indent.project_id,
            "project_name": indent.project_name,
            "remarks": body.remarks,
            # The code-level ALLOCATION fallback is the allocator's reporting
            # manager. Without this, a perfectly healthy hierarchy was skipped and
            # every allocation fell through to System Admin.
            "requester_position_id": getattr(user, "active_position_id", None),
        },
        # The ladder can approve at submit (the allocator IS the top of it, or the
        # policy lets him sign his own). The warehouse drafts must be generated then
        # too, exactly as they are when a separate approver acts.
        on_approved=warehouse_service.create_fulfilment_drafts_for_allocation,
    )

    # Approved the moment it was raised, so the indent has to move here too — the
    # act_on_allocation path is never reached and the indent would sit in
    # AWAITING_ALLOCATION forever with its stock already reserved.
    if alloc.status == AllocationStatus.APPROVED.value:
        await _recalculate_indent_allocation_state(db, indent)
        await db.commit()
        await db.refresh(alloc)
    return alloc


async def list_allocations(
    db: AsyncSession,
    params: PageParams,
    status: str | None = None,
    indent_id: int | None = None,
):
    return await allocations.list_allocations(db, params, status, indent_id)


async def get_allocation(db: AsyncSession, allocation_id: int):
    return await allocations.get(db, allocation_id)


async def act_on_allocation(db: AsyncSession, allocation_id: int, action: str, user,
                            comments: str = ""):
    """Approve or reject. Approval reserves the stock and updates the indent."""
    # Imported at the handoff rather than module load: Warehouse reads indent models
    # for fulfilment sources, so a top-level import would make the dependency circular.
    from app.modules.warehouse import service as warehouse_service

    # Read the indent first: approval can raise a material request, and only this side
    # of the chain can tell inventory which project that request belongs to.
    existing = await allocations.get(db, allocation_id)
    indent = await db.get(Indent, existing.indent_id)
    alloc = await allocations.act(
        db, allocation_id, action, user, comments,
        ctx={"project_id": getattr(indent, "project_id", None),
             "project_name": getattr(indent, "project_name", None)},
        on_approved=warehouse_service.create_fulfilment_drafts_for_allocation,
    )

    if alloc.status == AllocationStatus.APPROVED.value:
        indent = await db.get(Indent, alloc.indent_id)
        if indent is not None:
            await _recalculate_indent_allocation_state(db, indent)
            await db.commit()
            await db.refresh(alloc)
    return alloc


async def _recalculate_indent_allocation_state(db: AsyncSession, indent: Indent) -> None:
    stmt = (
        select(
            AllocationItem.indent_item_id,
            func.coalesce(func.sum(AllocationItem.quantity), 0),
        )
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(
            Allocation.indent_id == indent.id,
            Allocation.status == AllocationStatus.APPROVED.value,
        )
        .group_by(AllocationItem.indent_item_id)
    )
    allocated_by_line = {
        indent_item_id: Decimal(str(quantity or 0))
        for indent_item_id, quantity in (await db.execute(stmt)).all()
    }
    total_requested = Decimal("0")
    total_allocated = Decimal("0")

    await db.refresh(indent, attribute_names=["items"])
    for item_line in indent.items:
        requested = Decimal(str(item_line.approved_quantity or item_line.quantity or 0))
        allocated = allocated_by_line.get(item_line.id, Decimal("0"))
        item_line.allocated_quantity = allocated
        if allocated >= requested and requested > 0:
            item_line.status = IndentItemStatus.ALLOCATED.value
        elif indent.status != IndentStatus.AWAITING_ALLOCATION.value or allocated > 0:
            item_line.status = IndentItemStatus.SHORT.value
        else:
            item_line.status = IndentItemStatus.PENDING.value
        total_requested += requested
        total_allocated += allocated

    if total_allocated <= 0:
        indent.status = IndentStatus.PENDING_PROCUREMENT.value
    elif total_requested > 0 and total_allocated >= total_requested:
        indent.status = IndentStatus.ALLOCATED.value
    else:
        indent.status = IndentStatus.PARTIALLY_FULFILLED.value


async def item_demand(db: AsyncSession, item_id: int) -> dict:
    """Every indent still waiting on this item, plus what is on the shelf for it.

    This is the view Balu described: 60 bags of cement, four projects want it, split
    it. Deciding one indent at a time hides the competition, which is exactly the
    information the allocator needs.
    """
    from app.modules.inventory import allocations

    stmt = (
        select(Indent, IndentItem)
        .join(IndentItem, IndentItem.indent_id == Indent.id)
        .where(IndentItem.item_id == item_id,
               Indent.status == IndentStatus.AWAITING_ALLOCATION.value)
        .order_by(Indent.created_at)
    )
    rows = (await db.execute(stmt)).all()

    item = await db.get(Item, item_id)
    proposal = await allocations.propose(db, 0, [
        {"indent_item_id": 0, "item_id": item_id, "project_id": None}])
    stock = proposal[0] if proposal else {"available_total": 0, "warehouses": []}

    return {
        "item_id": item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_code": item.uom_code if item else None,
        "available_total": float(stock["available_total"]),
        "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                       for w in stock["warehouses"]],
        "demand": [{
            "indent_id": ind.id,
            "indent_no": ind.indent_no,
            "indent_item_id": line.id,
            "requested_by_name": ind.requested_by_name,
            "department_name": ind.department_name,
            "project_name": ind.project_name,
            "priority": ind.priority,
            "required_date": ind.required_date.isoformat() if ind.required_date else None,
            "requested_qty": float(line.approved_quantity or line.quantity or 0),
            "raised_at": ind.created_at.isoformat() if ind.created_at else None,
        } for ind, line in rows],
    }
