"""The Approvals Config screen's service: read, preview, save and copy ladders.

Kept apart from ladder.py, which the engine calls at submit time. This file is only
reached by an admin editing configuration and never by a document being approved.

Saving never edits a live ladder. It deactivates the current version and writes
version N+1, so the documents already climbing the old one finish on the ladder they
started with.
"""
import logging
from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.settings.service import write_audit
from app.platform.workflow import ladder
from app.platform.workflow.models import Instance, StageCondition, Workflow
from app.platform.workflow.schemas import LadderCopyIn, LadderIn
from app.shared.enums import AuditAction, DocType, InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)


async def options(db: AsyncSession) -> dict:
    """Everything the two dropdowns need, in one call."""
    return {
        "projects": await ladder.list_projects(db),
        "doc_types": await ladder.list_doc_types(),
        "module_order": ladder.MODULE_ORDER,
    }


async def _conditions_by_stage(db: AsyncSession,
                               stage_ids: list[int]) -> dict[int, list[StageCondition]]:
    """Every rung's conditions in one query. A ladder's rungs each carry both their
    real conditions and one row per eligible position, and fetching that per rung meant
    two round trips a rung — cheap on the seed, not on a live project."""
    if not stage_ids:
        return {}
    rows = (await db.execute(
        select(StageCondition).where(StageCondition.stage_id.in_(stage_ids))
    )).scalars().all()
    out: dict[int, list[StageCondition]] = {}
    for row in rows:
        out.setdefault(row.stage_id, []).append(row)
    return out


def _conditions_out(rows: list[StageCondition]) -> list[dict]:
    return [{"field_name": r.field_name, "operator": r.operator,
             "field_value": r.field_value, "logic": r.logic} for r in rows
            if r.field_name not in ladder.INTERNAL_FIELDS]


def _selected_positions_out(rows: list[StageCondition]) -> list[int] | None:
    """The posts an admin narrowed this rung to, or None for the whole rank.

    None is not "nothing selected": it is the default, and it means any post at the
    rank. Filling it in for the caller is what used to hide an ancestor the project's
    own people do not hold.
    """
    configured = any(
        row.field_name == ladder.APPROVER_SCOPE_FIELD for row in rows
    )
    if not configured:
        return None
    return [
        int(row.field_value) for row in rows
        if row.field_name == ladder.APPROVER_POSITION_FIELD
    ]


async def shared_holder_warnings(db: AsyncSession, project_id: int | None,
                                 role_ids: list[int]) -> list[str]:
    """One line per person who fills more than one of the switched-on rungs.

    Two rungs held by the same employee are one approver, not two — the chain collapses
    them at submit (ladder.dedupe_chain). Saying so on the config screen stops an admin
    building a "two-step" ladder that was only ever going to be one step.
    """
    if len(role_ids) < 2:
        return []
    holders_of = await ladder._rank_holders(db, project_id)
    names = {role_id: rank["role_name"]
             for role_id, rank in (await ladder.project_rank_summary(
                 db, project_id)).items()}

    rungs_of: dict[int, tuple[str, list[str]]] = {}
    for role_id in role_ids:
        for holder in holders_of.get(role_id, []):
            entry = rungs_of.setdefault(holder["id"], (holder["name"], []))
            entry[1].append(names.get(role_id) or f"Rank {role_id}")
    return [f"{name} holds {len(rungs)} of the switched-on ranks "
            f"({', '.join(rungs)}) — they count as ONE approver."
            for name, rungs in rungs_of.values() if len(rungs) > 1]


async def ranks(db: AsyncSession, project_id: int | None) -> dict:
    """The project's ranks with their holders — read on its own, keyed on the project.

    Split out of get_ladder because ranks do not depend on the document type: switching
    the Document dropdown used to re-derive all of this for an identical answer.
    """
    return {"ranks": await ladder.project_ranks(db, project_id)}


async def rank_positions(db: AsyncSession, project_id: int | None,
                         role_id: int) -> dict:
    """One rank's posts — fetched when the admin opens that rung, not before."""
    return {"positions": await ladder.rank_positions(db, project_id, role_id)}


