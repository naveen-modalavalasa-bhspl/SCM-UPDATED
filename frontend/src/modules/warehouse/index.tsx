// @ts-nocheck
import { Route, Routes, Navigate } from "react-router-dom";
import AcknowledgeDelivery from "./pages/AcknowledgeDelivery";
import FloorPlan from "./pages/FloorPlan";
import FloorPlan3D from "./pages/FloorPlan3D";
import GRN from "./pages/GRN";
import GRNForm from "./pages/GRNForm";
import MaterialInward from "./pages/MaterialInward";
import MaterialInwardForm from "./pages/MaterialInwardForm";
import MaterialIssueForm from "./pages/MaterialIssueForm";
import MaterialIssues from "./pages/MaterialIssues";
import OutwardLabelling from "./pages/OutwardLabelling";
import PurchaseReturnForm from "./pages/PurchaseReturnForm";
import PurchaseReturns from "./pages/PurchaseReturns";
import Putaway from "./pages/Putaway";
import PutawayForm from "./pages/PutawayForm";
import QCOutward from "./pages/QCOutward";
import QCOutwardForm from "./pages/QCOutwardForm";
import QualityInspection from "./pages/QualityInspection";
import QualityInspectionForm from "./pages/QualityInspectionForm";
import StockSegregation from "./pages/StockSegregation";
import TemplateMaterialIssueList from "./pages/TemplateMaterialIssueList";
import WarehouseDashboard from "./pages/WarehouseDashboard";
import WarehouseNotifications from "./pages/WarehouseNotifications";
import WarehouseReports from "./pages/WarehouseReports";
import Warehouses from "./pages/masters/Warehouses";
import WarehouseForm from "./pages/masters/WarehouseForm";
import WarehouseDetail from "./pages/masters/WarehouseDetail";
import TransactionsLayout from "./pages/TransactionsLayout";
import MastersLayout from "./pages/MastersLayout";

export function WarehouseModule() {
  return (
    <Routes>
      {/* Overview Dashboard */}
      <Route index element={<WarehouseDashboard />} />
      <Route path="dashboard" element={<WarehouseDashboard />} />
      <Route path="masters" element={<MastersLayout />} />

      {/* Transactions Sub-tab layout */}
      <Route path="transactions" element={<TransactionsLayout />}>
        <Route index element={<Navigate to="material-inward" replace />} />
        
        {/* Material Inward / Gate Entry */}
        <Route path="material-inward" element={<MaterialInward />} />
        <Route path="material-inward/new" element={<MaterialInwardForm />} />
        <Route path="material-inward/:id" element={<MaterialInwardForm />} />

        {/* Goods Receipt Note (GRN) */}
        <Route path="grn" element={<GRN />} />
        <Route path="grn/new" element={<GRNForm />} />
        <Route path="grn/:id" element={<GRNForm />} />

        {/* Quality Inspection */}
        <Route path="quality-inspection" element={<QualityInspection />} />
        <Route path="quality-inspection/new" element={<QualityInspectionForm />} />
        <Route path="quality-inspection/:id" element={<QualityInspectionForm />} />

        {/* Stock Putaway */}
        <Route path="putaway" element={<Putaway />} />
        <Route path="putaway/new" element={<PutawayForm />} />
        <Route path="putaway/:id" element={<PutawayForm />} />

        {/* Purchase Returns */}
        <Route path="purchase-returns" element={<PurchaseReturns />} />
        <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
        <Route path="purchase-returns/:id" element={<PurchaseReturnForm />} />

        {/* Material Issues */}
        <Route path="material-issues" element={<MaterialIssues />} />
        <Route path="material-issues/new" element={<MaterialIssueForm />} />
        <Route path="material-issues/:id" element={<MaterialIssueForm />} />
      </Route>

      {/* Legacy root-level routes (to prevent standard actions/links from breaking) */}
      <Route path="material-inward" element={<MaterialInward />} />
      <Route path="material-inward/new" element={<MaterialInwardForm />} />
      <Route path="material-inward/:id" element={<MaterialInwardForm />} />

      <Route path="grn" element={<GRN />} />
      <Route path="grn/new" element={<GRNForm />} />
      <Route path="grn/:id" element={<GRNForm />} />

      <Route path="quality-inspection" element={<QualityInspection />} />
      <Route path="quality-inspection/new" element={<QualityInspectionForm />} />
      <Route path="quality-inspection/:id" element={<QualityInspectionForm />} />

      <Route path="putaway" element={<Putaway />} />
      <Route path="putaway/new" element={<PutawayForm />} />
      <Route path="putaway/:id" element={<PutawayForm />} />

      <Route path="purchase-returns" element={<PurchaseReturns />} />
      <Route path="purchase-returns/new" element={<PurchaseReturnForm />} />
      <Route path="purchase-returns/:id" element={<PurchaseReturnForm />} />

      <Route path="material-issues" element={<MaterialIssues />} />
      <Route path="material-issues/new" element={<MaterialIssueForm />} />
      <Route path="material-issues/:id" element={<MaterialIssueForm />} />

      {/* Other Warehouse Sub-pages */}
      <Route path="floor-plan" element={<FloorPlan />} />
      <Route path="floor-plan-3d" element={<FloorPlan3D />} />
      <Route path="notifications" element={<WarehouseNotifications />} />
      <Route path="reports" element={<WarehouseReports />} />
      <Route path="acknowledge-delivery" element={<AcknowledgeDelivery />} />
      <Route path="stock-segregation" element={<StockSegregation />} />
      <Route path="template-material-issues" element={<TemplateMaterialIssueList />} />
      <Route path="outward-labelling" element={<OutwardLabelling />} />

      {/* Master Data */}
      <Route path="masters/warehouses" element={<Warehouses />} />
      <Route path="masters/warehouses/new" element={<WarehouseForm />} />
      <Route path="masters/warehouses/:id" element={<WarehouseDetail />} />
      <Route path="masters/warehouses/:id/edit" element={<WarehouseForm />} />
    </Routes>
  );
}
export default WarehouseModule;
