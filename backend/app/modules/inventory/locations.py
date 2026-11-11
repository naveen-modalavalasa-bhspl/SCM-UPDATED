"""Where a stocking point sits, and what a move between two of them IS.

The one place these two rules live. Warehouse and every later module call in here;
none of them re-derive it, because two copies of "is this a transfer?" is two answers
to "does the Inventory Manager have to approve this?".

Nothing here is stored on a document. A movement's kind is a function of its two
endpoints, so it is computed on the way in and can never disagree with them.
"""
import logging
from decimal import Decimal

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.hcm import sync as hcm_sync
from app.platform.hcm.mappers import office_geo
from app.core.exceptions import ValidationError
from app.shared.enums import DocType, WarehouseType
from app.shared.models.warehouse import Warehouse, WarehouseLocation

from .enums import LocationTier, MovementKind
from .models import NO_PROJECT, PositionLocation, PositionLocationAccess, Stock

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


async def held_location_ids(db: AsyncSession, position_id: int | None, *,
                            subtree: bool) -> set[int]:
    """The stocking points whose SHELF this post holds (and, with `subtree`, the posts
    under it hold). BUG_SCM_012.

    `rebuild_stocking_points` links EVERY post in an office to that office's point —
    the Store Keeper, and the DEO and the Driver sitting beside him — because the link
    also answers "which point serves this post" (a DEO's indent is served there). So
    the link alone cannot say whose stock it is. HCM's SECTION can: at an LIP or an
    MDP only the post in the stocking section (`L I P`, `M.D.P.`) keeps the shelf. A
    main warehouse is staffed by sections of its own (WAREHOUSE-01, LOGISTICS-01…),
    so every post linked to one still holds it, exactly as before.

    Per POST, not per person: the same human working as Driver and as Store Keeper
    sees the LIP's stock only while working as the Store Keeper.
    """
    if position_id is None:
        return set()
    cache = db.info.setdefault("held_points_memo", {})
    key = (position_id, subtree)
    if key in cache:
        return set(cache[key])

    seen: set[int] = {position_id}
    frontier = [position_id] if subtree else []
    while frontier:
        children = set((await db.execute(
            select(HcmPosition.id).where(HcmPosition.parent_position_id.in_(frontier))
        )).scalars().all())
        frontier = list(children - seen)
        seen |= children

    stocking_types = {WarehouseType.LIP.value, WarehouseType.MDP.value}
    points: set[int] = set()
    for warehouse_id, warehouse_type, section in (await db.execute(
        select(PositionLocation.warehouse_id, Warehouse.warehouse_type,
               PositionLocation.section_name)
        .join(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
        .where(PositionLocation.position_id.in_(seen), PositionLocation.is_active == 1)
    )).all():
        if (warehouse_type not in stocking_types
                or SECTION_TIER.get(_letters(section)) is not None):
            points.add(warehouse_id)
    cache[key] = set(points)
    return points


def _holds_shelf(warehouse_type: str | None, section: str | None) -> bool:
    """`held_location_ids`' rule for one link: at an LIP or an MDP only the post in the
    stocking section keeps the shelf; every post linked to a main warehouse does."""
    stocking_types = {WarehouseType.LIP.value, WarehouseType.MDP.value}
    return (warehouse_type not in stocking_types
            or SECTION_TIER.get(_letters(section)) is not None)


async def own_linked_points(db: AsyncSession, user) -> set[int]:
    """Every point this PERSON's live posts are linked to — never their reportees'.

    Any link, whatever its section. The shelf rule (`held_location_ids`) answers "whose
    stock is it" and keeps only the storekeeper; this answers "which point is mine",
    and an OE, a DM and an RM are linked to their branch MDP under a non-stocking
    section, so the shelf rule would say they have no point at all."""
    positions = await active_positions_of(db, user)
    if not positions:
        return set()
    return set((await db.execute(
        select(PositionLocation.warehouse_id).where(
            PositionLocation.position_id.in_(positions),
            PositionLocation.is_active == 1)
    )).scalars().all())


async def same_rank_points(db: AsyncSession, user,
                           destination_id: int | None = None) -> list[dict]:
    """Every stocking point an STR raised by this login may name as its SOURCE
    (2026-11-04): the points of the posts at the SAME HCM RANK as the post the login
    is acting as, on the SAME TIER as the raiser's own point, across the whole
    network — less the raiser's own.

    Read off the org, never written down: the rank is `hcm_positions.role_id` and the
    tier is the point's own type, so a storekeeper at an LIP is offered the other LIPs,
    an OE the other OEs' MDPs, a DM the other DMs', an RM the other RMs' — and a rank
    HCM adds tomorrow works the same day. No role NAME appears here. The tier is needed
    beside the rank because one rank serves several rungs (a Store Keeper sits at LIPs,
    at MDPs and at the main warehouse). A post with no rank on record is offered every
    point on its own tier, so a gap in HCM narrows the list instead of emptying it.

    WAREHOUSES go by TYPE, not by rank (2026-11-09). A warehouse rank usually has one
    post — one SCM HEAD, at Central Warehouse-1 — so "the same rank elsewhere" was
    nobody and the list was empty. When the STR is delivered into a warehouse, every
    other active warehouse is offered, whoever holds it. LIPs and MDPs keep the rank
    rule. `destination_id` (the point the STR is delivered into) is never offered, and
    decides the tier when the login's own posts are linked to no point.
    """
    position_id = getattr(user, "active_position_id", None)
    own = await own_linked_points(db, user)
    excluded = own | ({destination_id} if destination_id else set())
    # The tier of the point the post in hand is linked to; any post's when it has none;
    # the delivery point's when no post of theirs is linked to a point at all.
    mine_now = set((await db.execute(
        select(PositionLocation.warehouse_id).where(
            PositionLocation.position_id == position_id,
            PositionLocation.is_active == 1)
    )).scalars().all()) if position_id else set()
    anchor = mine_now or own or ({destination_id} if destination_id else set())
    tiers = {tier_of(t) for t in (await db.execute(
        select(Warehouse.warehouse_type).where(Warehouse.id.in_(anchor or {0}))
    )).scalars().all()}
    if not tiers:
        return []
    if destination_id:
        # The STR is going INTO this point, so its tier decides — a login holding posts
        # on two tiers must not be offered the other tier's points.
        dest_type = await db.scalar(
            select(Warehouse.warehouse_type).where(Warehouse.id == destination_id))
        if dest_type is not None:
            tiers = {tier_of(dest_type)}
    if tiers == {LocationTier.WAREHOUSE}:
        return await _other_warehouses(db, excluded)
    wanted_types = [t.value for t in WarehouseType if tier_of(t.value) in tiers]
    role_id = (await db.scalar(select(HcmPosition.role_id).where(
        HcmPosition.id == position_id))) if position_id else None

    stmt = (
        select(PositionLocation.warehouse_id, PositionLocation.position_id,
               Warehouse.code, Warehouse.name, Warehouse.warehouse_type)
        .join(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
        .join(HcmPosition, HcmPosition.id == PositionLocation.position_id)
        .where(PositionLocation.is_active == 1,
               HcmPosition.is_active.is_(True),
               Warehouse.is_active.is_(True),
               Warehouse.warehouse_type.in_(wanted_types))
    )
    if role_id is not None:
        stmt = stmt.where(HcmPosition.role_id == role_id)

    points: dict[int, dict] = {}
    rank_posts: dict[int, set[int]] = {}
    for wid, pos_id, code, name, wh_type in (await db.execute(stmt)).all():
        if wid in excluded:
            continue
        tier = tier_of(wh_type)
        points.setdefault(wid, {
            "warehouse_id": wid, "warehouse_code": code, "warehouse_name": name,
            "warehouse_type": wh_type, "tier": tier.value, "tier_label": tier_label(tier),
        })
        rank_posts.setdefault(wid, set()).add(pos_id)
    # "Held by" here is the people of that rank at the point — the OE whose MDP it is,
    # not the storekeeper who keeps its shelf.
    names = await point_holder_names(db, set(points), rank_posts)
    out = [{**row, "held_by": names.get(wid, [])} for wid, row in points.items()]
    return sorted(out, key=lambda r: ((r["warehouse_name"] or "").lower(), r["warehouse_id"]))


async def _other_warehouses(db: AsyncSession, excluded: set[int]) -> list[dict]:
    """Every active WAREHOUSE-tier point less `excluded`: the STR source list of a
    warehouse, by type and never by who holds it (`same_rank_points`)."""
    rows = (await db.execute(
        select(Warehouse.id, Warehouse.code, Warehouse.name, Warehouse.warehouse_type)
        .where(Warehouse.is_active.is_(True))
    )).all()
    points = {
        wid: {"warehouse_id": wid, "warehouse_code": code, "warehouse_name": name,
              "warehouse_type": wh_type, "tier": LocationTier.WAREHOUSE.value,
              "tier_label": tier_label(LocationTier.WAREHOUSE)}
        for wid, code, name, wh_type in rows
        if wid not in excluded and tier_of(wh_type) == LocationTier.WAREHOUSE
    }
    names = await point_holder_names(db, set(points))
    out = [{**row, "held_by": names.get(wid, [])} for wid, row in points.items()]
    return sorted(out, key=lambda r: ((r["warehouse_name"] or "").lower(), r["warehouse_id"]))


async def point_holder_names(db: AsyncSession, warehouse_ids: set[int],
                             posts: dict[int, set[int]] | None = None) -> dict[int, list[str]]:
    """Who holds each point's shelf, by name — the people an STR's source is held by.

    `posts` short-cuts the lookup when the caller already read the links; otherwise the
    holding posts are read here under the same section rule."""
    if not warehouse_ids:
        return {}
    if posts is None:
        posts = {}
        for wid, pos_id, section, wh_type in (await db.execute(
            select(PositionLocation.warehouse_id, PositionLocation.position_id,
                   PositionLocation.section_name, Warehouse.warehouse_type)
            .join(Warehouse, Warehouse.id == PositionLocation.warehouse_id)
            .where(PositionLocation.warehouse_id.in_(warehouse_ids),
                   PositionLocation.is_active == 1)
        )).all():
            if _holds_shelf(wh_type, section):
                posts.setdefault(wid, set()).add(pos_id)
    all_posts = {p for ps in posts.values() for p in ps}
    if not all_posts:
        return {}
    by_post: dict[int, list[str]] = {}
    for pos_id, full_name in (await db.execute(
        select(HcmPositionAssignment.position_id, HcmEmployee.full_name)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.position_id.in_(all_posts),
               HcmPositionAssignment.is_active.is_(True))
    )).all():
        if full_name:
            by_post.setdefault(pos_id, []).append(full_name)
    out: dict[int, list[str]] = {}
    for wid, ps in posts.items():
        names = sorted({n for p in ps for n in by_post.get(p, [])})
        if names:
            out[wid] = names
    return out


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


async def floor_ids_for_user(db: AsyncSession, user) -> set[int] | None:
    """Allowed floor roots for a floor in-charge; None means warehouse-wide.

    Role detection uses HCM org data, while the ability to manage exceptions remains
    behind STOCK_POINTS_MANAGE in the router. Approval roles are not modified.
    """
    positions = await active_positions_of(db, user)
    if not positions:
        return None
    floor_posts = set((await db.execute(
        select(HcmPosition.id).where(
            HcmPosition.id.in_(positions),
            or_(HcmPosition.role_name.ilike("%FLOOR%INCHARGE%"),
                HcmPosition.name.ilike("%FLOOR%INCHARGE%")),
        )
    )).scalars().all())
    if not floor_posts:
        return None
    tags = (await db.execute(
        select(PositionLocation.location_id, PositionLocation.warehouse_id).where(
            PositionLocation.position_id.in_(floor_posts),
            PositionLocation.is_active == 1,
        )
    )).all()
    automatic = {int(location_id) for location_id, _warehouse_id in tags
                 if location_id is not None}

    # Older HCM stocking-point links name the warehouse and section but carry no
    # physical `location_id`. In a building with exactly ONE active floor that floor
    # is unambiguous; refusing the floor in-charge there as "not assigned" only makes
    # a stale sync column more authoritative than the physical warehouse tree.
    # Multi-floor buildings still fail closed until HCM/admin names the exact floor.
    unresolved_warehouses = {int(warehouse_id) for location_id, warehouse_id in tags
                              if location_id is None and warehouse_id is not None}
    if unresolved_warehouses:
        floor_rows = (await db.execute(
            select(WarehouseLocation.id, WarehouseLocation.warehouse_id).where(
                WarehouseLocation.warehouse_id.in_(unresolved_warehouses),
                WarehouseLocation.bin_type == FLOOR_STORAGE_TYPE,
                WarehouseLocation.is_active.is_(True),
            )
        )).all()
        by_warehouse: dict[int, list[int]] = {}
        for location_id, warehouse_id in floor_rows:
            by_warehouse.setdefault(int(warehouse_id), []).append(int(location_id))
        automatic |= {
            floor_ids[0] for floor_ids in by_warehouse.values() if len(floor_ids) == 1
        }
    extra = set((await db.execute(
        select(PositionLocationAccess.location_id).where(
            PositionLocationAccess.position_id.in_(floor_posts),
            PositionLocationAccess.is_active == 1,
        )
    )).scalars().all())
    return automatic | extra


async def floor_incharge_names(db: AsyncSession,
                               floor_ids: set[int]) -> dict[int, list[str]]:
    """Names only — see `floor_incharge_people`."""
    people = await floor_incharge_people(db, floor_ids)
    return {floor_id: list(dict.fromkeys(name for _id, name in rows))
            for floor_id, rows in people.items()}


async def floor_incharge_people(db: AsyncSession,
                                floor_ids: set[int]) -> dict[int, list[tuple[int, str]]]:
    """Who is in charge of each floor — `floor_ids_for_user` read the other way round.

    Same three links, so the names a split shows are exactly the people who will see
    that piece in their queue: the post's own stocking-point tag on the floor, an
    admin grant on top, and the one-floor-building fallback for a tag that names only
    the warehouse. A floor nobody holds comes back with an empty list, never missing.
    """
    out: dict[int, list[tuple[int, str]]] = {floor_id: [] for floor_id in floor_ids}
    if not floor_ids:
        return out
    floor_posts = select(HcmPosition.id).where(
        or_(HcmPosition.role_name.ilike("%FLOOR%INCHARGE%"),
            HcmPosition.name.ilike("%FLOOR%INCHARGE%")))

    links: set[tuple[int, int]] = set()          # (floor_id, position_id)
    for location_id, position_id in (await db.execute(
        select(PositionLocation.location_id, PositionLocation.position_id).where(
            PositionLocation.location_id.in_(floor_ids),
            PositionLocation.is_active == 1,
            PositionLocation.position_id.in_(floor_posts)))).all():
        links.add((int(location_id), int(position_id)))
    for location_id, position_id in (await db.execute(
        select(PositionLocationAccess.location_id, PositionLocationAccess.position_id)
        .where(PositionLocationAccess.location_id.in_(floor_ids),
               PositionLocationAccess.is_active == 1,
               PositionLocationAccess.position_id.in_(floor_posts)))).all():
        links.add((int(location_id), int(position_id)))

    # The one-floor fallback: a tag carrying only the warehouse means that building's
    # single floor, exactly as `floor_ids_for_user` reads it.
    floors = (await db.execute(
        select(WarehouseLocation.id, WarehouseLocation.warehouse_id)
        .where(WarehouseLocation.id.in_(floor_ids)))).all()
    warehouse_ids = {int(w) for _f, w in floors if w is not None}
    if warehouse_ids:
        floor_counts = dict((await db.execute(
            select(WarehouseLocation.warehouse_id, func.count())
            .where(WarehouseLocation.warehouse_id.in_(warehouse_ids),
                   WarehouseLocation.bin_type == FLOOR_STORAGE_TYPE,
                   WarehouseLocation.is_active.is_(True))
            .group_by(WarehouseLocation.warehouse_id))).all())
        single = {int(f): int(w) for f, w in floors
                  if w is not None and floor_counts.get(w) == 1}
        if single:
            for warehouse_id, position_id in (await db.execute(
                select(PositionLocation.warehouse_id, PositionLocation.position_id)
                .where(PositionLocation.location_id.is_(None),
                       PositionLocation.warehouse_id.in_(set(single.values())),
                       PositionLocation.is_active == 1,
                       PositionLocation.position_id.in_(floor_posts)))).all():
                for floor_id, w in single.items():
                    if w == int(warehouse_id):
                        links.add((floor_id, int(position_id)))
    if not links:
        return out

    holders: dict[int, list[tuple[int, str]]] = {}
    for position_id, employee_id, name in (await db.execute(
        select(HcmPositionAssignment.position_id, HcmEmployee.id, HcmEmployee.full_name)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.position_id.in_({p for _f, p in links}),
               HcmPositionAssignment.is_active.is_(True),
               HcmEmployee.is_active.is_(True)))).all():
        holders.setdefault(int(position_id), []).append((int(employee_id), name))
    for floor_id, position_id in sorted(links):
        for person in holders.get(position_id, []):
            if person[1] and person not in out[floor_id]:
                out[floor_id].append(person)
    return out


