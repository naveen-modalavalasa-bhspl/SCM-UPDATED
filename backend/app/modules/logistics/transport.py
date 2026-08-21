"""Transport requests — the outward leg, from "we need a truck" to "it arrived".

Split out of `service.py` rather than appended to it. That file is the old GRN/issue
surface and shares nothing with this one but the module name; keeping transport in its
own file means a failure points at the leg it came from, and neither grows past what
fits in one head. `service.py` re-exports the public names so the router has one import
site (rule 1 counts the module's five files, not the modules a service is split into).

Import direction: logistics sits after procurement in the chain, so reading
`mst_vendors` for carriers and calling procurement is allowed. Nothing here imports
warehouse — the link to a dispatch or an issue is a soft id, never a model.

All approvals go through `platform/workflow/engine.py` (rule 8); this file never
decides who approves. Two doc types, because they are two decisions: TRANSPORT_REQUEST
sanctions the movement, CARRIER_AWARD sanctions the spend — and the second only runs
on a mode that actually hires somebody.
"""
import logging
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import (
    BigInteger, Integer, String, and_, case, cast, func, literal, or_, select,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.indents.models import Indent
from app.modules.indents import service as indent_service
from app.modules.logistics.enums import (
    ACK_CLAIM_EVENT,
    ACTIVITY_META,
    activity_catalogue as _activity_catalogue,
    activity_label,
    activity_result,
    AWAITING_ACK_STATUSES,
    CARRIAGE_RULES,
    CARRIER_VENDOR_TYPES,
    DEFAULT_CARRIAGE,
    EXCEPTION_EVENT_TYPES,
    LogisticsActivityType,
    MODE_RULES,
    AckCondition,
    QuoteStatus,
    SIGNATURE_EVENT_TYPES,
    ShipmentEventType,
    TERMINAL_STATUSES,
    TransportMode,
    TransportStatus,
    carriage_rule,
    carriages_for_mode,
    flow_stages,
    is_inbound,
    mode_rule,
    suggest_mode,
)
from app.modules.logistics import hooks
from app.modules.logistics.models import (
    MONEY, CarrierQuote, ShipmentEvent, TransportRequest, TransportRequestItem,
)
from app.modules.logistics.schemas import TRListRow, TROut
from app.platform.settings.service import write_audit
from app.platform.settings import attachments
from app.platform.workflow import engine, ladder
# Read-only, and only for the activity ledger: the trail of who decided what is
# the engine's to WRITE (rule 8) and every module's to read.
from app.platform.workflow.models import Action, Instance
from app.shared import evaluation
from app.shared.enums import ApprovalAction, AuditAction, DocType, InstanceStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Vendor
from app.shared.numbering import next_number
from app.shared.scope import scope_condition

logger = logging.getLogger(__name__)

AUDIT_ENTITY = "lgs_transport_requests"
ZERO = Decimal("0")
LOOKUP_LIMIT = 50


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def _and_list(names: list[str]) -> str:
    """"Amazon, Flipkart and Misaba" — for the audit line a person reads later."""
    clean = [name for name in names if name]
    if not clean:
        return "the provider"
    if len(clean) == 1:
        return clean[0]
    return f"{', '.join(clean[:-1])} and {clean[-1]}"


# --------------------------------------------------------------------------- #
#  Reads
# --------------------------------------------------------------------------- #

async def get_tr(db: AsyncSession, tr_id: int) -> TransportRequest:
    doc = await db.get(TransportRequest, tr_id)
    if doc is None:
        raise NotFoundError(f"Transport request {tr_id} not found")
    return doc


async def receipt_evidence(db: AsyncSession, tr_id: int) -> list:
    """Requester-uploaded photo/bill for this leg, exposed read-only to Logistics."""
    doc = await get_tr(db, tr_id)
    if not doc.indent_id:
        return []
    return await attachments.list_attachments(
        db, indent_service.ACK_ENTITY_TYPE, doc.indent_id)


async def receipt_evidence_file(db: AsyncSession, tr_id: int,
                                attachment_id: int):
    """Download one receipt file only when it belongs to this leg's indent."""
    rows = await receipt_evidence(db, tr_id)
    if not any(row.id == attachment_id for row in rows):
        raise NotFoundError("Receipt evidence not found for this shipment")
    return await attachments.attachment_file(db, attachment_id)



# FIXED 2026-08-20 — the whole transport register was unscoped.
#
# Why this exists: every reader here (`list_trs`, `provider_board`, `open_exceptions`,
# the activity ledger) selected straight off the table with no `user` at all, so
# `transport.view` alone showed one desk every shipment in the company — other regions'
# lanes, other projects' consignments, and the freight prices on all of them. WITHOUT
# this, a single logistics permission is a network-wide read, and the job-profile rung
# an admin sets on Job Profiles does nothing on this module.
#
# `from_warehouse_id` is the location dimension (a transport request is a fact about a
# lane leaving a point), `requested_by_id`/`requested_position_id` are the raiser, and
# `project_id` covers the PROJECT rung. A login with no profile still resolves to
# ScopeRung.ALL in `rung_for`, so nothing that works today stops working.
async def _tr_scope(db: AsyncSession, user):
    return await scope_condition(
        db, user,
        owner_col=TransportRequest.requested_by_id,
        position_col=TransportRequest.requested_position_id,
        project_col=TransportRequest.project_id,
        warehouse_col=TransportRequest.from_warehouse_id,
    )


# The paperwork that travels WITH the load, as opposed to the receipt evidence above,
# which is the requester's and comes back from the far end. Two documents, because
# those are the two a leg leaves with: the way bill the carrier moves it on, and the
# delivery challan the receiving site signs. Filed on `sys_attachments` under the
# shipment, so no logistics table learns about files.
DOC_ENTITY_TYPE = "TRANSPORT_REQUEST"
WAY_BILL_CATEGORY = "WAY_BILL"
DELIVERY_CHALLAN_CATEGORY = "DELIVERY_CHALLAN"
# A booked leg leaves with the counter's receipt instead: the parcel is handed over at
# a published rate, and the slip is what proves it was, and for how much.
RECEIPT_CATEGORY = "COURIER_RECEIPT"
TR_DOC_CATEGORIES = (WAY_BILL_CATEGORY, DELIVERY_CHALLAN_CATEGORY, RECEIPT_CATEGORY)


async def list_documents(db: AsyncSession, tr_id: int) -> list:
    """The way bill and delivery challan filed against this leg."""
    await get_tr(db, tr_id)
    return await attachments.list_attachments(db, DOC_ENTITY_TYPE, tr_id)


async def add_document(db: AsyncSession, tr_id: int, upload, doc_category: str, user):
    """File one of them. The category is checked here rather than taken as typed:
    `sys_attachments` is shared by every module, and a free-text category is how a
    panel that filters on one stops finding what another wrote."""
    await get_tr(db, tr_id)
    if doc_category not in TR_DOC_CATEGORIES:
        raise ValidationError(
            "A transport document is either a way bill or a delivery challan.")
    return await attachments.add_attachment(
        db, entity_type=DOC_ENTITY_TYPE, entity_id=tr_id, upload=upload,
        doc_category=doc_category, user=user)


async def document_file(db: AsyncSession, tr_id: int, attachment_id: int):
    """Download one, only when it belongs to this shipment."""
    rows = await list_documents(db, tr_id)
    if not any(row.id == attachment_id for row in rows):
        raise NotFoundError("That document is not filed against this shipment")
    return await attachments.attachment_file(db, attachment_id)


async def list_trs(db: AsyncSession, params: PageParams, status: str | None = None,
                   mode: str | None = None, carrier_id: int | None = None,
                   indent_id: int | None = None,
                   search: str | None = None,
                   dispatch_id: int | None = None,
                   source_type: str | None = None,
                   awaiting_ack: bool = False,
                   user=None) -> dict:
    stmt = select(TransportRequest)
    # FIXED — see `_tr_scope`. Optional so an internal caller that already knows what
    # it is reading (a hook, a handoff) is unaffected; every ROUTE passes the user.
    if user is not None:
        stmt = stmt.where(await _tr_scope(db, user))
    if source_type:
        # The one filter that separates the outward leg from the return one (doc E7).
        # Same register, same statuses, opposite direction.
        stmt = stmt.where(TransportRequest.source_type == source_type.upper())
    if status:
        # Comma-separated so one screen can ask for the two statuses that make up its
        # queue without two round trips.
        wanted = [s.strip().upper() for s in status.split(",") if s.strip()]
        stmt = stmt.where(TransportRequest.status.in_(wanted))
    if mode:
        stmt = stmt.where(TransportRequest.mode == mode.upper())
    if carrier_id:
        stmt = stmt.where(TransportRequest.carrier_id == carrier_id)
    if indent_id:
        stmt = stmt.where(TransportRequest.indent_id == indent_id)
    if dispatch_id:
        stmt = stmt.where(TransportRequest.dispatch_id == dispatch_id)
    if awaiting_ack:
        # On the road or landed, and nobody has signed for it. The indent team's chase
        # list (doc A7). IN_TRANSIT is in the queue as well as DELIVERED because the
        # site is the one who knows it arrived: waiting for this desk to tick
        # "delivered" first held the acknowledgement — and the indent behind it — on a
        # keystroke nobody at the destination can make.
        stmt = stmt.where(TransportRequest.status.in_(AWAITING_ACK_STATUSES))
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            TransportRequest.tr_no.ilike(like),
            TransportRequest.lr_no.ilike(like),
            TransportRequest.docket_no.ilike(like),
            TransportRequest.indent_no.ilike(like),
            TransportRequest.carrier_name.ilike(like),
            TransportRequest.to_location_name.ilike(like),
        ))
    return await paginate(db, stmt.order_by(TransportRequest.id.desc()), params)


def mode_catalogue() -> list[dict]:
    """The mode rules, served so the form asks for exactly what the service enforces.

    Without this the screen keeps its own copy of "own vehicle needs a driver" and the
    two drift the first time a rule changes.
    """
    return [{
        "value": value,
        "label": rule.label,
        "help": rule.help,
        "needs_carrier": rule.needs_carrier,
        "needs_quotes": rule.needs_quotes,
        "required_fields": list(rule.required_fields),
    } for value, rule in MODE_RULES.items()]


def carriage_catalogue() -> list[dict]:
    """The carriage modes and what can be arranged under each, served like the rules.

    Road, rail, air, sea — and which of the four arrangements each one allows, so the
    Dispatch screen narrows the arrangement tiles from the backend's table instead of
    from a constant of its own. It had one, and a copy of a rule in a screen is a rule
    with two values the day somebody starts shipping by barge.
    """
    return [{
        "value": value,
        "label": rule.label,
        "help": rule.help,
        "allowed_modes": list(rule.allowed_modes),
    } for value, rule in CARRIAGE_RULES.items()]


def _resolve_carriage(mode: str, carriage: str | None,
                      *, current: str | None = None) -> str:
    """The carriage this leg travels on, checked against the arrangement made.

    Nothing said falls back to what the document already carries, and then to ROAD:
    an unstated leg is a road leg, which is what every row written before the column
    existed actually was. Anything else is validated as a PAIR, because the two
    questions are not independent — a hand-over cannot be made by sea, and accepting
    one would leave the form asking for a driver on a container ship.
    """
    value = (carriage or "").strip().upper() or (current or "") or DEFAULT_CARRIAGE
    if value not in CARRIAGE_RULES:
        raise ValidationError(
            f"{carriage!r} is not a carriage mode. "
            f"Choose one of: {', '.join(CARRIAGE_RULES)}.")
    if (mode or "").upper() not in carriage_rule(value).allowed_modes:
        allowed = ", ".join(mode_rule(m).label
                            for m in carriage_rule(value).allowed_modes)
        raise ValidationError(
            f"{mode_rule(mode).label} cannot be arranged by "
            f"{carriage_rule(value).label.lower()}. By "
            f"{carriage_rule(value).label.lower()} the choices are: {allowed}.")
    return value


def evaluation_methods() -> list[dict]:
    """The same four the RFQ comparison offers — one catalogue, one arithmetic."""
    return evaluation.describe()


def mode_suggestion(distance_km: float | None = None,
                    weight_kg: float | None = None,
                    packages: int | None = None) -> dict | None:
    """"Based on distance, weight, items" (doc E3), answered before the desk picks.

    Advice, never a decision: the service validates whatever mode is chosen and this
    changes none of it. Served rather than computed in the screen for the same reason
    `mode_catalogue` is — the thresholds are a business rule, and a rule the frontend
    keeps its own copy of is a rule with two values.
    """
    return suggest_mode(distance_km, weight_kg, packages)


def flow_catalogue(mode: str | None = None) -> list[dict]:
    """The stepper, served rather than drawn from a constant in the screen.

    A tendered shipment has two stages the others do not. Letting the frontend decide
    that is how a hand-over ends up with a "Quotes" step nobody can ever complete.
    """
    return [{
        "key": stage.key,
        "label": stage.label,
        "help": stage.help,
        # The same rung read while the desk still owes it a press. Served rather than
        # written in the screen for the reason above: what a stage MEANS is the flow's
        # to say, and the award half of "Provider accepts" is no different.
        "pending_help": stage.pending_help,
        "statuses": list(stage.statuses),
    } for stage in flow_stages(mode)]


#: The queues the logistics desk actually works, in the order the flow runs. Served
#: as one call so the board is one round trip rather than nine.
_SUMMARY_QUEUES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("draft", (TransportStatus.DRAFT.value,)),
    ("pending_approval", (TransportStatus.PENDING_APPROVAL.value,)),
    ("quoting", (TransportStatus.QUOTING.value,)),
    ("awaiting_carrier", (TransportStatus.AWAITING_CARRIER.value,)),
    ("ready", (TransportStatus.READY.value,)),
    ("in_transit", (TransportStatus.IN_TRANSIT.value,)),
    ("delivered", (TransportStatus.DELIVERED.value,)),
    ("acknowledged", (TransportStatus.ACKNOWLEDGED.value,)),
    ("closed", (TransportStatus.CLOSED.value,)),
)


async def summary(db: AsyncSession) -> dict:
    """How many consignments are sitting at each stage, plus the open claims."""
    rows = (await db.execute(
        select(TransportRequest.status, func.count(TransportRequest.id))
        .group_by(TransportRequest.status)
    )).all()
    by_status = {status: count for status, count in rows}

    counts = {key: sum(by_status.get(s, 0) for s in statuses)
              for key, statuses in _SUMMARY_QUEUES}
    counts["open_claims"] = (await db.execute(
        select(func.count(ShipmentEvent.id))
        .where(ShipmentEvent.is_exception.is_(True),
               ShipmentEvent.resolved_at.is_(None))
    )).scalar_one()
    # The two the desk is actually judged on: nothing should sit here.
    counts["awaiting_ack"] = sum(by_status.get(s, 0) for s in AWAITING_ACK_STATUSES)
    counts["untracked"] = (await db.execute(
        select(func.count(TransportRequest.id))
        .where(TransportRequest.status.in_([TransportStatus.IN_TRANSIT.value,
                                            TransportStatus.DELIVERED.value]),
               TransportRequest.tracking_shared_at.is_(None))
    )).scalar_one()
    return counts


async def for_consignments(db: AsyncSession, dispatch_ids: list[int]) -> list[dict]:
    """Which of these warehouse consignments already have transport, and where it is.

    The Consignments screen asks this once for the page it is showing instead of one
    lookup per row. Nothing here reads `out_dispatches` — the ids come from the caller,
    which is what keeps logistics in front of warehouse in the import chain (rule 5).
    """
    if not dispatch_ids:
        return []
    rows = (await db.execute(
        select(TransportRequest)
        .where(TransportRequest.dispatch_id.in_(dispatch_ids))
        .order_by(TransportRequest.id.desc())
    )).scalars().all()
    seen: dict[int, dict] = {}
    for doc in rows:
        # Newest first, so the first row per consignment is the live one. A cancelled
        # attempt followed by a re-raise must show the re-raise.
        seen.setdefault(doc.dispatch_id, {
            "dispatch_id": doc.dispatch_id,
            "tr_id": doc.id,
            "tr_no": doc.tr_no,
            "mode": doc.mode,
            "carriage_mode": doc.carriage_mode,
            "status": doc.status,
            "carrier_name": doc.carrier_name,
            "lr_no": doc.lr_no or doc.docket_no,
            "driver_name": doc.driver_name,
            "vehicle_number": doc.vehicle_number,
        })
    return list(seen.values())


