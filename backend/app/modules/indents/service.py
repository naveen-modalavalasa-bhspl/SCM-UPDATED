"""Indents business logic. THE reference module — copy this shape.

Every state change follows: load -> validate current status -> change -> commit.
Approvals go ONLY through the workflow engine; there is no approval logic here.
"""
import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import BigInteger, DateTime, Numeric, String, and_, case, cast, exists, false, func, literal, or_, select, text, union_all
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only, selectinload

import calendar

from app.core.exceptions import (
    AppException, NotFoundError, PermissionError_, ValidationError,
)
from app.core.pagination import PageParams, paginate
from app.core.dependencies import via_scoped_grant
# inventory is the base module (imports nothing from app.modules), so calling it from
# here is the legal direction. This is the §3 stock-availability fork.
from app.modules.inventory import allocations, locations
from app.modules.inventory import service as inventory_service
from app.modules.inventory.models import (
    Allocation, AllocationItem, MaterialRequest, MaterialRequestItem, PositionLocation, Stock,
    StockTransferOrder,
)
from app.platform.hcm import mappers
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.notifications import service as notifications
from app.platform.rules import evaluator as rules
from app.platform.workflow import engine, ladder
from app.platform.workflow.models import Action, Instance, Stage
from app.platform.workflow.models import Pending
from app.platform.settings import attachments
from app.platform.settings.service import write_audit
from app.platform.settings.models import AuditLog, Notification
from app.platform.rbac import service as rbac_service
from app.platform.rbac import permissions as perms
from app.shared.models.base import utcnow
from app.shared.scope import scope_condition
from app.shared.models.master import Bom, BomGroup, BomItem, Item
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number
from app.modules.indents.enums import (
    AcknowledgmentStatus, AllocationStatus, ApprovalAction, AuditAction,
    ConsolidationStatus, DocType, IndentActivityType, IndentItemStatus, IndentStatus,
    IndentType, InstanceStatus, MRStatus, MaterialDirection, Priority, RuleActionType,
)
from app.modules.inventory.enums import LocationTier
from app.shared.enums import WarehouseType
from app.modules.indents import eligibility
from app.modules.indents.models import Consolidation, Indent, IndentItem, StrSourceChange
from app.modules.indents.schemas import (
    ACK_DAMAGE_REASONS, ACK_REJECTION_LABELS, IndentCreate, IndentItemIn, IndentUpdate,
)
from app.shared.time import now as ist_now, today as ist_today
from app.shared.time import to_ist
from app.shared import uom
from app.shared.masters import combinations


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
INDENT_STATUS_NOTIFICATION_PREFIX = "INDENT_STATUS:"


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
    if required_date < ist_today():
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
    """One line per item PER COMBINATION (2026-10-23): the same item in two brands is
    two lines; twice in the same one is the duplicate this refuses."""
    keys = [(line.item_id, int(getattr(line, "brand_id", 0) or 0),
             int(getattr(line, "variant_id", 0) or 0), int(getattr(line, "model_id", 0) or 0),
             bool(getattr(line, "combination_any", False)))
            for line in items]
    if len(keys) != len(set(keys)):
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

    Scoped by the SAME predicate the ledger rows are, rung included — a SELF login sees
    only the regions its own indents were raised in, a SUBTREE login also sees the ones
    its reporting line covers. With the access rule alone the dropdown listed regions
    whose rows the ledger then refused to show, which reads as a broken filter and
    quietly names locations the login is not entitled to know about.
    """
    stmt = (
        select(Indent.region_id, Indent.region_name)
        .where(Indent.region_id.is_not(None))
        .distinct()
        .order_by(Indent.region_name)
    )
    if user is not None:
        stmt = stmt.where(await _indent_visibility(db, user))
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


# ---------------- Stock Transfer's scoped grants (require_permission_or) ----------------
# An STR is an indent, so its approval, serving and receipt run on this module's
# endpoints. The `stock.transfer.*` codes reach them through
# `core.dependencies.require_permission_or`; these say whether THIS request's document
# is an STR. No document in the path → True, and the service narrows instead.

async def _is_str(db: AsyncSession, indent_id) -> bool:
    if indent_id is None:
        return False
    return await db.scalar(select(Indent.indent_type).where(
        Indent.id == int(indent_id))) == IndentType.STR.value


async def str_in_reach(db: AsyncSession, request, user) -> bool:
    indent_id = request.path_params.get("indent_id")
    return True if indent_id is None else await _is_str(db, indent_id)


async def str_allocation_in_reach(db: AsyncSession, request, user) -> bool:
    allocation_id = request.path_params.get("allocation_id")
    if allocation_id is not None:
        return await _is_str(db, await db.scalar(
            select(Allocation.indent_id).where(Allocation.id == int(allocation_id))))
    return await str_in_reach(db, request, user)


async def anywhere_in_reach(db: AsyncSession, request, user) -> bool:
    """Read-only option lists an STR form needs; already scoped to the login."""
    return True


async def _assert_can_raise_str(db: AsyncSession, user) -> None:
    """An STR is raised through the indent routes, so its own permission is checked
    here — the route's `indent.create` alone must not let anybody request a transfer."""
    user_perms = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None))
    if perms.STOCK_TRANSFER_REQUEST not in user_perms:
        raise PermissionError_("You are not allowed to raise a stock transfer request")


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    _validate_required_date(data.required_date)
    priority = _validate_priority(data.priority) or Priority.NORMAL.value
    indent_type = _validate_indent_type(
        getattr(data, "indent_type", None)) or IndentType.REGULAR.value

    if indent_type == IndentType.STR.value:
        await _assert_can_raise_str(db, user)
    elif via_scoped_grant(db, perms.INDENT_CREATE):
        # The create route also admits `stock.transfer.request` (for an STR); that
        # grant alone must never raise an ordinary indent.
        raise PermissionError_("Missing permission: indent.create")
    if not data.items:
        raise ValidationError("Indent must have at least one item")
    _validate_item_quantities(data.items)
    _validate_unique_item_ids(data.items)

    items_map = await _items_by_id(db, [line.item_id for line in data.items])
    missing = {line.item_id for line in data.items} - set(items_map)
    if missing:
        raise ValidationError(f"Unknown item ids: {sorted(missing)}")

    # Role/region item tagging. Runs on the WRITE path, not only in the picker: the
    # picker narrows what is offered, but the request body carries whatever item id
    # the caller sent, so this is the check that decides (rule 6). No-op until an
    # administrator tags an item — see `eligibility` for why the default is open.
    await eligibility.assert_items_allowed(
        db, user, [line.item_id for line in data.items])

    # Ahead of next_number(): a rejected vehicle must not burn a document number.
    vehicle_id, vehicle_number = await _resolve_vehicle(
        db, getattr(data, "vehicle_id", None))
    # An STR says where the stock comes FROM (2026-11-04); refused before a number is
    # minted, for the same reason as the vehicle above.
    source = (await _resolve_str_source(db, getattr(data, "source_warehouse_id", None))
              if indent_type == IndentType.STR.value else None)

    indent_date = utcnow().date()
    if indent_type == IndentType.MONTHLY.value:
        from app.platform.monthly_indent import service as monthly_indent_service
        await monthly_indent_service.assert_can_submit_monthly(db, user)
        indent_date = await monthly_indent_service.local_today(db)

    context = await _requester_context(db, user)
    total_qty = sum(line.quantity for line in data.items)
    indent = Indent(
        # An STR carries its own series (STR prefix) so a transfer is never read as an
        # indent on paper.
        indent_no=await next_number(
            db, "str" if indent_type == IndentType.STR.value else "indent",
            project=context["project_name"]),
        indent_type=indent_type,
        indent_date=indent_date,
        required_date=data.required_date,
        vehicle_id=vehicle_id,
        vehicle_number=vehicle_number,
        source_warehouse_id=source.id if source else None,
        source_warehouse_name=source.name if source else None,
        source_warehouse_code=source.code if source else None,
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
            **await combinations.resolve(db, item.id, line, allow_any=True, default_any=True,
                                         label=f"Line {line_no} ({item.name})"),
        ))
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": indent.status, "total_items": indent.total_items,
               "indent_type": indent.indent_type,
               "vehicle_number": indent.vehicle_number,
               "source_warehouse_name": indent.source_warehouse_name},
    )
    await notify_indent_status_event(
        db,
        indent,
        IndentStatus.DRAFT.value,
        [indent.requested_by_id],
        actor=user,
    )
    await db.commit()
    await db.refresh(indent)
    return await _attach_office_sac(db, indent)


def _values(values) -> list[str]:
    return [value.value for value in values or []]


def unknown_indent_statuses(statuses) -> set[str]:
    known = {status.value for status in IndentStatus}
    return {str(status) for status in statuses if status is not None and str(status) not in known}


def _workflow_context_for_indent(indent: Indent) -> dict:
    is_str = getattr(indent, "indent_type", None) == IndentType.STR.value
    return {
        # An STR is an indent on its own ladder: the instance stays INDENT (inbox, deep
        # links, approve permission), only the ladder lookup reads the STR's chain.
        **({engine.LADDER_DOC_TYPE_KEY: DocType.STOCK_TRANSFER_REQUEST.value}
           if is_str else {}),
        "doc_no": indent.indent_no,
        "doc_summary": (f"Stock transfer request {indent.indent_no}" if is_str
                        else f"Indent {indent.indent_no}"),
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
        IndentStatus.PARTIALLY_ALLOCATED.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.PARTIALLY_ORDERED.value,
        IndentStatus.ORDERED.value,
        IndentStatus.CLOSED.value,
    ]


async def _served_points(db: AsyncSession, user) -> set[int] | None:
    """The stocking points whose fulfilment work this login does (2026-11-02), or
    None when it is the CENTRAL desk and serves every indent.

    Read off the shelf the hat in hand holds (`locations.held_location_ids`, per POST):
    an LIP serves itself; an MDP serves itself and every LIP under it
    (`locations.parent_points`); a main warehouse — or a login holding no point at
    all, the SCM desk that has always worked the whole queue — serves everyone.

    Before this the SCM stage was gated on PERMISSIONS alone, so an LIP store keeper
    holding `stock.view` (which his Stock screens need) read every indent past approval
    in the company: Puthalapattu's store keeper listed Punganur's and Nr Peta's.
    """
    cache = db.info.setdefault("served_points_memo", {}) if isinstance(getattr(db, "info", None), dict) else {}
    hat = getattr(user, "active_position_id", None)
    key = (user.id, hat)
    if key in cache:
        return cache[key]

    posts = {hat} if hat is not None else await locations.active_positions_of(db, user)
    held: set[int] = set()
    for position_id in posts:
        held |= await locations.held_location_ids(db, position_id, subtree=False)
    if not held:
        cache[key] = None
        return None
    types = dict((await db.execute(
        select(Warehouse.id, Warehouse.warehouse_type).where(Warehouse.id.in_(held))
    )).all())
    if any(locations.tier_of(types.get(w)) == LocationTier.WAREHOUSE for w in held):
        cache[key] = None
        return None

    served = set(held)
    mdps = {w for w in held if locations.tier_of(types.get(w)) == LocationTier.MDP}
    if mdps:
        lips = set((await db.execute(
            select(Warehouse.id).where(Warehouse.warehouse_type == WarehouseType.LIP.value)
        )).scalars().all())
        parents = await locations.parent_points(db, lips)
        served |= {lip for lip, parent in parents.items() if parent in mdps}
    cache[key] = served
    return served


async def _scm_stage_condition(db: AsyncSession, user):
    """Indents past approval that are this login's FULFILMENT work, or None.

    The permission check says whether the login works the inventory stage at all;
    `_served_points` says WHERE. An indent belongs to the point linked to the post
    that raised it (`inv_position_locations` — the same link that answers "which point
    serves this post"), and an STR also to the point its transfer order is bound for.
    """
    scm_statuses = await _scm_stage_statuses(db, user)
    if not scm_statuses:
        return None
    at_stage = Indent.status.in_(scm_statuses)
    served = await _served_points(db, user)
    if served is None:
        return at_stage
    raised_here = Indent.position_id.in_(
        select(PositionLocation.position_id).where(
            PositionLocation.warehouse_id.in_(served),
            PositionLocation.is_active == 1,
        )
    )
    return and_(at_stage, or_(raised_here, str_addressed_to(served)))


async def indent_access_condition(db: AsyncSession, user):
    """Central visibility scope for indents.

    Role permissions open endpoints and UI actions. This SQL predicate limits which
    records the authenticated employee may actually see.

    Built once per request and reused (see shared/scope.py `_memo`). The clause is
    keyed by the login AND the position they are wearing, which is exactly what it is
    derived from, so a session that switches hats builds a new one. Its subqueries stay
    live — `wf_pending` and `wf_actions` are read when the SQL runs, not when the
    clause is assembled — so reusing it is reusing a predicate, never a result set.
    A batch approval asked for the identical clause once per indent and paid nine
    round trips each time to rebuild it.
    """
    session_info = getattr(db, "info", None)
    cache = session_info.setdefault("indent_access_memo", {}) if isinstance(session_info, dict) else {}
    key = (user.id, getattr(user, "active_position_id", None))
    if key in cache:
        return cache[key]

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

    visible.append(await indent_participant_condition(db, user))

    # Inventory works the fulfilment queue for requests it neither raised nor approved,
    # and the SCM department sits on posts with no children, so no branch above can ever
    # show them one. Holding the SCM read permissions does — and only from the point the
    # request reaches inventory, never before approval.
    scm_stage = await _scm_stage_condition(db, user)
    if scm_stage is not None:
        visible.append(scm_stage)

    clause = or_(*visible)
    cache[key] = clause
    return clause


async def indent_participant_condition(db: AsyncSession, user):
    """Indents this login is a PARTY to: awaiting their signature, or carrying a
    decision they took in the hat they are wearing.

    One definition, read twice — by `indent_access_condition` as one of the ways a
    document can be your business, and by `_indent_visibility` as the one thing no
    rung may take away. Two copies that could disagree is how an approver comes to
    be told a document they are holding does not exist.
    """
    session_info = getattr(db, "info", None)
    cache = session_info.setdefault("indent_participant_memo", {}) if isinstance(session_info, dict) else {}
    key = (user.id, getattr(user, "active_position_id", None))
    if key in cache:
        return cache[key]

    _, position = await _current_assignment(db, user)
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
    clause = Indent.id.in_(select(Instance.doc_id).where(
        Instance.doc_type == DocType.INDENT.value,
        or_(*participant_conditions),
    ))
    cache[key] = clause
    return clause


async def own_shelf_points(db: AsyncSession, user) -> set[int]:
    """The stocking points whose SHELF this login holds, across every live post —
    never its reportees'. Signing for a delivery is "it reached MY shelf"."""
    points: set[int] = set()
    for position_id in await locations.active_positions_of(db, user):
        points |= await locations.held_location_ids(db, position_id, subtree=False)
    return points


def str_addressed_to(points: set[int]):
    """An STR served by a Stock Transfer Order bound for one of these points
    (2026-10-29). The destination storekeeper is a party to that delivery: anyone who
    holds the receiving shelf may see it arrive and sign for it, not only the person
    who happened to raise it. One rule for the list, the read and the sign-off."""
    if not points:
        return false()
    return and_(
        Indent.indent_type == IndentType.STR.value,
        select(StockTransferOrder.id)
        .where(StockTransferOrder.str_id == Indent.id,
               StockTransferOrder.to_warehouse_id.in_(points))
        .correlate(Indent).exists(),
    )


async def _receives_str(db: AsyncSession, indent: Indent, user) -> bool:
    """Is this login a receiver of this STR by holding the shelf it is bound for?"""
    if indent.indent_type != IndentType.STR.value:
        return False
    points = await own_shelf_points(db, user)
    return bool(points) and bool(await db.scalar(
        select(func.count()).select_from(StockTransferOrder)
        .where(StockTransferOrder.str_id == indent.id,
               StockTransferOrder.to_warehouse_id.in_(points))))


async def _indent_visibility(db: AsyncSession, user):
    """Both halves of "may this login read this indent": the access rule AND the rung.

    `indent_access_condition` answers "is this document any of my business" — I raised
    it, I am approving it, it reached the stage my department works. The profile's
    scope rung (Settings > Job Profiles) answers a different question: "whose rows may
    I read at all" — only mine, my office, my reporting line, my project, everything.

    Both have to hold. Applying only the first is what let a SELF-scoped lab
    technician open 102 indents on /indents while Home — which already ANDed the two —
    showed 2 for the same login. Every indent reader goes through here so the list,
    the dashboard and the tile can never drift apart again.

    Except for one thing a rung may never take away: a document this login is a PARTY
    to. The rung answers "whose rows may I read", and a document waiting on my
    signature is not somebody else's row — it was handed to me. ANDing it away means
    the inbox lists an approval the review screen then 404s, which is a document
    stranded in the ladder with nobody able to move it. It is OR-ed OUTSIDE the AND
    for the same reason `scope_condition` always OR-s in `mine`: narrow the rung and
    you narrow whose work you see, never whether you can do your own.
    """
    scm_stage = await _scm_stage_condition(db, user)
    branches = [await indent_participant_condition(db, user)]
    if scm_stage is not None:
        branches.append(scm_stage)
    branches.append(
        and_(
            await indent_access_condition(db, user),
            await scope_condition(
                db, user,
                owner_col=Indent.requested_by_id,
                position_col=Indent.position_id,
                office_col=Indent.office_id,
                project_col=Indent.project_id,
            ),
        )
    )
    return or_(*branches)


async def _assert_can_view_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    stmt = (
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
        .where(await _indent_visibility(db, user))
    )
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if not indent:
        # The receiving point of an STR may read the one document it is signing for
        # even when its rung would not list it (2026-10-29). Asked only on a miss, so
        # every read the scope already answers costs nothing more.
        candidate = (await db.execute(
            select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
        )).scalar_one_or_none()
        if candidate is not None and await _receives_str(db, candidate, user):
            return candidate
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


async def _assert_active_workflow_task(db: AsyncSession, indent_id: int, user_id: int, user=None) -> None:
    if not await _has_pending_approval(db, indent_id, user_id):
        if user is not None:
            from app.platform.workflow.engine import is_workflow_admin
            if await is_workflow_admin(db, user):
                return
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
    # No ladder on this instance at all (`resolved_chain` is only ever frozen by a
    # ladder-routed submit — engine.py) means a classic, stage-based workflow, where
    # a rung is not a rank one person can hold through several positions. The caller
    # (`_pending_indent_return_instance`) already proved this user is the pending
    # approver at the CURRENT stage, which is the whole question on that workflow —
    # there is no second position of theirs to disambiguate. Without this, every
    # classic-workflow indent answered `_current_workflow_link` with None and Correction
    # never offered itself to anyone (SCM_0078), because the ladder-only check below
    # ran on indents that were never on a ladder.
    if not instance.resolved_chain:
        return True

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
    # An owner who is not already the requester can pass it further back.
    indent.can_send_correction_back = bool(
        indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value
        and is_correction_owner
        and await engine.get_correction_send_back_targets(
            db, DocType.INDENT.value, indent.id, user, _workflow_context_for_indent(indent))
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
    return await _attach_office_sac(db, indent)


async def _attach_office_sac(db: AsyncSession, indent: Indent) -> Indent:
    """Stamp the delivery office's service area code onto the indent for display.

    Resolved from `indent.office_id`, never from the viewer: a detail screen is read
    by approvers and store keepers who sit at other offices, and the SAC has to be
    the delivering office's own. An office HCM holds no SAC for stays None.

    Attached here rather than only in `get_indent` so the same indent carries a SAC
    whichever single-document call returned it — submit, approve, return and resubmit
    all hand the caller an `IndentOut`, and the field would otherwise blank out on
    the detail screen the moment an action refreshed it. Single-document only: no
    list path calls `_attach_capabilities`, so this costs no per-row lookups.
    """
    office = await db.get(HcmOffice, indent.office_id) if indent.office_id else None
    indent.office_sac = mappers.office_sac(office.raw) if office else None
    return await _attach_str_route(db, indent)


async def _resolve_str_source(db: AsyncSession, warehouse_id: int | None) -> Warehouse:
    """The source point an STR names. Required — an approver decides whether the
    point is theirs, and cannot decide that about nothing."""
    if not warehouse_id:
        raise ValidationError("Choose the source point this transfer should come from")
    point = await db.get(Warehouse, int(warehouse_id))
    if point is None or not point.is_active:
        raise ValidationError("That source point no longer exists or is inactive")
    return point


async def str_destination_point(db: AsyncSession, indent: Indent) -> int | None:
    """The point an STR (or any indent) is delivered INTO: the shelf the raising post
    holds, else its primary link, else the stocking point of its office."""
    held = await locations.held_location_ids(db, indent.position_id, subtree=False)
    if held:
        return min(held)
    primary = await locations.primary_location_for(db, indent.position_id)
    if primary:
        return primary
    if indent.office_id:
        return await db.scalar(
            select(Warehouse.id).where(Warehouse.office_id == indent.office_id,
                                       Warehouse.is_active.is_(True))
            .order_by(Warehouse.id).limit(1))
    return None


def _point_out(point: Warehouse | None, held_by: list[str] | None = None) -> dict | None:
    if point is None:
        return None
    tier = locations.tier_of(point.warehouse_type)
    return {
        "warehouse_id": point.id, "warehouse_code": point.code,
        "warehouse_name": point.name, "warehouse_type": point.warehouse_type,
        "tier_label": locations.tier_label(tier), "held_by": held_by or [],
    }


async def _attach_str_route(db: AsyncSession, indent: Indent) -> Indent:
    """Single-document only: where the goods land, whether that point takes a vehicle
    and an SAC, and — on an STR — where they come from and every move of the source.

    `needs_vehicle_and_sac` is the delivery point's TIER, read off the master: only the
    bottom rung of the chain runs a vehicle and carries a service area code. No point
    type is named here, so a chain that grows a rung keeps the rule."""
    destination_id = await str_destination_point(db, indent)
    destination = await db.get(Warehouse, destination_id) if destination_id else None
    bottom = max(LocationTier)
    indent.needs_vehicle_and_sac = (
        None if destination is None
        else locations.tier_of(destination.warehouse_type) == bottom)
    indent.str_destination = None
    indent.str_source = None
    indent.str_source_changes = []
    if indent.indent_type != IndentType.STR.value:
        return indent
    source = (await db.get(Warehouse, indent.source_warehouse_id)
              if indent.source_warehouse_id else None)
    held = await locations.point_holder_names(
        db, {p.id for p in (source, destination) if p is not None})
    indent.str_destination = _point_out(destination, held.get(destination_id))
    indent.str_source = _point_out(source, held.get(indent.source_warehouse_id))
    if source is None and indent.source_warehouse_name:
        indent.str_source = {"warehouse_id": indent.source_warehouse_id,
                             "warehouse_code": indent.source_warehouse_code,
                             "warehouse_name": indent.source_warehouse_name,
                             "held_by": []}
    indent.str_source_changes = list((await db.execute(
        select(StrSourceChange).where(StrSourceChange.indent_id == indent.id)
        .order_by(StrSourceChange.id))).scalars().all())
    return indent


async def str_sources_in_use(db: AsyncSession, user) -> list[dict]:
    """The source points named on the STRs this login may read — the Requests tab's
    Source filter, so it offers exactly the points the list can narrow to."""
    rows = (await db.execute(
        select(Indent.source_warehouse_id, func.max(Indent.source_warehouse_name))
        .where(Indent.indent_type == IndentType.STR.value,
               Indent.source_warehouse_id.is_not(None),
               await _indent_visibility(db, user))
        .group_by(Indent.source_warehouse_id)
    )).all()
    return sorted(({"value": wid, "label": name or f"Point {wid}"} for wid, name in rows),
                  key=lambda o: o["label"].lower())


async def str_source_options(db: AsyncSession, user) -> list[dict]:
    """The points an STR raised by this login may name as its source — the shelves
    held at the same HCM rank, network-wide, less the raiser's own."""
    return await locations.same_rank_points(db, user)


async def change_str_source(db: AsyncSession, indent: Indent, warehouse_id: int, user,
                            *, reason: str, stage_name: str | None = None) -> None:
    """Move an STR's source point and record the move. Called by the approver who
    pulls a request onto one of their own points; the caller checks that the point is
    in their scope. Not committed here — the caller allocates in the same transaction."""
    point = await _resolve_str_source(db, warehouse_id)
    if indent.source_warehouse_id == point.id:
        return
    position_id = getattr(user, "active_position_id", None)
    db.add(StrSourceChange(
        indent_id=indent.id,
        from_warehouse_id=indent.source_warehouse_id,
        from_warehouse_name=indent.source_warehouse_name,
        to_warehouse_id=point.id, to_warehouse_name=point.name,
        stage_name=stage_name, reason=(reason or "").strip()[:500] or None,
        changed_by_id=user.id, changed_by_name=getattr(user, "full_name", None),
        position_name=(await db.scalar(select(HcmPosition.name).where(
            HcmPosition.id == position_id))) if position_id else None,
    ))
    before = indent.source_warehouse_name
    indent.source_warehouse_id = point.id
    indent.source_warehouse_name = point.name
    indent.source_warehouse_code = point.code
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"source_warehouse_name": before},
        after={"source_warehouse_name": point.name, "reason": reason},
        summary=f"Source moved from {before or 'none'} to {point.name}",
    )


