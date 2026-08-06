"""Hand-built ladders: an ordered list of POSTS, with no climbing.

The rank ladder in `ladder.py` answers "who is above me?" by walking the raiser's own
`parent_position_id` chain. That is the right question for an Indent — a storekeeper's
request really does travel Store Supervisor -> OE -> District Manager.

It is the wrong question for Inventory and Warehouse, and the live mirror says so:

  * The whole SCM/warehouse department (12 people, `hcm_departments` "Warehouse") sits
    on posts with `parent_position_id = NULL` and no children. Mahendra, "Head SCM and
    Logistics", is an island. No amount of climbing from a storekeeper ever reaches him.
  * Every one of those 12 shares ONE rank — `role_id` 29, "MANAGER / WAREHOUSE
    MANAGER". Ticking that rank means all twelve; it cannot name Mahendra alone.

So a custom ladder names the POST (`hcm_positions.id`) instead of the rank, and the
approvers are simply the posts in the order they were ticked. Still not a person: the
post is the rung, so when Mahendra moves on, whoever takes the chair inherits it.

Everything else is unchanged — the chain is still resolved once at submit and frozen
onto `wf_instances.resolved_chain`, a vacant post is still skipped rather than
stranding the document, and saving still writes version N+1 rather than editing N.

Told apart from a rank ladder by the workflow code alone (`CUSTOM-…`), so a plain
POSITION workflow built on the Workflows screen is never mistaken for one.
"""
import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm.models import HcmDepartment, HcmEmployee, HcmPosition
from app.platform.settings.service import write_audit
from app.platform.workflow import ladder
from app.platform.workflow.models import Instance, Stage, StageCondition, Workflow
from app.shared.enums import ApprovalMode, ApproverType, AuditAction, InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

# Both live in ladder.py so active_ladder() can recognise a custom ladder without
# importing this module back.
CUSTOM_CODE_PREFIX = ladder.CUSTOM_CODE_PREFIX
is_custom = ladder.is_custom_ladder


def custom_code(project_id: int | None, doc_type: str) -> str:
    return f"{CUSTOM_CODE_PREFIX}-{doc_type}-{project_id or 'ALL'}"


# ---------------- discovery: departments, then the posts inside one ----------------

async def departments(db: AsyncSession, project_id: int | None) -> dict:
    """The departments this project's posts sit in, with a headcount.

    Grouped by department NAME, not id. HCM has duplicate rows for the same name —
    "Warehouse" exists twice with different ids, and an employee's `department_id`
    points at a different one than their position's does. Grouping by id split the
    twelve warehouse posts across two entries, one of which looked empty.
    """
    stmt = (select(
        func.coalesce(HcmDepartment.name, "No department").label("name"),
        func.count(func.distinct(HcmPosition.id)).label("position_count"),
    ).select_from(HcmPosition)
     .join(HcmDepartment, HcmDepartment.id == HcmPosition.department_id, isouter=True)
     .where(HcmPosition.is_active.is_(True))
     .group_by(func.coalesce(HcmDepartment.name, "No department")))
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(ladder._held_position_ids(project_id)))
    rows = (await db.execute(stmt.order_by("name"))).all()
    return {"departments": [{"name": row.name, "position_count": row.position_count}
                            for row in rows if row.position_count]}


async def department_posts(db: AsyncSession, project_id: int | None,
                           department: str) -> dict:
    """Every post in one department, with who fills it.

    A department is a dozen posts, not three thousand, which is the whole reason this
    screen can show checkboxes instead of a search box.
    """
    stmt = (select(HcmPosition.id, HcmPosition.name, HcmPosition.role_name,
                   HcmPosition.job_name)
            .join(HcmDepartment, HcmDepartment.id == HcmPosition.department_id,
                  isouter=True)
            .where(HcmPosition.is_active.is_(True),
                   func.coalesce(HcmDepartment.name, "No department") == department))
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(ladder._held_position_ids(project_id)))
    rows = list((await db.execute(stmt)).all())
    if not rows:
        return {"posts": []}

    holders_of, _first = await ladder._position_people(
        db, [row.id for row in rows], project_id)
    return {"posts": sorted(({
        "id": row.id,
        "name": row.name,
        "role_name": row.role_name or row.job_name or "",
        "holders": [{"id": h.id, "name": h.full_name, "code": h.emp_code}
                    for h in holders_of.get(row.id, [])[:8]],
    } for row in rows), key=lambda post: post["name"])}


# ---------------- loading ----------------

