import { api } from "@/shared/api/client";
import type {
  AcknowledgeWrite,
  ApprovalEvent,
  Attachment,
  Batch,
  Bin,
  BinWrite,
  Dispatch,
  DispatchEventWrite,
  DispatchReceiptSource,
  DispatchWrite,
  ConsignmentWrite,
  Inspection,
  HandlingUnit,
  InspectionWrite,
  OutboundInspection,
  OutboundInspectionWrite,
  Issue,
  IssueDispatchSource,
  IssueStockSource,
  UnitSupply,
  IssueWrite,
  ItemOption,
  LocationOption,
  VolumeBudget,
  ItemLocationsOut,
  StockReportScopes,
  ListParams,
  LocationOccupancy,
  Notification,
  OccupancyMove,
  Option,

  Page,
  PackageWrite,
  Picking,
  PickingWrite,
  DespatchPrefill,

  PoPrefill,
  PurchaseReturn,
  PurchaseReturnWrite,
  Putaway,
  PutawayCandidate,
  PutawayCodes,
  PutawayConfirm,
  PutawayUnitCode,
  PutawayCreate,
  Receipt,
  ReceiptRouting,
  ReceiptWrite,
  SerialNumber,
  StockAvailability,
  StockMovement,
  StockMovementWrite,
  StockMovementOrder,
  StockMovementOrderWrite,
  StorageType,
  StorageTypeWrite,
  Warehouse,
  WarehouseDashboard,
  WarehouseLocation,
  WarehouseOption,
  WarehouseWrite,
  TrackingTypeMeta,
} from "./types";

/**
 * Warehouse HTTP layer.
 *
 * The screens this replaced shipped their own axios instance pointed at `/api/v1`,
 * with its own interceptors, its own 401 handling and its own toast import. There is
 * one client for the whole app — `@/shared/api/client` — and it already attaches the
 * token and unwraps the backend's single error shape, so every call here goes
 * through it and every failure surfaces as an `Error` the screen can render.
 *
 * Paths are all under `/api/warehouse/...`; the module owns that prefix and nothing
 * else. Lookups the forms need (items, vendors, POs) are served by this module's own
 * `/options` routes rather than reaching into another module's endpoints.
 */

const BASE = "/api/warehouse";

/** Strips undefined/"" so a blank filter control never sends `?status=`. */
const clean = (params: object = {}) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const get = async <T,>(url: string, params?: object): Promise<T> =>
  (await api.get<T>(url, { params: clean(params) })).data;

const post = async <T,>(url: string, body?: unknown): Promise<T> =>
  (await api.post<T>(url, body)).data;

const put = async <T,>(url: string, body?: unknown): Promise<T> =>
  (await api.put<T>(url, body)).data;

const del = async (url: string): Promise<void> => {
  await api.delete(url);
};

/* --------------------------------------------------------------- dashboard -- */

export const getDashboard = (warehouse_id?: number) =>
  get<WarehouseDashboard>(`${BASE}/dashboard`, { warehouse_id });

/* --------------------------------------------------------- warehouse master -- */

export const listWarehouses = (params: ListParams = {}) =>
  get<Page<Warehouse>>(`${BASE}/warehouses`, params);

export const getWarehouse = (id: number) => get<Warehouse>(`${BASE}/warehouses/${id}`);

export const createWarehouse = (body: WarehouseWrite) =>
  post<Warehouse>(`${BASE}/warehouses`, body);

export const updateWarehouse = (id: number, body: WarehouseWrite) =>
  put<Warehouse>(`${BASE}/warehouses/${id}`, body);

/**
 * How much of a storage location's cube the locations inside it already claim.
 *
 * Every rung of the tree is measured, not just the bays, and a location has to be at
 * least as big as everything directly inside it. The form asks for this while it is
 * being filled in so the answer is "1.4 m³ of 4 m³ still free inside RACK-1" rather
 * than a refusal after Save — and it is SERVED, so the sentence on screen and the rule
 * the server enforces are the same arithmetic.
 */
export const locationVolumeBudget = (binId: number) =>
  get<VolumeBudget>(`${BASE}/bins/${binId}/volume-budget`);

/** The bin tree for one warehouse — zones, racks and shelves nested by `parent_id`. */
export const getBinTree = (warehouseId: number) =>
  get<Bin[]>(`${BASE}/warehouses/${warehouseId}/bins`);

export const createBin = (body: BinWrite) => post<Bin>(`${BASE}/bins`, body);

export const updateBin = (id: number, body: BinWrite) => put<Bin>(`${BASE}/bins/${id}`, body);

export const deleteBin = (id: number) => del(`${BASE}/bins/${id}`);

/**
 * How full a storage location is, and what a proposed move would do to it.
 *
 * One call for both directions: putaway asks with `IN` ("does this fit"), material
 * issue with `OUT` ("how much does this give back"). The wording comes back with the
 * numbers — see `LocationOccupancy.headline` — so no screen writes its own.
 */
export const locationOccupancy = (
  locationId: number,
  params: {
    item_id?: number;
    qty?: number;
    direction?: "IN" | "OUT";
    /** Which pack the quantity moves in. A bin is checked against handling units, so
     *  "3 cases" and "1500 eaches" are different questions about the same `qty`. */
    item_packaging_id?: number | null;
  } = {},
) => get<LocationOccupancy>(`${BASE}/locations/${locationId}/occupancy`, params);

/**
 * Which packaging units an item can be put away in, each with its own box and gross
 * weight. Served rather than assembled here so the volume on the picker is the volume
 * the bin check will use.
 */
export const itemHandlingUnits = (itemId: number) =>
  get<HandlingUnit[]>(`${BASE}/items/${itemId}/handling-units`);

