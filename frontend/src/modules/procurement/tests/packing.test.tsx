import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { PackEntry, PackHierarchy } from "@/shared/packing/packing";
import type { POPackChange } from "../types";

const granted = new Set<string>();
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: (code: string) => granted.has(code) }),
}));
const packChanges = vi.fn();
const decidePackChange = vi.fn();
vi.mock("../api", () => ({
  poApi: {
    packChanges: (...a: unknown[]) => packChanges(...a),
    decidePackChange: (...a: unknown[]) => decidePackChange(...a),
  },
}));
vi.mock("@/shared/components/Toast", async (orig) => ({
  ...(await orig<object>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { PackOrderRow } = await import("../components/PackOrderRow");
const { PackChangesPanel } = await import("../components/PackChangesPanel");

const ladder = (id: number, name: string, strip: number): PackHierarchy => ({
  hierarchy_id: id, name, base_uom: "TAB",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose TAB", size: 1, ratio: 1, label: "Loose TAB" },
    { item_packaging_id: id * 10 + 1, level: 1, name: "Strip", size: strip, ratio: strip,
      label: `Strip (${strip} TAB)` },
    { item_packaging_id: id * 10 + 2, level: 2, name: "Box", size: strip * 10, ratio: 10,
      label: `Box · 10 Strip (${strip * 10} TAB)` },
  ],
});
const TEN = ladder(1, "Strip of 10", 10);
const FIFTEEN = ladder(2, "Strip of 15", 15);

beforeEach(() => { granted.clear(); packChanges.mockReset(); decidePackChange.mockReset(); });

function Line({ start = "" }: { start?: string }) {
  const [line, setLine] = useState<{ quantity: string; pack_hierarchy_id?: number | null;
                                     pack_breakdown?: PackEntry[] | null }>({ quantity: start });
  return (
    <>
      <PackOrderRow hierarchies={[TEN, FIFTEEN]} hierarchyId={line.pack_hierarchy_id}
                    breakdown={line.pack_breakdown} quantity={line.quantity} uom="TAB"
                    onChange={(patch) => setLine((l) => ({ ...l, ...patch }))} />
      <output data-testid="qty">{line.quantity}</output>
    </>
  );
}

describe("a PO line ordered in packs", () => {
  it("keeps the typed quantity; the packs only describe it", () => {
    render(<Line start="1000" />);
    expect(screen.getByText(/Ordered loose/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Order in Strip of 10" }));
    // The biggest level is offered first: Box of 100 -> 10 Box.
    expect(screen.getByTestId("qty").textContent).toBe("1000");
    expect(screen.getByText(/Rounded up to whole Box \(100 TAB each\): 10\./)).toBeTruthy();
  });

  it("puts what does not fill a pack into one part pack", () => {
    render(<Line start="1050" />);
    fireEvent.click(screen.getByRole("button", { name: "Order in Strip of 10" }));
    // 10 Box of 100 and one Box holding 50.
    expect(screen.getByText("(50/100)")).toBeTruthy();
    expect(screen.getByText(/Rounded up to whole Box \(100 TAB each\): 11\./)).toBeTruthy();
  });

  it("re-describes the same quantity in another hierarchy", () => {
    render(<Line start="1050" />);
    fireEvent.click(screen.getByRole("button", { name: "Order in Strip of 10" }));
    fireEvent.click(screen.getByRole("radio", { name: /Strip of 15/ }));
    expect(screen.getByTestId("qty").textContent).toBe("1050");     // never moves
    expect(screen.getByText(/Rounded up to whole Box \(150 TAB each\): 7\./)).toBeTruthy();  // 7 x 150
  });
});

const change: POPackChange = {
  id: 7, despatch_note_id: 3, dn_no: "DN-0001", dn_status: "SUBMITTED", po_item_id: 1,
  item_id: 1, item_code: "TAB-0001", item_name: "Paracetamol", uom_code: "TAB",
  despatched_qty: 750, status: "PENDING", ordered_hierarchy_name: "Strip of 10",
  sent_hierarchy_name: "Strip of 15", sent_pack_text: "5 Box = 750 TAB",
  pack_breakdown: [{ level: 2, name: "Box", size: 150, qty: 5, hierarchy: "Strip of 15" }],
  reason: "10-strips out of stock",
};

const panel = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><PackChangesPanel poId={5} /></MemoryRouter>
  </QueryClientProvider>);

describe("the buyer's packing-changes panel", () => {
  it("draws nothing when the supplier kept the order's packing", async () => {
    packChanges.mockResolvedValue([]);
    const { container } = panel();
    await waitFor(() => expect(packChanges).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("names what was ordered, what was sent and why", async () => {
    packChanges.mockResolvedValue([change]);
    panel();
    expect(await screen.findByText(/10-strips out of stock/)).toBeTruthy();
    expect(screen.getByText("1 to answer")).toBeTruthy();
    // No permission, no buttons — the backend refuses it anyway.
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });

  it("accepts in one press, and will not decline without a reason", async () => {
    granted.add("po.pack_change");
    packChanges.mockResolvedValue([change]);
    decidePackChange.mockResolvedValue({ ...change, status: "ACCEPTED" });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: /Decline/ }));
    expect(screen.getByRole("button", { name: /Decline change/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why the change is declined"),
                     { target: { value: "Different MRP" } });
    expect(screen.getByRole("button", { name: /Decline change/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Accept Strip of 15/ }));
    await waitFor(() => expect(decidePackChange).toHaveBeenCalledWith(5, 7, true, ""));
  });
});
