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
  // The editor lives in a popup behind one press (2026-10-21); the line carries only
  // a summary of what was sent and what was counted.
  const openCount = () => fireEvent.click(screen.getByRole("button", { name: /count packs/i }));

  it("shows the declared packing locked and counts only what was sent", async () => {
    render(<GateLine />);
    expect(screen.getByText(/Supplier sent 750 TAB/)).toBeTruthy();
    openCount();
    expect(await screen.findByText(/From the supplier's despatch note, so the packing is fixed/))
      .toBeTruthy();
    // Only the declared level (Box) and loose are offered — no Strip, no Carton.
    expect(screen.queryByLabelText("Strip count")).toBeNull();
    expect(screen.queryByLabelText("Carton count")).toBeNull();
    // Never over what was declared.
    expect(screen.getByRole("button", { name: "One more Box" })).toBeDisabled();
  });

  it("makes the received quantity the count once it is used, and says what is short", async () => {
    render(<GateLine />);
    openCount();
    fireEvent.click(await screen.findByRole("button", { name: "One fewer Box" }));
    expect(screen.getByText(/Short of the despatch note by 150 TAB/)).toBeTruthy();
    // A count being typed is not yet the line's: Cancel must leave it as it was.
    expect(screen.getByTestId("received").textContent).toBe("750");
    fireEvent.click(screen.getByRole("button", { name: /Use this count/ }));
    await waitFor(() => expect(screen.getByTestId("received").textContent).toBe("600"));
    expect(screen.getByText(/Short 150 TAB/)).toBeTruthy();
  });

  it("tells the gate when the buyer declined the supplier's packing", async () => {
    render(<GateLine pack_change_status="DECLINED" ordered_pack_hierarchy_name="Strip of 10"
                     pack_change_note="Different MRP" />);
    expect(screen.getByText(/Packing change declined/)).toBeTruthy();
    openCount();
    expect(await screen.findByText(/The buyer DECLINED this packing/)).toBeTruthy();
    expect(screen.getByText(/Different MRP/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------- the issue -- */
// The issue quantity is in base units and decides everything; the packs follow it
// (2026-10-22). No coded pack, so no break bulk.
function Pick({ locked = false, qty = 150 }: { locked?: boolean; qty?: number }) {
  const [line, setLine] = useState<IssueItemWrite>({ item_id: 1, requested_qty: qty, issued_qty: qty });
  return (
    <>
      <IssuePickPacking line={line} hierarchies={[STRIP_OF_15]} locked={locked} uom="TAB"
                        onChange={(patch) => setLine((l) => ({ ...l, ...patch }))} />
      <button type="button" onClick={() => setLine((l) => ({ ...l, issued_qty: 165, pack_breakdown: null }))}>
        set 165
      </button>
      <output data-testid="qty">{String(line.issued_qty)}</output>
    </>
  );
}

describe("issue a pick in base units, shown in packs", () => {
  it("works the packs out from the quantity, and again when it changes", async () => {
    render(<Pick />);
    // 150 = 1 Box.
    expect(await screen.findByText(/1 Box/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "set 165" }));
    // 165 = 1 Box + 1 Strip, and the quantity stays what was typed.
    expect(await screen.findByText(/1 Strip/)).toBeTruthy();
    expect(screen.getByTestId("qty").textContent).toBe("165");
  });

  it("changes the mix of packs, never the quantity", async () => {
    render(<Pick />);
    fireEvent.click(await screen.findByRole("button", { name: /Change packing/ }));
    fireEvent.click(await screen.findByRole("button", { name: "One more Strip" }));
    expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "One fewer Box" }));
    fireEvent.change(screen.getByLabelText("Strip count"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: /Apply/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    expect(screen.getByTestId("qty").textContent).toBe("150");
  });

  it("offers no break bulk", () => {
    granted.add("issue.break_bulk");
    render(<Pick />);
    expect(screen.queryByText(/Break bulk/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ the repack -- */
// Codes belong to units, so no pack is locked (2026-10-22).
const LOT: LotPacks = {
  stock_id: 9, item_id: 1, warehouse_id: 1, bin_id: 5, batch_id: 0, project_id: 0,
  item_code: "TAB-0001", item_name: "Paracetamol", uom_code: "TAB", bin_code: "F1-B1",
  total_qty: 735, available_qty: 735, reserved_qty: 0, loose_qty: 0,
  pack_text: "3 Box + 19 Strip = 735 TAB", codes_per_pack: false, serialised: false,
  hierarchies: [{
    ...STRIP_OF_15, in_use: true, coded_floor: 0, top_counts: { "1": 19, "2": 3, "3": 0 },
    packs: [{ id: 20, hu_code: "PK-WH-0000020", code_kind: "PACK", level: 2,
              pack_name: "Box", pack_size: 150, is_atom: false, status: "SEALED",
              contents: [] }],
  }],
};

const BOX_OF_20: PackHierarchy = {
  hierarchy_id: 7, name: "Box of 20", base_uom: "TAB",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose TAB", size: 1, ratio: 1, label: "Loose TAB" },
    { item_packaging_id: 71, level: 1, name: "Box", size: 20, ratio: 20, label: "Box (20 TAB)" },
  ],
};

describe("repack a lot", () => {
  it("shows what is on the shelf, opens any level, and sends the target", async () => {
    lotPacks.mockResolvedValue(LOT);
    repackLot.mockResolvedValue({ ...LOT, pack_text: "1 Carton + 9 Strip = 735 TAB" });
    const done = vi.fn();
    render(wrap(<RepackDialog stockId={9} onClose={vi.fn()} onDone={done} />));
    await screen.findByText("Strip of 15");
    // Nothing is coded per pack, so loose is a level like any other.
    expect(screen.getByLabelText("Loose count")).not.toBeDisabled();
    const confirm = () => screen.getByRole("button", { name: /Repack$/ });
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

  it("shows every hierarchy on the lot and repacks the one picked, over its own packs", async () => {
    // 735 in strips of 15 plus 100 in boxes of 20, on one lot.
    lotPacks.mockResolvedValue({
      ...LOT, total_qty: 835, available_qty: 835,
      hierarchies: [...LOT.hierarchies, {
        ...BOX_OF_20, in_use: true, coded_floor: 0, top_counts: { "1": 5 },
        packs: [{ id: 30, hu_code: "PK-WH-0000030", code_kind: "PACK", level: 1,
                  pack_name: "Box", pack_size: 20, is_atom: false, status: "SEALED",
                  contents: [] }],
      }],
    });
    repackLot.mockResolvedValue(LOT);
    render(wrap(<RepackDialog stockId={9} onClose={vi.fn()} onDone={vi.fn()} />));
    await screen.findAllByText("Strip of 15");
    expect(screen.getAllByText("Box of 20").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("radio", { name: /Box of 20/ }));
    // Its own 100 — never the other hierarchy's 735.
    expect(await screen.findByText(/100 TAB — matches/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Box count"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Loose count"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /Repack$/ }));
    await waitFor(() => expect(repackLot).toHaveBeenCalled());
    expect(repackLot.mock.calls[0][1].pack_hierarchy_id).toBe(7);
  });
});
