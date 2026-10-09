"""Smart Load Planner and consolidated (multi-drop) trips.

Ten consignments packed at the central warehouse used to leave as ten dispatches: ten
trucks, most of them driving the same highway half-empty. A trip is ONE vehicle that
carries several of them and drops each one at its own stocking point on the way.

How it fits the flow that already exists, and why it adds so little:

    pack consignments          (unchanged)
    Smart Load Planner         recommend which packed consignments share a road,
                               reserve them onto a trip, draft ONE shipment for it
    Dispatch                   the SAME confirm screen, opened on that shipment:
                               mode, provider, tender, award — all unchanged
    release ("it has left")    the SAME press; every consignment on the trip gates
                               out behind it (`trip_shipment_released`)
    each stop                  the desk — or the carrier, from their portal — marks
                               it delivered; those consignments read DELIVERED
                               (`_deliver_stop`, one core behind both doors)
    each site                  signs for ITS consignment on its own Acknowledgements
                               screen (unchanged); the trip rolls up from those
                               signatures and closes itself once every stop has signed

So the only NEW decision is the planner's, and everything a shipment already knows —
pricing, the carrier portal, the gate pass, claims, the activity ledger — is reused
through the one transport request the trip raises. Nothing here re-implements it.

Rules that fail SILENTLY if narrowed:

* A consignment is on at most one ACTIVE trip, and a consignment on one is refused a
  dispatch of its own (`transport.dispatch_consignment`). Two shipments for one pallet
  is two trucks and two gate-outs.
* A trip's shipment is never signed for as a whole (`transport.acknowledge_tr`). Four
  sites received four different consignments; each signs for its own.
* Stop and trip status are ROLLED UP from the consignments (`_roll_up`), never set by
  hand. The consignment's own status on `out_dispatches` is the truth; the trip's
  columns are a cache of it for logistics' lists, re-derived on every read.
* The planner warns and explains; it never decides. Which consignments go on which
  truck is the desk's call, made on the screen, with the reasons in front of them.

**Distances** come from `logistics.routing`: road kilometres from a routing service
where one is configured (cached per pair), and an estimate — straight line times a
road factor, calibrated from routed pairs where there are enough — for the rest. Every
plan carries its `distance_basis` (ROAD, MIXED, ESTIMATE) and says it on screen.

**Load** is weight AND volume, each carried with the basis it was known on:

    WEIGHED / MEASURED   every package on the consignment was weighed / measured
    ESTIMATED            derived from the items' own packing ladders (`capacity`)
    ASSUMED              packages x the site's typical-carton assumption
    (none)               nothing known — counted as nothing, and said out loud

Only FIRM figures (weighed, measured) can refuse a trip: an estimate that says the
truck is over is a warning to go and weigh it, not a reason to stop a load the desk
can see fits. The planner's own grouping uses the whole figure, so it never PROPOSES
a truck its own numbers say is over.
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.modules.logistics import hooks as lgs_hooks
from app.modules.logistics import routing
from app.modules.logistics import transport as lgs_transport
from app.modules.logistics.enums import (
    ACK_CLAIM_EVENT, ACTIVE_TRIP_STATUSES, DEPARTED_TRIP_STATUSES, TERMINAL_STATUSES,
    AckCondition, ShipmentEventType, TransportSource, TransportStatus, TripStatus,
    TripStopStatus,
)
from app.modules.logistics.models import (
    ConsolidatedTrip, ConsolidatedTripConsignment, ConsolidatedTripStop, ShipmentEvent,
    TransportRequest,
)
from app.modules.logistics.schemas import TRCreate
from app.modules.warehouse import capacity
from app.modules.warehouse import geocoding
from app.modules.warehouse import models as m
from app.modules.warehouse import service as svc
from app.modules.warehouse.enums import DispatchEventType, DispatchStatus
from app.modules.inventory.locations import (
    HCM_COORDINATE_SOURCE, apply_hcm_coordinates, office_geo_for,
)
from app.modules.inventory.service import warehouse_ids_for_user
from app.platform.settings.service import get_setting, set_setting, write_audit
from app.shared.enums import AuditAction
from app.shared.models.base import utcnow
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

#: Consignments the planner may put on a truck: packed (or approved and waiting at the
#: gate) and not yet gone. Anything further along is already on a road.
PLANNABLE_DISPATCH_STATUSES = (DispatchStatus.PACKED.value, DispatchStatus.APPROVED.value)

#: A shipment in any of these no longer holds a consignment: it was cancelled or
#: refused, so the consignment is free to be planned again.
DEAD_TRANSPORT_STATUSES = (TransportStatus.CANCELLED.value, TransportStatus.REJECTED.value)

#: Consignment statuses that mean "the truck has put it down at its stop".
_ARRIVED = (DispatchStatus.DELIVERED.value, DispatchStatus.ACKNOWLEDGED.value)

#: Load bases that count as KNOWN. Only these may refuse a trip.
FIRM_WEIGHT = "WEIGHED"
FIRM_VOLUME = "MEASURED"
ESTIMATED = "ESTIMATED"
ASSUMED = "ASSUMED"


# --------------------------------------------------------------------------- #
#  Planning policy — every number the recommendation uses, and where it comes from
# --------------------------------------------------------------------------- #
#
# Held in `sys_settings` under `logistics.trip_planner.*`, so a site tunes its own
# lanes without a release. The values below are only what an empty settings table
# falls back to, and every one of them can also be overridden per run on the screen.

SETTING_PREFIX = "logistics.trip_planner."

POLICY_DEFAULTS: dict[str, float | bool] = {
    "capacity_kg": 5000.0,
    # The cargo box, in cubic metres. 0 = the vehicle is not limited by volume.
    "capacity_cbm": 14.0,
    # How much of that box a load can actually use. Cartons do not tessellate, and a
    # truck packed to the roof on paper is 15% air in the yard.
    "volume_fill_pct": 85.0,
    "max_packages": 0.0,          # 0 = the vehicle is limited by weight alone
    "max_stops": 8.0,
    # How much LONGER than the straight run to the farthest drop a trip may become by
    # picking up the ones on the way. The rule behind "is it on the way".
    "max_detour_pct": 25.0,
    # A flat allowance on top, so two drops 3 km apart on the edge of town are not
    # refused because 25% of a 10 km run is only 2.5 km.
    "detour_floor_km": 15.0,
    "cost_per_km": 35.0,
    "road_factor": 1.22,
    # A hired truck comes back. Counting the empty return is what makes ten separate
    # dispatches cost what they really cost.
    "return_to_origin": True,
    # What one package is ASSUMED to weigh and occupy when nobody measured it. 0 turns
    # the assumption off (an unmeasured package then counts as nothing, and the plan
    # says so). A typical 50 x 40 x 30 cm carton of medical consumables.
    "default_package_kg": 12.0,
    "default_package_cbm": 0.06,
}

POLICY_LIMITS: dict[str, tuple[float, float]] = {
    "capacity_kg": (1, 100000), "capacity_cbm": (0, 500), "volume_fill_pct": (10, 100),
    "max_packages": (0, 100000), "max_stops": (1, 25),
    "max_detour_pct": (0, 300), "detour_floor_km": (0, 500),
    "cost_per_km": (0, 100000), "road_factor": (1, 3),
    "default_package_kg": (0, 2000), "default_package_cbm": (0, 20),
}

_BOOLEAN_KEYS = {"return_to_origin"}

#: What the vehicle picker offers when nobody has configured the fleet. A site's own
#: list replaces this entirely (`logistics.trip_planner.vehicle_profiles`, JSON). The
#: cargo boxes are the usual Indian bodies: Ace 7 ft, 407 9 ft, 14/20 ft trucks and a
#: 32 ft container, inside dimensions.
DEFAULT_VEHICLE_PROFILES = [
    {"code": "MINI", "label": "Mini truck · 750 kg", "capacity_kg": 750,
     "capacity_cbm": 4.3, "max_packages": 40, "cost_per_km": 18},
    {"code": "LCV", "label": "LCV (407) · 2.5 t", "capacity_kg": 2500,
     "capacity_cbm": 8.4, "max_packages": 120, "cost_per_km": 26},
    {"code": "MCV", "label": "14 ft truck · 4 t", "capacity_kg": 4000,
     "capacity_cbm": 14.3, "max_packages": 220, "cost_per_km": 32},
    {"code": "HCV20", "label": "20 ft truck · 7 t", "capacity_kg": 7000,
     "capacity_cbm": 27.7, "max_packages": 380, "cost_per_km": 40},
    {"code": "HCV32", "label": "32 ft container · 15 t", "capacity_kg": 15000,
     "capacity_cbm": 58.0, "max_packages": 800, "cost_per_km": 55},
]


@dataclass(frozen=True)
class Policy:
    capacity_kg: float
    capacity_cbm: float
    volume_fill_pct: float
    max_packages: int
    max_stops: int
    max_detour_pct: float
    detour_floor_km: float
    cost_per_km: float
    road_factor: float
    return_to_origin: bool
    default_package_kg: float
    default_package_cbm: float
    #: True when this run typed its own road factor: calibration never overrides it.
    road_factor_pinned: bool = False

    @property
    def usable_cbm(self) -> float:
        """The part of the cargo box a load can really fill. 0 = unlimited."""
        return self.capacity_cbm * self.volume_fill_pct / 100 if self.capacity_cbm else 0.0

    def as_dict(self) -> dict:
        return {
            "capacity_kg": self.capacity_kg, "capacity_cbm": self.capacity_cbm,
            "volume_fill_pct": self.volume_fill_pct, "usable_cbm": round(self.usable_cbm, 3),
            "max_packages": self.max_packages,
            "max_stops": self.max_stops, "max_detour_pct": self.max_detour_pct,
            "detour_floor_km": self.detour_floor_km, "cost_per_km": self.cost_per_km,
            "road_factor": self.road_factor, "return_to_origin": self.return_to_origin,
            "default_package_kg": self.default_package_kg,
            "default_package_cbm": self.default_package_cbm,
            "distance_basis": ("Estimated road km — straight-line distance between "
                               f"verified coordinates × {self.road_factor}"),
        }


def build_policy(base: dict, overrides: dict | None = None) -> Policy:
    """Merge a run's overrides onto the site's policy, clamped to sane bounds.

    Clamped rather than refused: a slider dragged to 0 kg is a typo, not a request
    for an error page, and the screen shows the value actually used.
    """
    merged = {**POLICY_DEFAULTS, **(base or {})}
    for key, value in (overrides or {}).items():
        if key in POLICY_DEFAULTS and value is not None:
            merged[key] = value

    def num(key: str) -> float:
        low, high = POLICY_LIMITS[key]
        try:
            value = float(merged[key])
        except (TypeError, ValueError):
            value = float(POLICY_DEFAULTS[key])
        if not math.isfinite(value):
            value = float(POLICY_DEFAULTS[key])
        return min(max(value, low), high)

    raw_return = merged.get("return_to_origin", True)
    returns = (raw_return if isinstance(raw_return, bool)
               else str(raw_return).strip().lower() in {"1", "true", "yes", "on"})
    return Policy(
        capacity_kg=num("capacity_kg"), capacity_cbm=num("capacity_cbm"),
        volume_fill_pct=num("volume_fill_pct"), max_packages=int(num("max_packages")),
        max_stops=int(num("max_stops")), max_detour_pct=num("max_detour_pct"),
        detour_floor_km=num("detour_floor_km"), cost_per_km=num("cost_per_km"),
        road_factor=num("road_factor"), return_to_origin=returns,
        default_package_kg=num("default_package_kg"),
        default_package_cbm=num("default_package_cbm"),
        road_factor_pinned=(overrides or {}).get("road_factor") is not None,
    )


def _valid_profile(row) -> bool:
    return isinstance(row, dict) and bool(row.get("label")) and bool(row.get("capacity_kg"))


async def planner_policy(db: AsyncSession) -> dict:
    """The site's planning defaults and fleet, as the screen needs them."""
    stored: dict = {}
    for key in POLICY_DEFAULTS:
        value = await get_setting(db, SETTING_PREFIX + key)
        if value is not None and value != "":
            stored[key] = value
    raw_profiles = await get_setting(db, SETTING_PREFIX + "vehicle_profiles")
    profiles = DEFAULT_VEHICLE_PROFILES
    if raw_profiles:
        try:
            parsed = json.loads(raw_profiles) if isinstance(raw_profiles, str) else raw_profiles
            if isinstance(parsed, list) and parsed and all(_valid_profile(row) for row in parsed):
                # A fleet saved before volume existed has no cargo box: 0 = not limited.
                profiles = [{"capacity_cbm": 0, "max_packages": 0, "cost_per_km": 0, **row}
                            for row in parsed]
        except (TypeError, ValueError):
            logger.warning("%svehicle_profiles is not valid JSON; using the defaults",
                           SETTING_PREFIX)
    policy = build_policy(stored)
    return {"policy": policy.as_dict(), "vehicle_profiles": profiles,
            "configured": sorted(stored),
            "routing": {"configured": routing.routing_configured()}}


async def save_planner_policy(db: AsyncSession, data, user) -> dict:
    """Store new site defaults. Only the keys sent are written."""
    policy = build_policy({}, data.model_dump(exclude_none=True, exclude={"vehicle_profiles"}))
    sent = data.model_dump(exclude_none=True)
    for key in POLICY_DEFAULTS:
        if key in sent:
            await set_setting(db, SETTING_PREFIX + key, getattr(policy, key),
                              value_type="boolean" if key in _BOOLEAN_KEYS else "number",
                              category="logistics")
    if data.vehicle_profiles is not None:
        await set_setting(db, SETTING_PREFIX + "vehicle_profiles",
                          json.dumps([row.model_dump() for row in data.vehicle_profiles]),
                          value_type="json", category="logistics")
    await write_audit(db, entity="sys_settings", entity_id=0,
                      entity_no="logistics.trip_planner", action=AuditAction.UPDATE,
                      actor=user, after=data.model_dump(mode="json", exclude_none=True),
                      summary="Updated Smart Load Planner defaults")
    await db.commit()
    return await planner_policy(db)


# --------------------------------------------------------------------------- #
#  The route maths — pure, and tested without a database
# --------------------------------------------------------------------------- #

def geo_km(a_lat, a_lon, b_lat, b_lon, road_factor: float = 1.0) -> float:
    """Estimated road km between two points: haversine × the road factor."""
    return routing.straight_km((a_lat, a_lon), (b_lat, b_lon)) * road_factor


def _matrix(policy: Policy, km) -> routing.DistanceMatrix:
    """The distance function a pure caller uses: the one it was handed, else the
    straight-line estimate at the policy's own factor."""
    return km if km is not None else routing.estimate_matrix(policy.road_factor)


_RUNG_SUFFIX = re.compile(r"\s*-\s*(?:LIP|MDP|MAIN)\s*$", re.I)


