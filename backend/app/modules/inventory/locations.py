"""Where a stocking point sits, and what a move between two of them IS.

The one place these two rules live. Warehouse and every later module call in here;
none of them re-derive it, because two copies of "is this a transfer?" is two answers
to "does the Inventory Manager have to approve this?".

Nothing here is stored on a document. A movement's kind is a function of its two
endpoints, so it is computed on the way in and can never disagree with them.
"""
import logging

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.hcm import sync as hcm_sync
from app.shared.enums import DocType, WarehouseType
from app.shared.models.warehouse import Warehouse

from .enums import LocationTier, MovementKind
from .models import NO_PROJECT, PositionLocation, Stock

logger = logging.getLogger(__name__)

# Only LIP and MDP are rungs on the distribution chain. Everything else a warehouse
# can be — MAIN, TRANSIT, QUARANTINE, SCRAP — sits at the top: they are all places
# stock arrives from the outside world rather than places served by someone above.
_TIER_BY_TYPE = {
    WarehouseType.LIP.value: LocationTier.LIP,
    WarehouseType.MDP.value: LocationTier.MDP,
}


def tier_of(warehouse_type: str | None) -> LocationTier:
    """The rung a stocking point sits on. Unknown types read as WAREHOUSE, the top —
    an unrecognised type must not silently become a leaf that nothing can serve."""
    return _TIER_BY_TYPE.get((warehouse_type or "").upper(), LocationTier.WAREHOUSE)


def classify(
    from_warehouse_id: int | None, from_type: str | None,
    to_warehouse_id: int | None, to_type: str | None,
) -> MovementKind:
    """What this move is, from where it starts and where it lands.

    Same point -> MOVEMENT (a bin/rack change inside one building).
    Same tier, different point -> TRANSFER.
    Downstream -> ISSUE. Upstream -> RETURN.
    """
    if from_warehouse_id is not None and from_warehouse_id == to_warehouse_id:
        return MovementKind.MOVEMENT

    source, target = tier_of(from_type), tier_of(to_type)
    if source == target:
        return MovementKind.TRANSFER
    # Tier numbers grow downstream, so a bigger target is a step down the chain.
    return MovementKind.ISSUE if source.value < target.value else MovementKind.RETURN


async def classify_ids(
    db: AsyncSession, from_warehouse_id: int | None, to_warehouse_id: int | None,
) -> MovementKind:
    """`classify` for callers holding only ids. One query for both endpoints."""
    types = await _types_for(db, from_warehouse_id, to_warehouse_id)
    return classify(
        from_warehouse_id, types.get(from_warehouse_id),
        to_warehouse_id, types.get(to_warehouse_id),
    )


async def _types_for(db: AsyncSession, *warehouse_ids: int | None) -> dict[int, str]:
    wanted = {wid for wid in warehouse_ids if wid is not None}
    if not wanted:
        return {}
    rows = (await db.execute(
        select(Warehouse.id, Warehouse.warehouse_type).where(Warehouse.id.in_(wanted))
    )).all()
    return {row[0]: row[1] for row in rows}


async def project_of_location(db: AsyncSession, warehouse_id: int | None) -> int:
    """The project a stocking point serves, or NO_PROJECT when it is unassigned.

    Read off the position tagging rather than the warehouse: `whs_warehouses` has no
    project column, and the tagging row is where the project was captured. A point
    tagged to positions from two projects reads as NO_PROJECT — genuinely shared, so
    a move touching it is never treated as crossing a boundary on its account.
    """
    if warehouse_id is None:
        return NO_PROJECT
    projects = set((await db.execute(
        select(PositionLocation.project_id).where(
            PositionLocation.warehouse_id == warehouse_id,
            PositionLocation.is_active == 1,
        ).distinct()
    )).scalars().all())
    projects.discard(NO_PROJECT)
    return next(iter(projects)) if len(projects) == 1 else NO_PROJECT


