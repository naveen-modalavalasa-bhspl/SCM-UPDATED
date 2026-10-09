import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { AppLogsPage } from "../pages/AppLogsPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

const LOG = {
  id: 1,
  request_id: "request-123",
  source: "BACKEND",
  level: "ERROR",
  message: "Stock lookup failed",
  error_type: "RuntimeError",
  status_code: 500,
  http_method: "GET",
  endpoint: "/api/stock",
  page_url: "http://localhost:5173/inventory",
  source_file: "backend/app/modules/inventory/service.py",
  function_name: "get_stock",
  line_number: 42,
  column_number: 9,
  stack_trace: "Traceback\n  at get_stock (service.py:42:9)",
  actor_id: 7,
  actor_name: "System Admin",
  context_data: { kind: "api", query_fields: ["warehouse_id"] },
  created_at: "2026-07-29T10:30:00Z",
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}>
      <AppLogsPage />
    </QueryClientProvider>,
  );
}

describe("AppLogsPage", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      data: { items: [LOG], total: 1, page: 1, size: 25 },
    });
  });

  it("shows source, status, message, endpoint and exact code location", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getAllByText("Stock lookup failed").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("BACKEND").length).toBeGreaterThan(0);
    expect(screen.getAllByText("500").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GET /api/stock").length).toBeGreaterThan(0);
    expect(screen.getAllByText(
      "backend/app/modules/inventory/service.py:42:9",
    ).length).toBeGreaterThan(0);
  });

  it("opens full details and the stack trace when a row is clicked", async () => {
    renderPage();
    await waitFor(() => screen.getAllByText("Stock lookup failed"));

    const mobileRow = screen.getAllByRole("button").find(
      (button) => button.textContent?.includes("Stock lookup failed"),
    );
    expect(mobileRow).toBeDefined();
    fireEvent.click(mobileRow!);

    await waitFor(() =>
      expect(screen.getByText("Application error details")).toBeInTheDocument(),
    );
    expect(screen.getByText(/at get_stock \(service\.py:42:9\)/)).toBeInTheDocument();
    expect(screen.getByText("request-123")).toBeInTheDocument();
    expect(screen.getByText(/warehouse_id/)).toBeInTheDocument();
  });
});
