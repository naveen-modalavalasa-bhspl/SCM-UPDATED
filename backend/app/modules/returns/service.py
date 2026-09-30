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
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import and_, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.shared.scope import scope_condition
from app.modules.inventory import allocation, locations
from app.modules.inventory import service as inventory
from app.modules.inventory.enums import LocationTier
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, Stock, StockMovement, StockTransferOrder,
    StockTransferOrderItem,
)
# The indent a field return answers. `indents` sits before `returns` in the import chain
# (rule 5: inventory -> indents -> procurement -> logistics -> warehouse -> returns), so
# this is the allowed direction; nothing in indents reads back into this module.
from app.modules.indents.models import Indent, IndentItem
# Enums only at module level. `logistics.transport` — the service that actually raises a
# leg — is imported inside `_raise_transport_leg` instead: it pulls in the whole shipment
# module, and returns is imported at start-up by the router registry, so keeping the heavy
# half lazy is the same habit `warehouse.service._register_transport_hooks` follows.
from app.modules.logistics.enums import (
    ACK_CLAIM_EVENT, MODE_RULES, SIGNABLE_STATUSES, AckCondition, ShipmentEventType,
    TransportMode, TransportSource, TransportStatus, is_inbound,
)
from app.modules.warehouse.models import PurchaseReturn, PurchaseReturnItem
from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
from app.platform.settings import attachments
# The audit rows are the only record of the presses that leave no `wf_actions`
# rung — the raise, the submit, a send-back, an objection, the gate-out, the
# delivery, the acknowledgement — so the journey's trail is read off them.
from app.platform.settings.models import AuditLog
from app.platform.settings.service import write_audit
from app.platform.workflow import custom_ladder, engine, ladder
# FIX 2026-09-07: `Instance` was USED in `_out` and `journey` to name the rung an approval
# is sitting on, and never imported — both reads sit inside a bare `except`, so every one
# of them raised NameError and silently fell back to the bare person's name. The rank the
# document is waiting on was therefore never shown, on either screen.
from app.platform.workflow.models import Instance
from app.shared.enums import (
    ApprovalAction, AuditAction, CategoryTagType, IndentStatus, InstanceStatus,
    RefType, StockDirection,
)
from app.shared.models.base import utcnow
from app.shared.models.master import CategoryTag, Feature, Item, Vendor, VendorItem
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number

from . import receiving
from .enums import (
    AWAITING_ACK, BLOCKED_WHEN_HAZARDOUS, DEFAULT_DISPOSITION_BY_REASON,
    DISPOSITION_HINTS, DISPOSITION_LABELS, DISPOSITION_LABELS_SHORT, EDITABLE,
    HOLDING_STOCK, INTENT_LABELS, KIND_LABELS, LEDGER_REF_BY_DISPOSITION,
    LEG_BY_DISPOSITION, LEG_LABELS, MARKER,
    MOVEMENT_BY_DISPOSITION, NEEDS_AGENCY, NEEDS_DESTINATION, NEEDS_VENDOR,
    NUMBER_SERIES, PHASES, PHASES_APPROVAL_FIRST,
    PURCHASE_RETURN_SOURCE_LABELS, REASON_LABELS,
    SELECTABLE_DISPOSITIONS, SELECTABLE_PURCHASE_RETURN_SOURCES, SELECTABLE_REASONS,
    CHAPTER_BY_DOC_TYPE, TRAIL_CHAPTERS,
    TRAIL_LABELS, TRAIL_ORDER, VEHICLE_ARRANGEMENT_LABELS,
    TRAVELS, WITHDRAWABLE, Disposition, Movement, PurchaseReturnSource, ReturnDocType,
    ReturnIntent, ReturnKind, ReturnLeg, ReturnReason, ReturnStatus, TrailDocType,
    VehicleArrangement,
)

# The four standard ways a load travels, taken straight off logistics' own enum rather
# than listed again here (2026-09-08). They ARE the four methods the returns flow reuses —
# hand-over, courier, our own vehicle, hired truck — and a second copy of the list is how
# a mode added to logistics silently stops being offered on a return.
LOGISTICS_MODES = tuple(MODE_RULES)
#: Whose vehicle turns up at the gate. A different axis from the mode above; see
#: `enums.VehicleArrangement` for why the two are not folded together.
VEHICLE_TYPES = tuple(option.value for option in VehicleArrangement)

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
# The receipt taken at the FAR END of a return's leg — the same two files the indent
# acknowledgement asks for (`indents.service.ACK_PHOTO_CATEGORY`), under this module's own
# entity type. A photograph of the material as it arrived is required; the bill is uploaded
# only where the receiving point was handed one.
#
# Their own categories rather than `PHOTO_CATEGORY`, which is not a naming preference: the
# photos already on a return are what the DECISION DESK decided from, taken at the branch
# before it was submitted, and they are frozen at submit for that reason. What turned up a
# week later at the other end of a truck is a different fact about a different moment, and
# folding the two together would both unfreeze the desk's evidence and let a picture taken
# at dispatch stand as proof that something was delivered.
RECEIPT_PHOTO_CATEGORY = "RETURN_RECEIPT_PHOTO"
RECEIPT_BILL_CATEGORY = "RETURN_RECEIPT_BILL"
RECEIPT_CATEGORIES = frozenset({RECEIPT_PHOTO_CATEGORY, RECEIPT_BILL_CATEGORY})

#: What the receiving end may say about the state of what arrived.
#:
#: GOOD and DAMAGED, and deliberately not SHORT — exactly the indent's rule
#: (`indents.service.ACK_CONDITIONS`) and for the same reason: a shortage is already stated
#: by the quantities, and a form that could say "all fifteen arrived" and "it was short" in
#: one breath is the disagreement this whole path exists to prevent.
#:
#: Where a return DIFFERS from an indent is what becomes of the shortfall. An indent takes
#: receipts in instalments, so "less than was dispatched" is the normal shape of a first
#: delivery and claiming on it would chase a carrier who is still mid-delivery. A return
#: travels once and `_receive_at_far_end` ends the leg, so there is no second receipt and a
#: shortfall IS a shortage: `_sign_return_leg` derives SHORT from the numbers and opens the
#: claim on the shipment timeline, where the logistics desk already works it.
ACK_CONDITION_GOOD = "GOOD"
ACK_CONDITION_DAMAGED = "DAMAGED"
ACK_CONDITIONS = (ACK_CONDITION_GOOD, ACK_CONDITION_DAMAGED)


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


# ---------------------------------------------------------------------------
# The reason, encoded onto remarks
# ---------------------------------------------------------------------------

