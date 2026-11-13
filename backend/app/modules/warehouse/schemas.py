"""Request and response shapes.

Read models carry the snapshot columns the tables already hold, so a list response
is one row per document with nothing to join client-side. Write models carry only
what a user can actually set — `grn_no`, every `*_name`, every rollup and every
status are decided by the service, and accepting them from the client would let a
caller invent its own document number or mark its own issue approved.
"""
from app.shared.packing import PACK_ENTRIES, PackEntryIn, describe as describe_packs
from app.shared.org_scope_schemas import OrgScopeIn, OrgScopeOut
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.warehouse.enums import (
    VENDOR_RETURN_INBOUND_RESPONSES, VENDOR_RETURN_REFUND_RESPONSES,
    DispatchEventType, DispatchType, InspectionResult, InspectionType, IssueDirection,
    IssueType, PickStrategy, ReceiptType, VendorReturnResponse,
)
from app.shared.time import today as ist_today
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchIds, ConfigEntries, DocumentLines, SerialList,
    MAX_BATCH_IDS, MAX_DOCUMENT_LINES, MAX_SERIALS_PER_LINE,
    assert_serial_budget,
)
from app.shared.masters.combinations import CombinationIn, CombinationOut

ORM = ConfigDict(from_attributes=True)


class _Read(BaseModel):
    model_config = ORM

    @field_validator("status", "result", mode="before", check_fields=False)
    @classmethod
    def _upper_status(cls, value):
        """Statuses leave this module in one case, always.

        The live tables hold both `COMPLETED` and `completed` on `whs_inspections`
        (rows written before the enum was enforced). Every screen compares against
        the enum's uppercase value, so the QC tiles counted 14 of 20 inspections and
        reported an 82% pass rate over rows it had not looked at. Normalising on read
        is the only fix available without touching the data.
        """
        return value.upper() if isinstance(value, str) else value


# ---------------------------------------------------------------------------
# Warehouse master
# ---------------------------------------------------------------------------

class LocationStep(BaseModel):
    """One rung of the walk down to a storage location.

    Declared up here because two very different responses carry it — the location
    picker's options and an issue's stock sources — and both need to draw the same
    breadcrumb.
    """
    id: int
    code: str
    name: str | None = None
    bin_type: str | None = None



class WarehouseRead(_Read):
    id: int
    code: str
    name: str
    facility_id: int | None = None
    facility_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    warehouse_type: str
    address: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    coordinate_source: str | None = None
    coordinate_label: str | None = None
    coordinate_confidence: Decimal | None = None
    incharge_id: int | None = None
    incharge_name: str | None = None
    is_bin_managed: bool
    # None = follow the company default. See service.requires_inward.
    requires_inward: bool | None = None
    is_active: bool
    created_at: datetime | None = None


class UnlocatedStockStatus(BaseModel):
    """Stock a bin-managed warehouse holds with no location, and where it went.

    `pending_*` is what still stands at bin 0 (it is placed on the next pick or on
    the press); `held_*` is what its Unlocated location holds now. See
    `warehouse/unlocated.py`.
    """
    warehouse_id: int
    is_bin_managed: bool
    location_id: int | None = None
    location_code: str | None = None
    pending_rows: int = 0
    pending_qty: Decimal = Decimal("0")
    held_rows: int = 0
    held_items: int = 0
    held_qty: Decimal = Decimal("0")
    # Filled only by the press: what that press just moved.
    placed_rows: int = 0
    placed_qty: Decimal = Decimal("0")
    placed_units: int = 0
    # Filled by the audit/repair read: why codes can be missing after the switch.
    stranded_units: int = 0
    stranded_items: int = 0
    stale_lines: int = 0
    stale_issue_ids: list[int] = []
    repointed_lines: int = 0
    code_scope: str | None = None


class WarehouseWrite(BaseModel):
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=200)
    facility_id: int | None = None
    office_id: int | None = None
    warehouse_type: str = "MAIN"
    address: str | None = None
    latitude: Decimal | None = Field(default=None, ge=-90, le=90)
    longitude: Decimal | None = Field(default=None, ge=-180, le=180)
    incharge_id: int | None = None
    is_bin_managed: bool = False
    requires_inward: bool | None = None
    is_active: bool = True

    @model_validator(mode="after")
    def coordinates_are_a_pair(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must be entered together")
        return self


# ---------------------------------------------------------------------------
# Smart Load Planner / consolidated (multi-drop) trips — see `trips.py`
# ---------------------------------------------------------------------------

#: The planning inputs a run may override. Every one optional: what is not sent comes
#: from the site's policy (`logistics.trip_planner.*`).
_POLICY_KEYS = {"capacity_kg", "capacity_cbm", "volume_fill_pct", "max_packages",
                "max_stops", "max_detour_pct", "detour_floor_km", "cost_per_km",
                "road_factor", "return_to_origin", "default_package_kg",
                "default_package_cbm"}


class PlannerPolicyIn(BaseModel):
    capacity_kg: float | None = Field(default=None, gt=0, le=100000)
    #: The cargo box in m³; 0 = not limited by volume.
    capacity_cbm: float | None = Field(default=None, ge=0, le=500)
    volume_fill_pct: float | None = Field(default=None, ge=10, le=100)
    max_packages: int | None = Field(default=None, ge=0, le=100000)
    max_stops: int | None = Field(default=None, ge=1, le=25)
    max_detour_pct: float | None = Field(default=None, ge=0, le=300)
    detour_floor_km: float | None = Field(default=None, ge=0, le=500)
    cost_per_km: float | None = Field(default=None, ge=0, le=100000)
    road_factor: float | None = Field(default=None, ge=1, le=3)
    return_to_origin: bool | None = None
    #: What an unweighed / unmeasured package is ASSUMED to be. 0 = no assumption.
    default_package_kg: float | None = Field(default=None, ge=0, le=2000)
    default_package_cbm: float | None = Field(default=None, ge=0, le=20)

    def policy_overrides(self) -> dict:
        return self.model_dump(exclude_none=True, include=_POLICY_KEYS)


class VehicleProfileIn(BaseModel):
    code: str = Field(min_length=1, max_length=30)
    label: str = Field(min_length=1, max_length=100)
    capacity_kg: float = Field(gt=0, le=100000)
    capacity_cbm: float = Field(default=0, ge=0, le=500)
    max_packages: int = Field(default=0, ge=0, le=100000)
    cost_per_km: float = Field(default=0, ge=0, le=100000)


class PlannerPolicySave(PlannerPolicyIn):
    vehicle_profiles: Annotated[list[VehicleProfileIn], ConfigEntries] | None = None


class TripRecommendIn(PlannerPolicyIn):
    warehouse_id: int
    departure_date: date | None = None


class TripEvaluateIn(TripRecommendIn):
    dispatch_ids: Annotated[list[int], BatchIds]
    #: Destination warehouse ids in the order the desk wants them visited. Anything
    #: it leaves out is appended in the optimised order.
    stop_order: Annotated[list[int], BatchIds] | None = None

    @field_validator("dispatch_ids")
    @classmethod
    def _unique(cls, value):
        return list(dict.fromkeys(value))


class TripCreateIn(TripEvaluateIn):
    departure_date: date
    policy_name: str | None = Field(default=None, max_length=100)
    vehicle_profile: str | None = Field(default=None, max_length=100)
    remarks: str | None = Field(default=None, max_length=1000)

    @field_validator("dispatch_ids")
    @classmethod
    def _at_least_two(cls, value):
        value = list(dict.fromkeys(value))
        if len(value) < 2:
            raise ValueError("A trip combines at least two consignments — "
                             "dispatch a single one from the Dispatch queue")
        return value


class TripStopDeliverIn(BaseModel):
    received_by_name: str | None = Field(default=None, max_length=200)
    remarks: str | None = Field(default=None, max_length=500)
    delivered_at: datetime | None = None
    pod_url: str | None = Field(default=None, max_length=500)

    @field_validator("pod_url")
    @classmethod
    def _pod_is_a_link(cls, value):
        from app.modules.logistics.schemas import http_link
        return http_link(value)


class PackageMeasureIn(BaseModel):
    """One carton, weighed and measured on the load planner. A field left out is
    left as it is."""
    package_id: int
    weight_kg: Decimal | None = Field(default=None, gt=0, le=100000)
    length_cm: Decimal | None = Field(default=None, gt=0, le=5000)
    width_cm: Decimal | None = Field(default=None, gt=0, le=5000)
    height_cm: Decimal | None = Field(default=None, gt=0, le=5000)


class ConsignmentMeasuresIn(BaseModel):
    packages: Annotated[list[PackageMeasureIn], DocumentLines, Field(min_length=1)]


class TripCancelIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class PointLocationIn(BaseModel):
    """A stocking point pinned on the planner map. Bounded to India: a pin in the
    Atlantic is a slipped click, and the planner would route a truck to it."""
    latitude: float = Field(ge=6, le=37.5)
    longitude: float = Field(ge=68, le=97.5)
    label: str | None = Field(default=None, max_length=200)


class BinRead(_Read):
    id: int
    warehouse_id: int
    code: str
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None
    bin_type: str | None = None
    storage_type_id: int | None = None
    #: The kind's own name, off the storage-type master, so a tree can say "Rack"
    #: without every screen keeping its own copy of the code-to-label map.
    storage_type_name: str | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    # Derived when the tree is built, not stored — see service.bin_tree.
    path: str | None = None
    level: int | None = None
    capacity_qty: Decimal | None = None
    #: The USABLE cube on a decorated row: stated (or worked out from the three sides
    #: below) and then derated by the void factor, so a screen never re-derives it.
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    max_handling_units: int | None = None
    fill_efficiency_pct: Decimal | None = None
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool = False
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    is_pickable: bool
    is_active: bool
    occupied_qty: Decimal | None = None
    # Read, never stored — see modules/warehouse/capacity.py. Present on the rows the
    # suggestion list decorates and None everywhere else, so a screen can tell "this bin
    # is empty" from "nobody worked it out for this row". `capacity_volume` here is the
    # USABLE cube: stated or derived from the sides, then derated by the void factor.
    occupied_volume: Decimal | None = None
    free_volume: Decimal | None = None
    utilisation_pct: float | None = None
    capacity_status: str | None = None
    is_partial: bool | None = None
    # The discrete and payload gates, so a chip can say "1 of 1 pallet" — the limit no
    # cube expresses and the reason a bay with room left is still full.
    capacity_units: int | None = None
    occupied_units: Decimal | None = None
    capacity_weight_kg: Decimal | None = None
    occupied_weight_kg: Decimal | None = None
    # What this bin says about the LOAD IN HAND, as opposed to how full it is in
    # general — set only on the suggestion chips, which are ranked on it. `capacity_
    # status` describes the shelf; `fit_status` is the decision, and the two differ
    # exactly where it matters: a nine-tenths empty bay a pallet does not enter.
    fit_status: str | None = None
    #: Does ONE unit of this pack physically go in? None when either box is unmeasured.
    fits_pack: bool | None = None
    #: How many more of this pack it would still take, stated or slotted from the sides.
    slots_free: int | None = None
    slot_capacity: int | None = None
    children: list["BinRead"] = Field(default_factory=list)


class VolumeBudgetChild(BaseModel):
    """One location sitting directly inside another, and the cube it claims."""
    id: int
    code: str
    name: str | None = None
    bin_type: str | None = None
    #: None means nobody measured it — NOT zero, which would read as "takes no space".
    volume: Decimal | None = None
    is_active: bool = True


class VolumeBudget(BaseModel):
    """How much of a location's cube the locations inside it have already claimed.

    Served rather than worked out in the form: the sentence the screen shows and the
    rule the save enforces have to be the same arithmetic, or a form will happily
    accept a number the server then refuses.
    """
    location_id: int
    code: str
    name: str | None = None
    bin_type: str | None = None
    #: The location's own physical cube — stated, else worked out from its three sides.
    gross_volume: Decimal | None = None
    #: "stated" | "derived" | null, so a screen knows which number to send somebody to.
    volume_source: str | None = None
    children_volume: Decimal = Decimal("0")
    free_volume: Decimal | None = None
    child_count: int = 0
    unmeasured_children: int = 0
    headline: str
    detail: str
    children: list[VolumeBudgetChild] = []


class BinWrite(BaseModel):
    warehouse_id: int
    code: str = Field(min_length=1, max_length=50)
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None
    # A location's kind, off the storage-type master. `storage_type_id` is what the
    # form sends and what the service trusts; `bin_type` is the same row's code and is
    # accepted for callers (and older screens) that only know the code. Neither is
    # checked against a list in this file any more — see `storage_types.resolve`, which
    # is why a site can add a rung without a release.
    bin_type: str | None = None
    capacity_qty: Decimal | None = None
    # Leave blank and the cube is worked out from the three sides below, so a location
    # measured once needs nothing typed twice.
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    #: "This bay takes one euro-pallet, or four totes" — the gate no cube expresses.
    max_handling_units: int | None = Field(default=None, ge=1, le=100000)
    #: Void factor, 1-100. Blank means 100%: nobody has derated this location.
    fill_efficiency_pct: Decimal | None = Field(default=None, gt=0, le=100)
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool = False
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    storage_type_id: int | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    is_active: bool = True

    @field_validator("bin_type", mode="before")
    @classmethod
    def upper_code(cls, value):
        """Codes are upper case; whether this one EXISTS is the master's question, not
        a tuple's — the service asks it, so the answer can change without a release."""
        return value.strip().upper() or None if isinstance(value, str) else value

    @field_validator(
        "name", "description", "barcode", "floor_level", "shelf_level",
        "capacity_qty", "capacity_volume", "max_weight_capacity", "length_cm",
        "width_cm", "height_cm", "max_handling_units", "fill_efficiency_pct",
        "aisle_width_meters", "humidity_percentage", "target_temperature_celsius",
        "min_temperature_celsius", "max_temperature_celsius", "storage_type_id",
        mode="before",
    )
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value


class OccupancyLine(BaseModel):
    """One proposed movement, resolved into the handling units it actually is.

    `qty` is in the item's own UOM and `handling_units` is what that comes to in whole
    packs — `ceil(qty / pack_base_qty)`, because half a case still occupies a case's
    footprint. `volume` and `weight` are None when the pack has no box or no gross
    weight; the line is still listed so the screen can NAME what it could not count,
    rather than quietly leaving it out of a total that then reads as complete.
    """
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    qty: Decimal | None = None
    direction: str = "IN"
    #: The packaging unit this line was measured in.
    item_packaging_id: int | None = None
    pack_name: str | None = None
    pack_level: int | None = None
    pack_base_qty: Decimal | None = None
    pack_volume_cbm: Decimal | None = None
    pack_gross_weight_kg: Decimal | None = None
    handling_units: Decimal | None = None
    volume: Decimal | None = None
    weight: Decimal | None = None


class CapacityGate(BaseModel):
    """One of the four independent checks a location is put through.

    Every gate carries the same shape whether it measures a cube, a payload, a count or
    answers a plain yes/no, so a screen renders all four through one component and adds
    no arithmetic of its own. `detail` is a sentence written by
    `modules/warehouse/capacity.py`; a screen picks a colour from `status` and never
    writes the words.

    `key` is VOLUME, WEIGHT, FOOTPRINT or UNITS. The FOOTPRINT gate is a verdict rather
    than a fraction — a pallet either enters the bay or it does not — so its numeric
    fields are all None and only `status` and `detail` say anything.
    """
    key: str
    label: str
    unit: str | None = None
    status: str
    capacity: Decimal | None = None
    occupied: Decimal | None = None
    projected: Decimal | None = None
    free: Decimal | None = None
    over_by: Decimal | None = None
    pct: float | None = None
    detail: str
    #: The caveat under the bar — a derated capacity, an unweighed line, a container
    #: that may not be turned. None when there is nothing to add.
    note: str | None = None


class LocationOccupancy(BaseModel):
    """How full one storage location is, and what a proposed move would do to it.

    Served by `capacity.location_occupancy`, which owns the arithmetic and the wording
    both: `headline` and `detail` are sentences, not codes, so the putaway screen and
    the issue screen say the same thing about the same state.

    Space is measured in HANDLING UNITS, never in loose per-unit volume — the module
    docstring says at length why. A quantity is converted to whole packs and each pack
    carries its own outer box and gross weight, so the four `gates` below are the cube,
    the payload, whether one unit physically enters the location, and the discrete limit
    on how many it takes.

    `capacity_volume` is the USABLE cube: stated (or derived from the location's own
    sides) and then derated by its void factor. It is None when the location has none
    configured — not zero, which would read as "no room at all".
    """
    location_id: int
    location_code: str
    location_name: str | None = None
    bin_type: str | None = None
    is_pickable: bool
    #: How many locations this figure sums over — 1 for a bin, more for a rack.
    counts_locations: int

    capacity_volume: Decimal | None = None
    #: Before the void factor, so a screen can show what was derated from.
    stated_volume: Decimal | None = None
    fill_efficiency_pct: Decimal | None = None
    occupied_volume: Decimal
    free_volume: Decimal | None = None
    utilisation_pct: float | None = None
    projected_volume: Decimal | None = None
    projected_free_volume: Decimal | None = None
    projected_pct: float | None = None
    over_by: Decimal | None = None

    #: The whole verdict, gate by gate. Ordered as the storekeeper should read them.
    gates: list["CapacityGate"] = Field(default_factory=list)
    capacity_weight_kg: Decimal | None = None
    occupied_weight_kg: Decimal | None = None
    projected_weight_kg: Decimal | None = None
    capacity_units: int | None = None
    occupied_units: Decimal | None = None
    projected_units: Decimal | None = None
    location_length_cm: Decimal | None = None
    location_width_cm: Decimal | None = None
    location_height_cm: Decimal | None = None

    #: The honesty fields: stock whose item has no measured pack is counted in neither
    #: `occupied_volume` nor the bar, so the screen must say so.
    unmeasured_items: int = 0
    unmeasured_qty: Decimal | None = None
    measured_items: int = 0
    #: Proposed lines whose pack has no box, so they are not in `move_volume`.
    unmeasured_lines: int = 0
    is_partial: bool = False

    # The single-move fields. A document with several lines has no one item or pack, so
    # these stay None and the caller reads `lines` instead.
    item_id: int | None = None
    item_name: str | None = None
    qty: Decimal | None = None
    item_packaging_id: int | None = None
    pack_name: str | None = None
    pack_base_qty: Decimal | None = None
    pack_volume_cbm: Decimal | None = None
    pack_length_cm: Decimal | None = None
    pack_width_cm: Decimal | None = None
    pack_height_cm: Decimal | None = None
    pack_gross_weight_kg: Decimal | None = None
    direction: str = "IN"
    move_volume: Decimal | None = None
    move_weight: Decimal | None = None
    move_units: Decimal | None = None
    lines: list["OccupancyLine"] = Field(default_factory=list)

    status: str
    headline: str
    detail: str


class OccupancyMoveIn(BaseModel):
    """One line of a draft, as the screen has it so far."""
    location_id: int
    item_id: int
    qty: Decimal = Decimal("0")
    direction: str = "IN"
    #: Which rung of the item's ladder this quantity moves in. Blank falls back to the
    #: item's default putaway unit, which is what an issue or a transfer wants: the
    #: goods are already packed the way they are packed.
    item_packaging_id: int | None = None

    @field_validator("direction")
    @classmethod
    def known_direction(cls, value: str) -> str:
        value = (value or "IN").upper()
        if value not in ("IN", "OUT"):
            raise ValueError("direction must be IN or OUT")
        return value


class OccupancyPreviewIn(BaseModel):
    """A whole draft at once.

    Asked as one request rather than one per line because an issue commonly takes
    several lines out of the SAME bin, and the space that frees is their sum — netted
    on the server so no screen has to add volumes up and get it subtly wrong.
    """
    moves: list[OccupancyMoveIn] = Field(default_factory=list)


class LocationRead(_Read):
    id: int
    warehouse_id: int
    parent_location_id: int | None = None
    storage_type: str | None = None
    storage_type_id: int | None = None
    #: The kind's display name, and where this location sits in the building. Both are
    #: derived on the way out (`service.list_locations`) rather than stored: the floor
    #: plan draws the tree and names the rung, and neither answer may drift from the
    #: parent links it is drawn from.
    storage_type_name: str | None = None
    parent_code: str | None = None
    parent_name: str | None = None
    #: `F1 / F1-A1 / F1-A1-R1`, the walk down to this location, and how deep it is.
    path: str | None = None
    path_names: str | None = None
    level: int | None = None
    child_count: int = 0
    is_pickable: bool = False
    code: str
    name: str | None = None
    description: str | None = None
    barcode: str | None = None
    floor_level: int | None = None
    shelf_level: int | None = None
    capacity_weight: Decimal | None = None
    capacity_volume: Decimal | None = None
    max_weight_capacity: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    max_handling_units: int | None = None
    fill_efficiency_pct: Decimal | None = None
    aisle_width_meters: Decimal | None = None
    temperature_controlled: bool
    humidity_percentage: Decimal | None = None
    target_temperature_celsius: Decimal | None = None
    min_temperature_celsius: Decimal | None = None
    max_temperature_celsius: Decimal | None = None
    is_active: bool


class StorageTypeRead(_Read):
    """One kind of storage location — see `modules/warehouse/storage_types.py`."""
    id: int
    code: str | None = None
    name: str
    description: str | None = None
    sort_order: int = 0
    #: Is stock HELD in this kind, or is it structure you walk past on the way to one?
    is_pickable: bool = False
    #: A cold-chain kind: the location form asks for the temperature band.
    is_temperature_controlled: bool = False
    #: May a location of this kind stand at the root of a warehouse?
    allow_top_level: bool = False
    is_active: bool
    #: The kinds this one may sit inside. Ids drive the form; the codes and names are
    #: sent beside them so a list can say "inside Rack, Shelf" without a second fetch.
    parent_type_ids: list[int] = Field(default_factory=list)
    parent_type_codes: list[str] = Field(default_factory=list)
    parent_type_names: list[str] = Field(default_factory=list)
    #: How many storage locations are of this kind — what a deactivation would strand.
    location_count: int = 0


class StorageTypeWrite(BaseModel):
    code: str | None = Field(default=None, max_length=50)
    name: str = Field(min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=200)
    sort_order: int = Field(default=0, ge=0, le=10_000)
    is_pickable: bool = False
    is_temperature_controlled: bool = False
    allow_top_level: bool = False
    is_active: bool = True
    #: Which kinds a location of this kind may sit inside. Empty means "nothing holds
    #: it", which is only sane at the top of the building — hence `allow_top_level`.
    parent_type_ids: Annotated[list[int], ConfigEntries] = []

    @field_validator("code", "description", mode="before")
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value


# ---------------------------------------------------------------------------
# Inward
# ---------------------------------------------------------------------------

class ReceiptItemWrite(CombinationIn):
    """`accepted_qty` is what you are keeping; rejected and short are derived from
    it by the service, so they are not accepted here."""
    id: int | None = None
    po_item_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    # Display only, and ignored on the way in: the service always snapshots code, name
    # and unit from the masters when it writes a line. They are here so a form that is
    # PRE-FILLED from another document (a PO, or an incoming consignment) can show what
    # the item is — without them the source payload carried a bare item_id and every
    # line rendered as a placeholder with no name.
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: Decimal = Decimal("0")
    received_qty: Decimal = Decimal("0")
    accepted_qty: Decimal | None = None
    rate: Decimal | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    bin_id: int | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: Annotated[list[str], SerialList] | None = None
    imei_numbers: Annotated[list[str], SerialList] | None = None
    # Display only, like item_code above, and ignored on the way in — the service
    # reads tracking off the item master. Here so a PRE-FILLED line can render its
    # serial and IMEI cells instead of hiding the numbers it was handed.
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    # Packing (2026-10-08). `despatch_note_item_id` ties the line to the supplier's
    # despatch line, whose packing is DECLARED and fixed — the service copies it from
    # there, never from the client. `pack_breakdown` is what was COUNTED: the same
    # packs, each at most what was declared. With no despatch note the storekeeper
    # states the packing directly. Either way `received_qty` is the count's total.
    despatch_note_item_id: int | None = None
    pack_hierarchy_id: int | None = None
    pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None

    @field_validator("received_qty", "ordered_qty")
    @classmethod
    def _not_negative(cls, v: Decimal) -> Decimal:
        if v is not None and v < 0:
            raise ValueError("Quantity cannot be negative")
        return v


class ReceiptWrite(OrgScopeIn):
    receipt_type: ReceiptType = ReceiptType.PURCHASE
    grn_date: date
    po_id: int | None = None
    # A gate entry is typed from the driver's paperwork, which may name an order that
    # was never raised in this system, so the number is accepted as text. When `po_id`
    # is set the service snapshots the order's own number and ignores this.
    po_no: str | None = Field(default=None, max_length=50)
    # The vendor's despatch note this delivery arrived on, when they filed one. The
    # service copies its paperwork and per-line batch/expiry, so nothing here is taken
    # on trust from the client beyond the id.
    despatch_note_id: int | None = None
    transfer_id: int | None = None
    # The incoming consignment being inwarded, on a DISPATCH receipt. It is stored in
    # the same `transfer_id`/`transfer_no` pair the STO uses — `receipt_type` says
    # which document those columns point at, so one source reference serves both.
    dispatch_id: int | None = None
    vendor_id: int | None = None
    warehouse_id: int
    project_id: int | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: Decimal | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    gate_entry_no: str | None = None
    remarks: str | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list, max_length=MAX_DOCUMENT_LINES)

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: ReceiptWrite accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "items")
        return self