def place_name(name: str | None) -> str:
    """The name a person reads a stop BY: "Badangi", not
    "AP-104-MMU-Badangi-AP39UH4792 - LIP".

    Stocking points on the mobile-unit network are named for the programme, the
    unit, the village and the unit's vehicle registration all at once, and five of
    them in a row are unreadable — every one starts "AP-104-MMU-". The village is
    the part that tells a driver where to go, and it is what the gazetteer already
    extracts to place the point (`geocoding.locality_from_warehouse`), so the two
    can never disagree about which part of the label is the place. Anything that is
    not an operational MMU label keeps its own name, less a trailing rung. Display
    only: the full name and the code are always served beside it.
    """
    full = (name or "").strip()
    if re.search(r"\bMMU\b", full, re.I):
        village = geocoding.locality_from_warehouse(full)
        if village:
            return village.title()
    return _RUNG_SUFFIX.sub("", full) or full


@dataclass
class Drop:
    """One consignment as the planner sees it: where it goes and what it carries."""
    dispatch_id: int
    consignment_no: str
    destination_id: int
    destination_name: str
    lat: float
    lon: float
    packages: int = 0
    weight_kg: float = 0.0
    destination_code: str | None = None
    destination_type: str | None = None
    delivery_address: str | None = None
    expected_delivery: date | None = None
    indent_no: str | None = None
    project_name: str | None = None
    direct_km: float = 0.0
    #: The road home from this stop, when it differs from the road out. None = same.
    back_km: float | None = None
    volume_cbm: float = 0.0
    #: WEIGHED / ESTIMATED / ASSUMED / None — see the module docstring.
    weight_basis: str | None = None
    #: MEASURED / ESTIMATED / ASSUMED / None.
    volume_basis: str | None = None
    #: How many of its packages carry a weight / all three sides.
    packages_weighed: int = 0
    packages_measured: int = 0

    def __post_init__(self):
        # A drop built with a weight and no basis (a test, an old caller) is a weight
        # somebody recorded.
        if self.weight_basis is None and self.weight_kg > 0:
            self.weight_basis = FIRM_WEIGHT
        if self.volume_basis is None and self.volume_cbm > 0:
            self.volume_basis = FIRM_VOLUME

    @property
    def point(self) -> tuple[float, float]:
        return (self.lat, self.lon)

    @property
    def place(self) -> str:
        return place_name(self.destination_name)

    @property
    def weight_known(self) -> bool:
        return self.weight_basis is not None and self.weight_kg > 0

    @property
    def volume_known(self) -> bool:
        return self.volume_basis is not None and self.volume_cbm > 0

    @property
    def firm_weight_kg(self) -> float:
        return self.weight_kg if self.weight_basis == FIRM_WEIGHT else 0.0

    @property
    def firm_volume_cbm(self) -> float:
        return self.volume_cbm if self.volume_basis == FIRM_VOLUME else 0.0

    def as_dict(self) -> dict:
        return {
            "dispatch_id": self.dispatch_id, "consignment_no": self.consignment_no,
            "destination_warehouse_id": self.destination_id,
            "destination_code": self.destination_code,
            "destination_name": self.destination_name,
            "destination_place": self.place,
            "destination_type": self.destination_type,
            "delivery_address": self.delivery_address,
            "latitude": self.lat, "longitude": self.lon,
            "packages": self.packages, "weight_kg": round(self.weight_kg, 3),
            "weight_known": self.weight_known, "weight_basis": self.weight_basis,
            "volume_cbm": round(self.volume_cbm, 4), "volume_known": self.volume_known,
            "volume_basis": self.volume_basis,
            "packages_weighed": self.packages_weighed,
            "packages_measured": self.packages_measured,
            "expected_delivery": self.expected_delivery,
            "indent_no": self.indent_no, "project_name": self.project_name,
            "direct_km": round(self.direct_km, 1),
        }


def path_km(origin: tuple[float, float], order: list[tuple[float, float]],
            km, return_to_origin: bool) -> float:
    """Length of origin → each point in order (→ origin)."""
    route = [origin, *order] + ([origin] if return_to_origin and order else [])
    return sum(km(route[i], route[i + 1]) for i in range(len(route) - 1))


def order_stops(origin: tuple[float, float], stops: list[tuple[float, float]],
                km, return_to_origin: bool) -> list[int]:
    """The visiting order of `stops` (indexes into it) with the shortest km.

    Nearest-neighbour to start, then 2-opt until no swap shortens it. A trip is at
    most 25 stops, so this is exact enough and instant. Ties go to the order that puts
    the nearer stop first, so a closed loop is always driven outward-first.
    """
    n = len(stops)
    if n <= 1:
        return list(range(n))
    remaining, order, here = set(range(n)), [], origin
    while remaining:
        nxt = min(remaining, key=lambda i: (km(here, stops[i]), i))
        order.append(nxt)
        remaining.discard(nxt)
        here = stops[nxt]

    def length(seq: list[int]) -> float:
        return path_km(origin, [stops[i] for i in seq], km, return_to_origin)

    best, improved = length(order), True
    while improved:
        improved = False
        for i in range(n - 1):
            for j in range(i + 1, n):
                candidate = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                cand_len = length(candidate)
                if cand_len + 1e-9 < best:
                    order, best, improved = candidate, cand_len, True
    if return_to_origin:
        # A loop is the same length either way round on a symmetric road; drive the
        # nearer end first. On routed (directional) km, only if it is no longer.
        reverse = order[::-1]
        if km(origin, stops[reverse[0]]) < km(origin, stops[order[0]]) \
                and length(reverse) <= best + 1e-6:
            order = reverse
    return order


def _destinations(drops: list[Drop]) -> dict[int, tuple[float, float]]:
    seen: dict[int, tuple[float, float]] = {}
    for drop in drops:
        seen.setdefault(drop.destination_id, (drop.lat, drop.lon))
    return seen


def _route_len(origin, drops: list[Drop], policy: Policy, km) -> float:
    points = list(_destinations(drops).values())
    order = order_stops(origin, points, km, policy.return_to_origin)
    return path_km(origin, [points[i] for i in order], km, policy.return_to_origin)


def _separate_km(drop: Drop, policy: Policy) -> float:
    """What this consignment costs sent on its own truck: out, and back if it comes
    back — on the road back where that road is known."""
    if not policy.return_to_origin:
        return drop.direct_km
    return drop.direct_km + (drop.back_km if drop.back_km is not None else drop.direct_km)


def _corridor_km(members: list[Drop], policy: Policy) -> float:
    """The longest a trip may be and still count every drop on it as "on the way"."""
    farthest = max((drop.direct_km for drop in members), default=0.0)
    straight = farthest * (2 if policy.return_to_origin else 1)
    return straight * (1 + policy.max_detour_pct / 100) + policy.detour_floor_km


def _on_the_way(adds_km: float, drop: Drop, policy: Policy) -> bool:
    """Is the detour to `drop` small next to the truck it would otherwise need?

    Judged per DROP, not only per route: on a 400 km run a 60 km detour is 15% of the
    route and still the wrong way — Guntur on the Visakhapatnam truck. So calling at a
    drop may cost at most `max_detour_pct` of its own separate run, or the flat
    `detour_floor_km`, whichever is larger (a drop 5 km out of town is on everybody's
    way).
    """
    allowed = max(_separate_km(drop, policy) * policy.max_detour_pct / 100,
                  policy.detour_floor_km)
    return adds_km <= allowed + 1e-9


def _load(members: list[Drop]) -> dict:
    """What a set of consignments puts on the truck, firm and in total."""
    return {
        "weight": sum(drop.weight_kg for drop in members),
        "firm_weight": sum(drop.firm_weight_kg for drop in members),
        "volume": sum(drop.volume_cbm for drop in members),
        "firm_volume": sum(drop.firm_volume_cbm for drop in members),
        "packages": sum(drop.packages for drop in members),
    }


def _fits(members: list[Drop], extra: Drop, policy: Policy) -> str | None:
    """Why `extra` cannot join `members` on one vehicle, or None if it can.

    Judged on the WHOLE figure, estimates included: the planner must never propose a
    truck its own numbers say is over.
    """
    load = _load([*members, extra])
    if load["weight"] > policy.capacity_kg + 1e-9:
        return (f"the vehicle would carry {load['weight']:,.0f} kg of "
                f"{policy.capacity_kg:,.0f} kg")
    if policy.usable_cbm and load["volume"] > policy.usable_cbm + 1e-9:
        return (f"the load would take {load['volume']:,.2f} m³ of the "
                f"{policy.usable_cbm:,.2f} m³ that can be filled")
    if policy.max_packages and load["packages"] > policy.max_packages:
        return f"{load['packages']} packages would exceed {policy.max_packages}"
    stops = set(_destinations(members)) | {extra.destination_id}
    if len(stops) > policy.max_stops:
        return f"{len(stops)} stops would exceed the limit of {policy.max_stops}"
    return None


