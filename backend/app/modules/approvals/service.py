"""Business logic for the approver's operational workspace."""
import logging
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import (
    AppException, NotFoundError, PermissionError_, ValidationError,
)
from app.modules.indents import service as indent_service
from app.modules.indents.models import Indent, IndentItem
from app.modules.indents.enums import ApprovalAction, IndentStatus, IndentType
from app.platform.settings.models import AuditLog
from app.platform.settings.service import write_audit
from app.platform.notifications import service as notification_service
from app.platform.workflow import engine, service as workflow_service
from app.platform.hcm.models import HcmEmployee, HcmPosition
from app.platform.workflow.models import Action, Instance, Pending
from app.shared.enums import AuditAction, DocType, InstanceStatus
from app.shared.time import now as ist_now, today as ist_today
from app.shared.uom import MAX_DECIMALS, decimals_by_code

logger = logging.getLogger(__name__)


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


from .schemas import (
    ApprovalIndentLineOut, ApprovalIndentOut, ApprovalQuantityIn,
    ConsolidatedItemAllocationOut, ConsolidatedItemOut,
    ConsolidationApprovalFailureOut, ConsolidationApprovalIn, ConsolidationApprovalOut,
    ConsolidationBatchOut, ConsolidationFilterOptionOut,
    ConsolidationFilterOptionsOut, ConsolidationFilters, ConsolidationIndentSummaryOut,
    ConsolidationOut,
)


async def _document_numbers(
    db: AsyncSession, wanted: dict[str, set[int]],
) -> dict[tuple[str, int], str]:
    """The real document number for rows whose approval row never snapshotted one.

    `wf_pending.doc_no` / `wf_instances.doc_no` are written at submit time from the
    module's own context. Every procurement document raised before those submits
    started passing it holds NULL, and the queue then printed "#9" for
    PO/2026-27/00009 — an internal row id the approver has never seen on any other
    screen. Read from the document itself, display only: nothing is written back, and
    a row that already carries its number is not touched (so the search box, which
    still reads the stored column, is unaffected either way).
    """
    wanted = {doc_type: ids for doc_type, ids in wanted.items() if ids}
    if not wanted:
        return {}
    from app.modules.procurement.models import PurchaseOrder, RFQ, Requisition
    sources = {
        DocType.PO.value: (PurchaseOrder.id, PurchaseOrder.po_no),
        DocType.RFQ.value: (RFQ.id, RFQ.rfq_no),
        DocType.REQUISITION.value: (Requisition.id, Requisition.req_no),
    }
    numbers: dict[tuple[str, int], str] = {}
    for doc_type, ids in wanted.items():
        source = sources.get(doc_type)
        if source is None:
            continue
        id_column, no_column = source
        rows = (await db.execute(
            select(id_column, no_column).where(id_column.in_(ids))
        )).all()
        numbers.update({
            (doc_type, doc_id): doc_no for doc_id, doc_no in rows if doc_no
        })
    return numbers


def _missing_numbers(rows: Iterable) -> dict[str, set[int]]:
    """doc_type -> ids, for the rows that came back without a document number."""
    wanted: dict[str, set[int]] = defaultdict(set)
    for doc_type, doc_id, doc_no in rows:
        if not doc_no:
            wanted[doc_type].add(doc_id)
    return wanted


def _display_doc_type(doc_type: str, indent_type: str | None) -> str:
    """The type an approver is shown. An STR is an `ind_indents` row and its workflow
    rows say INDENT, but nobody raising or signing one calls it an indent."""
    if doc_type == DocType.INDENT.value and indent_type == IndentType.STR.value:
        return DocType.STOCK_TRANSFER_REQUEST.value
    return doc_type


async def pending_for_user(db: AsyncSession, user) -> list[dict]:
    rows = await engine.pending_for_user(db, user)
    indent_types = await _indent_types(
        db, (row["doc_id"] for row in rows if row["doc_type"] == DocType.INDENT.value),
    )
    rows = [
        row for row in rows
        if not (row["doc_type"] == DocType.INDENT.value
                and indent_types.get(row["doc_id"]) == IndentType.MONTHLY.value)
    ]
    numbers = await _document_numbers(db, _missing_numbers(
        (row["doc_type"], row["doc_id"], row["doc_no"]) for row in rows
    ))
    for row in rows:
        row["approver_name"] = user.full_name
        row["indent_type"] = (
            indent_types.get(row["doc_id"])
            if row["doc_type"] == DocType.INDENT.value else None
        )
        row["display_doc_type"] = _display_doc_type(row["doc_type"], row["indent_type"])
        if not row["doc_no"]:
            row["doc_no"] = numbers.get((row["doc_type"], row["doc_id"]))
    return rows


async def pending_summary(db: AsyncSession, user, scope: str = "mine") -> dict:
    """The tiles and the doc-type chips above the approval inbox, counted in SQL.

    The screen used to answer these by fetching its whole queue a second time (page 1
    at size 500, on top of the page it was already showing) and counting in the
    browser. That is two full reads per load, and it stops being possible the moment
    a queue passes 500 rows.
    """
    now = ist_now()
    if scope == "company":
        from app.platform.workflow.engine import is_workflow_admin
        if not await is_workflow_admin(db, user):
            raise PermissionError_("Admin permission required to view company-wide approval queue")
        conditions = [
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        ]
    else:
        conditions = [
            Pending.approver_id == user.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        ]
        # Same hat rule the list below applies, or the tiles would keep counting work the
        # list no longer shows (see engine.instances_for_other_hats).
        other_hat = await engine.other_hat_condition(db, user)
        if other_hat is not None:
            conditions.append(other_hat)
    base = (
        select(Pending.doc_type, Pending.doc_id, Pending.due_at, Pending.created_at)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    )
    rows = (await db.execute(base)).all()
    if scope == "company":
        seen_docs: set[tuple[str, int]] = set()
        deduped_rows = []
        for r in rows:
            doc_key = (r.doc_type, r.doc_id)
            if doc_key not in seen_docs:
                seen_docs.add(doc_key)
                deduped_rows.append(r)
        rows = deduped_rows

    # Monthly indents are approved as consolidated batches on another screen, so they
    # are not in this queue — the same exclusion pending_page applies to the list.
    indent_types = await _indent_types(
        db, (r.doc_id for r in rows if r.doc_type == DocType.INDENT.value),
    )
    rows = [
        r for r in rows
        if not (r.doc_type == DocType.INDENT.value
                and indent_types.get(r.doc_id) == IndentType.MONTHLY.value)
    ]

    # An STR rides the INDENT workflow but is counted as what it is, so a chart of
    # "what is waiting" does not file a stock transfer under Indent.
    by_doc_type: dict[str, int] = {}
    for row in rows:
        key = _display_doc_type(
            row.doc_type,
            indent_types.get(row.doc_id) if row.doc_type == DocType.INDENT.value else None,
        )
        by_doc_type[key] = by_doc_type.get(key, 0) + 1
    waiting = [r.created_at for r in rows if r.created_at]
    return {
        "total": len(rows),
        "past_due": sum(1 for r in rows if r.due_at and r.due_at < now),
        "oldest_waiting_since": min(waiting).isoformat() if waiting else None,
        "by_doc_type": by_doc_type,
    }


async def pending_page(
    db: AsyncSession, user, page: int, size: int, *, search: str = "",
    doc_type: str = "", overdue_only: bool = False,
    raised_from: datetime | None = None, raised_to: datetime | None = None,
    sort: str = "oldest", scope: str = "mine",
) -> dict:
    # Same rule the engine applies in pending_for_user: a task whose workflow has
    # finished is not work, whatever the row says. Without it a cancelled document
    # kept a live-looking task in the queue and in every count above it.
    if scope == "company":
        from app.platform.workflow.engine import is_workflow_admin
        if not await is_workflow_admin(db, user):
            raise PermissionError_("Admin permission required to view company-wide approval queue")
        conditions = [
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        ]
    else:
        conditions = [
            Pending.approver_id == user.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        ]
        # A task belongs to the POST the ladder resolved to, not merely to the person
        # holding it. Someone wearing two District Manager hats must not be shown the other
        # district's work — they cannot sign it, and acting on it half-succeeded.
        other_hat = await engine.other_hat_condition(db, user)
        if other_hat is not None:
            conditions.append(other_hat)
    now = ist_now()
    term = search.strip()
    if term:
        like = f"%{term}%"
        conditions.append(or_(
            Pending.doc_no.ilike(like), Pending.doc_summary.ilike(like),
            Pending.requested_by_name.ilike(like), Instance.current_stage_name.ilike(like),
        ))
    if doc_type == DocType.STOCK_TRANSFER_REQUEST.value:
        # Not a workflow doc type of its own: an STR is an INDENT row of type STR.
        conditions.append(and_(Pending.doc_type == DocType.INDENT.value,
                               Indent.indent_type == IndentType.STR.value))
    elif doc_type == DocType.INDENT.value:
        conditions.append(and_(Pending.doc_type == DocType.INDENT.value,
                               Indent.indent_type != IndentType.STR.value))
    elif doc_type:
        conditions.append(Pending.doc_type == doc_type)
    if overdue_only:
        conditions.append(Pending.due_at < now)
    if raised_from:
        conditions.append(Pending.created_at >= raised_from.replace(tzinfo=None))
    if raised_to:
        conditions.append(Pending.created_at < raised_to.replace(tzinfo=None))
    # Monthly indents are consolidated into batches (see consolidation_batches_for_user)
    # and must not also show up here individually. Every other doc type, and REGULAR
    # indents, are unaffected — the OR only bites when doc_type is INDENT.
    indent_join = and_(
        Pending.doc_type == DocType.INDENT.value, Indent.id == Pending.doc_id,
    )
    conditions.append(or_(
        Pending.doc_type != DocType.INDENT.value,
        Indent.indent_type != IndentType.MONTHLY.value,
    ))
    order = {
        "newest": Pending.created_at.desc(),
        "due": Pending.due_at.asc(),
        "value": Pending.amount.desc(),
    }.get(sort, Pending.created_at.asc())

    if scope == "company":
        # Group by instance_id so multiple approvers sharing a stage only show the document once
        subq = (
            select(func.min(Pending.id).label("min_pending_id"))
            .select_from(Pending)
            .join(Instance, Instance.id == Pending.instance_id)
            .outerjoin(Indent, indent_join)
            .where(*conditions)
            .group_by(Pending.instance_id)
        ).subquery()

        total = int(await db.scalar(
            select(func.count(subq.c.min_pending_id))
        ) or 0)

        joined = (
            select(Pending, Instance, Indent.indent_type)
            .join(subq, Pending.id == subq.c.min_pending_id)
            .join(Instance, Instance.id == Pending.instance_id)
            .outerjoin(Indent, indent_join)
        )
        rows = (await db.execute(
            joined.order_by(order, Pending.id.desc())
            .offset((page - 1) * size)
            .limit(size)
        )).all()
    else:
        total = int(await db.scalar(
            select(func.count(Pending.id))
            .select_from(Pending).join(Instance, Instance.id == Pending.instance_id)
            .outerjoin(Indent, indent_join)
            .where(*conditions)
        ) or 0)
        joined = (
            select(Pending, Instance, Indent.indent_type)
            .join(Instance, Instance.id == Pending.instance_id)
            .outerjoin(Indent, indent_join)
        )
        rows = (await db.execute(
            joined.where(*conditions)
            .order_by(order, Pending.id.desc())
            .offset((page - 1) * size)
            .limit(size)
        )).all()

    numbers = await _document_numbers(db, _missing_numbers(
        (pending.doc_type, pending.doc_id, pending.doc_no) for pending, _, _ in rows
    ))

    instance_ids = [pending.instance_id for pending, _, _ in rows]
    approver_names_by_instance: dict[int, list[str]] = {}
    if instance_ids and scope == "company":
        emp_rows = (await db.execute(
            select(Pending.instance_id, HcmEmployee.full_name)
            .join(HcmEmployee, HcmEmployee.id == Pending.approver_id)
            .where(Pending.instance_id.in_(instance_ids))
        )).all()
        for inst_id, emp_name in emp_rows:
            if emp_name:
                approver_names_by_instance.setdefault(inst_id, []).append(emp_name)

    overridden_instance_ids: set[int] = set()
    if instance_ids:
        overridden_rows = (await db.execute(
            select(Action.instance_id)
            .where(
                Action.instance_id.in_(instance_ids),
                or_(
                    Action.comments.ilike("%[Admin Override%"),
                    Action.actor_name.ilike("%(Admin Override)%"),
                ),
            )
        )).scalars().all()
        overridden_instance_ids = set(overridden_rows)

    items = []
    for pending, instance, indent_type in rows:
        if scope == "company":
            names = approver_names_by_instance.get(pending.instance_id, [])
            approver_disp = ", ".join(names) if names else user.full_name
        else:
            approver_disp = user.full_name

        items.append({
            "instance_id": pending.instance_id,
            "doc_type": pending.doc_type,
            "indent_type": indent_type,
            "display_doc_type": _display_doc_type(pending.doc_type, indent_type),
            "doc_id": pending.doc_id,
            "stage_sequence": pending.stage_sequence,
            "doc_no": pending.doc_no or numbers.get((pending.doc_type, pending.doc_id)),
            "summary": pending.doc_summary,
            "requested_by_name": pending.requested_by_name,
            "amount": float(pending.amount) if pending.amount is not None else None,
            "waiting_since": pending.created_at.isoformat() if pending.created_at else None,
            "due_at": pending.due_at.isoformat() if pending.due_at else None,
            # Decided here, against the same clock the `overdue_only` filter uses. These
            # timestamps go out naive, so a browser reading them as local time answered a
            # different question: "Past due 0" above a filter that returned a row.
            "overdue": bool(pending.due_at and pending.due_at < now),
            "current_stage_name": instance.current_stage_name,
            "approver_name": approver_disp,
            "is_overridden": pending.instance_id in overridden_instance_ids,
        })
    return {"items": items, "total": total, "page": page, "size": size}


