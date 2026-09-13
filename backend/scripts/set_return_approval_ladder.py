"""Set the stock-return APPROVAL ladder — the chain the raiser's own document climbs.

ADDED 2026-09-07, the companion to `set_return_receiving_ladder`. Between them the two
scripts write the whole flow the business states:

    OE -> DM -> RM -> SPH -> CPO -> INDENT TEAM -> SCM HEAD   <- this script
      -> decision desk (INVENTORY MANAGER)                    <- set_return_receiving_ladder
      -> sign-off (SCM HEAD)                                  <- set_return_receiving_ladder
      -> logistics

The raiser's own rank is deliberately NOT a rung. A return is raised by a Store Keeper (or
a DEO, or a Driver — see `_raiser_positions`), and a chain whose first rung is the raiser's
own rank either asks them to approve their own document or is struck off at resolve time.
The chain starts one step ABOVE them.

WHY THIS IS NOT ONE `save_custom` CALL
--------------------------------------
A rung that names a RANK resolves in one of two ways, and getting it wrong is silent:

  * ROLE      — CLIMBED. `resolve_fixed_chain` walks up the raiser's own
                `parent_position_id` chain and keeps the ancestors holding that rank.
                Right for a rank on the raiser's reporting line.
  * ROLE_ANY  — a CHAIR. Read straight off the rank's holders, whoever raised the
                document. Right for a rank that is not above the raiser at all.

`custom_ladder._rank_approver_type` answers this from the project when a ladder is saved
FOR a project, and cannot answer it at all for a company-wide ladder (`project_id IS
NULL`) — there is no raiser to climb from, so it returns ROLE for every rank. That is why
the live company-wide chain has INVENTORY MANAGER and SCM HEAD saved as ROLE: a branch
storekeeper's climb never reaches either post, so both rungs resolve to nobody and the
chain silently ends at the District Manager. The same trap is why
`repair_company_ladders.py` patches the column after saving.

The distinction is genuinely unanswerable from a rank alone. In this mirror SPH (1 post, 8
children, 1 holder) and SCM HEAD (1 post, 9 children, 1 holder) are structurally
identical; what separates them is that the org is THREE disjoint trees —

    SPH-104   -> Regional Manager -> District Manager -> OE -> Store Keeper / DEO / Driver
    SCM HEAD  -> INVENTORY MANAGER, INDENT TEAM, FLOOR INCHARGE, LOGISTICS
    DIRECTOR  -> CPO

— and a return is raised in the first of them. So the only honest test is the one the
engine itself performs: climb from the posts returns are ACTUALLY raised from and see
which ranks you meet. That is what `_reachable_ranks` does, and every rung's approver type
is decided by it. Nothing here is hardcoded: no role id, no position id, no employee.

    .venv/Scripts/python -m scripts.set_return_approval_ladder --dry-run
    .venv/Scripts/python -m scripts.set_return_approval_ladder

The chain may be given on the command line, in order, to configure a different one:

    .venv/Scripts/python -m scripts.set_return_approval_ladder OE DM RM SPH "SCM HEAD"

Company-wide (`project_id = NULL`), like the receiving ladder. A project that has its own
STOCK_RETURN chain keeps it — `ladder.find_ladder` prefers the narrower scope, and
`save_custom` only retires rows in the scope it is writing. Pass `--project <id>` to write
that project's chain instead.
"""
import asyncio
import sys
from types import SimpleNamespace

from sqlalchemy import func, select, text, update

from app.core.database import SessionLocal
from app.modules.returns.enums import MARKER
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.workflow import custom_ladder, ladder
from app.platform.workflow.models import Stage, Workflow
from app.shared.enums import ApproverType, DocType, InstanceStatus

USER = SimpleNamespace(id=900001, full_name="admin (return approval ladder)")

DOC_TYPE = DocType.STOCK_RETURN.value

#: The chain, in order, as the business names it. RANK NAMES ONLY — every one of them is
#: looked up in the live mirror at run time, so this list survives a re-sync that renumbers
#: every role id. The raiser's own rank (Store Keeper) is not here on purpose; see the
#: module docstring.
WANTED = ["OE", "District Manager", "Regional Manager", "SPH",
          "CPO", "INDENT TEAM", "SCM HEAD"]

