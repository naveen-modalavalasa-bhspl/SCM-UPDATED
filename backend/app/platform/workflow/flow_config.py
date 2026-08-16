"""One screen's worth of approval configuration: every document type, its chain.

The existing config surface grew into four screens — Approvals Config, Custom Ladder,
Workflows, Policies — that between them expose the implementation to the admin: rank
ladder vs hand-built ladder vs raw workflow, each with its own vocabulary. An admin
setting up "indent goes to the Indent Team, then the SCM Head" should not have to know
which of those they are in.

So this module answers one question — *who signs what* — in one shape:

    document type  ->  an ordered list of steps

A step is a chair, of one of three kinds (see `custom_ladder.resolve_fixed_chain`):
climb to a RANK, an HCM post, or a post this system owns. The admin picks from one
list; which kind it is decides how it resolves, and they never have to say the words.

Everything is stored exactly as the existing hand-built ladder stores it, so this is a
new front on the same data: a chain saved here is readable by the old screens, the
engine path is unchanged, and nothing has to be migrated if this screen is dropped.
"""
import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.platform.hcm.models import HcmEmployee, HcmPosition
from app.platform.workflow import custom_ladder, ladder, posts
from app.platform.workflow.models import Instance, Stage, Workflow
from app.platform.workflow.schemas import CustomLadderIn, CustomLadderStepIn
from app.shared.enums import InstanceStatus

logger = logging.getLogger(__name__)

# What each policy means, in the admin's words rather than the engine's. Sent with the
# overview so the screen never hardcodes copy the backend can contradict.
POLICY_LABELS = [
    {"value": ladder.POLICY_INDEPENDENT, "label": "Someone else must approve",
     "help": "The raiser is dropped from every step of their own document."},
    {"value": ladder.POLICY_CREATOR_ALLOWED, "label": "The raiser may approve",
     "help": "For teams where the same few people hold every post."},
    {"value": ladder.POLICY_NONE, "label": "No approval needed",
     "help": "The document is approved the moment it is raised, and says so."},
]


def _describe(steps: list[dict]) -> str:
    """The chain as one readable line — what the overview shows instead of a table."""
    if not steps:
        return ""
    return " → ".join(step["name"] for step in steps)


async def overview(db: AsyncSession, project_id: int | None) -> dict:
    """Every document type with its chain, ready to render as one row each.

    Deliberately every type, configured or not: a document type with no chain is the
    thing an admin most needs to see, and a screen that lists only what is already set
    up hides exactly that.
    """
    doc_types = await ladder.list_doc_types()
    workflows = await _active_by_doc_type(db, project_id)
    in_flight = await _in_flight_counts(db, [wf.id for wf in workflows.values()])

    rows = []
    for entry in doc_types:
        wf = workflows.get(entry["code"])
        steps: list[dict] = []
        policy = ladder.POLICY_INDEPENDENT
        if wf is not None:
            stages = await _stages_of(db, wf.id)
            policy, _fallback = await ladder.read_policy(db, stages)
            steps = await _step_summaries(db, stages)
        rows.append({
            **entry,
            "workflow_id": wf.id if wf else None,
            "is_configured": wf is not None,
            # A ladder saved on one of the older screens is shown and editable here too,
            # but flagged, because saving it here rewrites it in the newer form.
            "is_legacy": wf is not None and not ladder.is_custom_ladder(wf),
            "self_approval_policy": policy,
            "summary": _describe(steps),
            "step_count": len(steps),
            "in_flight": in_flight.get(wf.id, 0) if wf else 0,
        })

    order = {name: index for index, name in enumerate(ladder.MODULE_ORDER)}
    rows.sort(key=lambda row: (order.get(row["module"], len(order)), row["label"]))
    return {"items": rows, "policies": POLICY_LABELS,
            "modules": ladder.MODULE_ORDER + ["Other"]}


async def _active_by_doc_type(db: AsyncSession,
                              project_id: int | None) -> dict[str, Workflow]:
    """The chain governing each doc type for this scope.

    Uses `ladder.find_ladder`, so a project with no chain of its own correctly shows the
    company-wide one rather than an empty row — which is what the engine will actually
    use, and the whole point of the screen is that it agrees with the engine.
    """
    out: dict[str, Workflow] = {}
    for entry in await ladder.list_doc_types():
        found = await ladder.find_ladder(db, project_id, entry["code"])
        if found is not None:
            out[entry["code"]] = found[0]
    return out


async def _stages_of(db: AsyncSession, workflow_id: int) -> list[Stage]:
    return list((await db.execute(
        select(Stage).where(Stage.workflow_id == workflow_id).order_by(Stage.sequence)
    )).scalars().all())


async def _in_flight_counts(db: AsyncSession, workflow_ids: list[int]) -> dict[int, int]:
    if not workflow_ids:
        return {}
    rows = (await db.execute(
        select(Instance.workflow_id, func.count(Instance.id))
        .where(Instance.workflow_id.in_(workflow_ids),
               Instance.status == InstanceStatus.IN_PROGRESS.value)
        .group_by(Instance.workflow_id)
    )).all()
    return {row[0]: row[1] for row in rows}


