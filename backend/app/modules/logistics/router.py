"""Logistics endpoints: GRN and issues. No logic — routes call the service."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.logistics import service
from app.modules.logistics.schemas import (
    GRNCreate, GRNListRow, GRNOut, IssueCreate, IssueOut,
)
from app.platform.rbac import permissions as perms

router = APIRouter(tags=["logistics"])

# ---- GRN ----
grn_router = APIRouter(prefix="/api/grn")


@grn_router.get("", response_model=Page[GRNListRow])
async def list_grn(params: PageParams = Depends(), status: str | None = None,
                   po_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.GRN_VIEW))):
    return await service.list_grn(db, params, status, po_id)


@grn_router.post("/from-po/{po_id}", response_model=GRNOut)
async def create_from_po(po_id: int, data: GRNCreate, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.GRN_CREATE))):
    return await service.create_grn_from_po(db, po_id, data, user)


@grn_router.get("/{grn_id}", response_model=GRNOut)
async def get_grn(grn_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.GRN_VIEW))):
    return await service.get_grn(db, grn_id)


@grn_router.post("/{grn_id}/qc-pass", response_model=GRNOut)
async def qc_pass(grn_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.GRN_QC))):
    return await service.qc_pass(db, grn_id, user)


@grn_router.post("/{grn_id}/qc-fail", response_model=GRNOut)
async def qc_fail(grn_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.GRN_QC))):
    return await service.qc_fail(db, grn_id, user)


# ---- Issues ----
issue_router = APIRouter(prefix="/api/issues")


@issue_router.get("", response_model=Page[IssueOut])
async def list_issues(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ISSUE_VIEW))):
    return await service.list_issues(db, params)


@issue_router.post("", response_model=IssueOut)
async def create_issue(data: IssueCreate, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ISSUE_CREATE))):
    return await service.create_issue(db, data, user)


@issue_router.post("/{issue_id}/issue", response_model=IssueOut)
async def issue_stock(issue_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ISSUE_ISSUE))):
    return await service.issue_stock(db, issue_id, user)


router.include_router(grn_router)
router.include_router(issue_router)