async def get_ladder(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """The saved ladder for this project and document, or a draft built from the
    ranks the project's own people hold, with everything switched on.

    Deliberately narrow: rungs, their toggles and their counts. The holders' NAMES come
    from ranks() and a rung's positions from rank_positions(), because both are keyed on
    the project alone and would otherwise be re-read on every document switch.
    """
    _validate_doc_type(doc_type)

    # This scope's own ladder — never another project's, never a plain workflow, so a
    # leftover non-ladder workflow for the same doc type cannot make a saved ladder
    # look like it was never saved (see ladder.active_ladder). Its rungs come back with
    # it; re-reading them here was three fetches of the same rows.
    found = await ladder.active_ladder(db, project_id, doc_type)
    # A hand-built ladder lives on the same scope but names posts, not ranks. Rendering
    # its stages here would draw rungs with no rank at all, so this screen shows the
    # rank draft and flags that the custom one is what actually runs.
    if found is None or ladder.is_custom_ladder(found[0]):
        draft = await ladder.autobuild(db, project_id, doc_type)
        draft["in_flight"] = 0
        draft["rungs"] = draft.pop("stages")
        draft["has_custom"] = found is not None
        draft["self_approval_policy"] = ladder.POLICY_INDEPENDENT
        draft["fallback_position_id"] = None
        draft["warnings"] = []
        return draft

    wf, rows = found
    # Counts, not rows: seventeen grouped results instead of 3,400 positions.
    summary = await ladder.project_rank_summary(db, project_id)
    conditions_by_stage = await _conditions_by_stage(db, [row.id for row in rows])

    known = {row.position_role_id for row in rows}
    added = sorted(
        (rank for role_id, rank in summary.items() if role_id not in known),
        key=lambda rank: rank["role_name"] or "",
    )

    rungs = []
    for row in rows:
        rank = summary.get(row.position_role_id, {})
        stored = conditions_by_stage.get(row.id, [])
        rungs.append({
            "sequence": row.sequence,
            "name": row.name,
            "position_role_id": row.position_role_id,
            "is_enabled": row.is_enabled,
            "position_count": rank.get("position_count", 0),
            "holder_count": rank.get("holder_count", 0),
            "selected_position_ids": _selected_positions_out(stored),
            # A rung nobody in this project fills any more: HCM removed or renamed the
            # positions under it. Flagged rather than silently skipped.
            "is_dead": not rank.get("holder_count"),
            "conditions": _conditions_out(stored),
        })

    # Ranks HCM added since this ladder was saved. Offered switched off, so a new rank
    # never starts approving documents on its own.
    for rank in added:
        rungs.append({
            "sequence": len(rungs) + 1,
            "name": rank["role_name"],
            "position_role_id": rank["role_id"],
            "is_enabled": False,
            "position_count": rank["position_count"],
            "holder_count": rank["holder_count"],
            "selected_position_ids": None,
            "is_dead": not rank["holder_count"],
            "is_new_rank": True,
            "conditions": [],
        })

    in_flight = (await db.execute(
        select(func.count(Instance.id)).where(
            Instance.workflow_id == wf.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).scalar() or 0

    policy, fallback_position_id = await ladder.read_policy(db, rows)
    return {
        "workflow_id": wf.id,
        "version": wf.version,
        "project_id": project_id,
        "doc_type": doc_type,
        "module": wf.module or ladder.MODULE_BY_DOC_TYPE.get(doc_type, "Other"),
        "is_new": False,
        "has_custom": False,
        "rungs": rungs,
        "in_flight": in_flight,
        "self_approval_policy": policy,
        "fallback_position_id": fallback_position_id,
        "warnings": await shared_holder_warnings(
            db, project_id, [r["position_role_id"] for r in rungs if r["is_enabled"]]),
    }


async def preview(db: AsyncSession, project_id: int | None, doc_type: str,
                  rungs: list[dict], from_role_id: int | None,
                  policy: str = ladder.POLICY_INDEPENDENT,
                  fallback_position_id: int | None = None) -> dict:
    """Who would approve, if someone at this rank raised this document right now.

    Runs against the rungs currently on screen, saved or not, so an admin sees the
    outcome of a toggle before committing to it. This is the whole point of the
    screen — nobody should have to reason about parent chains in their head.
    """
    _validate_doc_type(doc_type)
    if from_role_id is None:
        return {"from": None, "chain": [], "note": "Pick a starting rank."}

    position, holder_id = await _sample_position(db, project_id, from_role_id)
    if position is None:
        return {"from": None, "chain": [],
                "note": "Nobody in this project holds this rank."}

    draft = [SimpleNamespace(id=None, position_role_id=r["position_role_id"],
                             is_enabled=r.get("is_enabled", True),
                             selected_position_ids=r.get("selected_position_ids"),
                             self_approval_policy=policy,
                             fallback_position_id=fallback_position_id,
                             conditions=[])
             for r in rungs]
    chain = await ladder.resolve_chain(db, draft, position.id, holder_id, {}, policy)
    # Shown exactly as it would run: if the ladder demands an independent approver and
    # the climb reached only the raiser, the nominated post is where it really goes.
    used_fallback = False
    if not chain and policy == ladder.POLICY_INDEPENDENT:
        chain = await ladder.fallback_chain(db, fallback_position_id, holder_id)
        used_fallback = bool(chain)
    return {
        "from": {"position_id": position.id, "position_name": position.name},
        "chain": [{"role_name": c["role_name"], "position_name": c["position_name"],
                   "approver_names": c["approver_names"]} for c in chain],
        "self_approved": not chain,
        "used_fallback": used_fallback,
    }


async def _sample_position(db: AsyncSession, project_id: int | None,
                           role_id: int) -> tuple[HcmPosition | None, int | None]:
    """One real position at this rank, held by one of this project's people.

    A real holder rather than any position at the rank: the climb starts from where
    somebody actually sits, so the preview shows the chain a real request would take.
    """
    stmt = (select(HcmPosition, HcmPositionAssignment.employee_id)
            .join(HcmPositionAssignment,
                  HcmPositionAssignment.position_id == HcmPosition.id)
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPosition.role_id == role_id,
                   HcmPosition.is_active.is_(True),
                   HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True)))
    if project_id is not None:
        stmt = stmt.where(HcmEmployee.project_id == project_id)
    row = (await db.execute(stmt.order_by(HcmPosition.id).limit(1))).first()
    if row is None:
        return None, None
    return row[0], row[1]


async def save_ladder(db: AsyncSession, data: LadderIn, user) -> dict:
    """Write version N+1 and retire version N. Never edits rows in place."""
    _validate_doc_type(data.doc_type)
    if not data.rungs:
        raise ValidationError("A ladder needs at least one rank")
    if not any(
        (rung.is_enabled or rung.conditions)
        and rung.selected_position_ids != []
        for rung in data.rungs
    ):
        raise ValidationError(
            "Switch on at least one rank with an eligible position, "
            "or nothing would ever be approved")

    available = await ladder.project_position_ids(
        db, data.project_id, {rung.position_role_id for rung in data.rungs})
    for rung in data.rungs:
        if rung.selected_position_ids is None:
            continue
        allowed = set(available.get(rung.position_role_id, []))
        if not set(rung.selected_position_ids).issubset(allowed):
            raise ValidationError(
                f"One or more positions do not belong to {rung.name} in this project"
            )

    project_name = None
    if data.project_id is not None:
        employee = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.project_id == data.project_id).limit(1)
        )).scalars().first()
        project_name = employee.project_name if employee else None

    previous = list((await db.execute(
        select(Workflow).where(
            Workflow.doc_type == data.doc_type,
            (Workflow.project_id == data.project_id if data.project_id is not None
             else Workflow.project_id.is_(None)),
            Workflow.is_active.is_(True),
        ).order_by(Workflow.version.desc(), Workflow.id.desc())
    )).scalars().all())
    version = max([w.version for w in previous], default=0) + 1
    for row in previous:
        # Retired, not deleted: its running documents still resolve their history
        # against it, and wf_actions must stay readable forever.
        row.is_active = False
        row.effective_to = utcnow().date()

    policy = (data.self_approval_policy
              if data.self_approval_policy in ladder.POLICIES
              else ladder.POLICY_INDEPENDENT)

    wf = ladder.new_workflow(data.project_id, project_name, data.doc_type, version)
    db.add(wf)
    await db.flush()

    for index, rung in enumerate(data.rungs):
        stage = ladder.new_stage(wf.id, index + 1, rung.name,
                                 rung.position_role_id, rung.is_enabled)
        db.add(stage)
        await db.flush()
        if index == 0:
            # The policy belongs to the LADDER, so it is written once, on its first
            # rung. read_policy() stops at the first rung carrying these markers.
            db.add(StageCondition(
                stage_id=stage.id, field_name=ladder.POLICY_FIELD,
                operator="EQ", field_value=policy, logic="AND"))
            if data.fallback_position_id:
                db.add(StageCondition(
                    stage_id=stage.id, field_name=ladder.FALLBACK_POSITION_FIELD,
                    operator="EQ", field_value=str(data.fallback_position_id),
                    logic="AND"))
        for condition in rung.conditions:
            db.add(StageCondition(
                stage_id=stage.id, field_name=condition.field_name,
                operator=condition.operator, field_value=condition.field_value,
                logic=condition.logic,
            ))
        if rung.selected_position_ids is not None:
            db.add(StageCondition(
                stage_id=stage.id,
                field_name=ladder.APPROVER_SCOPE_FIELD,
                operator="EQ",
                field_value="1",
                logic="AND",
            ))
            for position_id in sorted(set(rung.selected_position_ids)):
                db.add(StageCondition(
                    stage_id=stage.id,
                    field_name=ladder.APPROVER_POSITION_FIELD,
                    operator="EQ",
                    field_value=str(position_id),
                    logic="AND",
                ))
    await db.flush()

    enabled = [r.name for r in data.rungs if r.is_enabled]
    await write_audit(
        db, entity="wf_workflows", entity_id=wf.id, entity_no=wf.code[:50],
        action=AuditAction.CREATE, actor=user,
        after={"version": version, "project_id": data.project_id,
               "doc_type": data.doc_type, "enabled_ranks": enabled,
               "self_approval_policy": policy,
               "fallback_position_id": data.fallback_position_id},
        summary=f"Approval ladder v{version} saved ({', '.join(enabled) or 'none'})",
    )
    await db.commit()
    logger.info("Approval ladder %s saved as version %s by %s",
                wf.code, version, getattr(user, "full_name", user))

    saved = await get_ladder(db, data.project_id, data.doc_type)
    saved["warnings"] = [*await _unreachable_warnings(db, data, wf.code, version),
                         *saved.get("warnings", [])]
    return saved