#: What sits on the provider selection desk, in the order the flow runs. QUOTING is
#: "prices still coming in", AWAITING_CARRIER is "awarded, the winner has not confirmed
#: yet", READY is "settled, not yet gone". One desk works all three, because the second
#: is the consequence of the first and a decline drops a shipment straight back into it.
PROVIDER_BOARD_STATUSES = (
    TransportStatus.QUOTING.value,
    TransportStatus.AWAITING_CARRIER.value,
    TransportStatus.READY.value,
)


def _mode_label(mode: str | None) -> str:
    """The arrangement's short name, and the raw code back if it is not one of ours —
    a label is presentation, and an unknown mode must not break "where is my stuff"."""
    try:
        return mode_rule(mode).label
    except KeyError:
        return (mode or "").replace("_", " ").title()


def _carriage_label(carriage: str | None) -> str:
    """What it travels ON. Nothing recorded reads as Road, the same fallback
    `_resolve_carriage` applies when the column is empty."""
    try:
        return carriage_rule(carriage or DEFAULT_CARRIAGE).label
    except (KeyError, ValidationError):
        return (carriage or "").replace("_", " ").title()


def _raiser_view(doc: TransportRequest) -> dict:
    """What a raiser is shown about the leg carrying their indent.

    Deliberately short: it is "where is my material", not the transport register, and
    the freight, the losing quotes and who awarded it are none of the field's business.
    """
    return {
        "tr_id": doc.id, "tr_no": doc.tr_no,
        "status": doc.status, "mode": doc.mode,
        # How it travels, in the raiser's words as well as ours. The LABELS travel with
        # the codes because the screen reading this is Indents, and indents sits BEFORE
        # logistics in the chain (rule 5) — it may not import our mode tables to look
        # one up. The field asking "where is my material" is owed the answer in plain
        # words anyway: THIRD_PARTY on a card tells a storekeeper nothing.
        "mode_label": _mode_label(doc.mode),
        "carriage_mode": doc.carriage_mode,
        "carriage_label": _carriage_label(doc.carriage_mode),
        "consignment_no": doc.consignment_no,
        "carrier_name": doc.carrier_name,
        # The tracking handle and the carrier's own page, pasted by the desk at
        # dispatch. A raiser who has the number does not need to be told it twice.
        "lr_no": doc.lr_no, "docket_no": doc.docket_no,
        "tracking_url": doc.tracking_url,
        # No carrier to track on a hand-over or a company vehicle — the answer to
        # "where is it" there is a person and a phone number.
        "vehicle_number": doc.vehicle_number,
        "driver_name": doc.driver_name, "driver_phone": doc.driver_phone,
        "handed_over_by_name": doc.handed_over_by_name,
        "expected_delivery": doc.expected_delivery,
        "dispatched_at": doc.dispatched_at,
        "delivered_at": doc.delivered_at,
        "tracking_shared_at": doc.tracking_shared_at,
        # Acknowledged already, and by whom. The raiser's own screen has to know
        # whether it is still theirs to sign for, and this is the only field that says.
        "acknowledged_at": doc.acknowledged_at,
        "ack_condition": doc.ack_condition,
        "events": [{
            "event_type": e.event_type, "event_at": e.event_at,
            "location_name": e.location_name, "description": e.description,
            "is_exception": e.is_exception,
        } for e in doc.events[-5:]],
    }


async def for_indent(db: AsyncSession, indent_id: int, user) -> list[dict]:
    """"Where is my material?", answered for the person who asked for it.

    The raiser of an indent holds `indent.view` and nothing of transport's, so this is
    the one transport read that is authorised by OWNERSHIP rather than by a logistics
    permission: you may see the leg carrying the indent you raised, and no other. Same
    shape as the carrier portal, where the token's identity IS the authorisation.

    Not gated on `tracking_shared_at`. That stamp records that the desk told the field;
    a field asking where its material is, is exactly the case where nobody did.
    """
    indent = await db.get(Indent, indent_id)
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")
    # Same message either way: telling a stranger that an indent exists but is not
    # theirs is still telling them it exists.
    if indent.requested_by_id != getattr(user, "id", None):
        raise NotFoundError("That indent is not open to you")

    rows = await db.execute(
        select(TransportRequest)
        .where(TransportRequest.indent_id == indent_id)
        .order_by(TransportRequest.id.desc()))
    return [_raiser_view(doc) for doc in rows.scalars().all()]


async def _own_indent_leg(db: AsyncSession, tr_id: int, user) -> TransportRequest:
    """One transport request, but only if the caller RAISED the indent it carries.

    The other half of `for_indent`. Reading where your material is and signing for it
    when it lands are the same person's business, so they are authorised the same way —
    by ownership of the indent, not by a logistics permission the raiser never holds.
    """
    doc = await get_tr(db, tr_id)
    if not doc.indent_id:
        # Nothing to own. A leg with no indent behind it is the desk's alone.
        raise NotFoundError("That consignment is not open to you")
    indent = await db.get(Indent, doc.indent_id)
    # Same message in all three cases: telling a stranger that a shipment exists but is
    # not theirs is still telling them it exists.
    if indent is None or indent.requested_by_id != getattr(user, "id", None):
        raise NotFoundError("That consignment is not open to you")
    return doc


async def acknowledge_as_raiser(db: AsyncSession, tr_id: int, data,
                                user) -> TransportRequest:
    """The indent's raiser signs for what reached them (doc A6/E8).

    The same transition as `acknowledge_tr` and deliberately the same function beneath
    it — a signature is a signature, and a second copy of "the site accepted it" is how
    the two start disagreeing about SHORT and DAMAGED. What differs is only who is
    allowed to make it: this door is opened by having raised the indent, so the person
    the material was for can close their own loop without being granted the logistics
    desk's tracking and dispatch buttons alongside it.
    """
    await _own_indent_leg(db, tr_id, user)
    return await acknowledge_tr(db, tr_id, data, user)


async def provider_board(db: AsyncSession, params: PageParams,
                         status: str | None = None,
                         search: str | None = None,
                         user=None) -> dict:
    """Every shipment still waiting on "who is taking this", with its tender attached.

    The transport register answers "where is this consignment"; this answers the only
    question the provider desk has all day — how many of the partners I asked have
    answered, and what is the best price on the table. Those counts are computed here
    rather than left to the screen to derive from the quote rows, because a board that
    makes you open each request to count the replies is a board that awards late.

    Every mode, not just the tendered one. A courier booking has no quotes and reads
    0 of 0, which is exactly right: it was settled at dispatch and there is nothing to
    compare. Filtering it out would take rows off a board that has always shown them,
    to make a column tidier.
    """
    wanted = [s.strip().upper() for s in (status or "").split(",") if s.strip()]
    stmt = (select(TransportRequest)
            .where(TransportRequest.status.in_(
                wanted or list(PROVIDER_BOARD_STATUSES))))
    # FIXED — same rung as the register. The provider board carries the QUOTED PRICES,
    # so leaving it unscoped published every carrier's rates for every lane to anyone
    # holding transport.view.
    if user is not None:
        stmt = stmt.where(await _tr_scope(db, user))
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            TransportRequest.tr_no.ilike(like),
            TransportRequest.consignment_no.ilike(like),
            TransportRequest.indent_no.ilike(like),
            TransportRequest.to_location_name.ilike(like),
        ))
    page = await paginate(db, stmt.order_by(TransportRequest.id.desc()), params)

    for row in page["items"]:
        priced = [q for q in row.quotes if q.freight_amount is not None
                  and q.status != QuoteStatus.INVITED.value]
        row.invited_count = len(row.quotes)
        row.responded_count = len(priced)
        # The cheapest LANDED cost, not the cheapest headline freight: the register
        # has to agree with the comparison sheet it links to, and the sheet ranks on
        # what the company actually pays.
        best = min(priced, key=_landed_cost) if priced else None
        row.best_amount = float(_landed_cost(best)) if best else None
        row.best_carrier_name = best.carrier_name if best else None
        row.best_transit_days = best.transit_days if best else None
    return page


async def carrier_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    """Transport providers from `mst_vendors`.

    A carrier is a vendor of a transport type. Reusing the master is what lets a
    carrier sign in to the supplier portal and quote without a second identity, and it
    keeps their rate history in one place. Vendors with no type set are NOT offered —
    that would put every material supplier in the truck dropdown.
    """
    stmt = (select(Vendor)
            .where(Vendor.is_active.is_(True),
                   Vendor.is_blacklisted.is_(False),
                   func.upper(Vendor.vendor_type).in_(CARRIER_VENDOR_TYPES))
            .order_by(Vendor.name)
            .limit(LOOKUP_LIMIT))
    if search:
        stmt = stmt.where(Vendor.name.ilike(f"%{search.strip()}%"))
    rows = (await db.execute(stmt)).scalars().all()
    return [{"id": v.id, "code": v.code, "name": v.name} for v in rows]


async def open_exceptions(db: AsyncSession, params: PageParams, user=None) -> dict:
    """Damage, shortage and delay claims nobody has closed yet.

    FIXED 2026-08-20 — was unscoped. A claim names a shipment, a lane and a carrier, so
    an open claims board with no rung told every logistics login what had gone wrong on
    every other region's freight. `ShipmentEvent` carries no location of its own, so it
    is bounded through its shipment — the same rung `list_trs` applies.
    """
    stmt = (select(ShipmentEvent)
            .where(ShipmentEvent.is_exception.is_(True),
                   ShipmentEvent.resolved_at.is_(None))
            .order_by(ShipmentEvent.event_at.desc()))
    if user is not None:
        stmt = stmt.where(ShipmentEvent.tr_id.in_(
            select(TransportRequest.id).where(await _tr_scope(db, user))))
    return await paginate(db, stmt, params)


# --------------------------------------------------------------------------- #
#  The activity ledger
# --------------------------------------------------------------------------- #
# What happened, to which shipment, in the order it happened — the outward leg's
# answer to the indent module's Activity Ledger, and the screen that replaced the
# Shipment Tracking board and the Exceptions desk. Those two each drew ONE slice of
# the same trail (where is it now / what went wrong), so a desk chasing a consignment
# read half the story on one tab and half on another, and neither showed who awarded
# it, at what price, or when the carrier said yes.
#
# Read-only and derived: nothing is written for the ledger. It unions the four places
# a logistics event is ALREADY recorded —
#
#   the request header   raised, awarded, the carrier's yes or no, tracking shared
#   wf_actions           submitted, approved, rejected, returned (both doc types)
#   lgs_carrier_quotes   invited to quote, price came back
#   lgs_shipment_events  the custody scans and the claims
#
# — so the screen cannot show an event the documents do not carry, and no writer has
# to remember to log a second time.

#: The columns every branch of the union contributes, in this exact order. MySQL
#: matches UNION branches by position, so one branch out of order silently files a
#: carrier name under "location" instead of failing.
_ACTIVITY_FIELDS = (
    "event_id", "tr_id", "tr_no", "consignment_no", "indent_no", "mode",
    "event_type", "occurred_at", "actor_name", "carrier_name", "location_name",
    "detail", "amount", "is_exception", "from_name", "to_name",
)


def _act_value(value, sql_type):
    """A literal, a NULL of a known type, or an expression — whichever was passed."""
    if value is None:
        return cast(literal(None), sql_type)
    if isinstance(value, (str, int, float)):
        return literal(value)
    return value


def _activity_columns(visible, *, event_id, event_type, occurred_at, event_key,
                      source_rank, actor_name=None, carrier_name=None,
                      location_name=None, detail=None, amount=None,
                      is_exception=0):
    type_expr = _act_value(event_type, String)
    return (
        _act_value(event_id, String).label("event_id"),
        visible.c.tr_id,
        visible.c.tr_no,
        visible.c.consignment_no,
        visible.c.indent_no,
        visible.c.mode,
        type_expr.label("event_type"),
        occurred_at.label("occurred_at"),
        _act_value(actor_name, String).label("actor_name"),
        _act_value(carrier_name, String).label("carrier_name"),
        _act_value(location_name, String).label("location_name"),
        _act_value(detail, String).label("detail"),
        _act_value(amount, MONEY).label("amount"),
        _act_value(is_exception, Integer).label("is_exception"),
        visible.c.from_name,
        visible.c.to_name,
        # Ordering only, never returned: two events stamped in the same second — an
        # award and the approval it starts — must still read in the order they
        # happened rather than in whatever order the rows come back.
        _act_value(source_rank, Integer).label("_rank"),
        _act_value(event_key, BigInteger).label("_key"),
    )


def activity_catalogue() -> list[dict]:
    """The ledger's filter options, in the order the events happen. The vocabulary
    lives in `enums.py`; the router reaches it through the service like everything
    else (rule 2), rather than importing the module's enums itself."""
    return _activity_catalogue()


