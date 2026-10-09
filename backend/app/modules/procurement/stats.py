"""Procurement KPIs — the numbers each buying screen leads with, and the Overview.

WHY A FILE OF ITS OWN, beside `ledger.py` and `consolidation.py`: nothing here writes
anything. Every function is a COUNT over documents that already exist, so a KPI can
never say something the register under it does not, and there is no second copy of a
number to drift.

**RBAC is the whole design, not a decoration on it.** Two rules, both load-bearing:

1. Every function takes the same `user` its register takes and applies the SAME
   `scope_condition` over the SAME columns. A tile counting rows the list would not
   show is a leak — the count itself is the disclosure ("there are 14 orders you
   cannot see") — and a number that disagrees with the list under it is a bug report
   waiting to happen. The scoping here is copied from `service.list_pos` /
   `list_rfqs` / `list_quotations` / `list_requisitions` and
   `consolidation.list_consolidations`; change one and change the other.
2. One document family per function, so the ROUTER can gate each on the view code of
   the documents it counts — `requisition.view`, `consolidation.view`, `rfq.view`,
   `rfq.compare`, `po.view`. There is deliberately NO single `/overview` endpoint
   returning everything: it could only be gated on one code, and would then either
   fail closed for a buyer who holds the others or serve the ones they do not. The
   Overview screen calls the endpoints its login holds and draws the tiles it gets
   back, so revoking a permission removes the tile, the request and the number
   together.

`awaiting_me` is the exception that proves the rule: it never touches these tables at
all. It asks `platform/workflow/engine.pending_for_user`, which answers for the
CALLER's own position — so it is correct by construction and no data rung can widen
it.
"""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams
from app.modules.procurement import ledger
from app.modules.procurement.models import (
    PurchaseConsolidation, PurchaseOrder, Quotation, RFQ, Requisition,
    RequisitionItem,
)
from app.platform.workflow import engine
from app.shared.enums import (
    ConsolidationStatus, DocType, POStatus, POVendorStatus, QuotationStatus,
    RFQStatus, RequisitionStatus,
)
from app.shared.scope import scope_condition
from app.shared.time import now as ist_now

# --------------------------------------------------------------------------- #
# Status groupings. Named once, here, because the tile that COUNTS a bucket and the
# filter that tile OPENS have to agree — the screen sends these same values back as
# `?status=`, so a bucket defined in the frontend would be one rename away from a
# tile whose list comes back empty.
# --------------------------------------------------------------------------- #

#: Requisitions still moving: demand that has not been bought, rejected or dropped.
REQ_OPEN = (
    RequisitionStatus.PENDING_APPROVAL.value,
    RequisitionStatus.APPROVED.value,
    RequisitionStatus.CONSOLIDATED.value,
    RequisitionStatus.RFQ_RAISED.value,
)
#: Demand that has been SANCTIONED and is not yet fully on order — what the demand
#: pool is made of, and what a consolidated sheet is built from. DRAFT is out (nobody
#: buys against an unsubmitted request) and so is PENDING_APPROVAL (not sanctioned
#: yet), which is the same reading `indents._SETTLED_MR_STATUSES` gives its own
#: "on order" term.
REQ_SANCTIONED = (
    RequisitionStatus.APPROVED.value,
    RequisitionStatus.CONSOLIDATED.value,
    RequisitionStatus.RFQ_RAISED.value,
)
#: Purchase orders the company is still waiting on — the open commitment.
PO_OPEN = (
    POStatus.APPROVED.value,
    POStatus.SENT_TO_VENDOR.value,
    POStatus.ACCEPTED_BY_SUPPLIER.value,
    POStatus.PARTIALLY_RECEIVED.value,
)
#: Sent and not yet fully received: the order is with the vendor, whatever they have
#: said about it. APPROVED is NOT here — that one is still on our desk to send.
PO_AT_VENDOR = (
    POStatus.SENT_TO_VENDOR.value,
    POStatus.ACCEPTED_BY_SUPPLIER.value,
    POStatus.PARTIALLY_RECEIVED.value,
)
#: A quote that is on the table: submitted, possibly re-priced, not yet decided.
QUOTE_LIVE = (QuotationStatus.SUBMITTED.value, QuotationStatus.REVISED.value)

