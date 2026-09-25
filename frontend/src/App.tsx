import { Suspense, lazy } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useHref } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { AuthProvider, useAuth } from "@/shared/auth/AuthContext";
import { AppLayout } from "@/shared/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
// Approvals is its own module now — the inbox, decisions, reports and the
// indent review screen all live there, not inside indents.
// The gate pass, outside the shell for the same reason the order print is: what
// leaves the printer is the pass the driver shows at the gate.
// The warehouse module owns goods receipt, stock and issues now; it routes its own
// sub-pages, so these paths hand the whole subtree to it.
// Each inventory screen is its own route so it can appear in the left rail.
// The API console — build an API from the screen over any table in the database.
// `PurchaseConsolidation*`, not `Consolidation*`: the approvals module already owns
// that name for INDENT consolidation, which is a different document entirely.
// Logistics: consignment -> dispatch -> transport -> acknowledgement, plus the
// transport provider's own portal. Consignments and Dispatch are the warehouse's own
// screens, re-exported by the logistics module and mounted under /logistics/* — the
// same documents and the same flow, reached from the module that works them.
// The supplier portal — a second audience, on its own shell and its own token.
// One screen serves all four report ledgers; the ledger key is a route param.
// Mounts the alert/confirm dialog host and pulls the server's copy catalog once.
import { ToastProvider, AppSplash } from "@/shared/components";

