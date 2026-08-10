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
  InspectionWrite,
  Issue,
  IssueDispatchSource,
  IssueWrite,
  ItemOption,
  ListParams,
  Notification,
  Option,
  Page,
  PackageWrite,
  Picking,
  PickingWrite,
  PoLineOption,
  PurchaseReturn,
  PurchaseReturnWrite,
  Putaway,
  PutawayCandidate,
  PutawayConfirm,
  PutawayCreate,
  Receipt,
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

/** The bin tree for one warehouse — zones, racks and shelves nested by `parent_id`. */
export const getBinTree = (warehouseId: number) =>
  get<Bin[]>(`${BASE}/warehouses/${warehouseId}/bins`);

export const createBin = (body: BinWrite) => post<Bin>(`${BASE}/bins`, body);

export const updateBin = (id: number, body: BinWrite) => put<Bin>(`${BASE}/bins/${id}`, body);

export const deleteBin = (id: number) => del(`${BASE}/bins/${id}`);

/** The physical layer behind the floor plan — `whs_locations`, with coordinates. */
export const listLocations = (warehouseId: number) =>
  get<WarehouseLocation[]>(`${BASE}/warehouses/${warehouseId}/locations`);

export const listStorageTypes = () => get<StorageType[]>(`${BASE}/storage-types`);

export const createStorageType = (body: StorageTypeWrite) =>
  post<StorageType>(`${BASE}/storage-types`, body);

export const updateStorageType = (id: number, body: StorageTypeWrite) =>
  put<StorageType>(`${BASE}/storage-types/${id}`, body);

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

/** Pass an arrived consignment on to the points below — the MDP leg of WH -> MDP -> LIP.
 *  Builds one DRAFT issue per indent; the storekeeper still reviews and submits. */
export const forwardArrival = (id: number) =>
  post<Issue[]>(`${BASE}/receipts/${id}/forward`);

/** Posts accepted quantity to stock and raises the putaway tasks. */
export const completeReceipt = (id: number) => post<Receipt>(`${BASE}/receipts/${id}/complete`);

export const cancelReceipt = (id: number, reason?: string) =>
  post<Receipt>(`${BASE}/receipts/${id}/cancel`, { reason });

/** Open PO lines, so the GRN form fills itself from the order. */
export const getPoLines = (poId: number) =>
  get<PoLineOption[]>(`${BASE}/options/po-lines`, { po_id: poId });

/* ----------------------------------------------------------- quality (in) -- */

export const listInspections = (params: ListParams = {}) =>
  get<Page<Inspection>>(`${BASE}/inspections`, params);

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

/* ----------------------------------------------------------------- putaway -- */

export const listPutaways = (params: ListParams = {}) =>
  get<Page<Putaway>>(`${BASE}/putaways`, params);

export const getPutaway = (id: number) => get<Putaway>(`${BASE}/putaways/${id}`);

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

/** Bins the engine suggests for this task, best first. */
export const suggestBins = (id: number) => get<Bin[]>(`${BASE}/putaways/${id}/suggested-bins`);

export const listStockMovements = (params: ListParams = {}) =>
  get<Page<StockMovement>>(`${BASE}/stock-movements`, params);

export const createStockMovement = (body: StockMovementWrite) =>
  post<StockMovement>(`${BASE}/stock-movements`, body);

export const listStockMovementOrders = (params: ListParams = {}) =>
  get<Page<StockMovementOrder>>(`${BASE}/stock-movement-orders`, params);

export const createStockMovementOrder = (body: StockMovementOrderWrite) =>
  post<StockMovementOrder>(`${BASE}/stock-movement-orders`, body);


