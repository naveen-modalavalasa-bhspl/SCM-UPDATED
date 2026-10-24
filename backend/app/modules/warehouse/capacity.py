"""Does this fit in that bin — asked the way a WMS asks it, of HANDLING UNITS.

Goods do not arrive as a volume. They arrive as packs: a case, a tote, a euro-pallet.
The first version of this module computed `qty x volume_per_each` and checked the
result against `whs_warehouse_locations.capacity_volume`, and that is the one model
every production WMS (SAP EWM, Oracle, Blue Yonder, Manhattan) rejects, for a reason
worth writing down because it is not obvious:

    **You cannot pour boxes like liquid.** 500 SIM cards have a summed "each" volume of
    a couple of litres and physically occupy a pallet. Loose volume therefore reports a
    full bin as nearly empty, and the better the goods are packed the worse the lie
    gets — the error is largest exactly where the warehouse is fullest.

So the unit of account here is the **handling unit**: one pack, at a level of the
item's own packing ladder (`mst_item_packaging`), carrying the outer bounding box and
the gross weight of the thing a person actually lifts onto a shelf.

    space required = ceil(qty / units per pack) x volume of one pack

`ceil`, because half a case still occupies a case's footprint. That single rounding is
most of the difference between this module and the one it replaces.

A location is then checked on **four independent gates**, and passing three of them is
not passing:

    VOLUME     usable cube (stated or L x W x H, derated by the void factor)
    WEIGHT     the rack's payload against the GROSS weight standing on it
    FOOTPRINT  does ONE unit physically enter the bin's box, turned if it may be
    UNITS      the discrete limit — "this bay takes one pallet, or four totes" —
               stated outright, or slotted from the two boxes and the stack limit

Three rules shape everything, unchanged from the first version because they were the
part that was right.

**Occupancy is READ, never stored.** It is the stock standing in a location resolved
through each item's default putaway unit, computed on demand — the same invariant the
fulfilment desk runs on. There is no `occupied_volume` column to drift, no hook to
fire when stock moves and nothing to rebuild after a correction: a putaway, an issue,
a transfer or an adjustment changes the answer by existing. Adding a stored counter
later would reintroduce exactly the class of defect the allocation rewrite removed.

**A full location never blocks the work.** Capacity here is advice, loudly given and
recorded, and every caller carries on regardless — the goods are physically on the
floor whether or not the master data says they fit, and refusing the putaway only
means the stock sits in a bin nobody wrote down. The one thing worse than useless is
silence, so `status`, `headline` and `detail` are served from here rather than
assembled in a screen.

**An unmeasured pack has NO volume, not zero.** Zero reports a packed bin as empty,
which reads as "there is room" — the one answer worse than "nobody has measured this".
Every result carries `unmeasured_items` / `unmeasured_qty` and `is_partial`, and the
screens say so.
"""
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.shared.models.master import Item, ItemPackaging, PackHierarchy, Packaging
from app.shared.models.warehouse import BIN_TYPES, Bin

ZERO = Decimal("0")
ONE = Decimal("1")
HUNDRED = Decimal("100")
#: cm3 -> m3. A carton measured 40 x 30 x 25 is 0.03 cbm, not 30000 of anything.
CUBIC_CM_PER_CBM = Decimal("1000000")
#: Above this share of USABLE capacity a location is called TIGHT — near enough to full
#: that the storekeeper should be told before they walk over, not after.
TIGHT_AT = Decimal("0.9")

#: What a location can be told about itself. Served, never mapped in a screen.
STATUS_OK = "OK"
STATUS_TIGHT = "TIGHT"
STATUS_FULL = "FULL"
STATUS_OVER = "OVER"
STATUS_NO_CAPACITY = "NO_CAPACITY"
STATUS_UNMEASURED = "UNMEASURED"
#: The bounding-box verdict, and the reason a seventh status had to exist: a pack can
#: be well inside a bin's cube and still not go through its opening.
STATUS_WONT_FIT = "WONT_FIT"

#: Which of two verdicts a storekeeper needs to hear first. Used to fold the gates into
#: one overall status and to sort the rows of a multi-location preview.
SEVERITY = {
    STATUS_OVER: 0, STATUS_WONT_FIT: 1, STATUS_FULL: 2, STATUS_TIGHT: 3,
    STATUS_UNMEASURED: 4, STATUS_NO_CAPACITY: 5, STATUS_OK: 6,
}
#: The verdicts that mean something is wrong, as opposed to unknown or fine.
ADVERSE = (STATUS_OVER, STATUS_WONT_FIT, STATUS_FULL, STATUS_TIGHT)

IN = "IN"
OUT = "OUT"

GATE_VOLUME = "VOLUME"
GATE_WEIGHT = "WEIGHT"
GATE_FOOTPRINT = "FOOTPRINT"
GATE_UNITS = "UNITS"

CBM = "m³"
KG = "kg"


def _d(value) -> Decimal:
    """Decimal or zero. MySQL DECIMALs arrive as strings and a bad one must not 500."""
    if value is None:
        return ZERO
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return ZERO


def _pos(value) -> Decimal | None:
    """The figure if somebody actually set one, else None. The distinction this whole
    module turns on: a blank capacity is not a capacity of zero."""
    got = _d(value)
    return got if got > ZERO else None


def _q(value: Decimal | None, places: str = "0.000001") -> Decimal | None:
    """Rounded for display. Volumes are quoted to six places because a small part in a
    big warehouse is a genuinely small number, not because anyone measures that far."""
    return None if value is None else value.quantize(Decimal(places))


def _ceil(value: Decimal) -> Decimal:
    """Whole packs, always rounded up. Half a case occupies a case's footprint, and
    this one rounding is most of what separates handling units from loose volume."""
    return value.to_integral_value(rounding="ROUND_CEILING")


def _box(length, width, height) -> tuple[Decimal, Decimal, Decimal] | None:
    """The three sides, or None. All three or nothing — two sides describe nothing a
    slotting check can use, and treating a missing one as zero would let anything
    through."""
    sides = (_pos(length), _pos(width), _pos(height))
    return None if any(s is None for s in sides) else sides


