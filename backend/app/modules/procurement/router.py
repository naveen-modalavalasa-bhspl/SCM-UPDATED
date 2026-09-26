"""Procurement endpoints. No logic — every route calls the service.

Several routers under one `router` object, because `main.py` includes one attribute
per module:

  * `/api/pos/**`             — purchase orders, unchanged
  * `/api/requisitions/**`    — what a buyer wants to buy
  * `/api/consolidations/**`  — many requisitions rolled into one buying sheet
  * `/api/rfqs/**`            — what went out to vendors, and what came back
  * `/api/supplier/**`      — the vendor portal. NO `require_permission` anywhere on
                              it: the caller is not an employee and holds no role.
                              `get_current_vendor` is the whole guard, and every
                              service call under it filters on the vendor id from the
                              token — never one from the request.
"""
from datetime import date
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import throttle
from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import get_current_vendor, require_permission
from app.core.pagination import Page, PageParams
from app.modules.procurement import quote_otp, service, stats, suppliers
from app.modules.procurement.schemas import (
    ActionIn, ApprovalTrailOut, AwardIn, ConsolidationCreate, ConsolidationLinesIn,
    ConsolidationListRow, ConsolidationOut, ConsolidationSourceOut,
    ConsolidationStatsOut, DemandPoolRow, LedgerStatsOut, POStatsOut, QuoteStatsOut,
    ReqStatsOut, RFQStatsOut,
    DespatchNoteIn, DespatchNoteOut, MRCandidateRow, VendorPOListRow, VendorPOOut,
    POAmendIn, POApprovalQtyIn, POCommentIn, POCommentOut, POCreate, POFromQuotationIn, POHeaderUpdate, POListRow, POOut,
    PORevisionOut, POVendorResponseIn, QuoteListRow,
    QuoteOtpOut, QuoteOut, QuoteSubmit, ReqCreate, ReqFromMRsIn, ReqListRow,
    ReqOut, RFQCreate, RFQListRow, RFQOut, RFQQuantitiesIn, RFQUpdate,
    SupplierCreate, SupplierLoginIn, SupplierOut, SupplierUpdate, VendorAccountIn,
    LedgerRow,
    VendorAccountOut, VendorLoginIn, VendorNotificationOut, VendorPasswordIn,
    VendorProfileOut,
    VendorTokenOut,
)
from app.platform.rbac import permissions as perms
from app.shared.enums import ApprovalAction

pos = APIRouter(prefix="/api/pos", tags=["procurement"])
requisitions = APIRouter(prefix="/api/requisitions", tags=["procurement"])
consolidations = APIRouter(prefix="/api/consolidations", tags=["procurement"])
rfqs = APIRouter(prefix="/api/rfqs", tags=["procurement"])
# The buying trail spans all four document types, so it belongs to the module rather
# than to any one of them — hence its own prefix instead of hanging off /api/pos.
ledger_api = APIRouter(prefix="/api/procurement", tags=["procurement"])
supplier = APIRouter(prefix="/api/supplier", tags=["supplier-portal"])
# Its own prefix, not /api/rfqs/portal/…: `/api/rfqs/{rfq_id}` is int-typed and is
# declared first, so a literal "portal" segment there would 422 rather than fall
# through to the account routes.
accounts = APIRouter(prefix="/api/supplier-accounts", tags=["supplier-portal"])


@pos.get("", response_model=Page[POListRow])
async def list_pos(
    params: PageParams = Depends(),
    search: str | None = None,
    status: str | None = None,
    vendor_id: int | None = None,
    project_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    # What is waiting on THIS login, off `wf_pending` and not off the status — which
    # is what the "Waiting for me" tile opens. No new permission: it can only ever
    # NARROW what `po.view` already returns.
    pending_for_me: bool = False,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.PO_VIEW))
):
    return await service.list_pos(
        db, params, search=search, status=status, vendor_id=vendor_id,
        project_id=project_id, date_from=date_from, date_to=date_to,
        pending_for_me=pending_for_me, user=user
    )

@pos.get("/export")
async def export_pos(
    search: str | None = None,
    status: str | None = None,
    vendor_id: int | None = None,
    project_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.PO_VIEW))
):
    csv_data = await service.export_pos(
        db, search=search, status=status, vendor_id=vendor_id,
        project_id=project_id, date_from=date_from, date_to=date_to, user=user
    )
    return StreamingResponse(
        iter([csv_data]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=purchase_orders.csv"}
    )


@pos.get("/open-for-grn", response_model=Page[POListRow])
async def open_for_grn(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.PO_VIEW))):
    return await service.open_for_grn(db, params)


@pos.get("/stats", response_model=POStatsOut)
async def po_stats(db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.PO_VIEW))):
    """The KPI strip over the order register. `po.view`, same rung, same rows."""
    return await stats.po_stats(db, user=user)