async def _unreachable_warnings(db: AsyncSession, data: LadderIn, code: str,
                                version: int) -> list[str]:
    """Rungs that were saved against ranks no reporting line can reach.

    Computed AFTER the commit, and never allowed to fail the request: the ladder is
    already durably version N+1 by this point. An admin configuring a project before
    its HCM data lands must be able to save a ladder that resolves to nobody today —
    this only says so out loud, on the screen and in the log, the same way the
    fallback path already announces itself.
    """
    try:
        warnings = await ladder.unreachable_rung_warnings(
            db, data.project_id, data.rungs)
    except Exception:  # noqa: BLE001 - a warning must never undo a saved ladder
        logger.exception("Could not check ladder %s v%s for unreachable rungs",
                         code, version)
        return []
    for line in warnings:
        logger.warning("Approval ladder %s v%s has an unreachable rung: %s",
                       code, version, line)
    return warnings


async def copy_ladder(db: AsyncSession, data: LadderCopyIn, user) -> dict:
    """Copy one project's ladder onto others, matched by rank.

    Ranks are shared across projects; positions are not. A rank nobody in the target
    project holds is dropped rather than carried across as a rung nobody can fill.
    """
    source = await get_ladder(db, data.from_project_id, data.doc_type)
    if source["is_new"]:
        raise NotFoundError("Save this ladder before copying it")
    enabled = {r["position_role_id"] for r in source["rungs"] if r["is_enabled"]}

    copied = []
    for project_id in data.to_project_ids:
        if project_id == data.from_project_id:
            continue
        ranks = await ladder.project_ranks(db, project_id)
        if not ranks:
            continue
        rungs = ladder.build_stages(ranks, enabled)
        await save_ladder(db, LadderIn(
            project_id=project_id, doc_type=data.doc_type,
            # The policy travels with the ladder; the fallback POST does not — it is a
            # real position in the source project and means nothing in the target.
            self_approval_policy=source.get("self_approval_policy"),
            rungs=[{"position_role_id": r["position_role_id"], "name": r["name"],
                    "is_enabled": r["is_enabled"],
                    "selected_position_ids": r["selected_position_ids"],
                    "conditions": []} for r in rungs],
        ), user)
        copied.append(project_id)
    return {"copied_to": copied}


