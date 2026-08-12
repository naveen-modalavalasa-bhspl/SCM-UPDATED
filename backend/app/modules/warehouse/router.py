"""HTTP surface for the warehouse module.

Every function here is three to five lines: resolve the guard, call the service,
return what it gave back. There is no `if` in this file — a branch here is business
logic that has escaped `service.py`, where it can be tested without a request.

Every endpoint is guarded by `Depends(require_permission(...))`. The codes come from
`enums.py`, which mirrors `platform/rbac/permissions.py`; the ones marked NEW there do
not exist yet, so those endpoints will 403 for everyone until the lead adds them and
the seed is re-run. That is the correct failure mode — an ungranted permission closes
the door rather than leaving it open.
"""
from datetime import date

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams
# The delivery rows are an indents-module shape: this endpoint only supplies the
# warehouse evidence behind them (rule 5 forbids the join happening the other way).
from app.modules.indents.schemas import DeliveryRow as IndentDeliveryRow
from app.modules.indents.schemas import FulfilmentStep as IndentFulfilmentStep
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service
from app.platform.rbac.permissions import INDENT_VIEW
from app.modules.warehouse.enums import (
    DISPATCH_ACKNOWLEDGE, DISPATCH_APPROVE, DISPATCH_CREATE, DISPATCH_DELETE,
    DISPATCH_GATE_OUT, DISPATCH_VIEW, INSPECTION_DELETE, ISSUE_DELETE, MOVEMENT_DELETE,
    PICKING_DELETE, PUTAWAY_DELETE, RECEIPT_DELETE, RETURN_DELETE,
    INSPECTION_EXECUTE, INSPECTION_VIEW, ISSUE_CREATE, ISSUE_FORWARD, ISSUE_POST,
    ISSUE_VIEW,
    MASTER_LOCATION_MANAGE, PICKING_PICK, PICKING_VIEW, PUTAWAY_EXECUTE, PUTAWAY_VIEW,
    RECEIPT_CREATE, RECEIPT_POST, RECEIPT_VIEW, RETURN_APPROVE, RETURN_CREATE, RETURN_VIEW,
    STOCK_TRANSFER, STOCK_VIEW, WAREHOUSE_REPORT_VIEW,
)
from app.shared.enums import ApprovalAction

router = APIRouter(prefix="/api/warehouse", tags=["warehouse"])


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@router.get("/dashboard", response_model=s.DashboardRead)
async def dashboard(warehouse_id: int | None = None, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(STOCK_VIEW))):
    return await service.dashboard(db, warehouse_id, user=user)


# ---------------------------------------------------------------------------
# Warehouse master
# ---------------------------------------------------------------------------

