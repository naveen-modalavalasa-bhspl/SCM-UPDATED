import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useHref } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { AuthProvider, useAuth } from "@/shared/auth/AuthContext";
import { AppLayout } from "@/shared/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { HomePage } from "@/modules/home/pages/HomePage";
import { IndentListPage } from "@/modules/indents/pages/ListPage";
import { IndentFormPage } from "@/modules/indents/pages/FormPage";
import { IndentDetailPage } from "@/modules/indents/pages/DetailPage";
import { IndentDashboardPage } from "@/modules/indents/pages/DashboardPage";
import { IndentBoardPage } from "@/modules/indents/pages/BoardPage";
import AcknowledgementsPage from "@/modules/indents/pages/AcknowledgementsPage";
import { IndentReportsPage } from "@/modules/indents/pages/ReportsPage";
import { IndentNotificationsPage } from "@/modules/indents/pages/NotificationsPage";
// Approvals is its own module now — the inbox, decisions, team queue, reports and the
// indent review screen all live there, not inside indents.
import {
  ApprovalCorrectionPage, ApprovalsPage, ConsolidationDetailPage, ConsolidationIssuePage,
  ConsolidationItemPage, ConsolidationPage, MyDecisionsPage, TeamQueuePage,
} from "@/modules/approvals";
import { IndentJourneyPage } from "@/modules/indents/pages/JourneyPage";
import { POListPage } from "@/modules/procurement/pages/POListPage";
import { PODetailPage } from "@/modules/procurement/pages/PODetailPage";
// The warehouse module owns goods receipt, stock and issues now; it routes its own
// sub-pages, so these paths hand the whole subtree to it.
import { WarehouseModule } from "@/modules/warehouse";
import { AdminPage } from "@/modules/admin/pages/AdminPage";
import { UsersPage } from "@/modules/rbac/pages/UsersPage";
import { GroupsPage } from "@/modules/rbac/pages/GroupsPage";
import { JobProfilesPage } from "@/modules/rbac/pages/JobProfilesPage";
import { RulesPage } from "@/modules/admin/pages/RulesPage";
import { WorkflowsPage } from "@/modules/admin/pages/WorkflowsPage";
import { ApprovalConfigPage } from "@/modules/admin/pages/ApprovalConfigPage";
import { CustomLadderPage } from "@/modules/admin/pages/CustomLadderPage";
import { ApprovalFlowPage } from "@/modules/admin/pages/ApprovalFlowPage";
import { ChainEditorPage } from "@/modules/admin/pages/ChainEditorPage";
import { PoliciesPage } from "@/modules/admin/pages/PoliciesPage";
import { AuditPage } from "@/modules/admin/pages/AuditPage";
import { AppLogsPage } from "@/modules/admin/pages/AppLogsPage";
import { NumberingPage } from "@/modules/admin/pages/NumberingPage";
import { NotificationsPage } from "@/modules/admin/pages/NotificationsPage";
import { MastersPage } from "@/modules/masters/pages/MastersPage";
import { InventoryOverviewPage } from "@/modules/inventory/pages/OverviewPage";
// Each inventory screen is its own route so it can appear in the left rail.
import { StockBalanceView } from "@/modules/inventory/components/StockBalanceView";
import { StockLedgerView } from "@/modules/inventory/components/StockLedgerView";
import { StockReplenishmentView } from "@/modules/inventory/components/StockReplenishmentView";
import { StockTransferView } from "@/modules/inventory/components/StockTransferView";
import { StockAdjustmentsView } from "@/modules/inventory/components/StockAdjustmentsView";
import { StockValuationView } from "@/modules/inventory/components/StockValuationView";
import { FulfillmentQueuePage } from "@/modules/inventory/pages/FulfillmentQueuePage";
import { FulfilmentBatchPage } from "@/modules/inventory/pages/FulfilmentBatchPage";
import { MaterialRequestsPage } from "@/modules/inventory/pages/MaterialRequestsPage";
import { AllocationPage } from "@/modules/inventory/pages/AllocationPage";
import { AllocationApprovalsPage } from "@/modules/inventory/pages/AllocationApprovalsPage";
import { AllocationApprovalDetailPage } from "@/modules/inventory/pages/AllocationApprovalDetailPage";
import { AllocationCycleApprovalPage } from "@/modules/inventory/pages/AllocationCycleApprovalPage";
import { StockingPointsPage } from "@/modules/inventory/pages/StockingPointsPage";
import { MaterialRequestDetailPage } from "@/modules/inventory/pages/MaterialRequestDetailPage";
import { FallbackLogPage } from "@/modules/admin/pages/FallbackLogPage";
import { ItemDemandPage } from "@/modules/inventory/pages/ItemDemandPage";
import { LabelsPage } from "@/modules/inventory/pages/LabelsPage";
import {
  ReturnsOverviewPage, ReturnsListPage, ReturnFormPage, ReturnDetailPage,
  ReceivingConfigPage, DecisionQueuePage, PurchaseReturnsPage,
} from "@/modules/returns";
// The API console — build an API from the screen over any table in the database.
import { ApiClientsPage, ApiClientDetailPage } from "@/modules/integrations";
// `PurchaseConsolidation*`, not `Consolidation*`: the approvals module already owns
// that name for INDENT consolidation, which is a different document entirely.
import { PurchaseConsolidationListPage } from "@/modules/procurement/pages/PurchaseConsolidationListPage";
import { PurchaseConsolidationFormPage } from "@/modules/procurement/pages/PurchaseConsolidationFormPage";
import { PurchaseConsolidationDetailPage } from "@/modules/procurement/pages/PurchaseConsolidationDetailPage";
// Logistics: consignment -> dispatch -> transport -> acknowledgement, plus the
// transport provider's own portal. Consignments and Dispatch are the warehouse's own
// screens, re-exported by the logistics module and mounted under /logistics/* — the
// same documents and the same flow, reached from the module that works them.
import {
  ConsignmentsScreen, ConsignmentFormScreen, DispatchPage, DispatchConfirmPage,
  TransportRequestsPage, TransportFormPage, TransportDetailPage, ProviderSelectionPage,
  ShipmentTrackingPage, AcknowledgementsPage as LogisticsAcknowledgementsPage,
  LogisticsExceptionsPage, LogisticsVendorsPage,
  CarrierLayout, CarrierLoginPage, CarrierJobsPage, CarrierJobPage,
} from "@/modules/logistics";
import { RequisitionListPage } from "@/modules/procurement/pages/RequisitionListPage";
import { RequisitionFormPage } from "@/modules/procurement/pages/RequisitionFormPage";
import { RequisitionDetailPage } from "@/modules/procurement/pages/RequisitionDetailPage";
import { RFQListPage } from "@/modules/procurement/pages/RFQListPage";
import { RFQFormPage } from "@/modules/procurement/pages/RFQFormPage";
import { RFQDetailPage } from "@/modules/procurement/pages/RFQDetailPage";
import { QuotationListPage } from "@/modules/procurement/pages/QuotationListPage";
import { SupplierAccountsPage } from "@/modules/procurement/pages/SupplierAccountsPage";
// The supplier portal — a second audience, on its own shell and its own token.
import { SupplierLayout } from "@/modules/supplier/SupplierLayout";
import { SupplierLoginPage } from "@/modules/supplier/pages/SupplierLoginPage";
import { SupplierPasswordPage } from "@/modules/supplier/pages/SupplierPasswordPage";
import { SupplierRFQListPage } from "@/modules/supplier/pages/SupplierRFQListPage";
import { SupplierRFQDetailPage } from "@/modules/supplier/pages/SupplierRFQDetailPage";
import { SupplierPOListPage } from "@/modules/supplier/pages/SupplierPOListPage";
import { SupplierPODetailPage } from "@/modules/supplier/pages/SupplierPODetailPage";
import { SupplierProfilePage } from "@/modules/supplier/pages/SupplierProfilePage";
import { SettingsPage } from "@/modules/settings/pages/SettingsPage";
import { CodeFormatsPage } from "@/modules/settings/pages/CodeFormatsPage";
// One screen serves all four report ledgers; the ledger key is a route param.
import { ReportLedgerPage } from "@/modules/reports";
// Mounts the alert/confirm dialog host and pulls the server's copy catalog once.
import { AlertProvider } from "@/modules/alerts";
import { ToastProvider } from "@/shared/components";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center font-sans text-lg text-ink">
      {children}
    </div>
  );
}

