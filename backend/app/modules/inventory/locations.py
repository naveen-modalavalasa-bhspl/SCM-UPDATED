"""Where a stocking point sits, and what a move between two of them IS.

The one place these two rules live. Warehouse and every later module call in here;
none of them re-derive it, because two copies of "is this a transfer?" is two answers
to "does the Inventory Manager have to approve this?".

Nothing here is stored on a document. A movement's kind is a function of its two
endpoints, so it is computed on the way in and can never disagree with them.
"""
import logging

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.shared.enums import DocType, WarehouseType
from app.shared.models.warehouse import Warehouse

from .enums import LocationTier, MovementKind
from .models import NO_PROJECT, PositionLocation

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

    seen: set[int] = {position_id}
    frontier = [position_id]
    while frontier:
        children = set((await db.execute(
            select(HcmPosition.id).where(HcmPosition.parent_position_id.in_(frontier))
        )).scalars().all())
        frontier = list(children - seen)
        seen |= children

    return set((await db.execute(
        select(PositionLocation.warehouse_id).where(
            PositionLocation.position_id.in_(seen),
            PositionLocation.is_active == 1,
        )
    )).scalars().all())


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
    return warehouse_id


async def warehouses_visible_to(db: AsyncSession, user) -> set[int] | None:
    """Subtree-scoped stocking points for a login, or None when unscoped.

    None means "no tagging reaches this user" — the caller keeps whatever scope it
    already had, so adding this layer can never take away access someone has today.
    """
    position_id = getattr(user, "active_position_id", None) if user is not None else None
    if position_id is None:
        return None
    visible = await location_ids_for_subtree(db, position_id)
    return visible or None


# ---------------- Service-level operations over the tagging ----------------

_TIER_LABEL = {
    LocationTier.WAREHOUSE: "Warehouse",
    LocationTier.MDP: "Material Distribution Point",
    LocationTier.LIP: "Local Inventory Point",
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
    tags = await list_tags(db, data.position_id)
    return next(t for t in tags if t["warehouse_id"] == data.warehouse_id)


async def untag(db: AsyncSession, tag_id: int) -> None:
    """Deactivate rather than delete — the tagging is what past visibility was
    computed from, and a hard delete would rewrite that history."""
    await db.execute(update(PositionLocation).where(
        PositionLocation.id == tag_id,
    ).values(is_active=0))
    await db.commit()


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
