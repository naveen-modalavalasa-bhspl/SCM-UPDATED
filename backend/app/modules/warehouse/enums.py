"""Every status this module writes, plus the permission codes it guards on.

Rule 3: never a raw status string. A status that is not in here does not exist.

The lower_snake values are not a style slip — `whs_warehouse_items.status` and
`whs_serial_numbers.status` are MySQL ENUM columns whose members the DB team
defined in lower case, so writing "COMPLETED" to them raises a truncation error.
The enums mirror the columns; the API normalises for display, not for storage.
"""
from enum import Enum


class ReceiptType(str, Enum):
    """`inb_receipts.receipt_type` — which document this row is at this point."""
    GATE_ENTRY = "GATE_ENTRY"
    PURCHASE = "PURCHASE"
    DIRECT = "DIRECT"
    TRANSFER = "TRANSFER"
    RETURN = "RETURN"
    # Goods arriving at a stocking point from another one — the consignment a
    # warehouse dispatched to an MDP or a LIP. The receiving point inwards it the
    # same way it inwards a purchase (GRN, QC, putaway), so stock only exists at
    # the destination once somebody there says it arrived.
    DISPATCH = "DISPATCH"


class ReceiptStatus(str, Enum):
    """`inb_receipts.status`."""
    DRAFT = "DRAFT"
    GATE_ENTRY = "GATE_ENTRY"
    SUBMITTED = "SUBMITTED"
    PENDING_QC = "PENDING_QC"
    QC_PASSED = "QC_PASSED"
    QC_FAILED = "QC_FAILED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class QcStatus(str, Enum):
    """`inb_receipt_items.qc_status` and `out_issues.qc_status` — the QC outcome."""
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"
    NOT_REQUIRED = "NOT_REQUIRED"


class InspectionType(str, Enum):
    """`inb_inspections.inspection_type`."""
    INCOMING = "INCOMING"
    OUTGOING = "OUTGOING"
    IN_PROCESS = "IN_PROCESS"


class InspectionStatus(str, Enum):
    """`inb_inspections.status` and `whs_inspections.status`."""
    DRAFT = "DRAFT"
    IN_PROGRESS = "IN_PROGRESS"
    # Outward QC only, and only where a QC_OUTWARD ladder is configured: the result is
    # recorded and waiting on a signature before it may release the material issue.
    # Inbound inspections never reach this rung.
    PENDING_APPROVAL = "PENDING_APPROVAL"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class InspectionResult(str, Enum):
    """`inb_inspection_items.result`."""
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


class PutawayStatus(str, Enum):
    """`whs_warehouse_items.status` — a MySQL ENUM, lower case in the schema."""
    DRAFT = "draft"
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class PutawayType(str, Enum):
    """`whs_warehouse_items.putaway_type` — a MySQL ENUM, lower case."""
    SYSTEM_DIRECTED = "system_directed"
    MANUAL = "manual"


class PickingStatus(str, Enum):
    """`out_picking.status`."""
    DRAFT = "DRAFT"
    RELEASED = "RELEASED"
    IN_PROGRESS = "IN_PROGRESS"
    PICKED = "PICKED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class PickLineStatus(str, Enum):
    """`out_picking_items.status`."""
    PENDING = "PENDING"
    PICKED = "PICKED"
    SHORT = "SHORT"
    CANCELLED = "CANCELLED"


class PickStrategy(str, Enum):
    """`out_picking.strategy` — which batch the picker is sent to first."""
    FEFO = "FEFO"
    FIFO = "FIFO"
    MANUAL = "MANUAL"


class IssueStatus(str, Enum):
    """`out_issues.status`."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ISSUED = "ISSUED"
    DISPATCHED = "DISPATCHED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    PARTIALLY_RETURNED = "PARTIALLY_RETURNED"
    RETURNED = "RETURNED"
    CANCELLED = "CANCELLED"


# An issue in one of these is over: it holds no stock and blocks nothing, so the
# indent behind it is free to be issued again. Every other status is LIVE and is
# what the one-issue-per-indent rule counts.
DEAD_ISSUE_STATUSES = (IssueStatus.CANCELLED.value, IssueStatus.REJECTED.value)


class IssueType(str, Enum):
    """`out_issues.issue_type` - what an issue IS, not what it was for.

    It held DEPARTMENT / PROJECT / VEHICLE / CONSUMPTION / SCRAP, which are five
    REASONS, and the reason is already on the document: department, project and
    vehicle are columns of their own, and nothing downstream ever read consumption
    against scrap. The one thing that changes how an issue behaves is whether it
    serves a request somebody raised - so that is what this says.

    `a4d8f2c6b9e3` maps every existing row off `indent_id`, which is the fact the old
    words could only ever agree with or be wrong about.
    """
    INDENT_BASED = "INDENT_BASED"
    DIRECT = "DIRECT"


class IssueDirection(str, Enum):
    """`out_issues.direction` — OUT is an issue, IN is a return of one."""
    OUT = "OUT"
    IN = "IN"


class DispatchStatus(str, Enum):
    """`out_dispatches.status`."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PACKED = "PACKED"
    DISPATCHED = "DISPATCHED"
    IN_TRANSIT = "IN_TRANSIT"
    DELIVERED = "DELIVERED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    CANCELLED = "CANCELLED"


class ConsignmentRefType(str, Enum):
    """`out_dispatches.ref_type` for a consignment built from material issues.

    `ISSUE` is the legacy spelling still on old rows; `WH_ISSUE` is what one issue
    writes today. `MULTI_ISSUE` is a consignment carrying several issues bound for
    the same stocking point: `ref_id` is NULL on it, because one column cannot name
    several documents, and the issues are listed in `out_dispatch_sources`.
    """
    ISSUE = "ISSUE"
    WH_ISSUE = "WH_ISSUE"
    MULTI_ISSUE = "MULTI_ISSUE"


