"""Fix the "approver pinned to one named person" ladder defect found as SCM_0064.

TRANSPORT_REQUEST, ALLOCATION, GRN and CARRIER_AWARD each had an active ladder whose
one stage named ONE SPECIFIC PERSON'S POSITION rather than a rank -- company-wide, or
pinned to a position belonging to a DIFFERENT project than the ladder's own scope --
so anyone else holding the intended rank, including every OTHER current holder of it,
was refused with "You are not a valid approver for the current stage" the moment they
pressed Approve. SCM Head hit it on Shipments; the same shape of mistake was sitting
on three siblings nobody had tried yet.

104-MMU (a field project of ~1,900 people) has no SCM staff of its own and relies
entirely on the ~20-person central SUPPLY CHAIN MANAGEMENT team -- SCM Head, Inventory
Manager, Logistics, QC-Inward -- to approve these for it. Someone configuring the
ladder picked ONE NAMED PERSON off that team instead of their RANK, so the ladder broke
the moment that one person was unavailable, or anyone else holding the same rank tried
to sign.

The fix is a company-wide, RANK-based ladder -- Settings > Approvals Config's own
mechanism (`ladder_config.save_ladder`), never raw SQL on `wf_stages`. It is resolved
at submit time by climbing the raiser's own reporting line, and -- for a central desk
nobody's chain reaches -- by `ladder.offline_rung_resolution`'s company-wide rescue,
the exact mechanism this already depends on elsewhere. A project's OWN correctly
scoped ladder (a position that genuinely belongs to THAT project, e.g. SUPPLY CHAIN
MANAGEMENT's own CARRIER_AWARD chain, which really does sit under it) is never
touched -- only a pin that points outside its own scope is.

Detects the defect GENERICALLY, by comparing each pinned position's own project_id
against the ladder's, rather than by hardcoded workflow ids -- those are
auto-increment primary keys and will differ on every database. Safe to run against
any environment this shipped to, not only the one it was first found and fixed on
(SCM_REBUILD_DEV_TEAM, 2026-10-21).

Idempotent: a doc type whose company-wide ladder already matches the target rank,
with no broken override left active, reports nothing to do on a second run.

MR and STOCK_TRANSFER carry the same defect but, on the database this was fixed from,
already have a CORRECT company-wide ladder underneath the broken override (MR: a real
two-rank chain; STOCK_TRANSFER: a deliberate "no approval required" policy) -- so only
the broken override is retired for them, never a new ladder invented. If a target
database has nothing correct underneath, this script says so instead of guessing a
policy; configure one on Settings > Approvals Config.

    .venv/Scripts/python -m scripts.fix_approval_chains          # say what would change
    .venv/Scripts/python -m scripts.fix_approval_chains --apply  # and write it
"""
import asyncio
import sys
from types import SimpleNamespace

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.hcm.models import HcmPosition, HcmRole
from app.platform.workflow import ladder, ladder_config
from app.platform.workflow import service as wf_service
from app.platform.workflow.models import Stage, Workflow
from app.platform.workflow.schemas import LadderIn, LadderRungIn
from app.shared.enums import ApproverType

USER = SimpleNamespace(id=900001, full_name="admin (approval chain repair)")

# doc_type -> the rank that must serve it company-wide. Fixed and verified on
# SCM_REBUILD_DEV_TEAM on 2026-10-21.
TARGET_RANK: dict[str, tuple[int, str]] = {
    "TRANSPORT_REQUEST": (186, "SCM Head"),
    "ALLOCATION": (187, "Inventory Manager"),
    "GRN": (167, "QC-Inward"),
    "CARRIER_AWARD": (184, "Logistics"),
}

# Same defect, but only the broken override is retired here -- see the module
# docstring for why these two never get a new ladder invented.
RETIRE_ONLY = ["MR", "STOCK_TRANSFER"]

ALL_DOC_TYPES = [*TARGET_RANK, *RETIRE_ONLY]


async def _position_project(db, position_id: int) -> int | None:
    pos = await db.get(HcmPosition, position_id)
    return pos.project_id if pos else None


