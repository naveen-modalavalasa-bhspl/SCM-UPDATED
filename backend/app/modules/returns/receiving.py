"""The receiving desk's approval ladder — configured from inside Returns.

Who checks a return once its reporting line has signed cannot be derived from data.
It was looked for:

  * `inv_position_locations` holds 2,009 rows and not one of them maps the INVENTORY
    MANAGER or the Head SCM post to a stocking point;
  * `whs_warehouses.incharge_id` is NULL on every real point (one seed row aside);
  * both posts sit on `parent_position_id = NULL`, so no climb from a LIP reaches them
    (see `platform/workflow/custom_ladder.py`).

So it is a decision somebody has to record, and this is where they record it: an
ordered list of POSTS, saved by an admin on the Returns screen. Not names in code —
rule 13 — and not a row somebody inserts by hand into the database.

What gets written is exactly what `platform/workflow/custom_ladder.save_custom` would
write: a `CUSTOM-…` workflow whose stages name posts. That is deliberate — the engine
already recognises that shape (`ladder.active_ladder` -> `is_custom_ladder` ->
`resolve_fixed_chain`), so submitting goes through the ordinary public `engine.start`
and no approval logic lives in this module. `save_custom` itself cannot be called: it
validates the doc type against `shared.enums.DocType`, and STOCK_RETURN_RECEIPT is this
module's own doc type, not a shared one.

Company-wide only (`project_id = NULL`). The inventory desk and the warehouse serve
every project — HCM tags those people with no project at all — so a per-project copy
would be the same two posts written N times.
"""
import logging

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.settings.service import write_audit
from app.platform.workflow import custom_ladder, ladder
from app.platform.workflow.models import Instance, Stage, StageCondition, Workflow
from app.shared.enums import ApprovalMode, ApproverType, AuditAction, InstanceStatus
from app.shared.models.base import utcnow

from .enums import ReturnDocType

logger = logging.getLogger(__name__)

DOC_TYPE = ReturnDocType.STOCK_RETURN_RECEIPT.value
# Scope: one company-wide ladder. See the module docstring.
PROJECT_ID = None
AUDIT_ENTITY = "wf_workflows"
# How many posts a picker may offer at once. A search that returns three thousand rows
# is not a picker.
SEARCH_LIMIT = 40


async def _holders(db: AsyncSession, position_ids: list[int]) -> dict[int, list[dict]]:
    """post -> the people sitting in it. One query for the whole list."""
    if not position_ids:
        return {}
    rows = (await db.execute(
        select(HcmPositionAssignment.position_id, HcmEmployee.id,
               HcmEmployee.full_name, HcmEmployee.emp_code)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.position_id.in_(position_ids),
               HcmPositionAssignment.is_active.is_(True),
               HcmEmployee.is_active.is_(True))
    )).all()
    out: dict[int, list[dict]] = {}
    for position_id, employee_id, full_name, emp_code in rows:
        people = out.setdefault(position_id, [])
        # Someone can hold a post twice in the mirror; they are one approver.
        if not any(person["id"] == employee_id for person in people):
            people.append({"id": employee_id, "name": full_name, "code": emp_code})
    return out


async def _active(db: AsyncSession) -> Workflow | None:
    return (await db.execute(
        select(Workflow).where(
            Workflow.doc_type == DOC_TYPE,
            Workflow.project_id.is_(None),
            Workflow.is_active.is_(True),
        ).order_by(Workflow.version.desc(), Workflow.id.desc())
    )).scalars().first()


