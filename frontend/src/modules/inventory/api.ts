import { api } from "@/shared/api/client";
import type {
  AllocationDecision,
  Allocation,
  AllocationListRow,
  AllocationProposal,
  CatalogItemOption,
  MaterialRequest,
  MaterialRequestListRow,
  MovementRow,
  Page,
  ReplenishmentRule,
  StockBalanceFilter,
  StockBalanceItem,
  StockDetail,
  StockLedgerFilter,
  StockLedgerItem,
  StockRow,
  StockTransferCreate,
  VendorOption,
  WarehouseOption,
  WorkflowPending,
} from "./types";

/**
 * Inventory HTTP layer.
 *
 * This file used to hold an in-memory mock store (~870 lines) that tried the real
 * endpoint, swallowed any error, and returned invented rows. That is worse than
 * failing: the screens looked correct while showing numbers nobody could trace. Every
 * call here now goes to the real API and every error propagates so the UI can say so.
 *
 * Backend field names win. Every filter here matches a query param the endpoint
 * actually accepts -- the versions these replaced built a filter object the request
 * then dropped, so the screens had filter controls that changed nothing.
 */

const unwrap = <T,>(page: Page<T>): T[] => page.items ?? [];

const num = (v: unknown): number => Number(v ?? 0);

/**
 * stk_balance -> the shape the existing views read.
 *
 * physical_qty is total_qty (what is on the shelf, reserved or not). category,
 * reorder level and cost are not stk_balance columns; the backend fills them from
 * mst_items on the way out (service.list_stock).
 */
const toBalance = (r: StockRow): StockBalanceItem => ({
  id: r.id,
  item_id: r.item_id,
  item_code: r.item_code ?? "",
  item_name: r.item_name ?? "",
  category_name: r.category_name ?? "",
  warehouse_id: r.warehouse_id,
  warehouse_name: r.warehouse_name ?? "",
  uom_code: r.uom_code ?? "",
  physical_qty: num(r.total_qty),
  reserved_qty: num(r.reserved_qty),
  transit_qty: num(r.transit_qty),
  available_qty: num(r.available_qty),
  reorder_level: num(r.reorder_level),
  valuation_rate: num(r.valuation_rate),
  total_value: num(r.stock_value),
  batch_number: r.batch_no ?? undefined,
  batch_id: r.batch_id,
  expiry_date: r.expiry_date ?? undefined,
  storage_location: r.bin_code ?? undefined,
  bin_code: r.bin_code ?? undefined,
  project_name: r.project_name ?? undefined,
  serial_number: r.serial_number ?? undefined,
  asset_code: r.asset_code ?? undefined,
  consumable_code: r.consumable_code ?? undefined,
  barcode_value: r.barcode_value ?? undefined,
  last_movement_at: r.last_movement_at ?? undefined,
});

/** stk_ledger -> the shape the ledger view reads. One row is IN or OUT, never both. */
const toLedger = (r: MovementRow): StockLedgerItem => ({
  id: r.id,
  transaction_date: r.created_at,
  transaction_no: r.ref_no ?? String(r.id),
  transaction_type: r.ref_type ?? "",
  item_id: r.item_id,
  item_code: r.item_code ?? "",
  item_name: r.item_name ?? "",
  warehouse_id: r.warehouse_id,
  warehouse_name: r.warehouse_name ?? "",
  uom_code: r.uom_code ?? "",
  in_qty: r.direction === "IN" ? num(r.quantity) : 0,
  out_qty: r.direction === "OUT" ? num(r.quantity) : 0,
  balance_qty: num(r.balance_after),
  unit_rate: 0,
  total_value: 0,
  reference_no: r.ref_no ?? undefined,
  performed_by: r.created_by_name ?? undefined,
  batch_number: r.batch_no ?? undefined,
  created_by: r.created_by_name ?? undefined,
});

// ---- masters (shared endpoints, not inventory's own) ----

export const getWarehouses = () =>
  api
    .get<Page<WarehouseOption>>("/api/warehouses", { params: { size: 200 } })
    .then((r) => unwrap(r.data));

export const getCatalogItems = () =>
  api
    .get<Page<CatalogItemOption>>("/api/items", { params: { size: 500 } })
    .then((r) => unwrap(r.data));