async def needs_inventory_manager(
    db: AsyncSession, from_warehouse_id: int | None, to_warehouse_id: int | None,
) -> bool:
    """Does this move need the Inventory Manager's approval?

    Only a TRANSFER can: an issue down one's own chain is the holder's call, and a
    bin change inside a building is not a decision at all. A transfer between two
    points of the SAME project is likewise the holder's own business. It is the
    project boundary that needs a referee, because that is where the cost lands.

    An unknown project on either side answers False. Blocking every move whose
    tagging is incomplete would strand the flow on missing master data, which is
    exactly the failure the workflow fallbacks exist to prevent.
    """
    if await classify_ids(db, from_warehouse_id, to_warehouse_id) != MovementKind.TRANSFER:
        return False
    source = await project_of_location(db, from_warehouse_id)
    target = await project_of_location(db, to_warehouse_id)
    if source == NO_PROJECT or target == NO_PROJECT:
        return False
    return source != target


async def location_ids_for_subtree(db: AsyncSession, position_id: int | None) -> set[int]:
    """Every stocking point this position can see: its own, plus every point tagged
    to a position reporting under it, however deep.

    This is what lets a DM look down and find which OE below him is holding the
    stock. The descent mirrors the ladder resolver's climb — same column, opposite
    direction — so visibility and approval can never disagree about who is under whom.
    """
    if position_id is None:
        return set()

    # Memoised for the life of ONE request (see shared/scope.py `_memo` for why the
    # session is the right lifetime). The descent costs a query per level of the org
    # chart and is re-run on every scoped read; a batch approval asks for the same
    # position's subtree once per indent and gets the same answer every time, because
    # nothing a request does moves a position or a tag.
    cache = db.info.setdefault("subtree_points_memo", {})
    if position_id in cache:
        return set(cache[position_id])

    seen: set[int] = {position_id}
    frontier = [position_id]
    while frontier:
        children = set((await db.execute(
            select(HcmPosition.id).where(HcmPosition.parent_position_id.in_(frontier))
        )).scalars().all())
        frontier = list(children - seen)
        seen |= children

    points = set((await db.execute(
        select(PositionLocation.warehouse_id).where(
            PositionLocation.position_id.in_(seen),
            PositionLocation.is_active == 1,
        )
    )).scalars().all())
    cache[position_id] = set(points)
    return points


async def active_positions_of(db: AsyncSession, user) -> set[int]:
    """Every LIVE post this login holds — not just the hat they happen to be wearing.

    Both sides have to be alive. The assignment rows survive a cutover but the posts
    do not: 4,002 of the 8,007 assignments still name a position HCM retired, and
    those retired posts sit at the top of the name sort, so the hat a login lands on
    is routinely a dead one whose reporting tree nobody was ever moved into.
    """
    if user is None:
        return set()
    positions = set((await db.execute(
        select(HcmPositionAssignment.position_id)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(HcmPositionAssignment.employee_id == user.id,
               HcmPositionAssignment.is_active.is_(True),
               HcmPosition.is_active.is_(True))
    )).scalars().all())
    # The hat in hand counts even if the two tables disagree about it — narrowing a
    # login below what it is actively acting as would take away access it has today.
    active = getattr(user, "active_position_id", None)
    if active is not None:
        positions.add(active)
    return positions


async def location_ids_for_user(db: AsyncSession, user) -> set[int]:
    """Every stocking point this PERSON can draw from: their own points and their
    reportees', across every live post they hold.

    Per person, not per hat. A DM holds four posts — "DM MDP PADERU", two generations
    of "DM-104-PADERU", a storekeeper post — and the storekeepers carrying the stock
    hang off only one of them. Scoping to the selected hat meant the same human saw
    12,160 units under one and nothing under another, which reads as missing stock
    rather than as a hat they forgot to switch. Every post is still them, so every
    post's reportees are still their reportees.
    """
    points: set[int] = set()
    for position_id in await active_positions_of(db, user):
        points |= await location_ids_for_subtree(db, position_id)
    return points


