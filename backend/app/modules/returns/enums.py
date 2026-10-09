"""Returns' own vocabulary.

`ReturnDocType` is kept here rather than in `app.shared.enums.DocType`, which is the
lead's file: the workflow engine takes the doc type as a plain string, so a module can
name its own documents without anything shared having to change. `warehouse/enums.py`
sets the same precedent.

`ReturnStatus` deliberately uses the SAME string values as
`inventory.enums.STOStatus`, because a return row lives in `inv_sto` and that column
is read by inventory's own screens. A status they have never heard of would render as
a blank pill on a screen this module does not own.
"""
from enum import Enum


class ReturnDocType(str, Enum):
    """`doc_type` for the workflow engine. Not a `sys_doc_series` key — numbering uses
    `NUMBER_SERIES` below, so the series reads `RET-…` rather than `STO-…`."""

    STOCK_RETURN = "STOCK_RETURN"
    # The receiving desk's own approval, mirroring what an indent does after its own
    # chain signs: the inventory desk looks at it (indent's fulfilment queue), then the
    # warehouse (material issue / dispatch), and only then does stock move.
    #
    # A second doc_type rather than more rungs on the first chain, for two reasons:
    # the engine freezes ONE chain per (doc_type, doc_id), and those approvers are not
    # above the raiser at all — the SCM posts sit on `parent_position_id = NULL`, so no
    # climb reaches them (see platform/workflow/custom_ladder.py). The receiving chain
    # is therefore configured as a hand-built ladder of posts, and this is the doc type
    # it is configured against.
    STOCK_RETURN_RECEIPT = "STOCK_RETURN_RECEIPT"
    STOCK_RETURN_LOGISTICS = "STOCK_RETURN_LOGISTICS"


# The `sys_doc_series` key. Three letters of "stock_return" would be "STO", which is
# how everyone here says Stock Transfer Order, so the series is named outright.
NUMBER_SERIES = "ret"


class ReturnStatus(str, Enum):
    """A subset of STOStatus.

    APPROVED means the last rung of the reporting line signed — the FINAL approval.
    For an outcome that moves nothing (used at the branch, refused) and for one written
    off where it stands (scrap, controlled disposal) that is also the instant the stock
    settled. For the two outcomes that TRAVEL it is not: the material is still on the
    branch shelf, still reserved, waiting for a truck.

    DISPATCHED is no longer unused (2026-09-05). Approval and despatch stopped being the
    same instant when the logistics leg landed: a travelling return is dispatched by the
    logistics desk releasing its transport request, and that is when the stock actually
    leaves the source. The value was always in `STOStatus`, so inventory's own STO screens
    already render it.

    RECEIVED means the person who raised it has since confirmed the return is done — the
    acknowledgement that closes the document.
    """

    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    DISPATCHED = "DISPATCHED"
    RECEIVED = "RECEIVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class ReturnKind(str, Enum):
    """Who the stock is going back TO.

    Two documents share the word "return" and nothing else. A PURCHASE return leaves a
    warehouse for the vendor who supplied it, and the outcome is a credit note or a
    replacement — that document is `pro_returns`, owned by the warehouse module, and this
    module only reads it for the register. A FIELD return comes off a branch shelf and
    goes back into our own network, and the outcome is a decision about where the
    material is worth the most. Everything this module WRITES is a field return.

    The kind is recorded on the document anyway rather than assumed, because the register
    shows both and a row has to say which it is without the reader inferring it from
    which table it came out of.
    """

    FIELD = "FIELD"
    PURCHASE = "PURCHASE"


class ReturnIntent(str, Enum):
    """What the returner wants to happen next.

    REPLACEMENT means they still need the material and expect it back — so the return is
    only half the story and somebody has to watch for the replacement. RETURN means they
    are done with it and want it off their books. The distinction changes nothing about
    how the stock moves and everything about what the inventory desk decides: a
    replacement-intent return with a liable vendor goes to that vendor, where the same
    material with no replacement wanted might be scrapped on the spot.
    """

    REPLACEMENT = "REPLACEMENT"
    RETURN = "RETURN"


#: What the returner wants, as a screen says it.
#:
#: RETURN reads "Return only" and nothing more (2026-09-08). It used to read
#: "Return only — no replacement", which stated an outcome this document cannot
#: promise: whether the material comes back as a replacement or as a credit note is the
#: SUPPLIER's call on their own debit note, made long after the decision desk has moved
#: the stock. A return with no replacement ASKED FOR is not a return with no replacement
#: COMING, and the desk was reading the second sentence.
INTENT_LABELS: dict[str, str] = {
    ReturnIntent.REPLACEMENT.value: "Replacement wanted",
    ReturnIntent.RETURN.value: "Return only",
}

