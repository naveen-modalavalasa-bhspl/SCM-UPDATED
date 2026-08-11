"""Inventory endpoints. No logic — routes call the service."""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
from app.modules.inventory import locations, service
from app.modules.inventory.schemas import (
    ActionIn, MovementRow, MRListRow, MROut, StockRow, TransferIn,
    AdjustmentIn, AdjustmentOut, AdjustmentListRow, AdjustmentRejectIn, ReplenishmentRow,
    ReservationRow, ReservationReleaseOut, ItemAvailabilityOut,
    AgeingSummaryOut, ValuationSummaryOut, NearExpiryAlertRow,
    STOIn, STOOut, STOListRow, CycleCountIn, CycleCountUpdateIn,
    CycleCountOut, CycleCountListRow, StockOverviewKPIs,
    StockDetailOut, ReplenishmentRuleIn, ReplenishmentRuleRow,
    PositionLocationIn, PositionLocationOut, MovementClassificationOut,
    StockSummaryOut, MovementSummaryOut,
)
from app.platform.rbac import permissions as perms
from app.shared.enums import ApprovalAction

router = APIRouter(tags=["inventory"])

stock_router = APIRouter(prefix="/api/stock")


@stock_router.get("", response_model=Page[StockRow])
async def list_stock(params: PageParams = Depends(), item_id: int | None = None,
                     warehouse_id: int | None = None, project_id: int | None = None,
                     bin_id: int | None = None, search: str | None = None,
                     category_id: int | None = None, batch_no: str | None = None,
                     include_zero: bool = False, expiring_in_days: int | None = None,
                     expiry_status: str | None = None, expiry_from: date | None = None,
                     expiry_to: date | None = None, expired_in_last_days: int | None = None,
                     below_reorder: bool = False, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_stock(db, params, item_id, warehouse_id, project_id,
                                    bin_id, search, category_id, batch_no,
                                    include_zero, expiring_in_days, expiry_status,
                                    expiry_from, expiry_to, expired_in_last_days,
                                    below_reorder, user=user)


@stock_router.get("/summary", response_model=StockSummaryOut)
async def stock_summary(item_id: int | None = None,
                        warehouse_id: int | None = None, project_id: int | None = None,
                        bin_id: int | None = None, search: str | None = None,
                        category_id: int | None = None, batch_no: str | None = None,
                        include_zero: bool = False, expiring_in_days: int | None = None,
                        expiry_status: str | None = None, expiry_from: date | None = None,
                        expiry_to: date | None = None, expired_in_last_days: int | None = None,
                        below_reorder: bool = False, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.stock_summary(db, item_id, warehouse_id, project_id,
                                       bin_id, search, category_id, batch_no,
                                       include_zero, expiring_in_days, expiry_status,
                                       expiry_from, expiry_to, expired_in_last_days,
                                       below_reorder, user=user)


@stock_router.get("/movements", response_model=Page[MovementRow])
async def movements(params: PageParams = Depends(), item_id: int | None = None,
                    warehouse_id: int | None = None, direction: str | None = None,
                    ref_type: str | None = None, search: str | None = None,
                    date_from: date | None = None, date_to: date | None = None,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_movements(db, params, item_id, warehouse_id, direction,
                                        ref_type, search, date_from, date_to, user=user)


@stock_router.get("/movements/summary", response_model=MovementSummaryOut)
async def movement_summary(item_id: int | None = None,
                           warehouse_id: int | None = None, direction: str | None = None,
                           ref_type: str | None = None, search: str | None = None,
                           date_from: date | None = None, date_to: date | None = None,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.movement_summary(db, item_id, warehouse_id, direction,
                                          ref_type, search, date_from, date_to, user=user)


@stock_router.post("/transfer", status_code=204)
async def transfer(body: TransferIn, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.STOCK_TRANSFER))):
    await service.transfer_stock(
        db, body.item_id, body.quantity, user,
        from_warehouse_id=body.from_warehouse_id,
        to_warehouse_id=body.to_warehouse_id,
        from_project_id=body.from_project_id, to_project_id=body.to_project_id,
        ref_no=body.remarks)
    await db.commit()


@stock_router.post("/adjust", response_model=AdjustmentOut)
async def create_adjustment(body: AdjustmentIn, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.create_stock_adjustment(db, body, user)


@stock_router.get("/adjustments", response_model=Page[AdjustmentListRow])
async def list_adjustments(params: PageParams = Depends(), warehouse_id: int | None = None,
                            status: str | None = None, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_adjustments(db, params, warehouse_id, status, user=user)


@stock_router.get("/adjustments/{id}", response_model=AdjustmentOut)
async def get_adjustment(id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_adjustment(db, id, user=user)


@stock_router.post("/adjustments/{id}/approve", response_model=AdjustmentOut)
async def approve_adjustment(id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.act_on_adjustment(db, id, "APPROVE", user)


@stock_router.post("/adjustments/{id}/reject", response_model=AdjustmentOut)
async def reject_adjustment(id: int, body: AdjustmentRejectIn | None = None,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.act_on_adjustment(db, id, "REJECT", user,
                                           remarks=body.remarks if body else None)


@stock_router.get("/replenishment-rules", response_model=list[ReplenishmentRuleRow])
async def list_replenishment_rules(warehouse_id: int | None = None,
                                   item_id: int | None = None,
                                   db: AsyncSession = Depends(get_db),
                                   user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_replenishment_rules(db, warehouse_id, item_id, user=user)


@stock_router.put("/replenishment-rules", response_model=ReplenishmentRuleRow)
async def save_replenishment_rule(body: ReplenishmentRuleIn,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.save_replenishment_rule(db, body, user)


@stock_router.delete("/replenishment-rules/{warehouse_id}/{item_id}", status_code=204)
async def delete_replenishment_rule(warehouse_id: int, item_id: int,
                                    db: AsyncSession = Depends(get_db),
                                    user=Depends(require_permission(perms.STOCK_ADJUST))):
    await service.delete_replenishment_rule(db, warehouse_id, item_id, user)


@stock_router.get("/replenishment", response_model=list[ReplenishmentRow])
async def replenishment(warehouse_id: int | None = None, category_id: int | None = None,
                        criticality: str | None = None, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_stock_replenishment(
        db, warehouse_id, category_id, criticality, user=user,
    )


@stock_router.get("/ageing", response_model=AgeingSummaryOut)
async def stock_ageing(warehouse_id: int | None = None, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_stock_ageing(db, warehouse_id, user=user)


@stock_router.get("/valuation", response_model=ValuationSummaryOut)
async def stock_valuation(warehouse_id: int | None = None, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(
                             perms.STOCK_VALUATION_VIEW))):
    return await service.get_stock_valuation(db, warehouse_id, user=user)


@stock_router.get("/near-expiry-alerts", response_model=list[NearExpiryAlertRow])
async def near_expiry_alerts(days: int = 90, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_near_expiry_alerts(db, days, user=user)


@stock_router.get("/overview-kpis", response_model=StockOverviewKPIs)
async def overview_kpis(db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_overview_kpis(db, user=user)


@stock_router.get("/{stock_id}/detail", response_model=StockDetailOut)
async def stock_detail(stock_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_stock_detail(db, stock_id, user=user)


@stock_router.get("/{item_id}/availability", response_model=ItemAvailabilityOut)
async def item_availability(item_id: int, project_id: int | None = 0,
                            warehouse_id: int | None = None, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_item_availability(
        db, item_id, project_id, warehouse_id, user=user,
    )


# STO Endpoints
@stock_router.post("/sto", response_model=STOOut)
async def create_sto(body: STOIn, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.STOCK_TRANSFER))):
    return await service.create_sto(db, body, user)


@stock_router.get("/sto", response_model=Page[STOListRow])
async def list_stos(params: PageParams = Depends(), status: str | None = None,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_stos(db, params, status, user=user)


@stock_router.get("/sto/{id}", response_model=STOOut)
async def get_sto(id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_sto(db, id, user=user)


@stock_router.post("/sto/{id}/approve", response_model=STOOut)
async def approve_sto(id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.STOCK_TRANSFER))):
    return await service.approve_sto(db, id, user)


@stock_router.post("/sto/{id}/dispatch", response_model=STOOut)
async def dispatch_sto(id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.STOCK_TRANSFER))):
    return await service.dispatch_sto(db, id, user)


@stock_router.post("/sto/{id}/receive", response_model=STOOut)
async def receive_sto(id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.STOCK_TRANSFER))):
    return await service.receive_sto(db, id, user)


# Cycle Count Endpoints
@stock_router.post("/cycle-counts", response_model=CycleCountOut)
async def create_cycle_count(body: CycleCountIn, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.create_cycle_count(db, body, user)


@stock_router.get("/cycle-counts", response_model=Page[CycleCountListRow])
async def list_cycle_counts(params: PageParams = Depends(), warehouse_id: int | None = None,
                            status: str | None = None, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_cycle_counts(db, params, warehouse_id, status, user=user)


@stock_router.get("/cycle-counts/{id}", response_model=CycleCountOut)
async def get_cycle_count(id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.get_cycle_count(db, id, user=user)


@stock_router.put("/cycle-counts/{id}", response_model=CycleCountOut)
async def update_cycle_count(id: int, body: CycleCountUpdateIn, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.update_cycle_count(db, id, body, user)


@stock_router.post("/cycle-counts/{id}/post", response_model=CycleCountOut)
async def post_cycle_count(id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_ADJUST))):
    return await service.post_cycle_count(db, id, user)


# Reservations Router
res_router = APIRouter(prefix="/api/reservations")


@res_router.get("", response_model=Page[ReservationRow])
async def list_reservations(params: PageParams = Depends(), item_id: int | None = None,
                            warehouse_id: int | None = None, status: str | None = None,
                            ref_type: str | None = None, ref_id: int | None = None,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_reservations(db, params, item_id, warehouse_id, status, ref_type, ref_id, user=user)


@res_router.post("/{id}/release", response_model=ReservationReleaseOut)
async def release_reservation(id: int, db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.STOCK_RESERVE))):
    return await service.release_reservation_by_id(db, id)


mr_router = APIRouter(prefix="/api/material-requests")


@mr_router.get("", response_model=Page[MRListRow])
async def list_mrs(params: PageParams = Depends(), status: str | None = None,
                   indent_id: int | None = None, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.MR_VIEW))):
    return await service.list_mrs(db, params, status, indent_id, user=user)


@mr_router.get("/{mr_id}", response_model=MROut)
async def get_mr(mr_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.MR_VIEW))):
    return await service.get_mr(db, mr_id, user=user)


@mr_router.post("/{mr_id}/approve", response_model=MROut)
async def approve_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.MR_APPROVE))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.APPROVED.value, user,
                                   body.comments)


@mr_router.post("/{mr_id}/reject", response_model=MROut)
async def reject_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.MR_REJECT))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.REJECTED.value, user,
                                   body.comments)


