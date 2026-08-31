import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const heldPermissions = new Set<string>(["issue.view", "issue.create"]);
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: (code: string) => heldPermissions.has(code) }),
}));

// Mock the API calls for the warehouse module
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    occupancyPreview: vi.fn().mockResolvedValue([
      {
        location_id: 10,
        location_code: "BIN-1",
        location_name: "BIN-1",
        capacity_volume: 500,
        occupied_volume: 100,
        free_volume: 400,
        direction: "OUT",
        move_volume: 10,
        headline: "BIN-1 frees up 10 m³",
        unmeasured_lines: 0,
        lines: [],
      }
    ]),
    getIssue: vi.fn().mockResolvedValue({
      id: 1,
      issue_no: "ISS/001",
      warehouse_id: 1,
      status: "DRAFT",
      items: [
        { item_id: 1, bin_id: 10, requested_qty: 10, issued_qty: 10, rate: 0, serial_numbers: [] }
      ]
    }),
    issueApprovalHistory: vi.fn().mockResolvedValue([]),
    warehouseOptions: vi.fn().mockResolvedValue([{ id: 1, name: "Main Store", is_bin_managed: true }]),
  };
});

import MaterialIssueForm from "../pages/MaterialIssueForm";

const wrap = (ui: React.ReactNode, path = "/") => (
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/warehouse/material-issues/:id" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

describe("MaterialIssueForm CapacityMeter wiring", () => {
  it("renders the Space freed section for an issue with items", async () => {
    render(wrap(<MaterialIssueForm />, "/warehouse/material-issues/1"));

    // Wait for the capacity meter's text to appear
    await waitFor(() => {
      expect(screen.getByText("Space freed")).toBeInTheDocument();
      expect(screen.getByText("BIN-1 frees up 10 m³")).toBeInTheDocument();
    });
  });
});
