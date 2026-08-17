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
from app.platform.workflow import ladder, posts
from app.platform.workflow.models import (
    ApprovalPost, Instance, Stage, StageCondition, Workflow,
)
from app.shared.enums import ApprovalMode, ApproverType, AuditAction, InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

# Both live in ladder.py so active_ladder() can recognise a custom ladder without
# importing this module back.
CUSTOM_CODE_PREFIX = ladder.CUSTOM_CODE_PREFIX
is_custom = ladder.is_custom_ladder


def custom_code(project_id: int | None, doc_type: str,
                raiser_role_id: int | None = None) -> str:
    """The code identifies the BUCKET a chain belongs to: scope, document, raiser rank.

    A rank suffix rather than a second table: `active_ladder` already tells a custom
    ladder from a plain workflow by this prefix, and a chain pinned to a rank is the
    same object with one more thing said about it.
    """
    scope = f"{CUSTOM_CODE_PREFIX}-{doc_type}-{project_id or 'ALL'}"
    return scope if raiser_role_id is None else f"{scope}-R{raiser_role_id}"


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

async def get_custom(db: AsyncSession, project_id: int | None, doc_type: str,
                     raiser_role_id: int | None = None) -> dict:
    """The saved custom ladder for this scope, or an empty draft."""
    ladder_config_validate(doc_type)
    wf = await _active_custom(db, project_id, doc_type, raiser_role_id)
    if wf is None:
        return {"workflow_id": None, "version": 0, "project_id": project_id,
                "doc_type": doc_type, "raiser_role_id": raiser_role_id,
                "is_new": True, "steps": [], "in_flight": 0,
                "self_approval_policy": ladder.POLICY_INDEPENDENT,
                "fallback_position_id": None, "warnings": []}

    rows = list((await db.execute(
        select(Stage).where(Stage.workflow_id == wf.id).order_by(Stage.sequence)
    )).scalars().all())
    holders_of, _first = await ladder._position_people(
        db, [row.position_id for row in rows if row.position_id], None)
    local_seats = await posts.members_of(
        db, [row.post_id for row in rows if row.post_id])
    # A shared-chair rung DOES have a fixed answer — everyone holding that rank — so it
    # is read here like any other chair. Only a climbed rank has no answer until a
    # document exists.
    shared_seats = {
        row.position_role_id: await ladder.rank_any_holders(db, row.position_role_id)
        for row in rows
        if row.approver_type == ApproverType.ROLE_ANY.value and row.position_role_id
    }
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
    def _seats(row: Stage) -> list[dict]:
        """Who fills this step, whichever kind of chair it is.

        A rank rung has no fixed answer — which ancestor holds that rank depends on who
        raises the document — so it reports no seats and is described by its name alone.
        """
        if row.post_id is not None:
            return local_seats.get(row.post_id, [])
        if row.position_id is not None:
            return [{"id": h.id, "name": h.full_name, "code": h.emp_code}
                    for h in holders_of.get(row.position_id, [])]
        if row.approver_type == ApproverType.ROLE_ANY.value:
            return shared_seats.get(row.position_role_id, [])
        return []

    warnings: list[str] = []
    by_employee: dict[int, tuple[str, list[str]]] = {}
    def _is_climbed(row: Stage) -> bool:
        """Only a ROLE rung is answered at submit time. A ROLE_ANY rung names a chair
        whose holders are known now, so it counts as fixed everywhere below."""
        return (row.position_role_id is not None
                and row.approver_type != ApproverType.ROLE_ANY.value)

    for row in rows:
        if _is_climbed(row):
            continue
        for seat in _seats(row):
            entry = by_employee.setdefault(seat["id"], (seat["name"], []))
            entry[1].append(row.name or str(row.position_id or row.post_id))
    warnings = [f"{name} fills {len(steps)} of these steps ({', '.join(steps)}) — "
                f"they sign once per step, switching position each time."
                for name, steps in by_employee.values() if len(steps) > 1]

    # A hand-built ladder never climbs, so "unreachable" here means one thing only:
    # nobody sits in the chair. resolve_fixed_chain skips such a step rather than
    # stranding the document, and a ladder made entirely of them resolves to an empty
    # chain — which is how a document falls through to the safety-net approver.
    #
    # Wrapped, because this is a READ. Everything above it is the ladder the admin
    # came here to see, and a warning that cannot be computed must not be the reason
    # the screen fails to open.
    try:
        # A rank rung is exempt: it is answered by climbing at submit time, so having
        # nobody attached to it now says nothing about whether it will resolve.
        fixed_rows = [row for row in rows if not _is_climbed(row)]
        empty = [row.name or str(row.position_id or row.post_id) for row in fixed_rows
                 if not _seats(row)]
        if empty:
            line = (f"{len(empty)} step{'s' if len(empty) > 1 else ''} "
                    f"({', '.join(empty)}) {'have' if len(empty) > 1 else 'has'} nobody "
                    f"in the chair — {'they' if len(empty) > 1 else 'it'} will be "
                    f"skipped at submit.")
            if len(empty) == len(rows):
                line += (" Every step is empty, so documents will fall through to the "
                         "fallback approver.")
            elif len(empty) == len(fixed_rows):
                line += (" Only the climbed steps are left, so who signs depends "
                         "entirely on the raiser's reporting line.")
            logger.warning("Custom approval ladder for project %s / %s: %s",
                           project_id, doc_type, line)
            warnings.append(line)
    except Exception:  # noqa: BLE001 - a warning must never hide the ladder itself
        logger.exception("Could not check custom ladder %s / %s for empty steps",
                         project_id, doc_type)

    return {
        "workflow_id": wf.id, "version": wf.version, "project_id": project_id,
        "doc_type": doc_type, "raiser_role_id": wf.raiser_role_id,
        "raiser_role_name": wf.raiser_role_name,
        "is_new": False, "in_flight": in_flight,
        "self_approval_policy": policy,
        "fallback_position_id": fallback_position_id,
        "warnings": warnings,
        "steps": [{
            "sequence": row.sequence,
            "position_id": row.position_id,
            "post_id": row.post_id,
            "position_role_id": row.position_role_id,
            # What the screen renders as the step's kind: "rank" is answered by
            # climbing, the other two name a chair outright.
            "kind": ("shared_rank"
                     if row.approver_type == ApproverType.ROLE_ANY.value
                     else "rank" if row.position_role_id is not None
                     else "local" if row.post_id is not None else "hcm"),
            "name": row.name,
            "holders": _seats(row)[:8],
            # Nobody sits in this chair any more — it will be skipped at submit rather
            # than stranding the document, but the admin should know. Never true of a
            # rank rung, which has no fixed holder to be missing.
            "is_dead": not _is_climbed(row) and not _seats(row),
        } for row in rows],
    }


