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
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.indents.models import Indent
from app.modules.logistics.enums import (
    ACK_CLAIM_EVENT,
    AWAITING_ACK_STATUSES,
    CARRIER_VENDOR_TYPES,
    EXCEPTION_EVENT_TYPES,
    MODE_RULES,
    AckCondition,
    QuoteStatus,
    ShipmentEventType,
    TERMINAL_STATUSES,
    TransportMode,
    TransportStatus,
    flow_stages,
    is_inbound,
    mode_rule,
    suggest_mode,
)
from app.modules.logistics import hooks
from app.modules.logistics.models import (
    CarrierQuote, ShipmentEvent, TransportRequest, TransportRequestItem,
)
from app.modules.logistics.schemas import TROut
from app.platform.settings.service import write_audit
from app.platform.workflow import engine, ladder
from app.shared import evaluation
from app.shared.enums import ApprovalAction, AuditAction, DocType, InstanceStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Vendor
from app.shared.numbering import next_number

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


async def list_trs(db: AsyncSession, params: PageParams, status: str | None = None,
                   mode: str | None = None, carrier_id: int | None = None,
                   indent_id: int | None = None,
                   search: str | None = None,
                   dispatch_id: int | None = None,
                   source_type: str | None = None,
                   awaiting_ack: bool = False) -> dict:
    stmt = select(TransportRequest)
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
            "status": doc.status,
            "carrier_name": doc.carrier_name,
            "lr_no": doc.lr_no or doc.docket_no,
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


def _raiser_view(doc: TransportRequest) -> dict:
    """What a raiser is shown about the leg carrying their indent.

    Deliberately short: it is "where is my material", not the transport register, and
    the freight, the losing quotes and who awarded it are none of the field's business.
    """
    return {
        "tr_id": doc.id, "tr_no": doc.tr_no,
        "status": doc.status, "mode": doc.mode,
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
                         search: str | None = None) -> dict:
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


