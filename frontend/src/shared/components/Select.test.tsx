import { describe, expect, it, vi } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./ui";

const options = [
  { value: 1, label: "PCS — Pieces" },
  { value: 2, label: "BOX — Box" },
  { value: 3, label: "LTR — Litre" },
];

/** Opens the popover the way a mouse user does. React Aria only mounts the listbox
 *  once it is open, so every option assertion has to go through here first. */
function openList() {
  // HeroUI renders a clear button as well as the chevron, so the trigger is picked
  // by its label rather than by being the only button.
  fireEvent.click(screen.getByLabelText("Show suggestions"));
  return screen.getByRole("listbox");
}

/** Select is shared by every module, so a regression here breaks all of them. */
describe("Select", () => {
  it("shows the selected option's label, not its id", () => {
    render(<Select value={2} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("BOX — Box");
  });

  it("renders an empty box when nothing is selected", () => {
    render(<Select value="" options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("offers every option when the box is empty", () => {
    render(<Select value="" options={options} onChange={vi.fn()} />);
    openList();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters the list as you type", () => {
    render(<Select value="" options={options} onChange={vi.fn()} />);
    openList();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "lit" } });
    expect(screen.getByRole("option", { name: "LTR — Litre" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "PCS — Pieces" })).not.toBeInTheDocument();
  });

  it("picks up options that arrive after the first render", () => {
    // Every masters dropdown is fed by useQuery, so the first render always gets
    // an empty list and the real one lands a tick later. A collection captured at
    // mount would leave all of them permanently empty.
    const { rerender } = render(<Select value="" options={[]} onChange={vi.fn()} />);
    rerender(<Select value="" options={options} onChange={vi.fn()} />);
    openList();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("shows a preselected value whose options arrive late", () => {
    // Opening an existing row sets the value before the list has loaded. If the
    // collection never catches up, the field renders blank and the edit silently
    // drops whatever was already saved.
    const { rerender } = render(<Select value={2} options={[]} onChange={vi.fn()} />);
    rerender(<Select value={2} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("BOX — Box");
  });

  it("reports the option's own value, so a numeric id stays usable", () => {
    const onChange = vi.fn();
    render(<Select value="" options={options} onChange={onChange} />);
    openList();
    fireEvent.click(screen.getByRole("option", { name: "BOX — Box" }));
    expect(onChange).toHaveBeenCalledWith("2");
  });
});