async def floor_location_ids_for_user(db: AsyncSession, user) -> set[int] | None:
    """Assigned floors plus every active storage node below them."""
    roots = await floor_ids_for_user(db, user)
    if roots is None:
        return None
    allowed, frontier = set(roots), set(roots)
    while frontier:
        children = set((await db.execute(select(WarehouseLocation.id).where(
            WarehouseLocation.parent_id.in_(frontier),
            WarehouseLocation.is_active.is_(True),
        ))).scalars().all())
        frontier = children - allowed
        allowed |= children
    return allowed


async def grant_floor_access(db: AsyncSession, position_id: int, location_id: int,
                             user) -> PositionLocationAccess:
    location = await db.get(WarehouseLocation, location_id)
    if location is None or not location.is_active:
        raise ValidationError("Access can only be granted to an active warehouse location")
    row = (await db.execute(select(PositionLocationAccess).where(
        PositionLocationAccess.position_id == position_id,
        PositionLocationAccess.location_id == location_id,
    ))).scalars().first()
    if row is None:
        row = PositionLocationAccess(position_id=position_id,
            warehouse_id=location.warehouse_id, location_id=location_id)
        db.add(row)
    row.is_active = 1
    row.granted_by_id = getattr(user, "id", None)
    await db.commit()
    return row


