"""Indents endpoints. No logic here — every route calls the service."""
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import NotFoundError
from app.core.dependencies import require_permission, require_permission_or
from app.core.pagination import Page, PageParams
from app.platform.rbac import permissions as perms
from app.platform.settings import attachments
from app.platform.settings.schemas import AttachmentRead
from app.modules.indents import service
from app.modules.indents.enums import (
    AcknowledgmentStatus, ApprovalAction, IndentActivityType, IndentStatus,
    IndentType, MaterialDirection, Priority,
)
from app.modules.indents.schemas import (
    AcknowledgeIn, AcknowledgmentRow, ActionIn, ActivityRow, IndentCreate, IndentListRow,
    ReturnForCorrectionIn, ReturnTargetOut,
    IndentJourneyOut, IndentNotificationRow, IndentOut, IndentStatsOut, IndentUpdate,
    MonthlyCopyIn, MonthlySubmitIn, StrSourceOption,
)
# Allocation is a decision about an indent, so its endpoints live here. The
# mechanics are in modules/inventory/allocations.py -- indents may import inventory,
# never the reverse.
from app.modules.inventory.schemas import (
    AllocApproveIn, AllocationBatchIn, AllocationBatchOut,
    AllocationHistoryBatchIn, AllocationIn, AllocationLineAvailability,
    AllocationListRow, AllocationOut,
)
from app.modules.inventory.schemas import ActionIn as AllocActionIn
from app.modules.inventory.schemas import AllocBatchActionIn
from datetime import date

router = APIRouter(tags=["indents"])
indent_router = APIRouter(prefix="/api/indents")