/**
 * The same answer for a whole draft, one row per location it touches.
 *
 * Asked in one request because an issue commonly takes several lines out of the same
 * bin: the space that frees is their sum, netted on the server so no screen has to add
 * volumes up and get it subtly wrong. POST carries the lines; it writes nothing.
 */
export const occupancyPreview = (moves: OccupancyMove[]) =>
  post<LocationOccupancy[]>(`${BASE}/locations/occupancy-preview`, { moves });

/** The physical layer behind the floor plan — `whs_locations`, with coordinates. */
export const listLocations = (warehouseId: number) =>
  get<WarehouseLocation[]>(`${BASE}/warehouses/${warehouseId}/locations`);

export const listStorageTypes = () => get<StorageType[]>(`${BASE}/storage-types`);

export const createStorageType = (body: StorageTypeWrite) =>
  post<StorageType>(`${BASE}/storage-types`, body);

export const updateStorageType = (id: number, body: StorageTypeWrite) =>
  put<StorageType>(`${BASE}/storage-types/${id}`, body);

export const deleteStorageType = (id: number) => del(`${BASE}/storage-types/${id}`);

/** Put the standard rungs back on a site whose master is empty. Idempotent — a kind
 *  that is already there is left exactly as it has been edited. */
export const seedStorageTypes = () =>
  post<StorageType[]>(`${BASE}/storage-types/seed-defaults`, {});

/* ------------------------------------------------------------------ inward -- */

/** `gate_register` lists every row that was ever a gate entry, converted or not. */
export const listReceipts = (
  params: ListParams & { receipt_type?: string; gate_register?: boolean } = {},
) => get<Page<Receipt>>(`${BASE}/receipts`, params);

export const getReceipt = (id: number) => get<Receipt>(`${BASE}/receipts/${id}`);

export const createReceipt = (body: ReceiptWrite) => post<Receipt>(`${BASE}/receipts`, body);

export const updateReceipt = (id: number, body: ReceiptWrite) =>
  put<Receipt>(`${BASE}/receipts/${id}`, body);

export const convertReceiptToGrn = (id: number) =>
  post<Receipt>(`${BASE}/receipts/${id}/convert-to-grn`);

/** Freezes the receipt and raises the inspection tasks behind it. */
export const submitReceipt = (id: number) => post<Receipt>(`${BASE}/receipts/${id}/submit`);

/** Where each GRN line goes — a QC draft or straight to putaway. A forecast before
 *  submit, the record after it. */
export const getReceiptRouting = (id: number) =>
  get<ReceiptRouting>(`${BASE}/receipts/${id}/routing`);

/** Splits a GRN the retired GRN approval left at SUBMITTED with nothing raised. */
export const routeParkedReceipt = (id: number) =>
  post<Receipt>(`${BASE}/receipts/${id}/route`);

/** Pass an arrived consignment on to the points below — the MDP leg of WH -> MDP -> LIP.
 *  Builds one DRAFT issue per indent; the storekeeper still reviews and submits. */
export const forwardArrival = (id: number) =>
  post<Issue[]>(`${BASE}/receipts/${id}/forward`);

/** Posts accepted quantity to stock and raises the putaway tasks. */
export const completeReceipt = (id: number) => post<Receipt>(`${BASE}/receipts/${id}/complete`);

export const cancelReceipt = (id: number, reason?: string) =>
  post<Receipt>(`${BASE}/receipts/${id}/cancel`, { reason });

/**
 * What the order still OWES, so the GRN form fills itself from it.
 *
 * Only the lines with something outstanding — a fully received line is not one to
 * receive again. `receiptId` is the receipt being filled, whose own lines must not
 * count against it, or a saved receipt re-filling from its order would be told the
 * order owes nothing, by itself.
 */
export const getPoLines = (poId: number, receiptId?: number | null) =>
  get<PoPrefill>(`${BASE}/options/po-lines`, {
    po_id: poId, receipt_id: receiptId ?? undefined,
  });

/** Despatch notes the vendor has filed against an order — only SUBMITTED ones, since
 *  a draft is the vendor still typing. */
export const despatchNoteOptions = (poId: number) =>
  get<Option[]>(`${BASE}/options/despatch-notes`, { po_id: poId });

/** The vendor's paperwork and per-line batch/expiry, in the shape this form needs.
 *  Header and lines in one call — at the gate they are one act. */
export const getDespatchPrefill = (noteId: number, receiptId?: number | null) =>
  get<DespatchPrefill>(`${BASE}/options/despatch-prefill`, {
    note_id: noteId, receipt_id: receiptId ?? undefined,
  });

/* ----------------------------------------------------------- quality (in) -- */

// `inspection_type` is this list's own filter (the endpoint takes it), not something
// every warehouse list understands — so it widens here rather than in ListParams.
export const listInspections = (
  params: ListParams & { inspection_type?: string; receipt_id?: number } = {},
) => get<Page<Inspection>>(`${BASE}/inspections`, params);

export const getInspection = (id: number) => get<Inspection>(`${BASE}/inspections/${id}`);

export const createInspection = (body: InspectionWrite) =>
  post<Inspection>(`${BASE}/inspections`, body);

export const updateInspection = (id: number, body: InspectionWrite) =>
  put<Inspection>(`${BASE}/inspections/${id}`, body);

/** Writes the pass/fail back onto the receipt lines. */
export const completeInspection = (id: number) =>
  post<Inspection>(`${BASE}/inspections/${id}/complete`);

export const cancelInspection = (id: number, reason?: string) =>
  post<Inspection>(`${BASE}/inspections/${id}/cancel`, { reason });

/* ----------------------------------------------------------- qc outward -- */

