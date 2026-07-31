import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/components";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterBar } from "../components/IndentFilterBar";
import { IndentsNav } from "../components/IndentsNav";
import { buildStatusBreakdownData } from "../components/StatusBreakdownChart";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";
import { IndentDashboardPage } from "../pages/DashboardPage";
import { IndentListPage } from "../pages/ListPage";
import { IndentBoardPage } from "../pages/BoardPage";
import { IndentApprovalsPage } from "../pages/ApprovalsPage";
import { IndentAcknowledgmentsPage } from "../pages/AcknowledgmentsPage";
import { IndentReportsPage } from "../pages/ReportsPage";
import { IndentNotificationsPage } from "../pages/NotificationsPage";
import { IndentDetailPage } from "../pages/DetailPage";
import { IndentJourneyPage } from "../pages/JourneyPage";
import { groupJourneyHistory } from "../pages/JourneyPage";
import { indentApi, indentKeys } from "../api";
import { INDENT_STATUS_OPTIONS } from "../constants";
import { formatIndentDateTime, parseIndentTimestamp } from "../dateTime";
import type { ActivityRow, Indent, IndentJourney, IndentStats } from "../types";

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
}));

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    can: () => true,
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
    acknowledgments: (scope: { employeeId: number | null; activePositionId: number | null }, filters: unknown) => [...scoped(scope), "acknowledgments", filters] as const,
    notifications: (scope: { employeeId: number | null; activePositionId: number | null }) => [...scoped(scope), "notifications"] as const,
    pendingApprovals: (scope: { employeeId: number | null; activePositionId: number | null }) => [...scoped(scope), "pending-approvals"] as const,
    detail: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) => [...scoped(scope), "detail", id] as const,
    journey: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) => [...scoped(scope), "journey", id] as const,
    items: (scope: { employeeId: number | null; activePositionId: number | null }, context = "default") => [...scoped(scope), "items", context] as const,
  };
  const isIndentModuleQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === root;
  return {
    INDENT_QUERY_STALE_TIME: 45_000,
    INDENT_QUERY_GC_TIME: 5 * 60_000,
    INDENT_QUERY_ROOT: root,
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
    })),
    list: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    acknowledgments: vi.fn(() => Promise.resolve({
      items: [{
        id: 7,
        indent_id: 42,
        indent_no: "IND/2026/0007",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Anita Appr",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    })),
    activity: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    notifications: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, size: 20 })),
    get: vi.fn(),
    journey: vi.fn(),
    submit: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    bookmark: vi.fn(),
    unbookmark: vi.fn(),
    pendingApprovals: vi.fn(() => Promise.resolve([])),
    },
  };
});

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(ui: ReactElement, route = "/indents", client = createTestQueryClient()) {
  const result = render(
    // ToastProvider mirrors App.tsx: screens now report success through it, and a
    // page rendered without one throws rather than quietly losing its feedback.
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
    <>
      <button type="button" onClick={() => setPage(3)}>Set page</button>
      <IndentFilterBar />
      <output aria-label="filter state">{page}:{search}:{startDate}:{endDate}</output>
    </>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
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
    stages: [
      {
        sequence: 1,
        title: "Request Raised",
        status: "SUBMITTED",
        approver_name: "A Anil Kumar",
        position_name: "DRIVER-AP-104-MMU-CHILMATHUR",
        timestamp: "2026-07-27T09:30:00Z",
        stage_type: "request",
      },
      {
        sequence: 2,
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
        sequence: 3,
        title: "DM Review",
        status: "APPROVED",
        approver_name: "A Raveendra Prasad",
        position_name: "District Manager",
        timestamp: "2026-07-27T10:20:00Z",
        stage_type: "approval",
      },
      {
        sequence: 4,
        title: "Final Approval - SPH or COO",
        status: "APPROVED",
        approver_name: "SPH",
        position_name: "SPH-AP-104-MMU",
        timestamp: "2026-07-27T10:42:00Z",
        stage_type: "final",
      },
      {
        sequence: 5,
        title: "COO Authority",
        status: "NOT_REQUIRED",
        approver_name: "COO",
        position_name: "COO",
        timestamp: "2026-07-27T10:42:00Z",
        comments: "Final approval completed by another authority",
        stage_type: "final_any_one_peer",
      },
      {
        sequence: 6,
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

beforeEach(() => {
  mockAccount.employeeId = 1;
  mockAccount.activePositionId = 10;
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
    expect(screen.getAllByRole("link")).toHaveLength(6);
  });

  it("marks the current indent tab active", () => {
    renderWithProviders(<IndentsNav />, "/indents/board");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps renamed navigation labels on existing routes", () => {
    renderWithProviders(<IndentsNav />, "/indents/notifications");

    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/indents/board");
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("href", "/indents/notifications");
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["Overview", <IndentDashboardPage />, "/indents/dashboard"],
    ["All requests", <IndentListPage />, "/indents"],
    ["Board", <IndentBoardPage />, "/indents/board"],
    ["Acknowledgments", <IndentAcknowledgmentsPage />, "/indents/acknowledgments"],
    ["Activity ledger", <IndentReportsPage />, "/indents/reports"],
  ])("shows the common Indent toolbar on %s", async (_name, Page, route) => {
    renderWithProviders(Page, route);
    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toHaveAttribute("placeholder", "Search indents...");
    expect(screen.getByRole("button", { name: /^Date/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Status/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Priority/ })).toBeInTheDocument();
  });

  it.each([
    [
      "Overview",
      <IndentDashboardPage />,
      "/indents/dashboard",
      () => {
        expect(indentApi.stats).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt" }));
        expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", size: 6 }));
      },
    ],
    [
      "All requests",
      <IndentListPage />,
      "/indents",
      () => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", page: 1, size: 20 })),
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
      "Acknowledgments",
      <IndentAcknowledgmentsPage />,
      "/indents/acknowledgments",
      () => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", page: 1, size: 20 })),
    ],
    [
      "Activity ledger",
      <IndentReportsPage />,
      "/indents/reports",
      () => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Bolt", page: 1, size: 20 })),
    ],
  ])("sends trimmed search from the shared toolbar on %s", async (_name, Page, route, assertSearch) => {
    renderWithProviders(Page, route);

    const search = await screen.findByRole("searchbox", { name: "Search indents" });
    fireEvent.change(search, { target: { value: "  Bolt  " } });

    await waitFor(assertSearch);
  });

  it("shows only the latest five recent indents in the existing API order", async () => {
    const indentNumbers = [
      "IND/RECENT/005",
      "IND/RECENT/002",
      "IND/RECENT/009",
      "IND/RECENT/001",
      "IND/RECENT/006",
      "IND/RECENT/003",
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
      size: 6,
    });

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    await screen.findByText(recentIndents[4].indent_no);
    expect(screen.getAllByText(/^IND\/RECENT\//).map((node) => node.textContent)).toEqual(
      recentIndents.slice(0, 5).map((indent) => indent.indent_no),
    );
    expect(screen.queryByText(recentIndents[5].indent_no)).not.toBeInTheDocument();
    expect(indentApi.list).toHaveBeenCalledWith(expect.objectContaining({ size: 6 }));
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

  it("renders a solid pseudo-3D pie and keeps the dynamic badge with a sorted, aligned legend", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 1,
      CLOSED: 0,
      APPROVED: 3,
      PENDING_APPROVAL: 4,
      AWAITING_ALLOCATION: 7,
    }));

    const { container } = renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const chart = await screen.findByRole("img", {
      name: "Status breakdown donut chart. 15 total indents.",
    });
    expect(within(chart).queryByTestId("status-donut-total")).not.toBeInTheDocument();
    expect(within(chart).queryByText("Total Indents")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-total-badge")).toHaveTextContent(/^15 Indents$/);
    expect(screen.getByTestId("status-total-badge")).toHaveClass(
      "ml-auto",
      "w-fit",
      "md:absolute",
      "md:right-5",
      "md:top-4",
    );
    expect(container.querySelectorAll(".recharts-pie")).toHaveLength(2);

    const topColours = {
      AWAITING_ALLOCATION: "var(--color-info)",
      PENDING_APPROVAL: "var(--color-warn)",
      APPROVED: "var(--color-ok)",
      DRAFT: "var(--color-neutral)",
    };
    for (const [status, colour] of Object.entries(topColours)) {
      const top = within(chart).getByTestId(`status-pie-top-${status}`);
      const depthLayers = within(chart).getAllByTestId(
        new RegExp(`^status-pie-depth-${status}-\\d+$`),
      );

      expect(top).toHaveAttribute("data-layer", "top");
      expect(top).toHaveAttribute("data-status", status);
      expect(top).toHaveAttribute("data-base-color", colour);
      expect(top).toHaveAttribute("data-inner-radius", "0");
      expect(top).toHaveAttribute("fill", colour);
      expect(top).not.toHaveAttribute("pointer-events", "none");
      expect(depthLayers.length).toBeGreaterThan(0);

      for (const depth of depthLayers) {
        expect(depth).toHaveAttribute("data-layer", "depth");
        expect(depth).toHaveAttribute("data-status", status);
        expect(depth).toHaveAttribute("data-base-color", colour);
        expect(depth).toHaveAttribute("data-inner-radius", "0");
        expect(depth).toHaveAttribute("pointer-events", "none");
        expect(depth.getAttribute("fill")).not.toBe(colour);
        expect(depth.getAttribute("fill")).toMatch(
          new RegExp(
            `^color-mix\\(in srgb, ${colour.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+%, black \\d+%\\)$`,
          ),
        );
        expect(
          depth.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
    expect(within(chart).queryByTestId("status-pie-top-CLOSED")).not.toBeInTheDocument();

    const legend = screen.getByTestId("status-breakdown-legend");
    const awaitingAllocation = within(legend).getByRole("button", {
      name: "Awaiting Allocation: 7 indents, 47%",
    });
    expect(within(awaitingAllocation).getByText("Awaiting Allocation")).toBeInTheDocument();
    const count = screen.getByTestId("status-legend-count-AWAITING_ALLOCATION");
    const percentage = screen.getByTestId("status-legend-percentage-AWAITING_ALLOCATION");
    expect(awaitingAllocation).toHaveClass("grid-cols-[minmax(0,1fr)_2.5rem_3rem]");
    expect(count).toHaveTextContent(/^7$/);
    expect(count).toHaveClass("text-right", "font-semibold", "text-ink");
    expect(percentage).toHaveTextContent(/^47%$/);
    expect(percentage).toHaveClass("text-right", "text-muted");
    expect(awaitingAllocation).not.toHaveTextContent(/7\s*·\s*47%/);

    expect(within(legend).getAllByRole("button").map((row) => row.getAttribute("aria-label"))).toEqual([
      "Awaiting Allocation: 7 indents, 47%",
      "In Approval: 4 indents, 27%",
      "Approved: 3 indents, 20%",
      "Draft: 1 indent, 7%",
    ]);
    expect(within(legend).queryByText("Closed")).not.toBeInTheDocument();
    expect(screen.queryByText("AWAITING_ALLOCATION")).not.toBeInTheDocument();
    expect(container.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^status-slice-label-/)).toHaveLength(0);
  });

  it("sorts copied status data, calculates percentages, and removes zero counts", () => {
    const byStatus = {
      DRAFT: 1,
      REJECTED: 0,
      APPROVED: 3,
    };
    const original = { ...byStatus };

    const { entries, total } = buildStatusBreakdownData(byStatus);

    expect(total).toBe(4);
    expect(entries).toEqual([
      expect.objectContaining({ status: "APPROVED", count: 3, percentage: 75 }),
      expect.objectContaining({ status: "DRAFT", count: 1, percentage: 25 }),
    ]);
    expect(entries.some((entry) => entry.status === "REJECTED")).toBe(false);
    expect(byStatus).toEqual(original);
  });

  it("shows the unchanged compact tooltip only for an active top pie surface", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      AWAITING_ALLOCATION: 7,
      PENDING_APPROVAL: 4,
      APPROVED: 2,
      DRAFT: 2,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const firstTopSurface = await screen.findByTestId("status-pie-top-AWAITING_ALLOCATION");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(firstTopSurface);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Awaiting Allocation")).toBeInTheDocument();
    expect(within(tooltip).getByText("7 indents")).toBeInTheDocument();
    expect(within(tooltip).getByText("47% of total")).toBeInTheDocument();
    expect(tooltip).toHaveClass("pointer-events-none", "w-36");
    expect(screen.getByTestId("status-legend-row-AWAITING_ALLOCATION")).toHaveAttribute("data-active", "true");

    fireEvent.mouseLeave(firstTopSurface);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("shows the status empty state instead of an empty donut", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 0,
      CLOSED: 0,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    expect(await screen.findByText("No indent status data available")).toBeInTheDocument();
    expect(screen.getByTestId("status-total-badge")).toHaveTextContent(/^0 Indents$/);
    expect(screen.queryByRole("img", { name: /Status breakdown donut chart/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Status breakdown legend")).not.toBeInTheDocument();
  });

  it("renders a single status as a complete solid pie with a 100 percent legend value", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({ ORDERED: 6 }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const chart = await screen.findByRole("img", {
      name: "Status breakdown donut chart. 6 total indents.",
    });
    expect(within(chart).queryByTestId("status-donut-total")).not.toBeInTheDocument();
    expect(within(chart).queryByText("Total Indents")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-total-badge")).toHaveTextContent(/^6 Indents$/);

    const ordered = screen.getByRole("button", {
      name: "Ordered: 6 indents, 100%",
    });
    expect(within(ordered).getByTestId("status-legend-count-ORDERED")).toHaveTextContent(/^6$/);
    expect(within(ordered).getByTestId("status-legend-percentage-ORDERED")).toHaveTextContent(/^100%$/);
    const orderedTop = within(chart).getByTestId("status-pie-top-ORDERED");
    const orderedDepth = within(chart).getAllByTestId(/^status-pie-depth-ORDERED-\d+$/);
    expect(orderedTop).toHaveAttribute("data-inner-radius", "0");
    expect(orderedTop).toHaveAttribute("fill", "#2563eb");
    expect(orderedDepth.length).toBeGreaterThan(0);
    expect(orderedDepth.every((layer) => layer.getAttribute("pointer-events") === "none")).toBe(true);
    expect(chart.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
  });

  it("keeps tiny percentages in the legend without adding permanent pie labels", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      APPROVED: 99,
      REJECTED: 1,
    }));

    const { container } = renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const rejected = await screen.findByRole("button", {
      name: "Rejected: 1 indent, 1%",
    });
    expect(within(rejected).getByTestId("status-legend-count-REJECTED")).toHaveTextContent(/^1$/);
    expect(within(rejected).getByTestId("status-legend-percentage-REJECTED")).toHaveTextContent(/^1%$/);
    expect(container.querySelector(".recharts-pie-labels")).not.toBeInTheDocument();
  });

  it("uses a balanced 40/60 desktop split with the legend beside the pie", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 2,
      APPROVED: 1,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const layout = await screen.findByTestId("status-breakdown-layout");
    const chart = screen.getByRole("img", { name: /Status breakdown donut chart/i });
    const legend = screen.getByTestId("status-breakdown-legend");

    expect(layout).toHaveClass(
      "grid",
      "md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]",
      "md:items-center",
      "md:gap-6",
    );
    expect(chart).toHaveClass("h-[250px]", "max-w-[300px]");
    expect(legend).toHaveClass("md:max-h-[260px]", "md:overflow-y-auto");
    expect(layout.children[0]).toBe(chart);
    expect(layout.children[1]).toBe(legend);
  });

  it("stacks the legend below the centred pie on mobile without horizontal overflow", async () => {
    vi.mocked(indentApi.stats).mockResolvedValueOnce(overviewStats({
      DRAFT: 2,
      APPROVED: 1,
    }));

    renderWithProviders(<IndentDashboardPage />, "/indents/dashboard");

    const layout = await screen.findByTestId("status-breakdown-layout");
    const chart = screen.getByRole("img", { name: /Status breakdown donut chart/i });
    const legend = screen.getByTestId("status-breakdown-legend");
    const badge = screen.getByTestId("status-total-badge");

    expect(layout).toHaveClass("grid", "min-w-0", "gap-4");
    expect(layout).not.toHaveClass("grid-cols-2");
    expect(chart).toHaveClass("mx-auto", "h-[250px]", "w-full", "max-w-[300px]");
    expect(legend).toHaveClass("min-w-0");
    expect(badge).toHaveClass("ml-auto", "w-fit", "md:absolute");
    expect(badge).not.toHaveClass("absolute");
    expect(chart.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      name: "Status breakdown donut chart. 15 total indents.",
    });

    for (const label of [
      "Total indents",
      "Awaiting approval",
      "Approved active",
      "Raised this month",
      "In draft",
      "Units requested",
      "Rejected",
      "Approval rate",
      "Recent Indents",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows every lifecycle status and deselects a selected status", async () => {
    renderWithProviders(<IndentListPage />, "/indents");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    for (const option of INDENT_STATUS_OPTIONS) {
      expect(await screen.findByText(option.label)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText("Awaiting allocation"));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      status: ["AWAITING_ALLOCATION"],
      page: 1,
    })));

    fireEvent.click(screen.getByText("Awaiting allocation"));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      status: undefined,
      page: 1,
    })));
  });

  it("renders Acknowledgments with the common toolbar but without extra actions", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New indent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export/i })).not.toBeInTheDocument();
  });

  it("offers only fulfillment statuses and returns only the selected fulfillment rows", async () => {
    const rows = [
      {
        id: 71,
        indent_id: 421,
        indent_no: "IND/2026/FULL",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Warehouse Issuer",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      },
      {
        id: 72,
        indent_id: 422,
        indent_no: "IND/2026/PART",
        action: "PARTIALLY_FULFILLED",
        stage_name: null,
        actor_name: "Warehouse Issuer",
        comments: null,
        acted_at: "2026-07-27T10:31:00Z",
      },
    ];
    vi.mocked(indentApi.acknowledgments).mockImplementation((params = {}) => {
      const selected = typeof params.status === "string"
        ? [params.status]
        : params.status ?? [];
      const items = !selected.length
        ? rows
        : rows.filter((row) => (
          selected.includes(row.action)
        ));
      return Promise.resolve({
        items,
        total: items.length,
        page: params.page ?? 1,
        size: params.size ?? 20,
      });
    });

    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");
    expect(await screen.findByText("IND/2026/FULL")).toBeInTheDocument();
    expect(screen.getByText("IND/2026/PART")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Fulfilled",
      "Partially Fulfilled",
    ]);
    for (const excluded of [
      "Draft",
      "Pending Approval",
      "Approved",
      "Rejected",
      "Awaiting Allocation",
    ]) {
      expect(within(menu).queryByText(excluded)).not.toBeInTheDocument();
    }

    fireEvent.click(within(menu).getByText("Fulfilled"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: ["FULFILLED"], page: 1 }),
    ));
    expect(vi.mocked(indentApi.acknowledgments).mock.lastCall?.[0]?.status).not.toContain("ALLOCATED");
    expect(screen.getByText("Status: Fulfilled")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("IND/2026/PART")).not.toBeInTheDocument());
    expect(screen.getByText("IND/2026/FULL")).toBeInTheDocument();

    fireEvent.click(within(menu).getByText("Fulfilled"));
    fireEvent.click(within(menu).getByText("Partially Fulfilled"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: ["PARTIALLY_FULFILLED"], page: 1 }),
    ));
    await waitFor(() => expect(screen.queryByText("IND/2026/FULL")).not.toBeInTheDocument());
    expect(screen.getByText("IND/2026/PART")).toBeInTheDocument();

    vi.mocked(indentApi.acknowledgments).mockReset();
    vi.mocked(indentApi.acknowledgments).mockResolvedValue({
      items: [{
        id: 7,
        indent_id: 42,
        indent_no: "IND/2026/0007",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Anita Appr",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    });
  });

  it("keeps the acknowledgment row design while showing fulfillment wording", async () => {
    const { container } = renderWithProviders(
      <IndentAcknowledgmentsPage />,
      "/indents/acknowledgments",
    );

    const indentNumber = await screen.findByText("IND/2026/0007");
    const row = indentNumber.closest("button");
    expect(screen.getByText(/Anita Appr\s+·\s+fulfilled/i)).toBeInTheDocument();
    expect(screen.getByText(/27 Jul/i)).toBeInTheDocument();
    expect(row).toHaveClass(
      "flex",
      "w-full",
      "items-center",
      "gap-4",
      "border-b",
      "px-5",
      "py-4",
      "text-left",
    );
    expect(row?.querySelector(".bg-ok-bg.text-ok")).toBeTruthy();
    expect(container.querySelector(".overflow-hidden.rounded-2xl.bg-white")).toBeTruthy();
  });

  it("shows the interim empty state without allocation actor or timestamp content", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      size: 20,
    });

    const { container } = renderWithProviders(
      <IndentAcknowledgmentsPage />,
      "/indents/acknowledgments",
    );

    expect(await screen.findByText("No fulfilment acknowledgments found")).toBeInTheDocument();
    expect(screen.queryByText("Store Allocator")).not.toBeInTheDocument();
    expect(screen.queryByText(/27 Jul/i)).not.toBeInTheDocument();
    expect(container.querySelector(".overflow-hidden.rounded-2xl.bg-white")).toBeTruthy();
  });

  it("shows fulfillment rows and suppresses submitted, approval, rejection and fallback rows", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValueOnce({
      items: [
        {
          id: 71,
          indent_id: 421,
          indent_no: "IND/2026/FULL",
          action: "FULFILLED",
          stage_name: null,
          actor_name: "V Suresh Kumar",
          comments: null,
          acted_at: "2026-07-27T10:30:00Z",
        },
        {
          id: 72,
          indent_id: 422,
          indent_no: "IND/2026/PART",
          action: "PARTIALLY_FULFILLED",
          stage_name: null,
          actor_name: null,
          comments: null,
          acted_at: "2026-07-27T10:31:00Z",
        },
        {
          id: 73,
          indent_id: 423,
          indent_no: "IND/2026/SUBMITTED",
          action: "SUBMITTED",
          stage_name: "Submitted",
          actor_name: "Workflow User",
          comments: "Submitted",
          acted_at: "2026-07-27T10:32:00Z",
        },
        {
          id: 74,
          indent_id: 424,
          indent_no: "IND/2026/APPROVED",
          action: "APPROVED",
          stage_name: "Reporting Manager",
          actor_name: "Anita Appr",
          comments: "Approved",
          acted_at: "2026-07-27T10:32:00Z",
        },
        {
          id: 75,
          indent_id: 425,
          indent_no: "IND/2026/REJECTED",
          action: "REJECTED",
          stage_name: "Final Approval",
          actor_name: "Final Approver",
          comments: "Rejected",
          acted_at: "2026-07-27T10:33:00Z",
        },
        {
          id: 76,
          indent_id: 426,
          indent_no: "IND/2026/FALLBACK",
          action: "FALLBACK",
          stage_name: "Workflow Fallback",
          actor_name: null,
          comments: null,
          acted_at: "2026-07-27T10:34:00Z",
        },
      ],
      total: 2,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/FULL")).toBeInTheDocument();
    expect(screen.getByText(/V Suresh Kumar\s+·\s+fulfilled/i)).toBeInTheDocument();
    expect(screen.getByText("IND/2026/PART")).toBeInTheDocument();
    expect(screen.getByText(/System\s+·\s+partially fulfilled/i)).toBeInTheDocument();
    for (const indentNo of [
      "IND/2026/SUBMITTED",
      "IND/2026/APPROVED",
      "IND/2026/REJECTED",
      "IND/2026/FALLBACK",
    ]) {
      expect(screen.queryByText(indentNo)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/Reporting Manager|Final Approval|Workflow Fallback/)).not.toBeInTheDocument();
  });

  it("debounces and trims acknowledgment search by indent number", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "  IND/2026/0007  " },
    });
    expect(indentApi.acknowledgments).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(indentApi.acknowledgments).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    vi.useRealTimers();
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      size: 20,
      search: "IND/2026/0007",
    })));
    expect(indentApi.acknowledgments).toHaveBeenCalledTimes(2);
  });

  it("passes acknowledgment actor and fulfillment status search to the backend", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search indents" });
    fireEvent.change(search, { target: { value: "Anita Appr" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "Anita Appr",
    })));

    fireEvent.change(search, { target: { value: "PARTIALLY FULFILLED" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "PARTIALLY FULFILLED",
    })));

    fireEvent.change(search, { target: { value: "System" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "System",
    })));
  });

  it("passes Date, Status and Priority filters to acknowledgments API", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(await screen.findByText("Today"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      date_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      page: 1,
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(await screen.findByText("Fulfilled"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      status: ["FULFILLED"],
    })));
    expect(vi.mocked(indentApi.acknowledgments).mock.lastCall?.[0]?.status).not.toContain("ALLOCATED");

    fireEvent.click(screen.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(await screen.findByText("Urgent"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      priority: ["URGENT"],
    })));
  });

  it("keeps supported Activity filters in More filters and hides Movement", async () => {
    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transaction" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    expect(screen.getByRole("button", { name: "Transaction" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Movement" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(await screen.findByText("Rejected"));
    await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      status: ["REJECTED"],
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(await screen.findByText("Normal"));
    await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      priority: ["NORMAL"],
    })));

    fireEvent.click(screen.getByRole("button", { name: "Transaction" }));
    fireEvent.click(await screen.findByText("Approval completed"));
    fireEvent.change(screen.getByLabelText("Item ID"), { target: { value: "123" } });

    await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      transaction_type: "APPROVAL_COMPLETED",
      item_id: 123,
    })));
    expect(indentApi.activity).toHaveBeenLastCalledWith(expect.not.objectContaining({
      direction: expect.anything(),
    }));
  });

  it("offers only persisted Activity transaction types", async () => {
    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Transaction" }));

    for (const label of [
      "Request created",
      "Request submitted",
      "Approval completed",
      "Request rejected",
      "Request returned",
      "Approval routed automatically",
      "Stock allocated",
      "Procurement request created",
      "Bookmark added",
      "Bookmark removed",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    for (const unsupported of [
      "Acknowledged",
      "Fulfilled",
      "Received",
      "Ordered",
      "Closed",
    ]) {
      expect(screen.queryByText(unsupported)).not.toBeInTheDocument();
    }
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

  // Waiting for me carries its own toolbar now: it lists every document type, so the
  // indent module's Date/Status/Priority filters never applied to it.
  it("hides unsupported Date, Status and Priority filters on Waiting for me", async () => {
    renderWithProviders(<IndentApprovalsPage />, "/indents/approvals");

    expect(await screen.findByRole("searchbox", { name: "Search approvals" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Past due only/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Date/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Status/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Priority/ })).not.toBeInTheDocument();
  });

  it("uses wrap-friendly toolbar layout for mobile widths", async () => {
    renderWithProviders(<IndentListPage />, "/indents");

    const search = await screen.findByRole("searchbox", { name: "Search indents" });
    expect(search.closest("section")?.firstElementChild).toHaveClass("flex-wrap");
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    expect(screen.getByText("Raised date").closest("div")?.parentElement).toHaveClass(
      "w-[calc(100vw-2rem)]",
      "max-w-80",
      "overflow-y-auto",
    );
  });

  it.each([
    ["Overview", <IndentDashboardPage />, "/indents/dashboard"],
    ["All requests", <IndentListPage />, "/indents"],
    ["Board", <IndentBoardPage />, "/indents/board"],
    ["Acknowledgments", <IndentAcknowledgmentsPage />, "/indents/acknowledgments"],
    ["Activity ledger", <IndentReportsPage />, "/indents/reports"],
  ])("shows required-by control on %s", async (_name, Page, route) => {
    const view = renderWithProviders(Page, route);

    await screen.findByRole("searchbox", { name: "Search indents" });
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));

    expect(screen.getByRole("button", { name: "Add required-by filter" })).toBeInTheDocument();
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
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      created_date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      created_date_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(indentApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      created_date_from: undefined,
      created_date_to: undefined,
    })));
  });

  it("required-by expands, applies, clears and collapses on acknowledgments", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValue({
      items: [{
        id: 7,
        indent_id: 42,
        indent_no: "IND/2026/0007",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Anita Appr",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 25,
      page: 1,
      size: 20,
    });
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("Page 1 of 2 (25 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add required-by filter" }));
    fireEvent.change(screen.getByLabelText("Required by from"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("Required by to"), { target: { value: "2026-08-15" } });

    expect(screen.getByRole("button", { name: "Add required-by filter" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("Required-by filter active")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      required_from: "2026-08-01",
      required_to: "2026-08-15",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Add required-by filter" }));
    expect(screen.queryByText("Required-by date")).not.toBeInTheDocument();
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      required_from: undefined,
      required_to: undefined,
    })));

    fireEvent.click(screen.getByRole("button", { name: "Add required-by filter" }));
    expect(screen.getByLabelText("Required by from")).toHaveValue("");
    expect(screen.getByLabelText("Required by to")).toHaveValue("");
  });

  it("sends required-by filters to the activity API", async () => {
    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add required-by filter" }));
    fireEvent.change(screen.getByLabelText("Required by from"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("Required by to"), { target: { value: "2026-08-15" } });

    await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      required_from: "2026-08-01",
      required_to: "2026-08-15",
    })));
  });

  it("does not duplicate API requests when a date preset is selected", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    const initialCalls = vi.mocked(indentApi.acknowledgments).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Date/ }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));

    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenCalledTimes(initialCalls + 1));
  });

  it("clears acknowledgment search and resets pagination", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValue({
      items: [{
        id: 7,
        indent_id: 42,
        indent_no: "IND/2026/0007",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Anita Appr",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 25,
      page: 1,
      size: 20,
    });
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("Page 1 of 2 (25 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
      size: 20,
    })));

    const search = screen.getByRole("searchbox", { name: "Search indents" });
    fireEvent.change(search, { target: { value: " Anita " } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      search: "Anita",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      size: 20,
      search: undefined,
    })));
  });

  it("shows an empty acknowledgment search result message", async () => {
    vi.mocked(indentApi.acknowledgments).mockImplementation((params = {}) => Promise.resolve({
      items: params.search ? [] : [{
        id: 7,
        indent_id: 42,
        indent_no: "IND/2026/0007",
        action: "FULFILLED",
        stage_name: null,
        actor_name: "Anita Appr",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: params.search ? 0 : 1,
      page: 1,
      size: 20,
    }));
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search indents" }), {
      target: { value: "missing actor" },
    });

    expect(await screen.findByText("No fulfilment acknowledgments found")).toBeInTheDocument();
  });

  it("does not show search controls on Notifications", async () => {
    renderWithProviders(<IndentNotificationsPage />, "/indents/notifications");
    await waitFor(() => expect(screen.queryByText("Loading notifications...")).not.toBeInTheDocument());
    expect(screen.queryByRole("searchbox", { name: "Search indents" })).not.toBeInTheDocument();
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

  it("keeps partially fulfilled acknowledgments on the existing green icon treatment", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValueOnce({
      items: [{
        id: 8,
        indent_id: 42,
        indent_no: "IND/2026/0008",
        action: "PARTIALLY_FULFILLED",
        stage_name: null,
        actor_name: "A Raveendra Prasad",
        comments: null,
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    const row = await screen.findByText("IND/2026/0008");
    expect(row.closest("button")?.querySelector(".text-ok")).toBeTruthy();
    expect(row.closest("button")?.querySelector(".text-bad")).toBeFalsy();
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

  it("hides approval buttons when backend capabilities are false", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent());

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject/i })).not.toBeInTheDocument();
  });

  it("shows approval buttons only when backend capabilities are true", async () => {
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({
      can_approve: true,
      can_reject: true,
    }));

    renderWithProviders(<IndentDetailPage />, "/indents/42");

    expect(await screen.findByRole("button", { name: /Approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/i })).toBeInTheDocument();
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

  it("pins an indent without opening the row and adds it to the Board cache", async () => {
    const bookmark = deferred<Indent>();
    const scope = { employeeId: mockAccount.employeeId, activePositionId: mockAccount.activePositionId };
    const row = {
      id: 42,
      indent_no: "IND/2026/0042",
      requested_by_name: "A Anil Kumar",
      department_name: "Operations",
      status: "DRAFT",
      priority: "NORMAL",
      total_items: 2,
      is_bookmarked: "NO",
      created_at: "2026-07-27T10:30:00Z",
    };
    const client = createTestQueryClient();
    client.setQueryData(indentKeys.board(scope, { is_bookmarked: "YES" }), {
      items: [],
      total: 0,
      page: 1,
      size: 50,
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [row],
      total: 1,
      page: 1,
      size: 20,
    });
    vi.mocked(indentApi.bookmark).mockReturnValueOnce(bookmark.promise);

    renderWithProviders(
      <>
        <IndentListPage />
        <LocationProbe />
      </>,
      "/indents",
      client,
    );

    const pin = (await screen.findAllByRole("button", { name: "Add to Board" }))
      .find((button) => button.getAttribute("aria-pressed") === "false");
    expect(pin).toBeTruthy();
    fireEvent.click(pin!);

    await waitFor(() => expect(indentApi.bookmark).toHaveBeenCalledWith(42));
    expect(screen.getByLabelText("location")).toHaveTextContent("/indents");
    expect(client.getQueryData<{ items: typeof row[] }>(indentKeys.board(scope, { is_bookmarked: "YES" }))?.items[0]).toMatchObject({
      id: 42,
      is_bookmarked: "YES",
    });
    await act(async () => {
      bookmark.resolve(detailIndent({ is_bookmarked: "YES" }));
      await bookmark.promise;
    });
  });

  it("rolls back and shows an error when pinning fails", async () => {
    const scope = { employeeId: mockAccount.employeeId, activePositionId: mockAccount.activePositionId };
    const row = {
      id: 42,
      indent_no: "IND/2026/0042",
      requested_by_name: "A Anil Kumar",
      department_name: "Operations",
      status: "DRAFT",
      priority: "NORMAL",
      total_items: 2,
      is_bookmarked: "NO",
      created_at: "2026-07-27T10:30:00Z",
    };
    const client = createTestQueryClient();
    client.setQueryData(indentKeys.board(scope, { is_bookmarked: "YES" }), {
      items: [],
      total: 0,
      page: 1,
      size: 50,
    });
    vi.mocked(indentApi.list).mockResolvedValueOnce({
      items: [row],
      total: 1,
      page: 1,
      size: 20,
    });
    vi.mocked(indentApi.bookmark).mockRejectedValueOnce(new Error("nope"));

    renderWithProviders(<IndentListPage />, "/indents", client);

    const pin = (await screen.findAllByRole("button", { name: "Add to Board" }))
      .find((button) => button.getAttribute("aria-pressed") === "false");
    expect(pin).toBeTruthy();
    fireEvent.click(pin!);

    expect(await screen.findByText("Could not update board bookmark. Please try again.")).toBeInTheDocument();
    expect(client.getQueryData<{ items: typeof row[] }>(indentKeys.board(scope, { is_bookmarked: "YES" }))?.items).toEqual([]);
  });

  it("opens the approval journey from the progress card by click and keyboard", async () => {
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
      name: "View complete approval journey for IND/2026/0042",
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
      name: "View complete approval journey for IND/2026/0043",
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
    expect(indentApi.journey).toHaveBeenCalledWith(42);
  });

  it("reuses the prefetched journey cache on the journey page", async () => {
    const client = createTestQueryClient();
    const first = renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
    first.unmount();

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey", client);

    expect(await screen.findByText("OE Review")).toBeInTheDocument();
    expect(indentApi.journey).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate journey requests on progress card interactions", async () => {
    renderWithProviders(<IndentDetailPage />, "/indents/42");

    const card = await screen.findByRole("button", {
      name: "View complete approval journey for IND/2026/0042",
    });
    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));

    fireEvent.pointerEnter(card);
    fireEvent.focus(card);
    fireEvent.pointerDown(card);

    await waitFor(() => expect(indentApi.journey).toHaveBeenCalledTimes(1));
  });

  it("updates the detail cache from approval response and invalidates journey", async () => {
    const client = createTestQueryClient();
    const nextIndent = detailIndent({
      status: "AWAITING_ALLOCATION",
      can_approve: false,
      can_reject: false,
      current_approver_name: null,
    });
    const approval = deferred<Indent>();
    vi.mocked(indentApi.get).mockResolvedValueOnce(detailIndent({ can_approve: true, can_reject: true }));
    vi.mocked(indentApi.approve).mockReturnValueOnce(approval.promise);
    const scope = { employeeId: 1, activePositionId: 10 };
    client.setQueryData(indentKeys.journey(scope, 42), journeyData());

    renderWithProviders(<IndentDetailPage />, "/indents/42", client);

    fireEvent.click(await screen.findByRole("button", { name: /Approve/i }));
    expect(await screen.findByRole("button", { name: /Approving/i })).toBeDisabled();

    approval.resolve(nextIndent);
    await waitFor(() => {
      expect(client.getQueryData<Indent>(indentKeys.detail(scope, 42))?.status).toBe("AWAITING_ALLOCATION");
    });
    expect(client.getQueryState(indentKeys.journey(scope, 42))?.isInvalidated).toBe(true);
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
      // Same provider stack as renderWithProviders — a rerender that drops one
      // unmounts and remounts the tree, which is not what this test is about.
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

  it("renders requester-specific stages and SPH/COO ANY_ONE outcome", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData());

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    expect(await screen.findByText("IND/2026/0042")).toBeInTheDocument();
    expect(screen.getByText("OE Review")).toBeInTheDocument();
    expect(screen.getByText("DM Review")).toBeInTheDocument();
    expect(screen.getByText("Final Approval - SPH or COO")).toBeInTheDocument();
    expect(screen.getByText("COO Authority")).toBeInTheDocument();
    expect(screen.getByText("Not required")).toBeInTheDocument();
    expect(screen.getAllByText("Ready for Allocation").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("OE approval completed")).toBeInTheDocument();
    expect(screen.getByText("Approved by C Ramakrishna")).toBeInTheDocument();
  });

  it("uses a vertical mobile-safe journey timeline", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData());

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const timeline = await screen.findByLabelText("Approval journey timeline");
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

  it("marks exactly one journey stage current and leaves future stages grey", async () => {
    vi.mocked(indentApi.journey).mockResolvedValueOnce(journeyData({
      current_stage_message: "Waiting for DM review",
      stages: [
        {
          sequence: 1,
          title: "Request Raised",
          status: "SUBMITTED",
          approver_name: "A Anil Kumar",
          timestamp: "2026-07-27T09:30:00Z",
          stage_type: "request",
          is_current: false,
        },
        {
          sequence: 2,
          title: "OE Review",
          status: "APPROVED",
          approver_name: "C Ramakrishna",
          timestamp: "2026-07-27T10:00:00Z",
          stage_type: "approval",
          is_current: false,
        },
        {
          sequence: 3,
          title: "DM Review",
          status: "PENDING",
          approver_name: "A Raveendra Prasad",
          stage_type: "approval",
          is_current: true,
        },
        {
          sequence: 4,
          title: "RM Review",
          status: "PENDING",
          approver_name: "Regional Manager",
          stage_type: "approval",
          is_current: false,
        },
      ],
    }));

    renderWithProviders(<IndentJourneyPage />, "/indents/42/journey");

    const current = (await screen.findByText("DM Review")).closest("article");
    const future = screen.getByText("RM Review").closest("article");
    expect(current).toHaveClass("border-brand/40");
    expect(future).toHaveClass("border-line");
    expect(future).not.toHaveClass("border-brand/40");
  });
});
