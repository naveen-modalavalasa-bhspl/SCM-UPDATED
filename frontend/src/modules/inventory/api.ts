import { api } from "@/shared/api/client";
import type {
  PositionLocationTag, PositionLocationWrite, MovementClassification,
  MyStockingPoints, PositionSearchHit, StockingPointQuery, StockingPointTagPage,
  AllocationDecision,
  AllocationHistoryRow,
  Allocation,
  AllocationLineAvailability,
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
  MRClaims,
  MovementRow,
  Page,
  ReplenishmentRule,
  StockBalanceFilter,
  StockBalanceItem,
  StockDetail,
  StockLedgerFilter,
  StockLedgerItem,
  StockSummary,
  SerialSummaryRow,
  UnitCodeRow,
  UnitRow,
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
  // Both, and for different jobs: the CODE is the stored identity every document and
  // export is keyed on, the NAME is what the grid prints. The six oldest UOM masters
  // carry their prefix inside the code, so printing the code read as "12 UOM-GMS".
  uom_name: r.uom_name ?? undefined,
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
  // Carried, not only its label: the per-unit lookup narrows to a bin, and a bin CODE
  // is not unique across warehouses.
  bin_id: r.bin_id,
  bin_code: r.bin_code ?? undefined,
  project_name: r.project_name ?? undefined,
  // Flattened for display: the list column shows the first and counts the rest.
  serial_number: r.serial_number?.length ? r.serial_number.join(", ") : undefined,
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
  // Kept null when the ledger row has no rate rather than coerced to 0: a zero here
  // reads as "this stock is worthless", which is a different claim from "nobody
  // costed it". Rows written before stk_ledger.rate/.value were mapped are null.
  unit_rate: r.rate == null ? null : num(r.rate),
  total_value: r.value == null ? null : num(r.value),
  serial_number: r.serial_numbers?.length ? r.serial_numbers.join(", ") : undefined,
  // The raw list as well as the joined string. The columns need the individual units
  // to look their codes up and to list them; the joined string is only a caption.
  serial_numbers: r.serial_numbers?.length ? r.serial_numbers : undefined,
  // FIXED 2026-08-21 — the lot the movement touched. THIS is why the ledger showed a
  // dash for units that were sitting correctly coded in `whs_serial_numbers`: the row
  // reached the screen through this mapper, which dropped bin and batch, so the unit
  // lookup asked for `item:warehouse::` — a key `indexSerials` only ever writes for
  // UNPLACED units — and missed every put-away lot. Adding the fields to the API and
  // to the row type was necessary and not sufficient; the mapper in between has to
  // carry them.
  bin_id: r.bin_id ?? undefined,
  batch_id: r.batch_id ?? undefined,
  asset_code: r.asset_code ?? undefined,
  consumable_code: r.consumable_code ?? undefined,
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

/**
 * Serial / IMEI and asset-or-consumable codes for the rows on screen, grouped by item
 * and stocking point.
 *
 * They are not on the stock tables: `stk_balance` is one row per LOT and a lot here
 * holds up to 88 units, so its single `serial_number` column cannot say which units
 * they are. The warehouse module owns per-unit identity, and inventory may not import
 * it (rule 5), so the screens ask for the page they are showing and merge — the same
 * shape as the KPI summary call beside them.
 */
export const getSerialSummary = (itemIds: number[], warehouseIds: number[]) =>
  itemIds.length === 0
    ? Promise.resolve([] as SerialSummaryRow[])
    : api
        .get<{ items: SerialSummaryRow[] }>("/api/warehouse/serials/summary", {
          params: {
            item_ids: [...new Set(itemIds)].join(","),
            warehouse_ids: [...new Set(warehouseIds)].join(","),
          },
        })
        .then((r) => r.data.items);

/** "Not placed", written the same way on both sides of the join. `stk_balance` says 0
 * for bulk (NO_BIN / NO_BATCH); `whs_serial_numbers` says NULL. Keyed literally, a bulk
 * lot asks for `:0:0` while its own units are filed under `::` and never finds them. */
export const unplaced = (v?: number | null) => (v ? String(v) : "");

/** What else the named units carry — serial, IMEI, asset code, consumable code.
 *
 * NEW 2026-08-22. A ledger row names the units that MOVED (`stk_ledger.serial_numbers`)
 * but not their putaway codes, which live per unit in the warehouse module. Asked for
 * by the page in hand and merged, the same way `getSerialSummary` beside it works.
 *
 * POST for a read because one page of the ledger can name a couple of thousand units
 * and that will not fit in a query string. Codes are deduplicated here so a hundred
 * rows off one consignment ask once.
 */
export const getUnitCodes = (codes: string[]) => {
  const wanted = [...new Set(codes.filter(Boolean))];
  return wanted.length === 0
    ? Promise.resolve([] as UnitCodeRow[])
    : api
        .post<{ items: UnitCodeRow[] }>("/api/warehouse/serials/codes", { codes: wanted })
        .then((r) => r.data.items);
};

/** Index the answer by every identity a unit answers to, so a caller holding one
 *  string finds the row whichever kind of code it turned out to be.
 *
 *  Keyed on ITEM AND identity, never identity alone. `whs_serial_numbers.serial_number`
 *  is not unique across items in the live data — `SN-00000003` exists three times, on
 *  a monitor, a mouse and one other item — so a bare map handed the mouse's movement
 *  the monitor's asset code, which is a worse answer than none. The caller always
 *  knows which item its row is about. */
export const unitCodeKey = (itemId: number, identity: string) => `${itemId}:${identity}`;

export const indexUnitCodes = (rows: UnitCodeRow[]) => {
  const by = new Map<string, UnitCodeRow>();
  for (const row of rows) {
    for (const key of [row.serial_number, row.asset_code, row.consumable_code]) {
      const full = key && unitCodeKey(row.item_id, key);
      if (full && !by.has(full)) by.set(full, row);
    }
  }
  return by;
};

/** Index a summary under the keys that HONESTLY describe it, most specific first:
 * item+warehouse+bin+batch, then item+warehouse+bin, then item+warehouse.
 *
 * A row only rolls up into a coarser bucket when it genuinely lacks that dimension.
 * Rolling every row up unconditionally is what let a lot with no units of its own
 * display another lot's: 20 unplaced units at a point were offered to a 10 gram lot
 * standing in BINA1, which reported "20 units in lot" over a quantity of 10. A unit
 * that is in a bin belongs to that bin's lot and to no other. */
export const indexSerials = (rows: SerialSummaryRow[]) => {
  const byKey = new Map<string, SerialSummaryRow>();
  const merge = (key: string, row: SerialSummaryRow) => {
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { ...row }); return; }
    seen.count += row.count;
    seen.serials = seen.serials.concat(row.serials).slice(0, 5);
    seen.imeis = seen.imeis.concat(row.imeis).slice(0, 5);
    seen.codes = seen.codes.concat(row.codes).slice(0, 5);
    seen.asset_codes = (seen.asset_codes ?? []).concat(row.asset_codes ?? []).slice(0, 5);
    seen.consumable_codes = (seen.consumable_codes ?? [])
      .concat(row.consumable_codes ?? []).slice(0, 5);
    seen.asset_count = (seen.asset_count ?? 0) + (row.asset_count ?? 0);
    seen.consumable_count = (seen.consumable_count ?? 0) + (row.consumable_count ?? 0);
  };
  for (const r of rows) {
    const bin = unplaced(r.bin_id), batch = unplaced(r.batch_id);
    merge(`${r.item_id}:${r.warehouse_id}:${bin}:${batch}`, r);
    if (!batch) merge(`${r.item_id}:${r.warehouse_id}:${bin}`, r);
    if (!bin && !batch) merge(`${r.item_id}:${r.warehouse_id}`, r);
  }
  return byKey;
};