@indent_router.get("", response_model=Page[IndentListRow])
async def list_indents(params: PageParams = Depends(), search: str | None = None,
                       created_date_from: date | None = None,
                       created_date_to: date | None = None,
                       start_date: date | None = None,
                       end_date: date | None = None,
                       required_by_from: date | None = None,
                       required_by_to: date | None = None,
                       status: list[IndentStatus] | None = Query(None),
                       priority: list[Priority] | None = Query(None),
                       indent_type: list[IndentType] | None = Query(None),
                       department_id: list[int] | None = Query(None),
                       region_id: list[int] | None = Query(None),
                       region_unassigned: bool = False,
                       is_bookmarked: str | None = None,
                       # "Still owes something": approved_qty > allocated_qty on at
                       # least one line. What the fulfilment queue actually means, and
                       # the only honest way to ask it now that an approver can serve
                       # part of an indent from their own point.
                       has_remainder: bool = False,
                       # The fulfilment queue's own narrowing: work that is MINE to
                       # serve. Drops an indent still in approval unless it is parked on
                       # this login — a rung that has already approved and passed it on
                       # keeps reading it everywhere else, but it is not their job any
                       # more. Off by default, so /indents itself is unchanged.
                       to_serve: bool = False,
                       sort_by: str = "created_at", sort_dir: str = "desc",
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.list_indents(
        db, params, search=search, has_remainder=has_remainder, to_serve=to_serve,
        date_from=created_date_from or start_date,
        date_to=created_date_to or end_date,
        required_by_from=required_by_from, required_by_to=required_by_to,
        statuses=status, priorities=priority, indent_types=indent_type,
        department_ids=department_id, region_ids=region_id,
        include_unassigned_region=region_unassigned,
        is_bookmarked=is_bookmarked, sort_by=sort_by, sort_dir=sort_dir, user=user,
    )


# Inventory > Stock Transfer's Requests tab. An STR is an indent underneath, but the
# list is the transfer screen's, so it is guarded by `stock.transfer.view` rather than
# by all of Indents. Registered above `/{indent_id}`, which would otherwise match it.
@indent_router.get("/stock-transfer-requests", response_model=Page[IndentListRow])
async def list_stock_transfer_requests(params: PageParams = Depends(),
                                       search: str | None = None,
                                       created_date_from: date | None = None,
                                       created_date_to: date | None = None,
                                       status: list[IndentStatus] | None = Query(None),
                                       # The To serve tab: what is still owed, and mine
                                       # to serve — the Fulfilment Queue's own filters.
                                       has_remainder: bool = False,
                                       to_serve: bool = False,
                                       source_warehouse_id: int | None = None,
                                       db: AsyncSession = Depends(get_db),
                                       user=Depends(require_permission_or(
                                           perms.STOCK_TRANSFER_VIEW,
                                           perms.STOCK_TRANSFER_SERVE,
                                           service.anywhere_in_reach))):
    return await service.list_indents(
        db, params, search=search, date_from=created_date_from,
        date_to=created_date_to, statuses=status, has_remainder=has_remainder,
        to_serve=to_serve, indent_types=[IndentType.STR], user=user,
        source_warehouse_id=source_warehouse_id,
    )


@indent_router.get("/stock-transfer-requests/sources")
async def stock_transfer_request_sources(db: AsyncSession = Depends(get_db),
                                         user=Depends(require_permission_or(
                                             perms.STOCK_TRANSFER_VIEW,
                                             perms.STOCK_TRANSFER_SERVE,
                                             service.anywhere_in_reach))):
    """The source points named on the STRs this login can read — the Source filter."""
    return await service.str_sources_in_use(db, user)


@indent_router.get("/approved-pending-po", response_model=Page[IndentListRow])
async def approved_pending_po(params: PageParams = Depends(),
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.approved_pending_po(db, params, user=user)


@indent_router.get("/stats", response_model=IndentStatsOut)
async def stats(search: str | None = None, created_date_from: date | None = None,
                created_date_to: date | None = None, start_date: date | None = None,
                end_date: date | None = None, required_by_from: date | None = None,
                required_by_to: date | None = None,
                status: list[IndentStatus] | None = Query(None),
                priority: list[Priority] | None = Query(None),
                indent_type: list[IndentType] | None = Query(None),
                department_id: list[int] | None = Query(None),
                region_id: list[int] | None = Query(None),
                region_unassigned: bool = False,
                is_bookmarked: str | None = None,
                db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.indent_stats(
        db, search=search, date_from=created_date_from or start_date,
        date_to=created_date_to or end_date, required_by_from=required_by_from,
        required_by_to=required_by_to, statuses=status, priorities=priority,
        indent_types=indent_type,
        department_ids=department_id, region_ids=region_id,
        include_unassigned_region=region_unassigned,
        is_bookmarked=is_bookmarked, user=user,
    )


@indent_router.get("/activity", response_model=Page[ActivityRow])
async def activity(params: PageParams = Depends(), search: str | None = None,
                   date_from: date | None = None, date_to: date | None = None,
                   required_from: date | None = None,
                   required_to: date | None = None,
                   item_id: int | None = None,
                   status: list[IndentStatus] | None = Query(None),
                   priority: list[Priority] | None = Query(None),
                   region_id: list[int] | None = Query(None),
                   region_unassigned: bool = False,
                   transaction_type: IndentActivityType | None = None,
                   direction: MaterialDirection | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.activity_ledger(db, params, user=user, search=search, date_from=date_from,
        date_to=date_to, required_from=required_from, required_to=required_to,
        item_id=item_id, statuses=status, priorities=priority,
        region_ids=region_id, include_unassigned_region=region_unassigned,
        transaction_type=transaction_type, direction=direction)


@indent_router.get("/acknowledgments", response_model=Page[AcknowledgmentRow])
async def acknowledgments(params: PageParams = Depends(), search: str | None = None,
                          date_from: date | None = None, date_to: date | None = None,
                          start_date: date | None = None, end_date: date | None = None,
                          required_from: date | None = None,
                          required_to: date | None = None,
                          status: list[AcknowledgmentStatus] | None = Query(None),
                          priority: list[Priority] | None = Query(None),
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.INDENT_ACKNOWLEDGE))):
    return await service.list_acknowledgments(
        db, params, search=search, date_from=date_from or start_date,
        date_to=date_to or end_date, required_from=required_from,
        required_to=required_to, statuses=status, priorities=priority, user=user,
    )


@indent_router.get("/notifications", response_model=Page[IndentNotificationRow])
async def notifications(params: PageParams = Depends(), search: str | None = None,
                        date_from: date | None = None, date_to: date | None = None,
                        status: list[IndentStatus] | None = Query(None),
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.list_notifications(
        db, params, user, search=search, date_from=date_from, date_to=date_to,
        statuses=status,
    )


@indent_router.post("", response_model=IndentOut)
async def create(data: IndentCreate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission_or(
        perms.INDENT_CREATE, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    return await service.create_indent(db, data, user)


# --- raising a monthly cycle in bulk ---------------------------------------
# Declared above /{indent_id}: "monthly" is not an int, but FastAPI matches in
# declaration order and a static path behind a typed one is a 422 waiting to happen.

@indent_router.get("/monthly/last-cycle")
async def last_monthly_cycle(db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.INDENT_CREATE))):
    """What this person raised last month, ready to reuse."""
    return await service.last_monthly_cycle(db, user)


@indent_router.post("/monthly/copy", response_model=IndentOut)
async def copy_monthly_cycle(body: MonthlyCopyIn = MonthlyCopyIn(),
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.INDENT_CREATE))):
    """Last month's indent again, as an editable DRAFT."""
    return await service.copy_monthly_cycle(
        db, user, required_date=body.required_date, remarks=body.remarks,
        overrides={int(k): v for k, v in (body.overrides or {}).items()})


@indent_router.post("/monthly/submit")
async def submit_monthly_cycle(body: MonthlySubmitIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.INDENT_SUBMIT))):
    """Submit several drafts at once. One workflow instance each."""
    return await service.submit_monthly_cycle(db, user, body.indent_ids)


