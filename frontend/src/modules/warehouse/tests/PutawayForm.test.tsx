import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const heldPermissions = new Set<string>(["putaway.create"]);
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: (code: string) => heldPermissions.has(code) }),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    locationOccupancy: vi.fn().mockResolvedValue(
      {
        location_id: 20,
        location_code: "BIN-2",
        location_name: "BIN-2",
        capacity_volume: 500,
        occupied_volume: 450,
        free_volume: 50,
        direction: "IN",
        move_volume: 20,
        headline: "BIN-2 has room",
        unmeasured_lines: 0,
        lines: [],
      }
    ),
    getPutaway: vi.fn().mockResolvedValue({
      id: 1,
      putaway_no: "PUT/001",
      warehouse_id: 1,
      status: "pending",
      receipt_id: 10,
      item_id: 1,
      qty: 20,
      actual_bin_id: 20,
    }),
    warehouseOptions: vi.fn().mockResolvedValue([{ id: 1, name: "Main Store", is_bin_managed: true }]),
  };
});

import PutawayForm from "../pages/PutawayForm";

const wrap = (ui: React.ReactNode, path = "/") => (
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/warehouse/putaways/:id" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

describe("PutawayForm CapacityMeter wiring", () => {
  it("renders the Space required section for a putaway with items", async () => {
    render(wrap(<PutawayForm />, "/warehouse/putaways/1"));

    await waitFor(() => {
      expect(screen.getByText("BIN-2 has room")).toBeInTheDocument();
    });
    
    // The mocked occupancyPreview returns "BIN-2 has room"
    expect(screen.getByText("BIN-2 has room")).toBeInTheDocument();
  });
});