@pos.post("", response_model=POOut, status_code=201)
async def create_po(body: POCreate, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.PO_CREATE))):
    """Raise an order by hand, with no indent or quotation behind it."""
    return await service.create_po(db, body, user)


@pos.post("/from-indent/{indent_id}", response_model=POOut)
async def create_from_indent(indent_id: int, data: POCreate, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.PO_CREATE))):
    return await service.create_po_from_indent(db, indent_id, data, user)


@pos.post("/from-quotation/{quotation_id}", response_model=POOut, status_code=201)
async def create_from_quotation(quotation_id: int,
                                data: POFromQuotationIn = POFromQuotationIn(),
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.PO_CREATE))):
    return await service.create_po_from_quotation(db, quotation_id, data, user)


@pos.get("/{po_id}", response_model=POOut)
async def get_one(po_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_VIEW))):
    return await service.get_po_detail(db, po_id, user=user)


@pos.put("/{po_id}", response_model=POOut)
async def update_po(po_id: int, body: POHeaderUpdate, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.PO_EDIT))):
    """The header a draft order was raised without — terms, addresses, project."""
    return await service.update_po_header(db, po_id, body, user)


@pos.post("/{po_id}/amend", response_model=POOut)
async def amend_po(po_id: int, body: POAmendIn, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.PO_EDIT))):
    """Revise an order that has already gone out. It files the previous version away,
    bumps the revision, and sends the order back through approval — and, where the
    vendor had accepted, back to them for a fresh answer."""
    return await service.amend_po(db, po_id, body, user)


@pos.get("/{po_id}/revisions", response_model=list[PORevisionOut])
async def po_revisions(po_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.PO_VIEW))):
    """Every version this order has been. Reading one needs only `po.view`."""
    return await service.po_revisions(db, po_id, user)


# ── PO discussion (approver <=> raiser) & approval quantity edits ──────────

@pos.get("/{po_id}/comments", response_model=list[POCommentOut])
async def po_comments(po_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.PO_VIEW))):
    """Conversation on this PO — approver asks, raiser replies."""
    return await service.po_comments(db, po_id, user)


@pos.post("/{po_id}/comments", response_model=POCommentOut, status_code=201)
async def post_po_comment(po_id: int, body: POCommentIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.PO_VIEW))):
    return await service.add_po_comment(db, po_id, body.message, user)


@pos.put("/{po_id}/approval-quantities", response_model=POOut)
async def update_po_approval_quantities(
        po_id: int, body: POApprovalQtyIn,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.PO_APPROVE))):
    """Approver trims quantities — decrease only — while awaiting approval."""
    return await service.update_po_approval_quantities(db, po_id, body, user)



# --------------------------------------------------------------------------- #
#  Approval trail — one route per document, each on that document's OWN view
#  permission. No new permission code is invented (rule 6): if a login may open the
#  order, it may see who signed it and who is holding it now. That also means every
#  job profile already configured keeps working with no reseed.
# --------------------------------------------------------------------------- #

@pos.get("/{po_id}/approvals", response_model=ApprovalTrailOut)
async def po_approvals(po_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.PO_VIEW))):
    """Where this order is waiting, and every rung it has already passed."""
    return await service.po_approval_trail(db, po_id, user)


@pos.post("/{po_id}/submit", response_model=POOut)
async def submit(po_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.PO_SUBMIT))):
    return await service.submit_po(db, po_id, user)


@pos.post("/{po_id}/approve", response_model=POOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve(po_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_APPROVE))):
    return await service.act_on_po(db, po_id, "APPROVE", body.comments, user)


@pos.post("/{po_id}/reject", response_model=POOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject(po_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.PO_REJECT))):
    return await service.act_on_po(db, po_id, "REJECT", body.comments, user)


@pos.post("/{po_id}/send-to-vendor", response_model=POOut)
async def send_to_vendor(po_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.PO_SEND_VENDOR))):
    return await service.send_to_vendor(db, po_id, user)


# --------------------------------------------------------------------------- #
#  Requisitions
# --------------------------------------------------------------------------- #

