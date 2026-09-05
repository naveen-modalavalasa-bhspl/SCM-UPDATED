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
        // The four gates the meter draws. A cube-only payload is not what the server
        // sends, and a fixture that pretends otherwise stops testing the real screen.
        gates: [{
          key: "VOLUME", label: "Cube", unit: "m³", status: "OK",
          capacity: 500, occupied: 450, projected: 470, free: 30, over_by: 0, pct: 94,
          detail: "30 m³ of 500 m³ free after this.", note: null,
        }],
        lines: [],
      }
    ]),
    getIssue: vi.fn().mockResolvedValue({
      id: 1,
      issue_no: "ISS/001",
      warehouse_id: 1,
      status: "DRAFT",
      // One ask served out of TWO bays — the shape the flat grid could not express.
      // Both lines carry the same indent line, which is what makes them two picks of
      // one ask rather than two unrelated rows.
      items: [
        {
          id: 101, item_id: 1, indent_item_id: 55, bin_id: 10, batch_id: 11,
          item_code: "303010-MONITOR-HP-HP-0001", item_name: "All-in-One Monitor",
          bin_code: "F1-A1-R1-B1", batch_no: "AUG-26",
          requested_qty: 5, issued_qty: 5, rate: 0,
          tracking_type: "ASSET", unit_mode: "CODE", has_units: true,
          serial_numbers: ["AST-MON-2026-001"], unit_keys: ["AST-MON-2026-001"],
        },
        {
          id: 102, item_id: 1, indent_item_id: 55, bin_id: 20, batch_id: 12,
          item_code: "303010-MONITOR-HP-HP-0001", item_name: "All-in-One Monitor",
          bin_code: "F1-A2-R3-B2", batch_no: "SEP-26",
          requested_qty: 10, issued_qty: 10, rate: 0,
          tracking_type: "ASSET", unit_mode: "CODE", has_units: true,
          serial_numbers: [], unit_keys: [],
        },
      ],
    }),
    issueApprovalHistory: vi.fn().mockResolvedValue([]),
    warehouseOptions: vi.fn().mockResolvedValue([{ id: 1, name: "Main Store", is_bin_managed: true }]),
    trackingTypes: vi.fn().mockResolvedValue([
      { code: "ASSET", label: "Asset tag", unit: "asset tag",
        hint: "Scan the asset tag stamped on the unit at putaway." },
    ]),
    issueStockSources: vi.fn().mockResolvedValue([
      {
        item_id: 1, bin_id: 10, bin_code: "F1-A1-R1-B1",
        bin_path: "F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B1",
        batch_id: 11, batch_no: "AUG-26",
        available_qty: 0, reserved_qty: 5, own_reserved_qty: 5,
        total_qty: 5, drawable_qty: 5,
      },
      {
        item_id: 1, bin_id: 20, bin_code: "F1-A2-R3-B2",
        bin_path: "F1 / F1-A2 / F1-A2-R3 / F1-A2-R3-B2",
        batch_id: 12, batch_no: "SEP-26",
        available_qty: 0, reserved_qty: 10, own_reserved_qty: 10,
        total_qty: 10, drawable_qty: 10,
      },
    ]),
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

const open = () => render(wrap(<MaterialIssueForm />, "/warehouse/material-issues/1"));

describe("MaterialIssueForm", () => {
  it("renders the calculation breakdown for an issue with items", async () => {
    open();
    await waitFor(() => {
      expect(screen.getByText("Calculation breakdown")).toBeInTheDocument();
    });
  });

  it("names the kind of identifier the item is tracked by, from the served catalogue", async () => {
    open();
    // "Asset tag" rather than an undifferentiated column of codes. The word comes
    // from the backend's TRACKING_META, never from the screen.
    await waitFor(() => {
      expect(screen.getAllByText("Asset tag").length).toBeGreaterThan(0);
    });
  });

  it("reads two lines against one indent line as one ask over two locations", async () => {
    open();
    // ONE row for the item, with both bays inside it — and one set of column
    // headings for the whole document, not one per item.
    await waitFor(() => {
      expect(screen.getAllByText("Item & what it is owed").length).toBe(1);
    });
    // Both bays are named, which the single-location grid could not do.
    await waitFor(() => {
      expect(screen.getAllByText(/F1-A1-R1-B1/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/F1-A2-R3-B2/).length).toBeGreaterThan(0);
  });

  it("draws the whole storage hierarchy, not a bare bin code", async () => {
    open();
    // The walk down to the bay, served as `bin_path`. A picker reading
    // `F1-A1-R1-B1` alone has been handed a memory test, not a destination.
    await waitFor(() => {
      expect(screen.getAllByText("F1-A1-R1").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("F1-A2").length).toBeGreaterThan(0);
  });

  it("says what each location is holding for this document", async () => {
    open();
    // `available_qty` is 0 on both rows — the allocation reserved them — and saying
    // so on its own told a storekeeper his correct document was impossible.
    await waitFor(() => {
      expect(screen.getAllByText(/allocated here/).length).toBe(2);
    });
  });

  it("counts identifiers per pick, so a pick with none is called out on its own row", async () => {
    open();
    // 15 issued over two picks with one code on the first: the item-level count of
    // "1 of 15" used to be the only signal, and it said nothing about WHICH pick was
    // unscanned. Each pick states its own gap, on the pick.
    await waitFor(() => {
      expect(screen.getAllByText("4 more to assign").length).toBe(1);
    });
    expect(screen.getAllByText("10 more to assign").length).toBe(1);
  });
});
