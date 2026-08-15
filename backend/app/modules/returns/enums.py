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


# The `sys_doc_series` key. Three letters of "stock_return" would be "STO", which is
# how everyone here says Stock Transfer Order, so the series is named outright.
NUMBER_SERIES = "ret"


class ReturnStatus(str, Enum):
    """A subset of STOStatus.

    APPROVED means the last rung signed and the stock has physically moved. RECEIVED
    means the person who raised it has since confirmed the return is done — the
    acknowledgement that closes the document. DISPATCHED is unused: approval and
    despatch are the same instant here, so a separate value could only ever be a
    status nothing sets.
    """

    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
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


INTENT_LABELS: dict[str, str] = {
    ReturnIntent.REPLACEMENT.value: "Replacement wanted",
    ReturnIntent.RETURN.value: "Return only — no replacement",
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
    ReturnReason.OTHER.value: "Other",
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

# Statuses a return can still be edited or withdrawn from.
EDITABLE = frozenset({ReturnStatus.DRAFT.value})
# Where the reservation is still standing, so cancelling has to give the stock back.
HOLDING_STOCK = frozenset({ReturnStatus.PENDING_APPROVAL.value})
# The stock has moved and the raiser has not yet said so.
AWAITING_ACK = frozenset({ReturnStatus.APPROVED.value})
# Nothing further will happen to the document.
CLOSED = frozenset({
    ReturnStatus.RECEIVED.value,
    ReturnStatus.REJECTED.value,
    ReturnStatus.CANCELLED.value,
})

# The legs the tracker draws, in order. Held here rather than in the frontend so the
# stepper and the status guards can never describe different flows.
#
# `decision` and `endorsement` are the same leg an indent has between its approval chain
# and the goods moving — the inventory desk works it, then the warehouse signs off — but
# they are drawn separately because they ask different questions. The reporting line
# decides whether the stock should leave the branch; the inventory desk decides where it
# is worth the most; the warehouse only agrees or objects to that decision. Collapsing
# the last two into one leg was what made the tracker unable to say who was holding it.
#
# Both stay in the tracker even where no receiving ladder is configured, so the flow the
# screen describes is the flow the business has, not the flow this deployment happens to
# be configured for.
PHASES: tuple[tuple[str, str], ...] = (
    ("draft", "Draft"),
    ("submitted", "Submitted"),
    ("approvals", "Approvals"),
    ("decision", "Inventory decision"),
    ("endorsement", "Warehouse sign-off"),
    ("movement", "Carried out"),
    ("acknowledged", "Acknowledged"),
)
