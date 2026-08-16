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
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_vendor, require_permission
from app.core.pagination import Page, PageParams
from app.modules.procurement import service
from app.modules.procurement.schemas import (
    ActionIn, AwardIn, ConsolidationCreate, ConsolidationLinesIn,
    ConsolidationListRow, ConsolidationOut, ConsolidationSourceOut, POCreate,
    POListRow, POOut, QuoteListRow, QuoteOut, QuoteSubmit, ReqCreate, ReqListRow,
    ReqOut, RFQCreate, RFQListRow, RFQOut, RFQUpdate, VendorAccountIn,
    VendorAccountOut, VendorLoginIn, VendorPasswordIn, VendorProfileOut,
    VendorTokenOut,
)
from app.platform.rbac import permissions as perms
from app.shared.enums import ApprovalAction

pos = APIRouter(prefix="/api/pos", tags=["procurement"])
requisitions = APIRouter(prefix="/api/requisitions", tags=["procurement"])
consolidations = APIRouter(prefix="/api/consolidations", tags=["procurement"])
rfqs = APIRouter(prefix="/api/rfqs", tags=["procurement"])
supplier = APIRouter(prefix="/api/supplier", tags=["supplier-portal"])
# Its own prefix, not /api/rfqs/portal/…: `/api/rfqs/{rfq_id}` is int-typed and is
# declared first, so a literal "portal" segment there would 422 rather than fall
# through to the account routes.
accounts = APIRouter(prefix="/api/supplier-accounts", tags=["supplier-portal"])


@pos.get("", response_model=Page[POListRow])
async def list_pos(params: PageParams = Depends(), status: str | None = None,
                   vendor_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.PO_VIEW))):
    return await service.list_pos(db, params, status, vendor_id, user=user)


@pos.get("/open-for-grn", response_model=Page[POListRow])
async def open_for_grn(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.PO_VIEW))):
    return await service.open_for_grn(db, params)


@pos.post("/from-indent/{indent_id}", response_model=POOut)
async def create_from_indent(indent_id: int, data: POCreate, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.PO_CREATE))):
    return await service.create_po_from_indent(db, indent_id, data, user)


@pos.get("/{po_id}", response_model=POOut)
async def get_one(po_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_VIEW))):
    return await service.get_po(db, po_id, user=user)


@pos.post("/{po_id}/submit", response_model=POOut)
async def submit(po_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.PO_SUBMIT))):
    return await service.submit_po(db, po_id, user)


@pos.post("/{po_id}/approve", response_model=POOut)
async def approve(po_id: int, body: ActionIn = ActionIn(), db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.PO_APPROVE))):
    return await service.act_on_po(db, po_id, "APPROVE", body.comments, user)


@pos.post("/{po_id}/reject", response_model=POOut)
async def reject(po_id: int, body: ActionIn = ActionIn(), db: AsyncSession = Depends(get_db),
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
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.list_requisitions(db, params, status, user=user)


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


@requisitions.get("/{req_id}", response_model=ReqOut)
async def get_requisition(req_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.REQUISITION_VIEW))):
    return await service.get_requisition(db, req_id, user=user)


@requisitions.put("/{req_id}", response_model=ReqOut)
async def update_requisition(req_id: int, body: ReqCreate,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.update_requisition(db, req_id, body, user)


@requisitions.post("/{req_id}/submit", response_model=ReqOut)
async def submit_requisition(req_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.REQUISITION_CREATE))):
    return await service.submit_requisition(db, req_id, user)


@requisitions.post("/{req_id}/approve", response_model=ReqOut)
async def approve_requisition(req_id: int, body: ActionIn = ActionIn(),
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.REQUISITION_APPROVE))):
    return await service.act_on_requisition(
        db, req_id, ApprovalAction.APPROVED.value, body.comments, user)


@requisitions.post("/{req_id}/reject", response_model=ReqOut)
async def reject_requisition(req_id: int, body: ActionIn = ActionIn(),
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
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.RFQ_VIEW))):
    return await service.list_rfqs(db, params, status, user=user)


@rfqs.post("", response_model=RFQOut, status_code=201)
async def create_rfq(body: RFQCreate, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.create_rfq(db, body, user)


# Declared above `/{rfq_id}`: a literal segment has to be matched before the int-typed
# catch-all, or "quotations" is parsed as an RFQ id and 422s.
@rfqs.get("/quotations", response_model=Page[QuoteListRow])
async def list_quotations(params: PageParams = Depends(), rfq_id: int | None = None,
                          vendor_id: int | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.RFQ_COMPARE))):
    return await service.list_quotations(db, params, rfq_id, vendor_id)


