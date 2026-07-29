import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useHref } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { AuthProvider, useAuth } from "@/shared/auth/AuthContext";
import { AppLayout } from "@/shared/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { IndentListPage } from "@/modules/indents/pages/ListPage";
import { IndentFormPage } from "@/modules/indents/pages/FormPage";
import { IndentDetailPage } from "@/modules/indents/pages/DetailPage";
import { IndentDashboardPage } from "@/modules/indents/pages/DashboardPage";
import { IndentBoardPage } from "@/modules/indents/pages/BoardPage";
import { IndentAcknowledgmentsPage } from "@/modules/indents/pages/AcknowledgmentsPage";
import { IndentReportsPage } from "@/modules/indents/pages/ReportsPage";
import { IndentNotificationsPage } from "@/modules/indents/pages/NotificationsPage";
import { IndentApprovalsPage } from "@/modules/indents/pages/ApprovalsPage";
import { MyDecisionsPage } from "@/modules/indents/pages/MyDecisionsPage";
import { TeamQueuePage } from "@/modules/indents/pages/TeamQueuePage";
import { DelegationsPage } from "@/modules/indents/pages/DelegationsPage";
import { IndentJourneyPage } from "@/modules/indents/pages/JourneyPage";
import { POListPage } from "@/modules/procurement/pages/POListPage";
// The warehouse module owns goods receipt, stock and issues now; it routes its own
// sub-pages, so these paths hand the whole subtree to it.
import { WarehouseModule } from "@/modules/warehouse";
import { AdminPage } from "@/modules/admin/pages/AdminPage";
import { UsersPage } from "@/modules/rbac/pages/UsersPage";
import { GroupsPage } from "@/modules/rbac/pages/GroupsPage";
import { RulesPage } from "@/modules/admin/pages/RulesPage";
import { WorkflowsPage } from "@/modules/admin/pages/WorkflowsPage";
import { ApprovalConfigPage } from "@/modules/admin/pages/ApprovalConfigPage";
import { PoliciesPage } from "@/modules/admin/pages/PoliciesPage";
import { AuditPage } from "@/modules/admin/pages/AuditPage";
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
import { CycleCountsView } from "@/modules/inventory/components/CycleCountsView";
import { ReservationsView } from "@/modules/inventory/components/ReservationsView";
import { StockValuationView } from "@/modules/inventory/components/StockValuationView";
import { FulfillmentQueuePage } from "@/modules/inventory/pages/FulfillmentQueuePage";
import { MaterialRequestsPage } from "@/modules/inventory/pages/MaterialRequestsPage";
import { AllocationPage } from "@/modules/inventory/pages/AllocationPage";
import { AllocationApprovalsPage } from "@/modules/inventory/pages/AllocationApprovalsPage";
import { MaterialRequestDetailPage } from "@/modules/inventory/pages/MaterialRequestDetailPage";
import { FallbackLogPage } from "@/modules/admin/pages/FallbackLogPage";
import { ItemDemandPage } from "@/modules/inventory/pages/ItemDemandPage";
import { LabelsPage } from "@/modules/inventory/pages/LabelsPage";
import { SettingsPage } from "@/modules/settings/pages/SettingsPage";

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
        <Route index element={<DashboardPage />} />
        <Route path="indents" element={<IndentListPage />} />
        <Route path="indents/dashboard" element={<IndentDashboardPage />} />
        <Route path="indents/board" element={<IndentBoardPage />} />
        <Route path="indents/acknowledgments" element={<IndentAcknowledgmentsPage />} />
        <Route path="indents/reports" element={<IndentReportsPage />} />
        <Route path="indents/notifications" element={<IndentNotificationsPage />} />
        <Route path="indents/new" element={<IndentFormPage />} />
        <Route path="indents/:id/journey" element={<IndentJourneyPage />} />
        <Route path="indents/:id" element={<IndentDetailPage />} />
        <Route path="approvals" element={<IndentApprovalsPage />} />
        <Route path="approvals/decisions" element={<MyDecisionsPage />} />
        <Route path="approvals/team-queue" element={<TeamQueuePage />} />
        <Route path="approvals/delegations" element={<DelegationsPage />} />
        <Route path="pos" element={<POListPage />} />
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
        <Route path="inventory/cycle-counts" element={<CycleCountsView />} />
        <Route path="inventory/reservations" element={<ReservationsView />} />
        <Route path="inventory/valuation" element={<StockValuationView />} />
        <Route path="inventory/fulfillment" element={<FulfillmentQueuePage />} />
        <Route path="inventory/material-requests" element={<MaterialRequestsPage />} />
        <Route path="inventory/allocate/:indentId" element={<AllocationPage />} />
        <Route path="inventory/allocation-approvals" element={<AllocationApprovalsPage />} />
        <Route path="inventory/demand" element={<ItemDemandPage />} />
        <Route path="inventory/labels" element={<LabelsPage />} />
        <Route path="inventory/material-requests/:id" element={<MaterialRequestDetailPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/settings" element={<SettingsPage />} />
        <Route path="rbac/access" element={<UsersPage />} />
        <Route path="rbac/groups" element={<GroupsPage />} />
        <Route path="admin/rules" element={<RulesPage />} />
        <Route path="admin/workflows" element={<WorkflowsPage />} />
        <Route path="admin/approvals-config" element={<ApprovalConfigPage />} />
        <Route path="admin/policies" element={<PoliciesPage />} />
        <Route path="admin/audit" element={<AuditPage />} />
        <Route path="admin/numbering" element={<NumberingPage />} />
        <Route path="admin/notifications" element={<NotificationsPage />} />
        <Route path="admin/fallback-log" element={<FallbackLogPage />} />
        <Route path="masters" element={<MastersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Shell() {
  const navigate = useNavigate();
  return (
    <HeroUIProvider navigate={navigate} useHref={useHref}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
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