// ---------------------------------------------------------------------------
// Route-level code splitting (2026-09-03)
//
// Every screen was a STATIC import here -- 102 of them -- so one bundle carried all
// 120 pages and every user downloaded the warehouse module, the reports engine, the
// integrations console and the admin panel to open the Home screen. Built size was a
// single 2.68 MB JavaScript chunk; on a warehouse tablet over 4G that is the whole
// wait before anything appears.
//
// `React.lazy` splits each route into its own chunk that is fetched when the route is
// first visited. The login page is deliberately NOT lazy: it is the first paint, and
// making it a second round trip would move the delay rather than remove it.
//
// Named exports need the `.then(m => ({ default: m.X }))` shim because `lazy` resolves
// a module whose DEFAULT export is the component, and most pages here are named.
// ---------------------------------------------------------------------------
const AcknowledgementsPage = lazy(() => import("@/modules/indents/pages/AcknowledgementsPage"));
const AcknowledgementDetailPage = lazy(() => import("@/modules/indents/pages/AcknowledgementDetailPage"));
const ActivityEventPage = lazy(() => import("@/modules/integrations").then((m) => ({ default: m.ActivityEventPage })));
const AdminPage = lazy(() => import("@/modules/admin/pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const AlertProvider = lazy(() => import("@/modules/alerts").then((m) => ({ default: m.AlertProvider })));
const AllocationApprovalDetailPage = lazy(() => import("@/modules/inventory/pages/AllocationApprovalDetailPage").then((m) => ({ default: m.AllocationApprovalDetailPage })));
const AllocationCycleApprovalPage = lazy(() => import("@/modules/inventory/pages/AllocationCycleApprovalPage").then((m) => ({ default: m.AllocationCycleApprovalPage })));
const AllocationPage = lazy(() => import("@/modules/inventory/pages/AllocationPage").then((m) => ({ default: m.AllocationPage })));
const ApiClientDetailPage = lazy(() => import("@/modules/integrations").then((m) => ({ default: m.ApiClientDetailPage })));
const ApiClientsPage = lazy(() => import("@/modules/integrations").then((m) => ({ default: m.ApiClientsPage })));
const AppLogsPage = lazy(() => import("@/modules/admin/pages/AppLogsPage").then((m) => ({ default: m.AppLogsPage })));
const ApprovalCorrectionPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ApprovalCorrectionPage })));
const ApprovalFlowPage = lazy(() => import("@/modules/admin/pages/ApprovalFlowPage").then((m) => ({ default: m.ApprovalFlowPage })));
const ApprovalOverviewPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ApprovalOverviewPage })));
const ApprovalsPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ApprovalsPage })));
const AttachmentsReportPage = lazy(() => import("@/modules/reports/pages/AttachmentsReportPage").then((m) => ({ default: m.AttachmentsReportPage })));
const AuditPage = lazy(() => import("@/modules/admin/pages/AuditPage").then((m) => ({ default: m.AuditPage })));
const CarrierAckPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.CarrierAckPage })));
const CarrierJobPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.CarrierJobPage })));
const CarrierJobsPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.CarrierJobsPage })));
const CarrierLayout = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.CarrierLayout })));
const CarrierLoginPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.CarrierLoginPage })));
const ChainEditorPage = lazy(() => import("@/modules/admin/pages/ChainEditorPage").then((m) => ({ default: m.ChainEditorPage })));
const CodeFormatsPage = lazy(() => import("@/modules/settings/pages/CodeFormatsPage").then((m) => ({ default: m.CodeFormatsPage })));
const ConsignmentFormScreen = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.ConsignmentFormScreen })));
const ConsignmentPrintPage = lazy(() => import("@/modules/warehouse/pages/ConsignmentPrintPage").then((m) => ({ default: m.ConsignmentPrintPage })));
const ConsignmentsScreen = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.ConsignmentsScreen })));
const ConsolidationDetailPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ConsolidationDetailPage })));
const ConsolidationIssuePage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ConsolidationIssuePage })));
const ConsolidationItemPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ConsolidationItemPage })));
const ConsolidationPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.ConsolidationPage })));
const DecisionQueuePage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.DecisionQueuePage })));
const DispatchConfirmPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.DispatchConfirmPage })));
const DispatchPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.DispatchPage })));
const DispatchPrintPage = lazy(() => import("@/modules/warehouse/pages/DispatchPrintPage").then((m) => ({ default: m.DispatchPrintPage })));
const FallbackLogPage = lazy(() => import("@/modules/admin/pages/FallbackLogPage").then((m) => ({ default: m.FallbackLogPage })));
const ForgotPasswordPage = lazy(() => import("@/pages/PasswordResetPages").then((m) => ({ default: m.ForgotPasswordPage })));
const FulfilmentBatchPage = lazy(() => import("@/modules/inventory/pages/FulfilmentBatchPage").then((m) => ({ default: m.FulfilmentBatchPage })));
const FulfilmentDeskPage = lazy(() => import("@/modules/inventory/pages/FulfilmentDeskPage").then((m) => ({ default: m.FulfilmentDeskPage })));
const GRNPrintPage = lazy(() => import("@/modules/warehouse/pages/GRNPrintPage").then((m) => ({ default: m.GRNPrintPage })));
const GatePassPrintPage = lazy(() => import("@/modules/logistics/pages/GatePassPrintPage").then((m) => ({ default: m.GatePassPrintPage })));
const GroupsPage = lazy(() => import("@/modules/rbac/pages/GroupsPage").then((m) => ({ default: m.GroupsPage })));
const HomePage = lazy(() => import("@/modules/home/pages/HomePage").then((m) => ({ default: m.HomePage })));
const IndentBoardPage = lazy(() => import("@/modules/indents/pages/BoardPage").then((m) => ({ default: m.IndentBoardPage })));
const IndentDashboardPage = lazy(() => import("@/modules/indents/pages/DashboardPage").then((m) => ({ default: m.IndentDashboardPage })));
const IndentDetailPage = lazy(() => import("@/modules/indents/pages/DetailPage").then((m) => ({ default: m.IndentDetailPage })));
const IndentFormPage = lazy(() => import("@/modules/indents/pages/FormPage").then((m) => ({ default: m.IndentFormPage })));
const IndentJourneyPage = lazy(() => import("@/modules/indents/pages/JourneyPage").then((m) => ({ default: m.IndentJourneyPage })));
const IndentPrintPage = lazy(() => import("@/modules/indents/pages/PrintPage").then((m) => ({ default: m.IndentPrintPage })));
const IndentListPage = lazy(() => import("@/modules/indents/pages/ListPage").then((m) => ({ default: m.IndentListPage })));
const IndentNotificationsPage = lazy(() => import("@/modules/indents/pages/NotificationsPage").then((m) => ({ default: m.IndentNotificationsPage })));
const IndentReportsPage = lazy(() => import("@/modules/indents/pages/ReportsPage").then((m) => ({ default: m.IndentReportsPage })));
const InspectionPrintPage = lazy(() => import("@/modules/warehouse/pages/InspectionPrintPage").then((m) => ({ default: m.InspectionPrintPage })));
const InventoryOverviewPage = lazy(() => import("@/modules/inventory/pages/OverviewPage").then((m) => ({ default: m.InventoryOverviewPage })));
const ItemDemandPage = lazy(() => import("@/modules/inventory/pages/ItemDemandPage").then((m) => ({ default: m.ItemDemandPage })));
const JobProfilesPage = lazy(() => import("@/modules/rbac/pages/JobProfilesPage").then((m) => ({ default: m.JobProfilesPage })));
const LabelsPage = lazy(() => import("@/modules/inventory/pages/LabelsPage").then((m) => ({ default: m.LabelsPage })));
const LiveTrackingPage = lazy(() => import("@/modules/reports/pages/LiveTrackingPage").then((m) => ({ default: m.LiveTrackingPage })));
const LogisticsActivityPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.LogisticsActivityPage })));
const LogisticsOverviewPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.LogisticsOverviewPage })));
const LogisticsVendorsPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.LogisticsVendorsPage })));
const MRConsolidationPage = lazy(() => import("@/modules/procurement/pages/MRConsolidationPage").then((m) => ({ default: m.MRConsolidationPage })));
const MailPage = lazy(() => import("@/modules/admin/pages/MailPage").then((m) => ({ default: m.MailPage })));
const MastersPage = lazy(() => import("@/modules/masters/pages/MastersPage").then((m) => ({ default: m.MastersPage })));
// The same masters, split by the module that owns them. `/masters` stays whole and
// unchanged; these are a second door on the same rows, each with its own page code so
// RBAC can hand out (or withhold) one module's masters without touching another's.
const InventoryMastersPage = lazy(() => import("@/modules/inventory/pages/InventoryMastersPage").then((m) => ({ default: m.InventoryMastersPage })));
const ProcurementMastersPage = lazy(() => import("@/modules/procurement/pages/ProcurementMastersPage").then((m) => ({ default: m.ProcurementMastersPage })));
const IndentMastersPage = lazy(() => import("@/modules/indents/pages/IndentMastersPage").then((m) => ({ default: m.IndentMastersPage })));
const OrgMastersPage = lazy(() => import("@/modules/admin/pages/OrgMastersPage").then((m) => ({ default: m.OrgMastersPage })));
const MaterialIssuePrintPage = lazy(() => import("@/modules/warehouse/pages/MaterialIssuePrintPage").then((m) => ({ default: m.MaterialIssuePrintPage })));
const MaterialRequestDetailPage = lazy(() => import("@/modules/inventory/pages/MaterialRequestDetailPage").then((m) => ({ default: m.MaterialRequestDetailPage })));
const MaterialRequestFormPage = lazy(() => import("@/modules/inventory/pages/MaterialRequestFormPage").then((m) => ({ default: m.MaterialRequestFormPage })));
const MaterialRequestsPage = lazy(() => import("@/modules/inventory/pages/MaterialRequestsPage").then((m) => ({ default: m.MaterialRequestsPage })));
const MyDecisionsPage = lazy(() => import("@/modules/approvals").then((m) => ({ default: m.MyDecisionsPage })));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));
const NotificationsPage = lazy(() => import("@/modules/admin/pages/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));
const NumberingPage = lazy(() => import("@/modules/admin/pages/NumberingPage").then((m) => ({ default: m.NumberingPage })));
const PODetailPage = lazy(() => import("@/modules/procurement/pages/PODetailPage").then((m) => ({ default: m.PODetailPage })));
const POFormPage = lazy(() => import("@/modules/procurement/pages/POFormPage").then((m) => ({ default: m.POFormPage })));
const POListPage = lazy(() => import("@/modules/procurement/pages/POListPage").then((m) => ({ default: m.POListPage })));
const POPrintPage = lazy(() => import("@/modules/procurement/pages/POPrintPage").then((m) => ({ default: m.POPrintPage })));
const PicklistPrintPage = lazy(() => import("@/modules/warehouse/pages/PicklistPrintPage").then((m) => ({ default: m.PicklistPrintPage })));
const PlatformLinksPage = lazy(() => import("@/modules/integrations").then((m) => ({ default: m.PlatformLinksPage })));
const PoliciesPage = lazy(() => import("@/modules/admin/pages/PoliciesPage").then((m) => ({ default: m.PoliciesPage })));
const ProcurementLedgerPage = lazy(() => import("@/modules/procurement/pages/ProcurementLedgerPage").then((m) => ({ default: m.ProcurementLedgerPage })));
const ProcurementOverviewPage = lazy(() => import("@/modules/procurement/pages/ProcurementOverviewPage").then((m) => ({ default: m.ProcurementOverviewPage })));
const ProfilePage = lazy(() => import("@/pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const ProviderSelectionPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.ProviderSelectionPage })));
const PurchaseConsolidationDetailPage = lazy(() => import("@/modules/procurement/pages/PurchaseConsolidationDetailPage").then((m) => ({ default: m.PurchaseConsolidationDetailPage })));
const PurchaseConsolidationFormPage = lazy(() => import("@/modules/procurement/pages/PurchaseConsolidationFormPage").then((m) => ({ default: m.PurchaseConsolidationFormPage })));
const PurchaseConsolidationListPage = lazy(() => import("@/modules/procurement/pages/PurchaseConsolidationListPage").then((m) => ({ default: m.PurchaseConsolidationListPage })));
const PurchaseReturnsPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.PurchaseReturnsPage })));
const PurchaseReturnFormPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.PurchaseReturnFormPage })));
const PurchaseReturnDetailPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.PurchaseReturnDetailPage })));
const PutawayPrintPage = lazy(() => import("@/modules/warehouse/pages/PutawayPrintPage").then((m) => ({ default: m.PutawayPrintPage })));
const QuotationListPage = lazy(() => import("@/modules/procurement/pages/QuotationListPage").then((m) => ({ default: m.QuotationListPage })));
const RFQDetailPage = lazy(() => import("@/modules/procurement/pages/RFQDetailPage").then((m) => ({ default: m.RFQDetailPage })));
const RFQFormPage = lazy(() => import("@/modules/procurement/pages/RFQFormPage").then((m) => ({ default: m.RFQFormPage })));
const RFQListPage = lazy(() => import("@/modules/procurement/pages/RFQListPage").then((m) => ({ default: m.RFQListPage })));
const ReceivingConfigPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReceivingConfigPage })));
const ReportLedgerPage = lazy(() => import("@/modules/reports").then((m) => ({ default: m.ReportLedgerPage })));
const RequisitionDetailPage = lazy(() => import("@/modules/procurement/pages/RequisitionDetailPage").then((m) => ({ default: m.RequisitionDetailPage })));
const RequisitionFormPage = lazy(() => import("@/modules/procurement/pages/RequisitionFormPage").then((m) => ({ default: m.RequisitionFormPage })));
const RequisitionListPage = lazy(() => import("@/modules/procurement/pages/RequisitionListPage").then((m) => ({ default: m.RequisitionListPage })));
const ResetPasswordPage = lazy(() => import("@/pages/PasswordResetPages").then((m) => ({ default: m.ResetPasswordPage })));
const ReturnDetailPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnDetailPage })));
const ReturnFormPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnFormPage })));
const ReturnJourneyPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnJourneyPage })));
const ReturnTrailPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnTrailPage })));
const ReturnsListPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnsListPage })));
const ReturnsOverviewPage = lazy(() => import("@/modules/returns").then((m) => ({ default: m.ReturnsOverviewPage })));
const RulesPage = lazy(() => import("@/modules/admin/pages/RulesPage").then((m) => ({ default: m.RulesPage })));
const SettingsPage = lazy(() => import("@/modules/settings/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const StockAdjustmentsView = lazy(() => import("@/modules/inventory/components/StockAdjustmentsView").then((m) => ({ default: m.StockAdjustmentsView })));
const StockBalanceView = lazy(() => import("@/modules/inventory/components/StockBalanceView").then((m) => ({ default: m.StockBalanceView })));
const StockLedgerView = lazy(() => import("@/modules/inventory/components/StockLedgerView").then((m) => ({ default: m.StockLedgerView })));
const StockMovementPrintPage = lazy(() => import("@/modules/warehouse/pages/StockMovementPrintPage").then((m) => ({ default: m.StockMovementPrintPage })));
const StockReplenishmentView = lazy(() => import("@/modules/inventory/components/StockReplenishmentView").then((m) => ({ default: m.StockReplenishmentView })));
const OutboundQualityInspectionForm = lazy(() => import("@/modules/warehouse/pages/OutboundQualityInspectionForm"));
const MaterialIssueForm = lazy(() => import("@/modules/warehouse/pages/MaterialIssueForm"));
const StockTransferView = lazy(() => import("@/modules/inventory/components/StockTransferView").then((m) => ({ default: m.StockTransferView })));
const StockValuationView = lazy(() => import("@/modules/inventory/components/StockValuationView").then((m) => ({ default: m.StockValuationView })));
const StockingPointsPage = lazy(() => import("@/modules/inventory/pages/StockingPointsPage").then((m) => ({ default: m.StockingPointsPage })));
const SupplierAccountsPage = lazy(() => import("@/modules/procurement/pages/SupplierAccountsPage").then((m) => ({ default: m.SupplierAccountsPage })));
const SupplierLayout = lazy(() => import("@/modules/supplier/SupplierLayout").then((m) => ({ default: m.SupplierLayout })));
const SupplierLoginPage = lazy(() => import("@/modules/supplier/pages/SupplierLoginPage").then((m) => ({ default: m.SupplierLoginPage })));
const SupplierPODetailPage = lazy(() => import("@/modules/supplier/pages/SupplierPODetailPage").then((m) => ({ default: m.SupplierPODetailPage })));
const SupplierPOListPage = lazy(() => import("@/modules/supplier/pages/SupplierPOListPage").then((m) => ({ default: m.SupplierPOListPage })));
const SupplierPasswordPage = lazy(() => import("@/modules/supplier/pages/SupplierPasswordPage").then((m) => ({ default: m.SupplierPasswordPage })));
const SupplierProfilePage = lazy(() => import("@/modules/supplier/pages/SupplierProfilePage").then((m) => ({ default: m.SupplierProfilePage })));
const SupplierReturnDetailPage = lazy(() => import("@/modules/supplier/pages/SupplierReturnDetailPage").then((m) => ({ default: m.SupplierReturnDetailPage })));
const SupplierReturnListPage = lazy(() => import("@/modules/supplier/pages/SupplierReturnListPage").then((m) => ({ default: m.SupplierReturnListPage })));
const SupplierRFQDetailPage = lazy(() => import("@/modules/supplier/pages/SupplierRFQDetailPage").then((m) => ({ default: m.SupplierRFQDetailPage })));
const SupplierRFQListPage = lazy(() => import("@/modules/supplier/pages/SupplierRFQListPage").then((m) => ({ default: m.SupplierRFQListPage })));
const SuppliersPage = lazy(() => import("@/modules/procurement/pages/SuppliersPage").then((m) => ({ default: m.SuppliersPage })));
const TraceabilityPage = lazy(() => import("@/modules/reports/pages/TraceabilityPage").then((m) => ({ default: m.TraceabilityPage })));
const TransportDetailPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.TransportDetailPage })));
const TransportFormPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.TransportFormPage })));
const TransportRequestsPage = lazy(() => import("@/modules/logistics").then((m) => ({ default: m.TransportRequestsPage })));
const UsersPage = lazy(() => import("@/modules/rbac/pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const WarehouseModule = lazy(() => import("@/modules/warehouse").then((m) => ({ default: m.WarehouseModule })));
const WebhookDetailPage = lazy(() => import("@/modules/integrations").then((m) => ({ default: m.WebhookDetailPage })));


const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/* /logistics/transport/... -> /logistics/shipments/..., carrying whatever followed.
 * A plain <Navigate> cannot: the tail is a splat and the deep links that matter all
 * have one — the approvals inbox opens `/logistics/transport/12?approval=1`, and the
 * gate pass hangs off the id. Dropping the tail would land every one of them on the
 * list with the document they were sent to open nowhere in sight. */
function LegacyTransportRedirect() {
  const { pathname, search, hash } = useLocation();
  const tail = pathname.replace(/^\/logistics\/transport/, "");
  return <Navigate to={`/logistics/shipments${tail}${search}${hash}`} replace />;
}

/* /inventory/allocation-approvals -> the Fulfilment Desk's Approvals tab.
 *
 * A plain <Navigate> would drop the query string, and `?review=<id>` is exactly what
 * the notification for an allocation carries (`platform/notifications/service.py`).
 * Every one of those links, including the ones already sitting in somebody's inbox,
 * would have landed on the list with the document it was sent to open nowhere in
 * sight — so a review id goes straight to the review screen, which is a live route
 * and was never part of the merge. */
function LegacyAllocationApprovalsRedirect() {
  const { search, hash } = useLocation();
  const review = Number(new URLSearchParams(search).get("review"));
  if (Number.isFinite(review) && review > 0) {
    const decision = new URLSearchParams(search).get("decision") === "1";
    return <Navigate to={`/inventory/allocation-approvals/${review}`
      + (decision ? "?decision=1" : "")} replace />;
  }
  return <Navigate to={`/inventory/fulfilment?tab=approvals${hash}`} replace />;
}


/** Shown while a route's chunk is still arriving. Deliberately quiet: on a LAN the
 *  chunk lands in milliseconds and a spinner would flash on every navigation. */
function RouteFallback() {
  return <div className="p-8 text-sm text-muted">Loading…</div>;
}

function AppRoutes() {
  const { me, loading } = useAuth();
  if (loading) return <AppSplash />;

  return (
    <Suspense fallback={<RouteFallback />}>
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* Both PUBLIC — somebody who cannot sign in is the only caller they have.
          Safe because the request endpoint answers 204 whatever happens, so
          neither screen can be used to find out which addresses are real.
          Reachable while signed in too: the reset link may be opened in a
          browser that still holds a session, and bouncing it to Home would
          strand somebody who genuinely wants a new password. */}
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* The supplier portal. Outside the employee shell entirely — a vendor holds no
          RBAC role, so there is no menu to build and no <Can> to apply. It is gated on
          its own token (SUPPLIER_TOKEN_KEY), and `me` here is irrelevant: an employee
          being signed in must not open a vendor's screens, and a vendor must not need
          an SCM account to reach theirs. */}
      <Route path="/supplier/login" element={<SupplierLoginPage />} />
      <Route path="/supplier/password" element={<SupplierPasswordPage />} />
      <Route path="/supplier" element={<SupplierLayout />}>
        <Route index element={<Navigate to="/supplier/rfqs" replace />} />
        <Route path="rfqs" element={<SupplierRFQListPage />} />
        <Route path="rfqs/:id" element={<SupplierRFQDetailPage />} />
        {/* The orders they have been sent, and the despatch note they file against
            one before the vehicle leaves (doc B12). */}
        <Route path="pos" element={<SupplierPOListPage />} />
        <Route path="pos/:id" element={<SupplierPODetailPage />} />
        {/* Goods coming BACK — their own tab beside the orders (2026-09-11). They used
            to be a section under `SupplierPOListPage`, which meant scrolling the whole
            order board to reach them and nowhere to go when told one was on its way. */}
        <Route path="returns" element={<SupplierReturnListPage />} />
        <Route path="returns/:id" element={<SupplierReturnDetailPage />} />
        <Route path="profile" element={<SupplierProfilePage />} />
      </Route>

      {/* The transport provider's portal. Same account and the same token as the
          supplier portal — a carrier IS a vendor — but a different set of screens,
          because quoting for a lane, accepting the job and reporting it delivered is
          not the same work as pricing an RFQ. */}
      <Route path="/carrier/login" element={<CarrierLoginPage />} />
      <Route path="/carrier" element={<CarrierLayout />}>
        <Route index element={<Navigate to="/carrier/jobs" replace />} />
        <Route path="jobs" element={<CarrierJobsPage />} />
        <Route path="jobs/:id" element={<CarrierJobPage />} />
        {/* Awarded, not yet confirmed: the carrier says yes and, in the same press,
            names the vehicle and the driver the gate should expect. Those answers are
            what the dispatch queue and the shipment then read back. */}
        <Route path="acknowledgements" element={<CarrierAckPage />} />
        {/* The same account screen the supplier portal shows, mounted here too. One
            implementation — a carrier IS a vendor and the details are identical — but
            reached inside the carrier shell, because linking the tab at
            /supplier/profile dropped the driver into the supplier portal's header and
            tabs with no route back to their shipments. */}
        <Route path="profile" element={<SupplierProfilePage />} />
      </Route>
      {/* The forced change-password screen, on the carrier's own path. Same component
          as /supplier/password and OUTSIDE the carrier shell for the same reason that
          one is outside the supplier shell: it is what a vendor gets BEFORE they are
          let in, so there are no tabs to render yet. Without this route a carrier
          signing in for the first time was sent to /supplier/password and came out the
          other side looking at the supplier portal. */}
      <Route path="/carrier/password" element={<SupplierPasswordPage />} />

      {/* The order as a document, for paper and for "save as PDF". Outside the shell
          on purpose: what prints has to be the order, not a sidebar with an order next
          to it. Still signed-in only — it is the same data the detail page shows. */}
        <Route
          path="/pos/:id/print"
          element={me ? <POPrintPage /> : <Navigate to="/login" replace />}
        />
        {/* The indent as a document. Same rule as the order above: outside the shell,
            signed-in only, and every field on it is fetched under the viewer's own
            token — an indent this account cannot read prints nothing. */}
        <Route
          path="/indents/:id/print"
          element={me ? <IndentPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/material-issues/:id/print"
          element={me ? <MaterialIssuePrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/grn/:id/print"
          element={me ? <GRNPrintPage /> : <Navigate to="/login" replace />}
        />
        {/* The same sheet and the same row — a gate entry IS the receipt before it
            converts, and the component heads the paper off `receipt_type`. The second
            path exists so the gate register's own link does not read /grn/. */}
        <Route
          path="/warehouse/gate-entries/:id/print"
          element={me ? <GRNPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/consignments/:id/print"
          element={me ? <ConsignmentPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/dispatches/:id/print"
          element={me ? <DispatchPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/picklists/:id/print"
          element={me ? <PicklistPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/putaway/:id/print"
          element={me ? <PutawayPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/inspections/:id/print"
          element={me ? <InspectionPrintPage /> : <Navigate to="/login" replace />}
        />
        <Route
          path="/warehouse/stock-movements/print"
          element={me ? <StockMovementPrintPage /> : <Navigate to="/login" replace />}
        />

      {/* The gate pass for one transport leg — printed, or saved as a PDF, from the
          dispatch screen that raised it. Signed-in only, same data as the shipment. */}
      <Route
        path="/logistics/shipments/:id/gate-pass"
        element={me ? <GatePassPrintPage /> : <Navigate to="/login" replace />}
      />

        <Route element={me ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<HomePage />} />
        {/* Not in PAGE_TREE on purpose: everyone has a profile, so gating it behind an
            rbac_pages row would only mean a permission every role must be granted. */}
        <Route path="profile" element={<ProfilePage />} />
        <Route path="indents" element={<IndentListPage />} />
        <Route path="indents/dashboard" element={<IndentDashboardPage />} />
        <Route path="indents/board" element={<IndentBoardPage />} />
        <Route path="indents/acknowledgements" element={<AcknowledgementsPage />} />
        <Route path="indents/acknowledgements/:indentId" element={<AcknowledgementDetailPage />} />
        {/* The two addresses this screen used to answer on. `/indents/deliveries` was
            its own route; `/indents/acknowledgments` belonged to a duplicate page that
            was deleted while its rbac_pages row stayed active, so the rail advertised
            a link that fell through to "No screen at this address". Both redirect, so
            bookmarks and any database that has not had the rename migration yet still
            land on the real screen. */}
        <Route path="indents/deliveries"
               element={<Navigate to="/indents/acknowledgements" replace />} />
        <Route path="indents/acknowledgments"
               element={<Navigate to="/indents/acknowledgements" replace />} />
        <Route path="indents/reports" element={<IndentReportsPage />} />
        <Route path="indents/notifications" element={<IndentNotificationsPage />} />
        <Route path="indents/new" element={<IndentFormPage />} />
        <Route path="indents/masters" element={<IndentMastersPage />} />
        <Route path="indents/:id/journey" element={<IndentJourneyPage />} />
        {/* A returned indent belongs to its requester, who is not an approver and
            cannot open /approvals at all — the ?correction= form there redirected
            them to Home, so the notification the return sends was a dead end. The
            same screen lives here, under the module they can actually reach. */}
        <Route path="indents/:id/correction" element={<ApprovalCorrectionPage />} />
        <Route path="indents/:id" element={<IndentDetailPage />} />
        {/* Reports and the indent review screen are reached from the inbox via
            ?view=reports / ?reviewIndent=, so they need no route of their own. */}
        {/* The module's landing page. /approvals stays the inbox — every existing
            link, notification and bookmark points there. */}
        <Route path="approvals/overview" element={<ApprovalOverviewPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/decisions" element={<MyDecisionsPage />} />
        {/* Team Queue is retired. The route stays so an old link, a bookmark or a
            stale menu row lands on the inbox instead of on a blank page. */}
        <Route path="approvals/team-queue" element={<Navigate to="/approvals" replace />} />
        <Route path="approvals/consolidation" element={<ConsolidationPage />} />
        {/* Child screen, not a menu entry: it is reached by opening a row, and its
            :cycle is the group key the list navigated with. */}
        <Route path="approvals/consolidation/:cycle" element={<ConsolidationDetailPage />} />
        {/* One item of a consolidation, and everyone who asked for it — opened from an
            item row. Same rule as :cycle above: reached by navigation, never a menu. */}
        <Route path="approvals/consolidation/:cycle/items/:itemId" element={<ConsolidationItemPage />} />
        {/* Serve-from-stock for the whole cycle, one panel per indent. */}
        <Route path="approvals/consolidation/:cycle/serve" element={<ConsolidationIssuePage />} />
        {/* Delegation is retired. The route stays so old links and bookmarks land
            somewhere real instead of on a blank page. */}
        <Route path="approvals/delegations" element={<Navigate to="/approvals" replace />} />
        <Route path="pos" element={<POListPage />} />
        {/* Declared before `pos/:id`, which is read as an id: "new" would otherwise
          * open the detail screen for a purchase order that does not exist. */}
        <Route path="pos/new" element={<POFormPage />} />
        <Route path="pos/:id" element={<PODetailPage />} />
        {/* The buying chain upstream of a PO: requisition -> RFQ -> quotation. */}
        {/* The buying trail, all four document types in one register. */}
        {/* The module's front door: what is waiting on me, where the chain
            is, and the demand pool. Every section on it is gated on the
            documents it reads, so it is safe as a landing page for a
            module whose five registers are granted separately. */}
        <Route path="procurement/overview" element={<ProcurementOverviewPage />} />
        <Route path="procurement/ledger" element={<ProcurementLedgerPage />} />
        {/* The supplier register — who we buy from, and the login each one answers
            an RFQ with. Inside the employee shell like every other procurement
            screen; /supplier/* is the vendors' own portal and stays outside it. */}
        <Route path="procurement/masters" element={<ProcurementMastersPage />} />
        <Route path="procurement/suppliers" element={<SuppliersPage />} />
        <Route path="procurement/requisitions" element={<RequisitionListPage />} />
        <Route path="procurement/requisitions/new" element={<RequisitionFormPage />} />
        {/* Both literals before `:id`, which is read as a number. */}
        <Route path="procurement/requisitions/from-mrs" element={<MRConsolidationPage />} />
        <Route path="procurement/requisitions/:id" element={<RequisitionDetailPage />} />
        <Route path="procurement/requisitions/:id/edit" element={<RequisitionFormPage />} />
        <Route path="procurement/rfqs" element={<RFQListPage />} />
        <Route path="procurement/rfqs/new" element={<RFQFormPage />} />
        <Route path="procurement/rfqs/:id" element={<RFQDetailPage />} />
        <Route path="procurement/rfqs/:id/edit" element={<RFQFormPage />} />
        <Route path="procurement/quotations" element={<QuotationListPage />} />
        {/* Many requisitions, one buying sheet (doc B7). */}
        <Route path="procurement/consolidations" element={<PurchaseConsolidationListPage />} />
        <Route path="procurement/consolidations/new" element={<PurchaseConsolidationFormPage />} />
        <Route path="procurement/consolidations/:id" element={<PurchaseConsolidationDetailPage />} />
        <Route path="admin/supplier-accounts" element={<SupplierAccountsPage />} />

        {/* Logistics — the outward leg (doc Phase D+E), in the order it happens:
         * the packed consignment, the dispatch that releases it, the transport that
         * carries it, and the signature at the far end. The module opens on
         * Consignments because that is where a logistics day starts.
         *
         * Consignments is the SAME screen the warehouse serves, mounted here as well
         * as under /warehouse/* — one implementation, two front doors. Dispatch is
         * this module's own: mode, provider, go. */}
        {/* Landing is Shipments, not Overview/Approval. /logistics used to land on
            Overview which bounced to approvals, so clicking Logistics never showed
            the shipments queue. Shipments is where a logistics day is worked. */}
        <Route path="logistics" element={<Navigate to="/logistics/shipments" replace />} />
        <Route path="logistics/overview" element={<LogisticsOverviewPage />} />
        <Route path="logistics/consignments" element={<ConsignmentsScreen />} />
        <Route path="logistics/consignments/new" element={<ConsignmentFormScreen />} />
        <Route path="logistics/consignments/:id" element={<ConsignmentFormScreen />} />
        <Route path="logistics/dispatch" element={<DispatchPage />} />
        {/* The press itself: consignment, gate pass, mode, provider. Reached from the
         * queue and from a packed consignment — a logistics day never crosses into
         * the warehouse module to send something out. */}
        <Route path="logistics/dispatch/new" element={<DispatchConfirmPage />} />
        {/* Shipments. The screen was "Transport Requests" and answered on
         * /logistics/transport; a row stops being a request the moment it is awarded
         * and spends the rest of its life as a load on a truck, which is what the
         * register actually lists. The four routes below moved with the name, and the
         * old addresses redirect rather than 404 — links were handed out, and the
         * approvals inbox deep-links straight at a leg. */}
        <Route path="logistics/shipments" element={<TransportRequestsPage />} />
        <Route path="logistics/shipments/new" element={<TransportFormPage />} />
        <Route path="logistics/shipments/:id" element={<TransportDetailPage />} />
        <Route path="logistics/shipments/:id/edit" element={<TransportFormPage />} />
        <Route path="logistics/transport"
               element={<Navigate to="/logistics/shipments" replace />} />
        <Route path="logistics/transport/*" element={<LegacyTransportRedirect />} />
        <Route path="logistics/providers" element={<ProviderSelectionPage />} />
        {/* The ledger: every event on every shipment, in the order it happened. */}
        <Route path="logistics/activity" element={<LogisticsActivityPage />} />
        {/* Retired from Logistics.

            Shipment Tracking and Exceptions each drew ONE slice of the ledger above —
            where is it now, and what went wrong — so a desk chasing a consignment read
            half the story on one tab and half on another, and neither said who awarded
            the job, at what price, or when the carrier agreed to it. Both land on the
            ledger, which carries their contents and the rest of the trail besides.

            Signing for what arrived is the indent RAISER's act, and Indents already
            carries that screen — with the shipment leg on it, so they can track it too.

            Redirects rather than deletions: `sync_pages` never removes a menu row, so
            an existing database still lists these until the Alembic migration parks
            them, and a listed tab that renders nothing is worse than one that lands
            somewhere real. */}
        <Route path="logistics/acknowledgements"
               element={<Navigate to="/indents/acknowledgements" replace />} />
        <Route path="logistics/tracking"
               element={<Navigate to="/logistics/activity" replace />} />
        <Route path="logistics/exceptions"
               element={<Navigate to="/logistics/activity" replace />} />
        {/* The register behind the Dispatch dropdown, now in the Logistics tabs beside
            the screen that reads it. Same component and the same Admin-only page grant
            as before — issuing a login outside the company is an administrator's act
            whichever menu it hangs from; only the menu row moved. The old
            /settings/logistics-vendors path below still resolves, so existing links
            and bookmarks keep working. */}
        <Route path="logistics/vendors" element={<LogisticsVendorsPage />} />
        <Route path="grn/*" element={<WarehouseModule />} />
        <Route path="stock/*" element={<WarehouseModule />} />
        <Route path="issues/*" element={<WarehouseModule />} />
        <Route path="warehouse/*" element={<WarehouseModule />} />
        <Route path="returns" element={<ReturnsListPage />} />
        <Route path="returns/dashboard" element={<ReturnsOverviewPage />} />
        <Route path="returns/approvals" element={<ReturnsListPage />} />
        <Route path="returns/mine" element={<ReturnsListPage />} />
        {/* The return queues. One component, the queue read off the path. */}
        <Route path="returns/decisions" element={<DecisionQueuePage />} />
        <Route path="returns/sign-off" element={<DecisionQueuePage />} />
        <Route path="returns/logistics" element={<DecisionQueuePage />} />
        {/* The purchase-return register, and the form and review screen it opens.
            `pro_returns` is still the warehouse module's table and the warehouse still
            owns these two components — but a storekeeper who opened the register from
            the Returns rail was being handed over to the Warehouse module the moment
            they clicked a row or pressed New, and the rail, the tabs and the eyebrow
            all changed under them. Same component, served on this side, exactly as
            Consignments is served under /logistics. `/warehouse/purchase-returns/*`
            still resolves and still behaves as it did. `new` before `:id` so the word
            is never read as an id. */}
        <Route path="returns/purchase" element={<PurchaseReturnsPage />} />
        <Route path="returns/purchase/new" element={<PurchaseReturnFormPage />} />
        <Route path="returns/purchase/:id" element={<PurchaseReturnDetailPage />} />
        <Route path="returns/purchase/:id/edit" element={<PurchaseReturnFormPage />} />
        <Route path="returns/new" element={<ReturnFormPage />} />
        <Route path="returns/settings/receiving" element={<ReceivingConfigPage />} />
        <Route path="returns/:id" element={<ReturnDetailPage />} />
        <Route path="returns/:id/edit" element={<ReturnFormPage />} />
        <Route path="returns/:id/journey" element={<ReturnJourneyPage />} />
        {/* The material's history, not the document's: every other module's paperwork
          * behind the returned items. Gated by the endpoint on `return.decide`. */}
        <Route path="returns/:id/trail" element={<ReturnTrailPage />} />
        <Route path="inventory" element={<InventoryOverviewPage />} />
        <Route path="inventory/masters" element={<InventoryMastersPage />} />
        <Route path="inventory/stock-balance" element={<StockBalanceView />} />
        <Route path="inventory/ledger" element={<StockLedgerView />} />
        <Route path="inventory/replenishment" element={<StockReplenishmentView />} />
        <Route path="inventory/transfers" element={<StockTransferView />} />
        {/* An STO's material issue, worked inside Stock Transfer rather than the
            warehouse rail (REQ_020). The same form; only its home path moves. */}
        <Route path="inventory/transfers/qc/:id"
               element={<OutboundQualityInspectionForm basePath="/inventory/transfers/qc" />} />
        <Route path="inventory/transfers/issues/:id"
               element={<MaterialIssueForm basePath="/inventory/transfers/issues" />} />
        <Route path="inventory/adjustments" element={<StockAdjustmentsView />} />
        <Route path="inventory/valuation" element={<StockValuationView />} />
        {/* The Fulfilment Desk: the Fulfilment Queue and Allocation Approvals as one
            screen (2026-08-21). `/inventory/fulfilment` — one L, the British spelling
            the rest of the app uses — so it cannot collide with the old path beside
            it, which now redirects. */}
        <Route path="inventory/fulfilment" element={<FulfilmentDeskPage />} />
        {/* Both retired front doors, kept as redirects. The rows are parked in
            `page_registry.RETIRED_PAGES`, so they are off the rail — but a bookmark, a
            notification and the alerts catalogue all still point at them, and landing
            on "No screen at this address" is how a retirement reads as a breakage. */}
        <Route path="inventory/fulfillment"
               element={<Navigate to="/inventory/fulfilment" replace />} />
        {/* One monthly cycle, opened from the row above. A detail screen, not a page
            of its own: it carries no rbac_pages row, exactly like
            inventory/allocate/:indentId, so it inherits the Fulfilment Queue's
            permission and every action inside it is still checked server-side.
            The queue has always linked here; the route was simply never registered,
            so every monthly cycle landed on "No screen at this address". */}
        <Route path="inventory/fulfillment/:cycle" element={<FulfilmentBatchPage />} />
        {/* The same screen under the desk's own spelling. Two paths rather than a
            redirect because the queue builds this link from a cycle key that can carry
            a slash, and a redirect would have to reassemble it. */}
        <Route path="inventory/fulfilment/:cycle" element={<FulfilmentBatchPage />} />
        <Route path="inventory/material-requests" element={<MaterialRequestsPage />} />
        {/* Before the `:id` route below, or "new" is read as a material request id. */}
        <Route path="inventory/material-requests/new" element={<MaterialRequestFormPage />} />
        <Route path="inventory/allocate/:indentId" element={<AllocationPage />} />
        {/* Where the MDP/LIP chain is declared — everything downstream reads it. */}
        <Route path="inventory/stocking-points" element={<StockingPointsPage />} />
        <Route path="inventory/allocation-approvals"
               element={<LegacyAllocationApprovalsRedirect />} />
        {/* Child screen, not a menu entry: the list navigates here to review one
            allocation. Without this route that row click is a dead end. */}
        {/* Before the :id route, which matches a single segment and would never catch
            this two-segment path anyway — kept adjacent so the pair reads as one
            decision. Same story as the fulfilment cycle: the page and the link were
            written, only the route was missing, so every monthly cycle dead-ended. */}
        <Route path="inventory/allocation-approvals/cycle/:cycle" element={<AllocationCycleApprovalPage />} />
        <Route path="inventory/allocation-approvals/:id" element={<AllocationApprovalDetailPage />} />
        <Route path="inventory/demand" element={<ItemDemandPage />} />
        <Route path="inventory/labels" element={<LabelsPage />} />
        <Route path="inventory/material-requests/:id" element={<MaterialRequestDetailPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/settings" element={<SettingsPage />} />
        <Route path="admin/code-formats" element={<CodeFormatsPage />} />
        {/* The company mailbox: Inbox, Sent, Compose. Gated by
            `page.settings_mail.view`, and the Compose tab additionally by
            `mail.send` — the server checks both independently. */}
        <Route path="settings/mail" element={<MailPage />} />
        {/* Under Settings, beside Supplier & Carrier Logins: naming a logistics
            partner and issuing them a way in is an administrator's act, not a
            dispatcher's. The screen itself lives in the logistics module. */}
        <Route path="settings/logistics-vendors" element={<LogisticsVendorsPage />} />
        <Route path="rbac/access" element={<UsersPage />} />
        <Route path="rbac/groups" element={<GroupsPage />} />
        {/* Job Profiles: reachable by URL only for now. Adding a menu row means a
            rbac_pages insert, and seed prunes the live tree — same reason the
            custom ladder route below has no menu entry. */}
        <Route path="rbac/job-profiles" element={<JobProfilesPage />} />
        <Route path="admin/rules" element={<RulesPage />} />
        {/* Approvals Config, Custom Ladder and Workflows are gone. All three wrote to
            wf_workflows beside Approval Flow with different rules about what a save
            retires — Approvals Config deactivated every rank-scoped chain for the
            document it saved, which is how a Store Keeper chain disappeared without
            anything on screen saying so. One screen, one writer.

            The paths redirect rather than 404: they are bookmarked, and landing on
            "page not found" reads as the whole feature having been removed. */}
        <Route path="admin/workflows" element={<Navigate to="/admin/approval-flow" replace />} />
        <Route path="admin/approvals-config" element={<Navigate to="/admin/approval-flow" replace />} />
        <Route path="admin/approvals-config/custom" element={<Navigate to="/admin/approval-flow" replace />} />
        <Route path="admin/approval-flow" element={<ApprovalFlowPage />} />
        <Route path="admin/approval-flow/:docType" element={<ChainEditorPage />} />
        <Route path="admin/policies" element={<PoliciesPage />} />
        <Route path="admin/audit" element={<AuditPage />} />
        <Route path="admin/app-logs" element={<AppLogsPage />} />
        <Route path="admin/numbering" element={<NumberingPage />} />
        <Route path="admin/notifications" element={<NotificationsPage />} />
        <Route path="admin/fallback-log" element={<FallbackLogPage />} />
        {/* /admin/integrations, matching the `admin_integrations` page row — the route
            follows the menu, not the other way round. */}
        <Route path="admin/integrations" element={<ApiClientsPage />} />
        {/* Child screen, reached by opening a row — no menu entry of its own. */}
        {/* App Integrations: what THIS app connects OUT to — HCM, mail, the database
            — beside the console that lists who calls IN. Its own path rather than a
            child of /admin/integrations, which ends in a catch-all `:code` that would
            read any literal segment as a client code. */}
        <Route path="admin/app-links" element={<PlatformLinksPage />} />
        {/* Two segments, so it never collides with the `:code` catch-all below —
            one webhook's own screen, reached by opening its row. */}
        {/* One event of the Activity log, on its own address — two segments so it
            never collides with the `:code` catch-all below. It is a page and not a
            dialog because an event is something people forward to the partner who
            sent it, and a box over the list has no address to send anyone. */}
        <Route path="admin/integrations/activity/:id" element={<ActivityEventPage />} />
        <Route path="admin/integrations/webhooks/:source" element={<WebhookDetailPage />} />
        <Route path="admin/integrations/:code" element={<ApiClientDetailPage />} />
        <Route path="admin/org-masters" element={<OrgMastersPage />} />
        <Route path="masters" element={<MastersPage />} />
        {/* /reports lands on the first ledger so the rail entry always has a screen. */}
        <Route path="reports" element={<Navigate to="/reports/indents" replace />} />
        {/* Above `:ledger`, which is a catch-all string param — a literal
            segment after it would be read as a ledger name. */}
        <Route path="reports/traceability" element={<TraceabilityPage />} />
        {/* Live Tracking follows ONE indent as it moves — the Journey and the
            downstream trail, polled. Beside the Document Trail rather than
            replacing it: the Trail finds any document by number, this one
            watches an indent. Both are literal segments and must stay above
            `:ledger`, which reads any segment after it as a ledger name. */}
        <Route path="reports/live-tracking" element={<LiveTrackingPage />} />
        <Route path="reports/attachments" element={<AttachmentsReportPage />} />
        <Route path="reports/:ledger" element={<ReportLedgerPage />} />
        {/* An address with no screen says so. It used to render Home, which made a
            typo look like the app had simply ignored the click. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

function Shell() {
  const navigate = useNavigate();
  return (
    <HeroUIProvider navigate={navigate} useHref={useHref}>
      {/* Outside AuthProvider so a toast can fire during login too. */}
      <ToastProvider>
        {/* Outside AuthProvider for the same reason as ToastProvider: the 401 and
            network dialogs have to work on the login screen too. */}
        <AlertProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </AlertProvider>
      </ToastProvider>
    </HeroUIProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