# `ref_type` values under which `out_dispatches.ref_id` is a material issue id.
SINGLE_ISSUE_REF_TYPES = (ConsignmentRefType.ISSUE.value, ConsignmentRefType.WH_ISSUE.value)


class DispatchSourceType(str, Enum):
    """`out_dispatch_sources.source_type` — which kind of document a row lists."""
    ISSUE = "ISSUE"


class DispatchType(str, Enum):
    """`out_dispatches.dispatch_type`."""
    TRANSFER = "TRANSFER"
    CUSTOMER = "CUSTOMER"
    VENDOR_RETURN = "VENDOR_RETURN"
    PROJECT = "PROJECT"


class PackageStatus(str, Enum):
    """`out_dispatch_packages.status`."""
    PACKED = "PACKED"
    LOADED = "LOADED"
    DELIVERED = "DELIVERED"
    DAMAGED = "DAMAGED"


class DispatchEventType(str, Enum):
    """`out_dispatch_events.event_type`."""
    PICKED_UP = "PICKED_UP"
    IN_TRANSIT = "IN_TRANSIT"
    TEMPERATURE_CHECK = "TEMPERATURE_CHECK"
    DELAYED = "DELAYED"
    DELIVERED = "DELIVERED"
    GATE_OUT = "GATE_OUT"


class ReturnStatus(str, Enum):
    """`pro_returns.status`.

    A plain `String(30)` column with no database ENUM behind it, which is why a member
    can be added here without a migration. Nothing is ever RENAMED: the value is written
    on every row already raised, and every reader outside this module (the reports
    ledger, the approvals inbox) passes it through as a string.
    """
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    DISPATCHED = "DISPATCHED"
    # Purchase Return sent to the vendor from a DRAFT (Draft -> Send API).
    # No longer terminal (2026-09-11): the decision desk answers a sent return
    # Approve or Reject, and an approval opens the leg that brings the material
    # back. Kept beside DISPATCHED/COMPLETED so rows raised under the older
    # dispatch flow keep rendering.
    SENT_TO_VENDOR = "SENT_TO_VENDOR"

    # --- after SENT_TO_VENDOR: the decision, and the leg that brings it back -------
    #
    # ADDED 2026-09-11. A sent return used to stop dead: the consignment was with the
    # vendor, the screen was read-only, and whether anybody had agreed the return and
    # how the material was getting back to the warehouse were facts the system did not
    # hold. Six rungs rather than one flag, because a person chasing a return asks
    # exactly these questions in this order — has it been agreed, whose vehicle is
    # coming, has one actually been named, is it moving, is it here.
    #
    # A REJECT lands on the existing REJECTED, not on a seventh value: a refused return
    # is a refused return whichever desk refused it, and every screen already words that.

    #: Approved AFTER it reached the vendor. Deliberately NOT the plain `APPROVED`
    #: above, which means the internal ladder signed the DRAFT and is what
    #: `complete_return` accepts as "ready to move stock out". Landing a post-send
    #: approval there would let the return be completed with the material still sitting
    #: on the vendor's dock.
    #:
    #: WHOSE APPROVAL THIS IS CHANGED on 2026-09-12. It used to be our own returns desk
    #: pressing Approve on a return the vendor was already holding; it is now the
    #: VENDOR's answer, given on their portal before anything has left our warehouse.
    #: The column and the value are unchanged, so every row already carrying it still
    #: reads correctly — what moved is who is asked, and when.
    VENDOR_APPROVED = "VENDOR_APPROVED"
    #: The vendor has approved AND chosen to replace the goods rather than refund them,
    #: so the question is now ours: whose vehicle moves the material to them. Until that
    #: is answered nothing travels and the warehouse owes the only outstanding press.
    #:
    #: Its own rung rather than a flag on VENDOR_APPROVED, because the two are answered
    #: by different parties and a person chasing the return needs to know which desk is
    #: holding it. A REFUNDED return never reaches here — it is settled in money.
    REPLACEMENT_AGREED = "REPLACEMENT_AGREED"
    #: The vendor is putting it on their own vehicle. Nothing is asked of Logistics.
    AWAITING_VENDOR_VEHICLE = "AWAITING_VENDOR_VEHICLE"
    #: The vendor has accepted the collection job and is sending a vehicle for it.
    #: VENDOR_ARRANGES only: on the warehouse-arranged branch there is no such answer to
    #: give, because the vehicle is ours to assign and Logistics assigns it.
    VENDOR_TRANSPORT_ACCEPTED = "VENDOR_TRANSPORT_ACCEPTED"
    #: The material has physically left our warehouse. Reached from BOTH branches — the
    #: vendor recording their pickup, or Logistics releasing the return leg — because
    #: "the goods have gone" is one fact about the world however the truck was booked.
    STOCK_PICKED_UP = "STOCK_PICKED_UP"
    #: The vendor has signed for the returned material at their own dock. Theirs to give
    #: and nobody else's: this is the receipt that ends our liability for the goods.
    VENDOR_RECEIVED = "VENDOR_RECEIVED"
    #: The vendor has put the REPLACEMENT goods on a vehicle towards us, and stated what
    #: is in the carton. This is the rung that raises the inbound receipt the store will
    #: actually book the replacement in against.
    REPLACEMENT_DISPATCHED = "REPLACEMENT_DISPATCHED"
    #: A vehicle request has been raised on the Logistics Dispatch board.
    #:
    #: A return stays on this rung while logistics works the leg, INCLUDING after they
    #: have named the vehicle and the driver. "Vehicle assigned" is deliberately not a
    #: seventh member: nothing here would ever write it. Assigning a truck is a press on
    #: the logistics Dispatch screen, logistics exposes hooks for exactly two moments
    #: (the release and the receiving signature) and neither is that one, so a stored
    #: value would either need a hook in another module or a write on a GET. It is
    #: WORDED instead, off the leg's own columns, by `_decorate_return_inbound_leg` —
    #: which is what `status_label` has always been for.
    VEHICLE_REQUESTED = "VEHICLE_REQUESTED"
    #: LEGACY as of 2026-09-12, and kept valid because rows may carry it. It meant "the
    #: vehicle has collected from the vendor and is on the road" back when the only leg
    #: this document knew about ran vendor -> warehouse. The outward leg that replaced it
    #: is `STOCK_PICKED_UP`, and the replacement coming back is `REPLACEMENT_DISPATCHED`;
    #: between them they say which direction the goods are actually moving, which this
    #: value never could.
    IN_TRANSIT = "IN_TRANSIT"
    #: The material is back in the building and somebody here has signed for it.
    RECEIVED_AT_WAREHOUSE = "RECEIVED_AT_WAREHOUSE"
    #: Settled in money instead of goods. Terminal — nothing travels, so no inbound
    #: leg, no vehicle and no receipt. The amount is `pro_returns.vendor_refund_amount`
    #: (capped at the value of the goods sent back) with its own stamp beside it.
    REFUNDED = "REFUNDED"

    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


