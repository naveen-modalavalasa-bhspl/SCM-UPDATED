"""All the business logic for Returns.

## Why this module owns no tables

A return is a stock transfer with a reason attached, so it is stored in `inv_sto` /
`inv_sto_items` — the Stock Transfer Order, which already carries a from-point, a
to-point, a status chain, the raiser, and per-line quantities. Nothing here creates a
table or alters a column.

Two consequences follow, and both are deliberate:

  * **Returns are told apart by a marker on `remarks`**, not by the document number.
    `remarks` is Text and `create_sto` already stamps its own classification reason
    there, so this follows an existing habit. The marker leads (`[STOCK_RETURN]{…}`)
    so the discriminator is a prefix LIKE, which an index can serve. Keying off the
    `RET-` number prefix instead would break the moment an admin renamed the series
    under Settings > Document Numbering.
  * **Inventory's own STO list will show these rows**, because that query does not
    know to exclude them and this module may not edit it (rule 5 — inventory is the
    base module and nothing reads back into it). One line added there fixes it; it is
    on the outside-changes list rather than applied here.

## The reason lives in `remarks`

As JSON behind the marker, because there is no reason column on `inv_sto` and adding
one would be a migration. `_pack`/`_unpack` are the only two functions that know the
encoding, and `_unpack` treats malformed JSON as "no reason recorded" rather than
raising — a row hand-edited in MySQL must still be readable on the screen.

## The stock

Reserved at submit (rule 7: reservations move only through `inventory.allocation`), so
the returner cannot issue away material they have already promised to send back while
it waits for approval. Nothing physically moves until the last approver signs, and then
it moves in one transaction: the reservation is consumed, the source is debited and the
destination credited, both through `inventory.service.move_stock` so a `stk_ledger` row
is always written. A rejection releases the hold.
"""
import json
import logging
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.shared.scope import scope_condition
from app.modules.inventory import allocation, locations
from app.modules.inventory import service as inventory
from app.modules.inventory.enums import LocationTier
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, Stock, StockTransferOrder, StockTransferOrderItem,
)
from app.modules.warehouse.models import PurchaseReturn, PurchaseReturnItem
from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
from app.platform.settings import attachments
from app.platform.settings.service import write_audit
from app.platform.workflow import engine, ladder
from app.shared.enums import (
    ApprovalAction, AuditAction, CategoryTagType, InstanceStatus, RefType, StockDirection,
)
from app.shared.models.base import utcnow
from app.shared.models.master import CategoryTag, Feature, Item, Vendor
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number

from . import receiving
from .enums import (
    AWAITING_ACK, BLOCKED_WHEN_HAZARDOUS, DEFAULT_DISPOSITION_BY_REASON,
    DISPOSITION_HINTS, DISPOSITION_LABELS, DISPOSITION_LABELS_SHORT, EDITABLE,
    HOLDING_STOCK, INTENT_LABELS, KIND_LABELS, LEDGER_REF_BY_DISPOSITION, MARKER,
    MOVEMENT_BY_DISPOSITION, NEEDS_AGENCY, NEEDS_DESTINATION, NEEDS_VENDOR,
    NUMBER_SERIES, PHASES, REASON_LABELS, SELECTABLE_DISPOSITIONS, SELECTABLE_REASONS,
    Disposition, Movement, ReturnDocType, ReturnIntent, ReturnKind, ReturnReason,
    ReturnStatus,
)

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

# What marks an `inv_sto` row as a return. Defined in `enums.py` and re-exported here,
# because the reports ledger needs the same prefix and cannot import this module.

# `entity_type` for uploaded photos and bills, and the `ref_type` a reservation is
# held under. Both are free strings in their tables.
ENTITY_TYPE = "STOCK_RETURN"
RESERVE_REF_TYPE = "STOCK_RETURN"

AUDIT_ENTITY = "inv_sto"

# Photos of the material, and the paperwork that came with it. Free-text on
# `sys_attachments.doc_category`; named here so both ends agree.
PHOTO_CATEGORY = "RETURN_PHOTO"
DOCUMENT_CATEGORY = "RETURN_DOCUMENT"
# The licensed agency's certificate that regulated material was actually destroyed. Its own
# category, not a plain document, because closing a controlled disposal without it is the
# one gap in this module with a legal consequence rather than an accounting one.
CERTIFICATE_CATEGORY = "RETURN_DISPOSAL_CERTIFICATE"


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


# ---------------------------------------------------------------------------
# The reason, encoded onto remarks
# ---------------------------------------------------------------------------

def _pack(reason: str, note: str | None, office_name: str | None,
          raiser_code: str | None, kind: str | None = None,
          intent: str | None = None) -> str:
    """Everything a return knows that an STO has no column for."""
    return MARKER + json.dumps({
        "reason": reason,
        "note": note or None,
        # Snapshotted, never re-read from HCM: the office someone returned from is a
        # fact about the document, and a transfer to another posting must not silently
        # rewrite where last month's return came from (rule 10).
        "office_name": office_name,
        "raiser_code": raiser_code,
        # Field or purchase, and whether the returner still needs the material. Written
        # even where they are the defaults, so a row never has to be read as "the value
        # in force when this was raised" — see `_kind`/`_intent` for the rows that
        # predate these keys.
        "kind": kind or ReturnKind.FIELD.value,
        "intent": intent or ReturnIntent.RETURN.value,
    }, separators=(",", ":"))


# Which desk holds a submitted return. Kept in the same `remarks` payload as the reason —
# the document's status stays a value inventory's own STO screens already know
# (`STOStatus`), so no screen this module does not own has to learn a new one.
#
#   FIELD    the reporting line it was raised through
#   DECISION the inventory manager, who has to say where the stock goes. No workflow
#            instance exists yet at this point: the decision IS the first rung's
#            signature and opening the chain before there is a decision would ask him to
#            approve nothing.
#   ENDORSE  the receiving chain is running and the warehouse is agreeing or objecting.
PHASE_KEY = "phase"
PHASE_FIELD = "FIELD"
PHASE_DECISION = "DECISION"
PHASE_ENDORSE = "ENDORSE"

# Payload keys the decision writes. Named once so `_decision_of` and `decide` cannot
# disagree about the spelling.
DECISION_KEY = "disposition"
DECISION_NOTE_KEY = "decision_note"
DECISION_BY_KEY = "decided_by"
DECISION_AT_KEY = "decided_at"
DECISION_VALUE_KEY = "decided_value"
VENDOR_ID_KEY = "vendor_id"
VENDOR_NAME_KEY = "vendor_name"
AGENCY_KEY = "disposal_agency"
OBJECTIONS_KEY = "objections"
# The post the return was RAISED under, snapshotted at submit. Kept because the receiving
# chain is opened later, by the decision desk, and it has to be opened on behalf of the
# raiser — see `_open_endorsement`.
RAISER_POSITION_KEY = "raiser_position_id"

# A position id no post can hold. Stands in for "the raiser's post is unknown" when the
# receiving chain is opened: `engine.start` reads a missing or falsy `requester_position_id`
# as "use the caller's own post", and the caller there is the decision desk — precisely the
# post that must not be treated as the requester's. Zero would not do: it is falsy.
NO_POST = -1


def _set_payload(doc: StockTransferOrder, **changes) -> None:
    """Rewrite part of the marker payload, keeping every key it already had.

    A key set to None is dropped rather than stored as null — that is how the receiving
    phase marker is cleared once the stock has moved.
    """
    payload = {**_unpack(doc.remarks), **changes}
    doc.remarks = MARKER + json.dumps(
        {key: value for key, value in payload.items() if value is not None},
        separators=(",", ":"))


def _phase(doc: StockTransferOrder) -> str:
    return _unpack(doc.remarks).get(PHASE_KEY) or PHASE_FIELD


def _phase_doc_type(doc: StockTransferOrder) -> str:
    """Which approval chain a decision on this document belongs to right now.

    DECISION resolves to the receipt type too, even though no instance exists yet: every
    caller that asks the engine about a document in that phase is asking about the chain
    that is ABOUT to open, and the engine answers "nothing pending" rather than pointing
    at the reporting line that has already finished.
    """
    return (ReturnDocType.STOCK_RETURN_RECEIPT.value
            if _phase(doc) in {PHASE_DECISION, PHASE_ENDORSE}
            else ReturnDocType.STOCK_RETURN.value)


def _kind(doc: StockTransferOrder) -> str:
    """FIELD for anything raised before the kind was recorded — every return this module
    has ever written is a field return, so the default is a fact rather than a guess."""
    return _unpack(doc.remarks).get("kind") or ReturnKind.FIELD.value


def _intent(doc: StockTransferOrder) -> str:
    return _unpack(doc.remarks).get("intent") or ReturnIntent.RETURN.value


def _decision_of(doc: StockTransferOrder) -> dict | None:
    """What the inventory desk decided, or None while nobody has."""
    payload = _unpack(doc.remarks)
    disposition = payload.get(DECISION_KEY)
    if not disposition:
        return None
    value = payload.get(DECISION_VALUE_KEY)
    return {
        "disposition": disposition,
        "disposition_label": DISPOSITION_LABELS.get(disposition, disposition),
        "note": payload.get(DECISION_NOTE_KEY),
        "decided_by_name": payload.get(DECISION_BY_KEY),
        "decided_at": payload.get(DECISION_AT_KEY),
        "vendor_id": payload.get(VENDOR_ID_KEY),
        "vendor_name": payload.get(VENDOR_NAME_KEY),
        "disposal_agency": payload.get(AGENCY_KEY),
        # Snapshotted at decision time on purpose: the manager weighed freight against
        # THIS number, and a later re-costing must not rewrite the figure his reasoning
        # is recorded against.
        "value": Decimal(str(value)) if value is not None else None,
        "objections": int(payload.get(OBJECTIONS_KEY) or 0),
    }


async def _raiser_position_id(db: AsyncSession, doc: StockTransferOrder) -> int:
    """The post the return was raised under, for the receiving chain's requester.

    Snapshotted at submit; derived from the raiser's active assignment for rows raised
    before that key existed; `NO_POST` when even that finds nothing. Never None and never
    zero, because `engine.start` falls back to the CALLER's post on a falsy value and the
    caller is the decision desk.
    """
    stored = _unpack(doc.remarks).get(RAISER_POSITION_KEY)
    if stored:
        return int(stored)
    position_id = await db.scalar(
        select(HcmPositionAssignment.position_id).where(
            HcmPositionAssignment.employee_id == doc.requested_by_id,
            HcmPositionAssignment.is_active.is_(True))
    )
    return int(position_id) if position_id else NO_POST


