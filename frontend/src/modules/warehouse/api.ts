import { api } from "@/shared/api/client";
import type {
  AcknowledgeWrite,
  Attachment,
  Batch,
  Bin,
  BinWrite,
  Dispatch,
  DispatchEventWrite,
  DispatchWrite,
  Inspection,
  InspectionWrite,
  Issue,
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
  PutawayConfirm,
  Receipt,
  ReceiptWrite,
  SerialNumber,
  StockAvailability,
  StockMovement,
  StockMovementWrite,
  StorageType,
  StorageTypeWrite,
  Warehouse,
  WarehouseDashboard,
  WarehouseLocation,
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

export const listReceipts = (params: ListParams & { receipt_type?: string } = {}) =>
  get<Page<Receipt>>(`${BASE}/receipts`, params);

export const getReceipt = (id: number) => get<Receipt>(`${BASE}/receipts/${id}`);

export const createReceipt = (body: ReceiptWrite) => post<Receipt>(`${BASE}/receipts`, body);

export const updateReceipt = (id: number, body: ReceiptWrite) =>
  put<Receipt>(`${BASE}/receipts/${id}`, body);

export const convertReceiptToGrn = (id: number) =>
  post<Receipt>(`${BASE}/receipts/${id}/convert-to-grn`);

/** Freezes the receipt and raises the inspection tasks behind it. */
export const submitReceipt = (id: number) => post<Receipt>(`${BASE}/receipts/${id}/submit`);

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

export const startPutaway = (id: number) => post<Putaway>(`${BASE}/putaways/${id}/start`);

/** Confirming a putaway is what moves the stock into the bin. */
export const confirmPutaway = (id: number, body: PutawayConfirm) =>
  post<Putaway>(`${BASE}/putaways/${id}/confirm`, body);

export const skipPutaway = (id: number, reason?: string) =>
  post<Putaway>(`${BASE}/putaways/${id}/skip`, { reason });

/** Bins the engine suggests for this task, best first. */
export const suggestBins = (id: number) => get<Bin[]>(`${BASE}/putaways/${id}/suggested-bins`);

export const listStockMovements = (params: ListParams = {}) =>
  get<Page<StockMovement>>(`${BASE}/stock-movements`, params);

export const createStockMovement = (body: StockMovementWrite) =>
  post<StockMovement>(`${BASE}/stock-movements`, body);

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

export const acknowledgeIssue = (id: number, remarks?: string) =>
  post<Issue>(`${BASE}/issues/${id}/acknowledge`, { remarks });

export const cancelIssue = (id: number, reason?: string) =>
  post<Issue>(`${BASE}/issues/${id}/cancel`, { reason });

/* ---------------------------------------------------------------- dispatch -- */

export const listDispatches = (params: ListParams = {}) =>
  get<Page<Dispatch>>(`${BASE}/dispatches`, params);

export const getDispatch = (id: number) => get<Dispatch>(`${BASE}/dispatches/${id}`);

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

export const listSerials = (params: ListParams & { item_id?: number; batch_id?: number } = {}) =>
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

export const warehouseOptions = () => get<Option[]>(`${BASE}/options/warehouses`);

export const binOptions = (warehouse_id: number, search?: string) =>
  get<Option[]>(`${BASE}/options/bins`, { warehouse_id, search });

export const batchOptions = (item_id: number, warehouse_id: number, bin_id?: number | null) =>
  get<Option[]>(`${BASE}/options/batches`, { item_id, warehouse_id, bin_id });

export const poOptions = (search?: string) => get<Option[]>(`${BASE}/options/purchase-orders`, { search });

export const grnOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/receipts`, { search, receipt_type: "PURCHASE" });

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
    items: IssueWrite["items"];
  }>(`${BASE}/options/indent-issue-source`, { indent_id, warehouse_id });

export const getPickingIssueSource = (picking_id: number) =>
  get<{
    picking_id: number;
    warehouse_id: number;
    indent_id?: number | null;
    department_id?: number | null;
    project_id?: number | null;
    items: IssueWrite["items"];
  }>(`${BASE}/options/picking-issue-source`, { picking_id });

export const issueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/issues`, { search });

export const returnableIssueOptions = (search?: string) =>
  get<Option[]>(`${BASE}/options/returnable-issues`, { search });

export const getIssueDispatchSource = (issue_id: number) =>
  get<{
    issue_id: number;
    issue_no: string;
    warehouse_id: number;
    project_id?: number | null;
    items: DispatchWrite["items"];
  }>(`${BASE}/options/issue-dispatch-source`, { issue_id });

export const employeeOptions = (search?: string) => get<Option[]>(`${BASE}/options/employees`, { search });

export const projectOptions = (search?: string) => get<Option[]>(`${BASE}/options/projects`, { search });

export const departmentOptions = () => get<Option[]>(`${BASE}/options/departments`);

export const vehicleOptions = (search?: string) => get<Option[]>(`${BASE}/options/vehicles`, { search });

export const carrierOptions = (search?: string) => get<Option[]>(`${BASE}/options/carriers`, { search });
