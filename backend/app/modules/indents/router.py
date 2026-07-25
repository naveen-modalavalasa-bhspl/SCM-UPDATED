"""Indents endpoints. No logic here — every route calls the service."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.platform.rbac import permissions as perms
from app.modules.indents import service
from app.modules.indents.enums import (
    ApprovalAction, IndentActivityType, IndentStatus, MaterialDirection,
)
from app.modules.indents.schemas import (
    AcknowledgmentRow, ActionIn, ActivityRow, IndentCreate, IndentListRow,
    IndentNotificationRow, IndentOut, IndentStatsOut, IndentUpdate,
)
from datetime import date

router = APIRouter(prefix="/api/indents", tags=["indents"])


@router.get("", response_model=Page[IndentListRow])
async def list_indents(params: PageParams = Depends(), status: str | None = None,
                       department_id: int | None = None,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.list_indents(db, params, status, department_id)


@router.get("/approved-pending-po", response_model=Page[IndentListRow])
async def approved_pending_po(params: PageParams = Depends(),
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.approved_pending_po(db, params)


@router.get("/stats", response_model=IndentStatsOut)
async def stats(department_id: int | None = None, db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.indent_stats(db, department_id)


@router.get("/activity", response_model=Page[ActivityRow])
async def activity(params: PageParams = Depends(), search: str | None = None,
                   date_from: date | None = None, date_to: date | None = None,
                   item_id: int | None = None, status: IndentStatus | None = None,
                   transaction_type: IndentActivityType | None = None,
                   direction: MaterialDirection | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission("indent.view"))):
    return await service.activity_ledger(db, params, search=search, date_from=date_from,
        date_to=date_to, item_id=item_id, status=status,
        transaction_type=transaction_type, direction=direction)


@router.get("/acknowledgments", response_model=Page[AcknowledgmentRow])
async def acknowledgments(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission("indent.view"))):
    return await service.list_acknowledgments(db, params)


@router.get("/notifications", response_model=Page[IndentNotificationRow])
async def notifications(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission("indent.view"))):
    return await service.list_notifications(db, params, user)


@router.post("", response_model=IndentOut)
async def create(data: IndentCreate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.INDENT_CREATE))):
    return await service.create_indent(db, data, user)


@router.get("/{indent_id}", response_model=IndentOut)
async def get_one(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.get_indent(db, indent_id)


@router.put("/{indent_id}", response_model=IndentOut)
async def update(indent_id: int, data: IndentUpdate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.INDENT_EDIT))):
    return await service.update_indent(db, indent_id, data, user)


@router.post("/{indent_id}/submit", response_model=IndentOut)
async def submit(indent_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.INDENT_SUBMIT))):
    return await service.submit_indent(db, indent_id, user)


@router.post("/{indent_id}/approve", response_model=IndentOut)
async def approve(indent_id: int, body: ActionIn = ActionIn(),
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.APPROVED, body.comments, user,
    )


@router.post("/{indent_id}/reject", response_model=IndentOut)
async def reject(indent_id: int, body: ActionIn = ActionIn(),
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.INDENT_REJECT))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.REJECTED, body.comments, user,
    )
