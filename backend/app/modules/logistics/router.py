"""Logistics endpoints: GRN, issues and the transport leg.

No logic — routes call the service (rule 2).

The `/api/carrier/*` block at the bottom is reached from outside the company and
carries no `require_permission`: a carrier holds no RBAC role, so `get_current_vendor`
is the whole guard and every function filters on the carrier id taken from the token.
Same arrangement the supplier portal already uses.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_vendor, require_permission
from app.core.pagination import Page, PageParams
from app.modules.logistics import service
from app.modules.logistics.schemas import (
    ActionIn, AwardIn, DeliverIn, DispatchIn, EventIn, EventOut, GRNCreate,
    GRNListRow, GRNOut, InviteIn, IssueCreate, IssueOut, Option, ProviderIn, QuoteIn,
    QuoteOut, ResolveIn, TRCreate, TRListRow, TROut, TRUpdate,
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


# ---- Transport requests ----
transport_router = APIRouter(prefix="/api/transport")


# The mode rules and the evaluation methods are served, not hardcoded in the screen:
# the form must ask for exactly what the service enforces, and one copy of that rule
# is the only way the two cannot drift.
@transport_router.get("/modes", response_model=list[dict])
async def transport_modes(user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.mode_catalogue()


@transport_router.get("/evaluation-methods", response_model=list[dict])
async def transport_evaluation_methods(
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.evaluation_methods()


@transport_router.get("/carriers", response_model=list[Option])
async def transport_carriers(search: str | None = None,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.carrier_options(db, search)


@transport_router.get("/exceptions", response_model=Page[EventOut])
async def transport_exceptions(
        params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.open_exceptions(db, params)


@transport_router.get("", response_model=Page[TRListRow])
async def list_transport(params: PageParams = Depends(), status: str | None = None,
                         mode: str | None = None, carrier_id: int | None = None,
                         indent_id: int | None = None, search: str | None = None,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.list_trs(db, params, status, mode, carrier_id,
                                  indent_id, search)


@transport_router.post("", response_model=TROut)
async def create_transport(body: TRCreate, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.create_tr(db, body, user)


@transport_router.get("/{tr_id}", response_model=TROut)
async def get_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.get_tr(db, tr_id)


@transport_router.put("/{tr_id}", response_model=TROut)
async def update_transport(tr_id: int, body: TRUpdate,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.update_tr(db, tr_id, body, user)


@transport_router.delete("/{tr_id}")
async def delete_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_DELETE))):
    return await service.delete_tr(db, tr_id, user)


@transport_router.post("/{tr_id}/submit", response_model=TROut)
async def submit_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.submit_tr(db, tr_id, user)


@transport_router.post("/{tr_id}/approve", response_model=TROut)
async def approve_transport(tr_id: int, body: ActionIn = ActionIn(),
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_tr(db, tr_id, "APPROVED", user, body.comments)


@transport_router.post("/{tr_id}/reject", response_model=TROut)
async def reject_transport(tr_id: int, body: ActionIn = ActionIn(),
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_tr(db, tr_id, "REJECTED", user, body.comments)


@transport_router.post("/{tr_id}/cancel", response_model=TROut)
async def cancel_transport(tr_id: int, body: ActionIn = ActionIn(),
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.cancel_tr(db, tr_id, user, body.comments)


@transport_router.post("/{tr_id}/invite", response_model=TROut)
async def invite_carriers(tr_id: int, body: InviteIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.invite_carriers(db, tr_id, body, user)


@transport_router.post("/{tr_id}/quotes/{carrier_id}", response_model=QuoteOut)
async def record_quote(tr_id: int, carrier_id: int, body: QuoteIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.record_quote(db, tr_id, carrier_id, body, user)


@transport_router.get("/{tr_id}/comparison", response_model=dict)
async def transport_comparison(tr_id: int, method: str | None = None,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.comparison(db, tr_id, method)


@transport_router.post("/{tr_id}/award", response_model=TROut)
async def award_transport(tr_id: int, body: AwardIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.award_carrier(db, tr_id, body, user)


@transport_router.post("/{tr_id}/award/approve", response_model=TROut)
async def approve_award(tr_id: int, body: ActionIn = ActionIn(),
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_award(db, tr_id, "APPROVED", user, body.comments)


@transport_router.post("/{tr_id}/award/reject", response_model=TROut)
async def reject_award(tr_id: int, body: ActionIn = ActionIn(),
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_award(db, tr_id, "REJECTED", user, body.comments)


@transport_router.post("/{tr_id}/provider", response_model=TROut)
async def set_provider(tr_id: int, body: ProviderIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.set_provider(db, tr_id, body, user)


@transport_router.post("/{tr_id}/dispatch", response_model=TROut)
async def dispatch_transport(tr_id: int, body: DispatchIn = DispatchIn(),
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.TRANSPORT_TRACK))):
    return await service.dispatch_tr(db, tr_id, body, user)


@transport_router.post("/{tr_id}/events", response_model=EventOut)
async def add_event(tr_id: int, body: EventIn, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.TRANSPORT_TRACK))):
    return await service.add_event(db, tr_id, body, user)


@transport_router.post("/{tr_id}/deliver", response_model=TROut)
async def deliver_transport(tr_id: int, body: DeliverIn = DeliverIn(),
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_TRACK))):
    return await service.deliver_tr(db, tr_id, body, user)


@transport_router.post("/{tr_id}/share-tracking", response_model=TROut)
async def share_tracking(tr_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.TRANSPORT_TRACK))):
    return await service.share_tracking(db, tr_id, user)


@transport_router.post("/{tr_id}/close", response_model=TROut)
async def close_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.TRANSPORT_TRACK))):
    return await service.close_tr(db, tr_id, user)


@transport_router.get("/{tr_id}/history", response_model=list)
async def transport_history(tr_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.history(db, tr_id)


@transport_router.post("/events/{event_id}/resolve", response_model=EventOut)
async def resolve_exception(event_id: int, body: ResolveIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_EXCEPTION))):
    return await service.resolve_exception(db, event_id, body, user)


# ---- The carrier portal ----
#
# No `require_permission` anywhere below: a carrier is a `mst_vendors` row, holds no
# RBAC role and no position. `get_current_vendor` is the guard, and the carrier id
# comes from the token — never from the caller. Login, password change and profile are
# already served by the supplier portal, because a carrier IS a supplier: these routes
# add only the transport work to the same account.
carrier_router = APIRouter(prefix="/api/carrier")


@carrier_router.get("/transport", response_model=Page[TRListRow])
async def carrier_list_transport(params: PageParams = Depends(),
                                 db: AsyncSession = Depends(get_db),
                                 account=Depends(get_current_vendor)):
    return await service.carrier_open_requests(db, account.vendor_id, params)


@carrier_router.get("/transport/{tr_id}", response_model=TROut)
async def carrier_get_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                                account=Depends(get_current_vendor)):
    return await service.carrier_get_request(db, account.vendor_id, tr_id)


@carrier_router.post("/transport/{tr_id}/quote", response_model=QuoteOut)
async def carrier_submit_quote(tr_id: int, body: QuoteIn,
                               db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.carrier_quote(db, account.vendor_id, tr_id, body)


router.include_router(grn_router)
router.include_router(issue_router)
router.include_router(transport_router)
router.include_router(carrier_router)