async def _attach_brand_changes(db: AsyncSession, indent: Indent) -> Indent:
    """Per indent line, every allocation that gave ANOTHER brand than it asked for
    (2026-10-24) — what was given, how much, and why — so the requester reads the
    change on their own indent. Rejected and cancelled allocations gave nothing."""
    ids = [line.id for line in (indent.items or [])]
    rows = (await db.execute(
        select(AllocationItem, Allocation.allocation_no)
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(AllocationItem.indent_item_id.in_(ids or [0]),
               AllocationItem.substituted_from.isnot(None),
               AllocationItem.quantity > 0,
               Allocation.status.notin_((AllocationStatus.REJECTED.value,
                                         AllocationStatus.CANCELLED.value)))
        .order_by(AllocationItem.id))).all()
    by_line: dict[int, list[dict]] = {}
    for item, allocation_no in rows:
        by_line.setdefault(item.indent_item_id, []).append({
            "asked_for": item.substituted_from,
            "given": " · ".join(p for p in (item.brand_name, item.variant_name,
                                             item.model_name) if p) or "No brand",
            "quantity": float(item.quantity or 0),
            "reason": item.substitution_reason,
            "allocation_no": allocation_no,
        })
    for line in indent.items or []:
        setattr(line, "brand_changes", by_line.get(line.id, []))
    return indent


async def get_indent(db: AsyncSession, indent_id: int, user=None) -> Indent:
    if user is not None:
        # RBAC-scoped: `_assert_can_view_indent` decides whether this user may see the
        # indent at all, and the SAC rides on the indent it returns — an indent nobody
        # is allowed to read never reaches `_attach_office_sac`.
        indent = await _assert_can_view_indent(db, indent_id, user)
        return await _attach_brand_changes(db, await _attach_capabilities(db, indent, user))
    indent = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return await _attach_office_sac(db, indent)


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
        .where(await _indent_visibility(db, user))
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
            Indent.created_at >= datetime.combine(date_from, time.min)
        )
    if date_to:
        stmt = stmt.where(
            Indent.created_at
            < datetime.combine(date_to + timedelta(days=1), time.min)
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
    to_serve: bool = False,
    source_warehouse_id: int | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
) -> dict:
    _validate_indent_date_ranges(
        date_from, date_to, required_by_from, required_by_to,
    )
    stmt = select(Indent).options(selectinload(Indent.items))
    if user is not None:
        stmt = stmt.where(await _indent_visibility(db, user))
    stmt = _apply_indent_filters(
        stmt, search=search, date_from=date_from, date_to=date_to,
        required_by_from=required_by_from, required_by_to=required_by_to,
        statuses=statuses, priorities=priorities, indent_types=indent_types,
        department_ids=department_ids, region_ids=region_ids,
        include_unassigned_region=include_unassigned_region,
        is_bookmarked=is_bookmarked,
    )
    if source_warehouse_id:
        stmt = stmt.where(Indent.source_warehouse_id == source_warehouse_id)
    if to_serve and user is not None:
        # The fulfilment queue asks a narrower question than /indents does: not "may I
        # read this" but "is there fulfilment work in it FOR ME".
        #
        # An indent still climbing is only the current rung's to serve — he issues what
        # he holds from the approval screen, the remainder travels on. Everyone else it
        # has passed keeps READING it (they approved it; `indent_access_condition` keeps
        # them as participants, which is right for /indents and the journey), but it is
        # no longer work sitting in front of them. Without this, an OE who approved and
        # forwarded IND/2026-27/00661 still found it in his queue with the document
        # parked two rungs up on the District Manager.
        #
        # Only PENDING_APPROVAL is touched. Everything past approval is the inventory
        # desk's own queue and is left exactly as it was — who gets those rows is a
        # question of which login holds `allocation.view`, decided in RBAC, not here.
        stmt = stmt.where(or_(
            Indent.status != IndentStatus.PENDING_APPROVAL.value,
            Indent.id.in_(
                select(Pending.doc_id).where(
                    Pending.doc_type == DocType.INDENT.value,
                    Pending.approver_id == user.id,
                )
            ),
        ))
        # An approved STR is served at its SOURCE point's desk (2026-11-04): the last
        # approver signed it without the source in their scope, so the work belongs to
        # whoever can draw from that point. A desk with unrestricted reach (None) still
        # sees every one; an STR with no source on record is left as it always was.
        drawable = await inventory_service.drawable_warehouse_ids(db, user)
        if drawable is not None:
            stmt = stmt.where(or_(
                Indent.indent_type != IndentType.STR.value,
                Indent.status == IndentStatus.PENDING_APPROVAL.value,
                Indent.source_warehouse_id.is_(None),
                Indent.source_warehouse_id.in_(drawable or {0}),
            ))
    if has_remainder:
        # At least one line still owes something. EXISTS rather than a join, so an
        # indent with three unfulfilled lines is still one row in the queue.
        #
        # LOAD-BEARING since 2026-08-21. An approved allocation is terminal
        # (`inventory.allocations`, module docstring), so nothing wakes a part-served
        # indent any more — THIS arithmetic is the only thing that brings it back to
        # the Fulfilment Desk once the shelf can serve it again. Narrow any of the
        # three terms and an indent silently stops being servable, with no error and
        # nothing in a log to say so. Widen them and the desk is offered quantity
        # somebody is already buying. Both failure modes are silent, which is why the
        # three terms are spelled out below rather than folded into one expression.
        #
        # Live allocations count against the remainder as well as approved ones:
        # `allocated_quantity` does not move until an allocation is signed off, so a
        # line an approver has just committed would otherwise sit in the queue looking
        # untouched and invite a second allocation for the same goods.
        # UNAPPROVED, not ACTIVE: `allocated_quantity` on the right-hand side already
        # holds every APPROVED line, and counting those here as well subtracted them
        # twice — a line owing 16 with 6 approved read as fully covered.
        committed = (
            select(func.coalesce(func.sum(AllocationItem.quantity), 0))
            .join(Allocation, Allocation.id == AllocationItem.allocation_id)
            .where(
                AllocationItem.indent_item_id == IndentItem.id,
                Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES),
            )
            .correlate(IndentItem)
            .scalar_subquery()
        )
        # A shortage already handed to procurement is not fulfilment work either. The
        # allocation that gave nothing is APPROVED — deliberately left visible above so
        # the rung ABOVE can still serve what it did not cover — but once that remainder
        # has become a live material request, nobody in inventory can act on it and the
        # row only invites an allocation the backend will refuse. Counted like
        # `committed`, so a partly-ordered line still shows what is genuinely owed.
        on_order = (
            select(func.coalesce(func.sum(_MR_STILL_COMING), 0))
            .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
            .where(
                MaterialRequestItem.indent_item_id == IndentItem.id,
                MaterialRequest.status.notin_(_SETTLED_MR_STATUSES),
            )
            .correlate(IndentItem)
            .scalar_subquery()
        )
        # If warehouse stock has arrived for this item, on_order stops hiding the
        # indent: the goods are on the shelf and ready to be allocated.
        free_stock = (
            select(func.coalesce(func.sum(Stock.available_qty), 0))
            .where(
                Stock.item_id == IndentItem.item_id,
                or_(Stock.expiry_date.is_(None), Stock.expiry_date >= ist_today()),
            )
            .correlate(IndentItem)
            .scalar_subquery()
        )
        effective_on_order = func.greatest(on_order - free_stock, 0)
        # The SQL twin of `owed_quantity`: what the approver granted, falling back to
        # what was asked for. Reading `approved_quantity` raw hid every line that
        # predates the approval flow and carries 0 there — 69 of the live ones — so the
        # queue refused to offer indents `create_allocation_for_indent` would have
        # accepted an allocation for. The two must agree; this is the half that was
        # wrong.
        owed_qty = func.coalesce(
            func.nullif(IndentItem.approved_quantity, 0), IndentItem.quantity,
        )
        stmt = stmt.where(exists(
            select(IndentItem.id).where(
                IndentItem.indent_id == Indent.id,
                IndentItem.is_excluded.is_(False),
                owed_qty > IndentItem.allocated_quantity + committed + effective_on_order,
            ).correlate(Indent)
        ))
        # An allocation still awaiting approval takes the indent out of the queue
        # whatever it GAVE. The arithmetic above measures a pending allocation by its
        # quantity, so the one decision that gives nothing — every line short, the whole
        # requirement handed to procurement — subtracted nothing and left the row
        # sitting there as if it had never been raised: the material request that would
        # have covered it is only written at approval (`allocations.apply_to_stock`).
        # The desk pressed Submit, saw the row again and pressed again, and got the
        # write guard's refusal.
        #
        # Existence, not quantity, and only the UNAPPROVED ones — an APPROVED
        # allocation deliberately leaves the row for the rung above to serve the
        # remainder (`ensure_no_active(allow_approved=True)`), which the arithmetic
        # already handles. Nobody can allocate against an unapproved one anyway: the
        # guard refuses every login, so hiding the row hides work that does not exist
        # rather than work somebody else could do.
        stmt = stmt.where(~exists(
            select(Allocation.id).where(
                Allocation.indent_id == Indent.id,
                Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES),
            ).correlate(Indent)
        ))
    id_tie_breaker = Indent.id.asc() if sort_dir.lower() == "asc" else Indent.id.desc()
    stmt = stmt.order_by(_indent_sort(sort_by, sort_dir), id_tie_breaker)
    page_data = await paginate(db, stmt, params)
    await _enrich_indents_with_operational_status(db, page_data.get("items", []))
    return page_data