# ---------------------------------------------------------------------------------
# WHAT EACH PRESS MAY ACT ON
#
# One frozenset per press, declared here beside the vocabulary rather than spelled out
# as an `== SOME_STATUS` test inside the service. Two things depend on that:
#
#   * "prevent duplicate actions" is enforceable in ONE place. A press whose rung the
#     document has already left is refused by the same guard that refuses it too early,
#     so a double-submit cannot raise a second transport request or a second receipt.
#   * the served `can_*` flags on `ReturnDetail` are computed from these same sets, so
#     the button a screen draws and the guard the server applies cannot drift apart.
#
# Each is a set even where it holds one value today, because the question "which rungs
# does this press accept" is the one a new rung has to answer.
# ---------------------------------------------------------------------------------

#: Where the vendor's Approve / Reject is offered, on their own portal. A return that
#: has been sent and not yet answered, and nothing else — a decided return is past this
#: rung, which is what refuses the second press.
RETURN_DECIDABLE_STATUSES = frozenset({ReturnStatus.SENT_TO_VENDOR.value})

#: Where the vendor chooses Refund or Replacement, once they have approved. Answering
#: closes it: a refunded return must never then be asked whose vehicle is coming, and a
#: return already heading for replacement must not be offered money instead.
RETURN_SETTLEABLE_STATUSES = frozenset({ReturnStatus.VENDOR_APPROVED.value})

#: Where the WAREHOUSE picks who moves the goods. Opened by the vendor agreeing to
#: replace, closed by the choice — the answer decides whether a transport request exists
#: at all, and a second press would raise a second vehicle for one load.
RETURN_TRANSPORTABLE_STATUSES = frozenset({ReturnStatus.REPLACEMENT_AGREED.value})

#: Where the vendor accepts the collection job. VENDOR_ARRANGES only; the service also
#: checks the arrangement, because a status alone cannot say whose vehicle it is.
RETURN_VENDOR_ACCEPTABLE_STATUSES = frozenset({ReturnStatus.AWAITING_VENDOR_VEHICLE.value})

#: Where the vendor records that their vehicle has collected the goods from us.
RETURN_VENDOR_PICKUP_STATUSES = frozenset({ReturnStatus.VENDOR_TRANSPORT_ACCEPTED.value})

#: Where the vendor signs for the material at their own dock. Reachable from both
#: branches: our own leg delivering it, or their vehicle arriving home with it.
RETURN_VENDOR_RECEIVABLE_STATUSES = frozenset({
    ReturnStatus.STOCK_PICKED_UP.value,
    ReturnStatus.VEHICLE_REQUESTED.value,
})

#: Where the vendor raises the replacement dispatch note.
#:
#: THE SEPARATE "sign for the goods" PRESS WAS FOLDED INTO THIS ONE (2026-09-16), and
#: until then `VENDOR_RECEIVED` was the only member of this set. The vendor signed at
#: their own dock, and only then could they dispatch. Two statements days apart was the
#: theory; in practice a vendor who has packed a replacement carton has self-evidently
#: received the faulty one, so the signature was a gate they had to find before the screen
#: would let them do the only thing left to do. The dispatch note carries it now:
#: `vendor_dispatch_replacement` stamps `vendor_receipt_confirmed_at` on its way through
#: wherever nothing had stamped it yet, so the buyer's tracker still shows the goods
#: reaching the vendor before the replacement leaves them.
#:
#: VENDOR_RECEIVED STAYS IN THE SET AND MUST. Returns signed under the old two-press flow
#: are standing on it right now; dropping it would leave every one of them with no press
#: at all and no way to dispatch.
#:
#: Everything on these three rungs is a REPLACEMENT — `vendor_settle_return` lands a
#: refund on REFUNDED, which is terminal and never travels.
RETURN_REPLACEMENT_DISPATCHABLE_STATUSES = frozenset({
    ReturnStatus.STOCK_PICKED_UP.value,
    ReturnStatus.VEHICLE_REQUESTED.value,
    ReturnStatus.VENDOR_RECEIVED.value,
})

#: Where OUR warehouse signs for the replacement coming back.
RETURN_WAREHOUSE_RECEIVABLE_STATUSES = frozenset({
    ReturnStatus.REPLACEMENT_DISPATCHED.value,
})