DECISION_VALUES = {
    ApprovalAction.APPROVED.value,
    ApprovalAction.REJECTED.value,
    ApprovalAction.RETURNED.value,
}


def _decision_output(action: Action, instance: Instance, user,
                     numbers: dict[tuple[str, int], str] | None = None,
                     exclusions: dict[int, list[dict]] | None = None,
                     indent_types: dict[int, str] | None = None) -> dict:
    duration_hours = None
    if action.acted_at and instance.started_at:
        duration_hours = round(
            max(0, (action.acted_at - instance.started_at).total_seconds() / 3600), 1,
        )
    return {
        "id": action.id,
        "doc_type": instance.doc_type,
        "doc_id": instance.doc_id,
        "doc_no": instance.doc_no or (numbers or {}).get(
            (instance.doc_type, instance.doc_id)),
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "decision": action.action,
        "comments": action.comments,
        "decision_at": action.acted_at.isoformat() if action.acted_at else None,
        "started_at": instance.started_at.isoformat() if instance.started_at else None,
        "duration_hours": duration_hours,
        "within_sla": (
            action.acted_at <= instance.due_at
            if action.acted_at and instance.due_at else None
        ),
        "requester": instance.started_by_name,
        "approver_name": action.actor_name or user.full_name,
        "workflow_status": instance.status,
        "indent_type": (indent_types or {}).get(instance.doc_id)
        if instance.doc_type == DocType.INDENT.value else None,
        # The lines THIS approver dropped when they signed. An exclusion is part of
        # the decision, not a property of the document that follows it, so the ledger
        # has to carry it: the indent screen shows the line at zero and says nothing
        # about who took it out of the batch.
        "excluded_items": (exclusions or {}).get(instance.doc_id, [])
        if instance.doc_type == DocType.INDENT.value else [],
    }



# FIXED 2026-08-20 — "My Decisions" filtered on the PERSON alone (`Action.actor_id`),
# so an employee who holds two positions read both hats' decisions from either session.
# Everywhere else in the app a hat change changes the data — `indent_access_condition`
# matches `wf_actions.actor_position` for exactly this reason — and this screen was the
# exception. WITHOUT it, switching position moves the menu and not the history.
#
# `actor_position` is a NAME snapshot, which is what the engine writes, so the match is
# by name. A row with no position recorded stays visible: those predate the snapshot and
# belong to no hat, and hiding them would silently shorten somebody's own history.
async def _acting_position_name(db: AsyncSession, user) -> str | None:
    position_id = getattr(user, "active_position_id", None)
    if position_id is None:
        return None
    return await db.scalar(
        select(HcmPosition.name).where(HcmPosition.id == position_id))


async def _acted_by_me(db: AsyncSession, user):
    """The decisions this login made IN THE CAPACITY THEY ARE WEARING."""
    conditions = [Action.actor_id == user.id]
    name = await _acting_position_name(db, user)
    if name is not None:
        conditions.append(or_(Action.actor_position == name,
                              Action.actor_position.is_(None)))
    return and_(*conditions)


async def _decision_query(db: AsyncSession, user):
    # FIXED — was `Action.actor_id == user.id`. See `_acted_by_me`.
    return (
        select(Action, Instance)
        .join(Instance, Instance.id == Action.instance_id)
        .where(await _acted_by_me(db, user), Action.action.in_(DECISION_VALUES))
        .order_by(Action.acted_at.desc(), Action.id.desc())
    )


async def decisions_for_user(db: AsyncSession, user) -> list[dict]:
    rows = (await db.execute(await _decision_query(db, user))).all()
    numbers = await _document_numbers(db, _missing_numbers(
        (instance.doc_type, instance.doc_id, instance.doc_no) for _, instance in rows
    ))
    indent_types = await _indent_types(db, (
        instance.doc_id for _, instance in rows
        if instance.doc_type == DocType.INDENT.value
    ))
    return [_decision_output(action, instance, user, numbers,
                             indent_types=indent_types)
            for action, instance in rows]


async def _indent_types(db: AsyncSession, indent_ids: Iterable[int]) -> dict[int, str]:
    ids = [i for i in set(indent_ids) if i]
    if not ids:
        return {}
    rows = (await db.execute(
        select(Indent.id, Indent.indent_type).where(Indent.id.in_(ids))
    )).all()
    return {int(row.id): row.indent_type for row in rows}


async def _exclusions_by_indent(
    db: AsyncSession, indent_ids: Iterable[int], actor_id: int,
) -> dict[int, list[dict]]:
    """Which lines this approver dropped, per indent.

    Read off `ind_indent_items` — the exclusion is already stored there with who did
    it and when (see `IndentItem.is_excluded`), so nothing is written for this
    screen's benefit and it cannot show a drop the indent does not carry. Scoped to
    the actor so a row in MY ledger never reports somebody else's exclusion.
    """
    ids = [i for i in set(indent_ids) if i]
    if not ids:
        return {}
    rows = (await db.execute(
        select(IndentItem).where(
            IndentItem.indent_id.in_(ids),
            IndentItem.is_excluded.is_(True),
            IndentItem.excluded_by_id == actor_id,
        ).order_by(IndentItem.indent_id, IndentItem.line_no, IndentItem.id)
    )).scalars().all()
    out: dict[int, list[dict]] = defaultdict(list)
    for line in rows:
        out[line.indent_id].append({
            "line_id": line.id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "requested_quantity": float(line.quantity or 0),
            "excluded_by_name": line.excluded_by_name,
            "excluded_at": line.excluded_at.isoformat() if line.excluded_at else None,
        })
    return dict(out)


async def decisions_page(
    db: AsyncSession, user, page: int, size: int, *, search: str = "",
    decision: str = "", doc_type: str = "",
) -> dict:
    # FIXED — hat-scoped, same as `_decision_query`. See `_acted_by_me`.
    conditions = [await _acted_by_me(db, user), Action.action.in_(DECISION_VALUES)]
    if decision:
        conditions.append(Action.action == decision)
    if doc_type:
        conditions.append(Instance.doc_type == doc_type.upper())
    term = search.strip()
    if term:
        like = f"%{term}%"
        conditions.append(or_(
            Instance.doc_no.ilike(like), Instance.started_by_name.ilike(like),
            Action.comments.ilike(like), Instance.doc_type.ilike(like),
        ))
    total = int(await db.scalar(
        select(func.count(Action.id)).select_from(Action)
        .join(Instance, Instance.id == Action.instance_id).where(*conditions)
    ) or 0)
    rows = (await db.execute(
        select(Action, Instance).join(Instance, Instance.id == Action.instance_id)
        .where(*conditions).order_by(Action.acted_at.desc(), Action.id.desc())
        .offset((page - 1) * size).limit(size)
    )).all()
    numbers = await _document_numbers(db, _missing_numbers(
        (instance.doc_type, instance.doc_id, instance.doc_no) for _, instance in rows
    ))
    exclusions = await _exclusions_by_indent(
        db,
        (instance.doc_id for _, instance in rows
         if instance.doc_type == DocType.INDENT.value),
        user.id,
    )
    indent_types = await _indent_types(db, (
        instance.doc_id for _, instance in rows
        if instance.doc_type == DocType.INDENT.value
    ))
    return {
        "items": [_decision_output(action, instance, user, numbers, exclusions,
                                   indent_types)
                  for action, instance in rows],
        "total": total,
        "page": page,
        "size": size,
    }


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _num(value) -> float:
    try:
        return float(Decimal(str(value or 0)))
    except Exception:  # noqa: BLE001 - display fallback only
        return 0.0


def _change_pair(payload: dict | None) -> tuple[float | None, float | None]:
    if not isinstance(payload, dict):
        return None, None
    before = payload.get("from")
    after = payload.get("to")
    return (_num(before) if before is not None else None,
            _num(after) if after is not None else None)


def _decision_word(action: str | None, received: float, approved: float | None) -> str:
    if action is None:
        return "WAITING"
    if action == ApprovalAction.REJECTED.value:
        return "DENIED"
    if action == ApprovalAction.RETURNED.value:
        return "RETURNED"
    if approved is None:
        return "APPROVED"
    if approved <= 0 and received > 0:
        return "DENIED"
    if approved < received:
        return "PARTIALLY_APPROVED"
    return "APPROVED"


async def _indent_instances(db: AsyncSession, indent_id: int) -> list[Instance]:
    return list((await db.execute(
        select(Instance).where(
            Instance.doc_type == DocType.INDENT.value,
            Instance.doc_id == indent_id,
        ).order_by(Instance.id)
    )).scalars().all())


async def _indent_actions(db: AsyncSession, instance_ids: Iterable[int]) -> list[Action]:
    ids = [int(i) for i in instance_ids]
    if not ids:
        return []
    return list((await db.execute(
        select(Action).where(Action.instance_id.in_(ids))
        .order_by(Action.acted_at.asc(), Action.id.asc())
    )).scalars().all())


async def _indent_quantity_audits(db: AsyncSession, indent_id: int) -> list[AuditLog]:
    return list((await db.execute(
        select(AuditLog).where(
            AuditLog.entity_type == QUANTITY_AUDIT_ENTITY,
            AuditLog.entity_id == indent_id,
        ).order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
    )).scalars().all())


def _action_for_audit(audit: AuditLog, actions: list[Action]) -> Action | None:
    """Quantity audit is flushed just before the workflow action on the same click."""
    candidates = [
        action for action in actions
        if action.actor_id == audit.actor_id
        and action.action == ApprovalAction.APPROVED.value
        and audit.created_at and action.acted_at
        and action.acted_at >= audit.created_at
        and (action.acted_at - audit.created_at).total_seconds() < 300
    ]
    return candidates[0] if candidates else None


def _quantity_events_by_line(
    audits: list[AuditLog], actions: list[Action],
) -> dict[int, list[dict]]:
    by_line: dict[int, list[dict]] = defaultdict(list)
    for audit in audits:
        fields = audit.changed_fields if isinstance(audit.changed_fields, dict) else {}
        action = _action_for_audit(audit, actions)
        for key, payload in fields.items():
            if not key.startswith("line_") or not key.endswith("_approved_qty"):
                continue
            try:
                line_id = int(key.removeprefix("line_").removesuffix("_approved_qty"))
            except ValueError:
                continue
            before, after = _change_pair(payload)
            if before is None or after is None:
                continue
            by_line[line_id].append({
                "audit_id": audit.id,
                "previous_quantity": before,
                "new_quantity": after,
                "delta": after - before,
                "reduction": max(before - after, 0),
                "actor_id": audit.actor_id,
                "actor_name": audit.actor_name,
                "changed_at": _iso(audit.created_at),
                "stage_sequence": action.stage_sequence if action else None,
                "stage_name": action.stage_name if action else None,
                "reason": action.comments if action else None,
                "source": "sys_audit_log",
            })
    return by_line


async def _pending_names(db: AsyncSession, instance_ids: Iterable[int]) -> list[dict]:
    ids = [int(i) for i in instance_ids]
    if not ids:
        return []
    rows = (await db.execute(
        select(Pending, HcmEmployee.full_name)
        .outerjoin(HcmEmployee, HcmEmployee.id == Pending.approver_id)
        .where(Pending.instance_id.in_(ids))
        .order_by(Pending.created_at.asc(), Pending.id.asc())
    )).all()
    return [{
        "approver_id": pending.approver_id,
        "approver_name": name,
        "stage_sequence": pending.stage_sequence,
        "created_at": _iso(pending.created_at),
        "due_at": _iso(pending.due_at),
    } for pending, name in rows]