/** The server's own ceiling (`core.pagination.MAX_PAGE_SIZE`), so one request asks for
 *  as much as one request may carry. */
const UNITS_PAGE_SIZE = 500;

/** How many of those pages this panel will walk. 10,000 is `MAX_UNITS_PER_CODE_MINT`
 *  — the most units one receipt can ever be coded into — so a lot built by a single
 *  inward is always shown whole. Past that the panel says what it is showing rather
 *  than pulling an unbounded list into the browser. */
const UNITS_MAX_PAGES = 20;

/** The units standing at one item + point (+ bin + batch when known).
 *
 *  PAGED THROUGH, not asked for once (2026-09-03). This requested `size: 500` and took
 *  the first page, on the reasoning that "the largest lot in the live data is 108
 *  units" — true when it was written, and no longer: `_place_unit_codes` mints one
 *  coded unit per whole unit received, so a 10,000-unit inward is one lot of 10,000.
 *  500 is also the server's `MAX_PAGE_SIZE`, so raising the number did nothing; the
 *  panel simply showed 500 codes over a caption reading "10000 units in lot" and
 *  offered Copy-all and Download that quietly held 5% of the lot.
 */
export const getUnits = async (params: {
  item_id: number; warehouse_id?: number | null;
  bin_id?: number | null; batch_id?: number | null;
}) => {
  const rows: UnitRow[] = [];
  for (let page = 1; page <= UNITS_MAX_PAGES; page += 1) {
    const { data } = await api.get<Page<UnitRow>>("/api/warehouse/serials", {
      params: {
        item_id: params.item_id,
        warehouse_id: params.warehouse_id || undefined,
        bin_id: params.bin_id || undefined,
        batch_id: params.batch_id || undefined,
        page,
        size: UNITS_PAGE_SIZE,
      },
    });
    rows.push(...data.items);
    // Short page or the whole count in hand: there is nothing after this one.
    if (data.items.length < UNITS_PAGE_SIZE || rows.length >= (data.total ?? rows.length)) break;
  }
  return rows;
};