@requisitions.get("", response_model=Page[ReqListRow])
async def list_requisitions(params: PageParams = Depends(), status: str | None = None,
                            search: str | None = None,  # Real-time search filter for requisition number, project, and warehouse
                            # What is waiting on THIS login, off `wf_pending` and not
                            # off the status — which is what the "Waiting for me" tile
                            # opens. No new permission: it can only ever NARROW what
                            # `requisition.view` already returns.
                            pending_for_me: bool = False,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.list_requisitions(db, params, status, search,
                                           pending_for_me=pending_for_me, user=user)


# The KPI strip over the register. Same permission as the register itself, and the
# service applies the same rung — a tile must never count a row the list would hide.
# Declared above `/{req_id}`, which is int-typed.
@requisitions.get("/stats", response_model=ReqStatsOut)
async def requisition_stats(db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await stats.requisition_stats(db, user=user)


# The demand pool: how much of each item is sanctioned and not yet ordered. Read off
# requisition LINES, so `requisition.view` is the right gate and the same rung bounds
# it — see `stats.demand_pool`.
@requisitions.get("/demand-pool", response_model=Page[DemandPoolRow])
async def demand_pool(params: PageParams = Depends(),
                      project_id: int | None = None,
                      search: str | None = None,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await stats.demand_pool(
        db, params, project_id=project_id, search=search, user=user)


@requisitions.post("", response_model=ReqOut, status_code=201)
async def create_requisition(body: ReqCreate, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.create_requisition(db, body, user)


@requisitions.post("/from-material-request/{mr_id}", response_model=ReqOut,
                   status_code=201)
async def create_requisition_from_mr(
    mr_id: int, db: AsyncSession = Depends(get_db),
    user=Depends(require_permission(perms.REQUISITION_CREATE)),
):
    """Pick up an approved material request as a requisition, lines and all."""
    return await service.create_requisition_from_mr(db, mr_id, user)


# Both literals declared above `/{req_id}`, which is int-typed: a literal segment
# registered after it never matches, it 422s on the path parameter instead.
@requisitions.get("/mr-candidates", response_model=Page[MRCandidateRow])
async def mr_candidates(params: PageParams = Depends(), project_id: int | None = None,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.REQUISITION_CREATE))):
    """Approved material requests no requisition has claimed — the picker's source."""
    return await service.mr_candidates(db, params, project_id)


# "Select all" needs every id, not the twenty on screen — see
# `service.mr_candidate_ids`. Same permission as the list it selects from: this reveals
# nothing the list does not already show.
@requisitions.get("/mr-candidates/ids", response_model=list[int])
async def mr_candidate_ids(project_id: int | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.mr_candidate_ids(db, project_id)


@requisitions.post("/from-material-requests", response_model=ReqOut, status_code=201)
async def create_requisition_from_mrs(body: ReqFromMRsIn,
                                      db: AsyncSession = Depends(get_db),
                                      user=Depends(require_permission(perms.REQUISITION_CREATE))):
    """Fold a batch of approved material requests into one requisition, item-wise."""
    return await service.create_requisition_from_mrs(db, body, user)


@requisitions.get("/{req_id}/sources", response_model=list[dict])
async def requisition_sources(req_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.requisition_sources(db, req_id, user)


@requisitions.get("/{req_id}", response_model=ReqOut)
async def get_requisition(req_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.get_requisition_detail(db, req_id, user=user)


@requisitions.put("/{req_id}", response_model=ReqOut)
async def update_requisition(req_id: int, body: ReqCreate,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.update_requisition(db, req_id, body, user)


@requisitions.get("/{req_id}/approvals", response_model=ApprovalTrailOut)
async def requisition_approvals(
        req_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.requisition_approval_trail(db, req_id, user)


@requisitions.post("/{req_id}/submit", response_model=ReqOut)
async def submit_requisition(req_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.submit_requisition(db, req_id, user)


@requisitions.post("/{req_id}/approve", response_model=ReqOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve_requisition(req_id: int, body: ActionIn,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.REQUISITION_APPROVE))):
    return await service.act_on_requisition(
        db, req_id, ApprovalAction.APPROVED.value, body.comments, user)


@requisitions.post("/{req_id}/reject", response_model=ReqOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject_requisition(req_id: int, body: ActionIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_APPROVE))):
    return await service.act_on_requisition(
        db, req_id, ApprovalAction.REJECTED.value, body.comments, user)


@requisitions.post("/{req_id}/cancel", response_model=ReqOut)
async def cancel_requisition(req_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.cancel_requisition(db, req_id, user)


# --------------------------------------------------------------------------- #
#  RFQs and quotations
# --------------------------------------------------------------------------- #

@rfqs.get("", response_model=Page[RFQListRow])
async def list_rfqs(params: PageParams = Depends(), status: str | None = None,
                    search: str | None = None,  # Real-time search filter for RFQ number, title, project, and warehouse
                    pending_for_me: bool = False,
                    # A tender that is open or closed, has replies, and has no winner.
                    # Not a status, so it cannot ride on `?status=` — and the same
                    # predicate `stats.rfq_stats` counts, so the "Ready to award" tile
                    # opens exactly the rows it counted.
                    ready_to_award: bool = False,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.RFQ_VIEW))):
    return await service.list_rfqs(db, params, status, search,
                                   pending_for_me=pending_for_me,
                                   ready_to_award=ready_to_award, user=user)


# Both strips declared above `/{rfq_id}`, which is int-typed. Two endpoints and two
# gates, not one: `rfq.view` says who may see a tender, `rfq.compare` says who may see
# what it was priced at, and the quotation numbers are prices.
@rfqs.get("/stats", response_model=RFQStatsOut)
async def rfq_stats(db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.RFQ_VIEW))):
    return await stats.rfq_stats(db, user=user)


@rfqs.get("/quotations/stats", response_model=QuoteStatsOut)
async def quotation_stats(db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.RFQ_COMPARE))):
    return await stats.quotation_stats(db, user=user)


@rfqs.post("", response_model=RFQOut, status_code=201)
async def create_rfq(body: RFQCreate, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.create_rfq(db, body, user)


# Declared above `/{rfq_id}`: a literal segment has to be matched before the int-typed
# catch-all, or "quotations" is parsed as an RFQ id and 422s.
@rfqs.get("/quotations", response_model=Page[QuoteListRow])
async def list_quotations(params: PageParams = Depends(), rfq_id: int | None = None,
                          vendor_id: int | None = None,
                          search: str | None = None,  # Real-time search filter for quotation number and vendor name
                          # One value or a comma-separated set, so a KPI tile that
                          # counts a bucket ("to compare" = submitted + revised) can
                          # open a list holding exactly what it counted.
                          status: str | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.RFQ_COMPARE))):
    return await service.list_quotations(db, params, rfq_id, vendor_id, search,
                                         status=status, user=user)