def _cube(box: tuple[Decimal, Decimal, Decimal] | None) -> Decimal | None:
    """Cubic metres from three centimetre sides."""
    return None if box is None else (box[0] * box[1] * box[2]) / CUBIC_CM_PER_CBM


def _factor(pct) -> Decimal:
    """A void factor as a multiplier. Blank means 100% — nobody has derated this — and
    anything above 100 is a typo we refuse to compound into extra capacity."""
    got = _pos(pct)
    if got is None or got > HUNDRED:
        return ONE
    return got / HUNDRED


def _sides(box) -> str:
    """`120 × 80 × 144 cm`, for a sentence."""
    return " × ".join(str(_q(side, "0.1")) for side in box) + " cm"


# --------------------------------------------------------------------------- #
#  Packaging units — the item's ladder, resolved
# --------------------------------------------------------------------------- #

class Pack:
    """One rung of an item's packing ladder, resolved into what a bin check needs.

    `base_qty` is CUMULATIVE: level 1 holds its own quantity in the item's UOM, level 2
    holds that many of level 1, and so on — so `base_qty` on any rung is how many base
    units one of these actually contains. Multiplied up here rather than stored, for
    the reason `packaging_breakdown` gives: a stored total is one edit away from
    disagreeing with its own parts.

    Dimensions come from the rung where it overrides them and from the container type
    otherwise. `volume_cbm` is None — never zero — when neither carries a box.
    """

    __slots__ = (
        "item_packaging_id", "item_id", "level", "package_id", "package_name",
        "base_qty", "uom_code", "length_cm", "width_cm", "height_cm", "volume_cbm",
        "gross_weight_kg", "tare_weight_kg", "max_stack_tiers", "is_rotatable",
        "fill_efficiency_pct", "is_default", "dims_from",
    )

    def __init__(self, **kw):
        for slot in self.__slots__:
            setattr(self, slot, kw.get(slot))

    @property
    def is_measured(self) -> bool:
        return self.volume_cbm is not None and self.volume_cbm > ZERO

    @property
    def box(self) -> tuple[Decimal, Decimal, Decimal] | None:
        return _box(self.length_cm, self.width_cm, self.height_cm)

    def as_dict(self) -> dict:
        return {
            "item_packaging_id": self.item_packaging_id,
            "item_id": self.item_id,
            "level": self.level,
            "package_id": self.package_id,
            "package_name": self.package_name,
            "base_qty": _q(self.base_qty, "0.001"),
            "uom_code": self.uom_code,
            "length_cm": _q(self.length_cm, "0.01"),
            "width_cm": _q(self.width_cm, "0.01"),
            "height_cm": _q(self.height_cm, "0.01"),
            "volume_cbm": _q(self.volume_cbm),
            "gross_weight_kg": _q(self.gross_weight_kg, "0.001"),
            "tare_weight_kg": _q(self.tare_weight_kg, "0.001"),
            "max_stack_tiers": self.max_stack_tiers,
            "is_rotatable": self.is_rotatable,
            "fill_efficiency_pct": _q(self.fill_efficiency_pct, "0.01"),
            "is_default": bool(self.is_default),
            "is_measured": self.is_measured,
            # Which record the box came from, so a screen can say "from the container
            # type" instead of leaving a storekeeper to guess why two items differ.
            "dims_from": self.dims_from,
        }


def _loose_pack(item: Item) -> Pack:
    """The bare "one unit of stock" rung. Not a real packaging row and deliberately not
    measured: an item with no ladder has no handling unit, and the honest answer to
    "how much room does it need" is that nobody has said."""
    return Pack(
        item_packaging_id=None, item_id=item.id, level=0, package_id=None,
        package_name="Loose — no pack configured", base_qty=ONE,
        uom_code=item.uom_code, volume_cbm=None, is_default=True, dims_from=None,
    )


async def pack_ladders(db: AsyncSession, item_ids) -> dict[int, list[Pack]]:
    """`{item_id: [Pack, ...]}` for many items in two queries.

    Two, not two per item: occupancy sums a whole bin and the suggestion chips cover a
    dozen bins at once, so a per-item round trip is the difference between a screen
    that opens and one that hangs.

    A rung whose level breaks the ladder's sequence is dropped along with everything
    above it — `base_qty` is a running product, and a gap in it silently multiplies the
    wrong rungs together, which would UNDERSTATE the space needed rather than fail.
    """
    ids = {int(i) for i in item_ids if i}
    if not ids:
        return {}

    # One item may carry several pack hierarchies (2026-10-08). Each is its own ladder
    # with its own level 1, so the running product is kept PER HIERARCHY and the
    # default hierarchy's rungs come first — that is the one an unspecified movement
    # is measured in.
    # One query: the hierarchy is joined only to ORDER the rungs (default first), so
    # reading a ladder costs exactly what it did before hierarchies existed.
    rungs = (await db.execute(
        select(ItemPackaging)
        .outerjoin(PackHierarchy, PackHierarchy.id == ItemPackaging.hierarchy_id)
        .where(ItemPackaging.item_id.in_(ids), ItemPackaging.is_active.is_(True))
        .order_by(ItemPackaging.item_id, PackHierarchy.is_default.desc(),
                  ItemPackaging.hierarchy_id, ItemPackaging.level)
    )).scalars().all()
    packages = {
        p.id: p for p in (await db.execute(
            select(Packaging).where(
                Packaging.id.in_({r.package_id for r in rungs if r.package_id}))
        )).scalars().all()
    } if rungs else {}

    out: dict[int, list[Pack]] = {item_id: [] for item_id in ids}
    running: dict[tuple, Decimal] = {}
    seen: dict[tuple, int] = {}
    broken: set[tuple] = set()
    for rung in rungs:
        key = (rung.item_id, getattr(rung, "hierarchy_id", None))
        if key in broken:
            continue
        if rung.level != seen.get(key, 0) + 1:
            broken.add(key)
            continue
        seen[key] = rung.level
        base = running.get(key, ONE) * (_pos(rung.quantity) or ONE)
        running[key] = base

        container = packages.get(rung.package_id)
        own = _box(rung.length_cm, rung.width_cm, rung.height_cm)
        inherited = (_box(container.length_cm, container.width_cm, container.height_cm)
                     if container else None)
        box = own or inherited
        out[rung.item_id].append(Pack(
            item_packaging_id=rung.id,
            item_id=rung.item_id,
            level=rung.level,
            package_id=rung.package_id,
            package_name=rung.package_name or (container.name if container else None),
            base_qty=base,
            uom_code=rung.uom_code,
            length_cm=box[0] if box else None,
            width_cm=box[1] if box else None,
            height_cm=box[2] if box else None,
            volume_cbm=_cube(box),
            gross_weight_kg=_pos(rung.gross_weight_kg),
            tare_weight_kg=_pos(container.weight_kg) if container else None,
            max_stack_tiers=(rung.max_stack_tiers
                             or (container.max_stack_tiers if container else None)),
            # Unknown means "may be turned". A container that genuinely may not be has
            # to be flagged, because assuming the restriction everywhere would report
            # half the warehouse as unable to accept goods it accepts every day.
            is_rotatable=(True if container is None or container.is_rotatable is None
                          else bool(container.is_rotatable)),
            fill_efficiency_pct=(_pos(container.fill_efficiency_pct)
                                 if container else None),
            is_default=bool(rung.is_default_putaway_unit),
            dims_from=("RUNG" if own else "PACKAGE" if inherited else None),
        ))
    return out