#: WHERE THE REPLACEMENT'S INTAKE IS LIVE — the rungs on which the goods receipt, its QC
#: inspection and its putaway are the outstanding work, and the return is waiting on them
#: rather than on anybody's press.
#:
#: The intake itself is NOT a set of return statuses and deliberately never became one.
#: A GRN that is drafted, submitted, inspected, passed and put away is a ladder
#: `inb_receipts`, `inb_inspections` and `whs_warehouse_items` already climb, with their
#: own guards on every rung; mirroring it onto `pro_returns` would be a second copy of
#: those five states free to disagree with the documents that hold them. So the return
#: sits on RECEIVED_AT_WAREHOUSE for the whole intake and the journey READS the rung off
#: the receipt (`service._replacement_intake`). What closes the return is the putaway
#: finishing, which is the one moment the intake produces a fact the return did not have.
#:
#: REPLACEMENT_DISPATCHED is in the set because the receipt is raised at the dispatch
#: note, before the lorry arrives: the GRN draft genuinely exists on that rung and the
#: tracker must be able to say so.
RETURN_REPLACEMENT_INTAKE_STATUSES = frozenset({
    ReturnStatus.REPLACEMENT_DISPATCHED.value,
    ReturnStatus.RECEIVED_AT_WAREHOUSE.value,
})

#: RETAINED SPELLINGS, so nothing outside this module breaks on the rename.
#: `RETURN_ARRANGEABLE_STATUSES` was the old name for the transport choice and
#: `RETURN_REFUNDABLE_STATUSES` for the settlement; both are now the sets above.
RETURN_ARRANGEABLE_STATUSES = RETURN_TRANSPORTABLE_STATUSES
RETURN_REFUNDABLE_STATUSES = RETURN_SETTLEABLE_STATUSES

#: The rungs the material is physically in motion on. Read by the screen to decide
#: whether the vehicle panel has anything to show yet, and by the service to guard the
#: presses that record a vehicle or a receipt. `IN_TRANSIT` stays in it for the rows
#: raised under the older, vendor -> warehouse-only flow.
RETURN_INBOUND_STATUSES = frozenset({
    ReturnStatus.AWAITING_VENDOR_VEHICLE.value,
    ReturnStatus.VENDOR_TRANSPORT_ACCEPTED.value,
    ReturnStatus.VEHICLE_REQUESTED.value,
    ReturnStatus.STOCK_PICKED_UP.value,
    ReturnStatus.VENDOR_RECEIVED.value,
    ReturnStatus.REPLACEMENT_DISPATCHED.value,
    ReturnStatus.IN_TRANSIT.value,
})


#: WHERE THE REPLACEMENT'S PAPERWORK IS FILED. `sys_attachments` is keyed by
#: `(entity_type, entity_id)` and a route that does not name the type is acting on the
#: whole store (see `platform/settings/attachments.py`), so the one spelling the return
#: files under lives here rather than as a literal at each call site.
RETURN_ATTACHMENT_ENTITY = "PURCHASE_RETURN"


class ReplacementDocument(str, Enum):
    """THE FILES A REPLACEMENT DISPATCH CARRIES (2026-09-16).

    ONE OF THEM IS REQUIRED, and `required` on the meta below is the only place that
    says which — never a second list, and never a rule written into a screen. The image
    is mandatory: a replacement that arrives with no picture of what was loaded is a
    consignment the buyer's store cannot argue with weeks later, when a short or wrong
    delivery is being settled and nobody has a photograph of the pallet as it left. The
    invoice is OPTIONAL (2026-09-16, at the business owner's request) — it frequently
    follows the goods by a day or two through the supplier's own accounts, and holding
    the lorry for a document that is not written yet stops the delivery rather than the
    mistake.

    They are `doc_category` values on `sys_attachments`, not columns on the return. The
    store already holds the bytes, the audit trail and the download route; a pair of
    `*_attachment_id` columns on `pro_returns` would be a second, narrower copy of a
    table that exists for exactly this.
    """

    #: What is physically on the vehicle, photographed or otherwise pictured as it was
    #: loaded. Restricted to image types by `REPLACEMENT_PHOTO_SUFFIXES` — a PDF is not
    #: a picture of a pallet, and accepting one would make the requirement
    #: unenforceable. This is the one that is mandatory.
    PHOTO = "REPLACEMENT_PHOTO"
    #: The supplier's invoice or delivery bill for the replacement goods. Any business
    #: document type the store accepts, because this one genuinely arrives as a scan, a
    #: photograph of a printed bill or a generated PDF depending on the supplier.
    #: OPTIONAL — see the class docstring.
    INVOICE = "REPLACEMENT_INVOICE"


#: The image extensions the PHOTO slot accepts. A SUBSET of the platform whitelist, which
#: also allows PDFs and Office documents: those are legitimate attachments in general and
#: wrong for this slot in particular. Kept in step with `attachments.ALLOWED_TYPES` — an
#: extension here that the platform refuses would be offered and then rejected on upload.
REPLACEMENT_PHOTO_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif",
})

#: WHAT THE SCREEN ASKS FOR, in the order it asks. Served
#: (`GET /supplier/returns/replacement-documents`) for the same reason
#: `PURCHASE_RETURN_LOGISTICS_MODES` is: the words a supplier is held to and the rule the
#: server enforces must come from one place, or a screen can ask for something the save
#: does not require and refuse something it would have accepted.
REPLACEMENT_DOCUMENT_META: tuple[dict[str, object], ...] = (
    {
        "value": ReplacementDocument.PHOTO.value,
        "label": "Upload image",
        # WHAT A SENTENCE CALLS IT, which is not what the field is captioned. "Upload
        # image" is an instruction on a button and reads as nonsense inside a refusal
        # ("attach the upload image"), so the noun is stated rather than derived from
        # the label. Both still come from this one entry, so they cannot drift.
        "noun": "image of the replacement goods",
        "hint": "A picture of the replacement goods as they are loaded.",
        "accept": "image/*",
        # `capture` FORCES the camera on a phone and hides the gallery with it, so a
        # supplier photographing a pallet at 8am and sending the paperwork from the
        # office at noon could not attach the picture they had already taken. A field
        # called "Upload image" must accept an image that already exists.
        "capture": False,
        "required": True,
    },
    {
        "value": ReplacementDocument.INVOICE.value,
        "label": "Replacement invoice / bill",
        "noun": "replacement invoice or bill",
        "hint": "Your invoice or delivery bill for the goods being sent, if you have it "
                "to hand. A scan, a photograph or a PDF.",
        "accept": "image/*,.pdf,.doc,.docx,.xls,.xlsx",
        "capture": False,
        # OPTIONAL. Flipping this to True is the whole of what it takes to make the
        # invoice mandatory again — the dispatch guard and the screen's disabled press
        # both read it through `REQUIRED_REPLACEMENT_DOCUMENTS` below.
        "required": False,
    },
)

