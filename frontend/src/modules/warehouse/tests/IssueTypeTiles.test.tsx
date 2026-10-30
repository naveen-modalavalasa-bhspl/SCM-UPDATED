import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IssueTypeTiles } from "../components/IssueTypeTiles";

// The four kinds of material issue, told apart at a glance (2026-10-29).
describe("IssueTypeTiles", () => {
  it("offers the four issue types and reports the one picked", () => {
    const onChange = vi.fn();
    render(<IssueTypeTiles value="DIRECT" onChange={onChange} />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(screen.getByRole("radio", { name: /Stock Transfer Order/ }));
    expect(onChange).toHaveBeenCalledWith("STO");
  });

  it("shows a saved issue's type without letting it change", () => {
    const onChange = vi.fn();
    render(<IssueTypeTiles value="STO" onChange={onChange} disabled />);
    expect(screen.getByRole("radio", { name: /Stock Transfer Order/ }))
      .toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /Direct issue/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