@router.get("/warehouses", response_model=Page[s.WarehouseRead])
async def list_warehouses(params: PageParams = Depends(), search: str | None = None,
                          is_active: bool | None = None, db: AsyncSession = Depends(get_db),
                          _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_warehouses(db, params, search=search, is_active=is_active)


@router.get("/warehouses/{warehouse_id}", response_model=s.WarehouseRead)
async def get_warehouse(warehouse_id: int, db: AsyncSession = Depends(get_db),
                        _=Depends(require_permission(STOCK_VIEW))):
    return await service.get_warehouse(db, warehouse_id)


@router.post("/warehouses", response_model=s.WarehouseRead, status_code=201)
async def create_warehouse(data: s.WarehouseWrite, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.create_warehouse(db, data, user)


@router.put("/warehouses/{warehouse_id}", response_model=s.WarehouseRead)
async def update_warehouse(warehouse_id: int, data: s.WarehouseWrite,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.update_warehouse(db, warehouse_id, data, user)


@router.get("/warehouses/{warehouse_id}/bins", response_model=list[s.BinRead])
async def bin_tree(warehouse_id: int, db: AsyncSession = Depends(get_db),
                   _=Depends(require_permission(STOCK_VIEW))):
    return await service.bin_tree(db, warehouse_id)


@router.get("/warehouses/{warehouse_id}/locations", response_model=list[s.LocationRead])
async def list_locations(warehouse_id: int, db: AsyncSession = Depends(get_db),
                         _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_locations(db, warehouse_id)


@router.post("/bins", response_model=s.BinRead, status_code=201)
async def create_bin(data: s.BinWrite, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.create_bin(db, data, user)


@router.put("/bins/{bin_id}", response_model=s.BinRead)
async def update_bin(bin_id: int, data: s.BinWrite, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.update_bin(db, bin_id, data, user)


@router.delete("/bins/{bin_id}", status_code=204)
async def delete_bin(bin_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    await service.delete_bin(db, bin_id, user)


@router.get("/storage-types", response_model=list[s.StorageTypeRead])
async def list_storage_types(db: AsyncSession = Depends(get_db),
                             _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_storage_types(db)


@router.post("/storage-types", response_model=s.StorageTypeRead, status_code=201)
async def create_storage_type(data: s.StorageTypeWrite,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.create_storage_type(db, data, user)


@router.put("/storage-types/{storage_type_id}", response_model=s.StorageTypeRead)
async def update_storage_type(storage_type_id: int, data: s.StorageTypeWrite,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(MASTER_LOCATION_MANAGE))):
    return await service.update_storage_type(db, storage_type_id, data, user)


# ---------------------------------------------------------------------------
# Inward — gate entry and GRN
# ---------------------------------------------------------------------------

@router.get("/receipts", response_model=Page[s.ReceiptRead])
async def list_receipts(params: PageParams = Depends(), receipt_type: str | None = None,
                        status: str | None = None, warehouse_id: int | None = None,
                        search: str | None = None, date_from: date | None = None,
                        date_to: date | None = None, gate_register: bool = False,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RECEIPT_VIEW))):
    return await service.list_receipts(db, params, receipt_type=receipt_type, status=status,
                                       warehouse_id=warehouse_id, search=search,
                                       date_from=date_from, date_to=date_to,
                                       gate_register=gate_register, user=user)


@router.get("/receipts/{receipt_id}", response_model=s.ReceiptDetail)
async def get_receipt(receipt_id: int, db: AsyncSession = Depends(get_db),
                      _=Depends(require_permission(RECEIPT_VIEW))):
    return await service.get_receipt(db, receipt_id)


@router.post("/receipts", response_model=s.ReceiptDetail, status_code=201)
async def create_receipt(data: s.ReceiptWrite, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.create_receipt(db, data, user)


@router.put("/receipts/{receipt_id}", response_model=s.ReceiptDetail)
async def update_receipt(receipt_id: int, data: s.ReceiptWrite,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.update_receipt(db, receipt_id, data, user)


@router.post("/receipts/{receipt_id}/convert-to-grn", response_model=s.ReceiptDetail)
async def convert_gate_entry(receipt_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.convert_gate_entry(db, receipt_id, user)


@router.post("/receipts/{receipt_id}/submit", response_model=s.ReceiptDetail)
async def submit_receipt(receipt_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.submit_receipt(db, receipt_id, user)


@router.post("/receipts/{receipt_id}/complete", response_model=s.ReceiptDetail)
async def complete_receipt(receipt_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(RECEIPT_POST))):
    return await service.complete_receipt(db, receipt_id, user)


@router.post("/receipts/{receipt_id}/cancel", response_model=s.ReceiptDetail)
async def cancel_receipt(receipt_id: int, body: s.ReasonIn, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.cancel_receipt(db, receipt_id, body.reason, user)


# ---------------------------------------------------------------------------
# Quality inspection
# ---------------------------------------------------------------------------

@router.get("/inspections", response_model=Page[s.InspectionRead])
async def list_inspections(params: PageParams = Depends(), inspection_type: str | None = None,
                           status: str | None = None, warehouse_id: int | None = None,
                           search: str | None = None, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(INSPECTION_VIEW))):
    return await service.list_inspections(db, params, inspection_type=inspection_type,
                                          status=status, warehouse_id=warehouse_id,
                                          search=search, user=user)


@router.get("/inspections/{inspection_id}", response_model=s.InspectionDetail)
async def get_inspection(inspection_id: int, db: AsyncSession = Depends(get_db),
                         _=Depends(require_permission(INSPECTION_VIEW))):
    return await service.get_inspection(db, inspection_id)


@router.post("/inspections", response_model=s.InspectionDetail, status_code=201)
async def create_inspection(data: s.InspectionWrite, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(INSPECTION_EXECUTE))):
    return await service.create_inspection(db, data, user)


@router.put("/inspections/{inspection_id}", response_model=s.InspectionDetail)
async def update_inspection(inspection_id: int, data: s.InspectionWrite,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(INSPECTION_EXECUTE))):
    return await service.update_inspection(db, inspection_id, data, user)


@router.post("/inspections/{inspection_id}/complete", response_model=s.InspectionDetail)
async def complete_inspection(inspection_id: int, db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(INSPECTION_EXECUTE))):
    return await service.complete_inspection(db, inspection_id, user)


@router.post("/inspections/{inspection_id}/cancel", response_model=s.InspectionDetail)
async def cancel_inspection(inspection_id: int, body: s.ReasonIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(INSPECTION_EXECUTE))):
    return await service.cancel_inspection(db, inspection_id, body.reason, user)


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

@router.get("/putaways", response_model=Page[s.PutawayRead])
async def list_putaways(params: PageParams = Depends(), status: str | None = None,
                        warehouse_id: int | None = None, search: str | None = None,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(PUTAWAY_VIEW))):
    return await service.list_putaways(db, params, status=status,
                                       warehouse_id=warehouse_id, search=search, user=user)


# Declared above /putaways/{task_id}: that path param is an int, so "candidates" would
# 422 against it rather than falling through.
@router.get("/putaways/candidates", response_model=list[s.PutawayCandidate])
async def putaway_candidates(grn_id: int, db: AsyncSession = Depends(get_db),
                             _=Depends(require_permission(PUTAWAY_VIEW))):
    return await service.putaway_candidates(db, grn_id)


@router.post("/putaways", response_model=list[s.PutawayRead], status_code=201)
async def create_putaway(data: s.PutawayCreate, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(PUTAWAY_EXECUTE))):
    return await service.create_putaway(db, data, user)


@router.get("/putaways/{task_id}", response_model=s.PutawayRead)
async def get_putaway(task_id: int, db: AsyncSession = Depends(get_db),
                      _=Depends(require_permission(PUTAWAY_VIEW))):
    return await service.get_putaway(db, task_id)


@router.get("/putaways/{task_id}/suggested-bins", response_model=list[s.BinRead])
async def suggested_bins(task_id: int, db: AsyncSession = Depends(get_db),
                         _=Depends(require_permission(PUTAWAY_VIEW))):
    return await service.suggested_bins(db, task_id)


@router.post("/putaways/{task_id}/start", response_model=s.PutawayRead)
async def start_putaway(task_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(PUTAWAY_EXECUTE))):
    return await service.start_putaway(db, task_id, user)


@router.post("/putaways/{task_id}/confirm", response_model=s.PutawayRead)
async def confirm_putaway(task_id: int, data: s.PutawayConfirm,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(PUTAWAY_EXECUTE))):
    return await service.confirm_putaway(db, task_id, data, user)


@router.post("/putaways/{task_id}/skip", response_model=s.PutawayRead)
async def skip_putaway(task_id: int, body: s.ReasonIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(PUTAWAY_EXECUTE))):
    return await service.skip_putaway(db, task_id, body.reason, user)