#: The categories that must be on file before a replacement may be dispatched. Read off
#: the meta above rather than restated, so marking one optional there cannot leave a
#: second list still demanding it.
REQUIRED_REPLACEMENT_DOCUMENTS = frozenset(
    str(d["value"]) for d in REPLACEMENT_DOCUMENT_META if d["required"]
)


class ReturnVehicleArrangement(str, Enum):
    """WHO PROVIDES THE VEHICLE that brings an approved return's material back.

    Asked once, immediately after the approval, and it is the only fork in the inbound
    leg. Deliberately its own axis rather than a `TransportMode`: the mode says how a
    load travels and who is paid for it, and both answers here can be any mode. What
    this records is whether OUR logistics desk owes anybody a vehicle — which is the
    thing that decides whether a transport request exists at all.

    It is also deliberately not `returns.enums.VehicleArrangement`, which is the field
    returns module's own two-member enum for an OUTWARD leg (our truck, or the vendor
    collecting). This one is about the leg coming back, the members mean different
    things, and the warehouse module may not import returns anyway — returns sits AFTER
    warehouse in the import chain (rule 5).
    """

    #: The vendor puts the material on their own vehicle and sends it to the warehouse.
    #: Nothing is asked of Logistics; the desk records the vehicle the vendor states.
    VENDOR_ARRANGES = "VENDOR_ARRANGES"
    #: The warehouse asks Logistics for a vehicle. Logistics arranges and assigns one,
    #: it collects from the vendor, and it delivers to the warehouse.
    WAREHOUSE_REQUESTS = "WAREHOUSE_REQUESTS"


#: The two cards the screen offers after an approval, in the order it offers them, with
#: the sentence under each. Served (`GET /returns/vehicle-arrangements`), never written
#: into the frontend, for the same reason `PURCHASE_RETURN_LOGISTICS_MODES` is: the words
#: a desk decides against and the words the audit trail records must not be able to
#: drift apart.
#:
#: `raises_vehicle_request` travels WITH the option rather than being restated in the
#: screen, so a screen never has to test for the string "WAREHOUSE_REQUESTS" to know
#: whether a Logistics leg is about to appear.
RETURN_VEHICLE_ARRANGEMENTS: tuple[tuple[str, str, str, bool], ...] = (
    (ReturnVehicleArrangement.VENDOR_ARRANGES.value,
     "Vendor arranges vehicle",
     "The vendor puts the returned material on their own vehicle and sends it straight "
     "to the warehouse. Nothing is asked of Logistics — record the vehicle and driver "
     "the vendor names, and sign for the load when it arrives.",
     False),
    (ReturnVehicleArrangement.WAREHOUSE_REQUESTS.value,
     "Warehouse requests vehicle",
     "A vehicle request goes to Logistics. They arrange and assign the vehicle, it "
     "picks the material up from the vendor and delivers it to the warehouse. The "
     "vehicle and driver come back from the Logistics leg — nothing here is typed.",
     True),
)

RETURN_VEHICLE_ARRANGEMENT_LABELS: dict[str, str] = {
    value: label for value, label, _help, _raises in RETURN_VEHICLE_ARRANGEMENTS
}

#: The arrangement that hands the leg to Logistics. Derived from the catalogue above so
#: the flag on the card and the branch in the service can never disagree.
RETURN_ARRANGEMENTS_RAISING_REQUEST = frozenset(
    value for value, _label, _help, raises in RETURN_VEHICLE_ARRANGEMENTS if raises)


#: WHAT THE STATUS PILL READS on the rungs added above.
#:
#: Wording over a stored status, exactly the device `VENDOR_RETURN_STAGE_LABELS` below
#: already is. The raw value is what the column holds and what every filter matches on;
#: these are what a person reads. Held here rather than in the frontend so the register,
#: the detail screen and the supplier's copy cannot word one document three ways.
RETURN_STAGE_LABELS: dict[str, str] = {
    ReturnStatus.SENT_TO_VENDOR.value: "With the vendor — awaiting their decision",
    ReturnStatus.VENDOR_APPROVED.value: "Vendor approved — refund or replacement?",
    ReturnStatus.REPLACEMENT_AGREED.value: "Replacement agreed — arrange transport",
    ReturnStatus.AWAITING_VENDOR_VEHICLE.value: "Vendor arranging their vehicle",
    ReturnStatus.VENDOR_TRANSPORT_ACCEPTED.value: "Vendor accepted — collecting from us",
    ReturnStatus.VEHICLE_REQUESTED.value: "Return leg requested from Logistics",
    ReturnStatus.STOCK_PICKED_UP.value: "Picked up — on the way to the vendor",
    ReturnStatus.VENDOR_RECEIVED.value: "Vendor received the returned stock",
    ReturnStatus.REPLACEMENT_DISPATCHED.value: "Replacement dispatched by the vendor",
    ReturnStatus.IN_TRANSIT.value: "On the road to the warehouse",
    ReturnStatus.RECEIVED_AT_WAREHOUSE.value: "Replacement received at the warehouse",
    ReturnStatus.REFUNDED.value: "Refund settled",
}