async def revoke_floor_access(db: AsyncSession, access_id: int) -> None:
    await db.execute(update(PositionLocationAccess).where(
        PositionLocationAccess.id == access_id).values(is_active=0))
    await db.commit()


async def list_floor_access(db: AsyncSession, position_id: int) -> list[dict]:
    rows = (await db.execute(
        select(PositionLocationAccess, WarehouseLocation.code, WarehouseLocation.name)
        .join(WarehouseLocation,
              WarehouseLocation.id == PositionLocationAccess.location_id)
        .where(PositionLocationAccess.position_id == position_id,
               PositionLocationAccess.is_active == 1)
        .order_by(WarehouseLocation.name, WarehouseLocation.code)
    )).all()
    return [{"id": row.id, "position_id": row.position_id,
             "warehouse_id": row.warehouse_id, "location_id": row.location_id,
             "location_code": code, "location_name": name}
            for row, code, name in rows]


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


async def parent_points(db: AsyncSession, warehouse_ids: set[int]) -> dict[int, int | None]:
    """The point each stocking point sits UNDER, read off the reporting tree.

    `whs_warehouses` carries no parent: the chain is the org's. A point's parent is
    the nearest point of a HIGHER tier held by an ancestor (`parent_position_id`) of
    any position tagged to it — an LIP's MDP is the one its holder's OE holds. None
    when the climb finds nothing (a top-level warehouse, or a holder HCM gives no
    manager), which callers read as "parent unknown", never as "no siblings".
    """
    if not warehouse_ids:
        return {}
    tags = (await db.execute(
        select(PositionLocation.position_id, PositionLocation.warehouse_id)
        .where(PositionLocation.is_active == 1)
    )).all()
    held_by: dict[int, list[int]] = {}
    points_of: dict[int, list[int]] = {}
    for position_id, warehouse_id in tags:
        held_by.setdefault(warehouse_id, []).append(position_id)
        points_of.setdefault(position_id, []).append(warehouse_id)
    types = {row.id: row.warehouse_type for row in (await db.execute(
        select(Warehouse.id, Warehouse.warehouse_type)
        .where(Warehouse.id.in_({w for ws in points_of.values() for w in ws} | warehouse_ids))
    )).all()}
    parent_of = dict((await db.execute(
        select(HcmPosition.id, HcmPosition.parent_position_id)
        .where(HcmPosition.is_active.is_(True))
    )).all())

    out: dict[int, int | None] = {}
    for warehouse_id in warehouse_ids:
        tier = tier_of(types.get(warehouse_id))
        found: int | None = None
        for holder in sorted(held_by.get(warehouse_id, [])):
            seen: set[int] = set()
            position = parent_of.get(holder)
            while position is not None and position not in seen and found is None:
                seen.add(position)
                above = sorted(w for w in points_of.get(position, [])
                               if tier_of(types.get(w)) < tier)
                if above:
                    # The rung directly above first: an LIP's parent is its MDP even
                    # when the same manager also holds a main warehouse.
                    found = max(above, key=lambda w: (tier_of(types.get(w)), -w))
                position = parent_of.get(position)
            if found is not None:
                break
        out[warehouse_id] = found
    return out


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
        # Only the bottom rung of the chain runs a vehicle and carries a service area
        # code (2026-11-04) — read off the tier, so no screen compares a type by name.
        "needs_vehicle_and_sac": tier_of(warehouse_type) == max(LocationTier),
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
            "location_id": tag.location_id, "section_name": tag.section_name,
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
        "location_id": tag.location_id, "section_name": tag.section_name,
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