class ReceiptItemRead(CombinationOut, _Read):
    id: int
    receipt_id: int
    line_no: int
    po_item_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_asset: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    #: The item master's "Requires QI". Decides whether this line goes to QC or
    #: straight to putaway on submit.
    requires_qi: bool = False
    ordered_qty: Decimal
    received_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    short_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    batch_id: int
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    bin_id: int
    bin_code: str | None = None
    qc_status: str
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    despatch_note_item_id: int | None = None
    pack_hierarchy_id: int | None = None
    pack_hierarchy_name: str | None = None
    declared_pack_breakdown: list[dict] | None = None
    declared_pack_text: str | None = None
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None

    @model_validator(mode="after")
    def _describe_packing(self):
        if self.pack_breakdown and not self.pack_text:
            self.pack_text = describe_packs(self.pack_breakdown, self.uom_code)
        if self.declared_pack_breakdown and not self.declared_pack_text:
            self.declared_pack_text = describe_packs(self.declared_pack_breakdown, self.uom_code)
        if not getattr(self, "pack_hierarchy_name", None):
            for src in (self.pack_breakdown, self.declared_pack_breakdown):
                name = next((e.get("hierarchy") for e in src or []
                             if e.get("hierarchy")), None)
                if name:
                    self.pack_hierarchy_name = name
                    break
        return self


class ReceiptRead(OrgScopeOut, _Read):
    id: int
    grn_no: str
    receipt_type: str
    grn_date: date
    po_id: int | None = None
    po_no: str | None = None
    despatch_note_id: int | None = None
    despatch_note_no: str | None = None
    transfer_id: int | None = None
    transfer_no: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    vendor_gstin: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: Decimal | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    gate_entry_no: str | None = None
    gate_entry_at: datetime | None = None
    #: WHEN THE GOODS ARE EXPECTED, on a receipt raised before they arrive — today that
    #: is a supplier's replacement promise off a purchase return. Served here because
    #: writing the date and never showing it to the store would achieve nothing: this is
    #: the field that answers "what is due at my gate this week". Null on a receipt
    #: written AT the gate, which is describing goods already standing there, AND on a
    #: collection, where nothing is coming until somebody here sends a vehicle.
    expected_delivery: date | None = None
    #: SUPPLIER_DELIVERS or WE_COLLECT (`INBOUND_TRANSPORT_MODES`). The store acts
    #: differently on each — wait at the gate, or send a vehicle — so this is the field
    #: that decides which. Null on a receipt not raised in advance of the goods.
    inbound_transport_mode: str | None = None
    #: A collection's own two facts: where our vehicle goes, and when it may go.
    pickup_address: str | None = None
    goods_ready_date: date | None = None
    status: str
    total_items: int
    total_received_qty: Decimal
    total_accepted_qty: Decimal
    total_rejected_qty: Decimal
    total_value: Decimal
    is_stock_posted: bool
    posted_at: datetime | None = None
    received_by_id: int | None = None
    received_by_name: str | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ReceiptDetail(ReceiptRead):
    items: list[ReceiptItemRead] = Field(default_factory=list)


class ReceiptRouteLine(BaseModel):
    """One GRN line and where it goes. `route` is QC, PUTAWAY or STOCK (a point with
    no bins banks the goods directly)."""
    receipt_item_id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    received_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    requires_qi: bool = False
    route: str
    qc_status: str | None = None
    putaway_id: int | None = None
    putaway_no: str | None = None
    putaway_status: str | None = None


class ReceiptRouting(BaseModel):
    """`service.receipt_routing`. `stage` is FORECAST (not submitted yet), PARKED (the
    retired GRN approval held it with nothing raised) or ROUTED."""
    receipt_id: int
    grn_no: str
    status: str
    stage: str
    is_bin_managed: bool
    headline: str
    inspection_id: int | None = None
    inspection_no: str | None = None
    inspection_status: str | None = None
    putaway_total: int = 0
    putaway_done: int = 0
    qc_lines: list[ReceiptRouteLine] = Field(default_factory=list)
    direct_lines: list[ReceiptRouteLine] = Field(default_factory=list)


class PoLineOption(CombinationOut):
    """An open PO line, so the GRN form fills itself from the order."""
    po_item_id: int
    indent_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: Decimal
    received_qty: Decimal
    pending_qty: Decimal
    rate: Decimal | None = None
    # What the unit needs at the gate, off the item master (2026-10-21): without these
    # a prefilled line read as untracked and the serial/IMEI capture never appeared.
    is_asset: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    # How the ORDER asks for it to be packed — the starting point for a receipt that
    # has no despatch note to declare the packing.
    pack_hierarchy_id: int | None = None
    pack_hierarchy_name: str | None = None
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None

    @model_validator(mode="after")
    def _describe_packing(self):
        if self.pack_breakdown and not self.pack_text:
            self.pack_text = describe_packs(self.pack_breakdown, self.uom_code)
        if not getattr(self, "pack_hierarchy_name", None):
            for src in (self.pack_breakdown,):
                name = next((e.get("hierarchy") for e in src or []
                             if e.get("hierarchy")), None)
                if name:
                    self.pack_hierarchy_name = name
                    break
        return self


class IssueDestinationOption(BaseModel):
    """One stocking point a direct issue can be sent to, with what follows from it."""
    warehouse_id: int
    code: str | None = None
    name: str
    warehouse_type: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    sac: str | None = None
    vehicle_number: str | None = None


class IssueDestinationPage(BaseModel):
    items: list[IssueDestinationOption] = Field(default_factory=list)
    #: Matches before the cap, so the picker can say "keep typing".
    total: int = 0


class IssueEmployeeOption(BaseModel):
    """One person a direct issue can be issued to, with their office."""
    id: int
    code: str | None = None
    name: str
    #: The HCM position codes this person holds, primary post first.
    position_codes: list[str] = Field(default_factory=list)
    #: The primary post's role (or position name).
    position_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    department_name: str | None = None
    project_name: str | None = None


class IssueEmployeePage(BaseModel):
    items: list[IssueEmployeeOption] = Field(default_factory=list)
    total: int = 0


class PoPrefill(BaseModel):
    vendor_id: int | None = None
    vendor_name: str | None = None
    vendor_gstin: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    total_amount: float | None = None
    #: Only the lines with something still outstanding. A fully received line is not
    #: one to receive again — see `service.po_lines`.
    lines: list[PoLineOption] = Field(default_factory=list)
    #: The lines with NOTHING left — never prefilled, served so the form can name one a
    #: storekeeper adds by hand as already received, before Save rather than after.
    settled_lines: list[PoLineOption] = Field(default_factory=list)
    #: How many lines the order has altogether, so a screen can say "nothing left"
    #: rather than drawing an empty list and leaving the storekeeper to wonder whether
    #: the order was empty, the call failed, or the goods are already in.
    total_lines: int = 0
    #: The receipts already standing against this order, newest last.
    received_by: list[str] = Field(default_factory=list)


class TransferReceiptSource(BaseModel):
    transfer_id: int
    transfer_no: str
    warehouse_id: int
    project_id: int | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list)
    indent_id: int | None = None
    indent_no: str | None = None


class DispatchReceiptSource(BaseModel):
    """An incoming consignment, shaped so the inward form fills itself.

    `is_bin_managed` travels with it because it decides how much of the form the
    receiving point sees: an MDP or a LIP with no bins configured is never asked
    which shelf the goods went on.
    """
    dispatch_id: int
    dispatch_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    is_bin_managed: bool = False
    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    project_id: int | None = None
    dispatch_date: date | None = None
    lr_no: str | None = None
    vehicle_number: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    items: list[ReceiptItemWrite] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

class InspectionParameter(BaseModel):
    name: str
    expected: str | None = None
    observed: str | None = None
    result: str | None = None


class InspectionItemWrite(BaseModel):
    id: int | None = None
    receipt_item_id: int | None = None
    item_id: int
    batch_no: str | None = None
    inspected_qty: Decimal = Decimal("0")
    accepted_qty: Decimal = Decimal("0")
    #: How much was rejected (2026-11-13, SCM_0124). Sent, it lets a line be saved
    #: still being judged — accepted + rejected below inspected stays Pending
    #: (`service.qc_split`). Left out, the rest of the line is rejected, as before.
    rejected_qty: Decimal = Decimal("0")
    parameters: Annotated[list[InspectionParameter], ConfigEntries] | None = None
    result: InspectionResult = InspectionResult.PENDING
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: Annotated[list[str], SerialList] | None = None
    imei_numbers: Annotated[list[str], SerialList] | None = None
    # Decided by the PACK (2026-10-27): which of the GRN's counted packs were kept and
    # which rejected. Both or neither; they must add up to what was inspected.
    accepted_pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None
    rejected_pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None


class InspectionWrite(BaseModel):
    inspection_date: date
    receipt_id: int | None = None
    warehouse_id: int | None = None
    inspection_type: InspectionType = InspectionType.INCOMING
    inspector_id: int | None = None
    remarks: str | None = None
    items: Annotated[list[InspectionItemWrite], DocumentLines] = []

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: InspectionWrite accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "items")
        return self


class InspectionItemRead(CombinationOut, _Read):
    id: int
    inspection_id: int
    receipt_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    inspected_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    parameters: list[InspectionParameter] | None = None
    result: str
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    accepted_pack_breakdown: list[dict] | None = None
    rejected_pack_breakdown: list[dict] | None = None


class InspectionRead(OrgScopeOut, _Read):
    id: int
    inspection_no: str
    inspection_date: date
    receipt_id: int | None = None
    grn_no: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    inspection_type: str
    status: str
    total_items: int
    passed_items: int
    failed_items: int
    # SCM_0164 / 0165 / 0166: the same inspection by QUANTITY, derived on read
    # (`service.inspection_quantity_summary`), never stored. The three LINE counts above
    # put a partly rejected line in neither bucket; these are what a pass rate and a
    # "rejected" total are made of. None on a row nothing has summarised.
    inspected_qty: Decimal | None = None
    accepted_qty: Decimal | None = None
    rejected_qty: Decimal | None = None
    partial_items: int | None = None
    pending_items: int | None = None
    pass_rate: float | None = None
    inspector_id: int | None = None
    inspector_name: str | None = None
    remarks: str | None = None
    created_at: datetime | None = None


class InspectionDetail(InspectionRead):
    items: list[InspectionItemRead] = []


class OutboundInspectionItemWrite(BaseModel):
    id: int | None = None
    issue_item_id: int | None = None
    item_id: int
    batch_no: str | None = None
    inspected_qty: Decimal = Decimal("0")
    accepted_qty: Decimal = Decimal("0")
    #: See `InspectionItemWrite.rejected_qty` (SCM_0124).
    rejected_qty: Decimal = Decimal("0")
    parameters: Annotated[list[InspectionParameter], ConfigEntries] | None = None
    result: InspectionResult = InspectionResult.PENDING
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    serial_numbers: dict[str, list[str]] | list[str] | None = None
    #: Issued in packages (2026-10-26): units rejected out of each KEPT package,
    #: {code: qty}. A package rejected whole is simply left out of the accepted codes.
    pack_rejections: dict[str, float] | None = None

class OutboundInspectionWrite(BaseModel):
    inspection_date: date
    issue_id: int
    warehouse_id: int | None = None
    inspector_id: int | None = None
    remarks: str | None = None
    items: Annotated[list[OutboundInspectionItemWrite], DocumentLines] = []


class OutboundInspectionItemRead(CombinationOut, _Read):
    id: int
    inspection_id: int
    issue_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    inspected_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    parameters: list[InspectionParameter] | None = None
    result: str
    defect_type: str | None = None
    rejection_reason: str | None = None
    remarks: str | None = None
    # FIXED 2026-08-21 — a stored line can hold PER-UNIT rows
    # ({imei_no, serial_number, asset_code, consumable_code}), not just bare strings,
    # and this read model rejected them: GET /outbound-inspections/{id} answered 500
    # with ResponseValidationError on any inspection carrying them (id 6 is the live
    # proof, 32 occurrences in sys_app_logs). A read model must be able to render what
    # the column actually holds; the WRITE side still takes strings and is unchanged.
    serial_numbers: dict[str, list[str]] | list[str] | list[dict] | None = None
    pack_rejections: dict[str, float] | None = None
    # The packs this quantity travels in, read off the issue line (2026-10-22).
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None


class OutboundInspectionRead(_Read):
    id: int
    inspection_no: str
    inspection_date: date
    issue_id: int
    issue_no: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    status: str
    total_items: int
    passed_items: int
    failed_items: int
    # SCM_0164 / 0165 / 0166: the same inspection by QUANTITY, derived on read
    # (`service.inspection_quantity_summary`), never stored. The three LINE counts above
    # put a partly rejected line in neither bucket; these are what a pass rate and a
    # "rejected" total are made of. None on a row nothing has summarised.
    inspected_qty: Decimal | None = None
    accepted_qty: Decimal | None = None
    rejected_qty: Decimal | None = None
    partial_items: int | None = None
    pending_items: int | None = None
    pass_rate: float | None = None
    inspector_id: int | None = None
    inspector_name: str | None = None
    remarks: str | None = None
    # Only ever filled where a QC_OUTWARD ladder is configured.
    current_approver_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    created_at: datetime | None = None


class OutboundInspectionDetail(OutboundInspectionRead):
    items: list[OutboundInspectionItemRead] = []
    # Its issue executes a stock transfer, so it is worked on Inventory > Stock Transfer.
    is_stock_transfer: bool = False


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

class PutawayRead(OrgScopeOut, CombinationOut, _Read):
    """The task plus the labels the queue screen shows. The `*_name` fields are
    filled by the service from the masters, because `whs_warehouse_items` carries
    only ids — it is a work queue, not a document."""
    id: int
    putaway_no: str | None = None
    # Is a Storage container mapped for the item (2026-10-27)? Not: the screen warns.
    storage_defined: bool = False
    grn_id: int | None = None
    grn_no: str | None = None
    grn_item_id: int | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_id: int | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    qty: Decimal
    suggested_bin_id: int | None = None
    suggested_bin_code: str | None = None
    actual_bin_id: int | None = None
    actual_bin_code: str | None = None
    # Derived from the location tree, not stored — see service._ancestry.
    actual_bin_path: str | None = None
    # Stamped at confirm from the storage path; empty until the task is completed.
    lot_no: str | None = None
    putaway_type: str
    status: str
    assigned_to: int | None = None
    assigned_to_name: str | None = None
    scanned_by: int | None = None
    scanned_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    is_serial_tracked: bool = False
    is_asset: bool = False
    # WHICH pack this line is in, and what that comes to on a shelf. "3 cases" and
    # "1500 eaches" are the same `qty` and need entirely different space, so the task
    # carries the rung. None throughout means the item has no measured packaging unit —
    # said plainly rather than shown as zero, which would read as "takes no room".
    item_packaging_id: int | None = None
    package_id: int | None = None
    package_name: str | None = None
    pack_base_qty: Decimal | None = None
    pack_volume_cbm: Decimal | None = None
    pack_gross_weight_kg: Decimal | None = None
    handling_units: Decimal | None = None
    line_volume_cbm: Decimal | None = None
    line_weight_kg: Decimal | None = None
    #: Every rung this item could be put away in, so the screen can offer the choice
    #: without a second round trip.
    packs: list["HandlingUnit"] = Field(default_factory=list)
    # Packing (2026-10-08): the receipt's hierarchy (fixed), the packing arriving
    # from the receipt (what was counted at the gate) and, once confirmed, how it was
    # shelved. `pack_levels` is the hierarchy's ladder for the re-pack picker.
    pack_hierarchy_id: int | None = None
    pack_hierarchy_name: str | None = None
    received_pack_breakdown: list[dict] | None = None
    received_pack_text: str | None = None
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
    pack_levels: list[dict] = Field(default_factory=list)
    #: True when the item's codes are minted per pack: the shelved levels decide the
    #: smallest pack this stock can ever be split into without a break bulk.
    codes_per_pack: bool = False
    # Filled only on the response to `confirm`: what the shelf looked like at the
    # moment of the press, including an overflow if there was one. A full bin never
    # stops a putaway, so this is how the screen gets to say it happened.
    capacity: LocationOccupancy | None = None
    created_at: datetime | None = None


