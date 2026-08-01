import { Navigate, Route, Routes, useParams } from "react-router-dom";
import TransactionsLayout from "./pages/TransactionsLayout";
import WarehouseDashboard from "./pages/WarehouseDashboard";
import MaterialInward from "./pages/MaterialInward";
import GRN from "./pages/GRN";
import ReceiptForm from "./pages/ReceiptForm";
import QualityInspection from "./pages/QualityInspection";
import QualityInspectionForm from "./pages/QualityInspectionForm";
import Putaway from "./pages/Putaway";
import PutawayForm from "./pages/PutawayForm";
import Picklist from "./pages/Picklist";
import PicklistForm from "./pages/PicklistForm";
import MaterialIssues from "./pages/MaterialIssues";
import MaterialIssueForm from "./pages/MaterialIssueForm";
import Consignments from "./pages/Consignments";
import ConsignmentForm from "./pages/ConsignmentForm";
import Dispatch from "./pages/Dispatch";
import DispatchForm from "./pages/DispatchForm";
import PurchaseReturns from "./pages/PurchaseReturns";
import PurchaseReturnForm from "./pages/PurchaseReturnForm";
import OutwardLabelling from "./pages/OutwardLabelling";
import AcknowledgeDelivery from "./pages/AcknowledgeDelivery";
import StockSegregation from "./pages/StockSegregation";
import WarehouseNotifications from "./pages/WarehouseNotifications";
import WarehouseReports from "./pages/WarehouseReports";
import MastersLayout from "./pages/masters/MastersLayout";
import Warehouses from "./pages/masters/Warehouses";
import WarehouseForm from "./pages/masters/WarehouseForm";
import WarehouseDetail from "./pages/masters/WarehouseDetail";
import FloorPlan from "./pages/masters/FloorPlan";
import StorageTypes from "./pages/masters/StorageTypes";
import StockMovements from "./pages/StockMovements";
import StockMovementForm from "./pages/StockMovementForm";

/**
 * The warehouse module's own router.
 *
 * `App.tsx` mounts this at `/warehouse/*` (and at `/grn`, `/stock` and `/issues` for
 * links that predate the module), so every screen below is reachable without the
 * app-level router knowing any of them exist — adding a screen is a change to this
 * file plus a row in `PAGE_TREE`, and nothing shared moves.
 *
 * Gate entry and GRN are one form with a different `receipt_type`, and outward QC is
 * the inspection screen with a different `inspection_type`. Passing the discriminator
 * as a prop keeps one implementation of each rather than a near-copy that drifts.
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

        <Route path="putaway" element={<Putaway />} />
        <Route path="putaway/:id" element={<PutawayForm />} />
        <Route path="stock-movements" element={<StockMovements />} />
        <Route path="stock-movements/new" element={<StockMovementForm />} />

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

        <Route path="dispatch/consignments" element={<Consignments />} />
        <Route path="dispatch/consignments/new" element={<ConsignmentForm />} />
        <Route path="dispatch/consignments/:id" element={<ConsignmentForm />} />
        <Route path="dispatch" element={<Dispatch />} />
        <Route path="dispatch/new" element={<DispatchForm />} />
        <Route path="dispatch/:id" element={<DispatchForm />} />

        <Route path="purchase-returns" element={<PurchaseReturns />} />
        <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
        <Route path="purchase-returns/:id" element={<PurchaseReturnForm />} />
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

      <Route path="putaway" element={<Putaway />} />
      <Route path="putaway/:id" element={<PutawayForm />} />
      <Route path="stock-movements" element={<StockMovements />} />
      <Route path="stock-movements/new" element={<StockMovementForm />} />

      <Route path="purchase-returns" element={<PurchaseReturns />} />
      <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
      <Route path="purchase-returns/:id" element={<PurchaseReturnForm />} />

      <Route path="material-issues" element={<MaterialIssues />} />
      <Route path="material-issues/new" element={<MaterialIssueForm />} />
      <Route path="material-issues/:id" element={<MaterialIssueForm />} />
      <Route path="material-returns" element={<MaterialIssues direction="IN" />} />
      <Route path="material-returns/new" element={<MaterialIssueForm direction="IN" />} />
      <Route path="material-returns/:id" element={<MaterialIssueForm direction="IN" />} />

      <Route path="consignments" element={<Navigate to="/warehouse/dispatch/consignments" replace />} />
      <Route path="consignments/new" element={<Navigate to="/warehouse/dispatch/consignments/new" replace />} />
      <Route path="consignments/:id" element={<ConsignmentRedirect />} />

      <Route path="dispatch/consignments" element={<Consignments />} />
      <Route path="dispatch/consignments/new" element={<ConsignmentForm />} />
      <Route path="dispatch/consignments/:id" element={<ConsignmentForm />} />
      <Route path="dispatch" element={<Dispatch />} />
      <Route path="dispatch/new" element={<DispatchForm />} />
      <Route path="dispatch/:id" element={<DispatchForm />} />

      <Route path="outward-labelling" element={<OutwardLabelling />} />
      <Route path="acknowledge-delivery" element={<AcknowledgeDelivery />} />
      <Route path="stock-segregation" element={<StockSegregation />} />
      <Route path="notifications" element={<WarehouseNotifications />} />
      <Route path="reports" element={<WarehouseReports />} />

      {/* Outward QC — the same screen, inspecting before a consignment leaves. */}
      <Route path="qc-outward" element={<QualityInspection type="OUTGOING" title="Outward QC" />} />
      <Route path="qc-outward/new" element={<QualityInspectionForm type="OUTGOING" />} />
      <Route path="qc-outward/:id" element={<QualityInspectionForm type="OUTGOING" />} />

      <Route path="masters" element={<MastersLayout />}>
        <Route index element={<Navigate to="warehouses" replace />} />
        <Route path="warehouses" element={<Warehouses />} />
        <Route path="warehouses/new" element={<WarehouseForm />} />
        <Route path="warehouses/:id" element={<WarehouseDetail />} />
        <Route path="warehouses/:id/edit" element={<WarehouseForm />} />
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
  return <Navigate to={`/warehouse/dispatch/consignments/${id}`} replace />;
}

export default WarehouseModule;