async def stock_at_points(db: AsyncSession, warehouse_ids: set[int],
                          user=None) -> tuple[dict[int, dict], dict]:
    """On-hand at each stocking point, counted exactly as Stock Balance counts it.

    Returns `(per_point, totals)`.

    Every rule here is Stock Balance's rule, because the two screens are read against
    each other and any difference is a defect:

    * `total_qty > 0`, not `available_qty > 0`. Stock Balance's default page is
      `include_zero=False`, which is a test on total. A row whose stock is fully
      reserved is on hand — it is in the building — so counting it as nothing here
      made a point look empty on one screen and stocked on the other.
    * The quantity is `total_qty` for the same reason: available alone silently
      subtracts every reservation from what the point is holding.
    * The same warehouse scope the stock screens apply. Without it a login saw points
      totalling stock it is not allowed to open.
    * `totals["stock_items"]` counts DISTINCT items across the whole set. Adding the
      per-point counts counted one item held at four points four times, which is why
      the card never matched Stock Balance's "Distinct Items".
    """
    # Local import: service imports this module, so it cannot be imported at the top.
    from .service import _scoped_warehouse_ids

    empty = {"stock_points": 0, "stock_items": 0, "stock_qty": 0.0}
    if not warehouse_ids:
        return {}, empty
    allowed = await _scoped_warehouse_ids(db, user)
    if allowed is not None:
        warehouse_ids = warehouse_ids & allowed
        if not warehouse_ids:
            return {}, empty

    held = (Stock.warehouse_id.in_(warehouse_ids), Stock.total_qty > 0)

    rows = (await db.execute(
        select(Stock.warehouse_id,
               func.count(func.distinct(Stock.item_id)),
               func.sum(Stock.total_qty))
        .where(*held)
        .group_by(Stock.warehouse_id)
    )).all()
    per_point = {wid: {"stock_items": int(items or 0), "stock_qty": float(qty or 0)}
                 for wid, items, qty in rows}

    distinct_items = await db.scalar(
        select(func.count(func.distinct(Stock.item_id))).where(*held)
    )
    return per_point, {
        "stock_points": len(per_point),
        "stock_items": int(distinct_items or 0),
        "stock_qty": sum(point["stock_qty"] for point in per_point.values()),
    }


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
    stock, stock_totals = await stock_at_points(db, point_ids, user=user)

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
        # Counted over the whole filtered set by the same query Stock Balance uses:
        # distinct points, distinct ITEMS (not the sum of per-point counts), and
        # total_qty. Filtering this screen to one point must give the same three
        # numbers as opening Stock Balance on that point.
        **stock_totals,
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