async def get_custom(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """The saved custom ladder for this scope, or an empty draft."""
    ladder_config_validate(doc_type)
    wf = await _active_custom(db, project_id, doc_type)
    if wf is None:
        return {"workflow_id": None, "version": 0, "project_id": project_id,
                "doc_type": doc_type, "is_new": True, "steps": [], "in_flight": 0,
                "self_approval_policy": ladder.POLICY_INDEPENDENT,
                "fallback_position_id": None, "warnings": []}

    rows = list((await db.execute(
        select(Stage).where(Stage.workflow_id == wf.id).order_by(Stage.sequence)
    )).scalars().all())
    holders_of, _first = await ladder._position_people(
        db, [row.position_id for row in rows if row.position_id], None)
    in_flight = (await db.execute(
        select(func.count(Instance.id)).where(
            Instance.workflow_id == wf.id,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
        )
    )).scalar() or 0
    policy, fallback_position_id = await ladder.read_policy(db, rows)
    # One person on several steps is allowed and normal here — each step is a hat, and
    # he signs once per hat, switching between them. Said plainly so an admin building
    # the ladder knows how many signatures they are actually asking that person for.
    warnings: list[str] = []
    by_employee: dict[int, tuple[str, list[str]]] = {}
    for row in rows:
        for holder in holders_of.get(row.position_id, []):
            entry = by_employee.setdefault(holder.id, (holder.full_name, []))
            entry[1].append(row.name or str(row.position_id))
    warnings = [f"{name} fills {len(posts)} of these steps ({', '.join(posts)}) — "
                f"they sign once per step, switching position each time."
                for name, posts in by_employee.values() if len(posts) > 1]

    # A hand-built ladder never climbs, so "unreachable" here means one thing only:
    # nobody sits in the chair. resolve_fixed_chain skips such a step rather than
    # stranding the document, and a ladder made entirely of them resolves to an empty
    # chain — which is how a document falls through to the safety-net approver.
    #
    # Wrapped, because this is a READ. Everything above it is the ladder the admin
    # came here to see, and a warning that cannot be computed must not be the reason
    # the screen fails to open.
    try:
        empty = [row.name or str(row.position_id) for row in rows
                 if not holders_of.get(row.position_id)]
        if empty:
            line = (f"{len(empty)} step{'s' if len(empty) > 1 else ''} "
                    f"({', '.join(empty)}) {'have' if len(empty) > 1 else 'has'} nobody "
                    f"in the chair — {'they' if len(empty) > 1 else 'it'} will be "
                    f"skipped at submit.")
            if len(empty) == len(rows):
                line += (" Every step is empty, so documents will fall through to the "
                         "fallback approver.")
            logger.warning("Custom approval ladder for project %s / %s: %s",
                           project_id, doc_type, line)
            warnings.append(line)
    except Exception:  # noqa: BLE001 - a warning must never hide the ladder itself
        logger.exception("Could not check custom ladder %s / %s for empty steps",
                         project_id, doc_type)

    return {
        "workflow_id": wf.id, "version": wf.version, "project_id": project_id,
        "doc_type": doc_type, "is_new": False, "in_flight": in_flight,
        "self_approval_policy": policy,
        "fallback_position_id": fallback_position_id,
        "warnings": warnings,
        "steps": [{
            "sequence": row.sequence,
            "position_id": row.position_id,
            "name": row.name,
            "holders": [{"id": h.id, "name": h.full_name, "code": h.emp_code}
                        for h in holders_of.get(row.position_id, [])[:8]],
            # Nobody sits in this chair any more — it will be skipped at submit rather
            # than stranding the document, but the admin should know.
            "is_dead": not holders_of.get(row.position_id),
        } for row in rows],
    }


async def _active_custom(db: AsyncSession, project_id: int | None,
                         doc_type: str) -> Workflow | None:
    stmt = select(Workflow).where(
        Workflow.doc_type == doc_type, Workflow.is_active.is_(True),
        Workflow.code.like(f"{CUSTOM_CODE_PREFIX}-%"))
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    return (await db.execute(
        stmt.order_by(Workflow.version.desc(), Workflow.id.desc())
    )).scalars().first()


# ---------------- resolution (no climbing) ----------------

async def resolve_fixed_chain(db: AsyncSession, stages: list[Stage],
                              requester_id: int | None,
                              policy: str = ladder.POLICY_INDEPENDENT,
                              requester_position_id: int | None = None) -> list[dict]:
    """The ticked posts, in order, skipping the ones nobody fills.

    Same shape as ladder.resolve_chain so the engine's ladder path needs no other
    change. The difference from a rank ladder is what a rung MEANS here: a rung is a
    POST — a hat — not a person. One person routinely wears several of them, and each
    hat is a separate signature.

    So the raiser is never struck off a rung merely for being the raiser. What is
    spent is the ONE hat he submitted under:

      * INDEPENDENT — the post he submitted wearing is skipped. Siva allocates as
        Assistant Manager, so that rung is his own work and he signs the remaining
        one, Inventory Manager, after switching hats.
      * CREATOR_ALLOWED — nothing is skipped. He signs the Assistant Manager rung,
        switches, and signs the Inventory Manager rung: two approvals, one per hat.

    Rungs are deliberately NOT deduped by person. Collapsing two posts held by one
    employee is right for a rank ladder — the same human twice up a reporting line
    really is one approver — and wrong here, where the two posts are the two hats the
    ladder is made of. Each rung keeps its own post, so `engine.act` requires the
    matching hat to be active before it will accept a decision.
    """
    chain: list[dict] = []
    for stage in sorted(stages, key=lambda s: s.sequence):
        if not stage.is_enabled or stage.position_id is None:
            continue
        # The hat he raised the document under. Under CREATOR_ALLOWED it still has to
        # be signed; under INDEPENDENT signing it would be approving his own work.
        if (policy != ladder.POLICY_CREATOR_ALLOWED
                and requester_position_id is not None
                and stage.position_id == requester_position_id):
            logger.info("Rung %r skipped: raised under that post", stage.name)
            continue
        position = await db.get(HcmPosition, stage.position_id)
        if position is None or not position.is_active:
            continue
        holders = await ladder._position_holders(db, position.id, None)
        if not holders:
            continue
        chain.append({
            "sequence": len(chain) + 1,
            "position_id": position.id,
            "position_name": position.name,
            "role_id": position.role_id,
            # The post's own name, not its rank: the twelve warehouse posts all share
            # one rank, so "MANAGER" would tell the approver nothing.
            "role_name": stage.name or position.name,
            "approver_ids": [h.id for h in holders],
            "approver_names": [h.full_name for h in holders],
            # Exactly its own post: the rung is a hat, so only that hat may sign it.
            "allowed_position_ids": [position.id],
        })
    return chain


# ---------------- saving ----------------

async def save_custom(db: AsyncSession, data, user) -> dict:
    """Write version N+1 and retire every workflow live for this scope.

    Retiring the rank ladder too is deliberate: one scope, one ladder. Otherwise a
    document would have two live definitions and which one won would depend on row
    order.
    """
    ladder_config_validate(data.doc_type)
    if not data.steps:
        raise ValidationError("Pick at least one approver")

    allowed = {row[0] for row in (await db.execute(
        select(HcmPosition.id).where(
            HcmPosition.id.in_([step.position_id for step in data.steps]),
            HcmPosition.is_active.is_(True))
    )).all()}
    missing = [step.position_id for step in data.steps if step.position_id not in allowed]
    if missing:
        raise ValidationError(f"Unknown or inactive position {missing[0]}")

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
        # Retired, not deleted: documents already climbing it must still resolve their
        # history against it.
        row.is_active = False
        row.effective_to = utcnow().date()

    wf = Workflow(
        code=custom_code(data.project_id, data.doc_type),
        name=f"{ladder.DOC_TYPE_LABEL.get(data.doc_type, data.doc_type)} approval"
             f"{f' — {project_name}' if project_name else ''}",
        doc_type=data.doc_type,
        project_id=data.project_id,
        project_name=project_name,
        module=ladder.MODULE_BY_DOC_TYPE.get(data.doc_type, "Other"),
        version=version,
        is_active=True,
    )
    db.add(wf)
    await db.flush()

    policy = (data.self_approval_policy
              if data.self_approval_policy in ladder.POLICIES
              else ladder.POLICY_INDEPENDENT)

    for index, step in enumerate(data.steps):
        stage = Stage(
            workflow_id=wf.id,
            sequence=index + 1,
            name=step.name,
            # A real post, known before any document exists — so unlike a rank rung this
            # genuinely is a POSITION stage.
            approver_type=ApproverType.POSITION.value,
            position_id=step.position_id,
            is_enabled=True,
            approval_mode=ApprovalMode.ANY_ONE.value,
        )
        db.add(stage)
        if index == 0:
            # The policy belongs to the ladder, so it is written once on its first step.
            await db.flush()
            db.add(StageCondition(
                stage_id=stage.id, field_name=ladder.POLICY_FIELD,
                operator="EQ", field_value=policy, logic="AND"))
            if data.fallback_position_id:
                db.add(StageCondition(
                    stage_id=stage.id,
                    field_name=ladder.FALLBACK_POSITION_FIELD,
                    operator="EQ", field_value=str(data.fallback_position_id),
                    logic="AND"))
    await db.flush()

    await write_audit(
        db, entity="wf_workflows", entity_id=wf.id, entity_no=wf.code[:50],
        action=AuditAction.CREATE, actor=user,
        after={"version": version, "project_id": data.project_id,
               "doc_type": data.doc_type,
               "steps": [step.name for step in data.steps]},
        summary=f"Custom approval ladder v{version} saved "
                f"({' → '.join(step.name for step in data.steps)})",
    )
    await db.commit()
    logger.info("Custom approval ladder %s saved as version %s by %s",
                wf.code, version, getattr(user, "full_name", user))
    return await get_custom(db, data.project_id, data.doc_type)


def ladder_config_validate(doc_type: str) -> None:
    from app.shared.enums import DocType
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(f"Unknown document type {doc_type!r}")
