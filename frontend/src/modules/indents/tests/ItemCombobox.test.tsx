import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ItemCombobox, filterItemOptions } from "../components/ItemCombobox";

const options = [
  { value: 1, label: "101010-0039 — 4 Channel ISE Module" },
  { value: 2, label: "101010-0004 — Absorbant Cotton" },
  { value: 3, label: "101010-0033 — Albumin reagent" },
];

describe("ItemCombobox", () => {
  it("filters items by code or name as the user types", () => {
    expect(filterItemOptions(options, "cotton")).toEqual([options[1]]);
    expect(filterItemOptions(options, "0033")).toEqual([options[2]]);
  });

  it("lets the user type, filter and select an item", () => {
    const onChange = vi.fn();
    render(<ItemCombobox value="" onChange={onChange} options={options} />);

    const input = screen.getByRole("combobox", { name: "Item" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "cotton" } });

    expect(screen.getByRole("option", { name: /Absorbant Cotton/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Albumin reagent/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Absorbant Cotton/i }));
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(input).toHaveValue(options[1].label);
  });

  it("lets an existing selection be replaced by typing", () => {
    const onChange = vi.fn();
    render(<ItemCombobox value={1} onChange={onChange} options={options} />);

    const input = screen.getByRole("combobox", { name: "Item" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0033" } });
    fireEvent.click(screen.getByRole("option", { name: /Albumin reagent/i }));

    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("clears the controlled selection and does not restore it on refocus", () => {
    vi.useFakeTimers();

    function ControlledCombobox() {
      const [value, setValue] = useState<number | "">(1);
      return <ItemCombobox value={value} onChange={setValue} options={options} />;
    }

    render(<ControlledCombobox />);

    const input = screen.getByRole("combobox", { name: "Item" });
    expect(input).toHaveValue(options[0].label);

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");

    fireEvent.blur(input);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.focus(input);
    expect(input).toHaveValue("");
    expect(screen.getByRole("option", { name: /4 Channel ISE Module/i })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    fireEvent.change(input, { target: { value: "cotton" } });
    fireEvent.click(screen.getByRole("option", { name: /Absorbant Cotton/i }));
    expect(input).toHaveValue(options[1].label);

    vi.useRealTimers();
  });
});