async def open_exceptions(db: AsyncSession, params: PageParams) -> dict:
    """Damage, shortage and delay claims nobody has closed yet."""
    stmt = (select(ShipmentEvent)
            .where(ShipmentEvent.is_exception.is_(True),
                   ShipmentEvent.resolved_at.is_(None))
            .order_by(ShipmentEvent.event_at.desc()))
    return await paginate(db, stmt, params)


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
    "received_by_name": "who received it",
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
        vehicle_number=data.vehicle_number, driver_name=data.driver_name,
        driver_phone=data.driver_phone, trip_reference=data.trip_reference,
        handed_over_by_name=data.handed_over_by_name,
        received_by_name=data.received_by_name,
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
                      after={"mode": doc.mode, "status": doc.status},
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
        settled_summary = (f"{doc.tr_no} ready to leave with "
                           f"{doc.carrier_name or doc.vehicle_number or 'the warehouse'}")

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
    _guard_editable(doc)
    before = {"mode": doc.mode, "carrier_id": doc.carrier_id}

    if data.mode:
        if data.mode.upper() not in MODE_RULES:
            raise ValidationError(f"{data.mode!r} is not a transport mode")
        # Changing the mode drops any quoting already done: a courier booking is not
        # a truck tender, and carrying the old quotes forward would let an award be
        # justified by prices collected for a different job.
        if doc.mode != data.mode.upper():
            doc.quotes.clear()
            doc.carrier_id = doc.carrier_name = None
            doc.freight_amount = doc.awarded_quote_id = None
        doc.mode = data.mode.upper()

    for field in ("tr_date", "source_type", "source_id", "source_no", "issue_id",
                  "dispatch_id", "consignment_no",
                  "indent_id", "indent_no", "from_warehouse_id",
                  "from_warehouse_name", "to_location_name", "delivery_address",
                  "contact_person", "contact_phone", "distance_km", "project_id",
                  "project_name", "expected_delivery", "remarks", "vehicle_number",
                  "driver_name", "driver_phone", "trip_reference",
                  "handed_over_by_name", "received_by_name"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)

    if data.carrier_id:
        vendor = await _carrier(db, data.carrier_id)
        doc.carrier_id, doc.carrier_name = vendor.id, vendor.name
    if data.lines:
        _apply_lines(doc, data.lines)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"mode": doc.mode, "carrier_id": doc.carrier_id})
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

    A quoted mode goes out to carriers; every other mode already knows who is taking
    it, so it is ready to leave. Setting both from one place is what keeps a DIRECT
    hand-over from sitting in a QUOTING queue nobody works.
    """
    doc.status = (TransportStatus.QUOTING.value
                  if mode_rule(doc.mode).needs_quotes
                  else TransportStatus.READY.value)


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
    # the engine hands back an approved instance and the shipment moves on — a missing
    # ladder must never strand a consignment (rule 8).
    instance = await engine.start(db, DocType.CARRIER_AWARD.value, doc.id,
                                  _context(doc), user)
    # Approved internally, but not yet a booking: the carrier has to accept it in their
    # own portal before anything is loaded. READY means "it can leave", and a shipment
    # whose truck has not been confirmed emphatically cannot.
    doc.status = (TransportStatus.AWAITING_CARRIER.value
                  if instance.status == InstanceStatus.APPROVED.value
                  else TransportStatus.QUOTING.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"carrier": doc.carrier_name,
                             "freight": float(doc.freight_amount or 0)},
                      summary=f"Awarded {doc.tr_no} to {doc.carrier_name} "
                              f"({method.replace('_', ' ').lower()})")
    await db.commit()
    await db.refresh(doc)
    return doc


async def act_on_award(db: AsyncSession, tr_id: int, action: str, user,
                       comments: str = "") -> TransportRequest:
    doc = await get_tr(db, tr_id)
    action = (action or "").upper()
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("An award can only be approved or rejected")
    instance = await engine.act(db, DocType.CARRIER_AWARD.value, doc.id, action,
                                user, comments, context=_context(doc))
    if instance.status == InstanceStatus.APPROVED.value:
        doc.status = TransportStatus.AWAITING_CARRIER.value
    elif instance.status == InstanceStatus.REJECTED.value:
        # Back to the tender, not to rejected: the shipment still has to travel. The
        # quote goes back to SUBMITTED — it was overruled, not withdrawn, so it is
        # still on the comparison sheet and can win again under another method.
        _unwind_award(doc, QuoteStatus.SUBMITTED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=f"{action.title()} the carrier award on {doc.tr_no}")
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
            "there is no award waiting to be accepted")


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
    for field in ("freight_amount", "vehicle_number", "driver_name", "driver_phone",
                  "trip_reference", "handed_over_by_name", "received_by_name"):
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

async def _release(db: AsyncSession, doc: TransportRequest, data, user) -> None:
    """It has left. Capture the tracking handle the field will be given.

    Split out of `dispatch_tr` so the one-press Dispatch screen can release on the same
    press it books with (`dispatch_consignment(release_now=True)`) and get EXACTLY this
    — the same checks, the same pickup event, the same hand-back to the warehouse. A
    second copy of "it has left" is how the two doors start disagreeing about whether
    the consignment ever gated out.

    Does not commit: the caller owns the transaction and its audit row.
    """
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
    for field in ("lr_no", "docket_no", "tracking_url", "eway_bill_no",
                  "gate_pass_no", "expected_delivery"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)
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
    if (doc.status == TransportStatus.READY.value
            and event_type != ShipmentEventType.DELIVERED.value):
        doc.status = TransportStatus.IN_TRANSIT.value

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
    # Acknowledged is the normal way in. DELIVERED is still allowed because a
    # hand-over the receiver signed for on paper has nobody left to acknowledge in
    # the system, and blocking that would leave the shipment open forever.
    if doc.status not in (TransportStatus.DELIVERED.value,
                          TransportStatus.ACKNOWLEDGED.value):
        raise ValidationError("Only a delivered consignment can be closed")
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


def _carrier_scope(carrier_id: int, statuses: list[str]):
    """The one WHERE clause that decides what a carrier may see.

    Being invited buys visibility of the TENDER, and nothing else. Past the award, the
    shipment belongs to whoever won it: a carrier who was outbid must not keep watching
    somebody else's truck run, and must certainly not be shown it in a queue labelled
    "collect". Both halves are needed — the invitation join alone showed every invited
    carrier the winner's job, and `carrier_id` alone would hide the tender from
    everyone still bidding, because no carrier is set yet.
    """
    return (
        CarrierQuote.carrier_id == carrier_id,
        TransportRequest.status.in_(statuses or ["__none__"]),
        or_(TransportRequest.status == TransportStatus.QUOTING.value,
            TransportRequest.carrier_id == carrier_id),
    )


async def carrier_open_requests(db: AsyncSession, carrier_id: int,
                                params: PageParams,
                                status: str | None = None) -> dict:
    """What this carrier has been invited to, and nothing else."""
    wanted = ([s.strip().upper() for s in status.split(",") if s.strip()]
              if status else list(CARRIER_VISIBLE_STATUSES))
    # Intersected, never replaced: a carrier asking for DRAFT must not widen what the
    # portal shows. The filter narrows their own board; it cannot open somebody's.
    wanted = [s for s in wanted if s in CARRIER_VISIBLE_STATUSES]
    stmt = (select(TransportRequest)
            .join(CarrierQuote, CarrierQuote.tr_id == TransportRequest.id)
            .where(*_carrier_scope(carrier_id, wanted))
            .order_by(TransportRequest.id.desc()))
    page = await paginate(db, stmt, params)

    # Their own answer, stamped onto every row. A tender stays on the "quote for it"
    # queue after it has been priced — the desk may ask again and the carrier may
    # revise — so the row itself has to carry whether they have answered, or the board
    # reads as untouched work the moment they leave the job screen.
    for row in page["items"]:
        mine = next((q for q in row.quotes if q.carrier_id == carrier_id), None)
        row.my_quote_status = mine.status if mine else None
        row.my_quote_amount = float(mine.freight_amount) if (
            mine and mine.freight_amount is not None) else None
        row.my_quote_submitted_at = mine.submitted_at if mine else None
    return page


async def carrier_summary(db: AsyncSession, carrier_id: int) -> dict:
    """The five numbers a carrier's board leads with."""
    rows = (await db.execute(
        select(TransportRequest.status, func.count(TransportRequest.id))
        .join(CarrierQuote, CarrierQuote.tr_id == TransportRequest.id)
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

    return {
        "to_quote": to_quote,
        "to_confirm": by_status.get(TransportStatus.AWAITING_CARRIER.value, 0),
        "to_pick_up": by_status.get(TransportStatus.READY.value, 0),
        "on_the_road": by_status.get(TransportStatus.IN_TRANSIT.value, 0),
        "delivered": (by_status.get(TransportStatus.DELIVERED.value, 0)
                      + by_status.get(TransportStatus.ACKNOWLEDGED.value, 0)),
    }


async def carrier_get_request(db: AsyncSession, carrier_id: int,
                              tr_id: int) -> TransportRequest:
    """One request, if this carrier is entitled to it — the same rule as the board.

    Every write a carrier can make goes through here first, so the scope is enforced
    once: an outbid carrier cannot read the winner's shipment, and therefore cannot
    accept, track or deliver against it either.
    """
    doc = (await db.execute(
        select(TransportRequest)
        .join(CarrierQuote, CarrierQuote.tr_id == TransportRequest.id)
        .where(TransportRequest.id == tr_id,
               *_carrier_scope(carrier_id, list(CARRIER_VISIBLE_STATUSES)))
    )).scalars().first()
    if doc is None:
        # Same message whether it does not exist or belongs to somebody else — telling
        # them apart tells an outsider which shipments are real.
        raise NotFoundError("That transport request is not open to you")
    return doc


def _carrier_view(doc: TransportRequest, carrier_id: int) -> TROut:
    """The shipment as its carrier may see it: their own quote, nobody else's.

    Serialised here rather than by the router because the narrowing IS the rule — a
    tender where every bidder can read what the others bid is not a tender. Built as a
    detached `TROut` so the filtered list can never be written back onto the mapped
    relationship and delete the other carriers' rows.
    """
    out = TROut.model_validate(doc)
    out.quotes = [q for q in out.quotes if q.carrier_id == carrier_id]
    return out


async def carrier_view_request(db: AsyncSession, carrier_id: int,
                               tr_id: int) -> TROut:
    return _carrier_view(await carrier_get_request(db, carrier_id, tr_id), carrier_id)


async def carrier_quote(db: AsyncSession, carrier_id: int, tr_id: int,
                        data) -> CarrierQuote:
    await carrier_get_request(db, carrier_id, tr_id)
    return await record_quote(db, tr_id, carrier_id, data, user=None)


async def carrier_accept(db: AsyncSession, carrier_id: int, tr_id: int,
                         data) -> TROut:
    """The carrier takes the job they won."""
    await carrier_get_request(db, carrier_id, tr_id)
    doc = await accept_award(db, tr_id, carrier_id, data.carrier_reference)
    return _carrier_view(doc, carrier_id)


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
