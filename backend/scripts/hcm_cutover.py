"""Move the mirror onto the rebuilt HCM feed. Idempotent — run it as often as needed.

Run:  .venv/Scripts/python -m scripts.hcm_cutover

The rebuilt HCM (:8009) re-keyed its whole position and office space: not one of the
4002 position ids it now serves matches the 3733 the old feed issued. A plain sync
only ever upserts, so without this script the mirror ends up holding both generations
at once, every one of them flagged active, and the approval ladder happily climbs a
parent chain that no longer exists.

So, in order:

1. Sync the entities SCM needs (sync.NEEDED_ENTITIES), parents first.
   Roles ride along: `sync_needed` calls `rbac.service.sync_hcm_roles`, which since
   2026-08-20 also RETIRES the HCM-sourced roles the feed no longer returns. Before
   that it only added, so this script retired the old generation's positions and left
   its roles live beside the new ones — which is how one job ended up on the ladder
   twice under two role ids.
2. Retire every position the feed did NOT return, and the assignment that seats
   someone on it. Retire, not delete: `wf_instances.resolved_chain` and every
   historical approval name a position id, and those must still resolve to a name.
   `is_active = 0` is exactly the flag the ladder and resolver already filter on.
3. Report what moved, including the handful of employee ids HCM handed to a
   different person — `sys_local_credentials` is keyed on that id and a sync does not
   re-issue it, so those passwords have to be dealt with by hand.

Employees are deliberately NOT retired the same way. The feed carries active staff
only (1918 of the mirror's 2840), `is_active` gates login, and the accounts that are
not in HCM include the ones the team signs in with.
"""
import asyncio

from sqlalchemy import func, select, update

from app.core.database import SessionLocal
from app.platform.hcm import sync
from app.platform.hcm.client import HcmClient
from app.platform.hcm.models import (
    HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.settings.models import UserCredential
from scripts.hcm_clean_slate import build_stocking_points


async def retire_absent_positions(db, live_ids: set[int]) -> tuple[int, int]:
    """Deactivate mirror positions the feed no longer serves, and their assignments.

    A guard, not an optimisation: an empty id set means the fetch failed, and
    retiring every position in the mirror would leave nothing for any ladder to
    resolve to.
    """
    if not live_ids:
        raise RuntimeError("HCM returned no positions — refusing to retire the mirror")

    positions = (await db.execute(
        update(HcmPosition)
        .where(HcmPosition.is_active.is_(True), HcmPosition.id.notin_(live_ids))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )).rowcount
    assignments = (await db.execute(
        update(HcmPositionAssignment)
        .where(HcmPositionAssignment.is_active.is_(True),
               HcmPositionAssignment.position_id.notin_(live_ids))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )).rowcount
    await db.commit()
    return positions, assignments


async def stocking_point_summary(db) -> list[tuple]:
    """What the feed says about stocking points: active positions per section."""
    return (await db.execute(
        select(HcmPosition.section_name, func.count(HcmPosition.id),
               func.count(func.distinct(HcmPosition.office_id)))
        .where(HcmPosition.is_active.is_(True))
        .group_by(HcmPosition.section_name)
        .order_by(func.count(HcmPosition.id).desc())
    )).all()


async def employee_codes(db) -> dict[int, tuple[str | None, str]]:
    """id -> (emp_code, name), for the before/after comparison below."""
    return {row[0]: (row[1], row[2]) for row in (await db.execute(
        select(HcmEmployee.id, HcmEmployee.emp_code, HcmEmployee.full_name)
    )).all()}


async def changed_hands(db, before: dict, after: dict) -> list[tuple]:
    """Employee ids that now belong to a DIFFERENT person than before the sync.

    HCM reuses ids: an id that held one HR-EMP code before the sync can come back
    holding another. `sys_local_credentials` is keyed on the employee id and is NOT
    re-issued by a sync, so that person's password now opens a session as whoever
    HCM moved onto the id. Nothing here fixes it — deciding who gets a new password
    is not a script's call — but it must never pass unnoticed.
    """
    moved = [
        (emp_id, before[emp_id][0], before[emp_id][1], code, name)
        for emp_id, (code, name) in after.items()
        if emp_id in before and before[emp_id][0] and before[emp_id][0] != code
    ]
    if not moved:
        return []
    held = {row[0] for row in (await db.execute(
        select(UserCredential.employee_id)
        .where(UserCredential.employee_id.in_([m[0] for m in moved]))
    )).all()}
    return [(*m, m[0] in held) for m in moved]


async def main() -> None:
    client = HcmClient()
    print(f"HCM: {client.base_url}")

    async with SessionLocal() as db:
        before = await employee_codes(db)

        for log in await sync.sync_needed(db, client):
            print(f"  {log.entity:18} {log.status:8} fetched={log.records_fetched:<6} "
                  f"upserted={log.records_upserted:<6} {(log.error_message or '')[:80]}")

        live_ids = {row["id"] for row in await client.fetch_all("positions")
                    if row.get("id") is not None}
        positions, assignments = await retire_absent_positions(db, live_ids)
        print(f"\nretired {positions} positions and {assignments} assignments "
              f"absent from the feed ({len(live_ids)} live)")

        print("\nactive positions by section (the LIP/MDP stocking points):")
        for section, count, offices in await stocking_point_summary(db):
            print(f"  {section or '(none)':12} {count:>5} positions across {offices:>4} offices")

        # Every position id changed, so every inv_position_locations row now names a
        # post that no longer exists. Rebuilding is not optional after a sync.
        await build_stocking_points(db)

        moved = await changed_hands(db, before, await employee_codes(db))
        if moved:
            print(f"\n!! {len(moved)} employee ids now hold a DIFFERENT person. Any "
                  "password on one of these opens a session as the new holder:")
            for emp_id, old_code, old_name, new_code, new_name, has_login in moved:
                flag = "LOGIN EXISTS" if has_login else "no login"
                print(f"  {emp_id:>8}  {old_code} {old_name!r} -> "
                      f"{new_code} {new_name!r}   [{flag}]")


if __name__ == "__main__":
    asyncio.run(main())
