import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterBar } from "../components/IndentFilterBar";
import { IndentsNav } from "../components/IndentsNav";
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
import type { Indent, IndentJourney } from "../types";

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
        action: "APPROVED",
        stage_name: "Reporting Manager",
        actor_name: "Anita Appr",
        comments: "Approved",
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
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/indents/:id/journey" element={ui} />
          <Route path="/indents/:id" element={ui} />
          <Route path="/indents/*" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
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

  it("renders acknowledgment rows with indent, actor, action, stage and timestamp", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    expect(screen.getByText(/Anita Appr\s+·\s+approved at Reporting Manager/i)).toBeInTheDocument();
    expect(screen.getByText(/27 Jul/i)).toBeInTheDocument();
  });

  it("renders District Manager acknowledgment labels without using Submitted as the stage", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValueOnce({
      items: [
        {
          id: 71,
          indent_id: 421,
          indent_no: "IND/2026/DM-SUB",
          action: "SUBMITTED",
          stage_name: "District Manager",
          actor_name: "V Suresh Kumar",
          comments: "Submitted",
          acted_at: "2026-07-27T10:30:00Z",
        },
        {
          id: 72,
          indent_id: 422,
          indent_no: "IND/2026/DM-APP",
          action: "APPROVED",
          stage_name: "District Manager",
          actor_name: "V Suresh Kumar",
          comments: "Approved",
          acted_at: "2026-07-27T10:31:00Z",
        },
        {
          id: 73,
          indent_id: 423,
          indent_no: "IND/2026/RM-APP",
          action: "APPROVED",
          stage_name: "Reporting Manager",
          actor_name: "Anita Appr",
          comments: "Approved",
          acted_at: "2026-07-27T10:32:00Z",
        },
      ],
      total: 3,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/DM-SUB")).toBeInTheDocument();
    expect(screen.getByText(/V Suresh Kumar\s+·\s+submitted at District Manager/i)).toBeInTheDocument();
    expect(screen.getByText(/V Suresh Kumar\s+·\s+approved at District Manager/i)).toBeInTheDocument();
    expect(screen.queryByText(/V Suresh Kumar\s+·\s+submitted at Submitted/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Anita Appr\s+·\s+approved at Reporting Manager/i)).toBeInTheDocument();
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

  it("passes acknowledgment actor, action and stage search to the backend", async () => {
    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    expect(await screen.findByText("IND/2026/0007")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search indents" });
    fireEvent.change(search, { target: { value: "Anita Appr" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "Anita Appr",
    })));

    fireEvent.change(search, { target: { value: "REJECTED" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "REJECTED",
    })));

    fireEvent.change(search, { target: { value: "Reporting Manager" } });
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      search: "Reporting Manager",
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
    fireEvent.click(await screen.findByText("Draft"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      status: ["DRAFT"],
    })));

    fireEvent.click(screen.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(await screen.findByText("Urgent"));
    await waitFor(() => expect(indentApi.acknowledgments).toHaveBeenLastCalledWith(expect.objectContaining({
      priority: ["URGENT"],
    })));
  });

  it("keeps Activity legacy filters in More filters and sends all filters to the API", async () => {
    renderWithProviders(<IndentReportsPage />, "/indents/reports");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transaction" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    expect(screen.getByRole("button", { name: "Transaction" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Movement" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByText("Approved"));
    fireEvent.click(screen.getByRole("button", { name: "Movement" }));
    fireEvent.click(await screen.findByText("Outward"));
    fireEvent.change(screen.getByLabelText("Item ID"), { target: { value: "123" } });

    await waitFor(() => expect(indentApi.activity).toHaveBeenLastCalledWith(expect.objectContaining({
      transaction_type: "APPROVED",
      direction: "OUTWARD",
      item_id: 123,
    })));
  });

  it("hides unsupported Date, Status and Priority filters on Waiting for me", async () => {
    renderWithProviders(<IndentApprovalsPage />, "/indents/approvals");

    expect(await screen.findByRole("searchbox", { name: "Search indents" })).toBeInTheDocument();
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
        action: "APPROVED",
        stage_name: "Reporting Manager",
        actor_name: "Anita Appr",
        comments: "Approved",
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
        action: "APPROVED",
        stage_name: "Reporting Manager",
        actor_name: "Anita Appr",
        comments: "Approved",
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
        action: "APPROVED",
        stage_name: "Reporting Manager",
        actor_name: "Anita Appr",
        comments: "Approved",
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

    expect(await screen.findByText("No acknowledgments found for “missing actor”")).toBeInTheDocument();
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

  it("shows rejected acknowledgments with red rejection styling", async () => {
    vi.mocked(indentApi.acknowledgments).mockResolvedValueOnce({
      items: [{
        id: 8,
        indent_id: 42,
        indent_no: "IND/2026/0008",
        action: "REJECTED",
        stage_name: "District Manager",
        actor_name: "A Raveendra Prasad",
        comments: "Rejected",
        acted_at: "2026-07-27T10:30:00Z",
      }],
      total: 1,
      page: 1,
      size: 20,
    });

    renderWithProviders(<IndentAcknowledgmentsPage />, "/indents/acknowledgments");

    const row = await screen.findByText("IND/2026/0008");
    expect(row.closest("button")?.querySelector(".text-bad")).toBeTruthy();
    expect(row.closest("button")?.querySelector(".text-ok")).toBeFalsy();
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
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/indents/42"]}>
          <Routes>
            <Route path="/indents/:id" element={<IndentDetailPage />} />
          </Routes>
        </MemoryRouter>
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
