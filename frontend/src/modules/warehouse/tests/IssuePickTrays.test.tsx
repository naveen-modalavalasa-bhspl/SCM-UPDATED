import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IssuePickTrays } from "../components/IssuePickTrays";

// A tray's codes are picked in the same popup QC and the consignment use — never an
// inline list (2026-11-21).
describe("IssuePickTrays", () => {
  const codes = ["AT-1", "AT-2", "AT-3", "AT-4", "AT-5"];
  const trays = [
    { tray_no: "T-01", quantity: 2, codes: ["AT-1"] },
    { tray_no: "T-02", quantity: 3, codes: ["AT-5"] },
  ];

  it("shows a tray's codes as a summary, not a list", () => {
    render(<IssuePickTrays trays={trays} issued={5} codes={codes} codeWord="asset tag" mode="draft" onChange={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /Change asset tags/ })).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("picks in the popup: this tray's codes plus those no other tray holds, capped at its quantity", async () => {
    const onChange = vi.fn();
    render(<IssuePickTrays trays={trays} issued={5} codes={codes} codeWord="asset tag"
                           itemLabel="ELEC-1001" mode="draft" onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Change asset tags/ })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Tray T-01 · ELEC-1001/)).toBeInTheDocument();
    // AT-5 is in tray T-02, so it is not offered here.
    expect(within(dialog).queryByLabelText("Select AT-5")).toBeNull();
    expect(within(dialog).getByLabelText("Select AT-1")).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText("Select AT-3"));
    // Two is this tray's quantity — a third cannot be ticked.
    expect(within(dialog).getByText(/This pick is full at 2/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0][0]).toEqual({ tray_no: "T-01", quantity: 2, codes: ["AT-1", "AT-3"] });
  });
});
