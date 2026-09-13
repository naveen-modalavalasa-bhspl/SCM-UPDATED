"""Logistics endpoints: GRN, issues and the transport leg.

No logic — routes call the service (rule 2).

The `/api/carrier/*` block at the bottom is reached from outside the company and
carries no `require_permission`: a carrier holds no RBAC role, so `get_current_vendor`
is the whole guard and every function filters on the carrier id taken from the token.
Same arrangement the supplier portal already uses.
"""
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, get_current_vendor, require_permission
from app.core.pagination import Page, PageParams
from app.modules.logistics import partners, service
from app.modules.logistics.schemas import (
    AcceptQuoteIn, ActionIn, ActivityRow, AwardIn, CarrierAcceptIn, CarrierAckIn,
    CarrierConfirmIn, CarrierDeclineIn, CarrierTrackIn, ConsignmentLink, DeliverIn, DispatchIn, EventIn,
    EventOut, GRNCreate, GRNListRow, GRNOut, InviteIn, IssueCreate, IssueOut, Option,
    PartnerCreate, PartnerLoginIn, PartnerOut, PartnerUpdate, ProviderBoardRow,
    ProviderIn, QuickDispatchIn, QuoteIn, QuoteOut, ResolveIn, ReviseQuoteIn, TRCreate,
    TRListRow, TROut, TRUpdate,
)
from app.platform.rbac import permissions as perms
from app.platform.settings.schemas import AttachmentRead

router = APIRouter(tags=["logistics"])

# ---- GRN ----
grn_router = APIRouter(prefix="/api/grn")


@grn_router.get("", response_model=Page[GRNListRow])
async def list_grn(params: PageParams = Depends(), status: str | None = None,
                   po_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.GRN_VIEW))):
    return await service.list_grn(db, params, status, po_id, user=user)


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
    return await service.list_issues(db, params, user=user)


@issue_router.post("", response_model=IssueOut)
async def create_issue(data: IssueCreate, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ISSUE_CREATE))):
    return await service.create_issue(db, data, user)


@issue_router.post("/{issue_id}/issue", response_model=IssueOut)
async def issue_stock(issue_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ISSUE_ISSUE))):
    return await service.issue_stock(db, issue_id, user)


# ---- Transport requests ----
async def _require_transport_in_scope(request: Request,
                                      db: AsyncSession = Depends(get_db),
                                      user=Depends(get_current_user)):
    """Apply the register's row scope to every staff route carrying a shipment id."""
    tr_id = request.path_params.get("tr_id")
    if tr_id is not None:
        await service.get_tr(db, int(tr_id), user=user)


transport_router = APIRouter(
    prefix="/api/transport", dependencies=[Depends(_require_transport_in_scope)],
)