class PutawayUnitCode(_Read):
    """One printable identity minted by a putaway.

    `scope` says what the code names. UNIT is one physical thing off
    `whs_serial_numbers`; LOT is the whole balance row, which is all a continuous item
    can carry — 30 grams of cotton is one lot, not 30 things to label.

    `code` is what the QR carries and what is written under it. It is the asset or the
    consumable code, and falls back to the serial for an item whose code tracking is
    switched off — a label with nothing scannable on it is worse than no label.
    """
    id: int
    code: str
    #: ASSET | CONSUMABLE | SERIAL — which of the three the `code` above actually is.
    code_type: str
    #: UNIT | LOT.
    scope: str = "UNIT"
    serial_number: str | None = None
    imei: str | None = None
    status: str | None = None


class PutawayCodes(BaseModel):
    """The label sheet's HEADER: what a putaway minted, how many, and what it names.

    A separate call from `PutawayRead` on purpose: a task carries one line, but a line
    of 500 units carries 500 codes and the queue screen has no use for them. And this
    call carries no codes either — only `total_codes` — because opening the panel must
    not depend on how big the lorry was. The codes come a page at a time from
    `GET /putaways/{id}/codes/units`.

    Which units belong to a putaway is answered by its `lot_no`: the lot is stamped at
    confirm from the storage path and belongs to exactly one putaway, so it is the one
    key that separates this placement's units from the same item's units placed into
    the same bin yesterday.

    `reason` is filled when there are none and explains WHY in the same voice the rest
    of the module answers "why can I not do this" — an empty sheet with nothing said
    reads as a defect in the screen.
    """
    putaway_id: int
    putaway_no: str | None = None
    status: str
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    #: Warranty end for an asset, expiry for anything else — the screen labels it off
    #: `is_asset`, exactly as the task meta does.
    expiry_date: date | None = None
    is_asset: bool = False
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    bin_id: int | None = None
    bin_code: str | None = None
    #: `block A / flr-1 / lane-1 / rack-1 / bin A1` — the whole storage path, so a
    #: label says where the goods came to rest and not just a bin code.
    bin_path: str | None = None
    lot_no: str | None = None
    qty: Decimal | None = None
    completed_at: datetime | None = None
    #: Whether the item master's asset/consumable code toggle is on for this item.
    is_code_tracked: bool = True
    #: ASSET | CONSUMABLE, the kind this item mints. None when nothing was minted.
    code_type: str | None = None
    #: How many codes this putaway minted. A count, so the panel can say "500 codes"
    #: and size its pager without pulling five hundred rows to find out.
    total_codes: int = 0
    reason: str | None = None


class PutawayCreate(BaseModel):
    """Raise putaway tasks by hand, always against GRN lines.

    A task is normally raised by QC passing a line. This is the repair path, so it
    still points at the receipt it came from: a putaway with no GRN line behind it
    would put stock into a bin that nothing ever received. An empty `grn_item_ids`
    means every eligible line on the GRN.
    """
    grn_id: int
    grn_item_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)


class PutawayCandidate(BaseModel):
    """A GRN line offered to the manual putaway picker. Ineligible lines are returned
    too, carrying the reason — the screen shows them greyed out rather than hiding
    them, so "why is this one not here" never has to be asked."""
    grn_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    accepted_qty: Decimal
    qc_status: str | None = None
    existing_putaway_no: str | None = None
    eligible: bool
    reason: str | None = None


class HandlingUnit(BaseModel):
    """One packaging unit an item can move in — a rung of its ladder, resolved.

    Served by `capacity.handling_units` rather than assembled in the screen, so the
    volume on the picker is the volume the bin check will use. `dims_from` says whether
    the box came from this rung (RUNG) or was inherited from the container type
    (PACKAGE), because a storekeeper comparing two items deserves to know which.
    """
    item_packaging_id: int | None = None
    item_id: int | None = None
    level: int
    package_id: int | None = None
    package_name: str | None = None
    #: How many base units ONE of these holds — the conversion factor, multiplied up
    #: through every rung below it.
    base_qty: Decimal | None = None
    uom_code: str | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    volume_cbm: Decimal | None = None
    gross_weight_kg: Decimal | None = None
    tare_weight_kg: Decimal | None = None
    max_stack_tiers: int | None = None
    is_rotatable: bool | None = None
    fill_efficiency_pct: Decimal | None = None
    is_default: bool = False
    is_measured: bool = False
    dims_from: str | None = None


class PutawayConfirm(BaseModel):
    actual_bin_id: int
    qty: Decimal | None = None
    #: The rung being put away. Blank falls back to whatever the task was raised with,
    #: and then to the item's default putaway unit — so an untouched screen still
    #: measures the load rather than refusing to.
    item_packaging_id: int | None = None
    remarks: str | None = None
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    # How the goods are shelved (2026-10-08). The hierarchy is the receipt's and is
    # fixed; the levels may change — a carton opened into its boxes, loose strips
    # boxed. Must add up to `qty`. One `whs_handling_units` row is made per pack.
    pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None


class StockMovementWrite(CombinationIn):
    movement_type: str = Field(default="BIN_TO_BIN", max_length=30)
    warehouse_id: int
    source_bin_id: int
    destination_bin_id: int
    item_id: int
    batch_id: int | None = None
    quantity: Decimal = Field(gt=0)
    serial_numbers: Annotated[list[str], SerialList] | None = None
    imei_numbers: Annotated[list[str], SerialList] | None = None
    remarks: str | None = Field(default=None, max_length=500)


class StockMovementRead(BaseModel):
    movement_no: str
    movement_type: str
    warehouse_id: int
    warehouse_name: str | None = None
    source_bin_id: int
    source_bin_code: str | None = None
    destination_bin_id: int
    destination_bin_code: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    quantity: Decimal
    serial_numbers: list[str] = Field(default_factory=list)
    status: str = "COMPLETED"
    moved_by_name: str | None = None
    moved_at: datetime | None = None
    remarks: str | None = None


class StockAvailabilityRead(BaseModel):
    """One movement line's source, and how its units must be named.

    `units_required`, `unit_mode` and `tracking_type` are read off the item master
    (see `service._movement_units`), so a screen never decides for itself whether an
    item is serial, IMEI, asset or consumable tracked. `units_available` is bounded:
    with `units_capped` it means "at least this many".
    """
    available_qty: Decimal = Decimal("0")
    serial_numbers: list[str] = Field(default_factory=list)
    is_serial_tracked: bool = False
    units_required: bool = False
    unit_mode: str | None = None
    tracking_type: str | None = None
    units_available: int | None = None
    units_capped: bool = False
    bin_code: str | None = None
    bin_path: str | None = None
    batch_no: str | None = None


class StockMovementOrderItemWrite(CombinationIn):
    item_id: int
    source_bin_id: int
    destination_bin_id: int
    quantity: Decimal = Field(gt=0)
    batch_id: int | None = None
    serial_numbers: Annotated[list[str], SerialList] | None = None

    @model_validator(mode='after')
    def check_bins(self):
        if self.source_bin_id == self.destination_bin_id:
            raise ValueError("Source location and destination location must not be the same")
        return self


class StockMovementOrderWrite(OrgScopeIn):
    warehouse_id: int
    reason: str | None = Field(default=None, max_length=500)
    items: list[StockMovementOrderItemWrite] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: StockMovementOrderWrite accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "items")
        return self


class StockMovementOrderItemRead(BaseModel):
    """One line of a movement, read back off the ledger rows it wrote.

    No `id`: there is no line table. The document is its `order_no`, carried on every
    `stk_ledger` row the line produced.
    """
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    source_bin_id: int
    source_bin_code: str | None = None
    destination_bin_id: int
    destination_bin_code: str | None = None
    quantity: Decimal
    batch_id: int | None = None
    batch_no: str | None = None
    serial_numbers: list[str] | str | None = Field(default_factory=list)

    @field_validator("serial_numbers", mode="before")
    @classmethod
    def parse_serials(cls, v):
        if not v:
            return []
        if isinstance(v, str):
            return v.split(",")
        return v



class StockMovementOrderRead(BaseModel):
    """A movement document. `order_no` is its identity — see the item schema above.

    The list endpoint groups the ledger by `order_no` and cannot cheaply rebuild every
    line, so `items` is empty there and populated on create.
    """
    order_no: str
    #: 0 only for movements completed before orders were stored — those have ledger
    #: rows and no document row. Every order raised since carries a non-zero
    #: `inv_sto` row moving DRAFT → PENDING_APPROVAL → APPROVED → COMPLETED.
    id: int = 0
    warehouse_id: int
    warehouse_name: str | None = None
    status: str
    #: Who it is waiting on, and on which rung — "Mahendra Kumar (Warehouse Manager)".
    current_approver_name: str | None = None
    reason: str | None = None
    total_lines: int = 0
    created_by_name: str | None = None
    created_at: datetime | None = None
    items: list[StockMovementOrderItemRead] = Field(default_factory=list)

# ---------------------------------------------------------------------------
# Picking
# ---------------------------------------------------------------------------

class PickingItemWrite(BaseModel):
    item_id: int
    bin_id: int | None = None
    batch_id: int | None = None
    required_qty: Decimal


class PickingWrite(BaseModel):
    pick_date: date
    warehouse_id: int
    ref_type: str | None = None
    ref_id: int | None = None
    strategy: PickStrategy = PickStrategy.FEFO
    assigned_to_id: int | None = None
    items: Annotated[list[PickingItemWrite], DocumentLines] = []


class PickLine(BaseModel):
    picked_qty: Decimal
    bin_id: int | None = None


class PickingItemRead(_Read):
    id: int
    picking_id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    required_qty: Decimal
    picked_qty: Decimal
    status: str
    picked_by_id: int | None = None
    picked_at: datetime | None = None


class PickingRead(_Read):
    id: int
    pick_no: str
    pick_date: date
    warehouse_id: int
    warehouse_name: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    ref_no: str | None = None
    strategy: str | None = None
    status: str
    total_lines: int
    picked_lines: int
    assigned_to_id: int | None = None
    assigned_to_name: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None


class PickingDetail(PickingRead):
    items: list[PickingItemRead] = []


# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------

class IssueItemWrite(CombinationIn):
    id: int | None = None
    indent_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    bin_code: str | None = None
    bin_path: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    requested_qty: Decimal
    issued_qty: Decimal | None = None
    rate: Decimal | None = None
    remarks: str | None = None
    serial_numbers: Annotated[list[str], SerialList] | None = None
    imei_numbers: Annotated[list[str], SerialList] | None = None
    # Issue in packs (2026-10-08): "2 Box + 5 Strip". When given, the issue quantity
    # is its total — the server works it out. `break_bulk` opens a coded pack to give
    # part of it, and needs `issue.break_bulk`.
    pack_hierarchy_id: int | None = None
    pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None
    break_bulk: bool = False


class IssueWrite(OrgScopeIn):
    issue_type: IssueType = IssueType.DIRECT
    issue_date: date
    indent_id: int | None = None
    picking_id: int | None = None
    warehouse_id: int
    department_id: int | None = None
    project_id: int | None = None
    vehicle_id: int | None = None
    # Typed, not picked: transport owns `trn_vehicles` and most site deliveries go on
    # a vehicle nobody registered there. Without this the number the store typed was
    # dropped on the way in and the column was written from `vehicle_id` alone.
    vehicle_number: str | None = Field(default=None, max_length=50)
    issued_to_id: int | None = None
    # The stocking point chosen as the destination (any LIP / MDP / warehouse but the
    # origin). Optional — without it the destination is derived as before.
    destination_warehouse_id: int | None = None
    direction: IssueDirection = IssueDirection.OUT
    original_issue_id: int | None = None
    remarks: str | None = None
    items: Annotated[list[IssueItemWrite], DocumentLines] = []

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: IssueWrite accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "items")
        return self


class IssueItemRead(CombinationOut, _Read):
    #: On a SPLIT parent (2026-11-11): the floor piece and line that carry this line now.
    #: Its serials are listed and saved against that piece line.
    piece_issue_id: int | None = None
    piece_issue_no: str | None = None
    piece_line_id: int | None = None
    piece_is_posted: bool = False
    id: int
    issue_id: int
    line_no: int
    indent_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    # How many decimal places this line's unit allows — 0 for a whole-unit UOM.
    # Set by `get_issue`, never a column; an ORM row read with no decoration
    # (a listing, say) keeps the safe `None` default rather than a wrong 0.
    qty_decimals: int | None = None
    is_serial_tracked: bool = False
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    requested_qty: Decimal
    issued_qty: Decimal
    returned_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    remarks: str | None = None
    is_imei_tracked: bool = False
    serial_numbers: list[str] | None = None
    imei_numbers: list[str] | None = None
    # Which identifier names one unit of this item — SERIAL, IMEI or CODE. The screen
    # validates on this one and shows the rest of the matched unit beside it.
    unit_mode: str | None = None
    # What KIND of identifier that is, for the badge on the row: SERIAL, IMEI, ASSET,
    # CONSUMABLE or NONE. Wider than `unit_mode` on purpose — an asset tag and a
    # consumable lot code are one column to the matcher and two different labels on
    # the goods. See `enums.TrackingType`.
    tracking_type: str | None = None
    # The reserved units, stated in that same currency.
    unit_keys: list[str] | None = None
    #: How many identifiers the line must name (2026-10-24). One per unit, except for
    #: an item issued in a container: one per container (a box), whatever the lot's
    #: older per-unit codes say. None = one per unit.
    codes_needed: int | None = None
    #: Issued in a container (2026-10-26): the line names boxes; each box it holds
    #: (code, how much of it the line takes, what it holds, part or whole) and — when
    #: the Issue container changed after they were held — the sentence that says so.
    issue_in_boxes: bool = False
    box_codes: list[dict] | None = None
    container_note: str | None = None
    # Whether this item has identified units in stock at all, so a bulk consumable
    # line does not offer a picker with nothing in it.
    has_units: bool = False
    # How many units this line's OWN batch and bin can still give it, counting the
    # ones it already holds out. Served so the screen and the approver can see a line
    # that could never be posted while the batch is still editable — after approval
    # the batch is frozen. See `_issue_unit_supply`.
    units_available: int | None = None
    # The item's `requires_qi`: does this line go on the outward QC sheet. A line that
    # does not goes to logistics at its issued quantity — see `post_issue`.
    requires_qc: bool = False
    # Packing (2026-10-08).
    pack_hierarchy_id: int | None = None
    pack_hierarchy_name: str | None = None
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
    break_bulk: bool = False

    @model_validator(mode="after")
    def _describe_packing(self):
        if self.pack_breakdown and not self.pack_text:
            self.pack_text = describe_packs(self.pack_breakdown, self.uom_code)
        if not getattr(self, "pack_hierarchy_name", None):
            for src in (self.pack_breakdown,):
                name = next((e.get("hierarchy") for e in src or []
                             if e.get("hierarchy")), None)
                if name:
                    self.pack_hierarchy_name = name
                    break
        return self


class UnitSupplyPick(BaseModel):
    """One (item, batch, storage location) a screen is asking about, and how many
    identified units it needs there."""
    item_id: int
    batch_id: int | None = None
    bin_id: int | None = None
    #: How many units this pick issues. The probe stops one past it — see
    #: `service.issue_unit_supply` — so a bigger `need` costs a bigger count.
    need: int = 0
    #: The saved issue line, when the pick has one. Units this line already holds are
    #: available TO IT, and without the id they read as somebody else's claim.
    line_id: int | None = None


class UnitSupplyQuery(BaseModel):
    """Ask what a set of picks could name, in one round trip.

    One request for the whole grid rather than one per row: a fifty-line issue
    re-probing on every batch change is fifty calls a keystroke apart otherwise.
    """
    warehouse_id: int
    picks: Annotated[list[UnitSupplyPick], DocumentLines] = []
    issue_id: int | None = None
    direction: str = "OUT"


class UnitSupplyRead(_Read):
    """What one pick could name. `available` is `null` when there is no answer — the
    item carries no identified units at this warehouse at all, or the quantity is past the probe
    ceiling — which is NOT the same as zero, and a screen must not draw it as a
    shortfall."""
    item_id: int
    batch_id: int | None = None
    bin_id: int | None = None
    need: int = 0
    #: Whether this item has any identified units at this warehouse at all.
    has_units: bool = False
    #: Counted only as far as `need + 1`, so a figure equal to that means "at least".
    available: int | None = None
    #: Fallback pools for the same pick: same batch anywhere at this point, and any
    #: batch at this point. The picker names them "Same batch, other bay" and
    #: "Any batch here" so a stranded pick still finds its codes.
    batch_available: int | None = None
    point_available: int | None = None


class SerialScopeCounts(BaseModel):
    """How many codable units each widening circle holds.

    exact: the bay + batch named. batch: the batch anywhere at this point.
    point: the item anywhere at this point. Bounded to `need + 1` each, so a
    figure equal to that means "at least".
    """
    item_id: int
    exact: int | None = None
    batch: int | None = None
    point: int | None = None
    has_units: bool = False


class IssueStockSourceFetchIn(BaseModel):
    warehouse_id: int
    item_ids: list[int]
    indent_id: int | None = None
    # Lots held for this project are offered as the document's own.
    project_id: int | None = None
    #: The issue being edited, so its own picks are not counted as pinned by "another" (and a direct issue's own hold is stock it may draw).
    issue_id: int | None = None


class BoxSourceRead(BaseModel):
    """One box an issue line could name (2026-10-26): its code, what it holds, and
    who holds it — this issue, another one, or nobody."""
    id: int
    code: str
    pack_name: str | None = None
    holds: float
    size: float
    part: bool = False
    batch_no: str | None = None
    bin_code: str | None = None
    held_by_this_issue: bool = False
    held_by: str | None = None
    # The pack it sits in — the carton the picker groups it under (2026-10-27) — its
    # own level, and on request the serials / IMEIs / codes inside it.
    level: int | None = None
    parent_id: int | None = None
    parent_code: str | None = None
    parent_pack_name: str | None = None
    parent_holds: float | None = None
    parent_size: float | None = None
    units: list[str] | None = None
    # Every pack around it, outermost first: [{code, name, level}] (2026-10-28).
    path: list[dict] = Field(default_factory=list)


class BoxLabelRead(_Read):
    """A queued (or printed) label for one box code (2026-10-26)."""
    id: int
    handling_unit_id: int
    hu_code: str
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    bin_code: str | None = None
    batch_no: str | None = None
    pack_name: str | None = None
    content_qty: Decimal
    pack_size: Decimal
    uom_code: str | None = None
    reason: str
    source_no: str | None = None
    status: str
    printed_at: datetime | None = None
    printed_by_name: str | None = None
    created_at: datetime | None = None
    # Where the label sits in the carton → box tree, and what its sticker prints
    # (2026-10-27). `qr_token` opens live, read-only details on any phone.
    parent_code: str | None = None
    depth: int = 0
    root_id: int | None = None
    level: int | None = None
    packs_inside: str | None = None
    expiry_date: date | None = None
    brand_name: str | None = None
    variant_name: str | None = None
    model_name: str | None = None
    qr_token: str | None = None


class BoxLabelPrintedIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=MAX_BATCH_IDS)


class DocLabelRow(BaseModel):
    """One sticker for a posted issue or an acknowledged receipt (2026-10-28):
    a PACK (carton, box, strip — parent first, `depth` under it) or a UNIT (an asset /
    consumable code, or — for a serial / IMEI tracked item — its serial or IMEI,
    2026-11-02)."""
    key: str
    kind: str
    code: str
    serial_number: str | None = None
    imei: str | None = None
    line_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    pack_name: str | None = None
    qty: float
    pack_size: float
    part: bool = False
    batch_no: str | None = None
    expiry_date: date | None = None
    brand_name: str | None = None
    variant_name: str | None = None
    model_name: str | None = None
    depth: int = 0
    parent_code: str | None = None
    packs_inside: str | None = None
    qr_token: str | None = None
    # The Box-label queue row still waiting for this pack, ticked off when printed here.
    label_id: int | None = None
    # A part pack cut by this issue at posting.
    new_here: bool = False
    # The packs around it, outermost first: [{code, name}] (2026-10-28).
    path: list[dict] = Field(default_factory=list)
    # A parent label (a carton, an opened box) printed on top for context, not a pack
    # that left; and whether this row is a pack the line itself issued.
    context: bool = False
    issued: bool = False


