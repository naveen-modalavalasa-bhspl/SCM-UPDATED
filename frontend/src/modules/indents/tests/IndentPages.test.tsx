import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import {
  getRaisedDateRange,
  getRequiredByDateRange,
  IndentFilterBar,
} from "../components/IndentFilterBar";
import { IndentsNav } from "../components/IndentsNav";
import { buildStatusBreakdownData } from "../components/StatusBreakdownChart";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { IndentDashboardPage } from "../pages/DashboardPage";
import { IndentListPage } from "../pages/ListPage";
import { IndentBoardPage } from "../pages/BoardPage";
import { IndentReportsPage } from "../pages/ReportsPage";
import { IndentNotificationsPage } from "../pages/NotificationsPage";
import { IndentDetailPage } from "../pages/DetailPage";
import { AlertHost } from "@/modules/alerts/components/AlertHost";
import { ToastProvider } from "@/shared/components";
import { IndentJourneyPage } from "../pages/JourneyPage";
import { groupJourneyHistory } from "../pages/JourneyPage";
import { indentApi, indentKeys } from "../api";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";
import { formatIndentDateTime, parseIndentTimestamp } from "../dateTime";
import type { ActivityRow, Indent, IndentJourney, IndentNotification, IndentStats } from "../types";

const EXPECTED_REQUEST_STATUS_FILTERS = [
  ["Pending approvals", "PENDING_APPROVAL"],
  ["Allocated", "ALLOCATED"],
  ["Draft", "DRAFT"],
  ["Rejected", "REJECTED"],
  ["Awaiting allocation", "AWAITING_ALLOCATION"],
  ["Partially fulfilled", "PARTIALLY_FULFILLED"],
  ["Fulfilled", "CLOSED"],
] as const;

// The journey read newest-first, which is the order the filter offers them in. The
// filter carries EVERY event type the ledger's EVENT column can show — rejected,
// returned, auto-routed, procurement and the bookmarks were missing from it, so a
// desk could read those rows but never narrow to them.
// Mirrors `INDENT_ACTIVITY_EVENT_FILTER_OPTIONS` exactly.
const EXPECTED_ACTIVITY_EVENT_FILTERS = [
  ["Receipt acknowledged", "RECEIPT_ACKNOWLEDGED"],
  ["Material dispatched", "MATERIAL_DISPATCHED"],
  ["Material issued", "MATERIAL_ISSUED"],
  ["Procurement request created", "PROCUREMENT_REQUEST_CREATED"],
  ["Stock allocated", "STOCK_ALLOCATED"],
  ["Approval completed", "APPROVAL_COMPLETED"],
  ["Request returned", "REQUEST_RETURNED"],
  ["Request rejected", "REQUEST_REJECTED"],
  ["Approval routed automatically", "APPROVAL_ROUTED_AUTOMATICALLY"],
  ["Request submitted", "REQUEST_SUBMITTED"],
  ["Request created", "REQUEST_CREATED"],
  ["Bookmark added", "BOOKMARK_ADDED"],
  ["Bookmark removed", "BOOKMARK_REMOVED"],
] as const;

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    const contentRect = {
      x: 0,
      y: 0,
      width: 320,
      height: 320,
      top: 0,
      right: 320,
      bottom: 320,
      left: 0,
      toJSON: () => ({}),
    } as DOMRectReadOnly;
    this.callback([{ target, contentRect } as ResizeObserverEntry], this);
  }

  unobserve() {}

  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const mockAccount = vi.hoisted(() => ({
  employeeId: 1 as number | null,
  activePositionId: 10 as number | null,
  canDeleteIndent: false,
}));

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    can: (code: string) => code !== "indent.delete" || mockAccount.canDeleteIndent,
    me: {
      employee: { id: mockAccount.employeeId, name: "Test User" },
      active_position: mockAccount.activePositionId
        ? { id: mockAccount.activePositionId, name: "OE-TEST", is_primary: true }
        : null,
      permissions: ["indent.create"],
    },
  }),
}));

