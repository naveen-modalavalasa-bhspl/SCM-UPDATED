"""ALL status/enum values in the entire system. Never type a raw status string.

Values marked (added) are not in guide Part 6 but are required by the higher-
precedence addendum (Part D workflow engine) or by doc 03. See root CLAUDE.md
"Deviations" for the rationale.
"""
from enum import Enum


class IndentStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PENDING_APPROVAL = "PENDING_APPROVAL"   # added: engine uses it (addendum Part D)
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    # Set by inventory allocation once an approved indent has been checked against
    # stock (flow doc §3 steps 3-5).
    # Approval no longer allocates. It parks the indent here, in front of the person
    # who decides how much to give and from where.
    AWAITING_ALLOCATION = "AWAITING_ALLOCATION"
    ALLOCATED = "ALLOCATED"                       # every line reserved from stock
    PARTIALLY_ALLOCATED = "PARTIALLY_ALLOCATED"   # some reserved, rest went to an MR
    PARTIALLY_FULFILLED = "PARTIALLY_FULFILLED"   # physical goods partially received
    PENDING_PROCUREMENT = "PENDING_PROCUREMENT"   # nothing given, all of it to an MR
    PARTIALLY_ORDERED = "PARTIALLY_ORDERED"
    ORDERED = "ORDERED"
    CLOSED = "CLOSED"
    # An approver handed the request back for a fix without ending the approval:
    # the wf_instance stays IN_PROGRESS and resumes at the same rung on resubmit
    # (workflow.engine.return_for_correction / resubmit_correction). Not DRAFT —
    # a draft has no live approval behind it.
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION"
    # Live downstream fulfilment stages
    QC_PASSED = "QC_PASSED"
    QC_IN_PROGRESS = "QC_IN_PROGRESS"
    IN_CONSIGNMENT = "IN_CONSIGNMENT"
    IN_TRANSIT = "IN_TRANSIT"
    DELIVERED = "DELIVERED"


class POStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PENDING_APPROVAL = "PENDING_APPROVAL"   # added
    # An approver sent the order back one rung for a fix, with a reason. The approval
    # is paused, not ended: the wf_instance stays IN_PROGRESS and resumes at the rung
    # that sent it back (engine.return_for_correction / resubmit_correction).
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    SENT_TO_VENDOR = "SENT_TO_VENDOR"
    #: The vendor answered yes. A rung of its own, not just `vendor_status`,
    #: so the receiving desk can be shown orders somebody has actually agreed
    #: to deliver without reading a second column to find out.
    ACCEPTED_BY_SUPPLIER = "ACCEPTED_BY_SUPPLIER"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class POVendorStatus(str, Enum):
    """What the VENDOR has said about an order we sent them.

    Kept apart from `POStatus` on purpose. A purchase order's status is where the
    document is in OUR process; this is the counterparty's answer to it, and folding
    the two together would have meant a new PO status that every existing filter,
    badge, GRN guard and report had to learn about.

    PENDING is set when the order is sent. Nothing may be received against an order
    the vendor has not accepted, and an accepted order can only be changed by an
    amendment the vendor accepts again — that is what makes it a contract.
    """
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"


class GRNStatus(str, Enum):
    DRAFT = "DRAFT"
    RECEIVED = "RECEIVED"
    QC_PASSED = "QC_PASSED"
    QC_FAILED = "QC_FAILED"
    CLOSED = "CLOSED"


class IssueStatus(str, Enum):
    DRAFT = "DRAFT"
    ISSUED = "ISSUED"
    CANCELLED = "CANCELLED"


class ApprovalAction(str, Enum):
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    RETURNED = "RETURNED"        # added: wf_actions (addendum Part D)
    DELEGATED = "DELEGATED"      # added
    # Written when the document itself was withdrawn, so the approval behind it is
    # closed without anybody having decided anything. Not a decision — see
    # workflow.engine.abandon().
    CANCELLED = "CANCELLED"
    # Written when configuration failed to produce an approver and the hardcoded
    # reporting-manager ladder took over. Never an action a person performs.
    FALLBACK = "FALLBACK"
    # Written when an admin re-pointed a document already in approval at a different
    # ladder (or a different version of the same one) and the chain was re-resolved.
    # Not a decision either — see workflow.engine.move_to_workflow().
    MOVED = "MOVED"


class StockDirection(str, Enum):
    IN = "IN"
    OUT = "OUT"


class AdjustmentReason(str, Enum):
    DAMAGE = "DAMAGE"
    SHORTAGE = "SHORTAGE"
    EXCESS = "EXCESS"
    CYCLE_COUNT = "CYCLE_COUNT"
    EXPIRY = "EXPIRY"
    QUALITY_REJECTION = "QUALITY_REJECTION"
    OPENING_BALANCE = "OPENING_BALANCE"
    OTHER = "OTHER"


class UserRole(str, Enum):
    """Seed role CODES. Roles are data in rbac_roles; there is no user.role column."""
    ADMIN = "ADMIN"
    REQUESTER = "REQUESTER"
    APPROVER = "APPROVER"
    PROCUREMENT = "PROCUREMENT"
    STORE = "STORE"


