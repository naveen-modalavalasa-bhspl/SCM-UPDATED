"""Indents business logic. THE reference module — copy this shape.

Every state change follows: load -> validate current status -> change -> commit.
Approvals go ONLY through the workflow engine; there is no approval logic here.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Numeric, String, and_, case, cast, exists, false, func, literal, or_, select, union_all
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
from app.platform.workflow import engine
from app.platform.workflow.models import Action, Instance, Stage
from app.platform.workflow.models import Pending
from app.platform.settings.service import write_audit
from app.platform.settings.models import AuditLog
from app.platform.rbac import service as rbac_service
from app.platform.rbac import permissions as perms
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number
from app.modules.indents.enums import (
    AcknowledgmentStatus, AllocationStatus, ApprovalAction, AuditAction, DocType,
    IndentActivityType, IndentItemStatus, IndentStatus, InstanceStatus, MRStatus,
    MaterialDirection, Priority, RuleActionType,
)
from app.modules.indents.models import Indent, IndentItem
from app.modules.indents.schemas import IndentCreate, IndentUpdate


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
    return {
        "position_id": position.id if position else None,
        "position_name": position.name if position else None,
        "department_id": department_id,
        "department_name": await _name(db, HcmDepartment, department_id),
        "office_id": office_id,
        "office_name": await _name(db, HcmOffice, office_id),
        "project_id": project_id,
        "project_name": (position.project_name if position else None) or user.project_name,
    }


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    _validate_required_date(data.required_date)
    priority = _validate_priority(data.priority) or Priority.NORMAL.value

    if not data.items:
        raise ValidationError("Indent must have at least one item")
    _validate_item_quantities(data.items)
    _validate_unique_item_ids(data.items)

    items_map = await _items_by_id(db, [line.item_id for line in data.items])
    missing = {line.item_id for line in data.items} - set(items_map)
    if missing:
        raise ValidationError(f"Unknown item ids: {sorted(missing)}")

    context = await _requester_context(db, user)
    total_qty = sum(line.quantity for line in data.items)
    indent = Indent(
        indent_no=await next_number(db, "indent"),
        indent_date=utcnow().date(),
        required_date=data.required_date,
        requested_by_id=user.id,
        requested_by_name=user.full_name,
        requested_by_code=user.emp_code,
        position_id=context["position_id"],
        position_name=context["position_name"],
        department_id=context["department_id"],
        department_name=context["department_name"],
        office_id=context["office_id"],
        office_name=context["office_name"],
        project_id=context["project_id"],
        project_name=context["project_name"],
        status=IndentStatus.DRAFT.value,
        priority=priority,
        total_items=len(data.items),
        total_qty=total_qty,
        remarks=data.remarks,
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
        after={"status": indent.status, "total_items": indent.total_items},
    )
    await db.commit()
    await db.refresh(indent)
    return indent


def _values(values) -> list[str]:
    return [value.value for value in values or []]


def unknown_indent_statuses(statuses) -> set[str]:
    known = {status.value for status in IndentStatus}
    return {str(status) for status in statuses if status is not None and str(status) not in known}


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


async def _attach_capabilities(db: AsyncSession, indent: Indent, user) -> Indent:
    user_perms = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
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
    department_ids: list[int] | None = None,
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
    if department_ids:
        stmt = stmt.where(Indent.department_id.in_(department_ids))
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
    department_ids: list[int] | None = None,
    is_bookmarked: str | None = None,
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
        statuses=statuses, priorities=priorities, department_ids=department_ids,
        is_bookmarked=is_bookmarked,
    )
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
    if indent.requested_by_id != user.id:
        raise PermissionError_("Only the requester can edit this indent")
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot edit an indent in {indent.status} status")

    _validate_required_date(data.required_date)

    before = {
        "required_date": indent.required_date.isoformat() if indent.required_date else None,
        "priority": indent.priority,
        "office_id": indent.office_id,
        "office_name": indent.office_name,
        "remarks": indent.remarks,
        "total_items": indent.total_items,
        "total_qty": float(indent.total_qty or 0),
    }
    indent.required_date = data.required_date
    if data.priority is not None:
        indent.priority = _validate_priority(data.priority)
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


async def submit_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    indent = await get_indent(db, indent_id, user)
    if indent.requested_by_id != user.id:
        raise PermissionError_("Only the requester can submit this indent")
    if indent.status != IndentStatus.DRAFT.value:
        raise ValidationError(f"Cannot submit an indent in {indent.status} status")

    workflow_context = {
        "doc_no": indent.indent_no,
        "doc_summary": f"Indent {indent.indent_no}",
        "department_id": indent.department_id,
        "project_id": indent.project_id,
        "requester_position_id": indent.position_id,
        "requester_position_name": indent.position_name,
        "total_quantity": float(sum(i.quantity for i in indent.items)),
    }
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


async def act_on_indent(db: AsyncSession, indent_id: int, action: ApprovalAction,
                        comments: str, user) -> Indent:
    """APPROVE / REJECT / RETURN. Engine owns the chain; the module owns the status."""
    indent = await get_indent(db, indent_id, user)
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
    context = {
        "doc_no": indent.indent_no,
        "doc_summary": f"Indent {indent.indent_no}",
        "department_id": indent.department_id,
        "requester_position_id": indent.position_id,
        "requester_position_name": indent.position_name,
        "total_quantity": float(indent.total_qty),
    }
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
        line.allocated_quantity = 0
        line.status = IndentItemStatus.PENDING.value
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


def _journey_history(indent: Indent, actions: list[Action], audits: list[AuditLog]) -> list[dict]:
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

    add({
        "id": f"indent:{indent.id}:created",
        "event_type": "CREATED",
        "title": "Request created",
        "description": f"{indent.indent_no} created",
        "actor_name": indent.requested_by_name,
        "position_name": indent.position_name,
        "timestamp": indent.created_at,
        "comments": indent.remarks,
    })
    for action in actions:
        if action.action == ApprovalAction.SUBMITTED.value:
            title = "Request submitted"
            event_type = "SUBMITTED"
        elif action.action == ApprovalAction.APPROVED.value:
            title = f"{action.stage_name or 'Approval'} completed"
            event_type = "APPROVED"
        elif action.action == ApprovalAction.REJECTED.value:
            title = f"{action.stage_name or 'Approval'} rejected"
            event_type = "REJECTED"
        elif action.action == ApprovalAction.RETURNED.value:
            title = f"{action.stage_name or 'Approval'} returned"
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
        })
    for audit in audits:
        changed = audit.changed_fields or {}
        status_change = changed.get("status") if isinstance(changed, dict) else None
        new_status = status_change.get("to") if isinstance(status_change, dict) else None
        if new_status not in {
            IndentStatus.ALLOCATED.value,
            IndentStatus.ORDERED.value,
            IndentStatus.CLOSED.value,
            IndentStatus.PARTIALLY_FULFILLED.value,
        }:
            continue
        add({
            "id": f"audit:{audit.id}",
            "event_type": new_status,
            "title": new_status.replace("_", " ").title(),
            "description": f"{indent.indent_no} status changed",
            "actor_name": audit.actor_name,
            "position_name": None,
            "timestamp": audit.created_at,
            "comments": None,
        })

    return sorted(events, key=lambda row: row["timestamp"], reverse=True)


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


async def indent_journey(db: AsyncSession, indent_id: int, user) -> dict:
    indent = await _get_indent_for_journey(db, indent_id, user)
    instance, actions, pending = await _workflow_rows(db, indent.id)
    resolved_chain = getattr(instance, "resolved_chain", None) if instance else None
    positions = (
        await _approval_positions(db, indent.position_id)
        if resolved_chain is None else []
    )
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
        "title": "Request Raised" if submitted else "Draft Request",
        "status": "SUBMITTED" if submitted else "PENDING",
        "approver_name": submitted.actor_name if submitted else indent.requested_by_name,
        "position_name": submitted.actor_position if submitted else indent.position_name,
        "timestamp": _utc_datetime(submitted.acted_at if submitted else indent.created_at),
        "comments": submitted.comments if submitted else indent.remarks,
        "duration_seconds": _duration_seconds(
            indent.created_at,
            submitted.acted_at if submitted else indent.created_at,
        ),
        "stage_type": "request",
        "is_current": indent.status == IndentStatus.DRAFT.value,
    }]

    previous_at = stages[0]["timestamp"]
    current_stage = "Draft request" if indent.status == IndentStatus.DRAFT.value else None
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
            action = (
                _display_action_for_stage(actions_for_sequence)
                if actions_for_sequence else None
            )
            pending_for_sequence = pending_by_sequence.get(workflow_sequence, [])
            is_final = index == len(chain) - 1
            explicit_status = str(link.get("status") or "").upper()
            status = (
                _stage_status_from_action(action)
                if action else "NOT_REQUIRED"
                if explicit_status == "NOT_REQUIRED" else "PENDING"
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
                    if is_final else f"Waiting for {title}"
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
            title = (
                action.stage_name
                if action and action.stage_name and action.stage_name not in {"Reporting Manager", "Approval"}
                else fallback_title
            )
            if current_stage is None and is_current:
                current_stage = f"Waiting for {title}"
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
            if actions_for_sequence:
                display_action = _display_action_for_stage(actions_for_sequence)
                stage_type = "final" if any(_is_final_stage_name(action.stage_name) for action in actions_for_sequence) else "approval"
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

            approver_ids = {row.approver_id for row in pending_for_sequence}
            pending_positions = _positions_for_approvers(positions, approver_ids)
            is_final = len(pending_for_sequence) > 1
            has_final_stage = has_final_stage or is_final
            title = _fallback_stage_title(pending_positions, final=is_final)
            if current_stage is None:
                current_stage = "Waiting for final approval" if is_final else f"Waiting for {title}"
            stages.append({
                "sequence": len(stages) + 1,
                "title": title,
                "status": "PENDING",
                "is_current": True,
                "approver_name": _holder_names_for_ids(pending_positions, approver_ids),
                "position_name": " / ".join(position["name"] for position in pending_positions) or None,
                "timestamp": None,
                "comments": None,
                "duration_seconds": None,
                "stage_type": "final" if is_final else "approval",
            })

    if indent.status in _POST_APPROVAL_STATUSES:
        if not has_final_stage:
            raise ValidationError("Workflow final stage_name is required to build indent journey")
        ready_timestamp = _utc_datetime(indent.approved_at)
        stages.append({
            "sequence": len(stages) + 1,
            "title": "Ready for Allocation",
            "status": "PENDING" if indent.status == IndentStatus.AWAITING_ALLOCATION.value else "APPROVED",
            "approver_name": None,
            "position_name": None,
            "timestamp": ready_timestamp,
            "comments": None,
            "duration_seconds": _duration_seconds(previous_at, ready_timestamp),
            "stage_type": "allocation",
            "is_current": indent.status == IndentStatus.AWAITING_ALLOCATION.value,
        })
        if indent.status == IndentStatus.AWAITING_ALLOCATION.value:
            current_stage = "Ready for Allocation"

    if indent.status == IndentStatus.REJECTED.value:
        current_stage = "Request rejected"
    elif indent.status not in {
        IndentStatus.DRAFT.value,
        IndentStatus.PENDING_APPROVAL.value,
        IndentStatus.REJECTED.value,
        *_POST_APPROVAL_STATUSES,
    }:
        current_stage = "Status unavailable"
    elif current_stage is None:
        current_stage = "Approval completed"

    return {
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
        "history": _journey_history(indent, actions, audits),
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
    department_ids: list[int] | None = None,
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
        statuses=statuses, priorities=priorities, department_ids=department_ids,
        is_bookmarked=is_bookmarked,
    ).subquery()

    stmt = (
        select(Indent.status, func.count())
        .join(filtered_ids, filtered_ids.c.id == Indent.id)
        .group_by(Indent.status)
    )
    counts = {status: n for status, n in (await db.execute(stmt)).all()}

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
        Indent.project_name,
        Indent.created_at,
    )
    if user is not None:
        visible_stmt = visible_stmt.where(await indent_access_condition(db, user))
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
        IndentStatus.REJECTED.value, IndentStatus.PARTIALLY_ORDERED.value,
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