def _basis_counts(members: list[Drop], attr: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for drop in members:
        key = getattr(drop, attr) or "UNKNOWN"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _load_checks(members: list[Drop], policy: Policy) -> tuple[list[str], list[str]]:
    """(blockers, warnings) about what this truck carries.

    A BLOCKER is only ever raised on firm figures, or on counts nobody estimates
    (packages, stops). The same excess on estimated or assumed figures is a warning
    that says which consignments to go and weigh.
    """
    load = _load(members)
    blockers: list[str] = []
    warnings: list[str] = []
    if load["firm_weight"] > policy.capacity_kg + 1e-9:
        blockers.append(f"Over capacity: {load['firm_weight']:,.0f} kg weighed on a "
                        f"{policy.capacity_kg:,.0f} kg vehicle")
    elif load["weight"] > policy.capacity_kg + 1e-9:
        warnings.append(f"May be over capacity: about {load['weight']:,.0f} kg on a "
                        f"{policy.capacity_kg:,.0f} kg vehicle, counting estimated "
                        "weights — weigh the packages to be sure")
    if policy.usable_cbm:
        if load["firm_volume"] > policy.usable_cbm + 1e-9:
            blockers.append(f"Over volume: {load['firm_volume']:,.2f} m³ measured, "
                            f"{policy.usable_cbm:,.2f} m³ usable in the vehicle")
        elif load["volume"] > policy.usable_cbm + 1e-9:
            warnings.append(f"May not fit: about {load['volume']:,.2f} m³ against "
                            f"{policy.usable_cbm:,.2f} m³ usable, counting estimated "
                            "sizes — measure the packages to be sure")
    if policy.max_packages and load["packages"] > policy.max_packages:
        blockers.append(f"{load['packages']} packages is more than the vehicle's "
                        f"{policy.max_packages}")
    stops = len(_destinations(members))
    if stops > policy.max_stops:
        blockers.append(f"{stops} stops is more than the limit of {policy.max_stops}")

    unweighed = [drop.consignment_no for drop in members if not drop.weight_known]
    if unweighed:
        n = len(unweighed)
        warnings.append(f"{n} consignment{'s have' if n > 1 else ' has'} no recorded weight "
                        f"— capacity is counted without {'them' if n > 1 else 'it'}")
    guessed = [drop.consignment_no for drop in members
               if drop.weight_basis in (ESTIMATED, ASSUMED)
               or drop.volume_basis in (ESTIMATED, ASSUMED)]
    if guessed:
        n = len(guessed)
        warnings.append(f"{n} consignment{'s are' if n > 1 else ' is'} sized from "
                        "estimates, not from weighed and measured packages")
    if policy.usable_cbm:
        unsized = [drop.consignment_no for drop in members if not drop.volume_known]
        if unsized:
            n = len(unsized)
            warnings.append(f"{n} consignment{'s have' if n > 1 else ' has'} no known size "
                            f"— volume is counted without {'them' if n > 1 else 'it'}")
    return blockers, warnings


def evaluate_trip(origin: tuple[float, float], members: list[Drop], policy: Policy,
                  *, departure: date | None = None,
                  stop_order: list[int] | None = None, km=None) -> dict:
    """Everything the screen and the save need to know about one candidate trip.

    `stop_order` (destination ids) pins the visiting order the desk dragged into
    place; any destination it does not mention is appended in the optimised order.
    """
    km = _matrix(policy, km)
    dests = _destinations(members)
    ids = list(dests)
    optimal = [ids[i] for i in order_stops(origin, list(dests.values()), km,
                                           policy.return_to_origin)]
    if stop_order:
        pinned = [dest for dest in dict.fromkeys(stop_order) if dest in dests]
        order = pinned + [dest for dest in optimal if dest not in pinned]
    else:
        order = optimal

    stops, here, cumulative = [], origin, 0.0
    route_points = [origin]
    for sequence, dest in enumerate(order, 1):
        leg = km(here, dests[dest])
        cumulative += leg
        at_stop = [drop for drop in members if drop.destination_id == dest]
        first = at_stop[0]
        stops.append({
            "sequence": sequence, "destination_warehouse_id": dest,
            "destination_code": first.destination_code,
            "destination_name": first.destination_name,
            "destination_place": first.place,
            "destination_type": first.destination_type,
            "delivery_address": first.delivery_address,
            "latitude": first.lat, "longitude": first.lon,
            "distance_from_previous_km": round(leg, 1),
            "distance_basis": km.leg_basis(here, dests[dest]),
            "cumulative_km": round(cumulative, 1),
            "consignments": [drop.as_dict() for drop in at_stop],
            "total_packages": sum(drop.packages for drop in at_stop),
            "total_weight_kg": round(sum(drop.weight_kg for drop in at_stop), 3),
            "total_volume_cbm": round(sum(drop.volume_cbm for drop in at_stop), 4),
        })
        here = dests[dest]
        route_points.append(here)
    return_km = km(here, origin) if (policy.return_to_origin and stops) else 0.0
    if policy.return_to_origin and stops:
        route_points.append(origin)
    route_km = cumulative + return_km
    best_km = min(route_km, path_km(origin, [dests[dest] for dest in optimal], km,
                                    policy.return_to_origin)) if stops else 0.0

    # Why each stop is on this truck, in a sentence: what it costs the route to call
    # there. The difference between the route with it and without it.
    far = max(members, key=lambda drop: drop.direct_km) if members else None
    for stop in stops:
        dest = stop["destination_warehouse_id"]
        others = [drop for drop in members if drop.destination_id != dest]
        without = _route_len(origin, others, policy, km) if others else 0.0
        adds = max(0.0, route_km - without)
        stop["adds_km"] = round(adds, 1)
        if far and dest == far.destination_id:
            stop["reason"] = "Farthest drop — the trip is built around this run"
        elif adds < 1:
            stop["reason"] = f"Directly on the road to {far.place}" if far else ""
        else:
            stop["reason"] = (f"On the way to {far.place} — "
                              f"adds {adds:.1f} km to the run")

    baseline = sum(_separate_km(drop, policy) for drop in members)
    saving = max(0.0, baseline - route_km)
    load = _load(members)
    straight = (far.direct_km * (2 if policy.return_to_origin else 1)) if far else 0.0

    blockers, warnings = _load_checks(members, policy)
    if members and route_km > _corridor_km(members, policy) + 1e-6:
        warnings.append(f"The route is {((route_km / straight) - 1) * 100 if straight else 0:.0f}% "
                        f"longer than going straight to {far.place}")
    if departure:
        late = [drop.consignment_no for drop in members
                if drop.expected_delivery and drop.expected_delivery < departure]
        if late:
            warnings.append(f"Already past its expected delivery date: {', '.join(late)}")
    if members and saving <= 0:
        warnings.append("No distance is saved by combining these — dispatching them "
                        "separately costs the same or less")

    return {
        "kind": "MULTI_DROP" if len(stops) > 1 else "SAME_STOP",
        # Named for the FARTHEST drop — the run everything else rides along on. Not
        # the last stop: a round trip often comes home past the nearest one.
        "label": (f"{far.place} run" if len(stops) > 1
                  else f"{far.place} · one stop") if far else "",
        "stops": stops,
        "consignments": [drop.as_dict() for drop in members],
        "total_consignments": len(members),
        "total_packages": load["packages"],
        "total_weight_kg": round(load["weight"], 3),
        "firm_weight_kg": round(load["firm_weight"], 3),
        "total_volume_cbm": round(load["volume"], 4),
        "firm_volume_cbm": round(load["firm_volume"], 4),
        "weight_bases": _basis_counts(members, "weight_basis"),
        "volume_bases": _basis_counts(members, "volume_basis"),
        "capacity_utilisation_pct": round(load["weight"] / policy.capacity_kg * 100, 1)
        if policy.capacity_kg else 0.0,
        "volume_utilisation_pct": round(load["volume"] / policy.usable_cbm * 100, 1)
        if policy.usable_cbm else None,
        "package_utilisation_pct": round(load["packages"] / policy.max_packages * 100, 1)
        if policy.max_packages else None,
        "estimated_distance_km": round(route_km, 1),
        # The shortest order for the SAME stops, beside the one driven. Equal unless
        # the desk set the order by hand — then the screen can say, in km, what their
        # order costs, and offer the shorter one rather than silently replacing it.
        "optimal_order": optimal,
        "optimal_distance_km": round(best_km, 1),
        "order_is_optimal": route_km <= best_km + 0.05,
        "distance_basis": km.basis_of(route_points) if stops else "ESTIMATE",
        "return_km": round(return_km, 1),
        "separate_distance_km": round(baseline, 1),
        "estimated_saving_km": round(saving, 1),
        "estimated_cost": round(route_km * policy.cost_per_km, 2),
        "separate_cost": round(baseline * policy.cost_per_km, 2),
        "estimated_saving_amount": round(saving * policy.cost_per_km, 2),
        "saving_pct": round(saving / baseline * 100, 1) if baseline else 0.0,
        "vehicles_saved": max(0, len(members) - 1),
        "blockers": blockers,
        # Blockers are warnings too, first: the list the screen has always read is
        # complete on its own.
        "warnings": [*blockers, *warnings],
    }


def suggest_additions(origin, members: list[Drop], pool: list[Drop], policy: Policy,
                      limit: int = 12, *, km=None) -> list[dict]:
    """Other ready consignments, ranked by how little they add to THIS route.

    What the manifest builder offers under "also on the way": each with what it adds,
    what it would save against its own truck, and whether it still fits.
    """
    if not members:
        return []
    km = _matrix(policy, km)
    base = _route_len(origin, members, policy, km)
    taken = {drop.dispatch_id for drop in members}
    rows = []
    for drop in pool:
        if drop.dispatch_id in taken:
            continue
        adds = max(0.0, _route_len(origin, [*members, drop], policy, km) - base)
        saves = _separate_km(drop, policy) - adds
        blocked = _fits(members, drop, policy)
        rows.append({
            **drop.as_dict(), "adds_km": round(adds, 1),
            "saves_km": round(saves, 1),
            "saves_amount": round(saves * policy.cost_per_km, 2),
            "fits": blocked is None, "blocked_reason": blocked,
            "on_the_way": blocked is None and saves > 0 and _on_the_way(adds, drop, policy)
            and (base + adds) <= _corridor_km([*members, drop], policy),
        })
    rows.sort(key=lambda row: (not row["on_the_way"], not row["fits"], row["adds_km"]))
    return rows[:limit]


def next_stop_options(origin, members: list[Drop], order: list[int], pool: list[Drop],
                      policy: Policy, *, km=None) -> list[dict]:
    """Where the truck could go NEXT, for a desk building the route stop by stop.

    The manual builder APPENDS — "from the warehouse to Badangi, then Bapulapadu" — so
    the figure that matters is the leg from the last stop, not the cheapest insertion
    anywhere in the route that `suggest_additions` ranks by. One row per stocking
    point, never per consignment: a stop is a place the truck calls at, and every
    consignment for it rides together (the manifest can still take one off).

    `saves_km` is against ONE truck to that place, not one per consignment: that is
    what the desk would otherwise send, so the saving is never overstated. A row for
    a place already on the route carries its left-over consignments at no extra km.
    """
    km = _matrix(policy, km)
    points = _destinations(members)
    last_id = next((dest for dest in reversed(order) if dest in points), None)
    last = points[last_id] if last_id is not None else origin
    last_place = next((drop.place for drop in members if drop.destination_id == last_id), None)
    home_now = km(last, origin) if (policy.return_to_origin and members) else 0.0
    taken = {drop.dispatch_id for drop in members}
    groups: dict[int, list[Drop]] = {}
    for drop in pool:
        if drop.dispatch_id not in taken:
            groups.setdefault(drop.destination_id, []).append(drop)
    rows = []
    for dest, group in groups.items():
        first = group[0]
        already = dest in points
        if already:
            leg, adds = 0.0, 0.0
        else:
            leg = km(last, first.point)
            home = km(first.point, origin) if policy.return_to_origin else 0.0
            adds = max(0.0, leg + home - home_now)
        blocked = _fits([*members, *group[:-1]], group[-1], policy)
        saves = _separate_km(first, policy) - adds
        rows.append({
            "destination_warehouse_id": dest, "destination_place": first.place,
            "destination_name": first.destination_name,
            "destination_code": first.destination_code,
            "destination_type": first.destination_type,
            "latitude": first.lat, "longitude": first.lon,
            "dispatch_ids": [drop.dispatch_id for drop in group],
            "consignment_nos": [drop.consignment_no for drop in group],
            "packages": sum(drop.packages for drop in group),
            "weight_kg": round(sum(drop.weight_kg for drop in group), 3),
            "from_place": last_place,
            "from_last_km": round(leg, 1),
            "distance_basis": km.leg_basis(last, first.point) if not already else None,
            "adds_km": round(adds, 1), "saves_km": round(saves, 1),
            "saves_amount": round(saves * policy.cost_per_km, 2),
            "already_a_stop": already,
            "fits": blocked is None, "blocked_reason": blocked,
        })
    rows.sort(key=lambda row: (not row["already_a_stop"], not row["fits"],
                               row["from_last_km"], row["destination_warehouse_id"]))
    return rows


#: How many of the farthest unassigned consignments are tried as the anchor of the
#: next trip. Every one of them would be exact; forty keeps a hundred-consignment
#: morning well under a second and has never changed a plan in practice, because the
#: best anchor is always one of the long runs.
ANCHOR_CANDIDATES = 40


def _grow(anchor: Drop, pool: list[Drop], origin, policy: Policy, km):
    """The trip `anchor` would lead: others join cheapest-first while each (a) fits
    the vehicle, (b) costs the route less than its own truck, (c) is a small detour
    next to that truck (`_on_the_way`) and (d) keeps the whole run within the detour
    allowance of the straight run to the farthest drop. Cheapest insertion keeps
    this linear in the pool; `evaluate_trip` re-orders the result properly."""
    members = [anchor]
    route = [anchor.point]                        # visiting order, by insertion
    at_route = {anchor.destination_id}
    weight, volume, packages = anchor.weight_kg, anchor.volume_cbm, anchor.packages
    length = km(origin, route[0]) + (km(route[0], origin) if policy.return_to_origin else 0)
    while True:
        best = None
        for drop in pool:
            if drop is anchor or drop in members:
                continue
            if weight + drop.weight_kg > policy.capacity_kg + 1e-9:
                continue
            if policy.usable_cbm and volume + drop.volume_cbm > policy.usable_cbm + 1e-9:
                continue
            if policy.max_packages and packages + drop.packages > policy.max_packages:
                continue
            new_stop = drop.destination_id not in at_route
            if new_stop and len(at_route) + 1 > policy.max_stops:
                continue
            if new_stop:
                point = drop.point
                seq = [origin, *route] + ([origin] if policy.return_to_origin else [])
                slots = [(km(seq[i], point) + km(point, seq[i + 1]) - km(seq[i], seq[i + 1]), i)
                         for i in range(len(seq) - 1)]
                if not policy.return_to_origin:  # an open run may also end further on
                    slots.append((km(route[-1], point), len(route)))
                adds, slot = min(slots)
                adds = max(0.0, adds)
            else:
                adds, slot = 0.0, None
            if adds > 0 and adds >= _separate_km(drop, policy) - 1e-9:
                continue                          # cheaper on its own truck
            if not _on_the_way(adds, drop, policy):
                continue                          # a detour, not a drop on the way
            if length + adds > _corridor_km([*members, drop], policy) + 1e-9:
                continue                          # the whole run has grown too long
            score = (round(adds, 3), -drop.weight_kg, drop.dispatch_id)
            if best is None or score < best[0]:
                best = (score, drop, adds, slot)
        if best is None:
            break
        _, drop, adds, slot = best
        members.append(drop)
        weight += drop.weight_kg
        volume += drop.volume_cbm
        packages += drop.packages
        length += adds
        if slot is not None:
            route.insert(slot, drop.point)
            at_route.add(drop.destination_id)
    saving = sum(_separate_km(drop, policy) for drop in members) - length
    return members, saving


def recommend(origin: tuple[float, float], drops: list[Drop], policy: Policy, *,
              departure: date | None = None, km=None) -> dict:
    """Group every ready consignment into as few trucks as the road allows.

    Savings-first, and explainable. Each round, the farthest unassigned consignments
    are each tried as the ANCHOR of a trip (`_grow` says who could ride with it), and
    the trip that saves the most kilometres is committed. Repeat until nothing else
    combines. Taking the farthest run first and stopping there is not enough: a long
    run west would pick up two drops that sit much better on the run south, and the
    southern truck would leave half-empty.

    A consignment nothing else shares a road with is left as a single dispatch, with
    the reason, rather than forced onto a truck going elsewhere. Consignments for the
    same stocking point add no kilometres, so they always ride together while the
    vehicle has room.
    """
    km = _matrix(policy, km)
    unassigned = sorted(drops, key=lambda drop: (-drop.direct_km, drop.dispatch_id))
    trips, singles = [], []
    for drop in list(unassigned):
        reason = _fits([], drop, policy)
        if reason:
            singles.append({**drop.as_dict(), "reason": f"Too big for one vehicle: {reason}"})
            unassigned.remove(drop)
    while unassigned:
        best = None
        for anchor in unassigned[:ANCHOR_CANDIDATES]:
            members, saving = _grow(anchor, unassigned, origin, policy, km)
            if len(members) < 2:
                continue
            score = (round(saving, 3), len(members), anchor.direct_km)
            if best is None or score > best[0]:
                best = (score, members)
        if best is None:
            break
        members = best[1]
        for drop in members:
            unassigned.remove(drop)
        trips.append(evaluate_trip(origin, members, policy, departure=departure, km=km))
    for drop in unassigned:
        singles.append({**drop.as_dict(),
                        "reason": f"Nothing else ready is on the way to {drop.place}"})

    trips.sort(key=lambda plan: -plan["estimated_saving_amount"])
    for index, plan in enumerate(trips, 1):
        plan["key"] = f"T{index}"
    by_id = {drop.dispatch_id: drop for drop in drops}
    single_km = sum(_separate_km(by_id[row["dispatch_id"]], policy) for row in singles)
    baseline = sum(plan["separate_distance_km"] for plan in trips) + single_km
    planned = sum(plan["estimated_distance_km"] for plan in trips) + single_km
    saving = max(0.0, baseline - planned)
    return {
        "trips": trips,
        "singles": singles,
        "totals": {
            "consignments": len(drops),
            "vehicles_before": len(drops),
            "vehicles_after": len(trips) + len(singles),
            "separate_distance_km": round(baseline, 1),
            "planned_distance_km": round(planned, 1),
            "saving_km": round(saving, 1),
            "saving_amount": round(saving * policy.cost_per_km, 2),
            "saving_pct": round(saving / baseline * 100, 1) if baseline else 0.0,
        },
    }


# --------------------------------------------------------------------------- #
#  What a consignment weighs and occupies — measured, estimated or assumed
# --------------------------------------------------------------------------- #

def _package_box(package) -> Decimal | None:
    """One package's cube in m³, or None if any side is missing."""
    sides = [svc._d(package.length_cm), svc._d(package.width_cm), svc._d(package.height_cm)]
    if any(side <= ZERO for side in sides):
        return None
    return sides[0] * sides[1] * sides[2] / Decimal(1_000_000)


def measure_consignment(doc, packages: list, lines: list, ladders: dict,
                        policy: Policy) -> dict:
    """Weight and volume of one consignment, each with the basis it is known on.

    Pure. Order of trust, per figure:

    1. every package weighed / measured → WEIGHED / MEASURED. The warehouse's own
       record of the cartons on the floor.
    2. the items' packing ladders (`capacity.space_for`) → ESTIMATED, only when EVERY
       line resolves — an estimate of half the consignment is not an estimate of it.
    3. packages x the site's typical-carton assumption → ASSUMED, with any package that
       WAS measured counted at its real size.
    4. nothing → no basis, zero, and the plan says so.
    """
    count = len(packages) or int(doc.total_packages or 0)
    weighed = [svc._d(p.weight_kg) for p in packages if svc._d(p.weight_kg) > ZERO]
    boxes = [box for box in (_package_box(p) for p in packages) if box is not None]

    # --- weight
    weight, weight_basis = 0.0, None
    recorded = float(svc._d(doc.total_weight_kg))
    if packages and len(weighed) == len(packages):
        weight, weight_basis = float(sum(weighed, ZERO)), FIRM_WEIGHT
    elif not packages and recorded > 0:
        weight, weight_basis = recorded, FIRM_WEIGHT
    else:
        estimate = _ladder_total(lines, ladders, "weight")
        if estimate is not None and estimate > 0:
            weight, weight_basis = estimate, ESTIMATED
        elif count and policy.default_package_kg > 0:
            unweighed = count - len(weighed)
            weight = float(sum(weighed, ZERO)) + unweighed * policy.default_package_kg
            weight_basis = ASSUMED
        elif weighed:
            # Some weighed, no assumption configured: a lower bound, said as such.
            weight, weight_basis = float(sum(weighed, ZERO)), ASSUMED

    # --- volume
    volume, volume_basis = 0.0, None
    if packages and len(boxes) == len(packages):
        volume, volume_basis = float(sum(boxes, ZERO)), FIRM_VOLUME
    else:
        estimate = _ladder_total(lines, ladders, "volume")
        if estimate is not None and estimate > 0:
            volume, volume_basis = estimate, ESTIMATED
        elif count and policy.default_package_cbm > 0:
            unmeasured = count - len(boxes)
            volume = float(sum(boxes, ZERO)) + unmeasured * policy.default_package_cbm
            volume_basis = ASSUMED
        elif boxes:
            volume, volume_basis = float(sum(boxes, ZERO)), ASSUMED

    return {"weight_kg": weight, "weight_basis": weight_basis,
            "volume_cbm": volume, "volume_basis": volume_basis,
            "packages": count, "packages_weighed": len(weighed),
            "packages_measured": len(boxes)}


def _ladder_total(lines: list, ladders: dict, what: str) -> float | None:
    """Sum of `space_for` over every line, or None if any line cannot be sized."""
    if not lines:
        return None
    total = ZERO
    for line in lines:
        pack = capacity.choose_pack(ladders.get(line.item_id) or [])
        space = capacity.space_for(pack, line.quantity)
        value = space.get(what)
        if value is None:
            return None
        total += value
    return float(total)


async def _measures(db: AsyncSession, docs: list, policy: Policy) -> dict[int, dict]:
    """`measure_consignment` for many consignments in three queries."""
    ids = [doc.id for doc in docs]
    if not ids:
        return {}
    packages: dict[int, list] = {i: [] for i in ids}
    for row in (await db.execute(select(m.DispatchPackage)
                                 .where(m.DispatchPackage.dispatch_id.in_(ids)))).scalars():
        packages[row.dispatch_id].append(row)
    lines: dict[int, list] = {i: [] for i in ids}
    for row in (await db.execute(select(m.DispatchItem)
                                 .where(m.DispatchItem.dispatch_id.in_(ids)))).scalars():
        lines[row.dispatch_id].append(row)
    ladders = await capacity.pack_ladders(
        db, {line.item_id for rows in lines.values() for line in rows})
    return {doc.id: measure_consignment(doc, packages[doc.id], lines[doc.id], ladders, policy)
            for doc in docs}


async def consignment_packages(db: AsyncSession, dispatch_id: int, user) -> dict:
    """A consignment's packages as the measuring form needs them."""
    doc = await _plannable_for_measuring(db, dispatch_id, user, lock=False)
    policy = await _policy_for(db, None)
    rows = list((await db.execute(select(m.DispatchPackage)
                                  .where(m.DispatchPackage.dispatch_id == doc.id)
                                  .order_by(m.DispatchPackage.id))).scalars().all())
    return {"dispatch_id": doc.id, "consignment_no": doc.dispatch_no,
            "status": doc.status,
            "packages": [{"id": row.id, "package_no": row.package_no,
                          "package_type": row.package_type,
                          "weight_kg": row.weight_kg, "length_cm": row.length_cm,
                          "width_cm": row.width_cm, "height_cm": row.height_cm}
                         for row in rows],
            # What the planner will count this consignment as, and on what basis —
            # beside the cartons, so the form shows what a missing figure costs.
            "measures": (await _measures(db, [doc], policy))[doc.id]}


async def _plannable_for_measuring(db: AsyncSession, dispatch_id: int, user, *, lock: bool):
    stmt = select(m.Dispatch).where(m.Dispatch.id == dispatch_id)
    if lock:
        stmt = stmt.with_for_update()
    doc = (await db.execute(stmt)).scalar_one_or_none()
    if doc is None:
        raise NotFoundError(f"Consignment {dispatch_id} not found")
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and doc.warehouse_id not in allowed:
        raise PermissionError_("This consignment is outside your warehouse scope")
    return doc


async def record_measurements(db: AsyncSession, dispatch_id: int, data, user) -> dict:
    """Weigh and measure a packed consignment's packages from the planner.

    The planner is where a missing weight actually costs something — it is the one
    screen that has to decide whether the load fits — so it is where the desk may
    write it down, rather than being sent back to the packing screen. Only while the
    consignment is still waiting at the gate and not on a trip: a planned trip was
    costed and checked against the figures it had.
    """
    doc = await _plannable_for_measuring(db, dispatch_id, user, lock=True)
    if doc.status not in (*PLANNABLE_DISPATCH_STATUSES, DispatchStatus.DRAFT.value,
                          DispatchStatus.PENDING_APPROVAL.value):
        raise ValidationError(f"{doc.dispatch_no} is {doc.status.lower().replace('_', ' ')} "
                              "— its packages can no longer be re-measured here")
    on_trip = await db.scalar(
        select(ConsolidatedTrip.trip_no)
        .join(ConsolidatedTripConsignment,
              ConsolidatedTripConsignment.trip_id == ConsolidatedTrip.id)
        .where(ConsolidatedTripConsignment.dispatch_id == doc.id,
               ConsolidatedTrip.status.in_(ACTIVE_TRIP_STATUSES)).limit(1))
    if on_trip:
        raise ValidationError(f"{doc.dispatch_no} is planned on {on_trip}, which was "
                              "checked against its current figures. Cancel the trip to "
                              "re-measure it.")
    packages = {row.id: row for row in (await db.execute(
        select(m.DispatchPackage).where(m.DispatchPackage.dispatch_id == doc.id)
    )).scalars().all()}
    if not packages:
        raise ValidationError(f"{doc.dispatch_no} has no packages yet — pack it first, "
                              "then weigh the cartons")
    before, after = {}, {}
    for row in data.packages:
        package = packages.get(row.package_id)
        if package is None:
            raise ValidationError(f"Package {row.package_id} is not on {doc.dispatch_no}")
        before[package.package_no] = {k: str(getattr(package, k)) for k in
                                      ("weight_kg", "length_cm", "width_cm", "height_cm")}
        for key in ("weight_kg", "length_cm", "width_cm", "height_cm"):
            value = getattr(row, key)
            if value is not None:
                setattr(package, key, value)
        after[package.package_no] = {k: str(getattr(package, k)) for k in
                                     ("weight_kg", "length_cm", "width_cm", "height_cm")}
    doc.total_packages = len(packages)
    doc.total_weight_kg = sum((svc._d(p.weight_kg) for p in packages.values()), ZERO)
    await write_audit(db, entity="out_dispatches", entity_id=doc.id, entity_no=doc.dispatch_no,
                      action=AuditAction.UPDATE, actor=user, before=before, after=after,
                      summary=f"Weighed and measured {len(data.packages)} package(s) of "
                              f"{doc.dispatch_no} on the load planner")
    await db.commit()
    return await consignment_packages(db, doc.id, user)


# --------------------------------------------------------------------------- #
#  The map: every stocking point, with a position the planner can trust
# --------------------------------------------------------------------------- #

#: Bump when the matcher gets better: every point it once failed on is tried again,
#: once, on the next map read. A point it still cannot place stays unresolved.
GAZETTEER_VERSION_SETTING = SETTING_PREFIX + "gazetteer_version"


def _point(row: Warehouse) -> dict:
    return {
        "id": row.id, "code": row.code, "name": row.name,
        "warehouse_type": row.warehouse_type,
        "latitude": row.latitude, "longitude": row.longitude,
        "coordinate_source": row.coordinate_source,
        "coordinate_label": row.coordinate_label,
        "coordinate_confidence": row.coordinate_confidence,
    }


async def _office_hints(db: AsyncSession, warehouses: list[Warehouse]) -> dict[int, dict]:
    """What HCM says about where each office is: GPS, village, mandal, district."""
    return await office_geo_for(db, {row.office_id for row in warehouses if row.office_id})


def _hint_tuple(row: Warehouse, hints: dict[int, dict]) -> tuple:
    hint = hints.get(row.office_id) or {}
    return (row.name, hint.get("district") or "", hint.get("location"), hint.get("mandal"))


def _unresolve(row: Warehouse) -> None:
    row.latitude = row.longitude = None
    row.coordinate_source = "GAZETTEER_UNRESOLVED"
    row.coordinate_label = geocoding.locality_from_warehouse(row.name) or None
    row.coordinate_confidence = None


def _place(row: Warehouse, match) -> None:
    row.latitude = Decimal(str(round(match.latitude, 7)))
    row.longitude = Decimal(str(round(match.longitude, 7)))
    row.coordinate_source = "GEONAMES_LOCALITY"
    row.coordinate_label = match.label[:200]
    row.coordinate_confidence = Decimal(str(match.confidence))


async def _match_points(db: AsyncSession, rows: list[Warehouse],
                        hints: dict[int, dict]) -> dict:
    """Run the gazetteer over `rows`. A MANUAL pin is never passed in.

    A row with an EARLIER automatic match is re-checked, not just re-matched: a
    confident answer today replaces it (and says how far it moved); where today's
    matcher declines, the old point is kept only if it is still `plausible` — a place
    of that name in the office's own district is right there — and withdrawn to "pin
    me" otherwise, because a point drawn in the wrong district routes a truck there.
    """
    counts = {"tried": len(rows), "mapped": 0, "moved": 0, "kept": 0, "withdrawn": 0,
              "unresolved": 0}
    moved, withdrawn = [], []
    try:
        matches = await geocoding.resolve_many([_hint_tuple(row, hints) for row in rows])
    except Exception:   # the gazetteer is a convenience; its absence is not an error
        logger.exception("Gazetteer lookup failed for %d points", len(rows))
        return counts
    doubtful: list[Warehouse] = []
    for row, match in zip(rows, matches):
        earlier = (row.coordinate_source == "GEONAMES_LOCALITY"
                   and row.latitude is not None and row.longitude is not None)
        if match is not None and match.confidence >= geocoding.MIN_CONFIDENCE:
            if earlier:
                shift = routing.straight_km((float(row.latitude), float(row.longitude)),
                                            (match.latitude, match.longitude))
                if shift > geocoding.CLUSTER_KM:
                    moved.append(f"{row.code} ({shift:,.0f} km)")
                    counts["moved"] += 1
                else:
                    counts["kept"] += 1
            else:
                counts["mapped"] += 1
            _place(row, match)
        elif earlier:
            doubtful.append(row)
        else:
            counts["unresolved"] += 1
            _unresolve(row)
    if doubtful:
        try:
            verdicts = await geocoding.plausible_many(
                [(name, district, float(row.latitude), float(row.longitude), locality, mandal)
                 for row in doubtful
                 for name, district, locality, mandal in [_hint_tuple(row, hints)]])
        except Exception:
            logger.exception("Gazetteer plausibility check failed")
            verdicts = [True] * len(doubtful)
        for row, keep in zip(doubtful, verdicts):
            if keep:
                counts["kept"] += 1
            else:
                withdrawn.append(row.code)
                counts["withdrawn"] += 1
                _unresolve(row)
    if moved or withdrawn:
        await write_audit(
            db, entity="whs_warehouses", entity_id=0, entity_no="trip-planner",
            action=AuditAction.UPDATE, actor=None,
            after={"moved": moved[:200], "withdrawn": withdrawn[:200]},
            summary=(f"Gazetteer {geocoding.GAZETTEER_VERSION}: moved {len(moved)} "
                     f"automatic map points into their own district, withdrew "
                     f"{len(withdrawn)} that could not be confirmed there"))
    return counts


def _apply_snapshot(rows: list[Warehouse]) -> int:
    """Place every unplaced point the committed snapshot knows (`map_points.json`).

    Only a point with no coordinates is filled, and never over a MANUAL pin or HCM's
    GPS, so a pin set on this database always wins over one set on another.
    """
    snapshot = geocoding.load_snapshot()
    placed = 0
    for row in rows:
        if row.coordinate_source in ("MANUAL", HCM_COORDINATE_SOURCE):
            continue
        if row.latitude is not None and row.longitude is not None:
            continue
        point = snapshot.get(row.code)
        if not point:
            continue
        row.latitude = Decimal(str(point["latitude"]))
        row.longitude = Decimal(str(point["longitude"]))
        row.coordinate_source = point.get("source") or "GEONAMES_LOCALITY"
        row.coordinate_label = (point.get("label") or "")[:200] or None
        confidence = point.get("confidence")
        row.coordinate_confidence = Decimal(str(confidence)) if confidence is not None else None
        placed += 1
    return placed


def _needs_matching(row: Warehouse, *, recheck: bool) -> bool:
    if row.coordinate_source in ("MANUAL", HCM_COORDINATE_SOURCE):
        return False
    if row.latitude is None or row.longitude is None:
        return row.coordinate_source != "GAZETTEER_UNRESOLVED" or recheck
    return recheck and row.coordinate_source == "GEONAMES_LOCALITY"


async def prepare_map_network(db: AsyncSession, user) -> dict:
    """Every active stocking point in scope, located where the master allows.

    A point with no coordinates is matched against the offline gazetteer
    (`geocoding`). A confident match is written as GEONAMES_LOCALITY; one it cannot
    place is marked GAZETTEER_UNRESOLVED and not tried again until the matcher itself
    improves (`GAZETTEER_VERSION`) — the desk confirms one of its candidates, or pins
    it, instead (`point_candidates`, `set_point_location`). When the version moves,
    earlier automatic matches are re-checked too (`_match_points`). A MANUAL pin is
    never touched by any of this.
    """
    allowed = await warehouse_ids_for_user(db, user)
    stmt = select(Warehouse).where(Warehouse.is_active.is_(True)).order_by(Warehouse.code)
    if allowed is not None:
        stmt = stmt.where(Warehouse.id.in_(allowed or {0}))
    warehouses = list((await db.scalars(stmt)).all())
    hints = await _office_hints(db, warehouses)
    # HCM's own GPS first, on every read: a coordinate filled in HCM since the last
    # sync reaches the map now, not at the next sync. Never over a MANUAL pin.
    from_hcm = {"SET": 0, "CLEARED": 0}
    for row in warehouses:
        outcome = apply_hcm_coordinates(row, hints.get(row.office_id) or {})
        if outcome:
            from_hcm[outcome] += 1
    # The committed snapshot next, so a fresh checkout draws the same map as the
    # database it was exported from without waiting on its own gazetteer.
    from_snapshot = _apply_snapshot(warehouses)

    seen_version = await get_setting(db, GAZETTEER_VERSION_SETTING)
    # The version is the whole master's, so only an unscoped reader (who sees every
    # point) may advance it — a scoped desk re-checking its own ten points must not
    # mark the other nine hundred as done.
    recheck = allowed is None and str(seen_version or "") != str(geocoding.GAZETTEER_VERSION)
    todo = [row for row in warehouses if _needs_matching(row, recheck=recheck)]
    counts = await _match_points(db, todo, hints) if todo else {"mapped": 0}
    # ...and again after: a re-check on this machine's HCM mirror or GeoNames files
    # may withdraw a point the exporting database had confirmed.
    from_snapshot += _apply_snapshot(warehouses)
    await db.commit()
    if recheck:
        await set_setting(db, GAZETTEER_VERSION_SETTING, geocoding.GAZETTEER_VERSION,
                          value_type="string", category="logistics")
    mapped = sum(1 for row in warehouses
                 if row.latitude is not None and row.longitude is not None)
    return {
        "points": [_point(row) for row in warehouses], "total": len(warehouses),
        "mapped": mapped, "unresolved": len(warehouses) - mapped,
        "newly_mapped": counts.get("mapped", 0),
        "from_snapshot": from_snapshot,
        "rechecked": counts if recheck else None,
        "from_hcm": sum(1 for row in warehouses
                        if row.coordinate_source == HCM_COORDINATE_SOURCE),
        "hcm_updates": from_hcm,
        "source": "Warehouse masters · offline GeoNames gazetteer and postal "
                  "directory · pins set on this map",
    }


async def rematch_points(db: AsyncSession, user) -> dict:
    """Try the gazetteer again on every point in scope that is still not on the map.

    For after an HCM sync renamed stocking points, or a gazetteer refresh. Never
    moves a point that is already placed.
    """
    allowed = await warehouse_ids_for_user(db, user)
    stmt = select(Warehouse).where(Warehouse.is_active.is_(True),
                                   or_(Warehouse.latitude.is_(None),
                                       Warehouse.longitude.is_(None)))
    if allowed is not None:
        stmt = stmt.where(Warehouse.id.in_(allowed or {0}))
    rows = list((await db.scalars(stmt)).all())
    hints = await _office_hints(db, rows)
    for row in rows:
        apply_hcm_coordinates(row, hints.get(row.office_id) or {})
    _apply_snapshot(rows)
    rows = [row for row in rows if row.latitude is None or row.longitude is None]
    counts = await _match_points(db, rows, hints)
    await write_audit(db, entity="whs_warehouses", entity_id=0, entity_no="trip-planner",
                      action=AuditAction.UPDATE, actor=user, after=counts,
                      summary=f"Re-matched {len(rows)} unmapped stocking points; "
                              f"{counts['mapped']} placed")
    await db.commit()
    return {"tried": len(rows), "mapped": counts["mapped"],
            "still_unresolved": len(rows) - counts["mapped"]}


async def point_candidates(db: AsyncSession, warehouse_id: int, user,
                           query: str | None = None) -> dict:
    """Where this stocking point MIGHT be: ranked gazetteer places to confirm with one
    press, instead of hunting for it on the map.

    Never applied by itself. An ambiguous name is exactly the case the matcher refused
    to guess, and a person who knows the district choosing between "Bhamini,
    Srikakulam" and "Bhamini, Vizianagaram" is the reliable answer to it.
    """
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id not in allowed:
        raise PermissionError_("This stocking point is outside your warehouse scope")
    row = await svc._get(db, Warehouse, warehouse_id, "Warehouse")
    hint = (await _office_hints(db, [row])).get(row.office_id) or {}
    district, mandal = hint.get("district") or "", hint.get("mandal")
    typed = (query or "").strip()
    wanted = typed or geocoding.locality_from_warehouse(hint.get("location") or "") \
        or geocoding.locality_from_warehouse(row.name)
    try:
        found = await geocoding.candidates(
            typed or row.name, district, limit=8, mandal=mandal,
            locality=None if typed else hint.get("location"))
    except Exception:
        logger.exception("Gazetteer search failed for %s", row.code)
        found = []
    return {"point": _point(row), "query": wanted, "district": district or None,
            "mandal": mandal, "candidates": [candidate.as_dict() for candidate in found]}


async def set_point_location(db: AsyncSession, warehouse_id: int, data, user) -> dict:
    """Pin a stocking point where it actually is. A pin is MANUAL and fully trusted."""
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id not in allowed:
        raise PermissionError_("This stocking point is outside your warehouse scope")
    row = await svc._get(db, Warehouse, warehouse_id, "Warehouse")
    before = {"latitude": str(row.latitude) if row.latitude is not None else None,
              "longitude": str(row.longitude) if row.longitude is not None else None,
              "source": row.coordinate_source}
    row.latitude = Decimal(str(round(data.latitude, 7)))
    row.longitude = Decimal(str(round(data.longitude, 7)))
    row.coordinate_source = "MANUAL"
    row.coordinate_label = (data.label or row.name)[:200]
    row.coordinate_confidence = Decimal("1")
    await write_audit(db, entity="whs_warehouses", entity_id=row.id, entity_no=row.code,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"latitude": str(row.latitude),
                             "longitude": str(row.longitude), "source": "MANUAL"},
                      summary=f"Pinned {row.name} on the planner map")
    await db.commit()
    return _point(row)


