"""Returns endpoints. No business logic here (rule 2).

Returns has its own `return.*` permission family (`platform/rbac/permissions.py`), not
borrowed inventory codes. Six of them, because six different people are involved: the
LIP storekeeper who raises one must never gain the ability to transfer stock sideways,
the desk that decides where material goes is making a commercial call rather than
signing an outward move, and the floor that endorses that decision is neither.

New codes are fail-closed — `sync_permission_labels` grants them to Admin and to nobody
else on first start, so nothing anyone can already do changes, and an admin ticks the
module on per job profile when it goes live.
"""
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms
from app.platform.settings import attachments
from app.shared.enums import ApprovalAction

from . import receiving, service
from .schemas import (
    AcknowledgeIn,
    ActionIn, ApprovalFlowOut, AttachmentOut, DecisionIn, DecisionOptionsOut, HistoryOut,
    JourneyOut, MyStockOut, ObjectionIn, PositionOut, RaiserOut, ReasonOut,
    PurchaseSourceOut, ReceivingConfigIn, ReceivingConfigOut, RejectIn,
    RelatedDocumentsOut, ReturnOut, ReturnWrite, SendBackIn,
    SummaryOut,
)

router = APIRouter(prefix="/api/returns", tags=["returns"])


@router.get("")
async def list_returns(params: PageParams = Depends(), status: str = "",
                       search: str = "", mine_only: bool = False, queue: str = "",
                       date_from: date | None = Query(None),
                       date_to: date | None = Query(None),
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.RETURN_VIEW))):
    """`queue` narrows to a desk's work rather than to a status: the decision desk and
    the endorsers both hold PENDING_APPROVAL documents, so no status filter can tell
    the two backlogs apart.

    `date_from`/`date_to` bound the day the return was raised, both ends inclusive."""
    return await service.list_returns(db, params, user, status=status or None,
                                      search=search or None, mine_only=mine_only,
                                      queue=queue or None, date_from=date_from,
                                      date_to=date_to)


@router.get("/purchase")
async def purchase_returns(params: PageParams = Depends(), status: str = "",
                           search: str = "", source: str = "",
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    """The other family of return, read only — `pro_returns` is the warehouse module's
    table and this only lists it so the register can show both families in one place.

    `source` narrows to where the material came from — FROM_WAREHOUSE, FROM_LIP_MDB or
    QC_REJECTED_GRN. A different question from `status`, which is how far the paperwork
    has got, and the one the buying desk actually asks about a purchase return.
    """
    return await service.list_purchase_returns(db, params, status=status or None,
                                              search=search or None,
                                              source=source or None, user=user)


@router.get("/options/purchase-sources", response_model=list[PurchaseSourceOut])
async def purchase_return_sources(user=Depends(require_permission(perms.RETURN_VIEW))):
    """The three source categories, served so the register's filter and the desk's
    preview read the same words the service stamps on the document."""
    return service.purchase_return_sources()


@router.get("/summary", response_model=SummaryOut)
async def summary(db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.summary(db, user)


@router.get("/options/reasons", response_model=list[ReasonOut])
async def reasons(user=Depends(get_current_user)):
    return service.reasons()


@router.get("/options/raiser", response_model=RaiserOut)
async def raiser(db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.raiser_context(db, user)


# ADDED 2026-09-07. Declared above `/{return_id}` with the rest of the literal segments,
# for the same reason: an int-typed catch-all would swallow "options" otherwise.
@router.get("/options/indents")
async def returnable_indents(params: PageParams = Depends(), search: str = "",
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.RETURN_VIEW))):
    """The indents this person may return against — their own, past approval."""
    return await service.returnable_indents(db, params, user, search=search or None)


@router.get("/options/approval-flow", response_model=ApprovalFlowOut)
async def approval_flow_for_indent(indent_id: int | None = None,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.RETURN_VIEW))):
    """Who will sign a return raised against this indent, before it is raised.

    Resolved through the engine's own preview, so the flow the raiser is shown here is
    the flow the submit will actually open.
    """
    return await service.approval_flow(db, user, indent_id=indent_id)


@router.get("/my-stock")
async def my_stock(params: PageParams = Depends(), search: str = "",
                   indent_id: int | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.RETURN_VIEW))):
    """`indent_id` narrows the shelf to what that request asked for — the return form
    only offers items once an indent has been picked."""
    return await service.my_stock(db, params, user, search=search or None,
                                  indent_id=indent_id)