def choose_pack(packs: list[Pack], item_packaging_id: int | None = None) -> Pack | None:
    """Which rung this movement is measured in.

    The document's own choice wins: a putaway that says "three cases" is asking about
    cases, and second-guessing it would silently answer a different question. Failing
    that, the rung flagged as the default putaway unit; failing that, the LOWEST
    measured rung — the smallest pack the goods genuinely move in, which is how loose
    stock actually sits on a shelf and is the conservative choice of those available.

    None only when the item has no rungs at all. An item whose every rung is unmeasured
    still returns one, so a caller can NAME the pack it could not measure rather than
    showing a blank where a container type belongs.
    """
    if not packs:
        return None
    if item_packaging_id:
        chosen = next((p for p in packs if p.item_packaging_id == item_packaging_id),
                      None)
        if chosen is not None:
            return chosen
    flagged = [p for p in packs if p.is_default and p.is_measured]
    if flagged:
        return min(flagged, key=lambda p: p.level)
    measured = [p for p in packs if p.is_measured]
    if measured:
        return min(measured, key=lambda p: p.level)
    return min(packs, key=lambda p: (not p.is_default, p.level))


def space_for(pack: Pack | None, qty) -> dict:
    """What `qty` base units of this item actually take, as whole handling units.

        units  = ceil(qty / units per pack)
        volume = units x volume of one pack
        weight = units x gross weight of one pack

    `volume` and `weight` are None — separately — when the pack carries no box or no
    gross weight: a pack can be measured for cube and never weighed, and reporting a
    weight of zero would let an unweighed pallet sail through a payload check.
    """
    quantity = _d(qty)
    if pack is None:
        return {"units": None, "volume": None, "weight": None, "base_qty": None}
    per = _pos(pack.base_qty) or ONE
    units = _ceil(quantity / per) if quantity > ZERO else ZERO
    return {
        "units": units,
        "volume": None if not pack.is_measured else units * pack.volume_cbm,
        "weight": (None if pack.gross_weight_kg is None
                   else units * pack.gross_weight_kg),
        "base_qty": per,
    }


# --------------------------------------------------------------------------- #
#  The location's own spec
# --------------------------------------------------------------------------- #

class BinSpec:
    """What a storage location can be checked against, resolved once per call.

    `usable_volume` is the stated cube — or the one its three sides come to, so a bin
    measured once needs nothing typed twice — derated by the void factor. Every gate
    reads this rather than `capacity_volume` directly, so a location derated to 80% is
    derated everywhere at once instead of in whichever screen remembered.
    """

    __slots__ = ("stated_volume", "usable_volume", "fill_factor", "fill_pct",
                 "max_weight", "box", "max_units", "derived_volume")

    def __init__(self, location: Bin):
        self.box = _box(location.length_cm, location.width_cm, location.height_cm)
        stated = _pos(location.capacity_volume)
        self.derived_volume = stated is None and self.box is not None
        self.stated_volume = stated if stated is not None else _cube(self.box)
        self.fill_factor = _factor(location.fill_efficiency_pct)
        self.fill_pct = _pos(location.fill_efficiency_pct)
        self.usable_volume = (None if self.stated_volume is None
                              else self.stated_volume * self.fill_factor)
        self.max_weight = _pos(location.max_weight_capacity)
        self.max_units = (int(location.max_handling_units)
                          if location.max_handling_units else None)


def gross_volume(location: Bin) -> Decimal | None:
    """A location's own physical cube — stated, else worked out from its three sides.

    Deliberately NOT the same number as `BinSpec.usable_volume`, and deliberately not
    derated. `usable_volume` answers "how much stock will go in here", which is a
    question about gangway, reach and dunnage. This answers "does this box physically
    contain those boxes", which is a question about geometry: a rack derated to 80%
    still encloses all of its shelves, and derating the parent while not derating the
    children would refuse a warehouse that is laid out correctly.

    `None` means nobody has measured it. That is NOT zero — zero would read as "this
    location has no room", and every containment check below treats the two apart.
    """
    stated = _pos(location.capacity_volume)
    if stated is not None:
        return stated
    return _cube(_box(location.length_cm, location.width_cm, location.height_cm))


def volume_source(location: Bin) -> str | None:
    """Where `gross_volume` came from, so a screen can say which number to correct."""
    if _pos(location.capacity_volume) is not None:
        return "stated"
    if _box(location.length_cm, location.width_cm, location.height_cm) is not None:
        return "derived"
    return None