# --------------------------------------------------------------------------- #
#  What is ready to go, from one origin
# --------------------------------------------------------------------------- #

def _live_transport():
    """Dispatch ids some live shipment already carries on its own."""
    return select(TransportRequest.dispatch_id).where(
        TransportRequest.dispatch_id.isnot(None),
        TransportRequest.status.notin_(DEAD_TRANSPORT_STATUSES))


def _on_active_trip():
    return select(ConsolidatedTripConsignment.dispatch_id).join(
        ConsolidatedTrip, ConsolidatedTrip.id == ConsolidatedTripConsignment.trip_id
    ).where(ConsolidatedTrip.status.in_(ACTIVE_TRIP_STATUSES))


async def _origin(db: AsyncSession, user, warehouse_id: int) -> Warehouse:
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id not in allowed:
        raise PermissionError_("This stocking point is outside your warehouse scope")
    origin = await svc._get(db, Warehouse, warehouse_id, "Warehouse")
    if origin.latitude is None or origin.longitude is None:
        raise ValidationError(
            f"{origin.name} has no location on the map yet. Pin it on the planner map "
            "(or enter its gate coordinates in Warehouse Masters) and plan again.")
    return origin


async def _drops(db: AsyncSession, origin: Warehouse, *,
                 dispatch_ids: list[int] | None = None, policy: Policy,
                 matrix: routing.DistanceMatrix | None = None,
                 ) -> tuple[list[Drop], list[dict], routing.DistanceMatrix]:
    """Every consignment ready to leave `origin`, as planning units, the ones that
    cannot be planned and why, and the distance matrix between all of them.

    Pass `matrix` to reuse one already built in this request: a second build inside
    the same transaction reads the cache through the transaction's snapshot and would
    not see the pairs the first build just routed.
    """
    destination = aliased(Warehouse)
    stmt = (select(m.Dispatch, destination)
            .outerjoin(destination, destination.id == m.Dispatch.to_warehouse_id)
            .where(m.Dispatch.warehouse_id == origin.id,
                   m.Dispatch.status.in_(PLANNABLE_DISPATCH_STATUSES),
                   m.Dispatch.id.notin_(_on_active_trip()),
                   m.Dispatch.id.notin_(_live_transport()))
            .order_by(m.Dispatch.id))
    if dispatch_ids is not None:
        stmt = stmt.where(m.Dispatch.id.in_(dispatch_ids or [0]))
    rows = (await db.execute(stmt)).all()
    here = (float(origin.latitude), float(origin.longitude))
    plannable, excluded = [], []
    for doc, point in rows:
        reason = None
        if not doc.to_warehouse_id or point is None:
            reason = "Not going to a stocking point (customer or vendor delivery)"
        elif point.latitude is None or point.longitude is None:
            reason = f"{point.name} has no location on the map yet"
        elif point.id == origin.id:
            reason = "Destination is the origin itself"
        if reason:
            excluded.append({"dispatch_id": doc.id, "consignment_no": doc.dispatch_no,
                             "destination_warehouse_id": doc.to_warehouse_id,
                             "destination_name": doc.to_warehouse_name
                             or (point.name if point else None),
                             "destination_place": place_name(doc.to_warehouse_name
                                                             or (point.name if point else None))
                             or None,
                             "reason": reason, "can_pin": bool(point)})
            continue
        plannable.append((doc, point))

    if matrix is None:
        points = [here, *[(float(p.latitude), float(p.longitude)) for _, p in plannable]]
        matrix = await routing.build_matrix(db, points, road_factor=policy.road_factor,
                                            factor_pinned=policy.road_factor_pinned)
    measures = await _measures(db, [doc for doc, _ in plannable], policy)
    drops = []
    for doc, point in plannable:
        lat, lon = float(point.latitude), float(point.longitude)
        size = measures.get(doc.id, {})
        drops.append(Drop(
            dispatch_id=doc.id, consignment_no=doc.dispatch_no,
            destination_id=point.id, destination_code=point.code,
            destination_name=point.name, destination_type=point.warehouse_type,
            delivery_address=doc.delivery_address or point.address,
            lat=lat, lon=lon, packages=int(size.get("packages") or doc.total_packages or 0),
            weight_kg=float(size.get("weight_kg") or 0.0),
            weight_basis=size.get("weight_basis"),
            volume_cbm=float(size.get("volume_cbm") or 0.0),
            volume_basis=size.get("volume_basis"),
            packages_weighed=int(size.get("packages_weighed") or 0),
            packages_measured=int(size.get("packages_measured") or 0),
            expected_delivery=doc.expected_delivery,
            project_name=doc.project_name,
            direct_km=matrix(here, (lat, lon)),
            back_km=matrix((lat, lon), here),
        ))
    return drops, excluded, matrix