#: How many days ahead "closing soon" reaches on the RFQ board.
CLOSING_SOON_DAYS = 7


def _csv(statuses) -> str:
    """The comma-separated `?status=` the registers take."""
    return ",".join(statuses)


# --------------------------------------------------------------------------- #
# What each tile OPENS.
#
# Served, never mapped in the screen. A tile that counts one thing and filters to
# another is the worst kind of dashboard bug — it is invisible until somebody counts
# the rows by hand — and the only way to make it impossible is for the same code to
# decide both. The screen sends these query parameters back verbatim; it never builds
# one, so renaming a status here changes the count and the list in the same commit.
#
# Keys match the bucket names in the payloads below, one for one.
# --------------------------------------------------------------------------- #

REQ_FILTERS: dict[str, dict[str, str]] = {
    "awaiting_me": {"pending_for_me": "1"},
    "pending_approval": {"status": RequisitionStatus.PENDING_APPROVAL.value},
    "approved": {"status": RequisitionStatus.APPROVED.value},
    "draft": {"status": RequisitionStatus.DRAFT.value},
    "rejected": {"status": RequisitionStatus.REJECTED.value},
    "total": {},
}

CONSOLIDATION_FILTERS: dict[str, dict[str, str]] = {
    "awaiting_me": {"pending_for_me": "1"},
    "pending_approval": {"status": ConsolidationStatus.PENDING_APPROVAL.value},
    "approved": {"status": ConsolidationStatus.APPROVED.value},
    "draft": {"status": ConsolidationStatus.DRAFT.value},
    "total": {},
}

RFQ_FILTERS: dict[str, dict[str, str]] = {
    "awaiting_me": {"pending_for_me": "1"},
    "pending_approval": {"status": RFQStatus.PENDING_APPROVAL.value},
    "out_to_vendors": {"status": RFQStatus.PUBLISHED.value},
    # Not a status — see `rfq_stats`. The register takes the same flag and computes
    # the same predicate, so the tile and the list agree by construction.
    "ready_to_award": {"ready_to_award": "1"},
    "draft": {"status": RFQStatus.DRAFT.value},
    "awarded": {"status": RFQStatus.AWARDED.value},
    "total": {},
}

QUOTE_FILTERS: dict[str, dict[str, str]] = {
    "to_compare": {"status": _csv(QUOTE_LIVE)},
    "revised": {"status": QuotationStatus.REVISED.value},
    "accepted": {"status": QuotationStatus.ACCEPTED.value},
    "not_selected": {"status": QuotationStatus.REJECTED.value},
    "draft": {"status": QuotationStatus.DRAFT.value},
    "total": {},
}

PO_FILTERS: dict[str, dict[str, str]] = {
    "awaiting_me": {"pending_for_me": "1"},
    "pending_approval": {"status": POStatus.PENDING_APPROVAL.value},
    "to_send": {"status": POStatus.APPROVED.value},
    "at_vendor": {"status": _csv(PO_AT_VENDOR)},
    "awaiting_vendor": {"status": POStatus.SENT_TO_VENDOR.value},
    "draft": {"status": POStatus.DRAFT.value},
    "received": {"status": _csv((POStatus.RECEIVED.value, POStatus.CLOSED.value))},
    "total": {},
}


def _month_start():
    return ist_now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _f(value) -> float:
    """Numeric(16,2) comes back as Decimal, which is not JSON. Round at the edge."""
    if isinstance(value, (Decimal, int, float)):
        return float(value)
    return 0.0


def _where(clause):
    """A scope clause, or an always-true one when there is no user to scope by.

    `user=None` is the test/system caller, never a login: an endpoint always passes
    one, because `require_permission` cannot resolve without it.
    """
    return clause if clause is not None else literal(True)