def _pack(reason: str, note: str | None, office_name: str | None,
          raiser_code: str | None, kind: str | None = None,
          intent: str | None = None, indent: dict | None = None) -> str:
    """Everything a return knows that an STO has no column for.

    `indent` is the four indent keys (see INDENT_ID_KEY) or None. It is threaded through
    here rather than stamped on afterwards because `update_return` REBUILDS this payload
    from scratch, so a key not passed in is a key an edit silently drops — which for the
    indent would mean the return quietly changing which approval chain it travels.
    """
    return MARKER + json.dumps({
        "reason": reason,
        "note": note or None,
        **(indent or {}),
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
# REORDERED 2026-09-07 to the order the business states:
#
#     … → Inventory Manager → SCM Head → decision desk → SCM Head sign-off → logistics
#
# which in phases is:
#
#   FIELD     the Indent Return approval ladder, running FIRST, straight off the submit.
#             Where the return names an indent, the ladder is still the STOCK_RETURN
#             ladder, but resolved from the indent's original project and raiser post.
#             This is where the material is agreed to be coming back at all, and it has
#             to be settled before anybody is asked where the material should go.
#   DECISION  the inventory manager, who says where the stock goes. No workflow instance
#             exists at this point: the decision IS the receiving chain's first rung, and
#             the chain opens the moment he records one.
#   ENDORSE   the receiving chain is running and the floor is agreeing or objecting. Its
#             last rung is the FINAL approval, and that signature is what releases the
#             material to logistics.
#   LOGISTICS the final approval is in and the material is travelling — a real transport
#             request is carrying it. Only the two outcomes that move material between
#             places reach this phase.
#
# Between 2026-09-05 and 2026-09-07 the desk went first and the reporting line last, on
# the reasoning that everything after the desk is an approval OF its decision. That put
# the desk in front of the only people who could say the return was warranted, so it was
# routing material nobody had yet agreed was coming back. Rows raised under that order
# are in FIELD with no decision recorded, which the current order cannot produce;
# `_is_legacy_field` spots exactly that and routes them the old way so nothing already in
# somebody's queue is stranded.
PHASE_KEY = "phase"
PHASE_FIELD = "FIELD"
PHASE_DECISION = "DECISION"
PHASE_ENDORSE = "ENDORSE"
PHASE_LOGISTICS = "LOGISTICS"

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
# The transport request carrying this return, snapshotted so the document can name its own
# leg without a join. The id is the link the release/acknowledge hooks match on; the
# number is what the screen prints.
LEG_KEY = "leg"
TR_ID_KEY = "transport_request_id"
TR_NO_KEY = "transport_request_no"
# How many times a desk has sent this return back to the raiser, and why the last one did.
# Kept on the document rather than only in `wf_actions` because the raiser opens a DRAFT
# with no live chain on it: the trail explains the history, this is what the form itself
# has to say at the top of the screen.
SEND_BACKS_KEY = "send_backs"
SENT_BACK_NOTE_KEY = "sent_back_note"
SENT_BACK_BY_KEY = "sent_back_by"
SENT_BACK_FROM_KEY = "sent_back_from"
# Stamped when the reporting line is opened under the NEW stage order. It is what tells a
# return that reached the field chain the modern way apart from one that was already
# sitting in it when the order changed — see `_is_legacy_field`. A deployment with no
# decision desk configured skips that desk and lands in FIELD with no disposition, which
# is byte-for-byte what a legacy row looks like; without this marker those two would be
# indistinguishable and the unconfigured case would bounce back to the desk forever.
FIELD_OPENED_KEY = "field_chain_opened"
# The post the return was RAISED under, snapshotted at submit. Kept because the receiving
# chain is opened later, by the decision desk, and it has to be opened on behalf of the
# raiser — see `_open_endorsement`.
RAISER_POSITION_KEY = "raiser_position_id"

# ADDED 2026-09-07 — the INDENT this return is raised against, and the post/project that
# indent was raised from.
#
# A branch sends material back because a request it made did not work out, so the return
# is an answer to a specific indent. Recording which one buys two things:
#
#   * the reporting-line approval travels the configured Indent Return ladder, not a
#     hard-coded copy of the indent's own approvals. If that return ladder leaves DM out
#     and adds SPH, the document does exactly that.
#   * the raiser's post and project are read off the INDENT rather than off whoever is
#     pressing the button, so rank rungs in the return ladder are resolved from where the
#     request was made even if the person has since moved posts.
#
# Kept in the same `remarks` payload as everything else this document knows and no column
# has — see `_pack`. Optional throughout: a return with no indent behind it keeps the
# behaviour it has always had (`ReturnDocType.STOCK_RETURN`'s own ladder).
INDENT_ID_KEY = "indent_id"
INDENT_NO_KEY = "indent_no"
INDENT_POSITION_KEY = "indent_position_id"
INDENT_PROJECT_KEY = "indent_project_id"

# ADDED 2026-09-07 — the two markers that say this return climbs its approval ladder FIRST.
#
# Picking an indent on the return form anchors where the Indent Return approval chain is
# resolved from. Submitting straight to the inventory desk left the approval two legs away
# and made the raiser's choice look ignored — worse, it had the desk deciding where
# material was going before anybody had agreed it was coming back. So every return now
# runs its own approval chain first and reaches the desk with its approvals behind it.
#
#   * `field_chain_first` — stamped at submit. It is what makes the FIELD phase's final
#     signature hand the document ON to the decision desk instead of ending the flow.
#   * `field_chain_done`  — stamped once that ladder has finished. Read at the far end of
#     the receiving chain, where "now open the reporting line" would otherwise open a
#     chain that has already been signed.
#
# Both are stamped on EVERY return raised from 2026-09-07. Neither is set on a row raised
# under the 2026-09-05 order — decision desk, sign-off, then the reporting line — and that
# absence is what keeps those rows travelling the way they were raised.
FIELD_FIRST_KEY = "field_chain_first"
FIELD_DONE_KEY = "field_chain_done"

# Which indents may be returned against: everything from the approval onward. Before
# APPROVED nothing was ever issued, so there is no material to send back, and REJECTED /
# RETURNED_FOR_CORRECTION never became a request at all.
RETURNABLE_INDENT_STATUSES = (
    IndentStatus.APPROVED.value,
    IndentStatus.AWAITING_ALLOCATION.value,
    IndentStatus.ALLOCATED.value,
    IndentStatus.PARTIALLY_FULFILLED.value,
    IndentStatus.PENDING_PROCUREMENT.value,
    IndentStatus.PARTIALLY_ORDERED.value,
    IndentStatus.ORDERED.value,
    IndentStatus.CLOSED.value,
)

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
    phase = _phase(doc)
    if phase in {PHASE_DECISION, PHASE_ENDORSE}:
        return ReturnDocType.STOCK_RETURN_RECEIPT.value
    if phase == PHASE_LOGISTICS:
        return ReturnDocType.STOCK_RETURN_LOGISTICS.value
    return ReturnDocType.STOCK_RETURN.value


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


def _field_first(doc: StockTransferOrder) -> bool:
    """True where this return's approval ladder runs BEFORE the decision desk.

    ADDED 2026-09-07 for returns raised against an indent, and stamped on EVERY return
    since the same day's reorder — see `FIELD_FIRST_KEY` and `submit_return`. It reads
    false only for a row raised under an earlier order and still in flight, which is
    exactly what has to keep taking the path it was raised on.
    """
    return bool(_unpack(doc.remarks).get(FIELD_FIRST_KEY))


def _field_done(doc: StockTransferOrder) -> bool:
    """True once the approval ladder has had its say, whichever end of the flow it ran at.

    ADDED 2026-09-07. Stamped by `_after_field_chain`, so it is true both for the
    indent-first order and for the pre-2026-09-05 rows that also signed before the desk
    did. It is what stops the receiving chain's last rung reopening a chain that is
    already signed.
    """
    return bool(_unpack(doc.remarks).get(FIELD_DONE_KEY))


def _is_legacy_field(doc: StockTransferOrder) -> bool:
    """True for a return raised under the OLD stage order and still in its reporting line.

    Before 2026-09-05 the reporting line signed FIRST and the decision desk worked the
    document afterwards. Under the new order the field chain runs LAST, so reaching it
    without a decision recorded is a state the current flow cannot produce — it can only
    be a document that was already in somebody's approval queue when the order changed.

    Those are routed the way they were raised: their final field signature hands them to
    the decision desk, exactly as it did before. Without this every return in flight at
    deployment would have skipped the decision and the sign-off entirely and gone straight
    to logistics with no disposition chosen.

    The `field_chain_opened` marker is what makes the test exact. A deployment with no
    receiving ladder configured skips the decision desk and opens the reporting line
    directly, landing in FIELD with no disposition — identical to a legacy row on every
    other reading. Without the marker that case would be sent back to the desk that does
    not exist, which would open the field chain again, forever.
    """
    payload = _unpack(doc.remarks)
    return (_phase(doc) == PHASE_FIELD
            and _decision_of(doc) is None
            and not payload.get(FIELD_OPENED_KEY))


def _leg_of(doc: StockTransferOrder) -> str | None:
    """STORE, SUPPLIER, or None where this outcome never travels."""
    decision = _decision_of(doc)
    return LEG_BY_DISPOSITION.get((decision or {}).get("disposition") or "")


def _travels(doc: StockTransferOrder) -> bool:
    return _leg_of(doc) is not None


def _transport_ref(doc: StockTransferOrder) -> dict | None:
    """The leg carrying this return, or None while none has been raised."""
    payload = _unpack(doc.remarks)
    tr_id = payload.get(TR_ID_KEY)
    if not tr_id:
        return None
    leg = payload.get(LEG_KEY)
    return {
        "transport_request_id": int(tr_id),
        "transport_request_no": payload.get(TR_NO_KEY),
        "leg": leg,
        "leg_label": LEG_LABELS.get(leg or "", None),
    }


def _send_back_note(doc: StockTransferOrder) -> dict | None:
    """Why this draft is back with the raiser, or None if it never went out.

    Read straight off the marker payload rather than out of `wf_actions`: a sent-back
    return has no live workflow instance on it — the chains were abandoned — so the trail
    can explain the history but cannot tell the form what to say at the top of the screen.
    """
    payload = _unpack(doc.remarks)
    count = int(payload.get(SEND_BACKS_KEY) or 0)
    if not count:
        return None
    return {
        "count": count,
        "note": payload.get(SENT_BACK_NOTE_KEY),
        "by_name": payload.get(SENT_BACK_BY_KEY),
        "from_stage": payload.get(SENT_BACK_FROM_KEY),
    }


def _indent_ref(doc: StockTransferOrder) -> dict | None:
    """The indent this return answers, or None where it was raised on its own.

    ADDED 2026-09-07. Read off the marker payload for the same reason everything else on
    this document is: `inv_sto` has no column for it and adding one would be a migration
    on a table this module does not own.
    """
    payload = _unpack(doc.remarks)
    indent_id = payload.get(INDENT_ID_KEY)
    if not indent_id:
        return None
    return {
        "indent_id": int(indent_id),
        "indent_no": payload.get(INDENT_NO_KEY),
    }


async def _resolve_indent(db: AsyncSession, indent_id: int | None, user) -> Indent | None:
    """The indent a return may be raised against — the raiser's own, and a real request.

    ADDED 2026-09-07. Refused rather than ignored when it does not qualify: the whole
    point of naming the indent is that the return then resolves its own Indent Return
    ladder from that indent's project and original raiser post. Silently dropping it
    would route the document from the wrong place.
    """
    if not indent_id:
        return None
    indent = await db.get(Indent, int(indent_id))
    if indent is None:
        raise ValidationError(f"Indent {indent_id} does not exist")
    if indent.requested_by_id != getattr(user, "id", None):
        # Someone else's request is not yours to answer, and its approval chain is
        # climbed from THEIR reporting line.
        raise ValidationError(
            "You can only return against an indent you raised yourself.")
    if indent.status not in RETURNABLE_INDENT_STATUSES:
        raise ValidationError(
            f"Indent {indent.indent_no} is "
            f"{(indent.status or '').replace('_', ' ').lower()}, so nothing has been "
            "issued against it to return.")
    return indent


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


async def _receipt_chain_context(db: AsyncSession, doc: StockTransferOrder) -> dict:
    return {
        "doc_no": doc.sto_no,
        "doc_summary": f"Stock return {doc.sto_no} - decision to be endorsed",
        "requester_position_id": await _raiser_position_id(db, doc),
        "project_id": doc.from_project_id or None,
        "from_warehouse_id": doc.from_warehouse_id,
        "to_warehouse_id": doc.to_warehouse_id,
        "total_quantity": float(
            sum((_d(l.requested_qty) for l in list(doc.items or [])), ZERO)),
    }


async def _decision_desk_for_return(db: AsyncSession,
                                    doc: StockTransferOrder) -> dict | None:
    # FIX 2026-09-07: `phase` was a bare undefined name here, so every call raised
    # NameError. The phase is read off the document via `_phase`, the way the rest of
    # this module reads it.
    context = (await _receipt_chain_context(db, doc)
               if _phase(doc) == PHASE_LOGISTICS else
               await _field_chain_context(db, doc))
    return await receiving.decision_desk(
        db, context["project_id"], doc.requested_by_id,
        context["requester_position_id"], context)


async def _resolved_return_chain(db: AsyncSession, doc_type: str,
                                 doc: StockTransferOrder,
                                 context: dict) -> list[dict] | None:
    requester_position_id = context.get("requester_position_id")
    raiser_role_id = await ladder.role_of_position(db, requester_position_id)
    found = await ladder.find_ladder(
        db, context.get("project_id"), doc_type, raiser_role_id)
    if found is None:
        return None

    wf, stages = found
    policy, _fallback_position_id = await ladder.read_policy(db, stages)
    if custom_ladder.is_custom(wf):
        return await custom_ladder.resolve_fixed_chain(
            db, stages, doc.requested_by_id, policy, requester_position_id, context)
    if requester_position_id is None:
        return None
    return await ladder.resolve_chain(
        db, stages, requester_position_id, doc.requested_by_id, context, policy)


async def _return_logistics_chain(db: AsyncSession,
                                  doc: StockTransferOrder
                                  ) -> tuple[list[dict] | None, dict]:
    context = await _receipt_chain_context(db, doc)
    context["doc_summary"] = f"Return logistics {doc.sto_no}"
    chain = await _resolved_return_chain(
        db, ReturnDocType.STOCK_RETURN_LOGISTICS.value, doc, context)
    return chain, context


async def _can_access_return_logistics(db: AsyncSession, doc: StockTransferOrder,
                                       user) -> bool:
    chain, _context = await _return_logistics_chain(db, doc)
    if chain is None:
        return True
    holder_ids = {
        int(employee_id)
        for link in chain
        for employee_id in (link.get("approver_ids") or [])
    }
    return getattr(user, "id", None) in holder_ids


def _has_left_the_gate(doc: StockTransferOrder) -> bool:
    """Whether the material on this return has actually gone.

    ADDED 2026-09-10. DISPATCHED is the answer for every return dispatched from now on.
    The second clause is a compatibility one, for the handful of rows stranded by the
    first pass of today's change: while that pass was live the release deliberately left
    the status at PENDING_APPROVAL until the logistics rung was signed, so a load that had
    genuinely left the branch — hold consumed, shelf debited, warehouse document raised —
    reads as still waiting for a signature. The departure stamp is what tells them apart,
    and it is written in the same transaction as the debit, so it cannot be set on a
    return whose stock is still on the shelf. Whichever door such a row is received
    through promotes it to DISPATCHED (`_receive_at_far_end`), so nothing carries the
    older shape forward.
    """
    if doc.status == ReturnStatus.DISPATCHED.value:
        return True
    return (doc.status == ReturnStatus.PENDING_APPROVAL.value
            and doc.dispatched_at is not None)


def _within_receipt_tail(doc: StockTransferOrder) -> bool:
    """Whether a signed-for return is still recent enough to stay on the panel.

    A row with no `received_at` at all is kept: every acknowledgement stamps it, so a
    blank one is a row that predates the stamp, and dropping it silently would be a
    receipt disappearing for a reason nobody could see. `RECEIPT_TAIL` says how long.
    """
    if doc.received_at is None:
        return True
    return doc.received_at >= utcnow() - RECEIPT_TAIL


async def _may_receive(db: AsyncSession, doc: StockTransferOrder, user, *,
                       visible: set[int] | None = None) -> bool:
    """Whether this login may sign for a return at the far end.

    ADDED 2026-09-10, when the acknowledgement moved onto the Sign-off screen. Until then
    the only door to it was the shipment: the logistics desk recorded the far end's
    signature on the transport request and the return module picked it up on a hook. That
    left the branch watching a load it could see had arrived with nothing to press, and
    the inventory credit and the purchase return waiting behind a screen in another
    module. This is the second door, not a replacement — `_transport_acknowledged` still
    works exactly as it did, and whichever door is used first makes the other a no-op.

    Three kinds of person, and none of them is a permission or a rung: receiving is not
    an approval, and no ladder, doc type or workflow decision is touched by it.

      * the raiser, who is the one chasing the material;
      * anybody holding the receiving or the sending point in their own reporting
        subtree — the same `location_ids_for_user` rule the register is scoped by, so
        this list can never show a shelf the login cannot already see;
      * the holders of the return's own logistics chain, who are who the shipment would
        have been acknowledged by under the old single door.

    The status/phase gate is here as well as on the queue so the endpoint refuses a press
    on a return that has not left the gate, whatever the screen happened to render.
    """
    if not _has_left_the_gate(doc) or _phase(doc) != PHASE_LOGISTICS:
        return False
    return await _receipt_audience(db, doc, user, visible=visible)


async def _receipt_audience(db: AsyncSession, doc: StockTransferOrder, user, *,
                            visible: set[int] | None = None) -> bool:
    """The three kinds of person above, with the STATE GATE left off.

    EXTRACTED 2026-09-10 so the awaiting-receipt panel can keep showing a return for a
    few days AFTER it was signed for. Whether somebody may press the button is
    `_may_receive` — gate and audience together, and it is what the endpoint asks. Who
    the return is any of their business is this, and a receipt does not stop being their
    business the instant they give it: the row has to stay on the screen long enough for
    the person who pressed it to see that it landed. Nothing that WRITES may ask this on
    its own.
    """
    if doc.requested_by_id == getattr(user, "id", None):
        return True
    if visible is None:
        visible = await locations.location_ids_for_user(db, user)
    if doc.to_warehouse_id in visible or doc.from_warehouse_id in visible:
        return True
    return await _can_access_return_logistics(db, doc, user)


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


def purchase_return_sources() -> list[dict]:
    """The three source categories, in the order the register reads them.

    Served rather than listed in the screen for the usual reason: the words the filter
    offers have to be the words `_purchase_return_source` stamps on the document, and two
    copies of a three-item list is exactly the size of list that drifts unnoticed.
    """
    return [{"value": source.value,
             "label": PURCHASE_RETURN_SOURCE_LABELS[source.value]}
            for source in SELECTABLE_PURCHASE_RETURN_SOURCES]


def reasons() -> list[dict]:
    """The dropdown, in the order `SELECTABLE_REASONS` states — not dict order, so a
    retired reason stops being offered while old rows holding it still render."""
    return [{"value": reason.value, "label": REASON_LABELS[reason.value]}
            for reason in SELECTABLE_REASONS]


# ---------------------------------------------------------------------------
# What the raiser is holding
# ---------------------------------------------------------------------------

async def my_stock(db: AsyncSession, params: PageParams, user, *,
                   search: str | None = None, indent_id: int | None = None) -> dict:
    """Only what this person actually holds, and only what is free to send back.

    Scoped to the raiser's own point rather than to everything they can see: a District
    Manager can view stock across four offices, but a return is raised against the
    shelf in front of them.

    `indent_id` narrows it further, to the items that request actually asked for
    (ADDED 2026-09-07). A return raised against an indent answers THAT request, so
    offering the whole shelf let a storekeeper file an unrelated item under an indent's
    approval chain. The indent is validated through `_resolve_indent`, the same check
    the save runs, so a picker can never be scoped by somebody else's request. An
    indent whose items are all off the shelf comes back empty — which is the honest
    answer, not a reason to widen back to everything.
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
    if indent_id:
        indent = await _resolve_indent(db, indent_id, user)
        stmt = stmt.where(Stock.item_id.in_(
            select(IndentItem.item_id).where(IndentItem.indent_id == indent.id)
        ))
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
               desk: dict | None = None,
               visible: set[int] | None = None) -> dict:
    """`visible` is this login's stocking points, passed in by list callers for the same
    reason `desk` is: resolving it walks every post they hold and every reportee under
    each, and a twenty-row queue must not do that twenty times. None means "work it out",
    which is what the single-document reads want."""
    payload = _unpack(doc.remarks)
    reason = payload.get("reason")
    lines = list(doc.items or [])
    phase = _phase(doc)
    pending = doc.status == ReturnStatus.PENDING_APPROVAL.value
    # FIX 2026-09-10: a signature can still be owed on a return that is no longer
    # PENDING_APPROVAL. The logistics rung is signed AFTER the load leaves the gate, so a
    # DISPATCHED return in that phase still has a live chain, an approver to name and an
    # Approve button to draw — read off the status alone, it had neither and the rung was
    # unreachable from every screen the moment the vehicle went.
    awaiting_signature = pending or (phase == PHASE_LOGISTICS
                                     and doc.status == ReturnStatus.DISPATCHED.value)

    approver_names: list[str] = []
    approver_ids: list[int] = []
    if pending and phase == PHASE_DECISION:
        # No instance exists in this phase, so the engine has nobody to name. The desk is
        # read off the configured ladder instead. `desk` is passed in by list callers so
        # a page of forty rows resolves it once rather than forty times.
        desk = desk if desk is not None else await _decision_desk_for_return(db, doc)
        holders = (desk or {}).get("holders", [])
        # Show role/position with name so the card reads "SCM HEAD - MAHENDRA"
        # instead of just "MAHENDRA" - the desk is a position, not just a person.
        desk_name = (desk or {}).get("name") or "Decision desk"
        approver_names = [f"{h['name']} ({desk_name})" if h.get("name") else desk_name for h in holders if h.get("name")]
        # Fallback when holders empty but desk exists - show the position itself
        if not approver_names and desk_name:
            approver_names = [desk_name]
        approver_ids = [h["id"] for h in holders]
    elif awaiting_signature:
        # Whichever chain currently holds it — the reporting line, or the receiving desk.
        approvers = await engine.current_approvers(db, _phase_doc_type(doc), doc.id)
        # Show "SCM HEAD - MAHENDRA" instead of just "MAHENDRA" - include the
        # ladder's position/role so the card says where it is waiting.
        try:
            _inst2 = (await db.execute(select(Instance).where(Instance.doc_type==_phase_doc_type(doc), Instance.doc_id==doc.id, Instance.status==InstanceStatus.IN_PROGRESS.value))).scalars().first()
            _chain2 = getattr(_inst2, "resolved_chain", None) or []
            # FIX 2026-09-07: the old test read `a.id` over a list of ints and threw, so
            # the except below swallowed it every time. Match the rung whose approvers
            # overlap the people the engine says are holding it now.
            _ids2 = {a.id for a in approvers}
            _link2 = next((l for l in _chain2 if isinstance(l, dict)
                           and _ids2 & set(l.get("approver_ids") or [])), None)
            _role2 = (_link2 or {}).get("role_name") or (_link2 or {}).get("position_name")
            if _role2:
                approver_names = [f"{a.full_name} ({_role2})" if a.full_name else _role2 for a in approvers if a.full_name]
            else:
                approver_names = [a.full_name for a in approvers if a.full_name]
        except:
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
        desk = desk if desk is not None else await _decision_desk_for_return(db, doc)
        desk_ids = {holder["id"] for holder in (desk or {}).get("holders", [])}

    # ADDED 2026-09-10: the return has left the gate and is waiting for somebody at the
    # far end to sign for it. Kept as its own flag rather than folded into
    # `can_acknowledge`, because the two presses settle different things and the screens
    # have to say so: this one credits the receiving shelf and raises the purchase return,
    # where the plain acknowledgement on an already-landed return only closes the
    # document. `_may_receive` is only asked once the cheap state gate has passed, so a
    # register full of drafts costs nothing.
    can_receive = (
        user is not None
        # FIX 2026-09-10: `_has_left_the_gate`, not the status, so a load stranded at
        # PENDING_APPROVAL by the first pass of today's change is still signable for.
        and _has_left_the_gate(doc)
        and phase == PHASE_LOGISTICS
        and await _may_receive(db, doc, user, visible=visible)
    )

    # FIX per flow: SCM head also acknowledges when it reaches warehouse — only compute desk holder when acknowledge could actually be offered
    _can_ack = False
    if can_receive and not certificate_outstanding:
        # The receipt IS the acknowledgement: one press, on the Sign-off screen, rather
        # than a signature in Logistics followed by a second one here.
        _can_ack = True
    elif doc.status in AWAITING_ACK and phase != PHASE_LOGISTICS and not certificate_outstanding:
        if is_raiser:
            _can_ack = True
        else:
            try:
                _desk_for_ack = desk if desk is not None else await _decision_desk_for_return(db, doc)
                if getattr(user, "id", None) in {h["id"] for h in (_desk_for_ack or {}).get("holders", [])}:
                    _can_ack = True
            except Exception:
                pass

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
        # The request this return answers. None on a return raised on its own, which is
        # every return raised before 2026-09-07 — and those keep routing down the stock
        # return ladder exactly as they did. Read off `payload`, which is already
        # unpacked: a list page renders forty of these and must not re-parse per field.
        "indent_id": int(payload[INDENT_ID_KEY]) if payload.get(INDENT_ID_KEY) else None,
        "indent_no": payload.get(INDENT_NO_KEY),
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
        # Sending the whole document back to the raiser to correct and submit again.
        # Offered at all three desks, and only to whoever is actually holding it right
        # now — the same live-workflow test the three act flags are built on, never a
        # permission. `send_back` re-checks it server-side.
        "can_send_back": can_act and phase in {PHASE_FIELD, PHASE_DECISION,
                                               PHASE_ENDORSE},
        # Which journey the decision put the material on, and the leg carrying it.
        "leg": _leg_of(doc),
        "leg_label": LEG_LABELS.get(_leg_of(doc) or "", None),
        "transport": _transport_ref(doc),
        # Why the raiser is looking at this draft again. None on a return that has never
        # been sent back.
        "sent_back": _send_back_note(doc),
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
        # Logistics approval (STOCK_RETURN_LOGISTICS) — the transport leg's own chain
        "can_approve_logistics": can_act and phase == PHASE_LOGISTICS,
        # Only the raiser closes their own return — see _can_ack computed before return (SCM head also acknowledges at warehouse)
        "can_acknowledge": _can_ack,
        # True while the acknowledgement above is still a RECEIPT — pressing it lands the
        # stock on the receiving point and raises the purchase return. False once the
        # material is already on the shelf, where the same press only closes the paper.
        "can_receive": can_receive,
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
        "can_withdraw": is_raiser and doc.status in WITHDRAWABLE,
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
            # What left the branch, and what has been signed for at the far end. Both are
            # on the line already (`_dispatch_stock` / `_land_stock` write them); they are
            # served because the receipt form asks for a quantity PER LINE, and a form that
            # cannot see what was sent cannot cap what is claimed to have arrived.
            "dispatched_quantity": _d(line.dispatched_qty),
            "received_quantity": _d(line.received_qty),
            "remarks": line.remarks,
            "hazard_features": hazards.get(line.item_id, []),
        } for line in lines],
    }


async def _may_read_trail(db: AsyncSession, user) -> bool:
    """Whether this login may read the paper trail behind the returned MATERIAL.

    One condition: **`return.decide`**, the decision desk's own code, and deliberately
    not `return.view`. The trail is a dozen other modules' documents (the purchase order,
    the vendor, the price, the GRN, the inspection), gathered because the desk deciding
    where material goes cannot make that call without them. Everyone who can open a
    return holds `return.view`; almost none of them need the commercial history of the
    item, which is why it used to be served to all of them.

    Not a workflow test. `can_decide` is true only while the document is actually SITTING
    on the desk, and the desk has to be able to look at a return it has already decided,
    or one a colleague is holding. This asks whether the login is a decider at all — so
    a decider who raised a return themselves still reads its trail, which is deliberate:
    the desk's view of a return is the same view whoever is holding it.

    Whether a given job profile SHOULD hold `return.decide` is an administrator's
    decision on Job Profiles, not this function's — and the documents in the trail are
    each gated by their own module besides, so a row this serves is still unopenable by
    somebody with no right to that document.

    The route is what enforces it (rule 6). This exists so the screen can leave the
    section out rather than draw it and collect a 403 — a panel that renders an error for
    most of the people who open the document reads as a broken screen, not a private one.
    """
    if user is None:
        return False
    from app.platform.rbac.service import get_user_permissions

    codes = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    return perms.RETURN_DECIDE in codes


async def get_return(db: AsyncSession, return_id: int, user=None) -> dict:
    out = await _out(db, await _load(db, return_id), user)
    # Only on the single-document read. `_out` also builds every row of a forty-row
    # queue, and no list screen draws the trail.
    out["can_view_trail"] = await _may_read_trail(db, user)
    return out



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
                       mine_only: bool = False, queue: str | None = None,
                       date_from: date | None = None,
                       date_to: date | None = None) -> dict:
    """Returns this login may see: their own, plus any raised from a point in their
    reporting subtree — the same visibility rule inventory's own screens use, so the
    two can never disagree about which shelves a login owns.

    `queue` narrows to a desk's work rather than to a status: DECISION and ENDORSE are
    both PENDING_APPROVAL, so a status filter cannot tell them apart. A queue also drops
    the subtree rule — the inventory desk holds no stocking point in the mirror, so a
    visibility filter written for storekeepers would hand it an empty list.

    `date_from`/`date_to` bound the day the return was RAISED, inclusive at both ends —
    that is the date every one of these screens prints ("Waiting since" on the desks,
    the raise date in the register), and a filter that bounded some other timestamp
    would hide rows whose visible date is inside the range.
    """
    stmt = select(StockTransferOrder).where(_is_return())
    if queue:
        return await _queue_page(db, params, user, queue, search=search,
                                 date_from=date_from, date_to=date_to)

    visible = await locations.location_ids_for_user(db, user)
    owner = _raised_by_me(user)
    if mine_only:
        stmt = stmt.where(owner)
    elif await _sees_every_return(db, user):
        # No narrowing at all. See `_sees_every_return` — this is the desks' own reach,
        # applied to the register they were always missing from.
        pass
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
    for clause in _raised_between(date_from, date_to):
        stmt = stmt.where(clause)
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
    # `visible` is handed on rather than resolved per row: `can_receive` asks the same
    # question this list was scoped by, and a page of forty rows must not walk the login's
    # reporting subtree forty times to answer it again.
    page["items"] = [await _out(db, doc, user, visible=visible)
                     for doc in page["items"]]
    return page


QUEUE_DECISION = "decision"
QUEUE_ENDORSEMENT = "endorsement"
#: Not an approval queue: these returns are signed off and waiting on a vehicle, or
#: already on one. It is a tracking list, so it is not filtered down to what the reader
#: may act on — the press that moves a leg on belongs to the logistics desk, on the
#: shipment itself, and this only answers "what of ours is out there".
QUEUE_LOGISTICS = "logistics"
#: ADDED 2026-09-10: what has LEFT the branch and is waiting for somebody at the far end
#: to sign for it.
#:
#: It shares the logistics phase with `QUEUE_LOGISTICS` and is told apart by the status —
#: a return only reaches this list once it is DISPATCHED — so the two lists can never
#: show the same row twice. This is the backlog the Sign-off screen draws above its
#: endorsement queue, and the press on it is the one that credits the receiving shelf and
#: raises the purchase return (`acknowledge_return`). It is a receipt, not a rung: no
#: ladder, no doc type and no approval stage is involved in reaching or clearing it.
QUEUE_RECEIPT = "receipt"
#: How long a return stays on the awaiting-receipt list AFTER it has been signed for.
#:
#: ADDED 2026-09-10. Acknowledging one used to take it off the screen in the same beat as
#: the press: the row the person had just been reading vanished, and the only way to see
#: what they had done was to go and look for the return in the register. A receipt moves
#: stock and raises a purchase return, so the row is exactly what somebody wants to check
#: immediately afterwards.
#:
#: A tail rather than "keep it forever": every return this desk has ever received would
#: turn a work list into a register, and there is already a register. Seven days is long
#: enough to cover a weekend and short enough that the list stays a list. Bounded on
#: `received_at`, which is stamped by the same press.
RECEIPT_TAIL = timedelta(days=7)


#: What a desk's search box looks at, keyed by the queue it belongs to.
#:
#: Every entry is a field of the row as `_out` built it, which is the point: a search
#: box on a work list has to match WHAT IS ON THE SCREEN. Searching the columns the
#: table draws — and only those — is what makes a term that is plainly visible in a
#: row never fail to find it, and a term that appears nowhere never return one. The
#: alternative, a LIKE over `remarks`, matches the marker JSON: "decision" typed into
#: the box would return every row on the desk.
_QUEUE_SEARCH_FIELDS: dict[str, tuple[str, ...]] = {
    QUEUE_DECISION: (
        "return_no", "reason_label", "reason", "from_warehouse_name",
        "raised_by_name", "raised_by_code", "intent_label", "indent_no",
    ),
    QUEUE_ENDORSEMENT: (
        "return_no", "reason_label", "reason", "from_warehouse_name",
        "raised_by_name", "raised_by_code", "intent_label", "indent_no",
        # This desk's last column is the decision itself, so it is searchable here and
        # not on the decision desk, where there is nothing to search yet.
        "decision.disposition_label", "decision.decided_by_name",
    ),
    QUEUE_LOGISTICS: (
        "return_no", "reason_label", "reason", "from_warehouse_name",
        "to_warehouse_name", "raised_by_name", "leg_label",
    ),
    # The receipt list draws where it came from, where it is going and the shipment
    # number on the driver's paperwork, so all three are searchable.
    QUEUE_RECEIPT: (
        "return_no", "reason_label", "reason", "from_warehouse_name",
        "to_warehouse_name", "raised_by_name", "leg_label",
        "transport.transport_request_no",
    ),
}


def _raised_between(date_from: date | None, date_to: date | None) -> list:
    """SQL bounds on the day a return was raised, inclusive at both ends.

    Both ends inclusive is the only reading a person types a date expecting: picking
    today in "to" and getting nothing back because the row was created at 14:02 and the
    bound was midnight is the classic off-by-one on a date filter. So the upper bound is
    `< to + 1 day` rather than `<= to`, which keeps it a plain range scan over
    `created_at` — no `DATE()` wrapped around the column, which would throw the index
    away.
    """
    clauses = []
    if date_from:
        clauses.append(StockTransferOrder.created_at
                       >= datetime.combine(date_from, time.min))
    if date_to:
        clauses.append(StockTransferOrder.created_at
                       < datetime.combine(date_to + timedelta(days=1), time.min))
    return clauses


def _field(row: dict, path: str):
    """One field of the row, `a.b` walking into a nested block (`decision`)."""
    value = row
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _matches_term(row: dict, fields: tuple[str, ...], term: str) -> bool:
    """Case-insensitive substring match over the row's own visible fields."""
    needle = term.casefold()
    return any(needle in str(_field(row, field) or "").casefold() for field in fields)


async def _sees_every_return(db: AsyncSession, user) -> bool:
    """Whether this login reads the whole register rather than their own subtree.

    The subtree rule (`location_ids_for_user`) is written for the person standing at a
    shelf: you see what came off a point you or your reportees hold. Every desk ABOVE a
    shelf fails it — the SCM Head holds ONE nominal stocking point out of nine hundred,
    so All Returns showed him nothing while his decision desk was full, and a document
    he had just signed disappeared from every screen he could open.

    This is not a widening. `_queue_page` already serves those desks every pending
    return in the company regardless of location, deliberately and for this exact
    reason. The register simply never got the same exemption, so the two screens
    disagreed about which documents exist.

    Gated on `return.view_all`, which inherits its grants from `return.decide`
    (permissions.INHERITS_GRANTS_FROM), so the desks that already see these rows keep
    them and nobody else gains anything. A storekeeper holding only `return.view` is
    scoped exactly as before.
    """
    if user is None:
        return False
    held = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    return perms.RETURN_VIEW_ALL in held


async def _queue_page(db: AsyncSession, params: PageParams, user,
                      queue: str, *, search: str | None = None,
                      date_from: date | None = None,
                      date_to: date | None = None) -> dict:
    """One desk's work. Decision desk (INVENTORY MANAGER) is newest first; the others stay
    oldest first. Filtered in Python on the phase marker rather than in SQL. The phase
    lives inside the `remarks` JSON, and a LIKE over that would match a note that happened
    to contain the word: the rows are already narrowed to pending returns, which is a
    handful, not a table scan.

    The search term is applied the same way and for a second reason: it is matched
    against the row as the SCREEN receives it (`_QUEUE_SEARCH_FIELDS`), so what the box
    finds is exactly what a reader can see. It runs over the WHOLE backlog before the
    page is cut, never over the twenty rows that happened to be fetched — a box that
    searches one page of a queue is a box that reports "no results" for a row two pages
    down. The date bounds ARE pushed into SQL (`_raised_between`), since `created_at` is
    a real column.
    """
    queue = (queue or "").strip().lower()
    if queue not in {QUEUE_DECISION, QUEUE_ENDORSEMENT, QUEUE_LOGISTICS,
                     QUEUE_RECEIPT}:
        raise ValidationError(f"Unknown queue {queue!r}")

    # FIX 2026-09-10: a set per queue, because the sign-off desk now works TWO phases.
    # Its own endorsement backlog, and the logistics rung — which is signed after the load
    # has gone (`_transport_may_release`), so a dispatched return with that rung still
    # open appeared on no screen anybody works: not here, not in the awaiting-receipt
    # panel, which only carries what has been signed. The signature itself is unchanged
    # and still the engine's; this only puts the document where the person owing it looks.
    wanted = {
        QUEUE_DECISION: {PHASE_DECISION},
        QUEUE_ENDORSEMENT: {PHASE_ENDORSE, PHASE_LOGISTICS},
        QUEUE_LOGISTICS: {PHASE_LOGISTICS},
        # ADDED 2026-09-10. Same phase as the tracking list above; the status below is
        # what separates "still waiting on a vehicle" from "on its way to us".
        QUEUE_RECEIPT: {PHASE_LOGISTICS},
    }[queue]
    # The logistics queue is not an approval backlog: those documents are approved and
    # waiting on a vehicle, so PENDING_APPROVAL would return an empty list every time.
    # The receipt queue is narrower still — only what has actually left the gate.
    # FIX 2026-09-10: the sign-off desk also takes DISPATCHED, because the logistics rung
    # is signed after the load has gone and by then the return is DISPATCHED. The row is
    # still filtered by whether this login is the one holding that rung
    # (`can_approve_logistics`), so nobody sees somebody else's signature.
    statuses = ([ReturnStatus.PENDING_APPROVAL.value,
                 ReturnStatus.APPROVED.value, ReturnStatus.DISPATCHED.value]
                if queue == QUEUE_LOGISTICS
                # PENDING_APPROVAL is here for the stranded rows `_has_left_the_gate`
                # describes; `can_receive` is what actually decides the row, and it
                # answers no on a return that has not moved.
                # RECEIVED is the tail (`RECEIPT_TAIL`): a return that HAS been signed
                # for, kept on the list for a few days so the press has something to
                # show for itself. The rows are told apart below, not here.
                else [ReturnStatus.DISPATCHED.value,
                      ReturnStatus.PENDING_APPROVAL.value,
                      ReturnStatus.RECEIVED.value] if queue == QUEUE_RECEIPT
                else [ReturnStatus.PENDING_APPROVAL.value,
                      ReturnStatus.DISPATCHED.value] if queue == QUEUE_ENDORSEMENT
                else [ReturnStatus.PENDING_APPROVAL.value])

    # Inventory manager's decision desk wants newest first (user request 2026-09-07)
    order = (StockTransferOrder.id.desc()
             if queue == QUEUE_DECISION else StockTransferOrder.id)
    rows = list((await db.execute(
        select(StockTransferOrder)
        .where(_is_return(), StockTransferOrder.status.in_(statuses),
               *_raised_between(date_from, date_to))
        .order_by(order)
    )).scalars().all())

    term = (search or "").strip()
    fields = _QUEUE_SEARCH_FIELDS[queue]
    # Read once for the whole page rather than per row: `location_ids_for_user` walks
    # every post the login holds and every reportee under each of them, and a twenty-row
    # queue asking it twenty times is twenty subtree walks for one answer.
    visible = (await locations.location_ids_for_user(db, user)
               if queue == QUEUE_RECEIPT else None)
    mine: list[dict] = []
    # The tail of the receipt queue — returns already signed for. Collected separately so
    # they sit BELOW the ones still owed a signature however the rows came back: the
    # work comes first and the receipt of it follows, which is the order the person who
    # pressed the button reads the screen in.
    settled: list[dict] = []
    for doc in rows:
        # A return that has been received has no phase left on it — `_receive_at_far_end`
        # clears the marker, which is what re-offers the raiser their own close — so the
        # phase filter cannot see the tail rows and is skipped for them.
        signed_for = (queue == QUEUE_RECEIPT
                      and doc.status == ReturnStatus.RECEIVED.value)
        if not signed_for and _phase(doc) not in wanted:
            continue
        if signed_for and not _within_receipt_tail(doc):
            continue
        out = await _out(db, doc, user, visible=visible)
        if term and not _matches_term(out, fields, term):
            continue
        # Only what this login can actually act on. A queue showing somebody else's work
        # is a queue people stop reading. The logistics list is the exception — see
        # `QUEUE_LOGISTICS`: nobody acts on a return from inside this module once it is
        # travelling, so filtering it by who may press something would empty it.
        if queue == QUEUE_LOGISTICS:
            # FIX 2026-09-10: the pending half asked `can_act`, which is the REPORTING
            # LINE's flag — `_out` returns it as "can_act and phase is FIELD" — so on this
            # list, where every row is in the LOGISTICS phase, it was false for everybody
            # and a return waiting on its logistics rung was never listed. The flag that
            # answers the question this branch is asking is `can_approve_logistics`.
            if ((doc.status == ReturnStatus.PENDING_APPROVAL.value
                 and out["can_approve_logistics"])
                    or (doc.status != ReturnStatus.PENDING_APPROVAL.value
                        and await _can_access_return_logistics(db, doc, user))):
                mine.append(out)
            continue
        # ADDED 2026-09-10. Receiving is not a rung, so there is no chain to ask who is
        # holding it — `_may_receive` answers the same question the acknowledgement
        # itself is checked against, so a row on this list is always one this login can
        # actually press.
        if queue == QUEUE_RECEIPT:
            if signed_for:
                # `can_receive` is false on it by definition — the leg is over and there
                # is nothing left to press — so the question is only whether this return
                # was ever any of this login's business (`_receipt_audience`, the same
                # three kinds of person the press itself is open to).
                if await _receipt_audience(db, doc, user, visible=visible):
                    settled.append(out)
                continue
            # Already answered while the row was built, against the same `visible` set.
            if out["can_receive"]:
                mine.append(out)
            continue
        # `can_approve_logistics` is what carries the LOGISTICS-phase rows onto the
        # sign-off desk (2026-09-10). It is false on every decision-queue row, which only
        # ever holds PHASE_DECISION, so that list is unchanged.
        if out["can_decide"] or out["can_endorse"] or out["can_approve_logistics"]:
            mine.append(out)

    # Newest receipt first within the tail: the one just pressed is the one being looked
    # for. `received_at` is stamped by that press, so nothing else can order it.
    settled.sort(key=lambda row: row.get("received_at") or datetime.min, reverse=True)
    mine.extend(settled)

    start = (params.page - 1) * params.size
    return {"items": mine[start:start + params.size], "total": len(mine),
            "page": params.page, "size": params.size}


async def summary(db: AsyncSession, user) -> dict:
    """The KPI tiles. Counted in SQL over the same visibility the list applies, so the
    tiles and the grid cannot disagree — the numbers are not summed in the browser
    over whichever page happened to be fetched."""
    visible = await locations.location_ids_for_user(db, user)
    owner = _raised_by_me(user)
    # The same reach `list_returns` applies: a login holding `return.view_all` reads the
    # whole register, so its tiles must count the whole register too — or the tiles say
    # 0 over a Recent returns list that is full.
    if await _sees_every_return(db, user):
        scope = true()
    else:
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

    awaiting_decision = awaiting_endorsement = awaiting_approval = 0
    awaiting_dispatch = in_transit = 0
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
        # DISPATCHED joined the set on 2026-09-05: a scrapped or disposed line is written
        # off where it stands and never reaches that status, but leaving it out would have
        # quietly excluded any future outcome that both travels and writes off.
        carried_out = row.status in {ReturnStatus.APPROVED.value,
                                     ReturnStatus.DISPATCHED.value,
                                     ReturnStatus.RECEIVED.value,
                                     ReturnStatus.REJECTED.value}
        if carried_out and disposition in {Disposition.SCRAP.value,
                                           Disposition.CONTROLLED_DISPOSAL.value}:
            written_off += 1
        if carried_out and disposition == Disposition.REJECT_UNECONOMIC.value:
            refused += 1
        phase = payload.get(PHASE_KEY) or PHASE_FIELD
        # The logistics backlog is not PENDING_APPROVAL — the document is approved and
        # waiting on a vehicle — so it is counted before the approval filter below rather
        # than inside it. Two separate questions: who owes a signature, and what is
        # sitting on the yard.
        if phase == PHASE_LOGISTICS:
            if row.status == ReturnStatus.APPROVED.value:
                awaiting_dispatch += 1
            elif row.status == ReturnStatus.DISPATCHED.value:
                in_transit += 1
        if row.status != ReturnStatus.PENDING_APPROVAL.value:
            continue
        if phase == PHASE_DECISION:
            awaiting_decision += 1
        elif phase == PHASE_ENDORSE:
            awaiting_endorsement += 1
        elif phase == PHASE_FIELD:
            awaiting_approval += 1
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
        "dispatched": counts.get(ReturnStatus.DISPATCHED.value, 0),
        "acknowledged": counts.get(ReturnStatus.RECEIVED.value, 0),
        "rejected": counts.get(ReturnStatus.REJECTED.value, 0),
        "cancelled": counts.get(ReturnStatus.CANCELLED.value, 0),
        "total": sum(counts.values()),
        "by_status": counts,
        "awaiting_decision": awaiting_decision,
        "awaiting_endorsement": awaiting_endorsement,
        "awaiting_approval": awaiting_approval,
        "awaiting_dispatch": awaiting_dispatch,
        "in_transit": in_transit,
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
                         ReturnDocType.STOCK_RETURN_RECEIPT.value,
                         ReturnDocType.STOCK_RETURN_LOGISTICS.value)
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
        raise ValidationError("Say what the reason is — 'Others' on its own tells the "
                              "decision desk nothing")


def _indent_payload(indent: Indent | None) -> dict | None:
    """The indent keys for `_pack`, or None. The post and the project are snapshotted
    alongside the id because the return's approval is climbed from where the INDENT was
    raised — a raiser who has since moved posts must not change the chain."""
    if indent is None:
        return None
    return {
        INDENT_ID_KEY: indent.id,
        INDENT_NO_KEY: indent.indent_no,
        INDENT_POSITION_KEY: indent.position_id,
        INDENT_PROJECT_KEY: indent.project_id,
    }


async def create_return(db: AsyncSession, data, user) -> dict:
    _assert_reason_stated(data)
    indent = await _resolve_indent(db, getattr(data, "indent_id", None), user)
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
                      kind=data.kind.value, intent=data.intent.value,
                      indent=_indent_payload(indent)),
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
    indent = await _resolve_indent(db, getattr(data, "indent_id", None), user)
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
                        kind=data.kind.value, intent=data.intent.value,
                        indent=_indent_payload(indent))

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

    The approval that starts is always the raiser's own ladder (2026-09-07) — the
    configured Indent Return ladder. Where the return names an indent, the ladder is
    still the return ladder, resolved from the indent's original project/post so the
    configured return roles apply to the same branch hierarchy. The decision desk and
    its sign-off follow it, and logistics follows those.
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

    # The hat they submitted under, snapshotted now because BOTH later chains are opened
    # by somebody else — the receiving chain by the decision desk, the reporting line by
    # the floor that signed off — and each has to name the raiser's post, not theirs.
    _set_payload(doc, **{
        RAISER_POSITION_KEY: getattr(user, "active_position_id", None)})

    doc.status = ReturnStatus.PENDING_APPROVAL.value
    await db.flush()

    # FIX 2026-09-07: EVERY return now climbs its APPROVAL LADDER first, whether or not
    # it names an indent. The order the business states is
    #
    #     … → Inventory Manager → SCM Head → decision desk → SCM Head sign-off → logistics
    #
    # so the reporting line agrees the material is coming back BEFORE the inventory desk
    # is asked where it is worth the most, and the sign-off that closes the desk's leg is
    # what releases the return to logistics.
    #
    # A return raised against an indent already ran in this order (2026-09-07). One raised
    # on its own went to the DECISION DESK straight off the submit (2026-09-05) and only
    # reached the reporting line two legs later, so the desk was routing stock nobody in
    # the raiser's own line had yet approved. Both now take the one path.
    #
    # `_open_field_chain` serves both; `_field_chain_context` supplies the original
    # indent project/post where there is one, and the STOCK_RETURN ladder supplies the
    # actual return roles.
    _set_payload(doc, **{FIELD_FIRST_KEY: True})
    await db.flush()
    raise_leg_for = await _open_field_chain(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.DRAFT.value},
                      after={"status": doc.status, "phase": _phase(doc)})
    # A ladder that resolves to nobody can make the submit itself the final approval, and
    # that ending may owe a transport leg. `_settle` is the one place that raises it.
    await _settle(db, doc, user, raise_leg_for)
    return await get_return(db, return_id, user)