@rfqs.get("/quotations/{quote_id}", response_model=QuoteOut)
async def get_quotation(quote_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.RFQ_COMPARE))):
    return await service.get_quotation(db, quote_id, user=user)


# Declared BEFORE `/{rfq_id}`, which is int-typed: a literal segment registered after
# it never matches, it 422s on the path parameter instead. Same reason the supplier
# accounts have their own prefix.
@rfqs.get("/evaluation-methods", response_model=list[dict])
async def rfq_evaluation_methods(
        user=Depends(require_permission(perms.RFQ_VIEW))):
    """The scoring methods the comparison offers. Served rather than hardcoded in the
    screen so the dropdown and the arithmetic cannot disagree."""
    return service.evaluation_methods()


@rfqs.get("/{rfq_id}", response_model=RFQOut)
async def get_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RFQ_VIEW))):
    return await service.get_rfq_detail(db, rfq_id, user=user)


@rfqs.put("/{rfq_id}", response_model=RFQOut)
async def update_rfq(rfq_id: int, body: RFQUpdate, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.update_rfq(db, rfq_id, body, user)


@rfqs.get("/{rfq_id}/approvals", response_model=ApprovalTrailOut)
async def rfq_approvals(rfq_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.RFQ_VIEW))):
    return await service.rfq_approval_trail(db, rfq_id, user)


@rfqs.post("/{rfq_id}/submit", response_model=RFQOut)
async def submit_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.submit_rfq(db, rfq_id, user)


@rfqs.put("/{rfq_id}/quantities", response_model=RFQOut)
async def set_rfq_quantities(rfq_id: int, body: RFQQuantitiesIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.RFQ_APPROVE))):
    """The approver's own edit: how much, and nothing else. `rfq.approve`, not
    `rfq.create` — the person signing the tender rarely holds the buyer's rights."""
    return await service.set_rfq_quantities(db, rfq_id, body, user)


@rfqs.post("/{rfq_id}/approve", response_model=RFQOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve_rfq(rfq_id: int, body: ActionIn,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.RFQ_APPROVE))):
    """Approving publishes it: the vendors can see the RFQ from this moment."""
    return await service.act_on_rfq(
        db, rfq_id, ApprovalAction.APPROVED.value, body.comments, user)


@rfqs.post("/{rfq_id}/reject", response_model=RFQOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject_rfq(rfq_id: int, body: ActionIn,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_APPROVE))):
    return await service.act_on_rfq(
        db, rfq_id, ApprovalAction.REJECTED.value, body.comments, user)


@rfqs.get("/{rfq_id}/invites")
async def rfq_invites(rfq_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.RFQ_CREATE))):
    """The per-vendor links, for a buyer to send by hand. Each is a bearer credential
    for exactly one RFQ and one vendor."""
    return await service.rfq_invites(db, rfq_id, user)


@rfqs.get("/{rfq_id}/comparison")
async def comparison(rfq_id: int, method: str | None = None,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_COMPARE))):
    """Every submitted quote, best first under the RFQ's evaluation method. Carries
    every vendor's price, which is exactly what must never reach a vendor — hence its
    own permission. `method` previews a different ranking without saving it."""
    return await service.comparison(db, rfq_id, user, method)


@rfqs.post("/{rfq_id}/award", response_model=RFQOut)
async def award_rfq(rfq_id: int, body: AwardIn, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.RFQ_AWARD))):
    return await service.award_rfq(db, rfq_id, body, user)


@rfqs.post("/{rfq_id}/close", response_model=RFQOut)
async def close_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.close_rfq(db, rfq_id, user)


@rfqs.post("/{rfq_id}/cancel", response_model=RFQOut)
async def cancel_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.cancel_rfq(db, rfq_id, user)


# --------------------------------------------------------------------------- #
#  Supplier accounts — the internal side of the portal
# --------------------------------------------------------------------------- #