async def _count_by_status(db: AsyncSession, model, where) -> dict[str, int]:
    """`{status: n}` for one document type, under one scope clause.

    One GROUP BY rather than a COUNT per tile: the buckets below are combinations of
    statuses, several tiles share statuses, and five round trips to answer four
    numbers is how a dashboard becomes the slowest screen in the app.
    """
    rows = (await db.execute(
        select(model.status, func.count()).where(where).group_by(model.status)
    )).all()
    return {status: n for status, n in rows}


def _sum(counts: dict[str, int], *statuses: str) -> int:
    return sum(counts.get(s, 0) for s in statuses)


async def _awaiting_me(db: AsyncSession, user, doc_type: str) -> int:
    """How many of this document type sit in THIS login's approval queue.

    Straight off the engine, never off the document's status: `PENDING_APPROVAL` says
    somebody has to sign it, and only `wf_pending` says who. Counting the status
    instead would show every approver the whole queue and tell each of them it was
    theirs — which is the "why is this in my inbox" complaint, drawn as a tile.
    """
    if user is None:
        return 0
    return len(await engine.pending_for_user(db, user, doc_types=[doc_type]))


# --------------------------------------------------------------------------- #
# One function per document family — see the module docstring on why they are not
# one endpoint. Each mirrors its own register's scope exactly.
# --------------------------------------------------------------------------- #

async def requisition_stats(db: AsyncSession, user=None) -> dict:
    """Gated on `requisition.view`. Scope mirrors `service.list_requisitions`."""
    scope = _where(await scope_condition(
        db, user, owner_col=Requisition.created_by_id) if user is not None else None)
    counts = await _count_by_status(db, Requisition, scope)

    month = await db.scalar(
        select(func.count()).select_from(Requisition)
        .where(scope, Requisition.created_at >= _month_start())
    )
    open_value = await db.scalar(
        select(func.coalesce(func.sum(Requisition.estimated_value), 0))
        .where(scope, Requisition.status.in_(REQ_OPEN))
    )
    lines = await db.scalar(
        select(func.coalesce(func.sum(Requisition.total_items), 0)).where(scope)
    )
    return {
        "awaiting_me": await _awaiting_me(db, user, DocType.REQUISITION.value),
        "pending_approval": counts.get(RequisitionStatus.PENDING_APPROVAL.value, 0),
        "approved": counts.get(RequisitionStatus.APPROVED.value, 0),
        "draft": counts.get(RequisitionStatus.DRAFT.value, 0),
        "rejected": counts.get(RequisitionStatus.REJECTED.value, 0),
        "total": sum(counts.values()),
        "this_month": month or 0,
        "open_value": _f(open_value),
        "total_lines": int(lines or 0),
        "by_status": counts,
        "filters": REQ_FILTERS,
    }


async def consolidation_stats(db: AsyncSession, user=None) -> dict:
    """Gated on `consolidation.view`. Scope mirrors
    `consolidation.list_consolidations` — all four rungs, because that register
    carries every project's buying plan and its value."""
    scope = _where(await scope_condition(
        db, user,
        owner_col=PurchaseConsolidation.created_by_id,
        position_col=PurchaseConsolidation.created_position_id,
        project_col=PurchaseConsolidation.project_id,
        warehouse_col=PurchaseConsolidation.warehouse_id,
    ) if user is not None else None)
    counts = await _count_by_status(db, PurchaseConsolidation, scope)

    rolled, value, items = (await db.execute(
        select(
            func.coalesce(func.sum(PurchaseConsolidation.source_count), 0),
            func.coalesce(func.sum(PurchaseConsolidation.estimated_value), 0),
            func.coalesce(func.sum(PurchaseConsolidation.total_items), 0),
        ).where(scope, PurchaseConsolidation.status.notin_((
            ConsolidationStatus.CANCELLED.value,
            ConsolidationStatus.REJECTED.value,
        )))
    )).one()
    month = await db.scalar(
        select(func.count()).select_from(PurchaseConsolidation)
        .where(scope, PurchaseConsolidation.created_at >= _month_start())
    )
    return {
        "awaiting_me": await _awaiting_me(db, user, DocType.CONSOLIDATION.value),
        "pending_approval": counts.get(ConsolidationStatus.PENDING_APPROVAL.value, 0),
        "approved": counts.get(ConsolidationStatus.APPROVED.value, 0),
        "draft": counts.get(ConsolidationStatus.DRAFT.value, 0),
        "total": sum(counts.values()),
        "this_month": month or 0,
        "requisitions_rolled": int(rolled or 0),
        "total_items": int(items or 0),
        "estimated_value": _f(value),
        "by_status": counts,
        "filters": CONSOLIDATION_FILTERS,
    }