async def activity_ledger(db: AsyncSession, params: PageParams, *,
                          search: str | None = None,
                          date_from: date | None = None,
                          date_to: date | None = None,
                          event_type: str | None = None,
                          only_exceptions: bool = False,
                          tr_id: int | None = None,
                          dispatch_id: int | None = None,
                          user=None) -> dict:
    """Every logistics event, newest first. Read-only; writes nothing."""
    visible_stmt = select(
        TransportRequest.id.label("tr_id"),
        TransportRequest.tr_no,
        TransportRequest.consignment_no,
        TransportRequest.indent_no,
        TransportRequest.mode,
        TransportRequest.from_warehouse_name.label("from_name"),
        TransportRequest.to_location_name.label("to_name"),
        TransportRequest.carrier_name.label("doc_carrier_name"),
        TransportRequest.created_at,
        TransportRequest.requested_by_name,
        TransportRequest.awarded_at,
        TransportRequest.awarded_by_name,
        TransportRequest.freight_amount,
        TransportRequest.carrier_accepted_at,
        TransportRequest.carrier_confirmed_by_name,
        TransportRequest.carrier_declined_at,
        TransportRequest.carrier_decline_reason,
        TransportRequest.tracking_shared_at,
    )
    # Narrowed HERE rather than after the union: every branch fans one shipment out
    # into many rows, so filtering the source keeps nine joins off the shipments the
    # caller never asked about.
    if tr_id is not None:
        visible_stmt = visible_stmt.where(TransportRequest.id == tr_id)
    if dispatch_id is not None:
        visible_stmt = visible_stmt.where(TransportRequest.dispatch_id == dispatch_id)
    # FIXED 2026-08-20 — the ledger read every shipment in the company. It unions four
    # sources, and every one of them hangs off this statement, so bounding it here
    # bounds the whole ledger. WITHOUT this the retired Tracking and Exceptions boards
    # were replaced by a screen that showed strictly MORE than they did — who awarded
    # a job, at what freight, to which carrier — to anyone holding transport.view.
    if user is not None:
        visible_stmt = visible_stmt.where(await _tr_scope(db, user))
    visible = visible_stmt.cte("visible_shipments")

    key = func.concat(literal("tr:"), cast(visible.c.tr_id, String))

    raised = select(*_activity_columns(
        visible,
        event_id=func.concat(key, literal(":raised")),
        event_type=LogisticsActivityType.RAISED.value,
        occurred_at=visible.c.created_at,
        actor_name=visible.c.requested_by_name,
        event_key=visible.c.tr_id, source_rank=10,
    )).select_from(visible)

    # Both ladders on one branch. TRANSPORT_REQUEST sanctions the movement,
    # CARRIER_AWARD sanctions the spend, and telling them apart is the difference
    # between "approved" and "the freight was approved".
    is_award = Instance.doc_type == DocType.CARRIER_AWARD.value
    wf_type = case(
        (and_(is_award, Action.action == ApprovalAction.APPROVED.value),
         literal(LogisticsActivityType.AWARD_APPROVED.value)),
        (and_(is_award, Action.action == ApprovalAction.REJECTED.value),
         literal(LogisticsActivityType.AWARD_REJECTED.value)),
        (Action.action == ApprovalAction.SUBMITTED.value,
         literal(LogisticsActivityType.SUBMITTED.value)),
        (Action.action == ApprovalAction.APPROVED.value,
         literal(LogisticsActivityType.APPROVED.value)),
        (Action.action == ApprovalAction.REJECTED.value,
         literal(LogisticsActivityType.REJECTED.value)),
        (Action.action == ApprovalAction.RETURNED.value,
         literal(LogisticsActivityType.RETURNED.value)),
        (Action.action == ApprovalAction.FALLBACK.value,
         literal(LogisticsActivityType.ROUTED_AUTOMATICALLY.value)),
        else_=Action.action,
    )
    workflow = select(*_activity_columns(
        visible,
        event_id=func.concat(literal("wf:"), cast(Action.id, String)),
        event_type=wf_type,
        occurred_at=Action.acted_at,
        actor_name=Action.actor_name,
        detail=func.nullif(func.trim(func.concat(
            func.coalesce(Action.actor_position, literal("")),
            literal(" "),
            func.coalesce(Action.comments, literal("")),
        )), literal("")),
        event_key=Action.id, source_rank=20,
    )).select_from(visible).join(
        Instance, and_(Instance.doc_id == visible.c.tr_id,
                       Instance.doc_type.in_((DocType.TRANSPORT_REQUEST.value,
                                              DocType.CARRIER_AWARD.value))),
    ).join(Action, Action.instance_id == Instance.id).where(
        # The award ladder's own SUBMITTED row IS the award press, which the header
        # branch below already reports with the carrier and the price on it.
        ~and_(is_award, Action.action == ApprovalAction.SUBMITTED.value),
    )

    invited = select(*_activity_columns(
        visible,
        event_id=func.concat(literal("inv:"), cast(CarrierQuote.id, String)),
        event_type=LogisticsActivityType.CARRIER_INVITED.value,
        occurred_at=CarrierQuote.invited_at,
        carrier_name=CarrierQuote.carrier_name,
        event_key=CarrierQuote.id, source_rank=30,
    )).select_from(visible).join(
        CarrierQuote, CarrierQuote.tr_id == visible.c.tr_id,
    ).where(CarrierQuote.invited_at.is_not(None))

    quoted = select(*_activity_columns(
        visible,
        event_id=func.concat(literal("quo:"), cast(CarrierQuote.id, String)),
        event_type=LogisticsActivityType.QUOTE_RECEIVED.value,
        occurred_at=CarrierQuote.submitted_at,
        carrier_name=CarrierQuote.carrier_name,
        amount=(func.coalesce(CarrierQuote.freight_amount, 0)
                + func.coalesce(CarrierQuote.other_charges, 0)),
        detail=CarrierQuote.remarks,
        event_key=CarrierQuote.id, source_rank=40,
    )).select_from(visible).join(
        CarrierQuote, CarrierQuote.tr_id == visible.c.tr_id,
    ).where(CarrierQuote.submitted_at.is_not(None))

    awarded = select(*_activity_columns(
        visible,
        event_id=func.concat(key, literal(":awarded")),
        event_type=LogisticsActivityType.AWARDED.value,
        occurred_at=visible.c.awarded_at,
        actor_name=visible.c.awarded_by_name,
        carrier_name=visible.c.doc_carrier_name,
        amount=visible.c.freight_amount,
        event_key=visible.c.tr_id, source_rank=50,
    )).select_from(visible).where(visible.c.awarded_at.is_not(None))

    # The carrier's own answer. `carrier_confirmed_by_name` is set only where the desk
    # recorded it on their behalf, and the ledger says which it was — an acceptance
    # nobody in the portal ever made must not read as one.
    accepted = select(*_activity_columns(
        visible,
        event_id=func.concat(key, literal(":accepted")),
        event_type=LogisticsActivityType.CARRIER_ACCEPTED.value,
        occurred_at=visible.c.carrier_accepted_at,
        actor_name=func.coalesce(visible.c.carrier_confirmed_by_name,
                                 visible.c.doc_carrier_name),
        carrier_name=visible.c.doc_carrier_name,
        detail=case((visible.c.carrier_confirmed_by_name.is_not(None),
                     literal("Confirmed by the desk")),
                    else_=cast(literal(None), String)),
        event_key=visible.c.tr_id, source_rank=60,
    )).select_from(visible).where(visible.c.carrier_accepted_at.is_not(None))

    declined = select(*_activity_columns(
        visible,
        event_id=func.concat(key, literal(":declined")),
        event_type=LogisticsActivityType.CARRIER_DECLINED.value,
        occurred_at=visible.c.carrier_declined_at,
        actor_name=visible.c.doc_carrier_name,
        carrier_name=visible.c.doc_carrier_name,
        detail=visible.c.carrier_decline_reason,
        event_key=visible.c.tr_id, source_rank=70,
    )).select_from(visible).where(visible.c.carrier_declined_at.is_not(None))

    shared = select(*_activity_columns(
        visible,
        event_id=func.concat(key, literal(":shared")),
        event_type=LogisticsActivityType.TRACKING_SHARED.value,
        occurred_at=visible.c.tracking_shared_at,
        carrier_name=visible.c.doc_carrier_name,
        event_key=visible.c.tr_id, source_rank=80,
    )).select_from(visible).where(visible.c.tracking_shared_at.is_not(None))

    # The scans and the claims, their types carried through unchanged — which is why
    # `LogisticsActivityType` repeats `ShipmentEventType`'s eight values.
    scans = select(*_activity_columns(
        visible,
        event_id=func.concat(literal("evt:"), cast(ShipmentEvent.id, String)),
        event_type=ShipmentEvent.event_type,
        occurred_at=ShipmentEvent.event_at,
        actor_name=ShipmentEvent.recorded_by_name,
        carrier_name=visible.c.doc_carrier_name,
        location_name=ShipmentEvent.location_name,
        detail=func.coalesce(ShipmentEvent.description,
                             ShipmentEvent.affected_item_name),
        amount=ShipmentEvent.claim_amount,
        is_exception=cast(ShipmentEvent.is_exception, Integer),
        event_key=ShipmentEvent.id, source_rank=90,
    )).select_from(visible).join(
        ShipmentEvent, ShipmentEvent.tr_id == visible.c.tr_id)

    # Closing a claim is an event in its own right: "who settled it, and how" is the
    # question the Exceptions desk existed to answer.
    settled = select(*_activity_columns(
        visible,
        event_id=func.concat(literal("res:"), cast(ShipmentEvent.id, String)),
        event_type=LogisticsActivityType.CLAIM_SETTLED.value,
        occurred_at=ShipmentEvent.resolved_at,
        actor_name=ShipmentEvent.resolved_by_name,
        carrier_name=visible.c.doc_carrier_name,
        detail=ShipmentEvent.resolution,
        amount=ShipmentEvent.claim_amount,
        event_key=ShipmentEvent.id, source_rank=100,
    )).select_from(visible).join(
        ShipmentEvent, ShipmentEvent.tr_id == visible.c.tr_id,
    ).where(ShipmentEvent.resolved_at.is_not(None))

    events = union_all(raised, workflow, invited, quoted, awarded, accepted,
                       declined, shared, scans, settled).subquery("activity_events")
    filtered = select(events)

    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        # "delivered" and "carrier declined" are what a person types, and neither is
        # stored anywhere — the label is derived. So the term is resolved against the
        # vocabulary first and matched as a TYPE, which also keeps the union's SQL to
        # the columns that really exist rather than inlining the label table ten times.
        named = [kind for kind, meta in ACTIVITY_META.items()
                 if term.lower() in meta[0].lower()]
        filtered = filtered.where(or_(
            events.c.event_type.in_(named or ["__none__"]),
            events.c.tr_no.ilike(like),
            events.c.consignment_no.ilike(like),
            events.c.indent_no.ilike(like),
            events.c.actor_name.ilike(like),
            events.c.carrier_name.ilike(like),
            events.c.location_name.ilike(like),
            events.c.detail.ilike(like),
            events.c.to_name.ilike(like),
        ))
    if date_from:
        filtered = filtered.where(
            events.c.occurred_at >= datetime.combine(date_from, time.min))
    if date_to:
        # < the day AFTER, so an event stamped at 16:40 on the closing date is in.
        filtered = filtered.where(
            events.c.occurred_at
            < datetime.combine(date_to + timedelta(days=1), time.min))
    if event_type:
        filtered = filtered.where(events.c.event_type == event_type)
    if only_exceptions:
        # The Exceptions desk's own list, as a filter on the register rather than as a
        # second screen: the claim rows carry the flag the desk indexed on.
        filtered = filtered.where(events.c.is_exception == 1)

    rows = filtered.subquery("filtered_activity")
    stmt = (select(*(rows.c[field] for field in _ACTIVITY_FIELDS))
            .order_by(rows.c.occurred_at.desc(), rows.c._rank.desc(),
                      rows.c.tr_id.desc(), rows.c._key.desc()))
    total = await db.scalar(select(func.count()).select_from(rows))
    page = (await db.execute(
        stmt.offset(params.offset).limit(params.size))).mappings().all()
    # The wording is applied to the twenty rows on the page, not to every row in the
    # union: `ACTIVITY_META` is a lookup, and a lookup inlined into ten UNION branches
    # is a 30KB query to answer a 20-row question.
    items = []
    for row in page:
        item = dict(row)
        item["event_label"] = activity_label(item["event_type"])
        item["result"] = activity_result(item["event_type"])
        items.append(item)
    return {"items": items, "total": total or 0,
            "page": params.page, "size": params.size}


# --------------------------------------------------------------------------- #
#  Write helpers
# --------------------------------------------------------------------------- #

def _guard_editable(doc: TransportRequest) -> None:
    if doc.status in TERMINAL_STATUSES:
        raise ValidationError(
            f"{doc.tr_no} is {doc.status.lower()} and can no longer be changed")
    if doc.status != TransportStatus.DRAFT.value:
        raise ValidationError(
            f"{doc.tr_no} has already been submitted. Only a draft can be edited.")


def _volume_cbm(line) -> Decimal:
    """cm³ -> m³. A line with no dimensions contributes nothing rather than zeroing
    the total, which is why this returns 0 instead of raising."""
    dims = (line.length_cm, line.width_cm, line.height_cm)
    if not all(dims):
        return ZERO
    count = max(int(line.package_count or 0), 1)
    cubic_cm = _d(line.length_cm) * _d(line.width_cm) * _d(line.height_cm)
    return (cubic_cm * count) / Decimal("1000000")


def _recompute_totals(doc: TransportRequest) -> None:
    """Header totals are always derived. Nothing may set them directly — a carrier
    prices off these, and a total that disagrees with its lines is a dispute."""
    doc.total_items = len(doc.items)
    doc.total_qty = sum((_d(l.quantity) for l in doc.items), ZERO)
    doc.total_packages = sum(int(l.package_count or 0) for l in doc.items)
    doc.total_weight_kg = sum((_d(l.weight_kg) for l in doc.items), ZERO)
    doc.total_volume_cbm = sum((_volume_cbm(l) for l in doc.items), ZERO)


def _apply_lines(doc: TransportRequest, lines) -> None:
    doc.items.clear()
    for index, line in enumerate(lines or [], start=1):
        doc.items.append(TransportRequestItem(
            line_no=index,
            item_id=line.item_id, item_code=line.item_code,
            item_name=line.item_name, uom_code=line.uom_code,
            quantity=_d(line.quantity),
            package_count=line.package_count or 0,
            package_type=line.package_type,
            weight_kg=_d(line.weight_kg) if line.weight_kg is not None else None,
            length_cm=line.length_cm, width_cm=line.width_cm,
            height_cm=line.height_cm, is_fragile=line.is_fragile,
            remarks=line.remarks,
        ))
    _recompute_totals(doc)


_FIELD_LABELS = {
    "carrier_id": "a carrier",
    "vehicle_number": "the vehicle number",
    "driver_name": "the driver's name",
    "handed_over_by_name": "who handed the material over",
}


def _check_mode_fields(doc: TransportRequest, *, at_submit: bool = False) -> None:
    """Whatever the mode says it must carry, checked in one place.

    Runs at submit rather than at create: a draft is allowed to be incomplete, which
    is the whole point of a draft. What must never happen is an approved request that
    nobody can act on because it names no carrier and no vehicle.

    One field is exempt at submit, and only for a tendered mode: the carrier. A
    third-party shipment's carrier is AWARDED, not declared — it is the answer the
    tender exists to produce — so demanding it up front made a third-party request
    impossible to submit at all, while the form beside it correctly said to leave the
    carrier blank. By dispatch it is set, because an award is what sets it.
    """
    rule = mode_rule(doc.mode)
    required = rule.required_fields
    if at_submit and rule.needs_quotes:
        required = tuple(field for field in required if field != "carrier_id")
    missing = [_FIELD_LABELS.get(field, field)
               for field in required
               if not getattr(doc, field, None)]
    if missing:
        raise ValidationError(
            f"A {rule.label.lower()} request needs {', '.join(missing)}.")


async def _carrier(db: AsyncSession, carrier_id: int) -> Vendor:
    vendor = await db.get(Vendor, carrier_id)
    if vendor is None or not vendor.is_active:
        raise NotFoundError(f"Carrier {carrier_id} not found")
    if (vendor.vendor_type or "").upper() not in CARRIER_VENDOR_TYPES:
        raise ValidationError(
            f"{vendor.name} is not a transport provider. Set the vendor type to "
            "TRANSPORT on the vendor master first.")
    return vendor


def _context(doc: TransportRequest) -> dict:
    """What the approval engine is told about this document. Same shape both times so
    a ladder condition reads the same field whichever workflow it sits in."""
    return {
        "doc_no": doc.tr_no,
        "doc_summary": (f"Transport request {doc.tr_no} — {doc.mode.title()} to "
                        f"{doc.to_location_name or 'the field'}"),
        "project_id": doc.project_id or None,
        "requester_position_id": doc.requested_position_id,
        "mode": doc.mode,
        "carrier_id": doc.carrier_id,
        "freight_amount": float(doc.freight_amount or 0),
        "total_weight_kg": float(doc.total_weight_kg or 0),
        "from_warehouse_id": doc.from_warehouse_id,
        "indent_id": doc.indent_id,
    }


# --------------------------------------------------------------------------- #
#  Create / edit / delete
# --------------------------------------------------------------------------- #

