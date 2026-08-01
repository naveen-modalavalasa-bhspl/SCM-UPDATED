"""Indents endpoints. No logic here — every route calls the service."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.platform.rbac import permissions as perms
from app.modules.indents import service
from app.modules.indents.enums import (
    AcknowledgmentStatus, ApprovalAction, IndentActivityType, IndentStatus,
    MaterialDirection, Priority,
)
from app.modules.indents.schemas import (
    AcknowledgmentRow, ActionIn, ActivityRow, IndentCreate, IndentListRow,
    IndentJourneyOut, IndentNotificationRow, IndentOut, IndentStatsOut, IndentUpdate,
)
# Allocation is a decision about an indent, so its endpoints live here. The
# mechanics are in modules/inventory/allocations.py -- indents may import inventory,
# never the reverse.
from app.modules.inventory.schemas import (
    AllocationIn, AllocationListRow, AllocationOut,
)
from app.modules.inventory.schemas import ActionIn as AllocActionIn
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
                       department_id: list[int] | None = Query(None),
                       is_bookmarked: str | None = None,
                       sort_by: str = "created_at", sort_dir: str = "desc",
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission("indent.view"))):
    return await service.list_indents(
        db, params, search=search,
        date_from=created_date_from or start_date,
        date_to=created_date_to or end_date,
        required_by_from=required_by_from, required_by_to=required_by_to,
        statuses=status, priorities=priority, department_ids=department_id,
        is_bookmarked=is_bookmarked, sort_by=sort_by, sort_dir=sort_dir, user=user,
    )


@indent_router.get("/approved-pending-po", response_model=Page[IndentListRow])
async def approved_pending_po(params: PageParams = Depends(),
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission("indent.view"))):
    return await service.approved_pending_po(db, params, user=user)


@indent_router.get("/stats", response_model=IndentStatsOut)
async def stats(search: str | None = None, created_date_from: date | None = None,
                created_date_to: date | None = None, start_date: date | None = None,
                end_date: date | None = None, required_by_from: date | None = None,
                required_by_to: date | None = None,
                status: list[IndentStatus] | None = Query(None),
                priority: list[Priority] | None = Query(None),
                department_id: list[int] | None = Query(None),
                is_bookmarked: str | None = None,
                db: AsyncSession = Depends(get_db),
                user=Depends(require_permission("indent.view"))):
    return await service.indent_stats(
        db, search=search, date_from=created_date_from or start_date,
        date_to=created_date_to or end_date, required_by_from=required_by_from,
        required_by_to=required_by_to, statuses=status, priorities=priority,
        department_ids=department_id, is_bookmarked=is_bookmarked, user=user,
    )


@indent_router.get("/activity", response_model=Page[ActivityRow])
async def activity(params: PageParams = Depends(), search: str | None = None,
                   date_from: date | None = None, date_to: date | None = None,
                   required_from: date | None = None,
                   required_to: date | None = None,
                   item_id: int | None = None,
                   status: list[IndentStatus] | None = Query(None),
                   priority: list[Priority] | None = Query(None),
                   transaction_type: IndentActivityType | None = None,
                   direction: MaterialDirection | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission("indent.view"))):
    return await service.activity_ledger(db, params, user=user, search=search, date_from=date_from,
        date_to=date_to, required_from=required_from, required_to=required_to,
        item_id=item_id, statuses=status, priorities=priority,
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
                          user=Depends(require_permission("indent.view"))):
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
                        user=Depends(require_permission("indent.view"))):
    return await service.list_notifications(
        db, params, user, search=search, date_from=date_from, date_to=date_to,
        statuses=status,
    )


@indent_router.post("", response_model=IndentOut)
async def create(data: IndentCreate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission("indent.create"))):
    return await service.create_indent(db, data, user)


@indent_router.get("/options/offices")
async def office_options(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission("indent.view"))):
    return await service.list_office_options(db)


@indent_router.get("/{indent_id}", response_model=IndentOut)
async def get_one(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission("indent.view"))):
    return await service.get_indent(db, indent_id, user)


@indent_router.get("/{indent_id}/journey", response_model=IndentJourneyOut)
async def journey(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission("indent.view"))):
    return await service.indent_journey(db, indent_id, user)


@indent_router.put("/{indent_id}", response_model=IndentOut)
async def update(indent_id: int, data: IndentUpdate, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission("indent.edit"))):
    return await service.update_indent(db, indent_id, data, user)


@indent_router.delete("/{indent_id}", status_code=204)
async def delete_draft(indent_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission("indent.view"))):
    await service.delete_indent(db, indent_id, user)


@indent_router.post("/{indent_id}/submit", response_model=IndentOut)
async def submit(indent_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission("indent.submit"))):
    return await service.submit_indent(db, indent_id, user)


@indent_router.post("/{indent_id}/bookmark", response_model=IndentOut)
async def bookmark(indent_id: int, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission("indent.view"))):
    return await service.set_indent_bookmark(db, indent_id, user, is_bookmarked=True)


@indent_router.post("/{indent_id}/unbookmark", response_model=IndentOut)
async def unbookmark(indent_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission("indent.view"))):
    return await service.set_indent_bookmark(db, indent_id, user, is_bookmarked=False)


@indent_router.post("/{indent_id}/approve", response_model=IndentOut)
async def approve(indent_id: int, body: ActionIn = ActionIn(),
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission("indent.approve"))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.APPROVED, body.comments, user,
    )


@indent_router.post("/{indent_id}/reject", response_model=IndentOut)
async def reject(indent_id: int, body: ActionIn = ActionIn(),
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission("indent.reject"))):
    return await service.act_on_indent(
        db, indent_id, ApprovalAction.REJECTED, body.comments, user,
    )


alloc_router = APIRouter(prefix="/api/allocations")


@alloc_router.get("/proposal/{indent_id}")
async def allocation_proposal(indent_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    return await service.allocation_proposal(db, indent_id)


@alloc_router.get("", response_model=Page[AllocationListRow])
async def list_allocations(params: PageParams = Depends(), status: str | None = None,
                           indent_id: int | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    return await service.list_allocations(db, params, status, indent_id)


@alloc_router.post("", response_model=AllocationOut)
async def create_allocation(body: AllocationIn, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.ALLOCATION_CREATE))):
    return await service.decide_allocation(db, body, user)


@alloc_router.get("/demand/{item_id}")
async def item_demand(item_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    """All open demand for one item, so it can be split deliberately."""
    return await service.item_demand(db, item_id)


@alloc_router.get("/{allocation_id}", response_model=AllocationOut)
async def get_allocation(allocation_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ALLOCATION_VIEW))):
    return await service.get_allocation(db, allocation_id)


@alloc_router.post("/{allocation_id}/approve", response_model=AllocationOut)
async def approve_allocation(allocation_id: int, body: AllocActionIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.ALLOCATION_APPROVE))):
    return await service.act_on_allocation(
        db, allocation_id, ApprovalAction.APPROVED.value, user, body.comments)


@alloc_router.post("/{allocation_id}/reject", response_model=AllocationOut)
async def reject_allocation(allocation_id: int, body: AllocActionIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.ALLOCATION_REJECT))):
    return await service.act_on_allocation(
        db, allocation_id, ApprovalAction.REJECTED.value, user, body.comments)


router.include_router(indent_router)
router.include_router(alloc_router)