# The mode rules and the evaluation methods are served, not hardcoded in the screen:
# the form must ask for exactly what the service enforces, and one copy of that rule
# is the only way the two cannot drift.
@transport_router.get("/modes", response_model=list[dict])
async def transport_modes(user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.mode_catalogue()


# What it travels ON — road, rail, air, sea — and which arrangements each one allows.
# Served for the same reason /modes is: the Dispatch screen narrows the arrangement
# tiles from this table, and it used to narrow them from a constant of its own.
@transport_router.get("/carriage-modes", response_model=list[dict])
async def transport_carriage_modes(
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.carriage_catalogue()


# Which mode SUITS this load (doc E3). Advice only — whatever the desk picks is
# validated by the same rules either way — but it is the backend's advice, so the
# thresholds live in one place instead of being retyped into a screen.
@transport_router.get("/suggest-mode", response_model=dict | None)
async def transport_suggest_mode(
        distance_km: float | None = None, weight_kg: float | None = None,
        packages: int | None = None,
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.mode_suggestion(distance_km, weight_kg, packages)


@transport_router.get("/evaluation-methods", response_model=list[dict])
async def transport_evaluation_methods(
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.evaluation_methods()


# The stepper every transport screen draws. Served for the same reason /modes is:
# a tendered shipment has two stages the others do not, and the screen must not be
# the thing that decides that.
@transport_router.get("/flow", response_model=list[dict])
async def transport_flow(mode: str | None = None,
                         manual_courier: bool = False,
                         user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.flow_catalogue(mode, manual_courier=manual_courier)


@transport_router.get("/summary", response_model=dict)
async def transport_summary(db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.transport_summary(db)


# `ids` as a comma-separated string, not repeated query params: the Consignments
# screen asks about exactly the page it is showing, in one call.
@transport_router.get("/for-consignments", response_model=list[ConsignmentLink])
async def transport_for_consignments(
        ids: str = "", db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    wanted = [int(part) for part in ids.split(",") if part.strip().isdigit()]
    return await service.for_consignments(db, wanted)


# "Where is my material?" — for the person who raised the indent, not for the desk.
# `indent.view` and not a transport code on purpose: a raiser holds no logistics
# permission, and the real check is ownership, done in the service against the indent's
# own requester. The desk's read of the same leg is GET /api/transport.
@transport_router.get("/for-indent/{indent_id}", response_model=list[dict])
async def transport_for_indent(
        indent_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.for_indent(db, indent_id, user)


# Provider Selection's own board. A register rather than a filter on /api/transport:
# it carries the reply counts and the best price on the table, which the transport
# register has no reason to compute for every row it ever shows.
@transport_router.get("/provider-board", response_model=Page[ProviderBoardRow])
async def transport_provider_board(
        params: PageParams = Depends(), status: str | None = None,
        search: str | None = None, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.provider_board(db, params, status, search, user=user)


@transport_router.get("/carriers", response_model=list[Option])
async def transport_carriers(search: str | None = None,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.carrier_options(db, search)


@transport_router.get("/exceptions", response_model=Page[EventOut])
async def transport_exceptions(
        params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.open_exceptions(db, params, user=user)


# The activity ledger: what happened, to which shipment, in the order it happened.
# `dispatch_id` is how the Dispatch screen asks for one consignment's own trail
# without the desk having to know its transport request number.
@transport_router.get("/activity", response_model=Page[ActivityRow])
async def transport_activity(
        params: PageParams = Depends(), search: str | None = None,
        date_from: date | None = None, date_to: date | None = None,
        event_type: str | None = None, only_exceptions: bool = False,
        tr_id: int | None = None, dispatch_id: int | None = None,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.activity_ledger(
        db, params, search=search, date_from=date_from, date_to=date_to,
        event_type=event_type, only_exceptions=only_exceptions, tr_id=tr_id,
        dispatch_id=dispatch_id, user=user)


# Served, never a constant in the screen: a filter offering an event the ledger
# cannot return is a dropdown that silently empties the page.
@transport_router.get("/activity-types", response_model=list[dict])
async def transport_activity_types(
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return service.activity_catalogue()


@transport_router.get("", response_model=Page[TRListRow])
async def list_transport(params: PageParams = Depends(), status: str | None = None,
                         mode: str | None = None, carrier_id: int | None = None,
                         indent_id: int | None = None, search: str | None = None,
                         dispatch_id: int | None = None,
                         source_type: str | None = None,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.list_trs(db, params, status, mode, carrier_id,
                                  indent_id, search, dispatch_id, source_type,
                                  user=user)


@transport_router.post("", response_model=TROut)
async def create_transport(body: TRCreate, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.create_tr(db, body, user)


# The Dispatch screen: mode, provider, go. One call, because on the floor it is one
# decision — see service.dispatch_consignment.
@transport_router.post("/dispatch-consignment", response_model=TROut)
async def dispatch_consignment(body: QuickDispatchIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.dispatch_consignment(db, body, user)


@transport_router.get("/dispatch-policy")
async def dispatch_policy(db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    """The slice of Company Settings the dispatch form needs to render safely.

    Company Settings itself remains admin-only; dispatchers need only which courier
    form applies and which of its boxes are compulsory, never the company's
    addresses, notification settings, or other admin data.
    """
    return await service.dispatch_policy(db)


# `{tr_id:int}` on the three single-segment routes, not a bare `{tr_id}`. A literal
# one-word path under this prefix (`/carriers`, `/provider-board`, whatever is added
# next) is otherwise matched by these the moment it is declared below them, and the
# caller gets "tr_id: Input should be a valid integer" for a route that plainly exists.
# The convertor restricts the pattern to digits, so the match is decided by the SHAPE
# of the path rather than by declaration order — which is not something the next person
# adding an endpoint should have to know.
@transport_router.get("/{tr_id:int}", response_model=TROut)
async def get_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.get_tr(db, tr_id, user=user)


@transport_router.get("/{tr_id:int}/receipt-evidence",
                      response_model=list[AttachmentRead])
async def transport_receipt_evidence(
        tr_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.receipt_evidence(db, tr_id)


@transport_router.get("/{tr_id:int}/receipt-evidence/{attachment_id:int}/download")
async def download_transport_receipt_evidence(
        tr_id: int, attachment_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    path, file_name, media_type = await service.receipt_evidence_file(
        db, tr_id, attachment_id)
    return FileResponse(path, filename=file_name, media_type=media_type)


@transport_router.get("/{tr_id:int}/documents", response_model=list[AttachmentRead])
async def transport_documents(
        tr_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    return await service.list_documents(db, tr_id)


@transport_router.post("/{tr_id:int}/documents", response_model=AttachmentRead,
                       status_code=201)
async def upload_transport_document(
        tr_id: int, doc_category: str = Form(...), file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.add_document(db, tr_id, file, doc_category, user)


@transport_router.get("/{tr_id:int}/documents/{attachment_id:int}/download")
async def download_transport_document(
        tr_id: int, attachment_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.TRANSPORT_VIEW))):
    path, file_name, media_type = await service.document_file(db, tr_id, attachment_id)
    return FileResponse(path, filename=file_name, media_type=media_type)


@transport_router.put("/{tr_id:int}", response_model=TROut)
async def update_transport(tr_id: int, body: TRUpdate,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.update_tr(db, tr_id, body, user)


# The same press as `/dispatch-consignment`, on a leg that already exists — a return's
# draft is raised by the returns module the moment the return reaches logistics, so
# there is nothing to create and the dispatch board would otherwise have had no button
# on it. See service.dispatch_leg.
@transport_router.post("/{tr_id:int}/dispatch-leg", response_model=TROut)
async def dispatch_leg(tr_id: int, body: TRUpdate,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.dispatch_leg(db, tr_id, body, user)


@transport_router.delete("/{tr_id:int}")
async def delete_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_DELETE))):
    return await service.delete_tr(db, tr_id, user)


@transport_router.post("/{tr_id}/submit", response_model=TROut)
async def submit_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_CREATE))):
    return await service.submit_tr(db, tr_id, user)


@transport_router.post("/{tr_id}/approve", response_model=TROut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve_transport(tr_id: int, body: ActionIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_tr(db, tr_id, "APPROVED", user, body.comments)


@transport_router.post("/{tr_id}/reject", response_model=TROut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject_transport(tr_id: int, body: ActionIn,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_tr(db, tr_id, "REJECTED", user, body.comments)


@transport_router.post("/{tr_id}/cancel", response_model=TROut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def cancel_transport(tr_id: int, body: ActionIn,
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


@transport_router.post("/{tr_id}/accept-quote", response_model=TROut)
async def accept_quote(tr_id: int, body: AcceptQuoteIn = AcceptQuoteIn(),
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.accept_quote(db, tr_id, body.quote_id, user)


@transport_router.post("/{tr_id}/ask-revised-quote", response_model=TROut)
async def ask_revised_quote(tr_id: int, body: ReviseQuoteIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.ask_revised_quote(db, tr_id, body.note, user)


@transport_router.post("/{tr_id}/award/approve", response_model=TROut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve_award(tr_id: int, body: ActionIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_award(db, tr_id, "APPROVED", user, body.comments)


@transport_router.post("/{tr_id}/award/reject", response_model=TROut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject_award(tr_id: int, body: ActionIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.TRANSPORT_APPROVE))):
    return await service.act_on_award(db, tr_id, "REJECTED", user, body.comments)


# The carrier's own answer to an award lands on the portal routes at the bottom.
# This one is the desk confirming a phone call on their behalf — same transition,
# recorded as what it is so the two can never be confused.
@transport_router.post("/{tr_id}/carrier-confirm", response_model=TROut)
async def confirm_carrier(tr_id: int, body: CarrierConfirmIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.accept_award(db, tr_id, None, body.carrier_reference, user,
                                      confirmed_by_desk=body.confirmed_by)


@transport_router.post("/{tr_id}/carrier-declined", response_model=TROut)
async def carrier_declined(tr_id: int, body: CarrierDeclineIn,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.TRANSPORT_AWARD))):
    return await service.decline_award(db, tr_id, None, body.reason, user)


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
#
# Declared without a prefix and mounted TWICE, at /api/carrier and at /api/supplier.
# The vendor token lives under its own key in the browser and the axios interceptor
# picks it by URL — everything under /api/supplier gets the vendor token, everything
# else gets the employee one. Serving the same functions at both addresses is what
# lets the carrier screens use the portal token without the shared client having to
# learn a second prefix, and /api/carrier stays live for anything already calling it.
carrier_router = APIRouter()


@carrier_router.get("/transport", response_model=Page[TRListRow])
async def carrier_list_transport(params: PageParams = Depends(),
                                 status: str | None = None,
                                 db: AsyncSession = Depends(get_db),
                                 account=Depends(get_current_vendor)):
    return await service.carrier_open_requests(db, account.vendor_id, params, status)


@carrier_router.get("/transport-summary", response_model=dict)
async def carrier_transport_summary(db: AsyncSession = Depends(get_db),
                                    account=Depends(get_current_vendor)):
    return await service.carrier_summary(db, account.vendor_id)


@carrier_router.get("/transport/{tr_id}", response_model=TROut)
async def carrier_get_transport(tr_id: int, db: AsyncSession = Depends(get_db),
                                account=Depends(get_current_vendor)):
    return await service.carrier_view_request(db, account.vendor_id, tr_id)


@carrier_router.post("/transport/{tr_id}/quote", response_model=QuoteOut)
async def carrier_submit_quote(tr_id: int, body: QuoteIn,
                               db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.carrier_quote(db, account.vendor_id, tr_id, body)


@carrier_router.post("/transport/{tr_id}/accept", response_model=TROut)
async def carrier_accept_job(tr_id: int, body: CarrierAcceptIn = CarrierAcceptIn(),
                             db: AsyncSession = Depends(get_db),
                             account=Depends(get_current_vendor)):
    return await service.carrier_accept(db, account.vendor_id, tr_id, body)


@carrier_router.post("/transport/{tr_id}/acknowledge", response_model=TROut)
async def carrier_acknowledge_job(tr_id: int, body: CarrierAckIn,
                                  db: AsyncSession = Depends(get_db),
                                  account=Depends(get_current_vendor)):
    return await service.carrier_acknowledge(db, account.vendor_id, tr_id, body)


@carrier_router.post("/transport/{tr_id}/decline", response_model=TROut)
async def carrier_decline_job(tr_id: int, body: CarrierDeclineIn,
                              db: AsyncSession = Depends(get_db),
                              account=Depends(get_current_vendor)):
    return await service.carrier_decline(db, account.vendor_id, tr_id, body)


@carrier_router.post("/transport/{tr_id}/tracking", response_model=TROut)
async def carrier_add_tracking(tr_id: int, body: CarrierTrackIn,
                               db: AsyncSession = Depends(get_db),
                               account=Depends(get_current_vendor)):
    return await service.carrier_track(db, account.vendor_id, tr_id, body)


@carrier_router.post("/transport/{tr_id}/deliver", response_model=TROut)
async def carrier_deliver_job(tr_id: int, body: DeliverIn = DeliverIn(),
                              db: AsyncSession = Depends(get_db),
                              account=Depends(get_current_vendor)):
    return await service.carrier_deliver(db, account.vendor_id, tr_id, body)


# ---- The logistics vendor register ----
#
# Under Settings, not Logistics: it mints an identity outside the company, which is an
# administrator's act rather than a dispatcher's — the same reasoning that put
# Supplier & Carrier Logins there. Every route is guarded, and `partners._partner`
# refuses any vendor row that is not a carrier, so this permission can never reach a
# material supplier's record.
partner_router = APIRouter(prefix="/api/logistics-vendors", tags=["logistics-vendors"])


@partner_router.get("/types", response_model=list[dict])
async def logistics_vendor_types(
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_VIEW))):
    """Served, not duplicated in the screen: a type the form offers that Dispatch
    does not accept would create a partner nobody can ship with."""
    return partners.partner_types()


@partner_router.get("/summary", response_model=dict)
async def logistics_vendor_summary(
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_VIEW))):
    return await partners.partner_summary(db)


@partner_router.get("", response_model=Page[PartnerOut])
async def list_logistics_vendors(
        params: PageParams = Depends(), search: str | None = None,
        vendor_type: str | None = None, active_only: bool = False,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_VIEW))):
    return await partners.list_partners(db, params, search, vendor_type, active_only)


@partner_router.post("", response_model=PartnerOut, status_code=201)
async def create_logistics_vendor(
        body: PartnerCreate, background_tasks: BackgroundTasks,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.create_partner(db, body, user, background_tasks)


@partner_router.get("/{vendor_id}", response_model=PartnerOut)
async def get_logistics_vendor(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_VIEW))):
    return await partners.get_partner(db, vendor_id)


@partner_router.put("/{vendor_id}", response_model=PartnerOut)
async def update_logistics_vendor(
        vendor_id: int, body: PartnerUpdate, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.update_partner(db, vendor_id, body, user)


@partner_router.delete("/{vendor_id}", response_model=PartnerOut)
async def deactivate_logistics_vendor(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.deactivate_partner(db, vendor_id, user)


@partner_router.post("/{vendor_id}/login", response_model=PartnerOut)
async def issue_logistics_vendor_login(
        vendor_id: int, background_tasks: BackgroundTasks,
        body: PartnerLoginIn = PartnerLoginIn(),
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.issue_login(
        db, vendor_id, body.username, user, background_tasks)


@partner_router.post("/{vendor_id}/login/reset", response_model=PartnerOut)
async def reset_logistics_vendor_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.reset_login(db, vendor_id, user)


@partner_router.post("/{vendor_id}/login/disable", response_model=PartnerOut)
async def disable_logistics_vendor_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.set_login_active(db, vendor_id, False, user)


@partner_router.post("/{vendor_id}/login/enable", response_model=PartnerOut)
async def enable_logistics_vendor_login(
        vendor_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.LOGISTICS_PARTNER_MANAGE))):
    return await partners.set_login_active(db, vendor_id, True, user)


router.include_router(grn_router)
router.include_router(issue_router)
router.include_router(transport_router)
router.include_router(partner_router)
router.include_router(carrier_router, prefix="/api/carrier", tags=["carrier-portal"])
router.include_router(carrier_router, prefix="/api/supplier", tags=["carrier-portal"])