async def _policy_for(db: AsyncSession, overrides: dict | None) -> Policy:
    site = (await planner_policy(db))["policy"]
    site = {key: value for key, value in site.items() if key in POLICY_DEFAULTS}
    return build_policy(site, overrides)


def _origin_payload(origin: Warehouse) -> dict:
    return {"id": origin.id, "code": origin.code, "name": origin.name,
            "place": place_name(origin.name), "warehouse_type": origin.warehouse_type,
            "latitude": float(origin.latitude), "longitude": float(origin.longitude)}


def _policy_payload(policy: Policy, matrix: routing.DistanceMatrix) -> dict:
    """The policy actually used, with the distance basis stated by the matrix that
    measured it rather than assumed from the configuration."""
    described = matrix.describe()
    return {**policy.as_dict(), "distance_basis": described["text"],
            "road_factor_used": described["estimate_factor"], "routing": described}


async def recommendations(db: AsyncSession, user, data) -> dict:
    """The whole of today's plan for one origin: trips, singles, and what was left out."""
    policy = await _policy_for(db, data.policy_overrides())
    origin = await _origin(db, user, data.warehouse_id)
    drops, excluded, matrix = await _drops(db, origin, policy=policy)
    here = (float(origin.latitude), float(origin.longitude))
    plan = recommend(here, drops, policy, departure=data.departure_date, km=matrix)
    return {"origin": _origin_payload(origin), "policy": _policy_payload(policy, matrix),
            "candidates": [drop.as_dict() for drop in
                           sorted(drops, key=lambda drop: drop.direct_km)],
            "excluded": excluded, **plan}


async def evaluate(db: AsyncSession, user, data) -> dict:
    """One hand-built trip: the route, what it saves, and what else is on its way."""
    policy = await _policy_for(db, data.policy_overrides())
    origin = await _origin(db, user, data.warehouse_id)
    pool, _, matrix = await _drops(db, origin, policy=policy)
    by_id = {drop.dispatch_id: drop for drop in pool}
    missing = [dispatch_id for dispatch_id in data.dispatch_ids if dispatch_id not in by_id]
    members = [by_id[dispatch_id] for dispatch_id in data.dispatch_ids if dispatch_id in by_id]
    here = (float(origin.latitude), float(origin.longitude))
    plan = evaluate_trip(here, members, policy, departure=data.departure_date,
                         stop_order=data.stop_order, km=matrix)
    plan["unavailable"] = missing
    plan["additions"] = suggest_additions(here, members, pool, policy, km=matrix)
    plan["next_stops"] = next_stop_options(
        here, members, [stop["destination_warehouse_id"] for stop in plan["stops"]],
        pool, policy, km=matrix)
    plan["origin"] = _origin_payload(origin)
    plan["policy"] = _policy_payload(policy, matrix)
    return plan


# --------------------------------------------------------------------------- #
#  Planning a trip: reserve the consignments, draft the ONE shipment
# --------------------------------------------------------------------------- #

async def _indents_of(db: AsyncSession, doc: m.Dispatch) -> list[tuple[int, str]]:
    """The indents a consignment serves, through the issues it carries."""
    ids = await svc._dispatch_issue_ids(db, doc)
    if not ids:
        return []
    rows = (await db.execute(
        select(m.MaterialIssue.indent_id, m.MaterialIssue.indent_no)
        .where(m.MaterialIssue.id.in_(ids), m.MaterialIssue.indent_id.isnot(None))
        .order_by(m.MaterialIssue.id))).all()
    return list(dict.fromkeys((int(row[0]), row[1] or "") for row in rows))


def _lane_label(stops: list[dict]) -> str:
    names = [stop["destination_name"] for stop in stops]
    label = f"{len(names)} stops: " + " → ".join(names) if len(names) > 1 else names[0]
    return label if len(label) <= 200 else label[:197] + "…"