def fits_inside(pack: Pack, box: tuple[Decimal, Decimal, Decimal] | None) -> bool | None:
    """Does ONE of these physically enter that opening? None when either is unmeasured.

    A container is set down on its base, so the two horizontal sides may always be
    swapped — that is turning the pallet, not tipping it. Tipping is a different
    question and is allowed only where the container type says it may be turned: a drum
    may not go on its side, a carton may.
    """
    if box is None or pack.box is None:
        return None
    length, width, height = pack.box
    orientations = [(length, width, height), (width, length, height)]
    if pack.is_rotatable is not False:
        orientations += [
            (length, height, width), (height, length, width),
            (width, height, length), (height, width, length),
        ]
    return any(a <= box[0] and b <= box[1] and c <= box[2]
               for a, b, c in orientations)


def slot_capacity(pack: Pack, spec: BinSpec) -> int | None:
    """How many of these the bin holds, when nobody has stated a discrete limit.

    Proper 3D slotting rather than a cube division: how many fit across, how many deep,
    how many high — the last capped by the container's stack limit, because a tote rated
    for four tiers does not become eight because the bay is tall. Both horizontal
    orientations are tried and the better one wins, which is what a person does.
    """
    if spec.box is None or pack.box is None:
        return None
    length, width, height = pack.box
    tiers = int(spec.box[2] / height)
    if pack.max_stack_tiers:
        tiers = min(tiers, int(pack.max_stack_tiers))
    if tiers <= 0:
        return 0
    best = 0
    for across, deep in ((length, width), (width, length)):
        best = max(best, int(spec.box[0] / across) * int(spec.box[1] / deep))
    return best * tiers


# --------------------------------------------------------------------------- #
#  Gates
# --------------------------------------------------------------------------- #

def fill_status(capacity: Decimal | None, projected: Decimal | None) -> str:
    """What to call a gate holding `projected` out of `capacity`.

    One function so the putaway meter, the suggestion chips and the location tree cannot
    disagree about what "full" means — they did not have to agree while only one of them
    existed, which is exactly how they would drift.
    """
    if capacity is None or capacity <= ZERO:
        return STATUS_NO_CAPACITY
    if projected is None:
        return STATUS_UNMEASURED
    if projected > capacity:
        return STATUS_OVER
    if projected == capacity:
        return STATUS_FULL
    if projected >= capacity * TIGHT_AT:
        return STATUS_TIGHT
    return STATUS_OK


def _gate(key: str, label: str, unit: str, capacity, occupied, projected,
          *, detail: str, places: str = "0.000001", note: str | None = None) -> dict:
    """One measurable gate, rendered the same way whichever quantity it measures.

    A screen draws a bar from `pct` and a colour from `status` and writes none of the
    words — the same division of labour the whole module keeps.
    """
    status = fill_status(capacity, projected)
    free = (None if capacity is None or projected is None else capacity - projected)
    over = (-free if free is not None and free < ZERO else ZERO)
    return {
        "key": key, "label": label, "unit": unit, "status": status,
        "capacity": _q(capacity, places),
        "occupied": _q(occupied, places),
        "projected": _q(projected, places),
        "free": _q(free if free is None or free > ZERO else ZERO, places),
        "over_by": _q(over, places),
        "pct": (None if not capacity or projected is None
                else float(round(projected * HUNDRED / capacity, 2))),
        "detail": detail,
        "note": note,
    }


def _verdict_gate(key: str, label: str, status: str, detail: str,
                  note: str | None = None) -> dict:
    """A gate that is a yes/no rather than a fraction — the bounding-box check. Carries
    the same shape so a screen renders every gate through one component."""
    return {"key": key, "label": label, "unit": None, "status": status,
            "capacity": None, "occupied": None, "projected": None, "free": None,
            "over_by": None, "pct": None, "detail": detail, "note": note}


def _overall(gates: list[dict], *, has_unmeasured_move: bool) -> str:
    """One verdict from four.

    The worst ADVERSE gate wins, because passing three gates and failing one is failing.
    Where nothing is adverse, a move nobody could measure outranks a clean pass: a
    projection that could not count the very line being entered is not a statement about
    whether it fits. Only when no gate could be evaluated at all is the answer
    NO_CAPACITY — one gate saying OK is worth more than three saying nothing.
    """
    adverse = [g["status"] for g in gates if g["status"] in ADVERSE]
    if adverse:
        return min(adverse, key=lambda s: SEVERITY[s])
    if has_unmeasured_move:
        return STATUS_UNMEASURED
    if any(g["status"] == STATUS_OK for g in gates):
        return STATUS_OK
    if any(g["status"] == STATUS_UNMEASURED for g in gates):
        return STATUS_UNMEASURED
    return STATUS_NO_CAPACITY


# --------------------------------------------------------------------------- #
#  Reading a location
# --------------------------------------------------------------------------- #

async def subtree_ids(db: AsyncSession, location_id: int) -> list[int]:
    """This location and every location under it.

    A capacity may be set on a rack as easily as on a bin, and stock only ever sits in
    a bin — so "how full is this rack" is the sum of the bins beneath it. Walked
    breadth-first through `parent_id` for the reason `service.bin_tree` gives: derived
    ancestry cannot disagree with the tree it describes. The visited set stops a cycle
    in the data from becoming an infinite loop.
    """
    found: list[int] = [location_id]
    seen: set[int] = {location_id}
    frontier = [location_id]
    while frontier:
        children = [
            row[0] for row in (await db.execute(
                select(Bin.id).where(Bin.parent_id.in_(frontier))
            )).all()
        ]
        frontier = [cid for cid in children if cid not in seen]
        seen.update(frontier)
        found.extend(frontier)
    return found