@router.get("/stock-movements", response_model=Page[s.StockMovementRead])
async def list_stock_movements(params: PageParams = Depends(),
                               db: AsyncSession = Depends(get_db),
                               _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_stock_movements(db, params)


@router.post("/stock-movements", response_model=s.StockMovementRead, status_code=201)
async def create_stock_movement(data: s.StockMovementWrite,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(STOCK_TRANSFER))):
    return await service.create_stock_movement(db, data, user)


@router.get("/stock-movement-orders", response_model=Page[s.StockMovementOrderRead])
async def list_stock_movement_orders(params: PageParams = Depends(),
                                     search: str | None = None,
                                     db: AsyncSession = Depends(get_db),
                                     _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_stock_movement_orders(db, params, search=search)


@router.post("/stock-movement-orders", response_model=s.StockMovementOrderRead, status_code=201)
async def create_stock_movement_order(data: s.StockMovementOrderWrite,
                                      db: AsyncSession = Depends(get_db),
                                      user=Depends(require_permission(STOCK_TRANSFER))):
    return await service.create_stock_movement_order(db, data, user)


@router.get("/stock-movements/availability", response_model=s.StockAvailabilityRead)
async def stock_availability(warehouse_id: int, source_bin_id: int, item_id: int,
                             batch_id: int | None = None,
                             db: AsyncSession = Depends(get_db),
                             _=Depends(require_permission(STOCK_VIEW))):
    return await service.stock_availability(
        db,
        warehouse_id=warehouse_id,
        source_bin_id=source_bin_id,
        item_id=item_id,
        batch_id=batch_id,
    )


# ---------------------------------------------------------------------------
# Picking
# ---------------------------------------------------------------------------

@router.get("/pickings", response_model=Page[s.PickingRead])
async def list_pickings(params: PageParams = Depends(), status: str | None = None,
                        warehouse_id: int | None = None, search: str | None = None,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(PICKING_VIEW))):
    return await service.list_pickings(db, params, status=status,
                                       warehouse_id=warehouse_id, search=search, user=user)


@router.get("/pickings/{picking_id}", response_model=s.PickingDetail)
async def get_picking(picking_id: int, db: AsyncSession = Depends(get_db),
                      _=Depends(require_permission(PICKING_VIEW))):
    return await service.get_picking(db, picking_id)


@router.post("/receipts/{receipt_id}/forward", response_model=list[s.IssueRead],
             status_code=201)
async def forward_arrival(receipt_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(ISSUE_FORWARD))):
    """Pass an arrived consignment on to the points below it. One draft per indent."""
    return await service.forward_arrival(db, receipt_id, user)


@router.post("/pickings", response_model=s.PickingDetail, status_code=201)
async def create_picking(data: s.PickingWrite, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(ISSUE_CREATE))):
    return await service.create_picking(db, data, user)


@router.post("/pickings/{picking_id}/release", response_model=s.PickingDetail)
async def release_picking(picking_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(ISSUE_CREATE))):
    return await service.release_picking(db, picking_id, user)