function AppRoutes() {
  const { me, loading } = useAuth();
  if (loading) return <FullScreen>Loading…</FullScreen>;

  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />

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
        {/* The same account screen the supplier portal shows, mounted here too. One
            implementation — a carrier IS a vendor and the details are identical — but
            reached inside the carrier shell, because linking the tab at
            /supplier/profile dropped the driver into the supplier portal's header and
            tabs with no route back to their shipments. */}
        <Route path="profile" element={<SupplierProfilePage />} />
      </Route>

      <Route element={me ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<HomePage />} />
        {/* Not in PAGE_TREE on purpose: everyone has a profile, so gating it behind an
            rbac_pages row would only mean a permission every role must be granted. */}
        <Route path="profile" element={<ProfilePage />} />
        <Route path="indents" element={<IndentListPage />} />
        <Route path="indents/dashboard" element={<IndentDashboardPage />} />
        <Route path="indents/board" element={<IndentBoardPage />} />
        <Route path="indents/acknowledgements" element={<AcknowledgementsPage />} />
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
        <Route path="indents/:id/journey" element={<IndentJourneyPage />} />
        {/* A returned indent belongs to its requester, who is not an approver and
            cannot open /approvals at all — the ?correction= form there redirected
            them to Home, so the notification the return sends was a dead end. The
            same screen lives here, under the module they can actually reach. */}
        <Route path="indents/:id/correction" element={<ApprovalCorrectionPage />} />
        <Route path="indents/:id" element={<IndentDetailPage />} />
        {/* Reports and the indent review screen are reached from the inbox via
            ?view=reports / ?reviewIndent=, so they need no route of their own. */}
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/decisions" element={<MyDecisionsPage />} />
        <Route path="approvals/team-queue" element={<TeamQueuePage />} />
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
        <Route path="pos/:id" element={<PODetailPage />} />
        {/* The buying chain upstream of a PO: requisition -> RFQ -> quotation. */}
        <Route path="procurement/requisitions" element={<RequisitionListPage />} />
        <Route path="procurement/requisitions/new" element={<RequisitionFormPage />} />
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
        <Route path="logistics" element={<Navigate to="/logistics/consignments" replace />} />
        <Route path="logistics/consignments" element={<ConsignmentsScreen />} />
        <Route path="logistics/consignments/new" element={<ConsignmentFormScreen />} />
        <Route path="logistics/consignments/:id" element={<ConsignmentFormScreen />} />
        <Route path="logistics/dispatch" element={<DispatchPage />} />
        {/* The press itself: consignment, gate pass, mode, provider. Reached from the
         * queue and from a packed consignment — a logistics day never crosses into
         * the warehouse module to send something out. */}
        <Route path="logistics/dispatch/new" element={<DispatchConfirmPage />} />
        <Route path="logistics/transport" element={<TransportRequestsPage />} />
        <Route path="logistics/transport/new" element={<TransportFormPage />} />
        <Route path="logistics/transport/:id" element={<TransportDetailPage />} />
        <Route path="logistics/transport/:id/edit" element={<TransportFormPage />} />
        <Route path="logistics/providers" element={<ProviderSelectionPage />} />
        <Route path="logistics/tracking" element={<ShipmentTrackingPage />} />
        <Route path="logistics/acknowledgements" element={<LogisticsAcknowledgementsPage />} />
        <Route path="logistics/exceptions" element={<LogisticsExceptionsPage />} />
        <Route path="grn/*" element={<WarehouseModule />} />
        <Route path="stock/*" element={<WarehouseModule />} />
        <Route path="issues/*" element={<WarehouseModule />} />
        <Route path="warehouse/*" element={<WarehouseModule />} />
        <Route path="returns" element={<ReturnsListPage />} />
        <Route path="returns/dashboard" element={<ReturnsOverviewPage />} />
        <Route path="returns/approvals" element={<ReturnsListPage />} />
        <Route path="returns/mine" element={<ReturnsListPage />} />
        {/* The two desks. One component, the queue read off the path. */}
        <Route path="returns/decisions" element={<DecisionQueuePage />} />
        <Route path="returns/sign-off" element={<DecisionQueuePage />} />
        {/* Read only — pro_returns is the warehouse module's table. */}
        <Route path="returns/purchase" element={<PurchaseReturnsPage />} />
        <Route path="returns/new" element={<ReturnFormPage />} />
        <Route path="returns/settings/receiving" element={<ReceivingConfigPage />} />
        <Route path="returns/:id" element={<ReturnDetailPage />} />
        <Route path="returns/:id/edit" element={<ReturnFormPage />} />
        <Route path="inventory" element={<InventoryOverviewPage />} />
        <Route path="inventory/stock-balance" element={<StockBalanceView />} />
        <Route path="inventory/ledger" element={<StockLedgerView />} />
        <Route path="inventory/replenishment" element={<StockReplenishmentView />} />
        <Route path="inventory/transfers" element={<StockTransferView />} />
        <Route path="inventory/adjustments" element={<StockAdjustmentsView />} />
        <Route path="inventory/valuation" element={<StockValuationView />} />
        <Route path="inventory/fulfillment" element={<FulfillmentQueuePage />} />
        {/* One monthly cycle, opened from the row above. A detail screen, not a page
            of its own: it carries no rbac_pages row, exactly like
            inventory/allocate/:indentId, so it inherits the Fulfilment Queue's
            permission and every action inside it is still checked server-side.
            The queue has always linked here; the route was simply never registered,
            so every monthly cycle landed on "No screen at this address". */}
        <Route path="inventory/fulfillment/:cycle" element={<FulfilmentBatchPage />} />
        <Route path="inventory/material-requests" element={<MaterialRequestsPage />} />
        <Route path="inventory/allocate/:indentId" element={<AllocationPage />} />
        {/* Where the MDP/LIP chain is declared — everything downstream reads it. */}
        <Route path="inventory/stocking-points" element={<StockingPointsPage />} />
        <Route path="inventory/allocation-approvals" element={<AllocationApprovalsPage />} />
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
        <Route path="admin/workflows" element={<WorkflowsPage />} />
        <Route path="admin/approvals-config" element={<ApprovalConfigPage />} />
        {/* Reached from the Approvals Config screen, not from the menu — adding it to
            rbac_pages would mean reseeding, and seed prunes the live tree. */}
        <Route path="admin/approvals-config/custom" element={<CustomLadderPage />} />
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
        <Route path="admin/integrations/:code" element={<ApiClientDetailPage />} />
        <Route path="masters" element={<MastersPage />} />
        {/* /reports lands on the first ledger so the rail entry always has a screen. */}
        <Route path="reports" element={<Navigate to="/reports/indents" replace />} />
        <Route path="reports/:ledger" element={<ReportLedgerPage />} />
        {/* An address with no screen says so. It used to render Home, which made a
            typo look like the app had simply ignored the click. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
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
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