async def _enrich_indents_with_operational_status(db: AsyncSession, indents: list[Indent]) -> None:
    """Enrich list view indents with their real-time downstream operational stage."""
    candidate_indents = [
        ind for ind in indents
        if ind.status in (
            IndentStatus.ALLOCATED.value,
            IndentStatus.PARTIALLY_ALLOCATED.value,
            IndentStatus.APPROVED.value,
            IndentStatus.AWAITING_ALLOCATION.value,
        )
    ]
    if not candidate_indents:
        return

    from collections import defaultdict
    from app.modules.warehouse.models import MaterialIssue, OutboundInspection, Dispatch, DispatchSource
    from app.modules.warehouse.enums import IssueDirection

    candidate_ids = [ind.id for ind in candidate_indents]
    issues = (await db.execute(
        select(MaterialIssue.id, MaterialIssue.indent_id, MaterialIssue.is_stock_posted, MaterialIssue.status)
        .where(
            MaterialIssue.indent_id.in_(candidate_ids),
            MaterialIssue.direction == IssueDirection.OUT.value,
        )
    )).all()

    if not issues:
        return

    indent_issue_ids: dict[int, list[int]] = defaultdict(list)
    issue_ids = []
    for issue in issues:
        indent_issue_ids[issue.indent_id].append(issue.id)
        issue_ids.append(issue.id)

    # QC Inspections
    inspections = (await db.execute(
        select(OutboundInspection.issue_id, OutboundInspection.status)
        .where(OutboundInspection.issue_id.in_(issue_ids))
        .order_by(OutboundInspection.id.desc())
    )).all()
    issue_qcs: dict[int, list] = defaultdict(list)
    for qc in inspections:
        issue_qcs[qc.issue_id].append(qc)

    # Dispatches - direct
    dispatches_direct = (await db.execute(
        select(Dispatch.id, Dispatch.ref_id, Dispatch.status, Dispatch.gate_out_at, Dispatch.delivered_at)
        .where(
            Dispatch.ref_id.in_(issue_ids),
            Dispatch.ref_type.in_(("WH_ISSUE", "MATERIAL_ISSUE", "ISSUE")),
        )
        .order_by(Dispatch.id.desc())
    )).all()
    issue_dispatches: dict[int, list] = defaultdict(list)
    for d in dispatches_direct:
        issue_dispatches[d.ref_id].append(d)

    # Dispatches - via DispatchSource
    sources = (await db.execute(
        select(DispatchSource.dispatch_id, DispatchSource.issue_id)
        .where(DispatchSource.issue_id.in_(issue_ids))
    )).all()
    if sources:
        dispatch_ids = [s.dispatch_id for s in sources]
        source_dispatches = (await db.execute(
            select(Dispatch.id, Dispatch.status, Dispatch.gate_out_at, Dispatch.delivered_at)
            .where(Dispatch.id.in_(dispatch_ids))
            .order_by(Dispatch.id.desc())
        )).all()
        dispatch_by_id = {d.id: d for d in source_dispatches}
        for s in sources:
            if s.dispatch_id in dispatch_by_id:
                issue_dispatches[s.issue_id].append(dispatch_by_id[s.dispatch_id])

    for ind in candidate_indents:
        i_ids = indent_issue_ids.get(ind.id, [])
        all_d = [d for i_id in i_ids for d in issue_dispatches.get(i_id, [])]
        all_q = [q for i_id in i_ids for q in issue_qcs.get(i_id, [])]

        if any(d.delivered_at is not None or str(d.status or "").upper() == "DELIVERED" for d in all_d):
            ind.status = IndentStatus.DELIVERED.value
        elif any(d.gate_out_at is not None or str(d.status or "").upper() in ("DISPATCHED", "GATED_OUT", "IN_TRANSIT") for d in all_d):
            ind.status = IndentStatus.IN_TRANSIT.value
        elif all_d:
            ind.status = IndentStatus.IN_CONSIGNMENT.value
        elif any(str(q.status or "").upper() in ("COMPLETED", "PASSED") for q in all_q):
            ind.status = IndentStatus.QC_PASSED.value
        elif all_q:
            ind.status = IndentStatus.QC_IN_PROGRESS.value


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
        "source_warehouse_name": indent.source_warehouse_name,
    }
    indent.required_date = data.required_date
    if data.priority is not None:
        indent.priority = _validate_priority(data.priority)
    if data.indent_type is not None:
        new_type = _validate_indent_type(data.indent_type)
        # The number was minted from the type's own series (IND vs STR); flipping an
        # STR into an indent, or back, would leave a document numbered as the other.
        if (new_type == IndentType.STR.value) != (indent.indent_type == IndentType.STR.value):
            raise ValidationError(
                "A stock transfer request cannot be turned into an indent, or back — "
                "raise a new document instead")
        indent.indent_type = new_type
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
    if (indent.indent_type == IndentType.STR.value
            and "source_warehouse_id" in data.model_fields_set):
        source = await _resolve_str_source(db, data.source_warehouse_id)
        indent.source_warehouse_id = source.id
        indent.source_warehouse_name = source.name
        indent.source_warehouse_code = source.code

    if data.items is not None:
        if not data.items:
            raise ValidationError("Indent must have at least one item")
        # Same gate as create: an edit can introduce a line the requester may not ask
        # for, and it arrives by the same JSON route.
        await eligibility.assert_items_allowed(
            db, user, [line.item_id for line in data.items])
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
                **await combinations.resolve(db, item.id, line, allow_any=True,
                                             default_any=True,
                                             label=f"Line {line_no} ({item.name})"),
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
            "source_warehouse_name": indent.source_warehouse_name,
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
    if indent.indent_type == IndentType.STR.value and not indent.source_warehouse_id:
        # A draft saved before the field existed: it has to say where the stock comes
        # from before an approver can judge whether that point is theirs.
        raise ValidationError(
            "Choose the source point this transfer should come from, then submit")

    if indent.indent_type == IndentType.MONTHLY.value:
        from app.platform.monthly_indent import service as monthly_indent_service
        await monthly_indent_service.assert_can_submit_monthly(db, user, indent=indent)

    _seed_approval_quantities(indent)
    # A monthly indent joins its cycle document HERE, not when it is approved. It used
    # to join on approval, which left the approver's Consolidation screen with no
    # document to group on — it grouped on the month and called the batch `CONS-2026-08`
    # while the two screens downstream called the same set of indents
    # `CON/2026-27/00001`. One document, named once, from submit onwards.
    await _join_consolidation(db, indent, user)
    workflow_context = _workflow_context_for_indent(indent)
    if indent.indent_type == IndentType.MONTHLY.value:
        from app.platform.monthly_indent import service as monthly_indent_service
        if await monthly_indent_service.custom_approval_flow_enabled(db):
            workflow_context[engine.LADDER_DOC_TYPE_KEY] = (
                monthly_indent_service.MONTHLY_INDENT_LADDER_DOC_TYPE
            )
    instance = await engine.start(
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
    # A configured NO_APPROVAL ladder completes inside engine.start(): there is no
    # pending task and therefore no later approval action that could hand the indent
    # to Inventory. Keep the module-owned status in step with the engine-owned result,
    # using the same fulfilment handoff as the final-approval path in act_on_indent.
    if instance.status == InstanceStatus.APPROVED.value:
        indent.status = IndentStatus.APPROVED.value
        indent.approved_at = utcnow()
        indent.current_approver_name = None
        await _fulfil(db, indent, user)
    else:
        indent.status = IndentStatus.PENDING_APPROVAL.value
        await _refresh_current_approver(db, indent)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": IndentStatus.DRAFT.value},
        after={"status": indent.status},
    )
    await notify_indent_status_event(
        db,
        indent,
        indent.status,
        [indent.requested_by_id],
        actor=user,
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
    IndentStatus.PARTIALLY_ALLOCATED.value,
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

#: A delivery is photographed TWICE over, and the two are different evidence: the
#: consignment as it was handed over, sealed, and then each package as it was opened.
#: One indent's receipt therefore carries several photos that must not be read as
#: copies of each other — "1 photo" on both packages, when the storekeeper had
#: photographed one of them, is the state this scope removes.
#:
#: The scope rides on `doc_category` because `sys_attachments` is one flat table for
#: every module and has no column for it, and adding one is a platform change for a
#: fact only this module has (rule 4). Base category first, so every reader that asks
#: "is this a photo" keeps working by asking `ack_category_base`; an unscoped value is
#: the consignment's own, which is what every row written before today is.
ACK_SCOPE_SEP = "::"
#: `String(50)` on the column, and the longest base is 13 characters.
ACK_SCOPE_MAX = 30
_ACK_SCOPE_OK = re.compile(r"^[A-Z0-9_-]+$")


def ack_category_base(value: str | None) -> str:
    """`RECEIPT_PHOTO::DISPATCH-4-PACKAGE-9` -> `RECEIPT_PHOTO`."""
    return (value or "").split(ACK_SCOPE_SEP, 1)[0]


def ack_category_scope(value: str | None) -> str:
    """Which package it hangs on, or "" for the consignment itself."""
    parts = (value or "").split(ACK_SCOPE_SEP, 1)
    return parts[1] if len(parts) == 2 else ""


_ACK_ITEM_SCOPE = re.compile(r"^I-(\d+)(?:-|$)")


def ack_category_item(value: str | None) -> int | None:
    """Return the indent line named by an item photo scope."""
    match = _ACK_ITEM_SCOPE.match(ack_category_scope(value))
    return int(match.group(1)) if match else None


def owed_quantity(item) -> Decimal:
    """What the requester is entitled to on this line.

    What the approver granted, falling back to what was asked for. The fallback is not
    cosmetic: most live indent lines predate the approval flow and carry `approved_qty`
    0, and treating that as "owed nothing" would close an indent the moment anyone
    acknowledged it. Same rule the allocation code already uses.
    A line marked excluded or rejected by the approver is owed nothing.
    """
    if getattr(item, "is_excluded", False):
        return Decimal("0")
    if getattr(item, "approved_quantity", None) is not None and _d(item.approved_quantity) > Decimal("0"):
        return _d(item.approved_quantity)
    return _d(item.approved_quantity) or _d(item.quantity)


def _fulfilment_status(items) -> str:
    """CLOSED once every active line is fully received, else PARTIALLY_FULFILLED."""
    active_items = [
        i for i in items
        if not getattr(i, "is_excluded", False) and owed_quantity(i) > Decimal("0")
    ]
    if not active_items or all(_d(i.received_quantity) >= owed_quantity(i) for i in active_items):
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
    if indent.requested_by_id != user.id and not await _receives_str(db, indent, user):
        raise PermissionError_(
            "Only the person who raised this indent can attach its delivery proof")
    if indent.status not in _RECEIVABLE_STATUSES:
        raise ValidationError(
            f"{indent.indent_no} is not awaiting delivery (status {indent.status})")
    if ack_category_base(doc_category) not in {ACK_PHOTO_CATEGORY, ACK_BILL_CATEGORY}:
        raise ValidationError("A delivery attachment is either a photo or a bill")
    scope = ack_category_scope(doc_category)
    if scope and (len(scope) > ACK_SCOPE_MAX or not _ACK_SCOPE_OK.match(scope)):
        # The scope names a package of THIS receipt and nothing else. Refused rather
        # than trimmed: a silently shortened scope files the proof against a package
        # nobody can find again.
        raise ValidationError("That is not a package this delivery was sent in")
    line_id = ack_category_item(doc_category)
    if line_id is not None and line_id not in {item.id for item in indent.items}:
        raise ValidationError("That is not an item on this indent")
    return await attachments.add_attachment(
        db, entity_type=ACK_ENTITY_TYPE, entity_id=indent.id,
        upload=upload, doc_category=doc_category, user=user)


async def delete_receipt_attachment(db: AsyncSession, attachment_id: int, user) -> None:
    """Withdraw one, under exactly the rule that allowed attaching it.

    The route is addressed by attachment id alone, so the parent indent is read OFF
    the row — `require_attachment` refuses an id that is not an acknowledgement file
    in the first place, which is what stops one module's permission reaching another
    module's paperwork. The raiser check and the status check are then the same two
    `add_receipt_attachment` makes: whoever may file the proof may take it back, and
    only while the indent is still expecting goods. Once it is delivered the evidence
    is what the acknowledgement was accepted on, and removing it would change a
    settled document.
    """
    row = await attachments.require_attachment(
        db, attachment_id, entity_type=ACK_ENTITY_TYPE)
    indent = await get_indent(db, int(row.entity_id))
    if indent.requested_by_id != user.id and not await _receives_str(db, indent, user):
        raise PermissionError_(
            "Only the person who raised this indent can remove its delivery proof")
    if indent.status not in _RECEIVABLE_STATUSES:
        raise ValidationError(
            f"{indent.indent_no} is no longer awaiting delivery, so its delivery "
            "proof can no longer be changed.")
    await attachments.delete_attachment(
        db, attachment_id, user,
        entity_type=ACK_ENTITY_TYPE, entity_id=indent.id)


#: What the requester may say about the state of what arrived.
#:
#: GOOD and DAMAGED, and deliberately NOT SHORT. A shortage is already stated by the
#: quantities — someone who types 6 against 10 has reported it, and the indent stays
#: open for the rest of its own accord. Offering SHORT here as well would let one form
#: say "all ten arrived" and "it was short" at the same time.
#:
#: Nor is SHORT derived from those numbers, which was the other tempting option: this
#: path accepts PARTIAL receipts by design (six today, four next week), so "received
#: less than was dispatched" is the normal shape of a first instalment and flagging it
#: as a shortage would raise a claim against a carrier who is still mid-delivery.
#: Damage is the one fact the quantities genuinely cannot carry, so it is the one fact
#: this asks for.
ACK_CONDITION_GOOD = "GOOD"
ACK_CONDITION_DAMAGED = "DAMAGED"
ACK_CONDITIONS = (ACK_CONDITION_GOOD, ACK_CONDITION_DAMAGED)


def _delivery_condition(condition: str | None, remarks: str | None) -> str:
    """Validate what the requester said about the goods, defaulting to GOOD.

    Values are plain strings rather than logistics' `AckCondition`: logistics sits
    AFTER indents in the import chain (rule 5), so this module may not import it. The
    warehouse maps them onto the enum on the way to the transport leg.
    """
    value = (condition or ACK_CONDITION_GOOD).strip().upper()
    if value not in ACK_CONDITIONS:
        raise ValidationError(
            f"{condition!r} is not a delivery condition. Say whether the goods "
            "arrived GOOD or DAMAGED.")
    if value != ACK_CONDITION_GOOD and not (remarks or "").strip():
        raise ValidationError(
            "Describe the damage — it is what the claim against the carrier is "
            "investigated from.")
    return value


def rejection_groups(by_id: dict, rejections: dict[int, list[dict]] | None) -> list[dict]:
    """The rejections of one acknowledgement, grouped BY REASON across its lines.

    One group per reason ("" when none was given, which is now the usual case): a return
    holds several reason rows, so the groups feed ONE return per acknowledgement. Within a
    group the same item is merged into one line (its quantities added, its comments
    joined), so a return never lists an item twice. `by_id` maps a line id to anything with `item_id`; it serves an
    indent's lines and a direct issue's alike.
    """
    groups: dict[str, dict] = {}
    for line_id, rows in (rejections or {}).items():
        line = by_id.get(line_id)
        if line is None:
            continue
        for row in rows:
            reason = str(row.get("reason") or "").upper()
            group = groups.setdefault(reason, {
                "reason": reason, "total": 0.0, "notes": [], "lines": {}})
            quantity = float(row["quantity"])
            group["total"] += quantity
            comment = (row.get("comment") or "").strip() or None
            if comment and comment not in group["notes"]:
                group["notes"].append(comment)
            merged = group["lines"].setdefault(line.item_id, {
                "item_id": line.item_id, "line_id": line_id, "quantity": 0.0, "remarks": None,
                "serial_numbers": []})
            merged["quantity"] += quantity
            merged["serial_numbers"].extend(row.get("serial_numbers") or [])
            if comment:
                merged["remarks"] = " · ".join(
                    p for p in (merged["remarks"], comment) if p)[:500]
    return [{**group, "lines": list(group["lines"].values())} for group in groups.values()]


async def resolve_rejection_units(db, by_id: dict, rejections: dict[int, list[dict]] | None):
    """The units named as turned away, checked (2026-11-06).

    Returns `(rows, prefer)`: the unit rows, and `{item_id: [code, ...]}` for the landing to
    shelve first. Goods that carry serial numbers or IMEIs MUST name them, one per unit; bulk
    goods and asset-coded goods may. A code can be named once, across every reason."""
    from app.modules.warehouse import service as _warehouse
    from app.shared.models.master import Item

    rows: list = []
    prefer: dict[int, list[str]] = {}
    seen: set[str] = set()
    for line_id, entries in (rejections or {}).items():
        line = by_id.get(line_id)
        if line is None:
            continue
        codes = [c for entry in entries for c in (entry.get("serial_numbers") or [])]
        item = await db.get(Item, line.item_id)
        label = getattr(line, "item_name", None) or getattr(line, "item_code", None) or "Item"
        if not codes:
            if item is not None and (getattr(item, "is_serial_tracked", False)
                                     or getattr(item, "is_imei_tracked", False)):
                raise ValidationError(
                    f"{label}: choose which serial numbers are being turned away.")
            continue
        if any(c in seen for c in codes):
            raise ValidationError(f"{label}: a serial number is turned away twice.")
        seen.update(codes)
        found = await _warehouse.resolve_rejected_units(db, item_id=line.item_id, codes=codes)
        rows.extend(found)
        prefer.setdefault(line.item_id, []).extend(codes)
    return rows, prefer


def rejection_remark(groups: list[dict]) -> str:
    """"Not accepted: Damaged 10 (two cartons crushed), Expired 2" — what the receipt, the
    carrier claim and the audit row say about the goods that were turned away."""
    parts = []
    for group in groups:
        text = f"{ACK_REJECTION_LABELS.get(group['reason']) or 'Returned'} {group['total']:g}"
        notes = "; ".join(group["notes"])
        parts.append(f"{text} ({notes})" if notes else text)
    return "Not accepted: " + ", ".join(parts)


async def _raise_rejection_returns(db: AsyncSession, user, source: dict,
                                   groups: list[dict]) -> list[dict]:
    """Hand the rejected goods to whoever raises returns. Inside the caller's transaction."""
    if not groups:
        return []
    from app.modules.indents import hooks
    return await hooks.raise_returns(db, user, source, groups)


async def _package_receipt_notes(db: AsyncSession, indent,
                                 receipts: dict[int, dict]) -> list[str]:
    """"…450-STRIP: 3 of 10 arrived", "…454-STRIP missing" — per package that came
    short, refused for a code that is not a package this indent line was issued in."""
    from app.modules.warehouse import models as wm
    from app.modules.warehouse import box_codes
    from app.shared import packing
    notes: list[str] = []
    for line_id, by_code in receipts.items():
        if not by_code:
            continue
        sent: dict[str, Decimal] = {}
        for issue_id, issue_line_id in (await db.execute(
                select(wm.MaterialIssueLine.issue_id, wm.MaterialIssueLine.id)
                .where(wm.MaterialIssueLine.indent_item_id == line_id))).all():
            for box in await box_codes.line_boxes(db, issue_id, issue_line_id):
                sent[box.hu_code] = box_codes.held(box)
        label = next((i.item_code for i in indent.items if i.id == line_id), str(line_id))
        for code, got in by_code.items():
            if code not in sent:
                raise ValidationError(f"{label}: {code} is not a package sent on this line")
            got = _d(got)
            if got < 0 or got > sent[code]:
                raise ValidationError(
                    f"{label}: {code} carried {packing.fmt(sent[code])}; "
                    f"{packing.fmt(got)} cannot have arrived in it")
            notes.append(f"{code} missing" if got == 0
                         else f"{code}: {packing.fmt(got)} of {packing.fmt(sent[code])} arrived")
    return notes


async def acknowledge_receipt(db: AsyncSession, indent_id: int,
                              lines: dict[int, Decimal], user, *,
                              condition: str | None = None,
                              remarks: str | None = None,
                              package_receipts: dict[int, dict] | None = None,
                              rejections: dict[int, list[dict]] | None = None) -> Indent:
    """The requester confirms what physically reached them.

    `lines` is what was ACCEPTED. `rejections` is what reached them and was not, by reason
    (2026-11-06): it counts as arrived — the goods are on the receiving shelf and a return
    is raised for them — but not as received, so the line stays owed.

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
    # Or, for an STR, whoever holds the shelf it is bound for (2026-10-29).
    if indent.requested_by_id != user.id and not await _receives_str(db, indent, user):
        raise PermissionError_(
            "Only the person who raised this indent, or the receiving point, can "
            "acknowledge its delivery")
    if indent.status not in _RECEIVABLE_STATUSES:
        raise ValidationError(
            f"{indent.indent_no} is not awaiting delivery (status {indent.status})")
    if not lines:
        raise ValidationError("Enter what you received on at least one line")

    photos = [
        row for row in await attachments.list_attachments(db, ACK_ENTITY_TYPE, indent.id)
        # Any photo of this delivery: the sealed handover, or one of the packages as
        # it was opened. Matching the bare category counted only the first of those,
        # so a requester who photographed every package and not the outside of the
        # load was refused for having no proof.
        if ack_category_base(row.doc_category) == ACK_PHOTO_CATEGORY
    ]
    if not photos:
        raise ValidationError(
            "Attach a photo of the goods you received before acknowledging")
    # The CONSIGNMENT photo is required too (2026-09-28): the sealed load, the seal and
    # the number plate are what a claim against the carrier is argued from, and item
    # shots taken once the cartons are open cannot show them. A consignment-scoped
    # (`C-...`) or unscoped photo counts; a package or item shot does not.
    if not any(
        (scope := ack_category_scope(row.doc_category)) == "" or scope.startswith("C-")
        for row in photos
    ):
        raise ValidationError(
            "Attach a photo of the consignment (the load, the seal, the number plate) "
            "before acknowledging")

    by_id = {item.id: item for item in indent.items}
    photographed = {ack_category_item(row.doc_category) for row in photos}
    unproven = [
        by_id[line_id] for line_id in lines
        if line_id in by_id and line_id not in photographed
    ]
    if unproven:
        named = ", ".join(item.item_name or item.item_code or f"line {item.id}"
                          for item in unproven[:4])
        more = len(unproven) - 4
        raise ValidationError(
            "Take a photo of each item you are confirming. Still without one: "
            f"{named}{f' and {more} more' if more > 0 else ''}.")
    rejections = {k: v for k, v in (rejections or {}).items() if v}
    for line_id in rejections:
        if line_id not in by_id:
            raise ValidationError(f"Line {line_id} is not on {indent.indent_no}")
    delivered: dict[int, Decimal] = {}
    if rejections:
        # Imported here, not at module load: warehouse sits after indents in the chain.
        from app.modules.warehouse import service as _warehouse
        delivered = await _warehouse.delivered_by_indent_item(db, list(rejections))
    before = {str(i.id): float(_d(i.received_quantity)) for i in indent.items}
    for line_id, quantity in lines.items():
        item = by_id.get(line_id)
        if item is None:
            raise ValidationError(f"Line {line_id} is not on {indent.indent_no}")
        received = _d(quantity)
        rejected_now = sum((_d(r["quantity"]) for r in rejections.get(line_id, [])), ZERO)
        if received < 0 or (received == 0 and rejected_now <= 0):
            raise ValidationError(
                f"{item.item_name or item.item_code}: received quantity must be more "
                "than zero")
        if rejected_now > 0:
            # Accepted + rejected can be no more than reached the requester and is not yet
            # accounted for. Only checked where something is rejected, so a plain
            # acknowledgement behaves exactly as it always did.
            unaccounted = (delivered.get(line_id, ZERO) - _d(item.received_quantity)
                           - _d(item.rejected_quantity))
            if received + rejected_now > unaccounted:
                raise ValidationError(
                    f"{item.item_name or item.item_code}: {received + rejected_now:g} "
                    f"accepted and rejected is more than the {max(unaccounted, ZERO):g} "
                    "that reached you and is not yet accounted for.")
        running = _d(item.received_quantity) + received
        owed = owed_quantity(item)
        if running > owed:
            raise ValidationError(
                f"{item.item_name or item.item_code}: {running} received is more than "
                f"the {owed} approved. Acknowledge only what you were given.")
        item.received_quantity = running
        if rejected_now > 0:
            item.rejected_quantity = _d(item.rejected_quantity) + rejected_now
        if running >= owed:
            item.status = IndentItemStatus.ISSUED.value

    indent.status = _fulfilment_status(indent.items)

    # Packages that came short or missing (2026-10-26): checked against the packages
    # the line was issued in, and written onto the receipt so the claim reads WHICH.
    package_notes = await _package_receipt_notes(db, indent, package_receipts or {})
    if package_notes:
        remarks = " · ".join(p for p in ((remarks or "").strip(), "; ".join(package_notes)) if p)
    groups = rejection_groups(by_id, rejections)
    if groups:
        # Said on the receipt, and — where the goods were harmed — a claim on the carrier
        # too, which needs a description (`_delivery_condition`): this supplies it.
        remarks = " · ".join(p for p in ((remarks or "").strip(), rejection_remark(groups)) if p)
        if condition is None and any(g["reason"] in ACK_DAMAGE_REASONS for g in groups):
            condition = ACK_CONDITION_DAMAGED
    ack_condition = _delivery_condition(condition, remarks)

    # Imported here, not at module load: warehouse sits after indents in the import
    # chain, so a top-level import would run it backwards.
    from app.modules.warehouse import service as warehouse_service

    # The units being turned away (2026-11-06): named, checked, and landed first below so
    # that the return can send those very ones back.
    turned_units, prefer_units = await resolve_rejection_units(db, by_id, rejections)

    # The raiser saying "this reached me" IS the acknowledgement. Asking the warehouse
    # to sign the same delivery again afterwards recorded nothing new and left indents
    # open on a forgotten second click, so the issues settle here instead. Same
    # transaction as the receipt that made them settleable.
    signed = await warehouse_service.auto_acknowledge_for_indent(
        db, indent.id, user, condition=ack_condition, remarks=remarks,
        # What arrived in each package that came short or missing (2026-10-26).
        box_received={code: Decimal(str(got)) for by_code in (package_receipts or {}).values()
                      for code, got in (by_code or {}).items()},
        # Whether anything is still owed on this indent, which decides how far back the
        # receipt is allowed to reach into the outward legs. A partial receipt settles
        # only what has actually left; a complete one may also settle a leg still
        # reading READY, because nothing can be sitting in a yard for an indent whose
        # every line has now arrived. See `_sign_transport_for_indent`.
        fully_received=indent.status == IndentStatus.CLOSED.value,
        prefer_units=prefer_units or None)
    await warehouse_service.mark_rejected_units(db, turned_units, indent.indent_no)

    # The rejected goods are on the requester's shelf now (the confirmation above counts
    # them as arrived), so a return can be raised from it — one per reason, in this same
    # transaction. If one cannot be raised the whole acknowledgement fails with the reason,
    # rather than closing the delivery and losing track of the goods turned away.
    receipt_returns = await _raise_rejection_returns(db, user, {
        "kind": "INDENT", "number": indent.indent_no, "indent_id": indent.id,
        "issue_id": None,
    }, groups)

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before=before,
        after={"status": indent.status,
               **({"acknowledged_issues": ", ".join(signed)} if signed else {}),
               **({"package_receipts": "; ".join(package_notes)} if package_notes else {}),
               **({"rejected": rejection_remark(groups),
                   "returns": ", ".join(r["return_no"] for r in receipt_returns)}
                  if groups else {}),
               **{str(i.id): float(_d(i.received_quantity)) for i in indent.items}},
    )
    await db.commit()
    await db.refresh(indent)
    result = await _attach_capabilities(db, indent, user)
    result.receipt_returns = receipt_returns
    return result


async def act_on_indent(db: AsyncSession, indent_id: int, action: ApprovalAction,
                        comments: str, user, final: bool = False) -> Indent:
    """APPROVE / REJECT / RETURN. Engine owns the chain; the module owns the status.

    `final` ends the ladder at this rung: nothing is left owed, so there is nothing
    for the approvers above to decide.
    """
    indent = await get_indent(db, indent_id, user)
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")
    from app.platform.workflow.engine import is_workflow_admin
    is_admin = await is_workflow_admin(db, user)
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot approve or reject their own indent")
    if not is_admin:
        await _assert_active_workflow_task(db, indent.id, user.id, user=user)
    if action == ApprovalAction.REJECTED:
        comments = (comments or "").strip()
        if not comments:
            raise ValidationError(REJECTION_REASON_REQUIRED_ERROR)

    before_status = indent.status
    context = _workflow_context_for_indent(indent)
    instance = await engine.act(
        db, DocType.INDENT.value, indent.id, action.value, user, comments,
        context=context, final=final and action == ApprovalAction.APPROVED,
    )

    if instance.status == InstanceStatus.APPROVED.value:
        indent.status = IndentStatus.APPROVED.value
        indent.approved_at = utcnow()
        indent.current_approver_name = None
        await _fulfil(db, indent, user)
        await _finish_str_approval(db, indent, user)
    elif instance.status == InstanceStatus.REJECTED.value:
        indent.status = IndentStatus.REJECTED.value
        indent.current_approver_name = None
        await _withdraw_str_allocations(db, indent, user, f"{indent.indent_no} was rejected")
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


async def get_indent_return_targets(
    db: AsyncSession, indent_id: int, user,
) -> list[dict]:
    """The steps this approver may send the indent back to (empty when they may not
    return it at all). The one just below the current step is marked as the default."""
    indent = await get_indent(db, indent_id, user)
    if indent.status == IndentStatus.RETURNED_FOR_CORRECTION.value:
        # Already returned: the only person who can move it is the correction owner, and
        # what they may pick are the steps earlier than their own.
        return await engine.get_correction_send_back_targets(
            db, DocType.INDENT.value, indent.id, user, _workflow_context_for_indent(indent))
    if not await can_return_indent_for_correction(db, indent, user):
        return []
    return await engine.get_return_targets(
        db, DocType.INDENT.value, indent.id, _workflow_context_for_indent(indent))


async def return_indent_for_correction(
    db: AsyncSession, indent_id: int, comments: str, user,
    target_sequence: int | None = None,
) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot return their own indent for correction")
    await _assert_active_workflow_task(db, indent.id, user.id)

    before_status = indent.status
    context = _workflow_context_for_indent(indent)
    if target_sequence is None:
        # No step chosen: the nearest earlier step, which is where a return has always
        # gone. Resolved here, against the signed steps, so a rung nobody signed can no
        # longer leave the indent with nowhere to go.
        offered = await engine.get_return_targets(
            db, DocType.INDENT.value, indent.id, context)
        target_sequence = next(
            (row["sequence"] for row in offered if row["is_default"]), None)
    await engine.return_for_correction(
        db,
        DocType.INDENT.value,
        indent.id,
        user,
        comments,
        context=context,
        target_sequence=target_sequence,
    )
    indent.status = IndentStatus.RETURNED_FOR_CORRECTION.value
    indent.current_approver_name = None
    await _withdraw_str_allocations(
        db, indent, user, f"{indent.indent_no} was returned for correction")
    await notify_indent_followers(db, indent, indent.status)
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


async def send_indent_correction_back(
    db: AsyncSession, indent_id: int, comments: str, user,
    target_sequence: int | None = None,
) -> Indent:
    """The correction owner sends a returned indent further back, to the requester or
    any earlier signer, rather than correcting it themselves."""
    indent = await get_indent(db, indent_id, user)
    if indent.status != IndentStatus.RETURNED_FOR_CORRECTION.value:
        raise ValidationError(f"Indent is not returned for correction (status {indent.status})")
    comments = (comments or "").strip()
    if not comments:
        raise ValidationError("Say what must be corrected before sending it back")

    before_status = indent.status
    await engine.send_correction_back(
        db,
        DocType.INDENT.value,
        indent.id,
        user,
        comments,
        context=_workflow_context_for_indent(indent),
        target_sequence=target_sequence,
    )
    indent.current_approver_name = None
    await notify_indent_followers(db, indent, indent.status)
    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before_status}, after={"status": indent.status},
        summary="Sent indent correction further back",
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
            IndentStatus.PARTIALLY_ALLOCATED.value,
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
        stmt = stmt.where(await _indent_visibility(db, user))
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

    total_approved = sum(_d(line.approved_quantity) for line in indent.items)
    for line in indent.items:
        # allocated_quantity is NOT reset here. It used to be, back when nothing could
        # be served before the ladder finished, so zeroing was just clearing a field
        # that had to be 0 anyway. An approver can now issue from their own point
        # part-way up (approvals/fulfilment.py), and wiping it here told inventory the
        # line was untouched — so the units already handed over would be issued a
        # second time, with the stk_ledger rows for the first lot still on file.
        line_approved = _d(line.approved_quantity)
        line.status = (
            IndentItemStatus.ISSUED.value
            if (line.allocated_quantity and line.allocated_quantity >= line.approved_quantity) or line_approved <= 0
            else IndentItemStatus.PENDING.value
        )
    if total_approved <= 0:
        indent.status = IndentStatus.CLOSED.value
        return

    indent.status = IndentStatus.AWAITING_ALLOCATION.value
    # The one place a monthly indent enters the fulfilment queue, so the one place it
    # can pick up its consolidation. Every downstream screen groups by that document
    # rather than by the month, which is what stops a row and the screen it opens from
    # counting two different sets of indents.
    await _join_consolidation(db, indent, user)


async def _refresh_current_approver(db: AsyncSession, indent: Indent) -> None:
    # Name AND rung — "Mahendra Kumar (Warehouse Manager)" rather than a bare name, so
    # a requester can see how far up the ladder their indent has climbed. One builder in
    # the engine, used by every module, so the wording cannot drift apart again
    # (2026-08-21).
    indent.current_approver_name = await engine.current_approver_label(
        db, DocType.INDENT.value, indent.id)


_POST_APPROVAL_STATUSES = {
    IndentStatus.APPROVED.value,
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.ALLOCATED.value,
    IndentStatus.PARTIALLY_ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
    IndentStatus.PARTIALLY_ORDERED.value,
    IndentStatus.ORDERED.value,
    IndentStatus.CLOSED.value,
}

# The one wording for "this is with procurement, not with the warehouse". The Journey
# serves it and `FlowStepper`'s offline fallback repeats it verbatim; the two used to
# disagree because only the frontend had a procurement leg at all, and the frontend's
# copy never rendered (the backend always serves seven valid phases, so the fallback
# it lives in is unreachable for a real indent).
_PROCUREMENT_STAGE_MESSAGES = {
    IndentStatus.PENDING_PROCUREMENT.value: "Not in stock — with procurement",
    IndentStatus.PARTIALLY_ORDERED.value: "Partly ordered — with procurement",
    IndentStatus.ORDERED.value: "Ordered — waiting for goods receipt",
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
    return to_ist(value)


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
        old_status = status_change.get("from") if isinstance(status_change, dict) else None
        if (
            old_status == IndentStatus.RETURNED_FOR_CORRECTION.value
            and new_status == IndentStatus.PENDING_APPROVAL.value
        ):
            # A correction resubmit reopens the rung it was returned from instead of
            # writing a new wf_actions row, so this audit entry is the only evidence
            # the request ever went back up the ladder.  Without it the journey stops
            # at the return and never shows what happened next.  The rung itself is
            # still the ladder's: this only reports that the document went back to it,
            # and the approver on it comes from `wf_instances.resolved_chain` as before.
            add({
                "id": f"resubmitted:{audit.id}",
                "event_type": "RESUBMITTED",
                "title": "Resubmitted after correction",
                "description": (
                    f"Resubmitted by {audit.actor_name}"
                    if audit.actor_name else f"{indent.indent_no} resubmitted"
                ),
                "actor_name": audit.actor_name,
                "position_name": (
                    indent.position_name
                    if audit.actor_name and audit.actor_name == indent.requested_by_name
                    else None
                ),
                "timestamp": audit.created_at,
                "comments": None,
                "reference_no": None,
                "quantity_summary": None,
                # The approval leg, not a leg of its own: the ladder picks up exactly
                # where the return left it.
                "stage_type": "approval",
                "approval_mode": None,
                "_sort_order": 25,
            })
        elif new_status == IndentStatus.AWAITING_ALLOCATION.value:
            add({
                "id": f"ready-for-allocation:{audit.id}",
                "event_type": "READY_FOR_ALLOCATION",
                "title": "Ready for allocation",
                "description": f"{indent.indent_no} sent to inventory",
                "actor_name": None,
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
        return positions[:-1], positions[-1:]
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
    if label and "(before a consignment may be raised)" in label:
        label = label.replace("(before a consignment may be raised)", "").strip()
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
        Dispatch, DispatchItem, DispatchSource, MaterialIssue, MaterialIssueLine, Picking,
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
        # A consignment carrying several issues names them in `out_dispatch_sources`
        # and leaves `ref_id` empty.
        dispatch_conditions.append(Dispatch.id.in_(
            select(DispatchSource.dispatch_id)
            .where(DispatchSource.issue_id.in_(material_issue_ids))
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
    from app.modules.warehouse.models import (
        Dispatch, MaterialIssue, OutboundInspection,
    )

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

    issue_ids = [row.id for row in all_issues]
    inspections = []
    if issue_ids:
        inspections = list((await db.execute(
            select(OutboundInspection)
            .options(selectinload(OutboundInspection.items))
            .where(OutboundInspection.issue_id.in_(issue_ids))
            .order_by(OutboundInspection.created_at.asc(), OutboundInspection.id.asc())
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
    # A brand given in place of the one asked for (2026-10-24) is a decision the
    # requester must be able to read on the journey, not only on the indent's lines.
    # Rejected and cancelled allocations gave nothing, so they changed nothing.
    for row in allocations:
        if row.status in (AllocationStatus.REJECTED.value, AllocationStatus.CANCELLED.value):
            continue
        for item in row.items:
            if (item.indent_item_id not in target_item_ids or not item.substituted_from
                    or _d(item.quantity) <= 0):
                continue
            given = " · ".join(p for p in (item.brand_name, item.variant_name,
                                            item.model_name) if p) or "No brand"
            events.append({
                "id": f"allocation-brand:{row.id}:{item.id}",
                "event_type": "BRAND_CHANGED",
                "title": "Brand changed",
                "description": (f"{item.item_name or 'Item'}: brand substituted from "
                                f"{item.substituted_from} to {given}"),
                "actor_name": row.allocated_by_name,
                "position_name": None,
                "timestamp": row.created_at,
                "comments": item.substitution_reason,
                "reference_no": row.allocation_no,
                "quantity_summary": f"{float(_d(item.quantity)):g} {item.uom_code or ''}".strip(),
                "stage_type": "allocation",
                "approval_mode": None,
                "_sort_order": 41,
            })

    warehouse_workflow_events, _ = await _related_workflow_events(
        db,
        doc_ids=[row.id for row in all_issues],
        domain="Warehouse",
        stage_type="warehouse_approval",
        include_submission=False,
        sort_order=54,
        references={row.id: row.issue_no for row in all_issues},
    )
    events.extend(warehouse_workflow_events)
    for row in all_issues:
        issue_status = str(row.status or "").upper()
        is_draft = issue_status == "DRAFT" and not row.is_stock_posted
        events.append({
            "id": f"material-issue-created:{row.id}",
            "event_type": "MATERIAL_ISSUE_CREATED",
            "title": "Material issue draft created" if is_draft else "Material issue created",
            "description": (
                "Warehouse material issue draft recorded"
                if is_draft else "Warehouse material issue recorded"
            ),
            "status": "DRAFT" if is_draft else issue_status,
            "actor_name": row.created_by_name,
            "position_name": None,
            "timestamp": row.created_at,
            "comments": row.remarks,
            "reference_no": row.issue_no,
            "quantity_summary": None,
            "stage_type": "warehouse",
            "approval_mode": None,
            "_sort_order": 52,
        })

    qc_workflow_events, _ = await _related_workflow_events(
        db,
        doc_type="QC_OUTWARD",
        doc_ids=[row.id for row in inspections],
        domain="Quality Inspection",
        stage_type="warehouse_approval",
        include_submission=False,
        sort_order=59,
        references={row.id: row.inspection_no for row in inspections},
    )
    events.extend(qc_workflow_events)
    for row in inspections:
        qc_status = str(row.status or "").upper()
        is_completed = qc_status in ("COMPLETED", "PASSED")
        is_draft = qc_status == "DRAFT"
        events.append({
            "id": f"quality-inspection:{row.id}",
            "event_type": "QUALITY_INSPECTION_COMPLETED" if is_completed else "QUALITY_INSPECTION_CREATED",
            "title": "Quality inspection completed" if is_completed else "Quality inspection draft created" if is_draft else f"Quality inspection ({qc_status.capitalize()})",
            "description": (
                f"Quality inspection completed ({row.passed_items} passed, {row.failed_items} failed)"
                if is_completed
                else f"Quality inspection draft recorded ({row.total_items} items)"
                if is_draft
                else f"Quality inspection: {qc_status}"
            ),
            "status": qc_status,
            "actor_name": row.inspector_name or row.approved_by_name,
            "position_name": None,
            "timestamp": row.approved_at or row.created_at,
            "comments": row.remarks,
            "reference_no": row.inspection_no,
            "quantity_summary": f"{row.passed_items} of {row.total_items} passed" if row.total_items else None,
            "stage_type": "warehouse",
            "approval_mode": None,
            "_sort_order": 58 if is_draft else 60,
        })

    dispatch_workflow_events, _ = await _related_workflow_events(
        db,
        doc_ids=[row.id for row in dispatches],
        domain="Dispatch",
        stage_type="dispatch_approval",
        include_submission=False,
        sort_order=66,
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
            "_sort_order": 64,
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
    # What the shortfall on each line was handed to procurement as. A material request
    # is the only record that says "this quantity is not coming off a shelf", and
    # without reading it the journey took a signed zero-quantity allocation for stock
    # set aside and marched the document on to the warehouse.
    on_order_by_line: dict[int, Decimal] = defaultdict(Decimal)
    for row in material_requests:
        for item in row.items:
            if item.indent_item_id in target_item_ids:
                on_order_by_line[item.indent_item_id] += _d(item.quantity)
    # Still short on the line, and the shortfall is with procurement. Nothing can reach
    # the warehouse until a purchase lands, so no downstream leg may claim to be live.
    awaiting_procurement = any(
        on_order_by_line.get(line_id, Decimal("0")) > Decimal("0")
        and (
            allocation_by_line.get(line_id, Decimal("0"))
            + received_by_line.get(line_id, Decimal("0"))
        ) < required
        for line_id, required in required_by_line.items()
    )
    # The allocation leg is settled when stock was actually set aside and nothing is
    # still on order. A signed allocation that gave ZERO is a decision somebody made,
    # not a settlement — reading `has_allocation` alone let an indent sitting with
    # procurement report "Waiting for warehouse issue".
    allocation_settled = (
        allocation_complete or allocated_total > Decimal("0")
    ) and not awaiting_procurement
    if allocations_found:
        latest = allocations_found[-1]
        stage(
            # Naming a zero allocation "Stock allocated" is the same lie one rung down:
            # the quantity summary said 0, the title said otherwise.
            "Stock allocated" if allocated_total > Decimal("0")
            else "No stock available to allocate",
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
                "_sort_order": 56,
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
                "_sort_order": 57,
            })

    if inspections:
        latest_qc = inspections[-1]
        latest_qc_st = str(latest_qc.status or "").upper()
        stage(
            "Quality inspection completed" if latest_qc_st in ("COMPLETED", "PASSED")
            else "Quality inspection in progress",
            latest_qc_st,
            "warehouse",
            actor=latest_qc.inspector_name or latest_qc.approved_by_name,
            timestamp=latest_qc.approved_at or latest_qc.created_at,
            comments=latest_qc.remarks,
            reference=latest_qc.inspection_no,
            quantity=f"{latest_qc.passed_items} of {latest_qc.total_items} items passed" if latest_qc.total_items else None,
            source="whs_inspections.status",
        )

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
    warehouse_acknowledged = (
        any(row.acknowledged_at is not None for row in issues)
        or any(row.acknowledged_at is not None for row in dispatches)
    )
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
    if indent.status == IndentStatus.CLOSED.value:
        if not allocations_found:
            missing_sources.append("inv_allocations.status=APPROVED and approved_at")
        elif awaiting_procurement:
            # Not a gap in the evidence: the shortfall is a live material request and no
            # warehouse document can exist until procurement delivers against it. Listing
            # `out_issues` here fired the "missing evidence" banner on every indent that
            # is simply out of stock, and named the wrong document as the next step.
            pass
        elif not issues:
            missing_sources.append("out_issues.is_stock_posted=true and posted_at")
        elif not issue_complete:
            missing_sources.append("remaining posted out_issue_items.issued_qty")
        elif not dispatched:
            missing_sources.append("out_dispatches.gate_out_at")
        elif not delivered and not fully_received:
            missing_sources.append("out_dispatches.delivered_at")
        elif not delivery_complete and not fully_received:
            missing_sources.append("remaining out_dispatch_items.delivered_qty")
        elif received_total <= 0:
            missing_sources.append(
                "ind_indent_items.received_qty and acknowledgement audit"
            )
        elif not fully_received:
            missing_sources.append("remaining ind_indent_items.received_qty")
        elif closed_audit is None:
            missing_sources.append("sys_audit_log status.to=CLOSED")
        elif not is_complete:
            missing_sources.append("ind_indents.status=CLOSED audit transition")
    else:
        # Open indents are still in progress. Downstream stages that have not occurred
        # yet (such as allocation, issue, dispatch, etc.) are normal pending steps,
        # not missing records. Only flag genuine data inconsistencies where a status
        # claims a stage completed without records.
        if (
            indent.status == IndentStatus.ALLOCATED.value
            and not allocations_found
        ):
            missing_sources.append("inv_allocations.status=APPROVED and approved_at")

    return {
        "stages": stages,
        "events": events,
        "missing_sources": missing_sources,
        "has_allocation": bool(allocations_found),
        "allocation_complete": allocation_complete,
        "allocation_settled": allocation_settled,
        "awaiting_procurement": awaiting_procurement,
        "has_material_request": bool(material_requests),
        "has_issue": bool(issues),
        "issue_complete": issue_complete,
        "has_qc": bool(inspections),
        "qc_complete": bool(inspections) and all(str(row.status or "").upper() in ("COMPLETED", "PASSED") for row in inspections),
        "qc_in_progress": bool(inspections) and any(str(row.status or "").upper() in ("DRAFT", "IN_PROGRESS", "PENDING_APPROVAL") for row in inspections),
        "latest_qc_no": inspections[-1].inspection_no if inspections else None,
        "latest_qc_status": str(inspections[-1].status or "").upper() if inspections else None,
        "has_consignment": bool(dispatches),
        "pending_consignment": any(row.gate_out_at is None for row in dispatches),
        "latest_dispatch_no": dispatches[-1].dispatch_no if dispatches else None,
        "latest_dispatch_status": str(dispatches[-1].status or "").upper() if dispatches else None,
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
        "has_warehouse_acknowledgement": warehouse_acknowledged,
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
        "allocation_settled": False, "awaiting_procurement": False,
        "has_material_request": False, "has_issue": False, "issue_complete": False,
        "has_dispatch": False, "has_delivery": False, "delivery_complete": False,
        "has_acknowledgement": False, "has_warehouse_acknowledgement": False,
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

    # NOT `has_allocation`. An allocation row existing is not stock set aside: a
    # decision to give nothing is signed and APPROVED like any other, and the whole
    # requirement then goes to procurement. `allocation_settled` is the same fact the
    # Fulfilment Queue already computes — allocated, less whatever is on order.
    allocation_done = bool(operational["allocation_settled"])
    warehouse_done = bool(operational["issue_complete"])
    # The two final phases are separate signatures, taken from opposite ends of the
    # handover. Delivery is the warehouse's: recording the DELIVERED event on the
    # dispatch closes it (`out_dispatches.delivered_at` plus the line-level
    # delivered_qty behind `delivery_complete`). A flow that never raised a dispatch
    # — goods handed over at the store — has no such record, so a full receipt still
    # counts as arrival rather than leaving the phase PENDING on a closed indent.
    delivery_done = bool(
        operational["delivery_complete"] or operational["receipt_complete"]
    )
    # Acknowledgement is the requester's: what they confirmed in Indents >
    # Acknowledgements, written to `ind_indent_items.received_qty`. The warehouse
    # sign-off on the issue/dispatch is the same confirmation reaching the record
    # from the other side, for indents acknowledged through the issue page.
    acknowledgement_done = bool(
        operational["receipt_complete"]
        or (delivery_done and operational["has_warehouse_acknowledgement"])
    )
    allocation_current = (
        approvals_complete
        and not allocation_done
        and not operational["has_issue"]
    )
    warehouse_current = (
        (allocation_done or operational["has_issue"])
        and not warehouse_done
    )
    delivery_current = warehouse_done and not delivery_done
    acknowledgement_current = delivery_done and not acknowledgement_done

    has_posted_issue = bool(operational.get("has_issue"))
    has_qc = bool(operational.get("has_qc"))
    qc_complete = bool(operational.get("qc_complete"))
    qc_in_progress = bool(operational.get("qc_in_progress"))
    has_consignment = bool(operational.get("has_consignment"))
    is_dispatched = bool(operational.get("has_dispatch"))
    is_delivered = bool(operational.get("has_delivery"))

    warehouse_phase_message = None
    delivery_phase_message = None
    if has_posted_issue:
        if qc_in_progress:
            warehouse_phase_message = "QC in progress"
        elif qc_complete and not has_consignment:
            warehouse_phase_message = "QC completed"
        elif has_consignment and not is_dispatched:
            delivery_phase_message = "Pending dispatch"
        elif is_dispatched:
            delivery_phase_message = "In transit"

    phases = [
        phase(1, "Draft", "APPROVED" if request_submitted else "PENDING",
              current=draft_current),
        phase(2, "Submitted", "APPROVED" if request_submitted else "PENDING",
              current=submitted_current),
        phase(
            3, "Approvals", approval_status, current=approval_is_current,
            message=(approval_current or {}).get("title") if approval_current else None,
        ),
        phase(
            4, "Allocation", "APPROVED" if (allocation_done or has_posted_issue or operational["has_issue"]) else "PENDING",
            current=allocation_current and not has_posted_issue,
            # Why the leg is still open, for the stepper caption. Without it the step
            # reads a bare "Current" and the requester has no way to tell an indent
            # nobody has looked at from one that is out of stock and on order.
            message=(
                _PROCUREMENT_STAGE_MESSAGES.get(
                    indent.status, "Sourcing from procurement")
                if (allocation_current or operational["awaiting_procurement"])
                else None
            ),
        ),
        phase(5, "Warehouse", "APPROVED" if (warehouse_done or (has_posted_issue and qc_complete)) else "PENDING",
              current=warehouse_current and not (has_posted_issue and (qc_complete or is_dispatched or has_consignment)),
              message=warehouse_phase_message),
        phase(6, "Delivery", "APPROVED" if delivery_done else "PENDING",
              current=(delivery_current or is_dispatched) and not (has_posted_issue and qc_complete and not is_dispatched) and not delivery_done,
              message=delivery_phase_message),
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
        # Procurement sits inside the allocation leg rather than after it: the goods
        # were not on a shelf, so the requirement is being bought. Saying "waiting for
        # allocation" sends the requester to an inventory desk that cannot act.
        current_stage = (
            _PROCUREMENT_STAGE_MESSAGES.get(indent.status, "Sourcing from procurement")
            if operational["awaiting_procurement"]
            else "Waiting for allocation"
        )
    elif acknowledgement_done or all(p["status"] == "APPROVED" for p in phases):
        current_stage = "Completed"
    elif acknowledgement_current:
        current_stage = (
            "Partially received"
            if operational["has_receipt"]
            else "Waiting for acknowledgement"
        )
    elif has_posted_issue and (qc_in_progress or (has_qc and not qc_complete)):
        qc_no = operational.get("latest_qc_no")
        ref_txt = f" · Ref {qc_no}" if qc_no else ""
        current_stage = f"Quality inspection in progress{ref_txt}"
    elif has_posted_issue and qc_complete and not has_consignment and not delivery_done:
        current_stage = "QC completed — awaiting consignment"
    elif has_posted_issue and qc_complete and has_consignment and not is_dispatched and not delivery_done:
        dsp_no = operational.get("latest_dispatch_no")
        ref_txt = f" · Ref {dsp_no}" if dsp_no else ""
        current_stage = f"Pending in consignment — ready for dispatch{ref_txt}"
    elif delivery_current:
        current_stage = (
            "In delivery" if operational["has_dispatch"] else "Waiting for dispatch"
        )
    elif warehouse_current:
        current_stage = "Waiting for warehouse issue"

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
        "QUALITY_INSPECTION_CREATED": "warehouse",
        "QUALITY_INSPECTION_COMPLETED": "warehouse",
        "DISPATCH_CREATED": "delivery",
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
            "READY_FOR_ALLOCATION": (
                "COMPLETED" if operational.get("has_allocation") else "AWAITING_ALLOCATION"
            ),
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
        "qc_status": operational.get("latest_qc_status"),
        "qc_inspection_no": operational.get("latest_qc_no"),
        "qc_complete": operational.get("qc_complete", False),
        "consignment_no": operational.get("latest_dispatch_no"),
        "consignment_status": operational.get("latest_dispatch_status"),
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
        # Same predicate as list_indents, or the dashboard contradicts the list it
        # sits above.
        base = base.where(await _indent_visibility(db, user))
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

    now = ist_now()
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
        S.PARTIALLY_ALLOCATED.value, S.PARTIALLY_FULFILLED.value,
        S.PENDING_PROCUREMENT.value, S.ORDERED.value, S.PARTIALLY_ORDERED.value,
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
    "line_count",
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
    line_count=None,
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
        _activity_value(line_count, BigInteger).label("line_count"),
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
    # What the request was RAISED for, carried on the header events.
    #
    # Those events — created, submitted, approved, rejected, returned — are one row per
    # DOCUMENT, so they name no item and used to leave QTY blank; the column only ever
    # filled in once allocation fanned the indent out per line, which reads as "nobody
    # recorded a quantity" rather than "nothing has moved yet" (BUG_SCM_0001/0002).
    #
    # Summed here, never per approval rung: `approved_qty` is OVERWRITTEN at every rung
    # and no per-rung history is stored, so the only quantity that is true against every
    # header row is the one that was asked for. `uom_count` is what stops the sum being
    # a lie — 3 CAN + 2 BOTTLE + 1100 NOS has no total, so a mixed-unit request reports
    # its line count alone and no number at all.
    line_totals = (
        select(
            IndentItem.indent_id.label("indent_id"),
            func.count().label("line_count"),
            func.count(IndentItem.uom_code.distinct()).label("uom_count"),
            func.sum(IndentItem.quantity).label("requested_total"),
            func.min(IndentItem.uom_code).label("uom_code"),
        )
        .group_by(IndentItem.indent_id)
        .subquery("indent_line_totals")
    )
    single_uom = line_totals.c.uom_count == 1
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
        line_totals.c.line_count.label("line_count"),
        case((single_uom, line_totals.c.requested_total),
             else_=cast(literal(None), Numeric(16, 3))).label("requested_total"),
        case((single_uom, line_totals.c.uom_code),
             else_=cast(literal(None), String)).label("request_uom_code"),
    ).outerjoin(line_totals, line_totals.c.indent_id == Indent.id)
    if user is not None:
        visible_stmt = visible_stmt.where(await _indent_visibility(db, user))
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
        quantity=visible.c.requested_total,
        uom_code=visible.c.request_uom_code,
        line_count=visible.c.line_count,
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
            quantity=visible.c.requested_total,
            uom_code=visible.c.request_uom_code,
            line_count=visible.c.line_count,
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

    # The outward leg. Indents sits before warehouse in the import chain (rule 5), so
    # the models are read through a local import - the same one the Journey endpoint
    # uses, and for the same reason. It cannot widen access: every branch hangs off
    # `visible`, which already carries the indent visibility predicate.
    from app.modules.warehouse.enums import DispatchStatus, IssueDirection
    from app.modules.warehouse.models import (
        Dispatch, DispatchItem, MaterialIssue, MaterialIssueLine,
    )

    # Net of what came back: a returned unit was never fulfilment, and `returned_qty`
    # is where the return document already records that against the original line.
    net_issued = (
        MaterialIssueLine.issued_qty
        - func.coalesce(MaterialIssueLine.returned_qty, literal(0))
    )
    # What the line owed. The approved quantity is the promise; the requested one
    # stands in while a line predates approval, and the issue's own requested_qty is
    # the last resort for a legacy line that never carried an indent_item_id.
    line_required = func.coalesce(
        func.nullif(IndentItem.approved_quantity, literal(0)),
        IndentItem.quantity,
        MaterialIssueLine.requested_qty,
    )
    issue_lines = (
        select(
            MaterialIssue.id.label("issue_id"),
            MaterialIssue.issue_no,
            MaterialIssue.indent_id,
            MaterialIssue.posted_at,
            MaterialIssue.acknowledged_at,
            MaterialIssue.acknowledged_by_name,
            MaterialIssue.issued_by_id,
            MaterialIssue.issued_by_name,
            MaterialIssue.remarks.label("issue_remarks"),
            MaterialIssueLine.id.label("line_id"),
            MaterialIssueLine.item_id,
            MaterialIssueLine.item_code,
            MaterialIssueLine.item_name,
            MaterialIssueLine.uom_code,
            MaterialIssueLine.remarks.label("line_remarks"),
            net_issued.label("issued_qty"),
            line_required.label("required_qty"),
            # Fulfilled is a running total, not one document's line: two half issues
            # against the same request line finish it between them, and only the
            # second of the two may say so. Partitioned on the indent item where the
            # line carries one, on the item within the indent where it does not.
            func.sum(net_issued).over(
                partition_by=(
                    MaterialIssue.indent_id,
                    func.coalesce(MaterialIssueLine.indent_item_id, literal(0)),
                    MaterialIssueLine.item_id,
                ),
                order_by=(MaterialIssue.posted_at, MaterialIssue.id),
            ).label("issued_to_date"),
        )
        .select_from(MaterialIssue)
        .join(MaterialIssueLine, MaterialIssueLine.issue_id == MaterialIssue.id)
        .outerjoin(IndentItem, IndentItem.id == MaterialIssueLine.indent_item_id)
        .where(
            MaterialIssue.indent_id.is_not(None),
            MaterialIssue.direction == IssueDirection.OUT.value,
            # Posted stock is the evidence. A drafted issue moved nothing and must
            # never read as fulfilment on the ledger.
            MaterialIssue.is_stock_posted.is_(True),
            MaterialIssue.posted_at.is_not(None),
        )
        .subquery("indent_issue_lines")
    )
    fulfilled_to_date = issue_lines.c.issued_to_date >= issue_lines.c.required_qty
    fulfilment_result = case(
        (fulfilled_to_date, literal("FULFILLED")),
        else_=literal("PARTIALLY_FULFILLED"),
    )
    fulfilment_result_label = case(
        (fulfilled_to_date, literal("Fulfilled")),
        else_=literal("Partially Fulfilled"),
    )
    issue_remarks = func.coalesce(
        issue_lines.c.line_remarks, issue_lines.c.issue_remarks)

    material_issued = (
        select(*_activity_event_columns(
            visible,
            event_id=literal("issue:") + cast(issue_lines.c.line_id, String),
            event_type=IndentActivityType.MATERIAL_ISSUED.value,
            event_label="Material issued",
            result=fulfilment_result,
            result_label=fulfilment_result_label,
            occurred_at=issue_lines.c.posted_at,
            actor_id=issue_lines.c.issued_by_id,
            actor_name=issue_lines.c.issued_by_name,
            actor_position=issue_lines.c.issue_no,
            item_id=issue_lines.c.item_id,
            item_code=issue_lines.c.item_code,
            item_name=issue_lines.c.item_name,
            quantity=issue_lines.c.issued_qty,
            requested_quantity=issue_lines.c.required_qty,
            uom_code=issue_lines.c.uom_code,
            remarks=issue_remarks,
            source_type="out_issues",
            source_id=issue_lines.c.issue_id,
            source_rank=60,
            event_key=issue_lines.c.line_id,
            search_position=issue_lines.c.issue_no,
            search_remarks=issue_remarks,
        ))
        .select_from(visible)
        .join(issue_lines, issue_lines.c.indent_id == visible.c.indent_id)
    )

    # Gate-out, off the consignment the issue was loaded onto. `indent_id` on the
    # line is the link the dispatch itself records, so a consignment carrying two
    # requests contributes only its own lines to each.
    dispatch_actor = func.coalesce(Dispatch.security_by_name, Dispatch.created_by_name)
    material_dispatched = (
        select(*_activity_event_columns(
            visible,
            event_id=literal("dispatch:") + cast(DispatchItem.id, String),
            event_type=IndentActivityType.MATERIAL_DISPATCHED.value,
            event_label="Material dispatched",
            result="DISPATCHED",
            result_label="Dispatched",
            occurred_at=Dispatch.gate_out_at,
            actor_name=dispatch_actor,
            actor_position=Dispatch.dispatch_no,
            item_id=DispatchItem.item_id,
            item_code=DispatchItem.item_code,
            item_name=DispatchItem.item_name,
            quantity=DispatchItem.quantity,
            uom_code=DispatchItem.uom_code,
            remarks=Dispatch.remarks,
            source_type="out_dispatches",
            source_id=Dispatch.id,
            source_rank=70,
            event_key=DispatchItem.id,
            search_position=Dispatch.dispatch_no,
        ))
        .select_from(visible)
        .join(DispatchItem, DispatchItem.indent_id == visible.c.indent_id)
        .join(Dispatch, Dispatch.id == DispatchItem.dispatch_id)
        .where(
            Dispatch.gate_out_at.is_not(None),
            Dispatch.status != DispatchStatus.CANCELLED.value,
        )
    )

    # The receiving site's signature, taken once. Acknowledging a consignment stamps
    # the issue it was carrying and the other way round (`_apply_issue_acknowledgement`
    # / `_apply_dispatch_acknowledgement`), so reading it off both documents would
    # print the same event twice: the issue is the one that carries the request line.
    receipt_acknowledged = (
        select(*_activity_event_columns(
            visible,
            event_id=literal("acknowledgement:") + cast(issue_lines.c.line_id, String),
            event_type=IndentActivityType.RECEIPT_ACKNOWLEDGED.value,
            event_label="Receipt acknowledged",
            result=fulfilment_result,
            result_label=fulfilment_result_label,
            occurred_at=issue_lines.c.acknowledged_at,
            actor_name=issue_lines.c.acknowledged_by_name,
            actor_position=issue_lines.c.issue_no,
            item_id=issue_lines.c.item_id,
            item_code=issue_lines.c.item_code,
            item_name=issue_lines.c.item_name,
            quantity=issue_lines.c.issued_qty,
            requested_quantity=issue_lines.c.required_qty,
            uom_code=issue_lines.c.uom_code,
            remarks=issue_remarks,
            source_type="out_issues",
            source_id=issue_lines.c.issue_id,
            source_rank=80,
            event_key=issue_lines.c.line_id,
            search_position=issue_lines.c.issue_no,
            search_remarks=issue_remarks,
        ))
        .select_from(visible)
        .join(issue_lines, issue_lines.c.indent_id == visible.c.indent_id)
        .where(issue_lines.c.acknowledged_at.is_not(None))
    )

    combined_rows = union_all(
        created,
        workflow,
        allocation,
        material_request,
        material_issued,
        material_dispatched,
        receipt_acknowledged,
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
        stmt = stmt.where(await _indent_visibility(db, user))
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
        IndentStatus.DRAFT.value, IndentStatus.PENDING_APPROVAL.value,
        IndentStatus.APPROVED.value,
        IndentStatus.AWAITING_ALLOCATION.value, IndentStatus.ALLOCATED.value,
        IndentStatus.PARTIALLY_ALLOCATED.value,
        IndentStatus.PARTIALLY_FULFILLED.value,
        IndentStatus.PENDING_PROCUREMENT.value,
        IndentStatus.REJECTED.value, IndentStatus.RETURNED_FOR_CORRECTION.value,
        IndentStatus.PARTIALLY_ORDERED.value,
        IndentStatus.ORDERED.value, IndentStatus.CLOSED.value,
    ]
    legacy_title = case(
        (Indent.status == IndentStatus.DRAFT.value, "Draft created"),
        (Indent.status == IndentStatus.PENDING_APPROVAL.value, "Awaiting approval"),
        (Indent.status == IndentStatus.APPROVED.value, "Request approved"),
        (Indent.status == IndentStatus.AWAITING_ALLOCATION.value, "Request approved"),
        (Indent.status == IndentStatus.ALLOCATED.value, "Stock set aside"),
        (
            Indent.status == IndentStatus.PARTIALLY_ALLOCATED.value,
            "Part of it is coming from stock",
        ),
        (
            Indent.status == IndentStatus.PARTIALLY_FULFILLED.value,
            "Partially fulfilled",
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
    legacy_message = case(
        (
            Indent.status == IndentStatus.DRAFT.value,
            Indent.indent_no + literal(" is saved as a draft."),
        ),
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
            Indent.status == IndentStatus.PARTIALLY_ALLOCATED.value,
            literal("Some of ") + Indent.indent_no
            + literal(" is from stock; the rest is on order."),
        ),
        (
            Indent.status == IndentStatus.PARTIALLY_FULFILLED.value,
            literal("Some of ") + Indent.indent_no
            + literal(" has been received; the rest is on its way."),
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
    visible = await _indent_visibility(db, user)
    notification_status = case(
        (
            Notification.entity_type.startswith(INDENT_STATUS_NOTIFICATION_PREFIX),
            func.substr(
                Notification.entity_type,
                len(INDENT_STATUS_NOTIFICATION_PREFIX) + 1,
            ),
        ),
        else_=Indent.status,
    )
    indent_notification_type = or_(
        Notification.entity_type == DocType.INDENT.value,
        Notification.entity_type.startswith(INDENT_STATUS_NOTIFICATION_PREFIX),
    )
    has_persisted_notification = exists(
        select(Notification.id).where(
            Notification.employee_id == user.id,
            Notification.entity_id == Indent.id,
            indent_notification_type,
        )
    )
    persisted_stmt = (
        select(
            (literal("notification:") + cast(Notification.id, String)).label("id"),
            Indent.id.label("indent_id"),
            Indent.indent_no,
            Notification.title.label("title"),
            func.coalesce(Notification.body, literal("")).label("message"),
            cast(literal(None), String).label("_approver_name"),
            notification_status.label("status"),
            Notification.created_at.label("created_at"),
            literal("notification").label("_source"),
        )
        .join(Indent, Indent.id == Notification.entity_id)
        .where(Notification.employee_id == user.id)
        .where(indent_notification_type)
        .where(visible)
    )
    legacy_stmt = (
        select(
            (
                literal("indent:") + cast(Indent.id, String)
                + literal(":") + Indent.status
            ).label("id"),
            Indent.id.label("indent_id"),
            Indent.indent_no,
            legacy_title.label("title"),
            legacy_message.label("message"),
            Indent.current_approver_name.label("_approver_name"),
            Indent.status,
            Indent.updated_at.label("created_at"),
            literal("legacy").label("_source"),
        )
        .where(visible)
        .where(Indent.status.in_(supported_statuses))
        .where(~has_persisted_notification)
    )
    notification_rows = union_all(persisted_stmt, legacy_stmt).subquery("notification_rows")
    stmt = select(notification_rows)
    term = _clean_search(search)
    if term:
        pattern = _like_pattern(term)
        stmt = stmt.where(or_(
            _matches(notification_rows.c.indent_no, pattern),
            _matches(notification_rows.c.title, pattern),
            _matches(notification_rows.c.message, pattern),
            _matches(func.replace(notification_rows.c.status, "_", " "), pattern),
        ))
    if date_from:
        stmt = stmt.where(
            notification_rows.c.created_at >= datetime.combine(date_from, time.min)
        )
    if date_to:
        stmt = stmt.where(
            notification_rows.c.created_at
            < datetime.combine(date_to + timedelta(days=1), time.min)
        )
    if statuses:
        stmt = stmt.where(notification_rows.c.status.in_(_values(statuses)))
    stmt = stmt.order_by(
        notification_rows.c.created_at.desc(),
        notification_rows.c.indent_id.desc(),
        notification_rows.c.id.desc(),
    )

    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (
        await db.execute(stmt.offset(params.offset).limit(params.size))
    ).mappings().all()

    items = [dict(row) for row in rows]
    pending_items = {
        row["indent_id"]: row
        for row in items
        if row["status"] == IndentStatus.PENDING_APPROVAL.value
        and row.get("_source") == "legacy"
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
        row.pop("_source", None)
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

# A material request that no longer holds demand: refused, withdrawn, or delivered.
# The queue and the allocation guards both subtract what is "on order", and both must
# read the same list — a delivered request counted as outstanding is stock nobody can
# allocate, a rejected one counted as outstanding is a line nobody can serve.
ZERO = Decimal("0")

#: What of an MR line is still being bought: asked for, less what has already reached
#: stock. A request delivered in parts stays OPEN, so the status filter alone kept the
#: lines that had arrived counting as on order and the desk offered 0 of them.
_MR_STILL_COMING = func.greatest(
    MaterialRequestItem.quantity
    - func.coalesce(MaterialRequestItem.received_quantity, 0), 0)

_SETTLED_MR_STATUSES = (
    MRStatus.REJECTED.value, MRStatus.CANCELLED.value, MRStatus.RECEIVED.value,
    # FIXED 2026-08-21 — DRAFT counts as settled for this arithmetic, which is only
    # ever asked "how much of this line is somebody already buying". A draft is not:
    # nobody has submitted it, so no purchase exists behind it. An auto-raised
    # shortfall MR never sits here (`create_mr_from_shortfall` submits it in the same
    # call), so the only rows this touches are hand-typed requests somebody abandoned
    # — and every one of those was subtracting from the remainder forever, keeping its
    # indent line off the fulfilment desk with nothing on order to justify it.
    MRStatus.DRAFT.value,
)
# Read by the "on order" term of `has_remainder` and by `_on_order_by_lines`. Both
# directions are silent failures, so change it with the two of them in mind: a status
# wrongly treated as STILL ON ORDER keeps subtracting and hides its indent line from
# the Fulfilment Desk forever; one wrongly treated as SETTLED puts the line back on
# the desk while procurement is still buying it, and the desk allocates against stock
# that is already spoken for.

_ALLOCATION_ELIGIBLE_STATUSES = {
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.PARTIALLY_ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
    # An approver serving the request out of their own stocking point allocates while
    # the indent is still climbing — that is the whole cascade. Refusing it here is
    # what sent them to a separate screen to do the same thing.
    IndentStatus.PENDING_APPROVAL.value,
}


async def _committed_by_line(db: AsyncSession, indent_id: int) -> dict[int, Decimal]:
    """Per line, what an UNSIGNED allocation has already promised.

    `allocated_quantity` only moves when an allocation is APPROVED, so without this a
    line another rung committed an hour ago still reads as completely unserved.

    Only the unsigned ones, because every caller adds this to `allocated_quantity` —
    which is itself the APPROVED sum. Including approved allocations here counted them
    on both sides and hid real demand from the allocate screen.
    """
    rows = (await db.execute(
        select(AllocationItem.indent_item_id, func.sum(AllocationItem.quantity))
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(Allocation.indent_id == indent_id,
               Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES))
        .group_by(AllocationItem.indent_item_id)
    )).all()
    return {line_id: Decimal(str(qty or 0)) for line_id, qty in rows}


def _ensure_allocation_eligible(indent: Indent) -> None:
    if indent.status not in _ALLOCATION_ELIGIBLE_STATUSES:
        raise ValidationError(
            f"Indent {indent.indent_no} is not eligible for allocation in status {indent.status}"
        )


async def _in_approval_block_reason(db: AsyncSession, indent: Indent, user) -> str | None:
    """Why this login may NOT allocate an indent that is still climbing — or None.

    PENDING_APPROVAL sits in `_ALLOCATION_ELIGIBLE_STATUSES` for ONE reason: the
    approver the document is currently with serving it out of his own stocking point,
    which is the cascade. It was never meant to open the allocate screen to everybody
    else holding ALLOCATION_CREATE — and it did. An approver who has already signed and
    passed the indent on stays visible to himself in the fulfilment queue (he is a
    participant in `indent_access_condition`), so he could raise a further allocation
    against it, sign it himself as the OWN_STOCK_ALLOCATION ladder's own rung, and —
    once it covered every line — reach `_settle_indent_approval` -> `engine.settle`,
    which cleared the pending task of the approver it was actually waiting on. The rung
    above never saw the request.

    Exactly the two questions `approvals.fulfilment._may_settle` and
    `_wrong_hat_message` ask, so the allocate screen and "issue from my stock" answer
    identically: am I the rung this document is parked on, and am I wearing the post
    the ladder named. Both read `wf_pending` and the resolved chain, which leaves
    Approvals Config the only authority — no role, rank or permission code appears
    here, so reconfiguring a ladder moves this gate with it.

    Every other eligible status is untouched: the inventory desk allocating an
    AWAITING_ALLOCATION indent, a monthly cycle allocated in batch, a part-short
    request going round again — none of them are PENDING_APPROVAL and none reach here.
    """
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        return None
    instance = await _pending_indent_return_instance(db, indent.id, getattr(user, "id", None))
    if instance is None:
        return (
            f"{indent.indent_no} is still in approval and is not waiting on you. Only "
            "the approver it is currently with can serve it from their own stock; "
            "anyone else has to wait for it to reach inventory."
        )
    # Only asked of a login wearing more than one hat — the engine's own set, so a
    # person with one post (or none) is never in it and reaches the screen unchanged.
    if instance.id in await engine.instances_for_other_hats(
            db, user, [DocType.INDENT.value]):
        link = _current_workflow_link(instance) or {}
        return (
            f"{indent.indent_no} is waiting on "
            + (link.get("position_name") or "another of your positions")
            + ". Switch to that position before allocating against it — allocating "
              "under this one would raise the allocation and then be unable to pass "
              "the remainder on."
        )
    return None


def _quantities_recorded(indent: Indent) -> bool:
    """Did this indent's approval chain actually write quantities.

    `approved_quantity` 0 is ambiguous. It means either "the approver cut this line to
    nothing" or "no approval ever recorded a quantity here" — an indent approved
    through the plain approve endpoint, or one raised before submit-time seeding
    existed, carries 0 on every line having recorded nothing.

    One quantity above zero anywhere on the indent settles it: this chain records
    quantities, so a zero on a sibling line is a deliberate zero. Same test
    `approvals.service._recorded_quantities` applies, kept in step with it on purpose.

    Ladder-agnostic by construction: it asks whether numbers were written, never how
    many rungs wrote them or which rung the document is on, so reconfiguring a ladder
    cannot change the answer.
    """
    return any(Decimal(str(line.approved_quantity or 0)) > 0 for line in indent.items)


def _owed_quantity(line, quantities_recorded: bool) -> Decimal:
    """What a line is actually owed — the number every fulfilment screen must agree on.

    With quantities recorded, `approved_quantity` stands as written, including zero.
    Without, nothing was approved line by line and the request itself is the figure.

    The old `approved_quantity or line.quantity` collapsed those two cases, and since
    zero is falsy in Python a line an approver had cut to nothing reappeared in the
    fulfilment queue asking for its full original quantity.
    """
    if quantities_recorded:
        return Decimal(str(line.approved_quantity or 0))
    return Decimal(str(line.quantity or 0))


async def _recorded_indent_ids(db: AsyncSession, indent_ids) -> set[int]:
    """`_quantities_recorded` for many indents at once.

    Readers that hold one line per indent (the item-first demand view) cannot run the
    any()-test in memory. One grouped query answers it for the whole page rather than
    one query per indent.
    """
    if not indent_ids:
        return set()
    return set((await db.execute(
        select(IndentItem.indent_id)
        .where(IndentItem.indent_id.in_(indent_ids),
               IndentItem.approved_quantity > 0)
        .distinct()
    )).scalars().all())


async def allocation_proposal(db: AsyncSession, indent_id: int, user=None) -> dict:
    """What the allocation screen needs: the indent lines, what is still owed on each,
    which stocking points hold it, and how much other indents are already waiting on.

    Read-only. Reserves nothing.
    """
    stmt = select(Indent).options(selectinload(Indent.items)).where(
        Indent.id == indent_id)
    indent = (await db.execute(stmt)).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")

    committed = await _committed_by_line(db, indent_id)
    on_order = await _on_order_by_line(db, indent_id)

    # Read-only, so it never refuses. Every row in the fulfilment queue opens THIS
    # screen — one row, one destination — and the screen says what state the indent is
    # in rather than the router guessing between four pages and a red error. An indent
    # already served out of an approver's own stock, or finished, opens here showing
    # its allocations; only the Submit is withheld, by `allocatable`.
    #
    # The write path (`decide_allocation`) still calls `_ensure_allocation_eligible` —
    # that is the guard that matters, and no screen state can talk past it.
    recorded = _quantities_recorded(indent)

    # What is already promising this indent something, so the screen can point at it
    # instead of leaving the reader to go looking in Allocation Approvals. Read before
    # `blocked_reason` because one of the reasons IS this list.
    live = (await db.execute(
        select(Allocation.id, Allocation.allocation_no, Allocation.status)
        .where(Allocation.indent_id == indent_id,
               Allocation.status.in_(allocations.ACTIVE_ALLOCATION_STATUSES))
        .order_by(Allocation.id.desc())
    )).all()
    unapproved = [row for row in live
                  if row.status in allocations.UNAPPROVED_ALLOCATION_STATUSES]

    eligible_items = [
        line for line in indent.items
        if not getattr(line, "is_excluded", False)
        and not (
            recorded
            and _owed_quantity(line, recorded) <= Decimal("0")
            and Decimal(str(line.allocated_quantity or 0)) <= Decimal("0")
        )
    ]

    blocked_reason = None
    if indent.status not in _ALLOCATION_ELIGIBLE_STATUSES:
        blocked_reason = (
            f"This indent is {indent.status.replace('_', ' ').lower()} — "
            f"there is nothing to allocate."
        )
    # Still climbing, and parked on somebody else: readable, not decidable. Asked here
    # as well as in `decide_allocation` so the screen withholds the Submit and says why
    # in words, rather than offering a button that comes back red.
    elif user is not None and (
            reason := await _in_approval_block_reason(db, indent, user)):
        blocked_reason = reason
    # An allocation somebody already raised and nobody has signed. The arithmetic
    # below only sees what it GAVE, so an allocation that gave nothing — the whole
    # requirement sent to procurement — left this screen offering a Submit that
    # `allocations.ensure_no_active` could only refuse. Said in words here, with the
    # document itself linked beside it. Not RBAC-sensitive: it reports a document this
    # indent already carries, and the read is the same one the screen renders.
    elif unapproved:
        blocked_reason = (
            f"Allocation {unapproved[0].allocation_no} is awaiting approval — "
            f"nothing can be allocated for this indent until it is approved, "
            f"rejected or cancelled."
        )
    elif indent.items and not any(
        _owed_quantity(line, recorded)
        - Decimal(str(line.allocated_quantity or 0))
        - committed.get(line.id, Decimal("0"))
        - on_order.get(line.id, Decimal("0")) > 0
        for line in eligible_items
    ):
        if not eligible_items:
            blocked_reason = (
                "All items in this indent were rejected during approval — "
                "there is nothing to allocate."
            )
        else:
            blocked_reason = (
                "Every line is already covered by an allocation or an active material "
                "request. Outstanding demand becomes available again when procurement "
                "is received, rejected or cancelled."
            )

    lines = [{
        "indent_item_id": line.id,
        "item_id": line.item_id,
        "item_code": line.item_code,
        "item_name": line.item_name,
        "uom_code": line.uom_code,
        # What is STILL owed, not what was originally approved. A line another rung has
        # already committed would otherwise be offered again in full, and the screen
        # would happily promise the same goods twice. A line approved at zero is owed
        # nothing and clamps to zero here.
        "requested_qty": float(max(
            _owed_quantity(line, recorded)
            - Decimal(str(line.allocated_quantity or 0))
            - committed.get(line.id, Decimal("0"))
            - on_order.get(line.id, Decimal("0")),
            Decimal("0"),
        )),
        "already_allocated": float(
            Decimal(str(line.allocated_quantity or 0)) + committed.get(line.id, Decimal("0"))
        ),
        "on_order_qty": float(on_order.get(line.id, Decimal("0"))),
        "project_id": indent.project_id,
        # What the indent asked for — a brand / variant / model, or Any (2026-10-23).
        **combinations.carry(line),
    } for line in eligible_items]

    # Points this person may DRAW FROM: the stocking points they hold or that report
    # under them, UNION whatever their job profile's data scope opens up. The subtree
    # alone was the whole rule, so an inventory manager granted `stock.view_all` — who
    # sees every point on Stock Balance — was offered only the one warehouse tagged to
    # his own post here, and every other line fell through to procurement. None means
    # unrestricted (admin, `stock.view_all`, ALL rung) and drops the filter entirely.
    my_points = (await inventory_service.drawable_warehouse_ids(db, user)
                 if user is not None else None)

    proposal = await allocations.propose(
        db, indent_id, lines,
        warehouse_ids=sorted(my_points) if my_points else None)
    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "department_name": indent.department_name,
        "requested_by_name": indent.requested_by_name,
        "status": indent.status,
        # False means "look, don't decide": the lines are still worth reading, the
        # Submit is not offered, and `blocked_reason` says why in words.
        "allocatable": blocked_reason is None,
        "blocked_reason": blocked_reason,
        "allocations": [{"id": row.id, "allocation_no": row.allocation_no,
                         "status": row.status} for row in live],
        # The point an STR asked to be served from (2026-11-04): the screen opens every
        # line on it when this login can draw from it.
        "str_source_warehouse_id": (indent.source_warehouse_id
                                    if indent.indent_type == IndentType.STR.value else None),
        "str_source_warehouse_name": (indent.source_warehouse_name
                                      if indent.indent_type == IndentType.STR.value else None),
        "lines": [{**p, "available_total": float(p["available_total"]),
                   # What the WAREHOUSE can serve, LIP and MDP points excluded. Zero
                   # here with stock still showing in `available_total` is the case the
                   # Raise MR button exists for: servable, but not from the warehouse.
                   "main_available_qty": float(p["main_available_qty"]),
                   "competing_demand": float(p["competing_demand"]),
                   "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                                  for w in p["warehouses"]]}
                  for p in proposal],
    }


async def item_claims(db: AsyncSession, item_id: int, indent_id: int, user=None) -> dict:
    """"12 claimed by other indents", opened up: which indents, how much each, and
    what is on the shelf behind the number.

    The stock half is scoped to the points this login may draw from — the same set
    the allocation screen counts `available` over, so the two agree. The claims half
    is not: an allocator has to know a claim exists even when it was raised somewhere
    they cannot see stock.
    """
    warehouse_ids = (await inventory_service.warehouse_ids_for_user(db, user)
                     if user is not None else None)
    return await allocations.competing_claims(
        db, item_id, indent_id, warehouse_ids=warehouse_ids)


async def decide_allocation(db: AsyncSession, body, user):
    """A person has decided how much to give. Record it and send it for approval."""
    indent = await db.get(Indent, body.indent_id)
    if indent is None:
        raise NotFoundError(f"Indent {body.indent_id} not found")
    # Reached through `stock.transfer.serve` alone: only an STR may be served.
    if (indent.indent_type != IndentType.STR.value
            and via_scoped_grant(db, perms.ALLOCATION_CREATE)):
        raise PermissionError_("Missing permission: allocation.create")
    _ensure_allocation_eligible(indent)
    # The status gate says WHAT may be allocated; this says WHO. See
    # `_in_approval_block_reason` — an indent still climbing is only the current rung's
    # to serve, and `create_allocation_for_indent` deliberately leaves that to its
    # callers (the own-stock path in approvals has its own, identical, gate).
    blocked = await _in_approval_block_reason(db, indent, user)
    if blocked:
        raise ValidationError(blocked)
    return await create_allocation_for_indent(
        db, indent, [d.model_dump() for d in body.decisions], user, body.remarks)


async def decide_allocations_batch(db: AsyncSession, body, user) -> dict:
    """One allocation per indent for a whole monthly cycle, in one request.

    Each indent goes through `decide_allocation` exactly as if the storekeeper had
    opened its own screen — same eligibility gate, same ladder, same `stk_reservation`
    rows (rule 7). The batch screen only fills the numbers in faster.

    Deliberately NOT atomic across indents, for the same reason
    `approvals.approve_consolidation` is not: one indent that somebody else has already
    served must not throw away the other 899 decisions. It comes back under `failed`
    with the reason and the screen re-reads.
    """
    created: list[int] = []
    failed: list[dict] = []
    for one in body.allocations:
        try:
            await decide_allocation(db, one, user)
            created.append(one.indent_id)
        except Exception as exc:  # noqa: BLE001 - one bad row must not lose the batch
            # One document's problem is not the batch's: record it and carry on. The
            # rollback empties the identity map, so the next indent starts clean.
            await db.rollback()
            # A rollback EXPIRES every object it loaded, including `user`. The next
            # iteration then touches user.full_name, SQLAlchemy tries to reload it
            # lazily outside async context, and the whole request dies with
            # MissingGreenlet — so one already-approved row took the other 899 with it.
            await db.refresh(user)
            if not isinstance(exc, AppException):
                logger.exception("Batch allocation failed on indent %s", one.indent_id)
            indent = await db.get(Indent, one.indent_id)
            failed.append({
                "indent_id": one.indent_id,
                "indent_no": indent.indent_no if indent else None,
                "reason": str(getattr(exc, "message", None) or exc),
            })
    # This click was the cycle decision, so the batch it decided stops accepting
    # members. A monthly indent approved after this opens the next consolidation for
    # the month instead of quietly joining work already allocated.
    # Its own commit: every allocation above committed inside
    # `create_allocation_for_indent`, so the seal is left as the only pending change
    # and nothing further down the request would write it.
    sealed = await seal_consolidations(db, created, user)
    if sealed:
        await db.commit()
    return {"created_count": len(created), "created_indent_ids": created,
            "sealed_consolidations": sealed, "failed": failed}


async def _reconcile_indent_mr_receipts(db: AsyncSession, indent_id: int) -> None:
    """If POs or receipts exist for this indent, ensure the shortfall MRs reflect the received goods."""
    try:
        from app.modules.procurement.models import PurchaseOrder, POItem, Requisition
        from app.modules.warehouse import models as whs_models
        from app.modules.warehouse.enums import ReceiptStatus

        mrs = list((await db.execute(
            select(MaterialRequest)
            .options(selectinload(MaterialRequest.items))
            .where(
                MaterialRequest.indent_id == indent_id,
                MaterialRequest.status.notin_(_SETTLED_MR_STATUSES),
            )
        )).scalars().unique().all())
        if not mrs:
            return

        mr_ids = [mr.id for mr in mrs]
        po_ids = list((await db.execute(
            select(PurchaseOrder.id).where(PurchaseOrder.indent_id == indent_id)
        )).scalars().all())

        req_po_ids = list((await db.execute(
            select(PurchaseOrder.id)
            .join(Requisition, Requisition.id == PurchaseOrder.requisition_id)
            .where(Requisition.source_mr_id.in_(mr_ids))
        )).scalars().all())

        all_po_ids = list(set(po_ids) | set(req_po_ids))
        if not all_po_ids:
            return

        receipt_rows = (await db.execute(
            select(
                POItem.item_id,
                POItem.indent_item_id,
                func.coalesce(func.sum(whs_models.ReceiptItem.received_qty), 0),
            )
            .join(whs_models.Receipt, whs_models.Receipt.id == whs_models.ReceiptItem.receipt_id)
            .join(POItem, POItem.id == whs_models.ReceiptItem.po_item_id)
            .where(
                whs_models.Receipt.po_id.in_(all_po_ids),
                whs_models.Receipt.status.in_([
                    ReceiptStatus.RECEIVED.value, ReceiptStatus.INSPECTED.value,
                    ReceiptStatus.CLOSED.value,
                ]),
            )
            .group_by(POItem.item_id, POItem.indent_item_id)
        )).all()

        for item_id, indent_line_id, qty in receipt_rows:
            q = _d(qty)
            if q <= ZERO:
                continue
            for mr in mrs:
                for mr_item in mr.items:
                    if (indent_line_id and mr_item.indent_item_id == indent_line_id) or (mr_item.item_id == item_id):
                        mr_item.received_quantity = max(
                            _d(mr_item.received_quantity or 0),
                            min(_d(mr_item.quantity), q),
                        )
                if all(_d(mi.received_quantity or 0) >= _d(mi.quantity) for mi in mr.items):
                    mr.status = MRStatus.RECEIVED.value
        await db.commit()
    except Exception:
        pass


async def _on_order_by_line(db: AsyncSession, indent_id: int) -> dict[int, Decimal]:
    """Quantity per indent line already handed to procurement as a material request.

    The Fulfilment Queue subtracts this before it offers an indent for allocation
    (`on_order`, in `list_fulfilment_queue`); the allocation guards below did not, and
    the comment claiming the two agreed was simply wrong. That gap is how one line was
    signed off with a ZERO allocation, sent to procurement as a material request, and
    then had a SECOND allocation raised against it for the same quantity — the line
    would have been bought and issued.

    Same status filter as the queue: a rejected or cancelled request is not on order.
    """
    await _reconcile_indent_mr_receipts(db, indent_id)
    rows = (await db.execute(
        select(
            MaterialRequestItem.indent_item_id,
            MaterialRequestItem.item_id,
            func.coalesce(func.sum(_MR_STILL_COMING), 0),
        )
        .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
        .join(IndentItem, IndentItem.id == MaterialRequestItem.indent_item_id)
        .where(
            IndentItem.indent_id == indent_id,
            MaterialRequest.status.notin_(_SETTLED_MR_STATUSES),
        )
        .group_by(MaterialRequestItem.indent_item_id, MaterialRequestItem.item_id)
    )).all()
    result: dict[int, Decimal] = {}
    for line_id, item_id, quantity in rows:
        if not line_id:
            continue
        q = _d(quantity)
        stock_qty = (await db.scalar(
            select(func.coalesce(func.sum(Stock.available_qty), 0))
            .where(
                Stock.item_id == item_id,
                or_(Stock.expiry_date.is_(None), Stock.expiry_date >= ist_today()),
            )
        )) or ZERO
        result[int(line_id)] = max(ZERO, q - _d(stock_qty))
    return result


def _reject_over_allocation(indent: Indent, decisions: list[dict],
                            on_order: dict[int, Decimal] | None = None) -> None:
    """Nobody may be given more than they asked for.

    `allocations.create` already refuses to promise stock that is not on the shelf, but
    nothing checked the other end: a line asking for 15 could be allocated 181 as long
    as 181 existed somewhere, and the indent would then close claiming 181 were issued.
    The stock guard cannot do this one — it lives in `inventory`, which may not read
    `ind_indent_items` (rule 5) — so the module that owns the document does it.

    Summed per line, because one line legitimately arrives as several decisions when it
    is served from more than one point.

    `on_order` is what procurement is already sourcing for the line (see
    `_on_order_by_line`). It is owed to the requester exactly once: allocating it a
    second time off a shelf double-counts the demand and leaves a live purchase behind
    for goods that were issued from stock.
    """
    on_order = on_order or {}
    owed = {
        line.id: (
            owed_quantity(line)
            - _d(line.allocated_quantity)
            - on_order.get(line.id, Decimal("0"))
        )
        for line in indent.items
    }
    names = {line.id: line.item_name or line.item_code or line.item_id
             for line in indent.items}

    wanted: dict[int, Decimal] = defaultdict(Decimal)
    for decision in decisions:
        wanted[decision["indent_item_id"]] += _d(decision.get("quantity"))

    for line_id, quantity in wanted.items():
        if line_id not in owed:
            raise ValidationError(
                f"Line {line_id} is not on {indent.indent_no}")
        remaining = max(owed[line_id], Decimal("0"))
        if quantity > remaining:
            ordered = on_order.get(line_id, Decimal("0"))
            detail = (
                f" ({ordered} of it is already on a material request with procurement)"
                if ordered > 0 else ""
            )
            raise ValidationError(
                f"{names[line_id]}: cannot allocate {quantity} against "
                f"{indent.indent_no} — only {remaining} is still owed on that "
                f"line{detail}."
            )


async def _decide_combinations(db: AsyncSession, indent: Indent,
                               decisions: list[dict]) -> None:
    """Which brand / variant / model each decision gives (2026-10-23).

    An indent line that named one gives exactly that — the client cannot change it.
    A line that said Any is settled HERE, by the storekeeper's pick off the shelf,
    checked against the item's ON combinations; with no pick it stays Any and the
    reservation draws from whichever combination the point holds.
    """
    lines = {line.id: line for line in indent.items}
    for d in decisions:
        line = lines.get(d.get("indent_item_id"))
        no_brand = bool(d.get("no_brand")) and not int(d.get("brand_id") or 0)
        d["no_brand"] = no_brand
        if line is not None and line.brand_id:
            asked = combinations.carry(line)
            chosen = (int(d.get("brand_id") or 0), int(d.get("variant_id") or 0),
                      int(d.get("model_id") or 0))
            if no_brand:
                # Stock booked in before brands were recorded (2026-10-24): which
                # brand it is cannot be known, so it is given AS no brand — and
                # recorded as a change from what the indent asked for.
                d.update(combinations.NONE)
                d["substituted_from"] = " · ".join(
                    p for p in (asked["brand_name"], asked["variant_name"],
                                asked["model_name"]) if p) or "the brand asked for"
            elif chosen[0] and chosen != (asked["brand_id"], asked["variant_id"],
                                        asked["model_id"]):
                # ANOTHER brand than the indent named (2026-10-24): allowed, checked
                # against the item's combinations, and recorded on the line with what
                # was asked for — so the change is never silent.
                d.update(await combinations.resolve(
                    db, d["item_id"], d, label=d.get("item_name") or ""))
                d["substituted_from"] = " · ".join(
                    p for p in (asked["brand_name"], asked["variant_name"],
                                asked["model_name"]) if p) or "the brand asked for"
            else:
                d.update(asked)
        elif d.get("brand_id"):
            d.update(await combinations.resolve(
                db, d["item_id"], d, label=d.get("item_name") or ""))
        elif no_brand:
            d.update(combinations.NONE)
        else:
            d.update({**combinations.NONE,
                      "combination_any": bool(line is not None and line.combination_any)})


async def create_allocation_for_indent(db: AsyncSession, indent: Indent,
                                       decisions: list[dict], user,
                                       remarks: str | None = None):
    """Raise one allocation against an indent and start its ladder.

    Called from the allocation screen and from an approver serving the indent out of
    their own stocking point. The status gate lives in the callers, not here: an
    approver commits their own stock while the indent is still PENDING_APPROVAL, which
    is exactly the moment the allocation screen must refuse.
    """
    # Approved allocations do not block a further one while the indent still owes
    # something — that IS the cascade, each rung allocating what it holds. Only
    # inventory knows about allocations and only indents knows the remainder, so the
    # answer is worked out here and handed over.
    await db.refresh(indent, attribute_names=["items"])
    # `owed_quantity`, not the raw approved column: 69 of the live lines predate the
    # approval flow and carry approved_quantity 0, which read literally says "owes
    # nothing" and let an already-approved allocation block the cascade forever. The
    # fulfilment queue computes its remainder the same way — the two must agree or the
    # queue offers an indent whose submit can never pass.
    # Less whatever is already on order. Without this the guard was looser than the
    # queue that feeds it: the queue correctly hid an indent whose shortfall had gone
    # to procurement, but any other door into the allocation form — a saved URL, the
    # own-stock path, the batch screen — still passed, and `allow_additional` then let
    # `ensure_no_active` wave a second allocation through for quantity already bought.
    on_order = await _on_order_by_line(db, indent.id)
    still_owed = any(
        owed_quantity(line)
        > _d(line.allocated_quantity) + on_order.get(line.id, Decimal("0"))
        for line in indent.items
    )
    _reject_over_allocation(indent, decisions, on_order)

    # Which approval event this is. Every source point inside the raiser's own
    # reporting subtree means he is serving his own stock, and the point owner — not
    # the inventory desk — is the one with something to say about it. A single source
    # he does not hold makes it an ordinary inventory allocation.
    sources = {d.get("warehouse_id") for d in decisions
               if d.get("warehouse_id") and Decimal(str(d.get("quantity") or 0)) > 0}
    my_points = await locations.location_ids_for_user(db, user)
    # FIXED 2026-08-21 — giving NOTHING names no source at all, and `sources and ...`
    # then short-circuited to an ordinary ALLOCATION. So the same storekeeper, deciding
    # over the same shelf, was the rung on his own document when he gave 2 and a
    # stranger to it when he gave 0: the empty case fell through to the code-level
    # fallback and landed on System Admin. ALL/2026-27/00080 is the live proof — raised
    # by MAHENDRA, who holds the only point involved, and pending on Administrator, so
    # neither Allocation Approvals nor the cycle screen offered him anything to press.
    #
    # It also compounds, because "gave nothing" is exactly the document that comes BACK
    # when procurement delivers: the reopened allocation keeps the doc type it was
    # classified under, so the wrong approver outlives the shortage that caused it.
    #
    # By the rule this function already states — a single source he does NOT hold makes
    # it an ordinary allocation — no sources means no such point, so it stays his. The
    # `my_points` guard keeps it honest: a central desk that holds no point of its own
    # is not serving its own stock, and still goes down the inventory ladder.
    own_stock = (sources <= my_points) if sources else bool(my_points)
    doc_type = (DocType.OWN_STOCK_ALLOCATION.value if own_stock
                else DocType.ALLOCATION.value)

    # The project is the INDENT's, stated by the server. The batch screen sends 0 on
    # every decision, and a held lot (Stock Segregation > Project Lots) is offered
    # only to its own project's decisions — so trusting the client hid every hold.
    for d in decisions:
        d["project_id"] = indent.project_id or 0
    await _decide_combinations(db, indent, decisions)

    alloc = await allocations.create(
        db, indent.id, indent.indent_no, decisions, user,
        allow_additional=still_owed, doc_type=doc_type,
        ctx={
            "department_id": indent.department_id,
            "project_id": indent.project_id,
            "project_name": indent.project_name,
            "remarks": remarks,
            # The code-level ALLOCATION fallback is the allocator's reporting
            # manager. Without this, a perfectly healthy hierarchy was skipped and
            # every allocation fell through to System Admin.
            "requester_position_id": getattr(user, "active_position_id", None),
        },
        # The ladder can approve at submit (the allocator IS the top of it, or the
        # policy lets him sign his own). The warehouse drafts must be generated then
        # too, exactly as they are when a separate approver acts.
        on_approved=_fulfilment_drafts,
    )

    # Approved the moment it was raised, so the indent has to move here too — the
    # act_on_allocation path is never reached and the indent would sit in
    # AWAITING_ALLOCATION forever with its stock already reserved.
    #
    # Every SIGNED status, not APPROVED alone. An allocation whose short lines went to
    # procurement is signed as AWAITING_PROCUREMENT (`allocations._settle_approved`),
    # and testing APPROVED here skipped the indent update for exactly the case that
    # needs it most: a two-line indent with one line on the shelf stayed
    # AWAITING_ALLOCATION with allocated_qty 0, which is not a receivable status — so
    # the goods that WERE issued and dispatched could never be acknowledged, and the
    # destination stocking point was never credited for them.
    if alloc.status in allocations.SETTLED_ALLOCATION_STATUSES:
        was_in_approval = indent.status == IndentStatus.PENDING_APPROVAL.value
        await _recalculate_indent_allocation_state(db, indent)
        await _settle_indent_approval(db, indent, user, was_in_approval)
        await db.commit()
        await db.refresh(alloc)
    return alloc


async def list_allocations(
    db: AsyncSession,
    params: PageParams,
    status: str | None = None,
    indent_id: int | None = None,
    user=None,
):
    # Reached through `stock.transfer.serve` alone: the allocations serving STRs only.
    only = None
    if via_scoped_grant(db, perms.ALLOCATION_VIEW):
        only = select(Indent.id).where(Indent.indent_type == IndentType.STR.value)
    return await allocations.list_allocations(db, params, status, indent_id, user=user,
                                              only_indent_ids=only)


async def get_allocation(db: AsyncSession, allocation_id: int, user=None):
    # FIXED — the detail endpoint ignored the rung its list obeys. See `allocations.get`.
    return await allocations.get(db, allocation_id, user=user)


async def allocation_approval_batches(db: AsyncSession, user,
                                      include_done: bool = False) -> list[dict]:
    """Allocations awaiting this approver, grouped into the monthly cycle they serve.

    Without this the batch work simply moved the queue one step along: 900 indents
    consolidated into one approval, allocated in one screen, and then 900 separate
    allocations to open and sign. Same GROUP BY as everywhere else — nothing stored,
    each allocation still approved on its own ladder.
    """
    rows = (await db.execute(
        select(Allocation, Indent)
        .join(Indent, Indent.id == Allocation.indent_id)
        # `include_done` keeps a signed cycle reachable. Once every allocation was
        # approved the whole cycle vanished from both this screen and the fulfilment
        # queue, and search could not bring it back — the work was done but there was
        # nowhere to confirm what had been decided.
        .where(Allocation.status.in_(
            [AllocationStatus.PENDING_APPROVAL.value, AllocationStatus.APPROVED.value]
            if include_done else [AllocationStatus.PENDING_APPROVAL.value]))
        .where(Indent.indent_type == IndentType.MONTHLY.value)
        .where(await _indent_visibility(db, user))
    )).all()

    groups: dict[str, list] = defaultdict(list)
    for alloc, indent in rows:
        groups[consolidation_key(indent.consolidation_id, indent)].append((alloc, indent))

    # Which of these this login can sign under the hat they are currently wearing.
    # One person is often both the level-1 and the level-2 approver (Assistant Manager
    # and Inventory Manager), and the screen used to offer "Approve all" for rows that
    # had already climbed past their active position — the click then failed with
    # "Switch to the approval position before acting".
    all_alloc_ids = [alloc.id for group in groups.values() for alloc, _ in group]
    actionable = await engine.actionable_doc_ids(
        db, [DocType.ALLOCATION.value, DocType.OWN_STOCK_ALLOCATION.value],
        all_alloc_ids, user)
    # …and who the others are waiting on. One query for the screen: "waiting on
    # somebody else" is not something an approver can act on, and chasing it meant
    # opening each allocation to read its history.
    waiting_on = await engine.pending_approver_names(
        db, [DocType.ALLOCATION.value, DocType.OWN_STOCK_ALLOCATION.value],
        all_alloc_ids)
    # One query for every line in every cycle, and one for the units they are counted
    # in — this used to be a query per cycle inside the loop below.
    all_lines = (await db.execute(
        select(AllocationItem).where(AllocationItem.allocation_id.in_(all_alloc_ids))
    )).scalars().all() if all_alloc_ids else []
    lines_by_alloc: dict[int, list] = defaultdict(list)
    for line in all_lines:
        lines_by_alloc[line.allocation_id].append(line)
    uom_decimals = await uom.decimals_by_code(
        db, {line.uom_code for line in all_lines})
    docs = await _consolidations_by_key(db, groups.keys())
    # How many indents the CONSOLIDATION holds — not how many happen to have an
    # allocation in this approver's inbox. The screen says "indents in this cycle", and
    # that has to be the same number the Fulfilment Queue prints for the same cycle,
    # whoever is looking and whatever they have already signed.
    members = await _consolidation_member_counts(db, docs.values())

    out = []
    for key, group in groups.items():
        ids = [alloc.id for alloc, _ in group]
        lines = [line for alloc_id in ids for line in lines_by_alloc.get(alloc_id, [])]
        actionable_ids = [i for i in ids if i in actionable]
        doc = docs.get(key)
        out.append({
            "_cycle": doc.cycle if doc else key,
            "_id": doc.id if doc else 0,
            "cycle": key,
            "consolidation_no": doc.consolidation_no if doc else None,
            "consolidation_status": doc.status if doc else None,
            "month_label": _month_label(doc.cycle if doc else key),
            "allocation_ids": ids,
            "allocation_count": len(ids),
            # What the buttons act on. Empty means this hat has already signed
            # everything here — the next rung is somebody else, or the same person
            # under another position.
            "actionable_ids": actionable_ids,
            "actionable_count": len(actionable_ids),
            "pending_count": sum(
                1 for alloc, _ in group
                if alloc.status == AllocationStatus.PENDING_APPROVAL.value),
            "approved_count": sum(
                1 for alloc, _ in group
                if alloc.status == AllocationStatus.APPROVED.value),
            # The document's membership, so this figure matches the Fulfilment Queue's
            # for the same cycle. `allocated_indent_count` is the old reading — how
            # many of those members this inbox is actually holding allocations for.
            "indent_count": (members.get(doc.id) if doc
                             else len({alloc.indent_id for alloc, _ in group})),
            "allocated_indent_count": len({alloc.indent_id for alloc, _ in group}),
            "item_count": len({line.item_id for line in lines}),
            "line_count": len(lines),
            "total_qty": float(sum((_d(line.quantity) for line in lines), Decimal("0"))),
            # Per unit, because the flat total adds millilitres to boxes.
            "totals_by_uom": _totals_by_uom(
                [(line.uom_code, line.quantity) for line in lines], uom_decimals),
            "allocations": [{
                "id": alloc.id,
                "status": alloc.status,
                "can_act": alloc.id in actionable,
                # Names, not a rung number: the approver reading this wants to know
                # who to ring, and "another rung" told them nothing.
                "pending_with": waiting_on.get(alloc.id, []),
                "allocation_no": alloc.allocation_no,
                "indent_id": alloc.indent_id,
                "indent_no": alloc.indent_no,
                "requested_by_name": indent.requested_by_name,
                "office_name": indent.office_name,
                "priority": indent.priority,
                "lines": [{
                    "item_id": line.item_id,
                    "item_code": line.item_code,
                    "item_name": line.item_name,
                    "uom_code": line.uom_code,
                    "quantity": float(_d(line.quantity)),
                    "warehouse_id": line.warehouse_id,
                    "warehouse_name": line.warehouse_name,
                    # Indexed, not re-scanned: a 900-allocation cycle walked the whole
                    # line list once per allocation.
                } for line in lines_by_alloc.get(alloc.id, [])],
            } for alloc, indent in group],
        })
    # Newest month first, newest document within it — string-sorting the key alone
    # would put C9 after C10.
    out.sort(key=lambda row: (row.pop("_cycle"), row.pop("_id")), reverse=True)
    return out


async def act_on_allocations_batch(db: AsyncSession, allocation_ids: list[int],
                                   action: str, user, comments: str = "") -> dict:
    """Sign a whole cycle's allocations in one act.

    Each still goes through `act_on_allocation` — the engine owns the chain (rule 8),
    every allocation gets its own `wf_actions` row and reserves its own stock, exactly
    as if the approver had opened each one. Not atomic across allocations, for the same
    reason the consolidated indent approval is not: one that has moved on since the
    screen loaded must not block the other 899.
    """
    done: list[int] = []
    failed: list[dict] = []
    for allocation_id in allocation_ids:
        try:
            await act_on_allocation(db, allocation_id, action, user, comments)
            done.append(allocation_id)
        except Exception as exc:  # noqa: BLE001 - one bad row must not lose the batch
            # Every exception, not just AppException. An unexpected one used to escape
            # and 500 the whole request, so a batch where the FIRST allocation was
            # merely already-approved lost the other 899 decisions with no explanation.
            await db.rollback()
            # A rollback EXPIRES every object it loaded, including `user`. The next
            # iteration then touches user.full_name, SQLAlchemy tries to reload it
            # lazily outside async context, and the whole request dies with
            # MissingGreenlet — so one already-approved row took the other 899 with it.
            await db.refresh(user)
            if not isinstance(exc, AppException):
                logger.exception("Batch %s failed on allocation %s", action, allocation_id)
            alloc = await db.get(Allocation, allocation_id)
            failed.append({
                "allocation_id": allocation_id,
                "allocation_no": alloc.allocation_no if alloc else None,
                "reason": str(getattr(exc, "message", None) or exc) or exc.__class__.__name__,
            })
    return {"done_count": len(done), "done_ids": done, "failed": failed}


async def allocation_line_availability(db: AsyncSession, allocation_id: int,
                                       user=None) -> list[dict]:
    """Live free stock behind each line of one allocation — the approval screen's data."""
    return await allocations.line_availability(db, allocation_id)


async def allocation_histories(db: AsyncSession,
                               allocation_ids: list[int]) -> dict[int, list[dict]]:
    """Approval history for many allocations in ONE query.

    The cycle screen showed a history block per allocation and fetched them one at a
    time: a 900-allocation cycle opened 900 requests and took minutes to render. Same
    rows, same order, one round trip.
    """
    if not allocation_ids:
        return {}
    rows = (await db.execute(
        select(Instance.doc_id, Action)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Instance.doc_type.in_(
                   [DocType.ALLOCATION.value, DocType.OWN_STOCK_ALLOCATION.value]),
               Instance.doc_id.in_(allocation_ids))
        .order_by(Instance.doc_id, Action.acted_at, Action.id)
    )).all()
    out: dict[int, list[dict]] = {doc_id: [] for doc_id in allocation_ids}
    for doc_id, action in rows:
        out.setdefault(doc_id, []).append({
            "stage_sequence": action.stage_sequence,
            "stage_name": action.stage_name,
            "action": action.action,
            "actor_name": action.actor_name,
            "actor_position": action.actor_position,
            "comments": action.comments,
            "acted_at": action.acted_at,
        })
    return out