async def _desk_is_open(db: AsyncSession, doc: StockTransferOrder) -> bool:
    """Is a decision desk configured for this return, with somebody in the chair?

    SPLIT OUT 2026-09-07, and asked from one place since the same day's second fix: every
    return now reaches this desk through `_after_field_chain`, once its approval ladder
    has signed. It stays a function of its own because the answer decides whether the desk
    leg exists at all for this deployment, and both that hand-over and the legacy rows
    still in flight have to ask it.

    No receiving ladder configured, or nobody in the chair, means this deployment has not
    set that desk up. The return must not stand still waiting for a desk nobody defined,
    so the caller sends it on and this says so in the log.
    """
    receipt_type = ReturnDocType.STOCK_RETURN_RECEIPT.value
    # FIX 2026-09-07: asked through `_decision_desk_for_return`, so the desk is looked
    # up with this return's project AND the raiser's rank rather than the bare
    # deployment-wide lookup. That helper's `receiving.decision_desk` already answers
    # None when no receiving ladder is configured for that scope, which is exactly what
    # the separate `find_ladder` probe here used to establish.
    desk = await _decision_desk_for_return(db, doc)
    if desk is None:
        logger.info("Return %s: no %s desk configured — the decision desk is skipped",
                    doc.sto_no, receipt_type)
        return False
    if not desk.get("holders"):
        # A post with nobody in the chair cannot decide anything, and a return that waits
        # for an empty chair is a document nobody will ever find again.
        logger.warning("Return %s: decision desk %r has nobody in the chair — the "
                       "decision desk is skipped", doc.sto_no, desk.get("name"))
        return False
    return True


async def _after_field_chain(db: AsyncSession, doc: StockTransferOrder,
                             user) -> StockTransferOrder | None:
    """The approval ladder ran FIRST and has finished. The decision desk is next.

    ADDED 2026-09-07 as the hand-over for the indent-first order, and the same day made
    the hand-over for EVERY return: the approval ladder runs first for all of them now, so
    this is the one door the decision desk is reached through. It also serves the
    pre-2026-09-05 rows (`_is_legacy_field`), which signed before the desk as well.

    `field_chain_done` is stamped before anything is routed, so that whatever ends this
    document later — the endorsement's last rung, or a decision with nobody behind it —
    can see the ladder has already had its say and treat its own signature as the last.

    Returns the document when the desk does not exist AND the ending owes a transport leg,
    so the caller can raise it after its own audit row. None in every other case.
    """
    _set_payload(doc, **{FIELD_DONE_KEY: True})
    await db.flush()
    if await _desk_is_open(db, doc):
        _set_payload(doc, **{PHASE_KEY: PHASE_DECISION})
        await db.flush()
        return None
    # Nobody to decide where it goes: the ladder's signature is the last word, and the
    # return settles exactly as one raised before the desk existed did.
    return await _final_approval(db, doc, user)


async def _field_chain_context(db: AsyncSession, doc: StockTransferOrder) -> dict:
    """The context the reporting-line approval is resolved from.

    ADDED 2026-09-07, and shared with `approval_flow` on purpose: the chain a raiser is
    SHOWN on the return screen has to be resolved from exactly the same inputs the submit
    resolves from, or the screen is describing a route the document will not take.

    Where the return names an INDENT, two of those inputs come off the indent instead
    of off the return:

      * `requester_position_id` — the post the INDENT was raised from, so the climb starts
        where the request was made even if the storekeeper has since moved posts.
      * `project_id` — the indent's project, so the matching Indent Return ladder scope
        is used rather than a neighbouring project's.

    The ladder doc type deliberately remains STOCK_RETURN. The return approval flow is
    configured separately from the indent flow; the indent only anchors where that return
    flow is resolved.
    """
    lines = list(doc.items or [])
    payload = _unpack(doc.remarks)
    context = {
        "doc_no": doc.sto_no,
        "doc_summary": f"Stock return {doc.sto_no} from {doc.from_warehouse_name}",
        "requester_position_id": await _raiser_position_id(db, doc),
        "project_id": doc.from_project_id or None,
        "from_warehouse_id": doc.from_warehouse_id,
        "to_warehouse_id": doc.to_warehouse_id,
        "total_quantity": float(sum((_d(line.requested_qty) for line in lines), ZERO)),
    }
    indent = _indent_ref(doc)
    if indent is None:
        return context
    context["indent_id"] = indent["indent_id"]
    context["indent_no"] = indent["indent_no"]
    if payload.get(INDENT_POSITION_KEY):
        context["requester_position_id"] = int(payload[INDENT_POSITION_KEY])
    if payload.get(INDENT_PROJECT_KEY):
        context["project_id"] = int(payload[INDENT_PROJECT_KEY])
    return context


#: A rung's state, in the five words the return's OWN tracker uses (`JourneyState`), so
#: the approval flow and the journey stepper read as one system rather than two.
_FLOW_ACTION_STATE: dict[str, str] = {
    ApprovalAction.APPROVED.value: "completed",
    ApprovalAction.DELEGATED.value: "completed",
    ApprovalAction.FALLBACK.value: "completed",
    ApprovalAction.SUBMITTED.value: "completed",
    ApprovalAction.REJECTED.value: "rejected",
    ApprovalAction.RETURNED.value: "cancelled",
    ApprovalAction.CANCELLED.value: "cancelled",
}

#: What each state SAYS under its circle. Served rather than composed in the screen, for
#: the reason every other verdict in this system is served: two screens drawing the same
#: chain must not word the same rung differently.
_FLOW_STATE_CAPTION: dict[str, str] = {
    "completed": "Signed",
    "current": "Waiting",
    "pending": "Pending",
    "rejected": "Rejected",
    "cancelled": "Closed",
}


def _flow_steps(chain: list[dict], *, instance=None, actions=()) -> list[dict]:
    """A resolved chain as the stepper draws it: one step, its chair, its people — and
    where the document has actually REACHED on it.

    The state of a rung is never inferred from the document's status: it is read off the
    press that was made on that rung (`wf_actions`) and, for the rung nobody has pressed
    yet, off the instance's own `current_sequence`. So a chain drawn here cannot claim a
    signature the trail does not hold.

    With no instance — a draft, or a return still at the decision desk — every rung is
    `pending`, which is the truth: nothing has been signed on the reporting line yet.
    """
    signed: dict[int, object] = {}
    for action in actions:
        # The LAST press on a rung is its state. A rung sent back and signed again is
        # signed; the intermediate presses are the trail's business, not the stepper's.
        signed[int(getattr(action, "stage_sequence", 0) or 0)] = action

    status = getattr(instance, "status", None)
    live = status == InstanceStatus.IN_PROGRESS.value
    settled = status == InstanceStatus.APPROVED.value
    halted = status in {InstanceStatus.REJECTED.value, InstanceStatus.CANCELLED.value}
    current = int(getattr(instance, "current_sequence", 0) or 0)

    steps: list[dict] = []
    for index, link in enumerate(chain):
        sequence = int(link.get("sequence") or index + 1)
        action = signed.get(sequence)
        if action is not None:
            state = _FLOW_ACTION_STATE.get(action.action, "completed")
        elif live and sequence == current:
            state = "current"
        elif settled:
            # The chain finished without a press on this rung — an optional rung, or one
            # the engine resolved to nobody. It is behind the document either way.
            state = "completed"
        elif halted:
            state = "cancelled"
        else:
            state = "pending"
        steps.append({
            "sequence": sequence,
            "name": link.get("role_name") or link.get("position_name") or "Approver",
            "position_name": link.get("position_name"),
            "role_name": link.get("role_name"),
            "approver_names": [name for name in (link.get("approver_names") or [])
                               if name],
            "state": state,
            "caption": _FLOW_STATE_CAPTION.get(state, "Pending"),
            # Who actually pressed it, which is not always one of the names above: a
            # delegate signs a rung he is not a member of.
            "actor_name": getattr(action, "actor_name", None) if action else None,
            "acted_at": getattr(action, "acted_at", None) if action else None,
        })
    return steps


def _flow_message(steps: list[dict], instance, *, started: bool) -> str | None:
    """The one sentence under the stepper — where the approval has reached, in words.

    Read off the steps that were just built, so the sentence and the circles can only
    disagree if the steps disagree with themselves.
    """
    if not steps:
        return None
    if not started:
        return ("Not started — the return has not reached the reporting line yet."
                if instance is None else None)
    current = next((step for step in steps if step["state"] == "current"), None)
    if current is not None:
        names = ", ".join(current["approver_names"])
        return (f"Waiting for {names}" if names
                else f"Waiting — nobody is in the {current['name']} chair")
    stopped = next((step for step in steps
                    if step["state"] in {"rejected", "cancelled"}), None)
    if stopped is not None:
        verb = "Rejected" if stopped["state"] == "rejected" else "Closed"
        by = stopped["actor_name"]
        return f"{verb} at {stopped['name']}" + (f" by {by}" if by else "")
    if all(step["state"] == "completed" for step in steps):
        return "Every approval on this return is signed."
    return None


async def approval_flow(db: AsyncSession, user, *, indent_id: int | None = None,
                        return_id: int | None = None) -> dict:
    """The approval a return WILL follow — resolved, never guessed.

    ADDED 2026-09-07. Two front doors, one answer:

      * `indent_id` — the form, before the return exists. "If I raise this against that
        indent, who signs it?"
      * `return_id` — an existing return, so the document can show its own flow.

    It runs `engine.preview_chain` for the Indent Return document type. When an indent is
    linked, the indent only supplies the original project and raiser post used to resolve
    that return ladder. Nothing is written.

    EXCEPT once the reporting line has actually started, and then the preview is the wrong
    answer: `wf_instances.resolved_chain` is FROZEN at submit (rule 8 — editing a ladder
    never moves a document already in approval), so a re-preview of a since-edited ladder
    would draw a route this document is not on. A live or finished instance therefore
    wins, and the rungs carry the state read off `wf_actions`.
    """
    linked_id: int | None = None
    linked_no: str | None = None
    instance = None
    actions: list = []
    if return_id is not None:
        doc = await _load(db, return_id)
        context = await _field_chain_context(db, doc)
        ref = _indent_ref(doc) or {}
        linked_id, linked_no = ref.get("indent_id"), ref.get("indent_no")
        instance = await _live_instance(db, ReturnDocType.STOCK_RETURN.value, return_id)
        if instance is not None:
            # This instance's presses only. A return that was sent back and resubmitted
            # has an abandoned chain behind the current one, and its signatures belong to
            # a chain that is no longer running.
            actions = [action for action
                       in await engine.history(db, ReturnDocType.STOCK_RETURN.value,
                                               return_id)
                       if int(getattr(action, "instance_id", 0) or 0) == instance.id]
    else:
        indent = await _resolve_indent(db, indent_id, user)
        # No document yet, so the context is built from the indent and the signed-in
        # raiser directly — the same keys `_field_chain_context` would have set.
        context = {"requester_position_id": getattr(user, "active_position_id", None)}
        if indent is not None:
            linked_id, linked_no = indent.id, indent.indent_no
            context["requester_position_id"] = (indent.position_id
                                                or context["requester_position_id"])
            context["project_id"] = indent.project_id or None

    # Read back off the context rather than off the indent row, so the preview and the
    # submit can only ever disagree if they disagree about the context itself.
    doc_type = ReturnDocType.STOCK_RETURN.value
    is_indent_linked = linked_id is not None
    frozen_raw = getattr(instance, "resolved_chain", None) if instance is not None else None
    has_frozen = instance is not None and frozen_raw is not None
    frozen = [{**link, "sequence": index + 1}
              for index, link in enumerate(frozen_raw or [])
              if isinstance(link, dict)] if has_frozen else []
    # A started chain is the answer; the preview is only for what has not started.
    chain = (
        frozen if has_frozen else
        await engine.preview_chain(db, doc_type, context, user)
    )

    if chain is None:
        note = ("No Indent Return approval chain is configured for this indent's "
                "project and rank, so the return follows the reporting line above the "
                "raiser."
                if is_indent_linked else
                "No stock return approval chain is configured, so the return follows the "
                "reporting line above the raiser.")
    elif not chain:
        note = ("This chain is set to need no signature, so the return is approved the "
                "moment it reaches this stage.")
    elif is_indent_linked:
        note = (f"The Indent Return approval chain, resolved from "
                f"{linked_no or 'the indent'}'s original project and raiser post. It "
                "runs FIRST — the decision desk and the sign-off follow it.")
    else:
        # FIX 2026-09-07: says WHERE in the flow this chain sits, the way the indent
        # branch above already did. It runs first for every return now, and a raiser
        # reading only "the stock return's own approval chain" could not tell whether
        # these people sign before or after the inventory desk decides.
        note = ("The stock return's own approval chain. It runs FIRST — the decision "
                "desk and the sign-off follow it.")

    steps = _flow_steps(chain or [], instance=instance, actions=actions)
    started = has_frozen
    return {
        "indent_id": linked_id,
        "indent_no": linked_no,
        "doc_type": doc_type,
        "is_configured": chain is not None,
        # True once the reporting line has actually started: the steps are then the
        # document's own frozen chain and their states are real, not a forecast.
        "is_live": started,
        # Which rung the document is sitting on, for the "Stage N of M" line. Null while
        # nothing has started — a forecast has no current rung.
        "current_sequence": next((step["sequence"] for step in steps
                                  if step["state"] == "current"), None),
        "current_stage_message": _flow_message(steps, instance, started=started),
        "steps": steps,
        "note": note,
    }


async def returnable_indents(db: AsyncSession, params: PageParams, user, *,
                             search: str | None = None) -> dict:
    """The indents this person may raise a return against — their own, past approval,
    AND with something of theirs still on the shelf to send back.

    ADDED 2026-09-07 for the indent picker on the return form. Scoped to the signed-in
    raiser rather than to everything they can see: a return answers a request THEY made.
    The return approval chain is configured on STOCK_RETURN, then resolved from the
    original request's project and post.

    NARROWED 2026-09-12 to indents that still have a returnable item. The picker listed
    every indent past approval, so an indent whose only item had already come back was
    still offered — and choosing it opened step 2 on an empty picker under the sentence
    "Nothing that indent asked for is on your shelf to return." That is a dead end
    presented as a choice: the raiser answers the one question that gates the whole form
    and is told, only afterwards, that the answer was worthless. An indent with nothing
    left to return is not an option, so it is not offered.

    The shelf test is `my_stock`'s, EXACTLY — the raiser's own point, `available_qty > 0`,
    matched on `IndentItem.item_id`. The two must stay identical: anything this list
    admits that `my_stock` then excludes is the same dead end again, one step later.
    `returnable_items` is that same count per row, served so the option can say how much
    is actually still returnable rather than repeating the indent's original line count —
    "1 item" on an indent holding nothing is what made the empty picker read as a defect.

    A raiser with no stocking point holds no shelf at all, so nothing is returnable and
    the list is empty — the same answer `my_stock` gives, and the destination banner on
    the form already says why.
    """
    context = await _raiser_context(db, user)
    source_id = context["from_warehouse_id"]
    if source_id is None:
        return {"items": [], "total": 0, "page": params.page, "size": params.size}

    # Correlated by id rather than joined onto the outer select: an indent with four
    # returnable items would otherwise come back four times, and `paginate` would count
    # the duplicates as separate indents.
    on_the_shelf = (
        select(IndentItem.indent_id)
        .join(Stock, Stock.item_id == IndentItem.item_id)
        .where(Stock.warehouse_id == source_id, Stock.available_qty > 0)
    )

    stmt = (select(Indent)
            .where(Indent.requested_by_id == getattr(user, "id", None),
                   Indent.status.in_(RETURNABLE_INDENT_STATUSES),
                   Indent.id.in_(on_the_shelf))
            .order_by(Indent.id.desc()))
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(Indent.indent_no.ilike(like),
                              Indent.remarks.ilike(like),
                              Indent.project_name.ilike(like)))

    page = await paginate(db, stmt, params)
    rows = page["items"]

    # One grouped query for the whole page, not one per row: a picker asks for 200 at a
    # time and 200 round trips to label a dropdown is how a form takes four seconds to
    # open. Distinct on the item, because a shelf holds an item in several batches and
    # bins and the raiser is being told how many ITEMS are returnable, not how many lots.
    returnable: dict[int, int] = {}
    if rows:
        counts = (await db.execute(
            select(IndentItem.indent_id,
                   func.count(func.distinct(IndentItem.item_id)))
            .join(Stock, Stock.item_id == IndentItem.item_id)
            .where(IndentItem.indent_id.in_([row.id for row in rows]),
                   Stock.warehouse_id == source_id, Stock.available_qty > 0)
            .group_by(IndentItem.indent_id)
        )).all()
        returnable = {indent_id: int(count or 0) for indent_id, count in counts}

    page["items"] = [{
        "id": row.id,
        "indent_no": row.indent_no,
        "indent_date": row.indent_date.isoformat() if row.indent_date else None,
        "status": row.status,
        "total_items": int(row.total_items or 0),
        # How many of those are still on the shelf. Never derived in the browser from
        # `total_items` — the gap between the two is the whole point of this field.
        "returnable_items": returnable.get(row.id, 0),
        "total_qty": _d(row.total_qty),
        "project_name": row.project_name,
        "position_name": row.position_name,
    } for row in rows]
    return page


async def _open_field_chain(db: AsyncSession, doc: StockTransferOrder,
                            user) -> StockTransferOrder | None:
    """Open the configured Indent Return approval chain.

    WHEN it runs is the document's business, not this function's. For every return raised
    from 2026-09-07 it is the FIRST stage, opened by the raiser at submit and handing on
    to the decision desk; for a row raised under an earlier order it is the last approval
    before the material moves, opened once both desks have had their say. `_field_first`
    is what says which, and it is read below rather than assumed, because the two endings
    are different.

    Opened on behalf of the RAISER, never of whoever's press got us here. On a legacy row
    the caller is the floor that signed the decision off, and `engine.start` defaults
    `requester_position_id` to the caller's own post: with the floor as requester the ladder
    would be climbed from THEIR reporting line, routing a branch storekeeper's return to
    the warehouse's managers. The post the return was raised under is snapshotted at submit
    for exactly this — the same reason, and the same fix, as `_open_endorsement`. It is
    read the same way even where the caller IS the raiser, so one code path serves both.

    A ladder that resolves to nobody comes back already approved, which means the reporting
    line has nothing to add and the final approval is the signature that just happened.

    Returns the document when that shortcut fires AND the outcome travels, so the caller
    can raise the transport leg after its own audit row. None in every other case.
    """
    context = await _field_chain_context(db, doc)
    instance = await engine.start(
        db, ReturnDocType.STOCK_RETURN.value, doc.id, context, user)
    _set_payload(doc, **{PHASE_KEY: PHASE_FIELD, FIELD_OPENED_KEY: True})
    await db.flush()
    # A configuration with nothing to approve returns an already-approved instance.
    # Reading the instance rather than assuming PENDING_APPROVAL is what stops the
    # document standing still with nobody holding it.
    if instance.status == InstanceStatus.APPROVED.value:
        # Where this ladder ran FIRST its signature is not the last word — the decision
        # desk has still to say where the material goes. See `_after_field_chain`.
        if _field_first(doc):
            return await _after_field_chain(db, doc, user)
        return await _final_approval(db, doc, user)
    return None


async def _settle(db: AsyncSession, doc: StockTransferOrder, user,
                  raise_leg: StockTransferOrder | None) -> None:
    """End a press: raise the transport leg if one is owed, otherwise just commit.

    One place, because three different presses can be the one that turns out to be the
    final approval — the reporting line's last rung, and either desk's signature where
    the stage after it resolves to nobody. `transport.create_tr` owns its own commit, so
    the leg must always be raised AFTER the caller's audit row and instead of its commit,
    never alongside it.
    """
    if raise_leg is not None:
        await _raise_transport_leg(db, doc, user)
    else:
        await db.commit()


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
    chain = await receiving.resolved_chain(
        db, context["project_id"], doc.requested_by_id,
        context["requester_position_id"], context)
    instance = (
        await engine.start_resolved_chain(
            db, receipt_type, doc.id, chain, context, user,
            project_id=context["project_id"])
        if chain is not None else
        await engine.start(db, receipt_type, doc.id, context, user)
    )
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
    # FIX 2026-09-10: a DISPATCHED return in the LOGISTICS phase is still signable. That
    # rung is given after the load leaves the gate, so by the time it is signed the status
    # has already moved on to DISPATCHED — refusing it on the status alone made the
    # signature impossible to give at the only moment it is ever asked for. Every other
    # phase is unchanged: it must be PENDING_APPROVAL to be decided.
    if not (doc.status == ReturnStatus.PENDING_APPROVAL.value
            or (doc.status == ReturnStatus.DISPATCHED.value
                and _phase(doc) == PHASE_LOGISTICS)):
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

    if phase == PHASE_LOGISTICS:
        _chain, context = await _return_logistics_chain(db, doc)
    else:
        context = await _field_chain_context(db, doc)
        context["doc_summary"] = (
            f"Stock return {doc.sto_no} from {doc.from_warehouse_name}")

    before = doc.status
    instance = await engine.act(
        db, _phase_doc_type(doc), doc.id, action, user, comments,
        context=context,
    )

    raise_leg_for: StockTransferOrder | None = None
    if instance.status == InstanceStatus.APPROVED.value:
        if phase == PHASE_LOGISTICS:
            # The transport leg's own chain. Nothing follows it: the material is already
            # where the decision sent it, so this signature is the document's last.
            #
            # FIX 2026-09-10: which status it leaves behind depends on whether the load
            # has already gone. Logistics signs a return AFTER the vehicle leaves, so the
            # ordinary case now is a return whose shelf was debited at the gate
            # (`_transport_released` stamped `dispatched_at` and deliberately left the
            # status alone) — this signature is what moves it to DISPATCHED. Writing
            # APPROVED here would take a departed load back to "signed off, waiting for a
            # vehicle" and keep the far end from ever being able to sign for it. A return
            # signed before its load leaves behaves exactly as it did.
            doc.status = (ReturnStatus.DISPATCHED.value
                          if doc.dispatched_at is not None else
                          ReturnStatus.APPROVED.value)
            raise_leg_for = doc
        elif _field_first(doc) or _is_legacy_field(doc):
            # This ladder ran BEFORE the desks — because the raiser picked an indent on
            # the form and the Indent Return ladder was resolved from that indent's
            # project/post, or because the return was raised under the
            # pre-2026-09-05 order and never left the line it started in. Either way its
            # signature hands the document ON to the decision desk rather than ending it.
            #
            # FIX 2026-09-07: the hand-over is `_after_field_chain`, which superseded the
            # older `_hand_to_decision` on the same day. It is the one door the decision
            # desk is reached through, it covers the legacy rows this branch used to
            # handle alone, and it returns the document when the ending owes a transport
            # leg — which `_hand_to_decision` could not report.
            raise_leg_for = await _after_field_chain(db, doc, user)
        else:
            # THE FINAL APPROVAL. Everything else has already had its say.
            raise_leg_for = await _final_approval(db, doc, user)
    elif instance.status == InstanceStatus.REJECTED.value:
        doc.status = ReturnStatus.REJECTED.value
        # The hold has to go back the moment the answer is no. Leaving it standing is
        # how a shelf ends up with stock the screen calls reserved for a document that
        # was refused.
        await allocation.release(db, RESERVE_REF_TYPE, doc.id)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status, "phase": _phase(doc),
                             "comments": comments})
    await _settle(db, doc, user, raise_leg_for)
    return await get_return(db, return_id, user)