async def occupied_space(db: AsyncSession, location_ids: list[int]) -> dict:
    """What the stock standing in these locations takes up, in handling units.

    Every item is resolved through its own default putaway unit and its quantity
    converted to whole packs — the same arithmetic a proposed move goes through, so the
    shelf's current reading and the projection after a putaway are made of the same
    thing. Returns what could NOT be counted alongside the total, because a figure that
    silently omits the unmeasured items reads as the truth and is not.
    """
    from app.modules.inventory.models import Stock

    empty = {"volume": ZERO, "weight": ZERO, "units": ZERO, "unmeasured_items": 0,
             "unmeasured_qty": ZERO, "measured_items": 0, "unweighed_items": 0}
    if not location_ids:
        return empty

    rows = (await db.execute(
        select(Stock.item_id, func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.bin_id.in_(location_ids), Stock.total_qty > 0)
        .group_by(Stock.item_id)
    )).all()
    if not rows:
        return empty

    ladders = await pack_ladders(db, [r[0] for r in rows])
    volume = weight = units = ZERO
    unmeasured_items = measured = unweighed = 0
    unmeasured_qty = ZERO
    for item_id, qty in rows:
        space = space_for(choose_pack(ladders.get(item_id, [])), qty)
        if space["volume"] is None:
            unmeasured_items += 1
            unmeasured_qty += _d(qty)
            continue
        measured += 1
        volume += space["volume"]
        units += space["units"] or ZERO
        if space["weight"] is None:
            unweighed += 1
        else:
            weight += space["weight"]
    return {"volume": volume, "weight": weight, "units": units,
            "unmeasured_items": unmeasured_items, "unmeasured_qty": unmeasured_qty,
            "measured_items": measured, "unweighed_items": unweighed}


async def _resolve_moves(db: AsyncSession, moves: list[dict]) -> list[dict]:
    """Turn `{item_id, qty, direction, item_packaging_id}` into handling units.

    A move whose pack has no box keeps its place in the list with `volume=None` rather
    than being dropped: the screen has to be able to say "two of these five lines could
    not be measured", and a silently shorter list says the opposite.
    """
    if not moves:
        return []
    ids = {int(mv["item_id"]) for mv in moves if mv.get("item_id")}
    items = {
        i.id: i for i in (await db.execute(
            select(Item).where(Item.id.in_(ids))
        )).scalars().all()
    } if ids else {}
    ladders = await pack_ladders(db, ids)

    resolved: list[dict] = []
    for mv in moves:
        item = items.get(int(mv["item_id"])) if mv.get("item_id") else None
        pack = choose_pack(ladders.get(item.id, []) if item else [],
                           mv.get("item_packaging_id"))
        if pack is None and item is not None:
            pack = _loose_pack(item)
        qty = _d(mv.get("qty"))
        direction = (mv.get("direction") or IN).upper()
        space = space_for(pack, qty)
        sign = ONE if direction == IN else -ONE
        resolved.append({
            "item_id": item.id if item else None,
            "item_name": item.name if item else None,
            "item_code": item.code if item else None,
            "uom_code": item.uom_code if item else None,
            "qty": _q(qty, "0.001"),
            "direction": direction,
            "pack": pack,
            "units": space["units"],
            "volume": space["volume"],
            "weight": space["weight"],
            "signed": None if space["volume"] is None else space["volume"] * sign,
            "signed_weight": (None if space["weight"] is None
                              else space["weight"] * sign),
            "signed_units": (None if space["volume"] is None or space["units"] is None
                             else space["units"] * sign),
        })
    return resolved


def _line_out(mv: dict) -> dict:
    """One proposed movement, as the screens read it."""
    pack: Pack | None = mv["pack"]
    return {
        "item_id": mv["item_id"], "item_code": mv["item_code"],
        "item_name": mv["item_name"], "uom_code": mv["uom_code"],
        "qty": mv["qty"], "direction": mv["direction"],
        "item_packaging_id": pack.item_packaging_id if pack else None,
        "pack_name": pack.package_name if pack else None,
        "pack_level": pack.level if pack else None,
        "pack_base_qty": _q(pack.base_qty, "0.001") if pack else None,
        "pack_volume_cbm": _q(pack.volume_cbm) if pack else None,
        "pack_gross_weight_kg": (_q(pack.gross_weight_kg, "0.001")
                                 if pack and pack.gross_weight_kg is not None else None),
        "handling_units": (_q(mv["units"], "0.001")
                           if mv["volume"] is not None else None),
        "volume": _q(mv["volume"]),
        "weight": _q(mv["weight"], "0.001") if mv["weight"] is not None else None,
    }


def _describe(status: str, *, code: str, gates: list[dict], move_units,
              pack_name: str | None, is_partial: bool,
              direction: str) -> tuple[str, str]:
    """The headline and the sentence under it.

    Wording lives here so the putaway screen, the issue screen and anything added later
    say the same thing about the same state — the rule the alert catalog exists for. A
    screen picks a colour from `status`; it never writes the words.

    The sentence names the GATE that decided, because "over capacity" without saying
    whether it was the cube, the payload or the door is advice nobody can act on.
    """
    caveat = (" Some of what is already here has no measured pack, so the real figure "
              "is higher than this." if is_partial else "")
    named = f" ({pack_name})" if pack_name else ""
    load = (f"{_plain(move_units)} unit{'' if move_units == ONE else 's'}{named}"
            if move_units else "this")

    if status == STATUS_NO_CAPACITY:
        return ("No capacity configured",
                f"Nobody has told {code} how much it holds, so there is nothing to "
                f"check against. Set a volume, a weight limit, the location's own "
                f"dimensions or a handling-unit limit under Warehouse masters to turn "
                f"this on.")
    if status == STATUS_UNMEASURED:
        return ("Pack not measured",
                f"This item has no measured packaging unit, so its share of {code} "
                f"cannot be worked out. Give its container type a length, width and "
                f"height under Masters > Packages, or measure the rung itself on the "
                f"item's Packaging tab.")

    failed = min((g for g in gates if g["status"] in ADVERSE),
                 key=lambda g: SEVERITY[g["status"]], default=None)
    if status == STATUS_WONT_FIT and failed is not None:
        return (f"{load} will not go into {code}",
                f"{failed['detail']} Nothing is stopped — place it and the exception is "
                f"recorded — but it will not sit in this location as measured.")
    if status == STATUS_OVER and failed is not None:
        return (f"{code} does not have room",
                f"{failed['detail']} Nothing is stopped — place it and the overflow is "
                f"recorded — but the location will be past what it is rated "
                f"for.{caveat}")
    if status == STATUS_FULL and failed is not None:
        return (f"{code} will be exactly full",
                f"{failed['detail']} Nothing more fits here afterwards.{caveat}")
    if status == STATUS_TIGHT and failed is not None:
        return (f"{code} is nearly full", f"{failed['detail']}{caveat}")

    passing = next((g for g in gates if g["status"] == STATUS_OK), None)
    if direction == OUT and move_units:
        return (f"{code} frees up {load}",
                (passing["detail"] if passing
                 else f"{load} comes off this location.") + caveat)
    return (f"{code} has room",
            (passing["detail"] if passing else f"{code} accepts {load}.") + caveat)


