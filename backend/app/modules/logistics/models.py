"""lgs_ tables — GRN and Issues. Owned by modules/logistics.

Stock (stk_balance, stk_ledger) moved to modules/inventory: Inventory is the base
module and owns every stock table, so logistics calls inventory.service.move_stock()
rather than mutating balances itself.

KNOWN GAP: the GRN and Issue models below still map lgs_grn / lgs_issues, which do
not exist in the live SCM_REBUILD schema — the DB team models inbound receipts as
inb_receipts and issues as out_issues. Those belong to the Inventory and Warehouse
modules and are out of scope for the Admin & Masters build, so they are left as-is
and flagged here rather than silently half-migrated.
"""
from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric,
    String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.modules.logistics.enums import (
    DEFAULT_CARRIAGE,
    QuoteStatus,
    TransportStatus,
    TripStatus,
    TripStopStatus,
)
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col

QTY = Numeric(16, 3)
MONEY = Numeric(16, 2)


class GRN(Base):
    __tablename__ = "lgs_grn"
    id = pk()
    grn_no = Column(String(30), unique=True, nullable=False)
    grn_date = Column(Date, nullable=True)
    po_id = Column(ForeignKey("pro_purchase_orders.id"), index=True, nullable=True)  # backward pointer
    po_no = Column(String(30), nullable=True)   # snapshot
    vendor_id = soft_fk()
    vendor_name = Column(String(200), nullable=True)
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)
    invoice_no = Column(String(60), nullable=True)
    invoice_date = Column(Date, nullable=True)
    vehicle_no = Column(String(30), nullable=True)
    transporter = Column(String(150), nullable=True)
    received_by_id = soft_fk()
    received_by_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    total_items = Column(Integer, nullable=False, default=0)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "GRNItem", back_populates="grn",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_lgs_grn_facility_date", GRN.facility_id, GRN.grn_date.desc())