def _unpack(remarks: str | None) -> dict:
    """The reverse. A row whose payload was hand-edited into nonsense still reads."""
    text = remarks or ""
    if not text.startswith(MARKER):
        return {}
    try:
        payload = json.loads(text[len(MARKER):])
    except (ValueError, TypeError):
        logger.warning("Return remarks are not readable JSON: %r", text[:120])
        return {}
    return payload if isinstance(payload, dict) else {}


def _is_return():
    """The SQL discriminator."""
    return StockTransferOrder.remarks.like(f"{MARKER}%")


# ---------------------------------------------------------------------------
# Who is returning, from where, to where
# ---------------------------------------------------------------------------

async def _parent_point(db: AsyncSession, position_id: int | None,
                        source_warehouse_id: int | None) -> tuple[int | None, str]:
    """The stocking point one rung UP from the raiser — the MDP above a LIP.

    Found by climbing `hcm_positions.parent_position_id` and taking the first ancestor
    that holds a stocking point on a higher tier than the source. Climbing the position
    tree rather than reading a column because the org states the hierarchy in exactly
    one place, and it is that one; `whs_warehouses` has no parent pointer.

    Ancestors on the SAME tier are skipped rather than accepted: a storekeeper whose
    manager also sits on a LIP is not returning stock sideways to a peer, they are
    sending it up, and the next real rung is further along the chain.
    """
    if position_id is None:
        return None, "You are not on a position, so there is nowhere to send stock."

    source_tier = LocationTier.LIP
    if source_warehouse_id is not None:
        source_type = await db.scalar(
            select(Warehouse.warehouse_type).where(Warehouse.id == source_warehouse_id))
        source_tier = locations.tier_of(source_type)

    seen: set[int] = set()
    current = position_id
    # The same ceiling the approval ladder uses, and for the same reason: a cycle in
    # HCM's position tree would otherwise spin here forever.
    for _hop in range(20):
        parent_id = await db.scalar(
            select(HcmPosition.parent_position_id).where(HcmPosition.id == current))
        if parent_id is None or parent_id in seen:
            break
        seen.add(parent_id)
        current = parent_id

        warehouse_id = await locations.primary_location_for(db, parent_id)
        if warehouse_id is None:
            continue
        warehouse_type = await db.scalar(
            select(Warehouse.warehouse_type).where(Warehouse.id == warehouse_id))
        # Tier numbers grow downstream, so a SMALLER number is further up the chain.
        if locations.tier_of(warehouse_type).value < source_tier.value:
            return warehouse_id, ""

    return None, (
        "Nobody above you holds a stocking point, so there is nowhere to return this "
        "stock to. Ask an administrator to tag the MDP above your office under "
        "Inventory > Stocking Points.")


async def _warehouse_name(db: AsyncSession, warehouse_id: int | None) -> str | None:
    if warehouse_id is None:
        return None
    return await db.scalar(select(Warehouse.name).where(Warehouse.id == warehouse_id))


async def _raiser_context(db: AsyncSession, user) -> dict:
    """Source, destination and the identity block, all derived — never posted.

    The form shows this read-only so the returner sees what the document will say
    before they commit to it.
    """
    position_id = getattr(user, "active_position_id", None)
    source_id = await locations.primary_location_for(db, position_id)
    destination_id, note = await _parent_point(db, position_id, source_id)

    position_name = None
    if position_id is not None:
        position_name = await db.scalar(
            select(HcmPosition.name).where(HcmPosition.id == position_id))

    return {
        "employee_id": getattr(user, "id", None),
        "employee_code": getattr(user, "emp_code", None),
        "employee_name": _name(user),
        "position_name": position_name,
        "office_name": getattr(user, "office_name", None),
        "from_warehouse_id": source_id,
        "from_warehouse_name": await _warehouse_name(db, source_id),
        "to_warehouse_id": destination_id,
        "to_warehouse_name": await _warehouse_name(db, destination_id),
        "destination_note": note or None,
    }


async def raiser_context(db: AsyncSession, user) -> dict:
    return await _raiser_context(db, user)


def reasons() -> list[dict]:
    """The dropdown, in the order `SELECTABLE_REASONS` states — not dict order, so a
    retired reason stops being offered while old rows holding it still render."""
    return [{"value": reason.value, "label": REASON_LABELS[reason.value]}
            for reason in SELECTABLE_REASONS]


# ---------------------------------------------------------------------------
# What the raiser is holding
# ---------------------------------------------------------------------------

async def my_stock(db: AsyncSession, params: PageParams, user, *,
                   search: str | None = None) -> dict:
    """Only what this person actually holds, and only what is free to send back.

    Scoped to the raiser's own point rather than to everything they can see: a District
    Manager can view stock across four offices, but a return is raised against the
    shelf in front of them.
    """
    context = await _raiser_context(db, user)
    source_id = context["from_warehouse_id"]
    if source_id is None:
        return {"items": [], "total": 0, "page": params.page, "size": params.size}

    stmt = (
        select(Stock)
        .where(Stock.warehouse_id == source_id, Stock.available_qty > 0)
        .order_by(Stock.item_name, Stock.expiry_date, Stock.id)
    )
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(Stock.item_name.ilike(like), Stock.item_code.ilike(like)))

    page = await paginate(db, stmt, params)
    page["items"] = [{
        "item_id": row.item_id,
        "item_code": row.item_code,
        "item_name": row.item_name,
        "uom_code": row.uom_code,
        "available_qty": _d(row.available_qty),
        "warehouse_id": row.warehouse_id,
        "warehouse_name": row.warehouse_name,
        "expiry_date": row.expiry_date.isoformat() if row.expiry_date else None,
        "batch_no": row.batch_no,
    } for row in page["items"]]
    return page


async def _available_at(db: AsyncSession, warehouse_id: int,
                        item_id: int) -> Decimal:
    """Free quantity of one item at one point, summed across bins and batches."""
    total = await db.scalar(
        select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
            Stock.warehouse_id == warehouse_id, Stock.item_id == item_id)
    )
    return _d(total)


# ---------------------------------------------------------------------------
# What it is worth, and whether it is dangerous
# ---------------------------------------------------------------------------

async def _rate_for(db: AsyncSession, warehouse_id: int | None,
                    item_id: int) -> Decimal | None:
    """The unit cost to value a returned line at, or None when nothing has been costed.

    Two sources, in order: the valuation rate on the balance the stock is sitting on, then
    the item master's purchase price. Both are zero across the live data today — the
    costing columns were never populated — so this returns None far more often than it
    returns a number, and every caller has to render that as "not costed" rather than as
    zero. A rupee figure invented in the browser is worse than an honest gap, because the
    freight-versus-value decision is made against it.
    """
    if warehouse_id is not None:
        rate = await db.scalar(
            select(func.max(Stock.valuation_rate)).where(
                Stock.warehouse_id == warehouse_id, Stock.item_id == item_id,
                Stock.valuation_rate > 0)
        )
        if rate:
            return _d(rate)
    price = await db.scalar(select(Item.purchase_price).where(Item.id == item_id))
    return _d(price) if price else None


async def _value_of(db: AsyncSession, doc: StockTransferOrder) -> Decimal | None:
    """What the whole return is worth, or None if not one line could be costed.

    A partly-costed return is reported at the value of the lines that DO have a rate,
    because "₹4,000 of 6 lines, 2 uncosted" is still a useful number to weigh freight
    against. `is_costed` on the way out is what tells the screen whether to trust it.
    """
    total = ZERO
    found = False
    for line in list(doc.items or []):
        rate = await _rate_for(db, doc.from_warehouse_id, line.item_id)
        if rate is None:
            continue
        found = True
        total += _d(line.requested_qty) * rate
    return total if found else None


async def _hazard_flags(db: AsyncSession, item_ids: list[int]) -> dict[int, list[str]]:
    """item -> the handling features its category carries.

    Derived, never stored: an item's category is tagged with features
    (`mst_category_tags.tag_type = FEATURE`) and a feature says whether it changes
    handling. Anything with one is refused the plain Scrap route.

    The precision available is the CATEGORY's, not the item's — `mst_features` has no
    per-item link table — so a category mixing hazardous and inert items warns on both.
    That is the masters data being coarse, not this check being wrong, and it errs toward
    warning rather than toward letting somebody scrap a drum of something at a branch.
    """
    if not item_ids:
        return {}
    rows = (await db.execute(
        select(Item.id, Feature.name)
        .join(CategoryTag, CategoryTag.category_id == Item.category_id)
        .join(Feature, Feature.id == CategoryTag.tag_id)
        .where(Item.id.in_(item_ids),
               CategoryTag.tag_type == CategoryTagType.FEATURE.value,
               CategoryTag.is_active.is_(True),
               Feature.affects_handling.is_(True),
               Feature.is_active.is_(True))
    )).all()
    out: dict[int, list[str]] = {}
    for item_id, feature_name in rows:
        names = out.setdefault(item_id, [])
        if feature_name and feature_name not in names:
            names.append(feature_name)
    return out


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

async def _load(db: AsyncSession, return_id: int) -> StockTransferOrder:
    doc = await db.get(StockTransferOrder, return_id)
    if doc is None or not (doc.remarks or "").startswith(MARKER):
        # A real STO id must read as "no such return" rather than as somebody else's
        # document: this module has no business rendering a transfer it does not own.
        raise NotFoundError(f"Return {return_id} not found")
    return doc


