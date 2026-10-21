import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { greedy, type PackHierarchy } from "@/shared/packing/packing";
import type { IssueItemWrite, LotPacks, ReceiptItemWrite } from "../types";

/** Which permissions the signed-in person holds, per test. `<Can>` reads it. */
const granted = new Set<string>();
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: (code: string) => granted.has(code) }),
}));

const lotPacks = vi.fn();
const repackLot = vi.fn();
vi.mock("../api", () => ({
  lotPacks: (...a: unknown[]) => lotPacks(...a),
  repackLot: (...a: unknown[]) => repackLot(...a),
}));
vi.mock("@/shared/components/Toast", async (orig) => ({
  ...(await orig<object>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { ReceiptLinePacking } = await import("../components/ReceiptLinePacking");
const { IssuePickPacking } = await import("../components/IssuePickPacking");
const { RepackDialog } = await import("../components/RepackDialog");

const STRIP_OF_15: PackHierarchy = {
  hierarchy_id: 2, name: "Strip of 15", base_uom: "TAB",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose TAB", size: 1, ratio: 1, label: "Loose TAB" },
    { item_packaging_id: 21, level: 1, name: "Strip", size: 15, ratio: 15, label: "Strip (15 TAB)" },
    { item_packaging_id: 22, level: 2, name: "Box", size: 150, ratio: 10, label: "Box · 10 Strip (150 TAB)" },
    { item_packaging_id: 23, level: 3, name: "Carton", size: 600, ratio: 4, label: "Carton · 4 Box (600 TAB)" },
  ],
};
const declared = greedy(STRIP_OF_15, 750, 2);          // 5 Box, as the supplier sent it

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {node}
  </QueryClientProvider>
);

beforeEach(() => { granted.clear(); lotPacks.mockReset(); repackLot.mockReset(); });

/* --------------------------------------------------------------------- the gate -- */
function GateLine(extra: Partial<ReceiptItemWrite> = {}) {
  const [line, setLine] = useState<ReceiptItemWrite>({
    item_id: 1, uom_code: "TAB", received_qty: 750, pack_hierarchy_id: 2,
    declared_pack_breakdown: declared, pack_breakdown: declared, ...extra,
  });
  return (
    <>
      <ReceiptLinePacking line={line} hierarchies={[STRIP_OF_15]}
                          onChange={(patch) => setLine((l) => ({ ...l, ...patch }))} />
      <output data-testid="received">{String(line.received_qty)}</output>
    </>
  );
}

describe("receipt line packing (the gate)", () => {
  it("shows the declared packing locked and counts only what was sent", () => {
    render(<GateLine />);
    expect(screen.getByText(/Supplier sent/)).toBeTruthy();
    expect(screen.getByText(/from the despatch note, fixed/)).toBeTruthy();
    // Only the declared level (Box) and loose are offered — no Strip, no Carton.
    expect(screen.queryByLabelText("Strip count")).toBeNull();
    expect(screen.queryByLabelText("Carton count")).toBeNull();
    // Never over what was declared.
    expect(screen.getByRole("button", { name: "One more Box" })).toBeDisabled();
  });

  it("makes the received quantity the count, and says what is short", () => {
    render(<GateLine />);
    fireEvent.click(screen.getByRole("button", { name: "One fewer Box" }));
    expect(screen.getByTestId("received").textContent).toBe("600");
    expect(screen.getByText(/Short of the despatch note by 150 TAB/)).toBeTruthy();
  });

  it("tells the gate when the buyer declined the supplier's packing", () => {
    render(<GateLine pack_change_status="DECLINED" ordered_pack_hierarchy_name="Strip of 10"
                     pack_change_note="Different MRP" />);
    expect(screen.getByText(/The buyer DECLINED this packing/)).toBeTruthy();
    expect(screen.getByText(/Different MRP/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------- the issue -- */
function Pick({ codes = true, locked = false }: { codes?: boolean; locked?: boolean }) {
  const [line, setLine] = useState<IssueItemWrite>({ item_id: 1, requested_qty: 150, issued_qty: 150 });
  return (
    <>
      <IssuePickPacking line={line} hierarchies={[STRIP_OF_15]} codesPerPack={codes}
                        locked={locked} uom="TAB"
                        onChange={(patch, qty) => setLine((l) => ({
                          ...l, ...patch, ...(qty !== undefined ? { issued_qty: qty } : {}) }))} />
      <output data-testid="qty">{String(line.issued_qty)}</output>
    </>
  );
}

describe("issue a pick in packs", () => {
  it("lets the packs set the issue quantity", () => {
    render(<Pick />);
    fireEvent.click(screen.getByRole("button", { name: /Issue in packs/ }));
    // Whole packs of what was asked: 150 = 1 Box.
    expect(screen.getAllByText(/1 Box/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "One more Strip" }));
    expect(screen.getByTestId("qty").textContent).toBe("165");
  });

  it("offers break bulk only to someone who holds the permission", () => {
    const { unmount } = render(<Pick />);
    expect(screen.queryByText("Break bulk")).toBeNull();
    unmount();
    granted.add("issue.break_bulk");
    render(<Pick />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/its code retires/)).toBeTruthy();
  });

  it("never offers break bulk where packs carry no code", () => {
    granted.add("issue.break_bulk");
    render(<Pick codes={false} />);
    expect(screen.queryByText("Break bulk")).toBeNull();
  });
});

/* ------------------------------------------------------------------ the repack -- */
const LOT: LotPacks = {
  stock_id: 9, item_id: 1, warehouse_id: 1, bin_id: 5, batch_id: 0, project_id: 0,
  item_code: "TAB-0001", item_name: "Paracetamol", uom_code: "TAB", bin_code: "F1-B1",
  total_qty: 735, available_qty: 735, reserved_qty: 0, loose_qty: 0,
  pack_text: "3 Box + 19 Strip = 735 TAB", codes_per_pack: true, serialised: false,
  hierarchies: [{
    ...STRIP_OF_15, in_use: true, coded_floor: 1, top_counts: { "1": 19, "2": 3, "3": 0 },
    packs: [{ id: 20, hu_code: "TAB-0001-20-BOX", code_kind: "CONSUMABLE", level: 2,
              pack_name: "Box", pack_size: 150, is_atom: true, status: "SEALED",
              contents: [] }],
  }],
};

describe("repack a lot", () => {
  it("shows what is on the shelf, locks below the coded level, and sends the target", async () => {
    lotPacks.mockResolvedValue(LOT);
    repackLot.mockResolvedValue({ ...LOT, pack_text: "1 Carton + 9 Strip = 735 TAB" });
    const done = vi.fn();
    render(wrap(<RepackDialog stockId={9} onClose={vi.fn()} onDone={done} />));
    await screen.findByText("TAB-0001-20-BOX");
    // Coded as strips: loose tablets cannot be chosen.
    expect(screen.getByLabelText("Loose count")).toBeDisabled();
    expect(screen.getByText(/never\s+into anything smaller than a Strip/)).toBeTruthy();
    // Starts at what is there, which adds up; one more box no longer does.
    const confirm = () => screen.getByRole("button", { name: "Repack" });
    fireEvent.click(screen.getByRole("button", { name: "One more Box" }));
    expect(confirm()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "One fewer Box" }));
    // 3 Box + 19 Strip -> 1 Carton + 9 Strip
    fireEvent.change(screen.getByLabelText("Carton count"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Box count"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Strip count"), { target: { value: "9" } });
    expect(confirm()).not.toBeDisabled();
    fireEvent.click(confirm());
    await waitFor(() => expect(repackLot).toHaveBeenCalled());
    expect(repackLot.mock.calls[0][1]).toEqual({
      pack_hierarchy_id: 2, reason: null,
      target: [{ item_packaging_id: 23, level: 3, qty: 1 },
               { item_packaging_id: 21, level: 1, qty: 9 }],
    });
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});