@router.post("/pickings/{picking_id}/lines/{line_id}/pick", response_model=s.PickingDetail)
async def pick_line(picking_id: int, line_id: int, data: s.PickLine,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(PICKING_PICK))):
    return await service.pick_line(db, picking_id, line_id, data, user)


@router.post("/pickings/{picking_id}/complete", response_model=s.PickingDetail)
async def complete_picking(picking_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(PICKING_PICK))):
    return await service.complete_picking(db, picking_id, user)


# ---------------------------------------------------------------------------
# Material issues
# ---------------------------------------------------------------------------

@router.get("/issues", response_model=Page[s.IssueRead])
async def list_issues(params: PageParams = Depends(), direction: str | None = None,
                      status: str | None = None, warehouse_id: int | None = None,
                      search: str | None = None, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(ISSUE_VIEW))):
    return await service.list_issues(db, params, direction=direction, status=status,
                                     warehouse_id=warehouse_id, search=search, user=user)


# --- working a whole monthly cycle -----------------------------------------
# Above /issues/{issue_id}: "cycles" is not an int, and FastAPI matches in
# declaration order.

@router.get("/issues/cycles")
async def issue_cycles(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_VIEW))):
    """Outstanding issues grouped by the monthly cycle they serve."""
    return {"items": await service.issue_cycles(db, user)}


@router.post("/issues/post-batch")
async def post_issues_batch(body: s.IssueBatchIn, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(ISSUE_POST))):
    """Post a whole cycle. One stock movement and one ledger row per issue."""
    return await service.post_issues_batch(db, body.issue_ids, user)


@router.get("/issues/{issue_id}", response_model=s.IssueDetail)
async def get_issue(issue_id: int, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(ISSUE_VIEW))):
    return await service.get_issue(db, issue_id, user)


@router.post("/issues", response_model=s.IssueDetail, status_code=201)
async def create_issue(data: s.IssueWrite, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_CREATE))):
    return await service.create_issue(db, data, user)


@router.put("/issues/{issue_id}", response_model=s.IssueDetail)
async def update_issue(issue_id: int, data: s.IssueWrite, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_CREATE))):
    return await service.update_issue(db, issue_id, data, user)


@router.post("/issues/{issue_id}/submit", response_model=s.IssueDetail)
async def submit_issue(issue_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_CREATE))):
    return await service.submit_issue(db, issue_id, user)


@router.post("/issues/{issue_id}/approve", response_model=s.IssueDetail)
async def approve_issue(issue_id: int, body: s.ApprovalIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(ISSUE_POST))):
    return await service.act_on_issue(
        db, issue_id, ApprovalAction.APPROVED.value, body.comments, user
    )


@router.post("/issues/{issue_id}/reject", response_model=s.IssueDetail)
async def reject_issue(issue_id: int, body: s.ApprovalIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_POST))):
    return await service.act_on_issue(
        db, issue_id, ApprovalAction.REJECTED.value, body.comments, user
    )


@router.post("/issues/{issue_id}/issue", response_model=s.IssueDetail)
async def post_issue(issue_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(ISSUE_POST))):
    return await service.post_issue(db, issue_id, user)


@router.put("/issues/{issue_id}/serials", response_model=s.IssueDetail)
async def set_issue_serials(issue_id: int, body: s.IssueSerialsIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(ISSUE_POST))):
    return await service.set_issue_serials(db, issue_id, body, user)


@router.post("/issues/{issue_id}/acknowledge", response_model=s.IssueDetail)
async def acknowledge_issue(issue_id: int, body: s.AcknowledgeIssueIn,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(ISSUE_VIEW))):
    return await service.acknowledge_issue(db, issue_id, body.remarks, user)


@router.post("/issues/{issue_id}/cancel", response_model=s.IssueDetail)
async def cancel_issue(issue_id: int, body: s.ReasonIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_CREATE))):
    return await service.cancel_issue(db, issue_id, body.reason, user)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

@router.get("/consignments", response_model=Page[s.DispatchRead])
async def list_consignments(params: PageParams = Depends(), status: str | None = None,
                            warehouse_id: int | None = None, search: str | None = None,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(DISPATCH_VIEW))):
    return await service.list_consignments(db, params, status=status,
                                           warehouse_id=warehouse_id, search=search, user=user)


@router.get("/consignments/{consignment_id}", response_model=s.DispatchDetail)
async def get_consignment(consignment_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_VIEW))):
    return await service.get_dispatch(db, consignment_id, user)