async def _out(db: AsyncSession, doc: StockTransferOrder, user=None,
               desk: dict | None = None) -> dict:
    payload = _unpack(doc.remarks)
    reason = payload.get("reason")
    lines = list(doc.items or [])
    phase = _phase(doc)
    pending = doc.status == ReturnStatus.PENDING_APPROVAL.value

    approver_names: list[str] = []
    approver_ids: list[int] = []
    if pending and phase == PHASE_DECISION:
        # No instance exists in this phase, so the engine has nobody to name. The desk is
        # read off the configured ladder instead. `desk` is passed in by list callers so
        # a page of forty rows resolves it once rather than forty times.
        desk = desk if desk is not None else await receiving.decision_desk(db)
        holders = (desk or {}).get("holders", [])
        approver_names = [h["name"] for h in holders if h.get("name")]
        approver_ids = [h["id"] for h in holders]
    elif pending:
        # Whichever chain currently holds it — the reporting line, or the receiving desk.
        approvers = await engine.current_approvers(db, _phase_doc_type(doc), doc.id)
        approver_names = [a.full_name for a in approvers if a.full_name]
        approver_ids = [a.id for a in approvers]

    is_raiser = user is not None and doc.requested_by_id == getattr(user, "id", None)
    # Membership of the engine's own pending list, NOT `engine.actionable_doc_ids`.
    # That helper skips any document whose `resolved_chain` is null, and a return has
    # no ladder configured, so it falls back to the reporting line and leaves the
    # chain null by design — every approver came back unable to act on a document the
    # same engine was naming them the current approver of.
    can_act = user is not None and getattr(user, "id", None) in approver_ids

    decision = _decision_of(doc)
    value = await _value_of(db, doc)
    hazards = await _hazard_flags(db, [line.item_id for line in lines])

    # Controlled disposal cannot close on the agency's name alone — the certificate that
    # the material was actually destroyed has to be on the document. Looked up only when
    # the decision is that one, which is rare: a page of forty returns must not cost forty
    # attachment queries to render.
    needs_certificate = bool(decision and decision["disposition"] in NEEDS_AGENCY)
    has_certificate = (
        await _certificate_count(db, doc.id) > 0 if needs_certificate else False)
    certificate_outstanding = needs_certificate and not has_certificate
    # By the time a certificate is owed the document has settled, so no chain is pending
    # and `approver_ids` is empty. The desk is read off the configured ladder instead —
    # whoever decided on the disposal is who chases the agency for the paperwork.
    desk_ids: set[int] = set()
    if certificate_outstanding:
        desk = desk if desk is not None else await receiving.decision_desk(db)
        desk_ids = {holder["id"] for holder in (desk or {}).get("holders", [])}

    return {
        "id": doc.id,
        "return_no": doc.sto_no,
        "status": doc.status,
        "phase": phase,
        "kind": _kind(doc),
        "kind_label": KIND_LABELS.get(_kind(doc), _kind(doc)),
        "intent": _intent(doc),
        "intent_label": INTENT_LABELS.get(_intent(doc), _intent(doc)),
        "reason": reason,
        "reason_label": REASON_LABELS.get(reason or "", None),
        "reason_note": payload.get("note"),
        # None means nothing on this return has a cost recorded anywhere. The screens
        # print an em dash for it; they never print zero.
        "value": value,
        "is_costed": value is not None,
        "decision": decision,
        "hazard_features": sorted({name for names in hazards.values() for name in names}),
        # Deciding is not approving: it is choosing where the material goes, so it has
        # its own flag and its own endpoint. Only offered while the return is actually
        # sitting on the decision desk.
        "can_decide": can_act and phase == PHASE_DECISION,
        # Agreeing with that decision, or sending it back for another one.
        "can_endorse": can_act and phase == PHASE_ENDORSE,
        "from_warehouse_id": doc.from_warehouse_id,
        "from_warehouse_name": doc.from_warehouse_name,
        "to_warehouse_id": doc.to_warehouse_id,
        "to_warehouse_name": doc.to_warehouse_name,
        "raised_by_id": doc.requested_by_id,
        "raised_by_name": doc.requested_by_name,
        "raised_by_code": payload.get("raiser_code"),
        "office_name": payload.get("office_name"),
        "total_qty": sum((_d(line.requested_qty) for line in lines), ZERO),
        "total_items": len(lines),
        "current_approver_name": ", ".join(approver_names) or None,
        "can_edit": is_raiser and doc.status in EDITABLE,
        "can_submit": is_raiser and doc.status in EDITABLE and bool(lines),
        # Plain approve/reject belongs to the reporting line only. Past it the two desks
        # have their own verbs — decide, and endorse or object — so leaving this true
        # would put an "Approve" button next to them that means something different.
        "can_act": can_act and phase == PHASE_FIELD,
        # Only the raiser closes their own return, and only once the stock has moved — and
        # never while a disposal certificate is still owed. The button disappears rather
        # than failing on press, and `needs_certificate` is what the screen says instead.
        "can_acknowledge": (is_raiser and doc.status in AWAITING_ACK
                            and not certificate_outstanding),
        # Whether this return is waiting on a licensed agency's certificate, and whether it
        # has arrived. Both false on everything that is not a controlled disposal.
        "needs_certificate": needs_certificate,
        "has_certificate": has_certificate,
        # Who may post it: the desk that decided, the floor that signed, or the raiser who
        # is holding the material. Not a permission check — `add_file` re-checks server-side.
        "can_attach_certificate": (
            certificate_outstanding
            and doc.status in AWAITING_ACK
            and (is_raiser or getattr(user, "id", None) in desk_ids)),
        # Withdrawing is the raiser taking their own document back. An approver's only
        # choices are approve and reject — offering them Withdraw let anyone in the
        # chain cancel somebody else's return, which `cancel_return` refuses anyway.
        "can_withdraw": is_raiser and doc.status in EDITABLE | HOLDING_STOCK,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
        "approved_at": doc.approved_at,
        "received_at": doc.received_at,
        "items": [{
            "id": line.id,
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "quantity": _d(line.requested_qty),
            "remarks": line.remarks,
            "hazard_features": hazards.get(line.item_id, []),
        } for line in lines],
    }


async def get_return(db: AsyncSession, return_id: int, user=None) -> dict:
    return await _out(db, await _load(db, return_id), user)



# NOT FIXED, and it cannot be here — recorded so the next person does not go looking.
#
# The owner half of this rule matches the PERSON (`requested_by_id`), so an employee who
# holds two positions sees returns they raised under the other hat from either session —
# the same cross-hat leak that was fixed on the indent acknowledgements screen
# (`warehouse.acknowledgements_for_requester`) on 2026-08-20.
#
# It cannot be closed the same way: `inv_stock_transfer_orders` has NO position column,
# so there is nothing to match the active position against. Closing it needs a
# `position_id` on the table, written at create from `user.active_position_id`, and a
# migration to add it — a schema change, not a query change.
#
# The LOCATION half below (`location_ids_for_user`) is already position-derived, so a
# return raised at a point the login no longer holds is bounded correctly. Only the
# "I raised it" branch is person-wide.
def _raised_by_me(user):
    return StockTransferOrder.requested_by_id == getattr(user, "id", None)


async def list_returns(db: AsyncSession, params: PageParams, user, *,
                       status: str | None = None, search: str | None = None,
                       mine_only: bool = False, queue: str | None = None) -> dict:
    """Returns this login may see: their own, plus any raised from a point in their
    reporting subtree — the same visibility rule inventory's own screens use, so the
    two can never disagree about which shelves a login owns.

    `queue` narrows to a desk's work rather than to a status: DECISION and ENDORSE are
    both PENDING_APPROVAL, so a status filter cannot tell them apart. A queue also drops
    the subtree rule — the inventory desk holds no stocking point in the mirror, so a
    visibility filter written for storekeepers would hand it an empty list.
    """
    stmt = select(StockTransferOrder).where(_is_return())
    desk = await receiving.decision_desk(db)

    if queue:
        return await _queue_page(db, params, user, queue, desk)

    visible = await locations.location_ids_for_user(db, user)
    owner = _raised_by_me(user)
    if mine_only:
        stmt = stmt.where(owner)
    elif visible:
        # Either end of the move: a returner must keep seeing the document after it
        # leaves them, and the receiving MDP has to see what is coming.
        stmt = stmt.where(or_(
            owner,
            StockTransferOrder.from_warehouse_id.in_(visible),
            StockTransferOrder.to_warehouse_id.in_(visible),
        ))
    else:
        stmt = stmt.where(owner)

    if status:
        stmt = stmt.where(StockTransferOrder.status == status)
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(
            StockTransferOrder.sto_no.ilike(like),
            StockTransferOrder.requested_by_name.ilike(like),
            StockTransferOrder.from_warehouse_name.ilike(like),
            StockTransferOrder.to_warehouse_name.ilike(like),
            StockTransferOrder.remarks.ilike(like),
        ))

    page = await paginate(db, stmt.order_by(StockTransferOrder.id.desc()), params)
    page["items"] = [await _out(db, doc, user, desk=desk) for doc in page["items"]]
    return page


QUEUE_DECISION = "decision"
QUEUE_ENDORSEMENT = "endorsement"


async def _queue_page(db: AsyncSession, params: PageParams, user, queue: str,
                      desk: dict | None) -> dict:
    """One desk's work, oldest first — the queue is a to-do list, so the return that has
    been waiting longest is at the top rather than the newest one.

    Filtered in Python on the phase marker rather than in SQL. The phase lives inside the
    `remarks` JSON, and a LIKE over that would match a note that happened to contain the
    word: the rows are already narrowed to pending returns, which is a handful, not a
    table scan.
    """
    queue = (queue or "").strip().lower()
    if queue not in {QUEUE_DECISION, QUEUE_ENDORSEMENT}:
        raise ValidationError(f"Unknown queue {queue!r}")

    rows = list((await db.execute(
        select(StockTransferOrder)
        .where(_is_return(),
               StockTransferOrder.status == ReturnStatus.PENDING_APPROVAL.value)
        .order_by(StockTransferOrder.id)
    )).scalars().all())

    wanted = PHASE_DECISION if queue == QUEUE_DECISION else PHASE_ENDORSE
    mine: list[dict] = []
    for doc in rows:
        if _phase(doc) != wanted:
            continue
        out = await _out(db, doc, user, desk=desk)
        # Only what this login can actually act on. A queue showing somebody else's work
        # is a queue people stop reading.
        if out["can_decide"] or out["can_endorse"]:
            mine.append(out)

    start = (params.page - 1) * params.size
    return {"items": mine[start:start + params.size], "total": len(mine),
            "page": params.page, "size": params.size}