async def _active_custom(db: AsyncSession, project_id: int | None, doc_type: str,
                         raiser_role_id: int | None = None) -> Workflow | None:
    """The live chain for EXACTLY this bucket — no falling back to the default one.

    Deliberately exact: this reads what the editor is editing. Falling back here would
    show the default chain under a rank heading and the next save would silently copy
    it onto that rank.
    """
    stmt = select(Workflow).where(
        Workflow.doc_type == doc_type, Workflow.is_active.is_(True),
        Workflow.code.like(f"{CUSTOM_CODE_PREFIX}-%"))
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    stmt = (stmt.where(Workflow.raiser_role_id == raiser_role_id)
            if raiser_role_id is not None
            else stmt.where(Workflow.raiser_role_id.is_(None)))
    return (await db.execute(
        stmt.order_by(Workflow.version.desc(), Workflow.id.desc())
    )).scalars().first()


# ---------------- resolution (no climbing) ----------------

async def _local_post_rung(db: AsyncSession, stage: Stage, sequence: int,
                           exclude_employee_id: int | None) -> dict | None:
    """A rung naming a post this system owns rather than one from the HCM mirror.

    Same shape as every other rung, with two deliberate differences: `position_id` is
    None because there is no HCM post behind it, and `allowed_position_ids` is empty.
    The engine reads an empty allowed-list as "no hat restriction" (engine.py, the
    `if not allowed: continue` guard) and falls back to gating on `approver_ids`, which
    is exactly right here — a local post's seat is the person, so the person is the gate.
    """
    post = await db.get(ApprovalPost, stage.post_id)
    if post is None or not post.is_active:
        logger.info("Rung %r skipped: local post %s is retired", stage.name, stage.post_id)
        return None
    holders = await posts.holders(db, post.id, exclude_employee_id)
    if not holders:
        logger.info("Rung %r skipped: nobody is seated in local post %r",
                    stage.name, post.name)
        return None
    return {
        "sequence": sequence,
        "position_id": None,
        "position_name": post.name,
        "role_id": None,
        "role_name": stage.name or post.name,
        "approver_ids": [h.id for h in holders],
        "approver_names": [h.full_name for h in holders],
        "allowed_position_ids": [],
        # Tells the history and inbox screens this rung is a locally-owned chair, so a
        # missing HCM position never reads as a broken mirror.
        "post_id": post.id,
    }