@router.post("/consignments", response_model=s.DispatchDetail, status_code=201)
async def create_consignment(data: s.ConsignmentWrite, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.create_consignment(db, data, user)


@router.put("/consignments/{consignment_id}", response_model=s.DispatchDetail)
async def update_consignment(consignment_id: int, data: s.ConsignmentWrite,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.update_consignment(db, consignment_id, data, user)


@router.get("/dispatches", response_model=Page[s.DispatchRead])
async def list_dispatches(params: PageParams = Depends(), status: str | None = None,
                          warehouse_id: int | None = None, search: str | None = None,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_VIEW))):
    return await service.list_dispatches(db, params, status=status,
                                         warehouse_id=warehouse_id, search=search, user=user)


@router.get("/dispatches/{dispatch_id}", response_model=s.DispatchDetail)
async def get_dispatch(dispatch_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(DISPATCH_VIEW))):
    return await service.get_dispatch(db, dispatch_id, user)


@router.post("/dispatches", response_model=s.DispatchDetail, status_code=201)
async def create_dispatch(data: s.DispatchWrite, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.create_dispatch(db, data, user)


@router.put("/dispatches/{dispatch_id}", response_model=s.DispatchDetail)
async def update_dispatch(dispatch_id: int, data: s.DispatchWrite,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.update_dispatch(db, dispatch_id, data, user)


@router.post("/dispatches/{dispatch_id}/submit", response_model=s.DispatchDetail)
async def submit_dispatch(dispatch_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.submit_dispatch(db, dispatch_id, user)


@router.post("/dispatches/{dispatch_id}/approve", response_model=s.DispatchDetail)
async def approve_dispatch(dispatch_id: int, body: s.ApprovalIn,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(DISPATCH_APPROVE))):
    return await service.act_on_dispatch(
        db, dispatch_id, ApprovalAction.APPROVED.value, body.comments, user
    )


@router.post("/dispatches/{dispatch_id}/reject", response_model=s.DispatchDetail)
async def reject_dispatch(dispatch_id: int, body: s.ApprovalIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_APPROVE))):
    return await service.act_on_dispatch(
        db, dispatch_id, ApprovalAction.REJECTED.value, body.comments, user
    )


@router.post("/dispatches/{dispatch_id}/packages", response_model=s.DispatchDetail)
async def add_package(dispatch_id: int, data: s.PackageWrite,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.add_package(db, dispatch_id, data, user)


@router.delete("/dispatches/{dispatch_id}/packages/{package_id}",
               response_model=s.DispatchDetail)
async def delete_package(dispatch_id: int, package_id: int,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(DISPATCH_CREATE))):
    return await service.delete_package(db, dispatch_id, package_id, user)


@router.post("/dispatches/{dispatch_id}/gate-out", response_model=s.DispatchDetail)
async def gate_out(dispatch_id: int, body: s.GatePassIn, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(DISPATCH_GATE_OUT))):
    return await service.gate_out(db, dispatch_id, body.gate_pass_no, user)


@router.post("/dispatches/{dispatch_id}/events", response_model=s.DispatchDetail)
async def add_dispatch_event(dispatch_id: int, data: s.DispatchEventWrite,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(DISPATCH_VIEW))):
    return await service.add_dispatch_event(db, dispatch_id, data, user)


@router.post("/dispatches/{dispatch_id}/acknowledge", response_model=s.DispatchDetail)
async def acknowledge_dispatch(dispatch_id: int, data: s.AcknowledgeWrite,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(DISPATCH_ACKNOWLEDGE))):
    return await service.acknowledge_dispatch(db, dispatch_id, data, user)


@router.post("/dispatches/{dispatch_id}/cancel", response_model=s.DispatchDetail)
async def cancel_dispatch(dispatch_id: int, body: s.ReasonIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_APPROVE))):
    return await service.cancel_dispatch(db, dispatch_id, body.reason, user)


# ---------------------------------------------------------------------------
# Purchase returns
# ---------------------------------------------------------------------------

@router.get("/returns", response_model=Page[s.ReturnRead])
async def list_returns(params: PageParams = Depends(), status: str | None = None,
                       warehouse_id: int | None = None, search: str | None = None,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(RETURN_VIEW))):
    return await service.list_returns(db, params, status=status, warehouse_id=warehouse_id,
                                      search=search, user=user)


@router.get("/returns/returnable-lines", response_model=list[s.ReceiptItemRead])
async def returnable_lines(grn_id: int = Query(...), db: AsyncSession = Depends(get_db),
                           _=Depends(require_permission(RETURN_VIEW))):
    return await service.returnable_lines(db, grn_id)


@router.get("/returns/{return_id}", response_model=s.ReturnDetail)
async def get_return(return_id: int, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(RETURN_VIEW))):
    return await service.get_return(db, return_id, user)


@router.post("/returns", response_model=s.ReturnDetail, status_code=201)
async def create_return(data: s.ReturnWrite, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_CREATE))):
    return await service.create_return(db, data, user)


@router.put("/returns/{return_id}", response_model=s.ReturnDetail)
async def update_return(return_id: int, data: s.ReturnWrite,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_CREATE))):
    return await service.update_return(db, return_id, data, user)


