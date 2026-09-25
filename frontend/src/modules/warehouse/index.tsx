import { Navigate, Route, Routes, useParams } from "react-router-dom";
import TransactionsLayout from "./pages/TransactionsLayout";
import WarehouseDashboard from "./pages/WarehouseDashboard";
import MaterialInward from "./pages/MaterialInward";
import GRN from "./pages/GRN";
import ReceiptForm from "./pages/ReceiptForm";
import QualityInspection from "./pages/QualityInspection";
import QualityInspectionForm from "./pages/QualityInspectionForm";
import OutboundQualityInspectionForm from "./pages/OutboundQualityInspectionForm";
import Putaway from "./pages/Putaway";
import PutawayForm from "./pages/PutawayForm";
import Picklist from "./pages/Picklist";
import PicklistForm from "./pages/PicklistForm";
import MaterialIssues from "./pages/MaterialIssues";
import MaterialIssueForm from "./pages/MaterialIssueForm";
import Consignments from "./pages/Consignments";
import ConsignmentForm from "./pages/ConsignmentForm";
import AcknowledgeDelivery from "./pages/AcknowledgeDelivery";
import StockSegregation from "./pages/StockSegregation";
import WarehouseNotifications from "./pages/WarehouseNotifications";
import WarehouseReports from "./pages/WarehouseReports";
import MastersLayout from "./pages/masters/MastersLayout";
import Warehouses from "./pages/masters/Warehouses";
import WarehouseForm from "./pages/masters/WarehouseForm";
import WarehouseDetail from "./pages/masters/WarehouseDetail";
import BinForm from "./pages/masters/BinForm";
import FloorPlan from "./pages/masters/FloorPlan";
import StorageTypes from "./pages/masters/StorageTypes";
import ScanView from "./pages/ScanView";
import StockMovements from "./pages/StockMovements";
import StockMovementForm from "./pages/StockMovementForm";
import StockMovementDetail from "./pages/StockMovementDetail";
import PurchaseReturnForm from "./pages/PurchaseReturnForm";
import PurchaseReturns from "./pages/PurchaseReturns";
import PurchaseReturnDetail from "./pages/PurchaseReturnDetail";

/**
 * The warehouse module's own router.
 *
 * `App.tsx` mounts this at `/warehouse/*` (and at `/grn`, `/stock` and `/issues` for
 * links that predate the module), so every screen below is reachable without the
 * app-level router knowing any of them exist — adding a screen is a change to this
 * file plus a row in `PAGE_TREE`, and nothing shared moves.
 *
 * Gate entry and GRN are one form with a different `receipt_type`, and material issues
 * and returns are one screen with a different direction. Passing the discriminator as
 * a prop keeps one implementation of each rather than a near-copy that drifts.
 *
 * Outward QC, Outward Labelling and Purchase Returns were removed on 2026-08-13 — not
 * part of the flow this business runs. Their endpoints and tables are untouched and
 * now unreachable; nothing in the app routes to them.
 */