#: What VEHICLE_REQUESTED reads once logistics has actually named a truck. Its own
#: constant rather than a sixth row above because it is not keyed on a status — see the
#: note on `ReturnStatus.VEHICLE_REQUESTED` for why that rung is worded off the leg
#: rather than split into two stored values.
RETURN_VEHICLE_ASSIGNED_LABEL = "Vehicle assigned — collecting from vendor"


def return_stage_label(status: str | None, *, vehicle_assigned: bool = False
                       ) -> str | None:
    """The pill's wording for one of the inbound-leg rungs, else None.

    None — not a fallback string — on every status that predates this leg, so a screen
    writes `status_label ?? status` and every return raised before today renders exactly
    as it did.

    `vehicle_assigned` refines the one rung that covers two things a person distinguishes:
    a request sitting on the logistics board with nobody on it yet, and the same request
    with a truck and a driver against it. Passed in rather than read here, because only
    the caller has the leg.
    """
    if (vehicle_assigned
            and status == ReturnStatus.VEHICLE_REQUESTED.value):
        return RETURN_VEHICLE_ASSIGNED_LABEL
    return RETURN_STAGE_LABELS.get(status or "")


class VendorReturnResponse(str, Enum):
    """`pro_returns.vendor_response` — the SUPPLIER's answer to goods sent back.

    Mutually exclusive outcomes, answered once from the supplier portal. This is the
    supplier's word about the consignment, and it is deliberately NOT a `ReturnStatus`:
    our own document status describes where the paperwork stands in our warehouse, and
    overloading it with the counterparty's decision would mean a screen could no longer
    tell "we have dispatched it" from "they have accepted it".

    TWO AXES IN ONE COLUMN, which is why the values read oddly beside each other. The
    supplier answers two things at once — do you keep these goods, and if so what do we
    get instead — and the answer is stored as the single outcome those two produce.
    `RETURNED` is the refusal; `REFUNDED` and `REPLACED` are the two ways of keeping
    them. Keeping it one column is what makes "answered once" enforceable: a return can
    never sit accepted with nobody having said whether money or goods are owed.

    REFUNDED settles it in MONEY and nothing further arrives, so it raises no inbound
    receipt. REPLACED and RETURNED both mean goods are coming back INTO our warehouse,
    so each raises a DRAFT inbound receipt (`ReceiptType.RETURN`) — see
    `vendor_respond_to_return`. A draft posts no stock: the store still inwards it
    through the ordinary GRN/QC/putaway path, which is what keeps rule 7 intact.

    ACCEPTED is LEGACY (pre 2026-09-11) and is no longer written by the portal. It said
    the supplier kept the goods without saying what we get back, which is the gap
    REFUNDED and REPLACED close. Kept valid because rows carry it, and every sentence
    about an answer is worded from `VENDOR_RETURN_RESPONSES` rather than matched in a
    screen, so those rows keep reading correctly.
    """
    #: LEGACY. The supplier takes the goods back, settlement unstated. Never written now.
    ACCEPTED = "ACCEPTED"
    #: The supplier refuses them and is sending the SAME goods back to us.
    RETURNED = "RETURNED"
    #: The supplier keeps them and is sending REPLACEMENT goods.
    REPLACED = "REPLACED"
    #: The supplier keeps them and is refunding their value. Settled in money; nothing
    #: travels, so no inbound receipt. The amount is `pro_returns.vendor_refund_amount`.
    REFUNDED = "REFUNDED"


#: The answers that put goods back on a vehicle towards us, and the wording each puts on
#: the inbound receipt it raises. Kept beside the enum so a new outcome cannot be added
#: without deciding whether it produces a document. REFUNDED is deliberately absent: a
#: refund is money, and raising an expected delivery for it would have the store waiting
#: on a lorry that is never coming.
VENDOR_RETURN_INBOUND_RESPONSES = {
    VendorReturnResponse.RETURNED.value: "refused by the supplier and sent back",
    VendorReturnResponse.REPLACED.value: "replacement goods promised by the supplier",
}

#: The answers that settle the return in MONEY and therefore carry a refund amount.
#: A set of one today, and a set rather than an `== REFUNDED` check for the same reason
#: the map above is a map: what an outcome PRODUCES is declared beside the enum, so the
#: next outcome added has to answer the question rather than inherit an answer.
VENDOR_RETURN_REFUND_RESPONSES = {VendorReturnResponse.REFUNDED.value}


#: What the STATUS PILL reads on OUR screens once the supplier has answered.
#:
#: The stored status is untouched — `vendor_response` stays a separate axis for exactly
#: the reason the enum's docstring gives. What was wrong was not the column, it was the
#: SCREEN: a return the supplier had received, accepted and raised a replacement receipt
#: against still showed "SENT_TO_VENDOR", so the one fact a reader opens the document to
#: check was the one fact no pill would say. This is wording over a stored status, the
#: same device `VENDOR_RETURN_STATUS_LABEL` already is on the supplier's side.
#:
#: Each label says the ANSWER and, where goods are moving, WHERE THEY ARE GOING — a
#: replacement's whole point is that something is now inbound to our warehouse, and a
#: pill that said only "Accepted" would leave the store with nothing to expect.
VENDOR_RETURN_STAGE_LABELS = {
    VendorReturnResponse.REPLACED.value: "Replacement to warehouse",
    VendorReturnResponse.RETURNED.value: "Refused — coming back",
    VendorReturnResponse.REFUNDED.value: "Accepted — refund due",
    # LEGACY rows: goods kept, settlement never stated. Worded as what it actually
    # means rather than promising a refund or a replacement that was never recorded.
    VendorReturnResponse.ACCEPTED.value: "Accepted by supplier",
}

