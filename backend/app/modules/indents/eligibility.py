"""Which items a person may raise an indent for.

THE RULE, in one sentence: an item nobody has tagged is available to everyone; an
item with any tag at all is available only to a requester whose ROLE or REGION is
among them.

The fail-OPEN default is deliberate and is the whole reason this can ship onto a
working system. `mst_item_eligibility` starts empty, so on the day this deploys every
item is still requestable by everyone and nothing changes. An administrator narrows
items one at a time, and only a tagged item is ever restricted. Reading an empty
mapping as "deny" would have stopped every indent in the company on deploy — the same
reasoning `mst_brand_general_names` already carries for unmapped general names.

WHERE IT IS ENFORCED — both, not either:

  * `eligible_filter()` narrows the item picker, so a requester is not offered
    something they cannot ask for; and
  * `assert_items_allowed()` runs on create and on update, because hiding a control
    is not security (rule 6) and the picker is a JSON call anyone can replay with a
    different item id.

WHAT COUNTS AS THE REQUESTER'S REGION: `hcm_employees.office_id`, exactly what
`service._raiser_context` stamps onto `ind_indents.region_id`. Deliberately the same
source — an eligibility check that read a different office from the one written on
the document would pass at the picker and fail at submit, or worse, the reverse.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.rbac import service as rbac_service
from app.shared.enums import ItemScope
from app.shared.models.master import Item, ItemEligibility


async def requester_scopes(db: AsyncSession, user) -> set[tuple[str, int]]:
    """Every (scope_type, scope_id) pair this login satisfies.

    Roles come from the ACTIVE position, not from every hat the person owns: an
    employee who is a Store Keeper today and a Driver on another posting should be
    able to raise what the position they are working under allows, and switching
    position is an explicit act that already re-keys the whole session.
    """
    position_id = getattr(user, "active_position_id", None)
    roles = await rbac_service.get_user_roles(db, user.id, position_id)
    scopes: set[tuple[str, int]] = {
        (ItemScope.ROLE.value, role.id) for role in roles if role.id is not None
    }
    region_id = getattr(user, "office_id", None)
    if region_id is not None:
        scopes.add((ItemScope.REGION.value, int(region_id)))
    return scopes


async def _restricted_item_ids(db: AsyncSession) -> set[int]:
    """Items carrying at least one ACTIVE tag. Everything else is open to all."""
    rows = (await db.execute(
        select(ItemEligibility.item_id)
        .where(ItemEligibility.is_active.is_(True))
        .distinct()
    )).scalars().all()
    return {int(i) for i in rows}


async def allowed_item_ids(db: AsyncSession, user) -> set[int]:
    """The restricted items THIS login may still ask for.

    Only ever the TAGGED ones — untagged items are open to everyone and are not listed
    here, so a caller must read this together with `_restricted_item_ids` rather than
    treating it as the whole allow-list. Both callers below do.

    One query, filtered in Python against the exact (type, id) pairs. A SQL `IN` on
    each column separately would be a cross-product: a role id and an office id that
    happen to share a number are not a theoretical worry, since the two come from
    different tables and both start at 1.
    """
    scopes = await requester_scopes(db, user)
    if not scopes:
        return set()
    rows = (await db.execute(
        select(ItemEligibility.item_id, ItemEligibility.scope_type,
               ItemEligibility.scope_id)
        .where(ItemEligibility.is_active.is_(True))
    )).all()
    return {int(item_id) for item_id, scope_type, scope_id in rows
            if (scope_type, int(scope_id)) in scopes}


async def eligible_filter(db: AsyncSession, user):
    """A WHERE clause for `mst_items`, or None when nothing is restricted.

    None rather than an always-true clause so the caller can skip the join entirely on
    the overwhelmingly common path where no item has been tagged at all.
    """
    restricted = await _restricted_item_ids(db)
    if not restricted:
        return None
    allowed = await allowed_item_ids(db, user)
    denied = restricted - allowed
    if not denied:
        return None
    return Item.id.notin_(denied)


async def assert_items_allowed(db: AsyncSession, user, item_ids) -> None:
    """Refuse a document that names an item this requester may not ask for.

    Runs on create AND on update. The picker already narrows the list, but the picker
    is a JSON call — the id in the body is whatever the caller sent, so this is the
    check that actually decides (rule 6).

    Names the items rather than saying "not allowed": a requester who picked something
    off a stale page needs to know WHICH line to change.
    """
    wanted = {int(i) for i in item_ids if i is not None}
    if not wanted:
        return
    restricted = await _restricted_item_ids(db)
    in_play = wanted & restricted
    if not in_play:
        return
    allowed = await allowed_item_ids(db, user)
    denied = in_play - allowed
    if not denied:
        return

    names = (await db.execute(
        select(Item.code, Item.name).where(Item.id.in_(denied))
    )).all()
    listed = ", ".join(f"{code} ({name})" for code, name in names) or str(sorted(denied))
    raise ValidationError(
        f"Your role and location are not set up to request: {listed}. "
        "Ask an administrator to tag the item, or remove the line."
    )