KIND_LABELS: dict[str, str] = {
    ReturnKind.FIELD.value: "Field return",
    ReturnKind.PURCHASE.value: "Purchase return",
}


class Disposition(str, Enum):
    """The inventory manager's decision: where the material actually ends up.

    Six members, seven outcomes — TO_VENDOR reads differently depending on the intent
    (replacement expected, or credit expected), and that is the intent's job to say, not
    a seventh member's.

    Before this existed the destination was derived at raise time (the MDP one rung above
    the raiser) and nobody could change it, so every approved return moved. Two of these
    six move nothing at all, which is the point: refusing to spend freight on stock worth
    less than the freight is a decision the business makes constantly and the system had
    no way to express.
    """

    # Into the network — the material travels and lands on another balance.
    SEND_TO_POINT = "SEND_TO_POINT"
    # Out of the company. Credit note or replacement, per the intent.
    TO_VENDOR = "TO_VENDOR"
    # Stays exactly where it is. The hold is released and the branch keeps it.
    USE_AT_SOURCE = "USE_AT_SOURCE"
    # Written off at the branch. Cheap, and illegal for some material — see
    # CONTROLLED_DISPOSAL.
    SCRAP = "SCRAP"
    # Destroyed under supervision: licensed agency, certificate on file. The only route
    # open for anything the item master flags as affecting handling.
    CONTROLLED_DISPOSAL = "CONTROLLED_DISPOSAL"
    # The return itself is refused — not because the reason was wrong, but because moving
    # it costs more than the material is worth and nothing nearby needs it.
    REJECT_UNECONOMIC = "REJECT_UNECONOMIC"


DISPOSITION_LABELS: dict[str, str] = {
    Disposition.SEND_TO_POINT.value: "Send to a stocking point",
    Disposition.TO_VENDOR.value: "Send back to the vendor",
    Disposition.USE_AT_SOURCE.value: "Use it at the branch",
    Disposition.SCRAP.value: "Scrap at the branch",
    Disposition.CONTROLLED_DISPOSAL.value: "Controlled disposal",
    Disposition.REJECT_UNECONOMIC.value: "Refuse — not worth the freight",
}

# One line of guidance per outcome, shown under the button. Held here rather than in the
# frontend so the words the manager decides against and the words the trail records
# cannot drift apart.
DISPOSITION_HINTS: dict[str, str] = {
    Disposition.SEND_TO_POINT.value:
        "Still usable and needed elsewhere. Moves out of the branch and in at the point "
        "you choose.",
    Disposition.TO_VENDOR.value:
        "The vendor is liable — inside the GRN window, under warranty, or recalled. "
        "Leaves our books; watch for the credit note or the replacement.",
    Disposition.USE_AT_SOURCE.value:
        "Fit for use and the branch can consume it. Nothing moves and no freight is "
        "spent.",
    Disposition.SCRAP.value:
        "Beyond use, nothing hazardous about it. Written off at the branch.",
    Disposition.CONTROLLED_DISPOSAL.value:
        "Hazardous, cold-chain or regulated. Needs a licensed agency and a certificate "
        "on file before the return closes.",
    Disposition.REJECT_UNECONOMIC.value:
        "Usable, but worth less than the cost of moving it and nothing nearby needs it. "
        "Stays at the branch and the raiser is told why.",
}

DISPOSITION_LABELS_SHORT: dict[str, str] = {
    Disposition.SEND_TO_POINT.value: "Send to a point",
    Disposition.TO_VENDOR.value: "To the vendor",
    Disposition.USE_AT_SOURCE.value: "Use at the branch",
    Disposition.SCRAP.value: "Scrap",
    Disposition.CONTROLLED_DISPOSAL.value: "Controlled disposal",
    Disposition.REJECT_UNECONOMIC.value: "Refused",
}

# The order the decision screen offers them in: into the network first because it is the
# common case, refusal last because it is the one that needs the most thought.
SELECTABLE_DISPOSITIONS: tuple[Disposition, ...] = (
    Disposition.SEND_TO_POINT,
    Disposition.TO_VENDOR,
    Disposition.USE_AT_SOURCE,
    Disposition.SCRAP,
    Disposition.CONTROLLED_DISPOSAL,
    Disposition.REJECT_UNECONOMIC,
)