#: Shorthand accepted on the command line, expanded to what the mirror actually calls the
#: rank. Input parsing, not configuration: "DM" is what a person types, "District Manager"
#: is what HCM stores, and the lookup still runs against the mirror either way.
ALIASES = {
    "DM": "District Manager",
    "RM": "Regional Manager",
    "INDENTTEAM": "INDENT TEAM",
    "INDENT TEM": "INDENT TEAM",
    "SCMHEAD": "SCM HEAD",
    "IM": "INVENTORY MANAGER",
}


# --------------------------------------------------------------------------- ranks

async def _rank_rows(db) -> list[dict]:
    """Every live rank with its post and holder counts. One query, read once.

    Holder count is what tells a real rank from the HCM cutover's leftovers: the mirror
    carries two "District Manager" ranks (27 posts and a stray with one), "Store Keeper"
    beside an empty "STOREKEEPER", and the same for Driver. `flow_config.rungs` already
    hides the empty twin from the admin's picker; this does the same for a lookup by name.
    """
    rows = (await db.execute(
        select(HcmPosition.role_id,
               func.min(func.coalesce(HcmPosition.role_name, HcmPosition.job_name,
                                      HcmPosition.name)).label("role_name"),
               func.count(func.distinct(HcmPosition.id)).label("posts"),
               func.count(func.distinct(HcmPositionAssignment.employee_id)).label("held"))
        .outerjoin(HcmPositionAssignment,
                   (HcmPositionAssignment.position_id == HcmPosition.id)
                   & HcmPositionAssignment.is_active.is_(True))
        .where(HcmPosition.is_active.is_(True), HcmPosition.role_id.isnot(None))
        .group_by(HcmPosition.role_id)
    )).all()
    return [{"role_id": r[0], "role_name": r[1] or f"Rank {r[0]}",
             "posts": r[2], "held": r[3]} for r in rows]


def _match_rank(rows: list[dict], term: str) -> tuple[dict | None, list[dict]]:
    """(the one rank this term means, candidates). Exact name wins over a partial one.

    A partial match is only consulted when nothing matches exactly, because "OE" is a
    substring of a dozen job names and an exact rank called OE exists.
    """
    wanted = term.strip().casefold()
    exact = [row for row in rows if row["role_name"].strip().casefold() == wanted]
    pool = exact or [row for row in rows if wanted in row["role_name"].casefold()]
    # A rank nobody holds cannot approve anything — `resolve_fixed_chain` skips it — so
    # the twin with people in it is the one meant, every time.
    filled = [row for row in pool if row["held"]]
    if len(filled) == 1:
        return filled[0], pool
    if len(filled) > 1:
        # Still decidable when one of them plainly IS the rank: most posts, most holders.
        ranked = sorted(filled, key=lambda r: (-r["held"], -r["posts"]))
        if ranked[0]["held"] > ranked[1]["held"]:
            return ranked[0], pool
    return None, pool


# ------------------------------------------------------------------- who raises one

async def _raiser_positions(db) -> tuple[list[int], list[str]]:
    """The posts a stock return is actually raised from, and how each was found.

    Two independent readings of the same live data, unioned, so neither on its own has to
    be complete:

      * the posts held by whoever raised the returns already in `inv_sto` — the most
        direct evidence there is, and empty only on a deployment where none has been
        raised yet;
      * the posts held by people whose job profile carries `return.create` — which works
        on day one, before any return exists.

    Never a rank named in code. If both readings come back empty the script refuses rather
    than guess, because every rung's approver type is decided by climbing from these.
    """
    notes: list[str] = []
    found: set[int] = set()

    raised = (await db.execute(
        select(func.distinct(HcmPositionAssignment.position_id))
        .select_from(HcmPositionAssignment)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(HcmPositionAssignment.is_active.is_(True),
               HcmPosition.is_active.is_(True),
               HcmPositionAssignment.employee_id.in_(
                   select(text("requested_by_id")).select_from(text("inv_sto"))
                   .where(text("remarks LIKE :m")).params(m=f"{MARKER}%")))
    )).scalars().all()
    if raised:
        notes.append(f"{len(raised)} post(s) that have raised a return")
        found.update(raised)

    permitted = (await db.execute(
        select(func.distinct(HcmPositionAssignment.position_id))
        .select_from(HcmPositionAssignment)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.is_active.is_(True),
               HcmPosition.is_active.is_(True),
               HcmEmployee.is_active.is_(True),
               HcmPositionAssignment.employee_id.in_(
                   select(UserRole.employee_id)
                   .join(Role, Role.id == UserRole.role_id)
                   .join(RolePermission, RolePermission.role_id == Role.id)
                   .join(Permission, Permission.id == RolePermission.permission_id)
                   .where(Permission.code == perms.RETURN_CREATE,
                          Role.is_active.is_(True))))
    )).scalars().all()
    if permitted:
        notes.append(f"{len(permitted)} post(s) whose holder may raise one")
        found.update(permitted)

    return sorted(found), notes


