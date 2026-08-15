import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => ({
  me: {
    employee: { id: 7, name: "Sarah Buyer" },
    active_position: { id: 70, name: "Buyer" },
    roles: ["Buyer"],
  },
}));

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ me: mockAuth.me }),
}));

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { HomePage } from "../pages/HomePage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

const summary = {
  date_range: "week",
  kpis: [{
    key: "purchase_orders", label: "PURCHASE ORDERS", value: 15,
    detail: "5 Awaiting Delivery", detail_tone: "purple",
    href: "/pos", icon: "shopping-cart", tone: "purple",
  }],
  quick_actions: [{
    key: "create_po", label: "New Purchase Order", href: "/pos",
    icon: "shopping-cart", tone: "purple",
  }],
  modules: [{
    code: "grp_purchasing", name: "Procurement",
    description: "Manage purchase orders", href: "/pos", icon: "shopping-cart",
  }],
  needs_attention: [{
    key: "purchase_orders", label: "Purchase orders awaiting action",
    count: 5, href: "/pos", icon: "shopping-cart", tone: "purple",
  }],
  recent_activity: [],
};

function renderPage(client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    mockAuth.me = {
      employee: { id: 7, name: "Sarah Buyer" },
      active_position: { id: 70, name: "Buyer" },
      roles: ["Buyer"],
    };
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: summary });
  });

  it("renders only the RBAC-filtered sections returned by the backend", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Hello, Sarah" })).toBeInTheDocument(),
    );
    expect(screen.getByText("PURCHASE ORDERS")).toBeInTheDocument();
    expect(screen.getByText("New Purchase Order")).toBeInTheDocument();
    expect(screen.getByText("Procurement")).toBeInTheDocument();
    expect(screen.queryByText("Create Indent")).not.toBeInTheDocument();
    expect(screen.queryByText("Inventory")).not.toBeInTheDocument();
  });

  it("requests the selected date range", async () => {
    renderPage();
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(
        "/api/home/summary", { params: { date_range: "week" } },
      ),
    );
  });

  it("fetches fresh KPI values when the logged-in account position changes", async () => {
    const switchedSummary = {
      ...summary,
      kpis: [{ ...summary.kpis[0], value: 4 }],
    };
    mockGet
      .mockResolvedValueOnce({ data: summary })
      .mockResolvedValueOnce({ data: switchedSummary });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(client);

    await screen.findByText("15");
    mockAuth.me = {
      employee: { id: 15037, name: "Anusha" },
      active_position: { id: 1501, name: "Lab Technician" },
      roles: ["LT"],
    };
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hello, Anusha" })).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
