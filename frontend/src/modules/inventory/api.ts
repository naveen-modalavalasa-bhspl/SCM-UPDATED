import { api } from "@/shared/api/client";
import type {
  AllocationDecision,
  AllocationListRow,
  AllocationProposal,
  CatalogItemOption,
  MaterialRequest,
  MaterialRequestListRow,
  MovementRow,
  Page,
  ReplenishmentPOItem,
  StockBalanceFilter,
  StockBalanceItem,
  StockLedgerFilter,
  StockLedgerItem,
  StockRow,
  StockTransferCreate,
  StockTransferRow,
  VendorOption,
  WarehouseOption,
} from "./types";

/**
 * Inventory HTTP layer.
 *
 * This file used to hold an in-memory mock store (~870 lines) that tried the real
 * endpoint, swallowed any error, and returned invented rows. That is worse than
 * failing: the screens looked correct while showing numbers nobody could trace. Every
 * call here now goes to the real API and every error propagates so the UI can say so.
 *
 * Backend field names win. stk_balance carries available_qty / reserved_qty /
 * total_qty -- there is no physical_qty, valuation_rate or reorder_level, so those are
 * absent rather than faked.
 */

const unwrap = <T,>(page: Page<T>): T[] => page.items ?? [];

const num = (v: unknown): number => Number(v ?? 0);

/**
 * stk_balance -> the shape the existing views read.
 *
 * physical_qty is total_qty (what is on the shelf, reserved or not). Costing fields
 * are zero, not guessed: valuation is explicitly deferred, and a zero reads as "not
 * costed" where a plausible number would read as fact. Same for reorder levels, which
 * no master currently carries.
 */
const toBalance = (r: StockRow): StockBalanceItem => ({
  id: r.id,
  item_id: r.item_id,
  item_code: r.item_code ?? "",
  item_name: r.item_name ?? "",
  category_name: "",
  warehouse_id: r.warehouse_id,
  warehouse_name: r.warehouse_name ?? "",
  uom_code: r.uom_code ?? "",
  physical_qty: num(r.total_qty),
  reserved_qty: num(r.reserved_qty),
  available_qty: num(r.available_qty),
  reorder_level: 0,
  valuation_rate: 0,
  total_value: 0,
  batch_number: r.batch_no ?? undefined,
  expiry_date: r.expiry_date ?? undefined,
  storage_location: r.bin_code ?? undefined,
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

export const getStockBalances = (params?: StockBalanceFilter) =>
  api
    .get<Page<StockRow>>("/api/stock", {
      params: {
        item_id: params?.item_id,
        warehouse_id:
          params?.warehouse_id && params.warehouse_id !== "all"
            ? params.warehouse_id
            : undefined,
        page: params?.page ?? 1,
        size: params?.size ?? 200,
      },
    })
    .then((r) => unwrap(r.data).map(toBalance));

export const getStockLedger = (params?: StockLedgerFilter) =>
  api
    .get<Page<MovementRow>>("/api/stock/movements", {
      params: {
        item_id: params?.item_id,
        page: params?.page ?? 1,
        size: params?.size ?? 200,
      },
    })
    .then((r) => unwrap(r.data).map(toLedger));

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

export const getReservations = (params?: { item_id?: number; warehouse_id?: number; status?: string; page?: number; size?: number }) =>
  api.get("/api/reservations", { params }).then((r) => r.data);

export const releaseReservation = (id: number) =>
  api.post(`/api/reservations/${id}/release`).then((r) => r.data);

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

export const createCycleCount = (data: any) =>
  api.post("/api/stock/cycle-counts", data).then((r) => r.data);

export const listCycleCounts = (params?: { warehouse_id?: number; status?: string; page?: number; size?: number }) =>
  api.get("/api/stock/cycle-counts", { params }).then((r) => r.data);

export const getCycleCount = (id: number) =>
  api.get(`/api/stock/cycle-counts/${id}`).then((r) => r.data);

export const updateCycleCount = (id: number, data: any) =>
  api.put(`/api/stock/cycle-counts/${id}`, data).then((r) => r.data);

export const postCycleCount = (id: number) =>
  api.post(`/api/stock/cycle-counts/${id}/post`).then((r) => r.data);


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
  getStockTransfers: async (): Promise<any> => listSTOs(),
  receiveStockTransfer: async (id: number): Promise<any> => receiveSTO(id),
  cancelStockTransfer: async (_id: number): Promise<StockTransferRow> => {
    throw new Error("Transfer cancellation is not available yet");
  },

  // Adjustments & Replenishment
  adjustStock: createStockAdjustment,
  createStockAdjustment,
  listStockAdjustments,
  approveStockAdjustment,
  rejectStockAdjustment,
  getReplenishments,

  createReplenishmentPO: async (_payload: unknown) => {
    throw new Error("Replenishment is not available yet");
  },
  createPurchaseIndent: async (_items: ReplenishmentPOItem[]) => {
    throw new Error("Replenishment is not available yet");
  },
  exportStockLedger: async (_params?: StockLedgerFilter) => {
    throw new Error("Ledger export is not available yet");
  },
};

