"""Workflow read endpoints: the 'My Approvals' inbox and a document's audit trail."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.platform.rbac import permissions as perms
from app.platform.workflow import engine, service
from app.platform.workflow.schemas import (
    DelegationIn, DelegationOut, WorkflowActionIn, WorkflowActionOut,
)

router = APIRouter(prefix="/api/workflow", tags=["workflow"])


@router.get("/pending")
async def my_pending(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await engine.pending_for_user(db, user)}


@router.get("/history/{doc_type}/{doc_id}")
async def doc_history(doc_type: str, doc_id: int,
                      db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    actions = await engine.history(db, doc_type, doc_id)
    return {"items": [
        {"stage_sequence": a.stage_sequence, "actor_id": a.actor_id,
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
                            user=Depends(require_permission(perms.ADMIN_WORKFLOW_MANAGE))):
    return await service.delegate(db, body, user)
