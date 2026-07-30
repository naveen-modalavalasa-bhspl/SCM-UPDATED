import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    me: { employee: { name: "Sarah Buyer" }, roles: ["Buyer"] },
  }),
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
    code: "grp_purchasing", name: "Purchasing",
    description: "Manage purchase orders", href: "/pos", icon: "shopping-cart",
  }],
  needs_attention: [{
    key: "purchase_orders", label: "Purchase orders awaiting action",
    count: 5, href: "/pos", icon: "shopping-cart", tone: "purple",
  }],
  recent_activity: [],
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  beforeEach(() => {
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
    expect(screen.getByText("Purchasing")).toBeInTheDocument();
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
});