@indent_router.get("/options/offices")
async def office_options(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_VIEW, service.anywhere_in_reach))):
    return await service.list_office_options(db)


@indent_router.get("/options/regions")
async def region_options(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_VIEW, service.anywhere_in_reach))):
    return await service.list_region_options(db, user)


@indent_router.get("/options/str-sources", response_model=list[StrSourceOption])
async def str_source_options(db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.STOCK_TRANSFER_REQUEST))):
    """Where an STR may ask stock to come from: the points held at the raiser's rank."""
    return await service.str_source_options(db, user)


@indent_router.get("/options/vehicles")
async def vehicle_options(search: str | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_VIEW, service.anywhere_in_reach))):
    return await service.vehicle_options(db, search)


# MOVED ABOVE `/{indent_id}` on 2026-08-23, and it must stay here.
#
# FastAPI matches routes in DECLARATION order and `/{indent_id}` matches any single
# segment, so while this sat below it every call to /api/indents/eligible-items was
# routed into `get_one`, which tried to read the word "eligible-items" as an int and
# answered 422. The indent item picker therefore returned nothing at all, on every
# load, for everyone — 4,941 logged 422s worth of it — and it looked exactly like an
# item-eligibility problem, which is the wrong place anybody would go looking.
#
# Same trap `shared/masters/router.py` already documents for `/{row_id}`: a literal
# segment has to be declared BEFORE the typed catch-all that would swallow it.
@indent_router.get("/eligible-items")
async def eligible_items(search: str | None = None, limit: int = 500,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission_or(
        perms.INDENT_CREATE, perms.STOCK_TRANSFER_REQUEST, service.anywhere_in_reach))):
    """The items THIS requester may raise an indent for.

    Its own endpoint rather than a filter on `/api/masters/items`: that one is the
    shared item master, read by masters screens, procurement and the warehouse, and
    narrowing it for everybody would break every one of them. This narrows only the
    indent picker.

    Gated on `indent.create` — the list answers "what may I ask for", so it is exactly
    as sensitive as raising an indent. It NARROWS the master and never widens it, and
    the write path checks again (`eligibility.assert_items_allowed`), because the
    picker is advice and the server is the gate (rule 6).
    """
    return await service.eligible_items(db, user, search=search,
                                        limit=min(max(limit, 1), 1000))


@indent_router.get("/eligible-bom-items")
async def eligible_bom_items(bom_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.INDENT_CREATE))):
    """BOM lines this requester may add to an indent."""
    return await service.eligible_bom_items(db, user, bom_id)


@indent_router.get("/{indent_id}", response_model=IndentOut)
async def get_one(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_VIEW, service.str_in_reach))):
    return await service.get_indent(db, indent_id, user)


@indent_router.get("/{indent_id}/journey", response_model=IndentJourneyOut)
async def journey(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_VIEW, service.str_in_reach))):
    return await service.indent_journey(db, indent_id, user)


