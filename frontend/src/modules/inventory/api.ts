import { api } from "@/shared/api/client";
import type {
  PositionLocationTag, PositionLocationWrite, MovementClassification,
  MyStockingPoints, PositionSearchHit, StockingPointQuery, StockingPointTagPage,
  AllocationDecision,
  AllocationHistoryRow,
  Allocation,
  AllocationListRow,
  AllocationProposal,
  AllocationApprovalBatch,
  ItemClaims,
  AllocBatchResult,
  AllocationBatchResult,
  BatchDemand,
  FulfilmentBatch,
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
  StockSummary,
  LedgerSummary,
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

/** Stocking points for a FILTER on an inventory screen.
 *
 * The scoped options endpoint, not the `/api/warehouses` master. The master lists
 * every point in the company — it is the maintenance screen's data — so Stock Balance
 * and Stock Ledger offered a lab technician all 200 locations and then returned no
 * rows for 199 of them. This one returns exactly the points the login's data scope
 * covers, so the filter and the grid agree. */
export const getWarehouses = () =>
  api
    .get<WarehouseOption[]>("/api/warehouse/options/warehouses")
    .then((r) => r.data);

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
        expiry_status: params?.expiry_status,
        expiry_from: params?.expiry_from,
        expiry_to: params?.expiry_to,
        expired_in_last_days: params?.expired_in_last_days,
        page: params?.page ?? 1,
        size: params?.size ?? 20,
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
        size: params?.size ?? 20,
      }),
    })
    .then((r) => ({ items: unwrap(r.data).map(toLedger), total: r.data.total }));

// The KPI tiles above both grids. They read the whole filtered set, which the
// browser never holds — summing `items` counted whatever page happened to be open,
// so every tile changed when the page size did.
export const getStockSummary = (params?: StockBalanceFilter) =>
  api
    .get<StockSummary>("/api/stock/summary", {
      params: clean({
        item_id: params?.item_id,
        warehouse_id: params?.warehouse_id,
        category_id: params?.category_id,
        search: params?.search?.trim(),
        batch_no: params?.batch_no?.trim(),
        include_zero: params?.include_zero || undefined,
        below_reorder: params?.below_reorder || undefined,
        expiring_in_days: params?.expiring_in_days,
        expiry_status: params?.expiry_status,
        expiry_from: params?.expiry_from,
        expiry_to: params?.expiry_to,
        expired_in_last_days: params?.expired_in_last_days,
      }),
    })
    .then((r) => r.data);

export const getStockLedgerSummary = (params?: StockLedgerFilter) =>
  api
    .get<LedgerSummary>("/api/stock/movements/summary", {
      params: clean({
        item_id: params?.item_id,
        warehouse_id: params?.warehouse_id,
        direction: params?.direction,
        ref_type: params?.ref_type,
        search: params?.search?.trim(),
        date_from: params?.date_from,
        date_to: params?.date_to,
      }),
    })
    .then((r) => r.data);

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
/**
 * Everything that still owes something, whatever status it is sitting in.
 *
 * has_remainder alone: only indents whose approved quantity exceeds what has been
 * allocated. Pairing it with a status hid the whole queue — an indent part-served on
 * its way up approval is still PENDING_APPROVAL, and one nobody has touched is
 * AWAITING_ALLOCATION; neither is PARTIALLY_FULFILLED, which is what the filter asked
 * for. The remainder IS the queue, so it is the only filter.
 */
/** One row per ITEM across every indent still owed — the consolidated view.
 *
 *  Nine hundred monthly indents are nine hundred rows in the queue above, and none of
 *  them shows that between them they want 4,000 gloves against 2,500 on the shelf.
 *  This is the same rows grouped, computed fresh; no batch is stored anywhere. */
export const getBatchDemand = (cycle?: string) =>
  api
    .get<BatchDemand>("/api/allocations/demand", {
      params: cycle ? { cycle } : undefined,
    })
    .then((r) => r.data);

/** One row per monthly cycle still owed — what the Fulfilment Queue shows in place of
 *  every indent in that cycle. */
/** Allocations awaiting me, grouped into the monthly cycle they serve. Without this
 *  the batch work just moves the queue along: 900 indents approved at once, allocated
 *  at once, and then 900 allocations to open and sign one by one. */
export const getAllocationApprovalBatches = (includeDone = false) =>
  api.get<{ items: AllocationApprovalBatch[] }>(
    "/api/allocations/approval-batches",
    { params: includeDone ? { include_done: true } : undefined })
    .then((r) => r.data);

export const approveAllocationsBatch = (allocationIds: number[], comments = "") =>
  api.post<AllocBatchResult>("/api/allocations/approve-batch",
                             { allocation_ids: allocationIds, comments })
    .then((r) => r.data);