# ---- Workflow engine enums (addendum Part D; values defined there, enumerated here) ----

class DocType(str, Enum):
    INDENT = "INDENT"
    MONTHLY_INDENT = "MONTHLY_INDENT"
    ALLOCATION = "ALLOCATION"   # inventory's decision on how much stock to give
    # The same decision, made by the person who HOLDS the stock rather than by the
    # inventory desk: an OE serving an indent out of his own MDP or a LIP under him.
    # A separate event because the approver is a different person for a different
    # reason — nobody above him owns that shelf, so climbing to a manager asks the
    # wrong question. Configured on its own row in Approvals Config.
    OWN_STOCK_ALLOCATION = "OWN_STOCK_ALLOCATION"
    # The physical issue out of a point you hold, to a point under you. Same document
    # as WH_ISSUE; different approver, for the same reason as OWN_STOCK_ALLOCATION —
    # the shelf is yours, so the sign-off is yours. Keeps the ordinary warehouse issue
    # ladder untouched.
    OWN_STOCK_ISSUE = "OWN_STOCK_ISSUE"
    # Stock that never belonged to this point: it arrived here on a consignment for an
    # indent whose delivery point sits below, and is only being passed along (WH -> MDP
    # -> LIP). The five people who signed the indent already sanctioned these goods, so
    # asking the MDP to justify forwarding them re-approves a settled decision. Its own
    # doc type rather than reusing OWN_STOCK_ISSUE, because that one means "I chose to
    # give MY stock" — switching its ladder off to quieten forwarding would silently
    # remove the sign-off from a real decision.
    FORWARD_ISSUE = "FORWARD_ISSUE"
    MR = "MR"          # material request — the indent -> procurement bridge
    # Procurement's own demand note, raised by a buyer rather than by an indent.
    REQUISITION = "REQUISITION"
    # Going out to vendors commits nobody to spend, but it does publish what the
    # company is about to buy and to whom — so it gets a ladder of its own.
    RFQ = "RFQ"
    # Numbering only, deliberately absent from ladder.DOC_TYPE_LABEL: a quotation is
    # the VENDOR's document. It needs a number; nobody inside the company approves it.
    # What gets approved is the award, and that rides on the PO.
    QUOTATION = "QUOTATION"
    # Numbering only, like QUOTATION and for the same reason: a despatch note is the
    # VENDOR's statement of what they put on the vehicle. Nobody inside the company
    # approves it — the GRN is where we agree with it or do not.
    DESPATCH_NOTE = "DESPATCH_NOTE"
    PO = "PO"
    GRN = "GRN"
    ISSUE = "ISSUE"
    WH_ISSUE = "WH_ISSUE"
    DISPATCH = "DISPATCH"
    PURCHASE_RETURN = "PURCHASE_RETURN"
    # Stock moving sideways between two stocking points. Only ever put through the
    # engine when the two points sit in different projects — a same-project transfer
    # is the holder's own call and never starts a workflow at all.
    STOCK_TRANSFER = "STOCK_TRANSFER"
    # A Stock Transfer REQUEST (STR): one point asking another to send it stock. It is
    # carried as an indent (`indents.IndentType.STR`) so the serve, issue, consignment
    # and acknowledgement legs are the indent's own, and this value is only the LADDER
    # it is approved on (engine context `ladder_doc_type`) — the instance itself stays
    # doc type INDENT, so every inbox, deep link and approve permission still resolves.
    STOCK_TRANSFER_REQUEST = "STOCK_TRANSFER_REQUEST"
    # Stock moving between BINS inside one warehouse. Its own doc type, not
    # STOCK_TRANSFER: a transfer crosses stocking points and is the receiving side's
    # business, while a movement never leaves the building and is the point owner's
    # own. Added 2026-08-21 — before it, a movement went through no ladder at all and
    # `stock.movement.approve` existed with nothing able to call it.
    STOCK_MOVEMENT_ORDER = "STOCK_MOVEMENT_ORDER"
    # A stock audit: the physical count against what the system holds, and the
    # correction that follows. Only put through the engine when a project configured a
    # chain for it on Approval Flow; otherwise one holder of `stock.adjust.approve`
    # signs (inventory.service.act_on_adjustment).
    STOCK_ADJUSTMENT = "STOCK_ADJUSTMENT"
    # A correction to what stock IS rather than how much of it there is: a batch
    # number, a mfg/expiry date, a unit's serial, IMEI or code typed wrong at receipt.
    # No quantity moves, so it is not an adjustment — but it rewrites the identity
    # every later issue, recall and warranty claim reads, so it is signed first.
    STOCK_EDIT = "STOCK_EDIT"
    # Material going back UP the chain: a LIP returning expired or damaged stock to
    # the MDP above it. Its own doc type, not STOCK_TRANSFER — a transfer is the
    # holder's own call and a return has to be sanctioned by the tier receiving it.
    STOCK_RETURN = "STOCK_RETURN"
    # The receiving leg. The point being returned TO decides whether it takes the
    # material and where it then goes, which is a different ladder from the one that
    # let the material leave — hence a second doc type rather than a second stage.
    STOCK_RETURN_RECEIPT = "STOCK_RETURN_RECEIPT"
    # The return's LOGISTICS rung. RETIRED as a live rung on 2026-09-10 (nothing opens
    # an instance for it any more — see platform/workflow/ladder.RETIRED_DOC_TYPES), but
    # the value stays: a return that was already sitting on it still has to render, and
    # the engine reads DOC_TYPE_LABEL for the stage name on those rows.
    STOCK_RETURN_LOGISTICS = "STOCK_RETURN_LOGISTICS"
    # Logistics. The warehouse has packed and asks for transport; this is the request
    # that says what is moving, how heavy it is and by which mode. Signed by Logistics
    # before any carrier is approached, because approaching one publishes the shipment.
    TRANSPORT_REQUEST = "TRANSPORT_REQUEST"
    # Picking the provider commits freight spend, which the transport request itself
    # did not. Its own ladder for the same reason RFQ and PO have separate ones: the
    # person who says "we need a truck" is not always the person who says "this truck,
    # at this price". Only ever raised for THIRD_PARTY and COURIER — an own-vehicle or
    # hand-over leg awards nobody and never starts this workflow.
    CARRIER_AWARD = "CARRIER_AWARD"
    # The outward quality check, after a material issue is posted and before the
    # consignment may be raised against it. Its own doc type rather than reusing the
    # issue's: passing QC is a different decision, made by a different desk, on a
    # document (`whs_inspections`) the issue does not own. Without a row of its own it
    # could never be configured on Approvals Config at all.
    QC_OUTWARD = "QC_OUTWARD"
    # Procurement. Many requisitions rolled into one buying sheet, item-wise, so the
    # CPO and the SCM Head see the whole month's demand as one document instead of
    # forty. Approved once; the RFQs that follow point back at it.
    CONSOLIDATION = "CONSOLIDATION"
    # Accounts. A payment against one milestone of a PO's payment terms, recorded by
    # the accounts desk and signed on its own ladder before the milestone reads paid.
    VENDOR_PAYMENT = "VENDOR_PAYMENT"