async def create_trip(db: AsyncSession, data, user) -> dict:
    """Reserve these consignments onto one trip and draft the shipment that carries it.

    Everything is re-checked under row locks: the recommendation the desk looked at
    is minutes old, and another desk may have dispatched one of those consignments
    since. The shipment is drafted, not sent — the same confirm screen every dispatch
    uses is where its mode and provider are chosen (`?tr_id=`).
    """
    policy = await _policy_for(db, data.policy_overrides())
    origin = await _origin(db, user, data.warehouse_id)
    # Distances FIRST, before any row is locked: routing may wait on a network, and a
    # lock held across that wait is a lock every other desk queues behind. The matrix
    # is then reused under the lock rather than rebuilt (see `_drops`).
    _, _, matrix = await _drops(db, origin, dispatch_ids=data.dispatch_ids, policy=policy)
    locked = list((await db.execute(
        select(m.Dispatch).where(m.Dispatch.id.in_(data.dispatch_ids)).with_for_update()
    )).scalars().all())
    if len(locked) != len(data.dispatch_ids):
        raise ValidationError("One or more selected consignments no longer exist")
    wrong = [doc.dispatch_no for doc in locked
             if doc.status not in PLANNABLE_DISPATCH_STATUSES or doc.warehouse_id != origin.id]
    if wrong:
        raise ValidationError("No longer packed and waiting at "
                              f"{origin.name}: {', '.join(wrong)}")
    drops, excluded, matrix = await _drops(db, origin, dispatch_ids=data.dispatch_ids,
                                           policy=policy, matrix=matrix)
    by_id = {drop.dispatch_id: drop for drop in drops}
    blocked = [doc.dispatch_no for doc in locked if doc.id not in by_id]
    if blocked:
        reasons = {row["consignment_no"]: row["reason"] for row in excluded}
        raise ValidationError("Cannot go on this trip — " + "; ".join(
            f"{no}: {reasons.get(no, 'already on another trip or shipment')}"
            for no in blocked))
    members = [by_id[dispatch_id] for dispatch_id in data.dispatch_ids]
    here = (float(origin.latitude), float(origin.longitude))
    plan = evaluate_trip(here, members, policy, departure=data.departure_date,
                         stop_order=data.stop_order, km=matrix)
    # Only FIRM figures refuse: an estimate saying "over" is a reason to weigh the
    # cartons, not to stop a load the desk can see fits.
    if plan["blockers"]:
        raise ValidationError("; ".join(plan["blockers"]))

    trip = ConsolidatedTrip(
        trip_no=await next_number(db, "consolidated_trip"),
        status=TripStatus.PLANNED.value, departure_date=data.departure_date,
        from_warehouse_id=origin.id, from_warehouse_name=origin.name,
        origin_latitude=origin.latitude, origin_longitude=origin.longitude,
        policy_name=(data.policy_name or "Smart Load Planner")[:100],
        total_consignments=len(members), total_stops=len(plan["stops"]),
        total_packages=plan["total_packages"],
        total_weight_kg=Decimal(str(plan["total_weight_kg"])),
        vehicle_profile=data.vehicle_profile, vehicle_capacity_kg=Decimal(str(policy.capacity_kg)),
        returns_to_origin=policy.return_to_origin,
        road_factor=Decimal(str(round(matrix.road_factor, 3))),
        cost_per_km=Decimal(str(policy.cost_per_km)),
        estimated_distance_km=Decimal(str(plan["estimated_distance_km"])),
        separate_distance_km=Decimal(str(plan["separate_distance_km"])),
        estimated_saving_km=Decimal(str(plan["estimated_saving_km"])),
        estimated_saving_amount=Decimal(str(plan["estimated_saving_amount"])),
        distance_basis=plan["distance_basis"],
        vehicle_capacity_cbm=(Decimal(str(round(policy.capacity_cbm, 3)))
                              if policy.capacity_cbm else None),
        total_volume_cbm=Decimal(str(plan["total_volume_cbm"])),
        remarks=data.remarks, created_by_id=getattr(user, "id", None),
        created_by_name=svc._name(user))
    db.add(trip)
    await db.flush()

    docs = {doc.id: doc for doc in locked}
    lines, projects = [], set()
    for stop_data in plan["stops"]:
        stop = ConsolidatedTripStop(
            trip_id=trip.id, sequence=stop_data["sequence"],
            destination_warehouse_id=stop_data["destination_warehouse_id"],
            destination_code=stop_data["destination_code"],
            destination_name=stop_data["destination_name"][:200],
            delivery_address=(stop_data["delivery_address"] or None),
            latitude=Decimal(str(stop_data["latitude"])),
            longitude=Decimal(str(stop_data["longitude"])),
            distance_from_previous_km=Decimal(str(stop_data["distance_from_previous_km"])),
            total_consignments=len(stop_data["consignments"]),
            total_packages=stop_data["total_packages"],
            total_weight_kg=Decimal(str(stop_data["total_weight_kg"])),
            status=TripStopStatus.PLANNED.value)
        # Who to ring at the gate, snapshotted for the driver: logistics and the
        # carrier portal read the trip, never the warehouse's consignment (rule 5).
        contact = next((docs[row["dispatch_id"]] for row in stop_data["consignments"]
                        if docs[row["dispatch_id"]].contact_person
                        or docs[row["dispatch_id"]].contact_phone), None)
        if contact is not None:
            stop.contact_person = (contact.contact_person or None)
            stop.contact_phone = (contact.contact_phone or None)
        db.add(stop)
        await db.flush()
        for row in stop_data["consignments"]:
            doc = docs[row["dispatch_id"]]
            indents = await _indents_of(db, doc)
            db.add(ConsolidatedTripConsignment(
                trip_id=trip.id, stop_id=stop.id, dispatch_id=doc.id,
                consignment_no=doc.dispatch_no,
                destination_warehouse_id=stop.destination_warehouse_id,
                destination_name=stop.destination_name,
                indent_id=indents[0][0] if indents else None,
                indent_no=indents[0][1] if indents else None,
                indent_nos=(", ".join(no for _, no in indents)[:500] or None),
                packages=int(doc.total_packages or 0),
                weight_kg=svc._d(doc.total_weight_kg),
                status=TripStopStatus.PLANNED.value))
            projects.add((doc.project_id, doc.project_name))
            # One manifest line per consignment: its unique number, where it comes off,
            # and what a carrier prices on — packages and weight.
            lines.append({
                "item_code": doc.dispatch_no[:50],
                "item_name": f"{doc.dispatch_no} → {stop.destination_name} "
                             f"(stop {stop.sequence})"[:300],
                "uom_code": "CON", "quantity": float(svc._d(doc.total_qty)),
                "package_count": int(doc.total_packages or 0),
                "weight_kg": float(svc._d(doc.total_weight_kg)) or None,
                "remarks": (f"Stop {stop.sequence}: {stop.destination_name}"
                            + (f" · indent {indents[0][1]}" if indents else ""))[:500],
            })

    project_id, project_name = (next(iter(projects)) if len(projects) == 1 else (None, None))
    last = plan["stops"][-1]
    shipment = TRCreate(
        mode="THIRD_PARTY", carriage_mode="ROAD", tr_date=date.today(),
        source_type=TransportSource.TRIP.value, source_id=trip.id, source_no=trip.trip_no,
        from_warehouse_id=origin.id, from_warehouse_name=origin.name,
        to_location_name=_lane_label(plan["stops"]),
        delivery_address=(last["delivery_address"] or None),
        distance_km=plan["estimated_distance_km"],
        project_id=project_id, project_name=project_name,
        expected_delivery=max((doc.expected_delivery for doc in locked
                               if doc.expected_delivery), default=None),
        remarks=(f"Multi-drop trip {trip.trip_no}: {len(members)} consignments, "
                 f"{len(plan['stops'])} stops, est. {plan['estimated_distance_km']} km"),
        lines=lines)
    await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                      entity_no=trip.trip_no, action=AuditAction.CREATE, actor=user,
                      after={"status": trip.status, "consignments": data.dispatch_ids,
                             "estimated_saving_km": plan["estimated_saving_km"]},
                      summary=(f"Planned {trip.trip_no}: {len(members)} consignments over "
                               f"{len(plan['stops'])} stops, saving an estimated "
                               f"{plan['estimated_saving_km']} km"))
    # `create_tr` commits, and that commit carries the trip rows flushed above with it:
    # the trip and its shipment land together or not at all.
    doc = await lgs_transport.create_tr(db, shipment, user)
    trip = await _load_trip(db, trip.id)
    trip.tr_id, trip.tr_no = doc.id, doc.tr_no
    await db.commit()
    return await get_trip(db, trip.id, user)


# --------------------------------------------------------------------------- #
#  Reading a trip — with its stops re-derived from the consignments themselves
# --------------------------------------------------------------------------- #