async def summary(db: AsyncSession, user) -> dict:
    """The KPI tiles. Counted in SQL over the same visibility the list applies, so the
    tiles and the grid cannot disagree — the numbers are not summed in the browser
    over whichever page happened to be fetched."""
    visible = await locations.location_ids_for_user(db, user)
    owner = _raised_by_me(user)
    scope = or_(
        owner,
        StockTransferOrder.from_warehouse_id.in_(visible),
        StockTransferOrder.to_warehouse_id.in_(visible),
    ) if visible else owner

    rows = (await db.execute(
        select(StockTransferOrder.status, func.count(StockTransferOrder.id))
        .where(_is_return(), scope)
        .group_by(StockTransferOrder.status)
    )).all()
    counts = {status: int(count) for status, count in rows}

    # Everything below is keyed off the marker payload — phase, disposition, reason — and
    # none of those are columns, so they cannot be grouped in SQL. Read as a narrow
    # projection (five fields, no lines, no joins) over the rows already in scope.
    marker_rows = (await db.execute(
        select(StockTransferOrder.id, StockTransferOrder.status,
               StockTransferOrder.remarks, StockTransferOrder.from_warehouse_name,
               StockTransferOrder.created_at)
        .where(_is_return(), scope)
    )).all()

    awaiting_decision = awaiting_endorsement = 0
    written_off = refused = 0
    by_reason: dict[str, int] = {}
    by_branch: dict[str, int] = {}
    oldest_waiting: int | None = None
    now = utcnow()

    for row in marker_rows:
        payload = _unpack(row.remarks)
        reason = payload.get("reason")
        if reason:
            label = REASON_LABELS.get(reason, reason)
            by_reason[label] = by_reason.get(label, 0) + 1
        if row.from_warehouse_name:
            by_branch[row.from_warehouse_name] = by_branch.get(row.from_warehouse_name,
                                                               0) + 1
        disposition = payload.get(DECISION_KEY)
        # Counted only once the decision has been CARRIED OUT. A tile that says "3 written
        # off" while two of them are still sitting with the floor for sign-off reports
        # stock as destroyed that is still on the shelf, and the floor can still send the
        # decision back.
        carried_out = row.status in {ReturnStatus.APPROVED.value,
                                     ReturnStatus.RECEIVED.value,
                                     ReturnStatus.REJECTED.value}
        if carried_out and disposition in {Disposition.SCRAP.value,
                                           Disposition.CONTROLLED_DISPOSAL.value}:
            written_off += 1
        if carried_out and disposition == Disposition.REJECT_UNECONOMIC.value:
            refused += 1
        if row.status != ReturnStatus.PENDING_APPROVAL.value:
            continue
        phase = payload.get(PHASE_KEY) or PHASE_FIELD
        if phase == PHASE_DECISION:
            awaiting_decision += 1
        elif phase == PHASE_ENDORSE:
            awaiting_endorsement += 1
        else:
            continue
        # How long the longest-waiting return has been sitting at a desk. Whole days, and
        # measured from when it was raised rather than from when it reached the desk: the
        # phase marker carries no timestamp, and the branch that is waiting counts from
        # the day they asked.
        if row.created_at is not None:
            days = (now - row.created_at).days
            oldest_waiting = days if oldest_waiting is None else max(oldest_waiting, days)

    def _top(source: dict[str, int]) -> list[dict]:
        return [{"label": label, "count": count} for label, count in
                sorted(source.items(), key=lambda pair: (-pair[1], pair[0]))[:5]]

    return {
        "draft": counts.get(ReturnStatus.DRAFT.value, 0),
        "pending_approval": counts.get(ReturnStatus.PENDING_APPROVAL.value, 0),
        "approved": counts.get(ReturnStatus.APPROVED.value, 0),
        "acknowledged": counts.get(ReturnStatus.RECEIVED.value, 0),
        "rejected": counts.get(ReturnStatus.REJECTED.value, 0),
        "cancelled": counts.get(ReturnStatus.CANCELLED.value, 0),
        "total": sum(counts.values()),
        "by_status": counts,
        "awaiting_decision": awaiting_decision,
        "awaiting_endorsement": awaiting_endorsement,
        "written_off": written_off,
        "refused_uneconomic": refused,
        "oldest_waiting_days": oldest_waiting,
        "top_reasons": _top(by_reason),
        "top_branches": _top(by_branch),
    }


async def history(db: AsyncSession, return_id: int) -> list[dict]:
    """Both chains as one trail, oldest first.

    The reporting line and the receiving desk are separate workflow instances, but they
    are one story to the person reading the document — and the trail has to show the
    field rungs above the inventory and warehouse ones, not one of the two.
    """
    await _load(db, return_id)
    actions = [
        action
        for doc_type in (ReturnDocType.STOCK_RETURN.value,
                         ReturnDocType.STOCK_RETURN_RECEIPT.value)
        for action in await engine.history(db, doc_type, return_id)
    ]
    actions.sort(key=lambda row: (row.acted_at or utcnow(), row.id))
    return [{
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "actor_name": action.actor_name,
        "actor_position": action.actor_position,
        "action": action.action,
        "comments": action.comments,
        "acted_at": action.acted_at,
    } for action in actions]


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

async def _apply_lines(db: AsyncSession, doc: StockTransferOrder, lines,
                       source_id: int) -> None:
    """Replaces the lines, validating each against what is on the shelf.

    Quantities are checked here and again at submit, because a draft can sit for a day
    and the stock behind it can be issued away in the meantime. Validating only on save
    let a return be submitted for material that was no longer there, and the failure
    surfaced as "Insufficient stock" from `move_stock` weeks later, in front of the
    final approver.
    """
    if not lines:
        raise ValidationError("A return with no lines sends nothing back")

    wanted: dict[int, Decimal] = {}
    for line in lines:
        wanted[line.item_id] = wanted.get(line.item_id, ZERO) + _d(line.quantity)

    items = {}
    if wanted:
        rows = (await db.execute(
            select(Item).where(Item.id.in_(list(wanted))))).scalars().all()
        items = {item.id: item for item in rows}

    for item_id, quantity in wanted.items():
        item = items.get(item_id)
        if item is None:
            raise ValidationError(f"Item {item_id} does not exist")
        available = await _available_at(db, source_id, item_id)
        if quantity > available:
            raise ValidationError(
                f"{item.name}: you are holding {available} "
                f"{item.uom_code or ''}".rstrip() +
                f", so {quantity} cannot be returned.")

    doc.items.clear()
    for line in lines:
        item = items[line.item_id]
        doc.items.append(StockTransferOrderItem(
            item_id=item.id,
            item_code=item.code,
            item_name=item.name,
            uom_code=item.uom_code,
            requested_qty=_d(line.quantity),
            remarks=(line.remarks or None),
        ))


def _assert_reason_stated(data) -> None:
    """"Other" has to say what it means.

    Every other reason describes itself, so the note stays optional there. OTHER without
    one tells the decision desk nothing, and they are the ones who have to choose an
    outcome from it.
    """
    if (data.reason.value == ReturnReason.OTHER.value
            and not (data.reason_note or "").strip()):
        raise ValidationError("Say what the reason is — 'Other' on its own tells the "
                              "decision desk nothing")


async def create_return(db: AsyncSession, data, user) -> dict:
    _assert_reason_stated(data)
    context = await _raiser_context(db, user)
    source_id = context["from_warehouse_id"]
    if source_id is None:
        raise ValidationError(
            "You do not hold a stocking point, so there is no stock to return. Ask an "
            "administrator to tag your position under Inventory > Stocking Points.")

    destination_id = data.to_warehouse_id or context["to_warehouse_id"]
    if destination_id is None:
        raise ValidationError(context["destination_note"] or
                              "There is nowhere to return this stock to.")
    if destination_id == source_id:
        raise ValidationError("A return has to go somewhere other than where it is.")

    doc = StockTransferOrder(
        # Empty list up front so `_apply_lines`'s clear() does not trigger a lazy load
        # on a row that has no identity yet.
        items=[],
        sto_no=await next_number(db, NUMBER_SERIES),
        from_warehouse_id=source_id,
        from_warehouse_name=context["from_warehouse_name"],
        to_warehouse_id=destination_id,
        to_warehouse_name=await _warehouse_name(db, destination_id),
        from_project_id=await locations.project_of_location(db, source_id),
        to_project_id=await locations.project_of_location(db, destination_id),
        status=ReturnStatus.DRAFT.value,
        requested_by_id=getattr(user, "id", None),
        requested_by_name=_name(user),
        remarks=_pack(data.reason.value, data.reason_note,
                      context["office_name"], context["employee_code"],
                      kind=data.kind.value, intent=data.intent.value),
    )
    db.add(doc)
    await db.flush()

    await _apply_lines(db, doc, data.items, source_id)
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"status": doc.status, "reason": data.reason.value})
    await db.commit()
    return await get_return(db, doc.id, user)


async def update_return(db: AsyncSession, return_id: int, data, user) -> dict:
    _assert_reason_stated(data)
    doc = await _load(db, return_id)
    _assert_raiser(doc, user)
    if doc.status not in EDITABLE:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()} and can no longer "
            "be edited.")

    payload = _unpack(doc.remarks)
    before = {"status": doc.status, "reason": payload.get("reason")}

    destination_id = data.to_warehouse_id or doc.to_warehouse_id
    if destination_id == doc.from_warehouse_id:
        raise ValidationError("A return has to go somewhere other than where it is.")
    doc.to_warehouse_id = destination_id
    doc.to_warehouse_name = await _warehouse_name(db, destination_id)
    doc.to_project_id = await locations.project_of_location(db, destination_id)
    doc.remarks = _pack(data.reason.value, data.reason_note,
                        payload.get("office_name"), payload.get("raiser_code"),
                        kind=data.kind.value, intent=data.intent.value)

    await _apply_lines(db, doc, data.items, doc.from_warehouse_id)
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": doc.status, "reason": data.reason.value})
    await db.commit()
    return await get_return(db, return_id, user)


def _assert_raiser(doc: StockTransferOrder, user) -> None:
    if doc.requested_by_id != getattr(user, "id", None):
        raise ValidationError("Only the person who raised this return can change it.")