def _plain(value: Decimal | None) -> str:
    """A count without trailing zeros — `3`, not `3.000`. Handling units are counted,
    and a storekeeper reading "3.000 cases" wonders what the decimals are hiding."""
    if value is None:
        return "0"
    whole = value.to_integral_value()
    return str(whole if whole == value else value.normalize())


async def location_occupancy(
    db: AsyncSession,
    location_id: int,
    *,
    item_id: int | None = None,
    qty: Decimal | float | str | None = None,
    direction: str = IN,
    item_packaging_id: int | None = None,
    moves: list[dict] | None = None,
) -> dict:
    """The whole capacity picture for one location, optionally for proposed moves.

    With nothing proposed this answers "how full is this". With `item_id`/`qty` it also
    answers "and what happens if I put this here" (`direction=IN`) or "what does taking
    this out give me back" (`direction=OUT`) — one function, because putaway and
    material issue are the same question asked from either side, and two would drift.

    `moves` is the same question for a whole document: an issue takes several lines out
    of one bin and the freed space is their sum, so they are netted here rather than
    asked for one at a time and added up in a screen.
    """
    location = await db.get(Bin, location_id)
    if location is None:
        raise NotFoundError(f"Location {location_id} was not found")

    if moves is None:
        moves = ([{"item_id": item_id, "qty": qty, "direction": direction,
                   "item_packaging_id": item_packaging_id}]
                 if item_id else [])
    resolved = await _resolve_moves(db, moves)

    ids = await subtree_ids(db, location.id)
    held = await occupied_space(db, ids)
    spec = BinSpec(location)

    measured = [mv for mv in resolved if mv["signed"] is not None]
    unmeasured_moves = [mv for mv in resolved if mv["signed"] is None]
    weighed = [mv for mv in resolved if mv["signed_weight"] is not None]
    net_volume = sum((mv["signed"] for mv in measured), ZERO)
    net_units = sum((mv["signed_units"] for mv in measured), ZERO)
    net_weight = sum((mv["signed_weight"] for mv in weighed), ZERO)

    # Unsigned, because "this load is 0.6 m3" reads the same whichever way it is going;
    # `direction` says which way it moves the total.
    move_volume = abs(net_volume) if measured else None
    move_units = abs(net_units) if measured else None
    move_weight = abs(net_weight) if weighed else None
    move_direction = OUT if net_volume < ZERO or net_units < ZERO else IN

    def project(current: Decimal, delta: Decimal) -> Decimal:
        # Taking more out than the arithmetic says is in there is a measurement gap, not
        # a negative shelf. Floored so no screen ever shows minus one cubic metre.
        after = current + delta
        return after if after > ZERO else ZERO

    occupied, occupied_weight, occupied_units = (
        held["volume"], held["weight"], held["units"])
    projected = project(occupied, net_volume)
    projected_weight = project(occupied_weight, net_weight)
    projected_units = project(occupied_units, net_units)

    # The pack every gate reasons about. A single-line move has one; a document with
    # several has no one pack, so the footprint gate reads the LARGEST of them — if the
    # biggest carton will not go in, the load does not go in.
    biggest = max((mv["pack"] for mv in resolved
                   if mv["pack"] is not None and mv["pack"].is_measured),
                  key=lambda p: p.volume_cbm, default=None)

    gates: list[dict] = [_gate(
        GATE_VOLUME, "Cube", CBM, spec.usable_volume, occupied, projected,
        detail=_volume_detail(location.code, spec, projected, move_volume,
                              move_direction),
        note=(f"Derated to {_q(spec.fill_pct, '0.1')}% of "
              f"{_q(spec.stated_volume, '0.001')} {CBM} for void space."
              if spec.fill_pct else
              ("Worked out from the location's own dimensions."
               if spec.derived_volume else None)))]

    # Reported whenever there is a limit OR a load: a rack with no rating still tells
    # the floor what is standing on it, which is how the rating eventually gets set.
    if spec.max_weight or move_weight or occupied_weight:
        gates.append(_gate(
            GATE_WEIGHT, "Payload", KG, spec.max_weight, occupied_weight,
            projected_weight, places="0.001",
            detail=_weight_detail(location.code, spec, projected_weight, move_weight),
            note=(f"{len(resolved) - len(weighed)} of {len(resolved)} lines carry no "
                  f"gross weight." if resolved and len(weighed) < len(resolved)
                  else None)))

    # Only on the way IN. "Does it fit through the door" is not a question about goods
    # being taken off a shelf they are already sitting on.
    if biggest is not None and move_direction == IN:
        gates.append(_footprint_gate(location.code, spec, biggest))

    unit_cap, unit_note = spec.max_units, "Stated limit for this location."
    if unit_cap is None and biggest is not None:
        unit_cap = slot_capacity(biggest, spec)
        unit_note = ("Slotted from the location's dimensions and the pack's stack limit."
                     if unit_cap is not None else None)
    if unit_cap is not None:
        gates.append(_gate(
            GATE_UNITS, "Handling units", "units", _d(unit_cap), occupied_units,
            projected_units, places="0.001",
            detail=(f"{_plain(projected_units)} of {unit_cap} handling units in "
                    f"{location.code}{' after this' if move_units else ''}."),
            note=unit_note))

    status = _overall(gates, has_unmeasured_move=bool(resolved and not measured))
    is_partial = held["unmeasured_items"] > 0 or bool(unmeasured_moves)
    only = resolved[0] if len(resolved) == 1 else None
    only_pack: Pack | None = only["pack"] if only else None
    cube = gates[0]
    headline, detail = _describe(
        status, code=location.code, gates=gates, move_units=move_units,
        pack_name=(only_pack.package_name if only_pack else None),
        is_partial=is_partial, direction=move_direction)

    return {
        "location_id": location.id,
        "location_code": location.code,
        "location_name": location.name,
        "bin_type": location.bin_type,
        "is_pickable": location.is_pickable,
        # A capacity set on a rack covers the bins under it, so the caller is told how
        # many locations this figure actually sums over.
        "counts_locations": len(ids),

        # --- the cube, at the top level because it is the headline figure ---
        "capacity_volume": _q(spec.usable_volume),
        "stated_volume": _q(spec.stated_volume),
        "fill_efficiency_pct": _q(spec.fill_pct, "0.01"),
        "occupied_volume": _q(occupied),
        "free_volume": _q(None if spec.usable_volume is None
                          else spec.usable_volume - occupied),
        "utilisation_pct": (None if not spec.usable_volume else
                            float(round(occupied * HUNDRED / spec.usable_volume, 2))),
        "projected_volume": _q(projected),
        "projected_free_volume": cube["free"],
        "projected_pct": cube["pct"],
        "over_by": cube["over_by"],

        # --- the other three gates, each complete in itself ---
        "gates": gates,
        "capacity_weight_kg": _q(spec.max_weight, "0.001"),
        "occupied_weight_kg": _q(occupied_weight, "0.001"),
        "projected_weight_kg": _q(projected_weight, "0.001"),
        "capacity_units": unit_cap,
        "occupied_units": _q(occupied_units, "0.001"),
        "projected_units": _q(projected_units, "0.001"),
        "location_length_cm": _q(location.length_cm, "0.01"),
        "location_width_cm": _q(location.width_cm, "0.01"),
        "location_height_cm": _q(location.height_cm, "0.01"),

        # --- honesty ---
        "unmeasured_items": held["unmeasured_items"],
        "unmeasured_qty": _q(held["unmeasured_qty"], "0.001"),
        "measured_items": held["measured_items"],
        "unmeasured_lines": len(unmeasured_moves),
        "is_partial": is_partial,

        # --- the single-move fields. A document with several lines has no one item or
        # pack, so they stay None and the screen reads `lines` instead.
        "item_id": only["item_id"] if only else None,
        "item_name": only["item_name"] if only else None,
        "qty": only["qty"] if only else None,
        "item_packaging_id": only_pack.item_packaging_id if only_pack else None,
        "pack_name": only_pack.package_name if only_pack else None,
        "pack_base_qty": _q(only_pack.base_qty, "0.001") if only_pack else None,
        "pack_volume_cbm": _q(only_pack.volume_cbm) if only_pack else None,
        # The pack's own sides, so a screen can picture it against the opening rather
        # than asking the reader to compare two cubic figures in their head.
        "pack_length_cm": _q(only_pack.length_cm, "0.01") if only_pack else None,
        "pack_width_cm": _q(only_pack.width_cm, "0.01") if only_pack else None,
        "pack_height_cm": _q(only_pack.height_cm, "0.01") if only_pack else None,
        "pack_gross_weight_kg": (
            _q(only_pack.gross_weight_kg, "0.001")
            if only_pack and only_pack.gross_weight_kg is not None else None),
        "direction": move_direction,
        "move_volume": _q(move_volume),
        "move_weight": _q(move_weight, "0.001") if move_weight is not None else None,
        "move_units": _q(move_units, "0.001") if move_units is not None else None,
        "lines": [_line_out(mv) for mv in resolved],

        "status": status,
        "headline": headline,
        "detail": detail,
    }