class Movement(str, Enum):
    """What a disposition does to stock. Read by `_carry_out`, which is the only place
    that acts on it."""

    # Out of the source, in at the destination — a real transfer.
    TRANSFER = "TRANSFER"
    # Out of the source and off our books. There is no destination balance.
    OUT_ONLY = "OUT_ONLY"
    # Nothing moves; the reservation is released and the branch keeps the stock.
    NONE = "NONE"


MOVEMENT_BY_DISPOSITION: dict[str, Movement] = {
    Disposition.SEND_TO_POINT.value: Movement.TRANSFER,
    Disposition.TO_VENDOR.value: Movement.OUT_ONLY,
    Disposition.SCRAP.value: Movement.OUT_ONLY,
    Disposition.CONTROLLED_DISPOSAL.value: Movement.OUT_ONLY,
    Disposition.USE_AT_SOURCE.value: Movement.NONE,
    Disposition.REJECT_UNECONOMIC.value: Movement.NONE,
}

class ReturnLeg(str, Enum):
    """Which of the two return journeys a decision puts the material on.

    The business names them separately because they end in different places and are
    signed off by different people: a STORE return lands on one of our own shelves and
    the receiving warehouse inspects it, a SUPPLIER return leaves the company and the
    vendor acknowledges it. Everything in between — the transport request, the carrier,
    the gate pass, the tracking — is the same leg run by the same desk, which is why both
    ride one `lgs_transport_requests` row rather than two half-copies of one.
    """

    STORE = "STORE"
    SUPPLIER = "SUPPLIER"


LEG_BY_DISPOSITION: dict[str, str] = {
    Disposition.SEND_TO_POINT.value: ReturnLeg.STORE.value,
    Disposition.TO_VENDOR.value: ReturnLeg.SUPPLIER.value,
}

LEG_LABELS: dict[str, str] = {
    ReturnLeg.STORE.value: "Store / warehouse return",
    ReturnLeg.SUPPLIER.value: "Supplier return",
}


class PurchaseReturnSource(str, Enum):
    """Where the material a purchase return sends back to the vendor came FROM.

    ADDED 2026-09-08. A purchase return used to say only which warehouse raised it, and
    that is not the question the buying desk asks about one: stock rejected on the
    inspection bench the day it arrived is a supplier quality problem, and the same item
    coming back off a branch shelf six weeks later is a field problem. They are chased
    differently, argued with the vendor differently and reported separately, so the
    register has to be able to tell them apart without anybody reading the reason text.

    `QC_REJECTED_GRN` is deliberately NOT a third place — it is the same warehouse, and
    what makes it its own category is WHEN the material was rejected. It wins over the
    other two when both apply, because "failed inspection after GRN" is the fact the
    vendor is answerable for and the tier the goods sat in afterwards is not.

    **The two rungs are WAREHOUSE and MDP against LIP**, which is not what these names
    say, and the labels were corrected on 2026-09-12 rather than the values. There is no
    such thing as an "MDB" in this system: `inventory.enums.LocationTier` has exactly
    three rungs — WAREHOUSE, MDP (Material Distribution Point) and LIP (Local Inventory
    Point) — and `_purchase_return_source` files anything at MDP or above under
    `FROM_WAREHOUSE`. So the bucket named for an MDB never contained one, could not have,
    and the bucket that DOES hold every MDP return called itself "From warehouse" and
    said nothing about the rung. A desk reading either label was told the wrong thing.

    The stored STRINGS keep the old spelling on purpose: `pro_returns.source_category`
    already carries them, the register filters on them (`?source=`) and the frontend
    union types them. Renaming a value to fix a label would be a migration over live
    history to change something no user ever sees. What a user sees is
    `PURCHASE_RETURN_SOURCE_LABELS`, and beside it the rung actually resolved for THIS
    document (`_purchase_return_source` `source_detail`) — so the category stays a
    coarse three-way filter and the screen still names the real point.
    """

    #: Came off a warehouse or an MDP shelf — our own upper-tier stock going back.
    FROM_WAREHOUSE = "FROM_WAREHOUSE"
    #: Came up the chain off a branch: a LIP sent it back to the warehouse first, and the
    #: warehouse is now sending it on to the vendor. The `_MDB` in the stored value is a
    #: misnomer kept for the rows that already carry it — see the class docstring.
    FROM_LIP_MDB = "FROM_LIP_MDB"
    #: Rejected by QC after the GRN, so it never reached a shelf at all.
    QC_REJECTED_GRN = "QC_REJECTED_GRN"


PURCHASE_RETURN_SOURCE_LABELS: dict[str, str] = {
    PurchaseReturnSource.FROM_WAREHOUSE.value: "From warehouse / MDP",
    PurchaseReturnSource.FROM_LIP_MDB.value: "From LIP",
    PurchaseReturnSource.QC_REJECTED_GRN.value: "QC rejected after GRN",
}