async def submit_return(db: AsyncSession, return_id: int, user) -> dict:
    """Holds the stock, then starts the approval.

    In that order: a reservation that fails must not leave a document in approval
    against material that is no longer there.
    """
    doc = await _load(db, return_id)
    _assert_raiser(doc, user)
    if doc.status not in EDITABLE:
        raise ConflictError(
            f"This return is already {doc.status.replace('_', ' ').lower()}.")
    lines = list(doc.items or [])
    if not lines:
        raise ValidationError("A return with no lines sends nothing back")
    # The photograph is the evidence: an approver is being asked to accept that material
    # is damaged, expired or wrong, and a return with no picture of it cannot be judged.
    # Checked before the reservation so a rejected submit leaves no hold behind.
    if not await _photo_count(db, doc.id):
        raise ValidationError(
            "Attach a photo of the stock before submitting this return")

    for line in lines:
        reserved, shortfall = await allocation.reserve(
            db, line.item_id, _d(line.requested_qty),
            RESERVE_REF_TYPE, doc.id, doc.sto_no, user,
            project_id=doc.from_project_id or NO_PROJECT,
            warehouse_ids=[doc.from_warehouse_id],
            ref_line_id=line.id,
        )
        if shortfall > ZERO:
            # Everything reserved so far in this call goes back before the error
            # leaves: a partial hold on a document that never entered approval is
            # stock nobody can explain.
            await allocation.release(db, RESERVE_REF_TYPE, doc.id)
            raise ValidationError(
                f"{line.item_name}: only {reserved} of {_d(line.requested_qty)} is "
                "still on the shelf. Reduce the quantity and submit again.")

    # The hat they submitted under, snapshotted now because the receiving chain is opened
    # much later by somebody else and has to name the raiser's post, not theirs.
    _set_payload(doc, **{
        RAISER_POSITION_KEY: getattr(user, "active_position_id", None)})

    instance = await engine.start(
        db, ReturnDocType.STOCK_RETURN.value, doc.id,
        {
            "doc_no": doc.sto_no,
            "doc_summary": f"Stock return {doc.sto_no} from {doc.from_warehouse_name}",
            "requester_position_id": getattr(user, "active_position_id", None),
            "project_id": doc.from_project_id or None,
            "from_warehouse_id": doc.from_warehouse_id,
            "to_warehouse_id": doc.to_warehouse_id,
            "total_quantity": float(sum((_d(l.requested_qty) for l in lines), ZERO)),
        },
        user,
    )
    # A configuration with nothing to approve returns an already-approved instance.
    # Reading the instance rather than assuming PENDING_APPROVAL is what stops the
    # document standing still with nobody holding it.
    doc.status = ReturnStatus.PENDING_APPROVAL.value
    if instance.status == InstanceStatus.APPROVED.value:
        await db.flush()
        await _hand_to_decision(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.DRAFT.value},
                      after={"status": doc.status})
    await db.commit()
    return await get_return(db, return_id, user)


async def _hand_to_decision(db: AsyncSession, doc: StockTransferOrder, user) -> None:
    """The reporting line has signed. Now the decision desk has to say where it goes.

    This is the same shape an indent has: its own chain approves, then the inventory
    desk works it (fulfilment queue), then the warehouse (material issue, dispatch),
    and only after that does material actually move. A return is that in reverse, so
    the stock does NOT move on the field chain's last signature — it moves when the
    decision is carried out, in `_carry_out`.

    No workflow instance is opened here on purpose. The receiving ladder's first rung
    IS the decision desk, and asking the engine to route the document to him before he
    has decided anything would be asking him to approve a blank. He appears on his queue
    off the configured ladder (`receiving.decision_desk`), and the instance opens the
    moment he records a decision (`decide`).

    No receiving ladder configured for this scope means the deployment has not set that
    desk up yet, and a return must not stand still waiting for a desk nobody defined:
    it settles exactly as it did before, moving to the point one rung up, and says so in
    the log.
    """
    project_id = doc.from_project_id or None
    receipt_type = ReturnDocType.STOCK_RETURN_RECEIPT.value
    desk = await receiving.decision_desk(db)
    if desk is None or await ladder.find_ladder(db, project_id, receipt_type) is None:
        logger.info("Return %s: no %s desk configured — settling on the field chain's "
                    "approval", doc.sto_no, receipt_type)
        await _carry_out(db, doc, user)
        return

    if not desk.get("holders"):
        # A post with nobody in the chair cannot decide anything, and a return that waits
        # for an empty chair is a document nobody will ever find again.
        logger.warning("Return %s: decision desk %r has nobody in the chair — settling "
                       "on the field chain's approval", doc.sto_no, desk.get("name"))
        await _carry_out(db, doc, user)
        return

    _set_payload(doc, **{PHASE_KEY: PHASE_DECISION})
    # Status is unchanged — it IS still pending approval, at a different desk. The
    # journey leg and `current_approver_name` are what say which desk.
    await db.flush()


async def _open_endorsement(db: AsyncSession, doc: StockTransferOrder,
                            user, note: str):
    """Open the receiving chain and sign its first rung with the decision itself.

    The decision is not a separate kind of event from an approval — it is the decision
    desk's signature, and it carries a reason the next rung reads. So the instance opens
    and `engine.act` records that signature immediately, which is what advances the chain
    to the endorsers. Nothing here decides who they are; the engine resolves the ladder.

    Returns the instance after the signature, so the caller can see whether anybody is
    left to endorse.

    The chain is opened on behalf of the RAISER, not of the desk pressing the button.
    `engine.start` defaults `requester_position_id` to the caller's own post, and a custom
    ladder strikes off the rung the requester raised under (`resolve_fixed_chain`, the
    INDEPENDENT policy this ladder is saved with). With the desk as requester that rung is
    rung one — the desk's own — so the chain opened at the endorsers and the very next line
    here, the decision's signature, was refused as "not a valid approver". Every decision
    failed, on every correctly configured ladder.
    """
    receipt_type = ReturnDocType.STOCK_RETURN_RECEIPT.value
    context = {
        "doc_no": doc.sto_no,
        "doc_summary": f"Stock return {doc.sto_no} — decision to be endorsed",
        "requester_position_id": await _raiser_position_id(db, doc),
        "project_id": doc.from_project_id or None,
        "from_warehouse_id": doc.from_warehouse_id,
        "to_warehouse_id": doc.to_warehouse_id,
        "total_quantity": float(
            sum((_d(l.requested_qty) for l in list(doc.items or [])), ZERO)),
    }
    instance = await engine.start(db, receipt_type, doc.id, context, user)
    if instance.status != InstanceStatus.IN_PROGRESS.value:
        # A ladder that resolved to nobody comes back already approved. There is no rung
        # to sign, so the decision is the last word.
        return instance
    return await engine.act(db, receipt_type, doc.id,
                            ApprovalAction.APPROVED.value, user, note,
                            context=context)


async def act_on_return(db: AsyncSession, return_id: int, action: str, comments: str,
                        user) -> dict:
    """One rung of the REPORTING LINE's decision. The engine owns the chain; this owns
    the status.

    Past the reporting line the two desks have their own verbs — `decide`, and `endorse`
    — because approving is not the same act as choosing where material goes. Sending a
    plain approve/reject at a document sitting on either of those desks is refused rather
    than quietly treated as one of them.
    """
    doc = await _load(db, return_id)
    if doc.status != ReturnStatus.PENDING_APPROVAL.value:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()}, so there is "
            "nothing to decide.")
    phase = _phase(doc)
    if phase == PHASE_DECISION:
        raise ConflictError(
            "This return has cleared its reporting line and is waiting for a decision "
            "on where the stock goes. Use the decision desk.")
    if phase == PHASE_ENDORSE:
        raise ConflictError(
            "A decision has been recorded on this return. It can be endorsed or "
            "objected to, not approved.")
    action = (action or "").upper()
    if action not in {ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value}:
        raise ValidationError("A return can only be approved or rejected")
    if action == ApprovalAction.REJECTED.value and not (comments or "").strip():
        raise ValidationError("Tell the returner why this was rejected")
    if doc.requested_by_id == getattr(user, "id", None):
        raise ValidationError("You cannot approve your own return")

    before = doc.status
    instance = await engine.act(
        db, ReturnDocType.STOCK_RETURN.value, doc.id, action, user, comments,
        context={
            "doc_no": doc.sto_no,
            "doc_summary": f"Stock return {doc.sto_no} from {doc.from_warehouse_name}",
            "from_warehouse_id": doc.from_warehouse_id,
            "to_warehouse_id": doc.to_warehouse_id,
        },
    )

    if instance.status == InstanceStatus.APPROVED.value:
        await _hand_to_decision(db, doc, user)
    elif instance.status == InstanceStatus.REJECTED.value:
        doc.status = ReturnStatus.REJECTED.value
        # The hold has to go back the moment the answer is no. Leaving it standing is
        # how a shelf ends up with stock the screen calls reserved for a document that
        # was refused.
        await allocation.release(db, RESERVE_REF_TYPE, doc.id)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status, "comments": comments})
    await db.commit()
    return await get_return(db, return_id, user)


async def _carry_out(db: AsyncSession, doc: StockTransferOrder, user) -> None:
    """The decision is final: do to the stock whatever the decision said.

    Three shapes, read off `MOVEMENT_BY_DISPOSITION` rather than branched on the
    disposition name, so adding an outcome is a table entry and not a new `if` here:

      TRANSFER  out of the branch and in at the point that was chosen
      OUT_ONLY  out of the branch and off our books — vendor, scrap or disposal
      NONE      nothing moves; the hold goes back and the branch keeps the material

    Consume-then-move, per line and per balance slice, so the material that leaves is
    the exact bin/batch/project that was held — a return of expiring stock must not
    quietly send the fresh lot instead. `move_stock` writes every ledger row (rule 7);
    nothing here assigns to `stk_balance`.

    No decision at all means no decision desk is configured, and the return does what it
    did before that desk existed: it transfers to the point one rung up.
    """
    decision = _decision_of(doc)
    disposition = (decision or {}).get("disposition")
    movement = (MOVEMENT_BY_DISPOSITION.get(disposition) if disposition
                else Movement.TRANSFER)
    # An out-only movement is not a transfer and must not be reported as one: "what did
    # we write off last quarter" has to be answerable off `stk_ledger.ref_type` alone.
    ref_type = LEDGER_REF_BY_DISPOSITION.get(disposition or "", RefType.TRANSFER.value)

    if movement is Movement.NONE:
        # Released, not consumed: the material never left, so there is nothing to post
        # and the branch's available quantity has to come straight back.
        await allocation.release(db, RESERVE_REF_TYPE, doc.id)
    else:
        for line in list(doc.items or []):
            consumed = await allocation.consume_for_issue(
                db, RESERVE_REF_TYPE, doc.id, ref_line_id=line.id)
            moved = ZERO
            for slice_ in consumed:
                await inventory.move_stock(
                    db, line.item_id, slice_.quantity, StockDirection.OUT.value,
                    ref_type, doc.id, doc.sto_no, user,
                    warehouse_id=doc.from_warehouse_id,
                    bin_id=slice_.bin_id, batch_id=slice_.batch_id,
                    project_id=slice_.project_id,
                )
                if movement is Movement.TRANSFER:
                    await inventory.move_stock(
                        db, line.item_id, slice_.quantity, StockDirection.IN.value,
                        ref_type, doc.id, doc.sto_no, user,
                        warehouse_id=doc.to_warehouse_id,
                        bin_id=NO_BIN, batch_id=slice_.batch_id,
                        project_id=doc.to_project_id or slice_.project_id,
                    )
                moved += slice_.quantity
            line.dispatched_qty = moved
            # Only a transfer lands anywhere. Claiming a scrapped line was received
            # would put quantity on a balance that was never credited.
            line.received_qty = moved if movement is Movement.TRANSFER else ZERO

    stamped = utcnow()
    # Nobody holds it for approval any more, so the phase marker goes: `_phase_doc_type`
    # must not keep pointing decisions at a chain that has finished.
    _set_payload(doc, **{PHASE_KEY: None})
    if disposition == Disposition.REJECT_UNECONOMIC.value:
        # The return itself was refused. REJECTED is the honest status — nothing moved and
        # the branch still holds the material — and it is what stops the raiser being
        # asked to acknowledge a movement that never happened.
        doc.status = ReturnStatus.REJECTED.value
    else:
        doc.status = ReturnStatus.APPROVED.value
    doc.approved_by_name = _name(user)
    doc.approved_at = stamped
    if movement is not Movement.NONE:
        # The despatch IS this instant — the stock left the shelf in the loop above — so
        # it is stamped now rather than left NULL, which reads on inventory's own STO
        # screen as "approved but never sent". `received_at` stays NULL on purpose: it is
        # the raiser's acknowledgement, and nobody has given it yet.
        doc.dispatched_at = stamped
    await db.flush()