async def rfq_stats(db: AsyncSession, user=None) -> dict:
    """Gated on `rfq.view`. Scope mirrors `service.list_rfqs`."""
    scope = _where(await scope_condition(
        db, user, owner_col=RFQ.created_by_id) if user is not None else None)
    counts = await _count_by_status(db, RFQ, scope)

    # "Ready to award" is not a status — it is a PUBLISHED or CLOSED tender that has
    # replies and no winner yet. Counted here rather than inferred on the screen, for
    # the same reason the buckets above are named here: the tile opens a list that has
    # to come back holding exactly these rows.
    ready = await db.scalar(
        select(func.count()).select_from(RFQ).where(
            scope,
            RFQ.status.in_((RFQStatus.PUBLISHED.value, RFQStatus.CLOSED.value)),
            RFQ.response_count > 0,
            RFQ.awarded_vendor_id.is_(None),
        )
    )
    today = date.today()
    closing = await db.scalar(
        select(func.count()).select_from(RFQ).where(
            scope,
            RFQ.status == RFQStatus.PUBLISHED.value,
            RFQ.due_date.isnot(None),
            RFQ.due_date >= today,
            RFQ.due_date <= today + timedelta(days=CLOSING_SOON_DAYS),
        )
    )
    invited, replies = (await db.execute(
        select(
            func.coalesce(func.sum(RFQ.vendor_count), 0),
            func.coalesce(func.sum(RFQ.response_count), 0),
        ).select_from(RFQ).where(scope)
    )).one()
    return {
        "awaiting_me": await _awaiting_me(db, user, DocType.RFQ.value),
        "pending_approval": counts.get(RFQStatus.PENDING_APPROVAL.value, 0),
        "out_to_vendors": counts.get(RFQStatus.PUBLISHED.value, 0),
        "ready_to_award": ready or 0,
        "draft": counts.get(RFQStatus.DRAFT.value, 0),
        "awarded": counts.get(RFQStatus.AWARDED.value, 0),
        "total": sum(counts.values()),
        "closing_soon": closing or 0,
        "vendors_invited": int(invited or 0),
        "quotes_received": int(replies or 0),
        "by_status": counts,
        "filters": RFQ_FILTERS,
    }


async def quotation_stats(db: AsyncSession, user=None) -> dict:
    """Gated on `rfq.compare` — a quotation is a vendor's PRICE, and reading the sheet
    is a narrower right than seeing the tender. Scope mirrors
    `service.list_quotations`: bounded through the RFQ the quote answers, because
    `pro_quotations` carries no project or warehouse of its own."""
    scope = _where(Quotation.rfq_id.in_(
        select(RFQ.id).where(
            await scope_condition(db, user, owner_col=RFQ.created_by_id))
    ) if user is not None else None)
    counts = await _count_by_status(db, Quotation, scope)

    rfqs_covered, vendors, value = (await db.execute(
        select(
            func.count(func.distinct(Quotation.rfq_id)),
            func.count(func.distinct(Quotation.vendor_id)),
            func.coalesce(func.sum(Quotation.grand_total), 0),
        ).select_from(Quotation)
        .where(scope, Quotation.status.in_(
            QUOTE_LIVE + (QuotationStatus.ACCEPTED.value,)))
    )).one()
    month = await db.scalar(
        select(func.count()).select_from(Quotation)
        .where(scope, Quotation.created_at >= _month_start())
    )
    return {
        # DRAFT quotations are created for the vendor when an RFQ publishes, so they
        # are a form nobody has filled in — never a buyer's queue.
        "to_compare": _sum(counts, *QUOTE_LIVE),
        "revised": counts.get(QuotationStatus.REVISED.value, 0),
        "accepted": counts.get(QuotationStatus.ACCEPTED.value, 0),
        "not_selected": counts.get(QuotationStatus.REJECTED.value, 0),
        "draft": counts.get(QuotationStatus.DRAFT.value, 0),
        "total": sum(counts.values()),
        "this_month": month or 0,
        "rfqs_covered": int(rfqs_covered or 0),
        "vendors_quoting": int(vendors or 0),
        "quoted_value": _f(value),
        "by_status": counts,
        "filters": QUOTE_FILTERS,
    }