async def _load_trip(db: AsyncSession, trip_id: int) -> ConsolidatedTrip:
    trip = (await db.execute(
        select(ConsolidatedTrip)
        .options(selectinload(ConsolidatedTrip.stops)
                 .selectinload(ConsolidatedTripStop.consignments),
                 selectinload(ConsolidatedTrip.consignments))
        .where(ConsolidatedTrip.id == trip_id)
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if trip is None:
        raise NotFoundError(f"Trip {trip_id} not found")
    return trip


async def _trip_shipment(db: AsyncSession, trip: ConsolidatedTrip) -> TransportRequest | None:
    """The shipment carrying the trip — by its link, or by its source if the link was
    never written (a crash between the two commits in `create_trip`)."""
    doc = await db.get(TransportRequest, trip.tr_id) if trip.tr_id else None
    if doc is None:
        doc = (await db.execute(
            select(TransportRequest)
            .where(TransportRequest.source_type == TransportSource.TRIP.value,
                   TransportRequest.source_id == trip.id)
            .order_by(TransportRequest.id.desc()))).scalars().first()
        if doc is not None:
            trip.tr_id, trip.tr_no = doc.id, doc.tr_no
    return doc


async def _trip_of_shipment(db: AsyncSession, tr) -> ConsolidatedTrip | None:
    if (getattr(tr, "source_type", None) or "").upper() != TransportSource.TRIP.value:
        return None
    if not getattr(tr, "source_id", None):
        return None
    try:
        return await _load_trip(db, int(tr.source_id))
    except NotFoundError:
        logger.warning("%s names trip %s, which does not exist", tr.tr_no, tr.source_id)
        return None


def _link_state(dispatch_status: str | None, stored: str) -> str:
    """What a consignment on a trip reads as, from its OWN document's status."""
    if stored == TripStopStatus.CANCELLED.value:
        return stored
    if dispatch_status == DispatchStatus.ACKNOWLEDGED.value:
        return TripStopStatus.ACKNOWLEDGED.value
    if dispatch_status == DispatchStatus.DELIVERED.value:
        return TripStopStatus.DELIVERED.value
    if dispatch_status in (DispatchStatus.DISPATCHED.value, DispatchStatus.IN_TRANSIT.value):
        # The desk may have marked the stop while the document still reads on the road.
        return stored if stored == TripStopStatus.DELIVERED.value else TripStopStatus.IN_TRANSIT.value
    return stored


def _roll_up(trip: ConsolidatedTrip) -> list[str]:
    """Derive every stop's and the trip's status from its consignments. Pure; returns
    what changed, as sentences, for the audit row and the timeline."""
    changed: list[str] = []
    if trip.status == TripStatus.CANCELLED.value:
        return changed
    now = utcnow()
    for stop in trip.stops:
        states = {link.status for link in stop.consignments}
        if not states:
            continue
        if states == {TripStopStatus.ACKNOWLEDGED.value}:
            target = TripStopStatus.ACKNOWLEDGED.value
        elif states <= {TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value}:
            target = TripStopStatus.DELIVERED.value
        elif trip.status in DEPARTED_TRIP_STATUSES:
            target = TripStopStatus.IN_TRANSIT.value
        else:
            target = TripStopStatus.PLANNED.value
        if target != stop.status:
            if target in (TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value):
                stop.delivered_at = stop.delivered_at or now
            if target == TripStopStatus.ACKNOWLEDGED.value:
                stop.acknowledged_at = stop.acknowledged_at or now
                changed.append(f"Stop {stop.sequence} ({stop.destination_name}) signed for")
            stop.status = target

    if trip.status not in DEPARTED_TRIP_STATUSES:
        return changed
    stops = [stop.status for stop in trip.stops]
    arrived = {TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value}
    if stops and all(status == TripStopStatus.ACKNOWLEDGED.value for status in stops):
        target = TripStatus.COMPLETED.value
    elif stops and all(status in arrived for status in stops):
        target = TripStatus.DELIVERED.value
    elif any(status in arrived for status in stops):
        target = TripStatus.PARTIALLY_DELIVERED.value
    else:
        target = TripStatus.IN_TRANSIT.value
    if target != trip.status:
        changed.append(f"Trip now {target.replace('_', ' ').lower()}")
        trip.status = target
        if target == TripStatus.COMPLETED.value:
            trip.completed_at = trip.completed_at or now
    return changed


async def _reconcile(db: AsyncSession, trip: ConsolidatedTrip, user=None, *,
                     condition: str | None = None, remarks: str | None = None) -> list[str]:
    """Bring the trip's cached statuses into line with its consignments, and settle
    the shipment once every stop has signed. Idempotent; never commits."""
    if trip.status == TripStatus.CANCELLED.value or not trip.consignments:
        return []
    statuses = dict((await db.execute(
        select(m.Dispatch.id, m.Dispatch).where(
            m.Dispatch.id.in_([link.dispatch_id for link in trip.consignments]))
    )).all())
    shipment = await _trip_shipment(db, trip)
    newly_signed: list[ConsolidatedTripConsignment] = []
    for link in trip.consignments:
        doc = statuses.get(link.dispatch_id)
        state = _link_state(doc.status if doc else None, link.status)
        if state == link.status:
            continue
        if state in (TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value):
            link.delivered_at = link.delivered_at or (doc.delivered_at if doc else None) or utcnow()
        if state == TripStopStatus.ACKNOWLEDGED.value:
            link.acknowledged_at = (doc.acknowledged_at if doc else None) or utcnow()
            link.acknowledged_by_name = (doc.acknowledged_by_name if doc else None) or svc._name(user)
            link.ack_condition = (condition or AckCondition.GOOD.value).upper()
            newly_signed.append(link)
        link.status = state

    before = {stop.id: stop.status for stop in trip.stops}
    changed = _roll_up(trip)
    if shipment is None:
        return changed

    # The timeline says what happened at each stop, in order, on the ONE shipment.
    for stop in trip.stops:
        if before[stop.id] != TripStopStatus.ACKNOWLEDGED.value \
                and stop.status == TripStopStatus.ACKNOWLEDGED.value:
            shipment.events.append(ShipmentEvent(
                event_type=ShipmentEventType.STOP_ACKNOWLEDGED.value, event_at=utcnow(),
                location_name=stop.destination_name,
                description=(f"Stop {stop.sequence} of {trip.total_stops}: "
                             + ", ".join(link.consignment_no for link in stop.consignments)
                             + " signed for"),
                recorded_by_id=getattr(user, "id", None), recorded_by_name=svc._name(user)))

    # A short or damaged receipt is a claim on THIS truck, at THAT stop.
    reported = (condition or AckCondition.GOOD.value).upper()
    if newly_signed and reported != AckCondition.GOOD.value and ACK_CLAIM_EVENT.get(reported):
        where = ", ".join(sorted({link.destination_name for link in newly_signed}))
        await svc._raise_receipt_claim(
            db, [shipment], reported,
            f"{where} ({', '.join(link.consignment_no for link in newly_signed)}): "
            f"{remarks or 'reported on receipt'}", user)

    if trip.status == TripStatus.COMPLETED.value and shipment.acknowledged_at is None \
            and shipment.status not in TERMINAL_STATUSES:
        now = utcnow()
        conditions = {link.ack_condition or AckCondition.GOOD.value for link in trip.consignments}
        shipment.delivered_at = shipment.delivered_at or now
        shipment.status = TransportStatus.ACKNOWLEDGED.value
        shipment.acknowledged_at = now
        shipment.acknowledged_by_name = f"All {trip.total_stops} stops"
        shipment.ack_condition = (AckCondition.GOOD.value if conditions == {AckCondition.GOOD.value}
                                  else next(c for c in conditions if c != AckCondition.GOOD.value))
        for line in shipment.items:
            if not line.delivered_qty:
                line.delivered_qty = line.quantity
        shipment.events.append(ShipmentEvent(
            event_type=ShipmentEventType.ACKNOWLEDGED.value, event_at=now,
            location_name=trip.stops[-1].destination_name if trip.stops else None,
            description=f"Every consignment on {trip.trip_no} signed for by its site",
            recorded_by_id=getattr(user, "id", None), recorded_by_name=svc._name(user)))
        await write_audit(db, entity="lgs_transport_requests", entity_id=shipment.id,
                          entity_no=shipment.tr_no, action=AuditAction.UPDATE, actor=user,
                          after={"status": shipment.status},
                          summary=f"{shipment.tr_no}: all {trip.total_stops} stops of "
                                  f"{trip.trip_no} signed for")
        # Closed unless a claim is still open — the same rule every signed leg follows.
        await svc._close_signed_legs(db, [shipment], user)
    if changed:
        await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                          entity_no=trip.trip_no, action=AuditAction.UPDATE, actor=user,
                          after={"status": trip.status}, summary="; ".join(changed))
    return changed


def _shipment_summary(doc: TransportRequest | None) -> dict | None:
    if doc is None:
        return None
    return {
        "id": doc.id, "tr_no": doc.tr_no, "status": doc.status, "mode": doc.mode,
        "carriage_mode": doc.carriage_mode, "carrier_name": doc.carrier_name,
        "freight_amount": doc.freight_amount, "lr_no": doc.lr_no, "docket_no": doc.docket_no,
        "gate_pass_no": doc.gate_pass_no, "vehicle_number": doc.vehicle_number,
        "driver_name": doc.driver_name, "driver_phone": doc.driver_phone,
        "tracking_url": doc.tracking_url, "dispatched_at": doc.dispatched_at,
        "delivered_at": doc.delivered_at, "acknowledged_at": doc.acknowledged_at,
        "quotes_received": sum(1 for quote in doc.quotes if quote.submitted_at is not None)
        if hasattr(doc, "quotes") else 0,
        "quotes_invited": len(doc.quotes) if hasattr(doc, "quotes") else 0,
        "open_claims": sum(1 for event in doc.events
                           if event.is_exception and event.resolved_at is None),
        "events": [{
            "id": event.id, "event_type": event.event_type, "event_at": event.event_at,
            "location_name": event.location_name, "description": event.description,
            "is_exception": event.is_exception, "resolved_at": event.resolved_at,
            "recorded_by_name": event.recorded_by_name,
        } for event in sorted(doc.events, key=lambda e: (e.event_at, e.id or 0))],
    }


#: What the desk can press next, derived from the trip AND its shipment together.
def _next_action(trip: ConsolidatedTrip, doc: TransportRequest | None) -> dict:
    if trip.status == TripStatus.CANCELLED.value:
        return {"code": "NONE", "label": "Cancelled"}
    if doc is None:
        return {"code": "NONE", "label": "Shipment missing — cancel and plan again"}
    if doc.status == TransportStatus.DRAFT.value:
        return {"code": "ARRANGE", "label": "Arrange transport",
                "hint": "Choose the mode and the provider on the Dispatch screen"}
    if doc.status in (TransportStatus.PENDING_APPROVAL.value, TransportStatus.QUOTING.value,
                      TransportStatus.AWAITING_CARRIER.value):
        return {"code": "PROVIDER", "label": "Follow up the provider",
                "hint": "Waiting on approval, a price or the carrier's yes"}
    if doc.status == TransportStatus.READY.value:
        return {"code": "RELEASE", "label": "Release at the gate",
                "hint": "Record the LR/docket and let the vehicle leave"}
    if trip.status in (TripStatus.IN_TRANSIT.value, TripStatus.PARTIALLY_DELIVERED.value):
        nxt = next((stop for stop in trip.stops if stop.status in (
            TripStopStatus.IN_TRANSIT.value, TripStopStatus.PLANNED.value)), None)
        return {"code": "DELIVER", "label": f"Mark stop {nxt.sequence} delivered" if nxt
                else "Mark next stop delivered", "stop_id": nxt.id if nxt else None,
                "hint": f"Next: {nxt.destination_name}" if nxt else None}
    if trip.status == TripStatus.DELIVERED.value:
        waiting = sum(1 for stop in trip.stops if stop.status != TripStopStatus.ACKNOWLEDGED.value)
        return {"code": "AWAIT_ACK", "label": f"Waiting on {waiting} site"
                f"{'s' if waiting != 1 else ''} to sign",
                "hint": "Each receiving site acknowledges its own consignment"}
    return {"code": "NONE", "label": "Completed"}


async def _trip_payload(db: AsyncSession, trip: ConsolidatedTrip,
                        doc: TransportRequest | None) -> dict:
    docs = dict((await db.execute(
        select(m.Dispatch.id, m.Dispatch).where(
            m.Dispatch.id.in_([link.dispatch_id for link in trip.consignments] or [0]))
    )).all())

    def link_row(link: ConsolidatedTripConsignment) -> dict:
        consignment = docs.get(link.dispatch_id)
        return {
            "id": link.id, "dispatch_id": link.dispatch_id,
            "consignment_no": link.consignment_no,
            "destination_warehouse_id": link.destination_warehouse_id,
            "destination_name": link.destination_name,
            "indent_id": link.indent_id, "indent_no": link.indent_no,
            "indent_nos": link.indent_nos,
            "packages": link.packages, "weight_kg": link.weight_kg,
            "status": link.status,
            "consignment_status": consignment.status if consignment else None,
            "delivery_address": consignment.delivery_address if consignment else None,
            "contact_person": consignment.contact_person if consignment else None,
            "contact_phone": consignment.contact_phone if consignment else None,
            "delivered_at": link.delivered_at, "acknowledged_at": link.acknowledged_at,
            "acknowledged_by_name": link.acknowledged_by_name,
            "ack_condition": link.ack_condition,
        }

    stops = [{
        "id": stop.id, "sequence": stop.sequence,
        "destination_warehouse_id": stop.destination_warehouse_id,
        "destination_code": stop.destination_code,
        "destination_name": stop.destination_name,
        "delivery_address": stop.delivery_address,
        "latitude": stop.latitude, "longitude": stop.longitude, "status": stop.status,
        "distance_from_previous_km": stop.distance_from_previous_km,
        "total_consignments": stop.total_consignments,
        "total_packages": stop.total_packages, "total_weight_kg": stop.total_weight_kg,
        "delivered_at": stop.delivered_at, "delivered_by_name": stop.delivered_by_name,
        "received_by_name": stop.received_by_name,
        "delivered_via": stop.delivered_via, "pod_url": stop.pod_url,
        "contact_person": stop.contact_person, "contact_phone": stop.contact_phone,
        "acknowledged_at": stop.acknowledged_at,
        "consignments": [link_row(link) for link in stop.consignments],
    } for stop in trip.stops]
    arrived = {TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value}
    return {
        "id": trip.id, "trip_no": trip.trip_no, "status": trip.status,
        "departure_date": trip.departure_date,
        "from_warehouse_id": trip.from_warehouse_id,
        "from_warehouse_name": trip.from_warehouse_name,
        "origin_latitude": trip.origin_latitude, "origin_longitude": trip.origin_longitude,
        "tr_id": trip.tr_id, "tr_no": trip.tr_no,
        "policy_name": trip.policy_name, "vehicle_profile": trip.vehicle_profile,
        "vehicle_capacity_kg": trip.vehicle_capacity_kg,
        "returns_to_origin": trip.returns_to_origin,
        "road_factor": trip.road_factor, "cost_per_km": trip.cost_per_km,
        "total_consignments": trip.total_consignments, "total_stops": trip.total_stops,
        "total_packages": trip.total_packages, "total_weight_kg": trip.total_weight_kg,
        "estimated_distance_km": trip.estimated_distance_km,
        "separate_distance_km": trip.separate_distance_km,
        "estimated_saving_km": trip.estimated_saving_km,
        "estimated_saving_amount": trip.estimated_saving_amount,
        # Trips planned before distances were routed have no basis: they were estimates.
        "distance_basis": trip.distance_basis or "ESTIMATE",
        "vehicle_capacity_cbm": trip.vehicle_capacity_cbm,
        "total_volume_cbm": trip.total_volume_cbm,
        "vehicle_number": (doc.vehicle_number if doc and doc.vehicle_number
                           else trip.vehicle_number),
        "driver_name": doc.driver_name if doc and doc.driver_name else trip.driver_name,
        "driver_phone": doc.driver_phone if doc and doc.driver_phone else trip.driver_phone,
        "gate_pass_no": doc.gate_pass_no if doc and doc.gate_pass_no else trip.gate_pass_no,
        "dispatched_at": trip.dispatched_at, "completed_at": trip.completed_at,
        "cancelled_at": trip.cancelled_at, "remarks": trip.remarks,
        "created_by_name": trip.created_by_name, "created_at": trip.created_at,
        "stops_delivered": sum(1 for stop in trip.stops if stop.status in arrived),
        "stops_acknowledged": sum(1 for stop in trip.stops
                                  if stop.status == TripStopStatus.ACKNOWLEDGED.value),
        "consignments_acknowledged": sum(
            1 for link in trip.consignments
            if link.status == TripStopStatus.ACKNOWLEDGED.value),
        "stops": stops,
        "shipment": _shipment_summary(doc),
        "next_action": _next_action(trip, doc),
    }


async def _scoped(db: AsyncSession, trip: ConsolidatedTrip, user) -> None:
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and trip.from_warehouse_id not in allowed:
        raise PermissionError_("This trip is outside your warehouse scope")


async def get_trip(db: AsyncSession, trip_id: int, user) -> dict:
    """The trip console. Reconciled on the way out: whatever door a consignment was
    signed through, the trip read here reflects it."""
    trip = await _load_trip(db, trip_id)
    await _scoped(db, trip, user)
    if await _reconcile(db, trip, user):
        await db.commit()
        trip = await _load_trip(db, trip_id)
    doc = await _trip_shipment(db, trip)
    return await _trip_payload(db, trip, doc)


async def list_trips(db: AsyncSession, user, params: PageParams, *,
                     status: str | None = None, warehouse_id: int | None = None,
                     search: str | None = None, dispatch_ids: list[int] | None = None) -> dict:
    stmt = select(ConsolidatedTrip)
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None:
        stmt = stmt.where(ConsolidatedTrip.from_warehouse_id.in_(allowed or {0}))
    if status:
        wanted = [part.strip().upper() for part in status.split(",") if part.strip()]
        if "ACTIVE" in wanted:
            wanted = [*wanted, *ACTIVE_TRIP_STATUSES]
        stmt = stmt.where(ConsolidatedTrip.status.in_(wanted))
    if warehouse_id:
        stmt = stmt.where(ConsolidatedTrip.from_warehouse_id == warehouse_id)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            ConsolidatedTrip.trip_no.like(like), ConsolidatedTrip.tr_no.like(like),
            ConsolidatedTrip.id.in_(select(ConsolidatedTripConsignment.trip_id).where(or_(
                ConsolidatedTripConsignment.consignment_no.like(like),
                ConsolidatedTripConsignment.destination_name.like(like),
                ConsolidatedTripConsignment.indent_nos.like(like))))))
    if dispatch_ids:
        stmt = stmt.where(ConsolidatedTrip.id.in_(
            select(ConsolidatedTripConsignment.trip_id)
            .where(ConsolidatedTripConsignment.dispatch_id.in_(dispatch_ids))))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = list((await db.execute(
        stmt.options(selectinload(ConsolidatedTrip.stops)
                     .selectinload(ConsolidatedTripStop.consignments),
                     selectinload(ConsolidatedTrip.consignments))
        .order_by(ConsolidatedTrip.id.desc())
        .offset((params.page - 1) * params.size).limit(params.size)
    )).scalars().unique().all())
    shipments = {doc.id: doc for doc in (await db.execute(
        select(TransportRequest).where(
            TransportRequest.id.in_([trip.tr_id for trip in rows if trip.tr_id] or [0]))
    )).scalars().all()}
    items = []
    for trip in rows:
        doc = shipments.get(trip.tr_id)
        payload = await _trip_payload(db, trip, doc)
        payload.pop("shipment")
        payload["shipment_status"] = doc.status if doc else None
        payload["carrier_name"] = doc.carrier_name if doc else None
        payload["mode"] = doc.mode if doc else None
        items.append(payload)
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


# --------------------------------------------------------------------------- #
#  Along the road
# --------------------------------------------------------------------------- #

async def _put_down(db: AsyncSession, trip: ConsolidatedTrip, stop: ConsolidatedTripStop,
                    user, *, received_by: str | None = None,
                    remarks: str | None = None, when=None, actor_name: str | None = None,
                    via: str = "DESK", pod_url: str | None = None) -> list[str]:
    """The truck is at `stop` and its consignments come off. Never commits."""
    now = when or utcnow()
    actor = actor_name or svc._name(user) or "Carrier"
    docs = list((await db.execute(
        select(m.Dispatch).where(m.Dispatch.id.in_(
            [link.dispatch_id for link in stop.consignments])).with_for_update()
    )).scalars().all())
    for doc in docs:
        if doc.status in (DispatchStatus.DISPATCHED.value, DispatchStatus.IN_TRANSIT.value):
            doc.status = DispatchStatus.DELIVERED.value
            doc.delivered_at = doc.delivered_at or now
            if pod_url and not doc.pod_url:
                doc.pod_url = pod_url[:500]
        db.add(m.DispatchEvent(
            dispatch_id=doc.id, event_type=DispatchEventType.DELIVERED.value, event_at=now,
            location_name=stop.destination_name, latitude=stop.latitude,
            longitude=stop.longitude, is_breach=False,
            notes=(f"Stop {stop.sequence} of {trip.trip_no} · reported by {actor}"
                   + (f" · {remarks}" if remarks else ""))[:500],
            recorded_by_id=getattr(user, "id", None), recorded_by_name=actor[:200]))
    for link in stop.consignments:
        if link.status in (TripStopStatus.PLANNED.value, TripStopStatus.IN_TRANSIT.value):
            link.status = TripStopStatus.DELIVERED.value
            link.delivered_at = link.delivered_at or now
    stop.status = TripStopStatus.DELIVERED.value
    stop.arrived_at = stop.arrived_at or now
    stop.delivered_at = stop.delivered_at or now
    stop.delivered_by_name = actor[:200]
    stop.delivered_via = via
    stop.received_by_name = received_by or stop.received_by_name
    if pod_url:
        stop.pod_url = pod_url[:500]
    return [doc.dispatch_no for doc in docs]