#: The only statuses an answer may re-word. A COMPLETED return has been closed on our
#: side and "Completed" outranks whatever the supplier said on the way there; a DRAFT,
#: a PENDING_APPROVAL, a REJECTED or a CANCELLED one cannot carry an answer at all,
#: because the supplier never saw it (`_VENDOR_VISIBLE_RETURN_STATUSES`). Restricting
#: it here rather than trusting the column is what keeps the override from ever
#: out-shouting a status that has moved on.
VENDOR_ANSWERABLE_RETURN_STATUSES = {
    ReturnStatus.SENT_TO_VENDOR.value,
    ReturnStatus.DISPATCHED.value,
}


def vendor_return_stage_label(status: str | None,
                              vendor_response: str | None) -> str | None:
    """The pill's wording for a return the supplier has answered, else None.

    None — not a fallback string — when there is no answer or the status has moved past
    one, so every screen can write `status_label ?? status` and a return raised before
    the portal could answer at all keeps rendering exactly as it did.
    """
    if not vendor_response or status not in VENDOR_ANSWERABLE_RETURN_STATUSES:
        return None
    return VENDOR_RETURN_STAGE_LABELS.get(vendor_response)


# ---------------------------------------------------------------------------------
# THE JOURNEY
#
# The twelve legs a purchase return travels, in the order a person reads them. Held here
# rather than in the frontend for the same reason `RETURN_STAGE_LABELS` is: the tracker
# on the screen and the guards in the service must describe one flow, not two.
#
# EVERY leg is drawn for EVERY return, including the ones a particular document will
# never reach — a refund never gets to transport, a rejected return never gets past the
# decision. A tracker that hides steps per document describes a different flow on every
# screen, so a leg with nothing to do is CAPTIONED as having nothing to do rather than
# dropped. That is the rule the stock-return tracker (`returns.enums.PHASES`) already
# follows, and this is its purchase-return counterpart.
#
# `settlement` and `transport` stay separate legs because they are answered by different
# parties: the vendor says refund-or-replace, and only then does our warehouse say whose
# vehicle. Collapsing them was what left the old screen unable to say who was holding it.
#
# THE LAST THREE BEFORE `closed` ARE THE STORE'S ORDINARY INWARD PATH (added 2026-09-14),
# not a second one built for returns. `grn`, `qc` and `putaway` are READ off the goods
# receipt the replacement dispatch note raised, its inspection and its putaway tasks —
# three documents that already exist, already have their own guards, and are already
# worked on their own screens. The tracker names them because a storekeeper chasing a
# replacement asks exactly these three questions after "has it arrived": is it booked in,
# has QC passed it, and is it on the shelf. Until this the journey went straight from
# "Warehouse received" to "Closed", so the whole of the work that actually happens to the
# goods was a gap in the middle of the story.
#
# They are LEGS, never statuses on `pro_returns` — see `RETURN_REPLACEMENT_INTAKE_STATUSES`
# for why mirroring the receipt's ladder onto the return was refused.
# ---------------------------------------------------------------------------------
PURCHASE_RETURN_PHASES: tuple[tuple[str, str], ...] = (
    ("created", "Created"),
    ("sent_to_vendor", "Sent to vendor"),
    ("vendor_decision", "Vendor decision"),
    ("settlement", "Refund / Replacement"),
    ("transport", "Transport"),
    ("vendor_received", "Vendor received"),
    ("replacement_dispatched", "Replacement dispatched"),
    ("warehouse_received", "Warehouse received"),
    ("grn", "GRN"),
    ("qc", "QC inspection"),
    ("putaway", "Putaway"),
    ("closed", "Closed"),
)

#: Nothing further will happen to the document. Read by the journey to mark the last leg
#: and by the screens to stop offering presses.
RETURN_CLOSED_STATUSES = frozenset({
    ReturnStatus.COMPLETED.value,
    ReturnStatus.REJECTED.value,
    ReturnStatus.CANCELLED.value,
    ReturnStatus.REFUNDED.value,
})


class SerialStatus(str, Enum):
    """`whs_serial_numbers.status` — a MySQL ENUM, lower case in the schema."""
    AVAILABLE = "available"
    ISSUED = "issued"
    CONSUMED = "consumed"
    RETURNED = "returned"
    MAINTENANCE = "maintenance"
    SCRAPPED = "scrapped"


class TrackingType(str, Enum):
    """What one physical unit of an item is IDENTIFIED by, on any screen that lists
    identifiers.

    Not a column: it is read off the item master (`is_serial_tracked`,
    `is_imei_tracked`, `is_asset`) together with whether the point actually holds
    coded units. It exists because the issue screen used to list serials, IMEIs,
    asset codes and consumable codes in one undifferentiated column, and a
    storekeeper holding a handset could not tell which of its two numbers the line
    was asking him to scan.

    Distinct from `service._unit_mode`, and deliberately so. `_unit_mode` answers
    "which column does the backend VALIDATE against" and has three members, because
    an asset code and a consumable code are the same column to a matcher. This
    answers "what is the storekeeper looking at", which is the question a badge on a
    screen is for, and there an asset tag and a consumable lot code are not the same
    thing at all.
    """
    SERIAL = "SERIAL"
    IMEI = "IMEI"
    ASSET = "ASSET"
    CONSUMABLE = "CONSUMABLE"
    NONE = "NONE"


# The wording of a tracking type, SERVED (`GET /api/warehouse/tracking-types`) rather
# than mapped in a screen — same rule as `ACTIVITY_META` in logistics. `label` names
# the badge, `unit` names one of them in a sentence ("3 of 5 asset tags"), and `hint`
# is what the storekeeper is being asked to read off the goods.
TRACKING_META: dict[str, dict[str, str]] = {
    TrackingType.SERIAL.value: {
        "label": "Serial no",
        "unit": "serial",
        "hint": "Scan the serial number printed on the unit or its carton.",
    },
    TrackingType.IMEI.value: {
        "label": "IMEI",
        "unit": "IMEI",
        "hint": "Scan the 15-digit IMEI on the handset or its box label.",
    },
    TrackingType.ASSET.value: {
        "label": "Asset tag",
        "unit": "asset tag",
        "hint": "Scan the asset tag stamped on the unit at putaway.",
    },
    TrackingType.CONSUMABLE.value: {
        "label": "Consumable lot",
        "unit": "lot code",
        "hint": "Scan the consumable code stamped on the pack at putaway.",
    },
    TrackingType.NONE.value: {
        "label": "Not tracked",
        "unit": "unit",
        "hint": "This item is counted, not identified — there is nothing to scan.",
    },
}


