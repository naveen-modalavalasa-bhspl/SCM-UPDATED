import { useState } from "react";
import { describe, expect, it } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { PackBreakdownEditor } from "@/shared/packing/components";
import { greedy, type PackEntry, type PackHierarchy } from "@/shared/packing/packing";

const STRIP_OF_10: PackHierarchy = {
  hierarchy_id: 1, name: "Strip of 10", base_uom: "TAB",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose TAB", size: 1, ratio: 1, label: "Loose TAB" },
    { item_packaging_id: 11, level: 1, name: "Strip", size: 10, ratio: 10, label: "Strip (10 TAB)" },
    { item_packaging_id: 12, level: 2, name: "Box", size: 100, ratio: 10, label: "Box" },
  ],
};

function Harness({ target, limits, minLevel }: {
  target?: number; limits?: Record<number, number>; minLevel?: number;
}) {
  const [value, setValue] = useState<PackEntry[]>(greedy(STRIP_OF_10, 200));
  return (
    <PackBreakdownEditor hierarchy={STRIP_OF_10} value={value} onChange={setValue}
                         target={target} limits={limits} minLevel={minLevel} />
  );
}

describe("PackBreakdownEditor", () => {
  it("says when the packs make the quantity, and by how much they miss it", () => {
    render(<Harness target={200} />);
    expect(screen.getByRole("status").textContent).toContain("Adds up to 200 TAB");
    fireEvent.click(screen.getByRole("button", { name: "One more Strip" }));
    expect(screen.getByRole("status").textContent).toContain("Over by 10 TAB");
    expect(screen.getByRole("status").textContent).toContain("2 Box + 1 Strip = 210 TAB");
  });

  it("never lets a count pass what was declared", () => {
    render(<Harness limits={{ 2: 2 }} />);
    expect(screen.getByRole("button", { name: "One more Box" })).toBeDisabled();
    expect(screen.getByText("of 2 sent")).toBeTruthy();
  });

  it("locks the levels below a coded pack", () => {
    render(<Harness minLevel={2} />);
    expect(screen.getByLabelText("Strip count")).toBeDisabled();
    expect(screen.getByLabelText("Box count")).not.toBeDisabled();
  });
});
