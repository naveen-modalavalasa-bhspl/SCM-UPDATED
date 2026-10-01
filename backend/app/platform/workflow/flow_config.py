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

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmEmployee, HcmPosition
from app.platform.rbac.models import Permission, Role, RolePermission
from app.platform.settings.service import write_audit
from app.platform.workflow import custom_ladder, engine, ladder, posts
from app.platform.workflow.models import Instance, Stage, Workflow
from app.platform.workflow.schemas import CustomLadderIn, CustomLadderStepIn
from app.shared.enums import AuditAction, DocType, InstanceStatus

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


# Which permission lets someone RAISE each document. The engine's own map
# (`service.APPROVE_PERMISSION`) answers who signs; this answers who starts, which is
# the other half of "who does what" and the half no screen showed. Codes rather than
# imports of each module's router: a doc type without an entry simply says nothing.
CREATE_PERMISSION = {
    DocType.INDENT.value: "indent.create",
    DocType.ALLOCATION.value: "allocation.create",
    DocType.OWN_STOCK_ALLOCATION.value: "allocation.create",
    DocType.OWN_STOCK_ISSUE.value: "issue.create",
    DocType.FORWARD_ISSUE.value: "issue.create",
    DocType.WH_ISSUE.value: "issue.create",
    DocType.MR.value: "mr.create",
    DocType.REQUISITION.value: "requisition.create",
    DocType.CONSOLIDATION.value: "consolidation.create",
    DocType.RFQ.value: "rfq.create",
    DocType.PO.value: "po.create",
    DocType.GRN.value: "grn.create",
    DocType.DISPATCH.value: "dispatch.create",
    DocType.STOCK_TRANSFER.value: "stock.transfer",
    DocType.STOCK_TRANSFER_REQUEST.value: "stock.transfer.request",
    DocType.STOCK_EDIT.value: "stock.edit.create",
}


# Documents whose chain may differ by the RANK that raised it. An indent is the one
# that genuinely does: a Store Keeper's climbs the whole field line, an RM's has almost
# nobody above it. Every other type has one chain for everybody, and offering a rank
# selector on all of them would be twenty ways to configure something nobody wanted.
RAISER_SCOPED_DOC_TYPES = frozenset({DocType.INDENT.value})


async def _raiser_chains(db: AsyncSession, project_id: int | None,
                         doc_types: set[str]) -> dict[str, list[dict]]:
    """The rank-specific chains saved for this scope: doc type -> [{rank, version}]."""
    if not doc_types:
        return {}
    stmt = select(Workflow).where(
        Workflow.doc_type.in_(doc_types), Workflow.is_active.is_(True),
        Workflow.raiser_role_id.isnot(None))
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    out: dict[str, list[dict]] = {}
    for wf in (await db.execute(stmt.order_by(Workflow.id))).scalars().all():
        out.setdefault(wf.doc_type, []).append({
            "role_id": wf.raiser_role_id,
            "role_name": wf.raiser_role_name or f"Rank {wf.raiser_role_id}",
            "version": wf.version,
        })
    return out


async def _raisers(db: AsyncSession) -> dict[str, list[str]]:
    """Job profiles that may raise each document, by permission. One query for all."""
    rows = (await db.execute(
        select(Permission.code, Role.name)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(Role, Role.id == RolePermission.role_id)
        .where(Permission.code.in_(set(CREATE_PERMISSION.values())),
               Role.is_active.is_(True))
        .order_by(Role.name)
    )).all()
    by_code: dict[str, list[str]] = {}
    for code, name in rows:
        by_code.setdefault(code, []).append(name)
    return by_code


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
    raisers = await _raisers(db)
    raiser_chains = await _raiser_chains(db, project_id, set(RAISER_SCOPED_DOC_TYPES))

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
            "raised_by": raisers.get(CREATE_PERMISSION.get(entry["code"], ""), []),
            "supports_raiser_chains": entry["code"] in RAISER_SCOPED_DOC_TYPES,
            "raiser_chains": raiser_chains.get(entry["code"], []),
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