export const getStockAvailability = (
  warehouse_id: number,
  source_bin_id: number,
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

export const listDispatches = (params: ListParams = {}) =>
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

/* --------------------------------------------------------- purchase returns -- */

export const listReturns = (params: ListParams = {}) =>
  get<Page<PurchaseReturn>>(`${BASE}/returns`, params);

export const getReturn = (id: number) => get<PurchaseReturn>(`${BASE}/returns/${id}`);

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

/* ------------------------------------------------------- serials & batches -- */

export const listSerials = (
  params: ListParams & { item_id?: number; batch_id?: number; warehouse_id?: number; bin_id?: number } = {},
) =>
  get<Page<SerialNumber>>(`${BASE}/serials`, params);

export const listBatches = (params: ListParams & { item_id?: number; expiring_days?: number } = {}) =>
  get<Page<Batch>>(`${BASE}/batches`, params);

/** Finds whatever a scanned barcode is — a package, a bin, a serial or a document. */
export const scanCode = (code: string) =>
  get<{ kind: string; id: number; doc_no?: string | null; deep_link?: string | null }>(
    `${BASE}/scan/${encodeURIComponent(code)}`,
  );

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

export const itemOptions = (search?: string) =>
  get<ItemOption[]>(`${BASE}/options/items`, { search });

export const vendorOptions = (search?: string) => get<Option[]>(`${BASE}/options/vendors`, { search });

/* Both take the Lookup's `search` argument and ignore it — the list is small enough
 * to filter in the box. */
/** The stocking points this login holds. Scoped by default on the server, so a
 *  filter or a "where are the goods" field never offers a point its own screens
 *  would then hide. */
export const warehouseOptions = (_search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`);

/** Every active point in the network. ONLY for a destination field — you transfer
 *  or dispatch TO somewhere you do not hold, so scoping those would break transfers. */
export const allWarehouseOptions = (_search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`, { all_points: true });

/** Only the points this login actually holds. For the field that names where the
 *  goods physically are — the receiving point on an inward, the issuing point on an
 *  issue. Never for a destination, which is by definition somebody else's. */
export const myWarehouseOptions = (_search?: string) =>
  get<WarehouseOption[]>(`${BASE}/options/warehouses`, { mine_only: true });

/** Consignments on their way to this point that nobody has inwarded yet. */
export const incomingDispatchOptions = (warehouse_id: number, search?: string) =>
  get<Option[]>(`${BASE}/options/incoming-dispatches`, { warehouse_id, search });

export const dispatchReceiptSource = (dispatch_id: number, warehouse_id: number) =>
  get<DispatchReceiptSource>(`${BASE}/options/dispatch-receipt-source`, {
    dispatch_id, warehouse_id,
  });

export const binOptions = (
  warehouse_id: number,
  search?: string,
  item_id?: number | null,
  batch_id?: number | null,
  storage_type_id?: string | number | null,
  all_locations?: boolean,
) =>
  get<Option[]>(`${BASE}/options/bins`, { warehouse_id, search, item_id, batch_id, storage_type_id, all_locations });

export const batchOptions = (item_id: number, warehouse_id: number, bin_id?: number | null) =>
  get<Option[]>(`${BASE}/options/batches`, { item_id, warehouse_id, bin_id });

export const poOptions = (search?: string) => get<Option[]>(`${BASE}/options/purchase-orders`, { search });

/** GRNs this login can see. `for_putaway` narrows it to the ones with stock actually
 *  standing on the floor at a bin-managed point — the only ones a putaway can be
 *  raised against. */
export const grnOptions = (search?: string, for_putaway?: boolean) =>
  get<Option[]>(`${BASE}/options/receipts`, {
    search, receipt_type: "GRN", for_putaway,
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
    destination_office_id?: number | null;
    destination_office_name?: string | null;
    items: IssueWrite["items"];
  }>(`${BASE}/options/indent-issue-source`, { indent_id, warehouse_id });

export const getPickingIssueSource = (picking_id: number) =>
  get<{
    picking_id: number;
    warehouse_id: number;
    indent_id?: number | null;
    department_id?: number | null;
    project_id?: number | null;
    mixed_projects?: boolean;
    items: IssueWrite["items"];
  }>(`${BASE}/options/picking-issue-source`, { picking_id });

export const issueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/issues`, { search });

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
  putaway: "putaway.delete",
  picking: "picking.delete",
  issue: "issue.delete",
  dispatch: "dispatch.delete",
  return: "return.delete",
  movement: "movement.delete",
} as const;

export const deleteReceipt = (id: number) => del(`${BASE}/receipts/${id}`);
export const deleteInspection = (id: number) => del(`${BASE}/inspections/${id}`);
export const deletePutaway = (id: number) => del(`${BASE}/putaways/${id}`);
export const deletePicking = (id: number) => del(`${BASE}/pickings/${id}`);
export const deleteIssue = (id: number) => del(`${BASE}/issues/${id}`);
export const deleteDispatch = (id: number) => del(`${BASE}/dispatches/${id}`);
export const deletePurchaseReturn = (id: number) => del(`${BASE}/returns/${id}`);
export const deleteStockMovement = (id: number) => del(`${BASE}/stock-movements/${id}`);