# Declared above `/{return_id}`: a literal segment has to be matched before the
# int-typed catch-all, or "config" is parsed as a return id and 422s.
@router.get("/config/receiving", response_model=ReceivingConfigOut)
async def receiving_config(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    return await receiving.get_config(db)


@router.get("/config/positions", response_model=list[PositionOut])
async def receiving_positions(search: str = "", db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(
                                  perms.RETURN_CONFIG_MANAGE))):
    return await receiving.search_positions(db, search)


@router.put("/config/receiving", response_model=ReceivingConfigOut)
async def save_receiving_config(body: ReceivingConfigIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(
                                   perms.RETURN_CONFIG_MANAGE))):
    return await receiving.save_config(db, body.position_ids, user)


@router.post("", response_model=ReturnOut, status_code=201)
async def create(body: ReturnWrite, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.create_return(db, body, user)


@router.get("/{return_id}", response_model=ReturnOut)
async def get_one(return_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.get_return(db, return_id, user)


@router.put("/{return_id}", response_model=ReturnOut)
async def update(return_id: int, body: ReturnWrite,
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.update_return(db, return_id, body, user)


@router.post("/{return_id}/submit", response_model=ReturnOut)
async def submit(return_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.submit_return(db, return_id, user)


@router.post("/{return_id}/approve", response_model=ReturnOut)
async def approve(return_id: int, body: ActionIn,
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_APPROVE))):
    return await service.act_on_return(
        db, return_id, ApprovalAction.APPROVED.value, body.comments, user)


@router.post("/{return_id}/reject", response_model=ReturnOut)
async def reject(return_id: int, body: ActionIn,
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_APPROVE))):
    return await service.act_on_return(
        db, return_id, ApprovalAction.REJECTED.value, body.comments, user)


@router.get("/{return_id}/decision-options", response_model=DecisionOptionsOut)
async def decision_options(return_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    """The six outcomes, the reason's default, candidate points and liable vendors."""
    return await service.decision_options(db, return_id, user)


@router.post("/{return_id}/decide", response_model=ReturnOut)
async def decide(return_id: int, body: DecisionIn,
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_DECIDE))):
    """The desk saying where the material goes. Deciding is not approving — a scrapped
    batch is written off — so it carries its own code."""
    return await service.decide(db, return_id, body, user)


@router.post("/{return_id}/endorse", response_model=ReturnOut)
async def endorse(return_id: int, body: ActionIn,
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_ENDORSE))):
    """The floor agreeing the decision is workable. The last rung's yes moves the stock."""
    return await service.endorse(db, return_id, body.comments, user)


@router.post("/{return_id}/object", response_model=ReturnOut)
async def object_to_decision(return_id: int, body: ObjectionIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(
                                 perms.RETURN_ENDORSE))):
    """The floor sending the decision back for a fresh one. Not a rejection — the return
    stands and the hold stays; it is the ROUTE that was refused."""
    return await service.object_to_decision(db, return_id, body.comments, user)


# --------------------------------------------------------------------------- #
#  Send back, and reject, at each of the three approval stages
# --------------------------------------------------------------------------- #
#
# One service function per verb, three routes each, because the PERMISSION is what
# differs and the permission belongs to the stage. A single `/send-back` would have had
# to be gated on one code, which would either hand the decision desk the approvers' code
# or hand the approvers the desk's — and the whole point of six `return.*` codes is that
# those are different people (see the module docstring).
#
# The permission is the coarse gate only. Which of these a login may actually press is
# decided in the service against the LIVE workflow task (`_assert_holding`): holding
# `return.approve` does not make somebody the current approver of this document.

@router.post("/{return_id}/approval/send-back", response_model=ReturnOut)
async def send_back_from_approval(return_id: int, body: SendBackIn,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(
                                      perms.RETURN_APPROVE))):
    """An approver on the reporting line handing the document back to the raiser."""
    return await service.send_back(db, return_id, body.comments, user,
                                   phase=service.PHASE_FIELD)


@router.post("/{return_id}/decision/send-back", response_model=ReturnOut)
async def send_back_from_decision(return_id: int, body: SendBackIn,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(
                                      perms.RETURN_DECIDE))):
    """The decision desk handing the document back to the raiser to correct."""
    return await service.send_back(db, return_id, body.comments, user,
                                   phase=service.PHASE_DECISION)


@router.post("/{return_id}/sign-off/send-back", response_model=ReturnOut)
async def send_back_from_sign_off(return_id: int, body: SendBackIn,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(
                                      perms.RETURN_ENDORSE))):
    """The floor handing the document back to the raiser.

    Different from `/object`, which sends only the DECISION back to the desk and leaves
    the return itself standing with its hold intact. This sends the whole document home.
    """
    return await service.send_back(db, return_id, body.comments, user,
                                   phase=service.PHASE_ENDORSE)


