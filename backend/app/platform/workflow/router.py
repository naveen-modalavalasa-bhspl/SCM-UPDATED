"""Workflow read endpoints: the 'My Approvals' inbox and a document's audit trail."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.platform.rbac import permissions as perms
from app.platform.workflow import (
    custom_ladder, engine, ladder, ladder_config, service,
)
from app.platform.workflow.schemas import (
    CustomLadderIn, DelegationEndIn, DelegationIn, DelegationOut, LadderCopyIn, LadderIn,
    WorkflowActionIn, WorkflowActionOut, WorkflowIn,
)

router = APIRouter(prefix="/api/workflow", tags=["workflow"])


# ---------------- Settings > Approvals Config ----------------

@router.get("/ladders/options")
async def ladder_options(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.options(db)


@router.get("/ladders/ranks")
async def ladder_ranks(
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.ranks(db, project_id)


@router.get("/ladders/rank-positions")
async def ladder_rank_positions(
    role_id: int,
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await ladder_config.rank_positions(db, project_id, role_id)


@router.get("/ladders")
async def get_ladder(
    doc_type: str,
    project_id: int | None = None,
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
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.departments(db, project_id)


@router.get("/ladders/department-posts")
async def ladder_department_posts(
    department: str,
    project_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE)),
):
    return await custom_ladder.department_posts(db, project_id, department)


@router.get("/ladders/custom")
async def get_custom_ladder(
    doc_type: str,
    project_id: int | None = None,
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
async def my_pending(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await engine.pending_for_user(db, user)}


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