async def po_stats(db: AsyncSession, user=None) -> dict:
    """Gated on `po.view`. Scope mirrors `service.list_pos` — owner AND office."""
    scope = _where(await scope_condition(
        db, user,
        owner_col=PurchaseOrder.created_by_id,
        office_col=PurchaseOrder.office_id,
    ) if user is not None else None)
    counts = await _count_by_status(db, PurchaseOrder, scope)

    month_count, month_value = (await db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(PurchaseOrder.total_amount), 0),
        ).select_from(PurchaseOrder)
        .where(scope, PurchaseOrder.created_at >= _month_start())
    )).one()
    commitment = await db.scalar(
        select(func.coalesce(func.sum(PurchaseOrder.total_amount), 0))
        .where(scope, PurchaseOrder.status.in_(PO_OPEN))
    )
    # Orders sent out that the vendor has not answered. Its own number because it is
    # the one thing on this board nobody inside the company can move along.
    awaiting_vendor = await db.scalar(
        select(func.count()).select_from(PurchaseOrder).where(
            scope,
            PurchaseOrder.status == POStatus.SENT_TO_VENDOR.value,
            or_(PurchaseOrder.vendor_status.is_(None),
                PurchaseOrder.vendor_status == POVendorStatus.PENDING.value),
        )
    )
    return {
        "awaiting_me": await _awaiting_me(db, user, DocType.PO.value),
        "pending_approval": counts.get(POStatus.PENDING_APPROVAL.value, 0),
        "to_send": counts.get(POStatus.APPROVED.value, 0),
        "at_vendor": _sum(counts, *PO_AT_VENDOR),
        "awaiting_vendor": awaiting_vendor or 0,
        "draft": counts.get(POStatus.DRAFT.value, 0),
        "received": _sum(counts, POStatus.RECEIVED.value, POStatus.CLOSED.value),
        "total": sum(counts.values()),
        "this_month": month_count or 0,
        "month_value": _f(month_value),
        "open_commitment": _f(commitment),
        "by_status": counts,
        "filters": PO_FILTERS,
    }


# --------------------------------------------------------------------------- #
# The buying trail's own strip
# --------------------------------------------------------------------------- #

async def ledger_stats(db: AsyncSession, *,
                       status: str | None = None,
                       project: str | None = None,
                       vendor: str | None = None,
                       date_from: date | None = None,
                       date_to: date | None = None,
                       search: str | None = None) -> dict:
    """How many of each document kind the register is currently showing.

    The SAME filters `service.procurement_ledger` applies, over the SAME union, minus
    `doc_kind` — which is the one the tiles set. So the four numbers always add up to
    the total under the current filters, and pressing a tile narrows the register to
    exactly the rows that tile counted.

    Gated on `po.view`, like the register: the trail's most sensitive column is what
    an order came to, and that is a purchase order's own number.

    Unscoped, because the register it summarises is unscoped. That is a property of
    the ledger, not a decision taken here — a strip that counted MORE than its list
    shows would be the leak, and this one cannot.
    """
    trail = ledger.source().subquery("trail")
    stmt = select(trail.c.doc_kind, func.count()).select_from(trail)

    if status:
        stmt = stmt.where(trail.c.status == status)
    if project:
        stmt = stmt.where(trail.c.project_name == project)
    if vendor:
        stmt = stmt.where(trail.c.party == vendor)
    if date_from is not None:
        stmt = stmt.where(trail.c.doc_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(trail.c.doc_date <= date_to)
    if search and search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(*[
            trail.c[name].ilike(like) for name in ledger.SEARCH_COLUMNS
        ]))

    counts = {kind: n for kind, n in
              (await db.execute(stmt.group_by(trail.c.doc_kind))).all()}
    # Every kind is reported, zero included: a tile that vanishes when its bucket
    # empties makes the strip jump about, and "0 quotations" is an answer.
    by_kind = {kind["value"]: counts.get(kind["value"], 0)
               for kind in ledger.DOC_KINDS}
    return {
        "by_kind": by_kind,
        "total": sum(by_kind.values()),
        # Same contract as the five strips above: the screen sends this back verbatim.
        "filters": {kind: {"doc_kind": kind} for kind in by_kind},
    }