async def chain(db: AsyncSession, project_id: int | None, doc_type: str,
                raiser_role_id: int | None = None) -> dict:
    """One document type's chain, with everything the editor needs to change it."""
    saved = await custom_ladder.get_custom(db, project_id, doc_type, raiser_role_id)
    if raiser_role_id is not None and saved.get("is_new"):
        # A rank with no chain of its own starts from what its raisers travel TODAY —
        # the default chain — rather than from an empty screen. Loaded as an unsaved
        # draft (`is_new` stays true, no workflow_id), so nothing exists for this rank
        # until the admin saves, and the default is never edited by accident.
        base = await chain(db, project_id, doc_type)
        return {**base, "workflow_id": None, "version": 0, "is_new": True,
                "raiser_role_id": raiser_role_id, "in_flight": 0,
                "inherited_from_default": bool(base.get("steps")),
                "warnings": []}
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
    saved["supports_raiser_chains"] = doc_type in RAISER_SCOPED_DOC_TYPES
    saved["raiser_chains"] = (await _raiser_chains(
        db, project_id, {doc_type} & RAISER_SCOPED_DOC_TYPES)).get(doc_type, [])
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


async def versions(db: AsyncSession, project_id: int | None, doc_type: str,
                   raiser_role_id: int | None = None) -> dict:
    """Every version of this chain, newest first, with what is still riding each one.

    A saved chain is frozen onto the document at submit, so retired versions keep
    governing documents that started under them. Which is exactly the question an admin
    has after editing a chain — "what did I just NOT change?" — and the reason this
    lists in-flight documents per version rather than one total.

    Scoped to one raiser rank's history: the Store Keeper chain and the default one are
    separate chains, and mixing their versions into one list would offer a Restore that
    silently moves a chain from one bucket to the other.
    """
    stmt = select(Workflow).where(Workflow.doc_type == doc_type)
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    stmt = (stmt.where(Workflow.raiser_role_id == raiser_role_id)
            if raiser_role_id is not None
            else stmt.where(Workflow.raiser_role_id.is_(None)))
    rows = list((await db.execute(
        stmt.order_by(Workflow.version.desc(), Workflow.id.desc()))).scalars().all())
    if not rows:
        return {"items": []}

    live = await _in_flight_by_workflow(db, [wf.id for wf in rows])
    authors = await _authors(db, [wf.created_by_id for wf in rows])

    items = []
    for wf in rows:
        stages = await _stages_of(db, wf.id)
        steps = await _step_summaries(db, stages)
        items.append({
            "workflow_id": wf.id,
            "version": wf.version,
            "is_active": bool(wf.is_active),
            "code": wf.code,
            "saved_at": wf.created_at.isoformat() if wf.created_at else None,
            "saved_by": authors.get(wf.created_by_id),
            "summary": _describe(steps),
            # The rungs themselves, not just the one-line summary. A history that only
            # says "Store Keeper -> OE -> ..." truncated to a row width cannot answer
            # the question the admin opened it with — which rung changed — and reading
            # a retired version's steps needs no extra call.
            "steps": steps,
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
            # Echoed so the Move picker can leave out the version the document is
            # already on, rather than the screen inferring it from its own nesting.
            "workflow_id": instance.workflow_id,
            "doc_no": instance.doc_no or f"#{instance.doc_id}",
            "stage": instance.current_stage_name,
            "sequence": instance.current_sequence,
            "started_by": instance.started_by_name,
            "started_at": instance.started_at.isoformat() if instance.started_at else None,
        })
    return out


async def move_document(db: AsyncSession, instance_id: int, workflow_id: int,
                        user, reason: str = "") -> dict:
    """Move one in-flight document onto another version of the chain.

    The freeze that keeps a saved chain from moving documents already in approval is
    the right default (rule 8) and the wrong absolute — a chain saved with a wrong rung
    strands real documents, and the only remedy was to reject and re-raise them. The
    re-resolution, and every guard on it, lives in `engine.move_to_workflow`: approvals
    only ever happen through the engine, and this is the admin's door to it, not a
    second implementation of one.
    """
    instance = await engine.move_to_workflow(db, instance_id, workflow_id, user, reason)
    wf = await db.get(Workflow, workflow_id)
    await write_audit(
        db, entity="wf_instances", entity_id=instance.id,
        entity_no=(instance.doc_no or str(instance.doc_id))[:50],
        action=AuditAction.UPDATE, actor=user,
        after={"workflow_id": workflow_id, "code": wf.code if wf else None,
               "version": wf.version if wf else None, "reason": reason},
        summary=(f"{instance.doc_type} {instance.doc_no or instance.doc_id} moved onto "
                 f"{wf.code if wf else workflow_id} v{wf.version if wf else '?'}"
                 f"{f' — {reason}' if reason else ''}"),
    )
    await db.commit()
    return {
        "instance_id": instance.id,
        "doc_no": instance.doc_no,
        "workflow_id": instance.workflow_id,
        "stage": instance.current_stage_name,
        "sequence": instance.current_sequence,
    }