/** Older inspections store per-unit objects while the editor consumes identifiers. */
const serialStrings = (value: unknown): string[] => {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>).flatMap((entry) =>
          Array.isArray(entry) ? entry : [entry])
      : [];
  return [...new Set(values.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const unit = entry as Record<string, unknown>;
    return String(unit.serial_number ?? unit.serial_no ?? unit.asset_code
      ?? unit.consumable_code ?? unit.imei_no ?? "");
  }).filter(Boolean))];
};

const normaliseOutboundInspection = (row: OutboundInspection): OutboundInspection => ({
  ...row,
  items: row.items?.map((line) => ({
    ...line,
    serial_numbers: serialStrings((line as { serial_numbers?: unknown }).serial_numbers),
  })),
});

export const listOutboundInspections = (params: ListParams = {}) =>
  get<Page<OutboundInspection>>(`${BASE}/outbound-inspections`, params);

export const getOutboundInspection = (id: number) =>
  get<OutboundInspection>(`${BASE}/outbound-inspections/${id}`).then(normaliseOutboundInspection);

export const createOutboundInspection = (body: OutboundInspectionWrite) =>
  post<OutboundInspection>(`${BASE}/outbound-inspections`, body).then(normaliseOutboundInspection);

export const updateOutboundInspection = (id: number, body: OutboundInspectionWrite) =>
  put<OutboundInspection>(`${BASE}/outbound-inspections/${id}`, body).then(normaliseOutboundInspection);

export const completeOutboundInspection = (id: number) =>
  post<OutboundInspection>(`${BASE}/outbound-inspections/${id}/complete`);

/* Only reachable where a QC_OUTWARD ladder is configured on Approvals Config —
   without one, `complete` finishes the check and the document never sits at
   PENDING_APPROVAL for anyone to sign. */
export const approveOutboundInspection = (id: number, comments = "") =>
  post<OutboundInspection>(`${BASE}/outbound-inspections/${id}/approve`, { comments });

export const rejectOutboundInspection = (id: number, comments: string) =>
  post<OutboundInspection>(`${BASE}/outbound-inspections/${id}/reject`, { comments });

/* ----------------------------------------------------------------- putaway -- */

export const listPutaways = (params: ListParams = {}) =>
  get<Page<Putaway>>(`${BASE}/putaways`, params);

export const getPutaway = (id: number) => get<Putaway>(`${BASE}/putaways/${id}`);

/**
 * The label sheet's header — what this putaway minted and how many.
 *
 * A separate call from `getPutaway`: a task carries one line, but a line of 500 units
 * carries 500 codes, and only the detail screen's label panel ever wants them. This one
 * carries none of them, only the count; `putawayCodeUnits` pages through the codes.
 */
export const putawayCodes = (id: number) =>
  get<PutawayCodes>(`${BASE}/putaways/${id}/codes`);

/** One page of the codes, searchable by code, serial or IMEI. */
export const putawayCodeUnits = (
  id: number, params: { page?: number; size?: number; search?: string } = {},
) => get<Page<PutawayUnitCode>>(`${BASE}/putaways/${id}/codes/units`, params);

/** GRN lines a manual putaway could be raised for. Ineligible ones come back too,
 *  carrying the reason, so the picker can grey them out instead of hiding them. */
export const putawayCandidates = (grn_id: number) =>
  get<PutawayCandidate[]>(`${BASE}/putaways/candidates`, { grn_id });

/** Raises tasks by hand for GRN lines that have none. Empty `grn_item_ids` = all. */
export const createPutaway = (body: PutawayCreate) =>
  post<Putaway[]>(`${BASE}/putaways`, body);

export const startPutaway = (id: number) => post<Putaway>(`${BASE}/putaways/${id}/start`);

/** Confirming a putaway is what moves the stock into the bin. */
export const confirmPutaway = (id: number, body: PutawayConfirm) =>
  post<Putaway>(`${BASE}/putaways/${id}/confirm`, body);

/* `suggestBins` was here. Nothing suggests a location any more — a putaway may be
 * confirmed into any rung of the tree, so a shortlist of eight bays in front of
 * somebody who may legitimately choose any of nine hundred is a wrong answer with a
 * ranking on it. The location picker walks the hierarchy; the capacity meter measures
 * whatever was chosen. */

export const listStockMovements = (params: ListParams = {}) =>
  get<Page<StockMovement>>(`${BASE}/stock-movements`, params);

export const createStockMovement = (body: StockMovementWrite) =>
  post<StockMovement>(`${BASE}/stock-movements`, body);

export const listStockMovementOrders = (params: ListParams = {}) =>
  get<Page<StockMovementOrder>>(`${BASE}/stock-movement-orders`, params);

export const getStockMovementOrder = (order_no: string) =>
  get<StockMovementOrder>(`${BASE}/stock-movement-orders/${encodeURIComponent(order_no)}`);

export const createStockMovementOrder = (body: StockMovementOrderWrite) =>
  post<StockMovementOrder>(`${BASE}/stock-movement-orders`, body);

export const submitStockMovementOrder = (id: number) =>
  post<StockMovementOrder>(`${BASE}/stock-movement-orders/${id}/submit`);

export const completeStockMovementInspection = (id: number) =>
  post<StockMovementOrder>(`${BASE}/stock-movement-orders/${id}/complete-inspection`);

export const completeStockMovementOrder = (id: number) =>
  post<StockMovementOrder>(`${BASE}/stock-movement-orders/${id}/complete`);

/** Approve or reject a movement waiting on a signature. Only reachable when the
 *  project has an approval ladder configured for STOCK_MOVEMENT_ORDER — with none
 *  (every project today) a movement completes on the press and never lands here. */
export const actOnStockMovementOrder = (
  orderId: number, action: "APPROVED" | "REJECTED", comments = "",
) =>
  post<{ id: number; order_no: string; status: string;
         current_approver_name?: string | null }>(
    `${BASE}/stock-movement-orders/${orderId}/act`, { action, comments });