def _volume_detail(code: str, spec: BinSpec, projected: Decimal, move_volume,
                   direction: str) -> str:
    if spec.usable_volume is None:
        return (f"{code} has no volume capacity and no dimensions, so its cube cannot "
                f"be checked.")
    free = spec.usable_volume - projected
    usable = _q(spec.usable_volume, "0.001")
    if free < ZERO:
        return (f"This puts {_q(-free, '0.001')} {CBM} more into {code} than the "
                f"{usable} {CBM} it holds.")
    if direction == OUT and move_volume:
        return f"{_q(free, '0.001')} {CBM} of {usable} {CBM} free once this leaves."
    return (f"{_q(free, '0.001')} {CBM} of {usable} {CBM} free"
            f"{' after this' if move_volume else ''}.")


def _weight_detail(code: str, spec: BinSpec, projected_weight: Decimal,
                   move_weight) -> str:
    if spec.max_weight is None:
        return (f"{_q(projected_weight, '0.001')} {KG} on {code}, which has no weight "
                f"limit set — the load is reported but not checked.")
    free = spec.max_weight - projected_weight
    rated = _q(spec.max_weight, "0.001")
    if free < ZERO:
        return (f"This puts {_q(-free, '0.001')} {KG} more on {code} than the {rated} "
                f"{KG} it is rated to carry.")
    return (f"{_q(free, '0.001')} {KG} of {rated} {KG} spare"
            f"{' after this' if move_weight else ''}.")


def _footprint_gate(code: str, spec: BinSpec, pack: Pack) -> dict:
    """Does one unit physically go in? The gate loose volume can never express."""
    named = pack.package_name or "This pack"
    turning = (None if pack.is_rotatable is not False
               else "This container may not be turned on its side.")
    if spec.box is None:
        return _verdict_gate(
            GATE_FOOTPRINT, "Fit", STATUS_NO_CAPACITY,
            f"{code} has no length, width and height recorded, so whether {named} "
            f"physically goes in cannot be checked.")
    if pack.box is None:
        return _verdict_gate(
            GATE_FOOTPRINT, "Fit", STATUS_UNMEASURED,
            f"{named} has no dimensions, so it cannot be checked against {code}'s "
            f"{_sides(spec.box)} opening.")
    if fits_inside(pack, spec.box):
        return _verdict_gate(
            GATE_FOOTPRINT, "Fit", STATUS_OK,
            f"{named} at {_sides(pack.box)} goes into {code}'s {_sides(spec.box)}"
            + ("." if turning is None else " without turning."), note=turning)
    return _verdict_gate(
        GATE_FOOTPRINT, "Fit", STATUS_WONT_FIT,
        f"{named} measures {_sides(pack.box)} and {code} opens to "
        f"{_sides(spec.box)}, so it does not go in"
        + ("." if turning is None else " — and it may not be turned."), note=turning)