export const rejectAllocationsBatch = (allocationIds: number[], comments = "") =>
  api.post<AllocBatchResult>("/api/allocations/reject-batch",
                             { allocation_ids: allocationIds, comments })
    .then((r) => r.data);

export const getFulfilmentBatches = (includeDone = false) =>
  api.get<{ items: FulfilmentBatch[] }>(
    "/api/allocations/batches",
    { params: includeDone ? { include_done: true } : undefined }).then((r) => r.data);

/** The fulfilment queue's indents. `owedOnly` keeps the default reading — a line
 *  still owed — while false returns fulfilled and rejected indents too, so what was
 *  allocated can be looked up rather than only what is outstanding. */
export const getFulfillmentQueue = (status?: string, owedOnly = true) =>
  api
    .get<Page<Record<string, unknown>>>("/api/indents", {
      params: {
        size: 100,
        ...(owedOnly ? { has_remainder: true } : {}),
        ...(status ? { status } : {}),
      },
    })
    .then((r) => r.data);

// ---- allocation: the human decision ----

export const getAllocationProposal = (indentId: number) =>
  api.get<AllocationProposal>(`/api/allocations/proposal/${indentId}`).then((r) => r.data);

/** Who is holding the "N claimed by other indents" on an allocation line, itemised.
 *  `indentId` is the one being allocated, and is excluded from the answer. */
export const getItemClaims = (itemId: number, indentId: number) =>
  api.get<ItemClaims>(`/api/allocations/claims/${itemId}`, { params: { indent_id: indentId } })
    .then((r) => r.data);

/** Every indent in a cycle allocated in one request — one allocation each, exactly
 *  what `createAllocation` writes for a single indent. Not atomic across indents by
 *  design: one that somebody else already served must not discard the other 899. */
export const createAllocationsBatch = (
  allocations: { indent_id: number; decisions: AllocationDecision[] }[],
) =>
  api
    .post<AllocationBatchResult>("/api/allocations/batch", { allocations })
    .then((r) => r.data);

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

/** Who has signed this allocation so far, and under which hat. */
export const getAllocationHistory = (id: number) =>
  api
    .get<{ items: AllocationHistoryRow[] }>(`/api/workflow/history/ALLOCATION/${id}`)
    .then((r) => r.data.items);

// Both allocation events land on the same screen. OWN_STOCK_ALLOCATION is the same
// document decided by the person who holds the point rather than by the inventory
// desk — only the approver differs, so there is nothing to separate in the UI.
const ALLOCATION_DOC_TYPES = ["ALLOCATION", "OWN_STOCK_ALLOCATION"];

// Filtered by the server: the endpoint pages now (rule 11), so pulling every task
// this user has and keeping two of the types in the browser would silently drop
// allocations past the first page.
export const getPendingInventoryApprovals = () =>
  api.get<Page<WorkflowPending>>("/api/workflow/pending", {
    params: { doc_type: ALLOCATION_DOC_TYPES.join(","), page: 1, size: 500 },
  }).then((r) => r.data.items ?? []);

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


/* ---------------- Stocking points: tiers, tagging, classification ---------------- */

/** One page of position→point tags, narrowed by the caller's own scope.
 *
 *  Paged and filtered on the server: the live tagging is ~2,000 rows, so searching it
 *  in the browser meant downloading the whole org before the first keystroke could
 *  match anything. `tier_counts` describes the whole filtered set, not the page. */
export const listStockingPointTags = (params: StockingPointQuery = {}) =>
  api.get<StockingPointTagPage>("/api/stocking-points/tags", { params })
    .then((r) => r.data);

export const tagStockingPoint = (body: PositionLocationWrite) =>
  api.post<PositionLocationTag>("/api/stocking-points/tags", body).then((r) => r.data);

export const untagStockingPoint = (tagId: number) =>
  api.delete(`/api/stocking-points/tags/${tagId}`).then((r) => r.data);

/** What a move between two points would be — shown read-only beside the pickers. */
export const classifyMove = (fromWarehouseId?: number | null, toWarehouseId?: number | null) =>
  api.get<MovementClassification>("/api/stocking-points/classify", {
    params: { from_warehouse_id: fromWarehouseId, to_warehouse_id: toWarehouseId },
  }).then((r) => r.data);

/** Find a position by person, employee code or post name. Nobody knows raw ids. */
export const searchPositions = (query: string) =>
  api.get<PositionSearchHit[]>("/api/stocking-points/positions", { params: { q: query } })
    .then((r) => r.data);

/** The points this login draws from and can see into — own plus reporting subtree. */
export const getMyStockingPoints = () =>
  api.get<MyStockingPoints>("/api/stocking-points/mine").then((r) => r.data);

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
  // Stocking points
  listStockingPointTags,
  tagStockingPoint,
  untagStockingPoint,
  classifyMove,
  getMyStockingPoints,
  searchPositions,
};