async def _reachable_ranks(db, position_ids: list[int]) -> set[int]:
    """The ranks a climb from these posts actually meets — the engine's own walk.

    `ladder.resolve_chain` climbs `parent_position_id` upward and keeps ancestors, so a
    rank is climbable from a raiser exactly when one of its posts is above them. Bounded
    by `ladder.MAX_CLIMB`, and by a seen-set, for the same reason the engine is: HCM's
    tree has cycles in it.
    """
    reachable: set[int] = set()
    for start in position_ids:
        current, seen, hops = start, {start}, 0
        while current is not None and hops < ladder.MAX_CLIMB:
            hops += 1
            position = await db.get(HcmPosition, current)
            if position is None or position.parent_position_id in seen:
                break
            parent_id = position.parent_position_id
            if parent_id is None:
                break
            seen.add(parent_id)
            parent = await db.get(HcmPosition, parent_id)
            if parent is None:
                break
            if parent.is_active and parent.role_id is not None:
                reachable.add(parent.role_id)
            current = parent_id
    return reachable


# ---------------------------------------------------------------------- reporting

async def _live(db, project_id: int | None) -> tuple[Workflow, list[Stage]] | None:
    found = await ladder.active_ladder(db, project_id, DOC_TYPE, None)
    return found


async def _show(db, title: str, project_id: int | None) -> int:
    """Print the chain that is live for this scope. Returns its in-flight count."""
    print(title)
    found = await _live(db, project_id)
    if found is None:
        print("  (none configured — returns climb the reporting line above the raiser)")
        return 0
    wf, stages = found
    in_flight = (await db.execute(text(
        "SELECT COUNT(*) FROM wf_instances WHERE workflow_id=:w AND status=:s"),
        {"w": wf.id, "s": InstanceStatus.IN_PROGRESS.value})).scalar() or 0
    policy, _fallback = await ladder.read_policy(db, stages)
    print(f"  {wf.code} v{wf.version}, policy {policy}, {in_flight} in flight")
    for stage in sorted(stages, key=lambda s: s.sequence):
        kind = ("climbed" if stage.approver_type == ApproverType.ROLE.value
                else "chair" if stage.approver_type == ApproverType.ROLE_ANY.value
                else stage.approver_type.lower())
        print(f"    {stage.sequence}. {stage.name[:28]:<28} {kind:<9} "
              f"rank={stage.position_role_id} on={stage.is_enabled}")
    return in_flight


async def _preview(db, project_id: int | None, sample: int | None) -> None:
    """Resolve the saved chain for one real raiser, and print who would sign.

    The point of the script is a chain that resolves to PEOPLE. Asking
    `resolve_fixed_chain` — the very function the engine calls — is the only check that
    proves it, and it is what would have caught the two dead rungs on the live chain.
    """
    if sample is None:
        print("\n(no raiser post found to resolve against — skipping the check)")
        return
    found = await _live(db, project_id)
    if found is None:
        return
    _wf, stages = found
    policy, _fallback = await ladder.read_policy(db, stages)
    post = await db.get(HcmPosition, sample)
    chain = await custom_ladder.resolve_fixed_chain(
        db, stages, requester_id=None, policy=policy,
        requester_position_id=sample, context={})
    print(f"\nresolved for a real raiser — {post.name if post else sample} "
          f"({post.role_name if post else '?'}):")
    if not chain:
        print("  NOBODY. The chain resolves to no approver at all.")
    for rung in chain:
        people = ", ".join(rung.get("approver_names") or []) or "NOBODY"
        print(f"  {rung['sequence']}. {str(rung.get('role_name'))[:26]:<26} {people}")


# --------------------------------------------------------------------------- main