@indent_router.put("/{indent_id}", response_model=IndentOut)
async def update(indent_id: int, data: IndentUpdate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    return await service.update_indent(db, indent_id, data, user)


@indent_router.delete("/{indent_id}", status_code=204)
async def delete_draft(indent_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    await service.delete_indent(db, indent_id, user)


@indent_router.post("/{indent_id}/submit", response_model=IndentOut)
async def submit(indent_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission_or(
        perms.INDENT_SUBMIT, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    return await service.submit_indent(db, indent_id, user)


@indent_router.get("/{indent_id}/return-targets", response_model=list[ReturnTargetOut])
async def return_targets(indent_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission_or(
        perms.INDENT_APPROVE,
        (perms.INDENT_VIEW, perms.STOCK_TRANSFER_STR_APPROVE, perms.STOCK_TRANSFER_REQUEST),
        service.anywhere_in_reach))):
    """The earlier steps this person may send the indent back to: an approver returning
    it, or the correction owner passing it further back. The service decides which, and
    answers with nothing for anybody who may do neither."""
    return await service.get_indent_return_targets(db, indent_id, user)


@indent_router.post("/{indent_id}/return-for-correction", response_model=IndentOut)
async def return_for_correction(indent_id: int, body: ReturnForCorrectionIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission_or(
        perms.INDENT_APPROVE, perms.STOCK_TRANSFER_STR_APPROVE, service.str_in_reach))):
    return await service.return_indent_for_correction(
        db, indent_id, body.comments, user, target_sequence=body.target_sequence,
    )


@indent_router.post("/{indent_id}/send-correction-back", response_model=IndentOut)
async def send_correction_back(indent_id: int, body: ReturnForCorrectionIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    return await service.send_indent_correction_back(
        db, indent_id, body.comments, user, target_sequence=body.target_sequence,
    )


@indent_router.post("/{indent_id}/resubmit-correction", response_model=IndentOut)
async def resubmit_correction(indent_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission_or(
        perms.INDENT_VIEW, perms.STOCK_TRANSFER_REQUEST, service.str_in_reach))):
    return await service.resubmit_indent_correction(db, indent_id, user)


@indent_router.post("/{indent_id}/acknowledge", response_model=IndentOut)
async def acknowledge(indent_id: int, body: AcknowledgeIn,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission_or(
        perms.INDENT_ACKNOWLEDGE, perms.STOCK_TRANSFER_RECEIVE, service.str_in_reach))):
    lines = {line.indent_item_id: Decimal(str(line.received_quantity))
             for line in body.lines}
    return await service.acknowledge_receipt(
        db, indent_id, lines, user, condition=body.condition, remarks=body.remarks,
        package_receipts={line.indent_item_id: line.package_receipts or {}
                          for line in body.lines},
        rejections={line.indent_item_id: [r.model_dump() for r in line.rejections]
                    for line in body.lines if line.rejections})


@indent_router.get("/{indent_id}/receipt-attachments", response_model=list[AttachmentRead])
async def receipt_attachments(indent_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission_or(
        perms.INDENT_VIEW,
        (perms.STOCK_TRANSFER_RECEIVE, perms.STOCK_TRANSFER_VIEW), service.str_in_reach))):
    # `get_indent` first — the same visibility check the download route beside this one
    # already ran. Without it `indent.view` listed the file names, uploaders and
    # timestamps on every indent in the company, including the ones this login's own
    # scope hides from the register two screens away.
    await service.get_indent(db, indent_id, user)
    return await attachments.list_attachments(db, service.ACK_ENTITY_TYPE, indent_id)


@indent_router.post("/{indent_id}/receipt-attachments", response_model=AttachmentRead,
                    status_code=201)
async def upload_receipt_attachment(
    indent_id: int, file: UploadFile = File(...),
    doc_category: str = Query(service.ACK_PHOTO_CATEGORY),
    db: AsyncSession = Depends(get_db),
    user=Depends(require_permission_or(
        perms.INDENT_ACKNOWLEDGE, perms.STOCK_TRANSFER_RECEIVE, service.str_in_reach)),
):
    return await service.add_receipt_attachment(
        db, indent_id, file, doc_category=doc_category, user=user)


@indent_router.get("/{indent_id:int}/receipt-attachments/{attachment_id:int}/download")
async def download_receipt_attachment(
    indent_id: int, attachment_id: int, db: AsyncSession = Depends(get_db),
    user=Depends(require_permission_or(
        perms.INDENT_VIEW,
        (perms.STOCK_TRANSFER_RECEIVE, perms.STOCK_TRANSFER_VIEW), service.str_in_reach)),
):
    """The receipt photo or bill itself, for whoever may read the indent it hangs on.

    Nested under the indent on purpose, and `get_indent` is called first: it is the
    module's own visibility check, so an indent this login may not read cannot have its
    paperwork pulled out by walking attachment ids. The attachment must then actually
    belong to THAT indent — without it the id in the path would be decorative and any
    readable indent would unlock every file in the store.
    """
    await service.get_indent(db, indent_id, user)
    row = await db.get(attachments.Attachment, attachment_id)
    if (row is None or row.entity_type != service.ACK_ENTITY_TYPE
            or int(row.entity_id) != indent_id):
        # 404, not 403 — an id that is not yours must not confirm it exists.
        raise NotFoundError(f"Attachment {attachment_id} not found")
    path, file_name, mime_type = await attachments.attachment_file(db, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type)


