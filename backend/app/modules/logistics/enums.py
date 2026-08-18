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

from app.shared.enums import CARRIER_VENDOR_TYPES


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


class TransportSource(str, Enum):
    """What the leg is carrying, which is also WHICH WAY it runs.

    Outward legs are the whole of doc Phase E up to E6 and they all start at a
    warehouse. E7 — "return items from field tracked, returned back to the warehouse" —
    is the same document run backwards, and it is the source that says so: the trip
    from a site to a warehouse is planned, priced, tracked and closed exactly like the
    trip out, so it is one table and one flow rather than a second half-copy of both.
    """
    #: A packed warehouse consignment going out to the field (E1-E6).
    CONSIGNMENT = "CONSIGNMENT"
    #: A material issue going out.
    ISSUE = "ISSUE"
    #: Coming BACK: the field is sending material to a warehouse (E7). The return
    #: DECISION is the returns module's; this is only the trip it needs to travel.
    RETURN = "RETURN"


#: Sources whose leg runs field -> warehouse rather than warehouse -> field. Read
#: wherever a screen has to label the two ends, so "from" and "to" never have to be
#: guessed from which columns happen to be filled.
INBOUND_SOURCES = frozenset({TransportSource.RETURN.value})


def is_inbound(source_type: str | None) -> bool:
    return (source_type or "").upper() in INBOUND_SOURCES


class TransportStatus(str, Enum):
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    # Approved and, for a quoted mode, out to carriers. A DIRECT or OWN_VEHICLE
    # request skips this and lands on READY.
    QUOTING = "QUOTING"
    # Awarded, and waiting for the winning carrier to say yes in their own portal.
    # A won tender is an offer, not a booking: until the carrier confirms it has a
    # truck for that lane on that day, nothing can be loaded against it. Only a
    # tendered mode passes through here — a courier booking and a hand-over have
    # nobody to hear back from.
    AWAITING_CARRIER = "AWAITING_CARRIER"
    # A provider is fixed (or none is needed) and the consignment can leave.
    READY = "READY"
    IN_TRANSIT = "IN_TRANSIT"
    DELIVERED = "DELIVERED"
    # The receiving site has signed for it (doc A6). Delivered is the carrier's word;
    # acknowledged is the field's, and only the second one closes the indent's loop.
    ACKNOWLEDGED = "ACKNOWLEDGED"
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


class AckCondition(str, Enum):
    """How the material actually arrived, said by the site that signed for it.

    Anything but GOOD opens a claim on the same shipment timeline, because a site
    reporting a shortage and the logistics desk chasing the carrier for it are the
    same fact — recording it twice is how the two stop agreeing.
    """
    GOOD = "GOOD"
    SHORT = "SHORT"
    DAMAGED = "DAMAGED"


#: What each acknowledgement condition raises against the provider. GOOD raises
#: nothing; the other two are claims and go to the Exceptions desk.
ACK_CLAIM_EVENT: dict[str, str] = {
    AckCondition.SHORT.value: "MISSING",
    AckCondition.DAMAGED.value: "DAMAGED",
}


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


# --------------------------------------------------------------------------- #
#  Which mode SUITS this load (doc E3)
# --------------------------------------------------------------------------- #
# "Logistics provider identified — based on distance, weight, items." The desk still
# chooses; this only answers first, so the choice starts from the load rather than from
# whatever the last dispatch used. Held as thresholds rather than as branches for the
# same reason MODE_RULES is: the numbers are a business rule somebody will want to
# change, and they must change in ONE place, not in a service and again in a screen.
#
# The numbers below are a starting position, not a policy anybody signed off:
#   * 30 km — inside this a company vehicle can do the round trip and be back the same
#     day, so hiring anybody is a cost with nothing bought.
#   * 5 km / 10 kg — small enough and near enough that a person carries it.
#   * 25 kg — a courier's parcel ceiling. Past it a courier is priced as freight, and
#     freight is worth tendering.

#: Distance under which the warehouse's own vehicle is the sensible leg.
LOCAL_KM = 30
#: A load a person can reasonably walk or ride over.
HANDOVER_KM = 5
HANDOVER_KG = 10
#: The heaviest a courier will still treat as a parcel.
PARCEL_KG = 25