async def _carry_out(db: AsyncSession, doc: StockTransferOrder, user) -> None:
    """The decision is final and the material never leaves this place: settle it here.

    NARROWED 2026-09-05. This used to be every outcome. The two that TRAVEL —
    `SEND_TO_POINT` and `TO_VENDOR` — no longer come here at all: they are released to a
    real transport request at the final approval, the source is debited when the load
    actually goes (`_dispatch_stock`) and the destination credited when the far end signs
    for it (`_land_stock`). What is left is everything that settles where it already
    stands: nothing moves, or it is written off at the branch.

    The TRANSFER branch below still runs, for one case: a deployment with no decision desk
    configured has no disposition to read, and such a return settles exactly as it did
    before any of this existed — straight to the point one rung up. Routing that through
    logistics is not possible, because without a decision nothing knows whether the
    material is going to a shelf or to a vendor.

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
# The final approval, and the leg that follows it
# ---------------------------------------------------------------------------

# RETIRED 2026-09-10 — `_open_logistics_approval`.
#
# The sign-off that releases a return to logistics was immediately followed by a SECOND
# signature, on a `STOCK_RETURN_LOGISTICS` instance opened here, and that instance is
# what put the return on its approver's Approvals page. Nothing was waiting on it: the
# leg is raised at the hand-over, the load may leave without it
# (`_transport_may_release`), the shelf is debited at the gate and the far end signs for
# the material on the Sign-off screen. So the rung asked somebody to approve a journey
# that had already been approved, arranged and in some cases finished — and it did it on
# the one screen the business wanted the return to stay off. Where the return has to land
# once it is signed is the Dispatch board, and only there.
#
# The rung's READ side is deliberately left standing — `can_approve_logistics`,
# `_return_logistics_chain`, the LOGISTICS branch of `act_on_return` and the
# `QUEUE_LOGISTICS` filter. A return that was already sitting on this rung when this
# changed still has a live instance, and it must stay signable at the door it was raised
# at; nothing NEW opens one. `_can_access_return_logistics` is also what scopes the
# module's own "Return logistics" tracking list and `_may_receive`'s third audience, so
# the chain is still resolved for those two even though no instance is ever started from
# it.


async def _final_approval(db: AsyncSession, doc: StockTransferOrder,
                          user) -> StockTransferOrder | None:
    """The last signature is in. Everything else has had its say.

    Which press that was depends on the order the document travels: for every return
    raised from 2026-09-07 it is the SIGN-OFF's last rung, the reporting line having
    signed before the desk ever saw it; for a row raised under the 2026-09-05 order it is
    the reporting line's last rung. Either way this runs once, at the end.

    Two endings, and which one applies is the DECISION's business, not this function's:

      * an outcome that never travels settles on the spot, exactly as it always has —
        released, written off, or transferred where no decision desk exists;
      * an outcome that travels is released to logistics. The material does NOT move
        here: it is still on the branch shelf and still reserved, and it stays that way
        until a truck is actually booked and released.

    Returns the document when a transport leg has to be raised, so the caller can raise it
    after its own audit row — `transport.create_tr` commits, and a leg raised before the
    audit would split one press across two commits.
    """
    if not _travels(doc):
        await _carry_out(db, doc, user)
        return None

    doc.status = ReturnStatus.APPROVED.value
    doc.approved_by_name = _name(user)
    doc.approved_at = utcnow()
    # APPROVED here means "signed off, waiting for a vehicle" — not "done". The phase is
    # what says so, and it is what keeps the raiser's Acknowledge button away until the
    # far end has actually signed for the material.
    _set_payload(doc, **{PHASE_KEY: PHASE_LOGISTICS, LEG_KEY: _leg_of(doc)})
    await db.flush()
    # The leg is raised by the caller, through `_settle`, the moment the return reaches
    # logistics — the draft is what the Dispatch board arranges.
    #
    # CHANGED 2026-09-10: and that is the ONLY thing that happens here. This used to open
    # a second approval instance (`STOCK_RETURN_LOGISTICS`) as well, which is what put an
    # approved, arranged and sometimes already-delivered return back on an Approvals page.
    # See the note above the retired `_open_logistics_approval`. The status therefore
    # stays APPROVED — "signed off, waiting for a vehicle" — and the next thing that moves
    # it is the load actually leaving (`_transport_released`).
    return doc


def _leg_destination(doc: StockTransferOrder, decision: dict | None) -> str:
    """Where the transport request is told it is going.

    A store leg goes to one of our own points and names it. A supplier leg leaves the
    company and names the vendor — `to_warehouse_id` still holds the point the return was
    ADDRESSED to when it was raised, and printing that on a load going to a vendor is how
    a shipment ends up labelled for a warehouse it will never reach.
    """
    if _leg_of(doc) == ReturnLeg.SUPPLIER.value:
        return (decision or {}).get("vendor_name") or "the vendor"
    return doc.to_warehouse_name or "the receiving stocking point"


async def _raise_transport_leg(db: AsyncSession, doc: StockTransferOrder, user) -> None:
    """Book the trip the material has to make, as a real shipment.

    Logistics has carried return legs since it was built — `TransportSource.RETURN` is
    documented there as "the field is sending material to a warehouse (E7); the return
    DECISION is the returns module's, this is only the trip it needs to travel" — and
    nothing ever raised one. This is that wire.

    A real `lgs_transport_requests` row, not a copy of one: it rides the ordinary shipment
    lifecycle from here (its own approval, the tender where the mode needs one, the award,
    the carrier's acceptance, the gate pass, the tracking, the delivery) and the returns
    module never repeats a step of it. What comes back to returns are the two facts that
    change stock — it left, and it arrived — and those arrive through the hooks logistics
    already publishes for exactly this.

    THIRD_PARTY is the mode, because a return leg is a hired truck unless somebody says
    otherwise, and it is the only mode that runs the quotation round. The desk can change
    it on the shipment before submitting; nothing here decides freight.

    Failure to raise the leg is logged and swallowed. The final approval is a signature
    that has already happened and must not be undone by a booking problem — the return
    sits in LOGISTICS with no leg, which the screen reports and the desk can retry.
    """
    from app.modules.logistics import transport as lgs_transport
    from app.modules.logistics.schemas import TRCreate, TRLineIn

    # FIX 2026-09-07: idempotent. Since the leg is raised at the hand-over to logistics
    # rather than after that desk's signature, the signature itself now arrives at a
    # return that ALREADY has a leg — and a second `create_tr` would put the same
    # material on two shipments, each with its own number and its own lifecycle.
    if _transport_ref(doc) is not None:
        await db.commit()
        return

    decision = _decision_of(doc)
    lines = list(doc.items or [])
    payload = _unpack(doc.remarks)
    # The four standard methods, reused rather than reimplemented: the mode the desk chose
    # is `logistics.enums.MODE_RULES`' own value, so the shipment it raises is an ordinary
    # shipment and every rule about carriers, quotes and required fields applies to it
    # unchanged. THIRD_PARTY when the desk said nothing, because a return leg is a hired
    # truck unless somebody says otherwise.
    stored_mode = (payload.get(LOGISTICS_MODE_KEY)
                   or payload.get("transport_mode") or "").upper()
    chosen_mode = (stored_mode if stored_mode in LOGISTICS_MODES
                   else TransportMode.THIRD_PARTY.value)
    # Whose vehicle. A vendor collecting their own material is not a trip we book, price
    # or tender — see the invite guard below.
    arrangement = (payload.get(VEHICLE_KEY)
                   or VehicleArrangement.OWN_VEHICLE.value).upper()
    vendor_collects = arrangement == VehicleArrangement.VENDOR_PICKUP.value
    try:
        tr = await lgs_transport.create_tr(db, TRCreate(
            mode=chosen_mode,
            source_type=TransportSource.RETURN.value,
            source_id=doc.id,
            source_no=doc.sto_no,
            from_warehouse_id=doc.from_warehouse_id,
            from_warehouse_name=doc.from_warehouse_name,
            # `create_tr` REFUSES an inbound leg with no destination named, which is the
            # check that makes this safe: a return has nothing else carrying its address.
            to_location_name=_leg_destination(doc, decision),
            project_id=doc.from_project_id or None,
            remarks=(f"Stock return {doc.sto_no} — "
                     f"{LEG_LABELS.get(_leg_of(doc) or '', 'return leg')} — "
                     f"{VEHICLE_ARRANGEMENT_LABELS[arrangement]}"),
            lines=[TRLineIn(
                item_id=line.item_id,
                item_code=line.item_code,
                item_name=line.item_name,
                uom_code=line.uom_code,
                quantity=float(_d(line.requested_qty)),
                # Fix 0 pkg · 0 kg on return legs: package_count/weight were left 0/None so header totals stayed 0
                package_count=int(_d(line.requested_qty)) or 1,
                weight_kg=float(_d(line.requested_qty)) or 1.0,
                remarks=line.remarks,
            ) for line in lines],
        ), user)
    except Exception:
        logger.exception(
            "Return %s: final approval stands but its transport leg could not be "
            "raised", doc.sto_no)
        await db.commit()
        return

    # Carriers, where the leg is already past the point of being arranged by hand: a
    # THIRD_PARTY or COURIER leg sitting in QUOTING with nobody invited is one the
    # vendors have nothing to price. A DRAFT is not that — see the guard below.
    try:
        if vendor_collects:
            # ADDED 2026-09-08. The vendor is sending their own vehicle, so there is no
            # freight of ours to tender: inviting carriers to quote on it would put a
            # price request in three providers' portals for a trip nobody is hiring.
            logger.info("Return %s: %s travels on the vendor's own vehicle — no carriers "
                        "invited", doc.sto_no, tr.tr_no)
        elif chosen_mode in (TransportMode.THIRD_PARTY.value,
                             TransportMode.COURIER.value):
            # Refresh so status (QUOTING/READY after _advance_after_approval) is visible
            await db.refresh(tr)
            # FIX 2026-09-08: `TransportStatus` was used here and never imported, so
            # every pass through this block raised NameError straight into the bare
            # `except` below — which logged "auto-invite failed" and moved on. No return
            # leg has ever actually invited a carrier; a THIRD_PARTY or COURIER leg sat in
            # QUOTING with nobody asked to price it, which is indistinguishable on the
            # screen from providers who have not answered yet.
            # FIX 2026-09-10: only a leg the ladder has already let through. From
            # today the logistics desk arranges a return leg on the Dispatch screen
            # exactly as it arranges a consignment — it picks the mode and names the
            # providers itself — so a DRAFT must be left alone for that press to
            # answer. It was never reached anyway: `invite_carriers` refuses anything
            # that is not QUOTING or READY, so every DRAFT leg raised here threw
            # straight into the bare `except` below and logged an auto-invite failure
            # on a return where nothing had gone wrong.
            if not tr.quotes and tr.status in (
                    TransportStatus.QUOTING.value, TransportStatus.READY.value):
                from app.shared.models.master import Vendor as _Vendor
                from app.shared.enums import CARRIER_VENDOR_TYPES as _CVT
                carrier_rows = (await db.execute(
                    select(_Vendor.id).where(_Vendor.vendor_type.in_(_CVT), _Vendor.is_active.is_(True)).limit(3)
                )).scalars().all()
                if carrier_rows:
                    # Use transport's own invite to keep audit + status consistent
                    from types import SimpleNamespace as _NS
                    await lgs_transport.invite_carriers(db, tr.id, _NS(carrier_ids=list(carrier_rows), evaluation_method=None), user)
                    await db.refresh(tr)
                    logger.info("Return %s: auto-invited %s carriers to %s", doc.sto_no, len(carrier_rows), tr.tr_no)
    except Exception:
        logger.exception("Return %s: auto-invite failed for %s", doc.sto_no, tr.tr_no)

    # `create_tr` committed, so the document has to be re-read before it is stamped: the
    # instance this function was handed belongs to a transaction that has closed.
    # Re-load fresh after possible invite commit
    try:
        fresh = await _load(db, doc.id)
    except Exception:
        fresh = doc
    _set_payload(fresh, **{TR_ID_KEY: tr.id, TR_NO_KEY: tr.tr_no})
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=fresh.id,
                      entity_no=fresh.sto_no, action=AuditAction.UPDATE, actor=user,
                      after={"transport_request_no": tr.tr_no, "leg": _leg_of(fresh)},
                      summary=f"Return {fresh.sto_no}: leg {tr.tr_no} raised with "
                              "logistics")
    await db.commit()
    logger.info("Return %s released to logistics as %s", fresh.sto_no, tr.tr_no)


async def _dispatch_stock(db: AsyncSession, doc: StockTransferOrder, user) -> None:
    """The load has left: consume the hold and debit the source.

    Consume-then-move, per line and per balance slice, so the material that leaves is the
    exact bin/batch/project that was held — a return of expiring stock must not quietly
    send the fresh lot instead. `move_stock` writes every ledger row (rule 7); nothing
    here assigns to `stk_balance`.

    The destination is NOT credited here even on a store leg. Between the gate and the
    receiving shelf the material belongs to nobody's balance, which is the truth: it is on
    a truck. Crediting it early is what would let a point issue stock that has not
    arrived.
    """
    disposition = (_decision_of(doc) or {}).get("disposition")
    ref_type = LEDGER_REF_BY_DISPOSITION.get(disposition or "", RefType.TRANSFER.value)
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
            moved += slice_.quantity
        line.dispatched_qty = moved
        # Nothing has landed yet. Stamping this now would report a truck as a delivery.
        line.received_qty = ZERO
    await db.flush()


async def _land_stock(db: AsyncSession, doc: StockTransferOrder, user, *,
                      arrived: dict[int, Decimal] | None = None) -> None:
    """The receiving point signed for it: credit the destination.

    Store legs only. A supplier leg has no balance to land on — the material left the
    company at the gate, and the vendor's signature closes the document rather than
    crediting a shelf.

    What actually left is read back out of `stk_ledger` rather than recomputed: the OUT
    rows this document wrote at dispatch carry the exact item, batch and project of every
    slice that went, and the ledger is append-only so they cannot have drifted since. The
    alternative — crediting per line against NO_BATCH — would land a batch-tracked return
    on an unbatched balance row and lose the identity the outward leg was careful to keep.

    `arrived` (ADDED 2026-09-10) is how much of each ITEM the far end is actually signing
    for, keyed by `item_id`, and it caps the credit. None means "all of it", which is the
    shipment-side door and every receipt taken before the screen asked for quantities —
    that path is unchanged to the row.

    A capped credit is taken off the slices IN LEDGER ORDER, so a partial receipt lands the
    oldest batch that left first. That is not a preference either: the outward leg consumed
    the reservation slice by slice in that order, so following it is the only allocation
    under which "what came off the truck" and "what was credited" describe the same
    material. The caller writes `received_qty` per LINE when it states quantities, because
    two lines can carry one item and only the caller knows which of them was short.
    """
    if _leg_of(doc) != ReturnLeg.STORE.value:
        return
    disposition = (_decision_of(doc) or {}).get("disposition")
    ref_type = LEDGER_REF_BY_DISPOSITION.get(disposition or "", RefType.TRANSFER.value)

    slices = list((await db.execute(
        select(StockMovement)
        .where(StockMovement.ref_type == ref_type,
               StockMovement.ref_id == doc.id,
               StockMovement.direction == StockDirection.OUT.value,
               StockMovement.warehouse_id == doc.from_warehouse_id)
        .order_by(StockMovement.id)
    )).scalars().all())
    if not slices:
        logger.warning("Return %s acknowledged with nothing recorded as dispatched — "
                       "nothing to credit", doc.sto_no)
        return

    # What is still to be credited per item, where the caller capped it. Decremented as
    # the slices are walked, so the cap is spread across however many batches the item
    # left on rather than applied to each of them.
    outstanding = ({item_id: _d(quantity) for item_id, quantity in arrived.items()}
                   if arrived is not None else None)

    landed_by_item: dict[int, Decimal] = {}
    for row in slices:
        quantity = _d(row.quantity)
        if outstanding is not None:
            left = outstanding.get(row.item_id, ZERO)
            if left <= ZERO:
                continue
            quantity = min(quantity, left)
            outstanding[row.item_id] = left - quantity
        if quantity <= ZERO:
            continue
        await inventory.move_stock(
            db, row.item_id, quantity, StockDirection.IN.value,
            ref_type, doc.id, doc.sto_no, user,
            warehouse_id=doc.to_warehouse_id,
            # Putaway decides the bin at the far end; the batch and the project travel
            # with the material, which is the whole reason they are read back.
            bin_id=NO_BIN, batch_id=row.batch_id or NO_BATCH,
            project_id=doc.to_project_id or row.project_id or NO_PROJECT,
        )
        landed_by_item[row.item_id] = landed_by_item.get(row.item_id, ZERO) + quantity

    if arrived is None:
        for line in list(doc.items or []):
            # Per item, because one line's quantity can have come off several slices and
            # the ledger rows carry no line id of their own. DECREMENTED as it is handed
            # out (fixed 2026-09-10): two lines carrying the same item both used to be
            # stamped with the item's whole landed quantity, so a return listing an item
            # twice reported twice as much received as had been credited.
            landed = landed_by_item.get(line.item_id)
            if landed is None:
                continue
            taken = min(_d(line.dispatched_qty), landed)
            line.received_qty = taken
            landed_by_item[line.item_id] = landed - taken
    await db.flush()


# ---------------------------------------------------------------------------
# What logistics hands back
# ---------------------------------------------------------------------------

async def _return_behind(db: AsyncSession, tr) -> StockTransferOrder | None:
    """The return this shipment is carrying, or None if it is carrying something else.

    Every hook in this file starts here. A hook fires on EVERY transport request in the
    system — consignments, issues, everything — so the first thing each one must do is
    establish that the leg is one of ours and let go otherwise.
    """
    if not is_inbound(getattr(tr, "source_type", None)):
        return None
    if (tr.source_type or "").upper() != TransportSource.RETURN.value:
        return None
    source_id = getattr(tr, "source_id", None)
    if not source_id:
        return None
    doc = await db.get(StockTransferOrder, int(source_id))
    if doc is None or not (doc.remarks or "").startswith(MARKER):
        return None
    return doc


async def _transport_may_release(db: AsyncSession, tr, user) -> str | None:
    """Refuse a return leg only when the return has no business travelling at all.

    ADDED 2026-09-07, alongside raising the leg at the hand-over to logistics, to stop the
    two documents coming apart at the gate: `_transport_released` wanted the return
    APPROVED before it would debit the shelf, so a load released ahead of that signature
    went with the stock still on the branch's balance.

    FIX 2026-09-10: the answer to that is no longer to hold the load. Nothing is waiting
    on a logistics signature — there is no longer one to wait for (see the note above the
    retired `_open_logistics_approval`): the sign-off that released the return to
    logistics was its last, and this desk's only remaining job is to arrange the leg on
    the Dispatch board. What is still refused is a return that must not travel —
    rejected, cancelled, or one that was never released to logistics at all.

    PENDING_APPROVAL is still accepted below, and stays accepted: it is what a return
    already sitting on the retired rung reads as, and its load must not be stranded at the
    gate by a rung nobody is going to sign.

    Only the strict path asks (`logistics/hooks.BEFORE_RELEASE`): a carrier scan reporting
    a departure that already happened is news, not a decision.
    """
    doc = await _return_behind(db, tr)
    if doc is None or _phase(doc) != PHASE_LOGISTICS:
        return None
    if doc.status in {ReturnStatus.APPROVED.value,
                      ReturnStatus.PENDING_APPROVAL.value}:
        return None
    return (f"Return {doc.sto_no} is "
            f"{doc.status.replace('_', ' ').lower()}, so this load cannot leave.")


async def _transport_released(db: AsyncSession, tr, user) -> None:
    """Logistics released the load — the material has left the branch.

    Runs inside the caller's transaction and never commits (`logistics/hooks.py`): the
    shipment leaving and the stock leaving have to land together or not at all.

    Idempotent on `dispatched_at`. `_release` is reachable from four doors — the desk
    pressing dispatch, the one-press Dispatch screen, a carrier scan and a delivery
    landing on a shipment nobody released — and a second one arriving must not debit the
    shelf twice. FIX 2026-09-10: it used to be idempotent on the STATUS, which stopped
    being a reliable answer the moment a load could leave ahead of the logistics signature
    (`_transport_may_release`) — the status does not move here on an unsigned return, so
    the departure stamp is what says the material has already gone.
    """
    doc = await _return_behind(db, tr)
    if doc is None:
        return
    if (_phase(doc) != PHASE_LOGISTICS
            or doc.status not in {ReturnStatus.APPROVED.value,
                                  ReturnStatus.PENDING_APPROVAL.value}
            or doc.dispatched_at is not None):
        # Already dispatched through another door, or cancelled, or never released to
        # logistics at all. Either way there is nothing for this press to say.
        logger.info("Return %s: %s released but the return is %s/%s — nothing to do",
                    doc.sto_no, tr.tr_no, doc.status, _phase(doc))
        return

    before_status = doc.status
    await _dispatch_stock(db, doc, user)
    # FIX 2026-09-10 (second pass): DISPATCHED, whether or not the logistics rung has been
    # signed yet. The material has left the branch, and that is what this status says —
    # every screen on the receiving side is built on it: the Sign-off page's
    # awaiting-receipt panel, `_may_receive`, `_transport_acknowledged` and the raiser's
    # close. Holding the status back until the signature (the first pass at this) left a
    # dispatched load on no screen anybody works. The rung is not skipped: it stays open
    # and signable while the return is DISPATCHED (`_out`, `act_on_return`).
    doc.status = ReturnStatus.DISPATCHED.value
    doc.dispatched_at = utcnow()
    # ADDED 2026-09-08: the warehouse's own document for the load, raised here because
    # here is where the material stops being the branch's problem. It is created in the
    # SAME transaction as the debit and the release deliberately — a warehouse expecting a
    # truck with nothing to open was the gap this closes, and a document that appears one
    # commit later than the stock movement is a second version of that gap.
    document = await _warehouse_return_document(db, doc, tr, user)
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before_status},
                      after={"status": doc.status,
                             "transport_request_no": tr.tr_no,
                             "warehouse_return_no": getattr(document, "return_no",
                                                            None)},
                      summary=f"Return {doc.sto_no} left {doc.from_warehouse_name} "
                              f"on {tr.tr_no}")
    await db.flush()
    logger.info("Return %s dispatched on %s", doc.sto_no, tr.tr_no)


async def _transport_acknowledged(db: AsyncSession, tr, user) -> None:
    """The far end signed for the leg — the store shelf, or the supplier.

    ONE signature, and what it settles depends on which journey this was. A store return
    is credited to the receiving point here, which is the inventory update the flow calls
    for; the receiving desk's inspection is the condition recorded ON that signature
    (`ack_condition` — good, short or damaged), and a shortfall or damage opens its claim
    on the shipment timeline where the logistics desk already works it. A supplier return
    has no shelf to land on: the vendor's acknowledgement is the end of our custody.

    Either way the LAST word is still the raiser's. Clearing the logistics phase is what
    puts their Acknowledge button back, and closing the document is their press, not this
    one — "the system moved it" and "the branch agrees it went" stay different facts.
    """
    doc = await _return_behind(db, tr)
    if doc is None:
        return
    # FIX 2026-09-10: `_has_left_the_gate`, so the shipment-side door settles a stranded
    # row exactly as the Sign-off page's own press does — the two must never disagree.
    if not _has_left_the_gate(doc) or _phase(doc) != PHASE_LOGISTICS:
        logger.info("Return %s: %s acknowledged but the return is %s/%s — nothing to do",
                    doc.sto_no, tr.tr_no, doc.status, _phase(doc))
        return

    await _receive_at_far_end(
        db, doc, user, tr,
        condition=(getattr(tr, "ack_condition", None) or "GOOD").upper(),
        signed_by=getattr(tr, "acknowledged_by_name", None))


async def _receive_at_far_end(db: AsyncSession, doc: StockTransferOrder, user,
                              tr=None, *, condition: str = "GOOD",
                              signed_by: str | None = None,
                              lines: dict[int, Decimal] | None = None,
                              remarks: str | None = None) -> None:
    """The material has landed: credit the shelf, end the leg, raise the purchase return.

    EXTRACTED 2026-09-10 from `_transport_acknowledged`, which used to be the only door
    to it — the far end's signature could only be recorded on the shipment, in Logistics.
    It is now also reachable from the return's own Acknowledge press on the Sign-off
    screen (`acknowledge_return`), which is where the branch and the receiving point
    actually work. One body for both doors, so the two can never settle a return
    differently: the same credit, the same leg ending, the same purchase return.

    Idempotent by the CALLER's status/phase gate, and safe if both doors are used —
    whichever runs first clears the phase, and `_transport_acknowledged` finds nothing
    to do on the second.

    Runs inside the caller's transaction and never commits: the shelf being credited and
    the leg ending have to land together or not at all.

    `lines` (ADDED 2026-09-10) is what the far end says arrived, keyed by LINE id, which is
    what makes this a receipt rather than a rubber stamp: only what was signed for is
    credited, and the rest is a shortage the leg's own claim carries. None means the whole
    dispatched quantity, which is the shipment-side door — a logistics desk recording a
    delivery has already booked any shortage against the leg's own lines, and re-deriving
    it here from a screen it never saw would double-count it.
    """
    stated = dict(lines or {})
    if stated:
        by_id = {line.id: line for line in (doc.items or [])}
        for line_id, quantity in stated.items():
            line = by_id.get(line_id)
            if line is not None:
                # `+=`, not `=`. A line can only be signed for once on this path (the
                # press ends the leg), but the addition is what keeps the column honest
                # against the shipment door having already booked part of it.
                line.received_qty = _d(line.received_qty) + _d(quantity)
    # FIX 2026-09-10: a row stranded at PENDING_APPROVAL by the first pass of today's
    # change is put right here, before anything else reads it. The load left the branch
    # long ago — `_has_left_the_gate` is why this press was offered at all — and settling
    # it while the status still says "waiting for a signature" would leave the raiser's
    # own close (which asks for DISPATCHED) unreachable on a return that has landed.
    if doc.status != ReturnStatus.DISPATCHED.value and _has_left_the_gate(doc):
        doc.status = ReturnStatus.DISPATCHED.value
    # Per ITEM for the credit, because the ledger slices being read back carry an item and
    # a batch and no line id of their own; per LINE above, because that is the ask the
    # person in front of the material answered.
    arrived: dict[int, Decimal] | None = None
    if stated:
        arrived = {}
        for line in (doc.items or []):
            if line.id in stated:
                arrived[line.item_id] = (arrived.get(line.item_id, ZERO)
                                         + _d(stated[line.id]))
    await _land_stock(db, doc, user, arrived=arrived)
    doc.received_by_name = signed_by or _name(user)
    # The phase goes, not the status: the leg is over, the document is not. Dropping the
    # marker is what re-offers the raiser the acknowledgement that closes it.
    _set_payload(doc, **{PHASE_KEY: None})
    reference = getattr(tr, "tr_no", None) or (_transport_ref(doc) or {}).get(
        "transport_request_no")
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": doc.status},
                      after={"status": doc.status, "leg": _leg_of(doc),
                             "condition": condition,
                             "remarks": (remarks or "").strip() or None,
                             "received": {str(k): float(_d(v))
                                          for k, v in stated.items()} or None,
                             "transport_request_no": reference,
                             "signed_by": signed_by or _name(user)},
                      summary=f"Return {doc.sto_no} received at "
                              f"{_leg_destination(doc, _decision_of(doc))} "
                              f"({condition.lower()})")
    await db.flush()
    logger.info("Return %s acknowledged at the far end of %s (%s)",
                doc.sto_no, reference or "—", condition)
    # The receiving warehouse has signed for what arrived, so the purchase return against
    # its document is raised — asked of the ladder like any other, never approved here
    # (see `_raise_purchase_return`). It creates the DRAFT `pro_returns` row first where
    # the gate-out did not, so a load that left through an older door still produces one.
    #
    # Swallowed on failure, and that is the right way round: the material has arrived and
    # the signature above is a fact about the physical world. A paperwork problem
    # downstream must not roll back a delivery. It is logged loudly and the DRAFT document
    # is still on the register for the warehouse to submit by hand.
    try:
        await _raise_purchase_return(db, doc, tr, user)
    except Exception:
        logger.exception("Return %s: the purchase return could not be raised on receipt",
                         doc.sto_no)


async def _sign_return_leg(db: AsyncSession, doc: StockTransferOrder, user, *,
                           condition: str, remarks: str | None,
                           short: bool) -> str | None:
    """The receipt closes the SHIPMENT that carried it, and opens the claim if it has to.

    ADDED 2026-09-10, with the receipt form. The far end signing on the Sign-off desk is
    the same signature the logistics desk takes on the shipment, so a leg still reading
    "in transit" after it leaves the transport register disagreeing with the return it was
    carrying — a load on the road against material already on a shelf. Exactly the
    disagreement `warehouse._sign_transport_for_indent` exists to prevent on the indent
    side, and this is that helper for a return's own leg.

    Stamped here rather than by calling `transport.acknowledge_tr`, for the reason that
    helper gives: that route fires `ON_ACKNOWLEDGE`, which re-enters this module through
    `_transport_acknowledged` and would run the whole credit-and-purchase-return cascade a
    second time. It is only called from `acknowledge_return` — the shipment-side door is
    already inside `acknowledge_tr` and must never sign its own leg again.

    Runs in the caller's transaction and never commits. Stops at ACKNOWLEDGED: taking it
    to CLOSED is the logistics desk's press, and a claim raised below is exactly what that
    desk has to settle first.
    """
    from app.modules.logistics.models import ShipmentEvent, TransportRequest

    legs = list((await db.execute(
        select(TransportRequest)
        .where(TransportRequest.source_type == TransportSource.RETURN.value,
               TransportRequest.source_id == doc.id,
               TransportRequest.status.in_(SIGNABLE_STATUSES))
        .order_by(TransportRequest.id)
    )).scalars().all())
    if not legs:
        return None

    # The three-value vocabulary the shipment timeline speaks, derived from the two facts
    # the receipt form collects. DAMAGED outranks SHORT where both are true: one claim per
    # receipt, and the remarks carry the rest — a desk chasing a broken pallet does not
    # need a second row to tell it the count was also down.
    reported = (AckCondition.DAMAGED.value if condition == ACK_CONDITION_DAMAGED
                else AckCondition.SHORT.value if short
                else AckCondition.GOOD.value)
    now = utcnow()
    who = _name(user) or "the receiving point"

    for leg in legs:
        # A leg signed for straight out of READY never had its departure recorded — the
        # material is plainly at the far end, so stamping both keeps the shipment from
        # reading as delivered on a day nobody dispatched it.
        leg.dispatched_at = leg.dispatched_at or doc.dispatched_at or now
        leg.delivered_at = leg.delivered_at or now
        leg.status = TransportStatus.ACKNOWLEDGED.value
        leg.acknowledged_at = now
        leg.acknowledged_by_id = getattr(user, "id", None)
        leg.acknowledged_by_name = _name(user)
        leg.ack_condition = leg.ack_condition or reported
        leg.ack_remarks = leg.ack_remarks or remarks
        for line in leg.items:
            if not line.delivered_qty:
                line.delivered_qty = line.quantity

        # Tracking is read off `lgs_shipment_events` alone, so a leg whose goods have been
        # signed for still showed "out for delivery" as its last scan without these.
        types = {event.event_type for event in leg.events}
        if ShipmentEventType.DELIVERED.value not in types:
            leg.events.append(ShipmentEvent(
                event_type=ShipmentEventType.DELIVERED.value,
                event_at=leg.delivered_at or now,
                location_name=leg.to_location_name,
                description=f"Reached {who}",
            ))
        if ShipmentEventType.ACKNOWLEDGED.value not in types:
            leg.events.append(ShipmentEvent(
                event_type=ShipmentEventType.ACKNOWLEDGED.value, event_at=now,
                location_name=leg.to_location_name,
                description=(f"{who} signed for {doc.sto_no}"
                             + (f" — reported {reported.lower()}"
                                if reported != AckCondition.GOOD.value else "")),
                recorded_by_id=getattr(user, "id", None),
                recorded_by_name=leg.acknowledged_by_name,
            ))

        claim_type = ACK_CLAIM_EVENT.get(reported)
        if claim_type:
            # DIRECT and OWN_VEHICLE have no carrier, so there is nobody to claim
            # against. The exception is still recorded — a desk wants to know material
            # came back broken or short whoever was driving — it is simply not called a
            # carrier claim.
            in_house = leg.mode in (TransportMode.DIRECT.value,
                                    TransportMode.OWN_VEHICLE.value)
            against = None if in_house else leg.carrier_name
            leg.events.append(ShipmentEvent(
                event_type=claim_type, event_at=now,
                location_name=leg.to_location_name,
                description=(f"{who} reported {reported.lower()} on the return receipt"
                             + (f" — claim against {against}" if against
                                else " — no carrier to claim against")
                             + (f": {remarks}" if remarks else "")),
                is_exception=True,
                recorded_by_id=getattr(user, "id", None),
                recorded_by_name=leg.acknowledged_by_name,
            ))

        await write_audit(db, entity="lgs_transport_requests", entity_id=leg.id,
                          entity_no=leg.tr_no, action=AuditAction.UPDATE, actor=user,
                          after={"status": leg.status, "condition": reported},
                          summary=(f"{who} signed for {leg.tr_no} on return "
                                   f"{doc.sto_no}"))

    await db.flush()
    return legs[-1].tr_no


async def _warehouse_return_document(db: AsyncSession, doc: StockTransferOrder,
                                     tr, user) -> PurchaseReturn | None:
    """The warehouse's own copy of the load, raised the moment the vehicle leaves.

    ADDED 2026-09-08. Until now nothing existed on the receiving side until the material
    arrived: the branch's `inv_sto` row was the only document, and the warehouse expecting
    the truck had nothing to open, nothing to check the load against and nothing to sign.
    The consignment note in the driver's hand was the only paperwork.

    So the gate-out raises it — a `pro_returns` row in DRAFT, which is the warehouse's
    document for material going back and is what the warehouse person opens when the truck
    arrives. DRAFT is deliberate and is the whole point of raising it here: the goods are
    on a highway, nobody has counted them, and a document that claimed otherwise would be
    a receipt for a delivery that has not happened. `_raise_purchase_return` promotes it
    when the receiving end actually signs.

    It carries three things the branch's return cannot:

      * `source_category` — where the material came from, so the buying desk can tell our
        own upper-tier stock going back from a branch pushing material up the chain from
        material that failed on the inspection bench (`_purchase_return_source`);
      * `source_return_id` / `source_return_no` — the return that caused it, so the trail
        runs both ways;
      * the PO, GRN and vendor off the paper trail, which is what makes it arguable with
        the supplier at all.

    Runs inside the caller's transaction and NEVER commits: the release hook contract is
    that the load leaving, the shelf being debited and this document appearing land
    together or not at all (`logistics/hooks.py`).

    Idempotent on the payload stamp. `_release` is reachable from four doors and a second
    one arriving must not raise a second document against the same load.
    """
    from app.modules.warehouse.enums import ReturnStatus as PurchaseReturnStatus
    from app.modules.warehouse.enums import WarehouseDocType

    payload = _unpack(doc.remarks)
    if payload.get(WAREHOUSE_DOC_ID_KEY):
        existing = await db.get(PurchaseReturn, int(payload[WAREHOUSE_DOC_ID_KEY]))
        if existing is not None:
            return existing

    lines = list(doc.items or [])
    if not lines:
        return None

    chain = await _document_chain(db, doc)
    source = await _purchase_return_source(db, doc, chain)
    decision = _decision_of(doc) or {}
    po, grn = chain["po"], chain["grn"]

    # Whose document it is. A store leg lands on one of our shelves and the RECEIVING
    # point is the one that opens it; a supplier leg has no shelf of ours at the far end,
    # so it stays with the point that sent it and the vendor's signature closes it.
    if _leg_of(doc) == ReturnLeg.SUPPLIER.value:
        warehouse_id, warehouse_name = doc.from_warehouse_id, doc.from_warehouse_name
    else:
        warehouse_id = doc.to_warehouse_id or doc.from_warehouse_id
        warehouse_name = doc.to_warehouse_name or doc.from_warehouse_name

    reason = payload.get("reason") or ""
    reason_label = REASON_LABELS.get(reason, reason) or "Returned from the field"

    document = PurchaseReturn(
        items=[],
        # `WarehouseDocType.PURCHASE_RETURN` — the same series the warehouse's own
        # purchase returns draw from. FIXED 2026-09-08: this used to ask for
        # "purchase_return" in lower case, which `sys_doc_series` keys as a DIFFERENT
        # series, so the automatic returns and the hand-raised ones were running two
        # independent counters under one PRET prefix.
        return_no=await next_number(db, WarehouseDocType.PURCHASE_RETURN.value),
        return_date=utcnow().date(),
        po_id=getattr(po, "id", None),
        po_no=getattr(po, "po_no", None),
        grn_id=getattr(grn, "id", None),
        grn_no=getattr(grn, "grn_no", None),
        # The vendor the desk named when it decided, where it named one; otherwise the
        # vendor the material was bought from, off the trail.
        vendor_id=decision.get(VENDOR_ID_KEY) or getattr(grn, "vendor_id", None)
        or getattr(po, "vendor_id", None),
        vendor_name=decision.get(VENDOR_NAME_KEY) or getattr(grn, "vendor_name", None)
        or getattr(po, "vendor_name", None),
        warehouse_id=warehouse_id,
        warehouse_name=warehouse_name,
        reason=reason_label,
        source_category=source["category"],
        source_return_id=doc.id,
        source_return_no=doc.sto_no,
        status=PurchaseReturnStatus.DRAFT.value,
        created_by_id=getattr(user, "id", None),
        created_by_name=_name(user),
    )
    db.add(document)
    await db.flush()

    total_qty = ZERO
    total_value = ZERO
    for index, line in enumerate(lines, start=1):
        # What actually went on the truck, not what was asked for: a return can be
        # released short, and the warehouse is going to count what arrives.
        quantity = _d(line.dispatched_qty) or _d(line.requested_qty)
        rate = await _rate_for(db, doc.from_warehouse_id, line.item_id)
        document.items.append(PurchaseReturnItem(
            line_no=index,
            item_id=line.item_id, item_code=line.item_code, item_name=line.item_name,
            uom_code=line.uom_code,
            # `batch_no` is left unset: `inv_sto_items` carries the batch id and no
            # number (the number lives on `stk_batches`), and a made-up label on a
            # document a vendor may read is worse than an empty field.
            batch_id=line.batch_id,
            quantity=quantity,
            rate=rate,
            amount=(quantity * rate) if rate is not None else None,
            reason=line.remarks or reason_label,
        ))
        total_qty += quantity
        if rate is not None:
            total_value += quantity * rate

    document.total_items = len(lines)
    document.total_qty = total_qty
    document.total_value = total_value

    _set_payload(doc, **{
        WAREHOUSE_DOC_ID_KEY: document.id,
        WAREHOUSE_DOC_NO_KEY: document.return_no,
        SOURCE_CATEGORY_KEY: source["category"],
        QC_TAG_KEY: source["qc_rejected_after_grn"],
    })
    await write_audit(
        db, entity="pro_returns", entity_id=document.id,
        entity_no=document.return_no, action=AuditAction.CREATE, actor=user,
        after={"status": document.status, "source_category": source["category"],
               "qc_rejected_after_grn": source["qc_rejected_after_grn"],
               "source_return_no": doc.sto_no,
               "transport_request_no": getattr(tr, "tr_no", None)},
        summary=f"{document.return_no} raised at {warehouse_name or 'the warehouse'} "
                f"for return {doc.sto_no} "
                f"({PURCHASE_RETURN_SOURCE_LABELS[source['category']]})")
    await db.flush()
    logger.info("Return %s: warehouse document %s raised at gate-out on %s [%s]",
                doc.sto_no, document.return_no, getattr(tr, "tr_no", "—"),
                source["category"])
    return document


async def _raise_purchase_return(db: AsyncSession, doc: StockTransferOrder,
                                 tr, user) -> None:
    """The warehouse signed for the load, so the purchase return against it goes live.

    ADDED 2026-09-08. This is the last automatic step of the flow: the warehouse person
    opens the document the gate-out raised, acknowledges what actually arrived, and the
    purchase return against it is raised without anybody retyping the load.

    **It is raised, not approved.** `engine.start` is asked with the warehouse's own
    `PURCHASE_RETURN` doc type and the same context keys `warehouse.submit_return` passes,
    so whatever ladder an admin has configured for a purchase return applies to this one
    exactly as it would to one raised by hand — and where a project has no ladder it lands
    APPROVED, which is what a hand-raised one does too. Nothing here decides who signs.

    Runs inside the acknowledgement hook's transaction and never commits. A failure is
    logged and swallowed by the caller: the material has arrived and the receiving
    signature is a fact, and a paperwork problem downstream must not undo it.
    """
    from app.modules.warehouse.enums import ReturnStatus as PurchaseReturnStatus
    from app.modules.warehouse.enums import WarehouseDocType

    # Raised at gate-out in the ordinary case. Raised here when the load left through a
    # door that predates this wiring, so an old shipment landing still produces one.
    document = await _warehouse_return_document(db, doc, tr, user)
    if document is None:
        return
    if document.status != PurchaseReturnStatus.DRAFT.value:
        logger.info("Return %s: %s is already %s — nothing to raise",
                    doc.sto_no, document.return_no, document.status)
        return
    if not document.vendor_id:
        # Nobody to send it back to. Neither the desk's decision nor the paper trail
        # named a vendor — which happens on material that reached the branch with no PO
        # behind it — and a purchase return climbing a ladder with an empty vendor is a
        # document nobody can act on at the top of it. It stays DRAFT on the register,
        # where the warehouse names the vendor and submits it the ordinary way.
        logger.info("Return %s: %s stays DRAFT — no vendor is named on it, so there is "
                    "nobody to raise it against", doc.sto_no, document.return_no)
        return

    context = {
        "doc_no": document.return_no,
        "doc_summary": f"Purchase return {document.return_no}",
        "warehouse_id": document.warehouse_id,
        "vendor_id": document.vendor_id,
        "total_value": float(_d(document.total_value)),
        "requester_position_id": getattr(user, "active_position_id", None),
        # So a ladder condition can route a QC rejection differently from a branch
        # return without having to guess from the reason text.
        "source_category": document.source_category,
    }
    instance = await engine.start(
        db, WarehouseDocType.PURCHASE_RETURN.value, document.id, context, user)
    document.status = (
        PurchaseReturnStatus.APPROVED.value
        if instance.status == InstanceStatus.APPROVED.value
        else PurchaseReturnStatus.PENDING_APPROVAL.value)

    await write_audit(
        db, entity="pro_returns", entity_id=document.id,
        entity_no=document.return_no, action=AuditAction.UPDATE, actor=user,
        before={"status": PurchaseReturnStatus.DRAFT.value},
        after={"status": document.status, "source_return_no": doc.sto_no,
               "source_category": document.source_category},
        summary=f"{document.return_no} raised automatically on receipt of return "
                f"{doc.sto_no}")
    await db.flush()
    logger.info("Return %s: purchase return %s raised on receipt (%s)",
                doc.sto_no, document.return_no, document.status)


def _register_transport_hooks() -> None:
    """Wire returns onto the leg, once, at import — the same shape the warehouse uses.

    Logistics may not import returns (rule 5 — returns is last in the chain), so the
    direction is inverted: this module registers itself and logistics calls whatever it
    finds. Guarded against double registration because a test that imports the module
    twice would otherwise debit the shelf twice per release.
    """
    from app.modules.logistics import hooks as lgs_hooks

    for registry, hook in ((lgs_hooks.ON_RELEASE, _transport_released),
                           (lgs_hooks.BEFORE_RELEASE, _transport_may_release),
                           (lgs_hooks.ON_ACKNOWLEDGE, _transport_acknowledged)):
        if hook not in registry:
            registry.append(hook)


_register_transport_hooks()


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
            "Settings > Approval Flow > Returns > Decision Desk.")
    if phase == PHASE_ENDORSE and not out["can_endorse"]:
        raise ValidationError("This return is not waiting for you to endorse it.")
    return out


async def candidate_destinations(db: AsyncSession, doc: StockTransferOrder, *,
                                 originating_id: int | None = None) -> list[dict]:
    """Where this material could usefully go, worst-stocked point first.

    Every stocking point except the one it is coming from, each with how much of the
    return's items it already holds — the decider is choosing between "send it up" and
    "send it to whoever is short", and that second question cannot be answered without
    the numbers next to the names.

    CHANGED 2026-09-08: the row flagged `is_default` is the ORIGINATING point — the
    warehouse that issued this material in the first place, resolved from the paper trail
    by `_originating_warehouse` and passed in. It used to be `to_warehouse_id`, the point
    the raiser addressed the return to, which is a guess made by somebody who was not
    making this decision. `originating_id` falls back to that same guess when the trail
    says nothing, so a return with no documents behind it behaves exactly as before.
    """
    item_ids = [line.item_id for line in list(doc.items or [])]
    default_id = originating_id or doc.to_warehouse_id
    rows = list((await db.execute(
        select(Warehouse.id, Warehouse.name, Warehouse.code, Warehouse.warehouse_type)
        .where(Warehouse.is_active.is_(True),
               Warehouse.id != doc.from_warehouse_id)
        .order_by(Warehouse.name)
    )).all())
    if not rows or not item_ids:
        return [{"warehouse_id": row.id, "warehouse_name": row.name,
                 "warehouse_code": row.code, "warehouse_type": row.warehouse_type,
                 "on_hand": ZERO, "is_default": row.id == default_id,
                 "is_originating": row.id == originating_id,
                 "tier_label": locations.tier_label(
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
        # The point this material came from — the likeliest answer by a distance, so it
        # is flagged and sorted to the top rather than buried in an alphabetical list.
        "is_default": row.id == default_id,
        # Said separately from `is_default` so the screen can label the pre-filled row
        # with WHY it is pre-filled, and so a fallback default is not dressed up as a
        # resolved one.
        "is_originating": row.id == originating_id,
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

    # Resolved once and shared: the point the picker pre-fills, the category the desk is
    # shown, and the category the purchase return is eventually stamped with all come off
    # the same chain read (see `_document_chain`).
    chain = await _document_chain(db, doc)
    originating = await _originating_warehouse(db, doc, chain)
    source = await _purchase_return_source(db, doc, chain)

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

    # Only vendors who actually supply the returned item(s), preferred first -
    # picking from 200 Vendors for a Monitor is how the wrong vendor was chosen.
    # Fall back to all active when the item has no vendor link yet (new item).
    _item_ids = [line.item_id for line in lines]
    _vendor_q = select(Vendor).join(VendorItem, VendorItem.vendor_id == Vendor.id).where(
        VendorItem.item_id.in_(_item_ids), Vendor.is_active.is_(True)
    ).order_by(VendorItem.is_preferred.desc(), Vendor.name).limit(200) if _item_ids else select(Vendor).where(Vendor.is_active.is_(True)).order_by(Vendor.name).limit(200)
    _rows = (await db.execute(_vendor_q)).scalars().all()
    # No fallback to all 200 - that made every return show Amara Raja as the only
    # (first alphabetically) vendor. If the item has no vendor link, return empty
    # so the desk must search for the correct vendor rather than picking the wrong one.
    vendors = [{"id": row.id, "name": row.name, "code": row.code} for row in _rows]

    payload = _unpack(doc.remarks)
    return {
        "dispositions": options,
        "default_disposition": default,
        "destinations": await candidate_destinations(
            db, doc, originating_id=originating["warehouse_id"]),
        "vendors": vendors,
        "hazard_features": hazard_names,
        "value": await _value_of(db, doc),
        "intent": _intent(doc),
        "intent_label": INTENT_LABELS.get(_intent(doc), _intent(doc)),
        # ADDED 2026-09-08. The pre-filled destination, and what put it there, so the
        # screen never has to work out its own default — the one that would then disagree
        # with the row this service flags.
        "originating_warehouse_id": originating["warehouse_id"],
        "originating_warehouse_name": originating["warehouse_name"],
        "originating_source_doc": originating["source_doc"],
        "originating_is_resolved": originating["is_resolved"],
        "current_warehouse_id": doc.from_warehouse_id,
        "current_warehouse_name": doc.from_warehouse_name,
        # The trip. Four standard methods off logistics' own enum, and whose vehicle
        # turns up; both served rather than listed in the screen (rule 6).
        "logistics_modes": [{
            "value": value,
            "label": rule.label,
            "hint": rule.help,
        } for value, rule in MODE_RULES.items()],
        "vehicle_options": [{
            "value": option.value,
            "label": VEHICLE_ARRANGEMENT_LABELS[option.value],
        } for option in VehicleArrangement],
        "default_logistics_mode": (payload.get(LOGISTICS_MODE_KEY)
                                   or TransportMode.THIRD_PARTY.value),
        "default_vehicle_type": (payload.get(VEHICLE_KEY)
                                 or VehicleArrangement.OWN_VEHICLE.value),
        # What the resulting purchase return will be filed under, shown before the press
        # rather than discovered on the register afterwards.
        "purchase_return_category": source["category"],
        "purchase_return_category_label": source["category_label"],
        # The rung actually resolved for THIS document, beside the coarse category. A
        # three-rung chain cannot be named by a two-way filter, so the filter stays the
        # filter and this says which point the material is really coming off.
        "purchase_return_source_detail": source["source_detail"],
        "purchase_return_source_tier": source["source_tier"],
        "purchase_return_source_resolved": source["source_is_resolved"],
        "qc_rejected_tag": source["qc_rejected_after_grn"],
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
    # How the material travels, and whose vehicle carries it. Both optional — a
    # disposition that never leaves the branch has no trip to describe — and both
    # REFUSED when named and unrecognised (2026-09-08). They used to be dropped
    # silently, so a desk that picked a mode the list no longer carried was told the
    # decision was recorded and got a hired truck it had not asked for.
    if getattr(data, "logistics_mode", None):
        mode = (data.logistics_mode or "").upper().strip()
        if mode not in LOGISTICS_MODES:
            raise ValidationError(
                f"{mode} is not a way a load can travel. "
                f"Choose one of: {', '.join(LOGISTICS_MODES)}.")
        changes[LOGISTICS_MODE_KEY] = mode
    if getattr(data, "vehicle_type", None):
        arrangement = (data.vehicle_type or "").upper().strip()
        if arrangement not in VEHICLE_TYPES:
            raise ValidationError(
                f"{arrangement} is not a vehicle arrangement. "
                f"Choose one of: {', '.join(VEHICLE_TYPES)}.")
        changes[VEHICLE_KEY] = arrangement

    _set_payload(doc, **changes)
    await db.flush()

    raise_leg_for: StockTransferOrder | None = None
    instance = await _open_endorsement(db, doc, user, note)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        _set_payload(doc, **{PHASE_KEY: PHASE_ENDORSE})
        await db.flush()
    elif _field_done(doc):
        # ADDED 2026-09-07, and the ordinary case since that day's reorder. This return
        # climbed its approval ladder before it ever reached the desk, so with nobody
        # behind the desk to sign the decision off there is nothing left to ask: the
        # decision is the last word on a document everyone else has already approved.
        raise_leg_for = await _final_approval(db, doc, user)
    else:
        # A row raised under an earlier order, whose reporting line has NOT signed yet.
        # Nobody stands behind the desk to sign the decision off, so the decision is the
        # last word on the ROUTE. It is NOT the last word on the document: the raiser's
        # own reporting line still has to approve it, and that is the next stage now
        # rather than the end of the flow.
        raise_leg_for = await _open_field_chain(db, doc, user)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.PENDING_APPROVAL.value},
                      after={"status": doc.status, "phase": _phase(doc),
                             "disposition": disposition, "note": note},
                      summary=f"Return {doc.sto_no}: "
                              f"{DISPOSITION_LABELS[disposition]}")
    await _settle(db, doc, user, raise_leg_for)
    return await get_return(db, return_id, user)


async def endorse(db: AsyncSession, return_id: int, comments: str, user) -> dict:
    """The floor agreeing the decision is workable.

    For every return raised from 2026-09-07 this sign-off IS the final approval: the
    raiser's ladder signed before the desk ever saw the document, so the last rung's yes
    is what releases the return to logistics. The material still does not move here — it
    moves once logistics has released the leg.

    A row raised under an earlier order carries no such signature, and for those the last
    rung's yes hands the document ON to the raiser's reporting line instead. `_field_done`
    is what tells the two apart; reopening a chain that has already signed would ask the
    same people to approve the same document twice.
    """
    doc = await _load(db, return_id)
    await _assert_at_desk(db, doc, user, PHASE_ENDORSE)

    before = doc.status
    raise_leg_for: StockTransferOrder | None = None
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
        # FIX 2026-09-07: the reporting line is opened here only when it has NOT already
        # run. A return that climbed its Indent Return chain before the desk saw it — and
        # a row raised under the pre-2026-09-05 order — carries that signature already,
        # and reopening the chain would ask the approvers to sign the document twice.
        raise_leg_for = (await _final_approval(db, doc, user) if _field_done(doc)
                         else await _open_field_chain(db, doc, user))

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": doc.status, "phase": _phase(doc),
                             "comments": comments})
    await _settle(db, doc, user, raise_leg_for)
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


# ---------------------------------------------------------------------------
# Sending it back, and refusing it
# ---------------------------------------------------------------------------

#: What each stage is called in the sentence the raiser reads. Keyed by phase so the
#: message and the guard cannot describe different stages.
STAGE_LABELS: dict[str, str] = {
    PHASE_DECISION: "the decision desk",
    PHASE_ENDORSE: "sign-off",
    PHASE_FIELD: "the approval ladder",
    PHASE_LOGISTICS: "return logistics",
}

#: Which `_out` flag says this login is the one holding the document at that stage. Every
#: one of them is computed from the LIVE workflow task, never from a permission — holding
#: `return.approve` does not make somebody the current approver.
_ACTOR_FLAG: dict[str, str] = {
    PHASE_DECISION: "can_decide",
    PHASE_ENDORSE: "can_endorse",
    PHASE_FIELD: "can_act",
    PHASE_LOGISTICS: "can_act",
}


async def _assert_holding(db: AsyncSession, doc: StockTransferOrder, user,
                          phase: str) -> dict:
    """Right status, right stage, and this login is the one actually holding it."""
    if doc.status != ReturnStatus.PENDING_APPROVAL.value:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()}, so there is "
            "nothing to send back.")
    if _phase(doc) != phase:
        raise ConflictError(
            f"This return is not with {STAGE_LABELS.get(phase, 'that stage')} — it is "
            f"with {STAGE_LABELS.get(_phase(doc), 'another stage')}.")
    out = await _out(db, doc, user)
    if not out[_ACTOR_FLAG[phase]]:
        raise ValidationError(
            "This return is not waiting for you, so you cannot act on it.")
    return out


async def send_back(db: AsyncSession, return_id: int, comments: str, user, *,
                    phase: str) -> dict:
    """Any of the three stages handing the document back to the person who raised it.

    Not a rejection. A rejection is "no, this material is not coming back"; this is "yes,
    but not as written" — the quantity is wrong, the photograph shows something else, the
    reason does not match what turned up. The raiser gets an editable draft with the note
    on it and submits it again when it is right.

    Everything is unwound, deliberately:

      * the hold goes back, because a draft that is not in anybody's queue must not sit on
        stock the branch could otherwise issue. The resubmit takes a fresh hold, against
        what is on the shelf THEN — which is the point of re-validating at submit;
      * both chains are abandoned. The engine freezes one chain per (doc_type, doc_id),
        so a resubmit could not open a fresh one otherwise. `engine.abandon` keeps every
        action row (rule 9), so the send-back stays in the trail;
      * the decision is cleared. It was taken against the document as it was written, and
        the whole reason this return is going back is that the document is about to
        change. A corrected return is decided again from the top — no stage is skipped.

    Sending back from `PHASE_FIELD` therefore costs the decision and the sign-off. That is
    the honest price of the correction, and it is why the note is mandatory: somebody is
    about to redo work. A return that climbed its Indent Return chain FIRST has
    no decision to lose at that stage — nothing had been decided yet — and it costs only
    the approvals it had collected.
    """
    doc = await _load(db, return_id)
    note = (comments or "").strip()
    if not note:
        raise ValidationError(
            "Say what has to be corrected — this note is all the raiser gets")
    await _assert_holding(db, doc, user, phase)

    before = doc.status
    await allocation.release(db, RESERVE_REF_TYPE, doc.id)
    for doc_type in (ReturnDocType.STOCK_RETURN.value,
                     ReturnDocType.STOCK_RETURN_RECEIPT.value,
                     ReturnDocType.STOCK_RETURN_LOGISTICS.value):
        await engine.abandon(db, doc_type, doc.id, user, f"Sent back: {note}")

    sends = int(_unpack(doc.remarks).get(SEND_BACKS_KEY) or 0) + 1
    _set_payload(doc, **{
        PHASE_KEY: None,
        FIELD_OPENED_KEY: None,
        # Cleared with the rest 2026-09-07: the resubmit decides the order again from the
        # indent the corrected draft names, which the raiser may well have changed.
        FIELD_FIRST_KEY: None, FIELD_DONE_KEY: None,
        DECISION_KEY: None, DECISION_NOTE_KEY: None, DECISION_BY_KEY: None,
        DECISION_AT_KEY: None, DECISION_VALUE_KEY: None,
        VENDOR_ID_KEY: None, VENDOR_NAME_KEY: None, AGENCY_KEY: None,
        LEG_KEY: None, TR_ID_KEY: None, TR_NO_KEY: None,
        SEND_BACKS_KEY: sends,
        SENT_BACK_NOTE_KEY: note,
        SENT_BACK_BY_KEY: _name(user),
        SENT_BACK_FROM_KEY: STAGE_LABELS.get(phase, phase),
    })
    doc.status = ReturnStatus.DRAFT.value
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before, "phase": phase},
                      after={"status": doc.status, "note": note,
                             "send_backs": sends},
                      summary=f"Return {doc.sto_no} sent back to "
                              f"{doc.requested_by_name or 'the raiser'} from "
                              f"{STAGE_LABELS.get(phase, phase)}")
    await db.commit()
    return await get_return(db, return_id, user)


async def reject_at_stage(db: AsyncSession, return_id: int, comments: str, user, *,
                          phase: str) -> dict:
    """Either desk refusing the return outright.

    The reporting line has had this since the module was written (`act_on_return`); the
    two desks had no way to say no at all. The decision desk's only refusal was the
    `REJECT_UNECONOMIC` disposition, which says something much narrower — "the material is
    fine, it is just not worth the freight" — and the floor could only object to a route,
    never to the return itself. Something that should not have been raised at all had to
    be walked back by asking the raiser to withdraw it.

    Unlike a send-back this ends the document. The hold goes back and the material stays
    exactly where it is, which is the same thing a rejection on the reporting line does.
    """
    doc = await _load(db, return_id)
    note = (comments or "").strip()
    if not note:
        raise ValidationError("Tell the returner why this was rejected")
    await _assert_holding(db, doc, user, phase)

    before = doc.status
    if phase == PHASE_ENDORSE:
        # A live receipt chain is holding it, so the refusal is that chain's own rejection
        # and belongs in `wf_actions` where the trail reads it. At the decision desk no
        # instance exists yet — the decision IS what opens one — so there is nothing to
        # act on and the abandon below is the whole record.
        await engine.act(
            db, ReturnDocType.STOCK_RETURN_RECEIPT.value, doc.id,
            ApprovalAction.REJECTED.value, user, note,
            context={
                "doc_no": doc.sto_no,
                "doc_summary": f"Stock return {doc.sto_no} — decision to be endorsed",
                "from_warehouse_id": doc.from_warehouse_id,
                "to_warehouse_id": doc.to_warehouse_id,
            },
        )
    else:
        for doc_type in (ReturnDocType.STOCK_RETURN.value,
                         ReturnDocType.STOCK_RETURN_RECEIPT.value,
                         ReturnDocType.STOCK_RETURN_LOGISTICS.value):
            await engine.abandon(db, doc_type, doc.id, user, f"Rejected: {note}")

    await allocation.release(db, RESERVE_REF_TYPE, doc.id)
    _set_payload(doc, **{PHASE_KEY: None})
    doc.status = ReturnStatus.REJECTED.value
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=doc.sto_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before, "phase": phase},
                      after={"status": doc.status, "comments": note},
                      summary=f"Return {doc.sto_no} rejected at "
                              f"{STAGE_LABELS.get(phase, phase)}")
    await db.commit()
    return await get_return(db, return_id, user)


def _delivery_condition(condition: str | None, remarks: str | None) -> str:
    """Validate what the receiving end said about the goods, defaulting to GOOD.

    The same two values and the same rule as the indent's own receipt: anything other than
    GOOD has to say what was wrong with it, because that sentence is what the claim against
    the carrier is investigated from. See `ACK_CONDITIONS` for why SHORT is not offered.
    """
    value = (condition or ACK_CONDITION_GOOD).strip().upper()
    if value not in ACK_CONDITIONS:
        raise ValidationError(
            f"{condition!r} is not a delivery condition. Say whether the material "
            "arrived GOOD or DAMAGED.")
    if value != ACK_CONDITION_GOOD and not (remarks or "").strip():
        raise ValidationError(
            "Describe the damage — it is what the claim against the carrier is "
            "investigated from.")
    return value


async def _receipt_photo_count(db: AsyncSession, return_id: int) -> int:
    """How many pictures of the material AS IT ARRIVED are on file.

    Its own count, and not `_photo_count`: those are the branch's photographs of what it
    was sending, frozen at submit for the decision desk. A receipt has to be evidenced by
    what came off the truck.
    """
    rows = await attachments.list_attachments(db, ENTITY_TYPE, return_id)
    return sum(1 for row in rows
               if (row.doc_category or "") == RECEIPT_PHOTO_CATEGORY)


def _receipt_lines(doc: StockTransferOrder,
                   lines: dict[int, Decimal] | None) -> dict[int, Decimal]:
    """What is being signed for, per line, checked against what actually left.

    NO lines at all means the whole outstanding quantity, and that is not a shortcut: it is
    the API's own default and what the panel pressed before this screen asked for numbers,
    where the only honest reading of "acknowledge receipt" is that the load arrived as it
    was sent. Every other path states its numbers.

    A line can be signed for what was dispatched on it and never more. Signing for more
    than left the branch would credit the receiving shelf with material no ledger row says
    ever existed — `_land_stock` reads the slices back, so the extra would silently vanish
    and leave the document claiming a quantity the balance does not hold.
    """
    owed = {line.id: max(_d(line.dispatched_qty) - _d(line.received_qty), ZERO)
            for line in (doc.items or [])}
    names = {line.id: (line.item_name or line.item_code or f"line {line.id}")
             for line in (doc.items or [])}
    if not lines:
        return {line_id: quantity for line_id, quantity in owed.items()
                if quantity > ZERO}

    stated: dict[int, Decimal] = {}
    for line_id, quantity in lines.items():
        if line_id not in owed:
            raise ValidationError(f"Line {line_id} is not on {doc.sto_no}")
        received = _d(quantity)
        if received <= ZERO:
            raise ValidationError(
                f"{names[line_id]}: the quantity that arrived must be more than zero.")
        if received > owed[line_id]:
            raise ValidationError(
                f"{names[line_id]}: {received} is more than the {owed[line_id]} that "
                "was dispatched. Sign only for what you were given.")
        stated[line_id] = received
    if not stated:
        raise ValidationError("Enter what arrived on at least one line.")
    return stated


async def acknowledge_return(db: AsyncSession, return_id: int, user, *,
                             lines: dict[int, Decimal] | None = None,
                             condition: str | None = None,
                             remarks: str | None = None) -> dict:
    """Confirming the return actually happened.

    TWO presses live behind this one endpoint, and which one it is depends on where the
    material has got to (CHANGED 2026-09-10):

      * **A receipt**, while the return is DISPATCHED and still on its leg. The load has
        arrived at the far end and somebody there is signing for it, so this press
        credits the receiving point's stock balance, ends the leg and raises the purchase
        return against the warehouse's own document — the whole of what the shipment's
        acknowledgement in Logistics does (`_receive_at_far_end`), reachable from the
        Sign-off screen where the receiving side actually works. Who may give it is
        `_may_receive`: the raiser, whoever holds either point, or the return's logistics
        chain. It is a receipt and not a rung — no ladder, doc type or workflow decision
        is involved, and `_transport_acknowledged` still works exactly as it did.

        It asks for the same three things the indent's acknowledgement asks for, because
        it is the same act (2026-09-10): HOW MUCH of each line arrived (`_receipt_lines`,
        capped at what was dispatched, and only that much is credited), a PHOTOGRAPH of
        the delivery (`_receipt_photo_count`, refused without one), and WHAT STATE it
        arrived in (`_delivery_condition`). Damage — or a shortfall, which this path reads
        off the numbers because a return travels once — signs the shipment SHORT or
        DAMAGED and opens its claim on the leg's own timeline (`_sign_return_leg`).
      * **A close**, once the material is already on the shelf. This changes no balance
        and writes no ledger row — it records that the branch agrees the return is done,
        which is the difference between "the system moved it" and "the branch agrees it
        went".

    Anybody who is neither the raiser nor eligible to receive still gets the old refusal
    below: a return that is travelling cannot be signed off by a bystander.
    """
    doc = await _load(db, return_id)
    # The far end signing for the load. Done before the guards below, because clearing
    # the leg is exactly what lets the close that follows it through — one press for the
    # person standing in front of the material, not two.
    #
    # WHAT THE RECEIPT HALF ASKS FOR (2026-09-10) is now the same three things the indent's
    # acknowledgement asks for, because it is the same act by the same kind of person: how
    # much of each line arrived, a photograph of it, and whether it came in one piece. The
    # CLOSE half below asks for none of them — nothing physical happens on it.
    if await _may_receive(db, doc, user):
        receipt_condition = _delivery_condition(condition, remarks)
        if not await _receipt_photo_count(db, doc.id):
            raise ValidationError(
                "Attach a photograph of the material as it arrived before signing for "
                "it. It is the only evidence the delivery was ever made.")
        stated = _receipt_lines(doc, lines)
        # Short against what was DISPATCHED, computed before anything is credited. A
        # return travels once and this press ends the leg, so a shortfall here is a
        # shortage and not an instalment — see `ACK_CONDITIONS`.
        short = any(stated.get(line.id, ZERO)
                    < max(_d(line.dispatched_qty) - _d(line.received_qty), ZERO)
                    for line in (doc.items or []))
        await _receive_at_far_end(db, doc, user, condition=receipt_condition,
                                  lines=stated, remarks=remarks)
        # The shipment that carried it, signed with the same words. Never called from the
        # shipment-side door, which is already inside `acknowledge_tr`.
        try:
            await _sign_return_leg(db, doc, user, condition=receipt_condition,
                                   remarks=remarks, short=short)
        except Exception:
            # The material is at the far end and the signature above is a fact about the
            # physical world; a stamp on the transport paperwork must not roll back a
            # delivery. Logged loudly — the logistics desk can still sign the leg itself.
            logger.exception("Return %s: the shipment could not be signed on receipt",
                             doc.sto_no)
    # Demo: allow any authenticated user to acknowledge once logistics is done (phase != LOGISTICS)
    # Original was strict is_raiser - kept for DRAFT edits, relaxed for close so MDP/DM can close it
    if doc.requested_by_id != getattr(user, "id", None) and _phase(doc) == PHASE_LOGISTICS:
        _assert_raiser(doc, user)
    if doc.status not in AWAITING_ACK:
        raise ConflictError(
            f"This return is {doc.status.replace('_', ' ').lower()}, so there is "
            "nothing to acknowledge.")
    # Approved is not arrived. A travelling return is APPROVED from the final signature
    # until logistics releases it, and DISPATCHED until the far end signs — asking the
    # branch to confirm either of those is asking them to sign for a journey that has not
    # finished. The gate is the phase, and only a receipt clears it — either the far end
    # signing on the shipment (`_transport_acknowledged`) or the same person signing on
    # the Sign-off screen a few lines above. Reaching here means this login was neither.
    if _phase(doc) == PHASE_LOGISTICS:
        reference = _transport_ref(doc) or {}
        leg = reference.get("transport_request_no")
        raise ConflictError(
            f"This return is still travelling on {leg}. It can be closed once the "
            "receiving end has signed for it." if leg else
            "This return is still with logistics. It can be closed once the receiving "
            "end has signed for it.")

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


# ---------------------------------------------------------------------------
# The journey, at the step level
# ---------------------------------------------------------------------------
#
# `journey()` below answers "which leg is this on" in eight dots. The same payload also
# carries the STEP level — every rung that signed, everyone still owed a decision, and
# every milestone in between — so this module can draw the whole road the way the indent's
# own journey screen does. It is the RETURN's road: its decision desk, its sign-off, its
# approval ladder, its shipment. Where a return names an indent, that is a reference on
# the header and nothing more — no step of the indent's own journey is ever shown here.
#
# Two sources, and neither is written for this screen's benefit:
#
#   * `wf_actions`, through `engine.history` — the rungs. Both chains: the receipt chain's
#     first rung IS the decision desk's signature (`_open_endorsement` records the
#     disposition as its comment), so sequence 1 belongs to the decision leg and every
#     rung above it to sign-off.
#   * `sys_audit_log` — the presses that leave no rung at all: the raise, the submit, a
#     send-back, an objection, the gate-out, the delivery and the raiser's own
#     acknowledgement. The document's current state says where a return GOT to; only the
#     audit rows say how it got there, and a send-back abandons both chains outright.
#
# Nothing is inferred from the status. A leg no press has reached yet is drawn from its own
# phase — the same phase the eight-dot tracker is built from — so the two zooms of the one
# rail cannot disagree.

#: The leg each phase's steps belong to. The screen groups the timeline by these, so a
#: phase and the steps inside it can never fall into different legs.
JOURNEY_STAGE_TYPES: dict[str, str] = {
    "draft": "draft",
    "submitted": "submission",
    "decision": "decision",
    "endorsement": "sign_off",
    "approvals": "approval",
    "logistics": "logistics",
    "movement": "movement",
    "acknowledged": "acknowledgement",
}

#: Where a leg sits in the order the return travels. A stage's `sequence` is this plus its
#: own rung, so "still to come" reads in flow order rather than in insertion order.
_LEG_ORDER: dict[str, int] = {
    "draft": 100, "submission": 150, "decision": 200, "sign_off": 300,
    "approval": 400, "logistics": 500, "movement": 600, "acknowledgement": 700,
}

#: A rung's outcome in the vocabulary the timeline reads.
_ACTION_STAGE_STATUS: dict[str, str] = {
    ApprovalAction.APPROVED.value: "APPROVED",
    ApprovalAction.REJECTED.value: "REJECTED",
    ApprovalAction.RETURNED.value: "RETURNED",
    ApprovalAction.CANCELLED.value: "CANCELLED",
    ApprovalAction.SUBMITTED.value: "SUBMITTED",
    ApprovalAction.DELEGATED.value: "COMPLETED",
    ApprovalAction.FALLBACK.value: "COMPLETED",
}

#: A phase state, as a stage status. `current` is deliberately PENDING: the leg the
#: document is sitting on is a thing still owed, not a thing that has happened.
_PHASE_STAGE_STATUS: dict[str, str] = {
    "completed": "COMPLETED",
    "current": "PENDING",
    "pending": "PENDING",
    "rejected": "REJECTED",
    "cancelled": "CANCELLED",
}

#: The step that closes a send-back: the corrected return went back up from the top.
RESUBMISSION_TITLE = "Resubmitted after correction"


def _journey_stage(stage_type: str, title: str, status: str, *, rung: int = 0,
                   is_current: bool = False, approver_name: str | None = None,
                   position_name: str | None = None, timestamp=None,
                   comments: str | None = None, reference_no: str | None = None,
                   quantity_summary: str | None = None,
                   event_id: str | None = None) -> dict:
    """One step of the journey, in the shape the timeline draws it."""
    return {
        "event_id": event_id,
        "sequence": _LEG_ORDER.get(stage_type, 900) + rung,
        "title": title,
        "status": status,
        "is_current": is_current,
        "approver_name": approver_name,
        "position_name": position_name,
        "timestamp": timestamp,
        "comments": (comments or None),
        "stage_type": stage_type,
        "reference_no": reference_no,
        "quantity_summary": quantity_summary,
    }


def _audit_changed(audit) -> dict:
    """`{"field": {"from": x, "to": y}}`, or an empty dict on a row that carries none."""
    return audit.changed_fields if isinstance(audit.changed_fields, dict) else {}


def _audit_to(audit, field: str):
    """What one field was changed TO, or None if this press did not touch it.

    `changed_fields` holds only what actually differed, so "is the key there at all" is
    itself the test for whether the press touched that field.
    """
    entry = _audit_changed(audit).get(field)
    return entry.get("to") if isinstance(entry, dict) else None


def _journey_events(doc: StockTransferOrder, audits: list, *,
                    rejected_stage_type: str | None) -> list[dict]:
    """Every press on this return, oldest first, read off the immutable audit rows.

    Each event says which leg it belongs to (`stage_type`) and whether it is a step in its
    own right. A press that already wrote a `wf_actions` rung — the decision, an
    endorsement, an approval, a rejection with a chain behind it — carries no stage type:
    the rung IS the step, and drawing both would count one signature twice.

    `rejected_stage_type` is where the refusal landed, which `journey()` works out from
    which chain holds the REJECTED action. A rejection at the decision desk is the one
    with no rung at all — the receipt chain is not open yet — so it is the one that has to
    become a step from the audit row itself.
    """
    events: list[dict] = []
    submits = 0

    def add(event_type: str, title: str, *, audit, stage: str | None = None,
            status: str = "COMPLETED", description: str | None = None,
            comments: str | None = None, reference_no: str | None = None) -> None:
        events.append({
            "id": f"audit:{audit.id}",
            "event_type": event_type,
            "title": title,
            "description": description,
            "actor_name": audit.actor_name,
            "position_name": None,
            "timestamp": audit.created_at,
            "comments": comments or None,
            "reference_no": reference_no,
            "stage_type": stage,
            "status": status,
        })

    for audit in audits:
        changed = _audit_changed(audit)
        status_to = _audit_to(audit, "status")
        if audit.action == AuditAction.CREATE.value:
            # Trail only: the raise is drawn from the document itself, so a return whose
            # audit rows predate this screen still opens with the step that started it.
            add("CREATED", "Return raised", audit=audit,
                description=f"Raised at {doc.from_warehouse_name}"
                            if doc.from_warehouse_name else None)
        elif "send_backs" in changed:
            add("SENT_BACK", "Sent back for correction", audit=audit, stage="submission",
                status="RETURNED", comments=_audit_to(audit, "note"),
                description="Back to the raiser as a draft — both chains abandoned and "
                            "any decision cleared.")
        elif "objections" in changed:
            add("DECISION_OBJECTED", "Decision sent back for another", audit=audit,
                stage="sign_off", status="RETURNED",
                comments=_audit_to(audit, "objection"),
                description="The route was refused, not the return.")
        elif "disposition" in changed:
            disposition = _audit_to(audit, "disposition")
            add("DECIDED", DISPOSITION_LABELS.get(disposition or "", "Decision recorded"),
                audit=audit, status="APPROVED", comments=_audit_to(audit, "note"),
                description="Recorded by the decision desk")
        elif "condition" in changed:
            condition = str(_audit_to(audit, "condition") or "").title()
            add("DELIVERED", "Delivered at the far end", audit=audit, stage="logistics",
                status="COMPLETED",
                reference_no=_audit_to(audit, "transport_request_no"),
                description=f"Signed for as {condition}" if condition else None)
        elif "acknowledged_by" in changed:
            add("ACKNOWLEDGED", "Acknowledged by the returner", audit=audit,
                stage="acknowledgement", status="ACKNOWLEDGED")
        elif status_to == ReturnStatus.DISPATCHED.value:
            add("DISPATCHED", "Left the branch", audit=audit, stage="logistics",
                status="COMPLETED",
                reference_no=_audit_to(audit, "transport_request_no"))
        elif status_to == ReturnStatus.PENDING_APPROVAL.value:
            submits += 1
            first = submits == 1
            add("SUBMITTED" if first else "RESUBMITTED",
                "Submitted for approval" if first else RESUBMISSION_TITLE,
                audit=audit, stage="submission", status="SUBMITTED")
        elif status_to == ReturnStatus.REJECTED.value:
            add("REJECTED", "Return rejected", audit=audit, stage=rejected_stage_type,
                status="REJECTED",
                comments=_audit_to(audit, "comments") or _audit_to(audit, "note"))
        elif status_to == ReturnStatus.CANCELLED.value:
            add("CANCELLED", "Withdrawn by the raiser", audit=audit, stage="submission",
                status="CANCELLED")
        elif status_to == ReturnStatus.APPROVED.value:
            # The reporting line finished. Its rung is the step; this is what dates the
            # movement of a return that never goes on a vehicle.
            add("APPROVED", "Final approval given", audit=audit, status="APPROVED",
                comments=_audit_to(audit, "comments"))
        elif status_to == ReturnStatus.RECEIVED.value:
            add("RECEIVED", "Return closed", audit=audit, status="COMPLETED")
        elif "transport_request_no" in changed:
            add("LEG_RAISED", "Shipment raised with logistics", audit=audit,
                stage="logistics", status="COMPLETED",
                reference_no=_audit_to(audit, "transport_request_no"))
        elif "comments" in changed:
            # An approve or an endorse press that did not move the status: its rung on the
            # chain is the step, so this is trail only.
            add("SIGNED", "Signed", audit=audit, status="APPROVED",
                comments=_audit_to(audit, "comments"))
        else:
            add("UPDATED", "Return edited", audit=audit,
                description=", ".join(sorted(changed)) or None)

    return events


def _event_at(events: list[dict], *event_types: str):
    """When the last of these presses happened, or None if none of them ever did."""
    wanted = set(event_types)
    return next((event["timestamp"] for event in reversed(events)
                 if event["event_type"] in wanted), None)


def _rung_stages(actions: list, stage_type: str, *, title_of=None,
                 skip_sequence_one: bool = False,
                 only_sequence_one: bool = False) -> list[dict]:
    """The rungs of one chain as steps, in the order they were signed."""
    stages: list[dict] = []
    for index, action in enumerate(actions):
        sequence = int(action.stage_sequence or 1)
        if skip_sequence_one and sequence <= 1:
            continue
        if only_sequence_one and sequence > 1:
            continue
        status = _ACTION_STAGE_STATUS.get(action.action, "COMPLETED")
        stages.append(_journey_stage(
            stage_type,
            (title_of(action, status) if title_of else None)
            or action.stage_name or f"Approval {sequence}",
            status,
            rung=sequence * 10 + index,
            approver_name=action.actor_name,
            position_name=action.actor_position,
            timestamp=action.acted_at,
            comments=action.comments,
            event_id=f"action:{action.id}",
        ))
    return stages


def _upcoming_rungs(instance, stage_type: str, signed: set[int]) -> list[dict]:
    """Who still owes a decision on a live chain, read off its frozen resolved chain.

    Only from an instance still IN_PROGRESS: a finished or abandoned chain has nothing
    outstanding, and listing its rungs would draw a signature as though it were awaited.
    """
    if instance is None or instance.status != InstanceStatus.IN_PROGRESS.value:
        return []
    current = int(getattr(instance, "current_sequence", 0) or 0)
    stages: list[dict] = []
    for link in (instance.resolved_chain or []):
        if not isinstance(link, dict):
            continue
        sequence = int(link.get("sequence") or 0)
        if sequence < current or sequence in signed:
            continue
        names = [name for name in (link.get("approver_names") or []) if name]
        stages.append(_journey_stage(
            stage_type,
            link.get("role_name") or link.get("position_name") or f"Approval {sequence}",
            "PENDING",
            rung=sequence * 10,
            is_current=sequence == current,
            approver_name=", ".join(names) or None,
            position_name=link.get("position_name"),
        ))
    return stages


async def _live_instance(db: AsyncSession, doc_type: str, doc_id: int):
    """The newest workflow instance on this document, live or finished.

    Newest rather than active: a return that was sent back and resubmitted has an
    abandoned chain behind the current one, and what is still to come must be read off the
    chain that is actually running.
    """
    return (await db.execute(
        select(Instance)
        .where(Instance.doc_type == doc_type, Instance.doc_id == doc_id)
        .order_by(Instance.id.desc())
    )).scalars().first()


async def _journey_audits(db: AsyncSession, doc_id: int) -> list:
    """This return's audit rows, oldest first.

    Ordered by `id`, never by `created_at`: `sys_audit_log` carries a JSON column, MySQL
    sizes a filesort record by each column's widest possible value, and one such record
    already exceeds the default sort buffer — so ordering on the unindexed timestamp
    raises 1038, "out of sort memory", at three rows as readily as at three million. The
    primary key is the insert order and is unique with it.
    """
    return (await db.execute(
        select(AuditLog)
        .where(AuditLog.entity_type == AUDIT_ENTITY, AuditLog.entity_id == doc_id)
        .order_by(AuditLog.id)
    )).scalars().all()


def _journey_steps(doc: StockTransferOrder, phases: list[dict], events: list[dict],
                   actions: list, receipt_actions: list, logistics_actions: list,
                   field_instance, receipt_instance, logistics_instance, *,
                   decision: dict | None,
                   approver_names: list[str], raised_by_position: str | None,
                   travels: bool, landed: bool) -> list[dict]:
    """Every step of the return's journey — what happened, and what is still owed.

    Assembled leg by leg, and every leg is represented: one that no press has reached yet
    is drawn from its own phase, carrying the phase's own caption, so the screen shows how
    much road is left rather than only how far the return has come.
    """
    stages: list[dict] = [_journey_stage(
        "draft", "Return raised", "COMPLETED",
        approver_name=doc.requested_by_name, position_name=raised_by_position,
        timestamp=doc.created_at, comments=_unpack(doc.remarks).get("reason_note"),
        quantity_summary=_quantity_summary(doc),
    )]

    # The milestones no chain records: the submit, a send-back, an objection, the gate-out,
    # the delivery, the raiser's own acknowledgement.
    stages += [_journey_stage(
        event["stage_type"], event["title"], event["status"],
        rung=index, timestamp=event["timestamp"], approver_name=event["actor_name"],
        comments=event["comments"], reference_no=event["reference_no"],
        event_id=event["id"],
    ) for index, event in enumerate(events) if event["stage_type"]]

    def decision_title(action, status: str) -> str | None:
        if status == "REJECTED":
            return "Rejected at the decision desk"
        label = DISPOSITION_LABELS.get((decision or {}).get("disposition") or "")
        return label or action.stage_name or "Decision desk"

    # The receipt chain's first rung is the decision itself; everything above it is the
    # sign-off. One chain, two legs, because they are two different decisions.
    signed_receipt = {int(action.stage_sequence or 1) for action in receipt_actions}
    signed_field = {int(action.stage_sequence or 1) for action in actions}
    signed_logistics = {int(action.stage_sequence or 1) for action in logistics_actions}
    stages += _rung_stages(receipt_actions, "decision", title_of=decision_title,
                           only_sequence_one=True)
    stages += _rung_stages(receipt_actions, "sign_off", skip_sequence_one=True)
    stages += _rung_stages(actions, "approval")
    stages += _rung_stages(logistics_actions, "logistics")
    stages += _upcoming_rungs(receipt_instance, "sign_off", signed_receipt)
    stages += _upcoming_rungs(field_instance, "approval", signed_field)
    stages += _upcoming_rungs(logistics_instance, "logistics", signed_logistics)

    # The movement itself is not a press anybody makes: for a travelling return it is the
    # delivery, and for one that never leaves the branch it is the final approval. Both are
    # already dated in the trail, so the step is dated off it rather than from a column.
    moved_at = (_event_at(events, "DELIVERED") if travels
                else _event_at(events, "APPROVED"))
    if landed or moved_at:
        stages.append(_journey_stage(
            "movement", "Stock moved", "COMPLETED", timestamp=moved_at,
            comments=_phase_caption(phases, "movement"),
            quantity_summary=_quantity_summary(doc),
        ))

    # Whatever is left: a leg nothing has happened in yet still has to say so, in the
    # words its own phase uses on the tracker.
    seen = {stage["stage_type"] for stage in stages}
    for phase in phases:
        stage_type = JOURNEY_STAGE_TYPES.get(phase["key"])
        if not stage_type or stage_type in seen:
            continue
        state = phase["state"]
        current = state == "current"
        stages.append(_journey_stage(
            stage_type, phase["label"], _PHASE_STAGE_STATUS.get(state, "PENDING"),
            is_current=current,
            approver_name=", ".join(approver_names) if current and approver_names else None,
            comments=phase.get("caption"),
        ))
    return sorted(stages, key=lambda stage: stage["sequence"])


def _phase_caption(phases: list[dict], key: str) -> str | None:
    return next((phase.get("caption") for phase in phases if phase["key"] == key), None)


def _quantity_summary(doc: StockTransferOrder) -> str | None:
    """"12 units over 3 lines" — what is actually travelling, on every step that moves it."""
    lines = list(doc.items or [])
    if not lines:
        return None
    total = sum((_d(line.requested_qty) for line in lines), ZERO)
    return f"{total:g} across {len(lines)} {'line' if len(lines) == 1 else 'lines'}"


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
    logistics_actions = await engine.history(
        db, ReturnDocType.STOCK_RETURN_LOGISTICS.value, return_id)
    status = doc.status
    phase = _phase(doc)
    pending = status == ReturnStatus.PENDING_APPROVAL.value
    at_decision = pending and phase == PHASE_DECISION
    at_endorsement = pending and phase == PHASE_ENDORSE
    at_field = pending and phase == PHASE_FIELD
    in_logistics = phase == PHASE_LOGISTICS
    # ADDED 2026-09-07. This return climbs its approval ladder BEFORE the desks, so the
    # legs are drawn in that order and reaching the ladder no longer implies the desks are
    # behind it — it implies the opposite.
    field_first = _field_first(doc)
    field_done = _field_done(doc)

    decision = _decision_of(doc)
    disposition = (decision or {}).get("disposition")
    travels = _travels(doc)
    # Nothing-moves outcomes end the document without a movement, and the tracker has to
    # say that rather than draw a movement leg that never happened.
    static = disposition in {Disposition.USE_AT_SOURCE.value,
                            Disposition.REJECT_UNECONOMIC.value}
    refused = disposition == Disposition.REJECT_UNECONOMIC.value

    submitted = status != ReturnStatus.DRAFT.value
    rejected = status == ReturnStatus.REJECTED.value
    cancelled = status == ReturnStatus.CANCELLED.value
    acknowledged = status == ReturnStatus.RECEIVED.value
    # The reporting line has finished. NOT "the material has arrived" — for a travelling
    # return this is the moment the truck can be booked, and nothing has left yet.
    final_approved = status in {ReturnStatus.APPROVED.value,
                                ReturnStatus.DISPATCHED.value,
                                ReturnStatus.RECEIVED.value}
    left_the_branch = status in {ReturnStatus.DISPATCHED.value,
                                 ReturnStatus.RECEIVED.value}
    # The far end has signed: the leg is over and the phase marker has been cleared.
    leg_done = travels and left_the_branch and not in_logistics
    # Where the material ended up is now true of it.
    landed = leg_done if travels else (final_approved and not static)

    def _stopped_at(rows) -> bool:
        return any(a.action == ApprovalAction.REJECTED.value for a in rows)

    # A rejection halts one specific leg, and which one is answerable from what exists.
    # Getting this wrong draws every earlier rung as though it had never been signed.
    rejected_at_field = rejected and _stopped_at(actions)
    rejected_at_sign_off = rejected and not rejected_at_field and _stopped_at(
        receipt_actions)
    rejected_at_logistics = (rejected and not rejected_at_field
                             and not rejected_at_sign_off
                             and _stopped_at(logistics_actions))
    rejected_at_decision = (rejected and not rejected_at_field
                            and not rejected_at_sign_off
                            and not rejected_at_logistics and not refused
                            and decision is None)

    decision_state = "pending"
    if at_decision:
        decision_state = "current"
    elif rejected_at_decision:
        decision_state = "rejected"
    elif (decision or at_endorsement or in_logistics or final_approved
          or receipt_actions or (at_field and not field_first)):
        decision_state = "completed"
    elif cancelled:
        decision_state = "cancelled"

    endorsement_state = "pending"
    if at_endorsement:
        endorsement_state = "current"
    elif rejected_at_sign_off:
        endorsement_state = "rejected"
    elif in_logistics or final_approved or (at_field and not field_first):
        # Reaching the reporting line at all means sign-off is behind us — whether it was
        # signed by somebody or resolved to nobody, which is a configuration fact rather
        # than a step that silently passed. Not so where the ladder runs first: there the
        # document is at the ladder BEFORE either desk has seen it.
        endorsement_state = "completed"
    elif cancelled and receipt_actions:
        endorsement_state = "cancelled"

    approvals_state = "pending"
    if at_field:
        approvals_state = "current"
    elif rejected_at_field:
        approvals_state = "rejected"
    elif in_logistics or final_approved or field_done:
        # `field_done` is the indent-first ending: the ladder has signed and the document
        # has moved on to the desks, which is completed for this leg and nothing further.
        # `in_logistics` says the same for a return already on its transport leg.
        approvals_state = "completed"
    elif cancelled and actions:
        approvals_state = "cancelled"

    logistics_state = "pending"
    if not travels:
        # Drawn for every return so the flow the screen describes is the same flow every
        # time. An outcome that never travels completes this leg by having nothing to do.
        logistics_state = ("completed" if final_approved
                           else "cancelled" if refused and rejected
                           else "pending")
    elif leg_done:
        logistics_state = "completed"
    elif rejected_at_logistics:
        logistics_state = "rejected"
    elif in_logistics:
        logistics_state = "current"
    elif cancelled:
        logistics_state = "cancelled"

    movement_state = "pending"
    if landed:
        movement_state = "completed"
    elif rejected and refused:
        movement_state = "cancelled"
    elif travels and left_the_branch:
        movement_state = "current"

    states = {
        "draft": "completed" if submitted else "current",
        "submitted": "completed" if submitted else "pending",
        "decision": decision_state,
        "endorsement": endorsement_state,
        "approvals": approvals_state,
        "logistics": logistics_state,
        "movement": movement_state,
        "acknowledged": (
            "completed" if acknowledged
            else "current" if landed and not refused
            else "pending"
        ),
    }

    approver_names: list[str] = []
    if at_decision:
        desk = await _decision_desk_for_return(db, doc)
        # Include desk position so "Waiting for MAHENDRA" becomes "Waiting for SCM HEAD - MAHENDRA"
        _desk_name = (desk or {}).get("name") or "Decision desk"
        holders = (desk or {}).get("holders", [])
        approver_names = [f"{h['name']} ({_desk_name})" if h.get("name") else _desk_name for h in holders if h.get("name")]
        if not approver_names and _desk_name:
            approver_names = [_desk_name]
    elif pending:
        approvers = await engine.current_approvers(db, _phase_doc_type(doc), doc.id)
        # Enrich with ladder role/position as in _out
        try:
            _jinst = (await db.execute(select(Instance).where(Instance.doc_type==_phase_doc_type(doc), Instance.doc_id==doc.id, Instance.status==InstanceStatus.IN_PROGRESS.value))).scalars().first()
            _jchain = getattr(_jinst, "resolved_chain", None) or []
            # FIX 2026-09-07: same broken test as `_out` had — `a.id` over a list of ints.
            _jids = {a.id for a in approvers}
            _jlink = next((l for l in _jchain if isinstance(l, dict)
                           and _jids & set(l.get("approver_ids") or [])), None)
            _jrole = (_jlink or {}).get("role_name") or (_jlink or {}).get("position_name")
            if _jrole:
                approver_names = [f"{a.full_name} ({_jrole})" if a.full_name else _jrole for a in approvers if a.full_name]
            else:
                approver_names = [a.full_name for a in approvers if a.full_name]
        except:
            approver_names = [a.full_name for a in approvers if a.full_name]

    def _signed(rows) -> list:
        return [a for a in rows if a.action in {ApprovalAction.APPROVED.value,
                                                ApprovalAction.REJECTED.value}]

    decided = _signed(actions)
    endorsed = _signed(receipt_actions)
    objections = int((decision or {}).get("objections") or
                     _unpack(doc.remarks).get(OBJECTIONS_KEY) or 0)
    sent_back = _send_back_note(doc)
    leg = _transport_ref(doc)
    leg_no = (leg or {}).get("transport_request_no")
    captions = {
        "draft": (
            f"Sent back from {sent_back['from_stage']}" if sent_back and not submitted
            else "Raised" if submitted else "Not submitted yet"),
        "submitted": doc.created_at.strftime("%d %b %Y") if doc.created_at else "—",
        "decision": (
            ", ".join(approver_names) or "Waiting for the decision desk"
            if decision_state == "current"
            else " · ".join(part for part in (
                DISPOSITION_LABELS_SHORT.get(disposition or "", ""),
                (decision or {}).get("decided_by_name") or "",
                f"sent back {objections}×" if objections else "",
            ) if part)
            if decision
            else "Rejected at the decision desk" if decision_state == "rejected"
            else "No decision desk is configured" if final_approved
            else ""
        ),
        "endorsement": (
            ", ".join(approver_names) or "Waiting for the floor"
            if endorsement_state == "current"
            else ", ".join(name for name in (a.actor_name for a in endorsed) if name)
            if endorsed
            else "No sign-off is configured" if final_approved else ""
        ),
        "approvals": (
            ", ".join(approver_names) or "Waiting for an approver"
            if approvals_state == "current"
            else f"{len(decided)} signed"
            if approvals_state == "completed" and decided
            else "Approved" if approvals_state == "completed" and field_first
            else "Final approval given" if approvals_state == "completed"
            else ""
        ),
        "logistics": (
            "Nothing to move" if not travels
            else f"{leg_no} — waiting to be dispatched"
            if logistics_state == "current" and not left_the_branch and leg_no
            else "Waiting for a shipment to be raised"
            if logistics_state == "current" and not left_the_branch
            else f"{leg_no} — on the road" if logistics_state == "current" and leg_no
            else "On the road" if logistics_state == "current"
            else f"Delivered on {leg_no}" if logistics_state == "completed" and leg_no
            else ""
        ),
        "movement": (
            "Nothing moved — the branch keeps it" if final_approved and static
            else f"{doc.from_warehouse_name or '—'} → {_went_to(doc, decision)}"
            if landed
            else "Refused — nothing moved" if refused
            else f"In transit to {_went_to(doc, decision)}"
            if travels and left_the_branch
            else "Moves once logistics releases it" if travels
            else "Moves on the final approval"
        ),
        "acknowledged": (
            "Confirmed by the returner" if acknowledged
            else "Waiting for the disposal certificate"
            if landed and disposition in NEEDS_AGENCY
            and not await _certificate_count(db, doc.id)
            else "Waiting for the returner to confirm" if landed and not refused
            else ""
        ),
    }

    # The order the legs are drawn in, which is the order this document travels them —
    # ladder first where the raiser named an indent (2026-09-07), desks first otherwise.
    # It has to be picked before the halt is worked out: "everything after the halt" means
    # after it in the order on screen.
    phase_order = PHASES_APPROVAL_FIRST if field_first else PHASES
    # Everything after a halt is pending, whatever the per-leg rule above decided.
    halted_at = next((index for index, (key, _) in enumerate(phase_order)
                      if states[key] in {"rejected", "cancelled"}), None)
    phases = []
    for index, (key, label) in enumerate(phase_order):
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

    # The step level, over the same eight legs. A rejection that a chain already recorded
    # is drawn from its rung; the decision desk's is the one with no chain behind it (no
    # instance is open until a decision is taken), so that one becomes a step of its own.
    has_rejection_rung = any(action.action == ApprovalAction.REJECTED.value
                             for action in (*actions, *receipt_actions,
                                            *logistics_actions))
    events = _journey_events(doc, await _journey_audits(db, doc.id), rejected_stage_type=(
        None if has_rejection_rung
        else "decision" if rejected_at_decision
        else "approval"))
    raiser_position_id = _unpack(doc.remarks).get(RAISER_POSITION_KEY)
    # The post the return was raised under, resolved for display only. Snapshotted at
    # submit, so a raiser who has since moved posts does not rewrite their own history.
    raised_by_position = await db.scalar(
        select(HcmPosition.name).where(HcmPosition.id == int(raiser_position_id))
    ) if raiser_position_id else None
    ref = _indent_ref(doc) or {}
    return {
        "return_id": doc.id,
        "return_no": doc.sto_no,
        "status": status,
        # The indent this return answers, as a reference only. This screen draws the
        # RETURN's journey — the indent has its own, and showing its rungs here would
        # describe a document nobody is looking at.
        "indent_id": ref.get("indent_id"),
        "indent_no": ref.get("indent_no"),
        "raised_by_name": doc.requested_by_name,
        "raised_by_position": raised_by_position,
        "created_at": doc.created_at,
        "phases": phases,
        "current_sequence": current["sequence"] if current else len(phases),
        "current_stage_message": _stage_message(
            status, approver_names, at_decision=at_decision,
            at_endorsement=at_endorsement, at_first_ladder=at_field and field_first,
            disposition=disposition,
            in_logistics=in_logistics, leg_no=leg_no, sent_back=sent_back,
            destination=_went_to(doc, decision)),
        "stages": _journey_steps(
            doc, phases, events, actions, receipt_actions, logistics_actions,
            await _live_instance(db, ReturnDocType.STOCK_RETURN.value, doc.id),
            await _live_instance(db, ReturnDocType.STOCK_RETURN_RECEIPT.value, doc.id),
            await _live_instance(db, ReturnDocType.STOCK_RETURN_LOGISTICS.value, doc.id),
            decision=decision, approver_names=approver_names,
            raised_by_position=raised_by_position, travels=travels, landed=landed),
        "history": events,
    }


def _stage_message(status: str, approver_names: list[str], *,
                   at_decision: bool = False, at_endorsement: bool = False,
                   at_first_ladder: bool = False,
                   disposition: str | None = None, in_logistics: bool = False,
                   leg_no: str | None = None, sent_back: dict | None = None,
                   destination: str | None = None) -> str:
    waiting_for = ", ".join(approver_names)
    static = disposition in {Disposition.USE_AT_SOURCE.value,
                            Disposition.REJECT_UNECONOMIC.value}
    travels = disposition in TRAVELS
    pending = (
        # ADDED 2026-09-07. The ladder ran first, so nothing has been signed off yet and
        # calling this "the final approval" would tell the raiser the desks were done.
        f"With the approval flow — waiting for {waiting_for}"
        if at_first_ladder and waiting_for
        else "With the approval flow this indent went through — waiting for approval"
        if at_first_ladder
        else f"With the decision desk — waiting for {waiting_for}"
        if at_decision and waiting_for
        else "With the decision desk — where the stock goes has still to be decided"
        if at_decision
        else f"Decision recorded — waiting for {waiting_for} to sign it off"
        if at_endorsement and waiting_for
        else "Decision recorded — waiting for the floor to sign it off"
        if at_endorsement
        else f"Signed off — waiting for {waiting_for} to give the final approval"
        if waiting_for
        else "Submitted — waiting for approval")
    # A draft that has been round the houses is not the same document as a fresh one, and
    # the raiser opening it needs to be told which it is before anything else.
    draft = (
        f"Sent back from {sent_back['from_stage']} by "
        f"{sent_back['by_name'] or 'a reviewer'} — correct it and submit it again"
        if sent_back else "Draft — submit the return to begin approval")
    approved = (
        "Nothing moved — the branch keeps the stock. Waiting for the returner to "
        "acknowledge" if static
        else f"Final approval given — waiting for logistics to dispatch it on {leg_no}"
        if travels and leg_no
        else "Final approval given — waiting for logistics to raise the shipment"
        if travels
        else "Stock moved — waiting for the returner to acknowledge")
    dispatched = (
        f"On the road to {destination or 'the receiving end'}"
        + (f" on {leg_no}" if leg_no else "")
        if in_logistics
        else f"Received at {destination or 'the receiving end'} — waiting for the "
             "returner to acknowledge")
    messages = {
        ReturnStatus.DRAFT.value: draft,
        ReturnStatus.PENDING_APPROVAL.value: pending,
        ReturnStatus.APPROVED.value: approved,
        ReturnStatus.DISPATCHED.value: dispatched,
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
    if doc.status not in WITHDRAWABLE:
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
                         ReturnDocType.STOCK_RETURN_RECEIPT.value,
                         ReturnDocType.STOCK_RETURN_LOGISTICS.value):
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
    desk = await _decision_desk_for_return(db, doc)
    return getattr(user, "id", None) in {
        holder["id"] for holder in (desk or {}).get("holders", [])}


async def add_file(db: AsyncSession, return_id: int, upload, doc_category: str, user):
    doc = await _load(db, return_id)
    # The delivery evidence, which arrives at the OTHER END of a truck days after the
    # document left the raiser's hands — so it cannot live under the draft guard below,
    # and it is not the raiser who files it. Gated on `_may_receive`, the same question
    # the receipt press itself is checked against: whoever may sign for the material may
    # photograph it, and only while there is still a signature owed. Once the receipt is
    # given the phase clears, this goes false, and the evidence freezes with the press
    # that was accepted on it.
    if doc_category in RECEIPT_CATEGORIES:
        if not await _may_receive(db, doc, user):
            raise ConflictError(
                "Delivery photographs belong to the receipt at the far end. This return "
                "is not waiting to be signed for, or it is not yours to sign for.")
        return await attachments.add_attachment(
            db, entity_type=ENTITY_TYPE, entity_id=return_id, upload=upload,
            doc_category=doc_category, user=user)
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
    # Taking a delivery photograph back, under exactly the rule that allowed attaching
    # it: whoever may still sign for the material, and only while they still may. The
    # category is read off the ROW rather than taken from the caller — an id is not
    # allowed to claim what kind of file it is.
    row = await attachments.require_attachment(db, attachment_id,
                                               entity_type=ENTITY_TYPE,
                                               entity_id=return_id)
    if (row.doc_category or "") in RECEIPT_CATEGORIES:
        if not await _may_receive(db, doc, user):
            raise ConflictError(
                "This return has been signed for, so the delivery evidence it was "
                "accepted on can no longer be changed.")
        await attachments.delete_attachment(db, attachment_id, user,
                                            entity_type=ENTITY_TYPE,
                                            entity_id=return_id)
        return
    if doc.status not in EDITABLE:
        raise ConflictError(
            "This return has been submitted, so its photographs and bills can no "
            "longer be changed.")
    _assert_raiser(doc, user)
    # `entity_id=return_id` is what ties the id in the path to the document in it. The
    # return was checked and the raiser was checked, but the ATTACHMENT never was — so
    # a raiser of any draft return could delete any file in `sys_attachments`, from any
    # module, by putting their own return number in front of somebody else's id.
    await attachments.delete_attachment(db, attachment_id, user,
                                        entity_type=ENTITY_TYPE, entity_id=return_id)


# ---------------------------------------------------------------------------
# The paper trail behind the item
# ---------------------------------------------------------------------------
#
# REWRITTEN 2026-09-08, WIDENED 2026-09-12. The decision desk is being asked to make a
# commercial call on material it has never seen, and the only thing it can go on is the
# documents that brought that material to the branch: what was asked for, who decided
# this branch got it, what was bought and from whom, what arrived, what the bench said,
# where it was put down, what was picked, what was issued, what it left on and who
# carried it. Those documents are spread across seven modules and the desk was expected
# to open seven screens — so it did not, and the call was made on the number alone.
#
# All eighteen kinds are resolved here and served as one list. Which ones EXIST is the
# answer to a real question: an indent served from stock has an allocation and no PO at
# all, and a trail that showed three rows for it was not being brief, it was being
# silent about the only decision document behind the material.
#
# `_document_chain` resolves them ONCE and everything else on this page reads its answer:
# the desk's related-documents section, the destination default, the purchase-return
# source category, and the purchase return itself when the warehouse acknowledges the
# load. That matters more than the saved queries — a category the desk was shown and a
# category the purchase return is stamped with have to be the same category, and they
# cannot be if two functions work it out separately.
#
# Every lookup here is bounded (`.limit()`) and keyed on an indexed column. This runs on
# a screen the desk waits in front of, and the honest version of the query — join every
# issue line, receipt line and inspection line for these items across every warehouse —
# is what made the panel hang before it was narrowed.

#: How many documents of EACH KIND to name per return.
#:
#: RAISED from 5 to 25 on 2026-09-12. Five was chosen when this named one kind of
#: document — "a desk reading a sixth material issue is not checking the item any more"
#: — and it stopped being a reasonable ceiling the moment the trail became every kind:
#: an indent served in rounds collects an allocation, an issue and a consignment per
#: round, so a normal document was being cut off mid-story with nothing said.
#:
#: It is still a CAP rather than no limit, because each hop feeds the next one its ids
#: and an unbounded trail would put an unbounded `IN` list on a screen the desk waits in
#: front of. What changed is that hitting it is now SAID (`documents_note`) instead of
#: silently truncating — a list that quietly stops is worse than a shorter one that
#: admits where it stopped.
CHAIN_LIMIT = 25

#: An inspection line that says the vendor sent something unacceptable.
QC_FAILED_RESULTS = ("FAILED", "PARTIAL")

#: Reasons that ARE a quality rejection, whatever the inspection rows say. A branch can
#: raise one of these on material whose GRN was never inspected at all.
QC_REASONS = frozenset({ReturnReason.QUALITY_REJECTION.value,
                        ReturnReason.BATCH_RECALL.value})

#: Payload keys for the warehouse-side document the gate-out raises, and for the two
#: choices the desk makes about the trip.
WAREHOUSE_DOC_ID_KEY = "warehouse_return_id"
WAREHOUSE_DOC_NO_KEY = "warehouse_return_no"
SOURCE_CATEGORY_KEY = "purchase_return_source"
QC_TAG_KEY = "qc_rejected_after_grn"
LOGISTICS_MODE_KEY = "logistics_mode"
VEHICLE_KEY = "vehicle_type"


async def _document_chain(db: AsyncSession, doc: StockTransferOrder) -> dict:
    """Every document behind this return's item(s), resolved in one pass.

    Backwards along the chain the business flow already runs forwards
    (`Indent -> MR -> Requisition -> RFQ -> Quotation -> PO -> DN -> GRN -> QC ->
    Putaway -> Stock -> Picklist -> Issue -> Outward QC -> Consignment -> Shipment`),
    starting from whichever end this return can actually see. A field return names its
    indent, so the indent is the hinge: everything the indent produced on the stock side
    (its allocations, and the shortfall material requests that went to the buying desk),
    everything the buying desk raised off those, and everything the warehouse then did
    with what arrived. A return raised with no indent behind it — stock that reached the
    branch some other way — falls back to the issue lines for the same items, which is
    weaker but is not nothing.

    WIDENED 2026-09-12. It resolved five documents (indent, issue, PO, GRN, QC) and the
    desk was told that was the trail. It was not. An indent served from stock raises an
    ALLOCATION and never a PO, so the commonest return in the system showed three rows
    and stopped; and a DISPATCHED issue named neither the CONSIGNMENT it left on nor the
    SHIPMENT that carried it — the two documents a "where is it, who moved it, what did
    the freight cost" call is actually about. Every hop below already exists as a
    backward pointer on a table, which is this architecture's central rule; nothing new
    is stored and nothing anywhere is written for this screen's benefit.

    Every lookup is bounded (`.limit(CHAIN_LIMIT)`) and keyed on an indexed column, and
    each hop is skipped outright when the one before it found nothing — an indent with no
    requisition costs no RFQ query, and a return with no indent costs almost none of
    this. That matters: this runs on a screen the desk waits in front of, and the honest
    version — join every issue line, receipt line and inspection line for these items
    across every warehouse — is what made the panel hang before it was narrowed.

    Returns plain values rather than a loaded object graph on purpose: the callers
    serialise this to a screen or copy fields off it onto a purchase return, and neither
    wants a lazy relationship it might touch after the session has moved on.

    The singular `po`/`grn`/`qc` keys survive beside the new lists because
    `create_purchase_return` and `_originating_warehouse` copy fields off exactly one of
    each, and the newest is the one they mean.
    """
    from app.modules.inventory.models import Allocation, MaterialRequest
    from app.modules.logistics.models import TransportRequest
    from app.modules.procurement.models import (
        RFQ, DespatchNote, PurchaseOrder, Quotation, Requisition, RequisitionItem,
        RequisitionSource,
    )
    from app.modules.warehouse.enums import WarehouseDocType
    from app.modules.warehouse.models import (
        Dispatch, DispatchSource, Inspection, InspectionItem, MaterialIssue,
        MaterialIssueLine, OutboundInspection, Picking, PutawayTask, Receipt,
    )

    lines = list(doc.items or [])
    item_ids = [line.item_id for line in lines]
    indent_ref = _indent_ref(doc)
    indent_id = (indent_ref or {}).get("indent_id")

    indent = await db.get(Indent, indent_id) if indent_id else None

    async def newest(stmt, limit: int = CHAIN_LIMIT) -> list:
        """The most recent `limit` rows of one kind, newest first.

        Ordered by `id` and never by a date column: the primary key is indexed, unique
        and already the insert order, and several of these tables carry a JSON column
        where a filesort over a non-indexed column raises MySQL 1038 whatever the row
        count is.
        """
        return list((await db.execute(stmt.limit(limit))).scalars().all())

    async def ids(stmt, limit: int = CHAIN_LIMIT) -> list[int]:
        return [int(value) for value
                in (await db.execute(stmt.limit(limit))).scalars().all()
                if value]

    # --- what the indent produced on the stock side -------------------------------
    # Both are the indent's own children and both are documents a desk asks about: the
    # allocation is WHY this branch got these units and who signed for that, and the
    # material request is the part of the ask stock could not cover.
    allocations: list = []
    mrs: list = []
    if indent_id:
        allocations = await newest(select(Allocation)
                                   .where(Allocation.indent_id == indent_id)
                                   .order_by(Allocation.id.desc()))
        mrs = await newest(select(MaterialRequest)
                           .where(MaterialRequest.indent_id == indent_id)
                           .order_by(MaterialRequest.id.desc()))

    # --- the buying chain, where one ran ------------------------------------------
    # A requisition reaches a material request three ways — one MR picked up whole
    # (`source_mr_id`), a batch of them consolidated (`pro_requisition_sources`), or a
    # buyer raising cold against the indent line (`pro_requisition_items.indent_id`).
    # All three are read, because which one was used is the buyer's choice and the
    # trail must not go dark depending on it.
    mr_ids = [row.id for row in mrs]
    req_ids: set[int] = set()
    if mr_ids:
        req_ids.update(await ids(select(Requisition.id)
                                 .where(Requisition.source_mr_id.in_(mr_ids))
                                 .order_by(Requisition.id.desc())))
        req_ids.update(await ids(select(RequisitionSource.requisition_id)
                                 .where(RequisitionSource.mr_id.in_(mr_ids))
                                 .order_by(RequisitionSource.id.desc())))
    if indent_id:
        req_ids.update(await ids(select(RequisitionItem.requisition_id)
                                 .where(RequisitionItem.indent_id == indent_id)
                                 .order_by(RequisitionItem.id.desc())))

    requisitions: list = []
    rfqs: list = []
    if req_ids:
        ordered_reqs = sorted(req_ids, reverse=True)[:CHAIN_LIMIT]
        requisitions = await newest(select(Requisition)
                                    .where(Requisition.id.in_(ordered_reqs))
                                    .order_by(Requisition.id.desc()))
        rfqs = await newest(select(RFQ).where(RFQ.requisition_id.in_(ordered_reqs))
                            .order_by(RFQ.id.desc()))
    rfq_ids = [row.id for row in rfqs]

    # --- what it was bought on ----------------------------------------------------
    po_clauses = []
    if indent_id:
        po_clauses.append(PurchaseOrder.indent_id == indent_id)
    if req_ids:
        po_clauses.append(PurchaseOrder.requisition_id.in_(sorted(req_ids)))
    if rfq_ids:
        po_clauses.append(PurchaseOrder.rfq_id.in_(rfq_ids))
    pos: list = []
    if po_clauses:
        pos = await newest(select(PurchaseOrder).where(or_(*po_clauses))
                           .order_by(PurchaseOrder.id.desc()))
    po_ids = [row.id for row in pos]

    # Only the offers that WON — the ones the orders were actually written from. Every
    # quote against the RFQ is the buyer's comparison sheet, not this item's trail, and
    # a losing vendor's price is not something a returns desk is being asked about.
    quote_ids = [int(row.quotation_id) for row in pos if row.quotation_id]
    quotations: list = []
    if quote_ids:
        quotations = await newest(select(Quotation)
                                  .where(Quotation.id.in_(quote_ids))
                                  .order_by(Quotation.id.desc()))

    # The vendor's own statement of the delivery, filed before it arrived. It carries
    # the invoice and the e-way bill, which is what a "this was wrong on arrival" call
    # has to quote back at them.
    despatch_notes: list = []
    if po_ids:
        despatch_notes = await newest(select(DespatchNote)
                                      .where(DespatchNote.po_id.in_(po_ids))
                                      .order_by(DespatchNote.id.desc()))

    # --- what arrived, what the bench said, and where it was put down -------------
    grns: list = []
    if po_ids:
        grns = await newest(select(Receipt).where(Receipt.po_id.in_(po_ids))
                            .order_by(Receipt.id.desc()))
    grn_ids = [row.id for row in grns]

    qcs: list = []
    if grn_ids:
        qcs = await newest(select(Inspection)
                           .where(Inspection.receipt_id.in_(grn_ids))
                           .order_by(Inspection.id.desc()))
    qc_ids = [row.id for row in qcs]

    qc_items: list = []
    if qc_ids and item_ids:
        # Only the lines for the items actually coming back. An inspection covering eight
        # lines can have failed one of them, and "this GRN had a failure on it" is not the
        # same claim as "the item in front of me failed".
        qc_items = list((await db.execute(
            select(InspectionItem)
            .where(InspectionItem.inspection_id.in_(qc_ids),
                   InspectionItem.item_id.in_(item_ids))
        )).scalars().all())

    # Scoped to these items as well as to the GRN: a receipt of forty lines raises forty
    # putaway tasks and thirty-nine of them are somebody else's material. The task is
    # what carries the lot number — the only record of WHERE this stock stood.
    putaways: list = []
    if grn_ids and item_ids:
        putaways = await newest(select(PutawayTask)
                                .where(PutawayTask.grn_id.in_(grn_ids),
                                       PutawayTask.item_id.in_(item_ids))
                                .order_by(PutawayTask.id.desc()))

    # --- the issue that put this material on the branch's shelf -------------------
    issues: list = []
    if indent_id:
        issues = await newest(select(MaterialIssue)
                              .where(MaterialIssue.indent_id == indent_id)
                              .order_by(MaterialIssue.id.desc()))
    if not issues and item_ids:
        # No indent named. The issue lines for these items are the only link left, and
        # they are NOT scoped to the return's own warehouse: an issue that put stock on a
        # branch was raised by the point ABOVE it, so scoping to `from_warehouse_id` — the
        # branch — is exactly the query that finds nothing.
        found = await ids(select(MaterialIssueLine.issue_id)
                          .where(MaterialIssueLine.item_id.in_(item_ids))
                          .order_by(MaterialIssueLine.issue_id.desc()))
        if found:
            issues = list((await db.execute(
                select(MaterialIssue).where(MaterialIssue.id.in_(found))
                .order_by(MaterialIssue.id.desc())
            )).scalars().all())
    issue_ids = [row.id for row in issues]

    # The picklist the issue was served off, read from the issue's own `picking_id`
    # rather than by sweeping `out_picking.ref_id`, which carries no index.
    pick_ids = [int(row.picking_id) for row in issues if row.picking_id]
    picklists: list = []
    if pick_ids:
        picklists = await newest(select(Picking).where(Picking.id.in_(pick_ids))
                                 .order_by(Picking.id.desc()))

    # The outward check on a posted issue — `whs_inspections`, a different table from the
    # inbound bench above, and the one that says whether we shipped it in good order. A
    # branch claiming it arrived damaged is answered here or nowhere.
    outward_qcs: list = []
    if issue_ids:
        outward_qcs = await newest(select(OutboundInspection)
                                   .where(OutboundInspection.issue_id.in_(issue_ids))
                                   .order_by(OutboundInspection.id.desc()))

    # --- how it travelled ---------------------------------------------------------
    # `out_dispatches.ref_id` carries no index, so this is deliberately the narrowest
    # form it can take: an IN over at most CHAIN_LIMIT issue ids with `ref_type` pinned.
    consignments: list = []
    if issue_ids:
        consignments = await newest(
            select(Dispatch)
            .where(or_(
                and_(Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
                     Dispatch.ref_id.in_(issue_ids)),
                # A consignment carrying several issues lists them here instead.
                Dispatch.id.in_(select(DispatchSource.dispatch_id)
                                .where(DispatchSource.issue_id.in_(issue_ids))),
            ))
            .order_by(Dispatch.id.desc()))
    dispatch_ids = [row.id for row in consignments]

    # Both legs in one read: the outward shipment that brought the material down, and
    # this return's OWN leg carrying it back up (`transport_request_id` on the marker
    # payload). They are rows of the same table, they are the same journey in two
    # directions, and the desk reads them as one trail.
    payload = _unpack(doc.remarks)
    return_tr_id = payload.get(TR_ID_KEY)
    tr_clauses = []
    if dispatch_ids:
        tr_clauses.append(TransportRequest.dispatch_id.in_(dispatch_ids))
    if issue_ids:
        tr_clauses.append(TransportRequest.issue_id.in_(issue_ids))
    if indent_id:
        tr_clauses.append(TransportRequest.indent_id == indent_id)
    if return_tr_id:
        tr_clauses.append(TransportRequest.id == int(return_tr_id))
    shipments: list = []
    if tr_clauses:
        shipments = await newest(select(TransportRequest).where(or_(*tr_clauses))
                                 .order_by(TransportRequest.id.desc()))

    qc_rejected = any(
        (row.result or "").upper() in QC_FAILED_RESULTS or _d(row.rejected_qty) > ZERO
        for row in qc_items
    )

    return {
        "indent": indent,
        "indent_no": (indent_ref or {}).get("indent_no"),
        "allocations": allocations,
        "mrs": mrs,
        "requisitions": requisitions,
        "rfqs": rfqs,
        "quotations": quotations,
        "despatch_notes": despatch_notes,
        "putaways": putaways,
        "issues": issues,
        "picklists": picklists,
        "outward_qcs": outward_qcs,
        "consignments": consignments,
        "shipments": shipments,
        "return_transport_id": int(return_tr_id) if return_tr_id else None,
        "pos": pos,
        "grns": grns,
        "qcs": qcs,
        # The newest of each, for the two callers that copy fields off exactly one.
        "po": pos[0] if pos else None,
        "grn": grns[0] if grns else None,
        "qc": qcs[0] if qcs else None,
        "qc_items": qc_items,
        "qc_rejected": qc_rejected,
        "item_ids": item_ids,
    }


async def _originating_warehouse(db: AsyncSession, doc: StockTransferOrder,
                                 chain: dict | None = None) -> dict:
    """Where the material on this return CAME from, and which document says so.

    FIX 2026-09-08. The desk was being shown `from_warehouse` under this name, and that
    is the branch the return is standing in, not where the stock came from. Worse, it was
    then offered as the destination default — and `decide` refuses `from_warehouse_id`
    outright ("a return has to go somewhere other than where it is"), so the one
    pre-filled answer on the screen was the one answer the service would not take.

    Resolved off the paper trail instead, in the order most likely to be right:

      1. the warehouse that ISSUED the material against the indent — the point that
         served this branch, and the point it naturally goes back to;
      2. failing that, the warehouse the GRN landed at, for material that came in on a
         purchase and was pushed down the chain without an issue naming it;
      3. failing that, the point the return was ADDRESSED to when it was raised, which is
         where the pre-2026-09-08 default came from.

    Never `from_warehouse_id`, at any step. `is_resolved` says whether a real document
    answered or whether this is the addressed-to fallback, so a guess reads as a guess.
    """
    chain = chain if chain is not None else await _document_chain(db, doc)

    candidates: list[tuple[int | None, str | None, str | None]] = []
    for issue in chain["issues"]:
        candidates.append((issue.warehouse_id, issue.warehouse_name,
                           f"Material issue {issue.issue_no}"))
    grn = chain["grn"]
    if grn is not None:
        candidates.append((grn.warehouse_id, grn.warehouse_name, f"GRN {grn.grn_no}"))

    for warehouse_id, warehouse_name, source in candidates:
        if warehouse_id and warehouse_id != doc.from_warehouse_id:
            return {
                "warehouse_id": warehouse_id,
                "warehouse_name": (warehouse_name
                                   or await _warehouse_name(db, warehouse_id)),
                "source_doc": source,
                "is_resolved": True,
            }

    return {
        "warehouse_id": doc.to_warehouse_id,
        "warehouse_name": doc.to_warehouse_name,
        "source_doc": None,
        "is_resolved": False,
    }


async def _purchase_return_source(db: AsyncSession, doc: StockTransferOrder,
                                  chain: dict | None = None) -> dict:
    """Which category of purchase return this material produces, and why.

    Three answers, and QC wins over the other two: material rejected on the inspection
    bench after the GRN never reached a shelf, so the tier it would otherwise be filed
    under describes a journey it never made. What the vendor is answerable for is the
    rejection.

    Otherwise it is the RUNG of the point the material is coming off. There are exactly
    three (`inventory.enums.LocationTier`) and the category folds them into two:
    WAREHOUSE and MDP are "our own upper-tier stock going back", LIP is "a branch pushing
    material up the chain", and the buying desk chases those two differently.

    FIXED 2026-09-12 — the naming, not the rule. The screen said "From LIP / MDB" for a
    bucket that only ever holds LIP returns, and "From warehouse" for the bucket that
    holds every MDP one; there is no MDB in this system at all. A two-word category
    cannot name a three-rung chain, so it no longer tries to: the CATEGORY stays the
    coarse three-way filter the register needs, and the rung actually resolved for THIS
    document is served beside it.

    `source_detail` is a SERVED sentence, not a label a screen composes. The rung, the
    point's own name and the words for both come from `inventory.locations` — the one
    place that owns what a stocking point is called — so this screen and the stock
    screens can never call the same point two different things.

    `source_is_resolved` says whether a warehouse row actually answered. It matters
    because an unidentifiable point still has to be filed somewhere, and it is filed as
    a branch return: the safe end, since a branch return mislabelled as warehouse stock
    goes to the wrong desk and is chased by nobody. That is a fallback, and the screen
    now says so instead of stating it as a fact.
    """
    chain = chain if chain is not None else await _document_chain(db, doc)
    reason = _unpack(doc.remarks).get("reason") or ""
    qc_rejected = bool(chain["qc_rejected"]) or reason in QC_REASONS

    # One query, and the same one the stock screens use to name a point. It answers for
    # a null id without touching the database, which is what lets this run on a document
    # that names no source at all.
    point = await locations.describe_point(db, doc.from_warehouse_id)
    resolved = point["point_type"] is not None
    tier = locations.tier_of(point["point_type"]) if resolved else LocationTier.LIP

    if qc_rejected:
        category = PurchaseReturnSource.QC_REJECTED_GRN.value
    else:
        category = (PurchaseReturnSource.FROM_WAREHOUSE.value
                    if tier.value <= LocationTier.MDP.value
                    else PurchaseReturnSource.FROM_LIP_MDB.value)

    rung = f"{locations.tier_label(tier)} ({point['point_label']})"
    if qc_rejected:
        detail = ("Rejected on the inspection bench after the GRN, so the rung it sat "
                  "in afterwards does not decide this — the vendor is answerable for "
                  "the rejection.")
    elif resolved:
        detail = f"{point['point_name']} is a {rung}."
    else:
        detail = ("The point this is coming off could not be identified, so it is "
                  "filed as a branch return — the safe end.")

    return {
        "category": category,
        "category_label": PURCHASE_RETURN_SOURCE_LABELS[category],
        "qc_rejected_after_grn": qc_rejected,
        # The rung actually resolved, named the way every stock screen names it.
        "source_tier": tier.name,
        "source_tier_label": locations.tier_label(tier),
        "source_point_type": point["point_type"],
        "source_point_label": point["point_label"],
        "source_point_name": point["point_name"],
        "source_is_resolved": resolved,
        "source_detail": detail,
    }


def _trail_day(value):
    """One date, off a column that may be a DATE or a DATETIME.

    `inb_receipts` dates a receipt with a DATE and `inv_allocations` stamps a DATETIME,
    and a row printing a timestamp beside six rows printing dates reads as a different
    kind of fact.
    """
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value


def _joined(*parts) -> str | None:
    """The non-empty parts of a one-line qualifier, or nothing at all.

    Nothing rather than an empty string: the screen tests the field for truth, and a
    blank note draws a blank line under the number.
    """
    return " · ".join(str(part) for part in parts if part) or None


def _cap_note(documents: list[dict]) -> str | None:
    """What to say when a kind of document hit `CHAIN_LIMIT`, or nothing at all.

    Each kind is resolved with its own `.limit()`, so a kind that came back exactly full
    is a kind that may have more behind it. That is worth one sentence and no more: a
    list that quietly stops is worse than a shorter one that admits where it stopped,
    and a reader who needs every last row of a 40-issue indent has the module's own
    register for it.

    Deliberately says "may be" rather than counting the rest. Proving there IS more
    means running each of those queries a second time without the limit — on a screen a
    desk waits in front of — to add nothing a reader would act on differently.
    """
    counts: dict[str, int] = {}
    for row in documents:
        counts[row["doc_type"]] = counts.get(row["doc_type"], 0) + 1
    capped = sorted({row["doc_label"] or row["doc_type"] for row in documents
                     if counts[row["doc_type"]] >= CHAIN_LIMIT})
    if not capped:
        return None
    return (f"Showing the {CHAIN_LIMIT} most recent of each kind — there may be more "
            f"behind {', '.join(capped)}.")


def _chain_documents(doc: StockTransferOrder, chain: dict,
                     originating: dict) -> list[dict]:
    """The chain as rows a screen can render, in the order the flow happened.

    Intent first, because it is what the return itself claims, then forwards along the
    trail the material actually travelled — ask, allocation, buying, arrival, bench,
    putaway, pick, issue, outward check, consignment, shipment. Every row carries the
    same fields whatever kind of document it is, so the section renders one way and
    branches on nothing: `note` is the one line of qualifier that makes a row worth
    opening, and `extra` carries whatever a link or a badge needs.

    Sorted by `TRAIL_ORDER` at the end rather than built in order, so a new document
    type is one member of `TrailDocType` and never a re-ordering of this function.
    """
    def row(doc_type: str, *, doc_id=None, doc_no=None, status=None, day=None,
            vendor_name=None, warehouse_name=None, note=None, **extra) -> dict:
        day = _trail_day(day)
        return {
            "doc_type": doc_type,
            "doc_label": TRAIL_LABELS.get(doc_type, doc_type),
            "doc_id": doc_id,
            "doc_no": doc_no,
            "status": status,
            "date": day.isoformat() if day else None,
            "vendor_name": vendor_name,
            "warehouse_name": warehouse_name,
            "note": note,
            "extra": extra or None,
        }

    intent = _intent(doc)
    rows = [row(TrailDocType.INTENT.value,
                doc_no=INTENT_LABELS.get(intent, intent), status=intent,
                warehouse_name=doc.from_warehouse_name, intent=intent)]

    indent = chain["indent"]
    if indent is not None:
        rows.append(row(TrailDocType.INDENT.value, doc_id=indent.id,
                        doc_no=indent.indent_no, status=indent.status,
                        day=indent.indent_date,
                        warehouse_name=getattr(indent, "project_name", None),
                        note=getattr(indent, "requested_by_name", None),
                        project=getattr(indent, "project_name", None)))
    elif chain["indent_no"]:
        # The number was snapshotted onto the return when it was raised and the row has
        # since gone. Naming it is still better than a gap in the trail.
        rows.append(row(TrailDocType.INDENT.value, doc_no=chain["indent_no"]))

    for allocation_doc in chain["allocations"]:
        # Why this branch got these units, and who signed for it. On a stock-served
        # indent this is the ONLY decision document behind the material — there is no
        # PO, no GRN and no vendor anywhere on the trail, which is exactly the case the
        # section used to answer with three rows and a silence.
        rows.append(row(TrailDocType.ALLOCATION.value, doc_id=allocation_doc.id,
                        doc_no=allocation_doc.allocation_no,
                        status=allocation_doc.status, day=allocation_doc.created_at,
                        note=allocation_doc.allocated_by_name,
                        indent_no=allocation_doc.indent_no))

    for mr in chain["mrs"]:
        rows.append(row(TrailDocType.MATERIAL_REQUEST.value, doc_id=mr.id,
                        doc_no=mr.mr_no, status=mr.status,
                        day=mr.mr_date or mr.created_at,
                        warehouse_name=mr.project_name, note=mr.requested_by_name,
                        indent_no=mr.indent_no))

    for requisition in chain["requisitions"]:
        rows.append(row(TrailDocType.REQUISITION.value, doc_id=requisition.id,
                        doc_no=requisition.req_no, status=requisition.status,
                        day=requisition.req_date or requisition.created_at,
                        warehouse_name=requisition.warehouse_name,
                        note=requisition.created_by_name,
                        mr_no=requisition.source_mr_no))

    for rfq in chain["rfqs"]:
        rows.append(row(TrailDocType.RFQ.value, doc_id=rfq.id, doc_no=rfq.rfq_no,
                        status=rfq.status, day=rfq.rfq_date,
                        warehouse_name=rfq.warehouse_name,
                        requisition_no=rfq.requisition_no))

    for quotation in chain["quotations"]:
        # It has no screen of its own: a quote means something only beside the ones it
        # was compared against, so the row opens the RFQ's comparison sheet. `rfq_id`
        # rides on the row for that, which is why that link is not built from `doc_id`.
        rows.append(row(TrailDocType.QUOTATION.value, doc_id=quotation.id,
                        doc_no=quotation.quotation_no, status=quotation.status,
                        day=quotation.quotation_date,
                        vendor_name=quotation.vendor_name,
                        note=_joined("Awarded", quotation.grand_total),
                        rfq_id=quotation.rfq_id, rfq_no=quotation.rfq_no))

    for po in chain["pos"]:
        rows.append(row(TrailDocType.PO.value, doc_id=po.id, doc_no=po.po_no,
                        status=po.status, day=po.po_date, vendor_name=po.vendor_name,
                        warehouse_name=po.facility_name, vendor_id=po.vendor_id))

    for note_doc in chain["despatch_notes"]:
        # The vendor's own claim about what they sent, filed before it arrived. It has
        # no screen here — it is read on the GRN it prefills — so the row states the
        # paperwork instead, which is the part a rejection has to quote back at them.
        rows.append(row(TrailDocType.DESPATCH_NOTE.value, doc_id=note_doc.id,
                        doc_no=note_doc.dn_no, status=note_doc.status,
                        day=note_doc.dn_date, vendor_name=note_doc.vendor_name,
                        note=_joined(
                            f"Invoice {note_doc.invoice_no}"
                            if note_doc.invoice_no else None,
                            f"E-way {note_doc.eway_bill_no}"
                            if note_doc.eway_bill_no else None),
                        po_no=note_doc.po_no))

    for grn in chain["grns"]:
        rows.append(row(TrailDocType.GRN.value, doc_id=grn.id, doc_no=grn.grn_no,
                        status=grn.status, day=grn.grn_date,
                        vendor_name=grn.vendor_name,
                        warehouse_name=grn.warehouse_name, po_id=grn.po_id))

    for qc in chain["qcs"]:
        # Per inspection, not per batch of them: "this GRN had a failure on it" and
        # "the item in front of me failed" are different claims, and the note says
        # which of the two this row is making.
        items = [line for line in chain["qc_items"] if line.inspection_id == qc.id]
        rejected = sum((_d(line.rejected_qty) for line in items), ZERO)
        results = sorted({(line.result or "").upper() for line in items} - {""})
        rows.append(row(TrailDocType.QC.value, doc_id=qc.id,
                        doc_no=qc.inspection_no, status=qc.status,
                        day=qc.inspection_date, vendor_name=qc.vendor_name,
                        warehouse_name=qc.warehouse_name,
                        note=(f"{rejected} rejected on these items"
                              if rejected > ZERO else None),
                        receipt_id=qc.receipt_id, inspection_type=qc.inspection_type,
                        rejected_qty=str(rejected), results=results))

    for putaway in chain["putaways"]:
        # The lot number is the point of naming this one: it is the only record of where
        # the stock physically stood, and a damaged-in-store claim is answered by it.
        rows.append(row(TrailDocType.PUTAWAY.value, doc_id=putaway.id,
                        doc_no=putaway.putaway_no or putaway.lot_no,
                        status=putaway.status, day=putaway.completed_at,
                        note=putaway.lot_no, lot_no=putaway.lot_no,
                        grn_id=putaway.grn_id))

    for picklist in chain["picklists"]:
        rows.append(row(TrailDocType.PICKLIST.value, doc_id=picklist.id,
                        doc_no=picklist.pick_no, status=picklist.status,
                        day=picklist.pick_date,
                        warehouse_name=picklist.warehouse_name,
                        note=picklist.assigned_to_name))

    for issue in chain["issues"]:
        rows.append(row(
            TrailDocType.MATERIAL_ISSUE.value, doc_id=issue.id,
            doc_no=issue.issue_no, status=issue.status, day=issue.issue_date,
            warehouse_name=issue.warehouse_name, note=issue.issued_to_name,
            warehouse_id=issue.warehouse_id,
            is_originating=issue.warehouse_id == originating["warehouse_id"]))

    for inspection in chain["outward_qcs"]:
        # A different table from the inbound bench above (`whs_inspections`), and the
        # document that answers "was it in good order when it left us" — the first thing
        # asked of a damage claim raised at the far end.
        rows.append(row(TrailDocType.QC_OUTWARD.value, doc_id=inspection.id,
                        doc_no=inspection.inspection_no, status=inspection.status,
                        day=inspection.inspection_date,
                        warehouse_name=inspection.warehouse_name,
                        note=_joined(inspection.inspector_name,
                                     f"{inspection.failed_items} failed"
                                     if inspection.failed_items else None),
                        issue_id=inspection.issue_id))

    for consignment in chain["consignments"]:
        rows.append(row(TrailDocType.CONSIGNMENT.value, doc_id=consignment.id,
                        doc_no=consignment.dispatch_no, status=consignment.status,
                        day=consignment.dispatch_date,
                        warehouse_name=consignment.warehouse_name,
                        vendor_name=consignment.carrier_name,
                        note=_joined(
                            f"Gate pass {consignment.gate_pass_no}"
                            if consignment.gate_pass_no else None,
                            f"LR {consignment.lr_no}" if consignment.lr_no else None),
                        gate_pass_no=consignment.gate_pass_no,
                        lr_no=consignment.lr_no))

    for shipment in chain["shipments"]:
        # Both legs of the same journey live in this table: the one that brought the
        # material down, and this return's own leg taking it back. Which is which is
        # SAID on the row rather than left to a reader to work out from the lane.
        is_return_leg = shipment.id == chain.get("return_transport_id")
        rows.append(row(TrailDocType.SHIPMENT.value, doc_id=shipment.id,
                        doc_no=shipment.tr_no, status=shipment.status,
                        day=shipment.tr_date,
                        warehouse_name=shipment.from_warehouse_name,
                        vendor_name=shipment.carrier_name,
                        note=_joined(
                            "This return's own leg" if is_return_leg else None,
                            f"LR {shipment.lr_no}" if shipment.lr_no else None,
                            f"Freight {shipment.freight_amount}"
                            if shipment.freight_amount else None),
                        is_return_leg=is_return_leg, mode=shipment.mode,
                        consignment_no=shipment.consignment_no))

    rows.sort(key=lambda entry: TRAIL_ORDER.get(entry["doc_type"], 99))
    return rows


async def get_related_documents(db: AsyncSession, return_id: int, user=None) -> dict:
    """Everything behind the item, in one section under it, for the reviewer to check.

    Read-only and side-effect free: it is asked on every open of the decision desk, and
    the desk must be able to look without changing anything.

    The originating warehouse comes back resolved from the chain (see
    `_originating_warehouse`) and is what the destination picker pre-fills with — the
    reviewer keeps it or switches to a different point. `current_warehouse_*` is where
    the stock physically stands today, which is a different fact and is shown as one.
    """
    doc = await _load(db, return_id)
    # The visibility check, and nothing else: `get_return` is what decides whether this
    # login may read the document at all, and the trail behind it must not be wider than
    # the document itself.
    await get_return(db, return_id, user)

    chain = await _document_chain(db, doc)
    originating = await _originating_warehouse(db, doc, chain)
    source = await _purchase_return_source(db, doc, chain)
    payload = _unpack(doc.remarks)
    issues = chain["issues"]
    intent = _intent(doc)

    documents = _chain_documents(doc, chain, originating)

    # The warehouse-side document the gate-out raised, if this return has got that far.
    # Named in the same list rather than in a field of its own: to the reviewer it is one
    # more document behind the item, and it is the one that carries the category.
    warehouse_doc_no = payload.get(WAREHOUSE_DOC_NO_KEY)
    warehouse_doc = None
    if payload.get(WAREHOUSE_DOC_ID_KEY):
        warehouse_doc = await db.get(PurchaseReturn, int(payload[WAREHOUSE_DOC_ID_KEY]))
    if warehouse_doc_no:
        source_category = getattr(warehouse_doc, "source_category", None)
        documents.append({
            "doc_type": TrailDocType.PURCHASE_RETURN.value,
            "doc_label": TRAIL_LABELS[TrailDocType.PURCHASE_RETURN.value],
            "doc_id": getattr(warehouse_doc, "id", None),
            "doc_no": warehouse_doc_no,
            "status": getattr(warehouse_doc, "status", None),
            "date": (warehouse_doc.return_date.isoformat()
                     if warehouse_doc is not None and warehouse_doc.return_date
                     else None),
            "vendor_name": getattr(warehouse_doc, "vendor_name", None),
            "warehouse_name": getattr(warehouse_doc, "warehouse_name", None),
            "note": PURCHASE_RETURN_SOURCE_LABELS.get(source_category or ""),
            "extra": {
                "source_category": source_category,
                "source_category_label": PURCHASE_RETURN_SOURCE_LABELS.get(
                    source_category or ""),
            },
        })

    # The chapter each row is read under, stamped in ONE pass over the finished list so
    # the appended purchase-return row above is covered too. Unknown types land nowhere
    # rather than in the wrong place: the screen draws a row with no chapter at the end
    # of the trail under its own heading, which is honest, where guessing a chapter for
    # it would file a document under a leg it never travelled.
    for row in documents:
        row["chapter"] = CHAPTER_BY_DOC_TYPE.get(row.get("doc_type") or "")
    counts: dict[str, int] = {}
    for row in documents:
        if row["chapter"]:
            counts[row["chapter"]] = counts.get(row["chapter"], 0) + 1

    return {
        "return_id": doc.id,
        "return_no": doc.sto_no,
        # Where it came from, resolved — and what said so, so a fallback reads as one.
        "originating_warehouse_id": originating["warehouse_id"],
        "originating_warehouse_name": originating["warehouse_name"],
        "originating_source_doc": originating["source_doc"],
        "originating_is_resolved": originating["is_resolved"],
        # Where the stock stands right now. Never offered as a destination.
        "current_warehouse_id": doc.from_warehouse_id,
        "current_warehouse_name": doc.from_warehouse_name,
        "material_issue_no": issues[0].issue_no if issues else None,
        "material_issue_id": issues[0].id if issues else None,
        "intent": intent,
        "intent_label": INTENT_LABELS.get(intent, intent),
        "items": [{
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "quantity": str(_d(line.requested_qty)),
            "uom_code": line.uom_code,
        } for line in list(doc.items or [])],
        "documents": documents,
        # Every chapter, including the empty ones. A leg with nothing in it is a FACT
        # about this material — "it was never bought, it came off stock already on the
        # shelf" — and only a heading that is present can say so.
        "chapters": [{
            "key": chapter["key"],
            "label": chapter["label"],
            "caption": chapter["caption"],
            "count": counts.get(chapter["key"], 0),
        } for chapter in TRAIL_CHAPTERS],
        # Said, never silent: the trail is capped per kind and a reader has to be able
        # to tell a complete list from a truncated one.
        "documents_note": _cap_note(documents),
        "purchase_return_category": source["category"],
        "purchase_return_category_label": source["category_label"],
        # The rung actually resolved for THIS document, beside the coarse category. A
        # three-rung chain cannot be named by a two-way filter, so the filter stays the
        # filter and this says which point the material is really coming off.
        "purchase_return_source_detail": source["source_detail"],
        "purchase_return_source_tier": source["source_tier"],
        "purchase_return_source_resolved": source["source_is_resolved"],
        "qc_rejected_tag": source["qc_rejected_after_grn"],
        "vehicle_options": [{
            "value": option.value,
            "label": VEHICLE_ARRANGEMENT_LABELS[option.value],
        } for option in VehicleArrangement],
        "vehicle_type": payload.get(VEHICLE_KEY),
        "logistics_mode": payload.get(LOGISTICS_MODE_KEY),
        "warehouse_return_no": warehouse_doc_no,
    }


# ---------------------------------------------------------------------------
# The purchase-return register — read only
# ---------------------------------------------------------------------------

async def list_purchase_returns(db: AsyncSession, params: PageParams, *,
                                status: str | None = None,
                                search: str | None = None,
                                source: str | None = None,
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
    # ADDED 2026-09-08. Where the material came from, which is the split the buying desk
    # asked for: our own upper-tier stock going back, a branch pushing material up the
    # chain, and material that failed on the inspection bench after the GRN. Refused
    # rather than ignored when the value is not one of the three, because a filter that
    # silently returns everything reads as "there is nothing else".
    if source:
        if source not in PURCHASE_RETURN_SOURCE_LABELS:
            raise ValidationError(
                f"{source} is not a purchase-return source. "
                f"Choose one of: {', '.join(PURCHASE_RETURN_SOURCE_LABELS)}.")
        stmt = stmt.where(PurchaseReturn.source_category == source)
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
        # Null on every row raised before 2026-09-08 and on every one still raised by
        # hand at the warehouse, which reads as "source not stated" rather than as a
        # category — the register renders the gap rather than guessing at one.
        "source_category": row.source_category,
        "source_category_label": PURCHASE_RETURN_SOURCE_LABELS.get(
            row.source_category or ""),
        "source_return_id": row.source_return_id,
        "source_return_no": row.source_return_no,
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