#: Offered on the purchase-return register's filter, in the order the desk reads them.
SELECTABLE_PURCHASE_RETURN_SOURCES: tuple[PurchaseReturnSource, ...] = (
    PurchaseReturnSource.FROM_WAREHOUSE,
    PurchaseReturnSource.FROM_LIP_MDB,
    PurchaseReturnSource.QC_REJECTED_GRN,
)


class TrailDocType(str, Enum):
    """Every kind of document that can appear on the trail behind a returned item.

    NOT a workflow doc type and not a `sys_doc_series` key — this is the screen's
    vocabulary for "what is this row". A document's own module names it whatever it
    names it; this says which of the eighteen things on the trail it is, so the section
    renders one way and branches on nothing.

    Declared in the ORDER THE WORK HAPPENS, which is what `TRAIL_ORDER` reads to sort
    the section: ask, allocate, buy, receive, inspect, put away, pick, issue, check,
    consign, ship, and — once the load has left — the purchase return it becomes. A new
    document type is one member here plus one resolver in `_document_chain`, and never
    a re-ordering of anything.
    """

    #: Not a document: the claim the return itself makes about the material.
    INTENT = "INTENT"
    INDENT = "INDENT"
    ALLOCATION = "ALLOCATION"
    MATERIAL_REQUEST = "MATERIAL_REQUEST"
    REQUISITION = "REQUISITION"
    RFQ = "RFQ"
    QUOTATION = "QUOTATION"
    PO = "PO"
    DESPATCH_NOTE = "DESPATCH_NOTE"
    GRN = "GRN"
    QC = "QC"
    PUTAWAY = "PUTAWAY"
    PICKLIST = "PICKLIST"
    MATERIAL_ISSUE = "MATERIAL_ISSUE"
    QC_OUTWARD = "QC_OUTWARD"
    CONSIGNMENT = "CONSIGNMENT"
    SHIPMENT = "SHIPMENT"
    PURCHASE_RETURN = "PURCHASE_RETURN"


#: What each kind of document on the trail is CALLED, served on the row rather than
#: mapped in the screen. The same document is named by this section, by the journey
#: screen and by a print sheet, and three copies of this map is how one of them ends up
#: calling a consignment a dispatch. A type a screen has never heard of still renders
#: correctly, because its label arrived with it.
TRAIL_LABELS: dict[str, str] = {
    TrailDocType.INTENT.value: "Intent",
    TrailDocType.INDENT.value: "Indent",
    TrailDocType.ALLOCATION.value: "Material Allocation",
    TrailDocType.MATERIAL_REQUEST.value: "Material Request",
    TrailDocType.REQUISITION.value: "Requisition",
    TrailDocType.RFQ.value: "RFQ",
    TrailDocType.QUOTATION.value: "Vendor Quotation",
    TrailDocType.PO.value: "Purchase Order",
    TrailDocType.DESPATCH_NOTE.value: "Vendor Despatch Note",
    TrailDocType.GRN.value: "GRN / Receipt",
    TrailDocType.QC.value: "QC Inspection",
    TrailDocType.PUTAWAY.value: "Putaway",
    TrailDocType.PICKLIST.value: "Picklist",
    TrailDocType.MATERIAL_ISSUE.value: "Material Issue",
    TrailDocType.QC_OUTWARD.value: "Outward QC",
    TrailDocType.CONSIGNMENT.value: "Consignment",
    TrailDocType.SHIPMENT.value: "Shipment",
    TrailDocType.PURCHASE_RETURN.value: "Purchase Return",
}

#: The order the trail is read in — the declaration order above, which is the order the
#: work happens. The resolver walks the graph outward from the indent in both
#: directions, and that is not a story; this is what turns it back into one.
TRAIL_ORDER: dict[str, int] = {
    doc_type: index for index, doc_type in enumerate(TRAIL_LABELS)
}