# The `storage_type` a derived floor row carries — the same value the DB team's own
# floors use, so a derived floor and a hand-built one are the same kind of thing.
FLOOR_STORAGE_TYPE = "FLOOR"
# Codes this function owns inside a warehouse. Anything else under that warehouse was
# built by hand and is never touched.
DERIVED_FLOOR_PREFIX = "SEC-"


def floor_key(section_name: str | None) -> str | None:
    """The stable key for a floor, derived from the section HCM sent.

    Deliberately NOT parsed. HCM's section names are free text and inconsistent
    already — "WAREHOUSE OFFICE @1ST", "WAREHOUSE-2ND", "LOGISTICS-01" — and reading a
    floor NUMBER out of them is the one thing guaranteed to break: the day somebody
    types "Warehouse 2nd floor" a regex would either miss it or, worse, match the wrong
    digit and reseat people onto another floor.

    So the section IS the floor, whatever it is called. All this does is fold case and
    punctuation so that "WAREHOUSE-2ND" and "Warehouse 2nd" are recognised as the same
    one; the human-readable label is stored separately, verbatim.

    HCM sends `section_id` on every position it serves through /api/positions/, and
    that would be a better key — but the six SCM warehouse posts reach us through the
    employees feed, which sends the name only. When that is fixed upstream, key on the
    id and keep this as the fallback.
    """
    key = "".join(ch for ch in (section_name or "").upper() if ch.isalnum())
    return key or None