async def primary_location_for(db: AsyncSession, position_id: int | None) -> int | None:
    """The point a position issues from by default — its primary, else its only one."""
    if position_id is None:
        return None
    rows = (await db.execute(
        select(PositionLocation.warehouse_id, PositionLocation.is_primary).where(
            PositionLocation.position_id == position_id,
            PositionLocation.is_active == 1,
        ).order_by(PositionLocation.is_primary.desc(), PositionLocation.id)
    )).all()
    return rows[0][0] if rows else None


async def ensure_point_for_position(db: AsyncSession, position_id: int | None) -> int | None:
    """The stocking point a position draws into, provisioning one if it has none.

    Field staff — storekeeper, lab technician, DEO — do not get a stocking point
    assigned to them: the office their POSITION already sits at IS their Local
    Inventory Point. Making somebody tag each one by hand would mean every new joiner
    silently cannot receive stock until an administrator noticed, which is exactly how
    an indent ends up approved with nowhere to deliver.

    So the office is turned into a LIP the first time one is needed: one warehouse per
    office, `LIP-<office id>`, carrying the office's own name. Idempotent — the second
    caller finds the row the first one made. An explicit tag always wins, so anyone who
    has been placed somewhere deliberately keeps that placement.
    """
    if position_id is None:
        return None

    existing = await primary_location_for(db, position_id)
    if existing is not None:
        return existing

    office = (await db.execute(
        select(HcmPosition.office_id, HcmPosition.name)
        .where(HcmPosition.id == position_id)
    )).first()
    if office is None or office[0] is None:
        return None
    office_id, position_name = office

    warehouse_id = (await db.execute(
        select(Warehouse.id).where(
            Warehouse.office_id == office_id,
            Warehouse.warehouse_type == WarehouseType.LIP.value,
            Warehouse.is_active.is_(True),
        ).limit(1)
    )).scalar_one_or_none()

    if warehouse_id is None:
        office_name = (await db.execute(
            select(HcmOffice.name).where(HcmOffice.id == office_id)
        )).scalar_one_or_none()
        label = office_name or f"Office {office_id}"
        warehouse = Warehouse(
            code=f"LIP-{office_id}",
            name=f"{label} — Local Inventory Point",
            office_id=office_id,
            office_name=office_name,
            warehouse_type=WarehouseType.LIP.value,
            is_bin_managed=False,
            is_active=True,
        )
        db.add(warehouse)
        await db.flush()
        warehouse_id = warehouse.id
        logger.info(
            "Provisioned LIP %s for office %s, first needed by position %s (%s)",
            warehouse.code, office_id, position_id, position_name,
        )

    db.add(PositionLocation(
        position_id=position_id, warehouse_id=warehouse_id,
        project_id=NO_PROJECT, is_primary=1, is_active=1,
    ))
    await db.flush()
    db.info.pop("subtree_points_memo", None)
    return warehouse_id


async def warehouses_visible_to(db: AsyncSession, user) -> set[int] | None:
    """Subtree-scoped stocking points for a login, or None when unscoped.

    None means "no tagging reaches this user" — the caller keeps whatever scope it
    already had, so adding this layer can never take away access someone has today.
    """
    if user is None:
        return None
    visible = await location_ids_for_user(db, user)
    return visible or None


# ---------------- Service-level operations over the tagging ----------------

_TIER_LABEL = {
    LocationTier.WAREHOUSE: "Warehouse",
    LocationTier.MDP: "Material Distribution Point",
    LocationTier.LIP: "Local Inventory Point",
}


# What each stocking-point type is called on screen. LIP and MDP are rungs on the
# distribution chain, not warehouses, and the people holding them never call them one.
POINT_LABEL = {
    WarehouseType.MDP.value: "MDP",
    WarehouseType.LIP.value: "LIP",
}


