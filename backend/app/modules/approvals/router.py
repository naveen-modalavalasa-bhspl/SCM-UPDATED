"""Operational approval endpoints. Routers contain no business logic."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms

from . import service
from .schemas import (
    ApprovalActionIn, ApprovalActionOut, ApprovalIndentOut, ApprovalRejectionIn,
    ApprovalReportOut, IndentApprovalActionIn, IndentRejectionIn, IndentReturnIn,
    ReminderOut,
)


router = APIRouter(prefix="/api/approvals", tags=["approvals"])


@router.get("/pending")
async def pending(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user), search: str = "",
                  doc_type: str = "", overdue_only: bool = False,
                  raised_from: datetime | None = Query(None),
                  raised_to: datetime | None = Query(None),
                  sort: str = "oldest"):
    return await service.pending_page(
        db, user, params.page, params.size, search=search, doc_type=doc_type,
        overdue_only=overdue_only, raised_from=raised_from, raised_to=raised_to,
        sort=sort,
    )


@router.get("/my-decisions")
async def my_decisions(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                       user=Depends(get_current_user), search: str = "",
                       decision: str = ""):
    return await service.decisions_page(
        db, user, params.page, params.size, search=search, decision=decision,
    )


@router.get("/team-queue")
async def team_queue(db: AsyncSession = Depends(get_db),
                     user=Depends(get_current_user)):
    return {"items": await service.team_queue(db, user)}


@router.get("/reports/summary", response_model=ApprovalReportOut)
async def reports(db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user)):
    return await service.report_summary(db, user)


@router.get("/history/{doc_type}/{doc_id}")
async def history(doc_type: str, doc_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user)):
    return {"items": await service.approval_history(db, doc_type, doc_id, user)}


@router.post("/team-queue/{approver_id}/remind", response_model=ReminderOut)
async def remind(approver_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(get_current_user)):
    return await service.remind_team_approver(db, approver_id, user)


@router.post("/documents/{doc_type}/{doc_id}/approve", response_model=ApprovalActionOut)
async def approve_document(doc_type: str, doc_id: int, body: ApprovalActionIn,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(get_current_user)):
    return await service.act_on_document(
        db, doc_type, doc_id, "APPROVED", body.comments, user,
    )


@router.post("/documents/{doc_type}/{doc_id}/reject", response_model=ApprovalActionOut)
async def reject_document(doc_type: str, doc_id: int, body: ApprovalRejectionIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    return await service.act_on_document(
        db, doc_type, doc_id, "REJECTED", body.comments, user,
    )


@router.get("/indents/{indent_id}", response_model=ApprovalIndentOut)
async def get_indent(indent_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await service.get_indent_for_approval(db, indent_id, user)


@router.post("/indents/{indent_id}/approve", response_model=ApprovalIndentOut)
async def approve_indent(indent_id: int, body: IndentApprovalActionIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await service.approve_indent(db, indent_id, body.items, body.comments, user)


@router.post("/indents/{indent_id}/reject", response_model=ApprovalIndentOut)
async def reject_indent(indent_id: int, body: IndentRejectionIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.INDENT_REJECT))):
    return await service.reject_indent(db, indent_id, body.comments, user)


@router.post("/indents/{indent_id}/return", response_model=ApprovalIndentOut)
async def return_indent(indent_id: int, body: IndentReturnIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.INDENT_REJECT))):
    return await service.return_indent(db, indent_id, body.comments, user)
