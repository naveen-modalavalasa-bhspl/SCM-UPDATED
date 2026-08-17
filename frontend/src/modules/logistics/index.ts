/** The logistics module's public face — one import site for `App.tsx`.
 *
 * The screens follow the flow the material takes: the packed consignment, the
 * dispatch that releases it, the transport that carries it, the tracking board, the
 * signature at the far end, and the claims.
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
  ConsignmentsScreen, ConsignmentFormScreen,
} from "@/modules/warehouse";

/** Dispatch, in Logistics, is the one decision the floor actually makes: how does
 *  this consignment travel, and with whom. The warehouse's own dispatch document and
 *  its screens are untouched and still reached from Warehouse.
 *
 *  Two screens, one decision: `DispatchPage` is the queue (what is packed, what is
 *  moving, what is waiting on a price) and `DispatchConfirmPage` is the press —
 *  consignment, gate pass, mode, provider. The confirm screen is where BOTH front
 *  doors land, the queue and the consignment itself, so the decision exists once. */
export { DispatchPage } from "./pages/DispatchPage";
export { DispatchConfirmPage } from "./pages/DispatchConfirmPage";
export { TransportRequestsPage } from "./pages/TransportRequestsPage";
export { TransportFormPage } from "./pages/TransportFormPage";
export { TransportDetailPage } from "./pages/TransportDetailPage";
export { ProviderSelectionPage } from "./pages/ProviderSelectionPage";
export { ShipmentTrackingPage } from "./pages/ShipmentTrackingPage";
export { AcknowledgementsPage } from "./pages/AcknowledgementsPage";
export { LogisticsExceptionsPage } from "./pages/LogisticsExceptionsPage";

/** The register behind the Dispatch dropdown: the third-party providers we ship with
 *  and the portal logins they answer with. Mounted under Settings — issuing an
 *  identity outside the company is an administrator's act — but owned here, because
 *  a partner is only ever a logistics concept. */
export { LogisticsVendorsPage } from "./pages/LogisticsVendorsPage";

export { CarrierLayout } from "./portal/CarrierLayout";
export { CarrierLoginPage } from "./portal/CarrierLoginPage";
export { CarrierJobsPage } from "./portal/CarrierJobsPage";
export { CarrierJobPage } from "./portal/CarrierJobPage";