class DocLabelLine(BaseModel):
    line_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    qty: float
    brand_name: str | None = None
    variant_name: str | None = None
    model_name: str | None = None
    batch_no: str | None = None
    packs: int = 0
    inner_packs: int = 0
    units: int = 0


class DocLabels(BaseModel):
    document_type: str
    document_id: int
    document_no: str
    document_date: date | None = None
    from_name: str | None = None
    to_name: str | None = None
    lines: list[DocLabelLine]
    labels: list[DocLabelRow]


class DocLabelsPrintedIn(BaseModel):
    """What was printed: the queued Box labels it covers, and how many stickers."""
    label_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)
    printed: int = Field(ge=0, le=100_000)
    reprint: bool = False


class IssueStockSource(CombinationOut, _Read):
    """One (batch, bin) an issue line can draw from, with what it holds.

    The unit of the split: a quantity larger than any single source is spread over
    several of these, one issue line each, instead of being written against a bin
    that cannot serve it.
    """
    item_id: int
    bin_id: int | None = None
    bin_code: str | None = None
    bin_name: str | None = None
    # The whole walk down to it. A bin code is not a location a person can find: the
    # picker has to be able to say Ground Floor / Aisle 1 / Rack 1 / Bin 2.
    bin_path: str | None = None
    bin_steps: list[LocationStep] = []
    batch_id: int | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    mfg_date: date | None = None
    # Four numbers, not one. `available_qty` is what is free to ANYBODY, and on an
    # approved allocation that is routinely zero over stock the issuing document has
    # itself reserved — reporting it alone told a storekeeper his correct document was
    # impossible. `drawable_qty` is what this line may actually take.
    available_qty: Decimal
    reserved_qty: Decimal = Decimal("0")
    own_reserved_qty: Decimal = Decimal("0")
    #: Set aside for OTHER indents here, tradeable on save (holds float between batches).
    other_indent_qty: Decimal = Decimal("0")
    # What THIS direct issue reserved for itself on save (ISSUE_HOLD). Drawable by it,
    # but not an allocation.
    issue_hold_qty: Decimal = Decimal("0")
    total_qty: Decimal = Decimal("0")
    drawable_qty: Decimal
    # The two OUTER quantities this location's numbers sit inside: what the whole
    # batch holds in this warehouse, and what the item holds altogether. Denormalised
    # onto every row of the item — they cannot be summed out of the list, because a
    # location another document has entirely reserved is not in it. See
    # `service.issue_stock_sources`.
    batch_total_qty: Decimal = Decimal("0")
    batch_available_qty: Decimal = Decimal("0")
    item_total_qty: Decimal = Decimal("0")
    item_available_qty: Decimal = Decimal("0")
    # Must this item leave with one serial / IMEI / code per unit, and does this spot
    # hold any free coded unit? Drives the one FEFO swap past the same-day rule.
    codes_required: bool = False
    has_unit_codes: bool = False


class TrackingTypeRead(_Read):
    """The badge catalogue — see `enums.TRACKING_META`."""
    code: str
    label: str
    unit: str
    hint: str


class IssueRead(OrgScopeOut, _Read):
    id: int
    issue_no: str
    issue_type: str
    issue_date: date
    indent_id: int | None = None
    indent_no: str | None = None
    indent_type: str | None = None
    picking_id: int | None = None
    pick_no: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    issued_to_id: int | None = None
    issued_to_name: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    destination_office_sac: str | None = None
    destination_warehouse_id: int | None = None
    destination_warehouse_name: str | None = None
    #: MAIN / MDP / LIP of the chosen destination point, for its badge.
    destination_warehouse_type: str | None = None
    #: Whether the destination runs a vehicle and carries an SAC — an LIP only. None
    #: when the point is unknown (the screen then keeps both rows).
    destination_needs_vehicle_and_sac: bool | None = None
    #: The Stock Transfer Order this issue executes (2026-10-29). `sto_kind` is DIRECT
    #: for an order raised on its own, STR for the one an STR's allocation produced.
    #: The destination of such an issue is the order's and is frozen on it.
    sto_id: int | None = None
    sto_no: str | None = None
    sto_status: str | None = None
    sto_kind: str | None = None
    sto_str_no: str | None = None
    sto_from_warehouse_name: str | None = None
    sto_to_warehouse_id: int | None = None
    sto_to_warehouse_name: str | None = None
    direction: str
    original_issue_id: int | None = None
    original_issue_no: str | None = None
    # Set on a CHILD of a split. The parent stays generic and carries neither, which is
    # how a screen tells the two apart without asking a second question.
    parent_issue_id: int | None = None
    parent_issue_no: str | None = None
    floor_location_id: int | None = None
    floor_location_name: str | None = None
    # Who holds that floor — the floor in-charge(s) this piece was handed to.
    floor_in_charge_names: list[str] = []
    status: str
    #: What the status pill says. Same as `status` except a split parent CLOSED after
    #: its floor issues posted, which reads ISSUED (`_decorate_indent_types`).
    display_status: str | None = None
    total_items: int
    total_qty: Decimal
    total_value: Decimal
    is_stock_posted: bool
    posted_at: datetime | None = None
    current_approver_name: str | None = None
    # Who the document is with RIGHT NOW: the raiser on a draft, the approver while in
    # approval, the person who issues it from stock once approved. None once posted.
    currently_with: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None
    issued_by_id: int | None = None
    issued_by_name: str | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class IssueDetail(IssueRead):
    items: list[IssueItemRead] = []
    # Executes a stock transfer (STO / STR) — its QC is worked on Inventory > Stock Transfer.
    is_stock_transfer: bool = False
    # True only for the person the document is waiting on RIGHT NOW. Holding the
    # permission is not enough: every warehouse post shares one HCM rank, so all
    # eleven of them hold `issue.issue` and a permission-gated button appeared for
    # all eleven on a document only one of them could act on.
    can_approve: bool = False
    # True only for the person an approved issue is with, or someone above them on the
    # HCM reporting line. `post_issue` and `set_issue_serials` enforce the same rule.
    can_issue_from_stock: bool = False
    #: A SPLIT parent whose floor pieces this login may issue all at once.
    can_issue_split: bool = False
    # Swap auto-assigned asset/consumable codes: the issuer, or anyone who approved it.
    can_swap_codes: bool = False
    # Whoever submitted it for approval (the workflow's starter), shown as "Submitted
    # by" until stock is posted and `issued_by_name` is stamped.
    submitted_by_name: str | None = None
    # False until the indent raiser has confirmed this issue's quantities in My
    # Deliveries. The sending store must not be able to certify its own delivery.
    can_acknowledge: bool = False
    # On a split PARENT: the floor issues carrying its goods, newest status each. Its
    # own status is rolled up from these, so the screen shows what it is waiting on.
    child_issues: list["IssueChildRead"] = []


class IssueChildRead(BaseModel):
    """One floor issue of a split — on a parent its children, on a child its siblings."""
    id: int
    issue_no: str
    status: str
    floor_location_id: int | None = None
    floor_location_name: str | None = None
    is_stock_posted: bool = False
    total_qty: Decimal = Decimal(0)
    total_items: int = 0
    in_charge_names: list[str] = []


IssueDetail.model_rebuild()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

class DispatchItemWrite(CombinationIn):
    id: int | None = None
    package_id: int | None = None
    issue_id: int | None = None
    issue_no: str | None = None
    # The issue LINE, so one batch drawn from two bays stays two rows. See
    # `out_dispatch_items.issue_item_id`.
    issue_item_id: int | None = None
    bin_code: str | None = None
    mr_id: int | None = None
    mr_no: str | None = None
    indent_id: int | None = None
    item_id: int
    batch_id: int | None = None
    serial_no: str | None = None
    quantity: Decimal
    rate: Decimal | None = None
    remarks: str | None = None


class DispatchWrite(BaseModel):
    dispatch_type: DispatchType = DispatchType.TRANSFER
    dispatch_date: date
    warehouse_id: int
    to_warehouse_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    project_id: int | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    transport_mode: str | None = None
    carrier_id: int | None = None
    vehicle_id: int | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    expected_delivery: date | None = None
    remarks: str | None = None
    items: Annotated[list[DispatchItemWrite], DocumentLines] = []


class PackageWrite(BaseModel):
    package_no: str | None = Field(default=None, max_length=50)
    package_type: str | None = None
    barcode: str | None = Field(default=None, max_length=100)
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False
    item_ids: Annotated[list[int], BatchIds] = []


class ConsignmentPackageItemWrite(BaseModel):
    issue_id: int | None = None
    issue_no: str | None = None
    issue_item_id: int | None = None
    mr_id: int | None = None
    mr_no: str | None = None
    indent_id: int | None = None
    item_id: int
    batch_id: int | None = None
    serial_no: str | None = None
    serial_numbers: Annotated[list[str], SerialList] = []
    quantity: Decimal
    rate: Decimal | None = None
    remarks: str | None = None
    # How THIS carton holds the line, when the packer changed it (2026-10-22). Blank:
    # worked out for this quantity in the issue line's hierarchy. Must add up.
    pack_hierarchy_id: int | None = None
    pack_breakdown: Annotated[list[PackEntryIn], PACK_ENTRIES] | None = None


class ConsignmentPackageWrite(BaseModel):
    package_no: str | None = Field(default=None, max_length=50)
    package_type: str | None = Field(default="BOX", max_length=30)
    barcode: str | None = Field(default=None, max_length=100)
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False
    items: Annotated[list[ConsignmentPackageItemWrite], DocumentLines] = []

    @field_validator("package_no", "package_type", "barcode", mode="before")
    @classmethod
    def blank_to_none(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: ConsignmentPackageWrite accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "items")
        return self


class ConsignmentWrite(BaseModel):
    issue_id: int = 0
    issue_ids: Annotated[list[int], BatchIds] = []
    dispatch_type: DispatchType = DispatchType.TRANSFER
    dispatch_date: date
    to_warehouse_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    project_id: int | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    transport_mode: str | None = "ROAD"
    carrier_id: int | None = None
    vehicle_id: int | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    expected_delivery: date | None = None
    remarks: str | None = None
    packages: Annotated[list[ConsignmentPackageWrite], DocumentLines] = []


class DispatchEventWrite(BaseModel):
    event_type: DispatchEventType
    location_name: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    temperature_c: Decimal | None = None
    humidity_percent: Decimal | None = None
    notes: str | None = None


class AcknowledgeLine(BaseModel):
    id: int
    delivered_qty: Decimal


class AcknowledgeWrite(BaseModel):
    acknowledged_by_name: str | None = None
    pod_url: str | None = None
    remarks: str | None = None
    lines: Annotated[list[AcknowledgeLine], DocumentLines] = []


class DispatchItemRead(CombinationOut, _Read):
    id: int
    dispatch_id: int
    line_no: int
    package_id: int | None = None
    # The package (box / strip) this row carries, for an item issued in packages.
    box_code: str | None = None
    issue_id: int | None = None
    issue_no: str | None = None
    issue_item_id: int | None = None
    mr_id: int | None = None
    mr_no: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    bin_code: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    serial_no: str | None = None
    imei_no: str | None = None
    quantity: Decimal
    delivered_qty: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    remarks: str | None = None


class DispatchLinePacks(BaseModel):
    """One issue line's packs on a consignment — sent, and arrived (2026-10-22)."""
    issue_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    quantity: Decimal
    delivered_qty: Decimal = Decimal("0")
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
    delivered_pack_breakdown: list[dict] | None = None
    delivered_pack_text: str | None = None


class DispatchPackageRead(_Read):
    id: int
    dispatch_id: int
    package_no: str
    package_type: str | None = None
    barcode: str | None = None
    weight_kg: Decimal | None = None
    length_cm: Decimal | None = None
    width_cm: Decimal | None = None
    height_cm: Decimal | None = None
    is_fragile: bool
    is_temp_controlled: bool
    status: str
    packed_by_name: str | None = None
    packed_at: datetime | None = None
    public_scan_token: str | None = None
    #: The packs this carton holds, per issue line (2026-10-22).
    item_packs: list[dict] | None = None


class DispatchEventRead(_Read):
    id: int
    dispatch_id: int
    event_type: str
    event_at: datetime
    location_name: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    temperature_c: Decimal | None = None
    humidity_percent: Decimal | None = None
    is_breach: bool
    notes: str | None = None
    recorded_by_id: int | None = None
    recorded_by_name: str | None = None


class DispatchSourceRead(_Read):
    id: int
    dispatch_id: int
    source_type: str
    source_id: int
    source_no: str | None = None
    issue_id: int | None = None
    issue_no: str | None = None
    mr_id: int | None = None
    mr_no: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    destination_warehouse_id: int | None = None
    destination_warehouse_name: str | None = None
    quantity: Decimal


class DispatchRead(_Read):
    id: int
    dispatch_no: str
    dispatch_type: str
    dispatch_date: date
    warehouse_id: int
    warehouse_name: str | None = None
    # SCM_0053: snapshotted off the warehouse at the moment this consignment was
    # raised — what the Dispatch screen carries into a transport leg's own
    # from_warehouse_address, which is what the gate pass prints.
    warehouse_address: str | None = None
    to_warehouse_id: int | None = None
    to_warehouse_name: str | None = None
    customer_id: int | None = None
    customer_name: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    destination_office_sac: str | None = None
    # Set on the detail read only: this consignment landed at a relay point that put it
    # straight on the shelf, so the way on from here is the consignment, not a GRN.
    can_forward: bool = False
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    ref_type: str | None = None
    ref_id: int | None = None
    ref_no: str | None = None
    transport_mode: str | None = None
    carrier_id: int | None = None
    carrier_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    freight_amount: Decimal | None = None
    gate_pass_no: str | None = None
    gate_out_at: datetime | None = None
    security_by_name: str | None = None
    status: str
    total_items: int
    total_qty: Decimal
    total_packages: int
    total_weight_kg: Decimal
    total_value: Decimal
    expected_delivery: date | None = None
    delivered_at: datetime | None = None
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None
    pod_url: str | None = None
    current_approver_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    remarks: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DispatchDetail(DispatchRead):
    items: list[DispatchItemRead] = []
    packages: list[DispatchPackageRead] = []
    events: list[DispatchEventRead] = []
    sources: list[DispatchSourceRead] = []
    #: See IssueDetail.can_approve.
    can_approve: bool = False
    #: Opaque signed capability printed in the QR; it reveals no application route.
    public_scan_token: str | None = None
    #: Each issue line's packs, once per line — the rows are one per unit.
    line_packs: list[DispatchLinePacks] = []
    # Carton › box for each package code on it: {code: [{code, name, level}]} (2026-10-28).
    box_paths: dict[str, list[dict]] = {}


# ---------------------------------------------------------------------------
# Purchase returns
# ---------------------------------------------------------------------------

class ReturnReasonOption(BaseModel):
    """One reason the storekeeper can pick — served so UI never hard-codes them."""
    value: str
    label: str


PURCHASE_RETURN_REASONS: list[tuple[str, str]] = [
    ("DAMAGED", "Damaged"),
    ("DEFECTIVE", "Defective"),
    ("WRONG_MATERIAL", "Wrong Material"),
    ("EXCESS_MATERIAL", "Excess Material"),
    ("QUALITY_ISSUE", "Quality Issue"),
    ("INCORRECT_SPECIFICATION", "Incorrect Specification"),
    ("EXPIRED", "Expired"),
    ("MATERIAL_NOT_REQUIRED", "Material Not Required"),
    ("OTHER", "Other"),
]


#: The supplier's possible answers, WORDED FOR THEM, and served rather than mapped in
#: the portal — the same rule `PURCHASE_RETURN_REASONS` follows and the same reason
#: `VENDOR_RETURN_STATUS_LABEL` exists on the frontend: every sentence about a return has
#: to read from where the supplier is standing, not from inside our store.
#:
#: Note the direction of each. "Returned" on this screen means the SUPPLIER is sending
#: our goods back to us, which is the exact opposite of what "return" means everywhere
#: else in this module — hence the wording spells the direction out rather than
#: reusing the bare verb.
#:
#: ACCEPTED is kept and worded even though the portal no longer writes it: this map is
#: the ONLY place an answer is turned into a sentence, so a legacy row drops out of every
#: screen at once if it is removed from here. Its wording says what the row actually
#: means — goods kept, settlement never stated — rather than pretending it was a refund.
VENDOR_RETURN_RESPONSES: list[tuple[str, str]] = [
    (VendorReturnResponse.REFUNDED.value, "Refund being paid"),
    (VendorReturnResponse.REPLACED.value, "Replacement being sent"),
    (VendorReturnResponse.RETURNED.value, "Sent back to you"),
    (VendorReturnResponse.ACCEPTED.value, "Accepted (settlement not recorded)"),
]


class ReturnItemWrite(BaseModel):
    id: int | None = None
    po_item_id: int | None = None
    grn_item_id: int | None = None
    #: Optional since 2026-09-10 — a MANUAL line names an item by hand and that item
    #: need not exist in `mst_items`. Still required on a sourced line, which the
    #: service enforces: it is the link the returnable cap is computed against.
    item_id: int | None = None
    batch_id: int | None = None
    quantity: Decimal
    rate: Decimal | None = None
    reason: str | None = None

    # --- manual lines ---------------------------------------------------------------
    #: This line was typed rather than read off the source document.
    is_manual: bool = False
    #: What the storekeeper called it. Used only where `is_manual` and no `item_id`;
    #: a sourced line's name is always snapshotted from the master.
    item_name: str | None = Field(default=None, max_length=300)
    item_code: str | None = Field(default=None, max_length=50)
    uom_code: str | None = Field(default=None, max_length=20)
    #: Purchased / already returned / available, as typed. Stored verbatim on a manual
    #: line because there is no source document to derive them from.
    original_qty: Decimal | None = None
    previously_returned: Decimal | None = None
    returnable_qty: Decimal | None = None


class ReturnWrite(OrgScopeIn):
    return_date: date
    po_id: int | None = None
    grn_id: int | None = None
    vendor_id: int | None = None
    warehouse_id: int | None = None
    reason: str | None = None
    remarks: str | None = Field(default=None, max_length=1000)
    items: Annotated[list[ReturnItemWrite], DocumentLines] = []

    # --- manual returns ---------------------------------------------------------------
    #
    # ADDED 2026-09-10. A return whose vendor and lines are TYPED rather than read off a
    # purchase transaction, for goods whose paperwork never reached this system. The
    # sourced path is unchanged and remains the default: `is_manual` false means every
    # existing rule applies, including the vendor lock.
    is_manual: bool = False
    #: The document number the storekeeper typed for their own reference. A note, never
    #: resolved and never linked.
    source_ref_no: str | None = Field(default=None, max_length=100)
    #: The vendor as typed. Only read where `is_manual`.
    vendor_name: str | None = Field(default=None, max_length=200)
    vendor_code: str | None = Field(default=None, max_length=50)
    vendor_contact_person: str | None = Field(default=None, max_length=200)
    vendor_phone: str | None = Field(default=None, max_length=50)
    vendor_email: str | None = Field(default=None, max_length=200)
    vendor_address: str | None = Field(default=None, max_length=500)
    vendor_city: str | None = Field(default=None, max_length=100)
    vendor_state: str | None = Field(default=None, max_length=100)
    vendor_pincode: str | None = Field(default=None, max_length=20)
    vendor_gstin: str | None = Field(default=None, max_length=20)


class ReturnItemRead(CombinationOut, _Read):
    id: int
    return_id: int
    line_no: int
    po_item_id: int | None = None
    grn_item_id: int | None = None
    #: Null on a manually typed line — see `models.PurchaseReturnItem.item_id`.
    item_id: int | None = None
    #: This line was typed rather than read off a source document.
    is_manual: bool = False
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    quantity: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    reason: str | None = None
    # Per-line eligibility — served so frontend never computes it.
    original_qty: Decimal | None = None
    previously_returned: Decimal | None = None
    returnable_qty: Decimal | None = None


