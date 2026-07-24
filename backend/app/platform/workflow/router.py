"""Workflow read endpoints: the 'My Approvals' inbox and a document's audit trail."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.platform.workflow import engine

router = APIRouter(prefix="/api/workflow", tags=["workflow"])


@router.get("/pending")
async def my_pending(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return {"items": await engine.pending_for_user(db, user)}


@router.get("/history/{doc_type}/{doc_id}")
async def doc_history(doc_type: str, doc_id: int,
                      db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    actions = await engine.history(db, doc_type, doc_id)
    return {"items": [
        {"stage_sequence": a.stage_sequence, "actor_user_id": a.actor_user_id,
         "action": a.action, "comments": a.comments,
         "acted_at": a.acted_at.isoformat() if a.acted_at else None}
        for a in actions
    ]}