async def create_tr(db: AsyncSession, data, user) -> TransportRequest:
    if (data.mode or "").upper() not in MODE_RULES:
        raise ValidationError(
            f"{data.mode!r} is not a transport mode. "
            f"Choose one of: {', '.join(MODE_RULES)}.")
    # A return leg (doc E7) runs the other way, and the thing it must name is where it
    # is going BACK to. An outward leg can be raised without one — the consignment
    # carries the address — but nothing carries a return's destination for it.
    if is_inbound(data.source_type) and not (data.to_location_name or "").strip():
        raise ValidationError("Name the warehouse this return is coming back to")

    doc = TransportRequest(
        tr_no=await next_number(db, DocType.TRANSPORT_REQUEST.value.lower()),
        tr_date=data.tr_date or date.today(),
        mode=data.mode.upper(),
        # WHAT it travels on, checked against the arrangement made under it. The
        # Dispatch screen has always asked; until now the answer went nowhere.
        carriage_mode=_resolve_carriage(
            data.mode, getattr(data, "carriage_mode", None)),
        status=TransportStatus.DRAFT.value,
        source_type=data.source_type, source_id=data.source_id,
        source_no=data.source_no,
        issue_id=data.issue_id, dispatch_id=data.dispatch_id,
        consignment_no=data.consignment_no,
        indent_id=data.indent_id, indent_no=data.indent_no,
        from_warehouse_id=data.from_warehouse_id,
        from_warehouse_name=data.from_warehouse_name,
        to_location_name=data.to_location_name,
        delivery_address=data.delivery_address,
        contact_person=data.contact_person, contact_phone=data.contact_phone,
        distance_km=data.distance_km,
        project_id=data.project_id, project_name=data.project_name,
        expected_delivery=data.expected_delivery, remarks=data.remarks,
        gate_pass_no=data.gate_pass_no,
        # The tracking handles, when the desk already holds them. A courier docket is
        # written on the booking slip at the counter, so asking for it again on a
        # second screen is how it ends up typed nowhere. `dispatch_tr` overwrites
        # whatever is here if a different number comes back with the goods.
        lr_no=getattr(data, "lr_no", None),
        docket_no=getattr(data, "docket_no", None),
        tracking_url=getattr(data, "tracking_url", None),
        eway_bill_no=getattr(data, "eway_bill_no", None),
        carrier_reference=getattr(data, "carrier_reference", None),
        vehicle_number=data.vehicle_number, driver_name=data.driver_name,
        driver_phone=data.driver_phone, trip_reference=data.trip_reference,
        # Who came for the load, and which number names them. `TRCreate` has asked
        # for these since the custody columns landed and `create_tr` dropped every
        # one of them on the floor, so a gate pass printed from a request raised
        # through the register carried no driver licence and no custody identity —
        # the only place the fields survived was the one-press dispatch path.
        driver_licence_no=getattr(data, "driver_licence_no", None),
        handed_over_by_name=data.handed_over_by_name,
        handed_over_employee_id=getattr(data, "handed_over_employee_id", None),
        handed_over_aadhaar=getattr(data, "handed_over_aadhaar", None),
        handed_over_phone=getattr(data, "handed_over_phone", None),
        # Legacy read column only: logistics cannot name the receiver at dispatch.
        # The indent requester's receipt stamps the actual receiver later.
        received_by_name=None,
        requested_by_id=getattr(user, "id", None),
        requested_by_name=getattr(user, "full_name", None),
        requested_position_id=getattr(user, "active_position_id", None),
    )
    if data.carrier_id:
        vendor = await _carrier(db, data.carrier_id)
        doc.carrier_id, doc.carrier_name = vendor.id, vendor.name
    _apply_lines(doc, data.lines)

    db.add(doc)
    await db.flush()
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"mode": doc.mode, "carriage_mode": doc.carriage_mode,
                             "status": doc.status},
                      summary=f"Raised transport request {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
#  Dispatching a consignment — the whole thing, in one press
# --------------------------------------------------------------------------- #

def _chosen_carriers(data) -> list[int]:
    """The providers named on a dispatch, plural first and de-duplicated.

    `carrier_ids` is the real field and `carrier_id` the singular case of it, so both
    are read and merged: the Dispatch screen sends the list, and anything older (or a
    non-tendered booking, which only ever names one) sends the single id. Order is
    kept — the desk's first pick reads first on the comparison sheet — and a provider
    named twice is invited once, because two invitations to the same carrier is one
    row in `lgs_carrier_quotes` and a unique index that would have refused the second.
    """
    named = [*(getattr(data, "carrier_ids", None) or []),
             *([data.carrier_id] if data.carrier_id else [])]
    return list(dict.fromkeys(cid for cid in named if cid))


async def dispatch_consignment(db: AsyncSession, data, user) -> TransportRequest:
    """"This consignment is going out, this way, with them." One call.

    The Dispatch screen asks two questions and nothing else: how does it travel, and
    with whom. Everything a transport request needs is already on the consignment the
    warehouse packed, so raising it, filling it in and sending it to the provider is
    one action rather than a form, a save, a submit and three follow-ups.

    Where it lands depends only on the mode:

      * THIRD_PARTY — EVERY provider chosen is invited and the request sits in QUOTING.
        It appears in each of THEIR portals, they price it independently, and it comes
        back to the RFQ desk as a comparison. That round trip is the whole reason this
        mode exists, and it is only a tender if more than one carrier was asked: one
        price is a rate, not a competition.
      * everything else — the provider is known the moment it is chosen (a courier, a
        company vehicle, a person carrying it), so it goes straight to READY and the
        next press is "it has left".

    No second approval BY DEFAULT. The consignment it carries was already raised,
    approved and released by the warehouse; approving the same movement again is a
    queue nobody works and a document that sits still while a packed pallet waits on
    the floor. Approving the SPEND is separate and still happens — that is the award.

    "By default" and not "never", because the ladder is what decides (rule 8). No
    TRANSPORT_REQUEST ladder configured — every project today — and this lands exactly
    where it always did. Configure one on Approvals Config and it is honoured here too,
    rather than saving a row that quietly governs `submit_tr` and nothing else.
    """
    mode = (data.mode or "").upper()
    if mode not in MODE_RULES:
        raise ValidationError(
            f"{data.mode!r} is not a transport mode. "
            f"Choose one of: {', '.join(MODE_RULES)}.")
    rule = mode_rule(mode)
    chosen = _chosen_carriers(data)
    if rule.needs_carrier and not chosen:
        raise ValidationError(
            "Choose the logistics provider(s) this consignment goes with")
    # A booking is made with ONE provider. Only a tender asks several, so naming more
    # than one on a courier booking is a mistake worth stopping rather than silently
    # resolving to whichever happened to be first in the list.
    if not rule.needs_quotes and len(chosen) > 1:
        raise ValidationError(
            f"A {rule.label.lower()} booking goes with one provider. "
            "Choose third-party to send the same job to several and compare.")

    method = getattr(data, "evaluation_method", None)
    if method and not evaluation.is_valid(method):
        raise ValidationError(f"{method!r} is not an evaluation method")

    # `create_tr` reads the singular field, so the desk's first pick is what a
    # non-tendered booking is created against; a tender clears it again below.
    data.carrier_id = chosen[0] if chosen else None
    doc = await create_tr(db, data, user)
    doc.mode = mode

    if rule.needs_quotes:
        doc.carrier_id = doc.carrier_name = None   # not theirs until it is awarded
        doc.evaluation_method = (method or "").upper() or None
        invited = []
        for carrier_id in chosen:
            vendor = await _carrier(db, carrier_id)
            doc.quotes.append(CarrierQuote(
                carrier_id=vendor.id, carrier_name=vendor.name,
                status=QuoteStatus.INVITED.value, invited_at=utcnow(),
            ))
            invited.append(vendor.name)
        settled_summary = f"Sent {doc.tr_no} to {_and_list(invited)} for a price"
    else:
        if doc.carrier_id is None and chosen:
            vendor = await _carrier(db, chosen[0])
            doc.carrier_id, doc.carrier_name = vendor.id, vendor.name
        if mode == TransportMode.OWN_VEHICLE.value:
            # A vehicle already going that way costs the shipment nothing.
            doc.freight_amount = ZERO
        elif data.freight_amount is not None:
            doc.freight_amount = _d(data.freight_amount)
        _check_mode_fields(doc)
        settled_summary = (
            f"Sent {doc.tr_no} to {doc.carrier_name} for acknowledgement"
            if mode == TransportMode.COURIER.value
            else (f"{doc.tr_no} ready to leave with "
                  f"{doc.carrier_name or doc.vehicle_number or 'the warehouse'}")
        )

    # Rule 8: whether this needs a signature is the LADDER's answer, not this
    # function's — but only when somebody actually configured one.
    #
    # `find_ladder` returning None means nobody has, which is every project today, and
    # there the one-press dispatch stays exactly what it was: no approval, straight to
    # QUOTING or READY. Calling the engine unconditionally would NOT have been the same
    # thing — with nothing configured it falls back to climbing the raiser's reporting
    # line, so every dispatch would have started landing in a stranger's queue and a
    # packed pallet would sit on the floor waiting for a signature nobody asked for.
    #
    # A configured ladder is the other case, and it is the reason this asks at all:
    # Approvals Config OFFERS a TRANSPORT_REQUEST row, so an admin can switch one on and
    # watch it save. Skipping the engine outright would let that row govern `submit_tr`
    # and be silently ignored by the screen that raises nearly every transport request.
    doc.requested_position_id = (doc.requested_position_id
                                 or getattr(user, "active_position_id", None))
    raiser_role_id = await ladder.role_of_position(db, doc.requested_position_id)
    configured = await ladder.find_ladder(
        db, doc.project_id or None, DocType.TRANSPORT_REQUEST.value, raiser_role_id)

    if configured is None:
        _advance_after_approval(doc)
        summary = settled_summary
        # "Confirm dispatch" on a settled mode is the load LEAVING, not a booking to
        # release on a second screen: the gate pass, the docket and the driver are all
        # on the form that was just pressed. `release_now` says so, and only a mode
        # that needs no tender can be released here — a THIRD_PARTY job has no carrier
        # yet, and READY is the earliest it can be one.
        if getattr(data, "release_now", False) and doc.status == TransportStatus.READY.value:
            await _release(db, doc, data, user)
            summary = (f"{doc.tr_no} left with "
                       f"{doc.carrier_name or doc.vehicle_number or 'the warehouse'}")
    else:
        instance = await engine.start(
            db, DocType.TRANSPORT_REQUEST.value, doc.id, _context(doc), user)
        # A ladder can resolve to nobody (every rung switched off, or NO_APPROVAL).
        # Reading the instance rather than assuming it is pending is what stops the
        # request standing still with no one holding it — same rule as `submit_tr`.
        if instance.status == InstanceStatus.APPROVED.value:
            _advance_after_approval(doc)
            summary = settled_summary
        else:
            doc.status = TransportStatus.PENDING_APPROVAL.value
            summary = (f"Raised {doc.tr_no} for {rule.label.lower()} "
                       f"and sent it for approval")

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"mode": doc.mode, "status": doc.status},
                      summary=summary)
    await db.commit()
    await db.refresh(doc)
    return doc


async def accept_quote(db: AsyncSession, tr_id: int, quote_id: int | None,
                       user) -> TransportRequest:
    """"That price is fine." Accepts the provider's quote and offers them the job.

    Shorter than `award_carrier`, which is the competitive tender: here the desk asked
    ONE provider what it would cost and they answered, so there is nobody to compare
    them against and no second approval to run. `quote_id` may be omitted when only
    one price is on the table, which on this path is the normal case.

    What it does NOT skip is the carrier's own yes. An accepted price is still an
    OFFER (the same rule the tender path enforces): the provider quoted a lane before
    they knew the date was theirs, and until they confirm they have a vehicle for it
    nothing can be loaded against the shipment. So this lands on AWAITING_CARRIER and
    the provider's portal — or the desk on their behalf, via `/carrier-confirm` —
    makes it READY. Booking it here instead put consignments on the floor against
    carriers who had never agreed to come.
    """
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.QUOTING.value:
        raise ValidationError(f"{doc.tr_no} is not waiting on a price")

    priced = [q for q in doc.quotes if q.status == QuoteStatus.SUBMITTED.value]
    quote = (next((q for q in doc.quotes if q.id == quote_id), None)
             if quote_id else (priced[0] if len(priced) == 1 else None))
    if quote is None:
        raise ValidationError(
            "Say which quote is being accepted" if priced
            else "No provider has sent a price yet")
    if quote.status != QuoteStatus.SUBMITTED.value:
        raise ValidationError(f"{quote.carrier_name} has not sent a price")

    for other in doc.quotes:
        if other.id != quote.id and other.status == QuoteStatus.SUBMITTED.value:
            other.status = QuoteStatus.NOT_AWARDED.value
    quote.status = QuoteStatus.AWARDED.value

    doc.carrier_id, doc.carrier_name = quote.carrier_id, quote.carrier_name
    doc.freight_amount = _landed_cost(quote)
    doc.awarded_quote_id = quote.id
    doc.awarded_by_id = getattr(user, "id", None)
    doc.awarded_by_name = getattr(user, "full_name", None)
    doc.awarded_at = utcnow()
    # Cleared, not stamped: the acceptance we are waiting for is THEIRS. A re-quote
    # that comes back round must not inherit a confirmation from the first attempt.
    doc.carrier_accepted_at = None
    doc.carrier_declined_at = None
    doc.carrier_decline_reason = None
    doc.status = TransportStatus.AWAITING_CARRIER.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"carrier": doc.carrier_name,
                             "freight": float(doc.freight_amount or 0),
                             "status": doc.status},
                      summary=(f"Accepted {quote.carrier_name} at "
                               f"{doc.freight_amount} for {doc.tr_no} — "
                               f"waiting for them to confirm"))
    await db.commit()
    await db.refresh(doc)
    return doc


async def ask_revised_quote(db: AsyncSession, tr_id: int, note: str,
                            user) -> TransportRequest:
    """"Too dear — price it again." Hands the job back to the provider.

    The quote goes back to INVITED rather than being deleted, so the request reappears
    on the provider's board as something to price, and the note tells them why. What
    they quoted last time is overwritten when they answer, which is the whole point:
    a negotiation is one price at a time, not a thread.
    """
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.QUOTING.value:
        raise ValidationError(f"{doc.tr_no} is not out for a price")
    waiting = [q for q in doc.quotes if q.status == QuoteStatus.SUBMITTED.value]
    if not waiting:
        raise ValidationError("There is no price to send back")
    if not (note or "").strip():
        raise ValidationError("Tell the provider what to change")

    for quote in waiting:
        quote.status = QuoteStatus.INVITED.value
        quote.remarks = note.strip()
        quote.submitted_at = None

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"Asked for a revised price on {doc.tr_no}: {note.strip()}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def update_tr(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    doc = await get_tr(db, tr_id)
    # This is still preparation until the final Dispatch action moves it to
    # IN_TRANSIT. Prices, acknowledgement and READY therefore do not lock the form.
    editable = {
        TransportStatus.DRAFT.value,
        TransportStatus.PENDING_APPROVAL.value,
        TransportStatus.QUOTING.value,
        TransportStatus.AWAITING_CARRIER.value,
        TransportStatus.READY.value,
    }
    if doc.status not in editable:
        raise ValidationError(
            f"{doc.tr_no} can no longer be changed after final dispatch.")
    before = {"mode": doc.mode, "carriage_mode": doc.carriage_mode,
              "carrier_id": doc.carrier_id}
    workflow_status = doc.status
    fields_set = getattr(data, "model_fields_set",
                         getattr(data, "__fields_set__", set()))
    mode_changed = False

    if data.mode:
        if data.mode.upper() not in MODE_RULES:
            raise ValidationError(f"{data.mode!r} is not a transport mode")
        # Changing the mode drops any quoting already done: a courier booking is not
        # a truck tender, and carrying the old quotes forward would let an award be
        # justified by prices collected for a different job.
        if doc.mode != data.mode.upper():
            mode_changed = True
            doc.quotes.clear()
            doc.carrier_id = doc.carrier_name = None
            doc.freight_amount = doc.awarded_quote_id = None
        doc.mode = data.mode.upper()

    # Re-checked whichever of the two moved: switching an air leg to a hand-over is
    # exactly as impossible as arranging a hand-over by air, and an edit that changes
    # only the mode would otherwise leave the pair contradicting itself.
    doc.carriage_mode = _resolve_carriage(
        doc.mode, getattr(data, "carriage_mode", None), current=doc.carriage_mode)

    for field in ("tr_date", "source_type", "source_id", "source_no", "issue_id",
                  "dispatch_id", "consignment_no",
                  "indent_id", "indent_no", "from_warehouse_id",
                  "from_warehouse_name", "to_location_name", "delivery_address",
                  "contact_person", "contact_phone", "distance_km", "project_id",
                  "project_name", "expected_delivery", "remarks", "vehicle_number",
                  "driver_name", "driver_phone",
                  "driver_licence_no", "trip_reference",
                  "handed_over_by_name", "handed_over_employee_id",
                  "handed_over_aadhaar", "handed_over_phone", "gate_pass_no",
                  "lr_no", "docket_no", "tracking_url", "eway_bill_no",
                  "carrier_reference"):
        if field in fields_set:
            setattr(doc, field, getattr(data, field, None))

    selection_supplied = bool({"carrier_id", "carrier_ids"} & fields_set)
    if selection_supplied or mode_changed:
        chosen = _chosen_carriers(data)
        rule = mode_rule(doc.mode)
        if rule.needs_carrier and not chosen:
            raise ValidationError(
                "Choose the logistics provider(s) this consignment goes with")
        if not rule.needs_quotes and len(chosen) > 1:
            raise ValidationError(
                f"A {rule.label.lower()} booking goes with one provider.")

        if rule.needs_quotes:
            current = [quote.carrier_id for quote in doc.quotes]
            if mode_changed or current != chosen:
                doc.awarded_quote_id = None
                doc.carrier_id = doc.carrier_name = None
                doc.freight_amount = None
                doc.quotes.clear()
                await db.flush()
                for carrier_id in chosen:
                    vendor = await _carrier(db, carrier_id)
                    doc.quotes.append(CarrierQuote(
                        carrier_id=vendor.id, carrier_name=vendor.name,
                        status=QuoteStatus.INVITED.value, invited_at=utcnow(),
                    ))
                if workflow_status not in {
                        TransportStatus.DRAFT.value,
                        TransportStatus.PENDING_APPROVAL.value}:
                    doc.status = TransportStatus.QUOTING.value
            method = getattr(data, "evaluation_method", None)
            if method:
                if not evaluation.is_valid(method):
                    raise ValidationError(
                        f"{method!r} is not an evaluation method")
                doc.evaluation_method = method.upper()
        elif rule.needs_carrier:
            if mode_changed or doc.carrier_id != chosen[0]:
                vendor = await _carrier(db, chosen[0])
                doc.quotes.clear()
                doc.awarded_quote_id = None
                doc.carrier_id, doc.carrier_name = vendor.id, vendor.name
                doc.freight_amount = None
                if workflow_status not in {
                        TransportStatus.DRAFT.value,
                        TransportStatus.PENDING_APPROVAL.value}:
                    doc.status = TransportStatus.AWAITING_CARRIER.value
        elif mode_changed:
            doc.quotes.clear()
            doc.awarded_quote_id = None
            doc.carrier_id = doc.carrier_name = None
            doc.freight_amount = (ZERO if doc.mode == TransportMode.OWN_VEHICLE.value
                                  else None)
            if workflow_status not in {
                    TransportStatus.DRAFT.value,
                    TransportStatus.PENDING_APPROVAL.value}:
                doc.status = TransportStatus.READY.value

    if "lines" in fields_set:
        _apply_lines(doc, data.lines)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"mode": doc.mode, "carriage_mode": doc.carriage_mode,
                             "carrier_id": doc.carrier_id})
    await db.commit()
    await db.refresh(doc)
    return doc


