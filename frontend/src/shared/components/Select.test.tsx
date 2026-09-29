import { describe, expect, it, vi } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { Field, Select } from "./ui";

const options = [
  { value: 1, label: "PCS — Pieces" },
  { value: 2, label: "BOX — Box" },
  { value: 3, label: "LTR — Litre" },
];

/** Long enough to cross `SEARCHABLE_FROM`, which is what a masters dropdown looks
 *  like. The three-option list above is what a mode or a priority looks like. */
const many = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1, label: `Item ${String(i + 1).padStart(2, "0")}`,
}));

/** Opens the dropdown the way a mouse user does. React Aria drives the trigger from
 *  pointer events, and jsdom has none, so it falls back to the mouse pair — a bare
 *  `click` never opens it. The listbox is only mounted once open, so every option
 *  assertion has to come through here. */
function openDropdown() {
  const trigger = screen.getByRole("button");
  fireEvent.mouseDown(trigger);
  fireEvent.mouseUp(trigger);
  fireEvent.click(trigger);
  return screen.getByRole("listbox");
}

/** The searchable rendering opens from its own chevron, which HeroUI labels. */
function openSuggestions() {
  fireEvent.click(screen.getByLabelText("Show suggestions"));
  return screen.getByRole("listbox");
}

/* Select is shared by every module, so a regression here breaks all of them. It has
 * two renderings — a plain dropdown for a short list, a searchable box for a long
 * one — and a call site cannot tell which it got, so both are held to the same
 * contract below. */

describe("Select — a short list is an ordinary dropdown", () => {
  it("does not ask the user to type to pick from five things", () => {
    render(<Select value="" options={options} onChange={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-haspopup", "listbox");
  });

  it("shows the selected option's label, not its id", () => {
    render(<Select value={2} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveTextContent("BOX — Box");
  });

  it("shows the placeholder when nothing is selected", () => {
    render(<Select value="" options={options} onChange={vi.fn()}
                   placeholder="Pick a unit" />);
    expect(screen.getByRole("button")).toHaveTextContent("Pick a unit");
  });

  it("offers every option", () => {
    render(<Select value="" options={options} onChange={vi.fn()} />);
    openDropdown();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("reports the option's own value, so a numeric id stays usable", () => {
    const onChange = vi.fn();
    render(<Select value="" options={options} onChange={onChange} />);
    openDropdown();
    fireEvent.click(screen.getByRole("option", { name: "BOX — Box" }));
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("picks up options that arrive after the first render", () => {
    // Every masters dropdown is fed by useQuery, so the first render always gets
    // an empty list and the real one lands a tick later. A collection captured at
    // mount would leave all of them permanently empty.
    const { rerender } = render(<Select value="" options={[]} onChange={vi.fn()} />);
    rerender(<Select value="" options={options} onChange={vi.fn()} />);
    openDropdown();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("shows a preselected value whose options arrive late", () => {
    // Opening an existing row sets the value before the list has loaded. If the
    // collection never catches up, the field renders blank and the edit silently
    // drops whatever was already saved.
    const { rerender } = render(<Select value={2} options={[]} onChange={vi.fn()} />);
    rerender(<Select value={2} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveTextContent("BOX — Box");
  });
});

describe("Select — a long list is searchable", () => {
  it("turns into a search box once scrolling would be the alternative", () => {
    render(<Select value="" options={many} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("filters the list as you type", () => {
    render(<Select value="" options={many} onChange={vi.fn()} />);
    openSuggestions();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "07" } });
    expect(screen.getByRole("option", { name: "Item 07" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Item 01" })).not.toBeInTheDocument();
  });

  it("shows the selected option's label, not its id", () => {
    render(<Select value={2} options={many} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("Item 02");
  });

  it("reports the option's own value", () => {
    const onChange = vi.fn();
    render(<Select value="" options={many} onChange={onChange} />);
    openSuggestions();
    fireEvent.click(screen.getByRole("option", { name: "Item 02" }));
    expect(onChange).toHaveBeenCalledWith("2");
  });
});

describe("Select — `searchable` overrides the count", () => {
  it("keeps a short list searchable when a screen asks for it", () => {
    render(<Select value="" options={options} onChange={vi.fn()} searchable />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("keeps a long list a plain dropdown when a screen asks for it", () => {
    render(<Select value="" options={many} onChange={vi.fn()} searchable={false} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("Select inside a Field", () => {
  it("is not reopened by a click on the label", () => {
    // A <label> forwards a click on its text to the Autocomplete's input, which
    // HeroUI opens on click — dismissing the dropdown by clicking beside it used to
    // reopen it straight away.
    render(
      <Field label="Stop at this level" hint="Leave blank">
        <Select value={3} options={many} onChange={vi.fn()} />
      </Field>,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByText("Leave blank"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