class ReturnRead(OrgScopeOut, _Read):
    #: The project its number is drawn under (2026-11-12).
    project_id: int | None = None
    project_name: str | None = None
    id: int
    return_no: str
    return_date: date
    po_id: int | None = None
    po_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    # The GRN's own date and the vendor's invoice behind it — the purchase reference the
    # return is argued against. Read off `inb_receipts` on every load, never stored here.
    grn_date: date | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    # Full vendor snapshot — auto-fetched, never typed.
    vendor_code: str | None = None
    vendor_contact_person: str | None = None
    vendor_phone: str | None = None
    vendor_email: str | None = None
    vendor_address: str | None = None
    vendor_city: str | None = None
    vendor_state: str | None = None
    vendor_gstin: str | None = None
    vendor_pincode: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    # Indent snapshot — the request this return answers.
    indent_id: int | None = None
    indent_no: str | None = None
    material_receipt_id: int | None = None
    #: THE QC THAT CONDEMNED THE GOODS. Stored columns since 2026-09-12, resolved on read
    #: off the return's own GRN while they are blank and bound at send — so the evidence
    #: the vendor is being asked to accept is on the document from the moment it is
    #: raised and survives to the moment it is closed. Null where the return names no
    #: goods receipt, or where nobody inspected the one it names.
    inspection_id: int | None = None
    inspection_no: str | None = None
    reason: str | None = None
    reason_label: str | None = None
    #: The served reason code where the stored reason is one (see
    #: `service._enrich_return_with_vendor`); null where it is free text, which is the
    #: signal that the send has to ask for a reason rather than reuse this one.
    reason_code: str | None = None
    remarks: str | None = None
    status: str
    #: The stored status re-worded once the SUPPLIER has answered — "Replacement to
    #: warehouse" rather than "SENT_TO_VENDOR". Null while unanswered, and null once the
    #: return is closed, so a screen writes `status_label ?? status` and every row raised
    #: before the portal could answer renders exactly as it did. Served, never composed
    #: in a screen, for the same reason `reason_label` is: the list and the detail must
    #: not be able to word the same document differently. See
    #: `enums.vendor_return_stage_label`.
    status_label: str | None = None
    sent_at: datetime | None = None
    total_items: int
    total_qty: Decimal
    total_value: Decimal
    credit_note_no: str | None = None
    created_by_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    # Logistics leg — the shipment carrying this return to the vendor.
    dispatch_id: int | None = None
    dispatch_no: str | None = None

    # --- where the material came from, and what raised this document ----------------
    #
    # Stored columns (`pro_returns.source_category`, `.source_return_id`,
    # `.source_return_no`) that nothing served until now, so the review screen could not
    # say that the draft in front of the reader was raised automatically off a branch
    # consignment the warehouse had already signed for. That is the first thing a reader
    # asks of a DRAFT nobody remembers typing, and the answer was sitting in the row.
    source_category: str | None = None
    source_category_label: str | None = None
    source_return_id: int | None = None
    source_return_no: str | None = None

    # --- manual returns ---------------------------------------------------------------
    #: The vendor and lines on this document were typed, not read off a purchase. The
    #: `vendor_*` fields above are then served from the typed values rather than from
    #: `mst_vendors`, so the shape a reader gets is the same either way.
    is_manual: bool = False
    #: The document number the storekeeper typed for their own reference. A note.
    source_ref_no: str | None = None

    # --- what the SUPPLIER said, and what it raised ----------------------------------
    #
    # Stored columns on `pro_returns` since the portal learned to answer (2026-09-11)
    # that only the SUPPLIER's own schema served. The buyer's screen could therefore not
    # say that the supplier had accepted the goods, nor that an inbound receipt was
    # already waiting at the store for the replacement — both of which are the reason
    # anybody opens a sent return. Read-only here: the answer is the supplier's to write
    # and `vendor_respond_to_return` is the only thing that writes it.
    #
    #: REFUNDED | REPLACED | RETURNED, or legacy ACCEPTED. Null means unanswered, which
    #: is every return raised before the portal could answer.
    vendor_response: str | None = None
    #: The answer as a sentence, off `VENDOR_RETURN_RESPONSES` — the one place an answer
    #: is turned into words, so a legacy ACCEPTED row still reads correctly.
    vendor_response_label: str | None = None
    vendor_response_at: datetime | None = None
    #: Why, in the supplier's own words. The store's first question about a consignment
    #: it did not expect.
    vendor_response_note: str | None = None
    #: What the supplier is crediting, on a REFUNDED answer only.
    vendor_refund_amount: Decimal | None = None
    #: The DRAFT inbound receipt the answer raised, where it raised one — the document
    #: the replacement will actually be received against.
    vendor_followup_receipt_id: int | None = None
    vendor_followup_receipt_no: str | None = None

    # --- the chain READ behind a return that was raised without one -----------------
    #
    # A return the returns module raises off a branch consignment stores no GRN, no PO
    # and often no vendor (`service._trace_purchase_source` explains why), so the review
    # screen had an empty header and an empty vendor block. These carry what the trail
    # says instead, kept SEPARATE from the stored fields above rather than filled into
    # them: a traced value is evidence, not a binding, and a reader — human or code —
    # must be able to tell the two apart. Sending is what binds them.
    chain_traced: bool = False
    chain_note: str | None = None
    traced_grn_id: int | None = None
    traced_grn_no: str | None = None
    traced_po_id: int | None = None
    traced_po_no: str | None = None
    traced_vendor_id: int | None = None
    traced_vendor_name: str | None = None

    # --- the decision on a SENT return, and the leg that brings the material back ----
    #
    # ADDED 2026-09-11. See `models.PurchaseReturn.vendor_decision` for why each is
    # stored. Everything here is null on a return that has not been decided, which is
    # every return raised before today.
    #
    #: APPROVED | REJECTED. Null means the sent return has not been answered yet, which
    #: is what puts the two buttons on the screen.
    vendor_decision: str | None = None
    vendor_decision_at: datetime | None = None
    vendor_decision_by_name: str | None = None
    vendor_decision_note: str | None = None

    #: VENDOR_ARRANGES | WAREHOUSE_REQUESTS (`enums.ReturnVehicleArrangement`).
    vehicle_arrangement: str | None = None
    #: The arrangement as the card words it, off `RETURN_VEHICLE_ARRANGEMENT_LABELS` —
    #: the one place an arrangement is turned into words, so the detail screen and the
    #: history cannot word the same choice differently.
    vehicle_arrangement_label: str | None = None
    vehicle_arrangement_at: datetime | None = None
    vehicle_arrangement_by_name: str | None = None

    #: THE VEHICLE BRINGING IT BACK. One shape on both branches: typed on a vendor leg,
    #: read live off the Logistics transport request on a warehouse-requested one — see
    #: `service._decorate_return_inbound_leg`. A screen never asks which.
    inbound_vehicle_no: str | None = None
    inbound_driver_name: str | None = None
    inbound_driver_phone: str | None = None
    inbound_transporter_name: str | None = None
    inbound_lr_no: str | None = None
    inbound_expected_date: date | None = None
    inbound_dispatched_at: datetime | None = None
    #: The Logistics leg carrying it back, on a WAREHOUSE_REQUESTS arrangement.
    inbound_tr_id: int | None = None
    inbound_tr_no: str | None = None
    #: Where that leg has got to (`TransportStatus`), read off it rather than mirrored.
    inbound_tr_status: str | None = None
    #: Where the vehicle collects from, and the earliest it may go.
    inbound_pickup_address: str | None = None
    inbound_ready_date: date | None = None

    #: THE OUTWARD LEG — our warehouse to the vendor's dock, on a WAREHOUSE_REQUESTS
    #: arrangement. Its own pair, never `inbound_tr_*` above: three different trips can
    #: hang off one return and each settles differently.
    outbound_tr_id: int | None = None
    outbound_tr_no: str | None = None

    #: The vendor accepting the collection job, on a VENDOR_ARRANGES leg.
    vendor_transport_accepted_at: datetime | None = None
    vendor_transport_accepted_by_name: str | None = None

    #: The vendor signing for the returned goods at their own dock — the receipt that
    #: ends our liability for the stock and opens the replacement.
    vendor_receipt_confirmed_at: datetime | None = None
    vendor_receipt_by_name: str | None = None
    vendor_receipt_vehicle_no: str | None = None
    vendor_receipt_remarks: str | None = None

    #: THE REPLACEMENT DISPATCH NOTE. The per-line half (batch, mfg, expiry) rides on
    #: `ReturnItemRead.replacement_*`; these are the header facts.
    replacement_dispatched_at: datetime | None = None
    replacement_dispatch_no: str | None = None
    replacement_dispatch_date: date | None = None
    replacement_expected_date: date | None = None
    replacement_transporter_name: str | None = None
    replacement_vehicle_no: str | None = None
    replacement_lr_no: str | None = None
    replacement_remarks: str | None = None

    received_at: datetime | None = None
    received_by_name: str | None = None
    received_remarks: str | None = None

    #: The internal refund's own stamp. The AMOUNT is `vendor_refund_amount` above
    #: (one credit column whichever desk recorded it); these three say the desk did.
    #: All null except on a REFUNDED return.
    refunded_at: datetime | None = None
    refunded_by_name: str | None = None
    refund_remarks: str | None = None


class ReplacementDocumentRead(_Read):
    """One of the two files a replacement dispatch carries.

    Declared HERE, above both documents that serve it — `ReturnDetail` for our store and
    `VendorReturnDetail` for the supplier — so neither needs a forward reference. Both
    sides read the same rows, so the file the supplier attached and the file the store
    downloads cannot be described two different ways.

    A NARROWED `AttachmentRead`, deliberately. `file_path` is where the bytes sit inside
    our own store and is of no use to a caller who can only reach the file through the
    download route; serving it to an outside login states the layout of the upload
    directory for nothing in return.
    """
    id: int
    doc_category: str
    #: "Capture image" / "Replacement invoice / bill", off `REPLACEMENT_DOCUMENT_META`,
    #: so the panel that lists an uploaded file and the field that asked for it cannot
    #: end up calling the same slot two different things.
    label: str | None = None
    file_name: str
    file_size: int | None = None
    mime_type: str | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None


class ReturnDetail(ReturnRead):
    items: list[ReturnItemRead] = []
    #: See IssueDetail.can_approve.
    can_approve: bool = False
    can_send_to_vendor: bool = False
    # --- which of the inbound-leg presses this document is standing at ---------------
    #
    # SERVED, never worked out in the screen. The rungs are the service's own guards
    # (`enums.RETURN_DECIDABLE_STATUSES` and friends), and a screen that re-derived them
    # from the status string would be a second copy of the ladder drifting from the
    # first. Permission is still checked separately and on the server — `<Can>` decides
    # whether the button is worth drawing, `require_permission` decides whether it works.
    #: The vendor has agreed a replacement and this warehouse owes the one decision it
    #: still makes: whose vehicle carries the goods. THE ONLY `can_*` on this document
    #: that puts a button on an employee's screen — every other rung below is the
    #: vendor's own press on their portal, served here so our screen can SAY where the
    #: return is standing without offering to do it for them.
    can_arrange_transport: bool = False
    #: The material is on its way to this warehouse and somebody here may sign it in.
    can_confirm_receipt: bool = False

    # --- what the VENDOR is standing at, read-only on our side -----------------------
    #: Waiting on their Approve / Reject.
    awaiting_vendor_decision: bool = False
    #: Approved; waiting on them to choose refund or replacement.
    awaiting_vendor_settlement: bool = False
    #: Waiting on them to accept the collection job (VENDOR_ARRANGES only).
    awaiting_vendor_transport: bool = False
    #: Waiting on them to sign for the goods at their dock.
    awaiting_vendor_receipt: bool = False
    #: Waiting on their replacement dispatch note.
    awaiting_replacement_dispatch: bool = False

    #: RETAINED SPELLING. `can_arrange_vehicle` was this flag's name while the vehicle
    #: being arranged brought material back FROM the vendor. Served alongside the new
    #: name, with the same value, so a screen built against the old contract keeps
    #: rendering its panel rather than silently losing it.
    can_arrange_vehicle: bool = False

    # --- the replacement's INTAKE: the GRN, its QC and its putaway --------------------
    #
    # READ off the three documents that own those rungs (`inb_receipts`,
    # `inb_inspections`, `whs_warehouse_items`) on every load, never stored on
    # `pro_returns` — see `enums.RETURN_REPLACEMENT_INTAKE_STATUSES`. All null / zero on a
    # return with no replacement coming: a refund, a refusal, and every return raised
    # before this flow existed.
    #: The goods receipt the replacement dispatch note raised — the same document as
    #: `vendor_followup_receipt_no`, served under the name the intake uses.
    replacement_grn_no: str | None = None
    #: DRAFT | PENDING_QC | QC_PASSED | QC_FAILED | PARTIALLY_RECEIVED | COMPLETED.
    replacement_grn_status: str | None = None
    #: The QC inspection raised against it, once the receipt has been submitted.
    replacement_inspection_no: str | None = None
    replacement_putaway_total: int = 0
    replacement_putaway_done: int = 0
    #: The receipt has reached COMPLETED: booked in, passed and placed. This is the fact
    #: that closes the return (`service._close_return_on_intake_complete`).
    replacement_intake_complete: bool = False

    #: THE PAPERWORK THE SUPPLIER DISPATCHED THE REPLACEMENT ON — the loading image,
    #: which they could not send without, and their invoice, which is optional and may
    #: therefore be absent on a perfectly good consignment. Served on OUR side of the
    #: document as well as theirs: a store checking a short or wrong delivery needs the
    #: picture of what left, and collecting evidence only the supplier can see would be
    #: collecting it for nobody. Downloaded through
    #: `/returns/{id}/documents/{attachment_id}/download`, which scopes by this return
    #: rather than by attachment id.
    replacement_documents: list[ReplacementDocumentRead] = []
    #: What the store still owes, in one sentence. Composed on the server so the band on
    #: the detail screen and the journey tracker beside it cannot word one document two
    #: ways. Null where there is no replacement, and once the return is closed.
    replacement_intake_stage: str | None = None


# --- Purchase Return source selection (Warehouse → Vendor flow) ---

class PurchaseReturnSourceOption(BaseModel):
    """One eligible source transaction the storekeeper can pick."""
    source_type: str  # GRN | PO | INDENT | ITEM
    source_id: int
    source_no: str
    source_date: date | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    vendor_code: str | None = None
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    po_id: int | None = None
    po_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None


class PurchaseReturnSourceLookupOut(BaseModel):
    """The answer to a document number somebody typed in by hand.

    A 200 with `found: false` rather than a 404: this is asked on every keystroke of a
    number being typed, and a half-typed number is not an error condition — it is the
    ordinary state of the field. `message` is what the screen says either way, written
    here because only the server knows WHY a number did not resolve (no such document,
    outside your warehouses, or found but with no vendor behind it).
    """
    found: bool = False
    #: Populated only when `found`. The same shape the dropdown's rows carry, so the
    #: screen hands it to exactly the same auto-fetch and nothing downstream branches.
    option: PurchaseReturnSourceOption | None = None
    #: False where the document exists but a purchase return cannot be raised against
    #: it — an indent with no purchase order behind it names no vendor to return to.
    can_return: bool = False
    message: str | None = None


class VendorDetailOut(BaseModel):
    vendor_id: int | None = None
    vendor_code: str | None = None
    vendor_name: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    gstin: str | None = None


class ItemDetailOut(CombinationOut):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    description: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    batch_id: int | None = None
    serial_no: str | None = None
    # The source line this row was read off — echoed back on save so the
    # returnable cap is checked per line, not per item.
    grn_item_id: int | None = None
    po_item_id: int | None = None
    original_qty: Decimal
    previously_returned: Decimal = Decimal("0")
    returnable_qty: Decimal
    # Unit price off the source line (GRN/PO rate) and the extended amount, so the
    # form can show price x returnable without recomputing it in the browser.
    unit_price: Decimal | None = None
    amount: Decimal | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None


class PurchaseDetailsOut(BaseModel):
    po_id: int | None = None
    po_no: str | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    receipt_id: int | None = None
    receipt_no: str | None = None
    order_date: date | None = None
    receipt_date: date | None = None
    # The vendor's invoice behind the GRN — the "Purchase Invoice" the return
    # answers. Null on a PO-sourced return with no GRN yet.
    invoice_no: str | None = None
    invoice_date: date | None = None


class PurchaseReturnSourceDetail(BaseModel):
    """Everything auto-fetched when a source is picked — single call, single truth."""
    source_type: str
    source_id: int
    source_no: str
    vendor: VendorDetailOut
    items: list[ItemDetailOut] = []
    purchase: PurchaseDetailsOut
    # Top-level warehouse for the return itself.
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    total_original_qty: Decimal = Decimal("0")
    total_previously_returned: Decimal = Decimal("0")
    total_returnable_qty: Decimal = Decimal("0")
    # The source's organisation and project (2026-11-12), copied onto the return and
    # shown locked on its number card. All null off an older GRN / PO.
    organization_id: int | None = None
    organization_code: str | None = None
    organization_name: str | None = None
    org_department_id: int | None = None
    org_department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None


#: How a purchase return physically travels back to the supplier, in the order the
#: Send to Vendor wizard offers the three cards.
#:
#: Deliberately a SUBSET of the logistics module's `TransportMode` rather than a new
#: vocabulary of its own: these values land in `out_dispatches.transport_mode`, which
#: every other consignment in the product already fills from that enum, and inventing
#: "BY_HAND" here would have meant the shipments board showed one mode it could not
#: label. COURIER is the member left out — nothing in the returns flow books a
#: published parcel rate today — and leaving it out of the PICKER rather than out of
#: the enum means offering it later is a screen change and not a migration.
#:
#: Served, never hard-coded in UI, exactly as `PURCHASE_RETURN_REASONS` is.
PURCHASE_RETURN_LOGISTICS_MODES: list[tuple[str, str, str]] = [
    ("DIRECT", "By Hand",
     "Somebody carries it to the supplier. Nobody is hired and no freight is paid — "
     "the record is who took it and who signed for it."),
    ("THIRD_PARTY", "Third Party",
     "Handed to a hired carrier. Capture who is carrying it and the LR number, so the "
     "consignment can be chased while it is on the road."),
    ("OWN_VEHICLE", "Own Vehicle",
     "Sent on a company vehicle. No freight is paid — the record is which vehicle "
     "went and who drove it."),
]

#: The modes above that need a hired carrier named, and the ones that need a vehicle.
#: Held here beside the catalogue rather than in the service so the rule and the list
#: it applies to cannot drift apart.
LOGISTICS_MODES_NEEDING_CARRIER = ("THIRD_PARTY",)
LOGISTICS_MODES_NEEDING_VEHICLE = ("OWN_VEHICLE",)
LOGISTICS_MODES_NEEDING_BEARER = ("DIRECT",)


#: WHO MOVES GOODS COMING TOWARDS US. `inb_receipts.inbound_transport_mode`.
#:
#: A DIFFERENT AXIS from `PURCHASE_RETURN_LOGISTICS_MODES` above, which is why it is a
#: separate list and not two more rows on it. That one answers "how does it travel and
#: who is paid" for a leg WE are sending; every one of its values presumes the sender
#: arranges the journey. Goods coming towards us raise a prior question — is anything
#: coming at all, or is it sitting on the supplier's dock waiting for our vehicle — and
#: `OWN_VEHICLE` cannot answer it, because on an inbound leg "own vehicle" is ambiguous
#: between the supplier's truck and ours.
#:
#: Only two members, and deliberately so: this says who is responsible for the journey,
#: not what it moves on. If the answer is SUPPLIER_DELIVERS, how THEY chose to send it is
#: recorded by the transporter/vehicle/LR they state; if it is WE_COLLECT, the mode of
#: our own vehicle is ours to decide later and is not the supplier's to declare.
INBOUND_TRANSPORT_MODES: list[tuple[str, str, str]] = [
    ("SUPPLIER_DELIVERS", "We are sending it to you",
     "The supplier puts it on a vehicle and it arrives at our warehouse. They state the "
     "date it will reach us, and the carrier if one is booked."),
    ("WE_COLLECT", "Please collect it from us",
     "The goods are ready on the supplier's dock and somebody here has to send a "
     "vehicle. They state where to collect from and the date it is ready."),
]

#: The inbound mode that promises an ARRIVAL, and the one that promises goods READY on
#: the supplier's dock. Kept beside the catalogue for the same reason the `needs_*`
#: tuples above are: what an option requires must not be restated anywhere else.
INBOUND_MODES_ARRIVING = ("SUPPLIER_DELIVERS",)
INBOUND_MODES_COLLECTED = ("WE_COLLECT",)

#: Every replacement-only field on `VendorReturnResponseIn`, grouped by the leg it
#: belongs to. Module level rather than class attributes on the model: Pydantic v2 turns
#: underscore-prefixed class attributes into private attributes, so a tuple declared
#: inside the class is not reliably readable as a plain tuple from a validator.
REPLACEMENT_DELIVERY_FIELDS = (
    "replacement_expected_date", "replacement_transporter_name",
    "replacement_vehicle_no", "replacement_lr_no",
)
REPLACEMENT_COLLECTION_FIELDS = (
    "replacement_pickup_address", "replacement_ready_date",
)