# --------------------------------------------------------------------------- #
#  Payment terms and vendor payments (2026-10-06)
# --------------------------------------------------------------------------- #
class PaymentMilestoneStage(str, Enum):
    """The four points at which a PO's value falls due, in the order they happen."""
    ADVANCE = "ADVANCE"
    AGAINST_DELIVERY = "AGAINST_DELIVERY"
    POST_INSTALLATION = "POST_INSTALLATION"
    POST_WARRANTY = "POST_WARRANTY"


class PaymentSplitMode(str, Enum):
    """How one stage's share of a payment term is paid (2026-10-06).

    ONE    -- a single payment, `<stage>_days` after the stage's trigger.
    EQUAL  -- N equal instalments, each on its own day after the trigger.
    CUSTOM -- N instalments, each its own percent OF THE STAGE (they add up to 100)
              on its own day after the trigger.
    """
    ONE = "ONE"
    EQUAL = "EQUAL"
    CUSTOM = "CUSTOM"


# The most instalments one stage may be split into. A request limit as much as a
# business one: each instalment is a milestone row accounts pays against.
MAX_PAYMENT_INSTALMENTS = 12

# Served to every screen (the master form, the PO, the accounts desk), so a stage reads
# the same everywhere. `field` is the column prefix on mst_payment_terms; `short` is
# the milestone code printed beside each instalment (ADV 1/1, DLV 2/4); `after` is how
# a day count on that stage is read ("30 days after delivery").
PAYMENT_MILESTONE_META = [
    {"value": PaymentMilestoneStage.ADVANCE.value, "field": "advance",
     "label": "Advance", "trigger": "On PO approval", "short": "ADV",
     "after": "after PO approval"},
    {"value": PaymentMilestoneStage.AGAINST_DELIVERY.value, "field": "delivery",
     "label": "Against delivery", "trigger": "On receipt of goods", "short": "DLV",
     "after": "after delivery"},
    {"value": PaymentMilestoneStage.POST_INSTALLATION.value, "field": "installation",
     "label": "Post commissioning / installation",
     "trigger": "After commissioning or installation", "short": "INS",
     "after": "after installation"},
    {"value": PaymentMilestoneStage.POST_WARRANTY.value, "field": "warranty",
     "label": "Post support / warranty period",
     "trigger": "After the support or warranty period", "short": "WAR",
     "after": "after the warranty ends"},
]


class VendorPaymentStatus(str, Enum):
    PENDING_APPROVAL = "PENDING_APPROVAL"
    PAID = "PAID"           # approved: the money went out and the milestone counts it
    REJECTED = "REJECTED"


class PaymentMode(str, Enum):
    NEFT = "NEFT"
    RTGS = "RTGS"
    IMPS = "IMPS"
    UPI = "UPI"
    CHEQUE = "CHEQUE"
    DD = "DD"
    CASH = "CASH"


# What a vendor may file against a PO from the portal (sys_attachments.doc_category).
# A carrier files only the INVOICE, against its shipment.
class VendorDocCategory(str, Enum):
    INVOICE = "INVOICE"
    DC = "DC"               # delivery challan