/**
 * Every (batch, bin) the given items can be drawn from at this warehouse, oldest
 * stock first — what a quantity larger than any one bin is SPLIT across.
 *
 * `indent_id` for the same reason `binOptions` takes it: an issue against an
 * approved allocation must still be offered the stock its own reservation holds.
 */
export const issueStockSources = (
  warehouse_id: number,
  item_ids: number[],
  indent_id?: number | null,
) =>
  post<IssueStockSource[]>(`${BASE}/issues/stock-sources/fetch`, {
    warehouse_id,
    item_ids,
    indent_id,
  });

/**
 * How many identified units each (item, batch, location) could name, right now.
 *
 * Asked for the whole grid in one call rather than per row — a fifty-pick issue
 * re-probing on every batch change would otherwise be fifty requests a keystroke
 * apart. The count is bounded at `need + 1` on the server, so it stays cheap over a
 * table holding 773k unit rows.
 */
export const issueUnitSupply = (
  warehouse_id: number,
  picks: UnitSupplyPick[],
  issue_id?: number | null,
  direction: "OUT" | "IN" = "OUT",
) =>
  post<UnitSupply[]>(`${BASE}/issues/unit-supply`, {
    warehouse_id, picks, issue_id, direction,
  });

export interface UnitSupplyPick {
  item_id: number;
  batch_id?: number | null;
  bin_id?: number | null;
  need: number;
  line_id?: number | null;
}

/** What each kind of unit identifier is called. Served so no screen writes the
 *  words "asset tag" or "IMEI" itself — see the backend's `TRACKING_META`. */
export const trackingTypes = () => get<TrackingTypeMeta[]>(`${BASE}/tracking-types`);

export const getStockAvailability = (
  warehouse_id: number,
  source_bin_id: number | null | undefined,
  item_id: number,
  batch_id?: number | null,
) => get<StockAvailability>(`${BASE}/stock-movements/availability`, {
  warehouse_id,
  source_bin_id,
  item_id,
  batch_id,
});

/* --------------------------------------------------------------- picklists -- */

export const listPickings = (params: ListParams = {}) =>
  get<Page<Picking>>(`${BASE}/pickings`, params);

export const getPicking = (id: number) => get<Picking>(`${BASE}/pickings/${id}`);

export const createPicking = (body: PickingWrite) => post<Picking>(`${BASE}/pickings`, body);

export const releasePicking = (id: number) => post<Picking>(`${BASE}/pickings/${id}/release`);

export const pickLine = (id: number, lineId: number, picked_qty: number, bin_id?: number) =>
  post<Picking>(`${BASE}/pickings/${id}/lines/${lineId}/pick`, { picked_qty, bin_id });

export const completePicking = (id: number) => post<Picking>(`${BASE}/pickings/${id}/complete`);

/* ---------------------------------------------------------- material issues -- */

export const listIssues = (params: ListParams & { direction?: string } = {}) =>
  get<Page<Issue>>(`${BASE}/issues`, params);

export const getIssue = (id: number) => get<Issue>(`${BASE}/issues/${id}`);

export const createIssue = (body: IssueWrite) => post<Issue>(`${BASE}/issues`, body);

export const updateIssue = (id: number, body: IssueWrite) => put<Issue>(`${BASE}/issues/${id}`, body);

/** Hands the document to the shared workflow engine. */
export const submitIssue = (id: number) => post<Issue>(`${BASE}/issues/${id}/submit`);

export const approveIssue = (id: number, comments = "") =>
  post<Issue>(`${BASE}/issues/${id}/approve`, { comments });

export const rejectIssue = (id: number, comments = "") =>
  post<Issue>(`${BASE}/issues/${id}/reject`, { comments });

/** Posts the movement — this is the point stock actually leaves the shelf. */
export const postIssue = (id: number) => post<Issue>(`${BASE}/issues/${id}/issue`);

/** One child issue per warehouse floor holding stock for the parent's items. */
export interface IssueSplitResult {
  parent_issue_id: number;
  parent_issue_no: string;
  children: {
    id: number; issue_no: string;
    floor_location_id: number | null; floor_location_name: string | null;
    total_items: number; total_qty: string;
  }[];
  /** What no floor was holding. Reported, never rounded away — the shortage belongs
   *  to the indent and hiding it is how a site waits for goods nobody is buying. */
  unfulfilled: { item_id: number; item_code: string | null; item_name: string | null; qty: string }[];
}

/** Hand an approved issue down to the floors that are actually holding the stock. */
export const splitIssue = (id: number) =>
  post<IssueSplitResult>(`${BASE}/issues/${id}/split`);

/** Names the physical units after approval — the rest of the issue stays frozen. */
export const setIssueSerials = (
  id: number,
  lines: { id: number; serial_numbers: string[] }[],
) => put<Issue>(`${BASE}/issues/${id}/serials`, { lines });

export const acknowledgeIssue = (id: number, remarks?: string) =>
  post<Issue>(`${BASE}/issues/${id}/acknowledge`, { remarks });

export const cancelIssue = (id: number, reason?: string) =>
  post<Issue>(`${BASE}/issues/${id}/cancel`, { reason });

/**
 * Every rung the document has already passed, from the engine's own log.
 *
 * The one call in this module that leaves `/api/warehouse` — deliberately: approval
 * history belongs to `platform/workflow`, which owns it for every document type, and
 * mirroring those rows onto the issue payload would be a second copy of the truth.
 * An issue submits under one of two doc types (modules/warehouse/service.py):
 * `WH_ISSUE` normally, `OWN_STOCK_ISSUE` when it leaves a point the submitter holds.
 * Which one is not on the issue payload, so both are asked and the non-empty one wins
 * — cheaper than a round trip to find out which to ask for.
 */
