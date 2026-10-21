"""Operational approval endpoints. Routers contain no business logic."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms

from . import fulfilment, service
from .schemas import (
    ApprovalActionIn, ApprovalActionOut, ApprovalIndentOut, ApprovalRejectionIn,
    ApprovalReportOut, BulkActionIn, BulkActionOut,
    ConsolidationApprovalIn, ConsolidationApprovalOut,
    ConsolidationFilters, ConsolidationOut, IndentApprovalActionIn,
    IndentRejectionIn, IndentReturnIn, IssueFromStockIn, ReminderOut,
)


router = APIRouter(prefix="/api/approvals", tags=["approvals"])


@router.get("/pending")
async def pending(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user), search: str = "",
                  doc_type: str = "", overdue_only: bool = False,
                  raised_from: datetime | None = Query(None),
                  raised_to: datetime | None = Query(None),
                  sort: str = "oldest", scope: str = Query("mine")):
    return await service.pending_page(
        db, user, params.page, params.size, search=search, doc_type=doc_type,
        overdue_only=overdue_only, raised_from=raised_from, raised_to=raised_to,
        sort=sort, scope=scope,
    )


@router.get("/pending/summary")
async def pending_summary(db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user),
                          scope: str = Query("mine")):
    return await service.pending_summary(db, user, scope=scope)


@router.get("/my-decisions")
async def my_decisions(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                       user=Depends(get_current_user), search: str = "",
                       decision: str = "", doc_type: str = ""):
    return await service.decisions_page(
        db, user, params.page, params.size, search=search, decision=decision,
        doc_type=doc_type,
    )


@router.get("/team-queue")
async def team_queue(db: AsyncSession = Depends(get_db),
                     user=Depends(get_current_user)):
    return {"items": await service.team_queue(db, user)}


@router.get("/consolidation", response_model=ConsolidationOut)
async def consolidation(filters: ConsolidationFilters = Depends(),
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await service.consolidation_workspace(db, user, filters)


@router.post("/consolidation/approve", response_model=ConsolidationApprovalOut)
async def approve_consolidation(body: ConsolidationApprovalIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await service.approve_consolidation(db, body, user)


@router.get("/allocation-cycles")
async def allocation_cycles(db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """Monthly allocation cycles waiting on me — the consolidated counterpart to the
    single allocation rows already in this inbox."""
    return {"items": await service.allocation_cycles_for_user(db, user)}


@router.get("/reports/summary", response_model=ApprovalReportOut)
async def reports(db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user)):
    return await service.report_summary(db, user)


# Rule 6, on the two endpoints that serve an approval TRAIL. Each is gated on the
# screen it exists for, which is the honest mapping — there is no "may read a trail"
# code short of the auditor's, and the real work is done row by row inside: the
# service refuses a document this login was never part of, and `_ledger_visibility`
# then decides how far down it they may read. The gate is the outer door; it is not
# the security.
@router.get("/decision-ledger/{doc_type}/{doc_id}")
async def decision_ledger(doc_type: str, doc_id: int,
                          action_id: int | None = Query(None),
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(
                              perms.page_view_code("approval_decisions")))):
    return await service.decision_ledger(db, doc_type, doc_id, user, action_id)


# The same trail, read as a MONTH rather than as a document. A monthly indent is
# signed a whole cycle at a time (`approve_consolidation`), so the decision the
# approver actually took is spread across N `wf_actions` rows and no single ledger
# page can state it. Same gate as the ledger above, and the same row-by-row scoping
# inside: the service refuses an anchor this login was never part of, then counts
# only the members of the cycle it may read.
@router.get("/cycle-ledger/{doc_type}/{doc_id}")
async def cycle_ledger(doc_type: str, doc_id: int,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(
                           perms.page_view_code("approval_decisions")))):
    return await service.cycle_ledger(db, doc_type, doc_id, user)


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


# Declared before `/documents/{doc_type}/…`: `bulk-approve` would otherwise be read as
# a doc_type and the request would 422 on the missing doc_id.
@router.post("/documents/bulk-approve", response_model=BulkActionOut)
async def bulk_approve(body: BulkActionIn, db: AsyncSession = Depends(get_db),
                       user=Depends(get_current_user)):
    return await service.act_on_documents(
        db, body.documents, "APPROVED", body.comments, user,
    )


@router.post("/documents/bulk-reject", response_model=BulkActionOut)
async def bulk_reject(body: BulkActionIn, db: AsyncSession = Depends(get_db),
                      user=Depends(get_current_user)):
    return await service.act_on_documents(
        db, body.documents, "REJECTED", body.comments, user,
    )


def require_approval_permission(code: str):
    """Gated on permission, but also allows workflow admins for master override."""
    async def checker(
        user=Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ):
        from app.platform.rbac.service import get_user_permissions
        from app.platform.workflow.engine import is_workflow_admin
        if await is_workflow_admin(db, user):
            return user
        user_perms = await get_user_permissions(
            db, user, getattr(user, "active_position_id", None),
        )
        if code not in user_perms:
            from app.core.exceptions import PermissionError_
            raise PermissionError_(f"Missing permission: {code}")
        return user

    return checker


@router.get("/indents/{indent_id}", response_model=ApprovalIndentOut)
async def get_indent(indent_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_approval_permission(perms.INDENT_APPROVE))):
    return await service.get_indent_for_approval(db, indent_id, user)


@router.post("/indents/{indent_id}/approve", response_model=ApprovalIndentOut)
async def approve_indent(indent_id: int, body: IndentApprovalActionIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_approval_permission(perms.INDENT_APPROVE))):
    return await service.approve_indent(db, indent_id, body.items, body.comments, user)


@router.post("/indents/{indent_id}/reject", response_model=ApprovalIndentOut)
async def reject_indent(indent_id: int, body: IndentRejectionIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_approval_permission(perms.INDENT_REJECT))):
    return await service.reject_indent(db, indent_id, body.comments, user)


@router.post("/indents/{indent_id}/return", response_model=ApprovalIndentOut)
async def return_indent(indent_id: int, body: IndentReturnIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_approval_permission(perms.INDENT_APPROVE))):
    return await service.return_indent(db, indent_id, body.comments, user)


@router.get("/indents/{indent_id}/availability")
async def indent_availability(indent_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_approval_permission(perms.INDENT_APPROVE))):
    """What is still owed per line, and what this approver holds against it."""
    return await fulfilment.availability_for_indent(db, indent_id, user)


@router.post("/indents/{indent_id}/issue-from-stock")
async def issue_from_stock(indent_id: int, body: IssueFromStockIn,
                           # INDENT_APPROVE, not STOCK_TRANSFER: this is an approver
                           # serving a document they already hold, from a point they
                           # already own. Gating it on the warehouse permission meant
                           # every OE and DM needed stock.transfer before they could
                           # act on their own indent. The real boundary is enforced in
                           # the service — the source point must be in this user's
                           # reporting subtree — and that no permission can hand over.
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.INDENT_APPROVE))):
    return await fulfilment.issue_from_my_stock(
        db, indent_id, body.lines, user, body.reason, body.forward_remainder,
    )