#: Andhra Pradesh, with a margin for the border. HCM's GPS fields are typed by hand,
#: and a point outside this box is a typo — a dropped digit, a 0,0 — never a PHC.
AP_BOUNDS = (12.4, 19.95, 76.6, 84.9)   # lat min, lat max, lon min, lon max

#: `whs_warehouses.coordinate_source` for a point HCM's own GPS fields gave. Trusted
#: above any gazetteer match and below a pin set by hand on the planner map.
HCM_COORDINATE_SOURCE = "HCM"


def _inside_ap(lat: float, lon: float) -> bool:
    return AP_BOUNDS[0] <= lat <= AP_BOUNDS[1] and AP_BOUNDS[2] <= lon <= AP_BOUNDS[3]


def hcm_point(geo: dict) -> tuple[float, float] | None:
    """HCM's latitude/longitude for an office, if they describe a place in AP.

    Swapped fields are put right: AP's latitudes (12–20) and longitudes (76–85) cannot
    overlap, so a pair that only fits the other way round is unambiguous.
    """
    lat, lon = geo.get("latitude"), geo.get("longitude")
    if lat is None or lon is None:
        return None
    if _inside_ap(lat, lon):
        return (lat, lon)
    if _inside_ap(lon, lat):
        return (lon, lat)
    return None