export const issueApprovalHistory = async (id: number) => {
  const results = await Promise.all(
    ["WH_ISSUE", "OWN_STOCK_ISSUE"].map((docType) =>
      get<{ items: ApprovalEvent[] }>(`/api/workflow/history/${docType}/${id}`)
        .then((r) => r.items)
        .catch(() => [] as ApprovalEvent[]),
    ),
  );
  return results.flat();
};

/* ---------------------------------------------------------------- dispatch -- */

// `inbound` narrows the page to consignments ARRIVING at this login's own points —
// the receiving desk's question, which the ordinary scope (keyed on the sending dock)
// cannot answer. Only that one screen wants it, so it widens here, not in ListParams.
export const listDispatches = (params: ListParams & { inbound?: boolean } = {}) =>
  get<Page<Dispatch>>(`${BASE}/dispatches`, params);

export const getDispatch = (id: number) => get<Dispatch>(`${BASE}/dispatches/${id}`);

export const listConsignments = (params: ListParams = {}) =>
  get<Page<Dispatch>>(`${BASE}/consignments`, params);

export const getConsignment = (id: number) => get<Dispatch>(`${BASE}/consignments/${id}`);

export const createConsignment = (body: ConsignmentWrite) =>
  post<Dispatch>(`${BASE}/consignments`, body);

export const updateConsignment = (id: number, body: ConsignmentWrite) =>
  put<Dispatch>(`${BASE}/consignments/${id}`, body);

export const createDispatch = (body: DispatchWrite) => post<Dispatch>(`${BASE}/dispatches`, body);

export const updateDispatch = (id: number, body: DispatchWrite) =>
  put<Dispatch>(`${BASE}/dispatches/${id}`, body);

export const submitDispatch = (id: number) => post<Dispatch>(`${BASE}/dispatches/${id}/submit`);

export const approveDispatch = (id: number, comments = "") =>
  post<Dispatch>(`${BASE}/dispatches/${id}/approve`, { comments });

export const rejectDispatch = (id: number, comments = "") =>
  post<Dispatch>(`${BASE}/dispatches/${id}/reject`, { comments });

export const dispatchGateOut = (id: number, gate_pass_no?: string) =>
  post<Dispatch>(`${BASE}/dispatches/${id}/gate-out`, { gate_pass_no });

export const cancelDispatch = (id: number, reason?: string) =>
  post<Dispatch>(`${BASE}/dispatches/${id}/cancel`, { reason });

/** Packages — the outward labelling screen builds and prints these. */
export const addPackage = (dispatchId: number, body: PackageWrite) =>
  post<Dispatch>(`${BASE}/dispatches/${dispatchId}/packages`, body);

export const deletePackage = (dispatchId: number, packageId: number) =>
  del(`${BASE}/dispatches/${dispatchId}/packages/${packageId}`);

/** Custody / cold-chain trail. */
export const addDispatchEvent = (dispatchId: number, body: DispatchEventWrite) =>
  post<Dispatch>(`${BASE}/dispatches/${dispatchId}/events`, body);

export const acknowledgeDispatch = (dispatchId: number, body: AcknowledgeWrite) =>
  post<Dispatch>(`${BASE}/dispatches/${dispatchId}/acknowledge`, body);

/** The same handover as `forwardArrival`, for a relay point with no GRN behind the
 *  consignment — it signed for the lorry and the stock went straight on the shelf. */
export const forwardDispatch = (dispatchId: number) =>
  post<Issue[]>(`${BASE}/dispatches/${dispatchId}/forward`);

/* --------------------------------------------------------- purchase returns -- */

export const listReturns = (params: ListParams = {}) =>
  get<Page<PurchaseReturn>>(`${BASE}/returns`, params);

export const getReturn = (id: number) => get<PurchaseReturn>(`${BASE}/returns/${id}`);

/** Every document behind a purchase return, and everything that has happened to it. */
export const purchaseReturnDossier = (id: number) =>
  get<import("./types").PurchaseReturnDossier>(`${BASE}/returns/${id}/dossier`);

export const createReturn = (body: PurchaseReturnWrite) =>
  post<PurchaseReturn>(`${BASE}/returns`, body);

export const updateReturn = (id: number, body: PurchaseReturnWrite) =>
  put<PurchaseReturn>(`${BASE}/returns/${id}`, body);

export const submitReturn = (id: number) => post<PurchaseReturn>(`${BASE}/returns/${id}/submit`);

export const approveReturn = (id: number, comments = "") =>
  post<PurchaseReturn>(`${BASE}/returns/${id}/approve`, { comments });

export const rejectReturn = (id: number, comments = "") =>
  post<PurchaseReturn>(`${BASE}/returns/${id}/reject`, { comments });

/** Closes the vendor return; posted-stock lines move out, QC rejects do not double-post. */
export const completeReturn = (id: number, credit_note_no?: string) =>
  post<PurchaseReturn>(`${BASE}/returns/${id}/complete`, { credit_note_no });

export const cancelReturn = (id: number, reason?: string) =>
  post<PurchaseReturn>(`${BASE}/returns/${id}/cancel`, { reason });

/** Received lines of a GRN, so a return can only ever be raised against real receipts. */
export const getReturnableLines = (grnId: number) =>
  get<PurchaseReturn["items"]>(`${BASE}/returns/returnable-lines`, { grn_id: grnId });

/* ----- Warehouse → Vendor: Purchase Return with auto-fetch & Send to Vendor ----- */

export const purchaseReturnReasons = () =>
  get<{ value: string; label: string }[]>(`${BASE}/returns/reasons`);