async def stale_instances(db: AsyncSession) -> dict:
    """Documents still in approval that are climbing a ladder since replaced.

    This is correct behaviour, not a fault: `resolved_chain` is frozen at submit so an
    edit never moves a document already in flight. But it is invisible, and "I fixed
    the ladder, why is it still going to the old person" is the question it answers.

    Superseded is read straight off `is_active`: saving writes version N+1 and retires
    N, so an in-flight instance whose workflow row is inactive is by definition on an
    old version. No snapshot column is needed, and none exists.
    """
    current = (
        select(Workflow.code, func.max(Workflow.version).label("live_version"))
        .where(Workflow.is_active.is_(True))
        .group_by(Workflow.code)
        .subquery()
    )
    rows = (await db.execute(
        select(
            Instance.id, Instance.doc_type, Instance.doc_no, Instance.doc_id,
            Instance.started_by_name, Instance.started_at,
            Instance.current_stage_name, Instance.current_sequence,
            Workflow.code, Workflow.version, Workflow.project_name,
            current.c.live_version,
        )
        .join(Workflow, Workflow.id == Instance.workflow_id)
        .join(current, current.c.code == Workflow.code)
        .where(
            Instance.status == InstanceStatus.IN_PROGRESS.value,
            Workflow.is_active.is_(False),
        )
        .order_by(Instance.started_at)
    )).all()

    items = [{
        "instance_id": r.id,
        "doc_type": r.doc_type,
        "doc_no": r.doc_no,
        "doc_id": r.doc_id,
        "raised_by": r.started_by_name,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "stage_name": r.current_stage_name,
        "stage_sequence": r.current_sequence,
        "ladder_code": r.code,
        "project_name": r.project_name,
        "running_version": r.version,
        "live_version": r.live_version,
        "versions_behind": max(0, (r.live_version or 0) - (r.version or 0)),
    } for r in rows]
    return {"items": items, "total": len(items)}


def _validate_doc_type(doc_type: str) -> None:
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(f"Unknown document type {doc_type!r}")