async def occupancy_preview(db: AsyncSession, moves: list[dict]) -> list[dict]:
    """One occupancy row per location a document touches, netted over its lines.

    The material issue form asks this: a draft takes five lines out of three bins, and
    "what does this do to each of those bins" is three answers, not fifteen. Moves with
    no location are dropped — a line whose bin has not been chosen yet is not yet a
    claim on anybody's shelf.
    """
    grouped: dict[int, list[dict]] = {}
    for mv in moves or []:
        location_id = mv.get("location_id")
        if not location_id:
            continue
        grouped.setdefault(int(location_id), []).append(mv)
    rows = [await location_occupancy(db, location_id, moves=lines)
            for location_id, lines in grouped.items()]
    # Worst first: a shelf that will not take the load is the row the storekeeper has to
    # see, and it must not be the one below the fold.
    return sorted(rows, key=lambda r: (SEVERITY.get(r["status"], 9), r["location_code"]))


async def bin_occupancy_map(db: AsyncSession, bins: list[Bin]) -> dict[int, dict]:
    """`{bin_id: {capacity, occupied, free, status}}` for a handful of bins, in three
    queries.

    The suggested-bin chips need "how much room is left" for every option at once, and
    calling `location_occupancy` per chip would be a subtree walk plus several queries
    each. Only real bins are summed — a suggestion is always a bin, so there is no
    subtree to roll up here.
    """
    from app.modules.inventory.models import Stock

    ids = [b.id for b in bins if b.id]
    if not ids:
        return {}

    rows = (await db.execute(
        select(Stock.bin_id, Stock.item_id, func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.bin_id.in_(ids), Stock.total_qty > 0)
        .group_by(Stock.bin_id, Stock.item_id)
    )).all()
    ladders = await pack_ladders(db, {r[1] for r in rows}) if rows else {}

    volumes: dict[int, Decimal] = {}
    weights: dict[int, Decimal] = {}
    units: dict[int, Decimal] = {}
    partial: set[int] = set()
    for bin_id, item_id, qty in rows:
        space = space_for(choose_pack(ladders.get(item_id, [])), qty)
        if space["volume"] is None:
            partial.add(bin_id)
            continue
        volumes[bin_id] = volumes.get(bin_id, ZERO) + space["volume"]
        units[bin_id] = units.get(bin_id, ZERO) + (space["units"] or ZERO)
        if space["weight"] is not None:
            weights[bin_id] = weights.get(bin_id, ZERO) + space["weight"]

    out: dict[int, dict] = {}
    for b in bins:
        spec = BinSpec(b)
        occupied = volumes.get(b.id, ZERO)
        held_units = units.get(b.id, ZERO)
        held_weight = weights.get(b.id, ZERO)
        # The chips are ranked on the cube, but a bay already at its stated pallet limit
        # is full whatever its cube says — and a rack at its payload is full too. The
        # worst of the three verdicts wins, which is the same rule `_overall` applies.
        verdicts = [fill_status(spec.usable_volume, occupied)]
        if spec.max_units:
            verdicts.append(fill_status(_d(spec.max_units), held_units))
        if spec.max_weight:
            verdicts.append(fill_status(spec.max_weight, held_weight))
        out[b.id] = {
            "capacity_volume": _q(spec.usable_volume),
            "occupied_volume": _q(occupied),
            "free_volume": _q(None if spec.usable_volume is None
                              else spec.usable_volume - occupied),
            "capacity_units": spec.max_units,
            "occupied_units": _q(held_units, "0.001"),
            "capacity_weight_kg": _q(spec.max_weight, "0.001"),
            "occupied_weight_kg": _q(held_weight, "0.001"),
            "utilisation_pct": (
                None if not spec.usable_volume
                else float(round(occupied * HUNDRED / spec.usable_volume, 2))),
            "is_partial": b.id in partial,
            "status": min(verdicts, key=lambda s: SEVERITY[s]),
        }
    return out


# `suggestion_fit` and `SUGGESTION_RANK` were here.
#
# They ranked a shortlist of bins for the putaway screen on whether the pack in
# hand actually went in, rather than on free cube — which was the right answer to
# the wrong question. A suggestion only makes sense while a putaway can be confirmed
# into a BIN and nothing else, so the screen HAS to narrow nine hundred bays down to
# eight. Placement is not narrow any more: a putaway lands on any rung of the tree,
# because a pallet of drums stands at the end of a lane and a delivery can arrive
# before its bay is built. Eight ranked bays in front of somebody who may correctly
# choose any of nine hundred locations is a wrong answer with an ordering on it.
#
# What the ranking was genuinely good at — saying "this pack does not go in" rather
# than "this bay looks empty" — is what `location_occupancy` says about whichever
# location was actually chosen, through the same four gates. Nothing was lost but
# the shortlist.


async def handling_units(db: AsyncSession, item_id: int) -> list[dict]:
    """The packaging units one item can be put away in — what the putaway picker shows.

    Served rather than assembled in the screen for the reason everything else here is:
    the volume of a rung, which box it inherited and which one is the default are
    decided in ONE place, so the number on the picker is the number the check will use.
    """
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} was not found")
    packs = (await pack_ladders(db, [item_id])).get(item_id, [])
    chosen = choose_pack(packs)
    return [
        {**p.as_dict(),
         "is_default": bool(chosen and p.item_packaging_id == chosen.item_packaging_id)}
        for p in packs
    ]


__all__ = [
    "ADVERSE", "BIN_TYPES", "BinSpec", "GATE_FOOTPRINT", "GATE_UNITS", "GATE_VOLUME",
    "GATE_WEIGHT", "IN", "OUT", "Pack", "SEVERITY", "STATUS_FULL", "STATUS_NO_CAPACITY",
    "STATUS_OK", "STATUS_OVER", "STATUS_TIGHT", "STATUS_UNMEASURED", "STATUS_WONT_FIT",
    "bin_occupancy_map", "choose_pack", "fill_status", "fits_inside", "gross_volume",
    "handling_units", "location_occupancy", "occupancy_preview", "occupied_space",
    "pack_ladders", "slot_capacity", "space_for", "subtree_ids", "volume_source",
]