export function WarehouseModule() {
  return (
    <Routes>
      <Route index element={<WarehouseDashboard />} />
      <Route path="dashboard" element={<WarehouseDashboard />} />

      <Route path="transactions" element={<TransactionsLayout />}>
        <Route index element={<Navigate to="material-inward" replace />} />

        <Route path="material-inward" element={<MaterialInward />} />
        <Route path="material-inward/new" element={<ReceiptForm mode="GATE_ENTRY" />} />
        <Route path="material-inward/:id" element={<ReceiptForm mode="GATE_ENTRY" />} />

        <Route path="grn" element={<GRN />} />
        <Route path="grn/new" element={<ReceiptForm mode="PURCHASE" />} />
        <Route path="grn/:id" element={<ReceiptForm mode="PURCHASE" />} />

        <Route path="quality-inspection" element={<QualityInspection />} />
        <Route path="quality-inspection/new" element={<QualityInspectionForm />} />
        <Route path="quality-inspection/:id" element={<QualityInspectionForm />} />

        <Route path="qc-outward" element={<QualityInspection type="OUTGOING" title="Outward QC" stockTransfer={false} />} />
        <Route path="qc-outward/new" element={<OutboundQualityInspectionForm />} />
        <Route path="qc-outward/:id" element={<OutboundQualityInspectionForm />} />

        <Route path="putaway" element={<Putaway />} />
        <Route path="putaway/:id" element={<PutawayForm />} />
        {/* Warehouse → Vendor Purchase Return: draft list, form, review */}
        <Route path="purchase-returns" element={<PurchaseReturns />} />
        <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
        <Route path="purchase-returns/:id" element={<PurchaseReturnDetail />} />
        <Route path="purchase-returns/:id/edit" element={<PurchaseReturnForm />} />
        <Route path="stock-movements" element={<StockMovements />} />
        <Route path="stock-movements/new" element={<StockMovementForm />} />
        <Route path="stock-movements/view" element={<StockMovementDetail />} />

        <Route path="fulfilment" element={<Picklist />} />
        <Route path="fulfilment/new" element={<PicklistForm />} />
        <Route path="fulfilment/:id" element={<PicklistForm />} />
        {/* Legacy URLs stay valid for bookmarks while the UI uses the clearer name. */}
        <Route path="picklist" element={<Picklist />} />
        <Route path="picklist/new" element={<PicklistForm />} />
        <Route path="picklist/:id" element={<PicklistForm />} />

        <Route path="material-issues" element={<MaterialIssues />} />
        <Route path="material-issues/new" element={<MaterialIssueForm />} />
        <Route path="material-issues/:id" element={<MaterialIssueForm />} />
        <Route path="material-returns" element={<MaterialIssues direction="IN" />} />
        <Route path="material-returns/new" element={<MaterialIssueForm direction="IN" />} />
        <Route path="material-returns/:id" element={<MaterialIssueForm direction="IN" />} />

        <Route path="consignments" element={<Consignments />} />
        <Route path="consignments/new" element={<ConsignmentForm />} />
        <Route path="consignments/:id" element={<ConsignmentForm />} />

        {/* FIXED 2026-08-20 — Consignments and Dispatch are LOGISTICS screens now.
          * The components stay here and are re-exported below (logistics mounts the
          * SAME implementation), but this module no longer serves them: two front
          * doors to one decision is what the split was undoing, and the warehouse
          * copies showed none of the logistics context the desk decides on.
          * Redirected, never deleted — a printed gate pass or an old bookmark still
          * lands on the live screen instead of the 404 page. */}
        <Route path="dispatch/consignments" element={<Navigate to="/logistics/consignments" replace />} />
        <Route path="dispatch/consignments/new" element={<Navigate to="/logistics/consignments/new" replace />} />
        <Route path="dispatch/consignments/:id" element={<ConsignmentRedirect />} />
        <Route path="dispatch" element={<Navigate to="/logistics/dispatch" replace />} />
        <Route path="dispatch/new" element={<Navigate to="/logistics/dispatch/new" replace />} />
        <Route path="dispatch/:id" element={<Navigate to="/logistics/dispatch" replace />} />

      </Route>

      {/* Standalone screens — not part of the document chain. */}
      {/* The RBAC page tree still links to these root-level module URLs. Keep them
       * so menu clicks and existing bookmarks resolve inside this module. */}
      <Route path="material-inward" element={<MaterialInward />} />
      <Route path="material-inward/new" element={<ReceiptForm mode="GATE_ENTRY" />} />
      <Route path="material-inward/:id" element={<ReceiptForm mode="GATE_ENTRY" />} />

      <Route path="grn" element={<GRN />} />
      <Route path="grn/new" element={<ReceiptForm mode="PURCHASE" />} />
      <Route path="grn/:id" element={<ReceiptForm mode="PURCHASE" />} />

      <Route path="quality-inspection" element={<QualityInspection />} />
      <Route path="quality-inspection/new" element={<QualityInspectionForm />} />
      <Route path="quality-inspection/:id" element={<QualityInspectionForm />} />

      <Route path="qc-outward" element={<QualityInspection type="OUTGOING" title="Outward QC" stockTransfer={false} />} />
      <Route path="qc-outward/new" element={<OutboundQualityInspectionForm />} />
      <Route path="qc-outward/:id" element={<OutboundQualityInspectionForm />} />

      <Route path="putaway" element={<Putaway />} />
      <Route path="putaway/:id" element={<PutawayForm />} />
      <Route path="purchase-returns" element={<PurchaseReturns />} />
      <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
      <Route path="purchase-returns/:id" element={<PurchaseReturnDetail />} />
      <Route path="purchase-returns/:id/edit" element={<PurchaseReturnForm />} />
      <Route path="stock-movements" element={<StockMovements />} />
      <Route path="stock-movements/new" element={<StockMovementForm />} />
      <Route path="stock-movements/view" element={<StockMovementDetail />} />

      {/* The RBAC menu still points at /warehouse/picklist; without these the link
       * hit the catch-all below and bounced to the dashboard. */}
      <Route path="fulfilment" element={<Picklist />} />
      <Route path="fulfilment/new" element={<PicklistForm />} />
      <Route path="fulfilment/:id" element={<PicklistForm />} />
      <Route path="picklist" element={<Picklist />} />
      <Route path="picklist/new" element={<PicklistForm />} />
      <Route path="picklist/:id" element={<PicklistForm />} />

      <Route path="material-issues" element={<MaterialIssues />} />
      <Route path="material-issues/new" element={<MaterialIssueForm />} />
      <Route path="material-issues/:id" element={<MaterialIssueForm />} />
      <Route path="material-returns" element={<MaterialIssues direction="IN" />} />
      <Route path="material-returns/new" element={<MaterialIssueForm direction="IN" />} />
      <Route path="material-returns/:id" element={<MaterialIssueForm direction="IN" />} />

      <Route path="consignments" element={<Navigate to="/logistics/consignments" replace />} />
      <Route path="consignments/new" element={<Navigate to="/logistics/consignments/new" replace />} />
      <Route path="consignments/:id" element={<ConsignmentRedirect />} />

      {/* See the note above — logistics owns these screens now. */}
      <Route path="dispatch/consignments" element={<Navigate to="/logistics/consignments" replace />} />
      <Route path="dispatch/consignments/new" element={<Navigate to="/logistics/consignments/new" replace />} />
      <Route path="dispatch/consignments/:id" element={<ConsignmentRedirect />} />
      <Route path="dispatch" element={<Navigate to="/logistics/dispatch" replace />} />
      <Route path="dispatch/new" element={<Navigate to="/logistics/dispatch/new" replace />} />
      <Route path="dispatch/:id" element={<Navigate to="/logistics/dispatch" replace />} />

      {/* Where a label's QR points. Not in the menu — nobody navigates here, a camera
       * arrives here. `*` because a document number contains slashes. */}
      <Route path="scan/*" element={<ScanView />} />

      <Route path="acknowledge-delivery" element={<AcknowledgeDelivery />} />
      <Route path="stock-segregation" element={<StockSegregation />} />
      <Route path="notifications" element={<WarehouseNotifications />} />
      <Route path="reports" element={<WarehouseReports />} />

      <Route path="masters" element={<MastersLayout />}>
        <Route index element={<Navigate to="warehouses" replace />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="warehouses/new" element={<WarehouseForm />} />
        <Route path="warehouses/:id" element={<WarehouseDetail />} />
        <Route path="warehouses/:id/edit" element={<WarehouseForm />} />
        <Route path="warehouses/:id/bins/new" element={<BinForm />} />
        <Route path="warehouses/:id/bins/:bin_id/edit" element={<BinForm />} />
        <Route path="floor-plan" element={<FloorPlan />} />
        <Route path="storage-types" element={<StorageTypes />} />
      </Route>

      {/* App.tsx also mounts this module at /grn, /stock and /issues for links that
       * predate it; anything unmatched lands on the overview rather than a blank page. */}
      <Route path="*" element={<Navigate to="/warehouse" replace />} />
    </Routes>
  );
}

function ConsignmentRedirect() {
  const { id } = useParams();
  return <Navigate to={`/logistics/consignments/${id}`} replace />;
}

export default WarehouseModule;

/**
 * Consignments and Dispatch, re-exported so the Logistics module can mount the SAME
 * screens under `/logistics/*`.
 *
 * Deliberately a re-export rather than a move: the warehouse routes, their rbac_pages
 * rows and their permissions are all untouched, so both entry points work while the
 * business decides which one it wants. Retiring the warehouse copies later is then a
 * matter of switching those page rows off — no component moves and no import changes.
 */
// Dispatch and DispatchForm are no longer imported above: this module does not render
// them any more, it only redirects. They are still re-exported here, unchanged, because
// the LOGISTICS module mounts these exact components — moving the files would break the
// warehouse-side imports they carry for no gain.
export { default as ConsignmentsScreen } from "./pages/Consignments";
export { default as ConsignmentFormScreen } from "./pages/ConsignmentForm";
export { default as DispatchScreen } from "./pages/Dispatch";
export { default as DispatchFormScreen } from "./pages/DispatchForm";