@accounts.get("", response_model=Page[VendorAccountOut])
async def list_vendor_accounts(params: PageParams = Depends(),
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await service.list_vendor_accounts(db, params)


@accounts.post("", response_model=VendorAccountOut, status_code=201)
async def create_vendor_account(body: VendorAccountIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    """Idempotent: called twice, the vendor still has exactly one account and the
    password they may already have changed is left alone."""
    return await service.ensure_vendor_account(db, body, user)


@accounts.post("/{vendor_id}/reset", response_model=VendorAccountOut)
async def reset_vendor_password(vendor_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await service.reset_vendor_password(db, vendor_id, user)


@accounts.post("/{vendor_id}/disable", response_model=VendorAccountOut)
async def disable_vendor_account(vendor_id: int, db: AsyncSession = Depends(get_db),
                                 user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await service.set_vendor_account_active(db, vendor_id, False, user)


@accounts.post("/{vendor_id}/enable", response_model=VendorAccountOut)
async def enable_vendor_account(vendor_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await service.set_vendor_account_active(db, vendor_id, True, user)


# --------------------------------------------------------------------------- #
#  Supplier portal — reached by someone outside the company
# --------------------------------------------------------------------------- #
#  No `require_permission` below this line, deliberately. A vendor has no role and no
#  position; `get_current_vendor` is the guard, and the vendor id comes from the token.

@supplier.post("/login", response_model=VendorTokenOut)
async def vendor_login(body: VendorLoginIn, request: Request,
                       db: AsyncSession = Depends(get_db)):
    # The same 300 ms bcrypt as the employee login, on a door open to the internet and
    # unmetered until 2026-09-03. Carriers sign in here too — `/api/carrier/*` is this
    # same portal — so one throttle covers both.
    await throttle.guard(request, "vendor-login", settings.LOGIN_RATE_PER_MINUTE,
                         message="Too many sign-in attempts. Wait a minute.")
    return await service.vendor_login(db, body.username, body.password)


@supplier.get("/me", response_model=VendorProfileOut)
async def vendor_me(db: AsyncSession = Depends(get_db),
                    account=Depends(get_current_vendor)):
    return await service.vendor_profile(db, account.vendor_id)


@supplier.post("/change-password", status_code=204)
async def vendor_change_password(body: VendorPasswordIn,
                                 db: AsyncSession = Depends(get_db),
                                 account=Depends(get_current_vendor)):
    await service.vendor_change_password(
        db, account.vendor_id, body.current_password, body.new_password)


# The vendor's own bell. NEW 2026-08-21 — before this an amendment reached the vendor
# through no channel at all; `platform/notifications` is keyed on `employee_id` and a
# vendor has none. Scoped on `account.vendor_id` from the TOKEN, never a query
# parameter: the portal carries no permissions, so the scope IS the guard.
@supplier.get("/notifications", response_model=Page[VendorNotificationOut])
async def vendor_notifications(params: PageParams = Depends(),
                               unread_only: bool = False,
                               db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.vendor_notifications(
        db, account.vendor_id, params, unread_only)


@supplier.post("/notifications/{notification_id}/read", status_code=204)
async def vendor_read_notification(notification_id: int,
                                   db: AsyncSession = Depends(get_db),
                                   account=Depends(get_current_vendor)):
    await service.mark_vendor_notification_read(
        db, account.vendor_id, notification_id)


# The buying trail. Its own screen in Procurement rather than a row in the reports
# module, because it reads nothing outside procurement and a reader wants to click
# through to the document — see `procurement/ledger.py`.
#
# Gated on `po.view`: the register's most sensitive column is what an order came to, and
# that is exactly what a purchase order carries. Somebody who may not see orders must
# not see the same numbers unioned into a list beside three other document types.
@ledger_api.get("/ledger", response_model=Page[LedgerRow])
async def procurement_ledger(params: PageParams = Depends(),
                             doc_kind: str | None = None,
                             status: str | None = None,
                             project: str | None = None,
                             vendor: str | None = None,
                             date_from: date | None = None,
                             date_to: date | None = None,
                             search: str | None = None,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.PO_VIEW))):
    return await service.procurement_ledger(
        db, params, doc_kind=doc_kind, status=status, project=project,
        vendor=vendor, date_from=date_from, date_to=date_to, search=search)


# The strip over the register — one count per document kind, under the SAME filters
# the register is showing (minus `doc_kind`, which is what the tiles set). `po.view`,
# like the register, for the same reason: the trail's most sensitive column is what an
# order came to.
@ledger_api.get("/ledger/stats", response_model=LedgerStatsOut)
async def procurement_ledger_stats(status: str | None = None,
                                   project: str | None = None,
                                   vendor: str | None = None,
                                   date_from: date | None = None,
                                   date_to: date | None = None,
                                   search: str | None = None,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.PO_VIEW))):
    return await stats.ledger_stats(
        db, status=status, project=project, vendor=vendor,
        date_from=date_from, date_to=date_to, search=search)


@ledger_api.get("/ledger/filters")
async def procurement_ledger_filters(db: AsyncSession = Depends(get_db),
                                     user=Depends(require_permission(perms.PO_VIEW))):
    return await service.procurement_ledger_filters(db)


@supplier.get("/rfqs", response_model=Page[RFQListRow])
async def vendor_list_rfqs(params: PageParams = Depends(),
                           search: str | None = None,  # Real-time search filter for RFQ number and title in supplier portal
                           status: str | None = None,  # Narrows within what this vendor may already see
                           db: AsyncSession = Depends(get_db),
                           account=Depends(get_current_vendor)):
    return await service.vendor_list_rfqs(db, account.vendor_id, params, search, status)


@supplier.get("/rfqs/{rfq_id}", response_model=RFQOut)
async def vendor_get_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                         account=Depends(get_current_vendor)):
    return await service.vendor_get_rfq(db, account.vendor_id, rfq_id)


@supplier.get("/rfqs/{rfq_id}/quotation", response_model=QuoteOut)
async def vendor_get_quotation(rfq_id: int, db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.vendor_get_quotation(db, account.vendor_id, rfq_id)


# --- the vendor's own orders, and what they say they have sent ----------------
# Every one of these takes the vendor id from `get_current_vendor`, never from the
# request, so a vendor can only ever reach their own orders.

@supplier.get("/pos", response_model=Page[VendorPOListRow])
async def vendor_list_pos(params: PageParams = Depends(),
                          search: str | None = None,  # Real-time search filter for PO number in supplier portal
                          status: str | None = None,  # Narrows within what this vendor may already see
                          db: AsyncSession = Depends(get_db),
                          account=Depends(get_current_vendor)):
    return await service.vendor_list_pos(db, account.vendor_id, params, search, status)


@supplier.get("/pos/{po_id}", response_model=VendorPOOut)
async def vendor_get_po(po_id: int, db: AsyncSession = Depends(get_db),
                        account=Depends(get_current_vendor)):
    return await service.vendor_get_po(db, account.vendor_id, po_id)


@supplier.get("/pos/{po_id}/revisions", response_model=list[PORevisionOut])
async def vendor_po_revisions(po_id: int, db: AsyncSession = Depends(get_db),
                              account=Depends(get_current_vendor)):
    return await service.vendor_po_revisions(db, account.vendor_id, po_id)



@supplier.post("/pos/{po_id}/respond", response_model=VendorPOOut)
async def vendor_respond_to_po(po_id: int, body: POVendorResponseIn,
                               db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    """Accept the order, or decline it with a reason. The vendor id comes from the
    token, never from the caller, so this can only ever answer their own order."""
    await service.vendor_respond_to_po(
        db, account.vendor_id, po_id, body.accept, body.note)
    return await service.vendor_get_po(db, account.vendor_id, po_id)


@supplier.post("/pos/{po_id}/despatch-notes", response_model=DespatchNoteOut,
               status_code=201)
async def vendor_create_despatch_note(po_id: int, body: DespatchNoteIn,
                                      db: AsyncSession = Depends(get_db),
                                      account=Depends(get_current_vendor)):
    return await service.vendor_save_despatch_note(db, account.vendor_id, po_id, body)


@supplier.put("/pos/{po_id}/despatch-notes/{note_id}", response_model=DespatchNoteOut)
async def vendor_update_despatch_note(po_id: int, note_id: int, body: DespatchNoteIn,
                                      db: AsyncSession = Depends(get_db),
                                      account=Depends(get_current_vendor)):
    return await service.vendor_save_despatch_note(
        db, account.vendor_id, po_id, body, note_id)


@supplier.get("/despatch-notes/{note_id}", response_model=DespatchNoteOut)
async def vendor_get_despatch_note(note_id: int, db: AsyncSession = Depends(get_db),
                                   account=Depends(get_current_vendor)):
    return await service.vendor_get_despatch_note(db, account.vendor_id, note_id)


@supplier.post("/despatch-notes/{note_id}/submit", response_model=DespatchNoteOut)
async def vendor_submit_despatch_note(note_id: int, db: AsyncSession = Depends(get_db),
                                      account=Depends(get_current_vendor)):
    return await service.vendor_submit_despatch_note(db, account.vendor_id, note_id)


@supplier.post("/despatch-notes/{note_id}/cancel", response_model=DespatchNoteOut)
async def vendor_cancel_despatch_note(note_id: int, db: AsyncSession = Depends(get_db),
                                      account=Depends(get_current_vendor)):
    return await service.vendor_cancel_despatch_note(db, account.vendor_id, note_id)


@supplier.post("/rfqs/{rfq_id}/quotation/request-otp", response_model=QuoteOtpOut)
async def vendor_request_quote_otp(rfq_id: int, request: Request,
                                   db: AsyncSession = Depends(get_db),
                                   account=Depends(get_current_vendor)):
    """Email the code this vendor needs to submit. Answers with the masked address.

    Scoped through `vendor_get_rfq` first: a vendor may only raise a code for a tender
    they were actually invited to, or this becomes a way to probe which RFQ ids exist.
    """
    await service.vendor_get_rfq(db, account.vendor_id, rfq_id)
    return await quote_otp.issue(db, rfq_id, account.vendor_id,
                                 ip_address=getattr(request.client, "host", None))


@supplier.post("/rfqs/{rfq_id}/quotation", response_model=QuoteOut)
async def vendor_submit_quotation(rfq_id: int, body: QuoteSubmit,
                                  db: AsyncSession = Depends(get_db),
                                  account=Depends(get_current_vendor)):
    return await service.vendor_submit_quotation(
        db, account.vendor_id, rfq_id, body)


# --------------------------------------------------------------------------- #
#  Consolidated buying sheets
# --------------------------------------------------------------------------- #

# `/candidates` before `/{cons_id}`, for the int-typed-path reason above.
@consolidations.get("/candidates", response_model=Page[ReqListRow])
async def consolidation_candidates(
        params: PageParams = Depends(), project_id: int | None = None,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    """Approved requisitions not already on a sheet — what the buyer picks from."""
    return await service.consolidation_candidates(db, params, project_id)


@consolidations.get("/candidates/ids", response_model=list[int])
async def consolidation_candidate_ids(
        project_id: int | None = None,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    """Every candidate id, so "select all" can mean all of them and not one page."""
    return await service.consolidation_candidate_ids(db, project_id)


@consolidations.get("", response_model=Page[ConsolidationListRow])
async def list_consolidations(params: PageParams = Depends(),
                              status: str | None = None,
                              project_id: int | None = None,
                              pending_for_me: bool = False,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.list_consolidations(
        db, params, status, project_id, pending_for_me=pending_for_me, user=user)


@consolidations.get("/stats", response_model=ConsolidationStatsOut)
async def consolidation_stats(db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    """The KPI strip over the buying sheets. Same gate and same four rungs as the
    register — a sheet carries every project's plan, so an unscoped count would put
    the spend back in front of the login the rung was added to keep it from."""
    return await stats.consolidation_stats(db, user=user)


@consolidations.post("", response_model=ConsolidationOut, status_code=201)
async def create_consolidation(body: ConsolidationCreate,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.create_consolidation(db, body, user)


@consolidations.get("/{cons_id}", response_model=ConsolidationOut)
async def get_consolidation(cons_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.get_consolidation_detail(db, cons_id, user=user)


@consolidations.put("/{cons_id}", response_model=ConsolidationOut)
async def rebuild_consolidation(cons_id: int, body: ConsolidationCreate,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.rebuild_consolidation(db, cons_id, body, user)


@consolidations.put("/{cons_id}/lines", response_model=ConsolidationOut)
async def set_consolidation_lines(cons_id: int, body: ConsolidationLinesIn,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.set_consolidation_lines(db, cons_id, body, user)


@consolidations.delete("/{cons_id}")
async def delete_consolidation(cons_id: int, db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.delete_consolidation(db, cons_id, user)


@consolidations.get("/{cons_id}/sources", response_model=list[ConsolidationSourceOut])
async def consolidation_sources(cons_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.consolidation_sources(db, cons_id, user=user)


@consolidations.get("/{cons_id}/history", response_model=list)
async def consolidation_history(cons_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.consolidation_history(db, cons_id, user=user)


@consolidations.get("/{cons_id}/approvals", response_model=ApprovalTrailOut)
async def consolidation_approvals(
        cons_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.consolidation_approval_trail(db, cons_id, user=user)


@consolidations.post("/{cons_id}/submit", response_model=ConsolidationOut)
async def submit_consolidation(cons_id: int, db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.submit_consolidation(db, cons_id, user)


@consolidations.post("/{cons_id}/approve", response_model=ConsolidationOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve_consolidation(cons_id: int, body: ActionIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_APPROVE))):
    return await service.act_on_consolidation(
        db, cons_id, ApprovalAction.APPROVED.value, body.comments, user)


@consolidations.post("/{cons_id}/reject", response_model=ConsolidationOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject_consolidation(cons_id: int, body: ActionIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_APPROVE))):
    return await service.act_on_consolidation(
        db, cons_id, ApprovalAction.REJECTED.value, body.comments, user)


@consolidations.post("/{cons_id}/cancel", response_model=ConsolidationOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def cancel_consolidation(cons_id: int, body: ActionIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.cancel_consolidation(db, cons_id, user, body.comments)


# --------------------------------------------------------------------------- #
#  The supplier register - Procurement > Suppliers
# --------------------------------------------------------------------------- #
# The material mirror of /api/logistics-vendors. Every route is guarded by
# VENDOR_PORTAL_MANAGE, the permission that already governs minting a vendor login -
# no new code, so every job profile that could issue a supplier account yesterday can
# work this screen today and nobody else gains anything by it.
#
# `suppliers._supplier` refuses any vendor row whose type is a carrier, so this
# permission can never reach a transport provider's record or their password. Nothing
# here enters a workflow: an account is not a document and has no approval ladder.
supplier_register = APIRouter(prefix="/api/suppliers", tags=["suppliers"])


@supplier_register.get("/types", response_model=list[dict])
async def supplier_type_options(
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    """Served, not duplicated in the screen - a type the form offers that the register
    then filters out would create a supplier the page cannot show."""
    return suppliers.supplier_types()


@supplier_register.get("/summary", response_model=dict)
async def supplier_register_summary(
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.supplier_summary(db)


@supplier_register.get("", response_model=Page[SupplierOut])
async def list_suppliers(
        params: PageParams = Depends(), search: str | None = None,
        vendor_type: str | None = None, active_only: bool = False,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.list_suppliers(db, params, search, vendor_type, active_only)


@supplier_register.post("", response_model=SupplierOut, status_code=201)
async def create_supplier(
        body: SupplierCreate, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.create_supplier(db, body, user)


@supplier_register.get("/{vendor_id}", response_model=SupplierOut)
async def get_supplier(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.get_supplier(db, vendor_id)


@supplier_register.put("/{vendor_id}", response_model=SupplierOut)
async def update_supplier(
        vendor_id: int, body: SupplierUpdate, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.update_supplier(db, vendor_id, body, user)


@supplier_register.delete("/{vendor_id}", response_model=SupplierOut)
async def deactivate_supplier(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.deactivate_supplier(db, vendor_id, user)


@supplier_register.post("/{vendor_id}/login", response_model=SupplierOut)
async def issue_supplier_login(
        vendor_id: int, body: SupplierLoginIn = SupplierLoginIn(),
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.issue_login(db, vendor_id, body.username, user)


@supplier_register.post("/{vendor_id}/login/reset", response_model=SupplierOut)
async def reset_supplier_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.reset_login(db, vendor_id, user)


@supplier_register.post("/{vendor_id}/login/disable", response_model=SupplierOut)
async def disable_supplier_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.set_login_active(db, vendor_id, False, user)


@supplier_register.post("/{vendor_id}/login/enable", response_model=SupplierOut)
async def enable_supplier_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.VENDOR_PORTAL_MANAGE))):
    return await suppliers.set_login_active(db, vendor_id, True, user)



# --------------------------------------------------------------------------- #
#  Procurement Demand Pool — item-wise view of outstanding indent demand in
#  the buying chain. Two endpoints: the pool itself (paginated groups) and
#  the stage metadata the UI renders without hardcoding any label or colour.
#  Both gated on `requisition.view`: the pool shows exactly the demand a
#  buyer can already read, never a company-wide total from documents they
#  cannot reach.
# --------------------------------------------------------------------------- #
from app.modules.procurement import demand_pool as dp_procurement  # noqa: E402


@ledger_api.get("/demand-pool/stages", response_model=list[dict])
async def procurement_demand_pool_stages(
        user=Depends(require_permission(perms.REQUISITION_VIEW))):
    """Ordered stage metadata for the procurement demand pool UI strip.

    Served rather than hardcoded so the screen can render stage chips, tooltips
    and deep links without knowing the enum values — rule 12 (`IDENT_STATUS_CONFIG`
    anti-pattern).  The same list drives KPI tiles on the left and row badges on
    the right, so the two can never drift apart.
    """
    return list(dp_procurement.PROCUREMENT_STAGES)


@ledger_api.get("/demand-pool", response_model=dict)
async def procurement_demand_pool(
        params: PageParams = Depends(),
        search: str | None = None,
        item_id: int | None = None,
        warehouse_id: int | None = None,
        project_id: int | None = None,
        stage: str | None = None,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.REQUISITION_VIEW))):
    """Item-wise procurement demand pool.

    Every outstanding indent quantity that is being BOUGHT appears here, grouped
    by item, with each contributing indent line showing which stage its quantity
    is sitting at (TO_SOURCE → MR → REQUISITION → CONSOLIDATION → RFQ → PO).

    When the goods arrive at the warehouse the quantity drops out of this pool
    by itself — nothing is stored, everything is read.

    `?stage=` narrows to one bucket (what a KPI tile click sets) so the tile's
    count and the filtered list it opens can never disagree.
    """
    return await dp_procurement.demand_pool(
        db, params,
        search=search, item_id=item_id,
        warehouse_id=warehouse_id, project_id=project_id,
        stage=stage, user=user,
    )


# One router for main.py, six underneath. The parent adds no prefix of its own, so
# every path stays exactly where it was - no existing PO URL moves.
router = APIRouter()
router.include_router(pos)
router.include_router(requisitions)
router.include_router(consolidations)
router.include_router(rfqs)
router.include_router(ledger_api)
router.include_router(accounts)
router.include_router(supplier_register)
router.include_router(supplier)