# ---------------------------------------------------------------------------
# The decision desk
# ---------------------------------------------------------------------------

async def _assert_at_desk(db: AsyncSession, doc: StockTransferOrder, user,
                          phase: str) -> dict:
    """Common guard for both desk verbs: right status, right phase, right person."""
    if doc.status != ReturnStatus.PENDING_APPROVAL.value:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()}, so there is "
            "nothing to decide.")
    if _phase(doc) != phase:
        raise ConflictError(
            "This return is not waiting for a decision."
            if phase == PHASE_DECISION else
            "No decision has been recorded on this return yet.")

    out = await _out(db, doc, user)
    if phase == PHASE_DECISION and not out["can_decide"]:
        raise ValidationError(
            "Deciding where returned stock goes belongs to the desk configured under "
            "Returns > Receiving approval.")
    if phase == PHASE_ENDORSE and not out["can_endorse"]:
        raise ValidationError("This return is not waiting for you to endorse it.")
    return out


async def candidate_destinations(db: AsyncSession, doc: StockTransferOrder) -> list[dict]:
    """Where this material could usefully go, worst-stocked point first.

    Every stocking point except the one it is coming from, each with how much of the
    return's items it already holds — the decider is choosing between "send it up" and
    "send it to whoever is short", and that second question cannot be answered without
    the numbers next to the names.
    """
    item_ids = [line.item_id for line in list(doc.items or [])]
    rows = list((await db.execute(
        select(Warehouse.id, Warehouse.name, Warehouse.code, Warehouse.warehouse_type)
        .where(Warehouse.is_active.is_(True),
               Warehouse.id != doc.from_warehouse_id)
        .order_by(Warehouse.name)
    )).all())
    if not rows or not item_ids:
        return [{"warehouse_id": row.id, "warehouse_name": row.name,
                 "warehouse_code": row.code, "warehouse_type": row.warehouse_type,
                 "on_hand": ZERO, "tier_label": locations.tier_label(
                     locations.tier_of(row.warehouse_type))}
                for row in rows]

    held = {warehouse_id: _d(total) for warehouse_id, total in (await db.execute(
        select(Stock.warehouse_id, func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.item_id.in_(item_ids),
               Stock.warehouse_id.in_([row.id for row in rows]))
        .group_by(Stock.warehouse_id)
    )).all()}

    out = [{
        "warehouse_id": row.id,
        "warehouse_name": row.name,
        "warehouse_code": row.code,
        "warehouse_type": row.warehouse_type,
        "tier_label": locations.tier_label(locations.tier_of(row.warehouse_type)),
        "on_hand": held.get(row.id, ZERO),
        # The point the return was addressed to when it was raised — the MDP one rung
        # above the branch. Still the likeliest answer, so it is flagged rather than
        # buried in an alphabetical list.
        "is_default": row.id == doc.to_warehouse_id,
    } for row in rows]
    # Whoever holds least of it needs it most, and the default stays at the top.
    out.sort(key=lambda row: (not row["is_default"], row["on_hand"],
                              row["warehouse_name"] or ""))
    return out


async def decision_options(db: AsyncSession, return_id: int, user=None) -> dict:
    """Everything the decision desk needs on one screen, computed server-side.

    The six outcomes with their guidance, which of them this particular return may not
    take, what the reason implies as a default, where it could go, and which vendors
    could be liable. Held here rather than assembled in the browser so the words the
    decider reads and the words the trail records are the same words.
    """
    doc = await _load(db, return_id)
    lines = list(doc.items or [])
    hazards = await _hazard_flags(db, [line.item_id for line in lines])
    hazard_names = sorted({name for names in hazards.values() for name in names})

    reason = _unpack(doc.remarks).get("reason") or ""
    default = DEFAULT_DISPOSITION_BY_REASON.get(reason)
    if default in BLOCKED_WHEN_HAZARDOUS and hazard_names:
        # A pre-selected button the service would refuse is worse than no default.
        default = Disposition.CONTROLLED_DISPOSAL.value

    options = []
    for disposition in SELECTABLE_DISPOSITIONS:
        blocked = bool(hazard_names) and disposition.value in BLOCKED_WHEN_HAZARDOUS
        options.append({
            "value": disposition.value,
            "label": DISPOSITION_LABELS[disposition.value],
            "hint": DISPOSITION_HINTS[disposition.value],
            "needs_destination": disposition.value in NEEDS_DESTINATION,
            "needs_vendor": disposition.value in NEEDS_VENDOR,
            "needs_agency": disposition.value in NEEDS_AGENCY,
            "moves_stock": MOVEMENT_BY_DISPOSITION[disposition.value] is not
            Movement.NONE,
            "is_blocked": blocked,
            "blocked_reason": (
                f"{', '.join(hazard_names)} — this cannot be scrapped at a branch. Use "
                "controlled disposal." if blocked else None),
            "is_default": disposition.value == default,
        })

    vendors = [{"id": row.id, "name": row.name, "code": row.code} for row in
               (await db.execute(
                   select(Vendor).where(Vendor.is_active.is_(True))
                   .order_by(Vendor.name).limit(200)
               )).scalars().all()]

    return {
        "dispositions": options,
        "default_disposition": default,
        "destinations": await candidate_destinations(db, doc),
        "vendors": vendors,
        "hazard_features": hazard_names,
        "value": await _value_of(db, doc),
        "intent": _intent(doc),
        "intent_label": INTENT_LABELS.get(_intent(doc), _intent(doc)),
    }


async def decide(db: AsyncSession, return_id: int, data, user) -> dict:
    """The desk saying where the material actually goes.

    Validated here and not only on the screen (rule 6's reasoning): scrapping something
    the masters flag as affecting handling is the one outcome that can hurt somebody, so
    it is refused in the service.

    Recording the decision opens the receiving chain and signs its first rung with it —
    the decision IS that rung's signature, and the reason typed here is the comment the
    endorser reads. If nobody stands behind the desk the decision is the last word and
    is carried out at once.
    """
    doc = await _load(db, return_id)
    await _assert_at_desk(db, doc, user, PHASE_DECISION)
    if doc.requested_by_id == getattr(user, "id", None):
        raise ValidationError("You cannot decide on your own return")

    disposition = data.disposition.value
    note = (data.note or "").strip()
    if not note:
        # The floor is about to read it, and "because I said so" is not a handover.
        raise ValidationError("Say why you are sending it this way — the floor reads it")

    hazards = await _hazard_flags(
        db, [line.item_id for line in list(doc.items or [])])
    hazard_names = sorted({name for names in hazards.values() for name in names})
    if hazard_names and disposition in BLOCKED_WHEN_HAZARDOUS:
        raise ValidationError(
            f"This material is flagged {', '.join(hazard_names)} and cannot be scrapped "
            "at a branch. Use controlled disposal.")

    changes: dict = {
        DECISION_KEY: disposition,
        DECISION_NOTE_KEY: note,
        DECISION_BY_KEY: _name(user),
        DECISION_AT_KEY: utcnow().isoformat(),
    }

    if disposition in NEEDS_DESTINATION:
        destination_id = data.to_warehouse_id
        if destination_id is None:
            raise ValidationError("Pick the stocking point this is going to")
        if destination_id == doc.from_warehouse_id:
            raise ValidationError("A return has to go somewhere other than where it is.")
        name = await _warehouse_name(db, destination_id)
        if name is None:
            raise ValidationError(f"Unknown stocking point {destination_id}")
        doc.to_warehouse_id = destination_id
        doc.to_warehouse_name = name
        doc.to_project_id = await locations.project_of_location(db, destination_id)

    if disposition in NEEDS_VENDOR:
        if data.vendor_id is None:
            raise ValidationError("Name the vendor this is going back to")
        vendor = await db.get(Vendor, data.vendor_id)
        if vendor is None:
            raise ValidationError(f"Unknown vendor {data.vendor_id}")
        changes[VENDOR_ID_KEY] = vendor.id
        changes[VENDOR_NAME_KEY] = vendor.name

    if disposition in NEEDS_AGENCY:
        agency = (data.disposal_agency or "").strip()
        if not agency:
            raise ValidationError(
                "Name the licensed agency that will carry out the disposal")
        changes[AGENCY_KEY] = agency

    # Snapshotted, because the manager weighed freight against THIS number and a later
    # re-costing must not rewrite the figure his reasoning is recorded against.
    value = await _value_of(db, doc)
    if value is not None:
        changes[DECISION_VALUE_KEY] = str(value)

    _set_payload(doc, **changes)
    await db.flush()

    instance = await _open_endorsement(db, doc, user, note)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        _set_payload(doc, **{PHASE_KEY: PHASE_ENDORSE})
        await db.flush()
    else:
        await _carry_out(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.PENDING_APPROVAL.value},
                      after={"status": doc.status, "disposition": disposition,
                             "note": note},
                      summary=f"Return {doc.sto_no}: "
                              f"{DISPOSITION_LABELS[disposition]}")
    await db.commit()
    return await get_return(db, return_id, user)