@router.post("/returns/{return_id}/submit", response_model=s.ReturnDetail)
async def submit_return(return_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_CREATE))):
    return await service.submit_return(db, return_id, user)


@router.post("/returns/{return_id}/approve", response_model=s.ReturnDetail)
async def approve_return(return_id: int, body: s.ApprovalIn,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RETURN_APPROVE))):
    return await service.act_on_return(
        db, return_id, ApprovalAction.APPROVED.value, body.comments, user
    )


@router.post("/returns/{return_id}/reject", response_model=s.ReturnDetail)
async def reject_return(return_id: int, body: s.ApprovalIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_APPROVE))):
    return await service.act_on_return(
        db, return_id, ApprovalAction.REJECTED.value, body.comments, user
    )


@router.post("/returns/{return_id}/complete", response_model=s.ReturnDetail)
async def complete_return(return_id: int, body: s.CreditNoteIn,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(RETURN_APPROVE))):
    return await service.complete_return(db, return_id, body.credit_note_no, user)


@router.post("/returns/{return_id}/cancel", response_model=s.ReturnDetail)
async def cancel_return(return_id: int, body: s.ReasonIn, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_CREATE))):
    return await service.cancel_return(db, return_id, body.reason, user)


# ---------------------------------------------------------------------------
# Serials, batches, scanning
# ---------------------------------------------------------------------------

@router.get("/serials", response_model=Page[s.SerialRead])
async def list_serials(params: PageParams = Depends(), status: str | None = None,
                       item_id: int | None = None, batch_id: int | None = None,
                       warehouse_id: int | None = None, bin_id: int | None = None,
                       search: str | None = None, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(STOCK_VIEW))):
    return await service.list_serials(db, params, status=status, item_id=item_id,
                                      batch_id=batch_id, warehouse_id=warehouse_id,
                                      bin_id=bin_id, search=search, user=user)


@router.get("/serials/summary")
async def serial_summary(item_ids: str, warehouse_ids: str | None = None,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(STOCK_VIEW))):
    """Serial / asset / consumable codes for a page of stock rows, grouped by item and
    stocking point. Called by the inventory stock screens, which cannot read this
    module's tables themselves."""
    def ids(raw: str | None) -> list[int]:
        return [int(part) for part in (raw or "").split(",") if part.strip().isdigit()]
    return {"items": await service.serial_summary(
        db, item_ids=ids(item_ids), warehouse_ids=ids(warehouse_ids) or None, user=user)}


@router.get("/batches", response_model=Page[s.BatchRead])
async def list_batches(params: PageParams = Depends(), item_id: int | None = None,
                       expiring_days: int | None = None, search: str | None = None,
                       db: AsyncSession = Depends(get_db),
                       _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_batches(db, params, item_id=item_id,
                                      expiring_days=expiring_days, search=search)


@router.get("/scan/{code:path}", response_model=s.ScanResult)
async def scan(code: str, db: AsyncSession = Depends(get_db),
               _=Depends(require_permission(STOCK_VIEW))):
    return await service.scan(db, code)


# ---------------------------------------------------------------------------
# Deliveries owed to a requester
# ---------------------------------------------------------------------------

# Feeds the Indents module's "to acknowledge" screen. It lives here because the issue
# and dispatch evidence does, and indents may not import this module (rule 5). Gated on
# indent.view, not a warehouse permission — the caller is a requester, and the service
# only ever returns their own indents.
@router.get("/deliveries/mine", response_model=list[IndentDeliveryRow])
async def my_deliveries(search: str | None = None, status: str | None = None,
                        only_actionable: bool = False,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(INDENT_VIEW))):
    return await service.deliveries_for_requester(
        db, user, search=search, status=status, only_actionable=only_actionable)


# The delivery half of an indent's journey, for the stepper on its detail page. Any
# viewer of the indent may see it — unlike /deliveries/mine, this is not the actor's
# own worklist.
@router.get("/indents/{indent_id}/fulfilment", response_model=list[IndentFulfilmentStep])
async def indent_fulfilment(indent_id: int, db: AsyncSession = Depends(get_db),
                            _=Depends(require_permission(INDENT_VIEW))):
    return await service.indent_fulfilment(db, indent_id)


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

@router.get("/attachments", response_model=list[s.AttachmentRead])
async def list_attachments(entity_type: str, entity_id: int,
                           db: AsyncSession = Depends(get_db),
                           _=Depends(require_permission(STOCK_VIEW))):
    return await service.list_attachments(db, entity_type, entity_id)


