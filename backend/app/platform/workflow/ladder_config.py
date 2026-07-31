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
            if r.field_name not in {ladder.APPROVER_SCOPE_FIELD,
                                    ladder.APPROVER_POSITION_FIELD}]


def _selected_positions_out(rows: list[StageCondition],
                            default_position_ids: list[int]) -> list[int]:
    configured = any(
        row.field_name == ladder.APPROVER_SCOPE_FIELD for row in rows
    )
    if not configured:
        return default_position_ids
    return [
        int(row.field_value) for row in rows
        if row.field_name == ladder.APPROVER_POSITION_FIELD
    ]


async def get_ladder(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """The saved ladder for this project and document, or a draft built from the
    ranks the project's own people hold, with everything switched on."""
    _validate_doc_type(doc_type)
    ranks = await ladder.project_ranks(db, project_id)
    by_role = {rank["role_id"]: rank for rank in ranks}

    # This scope's own ladder — never another project's, never a plain workflow, so a
    # leftover non-ladder workflow for the same doc type cannot make a saved ladder
    # look like it was never saved (see ladder.active_ladder). Its rungs come back with
    # it; re-reading them here was three fetches of the same rows.
    found = await ladder.active_ladder(db, project_id, doc_type)
    if found is None:
        draft = await ladder.autobuild(db, project_id, doc_type)
        draft["in_flight"] = 0
        draft["rungs"] = draft.pop("stages")
        for rung in draft["rungs"]:
            rank = by_role.get(rung["position_role_id"], {})
            rung["holders"] = rank.get("holders", [])
            rung["holder_count"] = rank.get("holder_count", 0)
            rung["positions"] = rank.get("positions", [])
            rung["is_dead"] = not rank.get("holders")
        return draft

    wf, rows = found
    conditions_by_stage = await _conditions_by_stage(db, [row.id for row in rows])
    rungs = []
    for row in rows:
        rank = by_role.get(row.position_role_id, {})
        position_ids = [position["id"] for position in rank.get("positions", [])]
        stored = conditions_by_stage.get(row.id, [])
        rungs.append({
            "sequence": row.sequence,
            "name": row.name,
            "position_role_id": row.position_role_id,
            "is_enabled": row.is_enabled,
            "holders": rank.get("holders", []),
            "holder_count": rank.get("holder_count", 0),
            "positions": rank.get("positions", []),
            "selected_position_ids": _selected_positions_out(stored, position_ids),
            # A rung nobody in this project fills any more: HCM removed or renamed the
            # positions under it. Flagged rather than silently skipped.
            "is_dead": not rank.get("holders"),
            "conditions": _conditions_out(stored),
        })

    # Ranks HCM added since this ladder was saved. Offered switched off, so a new rank
    # never starts approving documents on its own.
    known = {row.position_role_id for row in rows}
    for rank in ranks:
        if rank["role_id"] not in known:
            rungs.append({
                "sequence": len(rungs) + 1,
                "name": rank["role_name"],
                "position_role_id": rank["role_id"],
                "is_enabled": False,
                "holders": rank["holders"],
                "holder_count": rank["holder_count"],
                "positions": rank.get("positions", []),
                "selected_position_ids": [
                    position["id"] for position in rank.get("positions", [])
                ],
                "is_dead": False,
                "is_new_rank": True,
                "conditions": [],
            })

    in_flight = (await db.execute(
        select(func.count(Instance.id)).where(
            Instance.workflow_id == wf.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).scalar() or 0

    return {
        "workflow_id": wf.id,
        "version": wf.version,
        "project_id": project_id,
        "doc_type": doc_type,
        "module": wf.module or ladder.MODULE_BY_DOC_TYPE.get(doc_type, "Other"),
        "is_new": False,
        "ranks": ranks,
        "rungs": rungs,
        "in_flight": in_flight,
    }


async def preview(db: AsyncSession, project_id: int | None, doc_type: str,
                  rungs: list[dict], from_role_id: int | None) -> dict:
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
                             conditions=[])
             for r in rungs]
    chain = await ladder.resolve_chain(db, draft, position.id, holder_id, {})
    return {
        "from": {"position_id": position.id, "position_name": position.name},
        "chain": [{"role_name": c["role_name"], "position_name": c["position_name"],
                   "approver_names": c["approver_names"]} for c in chain],
        "self_approved": not chain,
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

    available_ranks = {
        rank["role_id"]: rank
        for rank in await ladder.project_ranks(db, data.project_id)
    }
    for rung in data.rungs:
        if rung.selected_position_ids is None:
            continue
        allowed = {
            position["id"]
            for position in available_ranks.get(
                rung.position_role_id, {},
            ).get("positions", [])
        }
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

    wf = ladder.new_workflow(data.project_id, project_name, data.doc_type, version)
    db.add(wf)
    await db.flush()

    for index, rung in enumerate(data.rungs):
        stage = ladder.new_stage(wf.id, index + 1, rung.name,
                                 rung.position_role_id, rung.is_enabled)
        db.add(stage)
        await db.flush()
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
               "doc_type": data.doc_type, "enabled_ranks": enabled},
        summary=f"Approval ladder v{version} saved ({', '.join(enabled) or 'none'})",
    )
    await db.commit()
    logger.info("Approval ladder %s saved as version %s by %s",
                wf.code, version, getattr(user, "full_name", user))
    return await get_ladder(db, data.project_id, data.doc_type)


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
            rungs=[{"position_role_id": r["position_role_id"], "name": r["name"],
                    "is_enabled": r["is_enabled"],
                    "selected_position_ids": r["selected_position_ids"],
                    "conditions": []} for r in rungs],
        ), user)
        copied.append(project_id)
    return {"copied_to": copied}


def _validate_doc_type(doc_type: str) -> None:
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(f"Unknown document type {doc_type!r}")