async def _ledger_visibility(
    db: AsyncSession, user, actions: list[Action], pending: list[dict],
    action: Action | None,
) -> datetime | None:
    """How far down this document's trail THIS login may read.

    An approver is shown the indent as it REACHED them and the decision they took on
    it — never what the rung above did to it afterwards. The OE who cut 10 to 5 and
    signed sees exactly that. The DM who later cut it to 3 sees both, because the OE's
    decision is precisely what the DM was handed; the trail below you is the document
    you were given, and the trail above you is somebody else's decision.

    The rule is the trail itself, never a map of ranks. A cutover re-keys every role
    id (CLAUDE.md, the HCM section) and a ladder is configured per project per doc
    type, so a hardcoded "DM may read OE" would be wrong on the day a project
    configures a different ladder and silently wrong for every project that already
    has one.

    Three ways to read the whole trail, and each is somebody the document is
    genuinely theirs to read: the auditor holding APPROVAL_TRAIL_VIEW_ALL, the
    approver it is sitting with right now, and anybody who has never acted on it at
    all — the raiser reading their own indent, whose trail is nobody else's secret.

    Returns the instant the viewer's reading stops, or None for no limit at all.
    """
    # The auditor, on a permission that exists for exactly this and is granted to
    # Admin alone until somebody ticks it on.
    #
    # It was `report.view` for one revision and that was a real defect, worth the
    # words: twenty-odd job profiles hold `report.view` — Driver and QC Team among
    # them, and the OE whose leak started this — so the check passed for nearly every
    # login and the scoping never engaged. A grant that wide cannot be the one that
    # lifts a restriction; the test of an escape hatch is who does NOT hold it.
    from app.platform.rbac import permissions as perms
    from app.platform.rbac import service as rbac_service

    codes = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    if perms.APPROVAL_TRAIL_VIEW_ALL in codes:
        return None
    # Holding it now: everything that has happened to this document has happened
    # BEFORE it reached them, so there is nothing above them to hide.
    if any(row.get("approver_id") == user.id for row in pending):
        return None
    # DECISIONS only. A submission is not a decision, and counting it would cut the
    # raiser's own document off at the moment they sent it — they would watch their
    # indent disappear into a ladder and never see a stage of it come back. The
    # raiser is not who this rule is about: it protects one approver's decision from
    # the approver BELOW them, and the person who asked for the goods is below all of
    # them by definition.
    mine = [
        row for row in actions
        if row.actor_id == user.id and row.acted_at
        and row.action != ApprovalAction.SUBMITTED.value
    ]
    if action is not None and action.acted_at:
        return action.acted_at
    return max((row.acted_at for row in mine), default=None)


def _visible_quantity_events(
    quantity_by_line: dict[int, list[dict]], cut: datetime | None,
) -> dict[int, list[dict]]:
    """The per-line audit, trimmed to the cut. Same shape, fewer rows."""
    if cut is None:
        return quantity_by_line
    limit = _iso(cut) or ""
    return {
        line_id: [row for row in rows if (row.get("changed_at") or "") <= limit]
        for line_id, rows in quantity_by_line.items()
    }


def _user_quantity_audit(
    audits: list[AuditLog], action: Action | None, user,
) -> AuditLog | None:
    if action is None:
        return None
    matches = [
        audit for audit in audits
        if audit.actor_id == user.id
        and audit.created_at and action.acted_at
        and audit.created_at <= action.acted_at
        and (action.acted_at - audit.created_at).total_seconds() < 300
    ]
    return matches[-1] if matches else None


def _item_snapshot(
    line: IndentItem,
    *,
    action: Action | None,
    user_audit: AuditLog | None,
    history: list[dict],
    scoped: bool = False,
) -> dict:
    received = None
    approved_by_me = None
    if user_audit and isinstance(user_audit.changed_fields, dict):
        received, approved_by_me = _change_pair(
            user_audit.changed_fields.get(f"line_{line.id}_approved_qty"))
    if action is None:
        received = _num(line.approved_quantity or line.quantity)
    elif approved_by_me is None:
        # This reader's own change to THIS line. `user_audit` answers the same
        # question above and is the fast path; this is the fallback for a line their
        # audit row does not name, which is the COMMON case — an approver cuts one
        # line out of twenty and leaves the other nineteen alone.
        stamp = _iso(action.acted_at) or ""
        own = [row for row in history if row.get("actor_id") == action.actor_id]
        earlier = [row for row in history if (row.get("changed_at") or "") < stamp]
        if own:
            received = own[-1]["previous_quantity"]
            approved_by_me = own[-1]["new_quantity"]
        elif action.action == ApprovalAction.APPROVED.value:
            # They left this line as it reached them, so both figures are the same
            # number: whatever the last change BEFORE their signature left it at,
            # else the quantity the indent was raised with.
            #
            # NEVER `line.approved_quantity` for a scoped reader. That column is
            # whatever the rung ABOVE them wrote last, and reading it here is exactly
            # how the OE's own card came to report the DM's 3 — with the reduction
            # attributed to the OE, on a line the OE never touched. A full-trail
            # reader (report.view) still gets the live number, because for them it is
            # not somebody else's decision.
            base = earlier[-1]["new_quantity"] if earlier else _num(line.quantity)
            received = base
            approved_by_me = base if scoped else _num(line.approved_quantity)

    final_qty = _num(line.approved_quantity)
    received = _num(line.quantity) if received is None else received
    if scoped:
        # Same rule for the outcome column: a scoped reader's last figure is the one
        # they left behind, never the one the document carries now.
        final_qty = (
            approved_by_me if approved_by_me is not None
            else history[-1]["new_quantity"] if history
            else received
        )
    approved = approved_by_me if approved_by_me is not None else (
        None if action is None else final_qty)
    delta = (approved - received) if approved is not None else None
    return {
        "line_id": line.id,
        "item_id": line.item_id,
        "item_code": line.item_code,
        "item_name": line.item_name,
        "uom_code": line.uom_code,
        "requested_quantity": _num(line.quantity),
        "received_by_approver_quantity": received,
        "approved_by_approver_quantity": approved,
        "change_quantity": delta,
        "final_approved_quantity": final_qty,
        "decision": _decision_word(action.action if action else None, received, approved),
        "changed_by_name": (
            getattr(action, "actor_name", None)
            if action else None
        ) or (history[-1]["actor_name"] if history else None),
        "changed_at": _iso(action.acted_at) if action else None,
        "reason": action.comments if action else None,
        "is_excluded": bool(line.is_excluded),
        "excluded_by_name": line.excluded_by_name,
        "excluded_at": _iso(line.excluded_at),
        "quantity_history": history,
    }


def _doc_noun(indent: Indent) -> str:
    """What the document is called in a sentence: an STR is not an indent to anybody."""
    return ("stock transfer request"
            if indent.indent_type == IndentType.STR.value else "indent")


def _plain_summary(action: Action | None, items: list[dict], noun: str = "indent") -> str:
    if action is None:
        total = sum(item["received_by_approver_quantity"] for item in items)
        return f"You have {total:g} units waiting for your decision."
    if action.action == ApprovalAction.REJECTED.value:
        return f"You denied this {noun}."
    if action.action == ApprovalAction.RETURNED.value:
        return f"You returned this {noun} for correction."
    requested = sum(item["received_by_approver_quantity"] for item in items)
    approved = sum(item["approved_by_approver_quantity"] or 0 for item in items)
    reduced = requested - approved
    if reduced > 0:
        return f"You approved {approved:g} of {requested:g} requested units and reduced the quantity by {reduced:g}."
    return f"You approved all {approved:g} requested units."


def _history_events(
    indent: Indent,
    actions: list[Action],
    quantity_by_line: dict[int, list[dict]],
    pending: list[dict],
) -> list[dict]:
    events = [{
        "id": f"indent:{indent.id}:created",
        "kind": "REQUEST_CREATED",
        "title": f"{_doc_noun(indent).capitalize()} raised",
        "actor_name": indent.requested_by_name,
        "actor_role": "Requester",
        "stage_name": "Draft",
        "occurred_at": _iso(indent.created_at),
        "comments": indent.remarks,
        "quantity_changes": [],
    }]
    for action in actions:
        label = {
            ApprovalAction.SUBMITTED.value: "Submitted or resubmitted",
            ApprovalAction.APPROVED.value: "Approved",
            ApprovalAction.REJECTED.value: "Denied",
            ApprovalAction.RETURNED.value: "Returned for correction",
        }.get(action.action, action.action.title())
        changes = [
            {**change, "line_id": line_id}
            for line_id, rows in quantity_by_line.items()
            for change in rows
            if change.get("actor_id") == action.actor_id
            and change.get("changed_at") is not None
            and action.acted_at is not None
            and abs((
                datetime.fromisoformat(change["changed_at"]) - action.acted_at
            ).total_seconds()) < 300
        ]
        events.append({
            "id": f"action:{action.id}",
            "kind": action.action,
            "title": label,
            "actor_name": action.actor_name,
            "actor_role": action.actor_position,
            "stage_sequence": action.stage_sequence,
            "stage_name": action.stage_name,
            "occurred_at": _iso(action.acted_at),
            "comments": action.comments,
            "quantity_changes": changes,
        })
    for wait in pending:
        events.append({
            "id": f"pending:{wait['approver_id']}:{wait['stage_sequence']}",
            "kind": "WAITING",
            "title": "Currently waiting",
            "actor_name": wait.get("approver_name"),
            "actor_role": "Approver",
            "stage_sequence": wait.get("stage_sequence"),
            "stage_name": indent.current_stage_name,
            "occurred_at": wait.get("created_at"),
            "comments": None,
            "quantity_changes": [],
        })
    return sorted(events, key=lambda e: (e.get("occurred_at") or "", e["id"]))


async def _source_indents(db: AsyncSession, indent: Indent) -> list[dict]:
    if not indent.consolidation_id:
        rows = [indent]
    else:
        rows = list((await db.execute(
            select(Indent).where(Indent.consolidation_id == indent.consolidation_id)
            .order_by(Indent.indent_no)
        )).scalars().all())
    return [{
        "id": row.id,
        "indent_no": row.indent_no,
        "requested_by_name": row.requested_by_name,
        "status": row.status,
        "original_quantity": _num(row.total_qty),
        "pre_consolidation_quantity": _num(row.total_qty),
        "consolidated_quantity": _num(row.approved_qty or row.total_qty),
        "final_approved_quantity": _num(row.approved_qty),
    } for row in rows]


async def decision_ledger(
    db: AsyncSession, doc_type: str, doc_id: int, user, action_id: int | None = None,
) -> dict:
    """Read-only decision ledger for Regular and Monthly/Consolidation indents."""
    if doc_type.upper() != DocType.INDENT.value:
        raise ValidationError("Decision ledger is currently available for indents")
    indent = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == doc_id)
    )).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {doc_id} not found")

    instances = await _indent_instances(db, doc_id)
    instance_ids = [row.id for row in instances]
    actions = await _indent_actions(db, instance_ids)
    pending = await _pending_names(db, instance_ids)

    action = None
    if action_id is not None:
        action = next((row for row in actions if row.id == action_id), None)
        if action is None or action.actor_id != user.id:
            raise PermissionError_("You can view only decisions you made")
    else:
        is_pending = any(row.get("approver_id") == user.id for row in pending)
        if not is_pending and not any(row.actor_id == user.id for row in actions):
            raise PermissionError_("This indent is not in your approval history")

    audits = await _indent_quantity_audits(db, doc_id)
    quantity_by_line = _quantity_events_by_line(audits, actions)
    # Everything below this line is served THROUGH the cut. One place decides how far
    # a login may read and every figure, every audit row and the history itself are
    # taken from that one answer, because two answers is how one of them comes to
    # disagree with the other on screen.
    cut = await _ledger_visibility(db, user, actions, pending, action)
    quantity_by_line = _visible_quantity_events(quantity_by_line, cut)
    visible_actions = actions if cut is None else [
        row for row in actions if row.acted_at and row.acted_at <= cut
    ]
    user_audit = _user_quantity_audit(audits, action, user)
    items = [
        _item_snapshot(
            line,
            action=action,
            user_audit=user_audit,
            history=quantity_by_line.get(line.id, []),
            scoped=cut is not None,
        )
        for line in sorted(indent.items, key=lambda item: (item.line_no, item.id))
    ]
    gaps = []
    if action and action.action == ApprovalAction.APPROVED.value and user_audit is None:
        gaps.append("Approver-level before/after quantities are unavailable for this legacy approval action.")
    if indent.indent_type == IndentType.MONTHLY.value and indent.consolidation_id is None:
        gaps.append("This monthly indent has no consolidation document snapshot.")

    current_instance = instances[-1] if instances else None
    decision = action.action if action else "WAITING"
    return {
        "decision": {
            "mode": "DECIDED" if action else "WAITING",
            "action_id": action.id if action else None,
            "decision": decision,
            "decision_label": _decision_word(
                action.action if action else None,
                sum(item["received_by_approver_quantity"] for item in items),
                sum((item["approved_by_approver_quantity"] or 0) for item in items)
                if action else None,
            ),
            "stage_sequence": action.stage_sequence if action else (
                current_instance.current_sequence if current_instance else None),
            "stage_name": action.stage_name if action else indent.current_stage_name,
            "actor_name": action.actor_name if action else getattr(user, "full_name", None),
            "actor_role": action.actor_position if action else await _acting_position_name(db, user),
            "decided_at": _iso(action.acted_at) if action else None,
            "comments": action.comments if action else None,
            "summary": _plain_summary(action, items, _doc_noun(indent)),
        },
        "indent": {
            "id": indent.id,
            "indent_no": indent.indent_no,
            "type": (
                "Monthly/Consolidation"
                if indent.indent_type == IndentType.MONTHLY.value
                else "Stock transfer request"
                if indent.indent_type == IndentType.STR.value else "Regular"
            ),
            "indent_type": indent.indent_type,
            "status": indent.status,
            "current_stage_name": indent.current_stage_name,
            "current_approver_name": indent.current_approver_name,
            "requester": indent.requested_by_name,
            "department_name": indent.department_name,
            "office_name": indent.office_name or indent.region_name,
            "project_name": indent.project_name,
            "created_at": _iso(indent.created_at),
            "purpose": indent.remarks,
        },
        "consolidation": {
            "is_consolidated": indent.indent_type == IndentType.MONTHLY.value,
            "consolidation_id": indent.consolidation_id,
            "period": (
                indent.indent_date.strftime("%Y-%m")
                if getattr(indent, "indent_date", None) else None
            ),
            "cutoff_date": indent.required_date.isoformat() if indent.required_date else None,
            "milestones": [{
                "label": "Cut-off date",
                "date": indent.required_date.isoformat() if indent.required_date else None,
                "status": (
                    "UNAVAILABLE" if not indent.required_date else
                    "MET" if indent.created_at and indent.created_at.date() <= indent.required_date
                    else "OVERDUE"
                ),
            }],
            "source_indents": await _source_indents(db, indent),
        },
        "items": items,
        # Still served, still trimmed to the cut, and no longer rendered as a journey:
        # a complete approval history on an approver's own decision page showed every
        # reader what the rungs above them did. The screen states where the document
        # is NOW (pending_now) and what THIS reader decided, and nothing else.
        "timeline": _history_events(indent, visible_actions, quantity_by_line, pending),
        "pending_now": pending,
        "visibility": {
            "scoped": cut is not None,
            "through": _iso(cut),
            # The wording is served for the same reason every status word here is:
            # a screen composing its own sentence about who may see what is a second
            # copy of a rule that lives on the server.
            "outcome_label": "Approved at your stage" if cut else "Final approved",
            "note": (
                f"You are seeing this {_doc_noun(indent)} as it reached you and the "
                "decision you took on it. Later stages are not shown."
            ) if cut else None,
        },
        "legacy_gaps": gaps,
    }