async def act_on_allocation(db: AsyncSession, allocation_id: int, action: str, user,
                            comments: str = "", revisions: list[dict] | None = None):
    """Approve or reject. Approval reserves the stock and updates the indent."""
    # Read the indent first: approval can raise a material request, and only this side
    # of the chain can tell inventory which project that request belongs to.
    existing = await allocations.get(db, allocation_id)
    indent = await db.get(Indent, existing.indent_id)
    alloc = await allocations.act(
        db, allocation_id, action, user, comments,
        ctx={"project_id": getattr(indent, "project_id", None),
             "project_name": getattr(indent, "project_name", None)},
        on_approved=_fulfilment_drafts,
        revisions=revisions,
    )

    # Signed either way — see create_allocation_for_indent. AWAITING_PROCUREMENT is an
    # approval that also raised a material request, not a decision still pending.
    if alloc.status in allocations.SETTLED_ALLOCATION_STATUSES:
        indent = await db.get(Indent, alloc.indent_id)
        if indent is not None:
            # Same reason as in create_allocation_for_indent: an allocation raised by
            # an approver serving their own stock can be signed off while the indent
            # is still climbing, and the recalculated status must not end that climb.
            was_in_approval = indent.status == IndentStatus.PENDING_APPROVAL.value
            await _recalculate_indent_allocation_state(db, indent)
            await _settle_indent_approval(db, indent, user, was_in_approval)
            await db.commit()
            await db.refresh(alloc)
    return alloc