class GRNItem(Base):
    __tablename__ = "lgs_grn_items"
    id = pk()
    grn_id = Column(ForeignKey("lgs_grn.id", ondelete="CASCADE"), index=True, nullable=False)
    po_item_id = Column(ForeignKey("pro_po_items.id"), index=True, nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    ordered_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    accepted_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    rejected_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    batch_no = Column(String(60), nullable=True)
    expiry_date = Column(Date, nullable=True)
    remarks = Column(Text, nullable=True)

    grn = relationship("GRN", back_populates="items")


class Issue(Base):
    __tablename__ = "lgs_issues"
    id = pk()
    issue_no = Column(String(30), unique=True, nullable=False)
    issue_date = Column(Date, nullable=True)
    indent_id = Column(ForeignKey("ind_indents.id"), index=True, nullable=True)
    indent_no = Column(String(30), nullable=True)
    facility_id = soft_fk()            # issued from
    facility_name = Column(String(200), nullable=True)
    department_id = soft_fk()          # issued to
    department_name = Column(String(200), nullable=True)
    issued_to_id = soft_fk()
    issued_to_name = Column(String(200), nullable=True)
    issued_by_id = soft_fk()
    issued_by_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()

    items = relationship(
        "IssueItem", back_populates="issue",
        cascade="all, delete-orphan", lazy="selectin",
    )


class IssueItem(Base):
    __tablename__ = "lgs_issue_items"
    id = pk()
    issue_id = Column(ForeignKey("lgs_issues.id", ondelete="CASCADE"), index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(14, 3), nullable=False)
    batch_no = Column(String(60), nullable=True)

    issue = relationship("Issue", back_populates="items")


# ---------------------------------------------------------------------------
# Transport — the outward leg the warehouse hands over
#
# Deliberately NOT columns on `out_dispatches`. A dispatch is the warehouse saying
# "this left the building"; a transport request is logistics saying "this is what has
# to travel, and here is who is taking it". One dispatch can be re-tendered after a
# carrier declines without the dispatch changing at all, and a request can exist
# before any dispatch does — the warehouse asks for transport while it is still
# packing. Linked by `dispatch_id`, which stays nullable for exactly that reason.
#
# Soft pointers throughout (`source_*`, `carrier_id`): the referents live in the
# warehouse module and in `mst_vendors`, and a hard FK to a warehouse table would put
# logistics in front of warehouse in the import chain.
# ---------------------------------------------------------------------------

class TransportRequest(Base):
    """`lgs_transport_requests` — one consignment's worth of transport."""
    __tablename__ = "lgs_transport_requests"

    id = pk()
    tr_no = Column(String(50), unique=True, nullable=False)
    tr_date = Column(Date, nullable=True)
    # DIRECT / COURIER / OWN_VEHICLE / THIRD_PARTY. Decides which columns below are
    # required and whether the quoting round runs at all — see enums.MODE_RULES.
    mode = Column(String(30), nullable=False, index=True)
    # ROAD / RAIL / AIR / SEA — what it travels ON, as against the `mode` above, which
    # says who moves it. Two questions, and the screen was asking both while only one
    # of them was ever written down. Never null: a leg that named no carriage is a
    # road leg, which is what every existing row is — see enums.CARRIAGE_RULES for
    # which arrangements each carriage can be made under.
    carriage_mode = Column(String(20), nullable=False, index=True,
                           default=DEFAULT_CARRIAGE, server_default=DEFAULT_CARRIAGE)
    status = Column(String(30), nullable=False, index=True,
                    default=TransportStatus.DRAFT.value)

    # What it came from. Any of the three may be set; `source_type`/`source_id` is the
    # generic pointer the timeline reads, the named ones are for filtering.
    source_type = Column(String(30), nullable=True)
    source_id = Column(BigInteger, index=True, nullable=True)
    source_no = Column(String(50), nullable=True)
    issue_id = Column(BigInteger, index=True, nullable=True)
    # The warehouse consignment (`out_dispatches`) this leg carries. A soft id and a
    # snapshot of its number, never a join: the referent lives in the warehouse module,
    # which sits AFTER logistics in the import chain (rule 5). The number is snapshotted
    # so the transport register reads on its own, without a cross-module read.
    dispatch_id = Column(BigInteger, index=True, nullable=True)
    consignment_no = Column(String(50), nullable=True)
    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(50), nullable=True)

    from_warehouse_id = Column(BigInteger, index=True, nullable=True)
    from_warehouse_name = Column(String(200), nullable=True)
    # SCM_0053: the DC/DOD gate pass named the origin but never its address — this
    # is where that address comes from. Snapshotted off the consignment's own
    # `warehouse_address` at the moment the leg is raised, same rule as
    # from_warehouse_name itself.
    from_warehouse_address = Column(String(500), nullable=True)
    to_location_name = Column(String(200), nullable=True)
    delivery_address = Column(String(500), nullable=True)
    contact_person = Column(String(200), nullable=True)
    contact_phone = Column(String(30), nullable=True)
    distance_km = Column(Numeric(10, 2), nullable=True)
    project_id = Column(BigInteger, index=True, nullable=True)
    project_name = Column(String(200), nullable=True)

    # Totals, kept on the header so a carrier can price the job without reading every
    # line. Recomputed from the lines on every write; never edited directly.
    total_items = Column(Integer, nullable=False, default=0)
    total_qty = Column(QTY, nullable=False, default=0)
    total_weight_kg = Column(QTY, nullable=False, default=0)
    total_volume_cbm = Column(Numeric(14, 4), nullable=False, default=0)
    total_packages = Column(Integer, nullable=False, default=0)

    # Who is taking it. `carrier_id` is a `mst_vendors` row of a transport type — a
    # carrier is a vendor, so it reuses the vendor master, the vendor portal login and
    # the vendor's rate history rather than opening a second supplier table.
    carrier_id = Column(BigInteger, index=True, nullable=True)
    carrier_name = Column(String(200), nullable=True)
    evaluation_method = Column(String(30), nullable=True)
    freight_amount = Column(MONEY, nullable=True)
    awarded_quote_id = Column(BigInteger, nullable=True)
    awarded_by_id = soft_fk()
    awarded_by_name = Column(String(200), nullable=True)
    awarded_at = Column(DateTime, nullable=True)

    # The carrier's own answer to the award. Winning a tender is an offer; a booking
    # is what the carrier confirms in their portal, and until they do there is no
    # truck. A decline is kept beside the acceptance rather than only unwinding the
    # award, because "who dropped us, and why" is the reason the next tender excludes
    # them.
    carrier_accepted_at = Column(DateTime, nullable=True)
    carrier_declined_at = Column(DateTime, nullable=True)
    carrier_decline_reason = Column(String(500), nullable=True)
    #: The carrier's own booking id, typed in by them. Not the LR — that comes later.
    carrier_reference = Column(String(100), nullable=True)
    #: Set when the desk confirms on the carrier's behalf (a phone call). Recorded so
    #: an acceptance nobody in the portal ever made cannot be mistaken for one.
    carrier_confirmed_by_name = Column(String(200), nullable=True)

    # Own vehicle.
    vehicle_number = Column(String(50), nullable=True)
    driver_name = Column(String(200), nullable=True)
    driver_phone = Column(String(30), nullable=True)
    # Who was behind the wheel. A courier books at a published rate and a tender is
    # priced by the carriers, so there is no price to record when the load is handed
    # over — what the gate and the receiving site need is the person, and the licence
    # is the only thing that names one who is not ours.
    driver_licence_no = Column(String(50), nullable=True)
    # The other job the vehicle was already doing — the whole reason this mode is free.
    trip_reference = Column(String(200), nullable=True)

    # Direct hand-over.
    handed_over_by_name = Column(String(200), nullable=True)
    # WHO that person is, pinned to a number. A name on its own identifies nobody once
    # the load is being chased: one of ours is their employee id, anybody else is an
    # Aadhaar, and never both — an employee's Aadhaar is not ours to hold when HCM
    # already knows who they are. The same pair carries the DRIVER of an own vehicle,
    # who is the person custody passes to for the trip; the name and phone of a driver
    # stay in the driver columns above, next to the vehicle they came on.
    handed_over_employee_id = Column(String(50), nullable=True)
    handed_over_aadhaar = Column(String(12), nullable=True)
    handed_over_phone = Column(String(30), nullable=True)
    received_by_name = Column(String(200), nullable=True)

    # The tracking handle. `lr_no` for a truck, `docket_no` for a courier; both kept
    # because a consignment note and a docket are not the same document and a shipment
    # that changed mode mid-flight carries one of each.
    lr_no = Column(String(50), nullable=True)
    docket_no = Column(String(50), nullable=True)
    tracking_url = Column(String(500), nullable=True)
    eway_bill_no = Column(String(50), nullable=True)

    expected_delivery = Column(Date, nullable=True)
    # The dispatch leg, merged into this document rather than kept on a second one.
    # The warehouse consignment says what was packed; from the moment it is handed to
    # logistics, "it left the yard" is a fact about the transport, so the gate pass and
    # who released it live here beside the LR they were written with.
    gate_pass_no = Column(String(50), nullable=True)
    dispatched_at = Column(DateTime, nullable=True)
    dispatched_by_name = Column(String(200), nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    delivered_to_name = Column(String(200), nullable=True)
    pod_url = Column(String(500), nullable=True)
    # Set when the field is told where its material is (doc D5). Read by the indent
    # team's chase list — an untold field cannot acknowledge.
    tracking_shared_at = Column(DateTime, nullable=True)

    # The receiving end (doc A6-A7). Delivered is the carrier's word for it; this is
    # the site's, and it is the one that closes the loop. `ack_condition` is what the
    # site says it found — anything but GOOD raises a claim on the same timeline.
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by_id = soft_fk()
    acknowledged_by_name = Column(String(200), nullable=True)
    ack_condition = Column(String(20), nullable=True)
    ack_remarks = Column(Text, nullable=True)

    remarks = Column(Text, nullable=True)
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    requested_position_id = Column(BigInteger, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "TransportRequestItem", back_populates="request",
        cascade="all, delete-orphan", lazy="selectin",
        order_by="TransportRequestItem.line_no",
    )
    quotes = relationship(
        "CarrierQuote", back_populates="request",
        cascade="all, delete-orphan", lazy="selectin",
        order_by="CarrierQuote.id",
    )
    events = relationship(
        "ShipmentEvent", back_populates="request",
        cascade="all, delete-orphan", lazy="selectin",
        order_by="ShipmentEvent.event_at",
    )


Index("ix_lgs_tr_status_date", TransportRequest.status,
      TransportRequest.tr_date.desc())


# ---------------------------------------------------------------------------
# Consolidated trips -- one physical vehicle carrying many consignments.
#
# The trip is the ROUTE: which stops, in which order, which consignment comes off at
# which one. Everything a shipment already knows how to do -- the mode, the tender,
# the award, the carrier's own yes, the gate, the LR, the freight -- belongs to the
# ONE transport request the trip raises (`tr_id`, `source_type = TRIP`). So a
# multi-drop run is priced once, awarded once and released once, through exactly the
# screens a single consignment uses, and nothing here re-implements any of it.
#
# What the trip adds is what a single-consignment leg cannot say: where along the
# road each consignment is delivered, and whether ITS site has signed. Each receiving
# site still signs for its own consignment on its own Acknowledgements screen; the
# trip closes itself once every one of them has.
# ---------------------------------------------------------------------------

class ConsolidatedTrip(Base):
    __tablename__ = "lgs_consolidated_trips"

    id = pk()
    trip_no = Column(String(50), unique=True, nullable=False)
    status = Column(String(30), nullable=False, index=True,
                    default=TripStatus.PLANNED.value)
    departure_date = Column(Date, nullable=False)
    from_warehouse_id = Column(BigInteger, index=True, nullable=False)
    from_warehouse_name = Column(String(200), nullable=True)
    origin_latitude = Column(Numeric(10, 7), nullable=False)
    origin_longitude = Column(Numeric(10, 7), nullable=False)
    #: The shipment that carries this trip. Soft id plus a snapshot of its number,
    #: the same way the shipment points back at `source_id`.
    tr_id = Column(BigInteger, index=True, nullable=True)
    tr_no = Column(String(50), nullable=True)

    policy_name = Column(String(100), nullable=False, default="Balanced")
    route_version = Column(Integer, nullable=False, default=1)
    total_consignments = Column(Integer, nullable=False, default=0)
    total_stops = Column(Integer, nullable=False, default=0)
    total_packages = Column(Integer, nullable=False, default=0)
    total_weight_kg = Column(QTY, nullable=False, default=0)
    vehicle_profile = Column(String(100), nullable=True)
    vehicle_capacity_kg = Column(QTY, nullable=True)
    #: Whether the planned kilometres include the empty run back to the origin.
    returns_to_origin = Column(Boolean, nullable=False, default=True)
    road_factor = Column(Numeric(6, 3), nullable=True)
    cost_per_km = Column(MONEY, nullable=True)
    estimated_distance_km = Column(Numeric(12, 2), nullable=False, default=0)
    separate_distance_km = Column(Numeric(12, 2), nullable=False, default=0)
    estimated_saving_km = Column(Numeric(12, 2), nullable=False, default=0)
    estimated_saving_amount = Column(MONEY, nullable=False, default=0)
    #: What the kilometres above were measured with: ROAD (every leg routed), MIXED
    #: (some legs routed, the rest estimated) or ESTIMATE (straight line x factor).
    #: Kept beside the numbers so a plan costed on estimates is never read later as a
    #: routed one.
    distance_basis = Column(String(20), nullable=True)
    #: The cargo box the plan was checked against, in cubic metres. NULL: not limited
    #: by volume, which is what every trip planned before this was.
    vehicle_capacity_cbm = Column(Numeric(10, 3), nullable=True)
    total_volume_cbm = Column(Numeric(12, 4), nullable=True)

    vehicle_number = Column(String(50), nullable=True)
    driver_name = Column(String(200), nullable=True)
    driver_phone = Column(String(30), nullable=True)
    gate_pass_no = Column(String(50), nullable=True)
    dispatched_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)
    remarks = Column(Text, nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    stops = relationship(
        "ConsolidatedTripStop", back_populates="trip",
        cascade="all, delete-orphan", lazy="selectin",
        order_by="ConsolidatedTripStop.sequence",
    )
    consignments = relationship(
        "ConsolidatedTripConsignment", back_populates="trip",
        cascade="all, delete-orphan", lazy="selectin",
        order_by="ConsolidatedTripConsignment.id",
    )


Index("ix_lgs_trip_origin_status", ConsolidatedTrip.from_warehouse_id,
      ConsolidatedTrip.status)


class ConsolidatedTripStop(Base):
    __tablename__ = "lgs_consolidated_trip_stops"

    id = pk()
    trip_id = Column(ForeignKey("lgs_consolidated_trips.id", ondelete="CASCADE"),
                     index=True, nullable=False)
    sequence = Column(Integer, nullable=False)
    destination_warehouse_id = Column(BigInteger, index=True, nullable=False)
    destination_code = Column(String(50), nullable=True)
    destination_name = Column(String(200), nullable=False)
    delivery_address = Column(String(500), nullable=True)
    #: Who to ring at the gate, snapshotted from the consignment at planning. The
    #: driver reads the trip through the carrier portal, which may not read the
    #: warehouse's consignment (rule 5).
    contact_person = Column(String(200), nullable=True)
    contact_phone = Column(String(20), nullable=True)
    latitude = Column(Numeric(10, 7), nullable=False)
    longitude = Column(Numeric(10, 7), nullable=False)
    status = Column(String(30), nullable=False, default=TripStopStatus.PLANNED.value)
    distance_from_previous_km = Column(Numeric(12, 2), nullable=False, default=0)
    total_consignments = Column(Integer, nullable=False, default=0)
    total_packages = Column(Integer, nullable=False, default=0)
    total_weight_kg = Column(QTY, nullable=False, default=0)
    arrived_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    delivered_by_name = Column(String(200), nullable=True)
    received_by_name = Column(String(200), nullable=True)
    #: Who said this stop was reached: DESK (the logistics desk) or CARRIER (the
    #: carrier's portal, stop by stop). Evidence for a dispute about who put it down.
    delivered_via = Column(String(20), nullable=True)
    #: The carrier's proof of delivery for THIS stop — a signed copy at stop two is
    #: not proof of anything at stop three.
    pod_url = Column(String(500), nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)

    trip = relationship("ConsolidatedTrip", back_populates="stops")
    consignments = relationship(
        "ConsolidatedTripConsignment", back_populates="stop", lazy="selectin")


class ConsolidatedTripConsignment(Base):
    __tablename__ = "lgs_consolidated_trip_consignments"

    id = pk()
    trip_id = Column(ForeignKey("lgs_consolidated_trips.id", ondelete="CASCADE"),
                     index=True, nullable=False)
    stop_id = Column(ForeignKey("lgs_consolidated_trip_stops.id", ondelete="CASCADE"),
                     index=True, nullable=False)
    #: The warehouse consignment (`out_dispatches`) and its UNIQUE number, snapshotted:
    #: the number is what the driver, the gate and the receiving site all read.
    dispatch_id = Column(BigInteger, index=True, nullable=False)
    consignment_no = Column(String(50), nullable=False)
    destination_warehouse_id = Column(BigInteger, nullable=True)
    destination_name = Column(String(200), nullable=False)
    #: The indent behind it, so the requester's "where is my material" can find the
    #: trip without logistics reading the warehouse's tables (rule 5). A consignment
    #: carrying several issues can serve several indents; the others are listed.
    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(50), nullable=True)
    indent_nos = Column(String(500), nullable=True)
    packages = Column(Integer, nullable=False, default=0)
    weight_kg = Column(QTY, nullable=False, default=0)
    status = Column(String(30), nullable=False, default=TripStopStatus.PLANNED.value)
    delivered_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
    acknowledged_by_name = Column(String(200), nullable=True)
    ack_condition = Column(String(20), nullable=True)

    trip = relationship("ConsolidatedTrip", back_populates="consignments")
    stop = relationship("ConsolidatedTripStop", back_populates="consignments")


