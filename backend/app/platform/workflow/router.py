"""Workflow read endpoints: the 'My Approvals' inbox and a document's audit trail."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import ValidationError
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms
from app.platform.workflow import (
    custom_ladder, engine, flow_config, ladder, ladder_config, posts, reminders, service,
)
from app.platform.workflow import scheduler as approval_scheduler
from app.platform.workflow.schemas import (
    ApprovalPostIn, CustomLadderIn, DelegationEndIn, DelegationIn, DelegationOut,
    FlowCopyIn, LadderCopyIn, LadderIn, ReminderConfigIn, WorkflowActionIn,
    WorkflowActionOut, WorkflowIn,
)

router = APIRouter(prefix="/api/workflow", tags=["workflow"])


def _project_id(project_id: str | None = Query(None)) -> int | None:
    """The project a ladder is being configured for, or None for company-wide.

    Parsed by hand because company-wide IS a real choice on this screen and a select
    with no value posts `?project_id=`, which an `int | None` rejects with a 422 — the
    "Could not load this department's posts" the SCM staff's own ladder died on. An
    empty string and an absent parameter mean the same thing here: not scoped to a
    project.
    """
    if project_id is None or not project_id.strip():
        return None
    try:
        return int(project_id)
    except ValueError as exc:
        raise ValidationError(f"project_id must be a number: {project_id!r}") from exc


# ---------------- Settings > Approvals Config ----------------

@router.get("/ladders/options")
async def ladder_options(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.options(db)


@router.get("/ladders/ranks")
async def ladder_ranks(
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.ranks(db, project_id)


@router.get("/ladders/rank-positions")
async def ladder_rank_positions(
    role_id: int,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.rank_positions(db, project_id, role_id)


@router.get("/ladders")
async def get_ladder(
    doc_type: str,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.get_ladder(db, project_id, doc_type)


@router.post("/ladders/preview")
async def preview_ladder(
    body: LadderIn,
    from_role_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.preview(
        db, body.project_id, body.doc_type,
        [rung.model_dump() for rung in body.rungs], from_role_id,
        body.self_approval_policy or ladder.POLICY_INDEPENDENT,
        body.fallback_position_id,
    )


@router.post("/ladders")
async def save_ladder(
    body: LadderIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.save_ladder(db, body, user)


@router.get("/reminders")
async def reminder_status(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """The settings, the next run, and exactly what the next run would do."""
    data = await reminders.preview(db)
    data["next_run"] = approval_scheduler.next_run()
    return data


@router.put("/reminders")
async def save_reminder_config(
    body: ReminderConfigIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    config = await reminders.save_config(
        db, enabled=body.enabled, interval_minutes=body.interval_minutes,
        max_reminders=body.max_reminders, gap_hours=body.gap_hours,
        overdue_after_days=body.overdue_after_days,
    )
    approval_scheduler.configure(config["enabled"], config["interval_minutes"])
    return {**config, "next_run": approval_scheduler.next_run()}


@router.post("/reminders/run")
async def run_reminders_now(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Chase everything overdue now, whatever the schedule says.

    Deliberately ignores the enabled flag: that switch governs the unattended timer,
    and an admin pressing a button is not unattended.
    """
    return await reminders.run(db)