class TrailChapter(str, Enum):
    """The six legs of a material's life that the trail behind a return is read in.

    Eighteen document types is a correct answer to "what is behind this item" and a
    useless one to ask a person to read: the desk deciding where a returned carton goes
    was handed a flat list of twenty-six numbered rows and had to know, from the row's
    own name, whether a Requisition came before or after a GRN. A chapter is one run of
    documents under the name the business already uses for it — Request, Allocation,
    Purchase, Receipt, Issue, Return — so the same trail reads as six things with detail
    under them.

    The LABELS are the application's own document nouns, not a plain-English retelling
    of them (CHANGED 2026-09-14). They were "Asked for / Promised / Bought / Arrived /
    Issued out / Coming back", which reads well and names nothing a storekeeper can look
    up: the rows under "Promised" are allocations, the screen that opens them is called
    Allocation, and the leg heading was the one word in that chain that did not match.
    The caption carries the sentence the label used to; a heading a reader can map onto a
    menu is worth more than a heading that explains itself once.

    Declared in TRAIL_ORDER sequence and each chapter's types are CONTIGUOUS in it, so
    the sort the trail already runs produces the chapters grouped, in order, with no
    second pass. A new `TrailDocType` joins the chapter its neighbours are in; nothing
    re-orders.
    """

    REQUEST = "REQUEST"
    COMMITMENT = "COMMITMENT"
    SOURCING = "SOURCING"
    INBOUND = "INBOUND"
    OUTBOUND = "OUTBOUND"
    REVERSE = "REVERSE"


#: What each chapter is called, what it answers, and which document types land in it —
#: SERVED with the trail for the same reason `TRAIL_LABELS` is. The screen draws the
#: chapters it is sent, in the order it is sent them, and knows no doc type at all: a
#: type added to the trail appears under its chapter without the frontend changing.
#:
#: `caption` is the question, in the words a storekeeper would use. Not a definition of
#: the document type — the row already carries its own name — but what the reader learns
#: by opening this run of them.
TRAIL_CHAPTERS: list[dict] = [
    {
        "key": TrailChapter.REQUEST.value,
        "label": "Request",
        "caption": "The indent it was asked for on, and what the branch wants "
                   "done with it now.",
        "doc_types": [TrailDocType.INTENT.value, TrailDocType.INDENT.value],
    },
    {
        "key": TrailChapter.COMMITMENT.value,
        "label": "Allocation",
        "caption": "What the store committed off its own shelf, and what it had "
                   "to go and ask for.",
        "doc_types": [TrailDocType.ALLOCATION.value,
                      TrailDocType.MATERIAL_REQUEST.value],
    },
    {
        "key": TrailChapter.SOURCING.value,
        "label": "Purchase",
        "caption": "How it was sourced, who quoted for it, and the order that "
                   "was placed.",
        "doc_types": [TrailDocType.REQUISITION.value, TrailDocType.RFQ.value,
                      TrailDocType.QUOTATION.value, TrailDocType.PO.value],
    },
    {
        "key": TrailChapter.INBOUND.value,
        "label": "Receipt",
        "caption": "The delivery, the check at the gate and the shelf it went on.",
        "doc_types": [TrailDocType.DESPATCH_NOTE.value, TrailDocType.GRN.value,
                      TrailDocType.QC.value, TrailDocType.PUTAWAY.value],
    },
    {
        "key": TrailChapter.OUTBOUND.value,
        "label": "Issue",
        "caption": "Picked off the shelf, checked on the way out and handed to "
                   "the branch that is now returning it.",
        "doc_types": [TrailDocType.PICKLIST.value, TrailDocType.MATERIAL_ISSUE.value,
                      TrailDocType.QC_OUTWARD.value],
    },
    {
        "key": TrailChapter.REVERSE.value,
        "label": "Return",
        "caption": "The load carrying it back, and the purchase return it becomes.",
        "doc_types": [TrailDocType.CONSIGNMENT.value, TrailDocType.SHIPMENT.value,
                      TrailDocType.PURCHASE_RETURN.value],
    },
]

#: Which chapter a document type belongs to. Derived from the list above so the two can
#: never disagree — the mapping is the chapter definition read the other way round, and
#: a type in two chapters or in none is caught by the test rather than by a reader
#: noticing a row went missing off the screen.
CHAPTER_BY_DOC_TYPE: dict[str, str] = {
    doc_type: chapter["key"]
    for chapter in TRAIL_CHAPTERS
    for doc_type in chapter["doc_types"]
}


class VehicleArrangement(str, Enum):
    """Who provides the truck: we do, or the vendor collects.

    Separate from the transport MODE (`logistics.enums.TransportMode`), which says how
    the load travels. A vendor pickup can still be any mode on paper — what this records
    is whose vehicle turns up at the gate, and therefore whether the freight is ours to
    pay. Kept as its own axis for that reason rather than folded into the mode list.
    """

    OWN_VEHICLE = "OWN_VEHICLE"
    VENDOR_PICKUP = "VENDOR_PICKUP"


VEHICLE_ARRANGEMENT_LABELS: dict[str, str] = {
    VehicleArrangement.OWN_VEHICLE.value: "Our own vehicle",
    VehicleArrangement.VENDOR_PICKUP.value: "Vendor arranges pickup",
}