async def _draft_str_issues(db: AsyncSession, indent: Indent, user) -> list:
    """Draft an STR's material issues over EVERY allocation signed for it. Levels may
    each allocate from one point, and the warehouse drafts `allocated - already issued`
    per point, so the allocations must be handed over together: one at a time, the
    second of two from one point reads as already issued and drafts nothing."""
    # Imported here, not at module load: warehouse sits after indents in the chain.
    from app.modules.warehouse import service as warehouse_service

    signed = (await db.execute(select(Allocation).where(
        Allocation.indent_id == indent.id,
        Allocation.status.in_(allocations.SETTLED_ALLOCATION_STATUSES),
    ).order_by(Allocation.id))).scalars().all()
    if not signed:
        return []
    return await warehouse_service.create_fulfilment_drafts_for_allocation(
        db,
        SimpleNamespace(indent_id=indent.id,
                        items=[line for alloc in signed for line in alloc.items]),
        user,
    )


async def _fulfilment_drafts(db: AsyncSession, alloc, user) -> list:
    """What a signed allocation hands the warehouse. An STR still in approval hands
    over nothing: its stock is reserved, but no issue exists to post until its approval
    has ended, so goods cannot leave under a request that can still be refused."""
    from app.modules.warehouse import service as warehouse_service

    indent = await db.get(Indent, alloc.indent_id)
    if indent is None or indent.indent_type != IndentType.STR.value:
        return await warehouse_service.create_fulfilment_drafts_for_allocation(db, alloc, user)
    if indent.status == IndentStatus.PENDING_APPROVAL.value:
        return []
    return await _draft_str_issues(db, indent, user)