vi.mock("../api", async () => {
  const React = await import("react");
  const ReactQuery = await import("@tanstack/react-query");
  const root = "indents-module";
  const scoped = (scope: { employeeId: number | null; activePositionId: number | null }) =>
    [root, scope.employeeId, scope.activePositionId] as const;
  const mockedKeys = {
    all: scoped,
    list: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "list", filters] as const,
    board: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "board", filters] as const,
    recent: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "recent", filters] as const,
    stats: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "stats", filters] as const,
    activity: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "activity", filters] as const,
    notifications: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown = {}) => [...scoped(scope), "notifications", filters] as const,
    detail: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) => [...scoped(scope), "detail", id] as const,
    journey: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) => [...scoped(scope), "journey", 4, id] as const,
    shipments: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) => [...scoped(scope), "shipments", id] as const,
    items: (scope: { employeeId: number | null; activePositionId: number | null }, context = "default") => [...scoped(scope), "items", context] as const,
    regions: (scope: { employeeId: number | null; activePositionId: number | null }) => [...scoped(scope), "regions"] as const,
  };
  const isIndentModuleQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === root;
  return {
    INDENT_QUERY_STALE_TIME: 45_000,
    INDENT_QUERY_GC_TIME: 5 * 60_000,
    INDENT_QUERY_ROOT: root,
    normalizeIndentQueryParams: (params: Record<string, unknown>) => Object.fromEntries(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value].filter(Boolean).sort() : value,
        ])
        .filter(([, value]) => !Array.isArray(value) || value.length > 0),
    ),
    indentKeys: mockedKeys,
    isIndentModuleQuery,
    isIndentUnavailableError: (error: unknown) => {
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      return status === 403 || status === 404;
    },
    useIndentAccountScope: () => ({
      employeeId: mockAccount.employeeId,
      activePositionId: mockAccount.activePositionId,
    }),
    useIndentAccountCacheIsolation: (scope: { employeeId: number | null; activePositionId: number | null }) => {
      const qc = ReactQuery.useQueryClient();
      const previous = React.useRef<string | null>(null);
      const current = `${scope.employeeId ?? "none"}:${scope.activePositionId ?? "none"}`;
      React.useEffect(() => {
        if (previous.current !== null && previous.current !== current) {
          qc.removeQueries({ predicate: isIndentModuleQuery });
        }
        previous.current = current;
      }, [current, qc]);
    },
    indentApi: {
    stats: vi.fn(() => Promise.resolve({
      total: 0,
      draft: 0,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 0,
      total_items: 0,
      total_qty: 0,
      approval_rate: 0,
      by_status: {},
      by_region: [],
    })),
    list: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    activity: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    regions: vi.fn(() => Promise.resolve([
      { id: 654, name: "104-MMU-AP-Hanumanthunipadu" },
      { id: 937, name: "104-MMU-AP-Markapur" },
    ])),
    notifications: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    get: vi.fn(),
    journey: vi.fn(),
    submit: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    delete: vi.fn(),
    bookmark: vi.fn(),
    unbookmark: vi.fn(),
    },
  };
});

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(ui: ReactElement, route = "/indents", client = createTestQueryClient()) {
  const result = render(
    // ToastProvider because the app mounts one at its root and the detail screen
    // announces a submit, a delete and a correction resubmit through it.
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/indents/:id/journey" element={ui} />
            <Route path="/indents/:id" element={ui} />
            <Route path="/indents/*" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

function FilterHarness() {
  const { page, search, startDate, endDate, setPage } = useIndentFilters();
  return (
    // The bar loads its Region/Location options through react-query, the same as
    // every screen that hosts it, so the harness has to supply a client too.
    <QueryClientProvider client={createTestQueryClient()}>
      <button type="button" onClick={() => setPage(3)}>Set page</button>
      <IndentFilterBar />
      <output aria-label="filter state">{page}:{search}:{startDate}:{endDate}</output>
    </QueryClientProvider>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function BrowserBackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Browser back test</button>;
}

function renderAllRequestsFlow(
  route: string,
  client = createTestQueryClient(),
) {
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route path="/indents" element={<IndentListPage />} />
          <Route path="/indents/:id" element={<><IndentDetailPage /><BrowserBackButton /></>} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

function renderActivityLedgerFlow(
  route: string,
  client = createTestQueryClient(),
) {
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route path="/indents/reports" element={<IndentReportsPage />} />
          <Route path="/indents/:id" element={<><IndentDetailPage /><BrowserBackButton /></>} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

function renderNotificationsFlow(
  route: string,
  client = createTestQueryClient(),
) {
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route path="/indents/notifications" element={<IndentNotificationsPage />} />
          <Route path="/indents/:id" element={<><IndentDetailPage /><BrowserBackButton /></>} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function detailIndent(overrides: Partial<Indent> = {}): Indent {
  return {
    id: 42,
    indent_no: "IND/2026/0042",
    requested_by_id: 1,
    status: "PENDING_APPROVAL",
    priority: "NORMAL",
    total_items: 1,
    total_qty: 5,
    current_approver_name: "OE",
    is_bookmarked: "NO",
    can_submit: false,
    can_approve: false,
    can_reject: false,
    created_at: "2026-07-27T10:30:00Z",
    items: [{
      id: 1,
      item_id: 10,
      item_code: "IT-001",
      item_name: "Bolt",
      uom_code: "NOS",
      quantity: 5,
      ordered_quantity: 0,
      received_quantity: 0,
    }],
    ...overrides,
  };
}

function journeyData(overrides: Partial<IndentJourney> = {}): IndentJourney {
  return {
    indent_id: 42,
    indent_no: "IND/2026/0042",
    status: "AWAITING_ALLOCATION",
    requested_by_name: "A Anil Kumar",
    requested_by_position: "DRIVER-AP-104-MMU-CHILMATHUR",
    created_at: "2026-07-27T09:30:00Z",
    current_stage: "Ready for Allocation",
    current_stage_message: "Ready for Allocation",
    final_any_one_outcome: "Approved by SPH",
    phases: [
      { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
      { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
      { sequence: 3, title: "Approvals", status: "APPROVED", stage_type: "phase" },
      { sequence: 4, title: "Allocation", status: "PENDING", stage_type: "phase", is_current: true },
      { sequence: 5, title: "Warehouse", status: "PENDING", stage_type: "phase" },
      { sequence: 6, title: "Delivery", status: "PENDING", stage_type: "phase" },
      { sequence: 7, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
    ],
    stages: [
      {
        sequence: 1,
        title: "Draft created",
        status: "APPROVED",
        approver_name: "A Anil Kumar",
        position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
        timestamp: "2026-07-27T09:30:00Z",
        stage_type: "draft",
      },
      {
        sequence: 2,
        title: "Request submitted",
        status: "SUBMITTED",
        approver_name: "A Anil Kumar",
        position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
        timestamp: "2026-07-27T09:30:00Z",
        stage_type: "submission",
      },
      {
        sequence: 3,
        title: "OE Review",
        status: "APPROVED",
        approver_name: "C Ramakrishna",
        position_name: "OE-AP-104-MMU-Hindupur",
        timestamp: "2026-07-27T10:00:00Z",
        comments: "Approved",
        duration_seconds: 1800,
        stage_type: "approval",
      },
      {
        sequence: 4,
        title: "DM Review",
        status: "APPROVED",
        approver_name: "A Raveendra Prasad",
        position_name: "District Manager",
        timestamp: "2026-07-27T10:20:00Z",
        stage_type: "approval",
      },
      {
        sequence: 5,
        title: "Final Approval - SPH or COO",
        status: "APPROVED",
        approver_name: "SPH",
        position_name: "SPH-AP-104-MMU",
        timestamp: "2026-07-27T10:42:00Z",
        stage_type: "final",
      },
      {
        sequence: 6,
        title: "COO Authority",
        status: "NOT_REQUIRED",
        approver_name: "COO",
        position_name: "COO",
        timestamp: "2026-07-27T10:42:00Z",
        comments: "Final approval completed by another authority",
        stage_type: "final_any_one_peer",
      },
      {
        sequence: 7,
        title: "Ready for Allocation",
        status: "PENDING",
        timestamp: "2026-07-27T10:42:00Z",
        stage_type: "allocation",
      },
    ],
    history: [
      {
        id: "workflow:2",
        event_type: "APPROVED",
        title: "OE approval completed",
        description: "Approved by C Ramakrishna",
        actor_name: "C Ramakrishna",
        position_name: "OE-AP-104-MMU-Hindupur",
        timestamp: "2026-07-27T10:42:00Z",
        comments: "Approved",
      },
      {
        id: "workflow:1",
        event_type: "SUBMITTED",
        title: "Request submitted",
        actor_name: "A Anil Kumar",
        position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
        timestamp: "2026-07-27T09:30:00Z",
      },
    ],
    missing_sources: [],
    ...overrides,
  };
}

function overviewStats(byStatus: Record<string, number>): IndentStats {
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const draft = byStatus.DRAFT ?? 0;
  const awaitingApproval = (byStatus.SUBMITTED ?? 0) + (byStatus.PENDING_APPROVAL ?? 0);
  const rejected = byStatus.REJECTED ?? 0;
  const ordered = (byStatus.ORDERED ?? 0) + (byStatus.PARTIALLY_ORDERED ?? 0);

  return {
    total,
    draft,
    awaiting_approval: awaitingApproval,
    approved_active: Math.max(0, total - draft - awaitingApproval - rejected),
    rejected,
    ordered,
    this_month: total,
    total_items: total,
    total_qty: total * 2,
    approval_rate: total ? 80 : 0,
    by_status: byStatus,
  };
}

function listRow(id: number, indentNo: string, status = "DRAFT") {
  return {
    id,
    indent_no: indentNo,
    requested_by_name: "Status User",
    department_name: "Operations",
    status,
    priority: "NORMAL",
    total_items: 1,
    is_bookmarked: "NO",
    created_at: "2026-07-27T10:30:00Z",
  };
}

function activityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    event_id: "workflow:91",
    indent_id: 42,
    indent_no: "IND/2026/0042",
    event_type: "APPROVAL_COMPLETED",
    event_label: "Approval completed",
    result: "APPROVED",
    result_label: "Approved",
    occurred_at: "2026-07-27T10:42:00Z",
    actor_id: 9,
    actor_name: "Anita Approver",
    actor_position: "OE Review",
    item_id: null,
    item_code: null,
    item_name: null,
    quantity: null,
    requested_quantity: null,
    uom_code: null,
    department_name: "Operations",
    office_name: "Hindupur Office",
    remarks: null,
    source_type: "wf_actions",
    source_id: 91,
    ...overrides,
  };
}

function notificationRow(index: number, overrides: Partial<IndentNotification> = {}): IndentNotification {
  return {
    id: `indent:${index}:PENDING_APPROVAL`,
    indent_id: 42,
    indent_no: `IND/NOTIFICATION/${index}`,
    title: `Notification ${index}`,
    message: `Notification message ${index}`,
    status: "PENDING_APPROVAL",
    created_at: "2026-07-27T10:30:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockAccount.employeeId = 1;
  mockAccount.activePositionId = 10;
  mockAccount.canDeleteIndent = false;
  vi.mocked(indentApi.get).mockResolvedValue(detailIndent());
  vi.mocked(indentApi.journey).mockResolvedValue(journeyData());
  vi.mocked(indentApi.submit).mockResolvedValue(detailIndent({ status: "PENDING_APPROVAL", can_submit: false }));
  vi.mocked(indentApi.approve).mockResolvedValue(detailIndent({
    status: "AWAITING_ALLOCATION",
    can_approve: false,
    can_reject: false,
  }));
  vi.mocked(indentApi.reject).mockResolvedValue(detailIndent({
    status: "REJECTED",
    can_approve: false,
    can_reject: false,
  }));
  vi.mocked(indentApi.delete).mockResolvedValue(undefined);
  vi.mocked(indentApi.bookmark).mockResolvedValue(detailIndent({ is_bookmarked: "YES" }));
  vi.mocked(indentApi.unbookmark).mockResolvedValue(detailIndent({ is_bookmarked: "NO" }));
});

describe("indent UI shell", () => {
  it("keeps IndentsNav as the single navigation row", () => {
    renderWithProviders(
      <>
        <IndentsNav />
        <IndentModuleHeader title="All requests" showFilters={false} />
      </>,
      "/indents",
    );

    expect(screen.getAllByRole("navigation", { name: "Indent" })).toHaveLength(1);
    // Five tabs: Board is parked, while Acknowledgements remains in the navigation.
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("marks the current indent tab active", () => {
    renderWithProviders(<IndentsNav />, "/indents/reports");
    expect(screen.getByRole("link", { name: "Activity ledger" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps renamed navigation labels on existing routes", () => {
    renderWithProviders(<IndentsNav />, "/indents/notifications");

    expect(screen.queryByRole("link", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("href", "/indents/notifications");
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["Overview", <IndentDashboardPage />, "/indents/dashboard", "Search by indent no., requester, department or status...", true],
    ["All requests", <IndentListPage />, "/indents", "Search by indent no., requester, department or status...", true],
    ["Board", <IndentBoardPage />, "/indents/board", "Search indents...", false],
  ])("shows the common Indent toolbar on %s", async (_name, Page, route, placeholder, separateDates) => {
    renderWithProviders(Page, route);
    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toHaveAttribute("placeholder", placeholder);
    if (separateDates) {
      expect(screen.getByRole("button", { name: "Raised date" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Required by" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Date/ })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: /^Date/ })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /^Status/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Priority/ })).toBeInTheDocument();
  });

  it.each([
    [
      "Overview",
      <IndentDashboardPage />,
      "/indents/dashboard",
      () => {
        expect(indentApi.stats).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt" }), expect.anything());
        expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", size: 8 }), expect.anything());
      },
    ],
    [
      "All requests",
      <IndentListPage />,
      "/indents",
      () => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", page: 1, size: 20 }), expect.anything()),
    ],
    [
      "Board",
      <IndentBoardPage />,
      "/indents/board",
      () => {
        expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", is_bookmarked: "YES" }));
        expect(indentApi.stats).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", is_bookmarked: "YES" }));
      },
    ],
    [
      "Activity ledger",
      <IndentReportsPage />,
      "/indents/reports",
      () => expect(indentApi.activity).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "Bolt", page: 1, size: 20 }),
        expect.anything(),
      ),
    ],
  ])("sends trimmed search from the shared toolbar on %s", async (_name, Page, route, assertSearch) => {
    renderWithProviders(Page, route);

    const search = await screen.findByRole("searchbox", { name: "Search indents" });
    fireEvent.change(search, { target: { value: "  Bolt  " } });

    await waitFor(assertSearch);
  });

  it("shows only the latest seven recent indents in the existing API order", async () => {
    const indentNumbers = [
      "IND/RECENT/005",
      "IND/RECENT/002",
      "IND/RECENT/009",
      "IND/RECENT/001",
      "IND/RECENT/006",
      "IND/RECENT/003",
      "IND/RECENT/007",
      "IND/RECENT/004",
    ];
    const recentIndents = indentNumbers.map((indentNo, index) => ({
      id: 100 + index,
      indent_no: indentNo,
      requested_by_name: `Requester ${index + 1}`,
      department_name: "Operations",
      status: "DRAFT",
      priority: "NORMAL",
      total_items: 1,
      is_bookmarked: "NO",
      created_at: `2026-07-${String(28 - index).padStart(2, "0")}T10:00:00Z`,
    }));
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: recentIndents,
      total: recentIndents.length,
      page: 1,
      size: 8,
    });

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    await screen.findByText(recentIndents[6].indent_no);
    expect(screen.getAllByText(/^IND\/RECENT\//).map((node) => node.textContent)).toEqual(
      recentIndents.slice(0, 7).map((indent) => indent.indent_no),
    );
    expect(screen.queryByText(recentIndents[7].indent_no)).not.toBeInTheDocument();
    expect(indentApi.list).toHaveBeenCalledWith(expect.objectContaining({ size: 8 }), expect.anything());
  });

  it("shows View all in the Recent Indents header and navigates to All Requests", async () => {
    renderWithProviders(
      <>
        <IndentDashboardPage />
        <LocationProbe />
      </>,
      "/indents/dashboard",
    );

    const heading = await screen.findByRole("heading", { name: "Recent Indents" });
    const viewAll = screen.getByRole("button", { name: "View all" });

    expect(heading.parentElement).toHaveClass("flex", "items-center", "justify-between", "gap-4");
    expect(viewAll.parentElement).toBe(heading.parentElement);
    expect(viewAll).toHaveClass("cursor-pointer");

    fireEvent.click(viewAll);

    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/indents$/));
  });

  it("renders a flat donut with its total, fixed workflow order, values and ERP colours", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 1,
      CLOSED: 4,
      PARTIALLY_FULFILLED: 3,
      REJECTED: 3,
      ALLOCATED: 2,
      PENDING_APPROVAL: 4,
      AWAITING_ALLOCATION: 5,
    }));

    const { container } = renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    expect(await screen.findByRole("heading", { name: "STATUS BREAKDOWN" })).toBeInTheDocument();
    expect(screen.getByText("Current distribution by workflow status")).toBeInTheDocument();
    const chart = await screen.findByRole("img", {
      name: "Indent status donut chart. 22 total indents.",
    });
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("22Total indents");
    expect(screen.getByTestId("status-donut-total")).toHaveAccessibleName("22 total indents");
    expect(container.querySelectorAll(".recharts-pie")).toHaveLength(1);
    expect(container.querySelector(".status-pie-depth")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^status-pie-depth-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^status-pie-top-/)).toHaveLength(0);

    const colours = {
      DRAFT: "var(--color-neutral)",
      PENDING_APPROVAL: "var(--color-warn)",
      AWAITING_ALLOCATION: "var(--color-info)",
      ALLOCATED: "#8b5cf6",
      PARTIALLY_FULFILLED: "#0891b2",
      CLOSED: "var(--color-ok)",
      REJECTED: "var(--color-bad)",
    };
    for (const [status, colour] of Object.entries(colours)) {
      const slice = within(chart).getByTestId(`status-donut-slice-${status}`);
      expect(slice).toHaveAttribute("data-color", colour);
      expect(slice).toHaveAttribute("fill", colour);
      expect(Number(slice.getAttribute("data-inner-radius")) / Number(slice.getAttribute("data-outer-radius")))
        .toBeCloseTo(69 / 90, 2);
    }

    // Legend rows are read-only labels, not buttons — filtering by clicking a status
    // was removed, so the rows carry no role and no press state.
    const legend = screen.getByTestId("status-breakdown-legend");
    const legendRows = within(legend).getAllByTestId(/^status-legend-row-/);
    expect(within(legend).queryAllByRole("button")).toHaveLength(0);
    expect(legendRows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Pending approval: 4 indents, 18 percent",
      "Awaiting allocation: 5 indents, 23 percent",
      "Allocated: 2 indents, 9 percent",
      "Partially fulfilled: 3 indents, 14 percent",
      "Fulfilled: 4 indents, 18 percent",
      "Rejected: 3 indents, 14 percent",
      "Draft: 1 indent, 5 percent",
    ]);
    expect(legendRows[0]).toHaveClass(
      "grid-cols-[0.625rem_minmax(0,1fr)_2.5rem_3rem]",
      "min-h-9",
      "gap-x-2",
    );
    expect(screen.getByTestId("status-marker-DRAFT")).toHaveClass("bg-neutral");
    expect(screen.getByTestId("status-marker-PENDING_APPROVAL")).toHaveClass("bg-warn");
    expect(screen.getByTestId("status-marker-AWAITING_ALLOCATION")).toHaveClass("bg-info");
    expect(screen.getByTestId("status-marker-ALLOCATED")).toHaveClass("bg-purple-500");
    expect(screen.getByTestId("status-marker-PARTIALLY_FULFILLED")).toHaveClass("bg-warn");
    expect(screen.getByTestId("status-marker-CLOSED")).toHaveClass("bg-ok");
    expect(screen.getByTestId("status-marker-REJECTED")).toHaveClass("bg-bad");
    expect(within(legend).getByText("Fulfilled")).toBeInTheDocument();
    expect(within(legend).queryByText("Closed")).not.toBeInTheDocument();
    expect(container.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
  });

  it("keeps only the seven displayed statuses in order and handles zero safely", () => {
    const byStatus = {
      DRAFT: 1,
      PENDING_APPROVAL: 2,
      AWAITING_ALLOCATION: 2,
      ALLOCATED: 2,
      PARTIALLY_FULFILLED: 1,
      REJECTED: 1,
      APPROVED: 1,
      ORDERED: 1,
      CLOSED: 1,
    };
    const original = { ...byStatus };

    const { entries, total } = buildStatusBreakdownData(byStatus);

    expect(total).toBe(10);
    expect(entries.map(({ status }) => status)).toEqual([
      "PENDING_APPROVAL",
      "AWAITING_ALLOCATION",
      "ALLOCATED",
      "PARTIALLY_FULFILLED",
      "CLOSED",
      "REJECTED",
      "DRAFT",
    ]);
    expect(entries.some(({ status }) => status === "APPROVED" || status === "ORDERED")).toBe(false);
    expect(entries.every(({ isSelectable }) => isSelectable)).toBe(true);
    const zeroData = buildStatusBreakdownData({ DRAFT: 0, REJECTED: Number.NaN });
    expect(zeroData.total).toBe(0);
    expect(zeroData.entries.map(({ status }) => status)).toEqual([
      "PENDING_APPROVAL",
      "AWAITING_ALLOCATION",
      "ALLOCATED",
      "PARTIALLY_FULFILLED",
      "CLOSED",
      "REJECTED",
      "DRAFT",
    ]);
    expect(zeroData.entries.every(({ count, percentage }) => count === 0 && percentage === 0)).toBe(true);
    expect(byStatus).toEqual(original);
  });

  it("shows a slice tooltip on hover and never filters from the chart", async () => {
    const interactiveStats = overviewStats({
      AWAITING_ALLOCATION: 7,
      PENDING_APPROVAL: 4,
      APPROVED: 2,
      DRAFT: 2,
    });
    // One response only: nothing in the chart refetches any more.
    vi.mocked(indentApi.stats).mockResolvedValueOnce(interactiveStats);

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const slice = await screen.findByTestId("status-donut-slice-AWAITING_ALLOCATION");
    expect(slice).toHaveAccessibleName("Awaiting allocation: 7 indents, 47 percent");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(slice);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Awaiting allocation")).toBeInTheDocument();
    expect(within(tooltip).getByText("7 indents")).toBeInTheDocument();
    expect(within(tooltip).getByText("47% of total")).toBeInTheDocument();
    expect(tooltip).toHaveClass("pointer-events-none", "w-40", "shadow-sm");
    expect(screen.getByTestId("status-legend-row-AWAITING_ALLOCATION")).toHaveAttribute("data-active", "true");

    fireEvent.mouseLeave(slice);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    // The chart is read-only. Hovering a legend row highlights it and anchors the
    // same tooltip to that row's slice; clicking one must not refetch or filter.
    const row = screen.getByTestId("status-legend-row-AWAITING_ALLOCATION");
    const statsCallsBeforeHover = vi.mocked(indentApi.stats).mock.calls.length;
    fireEvent.mouseEnter(row);
    expect(row).toHaveAttribute("data-hovered", "true");
    expect(row).toHaveAttribute("data-selected", "false");
    expect(indentApi.stats).toHaveBeenCalledTimes(statsCallsBeforeHover);
    fireEvent.mouseLeave(row);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    fireEvent.click(row);
    await waitFor(() => expect(indentApi.stats).toHaveBeenCalledTimes(statsCallsBeforeHover));
    expect(row).not.toHaveAttribute("aria-pressed");
  });

  it("shows a neutral empty donut, zero centre KPI and filtered empty-state message", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 0,
      CLOSED: 0,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    expect(await screen.findByText("No status data available for the selected filters.")).toBeInTheDocument();
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("0Total indents");
    expect(screen.getByTestId("status-empty-donut-track")).toBeInTheDocument();
    expect(screen.getByRole("img", {
      name: "Indent status donut chart. 0 total indents.",
    })).toBeInTheDocument();
    expect(screen.queryByLabelText("Status breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it("renders a selected single status as a complete flat ring with a 100 percent row", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({ ALLOCATED: 6 }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const chart = await screen.findByRole("img", {
      name: "Indent status donut chart. 6 total indents.",
    });
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("6Total indents");

    const allocated = screen.getByTestId("status-legend-row-ALLOCATED");
    expect(allocated).toHaveAccessibleName("Allocated: 6 indents, 100 percent");
    expect(within(allocated).getByTestId("status-legend-count-ALLOCATED")).toHaveTextContent(/^6$/);
    expect(within(allocated).getByTestId("status-legend-percentage-ALLOCATED")).toHaveTextContent(/^100%$/);
    const allocatedSlice = within(chart).getByTestId("status-donut-slice-ALLOCATED");
    const allocatedPath = allocatedSlice.querySelector("path");
    expect(allocatedSlice).toHaveAttribute("fill", "#8b5cf6");
    expect(allocatedSlice).not.toHaveAttribute("stroke");
    expect(allocatedPath).toHaveAttribute("stroke", "none");
    expect(allocatedPath).toHaveAttribute("stroke-width", "0");
    expect(Number(allocatedSlice.getAttribute("data-inner-radius"))).toBeGreaterThan(0);
    fireEvent.click(allocated);
    expect(allocated).not.toHaveAttribute("aria-pressed");
    expect(chart.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
  });

  it("counts every status into the donut so its centre matches the Total indents card", async () => {
    // This used to assert the opposite, and the opposite is the bug that was
    // reported: the card said 74 and the donut said 63, the missing 11 being a
    // status the chart had no slice for.
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      APPROVED: 99,
      REJECTED: 1,
    }));

    const { container } = renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const approved = await screen.findByTestId("status-legend-row-APPROVED");
    expect(approved).toHaveAccessibleName("Approved: 99 indents, 99 percent");
    expect(within(approved).getByTestId("status-legend-count-APPROVED")).toHaveTextContent(/^99$/);
    expect(screen.getByTestId("status-donut-slice-APPROVED")).toBeInTheDocument();

    const rejected = screen.getByTestId("status-legend-row-REJECTED");
    expect(rejected).toHaveAccessibleName("Rejected: 1 indent, 1 percent");
    expect(within(rejected).getByTestId("status-legend-count-REJECTED")).toHaveTextContent(/^1$/);
    expect(within(rejected).getByTestId("status-legend-percentage-REJECTED")).toHaveTextContent(/^1%$/);
    expect(screen.getByTestId("status-donut-total")).toHaveAccessibleName("100 total indents");
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-legend-row-OTHER")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-marker-OTHER")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-donut-slice-OTHER")).not.toBeInTheDocument();
    expect(container.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
  });

  it("uses a larger balanced desktop donut with a compact scrollbar-free breakdown", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 2,
      APPROVED: 1,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const layout = await screen.findByTestId("status-breakdown-layout");
    const chart = screen.getByRole("img", { name: /Indent status donut chart/i });
    const donut = screen.getByTestId("status-donut-container");
    const legend = screen.getByTestId("status-breakdown-legend");

    expect(layout).toHaveClass(
      "grid",
      "md:grid-cols-[minmax(280px,1.15fr)_minmax(260px,0.85fr)]",
      "md:items-center",
      "md:gap-4",
    );
    expect(donut).toHaveClass(
      "h-[250px]",
      "max-w-[250px]",
      "sm:h-[290px]",
      "sm:max-w-[290px]",
      "md:h-[330px]",
      "md:max-w-[330px]",
    );
    expect(chart).toHaveClass("absolute", "inset-0");
    expect(legend).toHaveClass("max-w-[320px]", "gap-1");
    expect(legend).not.toHaveClass("overflow-y-auto", "md:overflow-y-auto", "max-h-[260px]", "md:max-h-[260px]");
    // DRAFT and APPROVED are the only two statuses with indents in this fixture.
    expect(within(legend).getAllByTestId(/^status-legend-row-/)).toHaveLength(2);
    expect(layout.children[0]).toBe(donut);
    expect(layout.children[1]).toBe(legend);
  });

  it("stacks the legend below the centred pie on mobile without horizontal overflow", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 2,
      APPROVED: 1,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const layout = await screen.findByTestId("status-breakdown-layout");
    const donut = screen.getByTestId("status-donut-container");
    const legend = screen.getByTestId("status-breakdown-legend");
    const centre = screen.getByTestId("status-donut-total");

    expect(layout).toHaveClass("grid", "min-w-0", "gap-3");
    expect(layout).not.toHaveClass("grid-cols-2");
    expect(donut).toHaveClass("mx-auto", "h-[250px]", "w-full", "max-w-[250px]");
    expect(legend).toHaveClass("min-w-0");
    expect(centre).toHaveClass("absolute", "inset-0", "text-center");
    expect(donut.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the other Overview cards unchanged", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      AWAITING_ALLOCATION: 7,
      PENDING_APPROVAL: 4,
      APPROVED: 3,
      DRAFT: 1,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");
    await screen.findByRole("img", {
      name: "Indent status donut chart. 15 total indents.",
    });

    expect(screen.getAllByText("Total indents")).toHaveLength(2);
    expect(screen.getAllByText("Rejected")).toHaveLength(2);
    for (const label of [
      "Awaiting approval",
      "Approved active",
      "Raised this month",
      "In draft",
      "Units requested",
      "Approval rate",
      "Recent Indents",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    ["Overview", <IndentDashboardPage />, "/indents/dashboard"],
    ["All requests", <IndentListPage />, "/indents"],
  ])("shows the same seven ungrouped status options on %s", async (_name, Page, route) => {
    renderWithProviders(Page, route);

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");

    expect(INDENT_REQUEST_STATUS_FILTER_OPTIONS).toEqual(
      EXPECTED_REQUEST_STATUS_FILTERS.map(([label, value]) => ({ label, value })),
    );
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
      EXPECTED_REQUEST_STATUS_FILTERS.map(([label]) => label),
    );
    for (const heading of ["Request", "Approved / Fulfilment", "Procurement", "Completed"]) {
      expect(within(menu).queryByText(heading)).not.toBeInTheDocument();
    }
  });

  it("maps every All Requests option to its existing enum, updates its chip, clears, and resets pagination", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: [],
      total: 45,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");

    for (const [label, value] of EXPECTED_REQUEST_STATUS_FILTERS) {
      fireEvent.click(within(menu).getByText(label));
      await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
        status: [value],
        page: 1,
      }), expect.anything()));
      expect(screen.getByRole("button", { name: "Status (1)" })).toBeInTheDocument();
      expect(screen.getByText(`Status: ${label}`)).toBeInTheDocument();

      fireEvent.click(within(menu).getByText(label));
      await waitFor(() => expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument());
      expect(screen.queryByText(`Status: ${label}`)).not.toBeInTheDocument();
    }

    fireEvent.click(within(menu).getByText("Pending approvals"));
    fireEvent.click(await screen.findByRole("button", { name: "close chip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument());

    fireEvent.click(within(menu).getByText("Allocated"));
    expect(await screen.findByRole("button", { name: "Clear all" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByText("Status: Allocated")).not.toBeInTheDocument();
  });

  it("maps every Overview option to the same existing enum values", async () => {
    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    await screen.findByRole("searchbox", { name: "Search indents" });
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");

    for (const [label, value] of EXPECTED_REQUEST_STATUS_FILTERS) {
      fireEvent.click(within(menu).getByText(label));
      await waitFor(() => {
        expect(indentApi.stats).toHaveBeenLastCalledWith(expect.objectContaining({ status: [value] }), expect.anything());
        expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: [value], size: 8 }), expect.anything());
      });
      fireEvent.click(within(menu).getByText(label));
      await waitFor(() => expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument());
    }
  });

  it("updates status and page in the selection event without the search debounce or a duplicate list request", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: [listRow(params.page ?? 1, `IND/PAGE-${params.page ?? 1}`)],
      total: 45,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (45 total)")).toBeInTheDocument();
    const requestCount = vi.mocked(indentApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("Draft"));

    expect(screen.getByRole("button", { name: "Status (1)" })).toBeInTheDocument();
    expect(screen.getByText("Status: Draft")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    expect(indentApi.list).toHaveBeenCalledTimes(requestCount + 1);
    expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      status: ["DRAFT"],
      page: 1,
    }), expect.anything());
  });

  it("keeps All Requests content visible and accessible while status results refresh", async () => {
    const draftResults = deferred<{
      items: ReturnType<typeof listRow>[];
      total: number;
      page: number;
      size: number;
    }>();
    vi.mocked(indentApi.list).mockImplementation((params = {}) => {
      if (params.status?.includes("DRAFT")) return draftResults.promise;
      return Promise.resolve({ items: [listRow(1, "IND/OLD", "ALLOCATED")], total: 1, page: 1, size: 20 });
    });
    renderWithProviders(<IndentListPage />, "/indents");

    expect((await screen.findAllByText("IND/OLD")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Draft"));

    const results = screen.getByRole("region", { name: "Indent results" });
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating results…");
    expect(results.querySelector(".opacity-70")).toBeInTheDocument();
    expect(screen.getAllByText("IND/OLD").length).toBeGreaterThan(0);

    await act(async () => {
      draftResults.resolve({ items: [listRow(2, "IND/DRAFT")], total: 1, page: 1, size: 20 });
      await draftResults.promise;
    });
    expect((await screen.findAllByText("IND/DRAFT")).length).toBeGreaterThan(0);
    await waitFor(() => expect(results).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByText("IND/OLD")).not.toBeInTheDocument();
  });

  it("shows a recently selected status from cache immediately without another request", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: params.status?.includes("DRAFT")
        ? [listRow(2, "IND/CACHED-DRAFT")]
        : [listRow(1, "IND/UNFILTERED", "ALLOCATED")],
      total: 1,
      page: 1,
      size: 20,
    }));
    renderWithProviders(<IndentListPage />, "/indents");

    expect((await screen.findAllByText("IND/UNFILTERED")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("Draft"));
    expect((await screen.findAllByText("IND/CACHED-DRAFT")).length).toBeGreaterThan(0);
    expect(indentApi.list).toHaveBeenCalledTimes(2);

    fireEvent.click(within(menu).getByText("Draft"));
    expect((await screen.findAllByText("IND/UNFILTERED")).length).toBeGreaterThan(0);
    fireEvent.click(within(menu).getByText("Draft"));

    expect(screen.getAllByText("IND/CACHED-DRAFT").length).toBeGreaterThan(0);
    expect(indentApi.list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Indent results" })).toHaveAttribute("aria-busy", "false");
  });

  it("aborts a superseded status request and ignores its late result", async () => {
    const draftResults = deferred<{ items: ReturnType<typeof listRow>[]; total: number; page: number; size: number }>();
    const allocatedResults = deferred<{ items: ReturnType<typeof listRow>[]; total: number; page: number; size: number }>();
    vi.mocked(indentApi.list).mockImplementation((params = {}) => {
      if (params.status?.includes("DRAFT")) return draftResults.promise;
      if (params.status?.includes("ALLOCATED")) return allocatedResults.promise;
      return Promise.resolve({ items: [listRow(1, "IND/BASE")], total: 1, page: 1, size: 20 });
    });
    renderWithProviders(<IndentListPage />, "/indents");

    expect((await screen.findAllByText("IND/BASE")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("Draft"));
    const draftSignal = vi.mocked(indentApi.list).mock.calls.at(-1)?.[1] as AbortSignal;
    fireEvent.click(within(menu).getByText("Draft"));
    fireEvent.click(within(menu).getByText("Allocated"));

    expect(draftSignal.aborted).toBe(true);
    await act(async () => {
      allocatedResults.resolve({ items: [listRow(3, "IND/LATEST", "ALLOCATED")], total: 1, page: 1, size: 20 });
      await allocatedResults.promise;
    });
    expect((await screen.findAllByText("IND/LATEST")).length).toBeGreaterThan(0);

    await act(async () => {
      draftResults.resolve({ items: [listRow(2, "IND/STALE")], total: 1, page: 1, size: 20 });
      await draftResults.promise;
    });
    expect(screen.queryByText("IND/STALE")).not.toBeInTheDocument();
    expect(screen.getAllByText("IND/LATEST").length).toBeGreaterThan(0);
  });

  it("starts the Overview stats and recent-list requests in parallel and refreshes them accessibly", async () => {
    const initialStats = deferred<IndentStats>();
    const initialRecent = deferred<{ items: ReturnType<typeof listRow>[]; total: number; page: number; size: number }>();
    vi.mocked(indentApi.stats).mockReturnValueOnce(initialStats.promise);
    vi.mocked(indentApi.list).mockReturnValueOnce(initialRecent.promise);
    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    expect(indentApi.stats).toHaveBeenCalledTimes(1);
    expect(indentApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Overview results" })).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      initialStats.resolve(overviewStats({ ALLOCATED: 1 }));
      initialRecent.resolve({ items: [listRow(1, "IND/OVERVIEW", "ALLOCATED")], total: 1, page: 1, size: 6 });
      await Promise.all([initialStats.promise, initialRecent.promise]);
    });
    expect(await screen.findByText("IND/OVERVIEW")).toBeInTheDocument();
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("1Total indents");

    const nextStats = deferred<IndentStats>();
    const nextRecent = deferred<{ items: ReturnType<typeof listRow>[]; total: number; page: number; size: number }>();
    vi.mocked(indentApi.stats).mockReturnValueOnce(nextStats.promise);
    vi.mocked(indentApi.list).mockReturnValueOnce(nextRecent.promise);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Draft"));

    expect(indentApi.stats).toHaveBeenCalledTimes(2);
    expect(indentApi.list).toHaveBeenCalledTimes(2);
    const results = screen.getByRole("region", { name: "Overview results" });
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating results…");
    expect(screen.getByText("IND/OVERVIEW")).toBeInTheDocument();
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("1Total indents");
    expect(screen.getByTestId("status-donut-slice-ALLOCATED")).toBeInTheDocument();
    expect(screen.queryByText("Loading status breakdown...")).not.toBeInTheDocument();

    await act(async () => {
      nextStats.resolve(overviewStats({ DRAFT: 2 }));
      nextRecent.resolve({ items: [listRow(2, "IND/OVERVIEW-DRAFT")], total: 1, page: 1, size: 6 });
      await Promise.all([nextStats.promise, nextRecent.promise]);
    });
    expect(await screen.findByText("IND/OVERVIEW-DRAFT")).toBeInTheDocument();
    expect(screen.getByTestId("status-donut-total")).toHaveTextContent("2Total indents");
    expect(await screen.findByTestId("status-donut-slice-DRAFT")).toBeInTheDocument();
    await waitFor(() => expect(results).toHaveAttribute("aria-busy", "false"));
  });

  it("keeps All Requests pagination stable through next-page refetch and Previous", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: [{
        id: params.page ?? 1,
        indent_no: `IND/PAGE-${params.page ?? 1}`,
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 2,
        is_bookmarked: "NO",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 45,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    const { client } = renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (45 total)")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
      size: 20,
    }), expect.anything()));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await client.invalidateQueries({
        predicate: (query) => query.queryKey[3] === "list",
      });
    });
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
      size: 20,
    }), expect.anything()));
    expect(screen.getByText("Page 2 of 3 (45 total)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      size: 20,
    }), expect.anything()));
  });

  it("resets All Requests to page 1 only when search actually changes", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: [],
      total: 45,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (45 total)")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(screen.getByText("Page 2 of 3 (45 total)")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "  Bolt  " },
    });
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      size: 20,
      search: "Bolt",
    }), expect.anything()));
    expect(screen.getByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
  });

  it("offers every Activity ledger event type as a filter and maps each label", async () => {
    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toHaveAttribute(
      "placeholder",
      "Search by indent no., event, actor, department or result...",
    );
    expect(screen.getByRole("button", { name: "Activity date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Event" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Priority/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^More filters/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(
      EXPECTED_ACTIVITY_EVENT_FILTERS.map(([label]) => label),
    );

    for (const [label, eventType] of EXPECTED_ACTIVITY_EVENT_FILTERS) {
      const callsBeforeSelection = vi.mocked(indentApi.activity).mock.calls.length;
      // The Event filter is single-select, so each pick closes the menu behind it.
      if (screen.queryByRole("menu") === null) {
        fireEvent.click(screen.getByRole("button", { name: /^Event/ }));
        await screen.findByRole("menu");
      }
      fireEvent.click(within(screen.getByRole("menu")).getByText(label));
      await waitFor(() => expect(indentApi.activity).toHaveBeenCalledTimes(callsBeforeSelection + 1));
      expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
        transaction_type: eventType,
        page: 1,
      }), expect.anything());
      expect(screen.getByText(`Event: ${label}`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Event/ }));
      expect((await screen.findByRole("menu")).querySelectorAll(".lucide-check")).toHaveLength(1);
    }
  });

  it("applies an Activity event and pending search immediately with one Page 1 request", async () => {
    const refresh = deferred<{
      items: ActivityRow[];
      total: number;
      page: number;
      size: number;
    }>();
    vi.mocked(indentApi.activity).mockImplementation((params = {}) => (
      params.transaction_type === "APPROVAL_COMPLETED"
        ? refresh.promise
        : Promise.resolve({
            items: [activityRow({ indent_no: "IND/ACTIVITY/OLD" })],
            total: 60,
            page: params.page ?? 1,
            size: params.size ?? 20,
          })
    ));
    renderActivityLedgerFlow("/indents/reports?page=3");

    expect((await screen.findAllByText("IND/ACTIVITY/OLD")).length).toBeGreaterThan(0);
    const callsBeforeEvent = vi.mocked(indentApi.activity).mock.calls.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "bolt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Approval completed"));

    expect(screen.getByRole("button", { name: "Event (1)" })).toBeInTheDocument();
    expect(screen.getByText("Event: Approval completed")).toBeInTheDocument();
    expect(indentApi.activity).toHaveBeenCalledTimes(callsBeforeEvent + 1);
    expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "bolt",
      transaction_type: "APPROVAL_COMPLETED",
      page: 1,
    }), expect.anything());
    const results = screen.getByRole("region", { name: "Activity ledger results" });
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(within(results).getByRole("status")).toHaveTextContent("Updating results…");
    expect(results.querySelector(".duration-150.opacity-70")).toBeInTheDocument();
    expect(screen.getAllByText("IND/ACTIVITY/OLD").length).toBeGreaterThan(0);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(indentApi.activity).toHaveBeenCalledTimes(callsBeforeEvent + 1);

    await act(async () => {
      refresh.resolve({
        items: [activityRow({ event_id: "indent:901", indent_no: "IND/ACTIVITY/NEW" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await refresh.promise;
    });
    expect((await screen.findAllByText("IND/ACTIVITY/NEW")).length).toBeGreaterThan(0);
    expect(results).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("IND/ACTIVITY/OLD")).not.toBeInTheDocument();
  });

  it("applies Notification status and pending search immediately with one Page 1 request", async () => {
    const refresh = deferred<{
      items: IndentNotification[];
      total: number;
      page: number;
      size: number;
    }>();
    vi.mocked(indentApi.notifications).mockImplementation((params = {}) => (
      params.status?.includes("DRAFT")
        ? refresh.promise
        : Promise.resolve({
            items: [notificationRow(1, { title: "Existing notification" })],
            total: 60,
            page: params.page ?? 1,
            size: params.size ?? 20,
          })
    ));
    renderNotificationsFlow("/indents/notifications?page=3");

    expect(await screen.findByText("Existing notification")).toBeInTheDocument();
    const callsBeforeStatus = vi.mocked(indentApi.notifications).mock.calls.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notifications" }), {
      target: { value: "stock" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Draft"));

    expect(screen.getByRole("button", { name: "Status (1)" })).toBeInTheDocument();
    expect(screen.getByText("Status: Draft")).toBeInTheDocument();
    expect(indentApi.notifications).toHaveBeenCalledTimes(callsBeforeStatus + 1);
    expect(indentApi.notifications).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "stock",
      status: ["DRAFT"],
      page: 1,
    }), expect.anything());
    const results = screen.getByRole("region", { name: "Notification results" });
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(within(results).getByRole("status")).toHaveTextContent("Updating results…");
    expect(results.querySelector(".duration-150.opacity-70")).toBeInTheDocument();
    expect(screen.getByText("Existing notification")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(indentApi.notifications).toHaveBeenCalledTimes(callsBeforeStatus + 1);

    await act(async () => {
      refresh.resolve({
        items: [notificationRow(2, { title: "Updated notification", status: "DRAFT" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await refresh.promise;
    });
    expect(await screen.findByText("Updated notification")).toBeInTheDocument();
    expect(results).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Existing notification")).not.toBeInTheDocument();
  });

  it("aborts superseded Activity event work, ignores late rows, and reuses fresh cache", async () => {
    const approval = deferred<{ items: ActivityRow[]; total: number; page: number; size: number }>();
    const allocated = deferred<{ items: ActivityRow[]; total: number; page: number; size: number }>();
    vi.mocked(indentApi.activity).mockImplementation((params = {}) => {
      if (params.transaction_type === "APPROVAL_COMPLETED") return approval.promise;
      if (params.transaction_type === "STOCK_ALLOCATED") return allocated.promise;
      return Promise.resolve({
        items: [activityRow({ indent_no: "IND/ACTIVITY/BASE" })],
        total: 1,
        page: 1,
        size: 20,
      });
    });
    renderActivityLedgerFlow("/indents/reports");
    expect((await screen.findAllByText("IND/ACTIVITY/BASE")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Approval completed"));
    const approvalSignal = vi.mocked(indentApi.activity).mock.calls.at(-1)?.[1] as AbortSignal;
    fireEvent.click(within(menu).getByText("Stock allocated"));

    expect(approvalSignal.aborted).toBe(true);
    expect(indentApi.activity).toHaveBeenCalledTimes(3);
    await act(async () => {
      allocated.resolve({
        items: [activityRow({ event_id: "indent:902", indent_no: "IND/ACTIVITY/LATEST" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await allocated.promise;
    });
    expect((await screen.findAllByText("IND/ACTIVITY/LATEST")).length).toBeGreaterThan(0);

    await act(async () => {
      approval.resolve({
        items: [activityRow({ event_id: "indent:903", indent_no: "IND/ACTIVITY/STALE" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await approval.promise;
    });
    expect(screen.queryByText("IND/ACTIVITY/STALE")).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByText("Stock allocated"));
    expect(screen.getAllByText("IND/ACTIVITY/BASE").length).toBeGreaterThan(0);
    fireEvent.click(within(menu).getByText("Stock allocated"));
    expect(screen.getAllByText("IND/ACTIVITY/LATEST").length).toBeGreaterThan(0);
    expect(indentApi.activity).toHaveBeenCalledTimes(3);
  });

  it("aborts superseded Notification status work and ignores its late result", async () => {
    const draft = deferred<{ items: IndentNotification[]; total: number; page: number; size: number }>();
    const allocated = deferred<{ items: IndentNotification[]; total: number; page: number; size: number }>();
    vi.mocked(indentApi.notifications).mockImplementation((params = {}) => {
      if (params.status?.includes("DRAFT")) return draft.promise;
      if (params.status?.includes("ALLOCATED")) return allocated.promise;
      return Promise.resolve({ items: [notificationRow(1)], total: 1, page: 1, size: 20 });
    });
    renderNotificationsFlow("/indents/notifications");
    expect(await screen.findByText("Notification 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Draft"));
    const draftSignal = vi.mocked(indentApi.notifications).mock.calls.at(-1)?.[1] as AbortSignal;
    fireEvent.click(within(menu).getByText("Draft"));
    fireEvent.click(within(menu).getByText("Allocated"));

    expect(draftSignal.aborted).toBe(true);
    expect(indentApi.notifications).toHaveBeenCalledTimes(3);
    await act(async () => {
      allocated.resolve({
        items: [notificationRow(2, { title: "Latest notification", status: "ALLOCATED" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await allocated.promise;
    });
    expect(await screen.findByText("Latest notification")).toBeInTheDocument();

    await act(async () => {
      draft.resolve({
        items: [notificationRow(3, { title: "Stale notification", status: "DRAFT" })],
        total: 1,
        page: 1,
        size: 20,
      });
      await draft.promise;
    });
    expect(screen.queryByText("Stale notification")).not.toBeInTheDocument();
    expect(screen.getByText("Latest notification")).toBeInTheDocument();
  });

  it.each([
    ["Activity", <IndentReportsPage />, "/indents/reports", "Activity date", indentApi.activity],
    ["Notification", <IndentNotificationsPage />, "/indents/notifications", "Notification date", indentApi.notifications],
  ])("keeps incomplete and invalid %s custom dates out of API state and chips", async (
    _name,
    Page,
    route,
    dateLabel,
    request,
  ) => {
    const view = renderWithProviders(Page, route);
    await screen.findByRole("button", { name: dateLabel });
    const initialCalls = vi.mocked(request).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: dateLabel }));
    const dialog = screen.getByRole("dialog", { name: `${dateLabel} filter` });
    for (const option of ["All time", "Today", "This week", "This month", "Custom range"]) {
      expect(within(dialog).getByRole("button", { name: option })).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    const from = within(dialog).getByLabelText(`${dateLabel} from`);
    const to = within(dialog).getByLabelText(`${dateLabel} to`);
    const apply = within(dialog).getByRole("button", { name: "Apply" });

    fireEvent.change(from, { target: { value: "2026-07-10" } });
    expect(apply).toBeDisabled();
    expect(vi.mocked(request)).toHaveBeenCalledTimes(initialCalls);

    fireEvent.change(to, { target: { value: "2026-07-09" } });
    expect(screen.getByText("To date must be the same as or later than From date.")).toBeInTheDocument();
    expect(apply).toBeDisabled();
    expect(vi.mocked(request)).toHaveBeenCalledTimes(initialCalls);
    expect(screen.queryByText(new RegExp(`^${dateLabel}:`))).not.toBeInTheDocument();
    view.unmount();
  });

  it("applies Activity presets immediately, resets pagination, and clears chips individually", async () => {
    vi.mocked(indentApi.activity).mockImplementation((params = {}) => Promise.resolve({
      items: [],
      total: 80,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderActivityLedgerFlow("/indents/reports?page=4");
    expect(await screen.findByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
    const callsBeforePreset = vi.mocked(indentApi.activity).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Activity date" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Activity date filter" }))
      .getByRole("button", { name: "Today" }));

    await waitFor(() => expect(indentApi.activity).toHaveBeenCalledTimes(callsBeforePreset + 1));
    expect(vi.mocked(indentApi.activity).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      date_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      page: 1,
    }));
    expect(screen.getByText("Activity date: Today")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    fireEvent.click(await screen.findByText("Request created"));
    await waitFor(() => expect(screen.getByText("Event: Request created")).toBeInTheDocument());
    const closeButtons = screen.getAllByRole("button", { name: "close chip" });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    await waitFor(() => expect(screen.queryByText("Event: Request created"))
      .not.toBeInTheDocument());
    expect(screen.getByLabelText("location")).not.toHaveTextContent("transaction_type=");
    expect(screen.getByText("Activity date: Today")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Event" }));
    fireEvent.click(await screen.findByText("Stock allocated"));
    await waitFor(() => expect(screen.getByText("Event: Stock allocated")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByText("Activity date: Today")).not.toBeInTheDocument());
    expect(screen.queryByText("Event: Stock allocated")).not.toBeInTheDocument();
    expect(screen.getByLabelText("location")).not.toHaveTextContent("transaction_type=");
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("applies Notification custom ranges and presets with Page 1 URL state", async () => {
    vi.mocked(indentApi.notifications).mockImplementation((params = {}) => Promise.resolve({
      items: [],
      total: 80,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderNotificationsFlow("/indents/notifications?page=4");
    expect(await screen.findByText("Page 4 of 4 (80 total)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Notification date" }));
    let dialog = screen.getByRole("dialog", { name: "Notification date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    fireEvent.change(within(dialog).getByLabelText("Notification date from"), {
      target: { value: "2026-07-31" },
    });
    fireEvent.change(within(dialog).getByLabelText("Notification date to"), {
      target: { value: "2026-07-31" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(indentApi.notifications).toHaveBeenLastCalledWith(
      expect.objectContaining({
        date_from: "2026-07-31",
        date_to: "2026-07-31",
        page: 1,
      }),
      expect.anything(),
    ));
    expect(screen.getByText("Notification date: 31 Jul 2026 – 31 Jul 2026"))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Notification date" }));
    dialog = screen.getByRole("dialog", { name: "Notification date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "This week" }));
    await waitFor(() => expect(screen.getByText("Notification date: This week"))
      .toBeInTheDocument());
    expect(screen.getByLabelText("location")).not.toHaveTextContent("page=");
  });

  it("debounces notification search while retaining rows and exposing quiet refresh state", async () => {
    const update = deferred<{
      items: IndentNotification[];
      total: number;
      page: number;
      size: number;
    }>();
    vi.mocked(indentApi.notifications).mockImplementation((params = {}) => (
      params.search
        ? update.promise
        : Promise.resolve({
          items: [notificationRow(1, { title: "Existing notification" })],
          total: 1,
          page: 1,
          size: 20,
        })
    ));
    renderNotificationsFlow("/indents/notifications");
    expect(await screen.findByText("Existing notification")).toBeInTheDocument();
    const initialCalls = vi.mocked(indentApi.notifications).mock.calls.length;

    fireEvent.change(screen.getByRole("searchbox", { name: "Search notifications" }), {
      target: { value: "stock" },
    });
    expect(indentApi.notifications).toHaveBeenCalledTimes(initialCalls);
    await waitFor(() => expect(indentApi.notifications).toHaveBeenCalledTimes(initialCalls + 1));
    expect(screen.getByText("Existing notification")).toBeInTheDocument();
    expect(screen.getByText("Updating results…")).toHaveAttribute("role", "status");
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.getByText('Search: “stock”')).toBeInTheDocument();

    await act(async () => update.resolve({
      items: [notificationRow(2, { title: "Updated notification" })],
      total: 1,
      page: 1,
      size: 20,
    }));
    expect(await screen.findByText("Updated notification")).toBeInTheDocument();
    expect(screen.queryByText("Updating results…")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it("renders the truthful Activity columns and matching desktop/mobile content", async () => {
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [
        activityRow(),
        activityRow({
          event_id: "allocation:8:3",
          indent_id: 43,
          indent_no: "IND/2026/0043",
          event_type: "STOCK_ALLOCATED",
          event_label: "Stock allocated",
          result: "PARTIALLY_ALLOCATED",
          result_label: "Partially Allocated",
          actor_name: "Allocation Approver",
          actor_position: "Inventory Approval",
          item_id: 3,
          item_code: "BOLT-01",
          item_name: "Anchor Bolt",
          quantity: 0,
          requested_quantity: 20,
          uom_code: "kg",
          remarks: "No stock available",
          source_type: "inv_allocations",
          source_id: 8,
        }),
        activityRow({
          event_id: "material-request:12:7",
          indent_id: 44,
          indent_no: "IND/2026/0044",
          event_type: "PROCUREMENT_REQUEST_CREATED",
          event_label: "Procurement request created",
          result: "PENDING_APPROVAL",
          result_label: "Pending Approval",
          actor_name: "Procurement Requester",
          actor_position: "MR/2026/0012",
          item_id: 4,
          item_code: "CEM-01",
          item_name: "Cement",
          quantity: 7.5,
          requested_quantity: 7.5,
          uom_code: "bag",
          source_type: "inv_material_requests",
          source_id: 12,
        }),
        activityRow({
          event_id: "workflow:95",
          indent_id: 45,
          indent_no: "IND/2026/0045",
          event_type: "APPROVAL_ROUTED_AUTOMATICALLY",
          event_label: "Approval routed automatically",
          result: "ROUTED_AUTOMATICALLY",
          result_label: "Routed Automatically",
          actor_id: null,
          actor_name: "System",
          actor_position: "District Manager Review",
          source_id: 95,
        }),
        activityRow({
          event_id: "indent:46",
          indent_id: 46,
          indent_no: "IND/2026/0046",
          event_type: "REQUEST_CREATED",
          event_label: "Request created",
          result: "DRAFT",
          result_label: "Draft",
          actor_name: "Ravi Requester",
          actor_position: "Site Engineer",
          quantity: null,
          requested_quantity: null,
          source_type: "ind_indents",
          source_id: 46,
        }),
      ],
      total: 5,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect((await screen.findAllByText("IND/2026/0042")).length).toBeGreaterThanOrEqual(2);
    for (const heading of [
      "WHEN",
      "REQUEST",
      "EVENT",
      "DETAILS",
      "QTY",
      "DEPARTMENT",
      "RESULT",
    ]) {
      const columnHeader = screen.getByRole("columnheader", { name: heading });
      expect(columnHeader).toBeInTheDocument();
      expect(columnHeader.closest('[class~="[&_th]:cursor-default"]')).toHaveClass(
        "[&_th]:cursor-default",
        "[&_th]:select-none",
      );
    }
    expect(screen.queryByRole("columnheader", { name: "Transaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Item / action" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();

    expect(screen.getAllByText("Approval completed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Approved").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Anita Approver · OE Review").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Anchor Bolt").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("BOLT-01").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("0 of 20 kg").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Cement").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("CEM-01 · MR/2026/0012").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("7.5 bag").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Ravi Requester · Site Engineer").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Operations").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Hindupur Office").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("System · District Manager Review").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("FALLBACK")).not.toBeInTheDocument();
    expect(screen.queryByText("REPORTING_LADDER")).not.toBeInTheDocument();
    expect(screen.queryByText("NO_WORKFLOW")).not.toBeInTheDocument();
  });

  it("uses simple semantic colors for every Activity result label", async () => {
    const results = [
      ["DRAFT", "Draft", "bg-neutral-bg", "text-neutral"],
      ["SUBMITTED", "Submitted", "bg-info-bg", "text-info"],
      ["APPROVED", "Approved", "bg-ok-bg", "text-ok"],
      ["REJECTED", "Rejected", "bg-bad-bg", "text-bad"],
      ["RETURNED", "Returned", "bg-warn-bg", "text-warn"],
      ["ROUTED_AUTOMATICALLY", "Routed Automatically", "bg-info-bg", "text-info"],
      ["AWAITING_ALLOCATION", "Awaiting Allocation", "bg-info-bg", "text-info"],
      ["ALLOCATED", "Allocated", "bg-purple-50", "text-purple-600"],
      ["PARTIALLY_ALLOCATED", "Partially Allocated", "bg-warn-bg", "text-warn"],
      ["PARTIALLY_FULFILLED", "Partially Fulfilled", "bg-warn-bg", "text-warn"],
      ["CLOSED", "Fulfilled", "bg-ok-bg", "text-ok"],
      ["PENDING_APPROVAL", "Pending Approval", "bg-warn-bg", "text-warn"],
      ["BOOKMARKED", "Bookmarked", "bg-brand-050", "text-brand"],
      ["BOOKMARK_REMOVED", "Bookmark Removed", "bg-neutral-bg", "text-neutral"],
    ] as const;
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: results.map(([result], index) => activityRow({
        event_id: `result-color:${index}`,
        indent_id: 500 + index,
        indent_no: `IND/COLOR/${index}`,
        result,
        result_label: null,
      })),
      total: results.length,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    await screen.findAllByText("Draft");
    for (const [, label, background, foreground] of results) {
      for (const badge of screen.getAllByText(label)) {
        expect(badge).toHaveClass(background, foreground);
      }
    }
  });

  it("renders the exact sanitised legacy API row shape that previously crashed", async () => {
    const legacyRow: ActivityRow = {
      event_id: "action:<source-id>",
      event_at: "2026-07-29T09:30:00Z",
      transaction_type: "APPROVED",
      direction: null,
      indent_id: 420,
      indent_no: "IND/<sanitised>",
      status: "AWAITING_ALLOCATION",
      requested_by_name: "Sanitised Requester",
      department_name: "Sanitised Department",
      item_id: null,
      item_code: null,
      item_name: null,
      uom_code: null,
      quantity: 0,
      actor_name: "Sanitised Approver",
      comments: null,
    };
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [legacyRow],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect((await screen.findAllByText("IND/<sanitised>")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Approval completed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Approved").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Sanitised Approver").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("AWAITING ALLOCATION")).not.toBeInTheDocument();
  });

  it("safely renders nullable rows, Decimal strings, fallbacks and invalid time", async () => {
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [
        activityRow({
          event_id: "indent:201",
          indent_id: 201,
          indent_no: "IND/SAFE/CREATED",
          event_type: "REQUEST_CREATED",
          event_label: null,
          result: "DRAFT",
          result_label: null,
          actor_name: "Safe Requester",
          actor_position: "Site Engineer",
          item_id: null,
          item_code: null,
          item_name: null,
          quantity: null,
          requested_quantity: null,
          remarks: null,
        }),
        activityRow({
          event_id: "workflow:202",
          indent_id: 202,
          indent_no: "IND/SAFE/WORKFLOW",
          event_type: "APPROVAL_COMPLETED",
          actor_name: "Workflow Approver",
          actor_position: "OE Review",
          item_id: null,
          item_code: null,
          item_name: null,
          quantity: undefined,
          requested_quantity: undefined,
        }),
        activityRow({
          event_id: "audit:203",
          indent_id: 203,
          indent_no: "IND/SAFE/BOOKMARK",
          event_type: "BOOKMARK_ADDED",
          event_label: null,
          result: "BOOKMARKED",
          result_label: null,
          actor_name: "Bookmark User",
          actor_position: null,
          quantity: 0,
          department_name: null,
          office_name: null,
          remarks: null,
        }),
        activityRow({
          event_id: "allocation:204:1",
          indent_id: 204,
          indent_no: "IND/SAFE/ALLOCATION",
          event_type: "STOCK_ALLOCATED",
          result: "PARTIALLY_ALLOCATED",
          result_label: null,
          item_name: "Safe Item",
          item_code: "SAFE-01",
          quantity: "12.0000",
          requested_quantity: "20.0000",
          uom_code: "g",
          remarks: "",
        }),
        activityRow({
          event_id: "material-request:205:1",
          indent_id: 205,
          indent_no: "IND/SAFE/PROCUREMENT",
          event_type: "PROCUREMENT_REQUEST_CREATED",
          event_label: null,
          result: "PENDING_APPROVAL",
          result_label: null,
          actor_name: null,
          actor_position: null,
          item_name: null,
          item_code: null,
          quantity: undefined,
          uom_code: null,
          department_name: null,
          office_name: null,
          remarks: null,
        }),
        activityRow({
          event_id: "workflow:206",
          indent_id: 206,
          indent_no: "IND/SAFE/AUTO",
          event_type: "APPROVAL_ROUTED_AUTOMATICALLY",
          event_label: null,
          result: "ROUTED_AUTOMATICALLY",
          result_label: null,
          actor_name: "System",
          actor_position: "Final Approval",
        }),
        activityRow({
          event_id: "unknown:207",
          indent_id: 207,
          indent_no: "IND/SAFE/UNKNOWN",
          event_type: "UNKNOWN_TECHNICAL_EVENT",
          event_label: null,
          result: "UNKNOWN_RESULT",
          result_label: null,
          occurred_at: "not-a-timestamp",
          actor_name: null,
          actor_position: null,
          item_name: null,
          quantity: null,
          department_name: null,
          office_name: null,
          remarks: null,
        }),
      ],
      total: 7,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect((await screen.findAllByText("IND/SAFE/CREATED")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Request created").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Safe Requester · Site Engineer").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Workflow Approver · OE Review").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Bookmark User").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("12 of 20 g").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Safe Item").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("SAFE-01").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Procurement request created").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Details unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("System · Final Approval").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Activity event").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Status unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Time unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("UNKNOWN_TECHNICAL_EVENT")).not.toBeInTheDocument();
    expect(screen.queryByText("UNKNOWN_RESULT")).not.toBeInTheDocument();
  });

  it("keeps Activity row navigation on the existing indent detail route", async () => {
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [activityRow()],
      total: 1,
      page: 1,
      size: 20,
    });
    renderWithProviders(
      <>
        <IndentReportsPage />
        <LocationProbe />
      </>,
      "/indents/reports",
    );

    const indentNumbers = await screen.findAllByText("IND/2026/0042");
    const mobileCard = indentNumbers
      .map((element) => element.closest("button"))
      .find((element): element is HTMLButtonElement => element !== null);
    expect(mobileCard).toBeDefined();
    fireEvent.click(mobileCard!);

    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42");
    });
  });

  it("keeps the Activity empty state and provides a retryable API error card", async () => {
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      size: 20,
    });
    const empty = renderWithProviders(<IndentReportsPage />, "/indents/reports");
    expect((await screen.findAllByText("No activity matches active filters.")).length)
      .toBeGreaterThanOrEqual(1);
    empty.unmount();

    const callsBeforeError = vi.mocked(indentApi.activity).mock.calls.length;
    vi.mocked(indentApi.activity)
      .mockRejectedValueOnce(new Error("Activity unavailable"))
      .mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        size: 20,
      });
    renderWithProviders(<IndentReportsPage />, "/indents/reports");
    expect(await screen.findByText("Unable to load activity ledger")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(indentApi.activity).toHaveBeenCalledTimes(callsBeforeError + 2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Unable to load activity ledger")).not.toBeInTheDocument();
    });
  });

  it("uses wrap-friendly toolbar layout for mobile widths", async () => {
    renderWithProviders(<IndentListPage />, "/indents");

    const search = await screen.findByRole("searchbox", { name: "Search indents" });
    expect(search.closest("section")?.firstElementChild).toHaveClass("flex-wrap");
    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    expect(screen.getByRole("dialog", { name: "Raised date filter" })).toHaveClass(
      "w-[calc(100vw-2rem)]",
      "max-w-96",
      "overflow-y-auto",
    );
  });

  it.each([
    ["Overview", <IndentDashboardPage />, "/indents/dashboard", true],
    ["All requests", <IndentListPage />, "/indents", true],
    ["Board", <IndentBoardPage />, "/indents/board", false],
  ])("shows required-by control on %s", async (_name, Page, route, separateDates) => {
    const view = renderWithProviders(Page, route);

    await screen.findByRole("searchbox", { name: "Search indents" });
    if (separateDates) {
      expect(screen.getByRole("button", { name: "Required by" })).toBeInTheDocument();
    } else {
      fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
      expect(screen.getByRole("button", { name: "Add required-by filter" })).toBeInTheDocument();
    }
    view.unmount();
  });

  it.each([
    ["Today"],
    ["This week"],
    ["This month"],
  ])("clears %s when clicked twice and resets pagination", (label) => {
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set page" }));
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent(/^1::\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("1:::");
    expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
  });

  it("clicking Custom twice clears From and To dates", () => {
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Raised from date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("Raised to date"), {
      target: { value: "2026-07-31" },
    });
    expect(screen.getByLabelText("filter state")).toHaveTextContent("1::2026-07-01:2026-07-31");

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("1:::");
    expect(screen.queryByLabelText("Raised from date")).not.toBeInTheDocument();
  });

  it("clearing a selected date preset removes API date params and resets pagination", async () => {
    vi.mocked(indentApi.list).mockResolvedValue({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 2,
        is_bookmarked: "NO",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 25,
      page: 1,
      size: 20,
    });
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 2 (25 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
    }), expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    let raisedDialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(raisedDialog).getByRole("button", { name: "Today" }));
    fireEvent.click(within(raisedDialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      created_date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      created_date_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }), expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    raisedDialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(raisedDialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByText("Raised: Today")).not.toBeInTheDocument());
    expect(screen.getByText("Page 1 of 2 (25 total)")).toBeInTheDocument();
  });

  it("calculates Raised and Required-by presets from the local calendar", () => {
    const localNow = new Date(2026, 6, 28, 23, 45);

    expect(getRaisedDateRange("today", localNow)).toEqual({
      from: "2026-07-28",
      to: "2026-07-28",
    });
    expect(getRaisedDateRange("this_week", localNow)).toEqual({
      from: "2026-07-27",
      to: "2026-07-28",
    });
    expect(getRaisedDateRange("this_month", localNow)).toEqual({
      from: "2026-07-01",
      to: "2026-07-28",
    });
    expect(getRequiredByDateRange("next_7_days", localNow)).toEqual({
      from: "2026-07-28",
      to: "2026-08-04",
    });
    expect(getRequiredByDateRange("next_30_days", localNow)).toEqual({
      from: "2026-07-28",
      to: "2026-08-27",
    });
  });

  it("keeps incomplete and invalid custom dates in the popup without requesting data", async () => {
    renderWithProviders(<IndentListPage />, "/indents");
    await screen.findByRole("button", { name: "Raised date" });
    const initialCalls = vi.mocked(indentApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    const dialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    expect(within(dialog).getByTestId("raised-date-grid")).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-2",
    );
    const from = within(dialog).getByLabelText("Raised date from");
    const to = within(dialog).getByLabelText("Raised date to");
    const apply = within(dialog).getByRole("button", { name: "Apply" });

    expect(screen.queryByText("When the requester needs the items.")).not.toBeInTheDocument();
    expect(apply).toBeDisabled();
    fireEvent.change(from, { target: { value: "2026-07-10" } });
    expect(to).toHaveAttribute("min", "2026-07-10");
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(indentApi.list).toHaveBeenCalledTimes(initialCalls);

    fireEvent.change(to, { target: { value: "2026-07-09" } });
    const error = screen.getByText("To date must be the same as or later than From date.");
    expect(to).toHaveAttribute("aria-invalid", "true");
    expect(to).toHaveAttribute("aria-describedby", error.id);
    expect(from).toHaveAttribute("max", "2026-07-09");
    expect(apply).toBeDisabled();
    expect(indentApi.list).toHaveBeenCalledTimes(initialCalls);

    fireEvent.change(to, { target: { value: "2026-07-20" } });
    fireEvent.change(from, { target: { value: "2026-07-21" } });
    expect(to).toHaveValue("");
    expect(to).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "Raised date filter" })).toBeInTheDocument();
    expect(apply).toBeDisabled();
    expect(indentApi.list).toHaveBeenCalledTimes(initialCalls);
  });

  it("applies one valid same-day Raised range and resets pagination once", async () => {
    vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
      items: [],
      total: 45,
      page: params.page ?? 1,
      size: params.size ?? 20,
    }));
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3 (45 total)")).toBeInTheDocument();
    const callsBeforeDraft = vi.mocked(indentApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    const dialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    fireEvent.change(within(dialog).getByLabelText("Raised date from"), {
      target: { value: "2026-07-31" },
    });
    fireEvent.change(within(dialog).getByLabelText("Raised date to"), {
      target: { value: "2026-07-31" },
    });

    expect(indentApi.list).toHaveBeenCalledTimes(callsBeforeDraft);
    const apply = within(dialog).getByRole("button", { name: "Apply" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(indentApi.list).toHaveBeenCalledTimes(callsBeforeDraft + 1);
    expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      created_date_from: "2026-07-31",
      created_date_to: "2026-07-31",
      page: 1,
    }), expect.anything());
    expect(screen.getByText("Raised: 31 Jul 2026 – 31 Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3 (45 total)")).toBeInTheDocument();
  });

  it("combines Raised and Required-by ranges, formats chips, and clears each independently", async () => {
    renderWithProviders(<IndentListPage />, "/indents");
    await screen.findByRole("button", { name: "Raised date" });

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    let dialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    fireEvent.change(within(dialog).getByLabelText("Raised date from"), { target: { value: "2026-07-01" } });
    fireEvent.change(within(dialog).getByLabelText("Raised date to"), { target: { value: "2026-07-31" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    fireEvent.click(screen.getByRole("button", { name: "Required by" }));
    dialog = screen.getByRole("dialog", { name: "Required by filter" });
    expect(within(dialog).getByText("When the requester needs the items.")).toBeInTheDocument();
    expect(within(dialog).queryByText("When the indent was created or raised.")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Custom range" }));
    fireEvent.change(within(dialog).getByLabelText("Required by from"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("Required by to"), { target: { value: "2026-08-10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      created_date_from: "2026-07-01",
      created_date_to: "2026-07-31",
      required_by_from: "2026-08-01",
      required_by_to: "2026-08-10",
      page: 1,
    }), expect.anything()));
    expect(screen.getByText("Raised: 01 Jul 2026 – 31 Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("Required by: 01 Aug 2026 – 10 Aug 2026")).toBeInTheDocument();
    expect(screen.queryByText(/2026-07-01 –/)).not.toBeInTheDocument();

    const chipCloseButtons = screen.getAllByRole("button", { name: "close chip" });
    expect(chipCloseButtons).toHaveLength(2);
    fireEvent.click(chipCloseButtons[0]);
    await waitFor(() => {
      const params = vi.mocked(indentApi.list).mock.calls.at(-1)?.[0];
      expect(params).not.toHaveProperty("created_date_from");
      expect(params).not.toHaveProperty("created_date_to");
      expect(params).toEqual(expect.objectContaining({
        required_by_from: "2026-08-01",
        required_by_to: "2026-08-10",
      }));
    });
    expect(screen.queryByText(/Raised:/)).not.toBeInTheDocument();
    expect(screen.getByText("Required by: 01 Aug 2026 – 10 Aug 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByText(/Required by:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raised date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Required by" })).toBeInTheDocument();
  });

  it("applies the same date presets to Overview stats and recent indents once", async () => {
    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");
    await screen.findByRole("button", { name: "Raised date" });
    const initialStatsCalls = vi.mocked(indentApi.stats).mock.calls.length;
    const initialListCalls = vi.mocked(indentApi.list).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Raised date" }));
    let dialog = screen.getByRole("dialog", { name: "Raised date filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "This month" }));
    expect(indentApi.stats).toHaveBeenCalledTimes(initialStatsCalls);
    expect(indentApi.list).toHaveBeenCalledTimes(initialListCalls);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(indentApi.stats).toHaveBeenCalledTimes(initialStatsCalls + 1);
    expect(indentApi.list).toHaveBeenCalledTimes(initialListCalls + 1);
    expect(screen.getByText("Raised: This month")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Required by" }));
    dialog = screen.getByRole("dialog", { name: "Required by filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next 7 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(indentApi.stats).toHaveBeenCalledTimes(initialStatsCalls + 2);
      expect(indentApi.list).toHaveBeenCalledTimes(initialListCalls + 2);
    });
    const statsParams = vi.mocked(indentApi.stats).mock.calls.at(-1)?.[0];
    const listParams = vi.mocked(indentApi.list).mock.calls.at(-1)?.[0];
    expect(statsParams).toEqual(expect.objectContaining({
      created_date_from: expect.any(String),
      created_date_to: expect.any(String),
      required_by_from: expect.any(String),
      required_by_to: expect.any(String),
    }));
    expect(listParams).toEqual(expect.objectContaining({ ...statsParams, size: 8 }));
    expect(screen.getByText("Required by: Next 7 days")).toBeInTheDocument();
  });

  it("shows the approved notification filter bar without advanced filters", async () => {
    renderWithProviders(<IndentNotificationsPage />, "/indents/notifications");
    await waitFor(() => expect(screen.queryByText("Loading notifications...")).not.toBeInTheDocument());
    expect(screen.getByRole("searchbox", { name: "Search notifications" })).toHaveAttribute(
      "placeholder",
      "Search by indent no., title or message...",
    );
    expect(screen.getByRole("button", { name: "Notification date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Priority/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^More filters/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(
      EXPECTED_REQUEST_STATUS_FILTERS.map(([label]) => label),
    );
  });

  it("uses final pre-UAT page headings", async () => {
    const board = renderWithProviders(<IndentBoardPage />, "/indents/board");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    board.unmount();

    const notifications = renderWithProviders(<IndentNotificationsPage />, "/indents/notifications");
    expect(await screen.findByRole("heading", { name: "Alert & Notification" })).toBeInTheDocument();
    notifications.unmount();
  });

  it("shows New indent only on Overview and All Requests", async () => {
    const overview = renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");
    expect(await screen.findByRole("button", { name: /New indent/i })).toBeInTheDocument();
    overview.unmount();

    const all = renderWithProviders(<IndentListPage />, "/indents");
    expect(await screen.findByRole("button", { name: /New indent/i })).toBeInTheDocument();
    all.unmount();

    const board = renderWithProviders(<IndentBoardPage />, "/indents/board");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New indent/i })).not.toBeInTheDocument();
    board.unmount();

    const activity = renderWithProviders(<IndentReportsPage />, "/indents/reports");
    expect(await screen.findByRole("heading", { name: "Activity ledger" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New indent/i })).not.toBeInTheDocument();
    activity.unmount();

    const notifications = renderWithProviders(<IndentNotificationsPage />, "/indents/notifications");
    expect(await screen.findByRole("heading", { name: "Alert & Notification" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New indent/i })).not.toBeInTheDocument();
    notifications.unmount();
  });

  it("uses local calendar dates for date presets around midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 0, 15));
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("2026-07-28:2026-07-28");

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("2026-07-27:2026-07-28");

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "This month" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("2026-07-01:2026-07-28");
  });

  it("uses backend status counts when the board preview has more pages", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 125,
      draft: 125,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 0,
      total_items: 125,
      total_qty: 125,
      approval_rate: 0,
      by_status: { DRAFT: 125 },
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 1,
        is_bookmarked: "YES",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 125,
      page: 1,
      size: 50,
    });

    renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(indentApi.list).toHaveBeenCalledWith(expect.objectContaining({ is_bookmarked: "YES" }));
    expect(indentApi.stats).toHaveBeenCalledWith(expect.objectContaining({ is_bookmarked: "YES" }));
    expect(screen.getByText("125")).toBeInTheDocument();
    expect(screen.getByText(/Column counts include all 125 matching requests/i)).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 125/i)).toBeInTheDocument();
  });

  it("start-aligns the Board grid while preserving mobile horizontal scrolling", async () => {
    const { container } = renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findAllByText("No pinned requests")).toHaveLength(6);

    const horizontalScroller = container.querySelector(".overflow-x-auto");
    const boardGrid = horizontalScroller?.firstElementChild;

    expect(horizontalScroller).toHaveClass(
      "-mx-4",
      "overflow-x-auto",
      "overflow-y-hidden",
      "px-4",
      "pb-3",
      "md:mx-0",
      "md:px-0",
    );
    expect(boardGrid).toHaveClass(
      "flex",
      "min-w-max",
      "items-start",
      "gap-4",
      "md:grid",
      "md:min-w-0",
      "md:grid-cols-6",
      "md:items-start",
    );
  });

  it("keeps Board columns, bodies and empty states at natural height", async () => {
    const { container } = renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findAllByText("No pinned requests")).toHaveLength(6);

    const columns = Array.from(container.querySelectorAll(".md\\:grid-cols-6 > section"));
    expect(columns).toHaveLength(6);

    columns.forEach((column) => {
      expect(column).toHaveClass("h-fit", "self-start");
      expect(column).not.toHaveClass("min-h-[26rem]", "h-full", "flex-1");

      const columnBody = column.children[1];
      expect(columnBody).toHaveClass("flex", "flex-col", "gap-3");
      expect(columnBody).not.toHaveClass("flex-1", "min-h-72");

      const emptyState = columnBody.firstElementChild;
      expect(emptyState).toHaveClass("min-h-52");
      expect(emptyState).not.toHaveClass("flex-1");
    });
  });

  it("keeps a one-card Board column compact with its count, pin and empty columns intact", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 1,
      draft: 1,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 1,
      total_items: 1,
      total_qty: 1,
      approval_rate: 0,
      by_status: { DRAFT: 1 },
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 1,
        is_bookmarked: "YES",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 50,
    });

    renderWithProviders(<IndentBoardPage />, "/indents/board");

    const cardNumber = await screen.findByText("IND/2026/0042");
    const draftColumn = screen.getByText("Draft").closest("section");
    expect(draftColumn).not.toBeNull();
    expect(draftColumn).toHaveClass("h-fit", "self-start");

    const draftBody = draftColumn!.children[1];
    expect(draftBody).toHaveClass("flex", "flex-col", "gap-3");
    expect(draftBody).not.toHaveClass("flex-1", "min-h-72");
    expect(cardNumber.closest("[role='button']")).toBeInTheDocument();
    expect(within(draftColumn!).getByText("1")).toBeInTheDocument();
    expect(within(draftColumn!).getByRole("button", { name: "Remove from Board" })).toBeInTheDocument();
    expect(within(draftColumn!).queryByText("No pinned requests")).not.toBeInTheDocument();
    expect(screen.getAllByText("No pinned requests")).toHaveLength(5);
    expect(screen.getAllByText("Pin a request from All requests")).toHaveLength(5);
  });

  it("keeps partially fulfilled and closed Board cards in mapped columns", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 2,
      draft: 0,
      awaiting_approval: 0,
      approved_active: 1,
      rejected: 0,
      ordered: 0,
      this_month: 2,
      total_items: 2,
      total_qty: 2,
      approval_rate: 100,
      by_status: { PARTIALLY_FULFILLED: 1, CLOSED: 1 },
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [
        {
          id: 42,
          indent_no: "IND/2026/PF",
          requested_by_name: "A Anil Kumar",
          department_name: "Operations",
          status: "PARTIALLY_FULFILLED",
          priority: "NORMAL",
          total_items: 1,
          is_bookmarked: "YES",
          created_at: "2026-07-27T10:30:00Z",
        },
        {
          id: 43,
          indent_no: "IND/2026/CL",
          requested_by_name: "A Anil Kumar",
          department_name: "Operations",
          status: "CLOSED",
          priority: "NORMAL",
          total_items: 1,
          is_bookmarked: "YES",
          created_at: "2026-07-27T10:31:00Z",
        },
      ],
      total: 2,
      page: 1,
      size: 50,
    });

    renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findByText("IND/2026/PF")).toBeInTheDocument();
    expect(screen.getByText("IND/2026/CL")).toBeInTheDocument();
    expect(screen.getByText("Partially Fulfilled")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("unpin removes a bookmarked indent from the Board", async () => {
    const unbookmark = deferred<Indent>();
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 1,
      draft: 1,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 1,
      total_items: 1,
      total_qty: 1,
      approval_rate: 0,
      by_status: { DRAFT: 1 },
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 1,
        is_bookmarked: "YES",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 50,
    });
    vi.mocked(indentApi.unbookmark).mockReturnValueOnce(unbookmark.promise);

    renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    const pin = screen.getByRole("button", { name: "Remove from Board" });
    fireEvent.click(pin);

    await waitFor(() => expect(indentApi.unbookmark).toHaveBeenCalledWith(42));
    expect(pin).toBeDisabled();
    expect(screen.getByText("IND/2026/0042").closest("[role='button']")).toHaveAttribute("data-removing", "true");
    await act(async () => {
      unbookmark.resolve(detailIndent({ is_bookmarked: "NO" }));
      await unbookmark.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    });
    await waitFor(() => expect(screen.queryByText("IND/2026/0042")).not.toBeInTheDocument());
    expect(screen.getAllByText("No pinned requests")).toHaveLength(6);
    expect(screen.getAllByText("Pin a request from All requests")).toHaveLength(6);
  });

  it("restores a Board card and shows an error when unpin fails", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 1,
      draft: 1,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 1,
      total_items: 1,
      total_qty: 1,
      approval_rate: 0,
      by_status: { DRAFT: 1 },
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 1,
        is_bookmarked: "YES",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 50,
    });
    vi.mocked(indentApi.unbookmark).mockRejectedValueOnce(new Error("nope"));

    renderWithProviders(<IndentBoardPage />, "/indents/board");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove from Board" }));

    expect(await screen.findByText("Could not update board bookmark. Please try again.")).toBeInTheDocument();
    expect(screen.getByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getByText("IND/2026/0042").closest("[role='button']")).toHaveAttribute("data-removing", "false");
  });

  it("debounces trimmed search and resets pagination", () => {
    vi.useFakeTimers();
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set page" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("3:");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "  IND-100  " },
    });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("3:");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("1:IND-100");

    fireEvent.click(screen.getByRole("button", { name: "Set page" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "  IND-100  " },
    });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("3:IND-100");
  });

  it("hides the native search cancel while the custom clear resets pagination", () => {
    vi.useFakeTimers();
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    const search = screen.getByRole("searchbox", { name: "Search indents" });
    expect(search).toHaveClass("[&::-webkit-search-cancel-button]:hidden");

    fireEvent.change(search, { target: { value: "IND-100" } });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole("button", { name: "Set page" }));
    expect(screen.getByLabelText("filter state")).toHaveTextContent("3:IND-100");

    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass("text-muted");
    fireEvent.click(clear);

    expect(search).toHaveValue("");
    expect(screen.getByLabelText("filter state")).toHaveTextContent("1::");
  });

  it("keeps required-by dates collapsed and resets pagination on raised date changes", () => {
    render(
      <IndentFilterProvider>
        <FilterHarness />
      </IndentFilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set page" }));
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));

    expect(screen.getByText("Raised date")).toBeInTheDocument();
    expect(screen.queryByText("Required-by date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Raised from date")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText("Raised from date"), {
      target: { value: "2026-07-01" },
    });

    expect(screen.getByLabelText("filter state")).toHaveTextContent("1:");

    fireEvent.click(screen.getByRole("button", { name: "Add required-by filter" }));
    expect(screen.getByText("Required-by date")).toBeInTheDocument();
    expect(screen.getByLabelText("Required by from")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  // Deciding on an indent belongs to the Approvals module; this page never offers it.
  it("never offers approve or reject, even when the server authorizes them", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({ can_approve: true, can_reject: true }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject/i })).not.toBeInTheDocument();
  });

  function rejectedJourney(stage: Partial<IndentJourney["stages"][number]>) {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "REJECTED",
      can_approve: false,
      can_reject: false,
    }));
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "REJECTED",
      current_stage: "Request rejected",
      current_stage_message: "Request rejected",
      stages: [{
        sequence: 2,
        title: "Approval",
        status: "REJECTED",
        timestamp: "2026-07-27T10:20:00Z",
        comments: "Incorrect quantity",
        stage_type: "approval",
        ...stage,
      }],
      history: [],
    }));
  }

  it.each([
    ["OE Review", null],
    ["Final Approval - COO", "COO"],
    ["Custom Assurance Gate", "ASSURANCE-AP-104"],
  ])("names the real rejecting approver for stage %s, whatever the ladder is called", async (title, positionName) => {
    rejectedJourney({ title, position_name: positionName, approver_name: "Rejecting Approver" });

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Rejected by Rejecting Approver")).toBeInTheDocument();
  });

  it("falls back to the rejecting position when no approver name was recorded", async () => {
    rejectedJourney({ title: "DM Review", position_name: "DISTRICT MANAGER-AP-104" });

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Rejected by DISTRICT MANAGER-AP-104")).toBeInTheDocument();
  });

  it("never invents a rejecting rank from the stage title alone", async () => {
    rejectedJourney({ title: "Final Approval - SPH or COO" });

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.queryByText(/Rejected by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SPH/)).not.toBeInTheDocument();
  });

  it("shows Draft actions in the detail header and navigates Edit Indent to edit mode", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "DRAFT",
      can_submit: true,
    }));

    renderWithProviders(
      <>
        <IndentDetailPage />
        <LocationProbe />
      </>,
      "/indents/42",
    );

    const edit = await screen.findByRole("button", { name: "Edit Indent" });
    expect(screen.getByRole("button", { name: "Delete Draft" })).toBeInTheDocument();

    fireEvent.click(edit);

    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("/indents/new?edit=42");
    });
  });

  it("keeps Edit Indent available for an owned draft opened from My Decisions", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "DRAFT",
      can_submit: true,
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42?decision=1");

    expect(await screen.findByRole("button", { name: "Edit Indent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject/i })).not.toBeInTheDocument();
  });

  it("hides Draft actions from a non-owner without delete permission", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "DRAFT",
      requested_by_id: 2,
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Indent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Draft" })).not.toBeInTheDocument();
  });

  it("shows Delete Draft to a permitted non-owner without exposing Edit Indent", async () => {
    mockAccount.canDeleteIndent = true;
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "DRAFT",
      requested_by_id: 2,
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByRole("button", { name: "Delete Draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Indent" })).not.toBeInTheDocument();
  });

  it("deletes a confirmed Draft and returns to All Requests", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      status: "DRAFT",
      can_submit: true,
    }));
    renderWithProviders(
      <>
        <IndentDetailPage />
        <AlertHost />
        <LocationProbe />
      </>,
      "/indents/42",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete Draft" }));

    // The app's own confirm now, not the browser's grey box, so the question is
    // answered on screen like every other destructive action in the app.
    fireEvent.click(await screen.findByRole("button", { name: "Yes, Delete" }));

    await waitFor(() => expect(indentApi.delete).toHaveBeenCalledWith(42));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents"));
  });

  it.each([
    "SUBMITTED",
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "AWAITING_ALLOCATION",
  ])("hides Draft actions for %s indents", async (status) => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({ status }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Indent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Draft" })).not.toBeInTheDocument();
  });

  it("keeps All Requests without an eye action column and opens detail on row click", async () => {
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: "A Anil Kumar",
        department_name: "Operations",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 2,
        is_bookmarked: "NO",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(
      <>
        <IndentListPage />
        <LocationProbe />
      </>,
      "/indents",
    );

    expect(await screen.findAllByText("IND/2026/0042")).not.toHaveLength(0);
    expect(screen.queryByRole("columnheader", { name: /action|view/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("IND/2026/0042")[0]);
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42"));
  });

  it("uses one fixed, aligned column layout for the All Requests header and rows", async () => {
    const requester = "A requester name long enough to test fixed table alignment";
    const department = "A department name long enough to test fixed table alignment";
    const region = "A region name long enough to test fixed table alignment";
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [{
        id: 42,
        indent_no: "IND/2026/0042",
        requested_by_name: requester,
        department_name: department,
        region_id: 654,
        region_name: region,
        status: "AWAITING_ALLOCATION",
        priority: "NORMAL",
        total_items: 17,
        is_bookmarked: "NO",
        created_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentListPage />, "/indents");

    const table = await screen.findByLabelText("List");
    await within(table).findByText(requester);
    const headers = within(table).getAllByRole("columnheader");
    const row = within(table).getByRole("row", { name: /IND\/2026\/0042/ });
    const cells = Array.from(row.querySelectorAll("td"));
    // Indent, Requested by, Department, Region, Items, Status, Raised. The lg widths
    // still add up to 100 with Region among them.
    const columnClasses = [
      ["w-[26%]", "lg:w-[16%]", "text-left"],
      ["w-0", "lg:w-[16%]", "text-left"],
      ["w-[30%]", "lg:w-[16%]", "text-left"],
      ["w-0", "lg:w-[16%]", "text-left"],
      ["w-[12%]", "lg:w-[8%]", "text-center"],
      ["w-[32%]", "lg:w-[16%]", "text-left"],
      ["w-0", "lg:w-[12%]", "text-left"],
    ];

    expect(table).toHaveClass("table-fixed");
    expect(headers).toHaveLength(columnClasses.length);
    expect(cells).toHaveLength(columnClasses.length);
    columnClasses.forEach((classes, index) => {
      expect(headers[index]).toHaveClass("px-4", "align-middle", ...classes);
      expect(cells[index]).toHaveClass("px-4", "align-middle", ...classes);
    });
    expect(within(cells[1]).getByText(requester)).toHaveClass("block", "truncate");
    expect(within(cells[2]).getByText(department)).toHaveClass("block", "truncate");
    expect(within(cells[3]).getByText(region)).toHaveClass("block", "truncate");
    expect(within(cells[4]).getByText("17")).toHaveClass("block", "tabular-nums");
    expect(within(cells[5]).getByText("AWAITING ALLOCATION")).toHaveClass("inline-flex");
  });

  it("shows the Region column on All Requests and a dash when HCM has no location", async () => {
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [
        {
          id: 42,
          indent_no: "IND/2026/0042",
          requested_by_name: "A Anil Kumar",
          department_name: "Networking department",
          region_id: 654,
          region_name: "104-MMU-AP-Hanumanthunipadu",
          status: "AWAITING_ALLOCATION",
          priority: "NORMAL",
          total_items: 3,
          is_bookmarked: "NO",
          created_at: "2026-07-27T10:30:00Z",
        },
        {
          // Raised by an employee HCM has no location for: 33 of the 296 live
          // indents are in this state, and they must still list.
          id: 43,
          indent_no: "IND/2026/0043",
          requested_by_name: "B Requester",
          department_name: "Networking department",
          region_id: null,
          region_name: null,
          status: "DRAFT",
          priority: "NORMAL",
          total_items: 1,
          is_bookmarked: "NO",
          created_at: "2026-07-27T10:31:00Z",
        },
      ],
      total: 2,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentListPage />, "/indents");

    const table = await screen.findByLabelText("List");
    expect(await within(table).findByText("104-MMU-AP-Hanumanthunipadu")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Region" })).toBeInTheDocument();
    const withoutRegion = within(table).getByRole("row", { name: /IND\/2026\/0043/ });
    expect(Array.from(withoutRegion.querySelectorAll("td"))[3]).toHaveTextContent("-");
  });

  it("sends the region filter from the URL to the list request", async () => {
    renderAllRequestsFlow("/indents?region_id=654&region_unassigned=1");

    await waitFor(() => expect(indentApi.list).toHaveBeenCalled());
    const [params] = vi.mocked(indentApi.list).mock.calls.at(-1)!;
    expect(params).toMatchObject({ region_id: [654], region_unassigned: true });
  });

  it("omits region parameters when no location filter is active", async () => {
    renderAllRequestsFlow("/indents");

    await waitFor(() => expect(indentApi.list).toHaveBeenCalled());
    const [params] = vi.mocked(indentApi.list).mock.calls.at(-1)!;
    expect(params).not.toHaveProperty("region_id");
    expect(params).not.toHaveProperty("region_unassigned");
  });

  it("offers the HCM locations plus an explicit no-location choice", async () => {
    renderAllRequestsFlow("/indents");

    fireEvent.click(await screen.findByRole("button", { name: /^Department/ }));

    // The menu is portalled out of the filter bar, so it is looked up on screen —
    // the same way the sibling test picks a region to filter by.
    expect(await screen.findByText("104-MMU-AP-Hanumanthunipadu")).toBeInTheDocument();
    expect(await screen.findByText("104-MMU-AP-Markapur")).toBeInTheDocument();
    // Region is nullable, so "no location" is a value a user can pick, not a gap.
    expect(await screen.findByText("No location")).toBeInTheDocument();
  });

  it("puts a chosen region into the URL so the filtered list can be shared", async () => {
    renderAllRequestsFlow("/indents");

    fireEvent.click(await screen.findByRole("button", { name: /^Department/ }));
    fireEvent.click(await screen.findByText("104-MMU-AP-Markapur"));

    await waitFor(() => expect(screen.getByLabelText("location"))
      .toHaveTextContent("region_id=937"));
  });

  it("sends the region filter from the URL to the activity ledger", async () => {
    renderActivityLedgerFlow("/indents/reports?region_id=654");

    await waitFor(() => expect(indentApi.activity).toHaveBeenCalled());
    const [params] = vi.mocked(indentApi.activity).mock.calls.at(-1)!;
    expect(params).toMatchObject({ region_id: [654] });
  });

  it("shows the Department of each activity ledger event, and no Region column", async () => {
    vi.mocked(indentApi.activity).mockResolvedValueOnce({
      items: [{
        event_id: "indent:42",
        indent_id: 42,
        indent_no: "IND/2026/0042",
        event_type: "REQUEST_CREATED",
        event_label: "Request created",
        result: "DRAFT",
        result_label: "Draft",
        occurred_at: "2026-07-27T10:30:00Z",
        department_name: "Networking department",
        office_name: "Regional Office",
        region_id: 654,
        region_name: "104-MMU-AP-Hanumanthunipadu",
        source_type: "ind_indents",
        source_id: 42,
      }] as ActivityRow[],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("columnheader", { name: "DEPARTMENT" })).toBeInTheDocument();
    // Twice: ResponsiveList keeps the desktop table and the mobile card both mounted.
    expect(await screen.findAllByText("Networking department")).toHaveLength(2);
    expect(screen.queryByRole("columnheader", { name: "REGION" })).not.toBeInTheDocument();
  });

  it("sends the region filter to the statistics request", async () => {
    renderWithProviders(<IndentDashboardPage />, "/indents/overview");

    await waitFor(() => expect(indentApi.stats).toHaveBeenCalled());
    vi.mocked(indentApi.stats).mockClear();
    fireEvent.click(await screen.findByRole("button", { name: /^Department/ }));
    fireEvent.click(await screen.findByText("104-MMU-AP-Markapur"));

    await waitFor(() => {
      const [params] = vi.mocked(indentApi.stats).mock.calls.at(-1)!;
      expect(params).toMatchObject({ region_id: [937] });
    });
  });

  it("does not show Region / Location on the detail screen", async () => {
    vi.mocked(indentApi.get).mockResolvedValue(detailIndent({
      region_id: 654,
      region_name: "104-MMU-AP-Hanumanthunipadu",
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Deliver to")).toBeInTheDocument();
    expect(screen.queryByText("Region / Location")).not.toBeInTheDocument();
    expect(screen.queryByText("104-MMU-AP-Hanumanthunipadu")).not.toBeInTheDocument();
  });

  it("does not render a region breakdown on the dashboard", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce({
      total: 10,
      draft: 0,
      awaiting_approval: 0,
      approved_active: 0,
      rejected: 0,
      ordered: 0,
      this_month: 0,
      total_items: 0,
      total_qty: 0,
      approval_rate: 0,
      by_status: {},
      by_region: [
        { region_id: 654, region_name: "104-MMU-AP-Hanumanthunipadu", count: 7 },
        { region_id: null, region_name: null, count: 3 },
      ],
    } as IndentStats);

    renderWithProviders(<IndentDashboardPage />, "/indents/overview");

    await waitFor(() => expect(indentApi.stats).toHaveBeenCalled());
    expect(screen.queryByRole("list", { name: "Indents by region" })).not.toBeInTheDocument();
    expect(screen.queryByText("By region / location")).not.toBeInTheDocument();
  });

  it("does not render pin controls for any indent in All Requests", async () => {
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [
        {
          id: 42,
          indent_no: "IND/2026/0042",
          requested_by_name: "A Anil Kumar",
          department_name: "Operations",
          status: "DRAFT",
          priority: "NORMAL",
          total_items: 2,
          is_bookmarked: "NO",
          created_at: "2026-07-27T10:30:00Z",
        },
        {
          id: 43,
          indent_no: "IND/2026/0043",
          requested_by_name: "B Bala Kumar",
          department_name: "Operations",
          status: "ALLOCATED",
          priority: "NORMAL",
          total_items: 1,
          is_bookmarked: "YES",
          created_at: "2026-07-27T11:30:00Z",
        },
      ],
      total: 2,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findAllByText("IND/2026/0042")).not.toHaveLength(0);
    expect(screen.getAllByText("IND/2026/0043")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add to Board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from Board" })).not.toBeInTheDocument();
    expect(indentApi.bookmark).not.toHaveBeenCalled();
    expect(indentApi.unbookmark).not.toHaveBeenCalled();
  });

  it("uses the summary status palette in All Requests", async () => {
    const statuses = [
      "ALLOCATED",
      "AWAITING_ALLOCATION",
      "PARTIALLY_FULFILLED",
      "CLOSED",
      "DRAFT",
      "PENDING_APPROVAL",
      "REJECTED",
      "APPROVED",
    ];
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: statuses.map((status, index) => ({
        id: 100 + index,
        indent_no: `IND/2026/${String(100 + index).padStart(4, "0")}`,
        requested_by_name: "Allocation User",
        department_name: "Operations",
        status,
        priority: "NORMAL",
        total_items: 1,
        is_bookmarked: "NO",
        created_at: "2026-07-27T10:30:00Z",
      })),
      total: statuses.length,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentListPage />, "/indents");

    for (const badge of await screen.findAllByText("ALLOCATED")) {
      expect(badge).toHaveClass("bg-purple-50", "text-purple-600");
      expect(badge).not.toHaveClass("bg-ok-bg", "text-ok");
    }
    for (const badge of screen.getAllByText("AWAITING ALLOCATION")) {
      expect(badge).toHaveClass("bg-info-bg", "text-info");
      expect(badge).not.toHaveClass("bg-ok-bg", "text-ok");
    }
    for (const badge of screen.getAllByText("PARTIALLY FULFILLED")) {
      expect(badge).toHaveClass("bg-warn-bg", "text-warn");
    }
    for (const badge of screen.getAllByText("FULFILLED")) {
      expect(badge).toHaveClass("bg-ok-bg", "text-ok");
    }
    expect(screen.queryByText("CLOSED")).not.toBeInTheDocument();
    for (const label of ["DRAFT", "PENDING APPROVAL", "REJECTED", "APPROVED"]) {
      for (const badgeContent of screen.getAllByText(label)) {
        expect(badgeContent).not.toHaveClass(
          "bg-ok-bg",
          "text-ok",
          "bg-info-bg",
          "text-info",
          "bg-purple-50",
          "text-purple-600",
          "bg-warn-bg",
          "text-warn",
        );
      }
    }
  });

  it("opens the complete indent journey from the progress card by click and keyboard", async () => {
    vi.mocked(indentApi.get)
      .mockResolvedValueOnce(detailIndent())
      .mockResolvedValueOnce(detailIndent({ id: 43, indent_no: "IND/2026/0043" }));

    const { unmount } = renderWithProviders(
      <>
        <IndentDetailPage />
        <LocationProbe />
      </>,
      "/indents/42",
    );
    const card = await screen.findByRole("button", {
      name: "View complete indent journey for IND/2026/0042",
    });
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42/journey"));
    unmount();

    renderWithProviders(
      <>
        <IndentDetailPage />
        <LocationProbe />
      </>,
      "/indents/43",
    );
    const keyboardCard = await screen.findByRole("button", {
      name: "View complete indent journey for IND/2026/0043",
    });
    keyboardCard.focus();
    fireEvent.keyDown(keyboardCard, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/43/journey"));
  });

  it("prefetches the approval journey after detail loads", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent());

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
    expect(indentApi.journey).toHaveBeenCalledWith(42, expect.any(AbortSignal));
  });

  it.each([
    // Title only: the one edit is dropping a trailing "Review"/"Approval".
    [{ title: "OE Review" }, "Pending at OE"],
    [{ title: "Custom Budget Approval" }, "Pending at Custom Budget"],
    [{ title: "Final Approval - SPH/COO" }, "Pending at Final Approval - SPH/COO"],
    // The rung wins over the person holding it.
    [{ title: "", position_name: "AREA COORDINATOR-AP-104" }, "Pending at AREA COORDINATOR-AP-104"],
    [{ title: "COO Approval", position_name: "COO", approver_name: "C Ramakrishna" },
      "Pending at COO"],
    [{ title: "", approver_name: "C Ramakrishna" }, "Pending at C Ramakrishna"],
  ])("names the current ladder rung %o in the pending detail badge", async (stage, badgeLabel) => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "PENDING_APPROVAL",
      stages: [
        {
          sequence: 1,
          title: "OE Review",
          status: "APPROVED",
          stage_type: "approval",
        },
        {
          sequence: 2,
          status: "PENDING",
          is_current: true,
          stage_type: "approval",
          ...stage,
        },
      ],
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText(badgeLabel)).toBeInTheDocument();
    expect(screen.queryByText("Pending Approval")).not.toBeInTheDocument();
  });

  it("keeps the pending detail badge fallback when no journey stage is current", async () => {
    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Pending Approval")).toBeInTheDocument();
  });

  it.each([
    ["DRAFT", "DRAFT"],
    ["APPROVED", "APPROVED"],
    ["REJECTED", "REJECTED"],
    ["AWAITING_ALLOCATION", "AWAITING ALLOCATION"],
  ])("keeps the %s detail badge unchanged", async (status, label) => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({ status }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("shows progress loading on first detail open, then renders seven journey phases", async () => {
    const journeyRequest = deferred<IndentJourney>();
    vi.mocked(indentApi.journey).mockReturnValueOnce(journeyRequest.promise);

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading approval progress" })).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();

    await act(async () => {
      journeyRequest.resolve(journeyData());
      await journeyRequest.promise;
    });

    expect(await screen.findByText("Allocation")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
  });

  it("keeps cached detail progress visible during a journey refetch", async () => {
    const client = createTestQueryClient();
    const refresh = deferred<IndentJourney>();
    const scope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.journey(scope, 42), journeyData());
    await client.invalidateQueries({ queryKey: indentKeys.journey(scope, 42), refetchType: "none" });
    vi.mocked(indentApi.journey).mockReturnValueOnce(refresh.promise);

    renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    expect(await screen.findByText("Allocation")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();

    await act(async () => {
      refresh.resolve(journeyData({ current_stage_message: "Approval completed" }));
      await refresh.promise;
    });
  });

  it("ignores the legacy six-phase cache key and fetches the versioned Journey contract", async () => {
    const client = createTestQueryClient();
    const scope = { employeeId: 1, activePositionId: 10 };
    const legacyKey = [...indentKeys.all(scope), "journey", 42] as const;
    client.setQueryData(legacyKey, journeyData({
      status: "PENDING_APPROVAL",
      phases: [
        { sequence: 1, title: "Request", status: "APPROVED", stage_type: "phase" },
        { sequence: 2, title: "Approvals", status: "PENDING", stage_type: "phase", is_current: true },
        { sequence: 3, title: "Allocation", status: "PENDING", stage_type: "phase" },
        { sequence: 4, title: "Warehouse", status: "PENDING", stage_type: "phase" },
        { sequence: 5, title: "Delivery", status: "PENDING", stage_type: "phase" },
        { sequence: 6, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
      ],
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Stage 4 of 7 · Allocation")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
    expect(client.getQueryData(indentKeys.journey(scope, 42))).toEqual(journeyData());
  });

  it("shows unavailable after the detail journey request fails", async () => {
    vi.mocked(indentApi.journey).mockRejectedValueOnce(new Error("Journey request failed"));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
  });

  it("uses a safe broad fallback for a recognised response with incomplete phases", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({ phases: [] }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Stage 4 of 7 · Allocation")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
  });

  it("shows unavailable for a genuinely malformed unrecognised response", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "SOMETHING_NEW",
      phases: [],
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading approval progress" })).not.toBeInTheDocument();
  });

  it("retains the prefetched journey while actively refreshing on page open", async () => {
    const client = createTestQueryClient();
    const first = renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
    first.unmount();

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey", client);

    expect(await screen.findByText("OE Review")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(2));
  });

  it("does not duplicate journey requests on progress card interactions", async () => {
    renderWithProviders(<IndentDetailPage />, "/indents/42");

    const card = await screen.findByRole("button", {
      name: "View complete indent journey for IND/2026/0042",
    });
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));

    fireEvent.pointerEnter(card);
    fireEvent.focus(card);
    fireEvent.pointerDown(card);

    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
  });

  it("updates the detail cache from submit response and triggers background journey refetch", async () => {
    const client = createTestQueryClient();
    const nextIndent = detailIndent({ status: "PENDING_APPROVAL", can_submit: false });
    const submission = deferred<Indent>();
    const detailRefresh = deferred<Indent>();
    const journeyRefresh = deferred<IndentJourney>();
    vi.mocked(indentApi.get)
      .mockResolvedValueOnce(detailIndent({ status: "DRAFT", can_submit: true }))
      .mockReturnValueOnce(detailRefresh.promise);
    vi.mocked(indentApi.submit).mockReturnValueOnce(submission.promise);
    vi.mocked(indentApi.journey).mockReturnValueOnce(journeyRefresh.promise);
    const scope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.journey(scope, 42), journeyData({ status: "DRAFT" }));

    renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    const submitButton = await screen.findByRole("button", { name: /Submit for approval/i });
    await waitFor(() => {
      expect(client.getQueryCache().find({
        queryKey: indentKeys.journey(scope, 42),
      })?.getObserversCount()).toBe(1);
    });
    expect(indentApi.journey).not.toHaveBeenCalled();

    fireEvent.click(submitButton);
    const pendingButton = await screen.findByRole("button", { name: /Submitting/i });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(indentApi.submit).toHaveBeenCalledTimes(1);
    expect(indentApi.submit).toHaveBeenCalledWith(42);

    await act(async () => {
      submission.resolve(nextIndent);
      await submission.promise;
    });
    await waitFor(() => {
      expect(client.getQueryData<Indent>(indentKeys.detail(scope, 42))?.status).toBe("PENDING_APPROVAL");
    });
    expect(screen.getByText("Pending Approval")).toBeInTheDocument();
    expect(screen.getByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();

    expect(client.getQueryState(indentKeys.journey(scope, 42))?.isInvalidated).toBe(true);
    expect(indentApi.journey).toHaveBeenCalledTimes(1);
    expect(indentApi.journey).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    await act(async () => {
      detailRefresh.resolve(nextIndent);
      journeyRefresh.resolve(journeyData({ status: "PENDING_APPROVAL" }));
      await Promise.all([detailRefresh.promise, journeyRefresh.promise]);
    });
  });

  it("keeps cached journey content visible during background refetch", async () => {
    const client = createTestQueryClient();
    const refresh = deferred<IndentJourney>();
    const scope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.journey(scope, 42), journeyData());
    await client.invalidateQueries({ queryKey: indentKeys.journey(scope, 42), refetchType: "none" });
    vi.mocked(indentApi.journey).mockReturnValueOnce(refresh.promise);

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey", client);

    expect(await screen.findByText("OE Review")).toBeInTheDocument();
    expect(screen.getByText("Refreshing journey...")).toBeInTheDocument();
    refresh.resolve(journeyData({ current_stage_message: "Approval completed" }));
  });

  it("clears cached indent records on employee or active-position switch", async () => {
    const client = createTestQueryClient();
    const firstScope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.detail(firstScope, 42), detailIndent({ indent_no: "IND/OLD" }));
    vi.mocked(indentApi.get).mockResolvedValue(detailIndent({ indent_no: "IND/NEW" }));

    const view = renderWithProviders(<IndentDetailPage />, "/indents/42", client);
    expect(await screen.findByText("IND/OLD")).toBeInTheDocument();

    mockAccount.employeeId = 2;
    mockAccount.activePositionId = 20;
    view.rerender(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/indents/42"]}>
            <Routes>
              <Route path="/indents/:id" element={<IndentDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.queryByText("IND/OLD")).not.toBeInTheDocument());
    expect(await screen.findByText("IND/NEW")).toBeInTheDocument();
    expect(client.getQueryData(indentKeys.detail(firstScope, 42))).toBeUndefined();
  });

  it("does not display stale cached detail after a denied refetch", async () => {
    const client = createTestQueryClient();
    const scope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.detail(scope, 42), detailIndent({ indent_no: "IND/STALE" }));
    await client.invalidateQueries({ queryKey: indentKeys.detail(scope, 42), refetchType: "none" });
    vi.mocked(indentApi.get).mockRejectedValueOnce({ response: { status: 403 } });

    renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    expect(await screen.findByText("This indent is not available to your current account")).toBeInTheDocument();
    expect(screen.queryByText("IND/STALE")).not.toBeInTheDocument();
    expect(client.getQueryData(indentKeys.detail(scope, 42))).toBeUndefined();
    expect(screen.getByRole("button", { name: /Back to All requests/i })).toBeInTheDocument();
  });

  it("renders every resolved ladder rung and explains the ANY_ONE outcome", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData());

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getByText("OE Review")).toBeInTheDocument();
    expect(screen.getByText("DM Review")).toBeInTheDocument();
    expect(screen.getByText("Final Approval - SPH or COO")).toBeInTheDocument();
    // The stood-down ANY_ONE peer is the only thing that explains why one
    // authority acted and its peers never did, so it must stay visible.
    expect(screen.getByText("COO Authority")).toBeInTheDocument();
    expect(screen.getByText("Not required")).toBeInTheDocument();
    expect(screen.getByText("Final approval · Approved by SPH")).toBeInTheDocument();
    // Header message plus the "Still to come" card for the same stage.
    expect(screen.getAllByText("Ready for Allocation")).toHaveLength(2);
    expect(screen.getByText("OE approval completed")).toBeInTheDocument();
    expect(screen.getByText("Approved by C Ramakrishna")).toBeInTheDocument();
    expect(within(screen.getByText("Draft created").closest("article")!).getByText("Completed")).toBeInTheDocument();
    expect(within(screen.getByRole("heading", { name: "Request submitted" }).closest("article")!).getByText("Completed")).toBeInTheDocument();
  });

  it("shows only genuine creation evidence for an unsubmitted draft", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "DRAFT",
      current_stage: "Draft — submit the indent to begin approval",
      current_stage_message: "Draft — submit the indent to begin approval",
      phases: [
        { sequence: 1, title: "Draft", status: "PENDING", stage_type: "phase", is_current: true },
        { sequence: 2, title: "Submitted", status: "PENDING", stage_type: "phase" },
        { sequence: 3, title: "Approvals", status: "PENDING", stage_type: "phase" },
        { sequence: 4, title: "Allocation", status: "PENDING", stage_type: "phase" },
        { sequence: 5, title: "Warehouse", status: "PENDING", stage_type: "phase" },
        { sequence: 6, title: "Delivery", status: "PENDING", stage_type: "phase" },
        { sequence: 7, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
      ],
      stages: [
        {
          sequence: 1,
          title: "Draft created",
          status: "COMPLETED",
          approver_name: "A Anil Kumar",
          position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "draft",
          is_current: false,
        },
      ],
      history: [{
        id: "indent:42:created",
        event_type: "CREATED",
        title: "Draft created",
        actor_name: "A Anil Kumar",
        position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
        timestamp: "2026-07-27T09:30:00Z",
      }],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const draftCard = (await screen.findByRole("heading", { name: "Draft created" })).closest("article");
    expect(draftCard).toHaveTextContent("Completed");
    expect(draftCard).toHaveTextContent("A Anil Kumar · DRIVER-AP-104-MMU-CHILMATHUR");
    expect(screen.queryByRole("heading", { name: "Request submitted" })).not.toBeInTheDocument();
    expect(screen.queryByText("OE Review")).not.toBeInTheDocument();
  });

  it("renders separate post-allocation batches and the outstanding wait card", async () => {
    const occurred = [
      { title: "Draft created", stage_type: "draft", timestamp: "2026-07-27T09:00:00Z" },
      { title: "Request submitted", stage_type: "submission", timestamp: "2026-07-27T09:05:00Z", status: "SUBMITTED" },
      { title: "Approval completed", stage_type: "approval", timestamp: "2026-07-27T10:00:00Z" },
      { title: "Stock allocated", stage_type: "allocation", timestamp: "2026-07-27T11:00:00Z", reference_no: "ALLOC-1", quantity_summary: "6 allocated" },
      { title: "Issued from warehouse", stage_type: "warehouse", timestamp: "2026-07-27T12:00:00Z", reference_no: "ISS-1", quantity_summary: "6 issued" },
      { title: "Dispatched", stage_type: "delivery", timestamp: "2026-07-27T13:00:00Z", reference_no: "DSP-1", quantity_summary: "3 dispatched" },
      { title: "Delivered", stage_type: "delivery", timestamp: "2026-07-27T14:00:00Z", reference_no: "DSP-1", quantity_summary: "3 delivered" },
      { title: "Acknowledgement submitted", stage_type: "acknowledgement", timestamp: "2026-07-27T15:00:00Z", quantity_summary: "3 received" },
      { title: "Partially received", stage_type: "acknowledgement", timestamp: "2026-07-27T15:00:00Z", quantity_summary: "3 received" },
      { title: "Dispatched", stage_type: "delivery", timestamp: "2026-07-28T09:00:00Z", reference_no: "DSP-2", quantity_summary: "3 dispatched" },
      { title: "Delivered", stage_type: "delivery", timestamp: "2026-07-28T10:00:00Z", reference_no: "DSP-2", quantity_summary: "3 delivered" },
    ];
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "PARTIALLY_FULFILLED",
      current_stage_message: "Waiting for acknowledgement",
      stages: [
        ...occurred.map((stage, index) => ({
          ...stage,
          sequence: index + 1,
          status: stage.status ?? "APPROVED",
          is_current: false,
        })),
        {
          sequence: occurred.length + 1,
          title: "Waiting for acknowledgement",
          status: "PENDING",
          stage_type: "acknowledgement",
          is_current: true,
        },
      ],
      history: [],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findAllByRole("heading", { name: "Delivered" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "Dispatched" })).toHaveLength(2);
    expect(screen.getByText("Ref ALLOC-1")).toBeInTheDocument();
    expect(screen.getAllByText("3 received")).toHaveLength(2);
    // What is still owed is stated once, under "Still to come".
    expect(screen.getByText("Still to come")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for acknowledgement" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fully received" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Completed" })).not.toBeInTheDocument();
  });

  it("uses phase aggregation on detail and the dynamic stages on complete journey", async () => {
    const client = createTestQueryClient();
    const dynamicJourney = journeyData({
      status: "PENDING_APPROVAL",
      current_stage: "Waiting for final approval",
      current_stage_message: "Waiting for final approval",
      phases: [
        { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "phase" },
        { sequence: 2, title: "Submitted", status: "APPROVED", stage_type: "phase" },
        { sequence: 3, title: "Approvals", status: "PENDING", stage_type: "phase", is_current: true, approver_name: "Final Approval - SPH/COO" },
        { sequence: 4, title: "Allocation", status: "PENDING", stage_type: "phase" },
        { sequence: 5, title: "Warehouse", status: "PENDING", stage_type: "phase" },
        { sequence: 6, title: "Delivery", status: "PENDING", stage_type: "phase" },
        { sequence: 7, title: "Acknowledgement", status: "PENDING", stage_type: "phase" },
      ],
      stages: [
        {
          sequence: 1,
          title: "Draft created",
          status: "APPROVED",
          approver_name: "A Anil Kumar",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "draft",
          is_current: false,
        },
        {
          sequence: 2,
          title: "Request submitted",
          status: "SUBMITTED",
          approver_name: "A Anil Kumar",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "submission",
          is_current: false,
        },
        {
          sequence: 3,
          title: "OE Review",
          status: "APPROVED",
          approver_name: "C Ramakrishna",
          position_name: "OE-AP-104-MMU-Hindupur",
          timestamp: "2026-07-27T10:00:00Z",
          stage_type: "approval",
          is_current: false,
        },
        {
          sequence: 4,
          title: "Final Approval - SPH/COO",
          status: "PENDING",
          approver_name: "SPH / COO",
          stage_type: "final",
          is_current: true,
        },
      ],
    });
    vi.mocked(indentApi.journey).mockResolvedValue(dynamicJourney);

    const detail = renderWithProviders(
      <IndentDetailPage />,
      "/indents/42",
      client,
    );

    expect(await screen.findByText("Approvals")).toBeInTheDocument();
    expect(screen.getByText("Final Approval - SPH/COO")).toBeInTheDocument();
    expect(screen.getByText("Pending at SPH / COO")).toBeInTheDocument();
    // The ladder position is counted from the resolved chain, not assumed.
    expect(screen.getByText("Approval 2 of 2 · SPH / COO")).toBeInTheDocument();
    expect(screen.queryByText("Pending Approval")).not.toBeInTheDocument();
    expect(screen.queryByText("OE Review")).not.toBeInTheDocument();
    detail.unmount();

    renderWithProviders(
      <IndentJourneyPage />,
      "/indents/42/journey",
      client,
    );

    expect(await screen.findByText("OE Review")).toBeInTheDocument();
    // The rung that holds the indent now is named on the journey too.
    expect(screen.getByRole("heading", { name: "Final Approval - SPH/COO" })).toBeInTheDocument();
    expect(screen.getByText("Still to come")).toBeInTheDocument();
    expect(screen.getByText("Pending at SPH / COO")).toBeInTheDocument();
    expect(screen.queryByText("Pending Approval")).not.toBeInTheDocument();
    expect(screen.queryByText("DM Review")).not.toBeInTheDocument();
    expect(screen.queryByText("RM Review")).not.toBeInTheDocument();
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(2));
  });

  it("keeps Pending Approval in the complete journey header when no stage is current", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "PENDING_APPROVAL",
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText("Pending Approval")).toBeInTheDocument();
  });

  it("shows the saved reason only inside the actual rejected journey stage", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "REJECTED",
      current_stage: "Request rejected",
      current_stage_message: "Request rejected",
      stages: [
        {
          sequence: 1,
          title: "OE Review",
          status: "APPROVED",
          approver_name: "OE Approver",
          timestamp: "2026-07-27T10:00:00Z",
          comments: "Approved after review",
          stage_type: "approval",
        },
        {
          sequence: 2,
          title: "Regional Manager Review",
          status: "REJECTED",
          approver_name: "RM Approver",
          timestamp: "2026-07-27T10:20:00Z",
          comments: "Incorrect quantity",
          stage_type: "approval",
        },
      ],
      history: [{
        id: "workflow:rejected",
        event_type: "REJECTED",
        title: "Regional Manager rejected",
        description: "Rejected by RM Approver",
        actor_name: "RM Approver",
        position_name: "Regional Manager",
        timestamp: "2026-07-27T10:20:00Z",
        comments: "Incorrect quantity",
      }],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const rejectedCard = (await screen.findByText("Regional Manager Review")).closest("article");
    const approvedCard = screen.getByText("OE Review").closest("article");
    expect(rejectedCard).not.toBeNull();
    expect(approvedCard).not.toBeNull();
    expect(within(rejectedCard!).getByText("RM Approver")).toBeInTheDocument();
    expect(within(rejectedCard!).getByText("Rejected")).toBeInTheDocument();
    const reasonLabel = within(rejectedCard!).getByText("Rejection reason");
    const reasonText = within(rejectedCard!).getByText("Incorrect quantity");
    expect(reasonLabel).toHaveClass("font-semibold", "uppercase", "text-bad");
    expect(reasonText).toHaveClass("break-words", "font-medium", "leading-5", "text-body");
    expect(within(approvedCard!).queryByText("Rejection reason")).not.toBeInTheDocument();
    const historyCard = screen.getByText("Regional Manager rejected").closest("article");
    expect(historyCard).not.toBeNull();
    expect(within(historyCard!).getByText("Incorrect quantity")).toBeInTheDocument();
    expect(screen.getAllByText("Incorrect quantity")).toHaveLength(2);
    expect(within(approvedCard!).getByText("Approved after review")).toBeInTheDocument();
  });

  it("shows a correction request without dressing it up as a rejection", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "RETURNED",
      current_stage: "Returned for correction",
      current_stage_message: "Returned for correction",
      final_any_one_outcome: null,
      stages: [{
        sequence: 3,
        title: "DM Review",
        status: "RETURNED",
        approver_name: "A Raveendra Prasad",
        position_name: "District Manager",
        timestamp: "2026-07-27T10:20:00Z",
        comments: "Quantity looks wrong, please revise and resubmit",
        stage_type: "approval",
      }],
      history: [],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const card = (await screen.findByRole("heading", { name: "DM Review" })).closest("article");
    expect(within(card!).getByText("Correction requested")).toBeInTheDocument();
    expect(within(card!).getByText("Quantity looks wrong, please revise and resubmit")).toBeInTheDocument();
    expect(within(card!).queryByText("Rejection reason")).not.toBeInTheDocument();
    expect(within(card!).getByText("Returned")).toBeInTheDocument();
    expect(screen.getByText("Returned by A Raveendra Prasad")).toBeInTheDocument();
  });

  it("warns when the journey was built from incomplete sources", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      missing_sources: ["warehouse issues", "dispatches"],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText(
      /Some records could not be read \(warehouse issues, dispatches\)/,
    )).toBeInTheDocument();
  });

  it("does not display missing records warning banner when indent is at allocation stage", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "AWAITING_ALLOCATION",
      current_stage_message: "Waiting for allocation",
      phases: [
        { sequence: 1, title: "Draft", status: "APPROVED", is_current: false, stage_type: "phase" },
        { sequence: 2, title: "Submitted", status: "APPROVED", is_current: false, stage_type: "phase" },
        { sequence: 3, title: "Approvals", status: "APPROVED", is_current: false, stage_type: "phase" },
        { sequence: 4, title: "Allocation", status: "PENDING", is_current: true, stage_type: "phase" },
        { sequence: 5, title: "Warehouse", status: "PENDING", is_current: false, stage_type: "phase" },
        { sequence: 6, title: "Delivery", status: "PENDING", is_current: false, stage_type: "phase" },
        { sequence: 7, title: "Acknowledgement", status: "PENDING", is_current: false, stage_type: "phase" },
      ],
      missing_sources: ["inv_allocations.status=APPROVED and approved_at"],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for allocation").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Some records could not be read/)).not.toBeInTheDocument();
  });

  it("offers a retry instead of an endless skeleton when the journey fails", async () => {
    vi.mocked(indentApi.journey).mockRejectedValueOnce(new Error("Journey service unavailable"));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText("The indent journey could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Journey service unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
  });

  it("offers a retry instead of an endless skeleton when the indent fails to load", async () => {
    vi.mocked(indentApi.get).mockRejectedValueOnce(new Error("Detail service unavailable"));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("This indent could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Detail service unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
  });

  it("orders the timeline chronologically whatever order the API returns", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      stages: [
        { sequence: 3, title: "Third", status: "APPROVED", timestamp: "2026-07-27T12:00:00Z", stage_type: "approval" },
        { sequence: 1, title: "First", status: "COMPLETED", timestamp: "2026-07-27T09:00:00Z", stage_type: "draft" },
        { sequence: 2, title: "Second", status: "SUBMITTED", timestamp: "2026-07-27T10:00:00Z", stage_type: "submission" },
      ],
      history: [],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const timeline = await screen.findByRole("list", { name: "Complete indent journey timeline" });
    expect(within(timeline).getAllByRole("heading").map((row) => row.textContent))
      .toEqual(["First", "Second", "Third"]);
  });

  it("shows a fallback reason for older rejected journey stages", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      status: "REJECTED",
      current_stage: "Request rejected",
      current_stage_message: "Request rejected",
      stages: [{
        sequence: 1,
        title: "Dynamic Approval Stage",
        status: "REJECTED",
        approver_name: "Approver",
        timestamp: "2026-07-27T10:20:00Z",
        comments: "   ",
        stage_type: "approval",
      }],
      history: [],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const rejectedCard = (await screen.findByText("Dynamic Approval Stage")).closest("article");
    expect(rejectedCard).not.toBeNull();
    expect(within(rejectedCard!).getByText("Rejection reason")).toBeInTheDocument();
    expect(within(rejectedCard!).getByText("Not provided")).toBeInTheDocument();
  });

  it("uses a vertical mobile-safe journey timeline", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData());

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const timeline = await screen.findByLabelText("Complete indent journey timeline");
    expect(timeline).toHaveClass("space-y-0");
    expect(screen.getByText("OE-AP-104-MMU-Hindupur")).toHaveClass("break-words");
  });

  it("converts UTC timestamps to the local display formatter", () => {
    const raw = "2026-07-27T16:49:00Z";
    const parsed = parseIndentTimestamp(raw);

    expect(parsed?.toISOString()).toBe("2026-07-27T16:49:00.000Z");
    expect(formatIndentDateTime(raw)).toBe(new Intl.DateTimeFormat(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(raw)));
  });

  it("does not double convert offset-aware timestamps", () => {
    expect(parseIndentTimestamp("2026-07-27T16:49:00+00:00")?.toISOString()).toBe("2026-07-27T16:49:00.000Z");
    expect(parseIndentTimestamp("2026-07-27T16:49:00+05:30")?.toISOString()).toBe("2026-07-27T11:19:00.000Z");
  });

  it("treats timezone-less backend timestamps as confirmed UTC", () => {
    expect(parseIndentTimestamp("2026-07-27T16:49:00")?.toISOString()).toBe("2026-07-27T16:49:00.000Z");
  });

  it("keeps complete history grouping by local calendar day", () => {
    const groups = groupJourneyHistory(journeyData().history);

    expect(groups).toHaveLength(1);
    expect(groups[0][1].map((event) => event.id)).toEqual(["workflow:2", "workflow:1"]);
  });

  it("separates what has happened from the rungs still owed a decision", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      current_stage_message: "Waiting for DM review",
      stages: [
        {
          sequence: 1,
          title: "Draft created",
          status: "APPROVED",
          approver_name: "A Anil Kumar",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "draft",
          is_current: false,
        },
        {
          sequence: 2,
          title: "Request submitted",
          status: "SUBMITTED",
          approver_name: "A Anil Kumar",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "submission",
          is_current: false,
        },
        {
          sequence: 3,
          title: "OE Review",
          status: "APPROVED",
          approver_name: "C Ramakrishna",
          timestamp: "2026-07-27T10:00:00Z",
          stage_type: "approval",
          is_current: false,
        },
        {
          sequence: 4,
          title: "DM Review",
          status: "PENDING",
          approver_name: "A Raveendra Prasad",
          stage_type: "approval",
          is_current: true,
        },
        {
          sequence: 5,
          title: "RM Review",
          status: "PENDING",
          approver_name: "Regional Manager",
          stage_type: "approval",
          is_current: false,
        },
      ],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const occurred = await screen.findByRole("list", { name: "Complete indent journey timeline" });
    const remaining = screen.getByRole("list", { name: "Remaining indent journey stages" });

    // Completed rungs stay in the timeline; the live and future rungs are named
    // separately, so neither can be read as something that already happened.
    expect(within(occurred).getByRole("heading", { name: "OE Review" })).toBeInTheDocument();
    expect(within(occurred).queryByRole("heading", { name: "DM Review" })).not.toBeInTheDocument();
    expect(within(remaining).getByRole("heading", { name: "DM Review" })).toBeInTheDocument();
    expect(within(remaining).getByRole("heading", { name: "RM Review" })).toBeInTheDocument();
    expect(within(remaining).getByText("Current")).toBeInTheDocument();
    expect(within(remaining).getByText("Pending")).toBeInTheDocument();
    expect(within(remaining).getByText("A Raveendra Prasad")).toBeInTheDocument();
  });

  describe("All Requests restoration", () => {
    const restoredRoute = "/indents?search=anil&status=REJECTED&priority=URGENT"
      + "&raised_preset=custom&created_date_from=2026-07-01&created_date_to=2026-07-31"
      + "&required_by_preset=custom&required_by_from=2026-08-01&required_by_to=2026-08-10"
      + "&size=10&page=4";

    afterEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      vi.restoreAllMocks();
    });

    it("restores Page 4, every URL filter, cached rows, and scroll through All indents", async () => {
      const client = createTestQueryClient();
      const scope = { employeeId: 1, activePositionId: 10 };
      const pageFour = {
        items: [listRow(42, "IND/PAGE-4", "REJECTED")],
        total: 40,
        page: 4,
        size: 10,
      };
      client.setQueryData(indentKeys.list(scope, {
        search: "anil",
        created_date_from: "2026-07-01",
        created_date_to: "2026-07-31",
        required_by_from: "2026-08-01",
        required_by_to: "2026-08-10",
        status: ["REJECTED"],
        priority: ["URGENT"],
        sort_by: "created_at",
        sort_dir: "desc",
        page: 4,
        size: 10,
      }), pageFour);
      Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
      const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

      renderAllRequestsFlow(restoredRoute, client);

      expect(screen.getAllByText("IND/PAGE-4").length).toBeGreaterThan(0);
      expect(screen.getByText("Page 4 of 4 (40 total)")).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Search indents" })).toHaveValue("anil");
      expect(screen.getByRole("button", { name: "Status (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Priority (1)" })).toBeInTheDocument();
      expect(indentApi.list).not.toHaveBeenCalled();

      fireEvent.click(screen.getAllByText("IND/PAGE-4")[0]);
      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42"));
      fireEvent.click(await screen.findByRole("button", { name: "All indents" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(restoredRoute));
      expect(screen.getAllByText("IND/PAGE-4").length).toBeGreaterThan(0);
      expect(screen.getByText("Page 4 of 4 (40 total)")).toBeInTheDocument();
      expect(indentApi.list).not.toHaveBeenCalled();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 640));
    });

    it("returns Browser Back to the same cached Page 4 URL without a Page 1 request", async () => {
      vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
        items: [listRow(42, `IND/PAGE-${params.page ?? 1}`)],
        total: 80,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderAllRequestsFlow("/indents?status=DRAFT&page=4");

      expect(await screen.findByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
      fireEvent.click(screen.getAllByText("IND/PAGE-4")[0]);
      await screen.findByRole("button", { name: "Browser back test" });
      fireEvent.click(screen.getByRole("button", { name: "Browser back test" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents?status=DRAFT&page=4",
      ));
      expect(screen.getByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
      expect(vi.mocked(indentApi.list).mock.calls.every(([params]) => params?.page === 4)).toBe(true);
    });

    it("falls back from a directly opened Detail to default All Requests", async () => {
      renderAllRequestsFlow("/indents/42");

      fireEvent.click(await screen.findByRole("button", { name: "All indents" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/indents$/));
    });

    it("sanitizes malformed and unsupported URL state before querying", async () => {
      renderAllRequestsFlow(
        "/indents?page=zero&size=9999&status=UNKNOWN&priority=LOW"
          + "&created_date_from=2026-02-30&created_date_to=2026-03-01&extra=ignored",
      );

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/indents$/));
      await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
        page: 1,
        size: 20,
      }), expect.anything()));
      const params = vi.mocked(indentApi.list).mock.calls.at(-1)?.[0];
      expect(params).not.toHaveProperty("status");
      expect(params).not.toHaveProperty("priority");
      expect(params).not.toHaveProperty("created_date_from");
      expect(params).not.toHaveProperty("created_date_to");
    });

    it("clamps an out-of-range restored page to the nearest last page with replace", async () => {
      vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
        items: params.page === 3 ? [listRow(3, "IND/LAST-PAGE")] : [],
        total: 25,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderAllRequestsFlow("/indents?size=10&page=9");

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents?size=10&page=3",
      ));
      expect(await screen.findByText("Page 3 of 3 (25 total)")).toBeInTheDocument();
      expect(screen.getAllByText("IND/LAST-PAGE").length).toBeGreaterThan(0);
      expect(vi.mocked(indentApi.list).mock.calls.some(([params]) => params?.page === 1)).toBe(false);
    });

    it("Clear all removes restored URL filters and resets to Page 1", async () => {
      vi.mocked(indentApi.list).mockImplementation((params = {}) => Promise.resolve({
        items: [],
        total: 100,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderAllRequestsFlow(restoredRoute);

      fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/indents$/));
      await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
        page: 1,
        size: 20,
      }), expect.anything()));
    });
  });

  describe("Activity ledger restoration", () => {
    const restoredRoute = "/indents/reports?search=bolt&transaction_type=APPROVAL_COMPLETED"
      + "&date_preset=custom&date_from=2026-07-01&date_to=2026-07-31"
      + "&size=10&page=4";

    afterEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      vi.restoreAllMocks();
    });

    it("restores Page 4, every ledger filter, cached rows, and scroll through Activity ledger", async () => {
      const client = createTestQueryClient();
      const scope = { employeeId: 1, activePositionId: 10 };
      client.setQueryData(indentKeys.activity(scope, {
        search: "bolt",
        date_from: "2026-07-01",
        date_to: "2026-07-31",
        transaction_type: "APPROVAL_COMPLETED",
        page: 4,
        size: 10,
      }), {
        items: [activityRow({ indent_no: "IND/ACTIVITY-PAGE-4" })],
        total: 40,
        page: 4,
        size: 10,
      });
      Object.defineProperty(window, "scrollY", { configurable: true, value: 720 });
      const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

      renderActivityLedgerFlow(restoredRoute, client);

      expect(screen.getAllByText("IND/ACTIVITY-PAGE-4").length).toBeGreaterThan(0);
      expect(screen.getByText("Page 4 of 4 (40 total)")).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Search indents" })).toHaveValue("bolt");
      expect(screen.getByRole("button", { name: "Event (1)" })).toBeInTheDocument();
      expect(indentApi.activity).not.toHaveBeenCalled();

      const mobileCard = screen.getAllByText("IND/ACTIVITY-PAGE-4")
        .map((element) => element.closest("button"))
        .find((element): element is HTMLButtonElement => element !== null);
      expect(mobileCard).toBeDefined();
      fireEvent.click(mobileCard!);
      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42"));
      fireEvent.click(await screen.findByRole("button", { name: "Activity ledger" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(restoredRoute));
      expect(screen.getAllByText("IND/ACTIVITY-PAGE-4").length).toBeGreaterThan(0);
      expect(screen.getByText("Page 4 of 4 (40 total)")).toBeInTheDocument();
      expect(indentApi.activity).not.toHaveBeenCalled();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 720));
    });

    it("returns Browser Back to the same cached ledger Page 4 without a Page 1 request", async () => {
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => Promise.resolve({
        items: [activityRow({ indent_no: `IND/ACTIVITY-PAGE-${params.page ?? 1}` })],
        total: 80,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderActivityLedgerFlow("/indents/reports?transaction_type=REQUEST_CREATED&page=4");

      expect(await screen.findByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
      const mobileCard = screen.getAllByText("IND/ACTIVITY-PAGE-4")
        .map((element) => element.closest("button"))
        .find((element): element is HTMLButtonElement => element !== null);
      fireEvent.click(mobileCard!);
      await screen.findByRole("button", { name: "Browser back test" });
      fireEvent.click(screen.getByRole("button", { name: "Browser back test" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/reports?transaction_type=REQUEST_CREATED&page=4",
      ));
      expect(screen.getByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
      expect(vi.mocked(indentApi.activity).mock.calls.every(([params]) => params?.page === 4)).toBe(true);
    });

    it("sanitizes malformed and unsupported ledger URL state before querying", async () => {
      renderActivityLedgerFlow(
        "/indents/reports?page=zero&size=9999&status=UNKNOWN&priority=LOW"
          + "&date_from=2026-02-30&date_to=2026-13-01"
          + "&transaction_type=UNSUPPORTED&item_id=-12&extra=ignored",
      );

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        /^\/indents\/reports$/,
      ));
      await waitFor(() => expect(vi.mocked(indentApi.activity).mock.calls.some(([params]) => (
        params?.page === 1 && params.size === 20
      ))).toBe(true));
      const params = vi.mocked(indentApi.activity).mock.calls.at(-1)?.[0];
      expect(params?.status).toBeUndefined();
      expect(params?.priority).toBeUndefined();
      expect(params?.date_from).toBeUndefined();
      expect(params?.date_to).toBeUndefined();
      expect(params?.transaction_type).toBeUndefined();
      expect(params?.item_id).toBeUndefined();
    });

    it("clamps an out-of-range restored ledger page to the last valid page with replace", async () => {
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => Promise.resolve({
        items: params.page === 3
          ? [activityRow({ indent_no: "IND/ACTIVITY-LAST-PAGE" })]
          : [],
        total: 25,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderActivityLedgerFlow("/indents/reports?size=10&page=9");

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/reports?size=10&page=3",
      ));
      expect(await screen.findByText("Page 3 of 3 (25 total)")).toBeInTheDocument();
      expect(screen.getAllByText("IND/ACTIVITY-LAST-PAGE").length).toBeGreaterThan(0);
      expect(vi.mocked(indentApi.activity).mock.calls.some(([params]) => params?.page === 1)).toBe(false);
    });

    it("resets the ledger to Page 1 when search changes", async () => {
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => Promise.resolve({
        items: [],
        total: 80,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderActivityLedgerFlow("/indents/reports?page=4");

      const search = await screen.findByRole("searchbox", { name: "Search indents" });
      fireEvent.change(search, { target: { value: "new search" } });

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/reports?search=new+search",
      ));
      await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
        search: "new search",
        page: 1,
      }), expect.anything()));
    });

    it("Clear all removes restored ledger URL filters and resets to Page 1", async () => {
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => Promise.resolve({
        items: [],
        total: 100,
        page: params.page ?? 1,
        size: params.size ?? 20,
      }));
      renderActivityLedgerFlow(restoredRoute);

      fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        /^\/indents\/reports$/,
      ));
      await waitFor(() => expect(vi.mocked(indentApi.activity).mock.calls.some(([params]) => (
        params?.page === 1 && params.size === 20
      ))).toBe(true));
    });
  });

  describe("Alerts and Notifications pagination restoration", () => {
    afterEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
      vi.restoreAllMocks();
    });

    it("shows 20 notifications per page and loads the remainder with Next", async () => {
      vi.mocked(indentApi.notifications).mockImplementation(({ page = 1, size = 20 } = {}) => {
        const start = (page - 1) * size + 1;
        const count = page === 1 ? 20 : 5;
        return Promise.resolve({
          items: Array.from({ length: count }, (_, index) => notificationRow(start + index)),
          total: 25,
          page,
          size,
        });
      });
      renderNotificationsFlow("/indents/notifications");

      expect(await screen.findByText("Page 1 of 2 (25 total)")).toBeInTheDocument();
      expect(screen.getAllByText(/^Notification \d+$/)).toHaveLength(20);
      expect(vi.mocked(indentApi.notifications).mock.calls.some(([params]) => (
        params?.page === 1 && params.size === 20
      ))).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Next" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/notifications?page=2",
      ));
      expect(await screen.findByText("Notification 21")).toBeInTheDocument();
      expect(screen.getAllByText(/^Notification \d+$/)).toHaveLength(5);
      expect(indentApi.notifications).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, size: 20 }),
        expect.anything(),
      );
    });

    it("restores a cached notification page and scroll through its Detail return link", async () => {
      const client = createTestQueryClient();
      const scope = { employeeId: 1, activePositionId: 10 };
      client.setQueryData(indentKeys.notifications(scope, { page: 4, size: 20 }), {
        items: [notificationRow(61, { title: "Cached notification page 4" })],
        total: 80,
        page: 4,
        size: 20,
      });
      Object.defineProperty(window, "scrollY", { configurable: true, value: 680 });
      const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

      renderNotificationsFlow("/indents/notifications?page=4", client);

      expect(screen.getByText("Cached notification page 4")).toBeInTheDocument();
      expect(screen.getByText("Page 4 of 4 (80 total)")).toBeInTheDocument();
      expect(indentApi.notifications).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Cached notification page 4").closest("button")!);
      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/indents/42"));
      fireEvent.click(await screen.findByRole("button", { name: "Alert & Notification" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/notifications?page=4",
      ));
      expect(screen.getByText("Cached notification page 4")).toBeInTheDocument();
      expect(indentApi.notifications).not.toHaveBeenCalled();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 680));
    });

    it("returns Browser Back to the same notification page without requesting Page 1", async () => {
      vi.mocked(indentApi.notifications).mockImplementation(({ page = 1, size = 20 } = {}) => Promise.resolve({
        items: [notificationRow((page - 1) * size + 1)],
        total: 80,
        page,
        size,
      }));
      renderNotificationsFlow("/indents/notifications?page=3");

      const title = await screen.findByText("Notification 41");
      fireEvent.click(title.closest("button")!);
      await screen.findByRole("button", { name: "Browser back test" });
      fireEvent.click(screen.getByRole("button", { name: "Browser back test" }));

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/notifications?page=3",
      ));
      expect(screen.getByText("Page 3 of 4 (80 total)")).toBeInTheDocument();
      expect(vi.mocked(indentApi.notifications).mock.calls.filter(([params]) => params?.page === 3)).toHaveLength(1);
      expect(vi.mocked(indentApi.notifications).mock.calls.some(([params]) => params?.page === 1)).toBe(false);
    });

    it("sanitizes malformed notification pagination parameters", async () => {
      renderNotificationsFlow("/indents/notifications?page=invalid&size=100&extra=ignored");

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        /^\/indents\/notifications$/,
      ));
      await waitFor(() => expect(indentApi.notifications).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, size: 20 }),
        expect.anything(),
      ));
    });

    it("clamps an out-of-range notification page to the nearest valid last page", async () => {
      vi.mocked(indentApi.notifications).mockImplementation(({ page = 1, size = 20 } = {}) => Promise.resolve({
        items: page === 3 ? [notificationRow(41, { title: "Last notification page" })] : [],
        total: 41,
        page,
        size,
      }));
      renderNotificationsFlow("/indents/notifications?page=9");

      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(
        "/indents/notifications?page=3",
      ));
      expect(await screen.findByText("Last notification page")).toBeInTheDocument();
      expect(screen.getByText("Page 3 of 3 (41 total)")).toBeInTheDocument();
      expect(vi.mocked(indentApi.notifications).mock.calls.some(([params]) => params?.page === 1)).toBe(false);
    });
  });

  describe("Activity and Notification pagination smoothness", () => {
    it("retains Activity rows, preserves filters, prefetches one adjacent page, and reuses fresh cache", async () => {
      const pageTwo = deferred<{ items: ActivityRow[]; total: number; page: number; size: number }>();
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => {
        if (params.page === 2) return pageTwo.promise;
        return Promise.resolve({
          items: [activityRow({
            event_id: `activity:${params.page ?? 1}`,
            indent_no: `IND/ACTIVITY/PAGE-${params.page ?? 1}`,
          })],
          total: 60,
          page: params.page ?? 1,
          size: params.size ?? 20,
        });
      });
      const heightSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function measuredActivityResults(this: HTMLElement) {
          const height = this.textContent?.includes("IND/ACTIVITY/PAGE-2") ? 520 : 260;
          return { width: 800, height } as DOMRect;
        });
      renderActivityLedgerFlow(
        "/indents/reports?search=bolt&transaction_type=APPROVAL_COMPLETED"
          + "&date_preset=custom&date_from=2026-07-01&date_to=2026-07-31",
      );

      expect((await screen.findAllByText("IND/ACTIVITY/PAGE-1")).length).toBeGreaterThan(0);
      await waitFor(() => expect(
        vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 2),
      ).toHaveLength(1));

      fireEvent.click(screen.getByRole("button", { name: "Next" }));

      const results = screen.getByRole("region", { name: "Activity ledger results" });
      const shell = within(results).getByTestId("paginated-results-shell");
      const content = within(results).getByTestId("paginated-results-content");
      const footer = within(results).getByTestId("activity-pagination-footer");
      expect(results).toHaveAttribute("aria-busy", "true");
      expect(within(results).getByRole("status")).toHaveTextContent("Updating results…");
      expect(content).toHaveClass("duration-150", "opacity-70");
      expect(shell).toHaveStyle({ height: "260px", overflow: "hidden" });
      expect(shell.style.minHeight).toBe("");
      expect(content).not.toContainElement(footer);
      expect(screen.getByText("Page 2 of 3 (60 total)")).toBeInTheDocument();
      expect(screen.getAllByText("IND/ACTIVITY/PAGE-1").length).toBeGreaterThan(0);
      expect(vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 2)).toHaveLength(1);
      expect(vi.mocked(indentApi.activity).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        search: "bolt",
        transaction_type: "APPROVAL_COMPLETED",
        date_from: "2026-07-01",
        date_to: "2026-07-31",
      }));

      await act(async () => {
        pageTwo.resolve({
          items: [activityRow({ event_id: "activity:2", indent_no: "IND/ACTIVITY/PAGE-2" })],
          total: 60,
          page: 2,
          size: 20,
        });
        await pageTwo.promise;
      });
      expect((await screen.findAllByText("IND/ACTIVITY/PAGE-2")).length).toBeGreaterThan(0);
      expect(shell).toHaveStyle({ height: "520px", transition: "height 180ms ease" });
      fireEvent.transitionEnd(shell, { propertyName: "height" });
      expect(shell.style.height).toBe("");
      await waitFor(() => expect(
        vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 3),
      ).toHaveLength(1));

      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      expect(screen.getAllByText("IND/ACTIVITY/PAGE-1").length).toBeGreaterThan(0);
      expect(vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 1)).toHaveLength(1);
      heightSpy.mockRestore();
    });

    it("keeps Notification rows while loading and ends a 13-row last page without blank space", async () => {
      const pageTwo = deferred<{ items: IndentNotification[]; total: number; page: number; size: number }>();
      vi.mocked(indentApi.notifications).mockImplementation((params = {}) => {
        if (params.page === 2) return pageTwo.promise;
        return Promise.resolve({
          items: Array.from({ length: 20 }, (_, index) => notificationRow(index + 1)),
          total: 33,
          page: params.page ?? 1,
          size: params.size ?? 20,
        });
      });
      const heightSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function measuredResults(this: HTMLElement) {
          const height = this.textContent?.includes("Last page notification") ? 416 : 640;
          return { width: 800, height } as DOMRect;
        });
      renderNotificationsFlow(
        "/indents/notifications?search=stock&status=DRAFT"
          + "&date_preset=custom&date_from=2026-07-01&date_to=2026-07-31",
      );

      expect(await screen.findByText("Notification 1")).toBeInTheDocument();
      await waitFor(() => expect(
        vi.mocked(indentApi.notifications).mock.calls.filter(([params]) => params?.page === 2),
      ).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));

      const results = screen.getByRole("region", { name: "Notification results" });
      const shell = within(results).getByTestId("paginated-results-shell");
      const content = within(results).getByTestId("paginated-results-content");
      const footer = within(results).getByTestId("notification-pagination-footer");
      expect(results).toHaveAttribute("aria-busy", "true");
      expect(content).toHaveClass("duration-150", "opacity-70");
      expect(shell).toHaveStyle({ height: "640px", overflow: "hidden" });
      expect(shell.style.minHeight).toBe("");
      expect(content).not.toContainElement(footer);
      expect(screen.getByText("Page 2 of 2 (33 total)")).toBeInTheDocument();
      expect(screen.getByText("Notification 1")).toBeInTheDocument();
      expect(vi.mocked(indentApi.notifications).mock.calls.filter(([params]) => params?.page === 2)).toHaveLength(1);
      expect(vi.mocked(indentApi.notifications).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        search: "stock",
        status: ["DRAFT"],
        date_from: "2026-07-01",
        date_to: "2026-07-31",
      }));

      await act(async () => {
        pageTwo.resolve({
          items: Array.from({ length: 13 }, (_, index) => notificationRow(21 + index, {
            title: `Last page notification ${21 + index}`,
          })),
          total: 33,
          page: 2,
          size: 20,
        });
        await pageTwo.promise;
      });
      expect(await screen.findByText("Last page notification 21")).toBeInTheDocument();
      expect(screen.getAllByText(/^Last page notification \d+$/)).toHaveLength(13);
      expect(shell).toHaveStyle({ height: "416px", transition: "height 180ms ease" });
      fireEvent.transitionEnd(shell, { propertyName: "height" });
      expect(shell.style.height).toBe("");
      expect(shell.style.minHeight).toBe("");
      expect(shell.style.overflow).toBe("");
      expect(shell.nextElementSibling).toContainElement(footer);
      expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
      heightSpy.mockRestore();
    });

    it("shows only the latest Activity page after rapid Next actions and a late stale response", async () => {
      const pageTwo = deferred<{ items: ActivityRow[]; total: number; page: number; size: number }>();
      const pageThree = deferred<{ items: ActivityRow[]; total: number; page: number; size: number }>();
      vi.mocked(indentApi.activity).mockImplementation((params = {}) => {
        if (params.page === 2) return pageTwo.promise;
        if (params.page === 3) return pageThree.promise;
        return Promise.resolve({
          items: [activityRow({ indent_no: "IND/ACTIVITY/PAGE-1" })],
          total: 60,
          page: 1,
          size: 20,
        });
      });
      renderActivityLedgerFlow("/indents/reports");

      expect((await screen.findAllByText("IND/ACTIVITY/PAGE-1")).length).toBeGreaterThan(0);
      await waitFor(() => expect(
        vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 2),
      ).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText("Page 3 of 3 (60 total)")).toBeInTheDocument();

      await act(async () => {
        pageThree.resolve({
          items: [activityRow({ event_id: "activity:latest", indent_no: "IND/ACTIVITY/LATEST" })],
          total: 60,
          page: 3,
          size: 20,
        });
        await pageThree.promise;
      });
      expect((await screen.findAllByText("IND/ACTIVITY/LATEST")).length).toBeGreaterThan(0);

      await act(async () => {
        pageTwo.resolve({
          items: [activityRow({ event_id: "activity:stale", indent_no: "IND/ACTIVITY/STALE" })],
          total: 60,
          page: 2,
          size: 20,
        });
        await pageTwo.promise;
      });
      expect(screen.queryByText("IND/ACTIVITY/STALE")).not.toBeInTheDocument();
      expect(screen.getAllByText("IND/ACTIVITY/LATEST").length).toBeGreaterThan(0);
      expect(vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 2)).toHaveLength(1);
      expect(vi.mocked(indentApi.activity).mock.calls.filter(([params]) => params?.page === 3)).toHaveLength(1);
    });
  });
});