async def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv
    argv = [arg for arg in argv if arg != "--dry-run"]

    project_id: int | None = None
    if "--project" in argv:
        index = argv.index("--project")
        try:
            project_id = int(argv[index + 1])
        except (IndexError, ValueError):
            print("--project needs a project id")
            return 2
        argv = argv[:index] + argv[index + 2:]

    terms = argv or WANTED
    terms = [ALIASES.get(term.strip().upper(), term) for term in terms]

    async with SessionLocal() as db:
        scope = "All projects" if project_id is None else f"project {project_id}"
        in_flight = await _show(db, f"current {DOC_TYPE} chain ({scope}):", project_id)
        print()

        rows = await _rank_rows(db)
        raisers, notes = await _raiser_positions(db)
        if not raisers:
            print("Cannot tell which ranks are on a raiser's reporting line: no post in "
                  "the mirror has either raised a stock return or holds "
                  f"{perms.RETURN_CREATE}. Fix that first — every rung's approver type "
                  "is decided by climbing from those posts.")
            return 1
        print(f"raisers discovered from live data: {', '.join(notes)} "
              f"-> {len(raisers)} post(s)")
        reachable = await _reachable_ranks(db, raisers)
        names = {row["role_id"]: row["role_name"] for row in rows}
        print("ranks a climb from them reaches: "
              + ", ".join(sorted(names.get(r, str(r)) for r in reachable)))
        print()

        steps, failed = [], False
        for term in terms:
            rank, candidates = _match_rank(rows, term)
            if rank is None:
                failed = True
                print(f"  {term:<20} -> AMBIGUOUS OR UNKNOWN")
                for row in sorted(candidates, key=lambda r: -r["held"])[:8]:
                    print(f"      role_id={row['role_id']} posts={row['posts']} "
                          f"holders={row['held']} {row['role_name']!r}")
                continue
            climbed = rank["role_id"] in reachable
            kind = "climbed" if climbed else "chair"
            print(f"  {term:<20} -> role_id={rank['role_id']:<5} "
                  f"{rank['role_name'][:20]:<20} posts={rank['posts']:<5} "
                  f"holders={rank['held']:<4} {kind}")
            steps.append(SimpleNamespace(
                name=rank["role_name"][:200], position_id=None, post_id=None,
                position_role_id=rank["role_id"], climbed=climbed))
        if failed:
            print("\nnothing written — name the rank exactly, or pass the chain as "
                  "arguments.")
            return 1

        # The policy the scope already runs under, not one chosen here. Changing how the
        # raiser is treated is a separate decision from changing who is on the chain.
        live = await _live(db, project_id)
        policy = ladder.POLICY_INDEPENDENT
        if live is not None:
            policy, _fallback = await ladder.read_policy(db, live[1])
        print(f"\nself-approval policy: {policy} (carried over from the live chain)")

        if dry_run:
            print("\n--dry-run: nothing written.")
            return 0

        saved = await custom_ladder.save_custom(db, SimpleNamespace(
            project_id=project_id, doc_type=DOC_TYPE, raiser_role_id=None,
            self_approval_policy=policy, fallback_position_id=None,
            steps=[SimpleNamespace(name=s.name, position_id=None, post_id=None,
                                   position_role_id=s.position_role_id)
                   for s in steps],
        ), USER)

        # `save_custom` cannot decide ROLE vs ROLE_ANY for a company-wide ladder — see the
        # module docstring — so the types worked out above are written over its guess. Done
        # per rank rather than in bulk, because a chain may legitimately hold both kinds.
        wf_id = saved.get("workflow_id") if isinstance(saved, dict) else None
        if wf_id is None:
            wf_id = (await db.execute(
                select(Workflow.id).where(
                    Workflow.doc_type == DOC_TYPE,
                    (Workflow.project_id == project_id if project_id is not None
                     else Workflow.project_id.is_(None)),
                    Workflow.raiser_role_id.is_(None),
                    Workflow.is_active.is_(True))
                .order_by(Workflow.version.desc(), Workflow.id.desc()).limit(1)
            )).scalar()
        for step in steps:
            await db.execute(
                update(Stage)
                .where(Stage.workflow_id == wf_id,
                       Stage.position_role_id == step.position_role_id)
                .values(approver_type=(ApproverType.ROLE.value if step.climbed
                                       else ApproverType.ROLE_ANY.value)))
        await db.commit()

        print()
        await _show(db, f"saved {DOC_TYPE} chain ({scope}):", project_id)
        await _preview(db, project_id, raisers[0] if raisers else None)

        if in_flight:
            print(f"\n{in_flight} return(s) were already in flight on the retired "
                  "version. They finish on the chain they started — "
                  "`wf_instances.resolved_chain` is frozen at submit.")
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