class PurchaseReturnLogisticsIn(BaseModel):
    """How the goods travel, who signed for them, and everything in between.

    One nested block rather than eighteen loose fields on the send payload, because
    every value here lands on the SAME `out_dispatches` row that `send_to_vendor`
    already raises — grouping them says so, and keeps the send payload's own fields
    (what is being returned, and why) legible beside it.

    THE WHOLE BLOCK IS OPTIONAL ON THE ENDPOINT, and that is not laziness. The send
    API predates this wizard and other callers post without it; a required block would
    have broken every one of them. Absent, the send behaves exactly as it always did.
    Present, it is validated in full — see `_apply_return_logistics`.

    Mode-specific fields are optional HERE and required THERE for the same reason:
    what a leg must carry depends on which of the three it is, and a Pydantic model
    that made `vehicle_number` mandatory would have refused a hand-over.
    """
    #: One of `PURCHASE_RETURN_LOGISTICS_MODES`.
    mode: str = Field(min_length=1, max_length=30)

    # --- who moves it: only the fields its own mode asks for are ever filled ---
    #: DIRECT — the person who physically carried it out of the gate.
    hand_carried_by: str | None = Field(default=None, max_length=200)
    #: OWN_VEHICLE
    vehicle_number: str | None = Field(default=None, max_length=50)
    driver_name: str | None = Field(default=None, max_length=200)
    driver_phone: str | None = Field(default=None, max_length=20)
    #: THIRD_PARTY. Typed, not picked off the carrier master: a return leg often goes
    #: with whoever the supplier nominated, and demanding a master record for a one-off
    #: truck is precisely what was keeping this on paper.
    carrier_name: str | None = Field(default=None, max_length=200)
    lr_no: str | None = Field(default=None, max_length=50)
    freight_amount: Decimal | None = Field(default=None, ge=0)

    # --- where it goes: the supplier's delivery point ---
    # Defaulted from the vendor master on screen and editable, because goods go back to
    # a gate or a stores address that is frequently not the billing address on file.
    delivery_address: str | None = Field(default=None, max_length=500)
    contact_person: str | None = Field(default=None, max_length=200)
    contact_phone: str | None = Field(default=None, max_length=20)

    # --- what leaves the gate ---
    total_packages: int | None = Field(default=None, ge=0)
    total_weight_kg: Decimal | None = Field(default=None, ge=0)
    eway_bill_no: str | None = Field(default=None, max_length=50)
    expected_delivery: date | None = None
    gate_pass_no: str | None = Field(default=None, max_length=50)
    dispatch_remarks: str | None = Field(default=None, max_length=1000)

    # --- the supplier's signature ---
    acknowledged_by_name: str | None = Field(default=None, max_length=200)
    acknowledged_at: datetime | None = None
    #: Where the signed copy lives — a link or a file reference, typed.
    pod_url: str | None = Field(default=None, max_length=500)


class PurchaseReturnSendToVendorIn(BaseModel):
    """The single commitment: quantities per item + reason."""
    return_reason: str = Field(min_length=1, max_length=50)
    remarks: str | None = Field(default=None, max_length=1000)
    items: list[ReturnItemWrite] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)
    # Optional: if the source was not already bound to the draft, bind it now.
    grn_id: int | None = None
    po_id: int | None = None
    indent_id: int | None = None
    vendor_id: int | None = None
    warehouse_id: int | None = None
    #: How it travels and who signed. Optional — see `PurchaseReturnLogisticsIn`.
    logistics: PurchaseReturnLogisticsIn | None = None


class ReturnDecisionIn(BaseModel):
    """Approve or Reject a return that has already been sent to the vendor.

    RETAINED for `VendorReturnDecisionIn` to inherit the shape from and for any caller
    still posting it. The DECISION itself moved to the vendor's portal on 2026-09-12;
    this model no longer has a route of its own.
    """
    #: Why. Optional on an approval, REQUIRED on a rejection — enforced in the service
    #: rather than here, because the same model serves both answers and a required field
    #: would refuse a perfectly ordinary approval.
    comments: str | None = Field(default=None, max_length=1000)


class VendorReturnDecisionIn(BaseModel):
    """The VENDOR's Approve or Reject on a return we have sent them.

    The action is a FIELD here rather than coming from the route, which is the opposite
    of how `ReturnDecisionIn` worked and deliberately so: the portal has no permission
    code to hang two routes off (a vendor holds no RBAC grants at all — they are scoped
    by the vendor id on their token), so two routes would buy nothing and one press with
    one body is what the screen actually sends.
    """
    #: APPROVED or REJECTED.
    action: Literal["APPROVED", "REJECTED"]
    #: Why. REQUIRED on a rejection and optional on an approval — checked in the service,
    #: because only it knows which way the answer went and a field required here would
    #: refuse an ordinary approval.
    remarks: str | None = Field(default=None, max_length=1000)


class VendorReturnSettlementIn(BaseModel):
    """Refund or Replacement — the vendor's second answer, once they have approved.

    Two members and no third. `VendorReturnResponse` also carries RETURNED and a legacy
    ACCEPTED, and neither belongs on this press: RETURNED is a REFUSAL, which is now the
    earlier `VendorReturnDecisionIn`, and ACCEPTED is the half-answer this whole pair of
    presses exists to eliminate. Spelling the two out as a Literal rather than accepting
    the enum is what stops either arriving here.
    """
    settlement: Literal["REFUNDED", "REPLACED"]
    #: What the vendor is crediting, in the return's own currency. REQUIRED on a refund
    #: and REFUSED on a replacement — a figure stored against an answer that promises
    #: goods and pays nothing would show on screen as a credit nobody agreed to. `gt=0`
    #: because a zero refund is not a refund. The upper cap (never more than the value of
    #: the goods) is checked in the service, which is the only place that has the row.
    refund_amount: Decimal | None = Field(default=None, gt=0, max_digits=16,
                                          decimal_places=2)
    remarks: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _amount_belongs_to_a_refund(self):
        if self.settlement == "REFUNDED" and self.refund_amount is None:
            raise ValueError(
                "Enter the amount you are refunding — a refund with no figure on it is "
                "the half-answer this press exists to avoid.")
        if self.settlement != "REFUNDED" and self.refund_amount is not None:
            raise ValueError(
                "A replacement carries no refund amount. Choose a refund if money is "
                "being credited.")
        return self


class VendorTransportAcceptIn(BaseModel):
    """The vendor accepting the collection job, and the vehicle they are sending.

    Every field optional: a vendor accepts on Monday and frequently does not know the
    truck until Thursday, and refusing the acceptance for want of a registration number
    pushes them back to the telephone this screen replaces. What they do state is stored;
    what they leave blank stays blank and can be filled in at the pickup.
    """
    vehicle_no: str | None = Field(default=None, max_length=50)
    driver_name: str | None = Field(default=None, max_length=200)
    driver_phone: str | None = Field(default=None, max_length=30)
    transporter_name: str | None = Field(default=None, max_length=200)
    lr_no: str | None = Field(default=None, max_length=50)
    #: When they expect to collect.
    expected_date: date | None = None
    remarks: str | None = Field(default=None, max_length=1000)


class VendorPickupIn(VendorTransportAcceptIn):
    """The vendor's vehicle has loaded at our warehouse and left with the goods.

    The same fields as the acceptance, because this is where a truck named days earlier
    gets corrected to the one that actually turned up. Inherited rather than restated so
    the two cannot drift; the service applies both through one mapping.
    """


#: `ReplacementDispatchIn` is declared further down the file, immediately after
#: `VendorReplacementLineIn` — the per-line model it is built out of. Python needs that
#: class to exist before this one refers to it, and keeping the two together is also how
#: a reader finds the second half of the dispatch note.


class ReturnVehicleArrangementIn(BaseModel):
    """Who moves an approved return's goods to the vendor.

    The warehouse's one press in this flow. The field names still say "pickup", which is
    read from the VEHICLE's point of view rather than ours: on a vendor-arranged leg their
    truck collects from our dock, and on a warehouse-arranged one Logistics' truck does
    the same. Either way this is where the load is picked up and when it may go.
    """
    #: One of `enums.ReturnVehicleArrangement`, as served by
    #: `GET /returns/vehicle-arrangements`.
    arrangement: str = Field(min_length=1, max_length=30)
    #: Where the vehicle loads. Defaulted from the warehouse on screen and editable,
    #: because goods are frequently ready on a dock that is not the registered address.
    pickup_address: str | None = Field(default=None, max_length=500)
    #: The earliest the material may be collected — our own goods-ready date. NOT a
    #: delivery date: nobody can know when the load reaches the vendor until a vehicle has
    #: been assigned.
    ready_date: date | None = None
    remarks: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _ready_date_is_not_behind_us(self):
        """No day that has already gone.

        The screen's calendar stops offering one (`min` on the Ready-from input), and
        this is the same rule where the save can actually enforce it — a form is not a
        guard. Worded like `ReplacementDispatchIn`'s identical check, because it is the
        same mistake on the other end of the same journey.

        Still OPTIONAL: a leg may be confirmed with no ready date at all, which says
        "as soon as it is packed". Only a date that is stated AND behind us is refused.
        """
        if self.ready_date is not None and self.ready_date < ist_today():
            raise ValueError(
                "The ready date is in the past. Give the date the load will actually "
                "be ready to leave.")
        return self


class ReturnInboundVehicleIn(BaseModel):
    """The vehicle the VENDOR named, on a vendor-arranged leg.

    Only reachable on `VENDOR_ARRANGES`. On the other branch every field here belongs to
    the Logistics transport request and is read back off it — typing a second copy is
    what would let the two documents disagree about which truck is coming.

    Every field is optional so a desk can record a vehicle number the moment it is given
    and add the driver when the vendor calls back; the service refuses a press that
    states nothing at all rather than a model that demands everything at once.
    """
    vehicle_no: str | None = Field(default=None, max_length=50)
    driver_name: str | None = Field(default=None, max_length=200)
    driver_phone: str | None = Field(default=None, max_length=30)
    transporter_name: str | None = Field(default=None, max_length=200)
    lr_no: str | None = Field(default=None, max_length=50)
    expected_date: date | None = None
    #: The vehicle has left the vendor. Flips the return onto IN_TRANSIT, which is the
    #: one thing a vendor-arranged leg has no Logistics document to say for it.
    dispatched: bool = False
    remarks: str | None = Field(default=None, max_length=1000)


class ReturnReceivedIn(BaseModel):
    """The material is back in the building, and who signed for it."""
    received_by_name: str | None = Field(default=None, max_length=200)
    remarks: str | None = Field(default=None, max_length=1000)


class ResolveRefundIn(BaseModel):
    """Settle an approved return in money instead of bringing goods back.

    The amount is what the VENDOR stated they will credit — recorded by the desk,
    never invented here — so it is required, positive, and capped at the value of
    the goods sent back (a supplier cannot credit more than they received).
    """
    refund_amount: Decimal = Field(gt=0, max_digits=16, decimal_places=2)
    refund_remarks: str | None = Field(default=None, max_length=1000)


class VehicleArrangementOption(BaseModel):
    """One of the two cards offered after an approval. Served so UI hard-codes neither."""
    value: str
    label: str
    help: str
    #: This option hands the leg to LOGISTICS — a vehicle request is raised on their
    #: Dispatch board and the vehicle and driver come back from it. Served for the same
    #: reason `LogisticsModeOption.raises_shipment` is: a screen that decided it by
    #: testing for the string "WAREHOUSE_REQUESTS" would be a second copy of the rule.
    raises_vehicle_request: bool = False


class LogisticsModeOption(BaseModel):
    """One card on the wizard's first step. Served so UI never hard-codes the three."""
    value: str
    label: str
    help: str
    #: Which extra questions this mode asks, so the screen renders the right fields
    #: from the catalogue instead of branching on the code in three places.
    needs_carrier: bool = False
    needs_vehicle: bool = False
    needs_bearer: bool = False
    #: This mode hands the load to LOGISTICS rather than finishing it at the gate, so
    #: the trip still has to be arranged and the supplier cannot have signed for it yet.
    #: Served for the same reason the three above are: whether the wizard may ask for an
    #: acknowledgement is a business rule, and `_validate_return_logistics` enforces the
    #: same one on the way in. A screen that decided it by testing for the string
    #: "OWN_VEHICLE" would be a second copy of the rule, drifting from the first.
    raises_shipment: bool = False


class VendorReturnListRow(BaseModel):
    """One purchase return, as the SUPPLIER sees it on their own portal.

    A separate shape from `ReturnRead`, and deliberately narrower. The internal read
    carries the warehouse, who raised it, the approval trail and the credit note; none
    of that is the supplier's business, and a portal row assembled by trimming an
    internal one drifts the moment somebody adds a column to the internal one.

    What IS here is what a supplier needs to answer "what is coming back to me, why,
    and how is it arriving": the return and the purchase behind it, the reason, the
    totals, and the logistics leg read off `out_dispatches` — the mode, who is
    carrying it, and when to expect it.
    """
    model_config = ORM

    id: int
    return_no: str
    return_date: date | None = None
    #: The purchase this return answers. Either may be null — a return can be raised
    #: against a GRN with no PO behind it, and a manual return has neither.
    po_no: str | None = None
    grn_no: str | None = None
    #: THE QC THAT CONDEMNED THE GOODS. On the supplier's copy because it is the evidence
    #: they are being asked to accept — the business requires them to be able to verify a
    #: return against the GRN, the PO and the QC before they answer it, and until
    #: 2026-09-12 the third of those was on no screen at all.
    inspection_no: str | None = None
    reason_code: str | None = None
    reason_label: str | None = None
    remarks: str | None = None
    total_items: int = 0
    total_qty: Decimal = Decimal("0")
    total_value: Decimal = Decimal("0")
    status: str
    #: The stored status as a sentence. Served for the same reason `reason_label` is: the
    #: supplier reading "REPLACEMENT_AGREED" is reading our database.
    status_label: str | None = None
    sent_at: datetime | None = None

    # --- the rungs the supplier themselves answered, read straight off the columns ----
    #: APPROVED | REJECTED, and their own words for it.
    vendor_decision: str | None = None
    vendor_decision_at: datetime | None = None
    vendor_decision_note: str | None = None
    #: Who moves the goods, once the buyer's warehouse has decided. VENDOR_ARRANGES means
    #: this supplier owes a vehicle; WAREHOUSE_REQUESTS means one is coming to them.
    vehicle_arrangement: str | None = None
    vehicle_arrangement_label: str | None = None
    vendor_transport_accepted_at: datetime | None = None
    #: The replacement dispatch note they raised, and how it travels.
    replacement_dispatched_at: datetime | None = None
    replacement_dispatch_no: str | None = None
    replacement_dispatch_date: date | None = None
    replacement_expected_date: date | None = None
    replacement_transporter_name: str | None = None
    replacement_vehicle_no: str | None = None
    replacement_lr_no: str | None = None

    # --- the logistics leg, read off the consignment; all null on a manual return,
    # --- which raises no consignment at all (see `send_to_vendor`).
    dispatch_no: str | None = None
    transport_mode: str | None = None
    transport_mode_label: str | None = None
    carrier_name: str | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    lr_no: str | None = None
    eway_bill_no: str | None = None
    total_packages: int | None = None
    expected_delivery: date | None = None
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None

    # --- the supplier's own two acts, read straight off the columns. Both null until
    # --- they answer, which is the state every return raised before 2026-09-11 is in.
    #: The physical handover. Null means nobody has signed for the consignment yet.
    vendor_receipt_confirmed_at: datetime | None = None
    vendor_receipt_by_name: str | None = None
    vendor_receipt_vehicle_no: str | None = None
    vendor_receipt_remarks: str | None = None
    #: REFUNDED | REPLACED | RETURNED, or legacy ACCEPTED. Null means unanswered.
    vendor_response: str | None = None
    #: The answer as the supplier should read it — SERVED, never mapped in a screen,
    #: for the same reason `reason_label` and `transport_mode_label` are.
    vendor_response_label: str | None = None
    vendor_response_at: datetime | None = None
    vendor_response_note: str | None = None
    #: What the supplier is crediting, on a REFUNDED answer only. Null on every other
    #: answer — including legacy ACCEPTED, where no figure was ever captured — so a
    #: screen must read "is there an amount" and not "is this settled in money".
    vendor_refund_amount: Decimal | None = None
    #: The refund set beside what was sent back, worded by the server because the
    #: comparison is the point: a short credit is normal and the document has to say so
    #: rather than leaving the reader to subtract. Null when there is no refund.
    vendor_refund_label: str | None = None
    #: The inbound receipt the answer raised, where it raised one.
    vendor_followup_receipt_no: str | None = None


class VendorReturnItemRow(BaseModel):
    """One line of a purchase return, as the SUPPLIER sees it.

    Narrower than `ReturnItemRead` for the same reason `VendorReturnListRow` is
    narrower than `ReturnRead`: the internal line carries the source `po_item_id` /
    `grn_item_id`, the batch id and the returnable-quantity arithmetic, none of which
    is the supplier's business. What is left is what is physically in the carton and
    what we say it is worth.
    """
    model_config = ORM

    line_no: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    quantity: Decimal
    rate: Decimal | None = None
    amount: Decimal | None = None
    #: The per-line reason, already worded. A line may carry its own reason where the
    #: consignment mixes several — a damaged drum beside an over-supplied one — and
    #: falls back to the document's where it does not.
    reason_label: str | None = None

    # --- WHAT A REPLACEMENT OF THIS LINE HAS TO STATE ---------------------------------
    #
    # Served so the portal can ask for exactly what the item master demands, rather than
    # showing three boxes on every line and letting the supplier find out from a refusal
    # which of them mattered. The same two flags `_apply_receipt_lines` enforces when the
    # store submits the GRN, read from the same item master, so the portal and the
    # receiving desk cannot disagree about what a line needs.
    #: This item is batch tracked — a replacement of it must name its batch.
    needs_batch: bool = False
    #: This item carries an expiry (or, on an asset, a warranty end) — a replacement of
    #: it must state the date.
    needs_expiry: bool = False
    #: What to CALL that date on screen. One flag, two words for it: a consumable
    #: expires, an asset's warranty ends. Worded here so every screen says it the same
    #: way, exactly as `_apply_receipt_lines` picks the word for its refusal.
    life_label: str = "Expiry"

    # --- WHAT WE ORIGINALLY RECEIVED, read off the GRN line these goods came in on.
    #
    # PREFILL, NOT A BINDING. The replacement is different physical stock and will
    # usually carry a different batch and a later expiry, so these are never written to
    # the new receipt on their own (see `_raise_vendor_return_inbound`) — they are handed
    # to the supplier as the starting point so a one-batch, one-expiry replacement is a
    # confirmation rather than a re-typing exercise, and so the supplier can see what we
    # are complaining about. Null where the return names no GRN line, and on a manual
    # return, which has no purchase behind it at all.
    original_batch_no: str | None = None
    original_mfg_date: date | None = None
    original_expiry_date: date | None = None


class VendorReturnDetail(VendorReturnListRow):
    """One purchase return opened on the supplier's portal.

    The list row plus the two things a row cannot carry: WHAT is in the consignment,
    and WHERE it is being delivered. The supplier reconciles goods against their own
    paperwork line by line, so a list that stops at "1.000 in 1 line" cannot answer the
    only question they open the document to ask.

    Everything else is inherited rather than restated, so a field added to the row is
    on the detail automatically and the two cannot drift.
    """
    items: list[VendorReturnItemRow] = []

    # --- where the consignment is going. Off the same `out_dispatches` leg the list
    # --- row's logistics fields come from, so null on a manual return.
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    total_weight_kg: Decimal | None = None

    # --- THE TWO PARTIES, added 2026-09-11 for the acknowledgement receipt. A receipt
    # --- that does not name who handed over and who received is not a receipt, and the
    # --- portal previously served neither: the supplier's own identity was known only
    # --- from the page header, and the warehouse that sent the goods was nowhere.
    # ---
    # --- Detail-only on purpose. A list row is a queue and repeats the same supplier
    # --- on every line; these are read once, with one document open.
    # --- HOW THE REPLACEMENT IS TRAVELLING, read back off the draft inbound receipt the
    # --- answer raised (2026-09-11). Not columns on the return: the receipt owns these
    # --- and this is a read of it, so the page and the store's receiving screen can
    # --- never show two different dates for one lorry.
    # ---
    # --- Detail-only, because it costs a second query. A list row says "replacement
    # --- being sent" and that is the whole answer at queue level.
    #: SUPPLIER_DELIVERS or WE_COLLECT (`INBOUND_TRANSPORT_MODES`) — which of the two
    #: inbound legs was agreed. The field a screen should branch on; the dates below are
    #: each meaningful on one leg only.
    replacement_mode: str | None = None
    #: When the supplier said the replacement would reach us. DELIVERY only — null on a
    #: collection, where nothing is due until a vehicle is scheduled here.
    replacement_expected_date: date | None = None
    #: When the goods are ready on the SUPPLIER's dock, and where to fetch them from.
    #: COLLECTION only. `replacement_ready_date` is not an arrival date and must never be
    #: shown as one.
    replacement_ready_date: date | None = None
    replacement_pickup_address: str | None = None
    #: The whole leg as one sentence — an arrival with its carrier, or a collection with
    #: its ready date and address. Worded by the server so the portal and any later
    #: screen say it identically.
    replacement_label: str | None = None

    #: OUR warehouse — the party handing the goods over.
    warehouse_name: str | None = None
    #: The SUPPLIER — the party receiving them. Their own details, shown back to them so
    #: the receipt they are signing names both sides. `vendor_name` is a column;
    #: the rest are assigned on read by `_enrich_return_with_vendor` off `mst_vendors`,
    #: which is why a manual return's typed values arrive under these same names.
    vendor_name: str | None = None
    vendor_code: str | None = None
    vendor_gstin: str | None = None
    vendor_address: str | None = None
    vendor_contact_person: str | None = None
    vendor_phone: str | None = None

    #: THE REPLACEMENT'S PAPERWORK — the loading image and the invoice, whichever of the
    #: two have been uploaded so far. The screen reads this to know which slots are
    #: already filled, and the SERVER reads the same rows to decide whether the dispatch
    #: may run, so the press cannot be enabled over a requirement the save will refuse.
    replacement_documents: list[ReplacementDocumentRead] = []


