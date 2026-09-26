/** The logistics module's public face — one import site for `App.tsx`.
 *
 * The screens follow the flow the material takes: the packed consignment, the
 * dispatch that releases it, the transport that carries it, and the ledger of
 * everything that happened to it.
 *
 * Consignments and Dispatch are the WAREHOUSE's screens, re-exported here and mounted
 * under `/logistics/*` — the same document, the same forms, the same flow (draft →
 * submit → approve → gate out → acknowledge), reached from the module that actually
 * works it. A copy would have been two screens to fix every time the flow changes;
 * this is one screen with two front doors, and the warehouse's own routes are
 * untouched.
 *
 * The portal screens are the other audience: the transport provider, signing in with
 * their vendor account to quote, accept, run and report a job.
 */
export {
  ConsignmentsScreen, ConsignmentFormScreen, ScanViewScreen,
} from "@/modules/warehouse";

/** Dispatch, in Logistics, is the one decision the floor actually makes: how does
 *  this consignment travel, and with whom. The warehouse's own dispatch document and
 *  its screens are untouched and still reached from Warehouse.
 *
 *  Two screens, one decision: `DispatchPage` is the queue (what is packed, what is
 *  moving, what is waiting on a price) and `DispatchConfirmPage` is the press —
 *  consignment, gate pass, mode, provider. The confirm screen is where BOTH front
 *  doors land, the queue and the consignment itself, so the decision exists once. */
/** The module's front page. Reads `/api/transport/summary` and nothing else, so it
 *  cannot disagree with the Shipments register that lives on the same call. */
export { LogisticsOverviewPage } from "./pages/LogisticsOverviewPage";
export { DispatchPage } from "./pages/DispatchPage";
export { DispatchConfirmPage } from "./pages/DispatchConfirmPage";
/** The gate pass that press produces, as paper. Mounted outside the app shell in
 *  `App.tsx`, so printing gives the pass and not the sidebar around it. */
export { GatePassPrintPage } from "./pages/GatePassPrintPage";
export { TransportRequestsPage } from "./pages/TransportRequestsPage";
export { TransportFormPage } from "./pages/TransportFormPage";
export { TransportDetailPage } from "./pages/TransportDetailPage";
export { ProviderSelectionPage } from "./pages/ProviderSelectionPage";
/** What happened, to which shipment, in the order it happened. One register in place
 *  of the Shipment Tracking board and the Exceptions desk: those two each drew a
 *  slice of the same trail — where is it now, what went wrong — and neither said who
 *  awarded the job, at what price, or when the carrier agreed to it. Derived from the
 *  documents, so it can only show events the module actually recorded. */
export { LogisticsActivityPage } from "./pages/LogisticsActivityPage";

/** The register behind the Dispatch dropdown: the third-party providers we ship with
 *  and the portal logins they answer with. Lives in the Logistics tabs
 *  (`/logistics/vendors`) beside the screen that reads it, and keeps its ADMIN-only
 *  page grant — issuing an identity outside the company is an administrator's act,
 *  whichever menu it hangs from. The old `/settings/logistics-vendors` path still
 *  resolves to this same screen. */
export { LogisticsVendorsPage } from "./pages/LogisticsVendorsPage";

export { CarrierLayout } from "./portal/CarrierLayout";
export { CarrierLoginPage } from "./portal/CarrierLoginPage";
export { CarrierJobsPage } from "./portal/CarrierJobsPage";
export { CarrierJobPage } from "./portal/CarrierJobPage";
export { CarrierAckPage } from "./portal/CarrierAckPage";
