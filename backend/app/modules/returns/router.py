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
from fastapi import APIRouter, Depends, File, Query, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms
from app.shared.enums import ApprovalAction

from . import receiving, service
from .schemas import (
    ActionIn, AttachmentOut, DecisionIn, DecisionOptionsOut, HistoryOut, JourneyOut,
    MyStockOut, ObjectionIn, PositionOut, RaiserOut, ReasonOut, ReceivingConfigIn,
    ReceivingConfigOut, ReturnOut, ReturnWrite, SummaryOut,
)

router = APIRouter(prefix="/api/returns", tags=["returns"])


@router.get("")
async def list_returns(params: PageParams = Depends(), status: str = "",
                       search: str = "", mine_only: bool = False, queue: str = "",
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.RETURN_VIEW))):
    """`queue` narrows to a desk's work rather than to a status: the decision desk and
    the endorsers both hold PENDING_APPROVAL documents, so no status filter can tell
    the two backlogs apart."""
    return await service.list_returns(db, params, user, status=status or None,
                                      search=search or None, mine_only=mine_only,
                                      queue=queue or None)


@router.get("/purchase")
async def purchase_returns(params: PageParams = Depends(), status: str = "",
                           search: str = "",
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    """The other family of return, read only — `pro_returns` is the warehouse module's
    table and this only lists it so the register can show both families in one place."""
    return await service.list_purchase_returns(db, params, status=status or None,
                                              search=search or None)


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


@router.get("/my-stock")
async def my_stock(params: PageParams = Depends(), search: str = "",
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.my_stock(db, params, user, search=search or None)


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


@router.post("/{return_id}/cancel", response_model=ReturnOut)
async def cancel(return_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.cancel_return(db, return_id, user)


@router.post("/{return_id}/acknowledge", response_model=ReturnOut)
async def acknowledge(return_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.RETURN_CREATE))):
    return await service.acknowledge_return(db, return_id, user)


@router.get("/{return_id}/journey", response_model=JourneyOut)
async def journey(return_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.journey(db, return_id, user)


@router.get("/{return_id}/history", response_model=list[HistoryOut])
async def history(return_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.history(db, return_id)


@router.get("/{return_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(return_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.RETURN_VIEW))):
    return await service.list_files(db, return_id)


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
