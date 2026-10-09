import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BLANK_LINE, ReturnLinesEditor } from "../components/ReturnLinesEditor";
import type { MyStockRow, ReturnLineWrite } from "../types";

const stock: MyStockRow[] = [
  {
    item_id: 11, item_code: "MED-PAR-500", item_name: "Paracetamol 500mg",
    uom_code: "TAB", available_qty: "40", warehouse_id: 3,
    warehouse_name: "LIP Mustabad", expiry_date: "2026-09-30", batch_no: "B-7",
  },
  // The same item in a second lot: the picker must offer it once, summed, because the
  // returner picks an item and the backend walks the lots itself.
  {
    item_id: 11, item_code: "MED-PAR-500", item_name: "Paracetamol 500mg",
    uom_code: "TAB", available_qty: "10", warehouse_id: 3,
    warehouse_name: "LIP Mustabad", expiry_date: "2027-01-31", batch_no: "B-9",
  },
];

const lineOf = (patch: Partial<ReturnLineWrite> = {}): ReturnLineWrite => ({
  ...BLANK_LINE,
  ...patch,
});

describe("ReturnLinesEditor", () => {
  it("shows the summed quantity the raiser is holding", () => {
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "5" })]}
        onChange={vi.fn()}
        stock={stock}
      />,
    );
    expect(screen.getByText("You are holding 50 TAB")).toBeInTheDocument();
  });

  it("marks a line that asks for more than is on the shelf", () => {
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "60" })]}
        onChange={vi.fn()}
        stock={stock}
      />,
    );
    expect(screen.getByText("Only 50 TAB is on the shelf")).toBeInTheDocument();
  });

  it("does not complain before an item is picked", () => {
    render(
      <ReturnLinesEditor lines={[lineOf({ quantity: "5" })]} onChange={vi.fn()} stock={stock} />,
    );
    expect(screen.queryByText(/on the shelf/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Pick an item to see what you are holding"),
    ).toBeInTheDocument();
  });

  it("adds a blank line", () => {
    const onChange = vi.fn();
    render(
      <ReturnLinesEditor lines={[lineOf({ item_id: 11, quantity: "5" })]} onChange={onChange} stock={stock} />,
    );
    fireEvent.click(screen.getByText("Add line"));
    expect(onChange).toHaveBeenCalledWith([
      { item_id: 11, quantity: "5", remarks: "" },
      { item_id: 0, quantity: "", remarks: "" },
    ]);
  });

  it("will not let the same item be picked on two lines", () => {
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "5" }), lineOf({ item_id: 11, quantity: "2" })]}
        onChange={vi.fn()}
        stock={stock}
      />,
    );
    expect(
      screen.getAllByText(
        "That item is already on another line — change the quantity there instead.",
      ),
    ).toHaveLength(2);
  });

  it("refuses a fraction of a whole-unit item", () => {
    const boxes: MyStockRow[] = [{ ...stock[0], uom_code: "BOX", available_qty: "10" }];
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "2.5" })]}
        onChange={vi.fn()}
        stock={boxes}
      />,
    );
    expect(screen.getByText("BOX comes in whole units")).toBeInTheDocument();
  });

  it("steps a whole-unit item by one and a divisible one by a thousandth", () => {
    const boxes: MyStockRow[] = [{ ...stock[0], uom_code: "BOX" }];
    const { rerender } = render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "2" })]}
        onChange={vi.fn()}
        stock={boxes}
      />,
    );
    expect(screen.getByLabelText("Quantity for line 1")).toHaveAttribute("step", "1");

    // TAB is the seeded UoM and is divisible, so the spinner keeps its decimals.
    rerender(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "2" })]}
        onChange={vi.fn()}
        stock={stock}
      />,
    );
    expect(screen.getByLabelText("Quantity for line 1")).toHaveAttribute("step", "0.001");
  });

  it("caps the quantity box at what is on the shelf", () => {
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "5" })]}
        onChange={vi.fn()}
        stock={stock}
      />,
    );
    expect(screen.getByLabelText("Quantity for line 1")).toHaveAttribute("max", "50");
  });

  it("offers no controls at all once the return has left the raiser", () => {
    render(
      <ReturnLinesEditor
        lines={[lineOf({ item_id: 11, quantity: "5" })]}
        onChange={vi.fn()}
        stock={stock}
        disabled
      />,
    );
    expect(screen.queryByText("Add line")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Remove line 1")).not.toBeInTheDocument();
  });
});