@indent_router.delete("/receipt-attachments/{attachment_id}", status_code=204)
async def delete_receipt_attachment(
    attachment_id: int, db: AsyncSession = Depends(get_db),
    user=Depends(require_permission_or(
        perms.INDENT_ACKNOWLEDGE, perms.STOCK_TRANSFER_RECEIVE, service.anywhere_in_reach)),
):
    """Withdraw a delivery photo or bill, for the person who filed it.

    FIXED 2026-09-03 — this used to hand `attachment_id` straight to the platform
    delete. `sys_attachments` is one table for every module, so `indent.acknowledge`
    was a licence to delete ANY file in the system: a GRN's invoice, a shipment's way
    bill, another region's QC photographs. The id in the path proved nothing.

    The route is addressed by attachment id (the panel has no indent in hand when it
    renders a row), so the parent is read off the row and then checked properly:
    `service.delete_receipt_attachment` runs the same rule the upload does — the
    raiser of that indent, while it is still expecting goods — because the person who
    may attach the proof is the person who may withdraw it.
    """
    await service.delete_receipt_attachment(db, attachment_id, user)


@indent_router.post("/{indent_id}/bookmark", response_model=IndentOut)
async def bookmark(indent_id: int, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.set_indent_bookmark(db, indent_id, user, is_bookmarked=True)


@indent_router.post("/{indent_id}/unbookmark", response_model=IndentOut)
async def unbookmark(indent_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.INDENT_VIEW))):
    return await service.set_indent_bookmark(db, indent_id, user, is_bookmarked=False)


@indent_router.post("/{indent_id}/approve", response_model=IndentOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def approve(indent_id: int, body: ActionIn,
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission_or(
        perms.INDENT_APPROVE, perms.STOCK_TRANSFER_STR_APPROVE, service.str_in_reach))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.APPROVED, body.comments, user,
    )


@indent_router.post("/{indent_id}/reject", response_model=IndentOut)
# FIX: Removed default instance ActionIn() to resolve FastAPI 422 Unprocessable Entity
async def reject(indent_id: int, body: ActionIn,
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission_or(
        perms.INDENT_REJECT, perms.STOCK_TRANSFER_STR_APPROVE, service.str_in_reach))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.REJECTED, body.comments, user,
    )


alloc_router = APIRouter(prefix="/api/allocations")


@alloc_router.get("/proposal/{indent_id}")
async def allocation_proposal(indent_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission_or(
        perms.ALLOCATION_VIEW, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach))):
    return await service.allocation_proposal(db, indent_id, user)


@alloc_router.get("", response_model=Page[AllocationListRow])
async def list_allocations(params: PageParams = Depends(), status: str | None = None,
                           indent_id: int | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission_or(
        perms.ALLOCATION_VIEW, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach))):
    return await service.list_allocations(db, params, status, indent_id, user=user)


# Two permissions, both required: allocation.create says this person decides splits,
# allocation.submit says they may send the decision into approval. An admin who unticks
# the Submit action gets a 403 here, not just a hidden button.
@alloc_router.post("", response_model=AllocationOut)
async def create_allocation(body: AllocationIn, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission_or(
        perms.ALLOCATION_CREATE, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach)),
                            _submit=Depends(require_permission_or(
        perms.ALLOCATION_SUBMIT, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach))):
    return await service.decide_allocation(db, body, user)


@alloc_router.post("/batch", response_model=AllocationBatchOut)
async def create_allocations_batch(body: AllocationBatchIn,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.ALLOCATION_CREATE)),
                                   _submit=Depends(require_permission(perms.ALLOCATION_SUBMIT))):
    """Every indent in a cycle allocated in one request, one allocation each."""
    return await service.decide_allocations_batch(db, body, user)