def apply_hcm_coordinates(warehouse: Warehouse, geo: dict) -> str | None:
    """Put HCM's GPS onto the stocking point. Returns SET, CLEARED or None.

    A MANUAL pin is never overwritten: somebody stood at the gate, or looked. When HCM
    stops sending coordinates for a point that carried them, they are cleared and the
    point goes back to being matched by name — keeping HCM's old figure with nothing
    behind it would present a withdrawn reading as a current one.
    """
    if warehouse.coordinate_source == "MANUAL":
        return None
    point = hcm_point(geo)
    if point is not None:
        lat, lon = (Decimal(str(round(value, 7))) for value in point)
        if (warehouse.coordinate_source == HCM_COORDINATE_SOURCE
                and warehouse.latitude == lat and warehouse.longitude == lon):
            return None
        warehouse.latitude, warehouse.longitude = lat, lon
        warehouse.coordinate_source = HCM_COORDINATE_SOURCE
        warehouse.coordinate_label = "GPS from HCM"
        warehouse.coordinate_confidence = Decimal("1")
        return "SET"
    if warehouse.coordinate_source == HCM_COORDINATE_SOURCE:
        warehouse.latitude = warehouse.longitude = None
        warehouse.coordinate_source = warehouse.coordinate_label = None
        warehouse.coordinate_confidence = None
        return "CLEARED"
    return None


async def office_geo_for(db: AsyncSession, office_ids) -> dict[int, dict]:
    """`mappers.office_geo` for many offices, with the district HCM gives each."""
    ids = {int(i) for i in office_ids if i}
    if not ids:
        return {}
    rows = (await db.execute(
        select(HcmOffice.id, HcmOffice.raw, HcmOffice.city).where(HcmOffice.id.in_(ids))
    )).all()
    out = {}
    for office_id, raw, city in rows:
        geo = office_geo(raw)
        geo["district"] = geo.get("district") or city
        out[office_id] = geo
    return out


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
    # SCM_0053: HCM already sends an address for every office (`map_office`, both the
    # poll sync and the webhook); carried onto the warehouse here, the same snapshot
    # rule office_name already follows, so a DC/DOD gate pass has a "From" address to
    # print without inventing a second address source.
    offices = {o.id: (o.name, o.office_mode, o.address) for o in (await db.execute(
        select(HcmOffice.id, HcmOffice.name, HcmOffice.office_mode, HcmOffice.address)
    )).all()}

    # office -> what kind of stocking point it is. Section first, warehouse second: a
    # warehouse office with LIP posts in it is still an LIP.
    kinds: dict[int, tuple[str, str]] = {}
    for row in positions:
        tier = SECTION_TIER.get(_letters(row.section_name))
        if tier:
            kinds.setdefault(row.office_id, (tier, tier))
    for office_id, (_name, mode, _address) in offices.items():
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
        name, _mode, address = offices.get(office_id, (str(office_id), None, None))
        warehouse = existing.get(code)
        if warehouse is None:
            warehouse = Warehouse(
                code=code, name=f"{name} - {kind}", office_id=office_id,
                office_name=name, address=address, warehouse_type=kind,
                is_bin_managed=False, is_active=True,
            )
            db.add(warehouse)
        else:
            warehouse.name, warehouse.office_name = f"{name} - {kind}", name
            warehouse.warehouse_type, warehouse.is_active = kind, True
            # Backfill only — never overwrite. `address` is also a field
            # `WarehouseWrite` lets an admin hand-correct (unlike name/office_name,
            # which this function already always overwrites), so a sync must not
            # silently replace a correction nobody asked it to touch.
            if not (warehouse.address or "").strip() and address:
                warehouse.address = address
        warehouses[office_id] = warehouse

    # HCM's own GPS, where it has any, is the most exact position a stocking point
    # can have short of a pin set by hand — applied on every sync, so a coordinate
    # filled in HCM reaches the planner without anybody touching the map.
    geo = await office_geo_for(db, warehouses)
    gps = {"SET": 0, "CLEARED": 0}
    for office_id, warehouse in warehouses.items():
        outcome = apply_hcm_coordinates(warehouse, geo.get(office_id) or {})
        if outcome:
            gps[outcome] += 1
    await db.flush()

    floors = await _rebuild_floors(db, positions, warehouses, kinds)

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
            # Which floor of that warehouse, when the building has more than one.
            # None everywhere else, which is every LIP and MDP.
            location_id=floors.get((warehouse.id, floor_key(row.section_name))),
            section_name=row.section_name,
            is_primary=1, is_active=1,
        ))
        links += 1
    await db.commit()

    result = {"warehouses": len(warehouses), "links": links,
              "removed": len(removed), "floors": len(floors),
              "gps_set": gps["SET"], "gps_cleared": gps["CLEARED"]}
    logger.info("stocking points rebuilt: %s", result)
    return result