@router.post("/{return_id}/decision/reject", response_model=ReturnOut)
async def reject_at_decision(return_id: int, body: RejectIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.RETURN_DECIDE))):
    """The decision desk refusing the return outright — not a disposition, a refusal."""
    return await service.reject_at_stage(db, return_id, body.comments, user,
                                         phase=service.PHASE_DECISION)


@router.post("/{return_id}/sign-off/reject", response_model=ReturnOut)
async def reject_at_sign_off(return_id: int, body: RejectIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.RETURN_ENDORSE))):
    """The floor refusing the return outright."""
    return await service.reject_at_stage(db, return_id, body.comments, user,
                                         phase=service.PHASE_ENDORSE)


@router.post("/{return_id}/cancel", response_model=ReturnOut)
async def cancel(return_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.cancel_return(db, return_id, user)


@router.post("/{return_id}/acknowledge", response_model=ReturnOut)
async def acknowledge(return_id: int, body: AcknowledgeIn | None = None,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.RETURN_CREATE))):
    """Two presses behind one route — see `service.acknowledge_return`.

    The body is optional because the close half has nothing to describe. The receipt half
    states what arrived and in what state, and the service refuses it without a photograph
    of the delivery.
    """
    return await service.acknowledge_return(
        db, return_id, user,
        lines={line.line_id: Decimal(str(line.received_quantity))
               for line in (body.lines if body else [])} or None,
        condition=body.condition if body else None,
        remarks=body.remarks if body else None)


@router.get("/{return_id}/journey", response_model=JourneyOut)
async def journey(return_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.journey(db, return_id, user)


@router.get("/{return_id}/approval-flow", response_model=ApprovalFlowOut)
async def approval_flow(return_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.RETURN_VIEW))):
    """This return's own approval chain — the indent's where it names one.

    Separate from `/history`, which is what has already happened. This is the route
    ahead, and it is the only thing that can be shown before anybody has signed.
    """
    return await service.approval_flow(db, user, return_id=return_id)


@router.get("/{return_id}/related-documents", response_model=RelatedDocumentsOut)
async def related_documents(return_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.RETURN_DECIDE))):
    """Everything behind the returned item — indent, allocation, PO, GRN, QC, issue.

    `RETURN_DECIDE`, not `RETURN_VIEW` (CHANGED 2026-09-14). This is not a wider view of
    the return: it is a dozen OTHER modules' documents, pulled together because the desk
    choosing where the material goes has to check them. A LIP storekeeper holds
    `return.view` so they can read the return they raised, and reading it used to hand
    them the branch's purchase orders, the vendor who supplied it and what it cost — none
    of which is theirs to see and none of which they can act on.

    The document itself is unchanged for them: the header, the lines, the journey and the
    approval trail are all still on `return.view`. Only the trail behind the MATERIAL
    moved. `get_return` serves `can_view_trail` off the same code so the screen asks
    rather than guesses, and this guard is what actually enforces it (rule 6).
    """
    return await service.get_related_documents(db, return_id, user)


@router.get("/{return_id}/history", response_model=list[HistoryOut])
async def history(return_id: int, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.history(db, return_id)


@router.get("/{return_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(return_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.list_files(db, return_id)


# SCM HEAD needs to see what the storekeeper photographed. The panel only
# listed file names, and the store had no download route at all, so the image
# the approval decision is made against was invisible to the person who decides.
@router.get("/{return_id}/attachments/{attachment_id}/download")
async def download_attachment(return_id: int, attachment_id: int,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.RETURN_VIEW))):
    """The photo/bill itself. Nested under the return so the return's own
    visibility check decides who may pull the bytes."""
    # Return-level check first - decides who may read the document at all.
    await service.get_return(db, return_id, user)
    row = await attachments.require_attachment(db, attachment_id,
                                               entity_type=service.ENTITY_TYPE,
                                               entity_id=return_id)
    path, file_name, mime_type = await attachments.attachment_file(db, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type,
                        content_disposition_type="inline")


@router.post("/{return_id}/attachments", response_model=AttachmentOut,
             status_code=201)
async def add_attachment(return_id: int, file: UploadFile = File(...),
                         doc_category: str = Query(service.PHOTO_CATEGORY),
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.add_file(db, return_id, file, doc_category, user)


@router.delete("/{return_id}/attachments/{attachment_id}", status_code=204)
async def delete_attachment(return_id: int, attachment_id: int,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.RETURN_CREATE))):
    await service.delete_file(db, return_id, attachment_id, user)