async def get_config(db: AsyncSession) -> dict:
    """What is configured today, with who currently fills each step."""
    wf = await _active(db)
    if wf is None:
        return {"version": 0, "is_configured": False, "in_flight": 0, "steps": [],
                "warnings": []}

    stages = list((await db.execute(
        select(Stage).where(Stage.workflow_id == wf.id).order_by(Stage.sequence)
    )).scalars().all())
    post_ids = [s.position_id for s in stages if s.position_id]
    holders = await _holders(db, post_ids)
    in_flight = len(list((await db.execute(
        select(Instance.id).where(
            Instance.workflow_id == wf.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value)
    )).scalars().all()))

    steps = [{
        "sequence": stage.sequence,
        "position_id": stage.position_id,
        "name": stage.name,
        "holders": holders.get(stage.position_id, []),
        # Nobody in the chair: the engine skips such a step rather than stranding the
        # return, but whoever configured it should be told.
        "is_dead": not holders.get(stage.position_id),
    } for stage in stages if stage.position_id]

    empty = [step["name"] for step in steps if step["is_dead"]]
    warnings = []
    if empty:
        warnings.append(
            f"{len(empty)} step{'s' if len(empty) > 1 else ''} ({', '.join(empty)}) "
            f"{'have' if len(empty) > 1 else 'has'} nobody in the chair and will be "
            "skipped when a return reaches it.")
    if not steps:
        warnings.append("No step has a post, so returns will settle on the reporting "
                        "line's approval alone.")
    return {"version": wf.version, "is_configured": bool(steps),
            "in_flight": in_flight, "steps": steps, "warnings": warnings}


async def decision_desk(db: AsyncSession) -> dict | None:
    """The FIRST rung of the receiving ladder — the inventory desk that decides.

    Resolved without starting a workflow, because the decision comes before the
    endorsement chain exists: a return that has cleared its reporting line has to appear
    on the inventory manager's queue immediately, and the engine instance is only opened
    once he records a decision (`service.decide`). Asking the engine who is next would
    mean starting a chain and then asking its first rung to "approve" something nobody had
    decided yet.

    Rungs two and upward are the endorsers; the engine resolves those itself, in order,
    the ordinary way.
    """
    wf = await _active(db)
    if wf is None:
        return None
    stage = (await db.execute(
        select(Stage).where(Stage.workflow_id == wf.id, Stage.position_id.isnot(None))
        .order_by(Stage.sequence)
    )).scalars().first()
    if stage is None:
        return None
    holders = (await _holders(db, [stage.position_id])).get(stage.position_id, [])
    return {
        "position_id": stage.position_id,
        "name": stage.name,
        "holders": holders,
        # Whether anybody stands behind the decider. With nobody there the decision is
        # the last word and is carried out the moment it is recorded.
        "has_endorsers": await db.scalar(
            select(Stage.id).where(Stage.workflow_id == wf.id,
                                   Stage.position_id.isnot(None),
                                   Stage.sequence > stage.sequence).limit(1)
        ) is not None,
    }


async def search_positions(db: AsyncSession, term: str | None) -> list[dict]:
    """Posts to choose from, matched on the post's own name, its rank or its holder.

    Searched rather than listed: the mirror holds 3,700 posts, and the two this screen
    exists for are found by typing "inventory" or "scm".
    """
    text = (term or "").strip()
    if len(text) < 2:
        return []
    like = f"%{text}%"
    stmt = (select(HcmPosition.id, HcmPosition.name, HcmPosition.role_name,
                   HcmPosition.job_name)
            .where(HcmPosition.is_active.is_(True))
            .where(or_(
                HcmPosition.name.ilike(like),
                HcmPosition.role_name.ilike(like),
                HcmPosition.job_name.ilike(like),
                HcmPosition.id.in_(
                    select(HcmPositionAssignment.position_id)
                    .join(HcmEmployee,
                          HcmEmployee.id == HcmPositionAssignment.employee_id)
                    .where(HcmPositionAssignment.is_active.is_(True),
                           or_(HcmEmployee.full_name.ilike(like),
                               HcmEmployee.emp_code.ilike(like)))),
            ))
            .order_by(HcmPosition.name)
            .limit(SEARCH_LIMIT))
    rows = list((await db.execute(stmt)).all())
    holders = await _holders(db, [row.id for row in rows])
    return [{
        "id": row.id,
        "name": row.name,
        "role_name": row.role_name or row.job_name or "",
        "holders": holders.get(row.id, []),
    } for row in rows]