async def resolve_fixed_chain(db: AsyncSession, stages: list[Stage],
                              requester_id: int | None,
                              policy: str = ladder.POLICY_INDEPENDENT,
                              requester_position_id: int | None = None,
                              context: dict | None = None) -> list[dict]:
    """The ticked rungs, in order, skipping the ones nobody fills.

    A rung is one of three things, and a single ladder may mix them — which the SCM
    indent flow requires: it climbs the field reporting line (Store Keeper -> OE ->
    District Manager -> …) and only then hands to two fixed SCM chairs.

      * `post_id`         — a local post (workflow/posts.py). Seats are people here.
      * `position_id`     — an HCM post. The original custom-ladder rung.
      * `position_role_id`— a RANK, resolved by climbing the raiser's own reporting
                            line, exactly as `ladder.resolve_chain` does. Spliced in at
                            its position in the order, so a mixed ladder reads top to
                            bottom the way the admin built it.

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
    exclude_id = None if policy == ladder.POLICY_CREATOR_ALLOWED else requester_id
    chain: list[dict] = []
    for stage in sorted(stages, key=lambda s: s.sequence):
        if not stage.is_enabled:
            continue

        # A locally-owned chair: HCM has no position for this step at all.
        if stage.post_id is not None:
            rung = await _local_post_rung(db, stage, len(chain) + 1, exclude_id)
            if rung is not None:
                chain.append(rung)
            continue

        # A shared chair: a rank that is NOT on the raiser's reporting line. Read
        # straight off its holders — climbing to it is impossible by construction, and
        # that is exactly why these rungs were being invented as local posts before HCM
        # created the real ones.
        if stage.approver_type == ApproverType.ROLE_ANY.value and stage.position_role_id:
            people = await ladder.rank_any_holders(
                db, stage.position_role_id, exclude_id)
            if not people:
                logger.info("Rung %r skipped: nobody holds rank %s",
                            stage.name, stage.position_role_id)
                continue
            chain.append({
                "sequence": len(chain) + 1,
                "position_id": None,
                "position_name": stage.name,
                "role_id": stage.position_role_id,
                "role_name": stage.name or f"Rank {stage.position_role_id}",
                "approver_ids": [person["id"] for person in people],
                "approver_names": [person["name"] for person in people],
                # No hat restriction: the chair IS the rank, so holding it is the gate.
                "allowed_position_ids": [],
            })
            continue

        # A RANK rung inside a hand-built ladder: climb the raiser's own reporting line
        # and keep the ancestors holding this rank. Delegated to ladder.resolve_chain
        # so there is exactly one implementation of climbing, and spliced in here so a
        # mixed ladder keeps the order the admin built.
        if stage.position_role_id is not None:
            climbed = await ladder.resolve_chain(
                db, [stage], requester_position_id, requester_id, context or {}, policy)
            for rung in climbed:
                chain.append({**rung, "sequence": len(chain) + 1})
            continue

        if stage.position_id is None:
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

async def _rank_approver_type(db: AsyncSession, role_id: int,
                              project_id: int | None) -> str:
    """ROLE if the rank is climbable from this project, ROLE_ANY if it is a chair.

    Decided here rather than asked of the caller: whether a rank sits on the raiser's
    line is a fact about the org, not a choice the admin should have to understand. A
    rank held by this project's own people is climbed to exactly as before; one held
    only elsewhere — SCM HEAD, INDENT TEAM, the PO desk — is a shared chair, and
    climbing to it would resolve to nobody every time.
    """
    if project_id is None:
        return ApproverType.ROLE.value
    mine = {rank["role_id"] for rank in await ladder.project_ranks(db, project_id)}
    return (ApproverType.ROLE.value if role_id in mine
            else ApproverType.ROLE_ANY.value)


async def save_custom(db: AsyncSession, data, user) -> dict:
    """Write version N+1 and retire every workflow live for this scope.

    Retiring the rank ladder too is deliberate: one scope, one ladder. Otherwise a
    document would have two live definitions and which one won would depend on row
    order.
    """
    ladder_config_validate(data.doc_type)
    # NO_APPROVAL is the one policy with nothing to tick: the document is born
    # approved, so demanding a rung would make the setting unsaveable. Every other
    # policy still needs at least one post or it would resolve to nobody.
    if not data.steps and data.self_approval_policy != ladder.POLICY_NONE:
        raise ValidationError("Pick at least one approver")

    wanted_positions = [s.position_id for s in data.steps if s.position_id is not None]
    if wanted_positions:
        allowed = {row[0] for row in (await db.execute(
            select(HcmPosition.id).where(
                HcmPosition.id.in_(wanted_positions),
                HcmPosition.is_active.is_(True))
        )).all()}
        missing = [value for value in wanted_positions if value not in allowed]
        if missing:
            raise ValidationError(f"Unknown or inactive position {missing[0]}")

    wanted_posts = [s.post_id for s in data.steps if s.post_id is not None]
    if wanted_posts:
        allowed = {row[0] for row in (await db.execute(
            select(ApprovalPost.id).where(
                ApprovalPost.id.in_(wanted_posts),
                ApprovalPost.is_active.is_(True))
        )).all()}
        missing = [value for value in wanted_posts if value not in allowed]
        if missing:
            raise ValidationError(f"Unknown or retired approval post {missing[0]}")

    project_name = None
    if data.project_id is not None:
        employee = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.project_id == data.project_id).limit(1)
        )).scalars().first()
        project_name = employee.project_name if employee else None

    raiser_role_id = getattr(data, "raiser_role_id", None)
    raiser_role_name = None
    if raiser_role_id is not None:
        raiser_role_name = (await db.execute(
            select(HcmPosition.role_name)
            .where(HcmPosition.role_id == raiser_role_id,
                   HcmPosition.role_name.isnot(None))
            .limit(1)
        )).scalar()

    # Retire only this BUCKET's live rows. Retiring the whole scope is right when
    # saving the default chain — one scope, one default, and an old rank ladder from
    # the previous screen must not compete with it — but a chain pinned to Store
    # Keeper says nothing about the one everybody else uses, and taking the default
    # down with it would leave every other rank falling through to the reporting line.
    previous = list((await db.execute(
        select(Workflow).where(
            Workflow.doc_type == data.doc_type,
            (Workflow.project_id == data.project_id if data.project_id is not None
             else Workflow.project_id.is_(None)),
            (Workflow.raiser_role_id == raiser_role_id if raiser_role_id is not None
             else Workflow.raiser_role_id.is_(None)),
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
        code=custom_code(data.project_id, data.doc_type, raiser_role_id),
        name=f"{ladder.DOC_TYPE_LABEL.get(data.doc_type, data.doc_type)} approval"
             f"{f' — {project_name}' if project_name else ''}"
             f"{f' (raised by {raiser_role_name})' if raiser_role_name else ''}",
        doc_type=data.doc_type,
        project_id=data.project_id,
        project_name=project_name,
        raiser_role_id=raiser_role_id,
        raiser_role_name=raiser_role_name,
        module=ladder.MODULE_BY_DOC_TYPE.get(data.doc_type, "Other"),
        version=version,
        is_active=True,
        # So the version list can say who changed the chain, not just when.
        created_by_id=getattr(user, "id", None),
    )
    db.add(wf)
    await db.flush()

    policy = (data.self_approval_policy
              if data.self_approval_policy in ladder.POLICIES
              else ladder.POLICY_INDEPENDENT)

    async def _mark_policy(stage: Stage) -> None:
        """The policy belongs to the ladder, so it is written once on its first step."""
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

    for index, step in enumerate(data.steps):
        stage = Stage(
            workflow_id=wf.id,
            sequence=index + 1,
            name=step.name,
            # POSITION for a chair known before any document exists — an HCM post or a
            # local one. A rank rung is ROLE: which chair it means depends on who
            # raised the document, so it can only be answered at submit time.
            approver_type=(await _rank_approver_type(db, step.position_role_id,
                                                     data.project_id)
                           if step.position_role_id is not None
                           else ApproverType.POSITION.value),
            position_id=step.position_id,
            post_id=step.post_id,
            position_role_id=step.position_role_id,
            is_enabled=True,
            approval_mode=ApprovalMode.ANY_ONE.value,
        )
        db.add(stage)
        if index == 0:
            await _mark_policy(stage)

    if not data.steps:
        # NO_APPROVAL has no rungs to pick, but the marker has to live somewhere or
        # read_policy finds nothing, defaults to INDEPENDENT, and the "no signature
        # needed" ladder routes to the reporting line — the exact opposite of the
        # setting. A disabled, post-less stage carries it: resolve_fixed_chain skips
        # any stage that has no position, so it can never resolve to an approver.
        marker = Stage(
            workflow_id=wf.id, sequence=1, name="No approval required",
            approver_type=ApproverType.POSITION.value, position_id=None,
            is_enabled=False, approval_mode=ApprovalMode.ANY_ONE.value,
        )
        db.add(marker)
        await _mark_policy(marker)
    await db.flush()

    await write_audit(
        db, entity="wf_workflows", entity_id=wf.id, entity_no=wf.code[:50],
        action=AuditAction.CREATE, actor=user,
        after={"version": version, "project_id": data.project_id,
               "doc_type": data.doc_type, "raiser_role_id": raiser_role_id,
               "steps": [step.name for step in data.steps]},
        summary=f"Custom approval ladder v{version} saved "
                f"{f'for raisers at {raiser_role_name} ' if raiser_role_name else ''}"
                f"({' → '.join(step.name for step in data.steps)})",
    )
    await db.commit()
    logger.info("Custom approval ladder %s saved as version %s by %s",
                wf.code, version, getattr(user, "full_name", user))
    return await get_custom(db, data.project_id, data.doc_type, raiser_role_id)


def ladder_config_validate(doc_type: str) -> None:
    from app.shared.enums import DocType
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(f"Unknown document type {doc_type!r}")