# ---------------- The monthly cycle ledger ----------------
#
# A monthly indent is never ONE document to the approver who signed it. The
# Consolidation screen takes a whole month in a single press and
# `approve_consolidation` walks it indent by indent, so one click writes N rows in
# `wf_actions` — six on the live database today, nine hundred at the scale this was
# sized for. Every one of those rows then becomes its own line in My Decisions and
# its own Decision Ledger page, and each of those pages carries the same sibling
# table in its sidebar.
#
# The regular ledger is right for a regular indent and wrong here for one reason:
# it answers "what did I do to THIS document", and the question a monthly approver
# actually has is about the CYCLE — how much of an item did I approve across every
# site that asked for it, which sites did I cut, and which of the month's indents
# never reached me at all. Answering that by opening eleven pages and adding them up
# by hand is what the screen is for.
#
# Nothing here is stored. The cycle is the same GROUP BY the Consolidation tab
# already computes (see "Monthly indent consolidation" below), and every figure on
# it comes from `_item_snapshot` — the SAME function the single-indent ledger uses —
# so a number on the roll-up and the number on the indent's own page cannot
# disagree. Five queries for the whole cycle whatever its size: members, instances,
# actions, pending, audits.


def _last_decision(actions: list[Action], user) -> Action | None:
    """This login's last DECISION on one document, never their submission.

    Same exclusion `_ledger_visibility` makes and for the same reason: a raiser who
    submitted their own monthly indent has not decided anything, and treating the
    submission as a decision would cut their own document off at the moment they
    sent it.
    """
    mine = [
        row for row in actions
        if row.actor_id == user.id and row.acted_at
        and row.action != ApprovalAction.SUBMITTED.value
    ]
    return mine[-1] if mine else None


def _member_reading(
    user, actions: list[Action], pending: list[dict], full_trail: bool,
) -> tuple[Action | None, datetime | None]:
    """(the decision this login took on this member, how far they may read it).

    The single-indent rule, applied per member without a permission read per
    document: `_ledger_visibility` asks RBAC for the same answer every time and the
    cycle asks it once. Everything else about the rule is identical, deliberately —
    an approver sees each indent as it REACHED them and the decision they took, and
    never what the rung above did to it afterwards.
    """
    action = _last_decision(actions, user)
    if full_trail:
        return action, None
    # Sitting with them right now: everything that has happened to it happened
    # before it arrived, so there is nothing above them to hide.
    if any(row.get("approver_id") == user.id for row in pending):
        return None, None
    return action, (action.acted_at if action else None)


async def _cycle_members(
    db: AsyncSession, indent: Indent,
) -> tuple[list[Indent], object | None]:
    """Every monthly indent in this indent's cycle, and the consolidation document
    if one has been opened for it.

    Two spellings of "the same cycle", because a monthly indent joins its
    consolidation only when it finishes approval (`indents._join_consolidation`) —
    so an indent still climbing the ladder, which is exactly the one an approver is
    reading a decision on, has no document yet. Before that the cycle is the month,
    which is what the Consolidation tab groups by; after it the document is the
    identity, because two consolidations for one month is normal.
    """
    from app.modules.indents.models import Consolidation

    if indent.consolidation_id:
        doc = await db.get(Consolidation, indent.consolidation_id)
        rows = (await db.execute(
            select(Indent).options(selectinload(Indent.items))
            .where(Indent.consolidation_id == indent.consolidation_id)
            .order_by(Indent.indent_no)
        )).scalars().all()
        return list(rows), doc

    # The month, narrowed in SQL rather than by loading every unconsolidated monthly
    # indent there has ever been and filtering in Python.
    conditions = [
        Indent.indent_type == IndentType.MONTHLY.value,
        Indent.consolidation_id.is_(None),
    ]
    if indent.indent_date is None:
        conditions.append(Indent.indent_date.is_(None))
    else:
        first = indent.indent_date.replace(day=1)
        following = (
            first.replace(year=first.year + 1, month=1) if first.month == 12
            else first.replace(month=first.month + 1)
        )
        conditions += [Indent.indent_date >= first, Indent.indent_date < following]
    rows = (await db.execute(
        select(Indent).options(selectinload(Indent.items))
        .where(*conditions).order_by(Indent.indent_no)
    )).scalars().all()
    return list(rows), None


async def _cycle_trails(
    db: AsyncSession, indent_ids: list[int],
) -> tuple[dict[int, list[Action]], dict[int, list[dict]], dict[int, list[AuditLog]]]:
    """(actions, pending, quantity audits) for a whole cycle, keyed by indent id.

    Three grouped queries instead of three per member — a nine-hundred-indent cycle
    is the size this was written for, and the per-document version of this is
    thousands of round trips for one page.
    """
    if not indent_ids:
        return {}, {}, {}
    instances = (await db.execute(
        select(Instance).where(
            Instance.doc_type == DocType.INDENT.value,
            Instance.doc_id.in_(indent_ids),
        ).order_by(Instance.id)
    )).scalars().all()
    doc_by_instance = {row.id: row.doc_id for row in instances}

    actions: dict[int, list[Action]] = defaultdict(list)
    pending: dict[int, list[dict]] = defaultdict(list)
    if doc_by_instance:
        for row in (await db.execute(
            select(Action).where(Action.instance_id.in_(doc_by_instance))
            .order_by(Action.acted_at.asc(), Action.id.asc())
        )).scalars().all():
            actions[doc_by_instance[row.instance_id]].append(row)
        for row, name in (await db.execute(
            select(Pending, HcmEmployee.full_name)
            .outerjoin(HcmEmployee, HcmEmployee.id == Pending.approver_id)
            .where(Pending.instance_id.in_(doc_by_instance))
            .order_by(Pending.created_at.asc(), Pending.id.asc())
        )).all():
            pending[doc_by_instance[row.instance_id]].append({
                "approver_id": row.approver_id,
                "approver_name": name,
                "stage_sequence": row.stage_sequence,
                "created_at": _iso(row.created_at),
                "due_at": _iso(row.due_at),
            })

    audits: dict[int, list[AuditLog]] = defaultdict(list)
    for row in (await db.execute(
        select(AuditLog).where(
            AuditLog.entity_type == QUANTITY_AUDIT_ENTITY,
            AuditLog.entity_id.in_(indent_ids),
        ).order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
    )).scalars().all():
        audits[int(row.entity_id)].append(row)

    return dict(actions), dict(pending), dict(audits)


def _rollup_decision(requested: float, approved: float | None, decided: int) -> str:
    """One word for a GROUP of lines, from the numbers rather than from a vote.

    A group nobody has decided is WAITING even though its quantities are populated —
    `_item_snapshot` fills `received` for a waiting line, and reading that as an
    approval is how a queue comes to report itself as finished.
    """
    if not decided or approved is None:
        return "WAITING"
    return _decision_word(ApprovalAction.APPROVED.value, requested, approved)


def _cycle_summary(
    signed: int, reached: int, total: int, sites: int,
    requested: float, approved: float, waiting: int,
) -> str:
    """The whole cycle in one sentence, served for the same reason every other
    status word here is: a screen composing it is a second copy of the rule."""
    place = "site" if sites == 1 else "sites"
    if not reached:
        return "None of this cycle's indents reached you."
    if not signed:
        return (
            f"{waiting:g} of the {total:g} indents in this cycle are waiting for "
            f"your decision, across {sites:g} {place}."
        )
    scope = f"all {signed:g} indents" if total == signed else (
        f"{signed:g} of the {total:g} indents")
    cut = requested - approved
    tail = (
        f"{approved:g} of {requested:g} units approved, {cut:g} cut."
        if cut > 0 else f"all {requested:g} requested units approved."
    )
    waited = f" {waiting:g} still waiting for you." if waiting else ""
    return f"You signed {scope} in this cycle, across {sites:g} {place} — {tail}{waited}"