class BatchStatus(str, Enum):
    """`stk_batches.status`."""
    ACTIVE = "ACTIVE"
    QUARANTINED = "QUARANTINED"
    EXPIRED = "EXPIRED"
    RECALLED = "RECALLED"
    CONSUMED = "CONSUMED"


class WarehouseDocType(str, Enum):
    """`doc_type` for the workflow engine and `sys_doc_series`.

    Kept separate from `app.shared.enums.DocType`, which is the lead's file: the
    engine takes the string, so a module can name its own document types without
    anything shared having to change.
    """
    RECEIPT = "RECEIPT"
    GATE_ENTRY = "GATE_ENTRY"
    INSPECTION = "INSPECTION"
    PUTAWAY = "PUTAWAY"
    PICKING = "PICKING"
    WH_ISSUE = "WH_ISSUE"
    DISPATCH = "DISPATCH"
    PURCHASE_RETURN = "PURCHASE_RETURN"
    STOCK_MOVEMENT = "STOCK_MOVEMENT"
    # The multi-line ORDER, as against the single bin-to-bin movement above. Its own
    # doc type since 2026-08-21 for two reasons: they were sharing one `sys_doc_series`
    # (so an order and a movement drew from the same running number), and an order is
    # the thing an approval ladder can be configured against — a movement is what the
    # order produces once it is signed.
    STOCK_MOVEMENT_ORDER = "STOCK_MOVEMENT_ORDER"
    # The outward check on a posted issue. Same string as
    # `shared.enums.DocType.QC_OUTWARD`, which is what puts it on Approvals
    # Config; INSPECTION stays the NUMBERING series for both directions.
    QC_OUTWARD = "QC_OUTWARD"
    # Not a document — a series, so a lot number is numbered like everything else.
    LOT = "lot"
    # The NUMBERING series of an `out_dispatches` row, the consignment — CON, not DSP
    # (2026-09-26). A consignment is the warehouse's packed load and was drawing on the
    # DISPATCH series, so every one of them went to paper as `.../DSP0025` beside a
    # screen, a print and a label that all say "Consignment". DISPATCH stays the
    # WORKFLOW doc type — ladders on Approvals Config, `wf_instances` and permissions
    # are keyed on it — exactly as INSPECTION numbers what QC_OUTWARD approves.
    # Numbers already issued are never rewritten: package labels encode them
    # (`scan_package` resolves a label by `dispatch_no`) and the gate pass carries one.
    CONSIGNMENT = "CONSIGNMENT"


class RefType(str, Enum):
    """What a picklist or dispatch was raised against."""
    INDENT = "INDENT"
    ISSUE = "ISSUE"
    DISPATCH = "DISPATCH"
    PO = "PO"


# ---------------------------------------------------------------------------
# Permission codes.
#
# RE-EXPORTED, never re-declared. `app/platform/rbac/permissions.py` is the single
# source of truth (rule 6), and this module used to keep its own copy of the same 25
# strings "so routers reference a constant". That worked right up until one of them
# drifted: `return.view`, `return.create` and `return.approve` ended up declared in
# three places, and the only reason nothing broke is that all three copies happened
# to agree.
#
# Importing them means the router keeps its existing `from ...warehouse.enums import
# RECEIPT_VIEW` lines unchanged, and a code that is renamed in the catalogue is
# renamed here too — or fails loudly at import, which is the point.
# ---------------------------------------------------------------------------
from app.platform.rbac.permissions import (  # noqa: F401  (re-exported)
    DISPATCH_ACKNOWLEDGE,
    DISPATCH_APPROVE,
    DISPATCH_CREATE,
    DISPATCH_DELETE,
    DISPATCH_GATE_OUT,
    DISPATCH_VIEW,
    INSPECTION_DELETE,
    INSPECTION_EXECUTE,
    INSPECTION_VIEW,
    ISSUE_CREATE,
    ISSUE_DELETE,
    ISSUE_FORWARD,
    ISSUE_SPLIT,
    ISSUE_VIEW,
    MASTER_LOCATION_MANAGE,
    MOVEMENT_APPROVE,
    MOVEMENT_CREATE,
    MOVEMENT_DELETE,
    MOVEMENT_UPDATE,
    MOVEMENT_VIEW,
    PICKING_DELETE,
    PICKING_PICK,
    PICKING_VIEW,
    PUTAWAY_DELETE,
    PUTAWAY_EXECUTE,
    PUTAWAY_VIEW,
    QC_OUTWARD_VIEW,
    QC_OUTWARD_CREATE,
    QC_OUTWARD_UPDATE,
    QC_OUTWARD_APPROVE,
    QC_OUTWARD_EXPORT,
    QC_OUTWARD_DELETE,
    RECEIPT_CREATE,
    RECEIPT_DELETE,
    RECEIPT_POST,
    RECEIPT_VIEW,
    RETURN_APPROVE,
    RETURN_CREATE,
    RETURN_DELETE,
    RETURN_VIEW,
    STOCK_TRANSFER,
    STOCK_VIEW,
    WAREHOUSE_REPORT_VIEW,
)

# The one name that differs: this module has always called `issue.issue` ISSUE_POST,
# and the catalogue calls it ISSUE_ISSUE. Aliased rather than renamed so no router
# line changes and no permission code moves.
from app.platform.rbac.permissions import ISSUE_ISSUE as ISSUE_POST  # noqa: F401