async def describe_point(db: AsyncSession, warehouse_id: int | None) -> dict:
    """Name and screen label for one stocking point. Falls back to "Warehouse"."""
    if warehouse_id is None:
        return {"point_type": None, "point_name": None, "point_label": "Warehouse"}
    row = (await db.execute(
        select(Warehouse.warehouse_type, Warehouse.name).where(Warehouse.id == warehouse_id)
    )).first()
    if row is None:
        return {"point_type": None, "point_name": None, "point_label": "Warehouse"}
    warehouse_type = (row.warehouse_type or "").upper()
    return {
        "point_type": warehouse_type or None,
        "point_name": row.name,
        "point_label": POINT_LABEL.get(warehouse_type, "Warehouse"),
    }


def tier_label(tier: LocationTier) -> str:
    return _TIER_LABEL[tier]


async def describe_move(
    db: AsyncSession, from_warehouse_id: int | None, to_warehouse_id: int | None,
) -> dict:
    """Everything the screen needs to show about a proposed move, computed not chosen."""
    types = await _types_for(db, from_warehouse_id, to_warehouse_id)
    source = tier_of(types.get(from_warehouse_id))
    target = tier_of(types.get(to_warehouse_id))
    kind = classify(
        from_warehouse_id, types.get(from_warehouse_id),
        to_warehouse_id, types.get(to_warehouse_id),
    )
    gated = await needs_inventory_manager(db, from_warehouse_id, to_warehouse_id)

    if kind == MovementKind.MOVEMENT:
        why = "Same stocking point — this is a bin or rack change inside one building."
    elif kind == MovementKind.TRANSFER:
        why = (
            "Both points sit on the same tier. Crossing a project boundary, so the "
            "Inventory Manager has to approve it."
            if gated else
            "Both points sit on the same tier and the same project, so it is yours to make."
        )
    elif kind == MovementKind.ISSUE:
        why = f"{tier_label(source)} down to {tier_label(target)} — an issue."
    else:
        why = f"{tier_label(source)} back up to {tier_label(target)} — a return."

    return {
        "from_warehouse_id": from_warehouse_id,
        "to_warehouse_id": to_warehouse_id,
        "from_tier": source.value,
        "to_tier": target.value,
        "movement_kind": kind.value,
        "doc_type": DocType.STOCK_TRANSFER.value if kind == MovementKind.TRANSFER else kind.value,
        "needs_inventory_manager": gated,
        "explanation": why,
    }


async def list_tags(db: AsyncSession, position_id: int | None = None) -> list[dict]:
    """The tagging, joined to what a screen needs to render it."""
    stmt = (
        select(PositionLocation, Warehouse.code, Warehouse.name,
               Warehouse.warehouse_type, HcmPosition.name)
        .outerjoin(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
        .outerjoin(HcmPosition, HcmPosition.id == PositionLocation.position_id)
        .where(PositionLocation.is_active == 1)
        .order_by(PositionLocation.position_id, PositionLocation.is_primary.desc())
    )
    if position_id is not None:
        stmt = stmt.where(PositionLocation.position_id == position_id)

    out = []
    for tag, code, name, wh_type, position_name in (await db.execute(stmt)).all():
        tier = tier_of(wh_type)
        out.append({
            "id": tag.id, "position_id": tag.position_id,
            "position_name": position_name,
            "warehouse_id": tag.warehouse_id, "warehouse_code": code,
            "warehouse_name": name, "warehouse_type": wh_type,
            "tier": tier.value, "tier_label": tier_label(tier),
            "project_id": tag.project_id or 0, "project_name": tag.project_name,
            "is_primary": bool(tag.is_primary),
        })
    return out


def _tag_row(tag, code, name, wh_type, position_name) -> dict:
    """One tagging, joined to what a screen needs to render it."""
    tier = tier_of(wh_type)
    return {
        "id": tag.id, "position_id": tag.position_id,
        "position_name": position_name,
        "warehouse_id": tag.warehouse_id, "warehouse_code": code,
        "warehouse_name": name, "warehouse_type": wh_type,
        "tier": tier.value, "tier_label": tier_label(tier),
        "project_id": tag.project_id or 0, "project_name": tag.project_name,
        "is_primary": bool(tag.is_primary),
    }


async def _holders_of(db: AsyncSession, position_ids: set[int]) -> dict[int, list[dict]]:
    """Who stands in each post. Looked up separately rather than joined into the page,
    because a position carries more than one assignment row and joining it would
    multiply the tagging: one tag would be listed once per holder, and the total above
    the list would count taggings that do not exist."""
    if not position_ids:
        return {}
    rows = (await db.execute(
        select(HcmPositionAssignment.position_id,
               HcmEmployee.emp_code, HcmEmployee.full_name)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.position_id.in_(position_ids))
    )).all()
    holders: dict[int, list[dict]] = {}
    for position_id, code, full_name in rows:
        holders.setdefault(position_id, []).append(
            {"employee_code": code, "employee_name": full_name})
    return holders