export const getVendors = () =>
  api
    .get<Page<VendorOption>>("/api/vendors", { params: { size: 200 } })
    .then((r) => unwrap(r.data));

// ---- stock ----

/** Blank strings and "all" mean "no filter" — they must not reach the query string. */
const clean = <T extends Record<string, unknown>>(params: T) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== "" && v !== undefined && v !== null && v !== "all"),
  );

export const getStockBalances = (params?: StockBalanceFilter) =>
  api
    .get<Page<StockRow>>("/api/stock", {
      params: clean({
        item_id: params?.item_id,
        warehouse_id: params?.warehouse_id,
        category_id: params?.category_id,
        search: params?.search?.trim(),
        batch_no: params?.batch_no?.trim(),
        include_zero: params?.include_zero || undefined,
        below_reorder: params?.below_reorder || undefined,
        expiring_in_days: params?.expiring_in_days,
        page: params?.page ?? 1,
        size: params?.size ?? 200,
      }),
    })
    .then((r) => ({ items: unwrap(r.data).map(toBalance), total: r.data.total }));

export const getStockLedger = (params?: StockLedgerFilter) =>
  api
    .get<Page<MovementRow>>("/api/stock/movements", {
      params: clean({
        item_id: params?.item_id,
        warehouse_id: params?.warehouse_id,
        direction: params?.direction,
        ref_type: params?.ref_type,
        search: params?.search?.trim(),
        date_from: params?.date_from,
        date_to: params?.date_to,
        page: params?.page ?? 1,
        size: params?.size ?? 200,
      }),
    })
    .then((r) => ({ items: unwrap(r.data).map(toLedger), total: r.data.total }));

export const createStockTransfer = (payload: StockTransferCreate) =>
  api.post<void>("/api/stock/transfer", payload).then((r) => r.data);

// ---- material requests ----

export const listMaterialRequests = (params?: { status?: string; indent_id?: number }) =>
  api
    .get<Page<MaterialRequestListRow>>("/api/material-requests", {
      params: { ...params, size: 100 },
    })
    .then((r) => r.data);

export const getMaterialRequest = (id: number) =>
  api.get<MaterialRequest>(`/api/material-requests/${id}`).then((r) => r.data);

export const approveMaterialRequest = (id: number, comments = "") =>
  api
    .post<MaterialRequest>(`/api/material-requests/${id}/approve`, { comments })
    .then((r) => r.data);

export const rejectMaterialRequest = (id: number, comments = "") =>
  api
    .post<MaterialRequest>(`/api/material-requests/${id}/reject`, { comments })
    .then((r) => r.data);

// ---- fulfilment queue ----

/**
 * Indents that have been through the availability check. There is no dedicated
 * endpoint: the indent list already filters by status, and a second way to ask the
 * same question would be a second thing to keep in step.
 */
export const getFulfillmentQueue = (status = "PARTIALLY_FULFILLED") =>
  api
    .get<Page<Record<string, unknown>>>("/api/indents", {
      params: { status, size: 100 },
    })
    .then((r) => r.data);

// ---- allocation: the human decision ----

export const getAllocationProposal = (indentId: number) =>
  api.get<AllocationProposal>(`/api/allocations/proposal/${indentId}`).then((r) => r.data);

export const createAllocation = (indentId: number, decisions: AllocationDecision[], remarks?: string) =>
  api
    .post("/api/allocations", { indent_id: indentId, decisions, remarks })
    .then((r) => r.data);

export const listAllocations = (params?: { status?: string; indent_id?: number }) =>
  api
    .get<Page<AllocationListRow>>("/api/allocations", { params: { ...params, size: 100 } })
    .then((r) => r.data);

export const getAllocation = (id: number) =>
  api.get<Allocation>(`/api/allocations/${id}`).then((r) => r.data);

export const getPendingInventoryApprovals = () =>
  api.get<{ items: WorkflowPending[] }>("/api/workflow/pending")
    .then((r) => r.data.items.filter((item) => item.doc_type === "ALLOCATION"));

// ---- New Inventory Module Endpoints ----

export const getOverviewKPIs = () =>
  api.get("/api/stock/overview-kpis").then((r) => r.data);

export const createStockAdjustment = (data: any) =>
  api.post("/api/stock/adjust", data).then((r) => r.data);