/** By Hand / Third Party / Own Vehicle, and which extra fields each one asks for. */
export const purchaseReturnLogisticsModes = () =>
  get<import("./types").LogisticsModeOption[]>(`${BASE}/returns/logistics-modes`);

export const purchaseReturnSourceOptions = (params: ListParams & { warehouse_id?: number } = {}) =>
  get<import("./types").Page<import("./types").PurchaseReturnSourceOption>>(`${BASE}/returns/source-options`, params);

/** Resolve an indent / PO / GRN number typed by hand, instead of picking from a list. */
export const purchaseReturnSourceLookup = (doc_no: string, source_type?: string) =>
  get<import("./types").PurchaseReturnSourceLookup>(`${BASE}/returns/source-lookup`, {
    doc_no,
    source_type: source_type || undefined,
  });

export const purchaseReturnSourceDetail = (source_type: string, source_id: number, item_id?: number) =>
  get<import("./types").PurchaseReturnSourceDetail>(`${BASE}/returns/source-detail`, {
    source_type,
    source_id,
    item_id,
  });

export const sendPurchaseReturnToVendor = (returnId: number, body: import("./types").PurchaseReturnSendToVendorPayload) =>
  post<PurchaseReturn>(`${BASE}/returns/${returnId}/send-to-vendor`, body);

/* --- after SENT_TO_VENDOR: the decision, and the leg that brings the material back --- */

/**
 * The two cards offered once the vendor has agreed a replacement. Served, never
 * hard-coded — the sentence the desk decides against and the sentence the audit trail
 * records have to be the same sentence.
 */
export const purchaseReturnVehicleArrangements = () =>
  get<import("./types").VehicleArrangementOption[]>(`${BASE}/returns/vehicle-arrangements`);

/**
 * Who moves the goods to the vendor: their vehicle, or Logistics on our request.
 *
 * THE ONLY press this warehouse still makes on a sent return. Approve/Reject and
 * Refund/Replacement moved to the supplier portal on 2026-09-12 — they are the vendor's
 * answers, and `approveSentReturn` / `rejectSentReturn` / `resolveRefund` /
 * `recordReturnVehicle` went with them. Answered once.
 */
export const arrangeReturnTransport = (
  id: number, body: import("./types").ReturnVehicleArrangementPayload,
) => post<PurchaseReturn>(`${BASE}/returns/${id}/transport`, body);

/** Sign the replacement in at the warehouse gate. Posts no stock. */
export const confirmReturnReceived = (
  id: number, body: import("./types").ReturnReceivedPayload = {},
) => post<PurchaseReturn>(`${BASE}/returns/${id}/receive`, body);

/* ------------------------------------------------------- serials & batches -- */

export const listSerials = (
  params: ListParams & {
    item_id?: number; batch_id?: number; warehouse_id?: number; bin_id?: number;
    // Scope the list to one issue line: units another document — or another line of
    // the same issue — is already holding drop out, the ones this line holds stay.
    issue_id?: number; issue_line_id?: number;
    // No batch named means the UNBATCHED lot, not any batch in the bay.
    unbatched?: boolean;
    // Only units no document is holding — a stock movement's picker.
    claim_free?: boolean;
  } = {},
) =>
  get<Page<SerialNumber>>(`${BASE}/serials`, params);

export const listBatches = (params: ListParams & { item_id?: number; expiring_days?: number } = {}) =>
  get<Page<Batch>>(`${BASE}/batches`, params);

export const getItemLocations = ({ warehouse_id, item_id, location_id }: { warehouse_id: number; item_id?: number | null; location_id?: number | null }) =>
  get<ItemLocationsOut[]>(`${BASE}/stock-segregation/item-locations`, { warehouse_id, item_id, location_id });

/* --------------------------------------- stock by location, as a download -- */

/**
 * What each of the two downloads would contain, BEFORE either is pulled.
 *
 * "The Floor 1 report" means two different files — the floor row itself, or the floor
 * and every bay under it — and on a real building the first is usually empty. The
 * counts are what make that visible, so they are fetched as soon as a location is
 * picked rather than after somebody has opened a blank spreadsheet.
 */
export const stockReportScopes = (params: {
  warehouse_id: number;
  location_id?: number | null;
  item_id?: number | null;
}) => get<StockReportScopes>(`${BASE}/stock-segregation/report/scopes`, params);

/** The file itself. Goes through the shared axios client so it carries the bearer
 *  token — a plain <a href> would hit the endpoint unauthenticated and 401. */
export const downloadStockReport = async (params: {
  warehouse_id: number;
  scope: "LOCATION" | "HIERARCHY";
  location_id?: number | null;
  item_id?: number | null;
  format?: "xlsx" | "csv";
}) => {
  const response = await api.get<Blob>(`${BASE}/stock-segregation/report/export`, {
    params: { format: "xlsx", ...params },
    responseType: "blob",
  });
  // The server names the file — it knows the location, the scope and the timestamp,
  // and a name invented here would drift from the header block inside the file.
  const disposition = String(response.headers?.["content-disposition"] ?? "");
  const named = /filename="?([^";]+)"?/.exec(disposition)?.[1];
  return {
    blob: response.data,
    filename: named ?? `stock-report.${params.format ?? "xlsx"}`,
  };
};

/** Hands a blob to the browser as a download. Kept here so no page has to know about
 *  object URLs. */
export const saveStockReport = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export interface ScanLine {
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  quantity: number | string;
  batch_no?: string | null;
  serial_no?: string | null;
  package_no?: string | null;
  imei_no?: string | null;
  expiry_date?: string | null;
  unit_code?: string | null;
}

export interface ScanPackage {
  id: number;
  package_no: string;
  barcode?: string | null;
  package_type?: string | null;
  status?: string | null;
  item_count: number;
  quantity: number | string;
  weight_kg?: number | string | null;
  is_fragile: boolean;
  is_temp_controlled: boolean;
}