async def restore(db: AsyncSession, project_id: int | None, doc_type: str,
                  workflow_id: int, user,
                  raiser_role_id: int | None = None) -> dict:
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
    logger.info("Restoring %s v%s for project %s (raiser rank %s) as a new version",
                doc_type, wf.version, project_id, raiser_role_id)
    return await custom_ladder.save_custom(db, CustomLadderIn(
        project_id=project_id, doc_type=doc_type, steps=steps,
        raiser_role_id=raiser_role_id,
        self_approval_policy=policy, fallback_position_id=fallback_position_id,
    ), user)


async def save(db: AsyncSession, data, user) -> dict:
    """Save a chain, refusing a rank-pinned one for a document that has no ranks.

    The guard is here rather than in the writer because the writer is shared with the
    older screens: a rank chain is a concept this screen introduced, and a chain saved
    against a document type the engine never looks up per rank would be configuration
    that is silently never read.
    """
    if (getattr(data, "raiser_role_id", None) is not None
            and data.doc_type not in RAISER_SCOPED_DOC_TYPES):
        raise ValidationError(
            f"{ladder.DOC_TYPE_LABEL.get(data.doc_type, data.doc_type)} uses one chain "
            f"for every raiser")
    return await custom_ladder.save_custom(db, data, user)


async def copy_flow(db: AsyncSession, data, user) -> dict:
    """Save one chain onto other projects, other raiser ranks, or both.

    The same chain is usually wanted for every region, and building it a dozen times by
    hand is how they drift apart. Copied step for step, including the self-approval
    policy: unlike the rank ladder's copy (which matches by level because positions are
    per-project), a step here is already portable — a RANK and a locally-owned post mean
    the same thing everywhere, and an HCM post is a named chair the admin picked
    deliberately, so it is carried across rather than silently dropped.

    Copying ACROSS RANKS is different in one way, and it is the reason this exists: a
    chain built for a Store Keeper contains rungs the OE is already above. Carrying
    "climb to OE" into the OE's own chain would ask an OE to be approved by an OE. So
    every rank step at or below the target rank is dropped (`drop_steps_at_or_below`),
    which is exactly the edit an admin would make by hand after copying.

    Each target is an ordinary save, so it lands as a new version with its own history
    and retires only that target's live chain. Documents already in approval anywhere
    are frozen onto theirs and never move.
    """
    source = await chain(db, data.from_project_id, data.doc_type,
                         getattr(data, "from_raiser_role_id", None))
    if not source.get("steps") and source.get("self_approval_policy") != ladder.POLICY_NONE:
        raise NotFoundError("Save this chain before copying it")

    def _steps(drop_at_or_below_depth: int | None,
               depths: dict[int, int]) -> list[CustomLadderStepIn]:
        out = []
        for step in source["steps"]:
            role_id = step["position_role_id"]
            # Only RANK steps are dropped. A named chair — the SCM Head, the Indent
            # Team — is not part of the reporting line and signs whoever raised it.
            if (drop_at_or_below_depth is not None and role_id is not None
                    and depths.get(role_id, -1) >= drop_at_or_below_depth):
                continue
            out.append(CustomLadderStepIn(
                name=step["name"], position_id=step["position_id"],
                post_id=step["post_id"], position_role_id=role_id,
            ))
        return out

    async def _save(project_id: int | None, raiser_role_id: int | None,
                    steps: list[CustomLadderStepIn]) -> None:
        await custom_ladder.save_custom(db, CustomLadderIn(
            project_id=project_id, doc_type=data.doc_type,
            raiser_role_id=raiser_role_id, steps=steps,
            self_approval_policy=source["self_approval_policy"],
            fallback_position_id=source.get("fallback_position_id"),
        ), user)

    copied_projects: list[int] = []
    for project_id in data.to_project_ids:
        # Copying onto the source is a no-op that would still burn a version number.
        if project_id == data.from_project_id:
            continue
        await _save(project_id, getattr(data, "from_raiser_role_id", None),
                    _steps(None, {}))
        copied_projects.append(project_id)

    copied_ranks: list[int] = []
    target_ranks = list(getattr(data, "to_raiser_role_ids", []) or [])
    if target_ranks:
        # A rank's DEPTH is how the tree orders them — smaller is higher. Read once
        # for the project the copy is being made within.
        depths = {rank["role_id"]: rank["depth"]
                  for rank in await ladder.project_ranks(db, data.from_project_id)}
        drop = getattr(data, "drop_steps_at_or_below", True)
        for role_id in target_ranks:
            if role_id == getattr(data, "from_raiser_role_id", None):
                continue
            target_depth = depths.get(role_id) if drop else None
            await _save(data.from_project_id, role_id, _steps(target_depth, depths))
            copied_ranks.append(role_id)

    logger.info("Copied the %s chain from project %s / rank %s onto projects %s "
                "and ranks %s", data.doc_type, data.from_project_id,
                getattr(data, "from_raiser_role_id", None), copied_projects,
                copied_ranks)
    return {"copied_to": copied_projects, "copied_to_ranks": copied_ranks}