@router.post("/attachments", response_model=s.AttachmentRead, status_code=201)
async def add_attachment(entity_type: str = Form(...), entity_id: int = Form(...),
                         doc_category: str | None = Form(None), file: UploadFile = File(...),
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_CREATE))):
    return await service.add_attachment(
        db, entity_type=entity_type, entity_id=entity_id, upload=file,
        doc_category=doc_category, user=user)


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(attachment_id: int, db: AsyncSession = Depends(get_db),
                              _=Depends(require_permission(STOCK_VIEW))):
    path, file_name, mime_type = await service.attachment_file(db, attachment_id)
    return FileResponse(path, filename=file_name, media_type=mime_type)


@router.delete("/attachments/{attachment_id}", status_code=204)
async def delete_attachment(attachment_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(RECEIPT_CREATE))):
    await service.delete_attachment(db, attachment_id, user)


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

@router.get("/notifications", response_model=Page[s.NotificationRead])
async def list_notifications(params: PageParams = Depends(), unread_only: bool = False,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(STOCK_VIEW))):
    return await service.list_notifications(db, params, user, unread_only=unread_only)


@router.post("/notifications/{notification_id}/read", response_model=s.NotificationRead)
async def mark_notification_read(notification_id: int, db: AsyncSession = Depends(get_db),
                                 user=Depends(require_permission(STOCK_VIEW))):
    return await service.mark_notification_read(db, notification_id, user)


@router.post("/notifications/read-all")
async def mark_all_notifications_read(db: AsyncSession = Depends(get_db),
                                      user=Depends(require_permission(STOCK_VIEW))):
    return await service.mark_all_notifications_read(db, user)


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@router.get("/reports/{key}", response_model=s.ReportResult)
async def run_report(key: str, warehouse_id: int | None = None, date_from: date | None = None,
                     date_to: date | None = None, db: AsyncSession = Depends(get_db),
                     _=Depends(require_permission(WAREHOUSE_REPORT_VIEW))):
    return await service.run_report(db, key, warehouse_id=warehouse_id,
                                    date_from=date_from, date_to=date_to)


# ---------------------------------------------------------------------------
# Options — lookups the forms need
# ---------------------------------------------------------------------------

@router.get("/options/items", response_model=list[s.ItemOption])
async def item_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                       _=Depends(require_permission(STOCK_VIEW))):
    return await service.item_options(db, search)


@router.get("/options/vendors", response_model=list[s.Option])
async def vendor_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                         _=Depends(require_permission(STOCK_VIEW))):
    return await service.vendor_options(db, search)


@router.get("/options/warehouses", response_model=list[s.Option])
async def warehouse_options(mine_only: bool = False, all_points: bool = False,
                            db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(STOCK_VIEW))):
    return await service.warehouse_options(
        db, mine_only=mine_only, all_points=all_points, user=user)


@router.get("/options/bins", response_model=list[s.Option])
async def bin_options(warehouse_id: int, search: str | None = None,
                      item_id: int | None = None, batch_id: int | None = None,
                      storage_type_id: str | None = None,
                      all_locations: bool = False,
                      db: AsyncSession = Depends(get_db),
                      _=Depends(require_permission(STOCK_VIEW))):
    return await service.bin_options(
        db, warehouse_id, search, item_id=item_id, batch_id=batch_id, storage_type_id=storage_type_id, all_locations=all_locations
    )


@router.get("/options/batches", response_model=list[s.Option])
async def batch_options(item_id: int = Query(...), warehouse_id: int = Query(...),
                        bin_id: int | None = None, db: AsyncSession = Depends(get_db),
                        _=Depends(require_permission(STOCK_VIEW))):
    return await service.batch_options(
        db, item_id=item_id, warehouse_id=warehouse_id, bin_id=bin_id
    )


@router.get("/options/purchase-orders", response_model=list[s.Option])
async def po_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                     _=Depends(require_permission(RECEIPT_VIEW))):
    return await service.po_options(db, search)


@router.get("/options/po-lines", response_model=list[s.PoLineOption])
async def po_lines(po_id: int = Query(...), db: AsyncSession = Depends(get_db),
                   _=Depends(require_permission(RECEIPT_VIEW))):
    return await service.po_lines(db, po_id)


@router.get("/options/receipts", response_model=list[s.Option])
async def receipt_options(search: str | None = None, receipt_type: str | None = None,
                          warehouse_id: int | None = None, for_putaway: bool = False,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(RECEIPT_VIEW))):
    return await service.receipt_options(db, search, receipt_type,
                                         warehouse_id=warehouse_id,
                                         for_putaway=for_putaway, user=user)


@router.get("/options/incoming-dispatches", response_model=list[s.Option])
async def incoming_dispatch_options(warehouse_id: int = Query(...),
                                    search: str | None = None,
                                    db: AsyncSession = Depends(get_db),
                                    _=Depends(require_permission(RECEIPT_VIEW))):
    return await service.incoming_dispatch_options(db, warehouse_id, search)