async def delete_tr(db: AsyncSession, tr_id: int, user) -> dict:
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.DRAFT.value:
        raise ValidationError(
            "Only a draft can be deleted. Cancel the request instead.")
    tr_no = doc.tr_no
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=tr_no,
                      action=AuditAction.DEACTIVATE, actor=user,
                      summary=f"Deleted draft transport request {tr_no}")
    await db.delete(doc)
    await db.commit()
    return {"success": True, "tr_no": tr_no}


# --------------------------------------------------------------------------- #
#  Approval — the movement
# --------------------------------------------------------------------------- #

async def submit_tr(db: AsyncSession, tr_id: int, user) -> TransportRequest:
    doc = await get_tr(db, tr_id)
    _guard_editable(doc)
    if not doc.items:
        raise ValidationError("Add at least one line before submitting")
    _check_mode_fields(doc, at_submit=True)

    doc.requested_position_id = (doc.requested_position_id
                                 or getattr(user, "active_position_id", None))
    instance = await engine.start(
        db, DocType.TRANSPORT_REQUEST.value, doc.id, _context(doc), user)

    doc.status = TransportStatus.PENDING_APPROVAL.value
    # A configuration with nothing to approve hands back an already-approved instance.
    # Reading it rather than assuming PENDING_APPROVAL is what stops the request
    # standing still with nobody holding it.
    if instance.status == InstanceStatus.APPROVED.value:
        _advance_after_approval(doc)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": TransportStatus.DRAFT.value},
                      after={"status": doc.status},
                      summary=f"Submitted {doc.tr_no} for approval")
    await db.commit()
    await db.refresh(doc)
    return doc


def _advance_after_approval(doc: TransportRequest) -> None:
    """Where an approved request goes next, which is entirely a question of mode.

    A quoted mode goes out to carriers. A courier booking already knows the provider,
    but still waits for that provider to acknowledge the job and supply the vehicle,
    driver and tracking details from their own login. The two modes operated by the
    warehouse are ready immediately because those details were entered by the desk.
    """
    if mode_rule(doc.mode).needs_quotes:
        doc.status = TransportStatus.QUOTING.value
    elif doc.mode == TransportMode.COURIER.value:
        doc.status = TransportStatus.AWAITING_CARRIER.value
    else:
        doc.status = TransportStatus.READY.value


async def act_on_tr(db: AsyncSession, tr_id: int, action: str, user,
                    comments: str = "") -> TransportRequest:
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"{doc.tr_no} is not waiting for approval")
    action = (action or "").upper()
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("A transport request can only be approved or rejected")
    if action == ApprovalAction.REJECTED.value and not (comments or "").strip():
        raise ValidationError("Tell the raiser why this was rejected")

    before = doc.status
    instance = await engine.act(db, DocType.TRANSPORT_REQUEST.value, doc.id,
                                action, user, comments, context=_context(doc))
    if instance.status == InstanceStatus.APPROVED.value:
        _advance_after_approval(doc)
    elif instance.status == InstanceStatus.REJECTED.value:
        doc.status = TransportStatus.REJECTED.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before}, after={"status": doc.status},
                      summary=f"{action.title()} {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def cancel_tr(db: AsyncSession, tr_id: int, user,
                    reason: str = "") -> TransportRequest:
    doc = await get_tr(db, tr_id)
    if doc.status in TERMINAL_STATUSES:
        raise ValidationError(f"{doc.tr_no} is already {doc.status.lower()}")
    if doc.status in (TransportStatus.IN_TRANSIT.value,
                      TransportStatus.DELIVERED.value,
                      TransportStatus.ACKNOWLEDGED.value):
        raise ValidationError(
            "This consignment has already left. Close it and raise a claim instead "
            "of cancelling.")
    before = doc.status
    # The engine has to be told, or the approver keeps seeing a task for a document
    # nobody can act on any more (rule 8, engine.abandon).
    if before == TransportStatus.PENDING_APPROVAL.value:
        await engine.abandon(db, DocType.TRANSPORT_REQUEST.value, doc.id, user, reason)
    doc.status = TransportStatus.CANCELLED.value
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before}, after={"status": doc.status},
                      summary=f"Cancelled {doc.tr_no}: {reason or 'no reason given'}")
    await db.commit()
    await db.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
#  Provider selection
# --------------------------------------------------------------------------- #

async def invite_carriers(db: AsyncSession, tr_id: int, data,
                          user) -> TransportRequest:
    """Ask a set of carriers to price the job.

    Only for a quoting mode. Idempotent per carrier: inviting the same one twice keeps
    the row (and any quote already on it) rather than resetting it to INVITED.
    """
    doc = await get_tr(db, tr_id)
    if not mode_rule(doc.mode).needs_quotes:
        raise ValidationError(
            f"A {mode_rule(doc.mode).label.lower()} request is not tendered. "
            "Set the provider directly instead.")
    if doc.status not in (TransportStatus.QUOTING.value, TransportStatus.READY.value):
        raise ValidationError(
            f"{doc.tr_no} must be approved before carriers can be invited")

    if data.evaluation_method:
        if not evaluation.is_valid(data.evaluation_method):
            raise ValidationError(
                f"{data.evaluation_method!r} is not an evaluation method")
        doc.evaluation_method = data.evaluation_method.upper()

    existing = {q.carrier_id for q in doc.quotes}
    for carrier_id in data.carrier_ids:
        if carrier_id in existing:
            continue
        vendor = await _carrier(db, carrier_id)
        doc.quotes.append(CarrierQuote(
            carrier_id=vendor.id, carrier_name=vendor.name,
            status=QuoteStatus.INVITED.value, invited_at=utcnow(),
        ))
    doc.status = TransportStatus.QUOTING.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"Invited {len(data.carrier_ids)} carrier(s) "
                              f"to quote {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def record_quote(db: AsyncSession, tr_id: int, carrier_id: int, data,
                       user=None) -> CarrierQuote:
    """A carrier's price, whether typed in by the desk or submitted by the carrier.

    One function for both so a portal submission and a phoned-in quote land in exactly
    the same shape — the comparison must not be able to tell them apart.
    """
    doc = await get_tr(db, tr_id)
    quote = next((q for q in doc.quotes if q.carrier_id == carrier_id), None)
    if quote is None:
        raise NotFoundError(f"{doc.tr_no} has no invitation for carrier {carrier_id}")
    if doc.status != TransportStatus.QUOTING.value:
        raise ValidationError(f"{doc.tr_no} is not open for quotations")
    if quote.status == QuoteStatus.AWARDED.value:
        raise ValidationError("This quote has already been awarded")

    quote.freight_amount = _d(data.freight_amount)
    quote.other_charges = _d(data.other_charges)
    quote.tax_percent = data.tax_percent
    quote.transit_days = data.transit_days
    quote.valid_until = data.valid_until
    quote.vehicle_type = data.vehicle_type
    quote.remarks = data.remarks
    quote.status = QuoteStatus.SUBMITTED.value
    quote.submitted_at = utcnow()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"{quote.carrier_name} quoted "
                              f"{quote.freight_amount} for {doc.tr_no}")
    await db.commit()
    await db.refresh(quote)
    return quote


def _landed_cost(quote: CarrierQuote) -> Decimal:
    base = _d(quote.freight_amount) + _d(quote.other_charges)
    return base * (Decimal("1") + _d(quote.tax_percent) / Decimal("100"))


def _rank_quotes(quotes: list[CarrierQuote], method: str) -> list[dict]:
    """Score and order the submitted quotes, through the shared scorer.

    Flattening to `evaluation.Candidate` rather than scoring here is what keeps the
    carrier comparison and the RFQ comparison arithmetically identical — the two are
    the same decision about different things being bought.
    """
    priced = [q for q in quotes if q.status in (QuoteStatus.SUBMITTED.value,
                                                QuoteStatus.AWARDED.value,
                                                QuoteStatus.NOT_AWARDED.value)
              and q.freight_amount is not None]
    if not priced:
        return []

    by_id = {q.id: q for q in priced}
    costs = {q.id: _landed_cost(q) for q in priced}
    ranked = evaluation.rank([
        evaluation.Candidate(ref=q.id, price=_d(q.freight_amount),
                             landed_cost=costs[q.id], lead_days=q.transit_days)
        for q in priced
    ], method)

    rows = []
    for row in ranked:
        quote = by_id[row.ref]
        rows.append({
            "quote_id": quote.id,
            "carrier_id": quote.carrier_id,
            "carrier_name": quote.carrier_name,
            "status": quote.status,
            "freight_amount": float(_d(quote.freight_amount)),
            "other_charges": float(_d(quote.other_charges)),
            "tax_percent": float(_d(quote.tax_percent)),
            "landed_cost": float(costs[quote.id]),
            "transit_days": quote.transit_days,
            "vehicle_type": quote.vehicle_type,
            "valid_until": quote.valid_until,
            "remarks": quote.remarks,
            "score": float(row.score),
            "rank": row.rank,
            "is_recommended": row.is_recommended,
        })
    _flag_best(rows)
    return rows


def _flag_best(rows: list[dict]) -> None:
    """Mark the cheapest quote and the fastest one, independently of the ranking.

    The rank already says who wins under the chosen method, and that is one number
    hiding two facts. A desk deciding a shipment wants both of them on the sheet at
    once: what the cheapest option is, and what the quickest one is. When they are the
    same carrier there is no decision to make; when they are not, the trade-off IS the
    decision, and a sheet that only shows the winner has quietly made it for them.

    Ties are all flagged, not just the first: two carriers at the same price are both
    the cheapest, and picking one of them to wear the badge is arbitrary.
    """
    if not rows:
        return
    best_cost = min(row["landed_cost"] for row in rows)
    timed = [row["transit_days"] for row in rows if row["transit_days"] is not None]
    best_days = min(timed) if timed else None
    for row in rows:
        row["is_cheapest"] = row["landed_cost"] == best_cost
        row["is_fastest"] = (best_days is not None
                             and row["transit_days"] == best_days)


def _brief(row: dict | None) -> dict | None:
    """One quote, cut down to what a recommendation has to name."""
    if row is None:
        return None
    return {
        "quote_id": row["quote_id"],
        "carrier_id": row["carrier_id"],
        "carrier_name": row["carrier_name"],
        "landed_cost": row["landed_cost"],
        "transit_days": row["transit_days"],
    }


def _recommendation(rows: list[dict]) -> dict | None:
    """Who the numbers point at, and what choosing them costs against the alternatives.

    A recommendation, never a decision: this returns what the ranking found and the
    two comparisons a desk would otherwise work out on paper — how much the top quote
    saves against the runner-up, and how many days it gives away against the fastest.
    The award is still a press somebody has to make, and `award_carrier` will accept
    any submitted quote, not only this one. That is deliberate: the numbers do not
    know that a carrier lost a pallet last month.

    Facts only, no sentence. Phrasing it (and printing the money) is the screen's job —
    the currency format lives beside the rest of the presentation, not in the service.
    """
    if not rows:
        return None
    top = rows[0]
    cheapest = next((row for row in rows if row["is_cheapest"]), None)
    fastest = next((row for row in rows if row["is_fastest"]), None)
    # The next quote down the ranking, which is what the top one was actually chosen
    # over. Absent on a single-quote sheet, where there was nothing to choose between.
    runner_up = rows[1] if len(rows) > 1 else None

    others = [row["landed_cost"] for row in rows
              if row["quote_id"] != top["quote_id"]]
    return {
        **_brief(top),
        "score": top["score"],
        "is_cheapest": top["is_cheapest"],
        "is_fastest": top["is_fastest"],
        "cheapest": _brief(cheapest),
        "fastest": _brief(fastest),
        "runner_up": _brief(runner_up),
        # What the recommendation saves against the best other price on the sheet, and
        # what it gives away in days against the quickest. Either may be zero, and the
        # saving goes NEGATIVE when the winner is not the cheapest — ranked by speed,
        # the winner can be the dearest quote, and a sheet that hid that would be
        # relabelling a deliberate trade-off as a bargain. `days_slower` is None when
        # nobody quoted a transit time: a comparison that invents a lead time is worse
        # than one that admits it does not have one.
        "saving": (min(others) - top["landed_cost"]) if others else None,
        "days_slower": (
            top["transit_days"] - fastest["transit_days"]
            if fastest is not None and top["transit_days"] is not None else None),
        # Cheapest and fastest are different carriers: there is a trade-off here and
        # the desk, not the ranking, is the one who should settle it.
        "is_trade_off": bool(cheapest and fastest
                             and cheapest["quote_id"] != fastest["quote_id"]),
    }


