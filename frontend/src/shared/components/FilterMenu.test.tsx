import { describe, expect, it, vi } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterMenu } from "./FilterMenu";

const warehouses = [
  { value: 1, label: "Hyderabad Main" },
  { value: 2, label: "Medak MDP" },
  { value: 3, label: "Nizamabad LIP" },
];

/** The pill IS the search box, so the combobox and the trigger are one element. */
function pill(label = "Warehouse") {
  return screen.getByRole("combobox", { name: label });
}

describe("FilterMenu", () => {
  it("opens on click and lists every option plus a reset row", () => {
    render(<FilterMenu label="Warehouse" value="" onChange={() => {}} options={warehouses} />);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.mouseDown(pill());

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Show all" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(warehouses.length + 1);
  });

  it("draws the list in a portal, outside the filter bar that would clip it", () => {
    // The regression this guards: the panel used to be `absolute` inside the bar, so a
    // rounded <Card> clipped it and the sticky app header painted over it.
    const { container } = render(
      <FilterMenu label="Warehouse" value="" onChange={() => {}} options={warehouses} />,
    );
    fireEvent.mouseDown(pill());

    const list = screen.getByRole("listbox");
    expect(container.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
  });

  it("narrows the list as the pill is typed into", () => {
    render(<FilterMenu label="Warehouse" value="" onChange={() => {}} options={warehouses} />);
    fireEvent.mouseDown(pill());
    fireEvent.change(pill(), { target: { value: "med" } });

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Medak MDP"]);
    // The reset row goes while narrowing: the user is filtering, not clearing.
    expect(screen.queryByRole("option", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("picks with the keyboard and closes", () => {
    const onChange = vi.fn();
    render(<FilterMenu label="Warehouse" value="" onChange={onChange} options={warehouses} />);
    fireEvent.mouseDown(pill());
    fireEvent.change(pill(), { target: { value: "niz" } });
    fireEvent.keyDown(pill(), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("3");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("clears the filter from the pill, and from Backspace on an empty box", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterMenu label="Warehouse" value="2" onChange={onChange} options={warehouses} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear warehouse filter" }));
    expect(onChange).toHaveBeenLastCalledWith("");

    rerender(<FilterMenu label="Warehouse" value="2" onChange={onChange} options={warehouses} />);
    fireEvent.mouseDown(pill());
    fireEvent.keyDown(pill(), { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("drops the reset row when the field must always hold a value", () => {
    // A page size, a label size — "" would be read as 0 by the caller.
    render(
      <FilterMenu
        label="20 per page"
        value="20"
        onChange={() => {}}
        allowEmpty={false}
        options={[{ value: "20", label: "20 per page" }, { value: "50", label: "50 per page" }]}
      />,
    );
    fireEvent.mouseDown(pill("20 per page"));
    expect(screen.queryByRole("option", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("closes on Escape without changing the filter", () => {
    const onChange = vi.fn();
    render(<FilterMenu label="Status" value="" onChange={onChange} options={warehouses} />);
    fireEvent.mouseDown(pill("Status"));
    fireEvent.keyDown(pill("Status"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