def _open_stops(trip: ConsolidatedTrip) -> list[ConsolidatedTripStop]:
    """Stops the truck has not yet reached, in visiting order."""
    return [stop for stop in trip.stops
            if stop.status in (TripStopStatus.PLANNED.value, TripStopStatus.IN_TRANSIT.value)]


async def _deliver_stop(db: AsyncSession, trip: ConsolidatedTrip, stop_id: int, *,
                        user, received_by: str | None, remarks: str | None, when,
                        pod_url: str | None = None, via: str = "DESK",
                        actor_name: str | None = None) -> None:
    """ONE stop reached and put down — the core behind the desk's press and the
    carrier's. Commits.

    The carrier's word, not the site's: the receiving site still signs for its own
    consignment on its Acknowledgements screen. The LAST stop also marks the whole
    shipment delivered, through the one door that does that (`transport.deliver_tr`),
    so the shipment never reads delivered while a stop is still on the truck.
    """
    if trip.status not in (TripStatus.IN_TRANSIT.value, TripStatus.PARTIALLY_DELIVERED.value):
        if trip.status == TripStatus.PLANNED.value:
            raise ValidationError(
                f"{trip.trip_no} has not left the gate yet — release its shipment "
                f"{trip.tr_no or ''} first".strip())
        raise ValidationError(f"{trip.trip_no} is {trip.status.lower().replace('_', ' ')}")
    stop = next((row for row in trip.stops if row.id == stop_id), None)
    if stop is None:
        raise NotFoundError(f"Stop {stop_id} is not on {trip.trip_no}")
    if stop.status in (TripStopStatus.DELIVERED.value, TripStopStatus.ACKNOWLEDGED.value):
        raise ValidationError(f"Stop {stop.sequence} ({stop.destination_name}) is already delivered")
    if stop.status == TripStopStatus.CANCELLED.value:
        raise ValidationError(f"Stop {stop.sequence} ({stop.destination_name}) was cancelled")

    actor = actor_name or svc._name(user) or "Carrier"
    shipment = await _trip_shipment(db, trip)
    consignments = await _put_down(db, trip, stop, user, received_by=received_by,
                                   remarks=remarks, when=when, actor_name=actor, via=via,
                                   pod_url=pod_url)
    _roll_up(trip)
    if shipment is not None:
        shipment.events.append(ShipmentEvent(
            event_type=ShipmentEventType.STOP_DELIVERED.value,
            event_at=when or utcnow(), location_name=stop.destination_name,
            description=(f"Stop {stop.sequence} of {trip.total_stops}: "
                         f"{', '.join(consignments)} delivered"
                         + (f" to {received_by}" if received_by else "")
                         + (" · reported by the carrier" if via == "CARRIER" else "")),
            recorded_by_id=getattr(user, "id", None), recorded_by_name=actor[:200]))
    await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                      entity_no=trip.trip_no, action=AuditAction.UPDATE, actor=user,
                      after={"status": trip.status, "stop": stop.sequence, "via": via},
                      summary=f"Stop {stop.sequence} ({stop.destination_name}) of "
                              f"{trip.trip_no} delivered: {', '.join(consignments)}"
                              + (f" — reported by {actor}" if via == "CARRIER" else ""))
    last = trip.status == TripStatus.DELIVERED.value
    if last and shipment is not None and shipment.status in (
            TransportStatus.IN_TRANSIT.value, TransportStatus.READY.value):
        # Commits the stop writes above with it; `ON_DELIVER` finds nothing left to do.
        from types import SimpleNamespace
        await lgs_transport.deliver_tr(db, shipment.id, SimpleNamespace(
            delivered_at=when, delivered_to_name=received_by, pod_url=pod_url,
            remarks=f"Last stop of {trip.trip_no}: {stop.destination_name}"), user)
    else:
        await db.commit()


async def mark_stop_delivered(db: AsyncSession, trip_id: int, stop_id: int, data, user) -> dict:
    """The desk records that the truck reached this stop and put its consignments down."""
    trip = await _load_trip(db, trip_id)
    await _scoped(db, trip, user)
    await _deliver_stop(db, trip, stop_id, user=user, received_by=data.received_by_name,
                        remarks=data.remarks, when=data.delivered_at,
                        pod_url=getattr(data, "pod_url", None), via="DESK")
    return await get_trip(db, trip_id, user)


async def carrier_stop_delivered(db: AsyncSession, tr, stop_id: int | None, data,
                                 actor_name: str | None) -> None:
    """The CARRIER reports a stop from their portal (`transport.carrier_deliver_stop`).

    Reached through `logistics.hooks.STOP_DELIVERERS`, never imported by logistics
    (rule 5). The carrier's identity and their right to this shipment were checked by
    the portal before it got here; this checks only that the stop is on THIS
    shipment's trip — a stop id from somebody else's trip must not be deliverable
    through a shipment the carrier does own.

    `stop_id=None` means "the next stop the truck has not reached", which is what a
    carrier pressing Delivered on a one-stop-left run means.
    """
    trip = await _trip_of_shipment(db, tr)
    if trip is None:
        raise ValidationError(f"{tr.tr_no} is not a multi-drop trip")
    if stop_id is None:
        remaining = _open_stops(trip)
        if not remaining:
            raise ValidationError(f"Every stop on {trip.trip_no} is already delivered")
        stop_id = remaining[0].id
    await _deliver_stop(db, trip, stop_id, user=None,
                        received_by=getattr(data, "delivered_to_name", None)
                        or getattr(data, "received_by_name", None),
                        remarks=getattr(data, "remarks", None),
                        when=getattr(data, "delivered_at", None),
                        pod_url=getattr(data, "pod_url", None), via="CARRIER",
                        actor_name=actor_name)


async def cancel_trip(db: AsyncSession, trip_id: int, reason: str, user) -> dict:
    """Give the consignments back before the truck leaves. They return to the queue
    exactly as packed — nothing about them changed while they were planned."""
    trip = await _load_trip(db, trip_id)
    await _scoped(db, trip, user)
    if trip.status != TripStatus.PLANNED.value:
        raise ValidationError(f"{trip.trip_no} has already left — it cannot be cancelled. "
                              "Deliver its stops, or raise a claim on its shipment.")
    shipment = await _trip_shipment(db, trip)
    if shipment is not None and shipment.status not in TERMINAL_STATUSES:
        # Cancelling the shipment cancels the trip through `ON_CANCEL`, in one commit,
        # and tells any approver or carrier holding it that it is gone.
        await lgs_transport.cancel_tr(db, shipment.id, user, reason)
    else:
        _cancel(trip, reason)
        await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                          entity_no=trip.trip_no, action=AuditAction.UPDATE, actor=user,
                          before={"status": TripStatus.PLANNED.value},
                          after={"status": trip.status},
                          summary=f"Cancelled {trip.trip_no}: {reason}")
        await db.commit()
    return await get_trip(db, trip_id, user)


def _cancel(trip: ConsolidatedTrip, reason: str | None) -> None:
    trip.status = TripStatus.CANCELLED.value
    trip.cancelled_at = utcnow()
    trip.remarks = " · ".join(part for part in [trip.remarks, f"Cancelled: {reason}"
                                                 if reason else "Cancelled"] if part)
    for stop in trip.stops:
        stop.status = TripStopStatus.CANCELLED.value
    for link in trip.consignments:
        link.status = TripStopStatus.CANCELLED.value


# --------------------------------------------------------------------------- #
#  Hooks — the shipment's lifecycle, told to the trip it carries
# --------------------------------------------------------------------------- #

async def trip_release_blocked(db: AsyncSession, tr, user) -> str | None:
    """May this trip's truck leave? Every consignment on it must still be waiting at
    the gate with its stock posted — one cancelled carton holds the whole vehicle,
    because releasing around it would gate the rest out and leave it on the manifest."""
    trip = await _trip_of_shipment(db, tr)
    if trip is None:
        return None
    if trip.status != TripStatus.PLANNED.value:
        return f"{trip.trip_no} is {trip.status.lower().replace('_', ' ')}"
    docs = list((await db.execute(select(m.Dispatch).where(m.Dispatch.id.in_(
        [link.dispatch_id for link in trip.consignments])))).scalars().all())
    problems = []
    for doc in docs:
        if doc.status not in (*PLANNABLE_DISPATCH_STATUSES,
                              DispatchStatus.PENDING_APPROVAL.value):
            problems.append(f"{doc.dispatch_no} is {doc.status.lower().replace('_', ' ')}")
            continue
        for issue_id in await svc._dispatch_issue_ids(db, doc):
            issue = await db.get(m.MaterialIssue, issue_id)
            if issue is None or not issue.is_stock_posted:
                problems.append(f"{doc.dispatch_no} carries an issue whose stock is not posted")
                break
    if len(docs) != len(trip.consignments):
        problems.append("a consignment on the manifest no longer exists")
    if problems:
        return (f"{trip.trip_no} cannot leave: {'; '.join(problems)}. Cancel the trip "
                "and plan it again without them.")
    return None


async def trip_shipment_released(db: AsyncSession, tr, user) -> bool:
    """The truck left: gate every consignment on the trip out behind it.

    Exactly the per-consignment gate-out a single dispatch runs (`_apply_gate_out`),
    once per consignment, in the release's own transaction. Returns whether this
    shipment was a trip, so the single-consignment path knows to stand aside.
    """
    trip = await _trip_of_shipment(db, tr)
    if trip is None:
        return False
    if trip.status != TripStatus.PLANNED.value:
        return True
    docs = list((await db.execute(
        select(m.Dispatch)
        .options(selectinload(m.Dispatch.items), selectinload(m.Dispatch.packages))
        .where(m.Dispatch.id.in_([link.dispatch_id for link in trip.consignments]))
        .with_for_update())).scalars().unique().all())
    for doc in docs:
        if doc.status not in (*PLANNABLE_DISPATCH_STATUSES,
                              DispatchStatus.PENDING_APPROVAL.value):
            logger.warning("%s left without %s, which is %s", trip.trip_no,
                           doc.dispatch_no, doc.status)
            continue
        await svc._cancel_open_dispatch_approval(db, doc, user)
        await svc._apply_gate_out(db, doc, tr.gate_pass_no, user)
        doc.vehicle_number = tr.vehicle_number or doc.vehicle_number
        doc.driver_name = tr.driver_name or doc.driver_name
        doc.driver_phone = (tr.driver_phone or doc.driver_phone or None)
        if doc.driver_phone:
            doc.driver_phone = doc.driver_phone[:20]
        doc.carrier_name = tr.carrier_name or doc.carrier_name
        doc.lr_no = tr.lr_no or tr.docket_no or doc.lr_no
    trip.status = TripStatus.IN_TRANSIT.value
    trip.dispatched_at = utcnow()
    trip.vehicle_number, trip.driver_name = tr.vehicle_number, tr.driver_name
    trip.driver_phone, trip.gate_pass_no = tr.driver_phone, tr.gate_pass_no
    for stop in trip.stops:
        stop.status = TripStopStatus.IN_TRANSIT.value
    for link in trip.consignments:
        link.status = TripStopStatus.IN_TRANSIT.value
    await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                      entity_no=trip.trip_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": TripStatus.PLANNED.value},
                      after={"status": trip.status, "gate_pass_no": tr.gate_pass_no},
                      summary=f"{trip.trip_no} left the gate with {len(docs)} consignments "
                              f"on {tr.tr_no}")
    logger.info("%s released %s: %d consignments gated out", tr.tr_no, trip.trip_no, len(docs))
    return True


async def trip_shipment_delivered(db: AsyncSession, tr, user) -> None:
    """The carrier says the whole run is done: every stop still on the truck is too."""
    trip = await _trip_of_shipment(db, tr)
    if trip is None or trip.status not in (TripStatus.IN_TRANSIT.value,
                                           TripStatus.PARTIALLY_DELIVERED.value):
        return
    via = "DESK" if user is not None else "CARRIER"
    for stop in _open_stops(trip):
        await _put_down(db, trip, stop, user, via=via,
                        remarks=("Whole run reported delivered by the carrier" if user is None
                                 else "Whole run marked delivered from the shipment"),
                        pod_url=getattr(tr, "pod_url", None))
    _roll_up(trip)


async def trip_shipment_cancelled(db: AsyncSession, tr, user) -> None:
    trip = await _trip_of_shipment(db, tr)
    if trip is None or trip.status != TripStatus.PLANNED.value:
        return
    _cancel(trip, f"shipment {tr.tr_no} cancelled")
    await write_audit(db, entity="lgs_consolidated_trips", entity_id=trip.id,
                      entity_no=trip.trip_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": TripStatus.PLANNED.value},
                      after={"status": trip.status},
                      summary=f"Cancelled {trip.trip_no} with its shipment {tr.tr_no}; "
                              f"{len(trip.consignments)} consignments back in the queue")


async def sync_for_dispatches(db: AsyncSession, dispatch_ids: list[int], user, *,
                              condition: str | None = None,
                              remarks: str | None = None) -> list[str]:
    """A consignment was signed for (by whichever door) — roll its trip up. Never commits."""
    if not dispatch_ids:
        return []
    trip_ids = list((await db.execute(
        select(ConsolidatedTripConsignment.trip_id).join(
            ConsolidatedTrip, ConsolidatedTrip.id == ConsolidatedTripConsignment.trip_id)
        .where(ConsolidatedTripConsignment.dispatch_id.in_(dispatch_ids),
               ConsolidatedTrip.status.in_(ACTIVE_TRIP_STATUSES)).distinct()
    )).scalars().all())
    touched = []
    for trip_id in trip_ids:
        trip = await _load_trip(db, trip_id)
        if await _reconcile(db, trip, user, condition=condition, remarks=remarks):
            touched.append(trip.trip_no)
    return touched


async def sync_for_indent(db: AsyncSession, indent_id: int, user, *,
                          condition: str | None = None,
                          remarks: str | None = None) -> list[str]:
    """The indent's raiser confirmed a receipt: every trip carrying it rolls up."""
    dispatch_ids = list((await db.execute(
        select(ConsolidatedTripConsignment.dispatch_id).join(
            ConsolidatedTrip, ConsolidatedTrip.id == ConsolidatedTripConsignment.trip_id)
        .where(ConsolidatedTripConsignment.indent_id == indent_id,
               ConsolidatedTrip.status.in_(ACTIVE_TRIP_STATUSES))
    )).scalars().all())
    return await sync_for_dispatches(db, dispatch_ids, user, condition=condition,
                                     remarks=remarks)


def _register() -> None:
    for registry, hook in ((lgs_hooks.BEFORE_RELEASE, trip_release_blocked),
                           (lgs_hooks.ON_DELIVER, trip_shipment_delivered),
                           (lgs_hooks.ON_CANCEL, trip_shipment_cancelled),
                           (lgs_hooks.STOP_DELIVERERS, carrier_stop_delivered)):
        if hook not in registry:
            registry.append(hook)


_register()