async def _finish_str_approval(db: AsyncSession, indent: Indent, user) -> None:
    """An STR's approval has ended: what was allocated on the way up goes to the
    warehouse, and a request nothing more is owed on reads as allocated, not as waiting
    at the Fulfilment Desk. An allocation still unsigned arrives through its own
    signature, by `_fulfilment_drafts`."""
    if indent.indent_type != IndentType.STR.value:
        return
    if indent.status != IndentStatus.AWAITING_ALLOCATION.value:
        return
    await _draft_str_issues(db, indent, user)
    served = any(_d(line.allocated_quantity) > 0 for line in indent.items)
    owed = any(_d(line.approved_quantity) > _d(line.allocated_quantity) for line in indent.items)
    if served and not owed:
        await _recalculate_indent_allocation_state(db, indent)


async def _withdraw_str_allocations(db: AsyncSession, indent: Indent, user, reason: str) -> None:
    """An STR refused or returned part-way up gives back what was allocated for it."""
    if indent.indent_type != IndentType.STR.value:
        return
    if await allocations.withdraw_for_indent(db, indent.id, user, reason):
        for line in indent.items:
            line.allocated_quantity = Decimal("0")


async def _settle_indent_approval(db: AsyncSession, indent: Indent, user,
                                  was_in_approval: bool) -> None:
    """After an allocation is approved, decide whether the indent is still climbing.

    Still owed something -> it goes back to PENDING_APPROVAL and carries the remainder
    up, which is the cascade.

    Nothing owed -> the recalculated status (ALLOCATED / PARTIALLY_FULFILLED) stands
    and the indent's own approval is settled. Both halves matter: pinning it at
    PENDING_APPROVAL kept a fully-served request in the approver's queue AND hid it
    from the raiser's Acknowledgements, because PENDING_APPROVAL is not a receivable
    status — so goods that were already dispatched had nowhere to be acknowledged.
    """
    if not was_in_approval:
        return
    # An STR's ladder is ended by its approver's own press (`approve_indent`, which
    # ends it when nothing is owed), and that is what hands its stock to the warehouse
    # (`_finish_str_approval`). Settling here would end it with no issue drafted.
    if indent.indent_type == IndentType.STR.value:
        indent.status = IndentStatus.PENDING_APPROVAL.value
        return
    still_owed = any(
        Decimal(str(line.approved_quantity or 0)) > Decimal(str(line.allocated_quantity or 0))
        for line in indent.items
    )
    if still_owed:
        indent.status = IndentStatus.PENDING_APPROVAL.value
        return
    await engine.settle(
        db, DocType.INDENT.value, indent.id, user,
        "Served in full from stock — nothing left to approve.",
    )