@alloc_router.get("/batches")
async def fulfilment_batches(include_done: bool = False,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """One row per monthly cycle still owed. `include_done=true` keeps the finished
    ones in the list so a completed cycle can still be found."""
    return {"items": await service.fulfilment_batches(
        db, user, include_done=include_done)}


@alloc_router.get("/demand")
async def fulfilment_batch(indent_type: str | None = None, cycle: str | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """Open demand grouped by ITEM across every visible indent — the batch view.

    Declared above `/demand/{item_id}` so the static path is matched first.
    """
    return await service.fulfilment_batch(db, user, indent_type, cycle)


@alloc_router.get("/demand/{item_id}")
async def item_demand(item_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """All open demand for one item, so it can be split deliberately."""
    return await service.item_demand(db, item_id, user)


@alloc_router.get("/claims/{item_id}")
async def item_claims(item_id: int, indent_id: int = Query(...),
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    return await service.item_claims(db, item_id, indent_id, user=user)


@alloc_router.get("/approval-batches")
async def allocation_approval_batches(include_done: bool = False,
                                      db: AsyncSession = Depends(get_db),
                                      user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """Allocations grouped into the monthly cycle they serve.

    `include_done=true` keeps cycles that are fully signed in the list, so a finished
    cycle can still be opened and read.
    """
    return {"items": await service.allocation_approval_batches(
        db, user, include_done=include_done)}


@alloc_router.post("/history-batch")
async def allocation_histories(body: AllocationHistoryBatchIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """Approval history for a whole cycle in one call, keyed by allocation id."""
    return {"items": await service.allocation_histories(db, body.allocation_ids)}


@alloc_router.get("/{allocation_id}/availability",
                  response_model=list[AllocationLineAvailability])
async def allocation_availability(allocation_id: int, db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission_or(
        perms.ALLOCATION_VIEW, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach))):
    """What each line of this allocation could actually be given, right now."""
    return await service.allocation_line_availability(db, allocation_id, user)


@alloc_router.get("/{allocation_id}", response_model=AllocationOut)
async def get_allocation(allocation_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission_or(
        perms.ALLOCATION_VIEW, perms.STOCK_TRANSFER_SERVE, service.str_allocation_in_reach))):
    return await service.get_allocation(db, allocation_id, user=user)


@alloc_router.post("/approve-batch")
async def approve_allocations_batch(
        body: AllocBatchActionIn,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.ALLOCATION_APPROVE)),
        _reserve=Depends(require_permission(perms.ALLOCATION_APPROVE_RESERVE))):
    """Sign a whole cycle at once — one wf_actions row per allocation, as always."""
    return await service.act_on_allocations_batch(
        db, body.allocation_ids, ApprovalAction.APPROVED.value, user, body.comments)


@alloc_router.post("/reject-batch")
async def reject_allocations_batch(body: AllocBatchActionIn,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.ALLOCATION_REJECT))):
    return await service.act_on_allocations_batch(
        db, body.allocation_ids, ApprovalAction.REJECTED.value, user, body.comments)


@alloc_router.post("/{allocation_id}/approve", response_model=AllocationOut)
async def approve_allocation(
        allocation_id: int, body: AllocApproveIn,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission_or(
        perms.ALLOCATION_APPROVE, perms.STOCK_TRANSFER_SERVE_APPROVE, service.str_allocation_in_reach)),
        _reserve=Depends(require_permission_or(
        perms.ALLOCATION_APPROVE_RESERVE, perms.STOCK_TRANSFER_SERVE_APPROVE, service.str_allocation_in_reach))):
    """Approve, optionally revising the give quantities first — same permission, because
    revising is part of the approver's decision, not a separate one.

    Rejecting is deliberately NOT gated on allocation.approve_reserve: taking the
    Approve and reserve button away must never leave an approver holding a document
    they can neither pass nor refuse."""
    return await service.act_on_allocation(
        db, allocation_id, ApprovalAction.APPROVED.value, user, body.comments,
        revisions=[r.model_dump() for r in body.revisions])


@alloc_router.post("/{allocation_id}/reject", response_model=AllocationOut)
async def reject_allocation(allocation_id: int, body: AllocActionIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission_or(
        perms.ALLOCATION_REJECT, perms.STOCK_TRANSFER_SERVE_APPROVE, service.str_allocation_in_reach))):
    return await service.act_on_allocation(
        db, allocation_id, ApprovalAction.REJECTED.value, user, body.comments)


router.include_router(indent_router)
router.include_router(alloc_router)