async def cycle_ledger(db: AsyncSession, doc_type: str, doc_id: int, user) -> dict:
    """The monthly cycle as THIS approver decided it — the roll-up the per-document
    ledger cannot give, because the decision was never per document.

    Scoped the same way the single ledger is: the members of the cycle this login is
    part of the trail of — signed, or sitting with them now — and the whole cycle for
    the auditor holding `APPROVAL_TRAIL_VIEW_ALL`. What was left out is still
    COUNTED, so a narrowed view reads as narrowed rather than as data that failed to
    load.
    """
    if doc_type.upper() != DocType.INDENT.value:
        raise ValidationError("The cycle ledger is available for indents")
    anchor = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == doc_id)
    )).scalar_one_or_none()
    if anchor is None:
        raise NotFoundError(f"Indent {doc_id} not found")
    if anchor.indent_type != IndentType.MONTHLY.value:
        raise ValidationError(
            "The cycle ledger is for monthly indents. A regular indent is one "
            "decision on one document and is read on its own ledger."
        )

    from app.platform.rbac import permissions as perms
    from app.platform.rbac import service as rbac_service
    codes = await rbac_service.get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    full_trail = perms.APPROVAL_TRAIL_VIEW_ALL in codes

    members, doc = await _cycle_members(db, anchor)
    if not any(row.id == anchor.id for row in members):
        members.append(anchor)
    actions_by, pending_by, audits_by = await _cycle_trails(
        db, [row.id for row in members],
    )

    # The anchor must be readable on its own terms before anything else is served:
    # the cycle is reached FROM one indent's decision, and a login with no standing
    # on that indent has no business reading the month around it.
    if not full_trail and not _last_decision(actions_by.get(anchor.id, []), user) \
            and not any(row.get("approver_id") == user.id
                        for row in pending_by.get(anchor.id, [])):
        raise PermissionError_("This indent is not in your approval history")

    items: dict[int, dict] = {}
    indents: list[dict] = []
    signed = waiting = reduced_lines = excluded_lines = 0
    decided_at: list[datetime] = []
    stages: list[str] = []

    for member in sorted(members, key=lambda row: (row.indent_no or "", row.id)):
        member_actions = actions_by.get(member.id, [])
        member_pending = pending_by.get(member.id, [])
        action, cut = _member_reading(user, member_actions, member_pending, full_trail)
        mine = action is not None
        on_my_desk = any(row.get("approver_id") == user.id for row in member_pending)
        if not (full_trail or mine or on_my_desk):
            continue

        scoped = cut is not None
        history = _visible_quantity_events(
            _quantity_events_by_line(audits_by.get(member.id, []), member_actions), cut,
        )
        user_audit = _user_quantity_audit(audits_by.get(member.id, []), action, user)
        lines = [
            _item_snapshot(
                line, action=action, user_audit=user_audit,
                history=history.get(line.id, []), scoped=scoped,
            )
            for line in sorted(member.items, key=lambda row: (row.line_no, row.id))
        ]

        member_requested = sum(line["received_by_approver_quantity"] for line in lines)
        member_approved = sum(
            line["approved_by_approver_quantity"] or 0 for line in lines
        ) if mine else None
        if mine:
            signed += 1
            if action.acted_at:
                decided_at.append(action.acted_at)
            if action.stage_name:
                stages.append(action.stage_name)
        else:
            waiting += 1

        for line in lines:
            bucket = items.setdefault(line["item_id"], {
                "item_id": line["item_id"],
                "item_code": line["item_code"],
                "item_name": line["item_name"],
                "uom_code": line["uom_code"],
                "requested": 0.0, "approved": 0.0, "waiting_quantity": 0.0,
                "decided_sites": 0, "excluded_sites": 0, "reduced_sites": 0,
                "sites": [],
            })
            approved = line["approved_by_approver_quantity"]
            bucket["requested"] += line["received_by_approver_quantity"]
            if approved is None:
                bucket["waiting_quantity"] += line["received_by_approver_quantity"]
            else:
                bucket["approved"] += approved
                bucket["decided_sites"] += 1
                if approved < line["received_by_approver_quantity"]:
                    bucket["reduced_sites"] += 1
                    reduced_lines += 1
            if line["is_excluded"]:
                bucket["excluded_sites"] += 1
                excluded_lines += 1
            bucket["sites"].append({
                "line_id": line["line_id"],
                "indent_id": member.id,
                "indent_no": member.indent_no,
                "requester": member.requested_by_name,
                "office_name": member.office_name or member.region_name,
                "requested": line["received_by_approver_quantity"],
                "approved": approved,
                "change": line["change_quantity"],
                "decision": line["decision"],
                "is_excluded": line["is_excluded"],
                "reason": line["reason"],
                # Passed THROUGH, not recomputed. The register opens an indent in
                # place now and this is the only thing the panel could not answer
                # off the roll-up: who moved the line, from what to what, at which
                # rung. It is already in hand -- `_item_snapshot` built it above
                # from `history`, which was already narrowed by
                # `_visible_quantity_events` to what this login may read, so it
                # carries exactly the events the single-document ledger would show
                # the same person and not one more.
                "quantity_history": line["quantity_history"],
                "indent_status": member.status,
            })

        indents.append({
            "id": member.id,
            "indent_no": member.indent_no,
            "requester": member.requested_by_name,
            "requested_by_id": member.requested_by_id,
            "office_name": member.office_name or member.region_name,
            "project_name": member.project_name,
            "department_name": member.department_name,
            "status": member.status,
            "indent_date": (
                member.indent_date.isoformat() if member.indent_date else None),
            "required_date": (
                member.required_date.isoformat() if member.required_date else None),
            "line_count": len(lines),
            "requested": member_requested,
            "approved": member_approved,
            "change": (
                member_approved - member_requested
                if member_approved is not None else None),
            "decision": _rollup_decision(
                member_requested, member_approved, 1 if mine else 0),
            "action_id": action.id if action else None,
            "decided_at": _iso(action.acted_at) if action else None,
            "stage_name": action.stage_name if action else None,
            "current_stage_name": member.current_stage_name,
            "current_approver_name": member.current_approver_name,
            "is_anchor": member.id == anchor.id,
            "on_my_desk": on_my_desk,
        })

    for bucket in items.values():
        # TWO counts, because they are two different numbers and the live data is
        # exactly the case that proves it: eleven indents from four offices, with
        # one requester raising several against the same site. One figure labelled
        # "sites" next to another labelled "sites" saying something else is how a
        # reader stops trusting both.
        bucket["request_count"] = len(bucket["sites"])
        bucket["site_count"] = len({
            row["office_name"] for row in bucket["sites"] if row["office_name"]
        })
        decided_requested = bucket["requested"] - bucket["waiting_quantity"]
        # Served, not derived on the screen. `requested` counts every site that asked
        # for the item, `decided_requested` only the ones this reader has answered —
        # and printing the first beside `approved` reports an approver who has one
        # site still to sign as having cut the difference.
        bucket["decided_requested"] = decided_requested
        bucket["waiting_requests"] = bucket["request_count"] - bucket["decided_sites"]
        bucket["change"] = (
            bucket["approved"] - decided_requested if bucket["decided_sites"] else None
        )
        bucket["decision"] = _rollup_decision(
            decided_requested,
            bucket["approved"] if bucket["decided_sites"] else None,
            bucket["decided_sites"],
        )
        bucket["sites"].sort(key=lambda row: (-row["requested"], row["indent_no"] or ""))

    item_rows = sorted(
        items.values(), key=lambda row: (-row["requested"], row["item_name"] or ""),
    )
    requested_total = sum(row["requested"] for row in item_rows)
    approved_total = sum(row["approved"] for row in item_rows)
    decided_total = sum(row["requested"] - row["waiting_quantity"] for row in item_rows)
    sites = {row["office_name"] for row in indents if row["office_name"]}
    requesters = {row["requested_by_id"] for row in indents if row["requested_by_id"]}
    required = [row["required_date"] for row in indents if row["required_date"]]

    return {
        "cycle": {
            "key": _consolidation_key(anchor.consolidation_id, anchor),
            "consolidation_id": anchor.consolidation_id,
            "consolidation_no": getattr(doc, "consolidation_no", None),
            "consolidation_status": getattr(doc, "status", None),
            "sealed_at": _iso(getattr(doc, "sealed_at", None)),
            "period": _cycle_key(anchor),
            "period_label": _month_label(_cycle_key(anchor)),
            "earliest_required_date": min(required) if required else None,
            "latest_required_date": max(required) if required else None,
            "project_name": anchor.project_name,
        },
        "anchor": {
            "id": anchor.id,
            "indent_no": anchor.indent_no,
            "requester": anchor.requested_by_name,
            "office_name": anchor.office_name or anchor.region_name,
            "status": anchor.status,
        },
        "scope": {
            "full_trail": full_trail,
            "reached_me": len(indents),
            "total_in_cycle": len(members),
            "outcome_label": (
                "Final approved" if full_trail else "Approved at your stage"),
            # Said out loud, by the server. A roll-up that quietly counts fewer
            # documents than the cycle holds reads as a page with missing data.
            "note": (
                None if full_trail or len(indents) == len(members) else
                f"{len(indents)} of this cycle's {len(members)} indents reached you. "
                "The rest are somebody else's decision and are not counted here."
            ),
        },
        "decision": {
            "mode": (
                "DECIDED" if signed and not waiting else
                "WAITING" if waiting and not signed else
                "MIXED" if signed else "NONE"
            ),
            "signed_count": signed,
            "waiting_count": waiting,
            "first_decided_at": _iso(min(decided_at)) if decided_at else None,
            "last_decided_at": _iso(max(decided_at)) if decided_at else None,
            # One rung for the whole batch is the normal case — one press, one stage.
            # Several means the cycle reached this login more than once, which is a
            # fact about the ladder and is stated rather than flattened away.
            "stage_names": sorted(set(stages)),
            "summary": _cycle_summary(
                signed, len(indents), len(members), len(sites),
                decided_total, approved_total, waiting,
            ),
        },
        "totals": {
            "indents": len(indents),
            "sites": len(sites),
            "requesters": len(requesters),
            "items": len(item_rows),
            "lines": sum(row["line_count"] for row in indents),
            "requested": requested_total,
            "approved": approved_total,
            "decided_requested": decided_total,
            "waiting_quantity": requested_total - decided_total,
            "change": approved_total - decided_total,
            "reduced_lines": reduced_lines,
            "excluded_lines": excluded_lines,
        },
        "items": item_rows,
        "indents": indents,
    }


async def team_queue(db: AsyncSession, user) -> list[dict]:
    return await workflow_service.team_queue(db, user)


async def approval_history(db: AsyncSession, doc_type: str, doc_id: int, user) -> list[dict]:
    instance_ids = list((await db.execute(
        select(Instance.id).where(
            Instance.doc_type == doc_type,
            Instance.doc_id == doc_id,
            or_(
                Instance.started_by_id == user.id,
                exists(select(Pending.id).where(
                    Pending.instance_id == Instance.id,
                    Pending.approver_id == user.id,
                )),
                exists(select(Action.id).where(
                    Action.instance_id == Instance.id,
                    Action.actor_id == user.id,
                )),
            ),
        ).order_by(Instance.id)
    )).scalars().all())
    if not instance_ids:
        return []
    actions = list((await db.execute(
        select(Action).where(Action.instance_id.in_(instance_ids))
        .order_by(Action.acted_at, Action.id)
    )).scalars().all())
    # The SECOND door onto the same trail — this is what the approval review screen
    # draws its timeline from — so it answers to the same rule as the Decision Ledger
    # and not to one of its own. Two doors onto one document with two ideas about who
    # may read it is how the first one came to be wrong.
    #
    # Nothing changes for the person this endpoint is actually for: the reviewer is
    # the current approver, so the cut is None and they see every stage below them.
    pending = await _pending_names(db, instance_ids)
    cut = await _ledger_visibility(db, user, actions, pending, None)
    if cut is not None:
        actions = [row for row in actions if row.acted_at and row.acted_at <= cut]
    return [{
        "id": action.id,
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "actor_id": action.actor_id,
        "actor_name": action.actor_name,
        "actor_position": action.actor_position,
        "action": action.action,
        "comments": action.comments,
        "acted_at": action.acted_at.isoformat() if action.acted_at else None,
    } for action in actions]


async def act_on_document(
    db: AsyncSession, doc_type: str, doc_id: int, action: str, comments: str, user,
) -> dict:
    """Use each owning module's existing status-safe approval operation."""
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("Only approve and reject are supported for this document")
    if action == ApprovalAction.REJECTED.value and not comments.strip():
        raise ValidationError("Rejection reason is required")

    normalized = doc_type.upper()
    if normalized in (DocType.ALLOCATION.value,
                      DocType.OWN_STOCK_ALLOCATION.value):
        # Through indents, not inventory.allocations directly: only this path hands
        # inventory the indent's project, generates the warehouse fulfilment drafts,
        # and pushes the indent's own status/allocated quantities forward. Calling
        # allocations.act() here approved the allocation and left the indent standing
        # still with nothing for the warehouse to pick against.
        from app.modules.indents import service as indent_service
        await indent_service.act_on_allocation(db, doc_id, action, user, comments)
    elif normalized == DocType.MR.value:
        from app.modules.inventory import service as inventory_service
        await inventory_service.act_on_mr(db, doc_id, action, user, comments)
    elif normalized == DocType.PO.value:
        from app.modules.procurement import service as procurement_service
        await procurement_service.act_on_po(db, doc_id, action, comments, user)
    # The rest of the buying chain. Each was already submitting to the engine and
    # landing in this queue, but had no branch here — so clicking one of them from
    # Approvals answered "approval is not supported", and the only way to sign was to
    # find the document's own screen. The engine owns the chain in every case; these
    # calls exist so the module that owns the document still moves its own status.
    elif normalized == DocType.REQUISITION.value:
        from app.modules.procurement import service as procurement_service
        await procurement_service.act_on_requisition(db, doc_id, action, comments, user)
    elif normalized == DocType.RFQ.value:
        from app.modules.procurement import service as procurement_service
        await procurement_service.act_on_rfq(db, doc_id, action, comments, user)
    elif normalized == DocType.CONSOLIDATION.value:
        from app.modules.procurement import consolidation as procurement_consolidation
        await procurement_consolidation.act_on_consolidation(
            db, doc_id, action, comments, user)
    elif normalized in {"ISSUE", "WH_ISSUE", DocType.OWN_STOCK_ISSUE.value}:
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_issue(db, doc_id, action, comments, user)
    elif normalized == "DISPATCH":
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_dispatch(db, doc_id, action, comments, user)
    elif normalized == DocType.QC_OUTWARD.value:
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_outbound_inspection(
            db, doc_id, action, comments, user)
    elif normalized == "PURCHASE_RETURN":
        from app.modules.warehouse import service as warehouse_service
        await warehouse_service.act_on_return(db, doc_id, action, comments, user)
    elif normalized == DocType.TRANSPORT_REQUEST.value:
        from app.modules.logistics import transport
        await transport.act_on_tr(db, doc_id, action, user, comments)
    elif normalized == DocType.CARRIER_AWARD.value:
        from app.modules.logistics import transport
        await transport.act_on_award(db, doc_id, action, user, comments)
    elif normalized == DocType.VENDOR_PAYMENT.value:
        from app.modules.accounts import service as accounts_service
        await accounts_service.act_on_payment(db, doc_id, action, user, comments)
    else:
        raise ValidationError(f"Approval action is not supported for {normalized}")
    return {"doc_type": normalized, "doc_id": doc_id, "action": action}


