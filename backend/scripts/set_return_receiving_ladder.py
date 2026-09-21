"""Set the stock-return receiving ladder to INVENTORY MANAGER -> SCM HEAD.

ADDED 2026-09-07, alongside the reorder in `app/modules/returns` that makes every return
climb its approval ladder first. The order the business states is

    ... -> Inventory Manager -> SCM Head -> decision desk -> SCM Head sign-off -> logistics

The first two rungs of that are the RAISER'S OWN reporting line, which is climbed and
therefore needs no configuration. The last two are the receiving ladder, and that is
data: `STOCK_RETURN_RECEIPT` is stored as a hand-built ladder of POSTS, because the SCM
desks sit on `parent_position_id = NULL` and no climb from a branch ever reaches them
(see `platform/workflow/custom_ladder.py` and `modules/returns/receiving.py`).

That ladder is currently a seven-rung copy of the reporting line — Store Keeper -> OE ->
District Manager -> District Manager -> Regional Manager -> SPH -> SCM HEAD. Its FIRST
rung is the decision desk, so as configured the STORE KEEPER decides where returned
material goes and six people above them endorse it. This rewrites it as the two rungs it
is meant to be:

    rung 1  INVENTORY MANAGER   the decision desk — picks the disposition
    rung 2  SCM HEAD            the sign-off — agrees the route, and that yes is the
                                final approval that releases the return to logistics

Nothing is edited in place. `receiving.save_config` writes version N+1 and retires the
previous one, because a return already sitting with the desk resolved its chain against
the version that was live when it got there (`wf_instances.resolved_chain`) and that must
not move under it.

    .venv/Scripts/python -m scripts.set_return_receiving_ladder

Posts are resolved by SEARCHING the HCM mirror, never by hardcoded id: the ids differ per
deployment. Where a name does not match exactly one live post the script prints the
candidates and refuses, so a wrong post is never written silently. Pass ids to override:

    .venv/Scripts/python -m scripts.set_return_receiving_ladder 2146 2148
"""
import asyncio
import sys
from types import SimpleNamespace

from sqlalchemy import or_, select

from app.core.database import SessionLocal
from app.modules.returns import receiving
from app.platform.hcm.models import HcmPosition

USER = SimpleNamespace(id=900001, full_name="admin (return receiving ladder)")

# The two chairs, in order. Matched against a post's own name, its HCM role and its job
# name — the same three columns `receiving.search_positions` offers the admin.
WANTED = [
    ("decision desk", "INVENTORY MANAGER"),
    ("sign-off", "SCM HEAD"),
]


async def _candidates(db, term: str) -> list[HcmPosition]:
    like = f"%{term}%"
    return list((await db.execute(
        select(HcmPosition)
        .where(HcmPosition.is_active.is_(True))
        .where(or_(HcmPosition.name.ilike(like),
                   HcmPosition.role_name.ilike(like),
                   HcmPosition.job_name.ilike(like)))
        .order_by(HcmPosition.name)
    )).scalars().all())


def _describe(post: HcmPosition) -> str:
    return (f"{post.id} {post.name!r} "
            f"(role={post.role_name or '-'}, job={post.job_name or '-'})")


async def _resolve(db) -> list[int] | None:
    """The two post ids, or None where a name did not land on exactly one live post."""
    ordered: list[int] = []
    for chair, term in WANTED:
        found = await _candidates(db, term)
        if len(found) == 1:
            print(f"{chair:<14} {term:<18} -> {_describe(found[0])}")
            ordered.append(found[0].id)
            continue
        if not found:
            print(f"{chair:<14} {term:<18} -> NO live post matches. Search for it on the "
                  "Returns > Receiving approvers screen and pass its id as an argument.")
        else:
            print(f"{chair:<14} {term:<18} -> {len(found)} live posts match; pick one and "
                  "pass its id as an argument:")
            for post in found[:20]:
                print(f"    {_describe(post)}")
            if len(found) > 20:
                print(f"    ... and {len(found) - 20} more")
        return None
    return ordered


async def main(argv: list[str]) -> int:
    async with SessionLocal() as db:
        before = await receiving.get_config(db)
        print("current receiving ladder:")
        if before["steps"]:
            for step in before["steps"]:
                chair = "decision desk" if step["sequence"] == 1 else "sign-off"
                holders = ", ".join(h["name"] for h in step["holders"]) or "NOBODY"
                print(f"  {step['sequence']}. {step['name']} [{chair}] — {holders}")
        else:
            print("  (none configured — returns settle on the reporting line alone)")
        print(f"  version {before['version']}, {before['in_flight']} return(s) in flight")
        print()

        if argv:
            try:
                ordered = [int(arg) for arg in argv]
            except ValueError:
                print(f"arguments must be position ids: {argv}")
                return 2
            print(f"using the ids given on the command line: {ordered}")
        else:
            ordered = await _resolve(db)
            if ordered is None:
                print("\nnothing written.")
                return 1
        print()

        after = await receiving.save_config(db, ordered, USER)
        print(f"saved version {after['version']}:")
        for step in after["steps"]:
            chair = "decision desk" if step["sequence"] == 1 else "sign-off"
            holders = ", ".join(h["name"] for h in step["holders"]) or "NOBODY"
            print(f"  {step['sequence']}. {step['name']} [{chair}] — {holders}")
        for warning in after["warnings"]:
            print(f"  WARNING: {warning}")

        # Said out loud rather than left to be discovered: the retired version is what
        # any return already at a desk is still being routed by, and those rows finish on
        # the seven rungs they started on.
        if before["in_flight"]:
            print(f"\n{before['in_flight']} return(s) were already in flight on version "
                  f"{before['version']}. They keep that chain to the end — the new "
                  "ladder applies to returns that reach the desk from now on.")
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
