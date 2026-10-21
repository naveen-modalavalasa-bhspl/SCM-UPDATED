import { describe, expect, it, vi, beforeEach } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PackHierarchy } from "@/shared/packing/packing";
import type { POItem } from "../types";

vi.mock("@/shared/auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));
const ladder = (id: number, name: string, pack: number): PackHierarchy => ({
  hierarchy_id: id, name, base_uom: "NOS",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose NOS", size: 1, ratio: 1, label: "" },
    { item_packaging_id: id * 10 + 1, level: 1, name: "Pack", size: pack, ratio: pack, label: "" },
    { item_packaging_id: id * 10 + 2, level: 2, name: "Carton", size: pack * 10, ratio: 10, label: "" },
  ],
});
vi.mock("@/shared/packing/api", async (orig) => ({
  ...(await orig<object>()),
  usePackOptions: () => ({ data: { 3: [ladder(1, "pack of 500", 500), ladder(2, "pack of 450", 450)] } }),
}));
const repackLine = vi.fn();
vi.mock("../api", () => ({ poApi: { repackLine: (...a: unknown[]) => repackLine(...a) } }));
vi.mock("@/shared/components/Toast", async (orig) => ({
  ...(await orig<object>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
const { POLinePacking } = await import("../components/POLinePacking");

const LINE: POItem = {
  id: 9, item_id: 3, item_name: "A4 Paper 75 GSM", uom_code: "NOS", quantity: 650, rate: 1,
  tax_percent: 12, amount: 650, received_quantity: 0, pack_hierarchy_id: 1,
  pack_breakdown: [
    { item_packaging_id: 11, level: 1, name: "Pack", size: 500, qty: 1, hierarchy: "pack of 500" },
    { item_packaging_id: null, level: 0, name: "Loose", size: 1, qty: 150, hierarchy: "pack of 500" },
  ],
};
const show = (status: string, line: POItem = LINE) => render(
  <QueryClientProvider client={new QueryClient()}>
    <POLinePacking poId={54} poStatus={status} line={line} />
  </QueryClientProvider>);

beforeEach(() => repackLine.mockReset().mockResolvedValue({}));

describe("changing a PO line's packing", () => {
  it("on an approved order, re-packs only to the approved quantity", async () => {
    show("APPROVED");
    fireEvent.click(screen.getByRole("button", { name: /Change packing/ }));
    expect(screen.getByText(/ordered quantity stays 650 NOS/)).toBeTruthy();
    const save = () => screen.getByRole("button", { name: /Save packing/ });
    // Switching to pack-of-450 keeps 650: 1 Pack + 200 loose.
    fireEvent.click(screen.getByRole("radio", { name: /pack of 450/ }));
    expect(save()).not.toBeDisabled();
    // One more pack would be 1,100 — not what was approved.
    fireEvent.click(screen.getByRole("button", { name: "One more Pack" }));
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "One fewer Pack" }));
    fireEvent.click(save());
    await waitFor(() => expect(repackLine).toHaveBeenCalledWith(54, 9, {
      pack_hierarchy_id: 2,
      pack_breakdown: [{ item_packaging_id: 21, level: 1, qty: 1 },
                       { item_packaging_id: null, level: 0, qty: 200 }],
    }));
  });

  it("on a draft too, packing never changes the ordered quantity", () => {
    show("DRAFT", { ...LINE, quantity: 500, amount: 500, pack_breakdown: [
      { item_packaging_id: 11, level: 1, name: "Pack", size: 500, qty: 1, hierarchy: "pack of 500" },
    ] });
    fireEvent.click(screen.getByRole("button", { name: /Change packing/ }));
    const save = () => screen.getByRole("button", { name: /Save packing/ });
    fireEvent.click(screen.getByRole("button", { name: "One more Pack" }));
    expect(save()).toBeDisabled();
    // Switching hierarchy re-packs the same 500 and says how many packs it needs.
    fireEvent.click(screen.getByRole("radio", { name: /pack of 450/ }));
    expect(save()).not.toBeDisabled();
    expect(screen.getByText(/500 NOS needs/)).toBeTruthy();
    expect(screen.getByText(/2 Pack/)).toBeTruthy();
    expect(screen.getByText(/ordered quantity stays 500 NOS/)).toBeTruthy();
  });

  it("is read-only once goods have arrived", () => {
    show("PARTIALLY_RECEIVED");
    expect(screen.queryByRole("button", { name: /Change packing/ })).toBeNull();
    expect(screen.getByText(/1 Pack/)).toBeTruthy();
  });
});