#: What an indent's status means to the people following it, in the words the bell
#: shows. Draft/submitted events are sent only to the requester; the workflow engine
#: still owns the separate "needs your approval" rows for approvers.
_LIFECYCLE_NOTICES: dict[str, tuple[str, str]] = {
    IndentStatus.DRAFT.value: (
        "{no} draft created", "{actor} created the draft."),
    IndentStatus.PENDING_APPROVAL.value: (
        "{no} submitted for approval", "{actor} submitted it."),
    IndentStatus.ALLOCATED.value: (
        "Stock set aside", "Stock for {no} has been set aside."),
    IndentStatus.PARTIALLY_ALLOCATED.value: (
        "Part of it is coming from stock",
        "Some of {no} is from stock; the rest is on order."),
    IndentStatus.PARTIALLY_FULFILLED.value: (
        "Partially fulfilled",
        "Some of {no} has been received; the rest is on its way."),
    IndentStatus.PENDING_PROCUREMENT.value: (
        "Going to procurement", "{no} is being bought in."),
    IndentStatus.ORDERED.value: (
        "Items ordered", "All items for {no} have been ordered."),
    IndentStatus.PARTIALLY_ORDERED.value: (
        "Ordering started", "Items for {no} are being ordered."),
    IndentStatus.CLOSED.value: (
        "Request completed", "{no} is complete."),
    IndentStatus.RETURNED_FOR_CORRECTION.value: (
        "Correction requested", "{no} has been returned for correction."),
}


def _indent_notification_entity(status: str) -> str:
    return f"{INDENT_STATUS_NOTIFICATION_PREFIX}{status}"


async def notify_indent_status_event(
    db: AsyncSession,
    indent: Indent,
    status: str,
    employee_ids,
    *,
    actor=None,
) -> int:
    notice = _LIFECYCLE_NOTICES.get(status)
    if notice is None:
        return 0
    title, body = notice
    actor_name = (
        getattr(actor, "full_name", None)
        or getattr(actor, "name", None)
        or "Someone"
    )
    return await notifications.notify(
        db,
        employee_ids,
        title=title.format(no=indent.indent_no, actor=actor_name),
        body=body.format(no=indent.indent_no, actor=actor_name),
        deep_link=notifications.link_for(DocType.INDENT.value, indent.id),
        entity_type=_indent_notification_entity(status),
        entity_id=indent.id,
    )


async def notify_indent_followers(db: AsyncSession, indent: Indent, status: str) -> int:
    """Tell the people involved in this indent that it has moved on.

    WHY THIS EXISTS. The bell only ever carried three things — "needs your approval",
    "approved", "rejected" — because the workflow engine was the only thing writing
    `sys_notifications`. Everything after approval (stock set aside, gone to
    procurement, ordered, complete) happened in silence, so the only way to find out
    was to open Alerts & Notifications and read statuses off a list (BUG_SCM_0003).

    WHO GETS IT. Everybody who has actually TOUCHED the document: the raiser, plus
    every approver who acted on it. Deliberately NOT everyone who can see it — an OE's
    visibility covers their whole reporting subtree, and notifying on visibility would
    put hundreds of badge rows in front of people who never handled the request, which
    is how a bell stops being read at all. Acting on a document is the signal that you
    want to know how it ended.

    Never raises and never rolls anything back: `notify` swallows its own errors, and a
    status change must not fail because a courtesy message could not be written.
    """
    # The approvers who acted, from the same table the ledger reads. A document with no
    # workflow (a fallback, or an indent that never needed one) simply has no actors,
    # and the raiser alone is then the whole audience.
    actors = set((await db.execute(
        select(Action.actor_id)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Instance.doc_type == DocType.INDENT.value,
               Instance.doc_id == indent.id,
               Action.actor_id.isnot(None))
    )).scalars().all())
    actors.add(indent.requested_by_id)
    return await notify_indent_status_event(db, indent, status, actors)


async def _recalculate_indent_allocation_state(db: AsyncSession, indent: Indent) -> None:
    stmt = (
        select(
            AllocationItem.indent_item_id,
            func.coalesce(func.sum(AllocationItem.quantity), 0),
        )
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(
            Allocation.indent_id == indent.id,
            Allocation.status.in_(allocations.SETTLED_ALLOCATION_STATUSES),
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
    recorded = _quantities_recorded(indent)
    for item_line in indent.items:
        requested = _owed_quantity(item_line, recorded)
        allocated = allocated_by_line.get(item_line.id, Decimal("0"))
        item_line.allocated_quantity = allocated
        if requested <= 0:
            # Approved at zero. Nothing is owed, so the line is settled — calling it
            # SHORT would put a line nobody approved back in front of the store as
            # something still to find.
            item_line.status = IndentItemStatus.ALLOCATED.value
        elif allocated >= requested:
            item_line.status = IndentItemStatus.ALLOCATED.value
        elif indent.status != IndentStatus.AWAITING_ALLOCATION.value or allocated > 0:
            item_line.status = IndentItemStatus.SHORT.value
        else:
            item_line.status = IndentItemStatus.PENDING.value
        total_requested += requested
        total_allocated += allocated

    was = indent.status
    has_received = any(_d(item_line.received_quantity) > 0 for item_line in indent.items)
    all_received = (
        total_requested > 0
        and all(_d(item_line.received_quantity) >= _owed_quantity(item_line, recorded) for item_line in indent.items)
    )

    if all_received:
        indent.status = IndentStatus.CLOSED.value
    elif has_received:
        indent.status = IndentStatus.PARTIALLY_FULFILLED.value
    elif total_requested <= 0:
        # Every line approved at zero: there is nothing to allocate and nothing to
        # buy. Falling through to PENDING_PROCUREMENT would ask procurement to source
        # nothing. Rejecting it is the approver's call, not this function's.
        indent.status = IndentStatus.ALLOCATED.value
    elif total_allocated <= 0:
        indent.status = IndentStatus.PENDING_PROCUREMENT.value
    elif total_requested > 0 and total_allocated >= total_requested:
        indent.status = IndentStatus.ALLOCATED.value
    else:
        indent.status = IndentStatus.PARTIALLY_ALLOCATED.value
    # Only on an actual transition. This function is re-run on every allocation touch,
    # and re-announcing the status it already held would put a duplicate in the bell
    # every time somebody opened the desk.
    if indent.status != was:
        await notify_indent_followers(db, indent, indent.status)


async def item_demand(db: AsyncSession, item_id: int, user=None) -> dict:
    """Every indent still waiting on this item, plus what is on the shelf for it.

    This is the view Balu described: 60 bags of cement, four projects want it, split
    it. Deciding one indent at a time hides the competition, which is exactly the
    information the allocator needs.

    Scoped by `_indent_visibility` like every other indent reader (rule: the list, the
    dashboard and this screen must never disagree about which rows a login may see).
    """
    from app.modules.inventory import allocations

    stmt = (
        select(Indent, IndentItem)
        .join(IndentItem, IndentItem.indent_id == Indent.id)
        .where(IndentItem.item_id == item_id,
               Indent.status == IndentStatus.AWAITING_ALLOCATION.value)
        .order_by(Indent.created_at)
    )
    if user is not None:
        stmt = stmt.where(await _indent_visibility(db, user))
    rows = (await db.execute(stmt)).all()

    # This view holds one line per indent, so the any()-test cannot run in memory.
    # One grouped query says which of these indents had quantities approved onto
    # them, so a line cut to zero is shown as zero instead of reverting to the full
    # original request and putting goods nobody approved in front of the store.
    recorded = await _recorded_indent_ids(db, {ind.id for ind, _ in rows})

    item = await db.get(Item, item_id)
    proposal = await allocations.propose(db, 0, [
        {"indent_item_id": 0, "item_id": item_id, "project_id": None}])
    stock = proposal[0] if proposal else {
        "available_total": 0, "main_available_qty": 0, "warehouses": []}

    uom_decimals = await uom.decimals_by_code(db, [item.uom_code if item else None])

    return {
        "item_id": item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_code": item.uom_code if item else None,
        # The unit's step, so the screen's split proposes 6 gloves rather than 5.7.
        "uom_decimals": uom_decimals.get(
            item.uom_code if item else None, uom.MAX_DECIMALS),
        "available_total": float(stock["available_total"]),
        # What the WAREHOUSE can serve, LIP and MDP excluded. FIXED 2026-08-22 — the
        # single-indent screen has read this since BUG_SCM_016 and the batch desk never
        # got it, so a line with 5 sitting at one LIP and nothing anywhere else read as
        # "39 to procurement, 5 still in stock". A LIP is a distribution ENDPOINT: its
        # stock is real and an allocator may still draw on it, but it is not stock the
        # warehouse can fill an indent from, and counting it silently kept 5 units off
        # the material request. See `allocations.propose`, which already computes it.
        "main_available_qty": float(stock["main_available_qty"]),
        "warehouses": [{**w, "available_qty": float(w["available_qty"])}
                       for w in stock["warehouses"]],
        # A line approved at zero is owed nothing, so it is not demand and is left
        # out entirely rather than listed asking for 0 — the allocator splits what is
        # on the shelf across this list, and a row nobody approved should not be
        # competing for it.
        "demand": [{
            "indent_id": ind.id,
            "indent_no": ind.indent_no,
            "indent_item_id": line.id,
            "requested_by_name": ind.requested_by_name,
            "department_name": ind.department_name,
            "project_name": ind.project_name,
            "priority": ind.priority,
            "required_date": ind.required_date.isoformat() if ind.required_date else None,
            "requested_qty": float(owed),
            "raised_at": ind.created_at.isoformat() if ind.created_at else None,
        } for ind, line, owed in (
            (ind, line, _owed_quantity(line, ind.id in recorded))
            for ind, line in rows
        ) if owed > 0],
    }


# ---------------- The consolidated (item-first) fulfilment view ----------------
#
# 900 lab technicians raise 900 monthly indents. Approvals already group them onto one
# screen (approvals/service.py, "Monthly indent consolidation"), but everything
# downstream went back to one document at a time: the fulfilment queue shows 900 rows
# and nobody can see that between them they want 4,000 gloves against 2,500 on the
# shelf.
#
# Same trick as the approval side, for the same reason: a GROUP BY over rows that are
# already there, not a new document. Nothing is stored, no indent is merged, and every
# reservation still lands on its own indent line through inventory.allocation — so
# rule 7 is untouched and the single-indent screens keep working unchanged.

def split_demand(
    lines: list[dict], giving: Decimal, decimals: int = uom.MAX_DECIMALS,
) -> dict[int, Decimal]:
    """Divide one item's stock across the indent lines competing for it.

    Urgent lines are filled to the brim first — an URGENT indent asking for 4 beats a
    NORMAL one asking for 5. Whatever survives that is shared pro-rata by what each
    line still needs, in whole steps of the unit.

    `decimals` is the unit's step (`app.shared.uom`): 0 for anything counted in whole
    numbers, 3 for anything measured. Pro-rata used to round every share to 3 dp
    whatever the unit was, so 20 gloves across two lines asking 10 and 7 proposed 5.7
    gloves — a quantity no storekeeper can hand over and no bin can hold.

    Pure and total: plain dicts in, {indent_item_id: quantity} out. Never hands out
    more than `giving`, never gives a line more than it asked for.
    """
    out: dict[int, Decimal] = {line["indent_item_id"]: Decimal("0") for line in lines}
    left = max(Decimal("0"), uom.quantize(giving, decimals))

    urgent = [ln for ln in lines if ln.get("priority") == Priority.URGENT.value]
    rest = [ln for ln in lines if ln.get("priority") != Priority.URGENT.value]

    for line in urgent:
        if left <= 0:
            break
        # Down to the unit's step: an urgent line pending 5.7 of a countable item (data
        # from before this rule) is filled to 5, not handed a fraction back.
        take = min(uom.quantize(line["pending_qty"], decimals), left)
        out[line["indent_item_id"]] = take
        left -= take

    if left > 0 and rest:
        # Largest remainder in whole steps, capped at what each line still needs —
        # the same rule the approver's consolidation split uses, so the two screens
        # never propose different numbers for the same shelf.
        shares = uom.share_out(
            left,
            [_d(ln["pending_qty"]) for ln in rest],
            [_d(ln["pending_qty"]) for ln in rest],
            decimals,
        )
        for line, share in zip(rest, shares):
            out[line["indent_item_id"]] = share
    return out


def preview_split(item_row: dict, giving: float) -> list[dict]:
    """What each indent gets if this item is given `giving` in total.

    Kept beside `split_demand` so the number the allocator is shown and the number the
    allocation is written with come from one function, never two.
    """
    shares = split_demand(item_row["demand"], _d(giving),
                          item_row.get("uom_decimals", uom.MAX_DECIMALS))
    return [{**line, "give_qty": float(shares.get(line["indent_item_id"], 0))}
            for line in item_row["demand"]]


# Approved and not yet fully served. Narrower than _POST_APPROVAL_STATUSES: an indent
# already ORDERED or CLOSED is procurement's problem or nobody's, not the store's.
_BATCH_STATUSES = (
    IndentStatus.APPROVED.value,
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.PARTIALLY_ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    # A cycle member whose shortfall went to procurement is not finished and not done
    # with the store: the goods arrive, the allocation reopens
    # is recomputed net of what is on order and the rest is handed over. Left out, a
    # monthly indent that reached PENDING_PROCUREMENT vanished from the cycle row AND
    # from the screen it opens — the one status the regular queue has always kept
    # (`_ALLOCATION_ELIGIBLE_STATUSES`, `list_fulfilment_queue`) was the one a monthly
    # indent could not survive. What is still OWED on it is worked out line by line
    # below and net of `_on_order_by_lines`, so re-listing it cannot re-offer quantity
    # procurement is already buying.
    IndentStatus.PENDING_PROCUREMENT.value,
)

#: Cycles that owe nothing more. Out of the queue by default, reachable on request.
_BATCH_DONE_STATUSES = (
    IndentStatus.ALLOCATED.value,
    IndentStatus.CLOSED.value,
)


def cycle_key(indent: Indent) -> str:
    """Which month an indent was raised in.

    Still the key `approvals/service.py::_cycle_key` groups by, because before approval
    there is no document yet — the consolidation screen is a working set of whatever is
    pending, and the approver must see this month's requests together.

    After approval the month stops being the identity: `consolidation_key` is, and it
    is the only thing the downstream screens group by. Two consolidations for the same
    month is the normal case (see `Consolidation`), so grouping by month past this point
    would merge a sealed batch with the one that came after it.
    """
    return indent.indent_date.strftime("%Y-%m") if indent.indent_date else "UNDATED"


def consolidation_key(consolidation_id: int | None, indent: Indent | None = None) -> str:
    """The stable, URL-safe key one consolidation is known by across the API.

    `C41` rather than the document number, because `CON/2026-27/00041` carries slashes
    and every one of these screens puts the key in a path segment. Falls back to the
    month for a monthly indent that has no consolidation yet, so nothing 500s while a
    database is mid-backfill.
    """
    if consolidation_id:
        return f"C{consolidation_id}"
    return cycle_key(indent) if indent is not None else "UNDATED"


async def _join_consolidation(db: AsyncSession, indent: Indent, user) -> None:
    """Put a freshly approved MONTHLY indent into its month's OPEN consolidation.

    Called from `_fulfil`, so it runs exactly once per indent — on the transition into
    the fulfilment queue — whatever route the approval took (a ladder, the consolidated
    approve, or the no-approval path). Regular indents are one-off requests and never
    belong to a cycle.

    The consolidation is created on first use rather than on a schedule: a month with
    no monthly indents should not leave an empty document behind.
    """
    if indent.indent_type != IndentType.MONTHLY.value or indent.consolidation_id:
        return
    cycle = cycle_key(indent)
    # Newest OPEN one for this month. Locked because the seal below reads the same row:
    # a seal landing between this SELECT and the assignment would leave the indent
    # attached to a document that says its membership is final.
    row = (await db.execute(
        select(Consolidation)
        .where(Consolidation.cycle == cycle,
               Consolidation.status == ConsolidationStatus.OPEN.value)
        .order_by(Consolidation.id.desc())
        .limit(1)
        .with_for_update()
    )).scalars().first()
    if row is None:
        row = Consolidation(
            consolidation_no=await next_number(
                db, "consolidation", project=indent.project_name),
            cycle=cycle,
            status=ConsolidationStatus.OPEN.value,
            created_by_id=getattr(user, "id", None),
            created_by_name=getattr(user, "full_name", None),
        )
        db.add(row)
        await db.flush()
        logger.info("Opened consolidation %s for cycle %s", row.consolidation_no, cycle)
    indent.consolidation_id = row.id


async def seal_consolidations(db: AsyncSession, indent_ids: list[int], user) -> list[str]:
    """Freeze the membership of every consolidation these indents belong to.

    Called when the storekeeper submits the allocation batch — that click IS the cycle
    decision, and everything decided in it has to stay countable as one set forever.
    Indents approved afterwards open the next consolidation for the month instead of
    joining a batch somebody has already worked.

    Deliberately NOT called by the single-indent allocate screen: serving one request
    out of a cycle is not deciding the cycle, and sealing there would shatter a month
    into a document per indent.
    """
    if not indent_ids:
        return []
    ids = [row[0] for row in (await db.execute(
        select(Indent.consolidation_id)
        .where(Indent.id.in_(indent_ids), Indent.consolidation_id.isnot(None))
        .distinct()
    )).all()]
    if not ids:
        return []
    rows = (await db.execute(
        select(Consolidation).where(
            Consolidation.id.in_(ids),
            Consolidation.status == ConsolidationStatus.OPEN.value)
    )).scalars().all()
    for row in rows:
        row.status = ConsolidationStatus.SEALED.value
        row.sealed_at = utcnow()
        row.sealed_by_id = getattr(user, "id", None)
        row.sealed_by_name = getattr(user, "full_name", None)
        logger.info("Sealed consolidation %s", row.consolidation_no)
    return [row.consolidation_no for row in rows]


def _totals_by_uom(pairs, uom_decimals: dict[str, int]) -> list[dict]:
    """Cycle totals, one per unit, each rounded to what that unit can actually hold.

    A single "total asked" across a cycle added millilitres to boxes to pieces and
    printed 985.324 — a number no storekeeper can act on, and the .324 came from a
    unit that is only ever whole. Grouping by `uom_code` and quantizing with
    `shared/uom` keeps each figure in a unit somebody can count out.
    """
    totals: dict[str, Decimal] = defaultdict(Decimal)
    for uom_code, quantity in pairs:
        totals[uom_code or "—"] += _d(quantity)
    return [
        {"uom_code": code,
         "quantity": float(uom.quantize(
             total, uom_decimals.get(code, uom.MAX_DECIMALS)))}
        for code, total in sorted(totals.items(), key=lambda kv: -kv[1])
    ]


async def fulfilment_batches(db: AsyncSession, user,
                             include_done: bool = False) -> list[dict]:
    """One row per monthly cycle still owed — what the Fulfilment Queue lists instead
    of 900 identical indent rows.

    Regular indents are not grouped: they are one-off requests and the queue has always
    shown them individually. Only MONTHLY indents collapse.
    """
    # The WHOLE consolidation, every time — not only the members that are still owed
    # stock. `include_done` decides which cycles appear in the list, never how a cycle
    # is counted: a document that reported 43 members yesterday and 9 today because 34
    # of them were served is the drift this design exists to end. What is still owed is
    # reported alongside, as `owed_indent_count`.
    indents = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(await _indent_visibility(db, user))
        .where(Indent.status.in_(_BATCH_STATUSES + _BATCH_DONE_STATUSES))
        .where(Indent.indent_type == IndentType.MONTHLY.value)
    )).scalars().unique().all()

    groups: dict[str, list[Indent]] = defaultdict(list)
    for indent in indents:
        groups[consolidation_key(indent.consolidation_id, indent)].append(indent)

    uom_decimals = await uom.decimals_by_code(
        db, {line.uom_code for ind in indents for line in ind.items})
    docs = await _consolidations_by_key(db, groups.keys())
    # "Still to allocate" has to mean the same thing here as on the screen this row
    # opens: a line with QUANTITY left, not merely an indent whose status has not
    # caught up. One August indent sat in AWAITING_ALLOCATION with every line already
    # covered by a live allocation — counted by the row, absent from the list below.
    committed = await _committed_by_lines(
        db, [line.id for ind in indents for line in ind.items])
    # Quantity already with procurement. Subtracted alongside `committed` so a cycle
    # member sitting in PENDING_PROCUREMENT counts as "waiting on goods", never as
    # "still to allocate" — the row and the Submit behind it agree again.
    on_order = await _on_order_by_lines(
        db, [line.id for ind in indents for line in ind.items])
    in_approval = await _indents_in_allocation_approval(
        db, [ind.id for ind in indents])

    rows = []
    for key, group in groups.items():
        lines = [line for ind in group for line in ind.items]
        owed = [ind for ind in group
                if ind.status in _BATCH_STATUSES and ind.id not in in_approval
                and _has_demand(ind, committed, on_order)]
        waiting = [ind for ind in group if ind.id in in_approval]
        # A cycle with nothing left to allocate leaves the queue — right until somebody
        # wants to look back at the one they just finished and finds it gone, with no
        # filter that brings it back. That is what `include_done` is for. A cycle whose
        # remainder is all sitting in allocation approval stays listed too, showing 0 to
        # allocate: it is not done, and vanishing from the queue is how you lose it.
        if not owed and not waiting and not include_done:
            continue
        owed_lines = [line for ind in owed for line in ind.items]
        doc = docs.get(key)
        cycle = doc.cycle if doc else key
        rows.append({
            "_cycle": cycle,
            "_id": doc.id if doc else 0,
            "cycle": key,
            "consolidation_no": doc.consolidation_no if doc else None,
            "consolidation_status": doc.status if doc else None,
            "month_label": _month_label(cycle),
            # Members of the document. Frozen once it is sealed, so this is the number
            # every other screen showing this cycle also reports.
            "indent_count": len(group),
            # …and how many of those still owe something. The queue row and the cycle
            # screen both print this one as "still to allocate".
            "owed_indent_count": len(owed),
            # …and how many are waiting on an allocation somebody already raised.
            # Neither allocatable nor done, and the difference is the whole reason the
            # row and the Submit button used to disagree.
            "in_approval_indent_count": len(waiting),
            # Items/lines in the document as a whole…
            "item_count": len({line.item_id for line in lines}),
            "line_count": len(lines),
            # …and the ones still owing something, which is exactly what the cycle
            # screen lists. The screen showed the document's 29 items above a list of
            # 7 — true figures, different questions, printed under one word.
            "owed_item_count": len({
                line.item_id for ind in owed for line in ind.items
                if _line_pending(line, committed, on_order) > 0}),
            "owed_line_count": len([
                line for ind in owed for line in ind.items
                if _line_pending(line, committed, on_order) > 0]),
            "requester_count": len({ind.requested_by_id for ind in group}),
            "urgent_count": sum(1 for ind in owed
                                if ind.priority == Priority.URGENT.value),
            # Kept for callers that already read it, but it adds millilitres to boxes
            # and means nothing on its own. `totals_by_uom` is the honest figure.
            "total_qty": float(sum((owed_quantity(line) for line in owed_lines),
                                   Decimal("0"))),
            "totals_by_uom": _totals_by_uom(
                [(line.uom_code, owed_quantity(line)) for line in owed_lines],
                uom_decimals),
            "oldest_raised_at": min(
                (ind.created_at for ind in group if ind.created_at), default=None,
            ),
            # SCM_0082: the queue showed only the oldest date in the cycle and
            # called it "raised" with nothing saying it was a range — a cycle
            # spanning 21-22 Oct read as "raised 21 Oct", a day earlier than half
            # the indents in it. Served so the screen can say "raised 21-22 Oct"
            # instead of composing a range from a single timestamp.
            "newest_raised_at": max(
                (ind.created_at for ind in group if ind.created_at), default=None,
            ),
        })
    # Newest month first, newest document within it. Sorting on the key alone would put
    # C9 after C10, and sorting on the label would put April after August.
    rows.sort(key=lambda row: (row.pop("_cycle"), row.pop("_id")), reverse=True)
    return rows