#: The outcomes that put material on a vehicle, and therefore raise a transport request
#: once the final approval is in. The other four never travel: two move nothing at all,
#: and scrap and controlled disposal are written off where the material already stands.
#: Derived from the leg map so the two can never disagree about which is which.
TRAVELS = frozenset(LEG_BY_DISPOSITION)

# Needs a destination stocking point picked before it can be carried out.
NEEDS_DESTINATION = frozenset({Disposition.SEND_TO_POINT.value})
# Needs a vendor named.
NEEDS_VENDOR = frozenset({Disposition.TO_VENDOR.value})
# Needs a disposal agency named and a certificate uploaded before the return closes.
NEEDS_AGENCY = frozenset({Disposition.CONTROLLED_DISPOSAL.value})
# Refused outright on anything the item master flags as affecting handling. Scrapping a
# hazardous item at a branch is the one outcome that can hurt somebody, so it is blocked
# in the service rather than only greyed out on the screen (rule 6's reasoning: hiding a
# button is not the control).
BLOCKED_WHEN_HAZARDOUS = frozenset({Disposition.SCRAP.value})


class LedgerRef(str, Enum):
    """`stk_ledger.ref_type` for the movements a decision causes.

    `RefType.TRANSFER` still covers SEND_TO_POINT — that movement has not changed and
    relabelling it would split one story across two ref types in every existing report.
    The out-only movements are new and get their own values, so "what did we write off"
    is answerable without reading the marker payload of every row.

    `ref_type` is a plain String on `stk_ledger` and the warehouse module already passes
    its own `WarehouseDocType.PURCHASE_RETURN` through `move_stock_out`, so naming values
    here follows an existing habit rather than inventing one.
    """

    VENDOR = "STOCK_RETURN_VENDOR"
    SCRAP = "STOCK_RETURN_SCRAP"
    DISPOSAL = "STOCK_RETURN_DISPOSAL"


LEDGER_REF_BY_DISPOSITION: dict[str, str] = {
    Disposition.TO_VENDOR.value: LedgerRef.VENDOR.value,
    Disposition.SCRAP.value: LedgerRef.SCRAP.value,
    Disposition.CONTROLLED_DISPOSAL.value: LedgerRef.DISPOSAL.value,
}


class ReturnReason(str, Enum):
    """Why the stock is going back.

    Grouped by what the storekeeper is actually looking at when they raise it —
    condition, wrong despatch, surplus, or a recall — because that is the order the
    reason is picked in. OTHER carries a mandatory free-text note; every other member
    is self-describing, so the note stays optional there.

    A member is never renamed once live: the value is written into `remarks` on every
    return already raised, so a rename would leave those rows showing a blank reason.
    Retiring one means dropping it from `SELECTABLE_REASONS` while the member stays.
    """

    # Nothing wrong with it — it simply is not needed
    UNUSED_SURPLUS = "UNUSED_SURPLUS"
    EXCESS = "EXCESS"
    PROJECT_CLOSED = "PROJECT_CLOSED"

    # Shelf life
    EXPIRED = "EXPIRED"
    NEAR_EXPIRY = "NEAR_EXPIRY"

    # Condition
    DAMAGED = "DAMAGED"
    LEAKED_SPILLED = "LEAKED_SPILLED"
    PACKAGING_DAMAGED = "PACKAGING_DAMAGED"
    COLD_CHAIN_BREACH = "COLD_CHAIN_BREACH"

    # Despatched wrongly
    WRONG_ITEM = "WRONG_ITEM"
    WRONG_QUANTITY = "WRONG_QUANTITY"
    NOT_AS_SPECIFIED = "NOT_AS_SPECIFIED"

    # Withdrawn from use
    QUALITY_REJECTION = "QUALITY_REJECTION"
    BATCH_RECALL = "BATCH_RECALL"
    FAULTY_EQUIPMENT = "FAULTY_EQUIPMENT"

    OTHER = "OTHER"


