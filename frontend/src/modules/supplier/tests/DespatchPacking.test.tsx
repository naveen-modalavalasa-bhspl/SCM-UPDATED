import { useState } from "react";
import { describe, expect, it } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { greedy, type PackEntry, type PackHierarchy } from "@/shared/packing/packing";
import { DespatchPacking } from "../components/DespatchPacking";

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

function Line({ inline = true }: { inline?: boolean }) {
  const [line, setLine] = useState<{ hierarchy: number; packs: PackEntry[]; reason: string | null;
                                     qty: number }>({
    hierarchy: 1, packs: greedy(TEN, 800), reason: null, qty: 800 });
  return (
    <>
      <DespatchPacking inline={inline} hierarchies={[TEN, FIFTEEN]} orderedId={1} hierarchyId={line.hierarchy}
                       breakdown={line.packs} reason={line.reason} uom="TAB" owed={800}
                       onChange={(p) => setLine({ hierarchy: p.pack_hierarchy_id ?? 1,
                                                  packs: p.pack_breakdown ?? [],
                                                  reason: p.pack_change_reason ?? null,
                                                  qty: p.despatched_qty })} />
      <output data-testid="qty">{line.qty}</output>
    </>
  );
}

describe("how the supplier packed a despatch line", () => {
  it("offers the order's hierarchy first and lets any of its levels make the quantity", () => {
    render(<Line inline={true} />);
    expect(screen.getByText("As ordered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "One fewer Box" }));
    fireEvent.change(screen.getByLabelText("Strip count"), { target: { value: "10" } });
    expect(screen.getByTestId("qty").textContent).toBe("800");       // 7 Box + 10 Strip
    expect(screen.queryByText(/buyer is asked/)).toBeNull();
  });

  it("asks why when the supplier switches hierarchy, and says the buyer decides", () => {
    render(<Line inline={true} />);
    fireEvent.click(screen.getByRole("radio", { name: /Strip of 15/ }));
    expect(screen.getByText(/The buyer is asked to accept the change/)).toBeTruthy();
    expect(screen.getByText("Why the packing changed")).toBeTruthy();
  });

  it("says when the packs are more than the order still owes", () => {
    render(<Line inline={true} />);
    fireEvent.click(screen.getByRole("button", { name: "One more Strip" }));
    expect(screen.getByText(/10 TAB more than the order still owes/)).toBeTruthy();
  });

  it("shows compact packaging with Change packaging button by default, opening modal on click", () => {
    render(<Line inline={false} />);
    expect(screen.getByRole("button", { name: /Change packaging/i })).toBeTruthy();
    expect(screen.getByText("As Ordered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Change packaging/i }));
    expect(screen.getByText("Configure Dispatch Packaging & Pack Hierarchy")).toBeTruthy();
    expect(screen.getByText("1. Packaging Hierarchy Architecture")).toBeTruthy();
    expect(screen.getByText("2. Container & Pack Quantity Distribution")).toBeTruthy();
  });
});
