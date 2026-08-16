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

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.logistics.enums import (
    CARRIER_VENDOR_TYPES,
    EXCEPTION_EVENT_TYPES,
    MODE_RULES,
    QuoteStatus,
    ShipmentEventType,
    TERMINAL_STATUSES,
    TransportMode,
    TransportStatus,
    mode_rule,
)
from app.modules.logistics.models import (
    CarrierQuote, ShipmentEvent, TransportRequest, TransportRequestItem,
)
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
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
                   search: str | None = None) -> dict:
    stmt = select(TransportRequest)
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


def _check_mode_fields(doc: TransportRequest) -> None:
    """Whatever the mode says it must carry, checked in one place.

    Runs at submit rather than at create: a draft is allowed to be incomplete, which
    is the whole point of a draft. What must never happen is an approved request that
    nobody can act on because it names no carrier and no vehicle.
    """
    rule = mode_rule(doc.mode)
    missing = [_FIELD_LABELS.get(field, field)
               for field in rule.required_fields
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

    doc = TransportRequest(
        tr_no=await next_number(db, DocType.TRANSPORT_REQUEST.value.lower()),
        tr_date=data.tr_date or date.today(),
        mode=data.mode.upper(),
        status=TransportStatus.DRAFT.value,
        source_type=data.source_type, source_id=data.source_id,
        source_no=data.source_no,
        issue_id=data.issue_id, dispatch_id=data.dispatch_id,
        indent_id=data.indent_id, indent_no=data.indent_no,
        from_warehouse_id=data.from_warehouse_id,
        from_warehouse_name=data.from_warehouse_name,
        to_location_name=data.to_location_name,
        delivery_address=data.delivery_address,
        contact_person=data.contact_person, contact_phone=data.contact_phone,
        distance_km=data.distance_km,
        project_id=data.project_id, project_name=data.project_name,
        expected_delivery=data.expected_delivery, remarks=data.remarks,
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
                  "dispatch_id", "indent_id", "indent_no", "from_warehouse_id",
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
    _check_mode_fields(doc)

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
                      TransportStatus.DELIVERED.value):
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
    return rows


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
    return {
        "tr_id": doc.id, "tr_no": doc.tr_no, "status": doc.status,
        "evaluation_method": chosen,
        "invited": len(doc.quotes),
        "responded": len(rows),
        "rows": rows,
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
    doc.status = (TransportStatus.READY.value
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
        doc.status = TransportStatus.READY.value
    elif instance.status == InstanceStatus.REJECTED.value:
        # Back to the tender, not to rejected: the shipment still has to travel. The
        # award is undone so a different carrier can be picked.
        doc.status = TransportStatus.QUOTING.value
        for quote in doc.quotes:
            if quote.id == doc.awarded_quote_id:
                quote.status = QuoteStatus.SUBMITTED.value
        doc.carrier_id = doc.carrier_name = None
        doc.freight_amount = doc.awarded_quote_id = None
        doc.awarded_at = doc.awarded_by_id = doc.awarded_by_name = None

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.tr_no,
                      action=AuditAction.UPDATE, actor=user,
                      after={"status": doc.status},
                      summary=f"{action.title()} the carrier award on {doc.tr_no}")
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

async def dispatch_tr(db: AsyncSession, tr_id: int, data, user) -> TransportRequest:
    """It has left. Capture the tracking handle the field will be given."""
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.READY.value:
        raise ValidationError(
            f"{doc.tr_no} is {doc.status.lower()} — it is not ready to leave")

    rule = mode_rule(doc.mode)
    if rule.needs_carrier and not (data.lr_no or data.docket_no
                                   or doc.lr_no or doc.docket_no):
        raise ValidationError(
            "Record the LR or docket number — it is what the field is given to "
            "track the consignment.")
    for field in ("lr_no", "docket_no", "tracking_url", "eway_bill_no",
                  "expected_delivery"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)
    if data.remarks:
        doc.remarks = data.remarks

    doc.status = TransportStatus.IN_TRANSIT.value
    doc.dispatched_at = utcnow()
    doc.events.append(ShipmentEvent(
        event_type=ShipmentEventType.PICKED_UP.value, event_at=utcnow(),
        location_name=doc.from_warehouse_name,
        description=(f"Picked up by {doc.carrier_name}" if doc.carrier_name
                     else f"Handed over by {doc.handed_over_by_name or 'the warehouse'}"),
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=getattr(user, "full_name", None),
    ))

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


async def close_tr(db: AsyncSession, tr_id: int, user) -> TransportRequest:
    doc = await get_tr(db, tr_id)
    if doc.status != TransportStatus.DELIVERED.value:
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

async def carrier_open_requests(db: AsyncSession, carrier_id: int,
                                params: PageParams) -> dict:
    """What this carrier has been invited to, and nothing else."""
    stmt = (select(TransportRequest)
            .join(CarrierQuote, CarrierQuote.tr_id == TransportRequest.id)
            .where(CarrierQuote.carrier_id == carrier_id,
                   TransportRequest.status.in_([
                       TransportStatus.QUOTING.value,
                       TransportStatus.READY.value,
                       TransportStatus.IN_TRANSIT.value,
                   ]))
            .order_by(TransportRequest.id.desc()))
    return await paginate(db, stmt, params)


async def carrier_get_request(db: AsyncSession, carrier_id: int,
                              tr_id: int) -> TransportRequest:
    doc = (await db.execute(
        select(TransportRequest)
        .join(CarrierQuote, CarrierQuote.tr_id == TransportRequest.id)
        .where(TransportRequest.id == tr_id, CarrierQuote.carrier_id == carrier_id)
    )).scalars().first()
    if doc is None:
        # Same message whether it does not exist or belongs to somebody else — telling
        # them apart tells an outsider which shipments are real.
        raise NotFoundError("That transport request is not open to you")
    return doc


async def carrier_quote(db: AsyncSession, carrier_id: int, tr_id: int,
                        data) -> CarrierQuote:
    await carrier_get_request(db, carrier_id, tr_id)
    return await record_quote(db, tr_id, carrier_id, data, user=None)