router.include_router(stock_router)
router.include_router(res_router)
router.include_router(mr_router)



# ---------------- Stocking points: tagging and classification ----------------

points_router = APIRouter(prefix="/api/stocking-points", tags=["inventory"])


@points_router.get("/tags")
async def list_position_locations(position_id: int | None = None,
                                  search: str | None = None,
                                  tier: int | None = None,
                                  project_id: int | None = None,
                                  page: int = 1, size: int = 25,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(perms.STOCK_VIEW))):
    """The tagging, searchable and paged, narrowed to what this login may see.

    Asking for one position still answers that question exactly — the engine and the
    tag form both do — but the screen's own read goes through the scoped path, so a
    district login browsing the list never sees another project's tagging.
    """
    if position_id is not None:
        rows = await locations.list_tags(db, position_id)
        return {"items": rows, "total": len(rows), "page": 1, "size": len(rows),
                "tier_counts": {}, "stock_points": 0, "stock_items": 0,
                "stock_qty": 0.0}
    return await locations.search_tags(db, user, search=search, tier=tier,
                                       project_id=project_id, page=page, size=size)


@points_router.post("/tags", response_model=PositionLocationOut)
async def tag_position_location(body: PositionLocationIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.STOCK_POINTS_MANAGE))):
    return await locations.tag_position(db, body, user)