class VendorReturnReceiptIn(BaseModel):
    """The supplier signing for the consignment — the acknowledgement receipt.

    Only the name is required. The vehicle is prefilled on screen from the consignment
    and may genuinely be blank (a manual return raises no consignment at all, and a
    hand-carried one has no vehicle), and remarks are for the discrepancy nobody
    planned for. The MOMENT is never taken from the caller: it is stamped server-side,
    because a receipt whose time the signing party can choose is not evidence.
    """
    received_by_name: str = Field(min_length=1, max_length=200)
    vehicle_number: str | None = Field(default=None, max_length=50)
    remarks: str | None = Field(default=None, max_length=1000)


class VendorReplacementLineIn(BaseModel):
    """Batch and life dates for ONE line of the replacement the supplier is sending.

    ASKED AT SOURCE, and this is the whole point of it. The draft inbound receipt a
    replacement raises used to carry a blank batch and no expiry — correctly, because the
    FAULTY goods' batch belongs to different physical stock (see
    `_raise_vendor_return_inbound`) — and the storekeeper then could not submit the GRN
    at all: an expiry-tracked item with no expiry date is refused by
    `_apply_receipt_lines`, which is the rule that keeps unlabelled stock out of
    inventory. The store cannot invent the number and neither can we. The supplier
    packing the carton is the only party who knows it, so they are asked in the same
    press that promises the replacement.

    PER LINE, not per document. A return may send back several items, and replacement
    goods for two different items have two different batches and two different expiries.
    One pair of boxes on the whole answer would be right only for the single-line case
    and quietly wrong for every other.

    Every field is optional HERE because what a line actually needs is a fact of the ITEM
    MASTER, which this request cannot see. `_raise_vendor_return_inbound` holds the items
    and refuses a batch-tracked line with no batch and an expiry-tracked line with no
    date; the portal marks the same boxes required from `needs_batch` / `needs_expiry` on
    `VendorReturnItemRow`, so the supplier is told before they press rather than after.
    """
    #: Which line of the RETURN this describes — `VendorReturnItemRow.line_no`, the
    #: number the supplier is looking at. Never a database id: the portal is not given
    #: line ids and must not need them.
    line_no: int = Field(ge=1)
    batch_no: str | None = Field(default=None, max_length=50)
    mfg_date: date | None = None
    #: Expiry for a consumable, warranty end for an asset — one column, and the item
    #: master decides which word the portal prints (`life_label`).
    expiry_date: date | None = None

    @model_validator(mode="after")
    def _the_dates_make_sense(self):
        if (self.expiry_date is not None and self.mfg_date is not None
                and self.expiry_date < self.mfg_date):
            raise ValueError(
                f"Line {self.line_no}: the expiry cannot be before the manufacturing "
                "date.")
        # Goods that have already expired are not a replacement, they are the next
        # complaint. Refused at the edge rather than received and written off, which is
        # what the store would otherwise have to do with them.
        if self.expiry_date is not None and self.expiry_date < ist_today():
            raise ValueError(
                f"Line {self.line_no}: that expiry has already passed. Send goods that "
                "will still be in date when they reach us.")
        if self.batch_no is not None:
            self.batch_no = self.batch_no.strip() or None
        return self


class ReplacementDispatchIn(BaseModel):
    """THE REPLACEMENT DISPATCH NOTE — what the vendor has put on a vehicle towards us.

    Carries what the business requires the note to carry. The item, the quantity, the
    purchase return number and the GRN/PO references are already on the return and are
    printed from it; what only the vendor can state is here — the batch and life dates of
    the goods ACTUALLY being sent, the dispatch date, and how it travels.

    Declared HERE rather than beside the other vendor presses because it is built out of
    `VendorReplacementLineIn` above, and Python needs that class to exist first.

    `lines` may be empty ONLY where no line needs a batch or a life date. The service
    checks each line against the item master (`_validate_replacement_cartons`) and refuses
    a batch-tracked item with no batch or an expiry-tracked one with no date — the same
    two rules that will stop the store's GRN, applied while the person who can read the
    number off the carton is still on the screen.
    """
    #: The vendor's OWN dispatch note number, as they state it. Never generated here and
    #: never resolved — it is their reference, printed so the two sides can quote one
    #: number at each other.
    dispatch_no: str | None = Field(default=None, max_length=100)
    #: The day the goods left the vendor.
    dispatch_date: date | None = None
    #: When the replacement is expected to reach our warehouse. This is what the receiving
    #: screen sorts its queue by, so it is the one date worth asking for.
    expected_date: date | None = None
    transporter_name: str | None = Field(default=None, max_length=200)
    vehicle_no: str | None = Field(default=None, max_length=50)
    lr_no: str | None = Field(default=None, max_length=50)
    remarks: str | None = Field(default=None, max_length=1000)
    #: What is in each carton, per line of the return. See the class docstring.
    lines: Annotated[list[VendorReplacementLineIn], DocumentLines] = []


class VendorReturnResponseIn(BaseModel):
    """The supplier's decision about the goods: refund, replace, or send them back.

    A note is demanded for the two answers that send goods back to us and optional for
    the one that does not — the store is about to receive an unexpected consignment and
    "why" is the first thing they will ask. The same rule, for the same reason, as
    `vendor_respond_to_po` requiring a reason to decline an order.

    `refund_amount` is REQUIRED on a REFUNDED answer and REFUSED on any other, both
    enforced here rather than left to the service. An amount arriving with REPLACED
    would be a figure stored against an answer that promises goods and pays nothing, and
    a screen showing it would be inventing a credit nobody agreed to; a REFUNDED answer
    with no amount is the half-answer this whole outcome exists to eliminate. Neither is
    a correctable mistake, so both are rejected at the edge.

    What is NOT checked here is the amount against what was actually returned — the
    request does not carry the return's value, and inferring it from a client-supplied
    figure is exactly the check an attacker controls both sides of. `vendor_respond_to_
    return` caps it against `pro_returns.total_value`, which it reads from the row.
    """
    response: VendorReturnResponse
    remarks: str | None = Field(default=None, max_length=1000)
    #: What the supplier is crediting, in the return's own currency. `gt=0` because a
    #: zero refund is not a refund — a supplier settling for nothing is REPLACED or a
    #: conversation with the buyer, and storing 0.00 would read on screen as a paid
    #: credit of nothing. Two decimal places, matching `MONEY`.
    refund_amount: Decimal | None = Field(default=None, gt=0, max_digits=16,
                                          decimal_places=2)

    # --- HOW THE REPLACEMENT TRAVELS (2026-09-11) -------------------------------------
    # REPLACED always raised a draft inbound receipt, so the store knew WHAT to expect
    # and never when, on what, or even whether anything was coming. These fill it in, and
    # they are written straight onto that receipt rather than stored on the return: the
    # receipt is the document the receiving screen reads, and a second copy on
    # `pro_returns` would be two places for one fact to drift.
    #
    # TWO LEGS, and `replacement_mode` picks which (`INBOUND_TRANSPORT_MODES`):
    #
    #   SUPPLIER_DELIVERS  they send it. `replacement_expected_date` is a real promise of
    #                      arrival at our gate, and the carrier fields describe THEIR
    #                      vehicle. Pickup fields are meaningless and refused.
    #   WE_COLLECT         it is ready on their dock and we send a vehicle.
    #                      `pickup_address` and `goods_ready_date` are required; the
    #                      arrival date and carrier fields are REFUSED, because the
    #                      vehicle is ours to assign and the supplier cannot promise when
    #                      goods they are not moving will reach us.
    #
    # Within each leg only the date is compulsory. That mirrors what the supplier can
    # actually know: somebody promising a replacement can promise a date, but the lorry
    # is frequently not booked until the goods are packed, and refusing the whole answer
    # for want of a vehicle number pushes them back to the telephone this screen
    # replaces.
    #: One of `INBOUND_TRANSPORT_MODES`. Required on a replacement, refused otherwise.
    replacement_mode: str | None = Field(default=None, max_length=30)

    # --- SUPPLIER_DELIVERS only ---
    #: When the replacement is expected to reach OUR warehouse.
    replacement_expected_date: date | None = None
    replacement_transporter_name: str | None = Field(default=None, max_length=200)
    replacement_vehicle_no: str | None = Field(default=None, max_length=50)
    replacement_lr_no: str | None = Field(default=None, max_length=50)

    # --- WE_COLLECT only ---
    #: Where our vehicle goes. Required on a collection: "come and collect it" with no
    #: address is not an instruction anybody can act on.
    replacement_pickup_address: str | None = Field(default=None, max_length=500)
    #: When it can be collected — ready on THEIR dock, not arriving at ours.
    replacement_ready_date: date | None = None

    # --- WHAT IS IN THE CARTON, per line. Belongs to neither leg: the batch and expiry
    # --- of the replacement goods are the same facts whether they drive them here or we
    # --- fetch them. See `VendorReplacementLineIn` for why this is asked at all.
    replacement_lines: list[VendorReplacementLineIn] = []

    @model_validator(mode="after")
    def _reason_required_when_goods_come_back(self):
        if self.response.value in VENDOR_RETURN_INBOUND_RESPONSES:
            if not (self.remarks or "").strip():
                raise ValueError(
                    "Say why the goods are coming back — the warehouse receiving them "
                    "has nothing else to go on.")
        return self

    @model_validator(mode="after")
    def _shipment_belongs_to_a_replacement(self):
        """The travel facts are a replacement's, and each leg accepts only its own.

        Refused on every other answer for the same reason `refund_amount` is: a vehicle
        number stored against a refund would show on the store's receiving screen as an
        expected delivery that is never coming, and against a RETURNED consignment it
        would claim to describe a lorry WE booked rather than theirs.

        ACROSS the two legs the refusal matters just as much, and is the reason this is
        not four optional fields the store can sort out later. A collection carrying an
        arrival date would be the supplier promising when goods THEY are not moving reach
        us, and the receiving queue would wait at the gate for it; a delivery carrying a
        pickup address would send a vehicle to fetch something already on its way here.
        Both are a wasted journey, so both are rejected at the edge rather than stored
        and reconciled by whoever notices.
        """
        replacing = self.response is VendorReturnResponse.REPLACED
        named = [f for f in REPLACEMENT_DELIVERY_FIELDS + REPLACEMENT_COLLECTION_FIELDS
                 if getattr(self, f) is not None]

        if not replacing:
            if named or self.replacement_mode is not None or self.replacement_lines:
                raise ValueError(
                    "Replacement shipment details only belong on a replacement. "
                    "Choose the replacement answer, or leave them out.")
            return self

        # One entry per line, and no line named twice. A repeated `line_no` is a client
        # bug, and taking the last one silently would write a batch nobody chose onto
        # stock — refused rather than resolved, exactly as `_apply_receipt_lines` refuses
        # the same item and batch twice on one GRN.
        seen = {line.line_no for line in self.replacement_lines}
        if len(seen) != len(self.replacement_lines):
            raise ValueError(
                "Each line of the return can carry only one batch. One of them was "
                "answered twice.")

        mode = (self.replacement_mode or "").strip().upper()
        valid = {v for v, _, _ in INBOUND_TRANSPORT_MODES}
        if mode not in valid:
            raise ValueError(
                "Say who is moving the replacement — whether you are sending it to us "
                "or we should collect it from you.")
        self.replacement_mode = mode

        delivering = mode in INBOUND_MODES_ARRIVING
        wrong = [f for f in (REPLACEMENT_COLLECTION_FIELDS if delivering
                             else REPLACEMENT_DELIVERY_FIELDS)
                 if getattr(self, f) is not None]
        if wrong:
            raise ValueError(
                "Those details belong to the other kind of journey. A delivery states "
                "when it reaches us and who is carrying it; a collection states where "
                "to collect from and when it is ready.")

        if delivering:
            if self.replacement_expected_date is None:
                raise ValueError(
                    "Say when the replacement will reach us — the warehouse has to know "
                    "what date to expect it.")
            if self.replacement_expected_date < ist_today():
                raise ValueError(
                    "The expected date is in the past. Give the date the replacement "
                    "will actually reach us.")
            return self

        if not (self.replacement_pickup_address or "").strip():
            raise ValueError(
                "Say where we should collect from — an address is the whole instruction "
                "the vehicle is sent on.")
        self.replacement_pickup_address = self.replacement_pickup_address.strip()
        if self.replacement_ready_date is None:
            raise ValueError(
                "Say when the goods will be ready to collect, so a vehicle is not sent "
                "before they are packed.")
        if self.replacement_ready_date < ist_today():
            raise ValueError(
                "The ready date is in the past. Give the date the goods will actually "
                "be ready to collect.")
        return self

    @model_validator(mode="after")
    def _amount_belongs_to_a_refund_and_only_a_refund(self):
        refunding = self.response.value in VENDOR_RETURN_REFUND_RESPONSES
        if refunding and self.refund_amount is None:
            raise ValueError(
                "Say how much you are refunding — a refund with no amount on it tells "
                "the buyer nothing they did not already know.")
        if not refunding and self.refund_amount is not None:
            raise ValueError(
                "A refund amount only belongs on a refund. Choose the refund answer, "
                "or leave the amount out.")
        return self


# --- The dossier: every document behind a purchase return, and everything that
# --- has happened to it. Read-only, served in one call.

class LinkedDocumentOut(BaseModel):
    """One document on the trail, in the shape every row is rendered from.

    Deliberately uniform — `doc_type` names what it is and the screen renders one row
    for all of them rather than branching per kind. `facts` is an ordered list of
    label/value pairs the SERVER chose, so adding a fact to the GRN row later is a
    backend change and not a frontend one.
    """
    #: INDENT | REQUISITION | RFQ | QUOTATION | PO | GRN | QC | BRANCH_RETURN |
    #: TRANSPORT_REQUEST | PURCHASE_RETURN | DISPATCH | CREDIT_NOTE
    doc_type: str
    doc_label: str
    doc_id: int | None = None
    doc_no: str | None = None
    status: str | None = None
    #: Named `doc_date` and not `date`: a field called `date` in a Pydantic class body
    #: shadows the imported `date` type and the annotation beside it stops resolving.
    doc_date: date | None = None
    party: str | None = None
    #: Ordered [label, value] pairs. A list rather than a dict so the order is the
    #: server's and survives JSON.
    facts: list[list[str]] = []
    #: Which half of the story this belongs to: how it was BOUGHT, how it came BACK,
    #: or the return itself. The screen groups on this.
    leg: str = "PURCHASE"
    #: True where the row was READ off the trail rather than named by the document —
    #: evidence, not a binding. See `service._trace_purchase_source`.
    traced: bool = False
    #: Where this document lives in the app, relative. Null where the module has no
    #: detail route for it, and the row then renders unclickable rather than 404-ing.
    route: str | None = None


class TimelineEventOut(BaseModel):
    """One thing that happened, on one document, to one person's name."""
    at: datetime | None = None
    #: The table it happened on — `pro_returns`, `inv_sto`, `lgs_transport_requests`.
    entity: str
    doc_no: str | None = None
    #: CREATE | UPDATE | APPROVED | REJECTED | … as recorded, never re-derived.
    action: str
    title: str
    detail: str | None = None
    actor_name: str | None = None
    #: DRAFT / PENDING_APPROVAL / … where this event moved the document's status.
    status_to: str | None = None


class PurchaseReturnJourneyLeg(BaseModel):
    """One leg of the twelve-leg tracker, as the server decided it.

    The whole flow is SERVED — which legs exist, what each is called, which one the
    document is standing on and what it says — for the reason every other catalogue in
    this module is served: a screen that re-derived the ladder from a status string would
    be a second copy of it, free to drift from the guards that actually enforce it.
    """
    #: `created` | `sent_to_vendor` | `vendor_decision` | `settlement` | `transport` |
    #: `vendor_received` | `replacement_dispatched` | `warehouse_received` | `grn` |
    #: `qc` | `putaway` | `closed`
    key: str
    label: str
    #: `completed` | `current` | `pending` | `rejected` | `cancelled`. A leg a particular
    #: return will never reach (a refund never travels) reads `cancelled` with a caption
    #: saying why, rather than sitting at `pending` as though somebody still owed it.
    state: str
    at: datetime | None = None
    #: Who did it — an employee's name, or the vendor's on a rung they answered.
    actor_name: str | None = None
    #: What was said: the remark recorded, or the sentence for a leg with nothing to do.
    detail: str | None = None
    #: The document number this leg produced, where it produced one — the consignment,
    #: the transport leg, the dispatch note, the credit note.
    reference_no: str | None = None


class PurchaseReturnDossierOut(BaseModel):
    """The whole paper trail behind one purchase return, its history, and its journey.

    One call, because the question a reader has in front of a DRAFT they did not raise
    is a single question — "where did this come from and what has happened to it" — and
    answering it out of six modules is how it went unanswered.
    """
    return_id: int
    return_no: str
    documents: list[LinkedDocumentOut] = []
    timeline: list[TimelineEventOut] = []
    #: Said plainly rather than left for the reader to infer from an empty list.
    trail_note: str | None = None
    #: The twelve-leg tracker. On this call rather than an endpoint of its own: the detail
    #: screen already fetches the dossier, and two round trips for facts drawn off one row
    #: is two chances for them to disagree about where the document is.
    journey: list[PurchaseReturnJourneyLeg] = []
    #: Which leg it is standing on (1-based), and the sentence that says so.
    current_sequence: int = 1
    current_stage_message: str | None = None


# ---------------------------------------------------------------------------
# Supporting
# ---------------------------------------------------------------------------

class BatchRead(_Read):
    id: int
    batch_no: str
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_asset: bool = False
    vendor_id: int | None = None
    vendor_name: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    received_date: date | None = None
    grn_id: int | None = None
    grn_no: str | None = None
    initial_qty: Decimal
    rate: Decimal | None = None
    status: str
    recall_reason: str | None = None


class SerialRead(_Read):
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    is_asset: bool = False
    #: The package (box / strip) the unit sits in, if any (2026-10-26).
    package_code: str | None = None
    package_name: str | None = None
    package_holds: float | None = None
    serial_number: str
    imei: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    bin_id: int | None = None
    bin_code: str | None = None
    bin_floor_level: int | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    status: str
    remarks: str | None = None
    is_active: bool


class AttachmentRead(_Read):
    id: int
    entity_type: str
    entity_id: int
    file_name: str
    file_path: str
    file_size: int | None = None
    mime_type: str | None = None
    doc_category: str | None = None
    uploaded_by_id: int | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None


class NotificationRead(_Read):
    id: int
    employee_id: int
    title: str
    body: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    deep_link: str | None = None
    is_read: bool
    created_at: datetime | None = None


class ScanLine(BaseModel):
    """One item inside whatever was scanned."""
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: Decimal = Decimal(0)
    batch_no: str | None = None
    serial_no: str | None = None
    package_no: str | None = None
    # What the floor asked a scan to read out: the batch's expiry and the code minted
    # for the physical unit. Both are already carried by the consignment line
    # (`unit_code` is looked up beside it), so nothing new is stored for this.
    imei_no: str | None = None
    expiry_date: date | None = None
    unit_code: str | None = None


class ScanPackage(BaseModel):
    """One carton of a scanned consignment."""
    id: int
    package_no: str
    barcode: str | None = None
    package_type: str | None = None
    status: str | None = None
    item_count: int = 0
    quantity: Decimal = Decimal(0)
    weight_kg: Decimal | None = None
    is_fragile: bool = False
    is_temp_controlled: bool = False