Index("ix_lgs_trip_consignment_active", ConsolidatedTripConsignment.dispatch_id,
      ConsolidatedTripConsignment.status)


class RoadDistance(Base):
    """`lgs_road_distances` — one routed road distance between two map points.

    A CACHE of what the routing service answered (`logistics/routing.py`), keyed on
    the two coordinates rounded to five places (about a metre), so a stocking point
    re-pinned elsewhere is simply a new pair and the old answer can never be served
    for it. Directional: the road from A to B is not always the road from B to A.

    Nothing reads this as the truth about a road it has not been asked about — a pair
    missing here is ESTIMATED, and labelled so, never guessed from a neighbour.
    """
    __tablename__ = "lgs_road_distances"

    id = pk()
    #: "lat,lon>lat,lon" at five decimals. Unique: one answer per direction.
    pair_key = Column(String(64), nullable=False, unique=True)
    from_lat = Column(Numeric(10, 5), nullable=False)
    from_lon = Column(Numeric(10, 5), nullable=False)
    to_lat = Column(Numeric(10, 5), nullable=False)
    to_lon = Column(Numeric(10, 5), nullable=False)
    distance_km = Column(Numeric(12, 3), nullable=False)
    duration_min = Column(Numeric(12, 2), nullable=True)
    #: Which service and profile answered, e.g. "OSRM:driving".
    source = Column(String(40), nullable=False)
    fetched_at = Column(DateTime, nullable=False)