@router.get("/options/dispatch-receipt-source", response_model=s.DispatchReceiptSource)
async def dispatch_receipt_source(dispatch_id: int = Query(...),
                                  warehouse_id: int = Query(...),
                                  db: AsyncSession = Depends(get_db),
                                  _=Depends(require_permission(RECEIPT_CREATE))):
    return await service.dispatch_receipt_source(db, dispatch_id, warehouse_id)


@router.get("/options/indents", response_model=list[s.Option])
async def indent_options(search: str | None = None, warehouse_id: int | None = None,
                         db: AsyncSession = Depends(get_db),
                         _=Depends(require_permission(ISSUE_VIEW))):
    return await service.indent_options(db, search, warehouse_id)


@router.get("/options/indent-issue-source", response_model=s.IndentIssueSource)
async def indent_issue_source(indent_id: int = Query(...), warehouse_id: int = Query(...),
                              db: AsyncSession = Depends(get_db),
                              _=Depends(require_permission(ISSUE_CREATE))):
    return await service.indent_issue_source(db, indent_id, warehouse_id)


@router.get("/options/picking-issue-source", response_model=s.PickingIssueSource)
async def picking_issue_source(picking_id: int = Query(...),
                               db: AsyncSession = Depends(get_db),
                               _=Depends(require_permission(ISSUE_CREATE))):
    return await service.picking_issue_source(db, picking_id)


@router.get("/options/issues", response_model=list[s.Option])
async def issue_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                        _=Depends(require_permission(DISPATCH_CREATE))):
    return await service.issue_options(db, search)


@router.get("/options/returnable-issues", response_model=list[s.Option])
async def returnable_issue_options(search: str | None = None,
                                   db: AsyncSession = Depends(get_db),
                                   _=Depends(require_permission(ISSUE_VIEW))):
    return await service.returnable_issue_options(db, search)


@router.get("/options/issue-dispatch-source", response_model=s.IssueDispatchSource)
async def issue_dispatch_source(issue_id: int = Query(...),
                                db: AsyncSession = Depends(get_db),
                                _=Depends(require_permission(DISPATCH_CREATE))):
    return await service.issue_dispatch_source(db, issue_id)


@router.get("/options/employees", response_model=list[s.Option])
async def employee_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                           _=Depends(require_permission(STOCK_VIEW))):
    return await service.employee_options(db, search)


@router.get("/options/projects", response_model=list[s.Option])
async def project_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                          _=Depends(require_permission(STOCK_VIEW))):
    return await service.project_options(db, search)


@router.get("/options/departments", response_model=list[s.Option])
async def department_options(db: AsyncSession = Depends(get_db),
                             _=Depends(require_permission(STOCK_VIEW))):
    return await service.department_options(db)


@router.get("/options/vehicles", response_model=list[s.Option])
async def vehicle_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                          _=Depends(require_permission(STOCK_VIEW))):
    return await service.vehicle_options(db, search)


@router.get("/options/carriers", response_model=list[s.Option])
async def carrier_options(search: str | None = None, db: AsyncSession = Depends(get_db),
                          _=Depends(require_permission(DISPATCH_VIEW))):
    return await service.carrier_options(db, search)


# ---------------------------------------------------------------------------
# Deleting a draft
#
# One endpoint per document type rather than one generic route: rule 6 wants the
# permission on the endpoint, and a `/drafts/{kind}` route could only ever declare
# one code for all eight. The service does the work; these pick the guard.
# ---------------------------------------------------------------------------

@router.delete("/receipts/{receipt_id}", status_code=204)
async def delete_receipt(receipt_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(RECEIPT_DELETE))):
    await service.delete_draft(db, "receipt", receipt_id, user)


@router.delete("/inspections/{inspection_id}", status_code=204)
async def delete_inspection(inspection_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(INSPECTION_DELETE))):
    await service.delete_draft(db, "inspection", inspection_id, user)


@router.delete("/putaways/{task_id}", status_code=204)
async def delete_putaway(task_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(PUTAWAY_DELETE))):
    await service.delete_draft(db, "putaway", task_id, user)


@router.delete("/pickings/{picking_id}", status_code=204)
async def delete_picking(picking_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(PICKING_DELETE))):
    await service.delete_draft(db, "picking", picking_id, user)


@router.delete("/issues/{issue_id}", status_code=204)
async def delete_issue(issue_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ISSUE_DELETE))):
    await service.delete_draft(db, "issue", issue_id, user)


@router.delete("/dispatches/{dispatch_id}", status_code=204)
async def delete_dispatch(dispatch_id: int, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(DISPATCH_DELETE))):
    await service.delete_draft(db, "dispatch", dispatch_id, user)


@router.delete("/returns/{return_id}", status_code=204)
async def delete_return(return_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(RETURN_DELETE))):
    await service.delete_draft(db, "return", return_id, user)


@router.delete("/stock-movements/{order_id}", status_code=204)
async def delete_stock_movement(order_id: int, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(MOVEMENT_DELETE))):
    await service.delete_draft(db, "movement", order_id, user)