async def endorse(db: AsyncSession, return_id: int, comments: str, user) -> dict:
    """The floor agreeing the decision is workable. The last rung's yes moves the stock."""
    doc = await _load(db, return_id)
    await _assert_at_desk(db, doc, user, PHASE_ENDORSE)

    before = doc.status
    instance = await engine.act(
        db, ReturnDocType.STOCK_RETURN_RECEIPT.value, doc.id,
        ApprovalAction.APPROVED.value, user, comments,
        context={
            "doc_no": doc.sto_no,
            "doc_summary": f"Stock return {doc.sto_no} — decision to be endorsed",
            "from_warehouse_id": doc.from_warehouse_id,
            "to_warehouse_id": doc.to_warehouse_id,
        },
    )
    if instance.status == InstanceStatus.APPROVED.value:
        await _carry_out(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status, "comments": comments})
    await db.commit()
    return await get_return(db, return_id, user)


async def object_to_decision(db: AsyncSession, return_id: int, comments: str,
                             user) -> dict:
    """The floor saying the decision will not work, and why.

    Not a rejection: the return is not refused, the ROUTE is. So the decision is cleared,
    the document goes back to the decision desk for a fresh one, and the reservation
    stands — the branch has still promised this material and must not be able to issue it
    away while the two desks disagree.

    The receiving chain is abandoned rather than rewound: the engine freezes one chain per
    (doc_type, doc_id), and a fresh decision has to be able to open a fresh chain. The
    abandoned instance keeps its action rows (rule 9), so the objection stays in the trail.
    """
    doc = await _load(db, return_id)
    await _assert_at_desk(db, doc, user, PHASE_ENDORSE)
    note = (comments or "").strip()
    if not note:
        raise ValidationError(
            "Say what is wrong with the decision — the desk has to decide again")

    await engine.abandon(db, ReturnDocType.STOCK_RETURN_RECEIPT.value, doc.id, user,
                         f"Objection: {note}")

    objections = int(_unpack(doc.remarks).get(OBJECTIONS_KEY) or 0) + 1
    _set_payload(doc, **{
        PHASE_KEY: PHASE_DECISION,
        # Cleared, not kept: the desk is being asked for a fresh decision, and leaving the
        # old one on the document would let the screen offer "endorse" against a route the
        # floor has already refused.
        DECISION_KEY: None, DECISION_NOTE_KEY: None, DECISION_BY_KEY: None,
        DECISION_AT_KEY: None, DECISION_VALUE_KEY: None,
        VENDOR_ID_KEY: None, VENDOR_NAME_KEY: None, AGENCY_KEY: None,
        OBJECTIONS_KEY: objections,
    })
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": doc.status},
                      after={"status": doc.status, "objection": note,
                             "objections": objections},
                      summary=f"Return {doc.sto_no}: decision objected to, back to the "
                              "decision desk")
    await db.commit()
    return await get_return(db, return_id, user)


async def acknowledge_return(db: AsyncSession, return_id: int, user) -> dict:
    """The person who raised it confirming the return actually happened.

    Only they may give it. The stock has already moved by this point, so this changes
    no balance and writes no ledger row — it closes the document and records who said
    so, which is the difference between "the system moved it" and "the branch agrees
    it went".
    """
    doc = await _load(db, return_id)
    _assert_raiser(doc, user)
    if doc.status not in AWAITING_ACK:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()}, so there is "
            "nothing to acknowledge.")

    # Regulated material cannot be signed off on the agency's name alone. Enforced here as
    # well as by the missing button, because closing the document is what stops anybody
    # ever asking for the certificate again (rule 6's reasoning).
    decision = _decision_of(doc)
    if (decision and decision["disposition"] in NEEDS_AGENCY
            and not await _certificate_count(db, doc.id)):
        agency = decision.get("disposal_agency")
        raise ValidationError(
            "This was a controlled disposal. Attach the disposal certificate from "
            f"{agency} before closing the return." if agency else
            "This was a controlled disposal. Attach the licensed agency's disposal "
            "certificate before closing the return.")

    before = doc.status
    doc.status = ReturnStatus.RECEIVED.value
    doc.received_at = utcnow()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status, "acknowledged_by": _name(user)})
    await db.commit()
    return await get_return(db, return_id, user)


def _went_to(doc: StockTransferOrder, decision: dict | None) -> str:
    """Where the material actually ended up, for the movement leg.

    Only SEND_TO_POINT lands on another stocking point. The other three movements leave
    our books, and `to_warehouse_id` still holds the point the return was ADDRESSED to
    when it was raised — so printing it made a drum sent for incineration read as though
    it had been received at the MDP.
    """
    disposition = (decision or {}).get("disposition")
    if disposition == Disposition.TO_VENDOR.value:
        return (decision or {}).get("vendor_name") or "the vendor"
    if disposition == Disposition.CONTROLLED_DISPOSAL.value:
        agency = (decision or {}).get("disposal_agency")
        return f"disposal by {agency}" if agency else "controlled disposal"
    if disposition == Disposition.SCRAP.value:
        return "scrapped at the branch"
    return doc.to_warehouse_name or "—"


async def journey(db: AsyncSession, return_id: int, user=None) -> dict:
    """The seven-leg tracker, built from the document's own status, the marker payload
    and the engine's action rows — never from a second copy of the flow kept in the
    browser.

    A rejection or a withdrawal halts the flow: every leg after the one that stopped
    stays pending, so a refused return can never render as though the stock moved.
    """
    doc = await _load(db, return_id)
    actions = await engine.history(db, ReturnDocType.STOCK_RETURN.value, return_id)
    receipt_actions = await engine.history(
        db, ReturnDocType.STOCK_RETURN_RECEIPT.value, return_id)
    status = doc.status
    phase = _phase(doc)
    pending = status == ReturnStatus.PENDING_APPROVAL.value
    at_decision = pending and phase == PHASE_DECISION
    at_endorsement = pending and phase == PHASE_ENDORSE
    past_field = at_decision or at_endorsement

    decision = _decision_of(doc)
    disposition = (decision or {}).get("disposition")
    # Nothing-moves outcomes end the document without a movement, and the tracker has to
    # say that rather than draw a movement leg that never happened.
    static = disposition in {Disposition.USE_AT_SOURCE.value,
                            Disposition.REJECT_UNECONOMIC.value}
    refused = disposition == Disposition.REJECT_UNECONOMIC.value

    submitted = status != ReturnStatus.DRAFT.value
    settled = status in {ReturnStatus.APPROVED.value, ReturnStatus.RECEIVED.value}
    moved = settled and not static
    acknowledged = status == ReturnStatus.RECEIVED.value

    approvals_state = "pending"
    if pending:
        # Past the field chain the moment either desk holds it.
        approvals_state = "completed" if past_field else "current"
    elif status == ReturnStatus.REJECTED.value:
        # A refusal at the decision desk stops the flow THERE, not at the field chain:
        # those rungs really did sign, and the trail says so.
        approvals_state = "completed" if (refused or receipt_actions) else "rejected"
    elif status == ReturnStatus.CANCELLED.value:
        approvals_state = "cancelled"
    elif settled:
        approvals_state = "completed"

    decision_state = "pending"
    if at_decision:
        decision_state = "current"
    elif decision or at_endorsement or settled:
        decision_state = "completed"
    elif status == ReturnStatus.CANCELLED.value:
        decision_state = "cancelled"

    endorsement_state = "pending"
    if at_endorsement:
        endorsement_state = "current"
    elif settled and receipt_actions:
        endorsement_state = "completed"
    elif settled:
        # Decided with nobody standing behind the desk — a configuration fact, not a step
        # that silently passed.
        endorsement_state = "completed"
    elif status == ReturnStatus.CANCELLED.value and receipt_actions:
        endorsement_state = "cancelled"

    movement_state = "pending"
    if settled:
        movement_state = "completed"
    elif status == ReturnStatus.REJECTED.value and refused:
        movement_state = "cancelled"

    states = {
        "draft": "completed" if submitted else "current",
        "submitted": "completed" if submitted else "pending",
        "approvals": approvals_state,
        "decision": decision_state,
        "endorsement": endorsement_state,
        "movement": movement_state,
        "acknowledged": (
            "completed" if acknowledged
            else "current" if settled and not refused
            else "pending"
        ),
    }

    approver_names: list[str] = []
    if at_decision:
        desk = await receiving.decision_desk(db)
        approver_names = [h["name"] for h in (desk or {}).get("holders", [])
                          if h.get("name")]
    elif pending:
        approvers = await engine.current_approvers(db, _phase_doc_type(doc), doc.id)
        approver_names = [a.full_name for a in approvers if a.full_name]

    def _signed(rows) -> list:
        return [a for a in rows if a.action in {ApprovalAction.APPROVED.value,
                                                ApprovalAction.REJECTED.value}]

    decided = _signed(actions)
    endorsed = _signed(receipt_actions)
    objections = int((decision or {}).get("objections") or
                     _unpack(doc.remarks).get(OBJECTIONS_KEY) or 0)
    captions = {
        "draft": "Raised" if submitted else "Not submitted yet",
        "submitted": doc.created_at.strftime("%d %b %Y") if doc.created_at else "—",
        "approvals": (
            ", ".join(approver_names) or "Waiting for an approver"
            if approvals_state == "current"
            else f"{len(decided)} signed"
            if approvals_state == "completed" and decided
            else ""
        ),
        "decision": (
            ", ".join(approver_names) or "Waiting for the decision desk"
            if decision_state == "current"
            else " · ".join(part for part in (
                DISPOSITION_LABELS_SHORT.get(disposition or "", ""),
                (decision or {}).get("decided_by_name") or "",
                f"sent back {objections}×" if objections else "",
            ) if part)
            if decision
            else "No decision desk is configured" if settled
            else ""
        ),
        "endorsement": (
            ", ".join(approver_names) or "Waiting for the floor"
            if endorsement_state == "current"
            else ", ".join(name for name in (a.actor_name for a in endorsed) if name)
            if endorsed
            else "No sign-off is configured" if settled else ""
        ),
        "movement": (
            "Nothing moved — the branch keeps it" if settled and static
            else f"{doc.from_warehouse_name or '—'} → {_went_to(doc, decision)}"
            if moved
            else "Refused — nothing moved" if refused
            else "Moves when the decision is endorsed"
        ),
        "acknowledged": (
            "Confirmed by the returner" if acknowledged
            else "Waiting for the disposal certificate"
            if settled and disposition in NEEDS_AGENCY
            and not await _certificate_count(db, doc.id)
            else "Waiting for the returner to confirm" if settled and not refused
            else ""
        ),
    }

    # Everything after a halt is pending, whatever the per-leg rule above decided.
    halted_at = next((index for index, (key, _) in enumerate(PHASES)
                      if states[key] in {"rejected", "cancelled"}), None)
    phases = []
    for index, (key, label) in enumerate(PHASES):
        state = states[key]
        if halted_at is not None and index > halted_at:
            state = "pending"
        phases.append({
            "key": key,
            "label": label,
            "sequence": index + 1,
            "state": state,
            "caption": captions.get(key) or None,
        })

    current = next((p for p in phases if p["state"] in {"current", "rejected",
                                                        "cancelled"}), None)
    return {
        "status": status,
        "phases": phases,
        "current_sequence": current["sequence"] if current else len(phases),
        "current_stage_message": _stage_message(
            status, approver_names, at_decision=at_decision,
            at_endorsement=at_endorsement, disposition=disposition),
    }