Index("ix_lgs_road_distances_from", RoadDistance.from_lat, RoadDistance.from_lon)
Index("ix_lgs_road_distances_to", RoadDistance.to_lat, RoadDistance.to_lon)


class TransportRequestItem(Base):
    """`lgs_transport_request_items` — what is in the consignment.

    Weight and dimensions live here rather than only on the header because that is
    what a carrier prices, and because a part-delivery has to say which lines arrived.
    """
    __tablename__ = "lgs_transport_request_items"

    id = pk()
    tr_id = Column(ForeignKey("lgs_transport_requests.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    item_id = Column(BigInteger, index=True, nullable=True)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(QTY, nullable=False, default=0)
    delivered_qty = Column(QTY, nullable=False, default=0)

    package_count = Column(Integer, nullable=False, default=0)
    package_type = Column(String(50), nullable=True)
    weight_kg = Column(QTY, nullable=True)
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    is_fragile = Column(Boolean, nullable=False, default=False)
    remarks = Column(String(500), nullable=True)

    request = relationship("TransportRequest", back_populates="items")


class CarrierQuote(Base):
    """`lgs_carrier_quotes` — one row per carrier invited to a request.

    Invitation and quotation in one row, unlike procurement's split of `pro_rfq_vendors`
    from `pro_quotations`. A freight quote is a single number with a date beside it;
    there are no quotation LINES to hang off a second table, and keeping the invite
    and the answer together is what makes "who was asked and who bothered to reply"
    one query.

    A losing row is never deleted — three quotes on file is the evidence the award was
    competitive (doc B8), and deleting the losers destroys exactly that.
    """
    __tablename__ = "lgs_carrier_quotes"

    id = pk()
    tr_id = Column(ForeignKey("lgs_transport_requests.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    carrier_id = Column(BigInteger, index=True, nullable=False)
    carrier_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, default=QuoteStatus.INVITED.value)

    freight_amount = Column(MONEY, nullable=True)
    # Everything on top of the line-haul: loading, packing, detention. Held apart so
    # LOWEST_PRICE and LOWEST_LANDED_COST can rank the same set differently.
    other_charges = Column(MONEY, nullable=False, default=0)
    tax_percent = Column(Numeric(6, 2), nullable=True)
    transit_days = Column(Integer, nullable=True)
    valid_until = Column(Date, nullable=True)
    vehicle_type = Column(String(100), nullable=True)
    remarks = Column(Text, nullable=True)

    invited_at = Column(DateTime, nullable=True)
    submitted_at = Column(DateTime, nullable=True)
    # Snapshotted at award time, not recomputed on read: the ranking that justified the
    # award has to keep saying what it said, even after the evaluation method changes.
    score = Column(Numeric(10, 4), nullable=True)
    rank = Column(Integer, nullable=True)

    request = relationship("TransportRequest", back_populates="quotes")


Index("ix_lgs_quote_tr_carrier", CarrierQuote.tr_id, CarrierQuote.carrier_id,
      unique=True)


class ShipmentEvent(Base):
    """`lgs_shipment_events` — the custody trail and the claims, on one timeline.

    Append-only in spirit: a scan is evidence. The one field that is written after the
    fact is the exception resolution, because closing a claim is itself an event the
    same row is the natural home for — a separate `lgs_exceptions` table would have
    duplicated tr_id, carrier, timestamp and description to hold two extra columns.
    """
    __tablename__ = "lgs_shipment_events"

    id = pk()
    tr_id = Column(ForeignKey("lgs_transport_requests.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    event_type = Column(String(30), nullable=False, index=True)
    event_at = Column(DateTime, nullable=False)
    location_name = Column(String(200), nullable=True)
    description = Column(String(500), nullable=True)

    # Set for DAMAGED / MISSING / DELAYED. A plain boolean rather than deriving it from
    # event_type on every query: the Exceptions screen is "open claims", and that is an
    # index on two columns, not a scan with an IN-list.
    is_exception = Column(Boolean, nullable=False, default=False, index=True)
    affected_item_name = Column(String(300), nullable=True)
    affected_qty = Column(QTY, nullable=True)
    claim_amount = Column(MONEY, nullable=True)
    resolution = Column(Text, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    resolved_by_id = soft_fk()
    resolved_by_name = Column(String(200), nullable=True)

    recorded_by_id = soft_fk()
    recorded_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()

    request = relationship("TransportRequest", back_populates="events")


Index("ix_lgs_event_open_exception", ShipmentEvent.is_exception,
      ShipmentEvent.resolved_at)