REASON_LABELS: dict[str, str] = {
    ReturnReason.UNUSED_SURPLUS.value: "Unused / Surplus",
    ReturnReason.EXCESS.value: "Excess issued / Excess supply",
    ReturnReason.PROJECT_CLOSED.value: "Project closed / Site demobilised",
    ReturnReason.EXPIRED.value: "Expired",
    ReturnReason.NEAR_EXPIRY.value: "Near expiry — cannot consume in time",
    ReturnReason.DAMAGED.value: "Damaged (in transit or in store)",
    ReturnReason.LEAKED_SPILLED.value: "Leaked / Spilled",
    ReturnReason.PACKAGING_DAMAGED.value: "Packaging damaged / Seal broken",
    ReturnReason.COLD_CHAIN_BREACH.value: "Cold chain breach / Temperature excursion",
    ReturnReason.WRONG_ITEM.value: "Wrong item issued",
    ReturnReason.WRONG_QUANTITY.value: "Wrong quantity issued",
    ReturnReason.NOT_AS_SPECIFIED.value: "Not as per specification",
    ReturnReason.QUALITY_REJECTION.value: "Quality issue / Failed QC",
    ReturnReason.BATCH_RECALL.value: "Batch recall / Manufacturer recall",
    ReturnReason.FAULTY_EQUIPMENT.value: "Equipment faulty / Not working",
    ReturnReason.OTHER.value: "Others",
}

# The order the dropdown offers them in — condition and shelf life first, because that
# is what most returns are. Alphabetical would put "Batch recall" above "Expired".
SELECTABLE_REASONS: tuple[ReturnReason, ...] = (
    ReturnReason.EXPIRED,
    ReturnReason.NEAR_EXPIRY,
    ReturnReason.DAMAGED,
    ReturnReason.LEAKED_SPILLED,
    ReturnReason.PACKAGING_DAMAGED,
    ReturnReason.COLD_CHAIN_BREACH,
    ReturnReason.BATCH_RECALL,
    ReturnReason.QUALITY_REJECTION,
    ReturnReason.FAULTY_EQUIPMENT,
    ReturnReason.WRONG_ITEM,
    ReturnReason.WRONG_QUANTITY,
    ReturnReason.NOT_AS_SPECIFIED,
    ReturnReason.UNUSED_SURPLUS,
    ReturnReason.EXCESS,
    ReturnReason.PROJECT_CLOSED,
    ReturnReason.OTHER,
)

# Reason-code routing: what the reason ITSELF implies should happen, pre-selected on the
# decision desk so the desk confirms a default rather than inventing an answer from a
# blank form. Always overridable — the reason says what the material is, not what the
# network needs today, and only the decider can weigh the second one.
#
# Declared below `ReturnReason` and `Disposition` because it is written in terms of both.
# The mapping is deliberately conservative: anything still usable defaults to going up the
# network (the common case, and the one that loses nothing if overridden), and only what
# cannot be used at all defaults to being written off.
DEFAULT_DISPOSITION_BY_REASON: dict[str, str] = {
    ReturnReason.EXPIRED.value: Disposition.CONTROLLED_DISPOSAL.value,
    ReturnReason.COLD_CHAIN_BREACH.value: Disposition.CONTROLLED_DISPOSAL.value,
    ReturnReason.LEAKED_SPILLED.value: Disposition.CONTROLLED_DISPOSAL.value,
    ReturnReason.NEAR_EXPIRY.value: Disposition.SEND_TO_POINT.value,
    ReturnReason.DAMAGED.value: Disposition.TO_VENDOR.value,
    ReturnReason.PACKAGING_DAMAGED.value: Disposition.TO_VENDOR.value,
    ReturnReason.NOT_AS_SPECIFIED.value: Disposition.TO_VENDOR.value,
    ReturnReason.QUALITY_REJECTION.value: Disposition.TO_VENDOR.value,
    ReturnReason.BATCH_RECALL.value: Disposition.TO_VENDOR.value,
    ReturnReason.FAULTY_EQUIPMENT.value: Disposition.TO_VENDOR.value,
    ReturnReason.WRONG_ITEM.value: Disposition.SEND_TO_POINT.value,
    ReturnReason.WRONG_QUANTITY.value: Disposition.SEND_TO_POINT.value,
    ReturnReason.UNUSED_SURPLUS.value: Disposition.SEND_TO_POINT.value,
    ReturnReason.EXCESS.value: Disposition.SEND_TO_POINT.value,
    ReturnReason.PROJECT_CLOSED.value: Disposition.SEND_TO_POINT.value,
    # No default: nobody can guess what "Other" means, and a pre-selected button on a
    # reason the system does not understand is a wrong answer offered as a right one.
}

# Statuses a return can still be edited or withdrawn from. A return SENT BACK by any of
# the three desks lands here, which is the whole point of sending it back: the raiser
# corrects it and submits it again.
EDITABLE = frozenset({ReturnStatus.DRAFT.value})
# Where the reservation is still standing, so cancelling has to give the stock back.
#
# APPROVED joined PENDING_APPROVAL on 2026-09-05. A travelling return keeps its hold past
# the final approval — the material is still on the branch shelf waiting for a truck, and
# it must not be issued away in the meantime. The hold is consumed when the load is
# released, not when the last approver signs.
HOLDING_STOCK = frozenset({ReturnStatus.PENDING_APPROVAL.value,
                           ReturnStatus.APPROVED.value})
