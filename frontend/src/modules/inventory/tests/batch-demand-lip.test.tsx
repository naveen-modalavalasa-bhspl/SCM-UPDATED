import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

// The Submit bar sits behind <Can do="allocation.create">; these run as somebody who
// holds it, the same way the allocation-approvals tests do.
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: () => true }),
}));

import { api } from "@/shared/api/client";
import { BatchDemandView } from "../components/BatchDemandView";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

/**
 * The case from the Fulfilment Desk, 2026-08-22: 44 asked for, nothing in any
 * warehouse, and 5 sitting at one LIP.
 *
 * A LIP is a distribution ENDPOINT. Its 5 units are real, and an allocator may still
 * draw on them, but they are not stock the warehouse can fill an indent from — so the
 * desk must not propose them, and must not count them as cover that keeps 5 units off
 * the material request.
 */
const ITEM = {
  item_id: 12,
  item_code: "102020-ABS-COTTON-DATT-DATT-0001",
  item_name: "Absorbent Cotton 500 g",
  uom_code: "NOS",
  uom_decimals: 0,
  indent_count: 1,
  urgent_count: 1,
  total_demand: 44,
  available_total: 5,
  main_available_qty: 0,
  shortfall: 39,
  warehouses: [
    {
      warehouse_id: 176,
      warehouse_name: "AP-104-MMU-Gurla-AP39UL4234 - LIP",
      warehouse_type: "LIP",
      available_qty: 5,
    },
  ],
  demand: [{
    indent_id: 1,
    indent_no: "BHS/104/2026-27/IND0001",
    indent_item_id: 91,
    requested_by_name: "Pudi Krishnamnaidu",
    department_name: null,
    project_name: null,
    priority: "URGENT",
    required_date: null,
    pending_qty: 44,
    raised_at: "2026-08-20T09:00:00Z",
  }],
};

function draw() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BatchDemandView />
    </QueryClientProvider>,
  );
}

/** The row is collapsed until its header is pressed. */
async function openRow() {
  const header = await screen.findByText("Absorbent Cotton 500 g");
  fireEvent.click(header.closest("button")!);
}

const shelf = () => screen.getByLabelText(/Source warehouse 1/i) as HTMLSelectElement;
const takeFromHere = () => screen.getByLabelText(/Quantity from source 1/i) as HTMLInputElement;

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation(() => Promise.resolve({ data: { items: [ITEM] } }));
});

describe("Fulfilment Desk — stock sitting on the distribution chain", () => {
  it("does not preselect a LIP, and sends the WHOLE demand to procurement", async () => {
    draw();
    await openRow();

    // No shelf chosen: the only stock is on a chain point, and taking it out of one
    // is a decision, not a default.
    expect(shelf().value).toBe("");
    expect(takeFromHere().value).toBe("0");

    // All 44, not 39 — the LIP's 5 are not cover.
    expect(await screen.findByLabelText(/Send the shortfall/i)).toBeChecked();
    expect(screen.getByText(/Send the 44 NOS no shelf can cover to/)).toBeInTheDocument();
    expect(screen.queryByText(/not issued — still in/)).not.toBeInTheDocument();
  });

  it("labels the LIP in the picker and keeps it selectable", async () => {
    draw();
    await openRow();
    expect(
      screen.getByRole("option", { name: /Gurla.*LIP.*distribution point/ }),
    ).toBeInTheDocument();
  });

  it("re-counts the shortfall the moment Take from here changes", async () => {
    // THE reported bug: setting the shelf quantity back to 0 left the checkbox still
    // offering to buy 39, because the shortfall was measured against `available_total`
    // — which counts the LIP — so the same 5 were subtracted whatever was typed.
    draw();
    await openRow();

    fireEvent.change(shelf(), { target: { value: "176" } });
    fireEvent.change(takeFromHere(), { target: { value: "5" } });
    await waitFor(() =>
      expect(screen.getByText(/Send the 39 NOS no shelf can cover to/)).toBeInTheDocument());

    fireEvent.change(takeFromHere(), { target: { value: "0" } });
    await waitFor(() =>
      expect(screen.getByText(/Send the 44 NOS no shelf can cover to/)).toBeInTheDocument());
    expect(screen.queryByText(/Send the 39 NOS/)).not.toBeInTheDocument();
  });
});