async def _find_broken(db, doc_type: str) -> list[tuple[Workflow, int | None]]:
    """Active workflows for this doc type pinned to a position outside their own
    scope: a company-wide ladder (project_id IS NULL) naming ANY specific position
    at all, or a project-scoped one naming a position belonging to a DIFFERENT
    project. Returns (workflow, the offending position's own project_id)."""
    broken = []
    workflows = (await db.execute(
        select(Workflow).where(Workflow.doc_type == doc_type, Workflow.is_active.is_(True))
    )).scalars().all()
    for wf in workflows:
        stages = (await db.execute(
            select(Stage).where(Stage.workflow_id == wf.id)
        )).scalars().all()
        for stage in stages:
            if stage.approver_type != ApproverType.POSITION.value or stage.position_id is None:
                continue
            pos_project = await _position_project(db, stage.position_id)
            if wf.project_id is None or pos_project != wf.project_id:
                broken.append((wf, pos_project))
                break  # one bad stage is enough to retire the whole workflow
    return broken


async def _has_correct_ladder(db, doc_type: str, role_id: int) -> bool:
    found = await ladder.find_ladder(db, None, doc_type)
    if not found:
        return False
    wf, stages = found
    live = [s for s in stages if s.is_enabled]
    return (wf.project_id is None and len(live) == 1
            and live[0].position_role_id == role_id
            and live[0].approver_type != ApproverType.POSITION.value)


async def _check_role_names(db) -> None:
    """Role ids are HCM-mirrored and should be stable across environments, but a
    mismatch here would silently misconfigure every ladder below it -- so this is
    said out loud rather than assumed."""
    for role_id, expected_name in TARGET_RANK.values():
        role = await db.get(HcmRole, role_id)
        actual = (role.name if role else None) or ""
        if expected_name.lower() not in actual.lower():
            print(f"WARNING: role {role_id} is {actual!r} on this database, "
                  f"expected something like {expected_name!r} -- STOP and confirm "
                  "the rank ids before applying.")


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        await _check_role_names(db)

        to_retire: list[Workflow] = []
        to_create: list[tuple[str, int, str]] = []
        warnings: list[str] = []

        for doc_type in ALL_DOC_TYPES:
            for wf, pos_project in await _find_broken(db, doc_type):
                scope = "company-wide" if wf.project_id is None else f"project {wf.project_id}"
                print(f"{doc_type}: workflow {wf.id} ({wf.code}) is {scope} but pinned "
                      f"to a position belonging to project {pos_project} -- retiring it")
                to_retire.append(wf)

            if doc_type in TARGET_RANK:
                role_id, role_name = TARGET_RANK[doc_type]
                if await _has_correct_ladder(db, doc_type, role_id):
                    print(f"{doc_type}: company-wide {role_name} ladder already "
                          "correct -- nothing to do")
                else:
                    to_create.append((doc_type, role_id, role_name))
            else:
                retiring_ids = {w.id for w in to_retire}
                remaining = await ladder.find_ladder(db, None, doc_type)
                if remaining is None or remaining[0].id in retiring_ids:
                    warnings.append(
                        f"{doc_type}: no company-wide ladder survives retiring the "
                        "broken override -- this doc type will fall through to the "
                        "old reporting-line fallback until one is configured on "
                        "Settings > Approvals Config.")

        if not apply:
            for doc_type, role_id, role_name in to_create:
                print(f"{doc_type}: would create a company-wide {role_name} "
                      f"(rank {role_id}) ladder")
            for line in warnings:
                print("WARNING:", line)
            print(f"\n{len(to_retire)} workflow(s) would be retired, "
                  f"{len(to_create)} ladder(s) would be created. "
                  "Nothing written -- pass --apply.")
            return

        for wf in to_retire:
            await wf_service.deactivate_workflow(db, wf.id, USER)

        for doc_type, role_id, role_name in to_create:
            await ladder_config.save_ladder(
                db,
                LadderIn(project_id=None, doc_type=doc_type,
                         rungs=[LadderRungIn(position_role_id=role_id, name=role_name,
                                             is_enabled=True)]),
                USER,
            )
            print(f"{doc_type}: company-wide {role_name} ladder created")

        for line in warnings:
            print("WARNING:", line)
        print(f"\n{len(to_retire)} workflow(s) retired, "
              f"{len(to_create)} ladder(s) created.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