@points_router.delete("/tags/{tag_id}")
async def untag_position_location(tag_id: int, db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(perms.STOCK_POINTS_MANAGE))):
    await locations.untag(db, tag_id)
    return {"success": True}


@points_router.get("/classify", response_model=MovementClassificationOut)
async def classify_move(from_warehouse_id: int | None = None,
                        to_warehouse_id: int | None = None,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.STOCK_VIEW))):
    """What a move between these two points would be. Read-only — the screen shows
    it beside the pickers so the derived type is visible before anything is saved."""
    return await locations.describe_move(db, from_warehouse_id, to_warehouse_id)


@points_router.get("/mine")
async def my_stocking_points(db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.STOCK_VIEW))):
    """The points this login can draw from and see into — its own plus its subtree."""
    position_id = getattr(user, "active_position_id", None)
    primary = await locations.primary_location_for(db, position_id)
    return {
        "primary_warehouse_id": primary,
        "warehouse_ids": sorted(await locations.location_ids_for_user(db, user)),
        "tags": await locations.list_tags(db, position_id),
        # What this person's own point IS. The warehouse screens call themselves by it,
        # because somebody who holds an MDP does not call the place a warehouse.
        **(await locations.describe_point(db, primary)),
    }


@points_router.get("/positions")
async def search_positions(q: str = "", db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.STOCK_POINTS_MANAGE))):
    """Find a position by person, employee code or post name — nobody knows ids."""
    return await locations.search_positions(db, q)


router.include_router(points_router)