async def comparison(db: AsyncSession, tr_id: int,
                     method: str | None = None) -> dict:
    """The comparison sheet, ranked by whichever method is asked for.

    `method` overrides what is stored so the desk can see the same quotes under a
    different lens before committing to one — looking is not choosing.
    """
    doc = await get_tr(db, tr_id)
    if method and not evaluation.is_valid(method):
        raise ValidationError(f"{method!r} is not an evaluation method")
    chosen = evaluation.method_of(method or doc.evaluation_method)
    rows = _rank_quotes(list(doc.quotes), chosen)
    # Invited and silent. Carried on the sheet rather than left to the screen to
    # diff against the invite list: "who has not answered yet" is the question that
    # decides whether to award now or wait one more day.
    pending = [{"quote_id": q.id, "carrier_id": q.carrier_id,
                "carrier_name": q.carrier_name, "invited_at": q.invited_at}
               for q in doc.quotes if q.status == QuoteStatus.INVITED.value]
    return {
        "tr_id": doc.id, "tr_no": doc.tr_no, "status": doc.status,
        "mode": doc.mode,
        "consignment_no": doc.consignment_no,
        "to_location_name": doc.to_location_name,
        "evaluation_method": chosen,
        "invited": len(doc.quotes),
        "responded": len(rows),
        "rows": rows,
        "pending": pending,
        "recommendation": _recommendation(rows),
        "awarded_quote_id": doc.awarded_quote_id,
        # Stated rather than enforced: three quotes is the standard (doc B8), but a
        # single-carrier lane is real and blocking it would stop the shipment.
        "meets_three_quote_norm": len(rows) >= 3,
    }


async def award_carrier(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    """Fix the provider on a tendered request, through the CARRIER_AWARD ladder."""
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.QUOTING.value:
        raise ValidationError(f"{doc.tr_no} is not open for award")
    quote = next((q for q in doc.quotes if q.id == data.quote_id), None)
    if quote is None:
        raise NotFoundError(f"Quote {data.quote_id} is not on {doc.tr_no}")
    if quote.status != QuoteStatus.SUBMITTED.value:
        raise ValidationError(f"{quote.carrier_name} has not submitted a price")

    method = evaluation.method_of(doc.evaluation_method)
    ranked = {row["quote_id"]: row for row in _rank_quotes(list(doc.quotes), method)}
    # Snapshotted, not recomputed on read: the ranking that justified this award has
    # to keep saying what it said even after the method or the quotes change.
    for candidate in doc.quotes:
        row = ranked.get(candidate.id)
        if row is not None:
            candidate.score, candidate.rank = _d(row["score"]), row["rank"]
        if candidate.status == QuoteStatus.SUBMITTED.value:
            candidate.status = QuoteStatus.NOT_AWARDED.value

    quote.status = QuoteStatus.AWARDED.value
    doc.carrier_id, doc.carrier_name = quote.carrier_id, quote.carrier_name
    doc.freight_amount = _landed_cost(quote)
    doc.awarded_quote_id = quote.id
    doc.awarded_by_id = getattr(user, "id", None)
    doc.awarded_by_name = getattr(user, "full_name", None)
    doc.awarded_at = utcnow()
    doc.evaluation_method = method

    # Awarding commits freight, so it gets its own sign-off. If nothing is configured
    # the engine hands back an approved instance and nobody is asked — a missing ladder
    # must never strand a consignment (rule 8).
    await engine.start(db, DocType.CARRIER_AWARD.value, doc.id, _context(doc), user)
    # And then it waits here REGARDLESS, on the rung the award was made from.
    #
    # Picking the winner off the comparison sheet and telling the winner are two
    # presses, not one. This used to read the engine's answer and, when the ladder
    # resolved to nobody, send the shipment straight to AWAITING_CARRIER — which is
    # exactly what happens for anyone raising an award from the top of the org, since
    # there is no rung above them to sign it. The desk pressed Award on Provider
    # Selection and the offer was already out to the carrier: no chance to re-read the
    # sheet, no chance to overrule it, and nothing on the shipment left to press.
    #
    # So the award always lands on QUOTING carrying `awarded_at`, which is the state
    # the screens draw as "confirm the award" on the Provider accepts rung. Whether a
    # signature was ALSO required is `act_on_award`'s question, not this one: with a
    # ladder configured the confirm press is the approver's, without one it is the
    # desk's, and either way the carrier hears nothing until it is made.
    doc.status = TransportStatus.QUOTING.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"carrier": doc.carrier_name,
                             "freight": float(doc.freight_amount or 0)},
                      summary=f"Awarded {doc.tr_no} to {doc.carrier_name} "
                              f"({method.replace('_', ' ').lower()})")
    await db.commit()
    await db.refresh(doc)
    return doc


async def _award_in_approval(db: AsyncSession, tr_id: int) -> bool:
    """Is a CARRIER_AWARD signature actually outstanding on this shipment?

    Asked because the confirm press has two meanings and only one of them is the
    engine's. A configured ladder leaves a live instance and the press is the
    APPROVER's, so it must go through `engine.act` and be recorded as an approval. A
    ladder that resolved to nobody — no rung above the raiser, which is every award
    raised from the top of the org — was self-approved at `start`, and calling `act`
    on it raises "No in-progress approval for this document": the press would fail on
    exactly the shipments that have nobody but this desk to make it.

    Read off `wf_instances` rather than kept on the request, so the answer is the
    engine's own and cannot drift from it.
    """
    return bool(await db.scalar(
        select(Instance.id)
        .where(Instance.doc_type == DocType.CARRIER_AWARD.value,
               Instance.doc_id == tr_id,
               Instance.status == InstanceStatus.IN_PROGRESS.value)
        .limit(1)))


def _guard_award_confirmable(doc: TransportRequest) -> None:
    """There has to BE an award, and it has to be one nobody has confirmed yet."""
    if doc.status != TransportStatus.QUOTING.value or doc.awarded_at is None:
        raise ValidationError(
            f"{doc.tr_no} has no award waiting to be confirmed")


async def act_on_award(db: AsyncSession, tr_id: int, action: str, user,
                       comments: str = "") -> TransportRequest:
    """Confirm the award, or overrule it — the press that tells the carrier.

    Both halves of the Provider accepts rung meet here: this is our side of it, and
    only once it is made does the shipment reach the carrier's portal to be
    acknowledged. Whether it also carried a signature is `_award_in_approval`'s
    question; the outcome for the shipment is the same either way.
    """
    doc = await get_tr(db, tr_id)
    action = (action or "").upper()
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("An award can only be approved or rejected")
    _guard_award_confirmable(doc)

    if await _award_in_approval(db, tr_id):
        instance = await engine.act(db, DocType.CARRIER_AWARD.value, doc.id, action,
                                    user, comments, context=_context(doc))
        outcome = instance.status
    else:
        # Nobody was asked, so there is nothing to record against a stage — the press
        # itself is the decision, and the audit row below is what carries it.
        outcome = (InstanceStatus.APPROVED.value
                   if action == ApprovalAction.APPROVED.value
                   else InstanceStatus.REJECTED.value)

    if outcome == InstanceStatus.APPROVED.value:
        doc.status = TransportStatus.AWAITING_CARRIER.value
    elif outcome == InstanceStatus.REJECTED.value:
        # Back to the tender, not to rejected: the shipment still has to travel. The
        # quote goes back to SUBMITTED — it was overruled, not withdrawn, so it is
        # still on the comparison sheet and can win again under another method.
        _unwind_award(doc, QuoteStatus.SUBMITTED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=(f"Confirmed the award on {doc.tr_no} — "
                               f"{doc.carrier_name} asked to acknowledge"
                               if outcome == InstanceStatus.APPROVED.value
                               else f"Overruled the carrier award on {doc.tr_no}"))
    await db.commit()
    await db.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
#  The carrier's answer
# --------------------------------------------------------------------------- #
# An award is an offer. A booking is what the carrier confirms, and until then there
# is no truck — so AWAITING_CARRIER is a real stage of the flow rather than a status
# the desk sets on somebody else's behalf. The desk can still confirm a phone call
# (`confirm_carrier`), but that is recorded as what it is.

def _unwind_award(doc: TransportRequest, quote_status: str) -> None:
    """Put a tendered request back out to the other carriers.

    Back to the tender, never to rejected: the shipment still has to travel. The award
    is undone so a different carrier can be picked, and the ex-winner's quote keeps the
    status that says WHY it is no longer the winner — a decline is not the same as
    being overruled.

    The LOSERS go back to SUBMITTED, and that is the part that makes this work at all:
    awarding requires a SUBMITTED quote, so leaving them NOT_AWARDED would send the
    shipment back to a tender where not one of the prices on file could be awarded to
    anybody. Nothing is deleted — three quotes on file is still the evidence the award
    was competitive (doc B8).
    """
    for quote in doc.quotes:
        if quote.id == doc.awarded_quote_id:
            quote.status = quote_status
        elif quote.status == QuoteStatus.NOT_AWARDED.value:
            quote.status = QuoteStatus.SUBMITTED.value
    doc.carrier_id = doc.carrier_name = None
    doc.freight_amount = doc.awarded_quote_id = None
    doc.awarded_at = doc.awarded_by_id = doc.awarded_by_name = None
    doc.carrier_accepted_at = None
    doc.status = TransportStatus.QUOTING.value


def _guard_awaiting_carrier(doc: TransportRequest) -> None:
    if doc.status != TransportStatus.AWAITING_CARRIER.value:
        raise ValidationError(
            f"{doc.tr_no} is {doc.status.lower().replace('_', ' ')} — "
            "there is no provider acknowledgement waiting")


async def accept_award(db: AsyncSession, tr_id: int, carrier_id: int | None,
                       reference: str | None, user=None,
                       confirmed_by_desk: str | None = None) -> TransportRequest:
    """The carrier takes the job. One function for the portal and for the desk.

    `carrier_id` is passed only by the portal, and it is checked against the awarded
    carrier: a carrier holds no RBAC role, so this comparison IS the authorisation.
    """
    doc = await get_tr(db, tr_id)
    _guard_awaiting_carrier(doc)
    if carrier_id is not None and doc.carrier_id != carrier_id:
        raise ValidationError("This shipment was awarded to another carrier")

    doc.carrier_accepted_at = utcnow()
    doc.carrier_declined_at = None
    doc.carrier_decline_reason = None
    if reference:
        doc.carrier_reference = reference
    doc.carrier_confirmed_by_name = confirmed_by_desk
    doc.status = TransportStatus.READY.value

    who = confirmed_by_desk or doc.carrier_name or "the carrier"
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=(f"{who} accepted {doc.tr_no}"
                               + (" (confirmed by the desk)" if confirmed_by_desk
                                  else "")))
    await db.commit()
    await db.refresh(doc)
    return doc