async def _committed_by_lines(db: AsyncSession,
                              line_ids: list[int]) -> dict[int, Decimal]:
    """`_committed_by_line` for many indents at once — one query for a whole cycle.

    Unsigned allocations only, for the reason spelled out on
    `allocations.UNAPPROVED_ALLOCATION_STATUSES`.
    """
    if not line_ids:
        return {}
    return {row[0]: _d(row[1]) for row in (await db.execute(
        select(AllocationItem.indent_item_id, func.sum(AllocationItem.quantity))
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(AllocationItem.indent_item_id.in_(line_ids),
               Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES))
        .group_by(AllocationItem.indent_item_id)
    )).all()}


async def _on_order_by_lines(db: AsyncSession,
                             line_ids: list[int]) -> dict[int, Decimal]:
    """`_on_order_by_line` for many indents at once — one query for a whole cycle.

    Quantity already handed to procurement as a material request. The single-indent
    guards subtract it (`create_allocation_for_indent`), so the cycle screens must
    too: without it a line whose shortage is already being bought is offered again,
    and `_reject_over_allocation` can only refuse the Submit it invited.

    Same status filter as everywhere else — a rejected, cancelled or received request
    holds no demand.
    """
    if not line_ids:
        return {}
    indent_ids = (await db.execute(
        select(IndentItem.indent_id).where(IndentItem.id.in_(line_ids)).distinct()
    )).scalars().all()
    for i_id in indent_ids:
        await _reconcile_indent_mr_receipts(db, i_id)
    return {int(row[0]): _d(row[1]) for row in (await db.execute(
        select(MaterialRequestItem.indent_item_id,
               func.coalesce(func.sum(_MR_STILL_COMING), 0))
        .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
        .where(MaterialRequestItem.indent_item_id.in_(line_ids),
               MaterialRequest.status.notin_(_SETTLED_MR_STATUSES))
        .group_by(MaterialRequestItem.indent_item_id)
    )).all() if row[0]}


async def _indents_in_allocation_approval(db: AsyncSession,
                                          indent_ids: list[int]) -> set[int]:
    """Indents an unapproved allocation is already in flight for.

    `allocations.ensure_no_active` refuses a second proposal for these, whatever is
    left on their lines, so the queue must not offer them either: the cycle screen
    counted three of them as "still to allocate", and Submit came back with three
    "already awaiting approval" errors and nothing raised.
    """
    if not indent_ids:
        return set()
    return {row[0] for row in (await db.execute(
        select(Allocation.indent_id)
        .where(Allocation.indent_id.in_(indent_ids),
               Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES))
    )).all()}


def _has_demand(indent: Indent, committed: dict[int, Decimal],
                on_order: dict[int, Decimal] | None = None) -> bool:
    """Is any quantity on this indent still unspoken for?

    The same arithmetic `fulfilment_batch` builds its item rows from, so a cycle's
    "still to allocate" count and the list of what to allocate cannot disagree —
    including `on_order`, which is quantity procurement is already buying and which no
    allocation may be raised against a second time.
    """
    on_order = on_order or {}
    return any(
        _line_pending(line, committed, on_order) > 0
        for line in indent.items
    )


def _line_pending(line, committed: dict[int, Decimal],
                  on_order: dict[int, Decimal]) -> Decimal:
    """What one indent line is still owed off the shelf.

    The single definition the cycle row, the cycle screen and the item-first demand
    list all read, so they cannot drift apart again.
    """
    return (owed_quantity(line)
            - _d(line.allocated_quantity)
            - committed.get(line.id, Decimal("0"))
            - on_order.get(line.id, Decimal("0")))


async def _consolidations_by_key(db: AsyncSession, keys) -> dict[str, Consolidation]:
    """{`C41`: Consolidation} for the cycles on screen, in one query.

    Keys that are not `C<id>` belong to monthly indents raised before consolidations
    existed and not yet backfilled; they simply have no document and fall back to
    reading the month out of the key itself.
    """
    ids = [int(key[1:]) for key in keys if key.startswith("C") and key[1:].isdigit()]
    if not ids:
        return {}
    rows = (await db.execute(
        select(Consolidation).where(Consolidation.id.in_(ids)))).scalars().all()
    return {f"C{row.id}": row for row in rows}


async def _consolidation_member_counts(db: AsyncSession, docs) -> dict[int, int]:
    """{consolidation_id: how many indents belong to it}, in one grouped query.

    Deliberately unscoped: it is the size of the document, not the slice of it this
    login may open. A count that shrank per viewer would put two people on the phone
    disagreeing about the same batch.
    """
    ids = [doc.id for doc in docs]
    if not ids:
        return {}
    return {row[0]: row[1] for row in (await db.execute(
        select(Indent.consolidation_id, func.count(Indent.id))
        .where(Indent.consolidation_id.in_(ids))
        .group_by(Indent.consolidation_id)
    )).all()}


_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _month_label(cycle: str) -> str:
    if cycle == "UNDATED":
        return "Undated"
    year, _, month = cycle.partition("-")
    try:
        return f"{_MONTH_NAMES[int(month) - 1]} {year}"
    except (ValueError, IndexError):
        return cycle


async def fulfilment_batch(db: AsyncSession, user,
                           indent_type: str | None = None,
                           cycle: str | None = None) -> dict:
    """The fulfilment queue turned on its side: one row per ITEM, not per indent.

    Reads through `_indent_visibility` and the same "still owed" arithmetic
    `list_indents(has_remainder=True)` uses, so this screen and the queue beside it can
    never disagree about what is outstanding.
    """
    stmt = (
        select(Indent)
        .options(selectinload(Indent.items))
        .where(await _indent_visibility(db, user))
        .where(Indent.status.in_(_BATCH_STATUSES))
    )
    if cycle:
        # A cycle is a MONTHLY thing. Without this the screen also pulled in every
        # regular indent that happened to be raised in the same month, so a row the
        # queue counted as "2 indents" opened showing 11 — the batch you opened was not
        # the batch you clicked.
        stmt = stmt.where(Indent.indent_type == IndentType.MONTHLY.value)
    elif indent_type:
        stmt = stmt.where(Indent.indent_type == indent_type)
    indents = (await db.execute(stmt)).scalars().unique().all()
    if cycle:
        # The consolidation this key names, and nothing else. This used to re-derive
        # the month per indent, which meant the screen quietly re-answered "everything
        # raised in August" rather than "the batch you clicked" — two different sets the
        # moment a month holds more than one consolidation.
        indents = [indent for indent in indents
                   if consolidation_key(indent.consolidation_id, indent) == cycle]

    # Quantities a signed-off or in-flight allocation has already claimed. One grouped
    # query for the whole screen: a batch of 900 indents must not cost 900 round trips.
    line_ids = [line.id for indent in indents for line in indent.items]
    committed: dict[int, Decimal] = {}
    if line_ids:
        committed = {row[0]: _d(row[1]) for row in (await db.execute(
            select(AllocationItem.indent_item_id, func.sum(AllocationItem.quantity))
            .join(Allocation, Allocation.id == AllocationItem.allocation_id)
            .where(AllocationItem.indent_item_id.in_(line_ids),
                   # UNSIGNED only. `allocated_quantity`, subtracted alongside this a
                   # few lines below, is already the APPROVED sum — counting approved
                   # allocations here as well deducted them twice, and a line owing 16
                   # with 6 approved offered 4 instead of 10.
                   Allocation.status.in_(allocations.UNAPPROVED_ALLOCATION_STATUSES))
            .group_by(AllocationItem.indent_item_id)
        )).all()}

    # An allocation already in flight owns the whole indent until it is signed or
    # cancelled (`allocations.ensure_no_active`), so these lines are not on offer here
    # however much is left on them. Listing them produced a Submit that could only fail.
    # What procurement is already buying for these lines. `create_allocation_for_indent`
    # refuses a second allocation against it, so offering it here produced a Submit
    # that could only come back refused — and, on a cycle, one refusal per indent.
    on_order = await _on_order_by_lines(db, line_ids)

    in_approval = await _indents_in_allocation_approval(
        db, [indent.id for indent in indents])

    by_item: dict[int, list[dict]] = defaultdict(list)
    for indent in indents:
        if indent.id in in_approval:
            continue
        for line in indent.items:
            pending = _line_pending(line, committed, on_order)
            if pending <= 0:
                continue
            by_item[line.item_id].append({
                "indent_id": indent.id,
                "indent_no": indent.indent_no,
                "indent_item_id": line.id,
                "requested_by_name": indent.requested_by_name,
                "office_name": indent.office_name,
                "project_id": indent.project_id,
                "project_name": indent.project_name,
                "priority": indent.priority,
                "pending_qty": float(pending),
                "raised_at": indent.created_at.isoformat() if indent.created_at else None,
            })
    if not by_item:
        return {"items": [], "total": 0}

    items = {row.id: row for row in (await db.execute(
        select(Item).where(Item.id.in_(by_item))
    )).scalars().all()}

    # On-hand per WAREHOUSE, scoped to the points this login may draw from — the same
    # set every inventory screen uses, so these numbers match the allocation screen's.
    # Broken down rather than totalled because "give 50" is only half the decision; the
    # other half is which shelf it leaves.
    warehouse_ids = await inventory_service.warehouse_ids_for_user(db, user)
    stock_stmt = (select(Stock.item_id, Stock.warehouse_id,
                         func.sum(Stock.available_qty))
                  .where(Stock.item_id.in_(by_item))
                  .group_by(Stock.item_id, Stock.warehouse_id))
    if warehouse_ids is not None:
        stock_stmt = stock_stmt.where(Stock.warehouse_id.in_(warehouse_ids or {0}))
    stock_rows = (await db.execute(stock_stmt)).all()

    names = {row[0]: row[1] for row in (await db.execute(
        select(Warehouse.id, Warehouse.name)
        .where(Warehouse.id.in_({row[1] for row in stock_rows} or {0}))
    )).all()}
    shelves: dict[int, list[dict]] = defaultdict(list)
    on_hand: dict[int, Decimal] = defaultdict(Decimal)
    for item_id, warehouse_id, qty in stock_rows:
        quantity = _d(qty)
        on_hand[item_id] += quantity
        if quantity > 0:
            shelves[item_id].append({
                "warehouse_id": warehouse_id,
                "warehouse_name": names.get(warehouse_id) or f"Warehouse {warehouse_id}",
                "available_qty": float(quantity),
            })

    # Lots set aside for a project (Stock Segregation > Project Lots). Not in
    # `available_qty`, so not in the figures above: only that project's lines may
    # draw them, and the screen shows them per line.
    from app.modules.inventory.models import ProjectHold
    from app.shared.enums import ProjectHoldStatus
    held_stmt = (
        select(ProjectHold.item_id, ProjectHold.project_id, ProjectHold.project_name,
               ProjectHold.warehouse_id, func.sum(ProjectHold.quantity))
        .where(ProjectHold.status == ProjectHoldStatus.ACTIVE.value,
               ProjectHold.item_id.in_(by_item))
        .group_by(ProjectHold.item_id, ProjectHold.project_id,
                  ProjectHold.project_name, ProjectHold.warehouse_id)
    )
    if warehouse_ids is not None:
        held_stmt = held_stmt.where(ProjectHold.warehouse_id.in_(warehouse_ids or {0}))
    project_holds: dict[int, list[dict]] = defaultdict(list)
    held_by_project: dict[tuple[int, int], Decimal] = defaultdict(Decimal)
    for item_id, project_id, project_name, warehouse_id, qty in (
            await db.execute(held_stmt)).all():
        project_holds[item_id].append({
            "project_id": project_id, "project_name": project_name,
            "warehouse_id": warehouse_id,
            "warehouse_name": names.get(warehouse_id) or f"Warehouse {warehouse_id}",
            "quantity": float(_d(qty)),
        })
        held_by_project[(item_id, project_id)] += _d(qty)
    for item_id, lines in by_item.items():
        for line in lines:
            line["project_held_qty"] = float(
                held_by_project.get((item_id, line["project_id"]), Decimal("0")))

    # One query for the whole queue: which of these units may be split, and how finely.
    uom_decimals = await uom.decimals_by_code(
        db, {row.uom_code for row in items.values()})

    rows = []
    for item_id, lines in by_item.items():
        item = items.get(item_id)
        demand = sum((_d(line["pending_qty"]) for line in lines), Decimal("0"))
        available = on_hand.get(item_id, Decimal("0"))
        rows.append({
            "item_id": item_id,
            "item_code": item.code if item else None,
            "item_name": item.name if item else None,
            "uom_code": item.uom_code if item else None,
            "uom_decimals": uom_decimals.get(
                item.uom_code if item else None, uom.MAX_DECIMALS),
            "indent_count": len({line["indent_id"] for line in lines}),
            "urgent_count": sum(1 for line in lines
                                if line["priority"] == Priority.URGENT.value),
            "total_demand": float(demand),
            "available_total": float(available),
            "shortfall": float(max(Decimal("0"), demand - available)),
            # Fullest shelf first: the default answer to "where from" is usually the
            # one holding the most, and offering it first saves a click per item.
            "warehouses": sorted(shelves.get(item_id, []),
                                 key=lambda w: -w["available_qty"]),
            "project_holds": project_holds.get(item_id, []),
            "demand": sorted(lines, key=lambda line: (
                line["priority"] != Priority.URGENT.value, line["raised_at"] or "")),
        })
    # Worst shortfall first: the rows that need a human decision, not the easy ones.
    rows.sort(key=lambda row: (-row["shortfall"], -row["total_demand"]))
    return {"items": rows, "total": len(rows)}


# ---------------------------------------------------------------------------
# Raising a monthly cycle in bulk
#
# ~770 lab technicians raise a monthly indent each, and every one of them was typing
# the same twenty lines they typed last month into the same form. The approval and
# allocation sides already batch a cycle; only the raising end was still one-at-a-time,
# which made the whole flow unusable at real headcount.
#
# Three pieces, and none of them invent a document:
#   * `last_monthly_cycle`  — what this person raised last time, ready to reuse.
#   * `copy_monthly_cycle`  — that, as a new DRAFT, quantities editable before saving.
#   * `submit_monthly_cycle`— submit several drafts in one call, each on its own ladder.
#
# Every indent stays a separate `ind_indents` row with its own workflow instance, for
# the same reason consolidation stores nothing: the ladder resolves each one
# independently and merging them would break who-approves-what.
# ---------------------------------------------------------------------------

async def last_monthly_cycle(db: AsyncSession, user) -> dict:
    """The most recent monthly indent this person raised, as a reusable line list.

    Reads their own indents only — this is "what did I ask for last month", not a
    scope-wide query, so it needs no rung: `requested_by_id` IS the narrowest scope
    there is.
    """
    previous = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(
            Indent.requested_by_id == user.id,
            Indent.indent_type == IndentType.MONTHLY.value,
            Indent.status != IndentStatus.DRAFT.value,
        )
        .order_by(Indent.indent_date.desc(), Indent.id.desc())
        .limit(1)
    )).scalars().first()

    if previous is None:
        return {"cycle": None, "cycle_label": None, "indent_no": None,
                "required_date": None, "items": []}

    return {
        "cycle": cycle_key(previous),
        "cycle_label": _month_label(cycle_key(previous)),
        "indent_no": previous.indent_no,
        "indent_id": previous.id,
        "required_date": previous.required_date,
        "items": [
            {
                "item_id": line.item_id,
                "item_code": line.item_code,
                "item_name": line.item_name,
                "uom_code": line.uom_code,
                # What was ASKED for, not what was approved: this is a starting point
                # for next month's request, and seeding it with last month's cut would
                # ratchet the ask down a little every cycle.
                "quantity": float(line.quantity or 0),
                "approved_qty": float(line.approved_quantity or 0),
                "remarks": line.remarks,
            }
            for line in sorted(previous.items, key=lambda x: x.line_no or 0)
        ],
    }


def _next_cycle_required_date(previous_required):
    """When next month's copy is needed by, when the requester did not say.

    A required date is mandatory on every indent, so a copy has to produce one or the
    whole point (one click, no typing) is lost. Rolls last cycle's date forward a
    month, keeping the day — a store that always wants stock by the 5th keeps wanting
    it by the 5th. Anything that still lands in the past falls back to a month out,
    because a copy raised late must not be born already overdue.
    """
    today = ist_today()
    candidate = None
    if previous_required is not None:
        year, month = previous_required.year, previous_required.month + 1
        if month > 12:
            year, month = year + 1, 1
        # The 31st does not exist in every month; clamp to the last valid day.
        day = min(previous_required.day, calendar.monthrange(year, month)[1])
        candidate = date(year, month, day)
    if candidate is None or candidate < today:
        year, month = today.year, today.month + 1
        if month > 12:
            year, month = year + 1, 1
        day = min(today.day, calendar.monthrange(year, month)[1])
        candidate = date(year, month, day)
    return candidate


async def copy_monthly_cycle(db: AsyncSession, user, *, required_date=None,
                             remarks: str | None = None,
                             overrides: dict[int, float] | None = None) -> Indent:
    """Raise this month's indent from last month's, as a DRAFT.

    A draft, never submitted: the point is to save the typing, not to send an
    unreviewed request up the ladder. `overrides` is {item_id: quantity} for the lines
    the requester changed, and a quantity of 0 drops the line entirely — last month's
    list is a suggestion, not a commitment.
    """
    previous = await last_monthly_cycle(db, user)
    if not previous["items"]:
        raise ValidationError(
            "You have no earlier monthly indent to copy. Raise the first one from the "
            "normal form; next month this will fill itself in."
        )

    overrides = overrides or {}
    lines = []
    for line in previous["items"]:
        qty = overrides.get(line["item_id"], line["quantity"])
        if _d(qty) <= Decimal("0"):
            continue   # deliberately dropped for this cycle
        lines.append(IndentItemIn(item_id=line["item_id"], quantity=qty,
                                  remarks=line["remarks"]))
    if not lines:
        raise ValidationError("Every line was set to zero — there is nothing to raise.")

    # Straight through create_indent, so numbering, the requester snapshot, validation
    # and the audit row are all identical to a hand-typed indent. A second create path
    # is a second set of rules to keep in step.
    return await create_indent(db, IndentCreate(
        required_date=required_date or _next_cycle_required_date(
            previous.get("required_date")),
        indent_type=IndentType.MONTHLY,
        remarks=remarks or f"Copied from {previous['indent_no']}",
        items=lines,
    ), user)


async def submit_monthly_cycle(db: AsyncSession, user, indent_ids: list[int]) -> dict:
    """Submit several drafts in one call. One workflow instance each, as always.

    Partial success is the normal outcome, not an error: one draft failing its ladder
    resolution must not silently discard the other nineteen. Each is reported.
    """
    if not indent_ids:
        raise ValidationError("Pick at least one indent to submit")

    submitted, failed = [], []
    for indent_id in indent_ids:
        try:
            indent = await submit_indent(db, indent_id, user)
            submitted.append({"indent_id": indent.id, "indent_no": indent.indent_no,
                              "status": indent.status})
        except AppException as exc:
            # Rolled back so the next one starts clean — submit_indent commits its own
            # work, so a failure here has left nothing half-written.
            await db.rollback()
            failed.append({"indent_id": indent_id, "error": str(exc)})

    return {
        "submitted": submitted,
        "failed": failed,
        "submitted_count": len(submitted),
        "failed_count": len(failed),
    }


async def eligible_items(db: AsyncSession, user, *, search: str | None = None,
                         limit: int = 500) -> list[dict]:
    """The item catalogue as the indent form should see it — narrowed to what this
    requester may actually ask for.

    Untagged items are open to everyone, so on a system where nothing has been tagged
    this returns exactly what the item master returns (see `eligibility`). The shared
    `/api/masters/items` endpoint is deliberately left alone: procurement, the
    warehouse and the masters screens all read it, and narrowing it there would change
    every one of them.
    """
    stmt = select(Item).where(Item.is_active.is_(True))
    clause = await eligibility.eligible_filter(db, user)
    if clause is not None:
        stmt = stmt.where(clause)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(Item.code.ilike(term), Item.name.ilike(term)))
    rows = (await db.execute(stmt.order_by(Item.name).limit(limit))).scalars().all()
    return [{
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "uom_code": row.uom_code,
        "category_name": row.category_name,
    } for row in rows]


async def eligible_bom_items(db: AsyncSession, user, bom_id: int) -> list[dict]:
    """The selected BOM's lines, narrowed to what this requester may raise.

    BOM access is already limited by the active job profile.  This second filter is
    intentionally line-level: a profile can be assigned a ten-line BOM while being
    allowed to request only eight of those items.
    """
    # Do not let a caller bypass the BOM picker by guessing an id.  The visible BOM
    # list and its lines must be scoped by the same active job profile.
    from app.platform.rbac.profiles import profile_keys_for_user

    profile_keys = await profile_keys_for_user(db, user)
    today = date.today()
    permitted_bom_ids = select(BomGroup.bom_id).where(
        BomGroup.profile_key.in_(profile_keys),
        BomGroup.is_active.is_(True),
        (BomGroup.effective_from.is_(None) | (BomGroup.effective_from <= today)),
        (BomGroup.effective_to.is_(None) | (BomGroup.effective_to >= today)),
    )
    bom = (await db.execute(
        select(Bom.id).where(Bom.id == bom_id, Bom.id.in_(permitted_bom_ids))
    )).scalar_one_or_none()
    if bom is None:
        raise NotFoundError("BOM not found")

    stmt = select(BomItem).where(BomItem.bom_id == bom_id)
    clause = await eligibility.eligible_filter(db, user)
    if clause is not None:
        stmt = stmt.join(Item, Item.id == BomItem.item_id).where(clause)
    rows = (await db.execute(stmt.order_by(BomItem.line_no, BomItem.id))).scalars().all()
    return [{
        "id": row.id, "bom_id": row.bom_id, "line_no": row.line_no,
        "item_id": row.item_id, "item_code": row.item_code, "item_name": row.item_name,
        "category_name": row.category_name, "uom_id": row.uom_id,
        "uom_code": row.uom_code, "quantity": float(row.quantity), "remarks": row.remarks,
    } for row in rows]