@rfqs.get("/quotations/{quote_id}", response_model=QuoteOut)
async def get_quotation(quote_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.RFQ_COMPARE))):
    return await service.get_quotation(db, quote_id)


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
    return await service.get_rfq(db, rfq_id, user=user)


@rfqs.put("/{rfq_id}", response_model=RFQOut)
async def update_rfq(rfq_id: int, body: RFQUpdate, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.update_rfq(db, rfq_id, body, user)


@rfqs.post("/{rfq_id}/submit", response_model=RFQOut)
async def submit_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.RFQ_CREATE))):
    return await service.submit_rfq(db, rfq_id, user)


@rfqs.post("/{rfq_id}/approve", response_model=RFQOut)
async def approve_rfq(rfq_id: int, body: ActionIn = ActionIn(),
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.RFQ_APPROVE))):
    """Approving publishes it: the vendors can see the RFQ from this moment."""
    return await service.act_on_rfq(
        db, rfq_id, ApprovalAction.APPROVED.value, body.comments, user)


@rfqs.post("/{rfq_id}/reject", response_model=RFQOut)
async def reject_rfq(rfq_id: int, body: ActionIn = ActionIn(),
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
async def vendor_login(body: VendorLoginIn, db: AsyncSession = Depends(get_db)):
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


@supplier.get("/rfqs", response_model=Page[RFQListRow])
async def vendor_list_rfqs(params: PageParams = Depends(),
                           db: AsyncSession = Depends(get_db),
                           account=Depends(get_current_vendor)):
    return await service.vendor_list_rfqs(db, account.vendor_id, params)


@supplier.get("/rfqs/{rfq_id}", response_model=RFQOut)
async def vendor_get_rfq(rfq_id: int, db: AsyncSession = Depends(get_db),
                         account=Depends(get_current_vendor)):
    return await service.vendor_get_rfq(db, account.vendor_id, rfq_id)


@supplier.get("/rfqs/{rfq_id}/quotation", response_model=QuoteOut)
async def vendor_get_quotation(rfq_id: int, db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.vendor_get_quotation(db, account.vendor_id, rfq_id)


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


@consolidations.get("", response_model=Page[ConsolidationListRow])
async def list_consolidations(params: PageParams = Depends(),
                              status: str | None = None,
                              project_id: int | None = None,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.list_consolidations(db, params, status, project_id)


@consolidations.post("", response_model=ConsolidationOut, status_code=201)
async def create_consolidation(body: ConsolidationCreate,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.create_consolidation(db, body, user)


@consolidations.get("/{cons_id}", response_model=ConsolidationOut)
async def get_consolidation(cons_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.get_consolidation(db, cons_id)


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
    return await service.consolidation_sources(db, cons_id)


@consolidations.get("/{cons_id}/history", response_model=list)
async def consolidation_history(cons_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_VIEW))):
    return await service.consolidation_history(db, cons_id)


@consolidations.post("/{cons_id}/submit", response_model=ConsolidationOut)
async def submit_consolidation(cons_id: int, db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.submit_consolidation(db, cons_id, user)


@consolidations.post("/{cons_id}/approve", response_model=ConsolidationOut)
async def approve_consolidation(cons_id: int, body: ActionIn = ActionIn(),
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.CONSOLIDATION_APPROVE))):
    return await service.act_on_consolidation(
        db, cons_id, ApprovalAction.APPROVED.value, body.comments, user)


@consolidations.post("/{cons_id}/reject", response_model=ConsolidationOut)
async def reject_consolidation(cons_id: int, body: ActionIn = ActionIn(),
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_APPROVE))):
    return await service.act_on_consolidation(
        db, cons_id, ApprovalAction.REJECTED.value, body.comments, user)


@consolidations.post("/{cons_id}/cancel", response_model=ConsolidationOut)
async def cancel_consolidation(cons_id: int, body: ActionIn = ActionIn(),
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.CONSOLIDATION_CREATE))):
    return await service.cancel_consolidation(db, cons_id, user, body.comments)


# One router for main.py, six underneath. The parent adds no prefix of its own, so
# every path stays exactly where it was - no existing PO URL moves.
router = APIRouter()
router.include_router(pos)
router.include_router(requisitions)
router.include_router(consolidations)
router.include_router(rfqs)
router.include_router(accounts)
router.include_router(supplier)
