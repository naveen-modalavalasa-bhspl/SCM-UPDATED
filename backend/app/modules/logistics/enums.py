"""Logistics enums — the outward transport leg.

The mode is the important one. The business moves material four ways and they are
genuinely different documents wearing one name: a hand-over needs no carrier at all,
an own-vehicle leg costs nothing and hires nobody, a courier is booked not quoted, and
only a third-party truck is competitively priced. Modelling them as four statuses or
four tables would have duplicated the same seven columns; modelling them as one
`mode` column means the shape is shared and `MODE_RULES` below decides, in one place,
what each mode must carry and how far through the flow it goes.
"""
from enum import Enum


class TransportMode(str, Enum):
    """How the consignment actually travels."""
    # A warehouse person carries it to the indent location, or the indenter comes and
    # collects it. Nobody is hired, nothing is tracked — but somebody handed it over
    # and somebody took it, and that is the whole record.
    DIRECT = "DIRECT"
    # Booked with a courier at their published rate. There is a docket to track and a
    # bill to pay, but no quotation round: you do not tender a 5 kg parcel.
    COURIER = "COURIER"
    # A company vehicle already going that way for another job. Free, and the only
    # thing worth recording is which vehicle and who drove.
    OWN_VEHICLE = "OWN_VEHICLE"
    # A hired truck. Quoted, compared, awarded — the only mode where the carrier award
    # workflow runs, because it is the only one that commits negotiated freight.
    THIRD_PARTY = "THIRD_PARTY"


class TransportStatus(str, Enum):
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    # Approved and, for a quoted mode, out to carriers. A DIRECT or OWN_VEHICLE
    # request skips this and lands on READY.
    QUOTING = "QUOTING"
    # A provider is fixed (or none is needed) and the consignment can leave.
    READY = "READY"
    IN_TRANSIT = "IN_TRANSIT"
    DELIVERED = "DELIVERED"
    CLOSED = "CLOSED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


#: Statuses a transport request can no longer be edited or acted on from.
TERMINAL_STATUSES = frozenset({
    TransportStatus.CLOSED.value,
    TransportStatus.REJECTED.value,
    TransportStatus.CANCELLED.value,
})


class QuoteStatus(str, Enum):
    """One row per carrier invited to a request."""
    INVITED = "INVITED"
    SUBMITTED = "SUBMITTED"
    AWARDED = "AWARDED"
    # Not chosen. Kept, never deleted — the losing quotes are the evidence that the
    # winning one was the best of three (doc B8).
    NOT_AWARDED = "NOT_AWARDED"
    DECLINED = "DECLINED"


class ShipmentEventType(str, Enum):
    """The custody trail, plus the two that are claims rather than progress."""
    PICKED_UP = "PICKED_UP"
    IN_TRANSIT = "IN_TRANSIT"
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY"
    DELIVERED = "DELIVERED"
    # Exceptions. Same table because they arrive on the same timeline and an
    # "it reached short" call is answered by reading the events in order.
    DAMAGED = "DAMAGED"
    MISSING = "MISSING"
    DELAYED = "DELAYED"


#: Event types that open a claim against the provider rather than record progress.
EXCEPTION_EVENT_TYPES = frozenset({
    ShipmentEventType.DAMAGED.value,
    ShipmentEventType.MISSING.value,
    ShipmentEventType.DELAYED.value,
})


class ModeRule:
    """What a mode requires, and how much of the flow it uses.

    Held as data rather than as branches in the service so that the API can hand the
    same table to the frontend: the form asks for a vehicle number only when the mode
    says it must, instead of the screen keeping its own copy of these rules and
    drifting from the validation.
    """

    __slots__ = ("needs_carrier", "needs_quotes", "required_fields", "label", "help")

    def __init__(self, label: str, help: str, needs_carrier: bool,
                 needs_quotes: bool, required_fields: tuple[str, ...]):
        self.label = label
        self.help = help
        self.needs_carrier = needs_carrier
        self.needs_quotes = needs_quotes
        self.required_fields = required_fields


MODE_RULES: dict[str, ModeRule] = {
    TransportMode.DIRECT.value: ModeRule(
        label="Direct hand-over",
        help="A warehouse person delivers it, or the indenter collects it. "
             "No carrier and no freight.",
        needs_carrier=False, needs_quotes=False,
        required_fields=("handed_over_by_name", "received_by_name"),
    ),
    TransportMode.COURIER.value: ModeRule(
        label="Courier",
        help="Booked with a courier at their standard rate. Track it on the docket.",
        needs_carrier=True, needs_quotes=False,
        required_fields=("carrier_id",),
    ),
    TransportMode.OWN_VEHICLE.value: ModeRule(
        label="Own vehicle",
        help="A company vehicle already heading that way. No freight cost.",
        needs_carrier=False, needs_quotes=False,
        required_fields=("vehicle_number", "driver_name"),
    ),
    TransportMode.THIRD_PARTY.value: ModeRule(
        label="Third-party logistics",
        help="Invite carriers, compare their quotes and award the shipment.",
        needs_carrier=True, needs_quotes=True,
        required_fields=("carrier_id",),
    ),
}


def mode_rule(mode: str) -> ModeRule:
    rule = MODE_RULES.get((mode or "").upper())
    if rule is None:
        raise KeyError(mode)
    return rule


#: The vendor_type on `mst_vendors` that marks a row as a transport provider. A
#: carrier is a vendor — same master, same portal login, same rate history — so
#: nothing here creates a second supplier table.
CARRIER_VENDOR_TYPES = ("TRANSPORT", "LOGISTICS", "COURIER")