# --------------------------------------------------------------------------- #
# The demand pool
# --------------------------------------------------------------------------- #

async def demand_pool(db: AsyncSession, params: PageParams, *,
                      project_id: int | None = None,
                      search: str | None = None,
                      user=None) -> dict:
    """How much of each item the company has sanctioned and not yet ordered.

    This is the question a consolidated buying sheet exists to answer, and until now
    it could only be answered by opening every approved requisition and adding up by
    hand. One item's pool is `sum(quantity - ordered_qty)` across every SANCTIONED
    requisition line — approved, consolidated or out to tender — so a line already
    bought in part contributes only its remainder and one bought in full contributes
    nothing. Rounds of buying therefore shrink the pool by themselves, the same way
    an indent's remainder is READ rather than stored (see `inventory/allocations.py`).

    Scoped through the REQUISITION, exactly as the register is: a buyer sees the pool
    made of the demand they can already read, never a company-wide total assembled out
    of documents their rung hides.
    """
    scope = _where(await scope_condition(
        db, user, owner_col=Requisition.created_by_id) if user is not None else None)

    remaining = func.sum(RequisitionItem.quantity - RequisitionItem.ordered_qty)
    stmt = (
        select(
            RequisitionItem.item_id.label("item_id"),
            func.max(RequisitionItem.item_code).label("item_code"),
            func.max(RequisitionItem.item_name).label("item_name"),
            func.max(RequisitionItem.uom_code).label("uom_code"),
            remaining.label("open_qty"),
            func.coalesce(func.sum(RequisitionItem.estimated_amount), 0)
            .label("estimated_value"),
            func.count(func.distinct(RequisitionItem.requisition_id))
            .label("requisition_count"),
            func.count(func.distinct(Requisition.project_id)).label("project_count"),
            func.min(RequisitionItem.required_date).label("earliest_required"),
        )
        .join(Requisition, Requisition.id == RequisitionItem.requisition_id)
        .where(scope, Requisition.status.in_(REQ_SANCTIONED))
        .group_by(RequisitionItem.item_id)
        # A line fully ordered leaves nothing in the pool. HAVING, not WHERE: the
        # remainder only exists once the group is summed, and filtering the LINES
        # would drop a part-ordered line's remainder along with it.
        .having(remaining > 0)
        .order_by(remaining.desc())
    )
    if project_id is not None:
        stmt = stmt.where(Requisition.project_id == project_id)
    if search:
        term = f"%{search}%"
        stmt = stmt.where(or_(
            RequisitionItem.item_code.ilike(term),
            RequisitionItem.item_name.ilike(term),
        ))

    # Not `core.pagination.paginate`: that one calls `.scalars()`, which keeps the
    # first column and throws the other eight away. Same {items, total, page, size}
    # shape (rule 11), same COUNT-over-the-subquery.
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(
        stmt.offset(params.offset).limit(params.size))).all()
    return {
        "items": [{
            "item_id": row.item_id,
            "item_code": row.item_code,
            "item_name": row.item_name,
            "uom_code": row.uom_code,
            "open_qty": _f(row.open_qty),
            "estimated_value": _f(row.estimated_value),
            "requisition_count": int(row.requisition_count or 0),
            "project_count": int(row.project_count or 0),
            "earliest_required": row.earliest_required,
        } for row in rows],
        "total": total or 0,
        "page": params.page,
        "size": params.size,
    }