async def rungs(db: AsyncSession, project_id: int | None, search: str = "") -> dict:
    """Everything an admin may put on a chain, in one list, grouped by kind.

    One list rather than three tabs: the admin is choosing a chair, and whether that
    chair happens to exist in HCM is our problem, not theirs.
    """
    local = (await posts.list_posts(db))["items"]
    ranks = await ladder.project_ranks(db, project_id)
    # The shared chairs HCM has since created — SCM HEAD, INDENT TEAM, P O, CPO,
    # DIRECTOR — every one of them seated out of the SUPPLY CHAIN MANAGEMENT and H O
    # projects. They are ranks like any other, but they are not on a field raiser's
    # reporting line, so they are listed apart and saved as ROLE_ANY: read straight off
    # their holders instead of climbed to. Listing them beside the climbable ranks is
    # what would put a rung on a chain that resolves to nobody.
    shared = await ladder.company_ranks(db, project_id)

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

    # A rank nobody fills cannot approve anything: `resolve_chain` skips a rung whose
    # ancestor has no holder, so putting one on a chain silently shortens it. The live
    # mirror is full of them — the HCM cutover left the old generation of role ids in
    # place beside the new one, so "District Manager" appears twice (27 posts, and a
    # leftover with one), "Store Keeper" appears beside "STOREKEEPER" with nobody in
    # it, and the same for Driver and Inventory Manager. An admin picking the wrong
    # one of a matched pair built a chain that could never resolve.
    #
    # Filtered, not flagged: there is no reason to offer a chair with nobody in it, and
    # the empty twin is exactly the one that reads as correct in the dropdown.
    climbable = [rank for rank in ranks if rank.get("holder_count")]

    return {
        "local": [{"id": row["id"], "name": row["name"],
                   "department": row["department"],
                   "members": row["members"]} for row in local],
        # `depth` is how the tree orders ranks — smaller is higher up. Sent so the
        # "when raised by" picker can list them top-down and so a copy across ranks
        # knows which steps the target is already above.
        "ranks": [{"id": rank["role_id"], "name": rank["role_name"],
                   "position_count": rank.get("position_count", 0),
                   "people_count": rank.get("holder_count", 0),
                   "depth": rank.get("depth", 0)} for rank in climbable],
        # Same shape, different bucket. `people` is who would actually sign, which the
        # admin needs to see: these rungs name a chair rather than a step up the line.
        "shared_ranks": [{"id": rank["role_id"], "name": rank["role_name"],
                          "position_count": rank.get("position_count", 0),
                          "people_count": rank.get("holder_count", 0),
                          "people": [p["name"] for p in rank.get("holders", [])]}
                         for rank in shared],
        "hcm": hcm,
    }