async def decline_award(db: AsyncSession, tr_id: int, carrier_id: int | None,
                        reason: str, user=None) -> TransportRequest:
    """The carrier drops the job. Straight back to the tender, minus that carrier."""
    doc = await get_tr(db, tr_id)
    _guard_awaiting_carrier(doc)
    if carrier_id is not None and doc.carrier_id != carrier_id:
        raise ValidationError("This shipment was awarded to another carrier")
    if not (reason or "").strip():
        raise ValidationError("Say why the job is being declined")

    declined_name = doc.carrier_name
    doc.carrier_declined_at = utcnow()
    doc.carrier_decline_reason = reason.strip()
    _unwind_award(doc, QuoteStatus.DECLINED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=f"{declined_name} declined {doc.tr_no}: {reason.strip()}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def set_provider(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    """Fix the provider on a mode with no tender — courier, own vehicle, hand-over."""
    doc = await get_tr(db, tr_id)
    rule = mode_rule(doc.mode)
    if rule.needs_quotes:
        raise ValidationError(
            "A third-party shipment is awarded off its quotes, not set directly")
    if doc.status not in (TransportStatus.READY.value,
                          TransportStatus.QUOTING.value):
        raise ValidationError(f"{doc.tr_no} must be approved first")

    if data.carrier_id:
        vendor = await _carrier(db, data.carrier_id)
        doc.carrier_id, doc.carrier_name = vendor.id, vendor.name
    # Same list the gate pass prints from. Leaving the custody fields out here meant
    # a provider named on Provider Selection arrived with a blank hand-over record.
    for field in ("freight_amount", "vehicle_number", "driver_name",
                  "driver_phone", "driver_licence_no", "trip_reference",
                  "handed_over_by_name", "handed_over_employee_id",
                  "handed_over_aadhaar", "handed_over_phone"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)
    # An own vehicle already going that way costs the shipment nothing — that is the
    # entire reason the mode exists, so it is recorded as zero rather than left blank.
    if doc.mode == TransportMode.OWN_VEHICLE.value:
        doc.freight_amount = ZERO
    _check_mode_fields(doc)
    doc.status = TransportStatus.READY.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"carrier": doc.carrier_name,
                             "vehicle": doc.vehicle_number},
                      summary=f"Set the provider on {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
#  Tracking
# --------------------------------------------------------------------------- #

async def _release(db: AsyncSession, doc: TransportRequest, data, user, *,
                   strict: bool = True) -> None:
    """It has left. Capture the tracking handle the field will be given.

    Split out of `dispatch_tr` so the one-press Dispatch screen can release on the same
    press it books with (`dispatch_consignment(release_now=True)`) and get EXACTLY this
    — the same checks, the same pickup event, the same hand-back to the warehouse. A
    second copy of "it has left" is how the two doors start disagreeing about whether
    the consignment ever gated out.

    `strict` is the difference between ASKING to release and DISCOVERING it already
    happened. The desk pressing "it has left" is asked for the docket, because that
    press is the moment to capture it. A carrier scan, a delivery or the site's own
    signature arriving on a shipment still reading READY is evidence it left days ago,
    and refusing those for a missing docket would throw away a fact that is already
    true — see `_ensure_released`.

    Does not commit: the caller owns the transaction and its audit row.
    """
    if strict:
        # The full check now, carrier included: whatever the mode was allowed to leave
        # blank at submit has been answered by this point, and a consignment must never
        # leave the yard with nobody named as taking it.
        _check_mode_fields(doc)

        rule = mode_rule(doc.mode)
        if rule.needs_carrier and not (getattr(data, "lr_no", None)
                                       or getattr(data, "docket_no", None)
                                       or doc.lr_no or doc.docket_no):
            raise ValidationError(
                "Record the LR or docket number — it is what the field is given to "
                "track the consignment.")

        # And whatever the load is CARRYING gets a say, while saying no still means
        # something. A consignment that owes its own dispatch signature must not go
        # out of the gate on a logistics press: refusing afterwards, in `ON_RELEASE`,
        # left the shipment IN_TRANSIT and the consignment at PACKED — so nothing
        # counted as dispatched, the requester was never offered the acknowledgement,
        # and the indent could never close. Nothing registered and this is a no-op.
        objection = await hooks.first_objection(hooks.BEFORE_RELEASE, db, doc, user)
        if objection:
            raise ValidationError(objection)
    for field in ("lr_no", "docket_no", "tracking_url", "eway_bill_no",
                  "gate_pass_no", "expected_delivery"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)

    # Security and an own vehicle do not depend on an outside carrier to issue these
    # references. Keep the defaults deterministic so the dialog can show them before
    # release and a direct API call records the exact same values.
    reference = doc.consignment_no or doc.tr_no
    if not (doc.gate_pass_no or "").strip():
        doc.gate_pass_no = f"GP/{reference}"
    if (doc.mode == TransportMode.OWN_VEHICLE.value
            and not (doc.lr_no or "").strip()):
        doc.lr_no = f"LR/{reference}"
    if getattr(data, "remarks", None):
        doc.remarks = data.remarks

    doc.status = TransportStatus.IN_TRANSIT.value
    doc.dispatched_at = utcnow()
    doc.dispatched_by_name = getattr(user, "full_name", None)
    doc.events.append(ShipmentEvent(
        event_type=ShipmentEventType.PICKED_UP.value, event_at=utcnow(),
        location_name=doc.from_warehouse_name,
        description=(f"Picked up by {doc.carrier_name}" if doc.carrier_name
                     else f"Handed over by {doc.handed_over_by_name or 'the warehouse'}"),
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=getattr(user, "full_name", None),
    ))
    # The consignment this leg carries is the WAREHOUSE's document and it has to know
    # the load is gone: left at PACKED it never counts as dispatched, so the requester's
    # own Acknowledgements screen shows nothing to confirm and the indent stays open
    # with the goods already on a truck. Logistics may not import warehouse (rule 5),
    # so the warehouse registered the hand-back itself — see `logistics/hooks.py`.
    await hooks.fire(hooks.ON_RELEASE, db, doc, user)


async def _ensure_released(db: AsyncSession, doc: TransportRequest, user,
                           data=None) -> bool:
    """Release a shipment that plainly left without anyone pressing the button.

    "It has left" used to be decided in four places. Only `dispatch_tr` and the
    one-press Dispatch screen went through `_release`; a carrier scan bumped the status
    inline and `deliver_tr` walked straight from READY to DELIVERED. The status was the
    least of what those two skipped — `_release` is also what fires `ON_RELEASE`, and
    that hook is what tells the WAREHOUSE its consignment is gone. Without it the
    consignment stayed PACKED, `dispatched_quantity` stayed zero, and the requester's
    Acknowledgements screen never offered the button that closes the indent. A
    third-party leg whose carrier tracked it from their own portal could therefore
    never be signed for at all.

    Non-strict on purpose: whatever is calling here has already established that the
    goods moved, so a missing docket is a gap in the record, not grounds to reject the
    news. Returns whether it did anything, for the caller's audit line.
    """
    if doc.status != TransportStatus.READY.value:
        return False
    await _release(db, doc, data, user, strict=False)
    return True


async def dispatch_tr(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    """The desk pressing "it has left" on a shipment that was already settled."""
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.READY.value:
        raise ValidationError(
            f"{doc.tr_no} is {doc.status.lower()} — it is not ready to leave")

    await _release(db, doc, data, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status, "lr_no": doc.lr_no},
                      summary=f"Dispatched {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def add_event(db: AsyncSession, tr_id: int, data, user) -> ShipmentEvent:
    """One scan, or one claim. Both land here — they arrive on the same timeline."""
    doc = await get_tr(db, tr_id)
    event_type = (data.event_type or "").upper()
    if event_type not in {e.value for e in ShipmentEventType}:
        raise ValidationError(f"{data.event_type!r} is not a shipment event")
    # A signature is stamped by the acknowledgement, never typed in as a scan — least
    # of all by the carrier, whose scan endpoint lands here too.
    if event_type in SIGNATURE_EVENT_TYPES:
        raise ValidationError(
            "Only the receiving site acknowledging the consignment records that")
    if doc.status in TERMINAL_STATUSES:
        raise ValidationError(f"{doc.tr_no} is closed; no further events")

    event = ShipmentEvent(
        event_type=event_type, event_at=data.event_at or utcnow(),
        location_name=data.location_name, description=data.description,
        is_exception=event_type in EXCEPTION_EVENT_TYPES,
        affected_item_name=data.affected_item_name,
        affected_qty=_d(data.affected_qty) if data.affected_qty is not None else None,
        claim_amount=_d(data.claim_amount) if data.claim_amount is not None else None,
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=getattr(user, "full_name", None),
    )
    doc.events.append(event)
    # A scan on a request that has not been marked dispatched still means it is moving.
    # Through `_ensure_released` rather than by assigning the status here: this used to
    # move the shipment on without telling the warehouse its consignment had gone, so a
    # carrier tracking their own job left the requester with nothing to acknowledge.
    # A DELIVERED scan is still excluded — `deliver_tr` is that door, and it releases
    # on its own way through.
    if event_type != ShipmentEventType.DELIVERED.value:
        await _ensure_released(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"{event_type.replace('_', ' ').title()} on {doc.tr_no}")
    await db.commit()
    await db.refresh(event)
    return event


async def resolve_exception(db: AsyncSession, event_id: int, data,
                            user) -> ShipmentEvent:
    event = await db.get(ShipmentEvent, event_id)
    if event is None:
        raise NotFoundError(f"Event {event_id} not found")
    if not event.is_exception:
        raise ValidationError("That event is not a claim")
    if event.resolved_at is not None:
        raise ValidationError("That claim is already closed")

    event.resolution = data.resolution
    event.resolved_at = utcnow()
    event.resolved_by_id = getattr(user, "id", None)
    event.resolved_by_name = getattr(user, "full_name", None)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=event.tr_id,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"Closed a {event.event_type.lower()} claim")
    await db.commit()
    await db.refresh(event)
    return event


async def deliver_tr(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    doc = await get_tr(db, tr_id)
    if doc.status not in (TransportStatus.IN_TRANSIT.value,
                          TransportStatus.READY.value):
        raise ValidationError(f"{doc.tr_no} is {doc.status.lower()}")

    # Arriving proves it left. Releasing first stamps the departure and hands the
    # warehouse its consignment back, which walking straight from READY to DELIVERED
    # skipped — the shipment read delivered while the consignment behind it was still
    # sitting PACKED on the warehouse's floor.
    await _ensure_released(db, doc, user)

    doc.status = TransportStatus.DELIVERED.value
    doc.delivered_at = data.delivered_at or utcnow()
    doc.delivered_to_name = data.delivered_to_name
    doc.pod_url = data.pod_url
    for line in doc.items:
        # Full delivery unless a shortage was already recorded against the line. The
        # claim is the exception; typing every line back in on the normal path is how
        # a shortage gets missed.
        line.delivered_qty = line.quantity
    doc.events.append(ShipmentEvent(
        event_type=ShipmentEventType.DELIVERED.value, event_at=doc.delivered_at,
        location_name=doc.to_location_name,
        description=data.remarks or f"Received by {data.delivered_to_name or 'the site'}",
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=getattr(user, "full_name", None),
    ))

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=f"Delivered {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def share_tracking(db: AsyncSession, tr_id: int, user) -> TransportRequest:
    """Doc D5: the field is told where its material is.

    Stamped rather than sent — this system does not mail anyone. What it records is
    that the field WAS told, which is what the indent team's chase list needs: an
    unnotified site cannot be expected to acknowledge.
    """
    doc = await get_tr(db, tr_id)
    if not (doc.lr_no or doc.docket_no or doc.tracking_url
            or doc.mode == TransportMode.DIRECT.value):
        raise ValidationError(
            "There is nothing to share yet — record the LR or docket first")
    doc.tracking_shared_at = utcnow()
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      summary=f"Shared tracking for {doc.tr_no} with the field")
    await db.commit()
    await db.refresh(doc)
    return doc


async def acknowledge_tr(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    """The receiving site signs for it (doc A6).

    Delivered is the carrier's word; this is the field's, and only this one closes the
    indent's loop. A site reporting SHORT or DAMAGED opens a claim on the same shipment
    timeline rather than in a second place — the logistics desk chasing the carrier and
    the site's complaint are one fact, and recording them apart is how they diverge.
    """
    doc = await get_tr(db, tr_id)
    if doc.status == TransportStatus.ACKNOWLEDGED.value:
        raise ValidationError(f"{doc.tr_no} has already been acknowledged")
    if doc.status not in AWAITING_ACK_STATUSES:
        raise ValidationError(
            f"{doc.tr_no} is {doc.status.lower().replace('_', ' ')} — only a "
            "consignment that has left can be acknowledged")

    before_status = doc.status
    condition = (data.condition or AckCondition.GOOD.value).upper()
    if condition not in {c.value for c in AckCondition}:
        raise ValidationError(f"{data.condition!r} is not a delivery condition")
    if condition != AckCondition.GOOD.value and not (data.remarks or "").strip():
        raise ValidationError(
            "Say what was short or damaged — it is the claim against the provider")

    # Signing for it IS the proof it arrived, so a shipment still reading IN_TRANSIT
    # is marked delivered on the way through rather than refused. Waiting for this desk
    # to tick "delivered" first put a keystroke nobody at the destination can make
    # between the goods landing and the indent closing.
    if doc.status != TransportStatus.DELIVERED.value:
        doc.delivered_at = doc.delivered_at or utcnow()
        doc.delivered_to_name = (doc.delivered_to_name or data.acknowledged_by_name
                                 or getattr(user, "full_name", None))
        for line in doc.items:
            # Full delivery unless a shortage was already booked against the line —
            # the same rule `deliver_tr` runs on, and for the same reason: typing every
            # line back in on the normal path is how a shortage gets missed.
            if not line.delivered_qty:
                line.delivered_qty = line.quantity
        doc.events.append(ShipmentEvent(
            event_type=ShipmentEventType.DELIVERED.value, event_at=doc.delivered_at,
            location_name=doc.to_location_name,
            description=(f"Confirmed on arrival by "
                         f"{data.acknowledged_by_name or 'the site'}"),
            recorded_by_id=getattr(user, "id", None),
            recorded_by_name=getattr(user, "full_name", None),
        ))

    doc.status = TransportStatus.ACKNOWLEDGED.value
    doc.acknowledged_at = utcnow()
    doc.acknowledged_by_id = getattr(user, "id", None)
    doc.acknowledged_by_name = (data.acknowledged_by_name
                                or getattr(user, "full_name", None))
    doc.ack_condition = condition
    doc.ack_remarks = data.remarks
    if data.pod_url:
        doc.pod_url = data.pod_url

    # The signature belongs on the tracking timeline, not only in the header. Tracking
    # is read from the events alone, so a leg somebody had already signed for went on
    # showing "Out for delivery" as its last scan.
    doc.events.append(ShipmentEvent(
        event_type=ShipmentEventType.ACKNOWLEDGED.value, event_at=doc.acknowledged_at,
        location_name=doc.to_location_name,
        description=(f"Signed for by {doc.acknowledged_by_name or 'the site'}"
                     + (f" — reported {condition.lower()}"
                        if condition != AckCondition.GOOD.value else "")),
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=doc.acknowledged_by_name,
    ))

    claim_type = ACK_CLAIM_EVENT.get(condition)
    if claim_type:
        doc.events.append(ShipmentEvent(
            event_type=claim_type, event_at=utcnow(),
            location_name=doc.to_location_name,
            description=f"Reported on acknowledgement: {data.remarks}",
            is_exception=True,
            affected_item_name=data.affected_item_name,
            affected_qty=(_d(data.affected_qty)
                          if data.affected_qty is not None else None),
            claim_amount=(_d(data.claim_amount)
                          if data.claim_amount is not None else None),
            recorded_by_id=getattr(user, "id", None),
            recorded_by_name=doc.acknowledged_by_name,
        ))

    # The site signing for the leg settles what the leg was carrying: the warehouse
    # consignment, the material issue behind it and, once nothing is still owed, the
    # indent that asked for it. Registered by the warehouse rather than called into it
    # — logistics sits in front of warehouse in the import chain (rule 5).
    await hooks.fire(hooks.ON_ACKNOWLEDGE, db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before_status},
                      after={"status": doc.status, "condition": condition},
                      summary=(f"{doc.acknowledged_by_name or 'The site'} acknowledged "
                               f"{doc.tr_no} as {condition.lower()}"))
    await db.commit()
    await db.refresh(doc)
    return doc


async def close_tr(db: AsyncSession, tr_id: int, user) -> TransportRequest:
    doc = await get_tr(db, tr_id)
    # Logistics cannot close around the receiver. Direct hand-over also stays open
    # until the indent requester confirms quantities and delivery evidence.
    #
    # ...but only when there IS a requester. The raiser's receipt is now the ONLY door
    # to ACKNOWLEDGED — the logistics desk's own `/acknowledge` route and the raiser's
    # `/raiser-acknowledge` were both retired with the Acknowledgements screen — so a
    # leg carrying no indent (a plain stock transfer, a consignment raised on its own)
    # has nobody left who can sign it. Requiring ACKNOWLEDGED there is not a stricter
    # rule, it is a shipment that can never be closed. DELIVERED stays the way out for
    # exactly those, which is what it was before this change.
    signable = (TransportStatus.ACKNOWLEDGED.value,) if doc.indent_id else (
        TransportStatus.ACKNOWLEDGED.value, TransportStatus.DELIVERED.value)
    if doc.status not in signable:
        raise ValidationError(
            "The indent requester must acknowledge this consignment before it can "
            "be closed" if doc.indent_id
            else "Only a delivered consignment can be closed")
    open_claims = [e for e in doc.events if e.is_exception and e.resolved_at is None]
    if open_claims:
        raise ValidationError(
            f"{len(open_claims)} open claim(s) on this consignment. Close them with "
            "the provider before closing the shipment.")
    doc.status = TransportStatus.CLOSED.value
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=f"Closed {doc.tr_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def history(db: AsyncSession, tr_id: int) -> list:
    doc = await get_tr(db, tr_id)
    rows = await engine.history(db, DocType.TRANSPORT_REQUEST.value, doc.id)
    rows += await engine.history(db, DocType.CARRIER_AWARD.value, doc.id)
    return rows


# --------------------------------------------------------------------------- #
#  Carrier portal
# --------------------------------------------------------------------------- #
# Reached by someone outside the company. There is no `require_permission` on any of
# it — a carrier holds no RBAC role — so the guard is that every function takes the
# carrier id from the verified token and filters on it. No function here accepts a
# carrier id from the caller. Same rule the supplier portal already runs on.

#: Everything a carrier is entitled to see on a request they were invited to: the
#: tender they can still price, the job they have won, and the leg they are running.
#: A closed or cancelled shipment drops off their board — it is no longer their work.
CARRIER_VISIBLE_STATUSES = (
    TransportStatus.QUOTING.value,
    TransportStatus.AWAITING_CARRIER.value,
    TransportStatus.READY.value,
    TransportStatus.IN_TRANSIT.value,
    TransportStatus.DELIVERED.value,
    TransportStatus.ACKNOWLEDGED.value,
)


#: The statuses the OUTCOME queue reads over, and the one place it differs from the
#: live board: a shipment that has been CLOSED. Closing is the end of the winner's
#: work, which is why it drops off every queue above — but for the carrier who did not
#: get it, closed is not "no longer relevant", it is the final answer. Dropping it
#: there put them straight back to watching the tender they priced disappear with
#: nothing said, which is the whole thing this queue exists to stop.
CARRIER_OUTCOME_STATUSES = CARRIER_VISIBLE_STATUSES + (TransportStatus.CLOSED.value,)

#: The queue that is not a status. A carrier who was outbid still has to be TOLD: the
#: last thing they saw was their own price going in, and a shipment that simply drops
#: off their board reads as a portal that lost it — which is exactly what "the other
#: one just disappeared" means. So the outcome is a queue of its own, keyed on THEIR
#: quote rather than on the shipment's status, because the shipment itself is somebody
#: else's job now and must never turn up under "collect".
CARRIER_LOST_QUEUE = "NOT_AWARDED"

#: Everything on a shipment that belongs to whoever WON it. A carrier who was outbid is
#: told the outcome and nothing further: not the price it went for, not who is driving
#: it, not where it has reached. They keep the lane, the load and their own quote —
#: precisely what they were shown when they were asked to price it. Blanked on a
#: detached Pydantic model, never on the mapped row, so a redaction can never be
#: flushed back onto the document.
WINNER_ONLY_FIELDS = (
    "carrier_id", "carrier_name", "freight_amount", "awarded_by_name",
    "carrier_accepted_at", "carrier_declined_at", "carrier_decline_reason",
    "carrier_reference", "carrier_confirmed_by_name", "vehicle_number", "driver_name",
    # The custody record is the winner's too — a licence number and an Aadhaar belong
    # to the person who actually came for the load, and a carrier who lost the tender
    # has no business reading either.
    "driver_phone", "driver_licence_no", "trip_reference", "handed_over_by_name",
    "handed_over_employee_id", "handed_over_aadhaar", "handed_over_phone",
    "received_by_name",
    "lr_no", "docket_no", "tracking_url", "eway_bill_no", "gate_pass_no",
    "dispatched_at", "dispatched_by_name", "delivered_at", "delivered_to_name",
    "pod_url", "tracking_shared_at", "acknowledged_at", "acknowledged_by_name",
    "ack_condition", "ack_remarks",
)


def _my_quote_exists(carrier_id: int):
    """EXISTS a quote row of mine — an invitation — on this request."""
    return (select(CarrierQuote.id)
            .where(CarrierQuote.tr_id == TransportRequest.id,
                   CarrierQuote.carrier_id == carrier_id)
            .exists())


def _carrier_scope(carrier_id: int, statuses: list[str], *, lost: bool = False):
    """The one WHERE clause that decides what a carrier may see.

    Being invited buys visibility of the TENDER, and nothing else. Past the award, the
    shipment belongs to whoever won it: a carrier who was outbid must not keep watching
    somebody else's truck run, and must certainly not be shown it in a queue labelled
    "collect". Both halves are needed — the invitation alone showed every invited
    carrier the winner's job, and `carrier_id` alone would hide the tender from
    everyone still bidding, because no carrier is set yet.

    The invitation is an EXISTS, not a join, and it guards only the tender half. A
    single-provider dispatch names its carrier on the request and never opens a
    quoting round, so those shipments carry NO `lgs_carrier_quotes` row at all — an
    inner join dropped every one of them, and the carrier who was actually driving the
    load saw an empty "collect" queue and a zero on every badge but the tender's. The
    EXISTS also keeps one row per request whatever the tender's size, so a count is a
    count of shipments rather than of invitations.

    `lost=True` is the mirror of all that, and the ONLY other thing a carrier may see:
    requests they answered and did not get. It is deliberately a separate scope rather
    than a widening of this one — the live queues stay exactly as narrow as they were,
    so an unawarded shipment can never leak into "accept the job" or "collect". It is
    read-only by construction too: every write below re-checks `doc.carrier_id`
    against the signed-in carrier, and on these rows that check is what fails.
    """
    if lost:
        return (
            TransportRequest.status.in_(statuses or ["__none__"]),
            # The tender is over. While it is still QUOTING there is nothing to tell
            # them — a request that came back round after a decline is an OPEN ask
            # again, and it belongs on "quote for it" where it already is.
            TransportRequest.status != TransportStatus.QUOTING.value,
            # Any quote of theirs will do: on a request that has left the tender, the
            # only quote status that means "yours" is AWARDED, and an awarded quote
            # carries its carrier on the request itself — which the next clause
            # excludes. An invitation they never answered is a lost tender too.
            _my_quote_exists(carrier_id),
            or_(TransportRequest.carrier_id.is_(None),
                TransportRequest.carrier_id != carrier_id),
        )
    return (
        TransportRequest.status.in_(statuses or ["__none__"]),
        or_(and_(TransportRequest.status == TransportStatus.QUOTING.value,
                 _my_quote_exists(carrier_id)),
            TransportRequest.carrier_id == carrier_id),
    )


async def carrier_open_requests(db: AsyncSession, carrier_id: int,
                                params: PageParams,
                                status: str | None = None) -> dict:
    """What this carrier has been invited to, and nothing else.

    `status=NOT_AWARDED` asks for the outcome queue rather than a status: the tenders
    they were invited to and did not get. Serialised here rather than by the router,
    because a row on that queue has to be redacted before it leaves — see
    `_redact_row`.
    """
    lost = (status or "").strip().upper() == CARRIER_LOST_QUEUE
    if lost:
        wanted = list(CARRIER_OUTCOME_STATUSES)
    else:
        wanted = ([s.strip().upper() for s in status.split(",") if s.strip()]
                  if status else list(CARRIER_VISIBLE_STATUSES))
        # Intersected, never replaced: a carrier asking for DRAFT must not widen what
        # the portal shows. The filter narrows their own board; it cannot open
        # somebody's.
        wanted = [s for s in wanted if s in CARRIER_VISIBLE_STATUSES]
    stmt = (select(TransportRequest)
            .where(*_carrier_scope(carrier_id, wanted, lost=lost))
            .order_by(TransportRequest.id.desc()))
    page = await paginate(db, stmt, params)

    # Their own answer, stamped onto every row. A tender stays on the "quote for it"
    # queue after it has been priced — the desk may ask again and the carrier may
    # revise — so the row itself has to carry whether they have answered, or the board
    # reads as untouched work the moment they leave the job screen. On the outcome
    # queue it IS the row: their quote status is the only thing that separates outbid
    # from declined from never answered, and the portal says which.
    rows = []
    for doc in page["items"]:
        row = TRListRow.model_validate(doc)
        mine = next((q for q in doc.quotes if q.carrier_id == carrier_id), None)
        row.my_quote_status = mine.status if mine else None
        row.my_quote_amount = float(mine.freight_amount) if (
            mine and mine.freight_amount is not None) else None
        row.my_quote_submitted_at = mine.submitted_at if mine else None
        if lost:
            _redact_row(row)
        rows.append(row)
    page["items"] = rows
    return page


def _redact_row(row: TRListRow) -> None:
    """Strip the winner's half off a list row before an outbid carrier reads it.

    The same rule `_carrier_view` applies to the detail, applied to the summary: they
    are told the lane and their own price, never what it went for or where it is now.
    Safe to assign because `row` is a detached `TRListRow`, not the mapped request.
    """
    for field in WINNER_ONLY_FIELDS:
        if field in TRListRow.model_fields:
            setattr(row, field, None)


async def carrier_summary(db: AsyncSession, carrier_id: int) -> dict:
    """The five numbers a carrier's board leads with."""
    rows = (await db.execute(
        select(TransportRequest.status, func.count(TransportRequest.id))
        .where(*_carrier_scope(carrier_id, list(CARRIER_VISIBLE_STATUSES)))
        .group_by(TransportRequest.status)
    )).all()
    by_status = {status: count for status, count in rows}

    # Only the ones still needing a price: a tender this carrier has already answered
    # is not an open invitation, and counting it as one makes the badge lie.
    to_quote = (await db.execute(
        select(func.count(CarrierQuote.id))
        .join(TransportRequest, CarrierQuote.tr_id == TransportRequest.id)
        .where(CarrierQuote.carrier_id == carrier_id,
               CarrierQuote.status == QuoteStatus.INVITED.value,
               TransportRequest.status == TransportStatus.QUOTING.value)
    )).scalar_one()

    # Counted off the LOST scope, not off `by_status`: those rows are not in the scope
    # the five numbers above are grouped over, and they never should be — a shipment
    # somebody else is driving must not add to "on the road".
    not_awarded = (await db.execute(
        select(func.count(TransportRequest.id))
        .where(*_carrier_scope(carrier_id, list(CARRIER_OUTCOME_STATUSES), lost=True))
    )).scalar_one()

    return {
        "to_quote": to_quote,
        "to_confirm": by_status.get(TransportStatus.AWAITING_CARRIER.value, 0),
        "to_pick_up": by_status.get(TransportStatus.READY.value, 0),
        "on_the_road": by_status.get(TransportStatus.IN_TRANSIT.value, 0),
        "delivered": (by_status.get(TransportStatus.DELIVERED.value, 0)
                      + by_status.get(TransportStatus.ACKNOWLEDGED.value, 0)),
        "not_awarded": not_awarded,
    }


async def carrier_get_request(db: AsyncSession, carrier_id: int,
                              tr_id: int) -> TransportRequest:
    """One request, if this carrier is entitled to it — the same rule as the board.

    Every write a carrier can make goes through here first, so the scope is enforced
    once: an outbid carrier cannot act on the winner's shipment — they cannot accept,
    track or deliver against it, because each of those re-checks `doc.carrier_id`
    against the signed-in carrier and a request they lost fails that check.

    The lost scope is tried SECOND and only as a fallback, so a request that is live
    work for this carrier is always found as live work. What it buys them is the
    outcome of their own quote, redacted by `_carrier_view` on the way out.
    """
    async def _find(statuses, **kwargs):
        return (await db.execute(
            select(TransportRequest)
            .where(TransportRequest.id == tr_id,
                   *_carrier_scope(carrier_id, list(statuses), **kwargs))
        )).scalars().first()

    # The same two scopes the board is built from, and the same status sets — a card
    # they can see on a queue has to open, closed shipments included.
    doc = (await _find(CARRIER_VISIBLE_STATUSES)
           or await _find(CARRIER_OUTCOME_STATUSES, lost=True))
    if doc is None:
        # Same message whether it does not exist or belongs to somebody else — telling
        # them apart tells an outsider which shipments are real.
        raise NotFoundError("That transport request is not open to you")
    return doc


def _carrier_view(doc: TransportRequest, carrier_id: int) -> TROut:
    """The shipment as this carrier may see it: their own quote, nobody else's.

    Serialised here rather than by the router because the narrowing IS the rule — a
    tender where every bidder can read what the others bid is not a tender. Built as a
    detached `TROut` so neither the filtered list nor the redaction below can ever be
    written back onto the mapped relationship.

    A request that went to somebody else is redacted down to the outcome: the lane,
    the load and their own quote — everything they were shown when they were asked to
    price it, and not one field more. Their quote's own status (`NOT_AWARDED`, or
    `DECLINED` if they dropped it) is what tells the portal which of the two happened,
    so the answer is served rather than inferred from a shipment status that is now
    describing another carrier's truck.
    """
    out = TROut.model_validate(doc)
    out.quotes = [q for q in out.quotes if q.carrier_id == carrier_id]
    if doc.carrier_id != carrier_id:
        for field in WINNER_ONLY_FIELDS:
            setattr(out, field, None)
        # The scans on it are the winner's movements, one per line.
        out.events = []
    return out


async def carrier_view_request(db: AsyncSession, carrier_id: int,
                               tr_id: int) -> TROut:
    return _carrier_view(await carrier_get_request(db, carrier_id, tr_id), carrier_id)


#: What a carrier must state before their price can be compared with anybody else's,
#: as (payload field, what the portal calls it).
QUOTE_REQUIRED_FIELDS = (
    ("freight_amount", "Transport charge"),
    ("other_charges", "Other charges"),
    ("tax_percent", "Tax %"),
    ("transit_days", "Transit days"),
    ("vehicle_type", "Vehicle type"),
)


async def carrier_quote(db: AsyncSession, carrier_id: int, tr_id: int,
                        data) -> CarrierQuote:
    """A price sent in by the carrier themselves, complete or not at all.

    The five numbers are checked HERE rather than on `QuoteIn`, because the schema is
    shared with the desk recording a quote that arrived by phone and a partial one
    taken down over a call is still worth having. What cannot be partial is a quote
    the carrier typed at leisure into a form that asked for all five: the comparison
    scores landed cost and lead time, so a blank tax or transit day is not a keener
    bid, it is an unrankable one that reads as zero.
    """
    missing = [label for field, label in QUOTE_REQUIRED_FIELDS
               if getattr(data, field, None) is None
               or (isinstance(getattr(data, field), str)
                   and not getattr(data, field).strip())
               or field not in getattr(data, "model_fields_set", {field})]
    if missing:
        raise ValidationError("Fill in " + ", ".join(missing) + " before sending "
                              "the quote — put 0 where nothing applies")
    await carrier_get_request(db, carrier_id, tr_id)
    return await record_quote(db, tr_id, carrier_id, data, user=None)


def carrier_carriage_options(mode: str) -> list[dict]:
    """The carriages this arrangement can be made under, for the portal's tiles.

    The catalogue read the other way round: the desk picks a carriage and narrows the
    arrangements, the carrier is handed an arrangement and narrows the carriages. One
    table either way, so the portal can never offer a routing the desk's own screen
    would refuse.
    """
    allowed = set(carriages_for_mode(mode))
    return [row for row in carriage_catalogue() if row["value"] in allowed]


async def carrier_accept(db: AsyncSession, carrier_id: int, tr_id: int,
                         data) -> TROut:
    """The carrier takes the job they won."""
    await carrier_get_request(db, carrier_id, tr_id)
    doc = await accept_award(db, tr_id, carrier_id, data.carrier_reference)
    return _carrier_view(doc, carrier_id)


#: What the carrier states when they acknowledge the award, by the column it is
#: written to. The desk types the same set on the dispatch form for a leg it settles
#: itself; on a tender they belong to whoever won it, so they arrive with the yes.
CARRIER_ACK_FIELDS = (
    "driver_name", "vehicle_number", "driver_phone", "driver_licence_no",
    "lr_no", "docket_no", "tracking_url", "eway_bill_no",
)


async def carrier_acknowledge(db: AsyncSession, carrier_id: int, tr_id: int,
                              data) -> TROut:
    """The carrier takes the job AND says what is coming for it.

    One press, not two: the vehicle and the driver are written first and the award is
    then accepted through `accept_award`, so a shipment can never end up READY with
    nobody named against it — and the audit row, the status and the "an award is an
    offer" rule all stay exactly where they were. Written before the accept because
    `accept_award` is what commits.
    """
    doc = await carrier_get_request(db, carrier_id, tr_id)
    if doc.carrier_id != carrier_id:
        raise ValidationError("This shipment was awarded to another carrier")
    # Refused here as well as inside `accept_award`, so nothing is written onto a
    # shipment that is not this carrier's to answer.
    _guard_awaiting_carrier(doc)

    for field in CARRIER_ACK_FIELDS:
        value = getattr(data, field, None)
        if value is not None and str(value).strip():
            setattr(doc, field, str(value).strip())

    # Which way they are actually sending it. The ARRANGEMENT stays the desk's — it
    # was settled before the tender went out and the award was made against it — so
    # the pair is validated against `doc.mode`, not against anything the carrier sent:
    # a third-party job can go by road or by rail, and neither answer can turn it into
    # a hand-over. Saying nothing keeps whatever the dispatch desk picked.
    doc.carriage_mode = _resolve_carriage(
        doc.mode, getattr(data, "carriage_mode", None), current=doc.carriage_mode)

    accepted = await accept_award(db, tr_id, carrier_id, data.carrier_reference)
    return _carrier_view(accepted, carrier_id)


async def carrier_decline(db: AsyncSession, carrier_id: int, tr_id: int,
                          data) -> TROut:
    """The carrier drops it. Straight back to the tender for the desk to re-award."""
    await carrier_get_request(db, carrier_id, tr_id)
    doc = await decline_award(db, tr_id, carrier_id, data.reason)
    return _carrier_view(doc, carrier_id)


async def carrier_track(db: AsyncSession, carrier_id: int, tr_id: int,
                        data) -> TROut:
    """The carrier records the LR / docket and, from then on, its own scans.

    The same two writes the desk makes, reached from the other side of the fence:
    dispatching a READY job, and adding a progress event to one already moving. Which
    of the two it is comes from the status, not from the caller — a carrier must not
    be able to say "this has left" about a shipment nobody has released.
    """
    doc = await carrier_get_request(db, carrier_id, tr_id)
    if doc.carrier_id != carrier_id:
        raise ValidationError("This shipment was awarded to another carrier")
    if data.carrier_reference:
        doc.carrier_reference = data.carrier_reference
    for field in ("lr_no", "docket_no", "tracking_url"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)
    await db.commit()
    await db.refresh(doc)

    if data.event_type:
        # Through `add_event`, not a hand-rolled row: a carrier scan and a desk scan
        # have to land identically, claim flag and all. A carrier cannot raise a claim
        # against itself, so the three claim fields are fixed at None here.
        await add_event(db, tr_id, SimpleNamespace(
            event_type=data.event_type, event_at=None,
            location_name=data.location_name, description=data.description,
            affected_item_name=None, affected_qty=None, claim_amount=None,
        ), user=None)
        await db.refresh(doc)
    return _carrier_view(doc, carrier_id)


async def carrier_deliver(db: AsyncSession, carrier_id: int, tr_id: int,
                          data) -> TROut:
    """The carrier says it arrived, and hands over the proof.

    It stops at DELIVERED on purpose. Only the receiving site can acknowledge, and a
    carrier marking its own delivery as accepted is exactly the signature a shortage
    claim would need to be missing.
    """
    doc = await carrier_get_request(db, carrier_id, tr_id)
    if doc.carrier_id != carrier_id:
        raise ValidationError("This shipment was awarded to another carrier")
    return _carrier_view(await deliver_tr(db, tr_id, data, user=None), carrier_id)