class InstanceStatus(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class ApproverType(str, Enum):
    POSITION = "POSITION"
    ROLE = "ROLE"
    # A RANK that is NOT on the raiser's reporting line — the SCM Head, the Indent
    # Team, the PO desk. ROLE is climbed upward from whoever raised the document;
    # ROLE_ANY is a chair the whole company shares, so its holders are read directly.
    # Without it those ranks could be ticked and would then resolve to nobody, because
    # a field store keeper's line tops out at his own SPH and never reaches them.
    ROLE_ANY = "ROLE_ANY"
    SPECIFIC_USER = "SPECIFIC_USER"
    DEPT_HEAD = "DEPT_HEAD"
    REPORTING_MANAGER = "REPORTING_MANAGER"


class ApprovalMode(str, Enum):
    ANY_ONE = "ANY_ONE"
    ALL = "ALL"
    MAJORITY = "MAJORITY"


class ConditionOperator(str, Enum):
    GT = "GT"
    GTE = "GTE"
    LT = "LT"
    LTE = "LTE"
    EQ = "EQ"
    NEQ = "NEQ"      # added: rules engine needs exclusion ("category is not X")
    IN = "IN"
    NOT_IN = "NOT_IN"    # added
    BETWEEN = "BETWEEN"  # added: "field_value" is "lo,hi"


class ConditionLogic(str, Enum):
    AND = "AND"
    OR = "OR"


class RefType(str, Enum):
    """What kind of document a `stk_ledger` row (or an `inv_reservations` hold) was
    written for. The complete vocabulary of that column, in one place.

    It was partial, so three modules each wrote their own spelling: warehouse passed
    `WarehouseDocType.RECEIPT/WH_ISSUE/...` and inventory passed the bare literals
    "STO" and "CYCLE_COUNT". Every value below is the string ALREADY STORED for that
    document type — naming them changes no row and no filter, it only stops the next
    caller inventing a twelfth spelling that no screen reads.

    GRN and RECEIPT are BOTH here and both mean goods received. `logistics` wrote GRN
    (2,487 rows, almost all the opening-stock load) and `warehouse`, which superseded
    it, writes RECEIPT (94). Converging them is a data migration over stored history,
    not an enum edit, so both stay valid until that is deliberately run.

    Not to be confused with `warehouse.enums.RefType`, which is a different column —
    what a PICKLIST or DISPATCH was raised against (INDENT/ISSUE/DISPATCH/PO).
    """
    # Inward
    GRN = "GRN"                          # legacy spelling, written by logistics
    RECEIPT = "RECEIPT"                  # current spelling, written by warehouse
    # Outward
    ISSUE = "ISSUE"
    WH_ISSUE = "WH_ISSUE"
    DISPATCH = "DISPATCH"
    PURCHASE_RETURN = "PURCHASE_RETURN"
    # Reported from the field by the clinic application, not raised in SCM. Two heads,
    # deliberately: a unit used on a patient and a unit spoiled cost against different
    # things, and the feeds that carry them are separate. They must never be summed
    # from one record — a consumption row repeats its wastage quantity for reporting,
    # and posting both would deduct every spoiled unit twice.
    CONSUMPTION = "CONSUMPTION"
    WASTAGE = "WASTAGE"
    # Internal — no goods enter or leave the company
    TRANSFER = "TRANSFER"                # point to point
    STO = "STO"                          # stock transfer order
    STOCK_MOVEMENT = "STOCK_MOVEMENT"    # bin to bin inside one warehouse
    # Stock a warehouse holds with no location (bin 0) given its UNLOCATED location
    # once that warehouse keeps locations — see `warehouse/unlocated.py`.
    UNLOCATED = "UNLOCATED"
    ADJUSTMENT = "ADJUSTMENT"
    CYCLE_COUNT = "CYCLE_COUNT"
    # Not a movement: the hold recorded on inv_reservations.
    RESERVATION = "RESERVATION"
    # Not a movement: a lot set aside for one project (stk_project_holds).
    PROJECT_HOLD = "PROJECT_HOLD"
    # Not a movement: stock a DIRECT material issue (no indent, so no allocation
    # behind it) has claimed from the moment it was saved, so two drafts cannot both
    # promise the same shelf. ref_id = out_issues.id, ref_line_id = out_issue_items.id.
    # Released on cancel/reject, consumed when the issue posts (2026-10-06).
    ISSUE_HOLD = "ISSUE_HOLD"


class Priority(str, Enum):
    NORMAL = "NORMAL"
    URGENT = "URGENT"


# ---- Masters & Admin (this build) ----

class WarehouseType(str, Enum):
    """whs_warehouses.warehouse_type. The live column defaults to MAIN.

    LIP (Local Inventory Point) and MDP (Material Distribution Point) from flow doc §1
    are stocking points like any other — they hold real stock and can fulfil an indent.
    They differ only in who they serve, so they are a type here rather than a table.

    Only LIP and MDP are rungs on the distribution chain (`inventory.locations`
    `_TIER_BY_TYPE`). Every other member sits at the top tier — they are all places
    stock enters from outside rather than places served from above — so adding one
    here never has to be mirrored there.

    REGIONAL and CENTRAL came from the live warehouse data, which already held them
    while this enum did not. A type the enum has not heard of fails validation on
    save, so the row can be read but never edited from the masters form; naming them
    is what makes those warehouses maintainable rather than read-only.
    """
    MAIN = "MAIN"
    CENTRAL = "CENTRAL"
    REGIONAL = "REGIONAL"
    LIP = "LIP"
    MDP = "MDP"
    TRANSIT = "TRANSIT"
    QUARANTINE = "QUARANTINE"
    SCRAP = "SCRAP"


# `BinType` was here: a fixed enum of the kinds a storage location can be.
#
# It is gone because the kinds are DATA. `whs_warehouse_storage_types` (the storage-type
# master, owned by the warehouse module) carries them, along with the rungs each kind may
# sit under, whether stock is held in it and whether it is temperature controlled. A site
# that racks its goods in "carton bays" adds the rung on Warehouse > Masters > Storage
# types; it does not wait for a release. The enum was also quietly wrong — the live data
# has always used STAGING, which the write schema rejected, so those rows could be read
# and never saved.
#
# `whs_warehouse_locations.storage_type` still holds the code (denormalised from the
# master, written only by the warehouse service); `storage_type_id` is the master row.


# ---- Inventory: reservations and material requests ----

class ProjectHoldStatus(str, Enum):
    """stk_project_holds.status. ACTIVE holds stock for the project; RELEASED gave it
    back to the shared pool (by hand, or lent to another project); USED means the
    project's own indent or issue drew it. Rows are kept, never deleted."""
    ACTIVE = "ACTIVE"
    RELEASED = "RELEASED"
    USED = "USED"


class ReservationStatus(str, Enum):
    """inv_reservations.status. Released and consumed rows are kept, never deleted —
    "who held this stock in March" must stay answerable."""
    ACTIVE = "ACTIVE"
    RELEASED = "RELEASED"
    CONSUMED = "CONSUMED"


class AllocationStatus(str, Enum):
    """inv_allocations.status. The decision is a document so that "who chose to give
    40 rather than 60, and when" stays answerable."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"          # only now is stock actually reserved
    # Signed, and what it could give IS reserved — but part of it could not be served
    # off the shelf and went to procurement as a material request. Not finished, so it
    # stays the indent's ONE allocation: when the goods arrive the same document
    # reopens for the shortfall lines instead of a second allocation being raised
    # against the same requirement.
    AWAITING_PROCUREMENT = "AWAITING_PROCUREMENT"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class MRStatus(str, Enum):
    """inv_material_requests.status. The bridge from a short indent to procurement."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    # Sent back one rung for a fix, with a reason; approval paused, not ended
    # (see POStatus.RETURNED_FOR_CORRECTION).
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ORDERED = "ORDERED"
    # The goods bought against it have reached stock (`logistics.qc_pass`). Terminal,
    # and the reason it exists: "on order" must stop meaning "outstanding" the moment
    # the delivery lands, or the shortfall it was raised for can never be allocated —
    # the indent behind it counted the request as still-coming forever and refused a
    # second allocation for stock that was by then sitting on the shelf.
    RECEIVED = "RECEIVED"
    CANCELLED = "CANCELLED"


class RequisitionStatus(str, Enum):
    """pro_requisitions.status. Procurement's own demand note.

    Distinct from MRStatus: an `inv_material_request` is the bridge an unfillable
    indent crosses into procurement, raised by the system. A requisition is raised BY
    a buyer, for anything — a stocked item nobody indented, a one-off, a rate contract
    top-up. Same shape, different author, so a shared status enum would make the two
    indistinguishable on the register.
    """
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    # An RFQ has been raised against it. Not CLOSED: more lines may still go out.
    RFQ_RAISED = "RFQ_RAISED"
    ORDERED = "ORDERED"
    CANCELLED = "CANCELLED"
    # Folded into a consolidated buying sheet. Terminal for the requisition itself —
    # from here the sheet is what gets tendered, and a requisition that could still be
    # picked up individually would be bought twice.
    CONSOLIDATED = "CONSOLIDATED"


class ConsolidationStatus(str, Enum):
    """pro_consolidations.status — the month's demand as one document."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    # An RFQ has gone out against it. Not terminal: a sheet is tendered in parts.
    RFQ_RAISED = "RFQ_RAISED"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class EvaluationMethod(str, Enum):
    """How a set of competing quotes is ranked.

    Shared rather than owned by procurement, because logistics ranks carrier quotes
    the same way and sits later in the import chain — "cheapest" and "soonest" mean
    the same thing whether the thing being bought is bandages or a truck.

    Every method scores so that HIGHER IS BETTER, normalised against the best quote
    actually received. There is no absolute scale: a 40-km run and a 900-km run are
    not comparable, and only the quotes in hand define what good looks like.
    """
    LOWEST_PRICE = "LOWEST_PRICE"
    SHORTEST_LEAD_TIME = "SHORTEST_LEAD_TIME"


#: What an RFQ or a transport request is evaluated by when nobody has said.
DEFAULT_EVALUATION_METHOD = EvaluationMethod.LOWEST_PRICE.value


class RFQStatus(str, Enum):
    """pro_rfqs.status."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    # Sent back one rung for a fix, with a reason; approval paused, not ended. Not
    # published, so vendors cannot see it (see POStatus.RETURNED_FOR_CORRECTION).
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION"
    # Approved and the vendors can see it. The tokens are live from this point.
    PUBLISHED = "PUBLISHED"
    # The deadline passed or a buyer shut it early. Vendors can read, not quote.
    CLOSED = "CLOSED"
    # A quotation was picked. Terminal, and the awarded vendor is on the row.
    AWARDED = "AWARDED"
    CANCELLED = "CANCELLED"


class DespatchNoteStatus(str, Enum):
    """pro_despatch_notes.status — what the vendor says they have sent.

    No approval states: nobody inside the company signs a vendor's despatch note. It is
    a claim, and the GRN is where that claim is agreed with or contradicted. SUBMITTED
    is therefore terminal from our side — only the vendor can cancel one, and only
    while nothing has been received against it.
    """
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    CANCELLED = "CANCELLED"


class DespatchStatus(str, Enum):
    """How much of a PURCHASE ORDER the vendor says they have sent. DERIVED, never stored.

    Summed off the order's SUBMITTED despatch notes against its ordered quantity and
    served beside `POStatus` (`despatch_status` on the PO payloads), so an accepted
    order the goods have already left for reads "Dispatched" on both the buyer's and the
    supplier's screens. Not a PO status: the receipt guards, filters and reports keep
    reading ACCEPTED_BY_SUPPLIER until a receipt moves the order.
    """
    PARTIALLY_DISPATCHED = "PARTIALLY_DISPATCHED"
    DISPATCHED = "DISPATCHED"


class QuotationStatus(str, Enum):
    """pro_quotations.status — the vendor's side of an RFQ."""
    # Created for the vendor when the RFQ publishes, so the portal has a form to open.
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    # Re-submitted before the deadline. revision_count says how many times.
    REVISED = "REVISED"
    # Lost, or the RFQ closed without them. Kept for the comparison sheet.
    REJECTED = "REJECTED"
    ACCEPTED = "ACCEPTED"


class QuoteChangeStatus(str, Enum):
    """pro_quote_change_requests.status — the buyer's ask on a supplier's price.

    The negotiation overlay lives on its own table, NOT on QuotationStatus: a
    request being open does not move the quotation anywhere, and folding it into
    the quote's status would have made every existing filter, KPI and report
    invent a meaning for a value they never knew about.
    """
    # The buyer's ask, sent and waiting. One per quotation, enforced in service.
    AWAITING_SUPPLIER = "AWAITING_SUPPLIER"
    # The supplier took the new numbers — service applied them through
    # `_quote_totals` and the quotation re-prices on the spot.
    ACCEPTED = "ACCEPTED"
    # The supplier said no. The quote stands exactly as it was — nothing was ever
    # pre-applied, so unlike the PO revert there is nothing to put back.
    DECLINED = "DECLINED"
    # The buyer took their own ask back before an answer.
    WITHDRAWN = "WITHDRAWN"
    # A different request on the same quotation was accepted first.
    SUPERSEDED = "SUPERSEDED"


class PickStrategy(str, Enum):
    """FEFO for anything carrying a batch or an expiry date — picking the nearest
    expiry first is the entire point of tracking expiry. FIFO for everything else."""
    FEFO = "FEFO"
    FIFO = "FIFO"


class IndentItemStatus(str, Enum):
    """ind_indent_items.status. Set by allocation, per line, after approval."""
    PENDING = "PENDING"
    ALLOCATED = "ALLOCATED"
    SHORT = "SHORT"
    ISSUED = "ISSUED"


class GroupType(str, Enum):
    """How rbac_user_groups derives its members. LOCATION groups are the
    "sub-groups by place"; they hang off a parent group via parent_id.

    ROLE and HCM_ROLE are different things and both are needed. ROLE means an SCM
    permission role from rbac_roles (APPROVER, STORE) — what someone may do. HCM_ROLE
    means the org role mirrored from HCM ("Network Technicians") — what someone is.
    An employee typically holds several HCM positions and roles at once; that is
    normal and the resolver unions them.
    """
    ROLE = "ROLE"
    POSITION = "POSITION"
    HCM_ROLE = "HCM_ROLE"
    LOCATION = "LOCATION"


class RuleActionType(str, Enum):
    ROUTE_APPROVAL = "ROUTE_APPROVAL"          # delegates to platform/workflow/engine.py
    ROUTE_FULFILLMENT = "ROUTE_FULFILLMENT"
    SPLIT_FULFILLMENT = "SPLIT_FULFILLMENT"
    NOTIFY = "NOTIFY"
    SET_FIELD = "SET_FIELD"


class FulfillmentTarget(str, Enum):
    INVENTORY = "INVENTORY"
    WAREHOUSE = "WAREHOUSE"
    PROCUREMENT = "PROCUREMENT"


class UomClass(str, Enum):
    """mst_uom.uom_class. What a unit measures.

    Required on every UOM, because a conversion between units of different classes is
    meaningless: litres never become kilograms. It is also what lets the item form
    offer only the units that fit the measurement being taken.

    PACKAGING is the odd one out — a box is not an SI dimension — but a packaging
    chain counts trays and boxes the same way a recipe counts litres, and giving them
    a class of their own keeps them out of the physical unit lists.
    """
    COUNT = "COUNT"
    LENGTH = "LENGTH"
    AREA = "AREA"
    VOLUME = "VOLUME"
    WEIGHT = "WEIGHT"
    TEMPERATURE = "TEMPERATURE"
    TIME = "TIME"
    PRESSURE = "PRESSURE"
    ENERGY = "ENERGY"
    PACKAGING = "PACKAGING"


class AttributeDataType(str, Enum):
    """What kind of value an attribute holds. Drives the input the UI shows and how
    the value is validated before it is stored."""
    TEXT = "TEXT"
    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    DATE = "DATE"
    LIST = "LIST"        # one of mst_attributes.allowed_values


class AttributeTarget(str, Enum):
    """What an attribute mapping attaches to. A mapping says "items of this kind need
    this attribute"; the per-item VALUE lives in mst_item_specs.specifications.

    Superseded by CategoryTagType: tagging is now always to a category, and one
    table covers attributes, specs and features. Kept only because the live
    mst_attribute_mappings table still carries the column.
    """
    CATEGORY = "CATEGORY"
    ITEM_CLASS = "ITEM_CLASS"


class CategoryTagType(str, Enum):
    """What a category tag attaches to that category.

    Three kinds of thing hang off a category and all three answer the same two
    questions — which one, and is it required — so they share one table rather than
    three near-identical ones.

    ATTRIBUTE is a selectable trait: colour, size, grade. It has a value list.
    SPEC is a measurement: voltage 240 V, pressure 10 bar. It carries a UOM.
    FEATURE is a yes/no trait: fragile, hazardous. It has no value at all.
    """
    ATTRIBUTE = "ATTRIBUTE"
    SPEC = "SPEC"
    FEATURE = "FEATURE"


class PriceType(str, Enum):
    PURCHASE = "PURCHASE"
    SALE = "SALE"
    TRANSFER = "TRANSFER"


class BomType(str, Enum):
    """mst_boms.bom_type. The live column defaults to GENERAL."""
    GENERAL = "GENERAL"
    KIT = "KIT"
    ASSEMBLY = "ASSEMBLY"
    VEHICLE = "VEHICLE"


class RecipientType(str, Enum):
    ROLE = "ROLE"
    POSITION = "POSITION"
    GROUP = "GROUP"
    EMPLOYEE = "EMPLOYEE"


class NotificationChannel(str, Enum):
    IN_APP = "IN_APP"
    EMAIL = "EMAIL"


class AuditAction(str, Enum):
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    # A row that is genuinely gone, not retired. Only settings-backed collections use
    # it — a master is DEACTIVATEd so what points at it still resolves. Added
    # 2026-08-24: `inventory.delete_replenishment_rule` already wrote it, and with the
    # member missing every delete raised AttributeError AFTER `set_setting` had
    # committed — the rule vanished and the caller got a 500 saying it had not.
    # `sys_audit_log.action` is a plain String(30), so no migration is owed.
    DELETE = "DELETE"
    DEACTIVATE = "DEACTIVATE"
    ACTIVATE = "ACTIVATE"
    LOGIN = "LOGIN"
    ACCESS_GRANTED = "ACCESS_GRANTED"
    ACCESS_REVOKED = "ACCESS_REVOKED"
    # A press refused for lacking a grant or an approver seat — never a document
    # state change, so it never went through write_audit's normal door (rule 9 is
    # about state changes; a refusal changes nothing). Written so an admin reviewing
    # "who got refused, and for what" can grant the right permission instead of
    # guessing from a support ticket. `sys_audit_log.action` is a plain String(30),
    # so no migration is owed — same note as DELETE above.
    PERMISSION_DENIED = "PERMISSION_DENIED"


class ResetPolicy(str, Enum):
    """When sys_doc_series.last_number returns to zero."""
    NEVER = "NEVER"
    YEARLY = "YEARLY"
    MONTHLY = "MONTHLY"


class ScopeRung(str, Enum):
    """How far a job profile can see. Rows, not pages.

    Splitting profiles fixes WHICH SCREENS someone gets; it does nothing about
    WHOSE ROWS. District Manager Anantapur and District Manager Kurnool are one
    profile doing one job — they must not read each other's documents.

    The ladder is HCM's own, read off hcm_positions.raw["office_level"]:
    FACILITATE -> BRANCH OFFICE -> DISTRICT/REGIONAL OFFICE -> HEAD OFFICE.
    """
    SELF = "SELF"            # only documents the login raised
    OFFICE = "OFFICE"        # own hcm office
    SUBTREE = "SUBTREE"      # own position and everything reporting under it
    PROJECT = "PROJECT"      # own hcm_employees.project_id
    ALL = "ALL"              # the whole network


#: The `mst_vendors.vendor_type` values that mark a row as a transport provider
#: rather than a material supplier. Lives here, not in logistics, because the vendor
#: master has to be able to leave carriers out of procurement's pickers — an RFQ that
#: offers a courier alongside three bandage suppliers invites a tender nobody can fill
#: — and shared may not import a module (rule 5). `logistics.enums` re-exports it.
CARRIER_VENDOR_TYPES = ("TRANSPORT", "LOGISTICS", "COURIER")


#: The `whs_warehouses.warehouse_type` values a purchase may be shipped TO — the
#: Shipment Address on a requisition, an RFQ or a consolidation (2026-09-07).
#:
#: An ALLOW-list, not "everything except LIP and MDP", because the difference matters:
#: TRANSIT, QUARANTINE and SCRAP are not distribution points either, and none of them
#: is somewhere a vendor delivers to. Written as "which of these is a place goods
#: arrive from outside", the answer stays right when a type is added.
#:
#: This is what makes the picker usable at all. `whs_warehouses` holds 983 rows — 948
#: LIP and 33 MDP field points against 2 real warehouses — so the buyer was searching
#: nine hundred delivery addresses that no purchase order has ever been shipped to,
#: and the two that matter sorted last and never arrived.
#:
#: Here rather than in procurement because the vendor master's carrier split sets the
#: precedent directly above, and because the masters list has to be able to narrow
#: itself while shared may not import a module (rule 5).
SHIPMENT_ADDRESS_WAREHOUSE_TYPES = ("MAIN", "CENTRAL", "REGIONAL")


class MailStatus(str, Enum):
    """`sys_mail_messages.status`. A row is written QUEUED before the send is
    attempted, so a message lost to a crash mid-send is still visible afterwards
    rather than leaving no trace at all."""
    QUEUED = "QUEUED"
    SENT = "SENT"
    FAILED = "FAILED"


class MailKind(str, Enum):
    """What raised a message. `PASSWORD_RESET` is logged WITHOUT its body — that body
    carries a live reset link and the Sent tab is readable by anyone with `mail.view`."""
    MANUAL = "MANUAL"
    PASSWORD_RESET = "PASSWORD_RESET"
    #: A carrier or supplier portal username plus the shared first password. The
    #: body is not logged because those credentials should not be readable from
    #: the Sent screen.
    VENDOR_LOGIN_INVITE = "VENDOR_LOGIN_INVITE"
    #: The six digits a vendor needs before their quotation can be submitted. Logged
    #: without its body for the same reason as a reset link: it is a live credential
    #: for the few minutes it lives, and the Sent tab is readable by anyone with
    #: `mail.view`.
    VENDOR_QUOTE_OTP = "VENDOR_QUOTE_OTP"


class EmailClaimStatus(str, Enum):
    """`sys_email_claims.status` — an address somebody typed into "forgot password",
    waiting for an admin to say it really is theirs.

    It exists because HCM serves no employee email (only the MANAGER's, under
    `position.reporting_to[0].employee_email`), so the mirror holds none and the reset
    flow has nothing to match a typed address against. Letting the typist's address be
    trusted on sight would make knowing somebody's emp code enough to receive their
    reset link, so the first address for an account is CONFIRMED by a human before any
    mail goes out. Once approved it is on the employee row and later resets are
    immediate.
    """
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class ItemScope(str, Enum):
    """`mst_item_eligibility.scope_type` — how an item is tagged to who may ask for it.

    ROLE reads `rbac_roles.id`; REGION reads `hcm_offices.id`, which is what
    `indents.service` already stamps on `ind_indents.region_id`. A requester matching
    EITHER kind passes — they are alternatives, not both-required, or an item tagged to
    two regions and one role could never be raised by anybody.
    """
    ROLE = "ROLE"
    REGION = "REGION"


class ContainerUsage(str, Enum):
    """What a container type of an item is USED for (2026-10-23) — many-to-many: one
    container may serve several usages and one usage several containers.

    INDENT: what a requester asks in. PURCHASE: what is bought and despatched in.
    STORAGE: what putaway shelves in. ISSUE: what leaves the counter in — and the
    container asset / consumable codes are minted per. CONSUMPTION: what the site
    reports using in. Quantities stay in base units everywhere; this only says which
    containers each screen offers and defaults to.
    """
    INDENT = "INDENT"
    PURCHASE = "PURCHASE"
    STORAGE = "STORAGE"
    ISSUE = "ISSUE"
    CONSUMPTION = "CONSUMPTION"


class PackChangeStatus(str, Enum):
    """A supplier's change of PACK HIERARCHY on a despatch note line (2026-10-08).

    The order said "strips of 10"; the supplier is sending strips of 15. Allowed —
    the quantity in tablets is what was bought — but the buyer is told, and decides.
    NONE: the line is packed in the order's own hierarchy. PENDING: waiting on the
    buyer. ACCEPTED: the order now says the new hierarchy. DECLINED: the buyer refused
    it; the gate sees that on the receipt before it books the goods in.
    """
    NONE = "NONE"
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    DECLINED = "DECLINED"