async def save_config(db: AsyncSession, position_ids: list[int], user) -> dict:
    """Write version N+1 and retire the previous one.

    Retired, never edited: a return already sitting with the inventory desk resolved its
    chain against the version that was live when it got there, and that must not move
    under it (`wf_instances.resolved_chain`).
    """
    ordered: list[int] = []
    for position_id in position_ids:
        # The same post twice would ask one person to sign the same document twice.
        if position_id not in ordered:
            ordered.append(int(position_id))

    if ordered:
        live = {row[0] for row in (await db.execute(
            select(HcmPosition.id).where(HcmPosition.id.in_(ordered),
                                         HcmPosition.is_active.is_(True))
        )).all()}
        missing = [p for p in ordered if p not in live]
        if missing:
            raise ValidationError(f"Unknown or inactive position {missing[0]}")

    previous = list((await db.execute(
        select(Workflow).where(
            Workflow.doc_type == DOC_TYPE,
            Workflow.project_id.is_(None),
            Workflow.is_active.is_(True),
        ).order_by(Workflow.version.desc(), Workflow.id.desc())
    )).scalars().all())
    version = max([wf.version for wf in previous], default=0) + 1
    for wf in previous:
        wf.is_active = False
        wf.effective_to = utcnow().date()

    # An empty list is a real choice: "no receiving check". It retires the ladder and
    # writes no new one, so `find_ladder` finds nothing and a return settles on its
    # reporting line exactly as it did before this screen existed.
    if not ordered:
        await write_audit(db, entity=AUDIT_ENTITY, entity_id=0,
                          entity_no=custom_ladder.custom_code(PROJECT_ID, DOC_TYPE)[:50],
                          action=AuditAction.UPDATE, actor=user,
                          after={"steps": []},
                          summary="Return receiving approval cleared — returns settle "
                                  "on the reporting line's approval")
        await db.commit()
        logger.info("Return receiving ladder cleared by %s",
                    getattr(user, "full_name", user))
        return await get_config(db)

    names = {row[0]: row[1] for row in (await db.execute(
        select(HcmPosition.id, HcmPosition.name).where(HcmPosition.id.in_(ordered))
    )).all()}

    wf = Workflow(
        code=custom_ladder.custom_code(PROJECT_ID, DOC_TYPE),
        name="Stock return — receiving approval",
        doc_type=DOC_TYPE,
        project_id=PROJECT_ID,
        module="Inventory",
        version=version,
        is_active=True,
    )
    db.add(wf)
    await db.flush()

    for index, position_id in enumerate(ordered):
        stage = Stage(
            workflow_id=wf.id,
            sequence=index + 1,
            name=(names.get(position_id) or f"Position {position_id}")[:200],
            # A real post, known before any return exists.
            approver_type=ApproverType.POSITION.value,
            position_id=position_id,
            is_enabled=True,
            approval_mode=ApprovalMode.ANY_ONE.value,
        )
        db.add(stage)
        if index == 0:
            await db.flush()
            # The policy lives on the first rung, which is where `ladder.read_policy`
            # looks. INDEPENDENT: the returner never signs their own return — and the
            # only rung they could hold is skipped rather than emptying the ladder.
            db.add(StageCondition(
                stage_id=stage.id, field_name=ladder.POLICY_FIELD,
                operator="EQ", field_value=ladder.POLICY_INDEPENDENT, logic="AND"))
    await db.flush()

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=wf.id, entity_no=wf.code[:50],
                      action=AuditAction.CREATE, actor=user,
                      after={"version": version, "steps": ordered},
                      summary="Return receiving approval v"
                              f"{version} saved ("
                              f"{' → '.join(names.get(p, str(p)) for p in ordered)})")
    await db.commit()
    logger.info("Return receiving ladder v%s saved by %s: %s", version,
                getattr(user, "full_name", user), ordered)
    return await get_config(db)