# What the RAISER may still take back. Deliberately NOT `EDITABLE | HOLDING_STOCK`, which
# is what it used to be spelled as: the day APPROVED joined `HOLDING_STOCK` that spelling
# silently began letting a raiser withdraw a return their whole reporting line had already
# signed and logistics was booking a truck for. Withdrawing is only ever open before a
# decision has been carried out.
WITHDRAWABLE = frozenset({ReturnStatus.DRAFT.value,
                          ReturnStatus.PENDING_APPROVAL.value})
# The document has settled and the raiser has not yet closed it. DISPATCHED is here for
# the travelling legs: the material has left, the far end has signed, and the last word is
# still the returner's. Whether the button is actually offered also depends on the phase —
# a return still waiting on its truck is APPROVED but nowhere near acknowledgeable.
AWAITING_ACK = frozenset({ReturnStatus.APPROVED.value,
                          ReturnStatus.DISPATCHED.value})
# Nothing further will happen to the document.
CLOSED = frozenset({
    ReturnStatus.RECEIVED.value,
    ReturnStatus.REJECTED.value,
    ReturnStatus.CANCELLED.value,
})

# The legs the tracker draws, in order. Held here rather than in the frontend so the
# stepper and the status guards can never describe different flows.
#
# HISTORICAL as of 2026-09-07: no NEW return travels this order any more. Every return
# raised from that day runs `PHASES_APPROVAL_FIRST` below, so this tuple exists only to
# draw the tracker for rows that were already in flight — a return raised under the
# 2026-09-05 order, where the decision desk saw it first and the reporting line approved
# the finished document last. Kept rather than deleted because those rows still have to
# render the flow they are actually on; delete it once none are left.
#
# `decision` and `endorsement` stay separate legs because they ask different questions:
# the desk decides WHERE the material goes, the floor only agrees the route is workable
# or sends it back. Collapsing them was what made the tracker unable to say who held it.
#
# `logistics` is the leg the material physically travels, and it is drawn for every
# return even where the outcome never moves — a tracker that hides steps per document
# describes a different flow on every screen. A non-travelling outcome captions it as
# "nothing to move" rather than dropping it.
#
# Every leg stays in the tracker even where no ladder is configured for it, so the flow
# the screen describes is the flow the business has, not the flow this deployment happens
# to be configured for.
PHASES: tuple[tuple[str, str], ...] = (
    ("draft", "Draft"),
    ("submitted", "Submitted"),
    ("decision", "Decision desk"),
    ("endorsement", "Sign-off"),
    ("approvals", "Approval ladder"),
    ("logistics", "Logistics"),
    ("movement", "Returned"),
    ("acknowledged", "Acknowledged"),
)

#: The same eight legs, in the order EVERY return travels them.
#:
#: ADDED 2026-09-07 for returns raised against an indent, and made the order for all of
#: them the same day. The business states it as
#:
#:     … → Inventory Manager → SCM Head → decision desk → SCM Head sign-off → logistics
#:
#: so the Indent Return approval ladder runs FIRST — resolved from the linked indent's
#: original project/post where the return names one — and only then does the inventory
#: desk decide where the material goes, with the sign-off that closes that leg being the
#: approval that releases the return to logistics. Handing a return straight to the desk
#: had it routing material nobody in the raiser's line had yet agreed was coming back.
#:
#: Kept as a second tuple rather than as a sort applied to the one above, because the
#: tracker is a fixed sequence a person reads left to right and both orders have to be
#: readable as written. `service.journey` picks between them on the document's own marker;
#: only a row raised under an earlier order still travels `PHASES`.
PHASES_APPROVAL_FIRST: tuple[tuple[str, str], ...] = (
    ("draft", "Draft"),
    ("submitted", "Submitted"),
    ("approvals", "Approval ladder"),
    ("decision", "Decision desk"),
    ("endorsement", "Sign-off"),
    ("logistics", "Logistics"),
    ("movement", "Returned"),
    ("acknowledged", "Acknowledged"),
)

#: What marks an `inv_sto` row as a return rather than a plain transfer. Leading, so
#: the filter is a prefix match.
#:
#: Lives here rather than in `service.py` because the reports module has to apply the
#: same test to build the returns ledger, and reports may not reach into another
#: module's service internals. One definition, two readers, no drift.
MARKER = "[STOCK_RETURN]"