@router.get("/ladders/in-flight-stale")
async def ladder_stale_instances(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Documents still climbing a ladder that has since been replaced."""
    return await ladder_config.stale_instances(db)


@router.post("/ladders/copy")
async def copy_ladder(
    body: LadderCopyIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.copy_ladder(db, body, user)


# ---------------- Settings > Approvals Config > Build your own ladder ----------------
#
# For the documents whose approvers are not above the raiser: pick a department, tick
# the posts, done. See platform/workflow/custom_ladder.py.

@router.get("/ladders/departments")
async def ladder_departments(
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.departments(db, project_id)


@router.get("/ladders/department-posts")
async def ladder_department_posts(
    department: str,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.department_posts(db, project_id, department)


@router.get("/ladders/custom")
async def get_custom_ladder(
    doc_type: str,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.get_custom(db, project_id, doc_type)


@router.post("/ladders/custom")
async def save_custom_ladder(
    body: CustomLadderIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.save_custom(db, body, user)


# ---------------- Settings > Approval Flow (the one-screen replacement) ----------------
#
# One question — who signs what — answered as: document type -> ordered list of chairs.
# See platform/workflow/flow_config.py for why this exists beside the older screens.

@router.get("/flow")
async def flow_overview(
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await flow_config.overview(db, project_id)


@router.get("/flow/rungs")
async def flow_rungs(
    search: str = "",
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await flow_config.rungs(db, project_id, search)


@router.get("/flow/{doc_type}/versions")
async def flow_versions(
    doc_type: str,
    raiser_role_id: int | None = None,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Every version, with the documents still riding each one."""
    return await flow_config.versions(db, project_id, doc_type, raiser_role_id)


@router.post("/flow/{doc_type}/restore/{workflow_id}")
async def restore_flow_version(
    doc_type: str,
    workflow_id: int,
    raiser_role_id: int | None = None,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Copy an old version's steps forward as a new one. The old row is never revived."""
    return await flow_config.restore(db, project_id, doc_type, workflow_id, user,
                                     raiser_role_id)


# Declared above `/flow/{doc_type}` so "copy" is never read as a document type.
@router.post("/flow/copy")
async def copy_flow_chain(
    body: FlowCopyIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Save this chain onto other projects and/or other raiser ranks, step for step."""
    return await flow_config.copy_flow(db, body, user)


@router.get("/flow/{doc_type}")
async def flow_chain(
    doc_type: str,
    raiser_role_id: int | None = None,
    project_id: int | None = Depends(_project_id),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await flow_config.chain(db, project_id, doc_type, raiser_role_id)


@router.post("/flow")
async def save_flow_chain(
    body: CustomLadderIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    """Saved through the hand-built ladder writer, so there is one way a chain is stored."""
    return await flow_config.save(db, body, user)


# ---------------- the chairs this system owns ----------------

@router.get("/posts")
async def approval_posts(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await posts.list_posts(db, include_inactive)


@router.get("/posts/employees")
async def approval_post_employees(
    search: str = "",
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await posts.search_employees(db, search)


@router.post("/posts")
async def create_approval_post(
    body: ApprovalPostIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await posts.save_post(db, body, user)


@router.put("/posts/{post_id}")
async def update_approval_post(
    post_id: int,
    body: ApprovalPostIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await posts.save_post(db, body, user, post_id)


@router.delete("/posts/{post_id}")
async def retire_approval_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await posts.deactivate_post(db, post_id, user)


@router.get("/definitions")
async def workflow_definitions(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.list_workflows(db)


@router.get("/definitions/options")
async def workflow_definition_options(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.workflow_options(db)


@router.get("/definitions/{workflow_id}")
async def workflow_definition(
    workflow_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.get_workflow(db, workflow_id)


@router.post("/definitions")
async def create_workflow_definition(
    body: WorkflowIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.save_workflow(db, body, user)


@router.put("/definitions/{workflow_id}")
async def update_workflow_definition(
    workflow_id: int,
    body: WorkflowIn,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.save_workflow(db, body, user, workflow_id)


@router.delete("/definitions/{workflow_id}")
async def deactivate_workflow_definition(
    workflow_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await service.deactivate_workflow(db, workflow_id, user)


@router.get("/pending")
async def my_pending(params: PageParams = Depends(), doc_type: str = "",
                     db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    """Approval tasks waiting on the caller, one page at a time.

    `doc_type` takes a comma-separated list, so a screen that only cares about two
    document types asks for those two instead of pulling every task and filtering in
    the browser. It used to answer a bare {items} with no paging at all, which is why
    it disagreed so loudly with /api/approvals/pending — that one is the approval
    inbox and deliberately leaves out monthly indents, which are approved as
    consolidated batches elsewhere. This one is the raw engine queue.
    """
    doc_types = [t.strip().upper() for t in doc_type.split(",") if t.strip()]
    return await engine.pending_page(db, user, params.page, params.size, doc_types)


@router.get("/history/{doc_type}/{doc_id}")
async def doc_history(doc_type: str, doc_id: int,
                      db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    actions = await engine.history(db, doc_type, doc_id)
    return {"items": [
        {"stage_sequence": a.stage_sequence, "stage_name": a.stage_name, "actor_id": a.actor_id,
         "actor_name": a.actor_name, "actor_position": a.actor_position,
         "action": a.action, "comments": a.comments,
         "acted_at": a.acted_at.isoformat() if a.acted_at else None}
        for a in actions
    ]}


@router.post("/{doc_type}/{doc_id}/return", response_model=WorkflowActionOut)
async def return_document(doc_type: str, doc_id: int,
                          body: WorkflowActionIn = WorkflowActionIn(),
                          db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    return await service.return_document(
        db, doc_type, doc_id, body.comments, body.context, user,
    )


@router.post("/delegations", response_model=DelegationOut)
async def create_delegation(body: DelegationIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(get_current_user)):
    return await service.delegate(db, body, user)


@router.get("/delegations", response_model=list[DelegationOut])
async def delegations(scope: str = "mine", db: AsyncSession = Depends(get_db),
                      user=Depends(get_current_user)):
    return await service.list_delegations(db, user, scope)


@router.get("/delegation-options")
async def delegation_options(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await service.delegation_options(db, user)}


@router.post("/delegations/{delegation_id}/end", response_model=DelegationOut)
async def end_delegation(delegation_id: int, body: DelegationEndIn = DelegationEndIn(),
                         db: AsyncSession = Depends(get_db),
                         user=Depends(get_current_user)):
    return await service.end_delegation(db, delegation_id, user, body.reason)


@router.get("/my-decisions")
async def my_decisions(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await service.my_decisions(db, user)}


@router.get("/team-queue")
async def team_queue(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await service.team_queue(db, user)}
