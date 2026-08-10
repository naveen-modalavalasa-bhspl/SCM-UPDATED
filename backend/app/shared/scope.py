"""One place that answers "whose rows may this login read?".

Splitting job profiles fixed WHICH SCREENS someone gets. It did nothing about
WHOSE ROWS, and those are different questions: District Manager Anantapur and
District Manager Kurnool are one profile doing one job, and must not read each
other's documents.

Every profile carries a rung (`ScopeRung`, stored on the profile role's
description as `PROFILE:DM|SCOPE:SUBTREE`, seeded from HCM's office_level):

    SELF     only documents this login raised, in the position they raised them
    OFFICE   everything in their own hcm office
    SUBTREE  their position and everything reporting under it
    PROJECT  everything in their hcm project
    ALL      the whole network

A module does NOT write its own version of this. It calls `scope_condition()`
with the columns of its own table and ANDs the result into its list query. That
is the whole contract, and `tests/test_scope.py` fails if a list endpoint skips
it — one module rolling its own predicate is how the hole reopens.

No schema change: the rung is parsed off the profile role that
`platform.rbac.profiles` already stores.
"""
from sqlalchemy import ColumnElement, and_, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import HcmPosition
from app.shared.enums import ScopeRung


def _memo(db: AsyncSession, bucket: str) -> dict:
    """Per-REQUEST scratch space, keyed by name.

    `get_db` yields a fresh session per request, so anything parked on `session.info`
    lives exactly as long as one HTTP call and is gone by the next. That is the right
    lifetime for both answers below: they read `hcm_positions` and the profile roles,
    neither of which a request can change, so re-deriving them is re-reading the same
    rows for the same answer.

    It matters because scope is resolved on EVERY scoped read, and a batch approval
    makes that read forty-one times in one request — 20 queries × 41 against a remote
    database was 38 seconds of pure round-trip for one unchanging answer. Cached, the
    rung and the subtree are still computed from the database, still per login, still
    per active position. Nothing about who may see what moves.
    """
    return db.info.setdefault(f"scope_memo_{bucket}", {})


async def descendant_position_ids(
    db: AsyncSession, position_id: int | None,
) -> list[int]:
    """Every position under `position_id`, walking hcm_positions.parent_position_id.

    Breadth-first with a seen-set: the live mirror has cycles (a position whose
    ancestor chain loops back), and a naive walk never terminates on them.
    """
    if position_id is None:
        return []
    cache = _memo(db, "descendants")
    if position_id in cache:
        # A copy: callers own their list, and one mutating it must not rewrite the
        # answer every later caller in this request gets.
        return list(cache[position_id])
    descendants: list[int] = []
    frontier = [position_id]
    seen = {position_id}
    while frontier:
        rows = (await db.execute(
            select(HcmPosition.id).where(
                HcmPosition.parent_position_id.in_(frontier),
                HcmPosition.is_active.is_(True),
            )
        )).scalars().all()
        frontier = []
        for row_id in rows:
            if row_id in seen:
                continue
            seen.add(row_id)
            descendants.append(row_id)
            frontier.append(row_id)
    cache[position_id] = list(descendants)
    return descendants


async def rung_for(db: AsyncSession, user) -> ScopeRung:
    """The rung of the profile behind this login's ACTIVE position.

    Deliberately keyed to the active position, never to the employee: switching
    position has to move the data as well as the menu, or a storekeeper who is also
    a lab technician reads both sets from either session.

    No profile — an unconfigured position, or a login with no position at all like
    the System Admin — means the old behaviour is still in force, so this returns
    ALL and the caller's existing rules decide. Profiles are opt-in; this must not
    silently tighten a screen nobody has configured yet.
    """
    from app.platform.rbac.profiles import parse_description, profile_role_for_position

    position_id = getattr(user, "active_position_id", None)
    if position_id is None:
        return ScopeRung.ALL
    # Keyed by the active position, exactly as the rung itself is — switching position
    # switches the key, so the memo can never hand one hat the other hat's rung.
    cache = _memo(db, "rung")
    if position_id in cache:
        return cache[position_id]

    role = await profile_role_for_position(db, position_id)
    if role is None:
        rung = ScopeRung.ALL
    else:
        _, scope = parse_description(role.description)
        try:
            rung = ScopeRung(scope) if scope else ScopeRung.SELF
        except ValueError:
            # An unreadable rung is a configuration error, and the safe reading of a
            # configuration error is the narrowest one.
            rung = ScopeRung.SELF
    cache[position_id] = rung
    return rung


async def scope_condition(
    db: AsyncSession,
    user,
    *,
    owner_col=None,
    position_col=None,
    office_col=None,
    project_col=None,
    warehouse_col=None,
    warehouse_ids: set[int] | None = None,
) -> ColumnElement[bool]:
    """The WHERE clause for one table, for this login, at its profile's rung.

    Pass the columns the table actually has; a rung whose column is missing falls
    back to the rung below it rather than opening up. OFFICE without an office
    column means SELF, not "everything".

    Rows the login owns are always visible — the narrowest rung is still "mine",
    and no rung should hide a document from the person who raised it.
    """
    rung = await rung_for(db, user)

    # A warehouse document (a receipt, a dispatch, a put-away) is a fact about a
    # LOCATION, not a person, so the person rungs do not describe it well. What
    # bounds it is which warehouses this login may reach.
    #
    # But ALL means all, including at the dock. Applying the warehouse bound at ALL
    # emptied Head SCM & Logistics: that login resolves to zero warehouses because
    # its office has none attached, and an unfilled config field must not read as
    # "deny everything". Narrowing a warehouse view is done by giving the profile a
    # narrower rung, which is an explicit act.
    warehouse_clause = (
        warehouse_col.in_(warehouse_ids)
        if warehouse_col is not None and warehouse_ids
        else None
    )

    if rung is ScopeRung.ALL:
        return literal(True)

    position_id = getattr(user, "active_position_id", None)
    if owner_col is None:
        # Nothing identifies a raiser on this table, so the warehouse bound is the
        # only one available. Never widen to true here.
        return warehouse_clause if warehouse_clause is not None else literal(False)

    mine = owner_col == user.id
    if position_col is not None and position_id is not None:
        # Same person, different capacity: an indent raised as a storekeeper is not
        # visible from the lab technician session.
        mine = and_(mine, position_col == position_id)

    def _with_warehouse(condition):
        """Rows I raised stay visible even outside my warehouses; anything else
        must satisfy both the rung and the warehouse bound.

        `mine` is OR-ed in either way. Dropping it when there is no warehouse bound
        was a real bug: a PROJECT-rung login stopped seeing documents they had
        raised themselves in another project.
        """
        if warehouse_clause is None:
            return or_(mine, condition)
        return or_(mine, and_(condition, warehouse_clause))

    if rung is ScopeRung.SELF:
        return mine

    if rung is ScopeRung.PROJECT and project_col is not None:
        project_id = getattr(user, "project_id", None)
        if project_id is not None:
            return _with_warehouse(project_col == project_id)
        return mine

    if rung is ScopeRung.OFFICE and office_col is not None:
        office_id = getattr(user, "office_id", None)
        if office_id is not None:
            return _with_warehouse(office_col == office_id)
        return mine

    if rung is ScopeRung.SUBTREE and position_col is not None:
        descendants = await descendant_position_ids(db, position_id)
        if descendants:
            return _with_warehouse(position_col.in_(descendants))
        return mine

    return mine