export const listStockAdjustments = (params?: { warehouse_id?: number; status?: string; page?: number; size?: number }) =>
  api.get("/api/stock/adjustments", { params }).then((r) => r.data);

export const approveStockAdjustment = (id: number) =>
  api.post(`/api/stock/adjustments/${id}/approve`).then((r) => r.data);

export const rejectStockAdjustment = (id: number) =>
  api.post(`/api/stock/adjustments/${id}/reject`).then((r) => r.data);

export const getReplenishments = (params?: { warehouse_id?: number; category_id?: number; criticality?: string }) =>
  api.get("/api/stock/replenishment", { params }).then((r) => r.data);

/** Every lot of this row's item in this row's warehouse, plus the path to each bin. */
export const getStockDetail = (stockId: number) =>
  api.get<StockDetail>(`/api/stock/${stockId}/detail`).then((r) => r.data);

export const listReplenishmentRules = (params?: { warehouse_id?: number; item_id?: number }) =>
  api.get<ReplenishmentRule[]>("/api/stock/replenishment-rules", { params: clean(params ?? {}) })
    .then((r) => r.data);

export const saveReplenishmentRule = (rule: ReplenishmentRule) =>
  api.put<ReplenishmentRule>("/api/stock/replenishment-rules", {
    warehouse_id: rule.warehouse_id, item_id: rule.item_id,
    min_qty: rule.min_qty, max_qty: rule.max_qty, reorder_qty: rule.reorder_qty,
  }).then((r) => r.data);

export const deleteReplenishmentRule = (warehouseId: number, itemId: number) =>
  api.delete<void>(`/api/stock/replenishment-rules/${warehouseId}/${itemId}`).then((r) => r.data);

export const getItemAvailability = (itemId: number, projectId?: number, warehouseId?: number) =>
  api.get(`/api/stock/${itemId}/availability`, { params: { project_id: projectId, warehouse_id: warehouseId } }).then((r) => r.data);

export const getStockAgeing = (warehouseId?: number) =>
  api.get("/api/stock/ageing", { params: { warehouse_id: warehouseId } }).then((r) => r.data);

export const getStockValuation = (warehouseId?: number) =>
  api.get("/api/stock/valuation", { params: { warehouse_id: warehouseId } }).then((r) => r.data);

export const getNearExpiryAlerts = (days = 90) =>
  api.get("/api/stock/near-expiry-alerts", { params: { days } }).then((r) => r.data);

export const createSTO = (data: any) =>
  api.post("/api/stock/sto", data).then((r) => r.data);

export const listSTOs = (params?: { status?: string; page?: number; size?: number }) =>
  api.get("/api/stock/sto", { params }).then((r) => r.data);

export const getSTO = (id: number) =>
  api.get(`/api/stock/sto/${id}`).then((r) => r.data);

export const approveSTO = (id: number) =>
  api.post(`/api/stock/sto/${id}/approve`).then((r) => r.data);

export const dispatchSTO = (id: number) =>
  api.post(`/api/stock/sto/${id}/dispatch`).then((r) => r.data);

export const receiveSTO = (id: number) =>
  api.post(`/api/stock/sto/${id}/receive`).then((r) => r.data);

export const approveAllocation = (id: number, comments = "") =>
  api.post(`/api/allocations/${id}/approve`, { comments }).then((r) => r.data);

export const rejectAllocation = (id: number, comments = "") =>
  api.post(`/api/allocations/${id}/reject`, { comments }).then((r) => r.data);

export const inventoryApi = {
  getWarehouses,
  getCatalogItems,
  getVendors,
  getStockBalances,
  getStockBalance: getStockBalances,
  getStockLedger,
  createStockTransfer,
  createTransfer: createStockTransfer,
  listMaterialRequests,
  getMaterialRequest,
  approveMaterialRequest,
  rejectMaterialRequest,
  getFulfillmentQueue,

  // STO methods
  listSTOs,
  createSTO,
  approveSTO,
  dispatchSTO,
  receiveSTO,
  // Adjustments & Replenishment
  adjustStock: createStockAdjustment,
  createStockAdjustment,
  listStockAdjustments,
  approveStockAdjustment,
  rejectStockAdjustment,
  getReplenishments,
};