def _stage_message(status: str, approver_names: list[str], *,
                   at_decision: bool = False, at_endorsement: bool = False,
                   disposition: str | None = None) -> str:
    waiting_for = ", ".join(approver_names)
    static = disposition in {Disposition.USE_AT_SOURCE.value,
                            Disposition.REJECT_UNECONOMIC.value}
    pending = (
        f"With the decision desk — waiting for {waiting_for}"
        if at_decision and waiting_for
        else "With the decision desk — where the stock goes has still to be decided"
        if at_decision
        else f"Decision recorded — waiting for {waiting_for} to endorse it"
        if at_endorsement and waiting_for
        else "Decision recorded — waiting for the floor to endorse it"
        if at_endorsement
        else f"Waiting for {waiting_for}" if waiting_for
        else "Submitted — waiting for approval")
    messages = {
        ReturnStatus.DRAFT.value: "Draft — submit the return to begin approval",
        ReturnStatus.PENDING_APPROVAL.value: pending,
        ReturnStatus.APPROVED.value: (
            "Nothing moved — the branch keeps the stock. Waiting for the returner to "
            "acknowledge" if static
            else "Stock moved — waiting for the returner to acknowledge"),
        ReturnStatus.RECEIVED.value: "Return completed and acknowledged",
        ReturnStatus.REJECTED.value: (
            "Refused as uneconomic — nothing moved and the branch keeps the stock"
            if disposition == Disposition.REJECT_UNECONOMIC.value
            else "Return rejected — the stock stayed where it is"),
        ReturnStatus.CANCELLED.value: "Withdrawn by the person who raised it",
    }
    return messages.get(status, status.replace("_", " ").title())


async def cancel_return(db: AsyncSession, return_id: int, user) -> dict:
    """The raiser withdrawing their own return before it is decided."""
    doc = await _load(db, return_id)
    _assert_raiser(doc, user)
    if doc.status not in EDITABLE | HOLDING_STOCK:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()} and can no longer "
            "be withdrawn.")

    before = doc.status
    if doc.status in HOLDING_STOCK:
        await allocation.release(db, RESERVE_REF_TYPE, doc.id)
        # Closes the approval rather than deleting it: a wf_actions row is never
        # removed (rule 9), so the withdrawal stays part of the document's story.
        # Both chains, whichever is live — abandon is a no-op on one that is not.
        for doc_type in (ReturnDocType.STOCK_RETURN.value,
                         ReturnDocType.STOCK_RETURN_RECEIPT.value):
            await engine.abandon(db, doc_type, doc.id, user,
                                 "Withdrawn by the person who raised it")
    doc.status = ReturnStatus.CANCELLED.value

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status})
    await db.commit()
    return await get_return(db, return_id, user)


# ---------------------------------------------------------------------------
# Photos and paperwork
# ---------------------------------------------------------------------------

async def list_files(db: AsyncSession, return_id: int) -> list:
    await _load(db, return_id)
    return await attachments.list_attachments(db, ENTITY_TYPE, return_id)


async def _photo_count(db: AsyncSession, return_id: int) -> int:
    """How many pictures of the material are on this return. Documents do not count —
    a GRN scan is paperwork, not a look at what is coming back."""
    rows = await attachments.list_attachments(db, ENTITY_TYPE, return_id)
    return sum(1 for row in rows if (row.doc_category or "") == PHOTO_CATEGORY)


async def _certificate_count(db: AsyncSession, return_id: int) -> int:
    """How many disposal certificates are on file. Its own count, not a document count:
    the gate is "the agency certified the destruction", and an inward bill is not that."""
    rows = await attachments.list_attachments(db, ENTITY_TYPE, return_id)
    return sum(1 for row in rows if (row.doc_category or "") == CERTIFICATE_CATEGORY)


async def _may_post_certificate(db: AsyncSession, doc: StockTransferOrder, user) -> bool:
    """Whether this login may post the certificate for THIS return.

    The one exception to "attachments freeze at submit", and it is narrow on purpose: only
    for a decision that is a controlled disposal, only while one is still owed, and only
    for the raiser holding the material or the desk that took the decision.
    """
    decision = _decision_of(doc)
    if not decision or decision["disposition"] not in NEEDS_AGENCY:
        return False
    if doc.status not in AWAITING_ACK:
        return False
    if await _certificate_count(db, doc.id) > 0:
        return False
    if doc.requested_by_id == getattr(user, "id", None):
        return True
    desk = await receiving.decision_desk(db)
    return getattr(user, "id", None) in {
        holder["id"] for holder in (desk or {}).get("holders", [])}


async def add_file(db: AsyncSession, return_id: int, upload, doc_category: str, user):
    doc = await _load(db, return_id)
    # The certificate is the one file that arrives AFTER the document has been worked: the
    # agency destroys the material and hands the paperwork over days later. Checked before
    # the draft guard, because by then the return is long out of DRAFT.
    if doc_category == CERTIFICATE_CATEGORY and doc.status not in EDITABLE:
        if not await _may_post_certificate(db, doc, user):
            raise ConflictError(
                "A disposal certificate can only be posted while one is still owed, and "
                "only by the person who raised the return or the desk that decided it.")
        return await attachments.add_attachment(
            db, entity_type=ENTITY_TYPE, entity_id=return_id, upload=upload,
            doc_category=doc_category, user=user)

    # Once it is out of the raiser's hands the evidence is what the approvers saw. A
    # photograph added after the fact would change the document under them.
    if doc.status not in EDITABLE:
        raise ConflictError(
            "This return has been submitted, so its photographs and bills can no "
            "longer be changed.")
    _assert_raiser(doc, user)
    return await attachments.add_attachment(
        db, entity_type=ENTITY_TYPE, entity_id=return_id, upload=upload,
        doc_category=doc_category, user=user)


async def delete_file(db: AsyncSession, return_id: int, attachment_id: int,
                      user) -> None:
    doc = await _load(db, return_id)
    if doc.status not in EDITABLE:
        raise ConflictError(
            "This return has been submitted, so its photographs and bills can no "
            "longer be changed.")
    _assert_raiser(doc, user)
    await attachments.delete_attachment(db, attachment_id, user)


# ---------------------------------------------------------------------------
# The purchase-return register — read only
# ---------------------------------------------------------------------------

async def list_purchase_returns(db: AsyncSession, params: PageParams, *,
                                status: str | None = None,
                                search: str | None = None,
                                user=None) -> dict:
    """The other family of return, listed beside this module's own.

    `pro_returns` is the warehouse module's table and stays that way: this reads it so the
    register can show both families in one place, and writes nothing. Acting on a purchase
    return — the draft, the vendor's answer, the credit note — is the warehouse module's
    endpoints, and is the next phase of this work rather than part of it.

    Shaped to the same keys the field register uses (`return_no`, `status`, `kind`, …) so
    one table renders both without the screen branching per row.
    """
    stmt = select(PurchaseReturn)
    # FIXED 2026-08-20 — was unscoped while this module's OWN register
    # (`list_returns`) is bounded by the login's stocking points. Half of one screen
    # obeying the rung and the other half ignoring it is worse than either: a login saw
    # their own branch's field returns beside every branch's purchase returns, vendor
    # named. Bounded on the warehouse that raised it, with the raiser as the fallback.
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=PurchaseReturn.warehouse_id,
            owner_col=PurchaseReturn.created_by_id,
        ))
    if status:
        stmt = stmt.where(PurchaseReturn.status == status)
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(
            PurchaseReturn.return_no.ilike(like),
            PurchaseReturn.vendor_name.ilike(like),
            PurchaseReturn.po_no.ilike(like),
            PurchaseReturn.grn_no.ilike(like),
            PurchaseReturn.warehouse_name.ilike(like),
        ))

    page = await paginate(db, stmt.order_by(PurchaseReturn.id.desc()), params)
    rows = list(page["items"])
    counts = {}
    if rows:
        counts = {return_id: int(count) for return_id, count in (await db.execute(
            select(PurchaseReturnItem.return_id, func.count(PurchaseReturnItem.id))
            .where(PurchaseReturnItem.return_id.in_([row.id for row in rows]))
            .group_by(PurchaseReturnItem.return_id)
        )).all()}

    page["items"] = [{
        "id": row.id,
        "return_no": row.return_no,
        "status": row.status,
        "kind": ReturnKind.PURCHASE.value,
        "kind_label": KIND_LABELS[ReturnKind.PURCHASE.value],
        "return_date": row.return_date.isoformat() if row.return_date else None,
        "po_id": row.po_id,
        "po_no": row.po_no,
        "grn_id": row.grn_id,
        "grn_no": row.grn_no,
        "vendor_id": row.vendor_id,
        "vendor_name": row.vendor_name,
        "warehouse_id": row.warehouse_id,
        "warehouse_name": row.warehouse_name,
        "reason": row.reason,
        "total_items": counts.get(row.id, row.total_items or 0),
        "total_qty": _d(row.total_qty),
        # Unlike a field return this one IS costed — the rate came off the GRN line — so
        # the value is a real number rather than an em dash.
        "total_value": _d(row.total_value),
        "credit_note_no": row.credit_note_no,
        "created_by_name": row.created_by_name,
        "created_at": row.created_at,
    } for row in rows]
    return page