async def stock_at_points(db: AsyncSession, warehouse_ids: set[int]) -> dict[int, dict]:
    """On-hand at each stocking point: how many distinct items, and how much in total.

    Unscoped on purpose — the caller has already decided which points may be read, and
    the number has to be the point's real holding or "what has this OE got" answers
    with a figure nobody can reconcile against the stock screens.
    """
    if not warehouse_ids:
        return {}
    rows = (await db.execute(
        select(Stock.warehouse_id,
               func.count(func.distinct(Stock.item_id)),
               func.sum(Stock.available_qty))
        .where(Stock.warehouse_id.in_(warehouse_ids), Stock.available_qty > 0)
        .group_by(Stock.warehouse_id)
    )).all()
    return {wid: {"stock_items": int(items or 0), "stock_qty": float(qty or 0)}
            for wid, items, qty in rows}


async def search_tags(db: AsyncSession, user, *, search: str | None = None,
                      tier: int | None = None, project_id: int | None = None,
                      page: int = 1, size: int = 25) -> dict:
    """The tagging as the Stocking Points screen reads it: scoped, filtered, paged.

    Separate from `list_tags` on purpose. That one answers a mechanical question —
    "which points does THIS position hold?" — for the engine and for /mine, and must
    stay complete and unscoped or a login would stop being able to see its own point.
    This one answers a person's question, so it is narrowed to what that person may
    see (`project_condition`, the same predicate the BOM groups master uses) and cut
    to a page: the live tagging is 2,001 rows, which is neither searchable nor
    sendable in one response.

    Tier is filtered on the WAREHOUSE TYPE rather than on a stored column, because the
    tier is derived from the warehouse and is never written onto the tag (a point must
    not be an MDP on one tag and a LIP on another).
    """
    from app.shared.scope import project_condition

    # Built once and applied to all three queries below — the page, its total and the
    # per-rung counts must describe the SAME set, and they only do if they cannot
    # drift apart by being filtered in three places.
    conditions = [
        PositionLocation.is_active == 1,
        # NO_PROJECT (0) is this table's spelling of "no project", so it has to be
        # named or every unassigned row would read as project 0 and vanish.
        await project_condition(db, user, PositionLocation.project_id,
                                unassigned=NO_PROJECT),
    ]
    if search and search.strip():
        like = f"%{search.strip()}%"
        conditions.append(or_(
            HcmPosition.name.ilike(like),
            Warehouse.name.ilike(like),
            Warehouse.code.ilike(like),
            PositionLocation.project_name.ilike(like),
            # The person, not just the post. Nobody browsing this screen knows which of
            # an OE's four posts holds the stocking point, so typing "HR-EMP-07278" or
            # their name has to answer with every point that employee reaches. A
            # subquery rather than a join: a position carries several assignment rows
            # and joining would list each tagging once per holder.
            PositionLocation.position_id.in_(
                select(HcmPositionAssignment.position_id)
                .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
                .where(or_(HcmEmployee.emp_code.ilike(like),
                           HcmEmployee.full_name.ilike(like)))
            ),
        ))
    if project_id is not None:
        conditions.append(PositionLocation.project_id == project_id)
    if tier is not None:
        types = [t for t, rung in _TIER_BY_TYPE.items() if rung.value == tier]
        conditions.append(
            Warehouse.warehouse_type.in_(types) if types
            # The top rung is "everything that is not a rung", so it is the
            # complement rather than a list nobody maintains.
            else or_(Warehouse.warehouse_type.notin_(_TIER_BY_TYPE),
                     Warehouse.warehouse_type.is_(None)))

    def joined(*columns):
        return (
            select(*columns)
            .select_from(PositionLocation)
            .outerjoin(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
            .outerjoin(HcmPosition, HcmPosition.id == PositionLocation.position_id)
            .where(*conditions)
        )

    total = await db.scalar(joined(func.count()).select_from(PositionLocation)) or 0

    # Distinct POINTS per rung, over the whole filtered, scoped set — not tags, and
    # not the page. The cards are read as "how big is the network at each rung", so
    # counting tag rows overstated it (one point tagged to four positions is still
    # one point) and counting the page understated it to nothing.
    counts = {rung.value: 0 for rung in LocationTier}
    for wh_type, n in (await db.execute(
        joined(Warehouse.warehouse_type,
               func.count(func.distinct(PositionLocation.warehouse_id)))
        .group_by(Warehouse.warehouse_type)
    )).all():
        counts[tier_of(wh_type).value] += n

    # On-hand across the WHOLE filtered set, not the page. Searching an employee code
    # is asking "what has this person got", and an answer that only totalled the 25
    # rows on screen would understate anyone holding more points than that.
    point_ids = set((await db.execute(
        joined(PositionLocation.warehouse_id).distinct()
    )).scalars().all())
    stock = await stock_at_points(db, point_ids)

    rows = (await db.execute(
        joined(PositionLocation, Warehouse.code, Warehouse.name,
               Warehouse.warehouse_type, HcmPosition.name)
        .order_by(PositionLocation.position_id, PositionLocation.is_primary.desc())
        .offset(max(page - 1, 0) * size).limit(size)
    )).all()
    holders = await _holders_of(db, {row[0].position_id for row in rows})

    items = []
    for row in rows:
        tag = _tag_row(*row)
        tag["holders"] = holders.get(tag["position_id"], [])
        tag.update(stock.get(tag["warehouse_id"],
                             {"stock_items": 0, "stock_qty": 0.0}))
        items.append(tag)

    return {
        "items": items,
        "total": total, "page": page, "size": size,
        "tier_counts": {str(k): v for k, v in counts.items()},
        # Distinct points, so a point tagged to four posts is counted once — the cards
        # above the list already count points that way and the two must agree.
        "stock_points": sum(1 for wid in point_ids if wid in stock),
        "stock_items": sum(s["stock_items"] for s in stock.values()),
        "stock_qty": sum(s["stock_qty"] for s in stock.values()),
    }


async def tag_position(db: AsyncSession, data, user=None) -> dict:
    """Tag a position to a stocking point, or revive//update the tag if it exists.

    Idempotent on (position, warehouse) because the unique index says so — a repeated
    tag is the same fact stated twice, not an error the user should have to read.
    """
    existing = (await db.execute(select(PositionLocation).where(
        PositionLocation.position_id == data.position_id,
        PositionLocation.warehouse_id == data.warehouse_id,
    ))).scalars().first()

    if existing is None:
        existing = PositionLocation(
            position_id=data.position_id, warehouse_id=data.warehouse_id,
        )
        db.add(existing)

    existing.project_id = data.project_id or 0
    existing.project_name = data.project_name
    existing.is_active = 1
    existing.is_primary = 1 if data.is_primary else 0
    await db.flush()

    if data.is_primary:
        # Exactly one primary per position: "where do I issue from by default" has one
        # answer, and a unique index cannot express "at most one TRUE per position".
        await db.execute(update(PositionLocation).where(
            PositionLocation.position_id == data.position_id,
            PositionLocation.id != existing.id,
        ).values(is_primary=0))

    await db.commit()
    # The tagging just moved, so anything this request already worked out about which
    # points a position reaches is now wrong. Cheap insurance: the memo only exists to
    # save round trips, never to outlive the fact it was derived from.
    db.info.pop("subtree_points_memo", None)
    tags = await list_tags(db, data.position_id)
    return next(t for t in tags if t["warehouse_id"] == data.warehouse_id)


async def untag(db: AsyncSession, tag_id: int) -> None:
    """Deactivate rather than delete — the tagging is what past visibility was
    computed from, and a hard delete would rewrite that history."""
    await db.execute(update(PositionLocation).where(
        PositionLocation.id == tag_id,
    ).values(is_active=0))
    await db.commit()
    db.info.pop("subtree_points_memo", None)


async def search_positions(db: AsyncSession, query: str, limit: int = 20) -> list[dict]:
    """Positions matching a person's name, their employee code, or the post's name.

    All three because nobody thinks in `hcm_positions.id`: an administrator knows the
    person ("Ravi"), the payroll code ("HR-EMP-15905") or the post ("STORE KEEPER —
    SURABHI"). Making them look the id up in the database first is how the screen sat
    unusable.

    One row per position, not per person: somebody holding two posts is tagged twice,
    and scope follows whichever post they are working as.
    """
    term = (query or "").strip()
    if len(term) < 2:
        return []
    like = f"%{term}%"

    rows = (await db.execute(
        select(
            HcmPosition.id, HcmPosition.name, HcmPosition.office_id,
            HcmEmployee.emp_code, HcmEmployee.full_name,
        )
        .join(HcmPositionAssignment,
              HcmPositionAssignment.position_id == HcmPosition.id, isouter=True)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id,
              isouter=True)
        .where(or_(
            HcmPosition.name.like(like),
            HcmEmployee.full_name.like(like),
            HcmEmployee.emp_code.like(like),
        ))
        .order_by(HcmPosition.name)
        .limit(limit)
    )).all()

    # What each one is already tagged to, so the screen can say "already placed"
    # rather than letting somebody tag the same post twice and wonder why nothing
    # changed (the unique index makes the second attempt a no-op).
    position_ids = [r[0] for r in rows]
    tagged: dict[int, str] = {}
    if position_ids:
        for position_id, code in (await db.execute(
            select(PositionLocation.position_id, Warehouse.code)
            .join(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
            .where(PositionLocation.position_id.in_(position_ids),
                   PositionLocation.is_active == 1)
        )).all():
            tagged.setdefault(position_id, code)

    return [{
        "position_id": r[0],
        "position_name": r[1],
        "office_id": r[2],
        "employee_code": r[3],
        "employee_name": r[4],
        "tagged_to": tagged.get(r[0]),
    } for r in rows]


# --------------------------------------------------------------------------- #
#  Stocking points, derived from the HCM mirror
# --------------------------------------------------------------------------- #
#
# HCM says where stock can sit; it just says it in three different ways. A post in the
# LIP or MDP section serves that rung of the distribution chain. An office HCM types as
# a warehouse IS a stocking point, whatever section the people standing in it belong to
# — the warehouse manager sits in "LOGISTICS-01" and would otherwise be tagged to
# nothing at all. Both are read here, on every sync, so a vehicle HCM adds tomorrow has
# somewhere to hold stock without anyone running a script.

# Matched on letters only: HCM types these by hand and has already shipped both "M.D.P"
# and "M.D.P.", and "ware house" for the office type.
SECTION_TIER = {"LIP": WarehouseType.LIP.value, "MDP": WarehouseType.MDP.value}
WAREHOUSE_OFFICE_TYPE = "WAREHOUSE"
# Warehouses this function owns, and the only ones it will ever delete. Anything an
# admin created by hand has a different code and is left alone.
DERIVED_CODE = "^(LIP|MDP|WH)-[0-9]+$"


def _letters(value: str | None) -> str:
    return "".join(ch for ch in (value or "").upper() if ch.isalpha())


async def rebuild_stocking_points(db: AsyncSession) -> dict:
    """One warehouse per stocking-point office, and the position links that reach it.

    Rebuilt rather than patched: HCM re-keys its offices and positions on every rebuild
    of its own database, so yesterday's rows name ids that no longer exist. Warehouses
    holding stock are kept whatever else changes — deleting one would orphan its
    balances, and `stk_ledger` is append-only, so it could not be corrected afterwards.
    """
    positions = (await db.execute(
        select(HcmPosition.id, HcmPosition.section_name, HcmPosition.office_id,
               HcmPosition.project_id, HcmPosition.project_name)
        .where(HcmPosition.is_active.is_(True), HcmPosition.office_id.isnot(None))
    )).all()
    offices = {o.id: (o.name, o.office_mode) for o in (await db.execute(
        select(HcmOffice.id, HcmOffice.name, HcmOffice.office_mode)
    )).all()}

    # office -> what kind of stocking point it is. Section first, warehouse second: a
    # warehouse office with LIP posts in it is still an LIP.
    kinds: dict[int, tuple[str, str]] = {}
    for row in positions:
        tier = SECTION_TIER.get(_letters(row.section_name))
        if tier:
            kinds.setdefault(row.office_id, (tier, tier))
    for office_id, (_name, mode) in offices.items():
        if _letters(mode) == WAREHOUSE_OFFICE_TYPE:
            # MAIN, not a rung: a store is where stock arrives from outside, which is
            # what tier_of() already reads the top of the chain as.
            kinds.setdefault(office_id, (WarehouseType.MAIN.value, "WH"))

    stocked = set((await db.execute(
        select(Stock.warehouse_id).distinct()
    )).scalars().all())
    existing = {w.code: w for w in (await db.execute(
        select(Warehouse).where(Warehouse.code.regexp_match(DERIVED_CODE))
    )).scalars().all()}
    wanted = {f"{prefix}-{office_id}": (office_id, kind)
              for office_id, (kind, prefix) in kinds.items()}

    removed = [w for code, w in existing.items()
               if code not in wanted and w.id not in stocked]
    if removed:
        ids = [w.id for w in removed]
        await db.execute(delete(PositionLocation)
                         .where(PositionLocation.warehouse_id.in_(ids)))
        await db.execute(delete(Warehouse).where(Warehouse.id.in_(ids)))

    warehouses: dict[int, Warehouse] = {}
    for code, (office_id, kind) in wanted.items():
        name = offices.get(office_id, (str(office_id), None))[0]
        warehouse = existing.get(code)
        if warehouse is None:
            warehouse = Warehouse(
                code=code, name=f"{name} - {kind}", office_id=office_id,
                office_name=name, warehouse_type=kind,
                is_bin_managed=False, is_active=True,
            )
            db.add(warehouse)
        else:
            warehouse.name, warehouse.office_name = f"{name} - {kind}", name
            warehouse.warehouse_type, warehouse.is_active = kind, True
        warehouses[office_id] = warehouse
    await db.flush()

    # Links are rebuilt whole: a position id HCM re-issued would otherwise leave a row
    # pointing at a post nobody holds.
    await db.execute(delete(PositionLocation).where(
        PositionLocation.warehouse_id.in_([w.id for w in warehouses.values()])))
    links = 0
    for row in positions:
        warehouse = warehouses.get(row.office_id)
        if warehouse is None:
            continue
        db.add(PositionLocation(
            position_id=row.id, warehouse_id=warehouse.id,
            project_id=row.project_id or NO_PROJECT, project_name=row.project_name,
            is_primary=1, is_active=1,
        ))
        links += 1
    await db.commit()

    result = {"warehouses": len(warehouses), "links": links, "removed": len(removed)}
    logger.info("stocking points rebuilt: %s", result)
    return result


# Registered, not called: platform must never import a module (rule 5), so the sync
# offers a hook and inventory — which owns stocking points — puts itself in it. Every
# "Sync now" and every scheduled run therefore ends with the points up to date.
hcm_sync.POST_SYNC_HOOKS.append(rebuild_stocking_points)