async def _rebuild_floors(db: AsyncSession, positions, warehouses: dict,
                          kinds: dict) -> dict[tuple[int, str], int]:
    """Ensure every HCM warehouse section exists as a physical floor.

    Deliberately MATCHES, never creates. HCM's section is the team a post works in
    ("WAREHOUSE OFFICE @1ST", "LOGISTICS-01"); a warehouse floor is a node in the
    physical location tree with aisles, racks and bins under it. They share the word
    "floor" and nothing else, and the live data proves it: every unit in CENTRAL
    WAREHOUSE-1 sits in a bin under the hand-built `F1 - Ground Floor`, so a floor
    invented from a section name would hold no stock at all and scoping anyone to it
    would show them an empty warehouse.

    So a link only gets a `location_id` when the building really has a floor of that
    name. Where it does not — which is every warehouse today — the link keeps its
    `section_name` and `location_id` stays NULL, meaning the whole warehouse, exactly
    as before. Nothing narrows until somebody has said which physical floor a section
    means.

    Matching is on the folded key, so a floor called "Warehouse 2nd" answers to a
    section called "WAREHOUSE-2ND" without anyone editing either.

    Returns {(warehouse_id, floor_key): location_id} for the link pass to read.
    """
    multi_floor = {office_id: warehouse for office_id, warehouse in warehouses.items()
                   if kinds.get(office_id, ("", ""))[0] == WarehouseType.MAIN.value}
    if not multi_floor:
        return {}

    wanted = {
        (warehouse.id, floor_key(row.section_name))
        for row in positions
        if (warehouse := multi_floor.get(row.office_id)) is not None
        and floor_key(row.section_name)
        # Administrative teams in a warehouse office are not storage floors.
        and any(word in (row.section_name or "").upper()
                for word in ("WAREHOUSE", "FLOOR", "BLOCK"))
    }
    if not wanted:
        return {}

    floors = (await db.execute(
        select(WarehouseLocation).where(
            WarehouseLocation.warehouse_id.in_([w.id for w in multi_floor.values()]),
            WarehouseLocation.bin_type == FLOOR_STORAGE_TYPE)
    )).scalars().all()

    # A floor answers to its code and to its name — "F2" and "Warehouse 2nd" are both
    # reasonable things for HCM's section to have been called.
    by_key: dict[tuple[int, str], int] = {}
    for floor in floors:
        for candidate in (floor.code, floor.name):
            key = floor_key(candidate)
            if key:
                by_key.setdefault((floor.warehouse_id, key), floor.id)

    # HCM is authoritative for warehouse sections. Create only the missing top-level
    # FLOOR nodes; racks/bins remain warehouse-master data and are never fabricated.
    # Do NOT collapse an unmatched section onto "the warehouse's only floor": a
    # building with one hand-built floor is exactly the case where HCM's other
    # sections are floors nobody has created yet, and claiming them suppressed the
    # creation entirely.
    for warehouse_id, key in sorted(wanted):
        if (warehouse_id, key) in by_key:
            continue
        section_name = next(
            row.section_name for row in positions
            if warehouses.get(row.office_id)
            and warehouses[row.office_id].id == warehouse_id
            and floor_key(row.section_name) == key)
        floor = WarehouseLocation(
            warehouse_id=warehouse_id,
            code=f"HCM-{key}"[:50], name=section_name,
            bin_type=FLOOR_STORAGE_TYPE, is_active=True,
        )
        db.add(floor)
        await db.flush()
        by_key[(warehouse_id, key)] = floor.id

    matched = {key: by_key[key] for key in wanted if key in by_key}
    return {key: by_key[key] for key in wanted}


async def stocking_point_link_status(db: AsyncSession) -> dict:
    """Did the rebuild above actually reach every position that should have a point.

    A position belongs here when its office was classified as a stocking point; the
    same condition `rebuild_stocking_points` links on. Any gap means the rebuild did
    not run or did not finish, which is invisible everywhere else — the sync reports
    seven green entities either way, and the only symptom is an OE who cannot see
    their own store.
    """
    linked = await db.scalar(
        select(func.count()).select_from(PositionLocation)
        .where(PositionLocation.is_active == 1)
    ) or 0
    expected = await db.scalar(
        select(func.count()).select_from(HcmPosition)
        .join(Warehouse, Warehouse.office_id == HcmPosition.office_id)
        .where(HcmPosition.is_active.is_(True),
               HcmPosition.office_id.isnot(None),
               Warehouse.code.regexp_match(DERIVED_CODE))
    ) or 0
    missing = max(expected - linked, 0)
    return {
        "label": "Stocking point links",
        "ok": linked > 0 and missing == 0,
        "detail": (
            f"{linked} of {expected} position links"
            + (f" · {missing} missing" if missing else " · all positions covered")
        ),
    }


# Registered, not called: platform must never import a module (rule 5), so the sync
# offers a hook and inventory — which owns stocking points — puts itself in it. Every
# "Sync now" and every scheduled run therefore ends with the points up to date.
hcm_sync.POST_SYNC_HOOKS.append(rebuild_stocking_points)
hcm_sync.SYNC_STATUS_PROVIDERS.append(stocking_point_link_status)