/** Find ONE unit by whatever identity is printed on its label — serial, IMEI, asset
 * code or consumable code. Resolves to null when nothing matches: "no unit carries
 * this" is an ordinary answer to a search box, not an error to shout about, so the
 * endpoint answers 200 with `found:false` rather than a 404 the logger would file. */
export const lookupUnit = (code: string) =>
  api
    .get<UnitRow & { found: boolean }>("/api/warehouse/serials/lookup", { params: { code } })
    .then((r) => (r.data?.found ? r.data : null))
    .catch(() => null);

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
        stock_view: params?.stock_view || undefined,
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
        stock_view: params?.stock_view || undefined,
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

export interface MaterialRequestCreate {
  items: { item_id: number; quantity: number; project_id?: number | null;
           indent_item_id?: number | null }[];
  indent_id?: number | null;
  indent_no?: string | null;
  priority?: string | null;
  required_by?: string | null;
  remarks?: string | null;
}

/** Raise a request by hand. `indent_id` set when the allocation screen raised it for a
 *  line the warehouse cannot serve; absent for a free-standing buy. */
export const createMaterialRequest = (body: MaterialRequestCreate) =>
  api.post<MaterialRequest>("/api/material-requests", body).then((r) => r.data);

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

/** Change what the request asks for before it is signed. Lines are keyed by MR LINE
 *  id, never item id — one MR can carry the same item twice. */
export const reviseMaterialRequest = (
  id: number,
  lines: { id: number; quantity: number }[],
  comments = "",
) =>
  api
    .patch<MaterialRequest>(`/api/material-requests/${id}/items`, { lines, comments })
    .then((r) => r.data);

/** The other open requests wanting this item — this one excluded. */
export const getMRItemClaims = (mrId: number, itemId: number) =>
  api
    .get<MRClaims>(`/api/material-requests/${mrId}/claims/${itemId}`)
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
 *  allocated can be looked up rather than only what is outstanding.
 *
 *  `to_serve` is what makes this a QUEUE and not a list: an indent still climbing
 *  belongs to the rung it is parked on, who serves it from his own stock at the moment
 *  he approves. An approver who has already signed and passed it up keeps seeing it on
 *  /indents and in its journey — it is simply no longer work waiting on him. */
export const getFulfillmentQueue = (status?: string, owedOnly = true) =>
  api
    .get<Page<Record<string, unknown>>>("/api/indents", {
      params: {
        size: 100,
        to_serve: true,
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

/** Live free stock behind every line of one allocation — what the approver may give. */
export const getAllocationAvailability = (id: number) =>
  api
    .get<AllocationLineAvailability[]>(`/api/allocations/${id}/availability`)
    .then((r) => r.data);

/** Every allocation's history in ONE call. Opening a 900-allocation cycle used to
 *  fire 900 requests, which is why the screen took minutes. */
export const getAllocationHistories = (allocationIds: number[]) =>
  api
    .post<{ items: Record<string, AllocationHistoryRow[]> }>(
      "/api/allocations/history-batch", { allocation_ids: allocationIds })
    .then((r) => r.data.items ?? {});

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

/** `revisions` are the approver's own quantities, one entry per changed line. Sending
 *  none approves exactly what inventory decided, as before. */
export const approveAllocation = (
  id: number, comments = "", revisions: { id: number; quantity: number }[] = [],
) =>
  api.post(`/api/allocations/${id}/approve`, { comments, revisions })
    .then((r) => r.data);

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
  createMaterialRequest,
  getMaterialRequest,
  approveMaterialRequest,
  rejectMaterialRequest,
  reviseMaterialRequest,
  getMRItemClaims,
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