def suggest_mode(distance_km: float | None = None,
                 weight_kg: float | None = None,
                 packages: int | None = None) -> dict | None:
    """The mode this load looks like, and WHY — or None when nothing is known.

    Returning None rather than a default matters: a consignment whose distance and
    weight were never captured has told us nothing, and advising THIRD_PARTY off no
    evidence is worse than staying quiet, because a suggestion reads as an answer.
    """
    if distance_km is None and weight_kg is None:
        return None

    near = distance_km is not None and distance_km <= HANDOVER_KM
    local = distance_km is not None and distance_km <= LOCAL_KM
    light = weight_kg is not None and weight_kg <= HANDOVER_KG
    parcel = weight_kg is not None and weight_kg <= PARCEL_KG
    few = packages is None or packages <= 2

    if near and light and few:
        mode, why = (TransportMode.DIRECT.value,
                     f"{distance_km:g} km and {weight_kg:g} kg — somebody can carry it")
    elif local:
        mode, why = (TransportMode.OWN_VEHICLE.value,
                     f"{distance_km:g} km — inside {LOCAL_KM} km a company vehicle can "
                     "do the round trip")
    elif parcel:
        mode, why = (TransportMode.COURIER.value,
                     f"{weight_kg:g} kg — a courier still prices this as a parcel")
    else:
        mode, why = (TransportMode.THIRD_PARTY.value,
                     "too heavy or too far to book at a published rate — worth asking "
                     "several providers for a price")

    return {"mode": mode, "label": MODE_RULES[mode].label, "reason": why}


#: The vendor_type on `mst_vendors` that marks a row as a transport provider. A
#: carrier is a vendor — same master, same portal login, same rate history — so
#: nothing here creates a second supplier table. Defined in shared/enums.py and
#: re-exported here: the vendor master itself has to know which rows are carriers so
#: procurement's pickers can leave them out, and shared may not import a module.
CARRIER_VENDOR_TYPES = CARRIER_VENDOR_TYPES  # noqa: PLW0127 - re-export


# --------------------------------------------------------------------------- #
#  The flow, as the screen draws it
# --------------------------------------------------------------------------- #
# One consignment travels through a fixed set of stages, and the stepper at the top
# of every transport screen is that list. Held here rather than in the frontend for
# the same reason MODE_RULES is: the screen must draw the flow the service actually
# runs. A tendered shipment has two stages the others do not (the tender, and the
# carrier saying yes), so the list is per-mode and served at /api/transport/flow.

class Stage:
    __slots__ = ("key", "label", "help", "statuses")

    def __init__(self, key: str, label: str, help: str, statuses: tuple[str, ...]):
        self.key, self.label, self.help, self.statuses = key, label, help, statuses


_PLAN = Stage(
    "PLAN", "Transport request",
    "Items, quantity, weight and dimensions, taken off the packing list (E2).",
    (TransportStatus.DRAFT.value,),
)
_APPROVE = Stage(
    "APPROVE", "Approval",
    "The movement is sanctioned before anything is booked.",
    (TransportStatus.PENDING_APPROVAL.value,),
)
_TENDER = Stage(
    "TENDER", "Provider identified",
    "Invite providers, compare what they quoted and award the job (E3).",
    (TransportStatus.QUOTING.value,),
)
_CONFIRM = Stage(
    "CONFIRM", "Provider confirms",
    "The awarded provider accepts the job in their portal.",
    (TransportStatus.AWAITING_CARRIER.value,),
)
_DISPATCH = Stage(
    "DISPATCH", "Sent to provider",
    "Gate pass, LR / docket and e-way bill — then it leaves the yard (E4).",
    (TransportStatus.READY.value,),
)
_TRANSIT = Stage(
    "TRANSIT", "Tracked to destination",
    "Scans, delays and damage, tracked to the final destination (E5).",
    (TransportStatus.IN_TRANSIT.value,),
)
_DELIVERED = Stage(
    "DELIVERED", "Delivered",
    "The provider says it arrived and hands over the proof of delivery.",
    (TransportStatus.DELIVERED.value,),
)
_ACK = Stage(
    "ACKNOWLEDGE", "Cycle closed",
    "The indent's raiser signs for what reached them, and the leg is closed (E8).",
    (TransportStatus.ACKNOWLEDGED.value, TransportStatus.CLOSED.value),
)


def flow_stages(mode: str | None = None) -> list[Stage]:
    """The stages this mode actually passes through, in order."""
    tendered = bool(mode) and mode_rule(mode).needs_quotes
    stages = [_PLAN, _APPROVE]
    if tendered:
        stages += [_TENDER, _CONFIRM]
    return stages + [_DISPATCH, _TRANSIT, _DELIVERED, _ACK]


#: The shipment is on the road or has landed, and nobody at the receiving site has
#: signed for it yet. This — not DELIVERED alone — is the Acknowledgements queue.
#:
#: A consignment becomes the site's business the moment it LEAVES, not the moment
#: somebody at this desk remembers to tick "delivered". Waiting for that tick meant a
#: courier parcel that reached the site on Tuesday could not be acknowledged until the
#: logistics desk marked it arrived on Friday, and the indent behind it stayed open in
#: between. The receiving site signing for it is itself the proof it arrived, so the
#: acknowledgement stamps the delivery as well (`acknowledge_tr`).
AWAITING_ACK_STATUSES = (
    TransportStatus.IN_TRANSIT.value,
    TransportStatus.DELIVERED.value,
)