class ScanResult(BaseModel):
    """What a scanned code turned out to be.

    Everything past `deep_link` is what the label is *for*: scan a consignment and
    the answer is the cartons it holds, scan a carton and the answer is what is
    inside it. The fields are optional so a bin or a serial scan stays as terse as
    it was, and so an older client reading only `kind`/`deep_link` is unaffected.
    """
    kind: str
    id: int
    doc_no: str | None = None
    deep_link: str | None = None

    title: str | None = None
    subtitle: str | None = None
    status: str | None = None
    meta: list[dict[str, str | None]] = []
    packages: list[ScanPackage] = []
    items: list[ScanLine] = []
    package_count: int = 0
    item_count: int = 0
    total_qty: Decimal = Decimal(0)


class Option(BaseModel):
    id: int
    code: str | None = None
    name: str
    is_bin_managed: bool | None = None
    # Only warehouse options carry this. It tells a form whether it is standing at a
    # main store or at an MDP / LIP, which is what decides the shape of the GRN.
    warehouse_type: str | None = None


class LocationOption(Option):
    """A storage location, offered with the whole route to it.

    A bin code alone is unusable on a floor: `F1-A1-R1-B2` and `F1-A1-R2-B2` are one
    character apart and thirty metres apart. `steps` is the walk — floor, lane, rack,
    shelf, bin — so a picker can draw the hierarchy instead of asking somebody to
    decode it, and `path` / `path_names` are the same thing already joined for the
    places that only have room for a line of text.
    """
    bin_type: str | None = None
    is_pickable: bool = True
    path: str | None = None
    path_names: str | None = None
    steps: list[LocationStep] = []


class ItemOption(Option):
    uom_code: str | None = None
    # How many decimal places this item's unit allows — 0 for a whole-unit UOM.
    # Lets the issue form refuse a typed fraction before save (SCM_0080).
    qty_decimals: int | None = None
    is_batch_tracked: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    has_expiry: bool = False
    is_asset: bool = False
    requires_qi: bool = False
    # What the named stocking point can give of this item, and how far it is spread —
    # `null` on every caller that names no point, which is "nobody asked" and must not
    # be drawn as "this point holds none". See `service.item_options`.
    on_hand: Decimal | None = None
    batch_count: int | None = None
    location_count: int | None = None


class IndentIssueSource(OrgScopeOut):
    indent_id: int
    indent_no: str
    warehouse_id: int
    department_id: int | None = None
    department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    # True when some reserved stock was received for a different project (or for
    # none). Informational: the screen says so, nothing blocks the issue.
    mixed_projects: bool = False
    issued_to_id: int | None = None
    # Carried beside the id because the employee dropdown holds only its first page:
    # without the name the form has a value it cannot label, and shows a placeholder.
    issued_to_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    destination_office_sac: str | None = None
    #: Only an LIP runs a vehicle and carries an SAC; None when no point resolves.
    destination_needs_vehicle_and_sac: bool | None = None
    items: list[IssueItemWrite] = []


class EmployeeDestination(BaseModel):
    """Where a direct issue is headed when it names a person, not an indent.

    The same office/SAC/vehicle answer `indent_issue_source` serves for an
    indent, read off the employee instead: the destination office is the
    employee's own office, the SAC is that office's code from HCM, and the
    vehicle is the registration the office name carries, if any. Served so the
    form can fill Destination / SAC / Vehicle the moment Issued-to is picked,
    instead of leaving them blank on every issue raised without an indent.
    """
    issued_to_id: int
    issued_to_name: str | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    destination_office_sac: str | None = None
    vehicle_number: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None


class PickingIssueSource(BaseModel):
    picking_id: int
    warehouse_id: int
    indent_id: int | None = None
    department_id: int | None = None
    department_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    mixed_projects: bool = False
    issued_to_id: int | None = None
    issued_to_name: str | None = None
    vehicle_id: int | None = None
    vehicle_number: str | None = None
    items: list[IssueItemWrite] = []


class IssueDispatchSourceItem(DispatchItemWrite):
    indent_no: str | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    # Snapshotted on the issue line, not re-derived downstream — see
    # `out_dispatch_items.mfg_date` for why the consignment carries them itself.
    mfg_date: date | None = None
    expiry_date: date | None = None
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    # SERIAL / IMEI / ASSET / CONSUMABLE / NONE — what the codes on this row are.
    tracking_type: str | None = None
    # Whether this line went through outward QC, or out without needing it.
    requires_qc: bool = False
    serial_numbers: list[str] = []
    # serial -> IMEI, so the packing screen shows the handset's number beside the
    # unit it belongs to rather than making the receiving point retype it.
    imei_by_serial: dict[str, str] = {}
    # Issued in PACKAGES (2026-10-26): each package the line sends on and what it
    # carries after outward QC — {code, quantity}. A carton names which of them it
    # holds (in `serial_numbers`); no unit code per piece is asked for.
    box_codes: list[dict] = []
    # The packs this quantity travels in, read off the issue line (2026-10-22).
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None


class IssueDispatchSource(BaseModel):
    issue_id: int
    issue_ids: list[int] = []
    issue_no: str
    issue_nos: list[str] = []
    warehouse_id: int
    project_id: int | None = None
    destination_office_id: int | None = None
    destination_office_name: str | None = None
    destination_office_sac: str | None = None
    # The vehicle the goods go out on, derived from the issue or the destination
    # office's own name. Read-only on the form — nothing here picks a vehicle.
    vehicle_number: str | None = None
    # The stocking point serving the requesting office — what "To warehouse" defaults
    # to. Blank when that point IS the origin, which `destination_is_origin` explains.
    destination_warehouse_id: int | None = None
    destination_warehouse_name: str | None = None
    destination_is_origin: bool = False
    items: list[IssueDispatchSourceItem] = []


class RecommendedIssue(BaseModel):
    """One issue inside a suggested grouped consignment, as the card lists it."""
    issue_id: int
    issue_no: str
    issue_date: date | None = None
    indent_no: str | None = None
    mr_nos: list[str] = []
    item_lines: int = 0
    total_qty: Decimal = Decimal("0")


class ConsignmentRecommendation(BaseModel):
    """Issues that can travel together: same point out, same LIP/MDP in.

    `headline` and `reason` are served so every screen words a suggestion the same way.
    """
    key: str
    label: str
    headline: str = ""
    reason: str
    issue_ids: list[int]
    issue_nos: list[str]
    issues: list[RecommendedIssue] = []
    oldest_issue_date: date | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    destination_warehouse_id: int | None = None
    destination_warehouse_name: str | None = None
    destination_office_name: str | None = None
    total_qty: Decimal
    item_lines: int
    mr_nos: list[str] = []


class ReasonIn(BaseModel):
    """The body every cancel/skip endpoint takes."""
    reason: str | None = None


class ApprovalIn(BaseModel):
    comments: str = ""


class GatePassIn(BaseModel):
    gate_pass_no: str | None = None


class CreditNoteIn(BaseModel):
    credit_note_no: str | None = None


class AcknowledgeIssueIn(BaseModel):
    remarks: str | None = None


class DirectIssueAckLine(BaseModel):
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    issued_qty: Decimal = Decimal("0")


class DirectIssueConsignment(BaseModel):
    dispatch_id: int
    dispatch_no: str
    status: str | None = None
    package_count: int = 0


class DirectIssueAckRow(BaseModel):
    """A material issue raised against no indent, as its recipient sees it.

    Indent-linked issues are confirmed through the indent's own acknowledgement; a
    direct issue has no indent, so the person it was issued TO signs the issue itself.
    """
    issue_id: int
    issue_no: str
    issue_date: date | None = None
    status: str
    warehouse_name: str | None = None
    department_name: str | None = None
    project_name: str | None = None
    issued_by_name: str | None = None
    total_qty: Decimal = Decimal("0")
    acknowledged_by_name: str | None = None
    acknowledged_at: datetime | None = None
    can_acknowledge: bool = False
    lines: list[DirectIssueAckLine] = []
    #: The consignments carrying this issue, each with how many packages it holds.
    consignments: list[DirectIssueConsignment] = []


class StockTransferAckRow(DirectIssueAckRow):
    """A direct STO's issue arriving at the caller's point (2026-10-29): the receipt
    row on Inventory > Stock Transfer > Acknowledgements, with the order it executes."""
    sto_id: int | None = None
    sto_no: str | None = None
    from_warehouse_name: str | None = None
    to_warehouse_name: str | None = None


class IssueSerialLineIn(BaseModel):
    """One line's physical units, named after approval."""
    id: int
    serial_numbers: Annotated[list[str], SerialList] = Field(default_factory=list)


class IssueSerialsIn(BaseModel):
    """Serial capture on an approved, unposted issue.

    A draft is created by inventory when it approves an allocation, and inventory
    has no idea which physical units the storekeeper will pick. post_issue demands
    the full set, so without a way to name them after approval a serialized issue
    could never be posted at all.
    """
    lines: Annotated[list[IssueSerialLineIn], DocumentLines]

    @model_validator(mode="after")
    def _serial_budget(self):
        """One request may not carry more units than a worker should.

        The per-line cap is not enough on its own: IssueSerialsIn accepts up to
        MAX_DOCUMENT_LINES lines, each with up to MAX_SERIALS_PER_LINE
        serials, and that product is half a million units in one
        transaction -- the exact shape that locks the warehouse tables and
        runs past the proxy timeout."""
        assert_serial_budget(self, "lines")
        return self


class DashboardRead(BaseModel):
    """Queue depths, computed server-side so the screen makes one call."""
    pending_gate_entries: int = 0
    pending_grn: int = 0
    pending_inspections: int = 0
    pending_putaways: int = 0
    open_picklists: int = 0
    pending_issues: int = 0
    in_transit_dispatches: int = 0
    open_returns: int = 0
    stock_value: Decimal = Decimal("0")
    bin_utilisation_percent: Decimal = Decimal("0")
    recent: list[dict] = []
    inward_trend: list[dict] = []


class ReportColumn(BaseModel):
    key: str
    header: str
    numeric: bool = False


class ReportResult(BaseModel):
    """Reports carry their own columns, so a new report needs no frontend change."""
    columns: list[ReportColumn]
    rows: list[dict]
    total: int


BinRead.model_rebuild()


class IssueBatchIn(BaseModel):
    """The issues to post in one go — a whole monthly cycle, usually."""
    issue_ids: Annotated[list[int], BatchIds]


class DespatchPrefillLine(CombinationOut):
    """One line of what the vendor says they sent, ready to become a receipt line."""
    po_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: Decimal = Decimal("0")
    despatched_qty: Decimal = Decimal("0")
    rate: Decimal | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    # What the unit needs at the gate, off the item master (2026-10-21): without these
    # a prefilled line read as untracked and the serial/IMEI capture never appeared.
    is_asset: bool = False
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    # The supplier's packing, DECLARED and read-only on the receipt (2026-10-08).
    despatch_note_item_id: int | None = None
    pack_hierarchy_id: int | None = None
    pack_hierarchy_name: str | None = None
    pack_breakdown: list[dict] | None = None
    pack_text: str | None = None
    # When the supplier sent a different hierarchy from the order's: the buyer's
    # answer, so the gate knows before booking it in.
    pack_change_status: str | None = None
    ordered_pack_hierarchy_name: str | None = None
    pack_change_reason: str | None = None
    pack_change_note: str | None = None
    #: The count the receipt starts from: the declared packing, read inside what the
    #: order still owes when that is less.
    counted_pack_breakdown: list[dict] | None = None

    @model_validator(mode="after")
    def _describe_packing(self):
        if self.pack_breakdown and not self.pack_text:
            self.pack_text = describe_packs(self.pack_breakdown, self.uom_code)
        if not getattr(self, "pack_hierarchy_name", None):
            for src in (self.pack_breakdown,):
                name = next((e.get("hierarchy") for e in src or []
                             if e.get("hierarchy")), None)
                if name:
                    self.pack_hierarchy_name = name
                    break
        return self


class DespatchPrefill(BaseModel):
    """A vendor's despatch note in the shape the receipt form needs.

    Header and lines together: the paperwork and the cartons arrive as one act, and
    asking the gate for two round trips to describe one delivery is how a form ends up
    half-filled.
    """
    despatch_note_id: int
    despatch_note_no: str
    po_id: int | None = None
    po_no: str | None = None
    vendor_id: int | None = None
    vendor_name: str | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: Decimal | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    lines: list[DespatchPrefillLine] = []


class MovementOrderAction(BaseModel):
    """Approve or reject a stock movement waiting on a signature."""
    action: str
    comments: str = ""



class UnitCodeQuery(BaseModel):
    """Identities the caller already holds, asking what else each unit carries.

    A POST for a read, deliberately: one stock-ledger page can name a couple of
    thousand units, and a query string that long is refused by the proxy long before
    it reaches us.
    """
    codes: list[str] = Field(default_factory=list)


class ItemLocationBatch(BaseModel):
    stock_id: int
    batch_id: int
    batch_no: str | None = None
    expiry_date: date | None = None
    days_to_expiry: int | None = None
    available_qty: float
    reserved_qty: float
    total_qty: float
    project_name: str | None = None
    serial_number: str | None = None
    asset_code: str | None = None


class ItemLocation(BaseModel):
    bin_id: int
    bin_code: str
    location_path: list[str]
    total_available: float
    total_reserved: float
    total_on_hand: float
    batches: list[ItemLocationBatch]


class ItemLocationsOut(BaseModel):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    total_available: float
    total_reserved: float
    total_on_hand: float
    locations: list[ItemLocation]


# --------------------------------------------------------------------------- #
# Stock by storage location, as a download (`warehouse/stock_report.py`)
# --------------------------------------------------------------------------- #

class StockReportScopeOption(BaseModel):
    """One of the two downloads, already counted.

    Every string on it is composed by the service, so the button and the file it
    produces cannot describe the same scope differently.
    """
    key: str                       #: LOCATION | HIERARCHY
    title: str                     #: "Only F1 — Ground floor"
    sentence: str                  #: the same line the file's header block prints
    hint: str                      #: why you would pick this one, or must not
    locations_in_scope: int        #: locations the scope covers, stock or no stock
    locations: int                 #: of those, how many actually hold something
    items: int
    rows: int
    total_qty: Decimal
    is_empty: bool
    #: True when this location has nothing inside it, so both scopes are one file.
    same_as_other: bool
    recommended: bool


class StockReportScopes(BaseModel):
    """`GET /stock-segregation/report/scopes` — what each download would contain.

    Asked BEFORE anything is downloaded, because "the Floor 1 report" means two
    different files and the counts are what make the difference visible.
    """
    warehouse_id: int
    warehouse_name: str | None = None
    location_id: int | None = None
    location_code: str | None = None
    location_name: str | None = None
    location_label: str
    location_kind: str | None = None
    location_path: list[str] = Field(default_factory=list)
    depth: int = 0
    child_count: int = 0
    descendant_count: int = 0
    item_filter: int | None = None
    #: The person only sees the floors they are assigned; another may pull more.
    floor_restricted: bool = False
    row_cap: int
    options: list[StockReportScopeOption] = Field(default_factory=list)


# Forward references: LocationOccupancy names CapacityGate/OccupancyLine and
# PutawayRead names HandlingUnit, all declared after them.
LocationOccupancy.model_rebuild()
PutawayRead.model_rebuild()


# ---------------------------------------------------------------------------
# Stock corrections (2026-10-01) — see stock_edits.py
# ---------------------------------------------------------------------------

class StockEditItemRow(BaseModel):
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    is_serial_tracked: bool = False
    is_imei_tracked: bool = False
    is_asset: bool = False
    is_batch_tracked: bool = False
    has_expiry: bool = False
    qty: float = 0
    unit_count: int = 0
    batch_count: int = 0


class StockEditUnitRow(BaseModel):
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    serial_number: str | None = None
    imei: str | None = None
    asset_code: str | None = None
    consumable_code: str | None = None
    lot_no: str | None = None
    status: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    batch_qty: float | None = None
    pending_edit_no: str | None = None


class StockEditBatchRow(BaseModel):
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    qty: float = 0
    grn_no: str | None = None
    pending_edit_no: str | None = None


class StockEditLineIn(BaseModel):
    target_type: Literal["BATCH", "UNIT"]
    target_id: int
    # {field: new value}. The old value is read by the server, never sent.
    changes: dict[str, str | None] = Field(max_length=10)


class StockEditIn(OrgScopeIn):
    warehouse_id: int
    reason: str = Field(max_length=500)
    remarks: str | None = None
    lines: Annotated[list[StockEditLineIn], DocumentLines]


class StockEditDecisionIn(BaseModel):
    remarks: str | None = None


class StockEditItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    target_type: str
    batch_id: int | None = None
    serial_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    label: str | None = None
    changes: dict


class StockEditListRow(OrgScopeOut):
    model_config = ConfigDict(from_attributes=True)
    #: The project its number is drawn under (2026-11-11).
    project_id: int | None = None
    project_name: str | None = None
    id: int
    edit_no: str
    warehouse_id: int
    warehouse_name: str | None = None
    status: str
    reason: str
    created_by_id: int | None = None
    created_by_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    current_approver_name: str | None = None
    created_at: datetime


class StockEditRead(StockEditListRow):
    remarks: str | None = None
    items: list[StockEditItemRead] = Field(default_factory=list)
    can_act: bool = False


# ---------------------------------------------------------------------------
# Project lots (Stock Segregation > Project Lots)
# ---------------------------------------------------------------------------

class ProjectHoldCreate(BaseModel):
    stock_id: int
    project_id: int
    quantity: Decimal = Field(gt=0)
    # Optional: the exact units being held. One per unit held when given.
    serial_numbers: list[str] = Field(default_factory=list, max_length=1000)
    reason: str = Field(min_length=3, max_length=500)


class ProjectHoldRelease(BaseModel):
    # None releases everything still held.
    quantity: Decimal | None = Field(default=None, gt=0)
    serial_numbers: list[str] = Field(default_factory=list, max_length=1000)
    reason: str = Field(min_length=3, max_length=500)
    # Lend only: the project whose urgent need this lot now serves.
    for_project_id: int | None = None
    # Where the released stock is moved to — a release is a Stock Movement Order.
    destination_bin_id: int


class ProjectHoldRead(_Read):
    id: int
    hold_no: str
    stock_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    project_id: int
    project_name: str | None = None
    held_qty: Decimal
    quantity: Decimal
    serial_numbers: list[str] | None = None
    reason: str | None = None
    status: str
    created_by_name: str | None = None
    created_at: datetime | None = None
    released_by_name: str | None = None
    released_at: datetime | None = None
    release_reason: str | None = None
    released_for_project_name: str | None = None
    # A release in flight: the movement order carrying it, and what it moves where.
    release_order_no: str | None = None
    release_qty: Decimal | None = None
    release_destination: str | None = None
    pending_lend_project_name: str | None = None
    is_unit_tracked: bool = False


class ProjectHoldReleaseResult(BaseModel):
    hold: ProjectHoldRead
    order_no: str | None = None
    order_status: str | None = None


class ProjectLotHold(BaseModel):
    id: int
    hold_no: str
    project_id: int
    project_name: str | None = None
    quantity: Decimal
    serial_count: int = 0


class ProjectLotRead(BaseModel):
    stock_id: int
    # Every put-away lot that landed on this row (LOT/WH10/<path>/2026-27/00001).
    lot_nos: list[str] = []
    # Warehouse / floor / lane / rack / bin, walked up the location tree.
    location_path: str | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    warehouse_id: int
    warehouse_name: str | None = None
    bin_id: int | None = None
    bin_code: str | None = None
    batch_id: int | None = None
    batch_no: str | None = None
    expiry_date: date | None = None
    received_for_project: str | None = None
    total_qty: Decimal
    available_qty: Decimal
    reserved_qty: Decimal
    held_qty: Decimal
    holds: list[ProjectLotHold] = []
    is_unit_tracked: bool = False
    # Packing (2026-10-08): the balance row's project — part of its key — and how
    # the quantity is bagged, as a sentence and as the outermost packs.
    project_id: int | None = None
    pack_text: str | None = None
    packs: list[dict] = []
    loose_qty: Decimal | None = None
    pack_unreconciled: bool = False
    # Part packs here, and how many are under their level's minimum — allowed, but
    # flagged until somebody repacks them (2026-10-11).
    pack_below_min: int = 0
    pack_part_packs: int = 0


class PackSummaryIn(BaseModel):
    """Which stock rows a screen wants the packing of — by `stk_balance` id."""
    stock_ids: Annotated[list[int], BatchIds]


class RepackIn(BaseModel):
    """How one stock row should be packed afterwards: a breakdown in ONE of the
    item's hierarchies, holding exactly what the row holds (loose included)."""
    pack_hierarchy_id: int
    target: Annotated[list[PackEntryIn], Field(min_length=1, max_length=12)]
    reason: str | None = Field(default=None, max_length=300)