async def act_on_documents(db: AsyncSession, documents: list, action: str,
                           comments: str, user) -> dict:
    """Sign a whole selection in one request.

    An approver holding forty requisitions was making forty round trips through the UI,
    which is minutes of clicking for a decision they made once. One call, one pass.

    Deliberately NOT one transaction. Each module's own approve is already a complete
    load -> validate -> change -> audit -> commit, and wrapping forty of them in a
    single commit would mean one document whose status moved underneath the approver
    (someone else signed it, it was cancelled) discards the thirty-nine that were fine.
    So each is committed on its own and the failures come back named — the approver sees
    exactly which ones still need them, rather than an all-or-nothing error.
    """
    if not documents:
        raise ValidationError("Choose at least one document to act on")
    # A guard, not a preference: this runs one approval per element, and an unbounded
    # list is a request that holds a connection for minutes.
    if len(documents) > 200:
        raise ValidationError("Act on at most 200 documents at a time")

    approved: list[dict] = []
    failed: list[dict] = []
    for document in documents:
        doc_type = getattr(document, "doc_type", None)
        doc_id = getattr(document, "doc_id", None)
        try:
            approved.append(
                await act_on_document(db, doc_type, doc_id, action, comments, user))
        except Exception as error:  # noqa: BLE001 - reported per document, never swallowed
            # Without this the session stays poisoned and every later document in the
            # loop fails for a reason that has nothing to do with it.
            await db.rollback()
            logger.warning("bulk %s failed for %s %s: %s",
                           action, doc_type, doc_id, error)
            failed.append({
                "doc_type": doc_type, "doc_id": doc_id,
                "error": getattr(error, "message", None) or str(error),
            })
    return {
        "action": action,
        "requested": len(documents),
        "succeeded": len(approved),
        "items": approved,
        "failed": failed,
    }


async def report_summary(db: AsyncSession, user) -> dict:
    decision_values = {
        ApprovalAction.APPROVED.value,
        ApprovalAction.REJECTED.value,
        ApprovalAction.RETURNED.value,
    }
    decided = (await db.execute(
        select(Action, Instance.started_at)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Action.actor_id == user.id, Action.action.in_(decision_values))
    )).all()
    counts = {value: 0 for value in decision_values}
    elapsed_hours: list[float] = []
    for action, started_at in decided:
        counts[action.action] += 1
        if action.acted_at and started_at:
            elapsed_hours.append(max(0, (action.acted_at - started_at).total_seconds() / 3600))

    pending_rows = await engine.pending_for_user(db, user)

    def is_overdue(row: dict) -> bool:
        value = row.get("due_at")
        if not value:
            return False
        due = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        return due < ist_now()

    return {
        "total_decisions": len(decided),
        "approved": counts[ApprovalAction.APPROVED.value],
        "rejected": counts[ApprovalAction.REJECTED.value],
        "returned": counts[ApprovalAction.RETURNED.value],
        "pending": len(pending_rows),
        "overdue": sum(1 for row in pending_rows if is_overdue(row)),
        "average_decision_hours": round(sum(elapsed_hours) / len(elapsed_hours), 1) if elapsed_hours else 0,
    }


async def remind_team_approver(db: AsyncSession, approver_id: int, user) -> dict:
    visible_team = await workflow_service.team_queue(db, user)
    allowed = {int(row["approver_id"]): row for row in visible_team}
    if approver_id not in allowed:
        raise PermissionError_("You can remind only an approver in your reporting team")
    row = allowed[approver_id]
    pending_count = int(row.get("pending_count") or 0)
    created = await notification_service.notify(
        db,
        [approver_id],
        title="Approval reminder",
        body=f"You have {pending_count} approval{'s' if pending_count != 1 else ''} waiting for your decision.",
        deep_link="/approvals",
        entity_type="APPROVAL_QUEUE",
        entity_id=approver_id,
    )
    await db.commit()
    return {
        "approver_id": approver_id,
        "pending_count": pending_count,
        "notifications_created": created,
    }


#: The audit entity `approve_indent` writes its per-line quantities under. Its presence
#: is the proof that an approval RECORDED numbers, which a row of zeros cannot give on
#: its own — see `_recorded_quantities`.
QUANTITY_AUDIT_ENTITY = "ind_indent_items"


async def _indents_with_recorded_quantities(
    db: AsyncSession, indent_ids: Iterable[int],
) -> set[int]:
    """Which of these indents have had quantities written by an approver.

    `approve_indent` logs every line's before/after under `ind_indent_items` (nothing
    else writes that entity), so one row of that audit is the durable record that a
    rung below actually entered numbers — including a deliberate zero, which the
    quantities themselves cannot distinguish from "never touched".
    """
    ids = {int(i) for i in indent_ids}
    if not ids:
        return set()
    rows = (await db.execute(
        select(AuditLog.entity_id)
        .where(AuditLog.entity_type == QUANTITY_AUDIT_ENTITY, AuditLog.entity_id.in_(ids))
        .distinct()
    )).scalars().all()
    return {int(row) for row in rows}


def _recorded_quantities(indent: Indent, audited: bool) -> bool:
    """Did the rung below actually record quantities on this indent.

    An approval only lowers the ceiling if it recorded something. An indent submitted
    before submit-time seeding existed, and approved through the plain
    `POST /indents/{id}/approve` (the indent screen's Approve button, or an API
    client), carries approved_qty 0 on every line — it recorded nothing. Reading that
    as "the level below approved none of it" collapsed the next approver's ceiling to
    zero: a number nobody entered, which silently wipes out the whole request.

    A quantity above zero says so by itself. Zeros need the audit trail, because an
    approver who deliberately cut a line to nothing writes exactly the same row as the
    legacy path that wrote nothing at all — and getting that backwards is how an indent
    cut to zero at one rung reappeared at the next asking for its full original
    quantity again.
    """
    if any(Decimal(str(line.approved_quantity or 0)) > 0 for line in indent.items):
        return True
    return audited


async def _has_previous_approval(db: AsyncSession, instance: Instance, indent: Indent) -> bool:
    """Has a level below this one actually recorded quantities on this indent.

    Shared by _load_indent_task (single-indent review) and the Consolidation batch
    builder, so the two screens can never disagree about whether a ceiling reads as
    the request or as what the previous level approved.
    """
    previous_approval = await db.scalar(select(func.count(Action.id)).where(
        Action.instance_id == instance.id,
        Action.action == ApprovalAction.APPROVED.value,
    ))
    if not previous_approval:
        return False
    audited = await _indents_with_recorded_quantities(db, [indent.id])
    return _recorded_quantities(indent, indent.id in audited)