async def _step_summaries(db: AsyncSession, stages: list[Stage]) -> list[dict]:
    """One line per step: its name and how it resolves. No holder lookups.

    The overview lists every document type, so this runs a dozen times per page load —
    it must not fan out into a holder query per step. The detail screen does that.
    """
    enabled = [stage for stage in stages if stage.is_enabled]
    names: dict[int, str] = {}
    position_ids = [s.position_id for s in enabled if s.position_id]
    if position_ids:
        names = {row[0]: row[1] for row in (await db.execute(
            select(HcmPosition.id, HcmPosition.name)
            .where(HcmPosition.id.in_(position_ids))
        )).all()}
    return [{
        "sequence": stage.sequence,
        "name": stage.name or names.get(stage.position_id or 0) or "Step",
        "kind": ("rank" if stage.position_role_id is not None
                 else "local" if stage.post_id is not None else "hcm"),
    } for stage in enabled]


async def chain(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """One document type's chain, with everything the editor needs to change it."""
    saved = await custom_ladder.get_custom(db, project_id, doc_type)
    if saved.get("is_new"):
        # Nothing hand-built for this scope, but a rank ladder or a seeded workflow may
        # still be governing it. Show that, so the admin edits what is really in force
        # rather than starting from a blank slate that silently competes with it.
        found = await ladder.find_ladder(db, project_id, doc_type)
        if found is not None:
            wf, stages = found
            policy, fallback_position_id = await ladder.read_policy(db, stages)
            saved = {
                **saved,
                "workflow_id": wf.id, "version": wf.version, "is_new": False,
                "is_legacy": True,
                "self_approval_policy": policy,
                "fallback_position_id": fallback_position_id,
                "steps": await _legacy_steps(db, stages),
                "warnings": ["This chain was built on the older Approvals Config "
                             "screen. Saving it here rewrites it in the new form; the "
                             "old version is kept and documents already in approval "
                             "are untouched."],
            }
    saved.setdefault("is_legacy", False)
    saved["label"] = ladder.DOC_TYPE_LABEL.get(doc_type, doc_type)
    saved["policies"] = POLICY_LABELS
    return saved


async def _legacy_steps(db: AsyncSession, stages: list[Stage]) -> list[dict]:
    """A rank ladder's rungs in this screen's step shape, so it can be edited here."""
    ranks: dict[int, str] = {}
    role_ids = [s.position_role_id for s in stages if s.position_role_id]
    if role_ids:
        ranks = {row[0]: row[1] for row in (await db.execute(
            select(HcmPosition.role_id, HcmPosition.role_name)
            .where(HcmPosition.role_id.in_(role_ids)).distinct()
        )).all()}
    # Who actually sits in each chair. Left empty here once, which made every HCM and
    # local step of a legacy chain render as "nobody seated, will be skipped" even when
    # the post was filled — the screen accusing the mirror of being empty. Read with
    # project_id=None for the same reason the picker no longer filters: a cross-project
    # chair is a real holder.
    enabled = [s for s in stages if s.is_enabled]
    holders_of, _first = await ladder._position_people(
        db, [s.position_id for s in enabled if s.position_id], None)
    local_seats = await posts.members_of(
        db, [s.post_id for s in enabled if s.post_id])

    def _seats(stage: Stage) -> list[dict]:
        if stage.post_id is not None:
            return local_seats.get(stage.post_id, [])
        if stage.position_id is not None:
            return [{"id": h.id, "name": h.full_name, "code": h.emp_code}
                    for h in holders_of.get(stage.position_id, [])]
        return []

    return [{
        "sequence": index + 1,
        "position_id": stage.position_id,
        "post_id": stage.post_id,
        "position_role_id": stage.position_role_id,
        "kind": ("rank" if stage.position_role_id is not None
                 else "local" if stage.post_id is not None else "hcm"),
        "name": stage.name or ranks.get(stage.position_role_id or 0) or "Step",
        "holders": _seats(stage)[:8],
        # A rank rung has no fixed holder, so it is never "dead" for want of one.
        "is_dead": stage.position_role_id is None and not _seats(stage),
    } for index, stage in enumerate(enabled)]


async def versions(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """Every version of this chain, newest first, with what is still riding each one.

    A saved chain is frozen onto the document at submit, so retired versions keep
    governing documents that started under them. Which is exactly the question an admin
    has after editing a chain — "what did I just NOT change?" — and the reason this
    lists in-flight documents per version rather than one total.
    """
    stmt = select(Workflow).where(Workflow.doc_type == doc_type)
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    rows = list((await db.execute(
        stmt.order_by(Workflow.version.desc(), Workflow.id.desc()))).scalars().all())
    if not rows:
        return {"items": []}

    live = await _in_flight_by_workflow(db, [wf.id for wf in rows])
    authors = await _authors(db, [wf.created_by_id for wf in rows])

    items = []
    for wf in rows:
        stages = await _stages_of(db, wf.id)
        items.append({
            "workflow_id": wf.id,
            "version": wf.version,
            "is_active": bool(wf.is_active),
            "code": wf.code,
            "saved_at": wf.created_at.isoformat() if wf.created_at else None,
            "saved_by": authors.get(wf.created_by_id),
            "summary": _describe(await _step_summaries(db, stages)),
            "documents": live.get(wf.id, []),
        })
    return {"items": items}


async def _authors(db: AsyncSession, employee_ids: list[int | None]) -> dict[int, str]:
    wanted = {value for value in employee_ids if value is not None}
    if not wanted:
        return {}
    rows = (await db.execute(
        select(HcmEmployee.id, HcmEmployee.full_name)
        .where(HcmEmployee.id.in_(wanted))
    )).all()
    return {row[0]: row[1] for row in rows}


async def _in_flight_by_workflow(db: AsyncSession,
                                 workflow_ids: list[int]) -> dict[int, list[dict]]:
    """The documents still climbing each version — the document itself, not a count.

    Capped per version: a chain that has been live for a month can hold hundreds, and
    the screen only ever shows the first few with a total beside them.
    """
    if not workflow_ids:
        return {}
    rows = (await db.execute(
        select(Instance).where(
            Instance.workflow_id.in_(workflow_ids),
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        ).order_by(Instance.started_at.desc())
    )).scalars().all()
    out: dict[int, list[dict]] = {}
    for instance in rows:
        out.setdefault(instance.workflow_id, []).append({
            "id": instance.id,
            "doc_no": instance.doc_no or f"#{instance.doc_id}",
            "stage": instance.current_stage_name,
            "sequence": instance.current_sequence,
            "started_by": instance.started_by_name,
            "started_at": instance.started_at.isoformat() if instance.started_at else None,
        })
    return out


async def restore(db: AsyncSession, project_id: int | None, doc_type: str,
                  workflow_id: int, user) -> dict:
    """Re-save an old version's steps as the newest one.

    Never reactivates the old row: a version is a historical record, and documents
    frozen onto it must keep resolving against exactly what they started with. So a
    restore is an ordinary save that happens to copy its steps from further back.
    """
    wf = await db.get(Workflow, workflow_id)
    if wf is None or wf.doc_type != doc_type:
        raise NotFoundError(f"Version {workflow_id} not found for {doc_type}")

    stages = await _stages_of(db, wf.id)
    policy, fallback_position_id = await ladder.read_policy(db, stages)
    steps = [
        CustomLadderStepIn(
            name=stage.name or "Step",
            position_id=stage.position_id,
            post_id=stage.post_id,
            position_role_id=stage.position_role_id,
        )
        for stage in stages
        if stage.is_enabled and (stage.position_id is not None
                                 or stage.post_id is not None
                                 or stage.position_role_id is not None)
    ]
    logger.info("Restoring %s v%s for project %s as a new version",
                doc_type, wf.version, project_id)
    return await custom_ladder.save_custom(db, CustomLadderIn(
        project_id=project_id, doc_type=doc_type, steps=steps,
        self_approval_policy=policy, fallback_position_id=fallback_position_id,
    ), user)


async def rungs(db: AsyncSession, project_id: int | None, search: str = "") -> dict:
    """Everything an admin may put on a chain, in one list, grouped by kind.

    One list rather than three tabs: the admin is choosing a chair, and whether that
    chair happens to exist in HCM is our problem, not theirs.
    """
    local = (await posts.list_posts(db))["items"]
    ranks = await ladder.project_ranks(db, project_id)

    hcm: list[dict] = []
    term = (search or "").strip()
    if len(term) >= 2:
        stmt = (select(HcmPosition.id, HcmPosition.name, HcmPosition.role_name)
                .where(HcmPosition.is_active.is_(True),
                       HcmPosition.name.like(f"%{term}%"))
                .order_by(HcmPosition.name).limit(25))
        # Deliberately NOT filtered to the selected project. A chair that serves every
        # project — the Inventory Manager, who sees every item in every warehouse — is
        # seated on a post HCM tags with somebody else's project, and scoping the search
        # to this project's own posts is what hid them. Resolution was never scoped
        # (custom_ladder resolves an HCM step with project_id=None), so a post picked
        # from another project already approves correctly once saved.
        hcm = [{"id": row[0], "name": row[1], "role_name": row[2] or ""}
               for row in (await db.execute(stmt)).all()]

    return {
        "local": [{"id": row["id"], "name": row["name"],
                   "department": row["department"],
                   "members": row["members"]} for row in local],
        "ranks": [{"id": rank["role_id"], "name": rank["role_name"],
                   "position_count": rank.get("position_count", 0),
                   "people_count": rank.get("holder_count", 0)} for rank in ranks],
        "hcm": hcm,
    }