export interface ScanResult {
  kind: string;
  id: number;
  doc_no?: string | null;
  deep_link?: string | null;
  title?: string | null;
  subtitle?: string | null;
  status?: string | null;
  meta?: { label?: string | null; value?: string | null }[];
  packages?: ScanPackage[];
  items?: ScanLine[];
  package_count?: number;
  item_count?: number;
  total_qty?: number | string;
}

/** Finds whatever a scanned barcode is — a package, a bin, a serial or a document. */
export const scanCode = (code: string) => get<ScanResult>(`${BASE}/scan/${encodeURIComponent(code)}`);

/* ------------------------------------------------------------- attachments -- */

export const listAttachments = (entity_type: string, entity_id: number) =>
  get<Attachment[]>(`${BASE}/attachments`, { entity_type, entity_id });

export const uploadAttachment = async (
  entity_type: string,
  entity_id: number,
  file: File,
  doc_category?: string,
) => {
  const form = new FormData();
  form.append("file", file);
  form.append("entity_type", entity_type);
  form.append("entity_id", String(entity_id));
  if (doc_category) form.append("doc_category", doc_category);
  return (await api.post<Attachment>(`${BASE}/attachments`, form)).data;
};

/** The stored file. Fetched through axios rather than linked to, so the request
 *  carries the bearer token the download endpoint asks for. */
export const downloadAttachment = async (id: number) =>
  (await api.get<Blob>(`${BASE}/attachments/${id}/download`, { responseType: "blob" })).data;

export const deleteAttachment = (id: number) => del(`${BASE}/attachments/${id}`);

/* ----------------------------------------------------------- notifications -- */

export const listNotifications = (unread_only = false) =>
  get<Page<Notification>>(`${BASE}/notifications`, { unread_only: unread_only || undefined });

export const markNotificationRead = (id: number) =>
  post<Notification>(`${BASE}/notifications/${id}/read`);

export const markAllNotificationsRead = () => post<{ updated: number }>(`${BASE}/notifications/read-all`);

/* ----------------------------------------------------------------- reports -- */

export type ReportKey =
  | "inward-register"
  | "qc-summary"
  | "putaway-ageing"
  | "issue-register"
  | "dispatch-register"
  | "bin-utilisation"
  | "batch-expiry";

/** Reports return their own columns so a new report needs no frontend change. */
export interface ReportResult {
  columns: { key: string; header: string; numeric?: boolean }[];
  rows: Record<string, unknown>[];
  total: number;
}

export const runReport = (key: ReportKey, params: Record<string, unknown> = {}) =>
  get<ReportResult>(`${BASE}/reports/${key}`, params);

/* ----------------------------------------------------------------- options -- */

/**
 * Items for a picker, and — when a stocking point is named — what that point holds.
 *
 * `in_stock` narrows the list to what can actually be issued from there. The plain
 * catalogue is right for a GRN (goods arrive for items the shelf has never seen) and
 * wrong for an issue, where offering the whole master sends the storekeeper down two
 * more dropdowns before anything tells him the shelf is empty.
 */
export const itemOptions = (
  search?: string,
  warehouse_id?: number | null,
  in_stock?: boolean,
  indent_id?: number | null,
) =>
  get<ItemOption[]>(`${BASE}/options/items`, {
    search, warehouse_id, in_stock, indent_id,
  });

export const vendorOptions = (search?: string) => get<Option[]>(`${BASE}/options/vendors`, { search });

/* Both take the Lookup's `search` argument and ignore it — the list is small enough
 * to filter in the box. */
/** The stocking points this login holds. Scoped by default on the server, so a
 *  filter or a "where are the goods" field never offers a point its own screens
 *  would then hide. */
export const warehouseOptions = (_search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`);

/** Warehouses only — the LIP/MDP rungs of the distribution chain dropped.
 *  For a field that names a WAREHOUSE (a load leaving the building, say) rather than
 *  any stocking point: the two chain tiers hold real stock but are not the warehouse,
 *  and `warehouse_type` is already on every row, so the line is drawn here rather
 *  than in a screen. Same scoping as `warehouseOptions` — this login's points only. */
export const warehouseTierOptions = async (search?: string) =>
  (await warehouseOptions(search)).filter(
    (w) => w.warehouse_type !== "LIP" && w.warehouse_type !== "MDP");

/** Every active point in the network. ONLY for a destination field — you transfer
 *  or dispatch TO somewhere you do not hold, so scoping those would break transfers. */
export const allWarehouseOptions = (search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`, { all_points: true, search });

/** Only the points this login actually holds. For the field that names where the
 *  goods physically are — the receiving point on an inward, the issuing point on an
 *  issue. Never for a destination, which is by definition somebody else's. */
