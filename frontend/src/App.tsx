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
import { IndentAcknowledgmentsPage } from "@/modules/indents/pages/AcknowledgmentsPage";
import DeliveriesPage from "@/modules/indents/pages/DeliveriesPage";
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
import { MaterialRequestsPage } from "@/modules/inventory/pages/MaterialRequestsPage";
import { AllocationPage } from "@/modules/inventory/pages/AllocationPage";
import { AllocationApprovalsPage } from "@/modules/inventory/pages/AllocationApprovalsPage";
import { AllocationApprovalDetailPage } from "@/modules/inventory/pages/AllocationApprovalDetailPage";
import { StockingPointsPage } from "@/modules/inventory/pages/StockingPointsPage";
import { MaterialRequestDetailPage } from "@/modules/inventory/pages/MaterialRequestDetailPage";
import { FallbackLogPage } from "@/modules/admin/pages/FallbackLogPage";
import { ItemDemandPage } from "@/modules/inventory/pages/ItemDemandPage";
import { LabelsPage } from "@/modules/inventory/pages/LabelsPage";
import { SettingsPage } from "@/modules/settings/pages/SettingsPage";
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
      <Route element={me ? <AppLayout /> : <Navigate to="/login" replace />}>
        <Route index element={<HomePage />} />
        {/* Not in PAGE_TREE on purpose: everyone has a profile, so gating it behind an
            rbac_pages row would only mean a permission every role must be granted. */}
        <Route path="profile" element={<ProfilePage />} />
        <Route path="indents" element={<IndentListPage />} />
        <Route path="indents/dashboard" element={<IndentDashboardPage />} />
        <Route path="indents/board" element={<IndentBoardPage />} />
        <Route path="indents/acknowledgments" element={<IndentAcknowledgmentsPage />} />
        <Route path="indents/deliveries" element={<DeliveriesPage />} />
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
        <Route path="grn/*" element={<WarehouseModule />} />
        <Route path="stock/*" element={<WarehouseModule />} />
        <Route path="issues/*" element={<WarehouseModule />} />
        <Route path="warehouse/*" element={<WarehouseModule />} />
        <Route path="inventory" element={<InventoryOverviewPage />} />
        <Route path="inventory/stock-balance" element={<StockBalanceView />} />
        <Route path="inventory/ledger" element={<StockLedgerView />} />
        <Route path="inventory/replenishment" element={<StockReplenishmentView />} />
        <Route path="inventory/transfers" element={<StockTransferView />} />
        <Route path="inventory/adjustments" element={<StockAdjustmentsView />} />
        <Route path="inventory/valuation" element={<StockValuationView />} />
        <Route path="inventory/fulfillment" element={<FulfillmentQueuePage />} />
        <Route path="inventory/material-requests" element={<MaterialRequestsPage />} />
        <Route path="inventory/allocate/:indentId" element={<AllocationPage />} />
        {/* Where the MDP/LIP chain is declared — everything downstream reads it. */}
        <Route path="inventory/stocking-points" element={<StockingPointsPage />} />
        <Route path="inventory/allocation-approvals" element={<AllocationApprovalsPage />} />
        {/* Child screen, not a menu entry: the list navigates here to review one
            allocation. Without this route that row click is a dead end. */}
        <Route path="inventory/allocation-approvals/:id" element={<AllocationApprovalDetailPage />} />
        <Route path="inventory/demand" element={<ItemDemandPage />} />
        <Route path="inventory/labels" element={<LabelsPage />} />
        <Route path="inventory/material-requests/:id" element={<MaterialRequestDetailPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/settings" element={<SettingsPage />} />
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
        <Route path="admin/policies" element={<PoliciesPage />} />
        <Route path="admin/audit" element={<AuditPage />} />
        <Route path="admin/app-logs" element={<AppLogsPage />} />
        <Route path="admin/numbering" element={<NumberingPage />} />
        <Route path="admin/notifications" element={<NotificationsPage />} />
        <Route path="admin/fallback-log" element={<FallbackLogPage />} />
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