async def _load_indent_task(
    db: AsyncSession, indent_id: int, user,
) -> tuple[Indent, Instance, bool]:
    indent = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")
    if indent.status != IndentStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"Indent is not awaiting approval (status {indent.status})")

    instance = (await db.execute(
        select(Instance).where(
            Instance.doc_type == DocType.INDENT.value,
            Instance.doc_id == indent_id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).scalar_one_or_none()
    if instance is None:
        raise ValidationError("No in-progress approval exists for this indent")

    assigned = await db.scalar(select(func.count(Pending.id)).where(
        Pending.instance_id == instance.id,
        Pending.stage_sequence == instance.current_sequence,
        Pending.approver_id == user.id,
    ))
    from app.platform.workflow.engine import is_workflow_admin
    is_admin = await is_workflow_admin(db, user)
    if not assigned and not is_admin:
        raise PermissionError_("This indent is not assigned to you at the current stage")
    if indent.requested_by_id == user.id:
        raise ValidationError("Requester cannot approve or reject their own indent")

    has_previous = await _has_previous_approval(db, instance, indent)
    return indent, instance, has_previous


def _plain(value: Decimal) -> str:
    """5.000 reads as 5 in a message an approver has to act on."""
    trimmed = value.normalize()
    return f"{trimmed:f}"


QUANTITY_STEP = Decimal("0.001")


def _quantize(value: Decimal) -> Decimal:
    """Round to what `ind_indent_items.approved_qty` (NUMERIC(16,3)) can hold.

    Rounding at write time instead would let 4.9995 clear a ceiling of 4.999 and then
    be stored as 5.000 — an increase, through the one door that must only reduce. We
    round down so what was validated is exactly what is stored.
    """
    return value.quantize(QUANTITY_STEP, rounding=ROUND_DOWN)


def _approval_ceiling(line, has_previous_approval: bool) -> Decimal:
    """The most this approver may pass on.

    Quantities only ever come down the ladder: the first approver is capped by the
    requested quantity, every later one by what the level below them approved.
    `has_previous_approval` is false until an approval has actually recorded
    quantities (see _load_indent_task), so an uninitialised line reads as the request
    rather than as zero.

    Never above the request, whatever `approved_qty` holds. A row written before this
    rule existed can carry more than was asked for, and the ceiling is the one number
    on this screen that must not be able to grow.
    """
    requested = _quantize(Decimal(str(line.quantity)))
    if not has_previous_approval:
        return requested
    return min(_quantize(Decimal(str(line.approved_quantity or 0))), requested)


def _approval_out(
    indent: Indent, instance: Instance, has_previous_approval: bool,
    *, can_return_for_correction: bool = False,
) -> ApprovalIndentOut:
    items = [
        ApprovalIndentLineOut(
            id=line.id,
            item_id=line.item_id,
            item_code=line.item_code,
            item_name=line.item_name,
            uom_code=line.uom_code,
            requested_quantity=float(line.quantity),
            approved_quantity=float(_approval_ceiling(line, has_previous_approval)),
            max_quantity=float(_approval_ceiling(line, has_previous_approval)),
            remarks=line.remarks,
            is_excluded=bool(line.is_excluded),
            excluded_by_name=line.excluded_by_name,
        )
        for line in sorted(indent.items, key=lambda item: (item.line_no, item.id))
    ]
    return ApprovalIndentOut(
        id=indent.id,
        indent_no=indent.indent_no,
        status=indent.status,
        priority=indent.priority,
        requested_by_name=indent.requested_by_name,
        position_name=indent.position_name,
        department_name=indent.department_name,
        office_name=indent.office_name,
        current_stage_name=instance.current_stage_name,
        current_approver_name=indent.current_approver_name,
        can_return_for_correction=can_return_for_correction,
        required_date=indent.required_date,
        created_at=indent.created_at,
        items=items,
    )


async def get_indent_for_approval(
    db: AsyncSession, indent_id: int, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    can_return = await indent_service.can_return_indent_for_correction(db, indent, user)
    return _approval_out(
        indent, instance, has_previous, can_return_for_correction=can_return,
    )


# ---------------- Monthly indent consolidation ----------------
#
# A consolidation batch stores nothing: it is a GROUP BY, computed fresh on every
# request, over exactly the same wf_pending/wf_instances/ind_indents rows that
# Waiting for Me reads. Every original indent keeps its own row, its own wf_instances
# chain and its own wf_actions history untouched — this is a read-only view over
# them, never a merge. See memory: indent-consolidation-no-new-table.
#
# Why this needs no new hierarchy logic: the ladder already resolves each Monthly
# indent's next approver independently (platform/workflow/engine.py), so "every
# Monthly indent currently pending with approver X" is already sitting in wf_pending
# with approver_id = X. Grouping those rows by (cycle, region, project) reproduces
# "ST-1..4 report to OE-1" -> one batch for OE-1, and once each is approved and the
# ladder climbs a rung, the same query run as DM-1 reproduces the next level — with
# no code that knows about OE/DM/RM/SPH/COO by name.

async def _monthly_pending_indents(
    db: AsyncSession, user,
) -> list[tuple[Indent, Instance, bool]]:
    """Monthly indents currently pending at this approver's stage.

    Two queries rather than one join-and-selectinload: wf_pending/wf_instances name
    the doc_ids in play, ind_indents needs its items eager-loaded to sum quantities,
    and doing that through a join would re-fetch the instance per line.
    """
    conditions = [
        Pending.approver_id == user.id,
        Pending.doc_type == DocType.INDENT.value,
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ]
    # The Consolidation tab is the Monthly half of the same inbox, so it obeys the same
    # hat rule as Waiting for Me. Without it a District Manager wearing the Paderu hat
    # was offered Vizianagaram's monthly batch — and "Serve from own stock" on it wrote
    # the allocation, then failed the profile rung on the way to settling the ladder.
    other_hat = await engine.other_hat_condition(db, user, [DocType.INDENT.value])
    if other_hat is not None:
        conditions.append(other_hat)
    pending_rows = (await db.execute(
        select(Pending.doc_id, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions)
    )).all()
    if not pending_rows:
        return []
    instance_by_doc_id = {doc_id: instance for doc_id, instance in pending_rows}

    indents = (await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(
            Indent.id.in_(instance_by_doc_id),
            Indent.indent_type == IndentType.MONTHLY.value,
        )
    )).scalars().all()

    # One grouped COUNT for the whole queue instead of `_has_previous_approval` per
    # indent: the same answer, but a consolidation with 200 Monthly indents costs three
    # queries rather than 401. The Python half of the rule stays identical to the
    # single-indent screen's — both go through `_recorded_quantities`.
    approved_counts = dict((await db.execute(
        select(Action.instance_id, func.count(Action.id))
        .where(
            Action.instance_id.in_([i.id for i in instance_by_doc_id.values()]),
            Action.action == ApprovalAction.APPROVED.value,
        )
        .group_by(Action.instance_id)
    )).all())
    audited = await _indents_with_recorded_quantities(db, [i.id for i in indents])

    out = []
    for indent in indents:
        instance = instance_by_doc_id[indent.id]
        has_previous = bool(approved_counts.get(instance.id)) and _recorded_quantities(
            indent, indent.id in audited,
        )
        out.append((indent, instance, has_previous))
    return out


# The cycle key lives in indents, which owns the concept. It was duplicated here and
# the two copies had to agree forever or "approve the March lot" and "issue the March
# lot" would quietly mean different sets of indents.
from app.modules.indents.service import cycle_key as _cycle_key   # noqa: E402
# The consolidation DOCUMENT the indents belong to. Monthly indents join it at submit,
# so this screen can name the batch the same way the Fulfilment Queue and Allocation
# Approvals name it — `CON/2026-27/00001`, not a made-up `CONS-2026-08`. Same reason
# the cycle key is imported rather than copied: one concept, one owner.
from app.modules.indents.service import (  # noqa: E402
    _consolidations_by_key as _consolidation_docs,
    consolidation_key as _consolidation_key,
)


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


# ---------------- Filter dimensions ----------------
#
# Every dimension below is an EXISTING snapshot column on ind_indents (region_id,
# project_id, vehicle_id, office_id, requested_by_id) or an existing line column
# (ind_indent_items.item_id). Nothing here needs a join, a migration or a new column.
#
# "Phase" was asked for and is NOT here: neither ind_indents nor the hcm_ mirror has a
# phase / sub-project / stage-of-project column, and inventing one would mean a
# migration. The screen therefore never offers a Phase control. (`phases` in
# indents/schemas.py is the document's own journey — Draft/Submitted/Allocation/… —
# not an organisational dimension, and is not it.)

_DIMENSIONS = {
    "region": (lambda i: i.region_id, lambda i: i.region_name),
    "project": (lambda i: i.project_id, lambda i: i.project_name),
    "vehicle": (lambda i: i.vehicle_id, lambda i: i.vehicle_number),
    "office": (lambda i: i.office_id, lambda i: i.office_name),
    "requester": (lambda i: i.requested_by_id, lambda i: i.requested_by_name),
}


def _matches(indent: Indent, filters: ConsolidationFilters) -> bool:
    """AND across dimensions — picking Region A then Project 2 narrows, never widens.

    A filter on a dimension the indent has no value for excludes it: asking for
    Region A is asking for Region A, and an indent whose requester HCM has no
    location for is not in Region A.
    """
    # Either key: the month (what the cycle dropdown offers) or the consolidation
    # document (what a batch is now keyed and linked by). One filter, both spellings,
    # so a bookmarked `?cycle=2026-08` keeps working next to a `?cycle=C2` batch link.
    if filters.cycle and filters.cycle not in (
            _cycle_key(indent),
            _consolidation_key(getattr(indent, "consolidation_id", None), indent)):
        return False
    if filters.region_id is not None and indent.region_id != filters.region_id:
        return False
    if filters.project_id is not None and indent.project_id != filters.project_id:
        return False
    if filters.vehicle_id is not None and indent.vehicle_id != filters.vehicle_id:
        return False
    if filters.office_id is not None and indent.office_id != filters.office_id:
        return False
    if filters.requester_id is not None and indent.requested_by_id != filters.requester_id:
        return False
    if filters.item_id is not None and not any(
        line.item_id == filters.item_id for line in indent.items
    ):
        return False
    # Raised-on window, inclusive at both ends. Compared as dates: the filter is a
    # day, and an indent raised at 18:00 belongs to that day, not to the one after.
    raised = getattr(indent, "created_at", None)
    raised_day = raised.date() if raised is not None else None
    if filters.raised_from and (raised_day is None or raised_day < filters.raised_from):
        return False
    if filters.raised_to and (raised_day is None or raised_day > filters.raised_to):
        return False
    if filters.search:
        needle = filters.search.lower()
        haystack = [
            indent.indent_no, indent.requested_by_name, indent.requested_by_code,
            indent.region_name, indent.project_name, indent.office_name,
            indent.vehicle_number,
        ]
        haystack += [line.item_name for line in indent.items]
        haystack += [line.item_code for line in indent.items]
        if not any(value and needle in value.lower() for value in haystack):
            return False
    return True


def _lines(indent: Indent, filters: ConsolidationFilters) -> list:
    """The lines a total is built from. Only the Item filter narrows them: filtering
    to Helmet must show Helmet's quantity, not the whole indent's."""
    if filters.item_id is None:
        return list(indent.items)
    return [line for line in indent.items if line.item_id == filters.item_id]


def _filter_options(members: list) -> ConsolidationFilterOptionsOut:
    """Dropdown contents, counted over the approver's UNFILTERED pending set.

    Unfiltered on purpose: options built from the filtered set would empty out the
    moment a filter is applied and leave no way back except Clear Filters. A
    dimension no indent carries a value for yields an empty list, and the screen
    hides that control entirely.
    """
    counts: dict[str, dict[str, tuple[str, int]]] = {name: {} for name in _DIMENSIONS}
    counts["cycle"] = {}
    counts["item"] = {}

    for indent, _instance, _has_previous in members:
        for name, (get_id, get_label) in _DIMENSIONS.items():
            value = get_id(indent)
            if value is None:
                continue
            label, count = counts[name].get(str(value), (get_label(indent) or str(value), 0))
            counts[name][str(value)] = (label, count + 1)

        cycle = _cycle_key(indent)
        label, count = counts["cycle"].get(cycle, (_month_label(cycle), 0))
        counts["cycle"][cycle] = (label, count + 1)

        # Once per indent per item, not once per line: "how many indents ask for
        # Helmet" is the number the dropdown means.
        for item_id in {line.item_id for line in indent.items}:
            sample = next(l for l in indent.items if l.item_id == item_id)
            label, count = counts["item"].get(
                str(item_id), (sample.item_name or sample.item_code or str(item_id), 0))
            counts["item"][str(item_id)] = (label, count + 1)

    def options(name: str) -> list[ConsolidationFilterOptionOut]:
        return [
            ConsolidationFilterOptionOut(value=value, label=label, indent_count=count)
            for value, (label, count) in sorted(counts[name].items(), key=lambda kv: kv[1][0])
        ]

    return ConsolidationFilterOptionsOut(
        cycle=sorted(options("cycle"), key=lambda o: o.value, reverse=True),
        region=options("region"), project=options("project"), vehicle=options("vehicle"),
        office=options("office"), requester=options("requester"), item=options("item"),
    )


def _only(values: set):
    """The single distinct value, or None when the set spans more than one."""
    real = {v for v in values if v is not None}
    return next(iter(real)) if len(real) == 1 else None


def _build_batch(
    cycle: str, group: list, filters: ConsolidationFilters,
    decimals_by_uom: dict[str, int] | None = None,
    doc=None,
) -> ConsolidationBatchOut:
    items_totals: dict[int, dict] = {}
    for indent, _instance, has_previous in group:
        for line in _lines(indent, filters):
            bucket = items_totals.setdefault(line.item_id, {
                "item_id": line.item_id, "item_code": line.item_code,
                "item_name": line.item_name, "uom_code": line.uom_code,
                "total_requested_quantity": Decimal("0"),
                "total_ceiling_quantity": Decimal("0"),
                "indent_count": 0,
                "allocations": [],
            })
            requested = _quantize(Decimal(str(line.quantity)))
            ceiling = _approval_ceiling(line, has_previous)
            bucket["total_requested_quantity"] += requested
            bucket["total_ceiling_quantity"] += ceiling
            bucket["indent_count"] += 1
            bucket["allocations"].append(ConsolidatedItemAllocationOut(
                indent_id=indent.id,
                indent_no=indent.indent_no,
                line_id=line.id,
                requested_by_name=indent.requested_by_name,
                requested_quantity=float(requested),
                ceiling_quantity=float(ceiling),
                is_excluded=bool(line.is_excluded),
                excluded_by_name=line.excluded_by_name,
            ))

    indent_summaries = []
    for indent, instance, has_previous in sorted(group, key=lambda m: m[0].indent_no):
        lines = _lines(indent, filters)
        indent_summaries.append(ConsolidationIndentSummaryOut(
            id=indent.id,
            indent_no=indent.indent_no,
            status=indent.status,
            requested_by_id=indent.requested_by_id,
            requested_by_name=indent.requested_by_name,
            requested_by_code=indent.requested_by_code,
            region_id=indent.region_id,
            region_name=indent.region_name,
            project_id=indent.project_id,
            project_name=indent.project_name,
            office_id=indent.office_id,
            office_name=indent.office_name,
            vehicle_id=indent.vehicle_id,
            vehicle_number=indent.vehicle_number,
            current_stage_name=instance.current_stage_name,
            line_count=len(lines),
            total_requested_quantity=float(
                sum((_quantize(Decimal(str(l.quantity))) for l in lines), Decimal("0")),
            ),
            previous_approved_quantity=(
                float(sum(
                    (_approval_ceiling(l, has_previous) for l in lines), Decimal("0"),
                )) if has_previous else None
            ),
            current_ceiling_quantity=float(
                sum((_approval_ceiling(l, has_previous) for l in lines), Decimal("0")),
            ),
        ))

    indents = [i for i, _, _ in group]
    # The month the DOCUMENT is for, not the key it is filed under: once indents group
    # by consolidation the key reads `C2`, which is nobody's idea of a month.
    month = doc.cycle if doc is not None else cycle
    return ConsolidationBatchOut(
        batch_key=cycle,
        cycle=cycle,
        consolidation_no=getattr(doc, "consolidation_no", None),
        consolidation_status=getattr(doc, "status", None),
        month_label=_month_label(month),
        region_id=_only({i.region_id for i in indents}),
        region_name=_only({i.region_name for i in indents}),
        project_id=_only({i.project_id for i in indents}),
        project_name=_only({i.project_name for i in indents}),
        current_stage_name=group[0][1].current_stage_name,
        indent_count=len(group),
        requester_count=len({i.requested_by_id for i in indents}),
        project_count=len({i.project_id for i in indents if i.project_id is not None}),
        region_count=len({i.region_id for i in indents if i.region_id is not None}),
        requesters=sorted({i.requested_by_name for i in indents if i.requested_by_name}),
        consolidated_items=[
            ConsolidatedItemOut(
                item_id=v["item_id"], item_code=v["item_code"], item_name=v["item_name"],
                uom_code=v["uom_code"],
                # How finely this unit may be split, so the screen's proportional share
                # cannot offer somebody 5.7 of something counted in whole numbers. An
                # unknown code keeps the old three decimals.
                uom_decimals=(decimals_by_uom or {}).get(v["uom_code"], MAX_DECIMALS),
                total_requested_quantity=float(v["total_requested_quantity"]),
                total_ceiling_quantity=float(v["total_ceiling_quantity"]),
                indent_count=v["indent_count"],
                allocations=sorted(v["allocations"], key=lambda a: a.indent_no),
            )
            for v in sorted(items_totals.values(), key=lambda v: v["item_code"] or "")
        ],
        indents=indent_summaries,
    )


async def consolidation_batches_for_user(
    db: AsyncSession, user, filters: ConsolidationFilters | None = None,
) -> list[ConsolidationBatchOut]:
    """One batch per monthly cycle, holding the indents that survive `filters`.

    Region/project/vehicle/office/requester/item narrow what is inside a cycle; they
    never split it into more cycles. An empty cycle is dropped rather than returned
    with zero indents.
    """
    filters = filters or ConsolidationFilters()
    members = await _monthly_pending_indents(db, user)
    return _batches_from(members, filters, await _member_uom_decimals(db, members),
                         await _docs_for(db, members))


async def _docs_for(db: AsyncSession, members: list) -> dict:
    """{key: Consolidation} for the batches these indents form, in one query."""
    return await _consolidation_docs(db, {
        _consolidation_key(getattr(indent, "consolidation_id", None), indent)
        for indent, _instance, _has_previous in members
    })


async def _member_uom_decimals(db: AsyncSession, members: list) -> dict[str, int]:
    """{uom_code: decimals} for every unit in this queue, in one query."""
    return await decimals_by_code(db, {
        line.uom_code for indent, _instance, _has_previous in members
        for line in indent.items
    })


def _batches_from(
    members: list, filters: ConsolidationFilters,
    decimals_by_uom: dict[str, int] | None = None,
    docs: dict | None = None,
) -> list[ConsolidationBatchOut]:
    """Grouped by the consolidation DOCUMENT, falling back to the month for indents
    raised before documents existed. Grouping on the month alone put every August
    indent in one heap and named it `CONS-2026-08`, while the fulfilment and allocation
    screens were already calling the same set `CON/2026-27/00001`. Same set, three
    names — and once a document is sealed, the month is no longer even the same set."""
    groups: dict[str, list] = defaultdict(list)
    for indent, instance, has_previous in members:
        if _matches(indent, filters):
            key = _consolidation_key(getattr(indent, "consolidation_id", None), indent)
            groups[key].append((indent, instance, has_previous))

    batches = [_build_batch(cycle, group, filters, decimals_by_uom,
                            (docs or {}).get(cycle))
               for cycle, group in groups.items()]
    batches.sort(key=lambda b: b.cycle, reverse=True)
    return batches


async def consolidation_workspace(
    db: AsyncSession, user, filters: ConsolidationFilters | None = None,
) -> ConsolidationOut:
    """The whole screen in one round trip: filtered batches + the dropdown contents.

    The approver's Monthly pending set is read ONCE and both halves are derived from
    it in memory — the filter bar costs no extra query, and adding a filter costs one
    request, not one per dropdown.
    """
    filters = filters or ConsolidationFilters()
    members = await _monthly_pending_indents(db, user)
    batches = _batches_from(members, filters, await _member_uom_decimals(db, members),
                            await _docs_for(db, members))
    return ConsolidationOut(
        items=batches,
        filter_options=_filter_options(members),
        applied={k: v for k, v in filters.as_dict().items() if v is not None},
        total_indent_count=sum(b.indent_count for b in batches),
        total_requester_count=len({
            row.requested_by_id for b in batches for row in b.indents
            if row.requested_by_id is not None
        }),
        unfiltered_indent_count=len(members),
    )


def _validated_quantities(
    indent: Indent, submitted: list[ApprovalQuantityIn],
    has_previous_approval: bool = False,
) -> dict[int, Decimal]:
    by_id: dict[int, Decimal] = {}
    excluded_set: set[int] = {
        item.line_id for item in submitted if getattr(item, "excluded", False)
    }
    for item in submitted:
        if item.line_id in by_id:
            raise ValidationError(f"Quantity for line {item.line_id} was submitted twice")
        by_id[item.line_id] = _quantize(Decimal(str(item.approved_quantity)))

    expected = {line.id for line in indent.items}
    received = set(by_id)
    if received != expected:
        missing = sorted(expected - received)
        unknown = sorted(received - expected)
        details = []
        if missing:
            details.append(f"missing lines: {missing}")
        if unknown:
            details.append(f"unknown lines: {unknown}")
        raise ValidationError("Submit one quantity for every indent line (" + "; ".join(details) + ")")

    for line in indent.items:
        approved = by_id[line.id]
        ceiling = _approval_ceiling(line, has_previous_approval)
        label = line.item_name or line.item_code or line.id
        if approved < 0:
            raise ValidationError(f"Approved quantity for {label} cannot be negative")
        if approved > ceiling:
            source = (
                "the quantity approved at the previous level"
                if has_previous_approval else "the requested quantity"
            )
            raise ValidationError(
                f"Approved quantity for {label} cannot exceed {source} "
                f"({_plain(ceiling)}). An approver may only reduce it."
            )
    return by_id


async def _nothing_owed(db: AsyncSession, indent) -> bool:
    """Every line already covered, and something actually covers it.

    Covered means approved-and-allocated OR promised by a live allocation somebody has
    raised but nobody has signed yet — an approver who commits their whole stock has
    finished the indent even though `allocated_quantity` will not move until the
    allocation clears its own ladder.

    The "and something actually covers it" half matters: a fresh indent has 0
    allocated against 0 approved on every line until this very call sets the
    quantities, and reading that as "fully served" would end every ladder at the
    first rung.
    """
    from .fulfilment import committed_by_line, remainder_of

    committed = await committed_by_line(db, indent.id)
    owed = sum(
        max(remainder_of(line) - committed.get(line.id, Decimal("0")), Decimal("0"))
        for line in indent.items
    )
    covered = sum(
        Decimal(str(line.allocated_quantity or 0)) + committed.get(line.id, Decimal("0"))
        for line in indent.items
    )
    return covered > 0 and owed == 0


async def approve_indent(
    db: AsyncSession, indent_id: int, quantities: list[ApprovalQuantityIn],
    comments: str, user, task: tuple[Indent, Instance, bool] | None = None,
) -> ApprovalIndentOut:
    """`task` is the already-loaded (indent, instance, has_previous) for callers that
    have just validated it — the consolidated approval, which would otherwise pay for
    the same three-query load twice per indent, 900 times over. Loaded here when it is
    not supplied, so the single-indent route is unchanged."""
    indent, instance, has_previous = task or await _load_indent_task(db, indent_id, user)
    approved_by_line = _validated_quantities(indent, quantities, has_previous)

    # Which lines this approver DROPPED, as opposed to cut to nothing. Only lines the
    # screen actually sent can be excluded; a line it never mentioned keeps whatever it
    # already carried, so approving without touching anything never excludes.
    excluded_lines = {q.line_id for q in quantities if getattr(q, "excluded", False)}

    before: dict[str, float] = {}
    after: dict[str, float] = {}
    for line in indent.items:
        before[f"line_{line.id}_approved_qty"] = float(
            _approval_ceiling(line, has_previous)
        )
        line.approved_quantity = approved_by_line[line.id]
        after[f"line_{line.id}_approved_qty"] = float(line.approved_quantity)
        # Setting quantity to 0 or dropping a line permanently marks it excluded/rejected.
        if (line.id in excluded_lines or line.approved_quantity == 0) and not line.is_excluded:
            line.is_excluded = True
            line.excluded_by_id = getattr(user, "id", None)
            line.excluded_by_name = getattr(user, "full_name", None)
            line.excluded_at = ist_now()
            after[f"line_{line.id}_excluded"] = 1.0

    await write_audit(
        db,
        entity="ind_indent_items",
        entity_id=indent.id,
        entity_no=indent.indent_no,
        action=AuditAction.UPDATE,
        actor=user,
        before=before,
        after=after,
        summary=f"Updated quantities at {instance.current_stage_name or 'approval stage'}",
    )

    positive_count = sum(1 for line in indent.items if _d(line.approved_quantity) > 0 and not getattr(line, "is_excluded", False))
    if positive_count == 0:
        # All items were set to 0 (or the only item was set to 0): stop here with REJECTED status.
        updated = await indent_service.act_on_indent(
            db, indent_id, ApprovalAction.REJECTED,
            comments or "All requested items rejected (quantities set to 0)",
            user,
        )
    else:
        # Positive quantities remain: advance to next stage or complete approval.
        # Zero-quantity lines are excluded and will not enter inventory fulfilment.
        updated = await indent_service.act_on_indent(
            db, indent_id, ApprovalAction.APPROVED, comments, user,
            final=await _nothing_owed(db, indent),
        )

    # The action may advance to another stage or complete the workflow. Return the
    # latest document with the quantities just persisted.
    next_instance = (await db.execute(select(Instance).where(
        Instance.doc_type == DocType.INDENT.value,
        Instance.doc_id == indent_id,
    ).order_by(Instance.id.desc()))).scalars().first()
    if next_instance is None:
        next_instance = instance
    return _approval_out(updated, next_instance, True)


async def approve_consolidation(
    db: AsyncSession, body: ConsolidationApprovalIn, user,
) -> ConsolidationApprovalOut:
    """Approve every indent the Consolidation screen currently shows, in one act.

    The screen sends the per-line quantities its split produced; any line it does not
    mention keeps this approver's ceiling, so approving without touching a quantity
    passes the request on unchanged. Each indent still goes through
    `approve_indent` — the engine owns the chain (rule 8) and every document gets its
    own `wf_actions` row, exactly as if the approver had opened each one.

    Not atomic across indents by design: one indent that has moved on since the
    screen loaded must not block the rest. Its id comes back under `failed` with the
    reason, and the caller refreshes.
    """
    quantities_by_indent: dict[int, list[ApprovalQuantityIn]] = defaultdict(list)
    for line in body.lines:
        quantities_by_indent[line.indent_id].append(
            ApprovalQuantityIn(line_id=line.line_id,
                               approved_quantity=line.approved_quantity,
                               excluded=line.excluded),
        )

    approved: list[int] = []
    failed: list[ConsolidationApprovalFailureOut] = []
    for indent_id in body.indent_ids:
        try:
            quantities = quantities_by_indent.get(indent_id)
            # ONE load per indent for the whole approval. This used to read the indent
            # three times over — `db.get` for the served check, `_load_indent_task` for
            # the ceilings, and `_load_indent_task` again inside `approve_indent` — plus
            # their instance and pending lookups. On a 900-indent cycle that is thousands
            # of round trips spent re-reading rows already in hand, and it is most of why
            # signing a month took minutes. The task is handed down instead.
            task = await _load_indent_task(db, indent_id, user)
            indent, _instance, has_previous = task
            # An indent with nothing left owed is NOT skipped here, it is approved and
            # ended. `approve_indent` already passes `final=_nothing_owed(...)` to the
            # engine, which closes the ladder at this rung rather than sending a settled
            # document upward — the exact protection the skip was reaching for.
            #
            # Skipping did not achieve it. It returned before the engine was ever
            # called, so the instance stayed IN_PROGRESS and the indent stayed
            # PENDING_APPROVAL: the batch came back to the same approver, was judged
            # served again, and was skipped again, forever. IND/2026-27/00639 in
            # CON/2026-27/00004 sat at the District Manager rung this way — 9.875
            # approved, covered by one APPROVED allocation of 4.263 and one still-
            # pending 5.612 — while its batch-mate, which had no pending allocation,
            # completed normally. A document the screen refuses to act on has to be
            # finished by something; nothing else was going to finish this one.
            if not quantities:
                # Nothing edited for this indent: hand on what it is already entitled
                # to rather than sending an empty list, which approve_indent rejects.
                quantities = [
                    ApprovalQuantityIn(
                        line_id=line.id,
                        approved_quantity=float(_approval_ceiling(line, has_previous)),
                    )
                    for line in indent.items
                ]
            await approve_indent(db, indent_id, quantities, body.comments, user, task=task)
            approved.append(indent_id)
        except AppException as exc:
            # One document's problem is not the batch's: record it and carry on.
            await db.rollback()
            # The rollback expires `user` too; without this the NEXT indent dies on a
            # lazy reload outside async context and 500s the whole consolidation.
            await db.refresh(user)
            failed.append(ConsolidationApprovalFailureOut(
                indent_id=indent_id, reason=str(getattr(exc, "message", None) or exc),
            ))

    return ConsolidationApprovalOut(
        approved_count=len(approved), approved_indent_ids=approved, failed=failed,
    )


async def reject_indent(
    db: AsyncSession, indent_id: int, comments: str, user,
) -> ApprovalIndentOut:
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    updated = await indent_service.act_on_indent(
        db, indent_id, ApprovalAction.REJECTED, comments, user,
    )
    return _approval_out(updated, instance, has_previous)


async def return_indent(
    db: AsyncSession, indent_id: int, comments: str, user,
) -> ApprovalIndentOut:
    """Return for correction: same engine-backed flow as `/api/indents/{id}/
    return-for-correction` (`indent_service.return_indent_for_correction`), which
    the frontend actually calls. This route must not carry its own divergent
    implementation — a second "return" that cancelled the instance and dropped the
    indent to DRAFT used to live here, which silently reset the approval chain and
    disagreed with RETURNED_FOR_CORRECTION on resubmit (fresh instance instead of
    resuming the same rung). Delegating keeps exactly one return-for-correction
    behavior regardless of which endpoint a caller uses.
    """
    indent, instance, has_previous = await _load_indent_task(db, indent_id, user)
    updated = await indent_service.return_indent_for_correction(db, indent_id, comments, user)
    return _approval_out(updated, instance, has_previous)


# ---------------- Monthly allocation cycles in the approval inbox ----------------
#
# A monthly cycle's allocations were only reachable from Inventory > Allocation
# Approvals. Somebody living in the Approvals module — which is where every other
# approval lands — had no way to see or sign them, so a cycle sat waiting while the
# approver's inbox said there was nothing to do.
#
# Delegated rather than reimplemented: `indents.service.allocation_approval_batches`
# already builds these, already applies `_indent_visibility` (the rung), and already
# marks which ones the caller's ACTIVE position may sign. Writing a second query here
# would be a second scope rule to keep in step with the first.

async def allocation_cycles_for_user(db: AsyncSession, user) -> list[dict]:
    """Monthly allocation cycles awaiting this approver, for the approval inbox."""
    from app.modules.indents.service import allocation_approval_batches

    batches = await allocation_approval_batches(db, user)
    return [{
        "cycle": batch["cycle"],
        "month_label": batch["month_label"],
        # The document number, so the inbox names the same thing the cycle screen
        # does when a month holds more than one consolidation.
        "consolidation_no": batch["consolidation_no"],
        "allocation_count": batch["allocation_count"],
        "actionable_count": batch["actionable_count"],
        "indent_count": batch["indent_count"],
        "item_count": batch["item_count"],
        "total_qty": batch["total_qty"],
        # Where the inbox sends them. The same screen Inventory links to, so a cycle
        # is signed in one place however it was reached.
        "href": f"/inventory/allocation-approvals/cycle/{batch['cycle']}",
        "doc_type": DocType.ALLOCATION.value,
    } for batch in batches]