export const myWarehouseOptions = (search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`, { mine_only: true, search });

/** Consignments on their way to this point that nobody has inwarded yet. */
export const incomingDispatchOptions = (warehouse_id: number, search?: string) =>
  get<Option[]>(`${BASE}/options/incoming-dispatches`, { warehouse_id, search });

export const dispatchReceiptSource = (dispatch_id: number, warehouse_id: number) =>
  get<DispatchReceiptSource>(`${BASE}/options/dispatch-receipt-source`, {
    dispatch_id, warehouse_id,
  });

/**
 * Storage locations in one warehouse, each carrying the whole walk down to it.
 *
 * `all_locations` offers the structure as well as the bins — floors, lanes, racks,
 * shelves. Stock is allowed to sit on any of them (a pallet of drums goes on the
 * floor of a lane, not into a bin), so putaway and the movement screens ask for the
 * whole tree; a query already narrowed to an item or a batch gets the whole tree too,
 * because a location holding goods is by definition one they can be picked from.
 */
export const binOptions = (
  warehouse_id: number,
  search?: string,
  item_id?: number | null,
  batch_id?: number | null,
  storage_type_id?: string | number | null,
  all_locations?: boolean,
  exclude_bin_id?: number | null,
  /** The indent being issued. Its own reservation would otherwise hide the very bin
   *  the line is issuing from — see warehouse service `_stock_offerable`. */
  indent_id?: number | null,
) =>
  get<LocationOption[]>(`${BASE}/options/bins`, {
    warehouse_id, search, item_id, batch_id, storage_type_id, all_locations,
    exclude_bin_id, indent_id,
  });

/** `indent_id`: same reason as `binOptions` — a line issuing the whole balance must
 *  still be offered the batch it is issuing from. */
export const batchOptions = (item_id: number, warehouse_id: number,
                             bin_id?: number | null, indent_id?: number | null) =>
  get<Option[]>(`${BASE}/options/batches`, { item_id, warehouse_id, bin_id, indent_id });

/** Orders a delivery can arrive against — sent to the vendor, not yet fully received.
 *  Behind `receipt.view`, not `po.view`: a storekeeper picks the order the goods came
 *  on without being given the run of procurement. */
export const poOptions = (search?: string, warehouse_id?: number) =>
  get<Option[]>(`${BASE}/options/purchase-orders`, { search, warehouse_id });

/** GRNs this login can see. `for_putaway` narrows it to the ones with stock actually
 *  standing on the floor at a bin-managed point — the only ones a putaway can be
 *  raised against. */
export const grnOptions = (search?: string, for_putaway?: boolean, for_qc?: boolean) =>
  get<Option[]>(`${BASE}/options/receipts`, {
    search, receipt_type: "GRN", for_putaway, for_qc,
  });

export const gateEntryOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/receipts`, { search, receipt_type: "GATE_ENTRY" });

export const indentOptions = (search?: string, warehouse_id?: number) =>
  get<Option[]>(`${BASE}/options/indents`, { search, warehouse_id });

export const getIndentIssueSource = (indent_id: number, warehouse_id: number) =>
  get<{
    indent_id: number;
    indent_no: string;
    warehouse_id: number;
    department_id?: number | null;
    project_id?: number | null;
    mixed_projects?: boolean;
    issued_to_id?: number | null;
    issued_to_name?: string | null;
    vehicle_id?: number | null;
    vehicle_number?: string | null;
    destination_office_id?: number | null;
    destination_office_name?: string | null;
    destination_office_sac?: string | null;
    items: IssueWrite["items"];
  }>(`${BASE}/options/indent-issue-source`, { indent_id, warehouse_id });

export const getPickingIssueSource = (picking_id: number) =>
  get<{
    picking_id: number;
    warehouse_id: number;
    indent_id?: number | null;
    department_id?: number | null;
    project_id?: number | null;
    issued_to_id?: number | null;
    issued_to_name?: string | null;
    vehicle_id?: number | null;
    vehicle_number?: string | null;
    mixed_projects?: boolean;
    items: IssueWrite["items"];
  }>(`${BASE}/options/picking-issue-source`, { picking_id });

export const issueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/issues`, { search });

/* Issues that still owe an outward check. Deliberately not `issueOptions`, which
   lists what may be DISPATCHED and so excludes every issue this screen inspects. */
export const inspectableIssueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/inspectable-issues`, { search });

export const returnableIssueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/returnable-issues`, { search });

export const getIssueDispatchSource = (issue_id: number) =>
  get<IssueDispatchSource>(`${BASE}/options/issue-dispatch-source`, { issue_id });

export const employeeOptions = (search?: string) => get<Option[]>(`${BASE}/options/employees`, { search });

export const projectOptions = (search?: string) => get<Option[]>(`${BASE}/options/projects`, { search });

export const departmentOptions = () => get<Option[]>(`${BASE}/options/departments`);

export const vehicleOptions = (search?: string) => get<Option[]>(`${BASE}/options/vehicles`, { search });

export const carrierOptions = (search?: string) => get<Option[]>(`${BASE}/options/carriers`, { search });

/* ------------------------------------------------------- deleting a draft -- */

/**
 * Removing an abandoned draft. Only a DRAFT can go — the backend refuses anything
 * that has been submitted, moved stock, or grown a child document, and it checks the
 * same RBAC scope the list does, so a draft you cannot see is not one you can delete
 * by guessing its id.
 *
 * One permission per document type, matching the endpoints.
 */
export const DRAFT_DELETE_PERMISSION = {
  receipt: "receipt.delete",
  inspection: "inspection.delete",
  outbound_inspection: "qc_outward.delete",
  putaway: "putaway.delete",
  picking: "picking.delete",
  issue: "issue.delete",
  dispatch: "dispatch.delete",
  return: "return.delete",
  movement: "movement.delete",
} as const;

export const deleteReceipt = (id: number) => del(`${BASE}/receipts/${id}`);
export const deleteInspection = (id: number) => del(`${BASE}/inspections/${id}`);
export const deleteOutboundInspection = (id: number) => del(`${BASE}/outbound-inspections/${id}`);
export const deletePutaway = (id: number) => del(`${BASE}/putaways/${id}`);
export const deletePicking = (id: number) => del(`${BASE}/pickings/${id}`);
export const deleteIssue = (id: number) => del(`${BASE}/issues/${id}`);
export const deleteDispatch = (id: number) => del(`${BASE}/dispatches/${id}`);
export const deletePurchaseReturn = (id: number) => del(`${BASE}/returns/${id}`);
export const deleteStockMovement = (id: number) => del(`${BASE}/stock-movements/${id}`);
