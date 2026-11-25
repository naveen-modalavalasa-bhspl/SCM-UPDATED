import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PickBox, PickedTag, pickRevision } from "../components/PickBox";

/** SCM_0158: a ticked row must LOOK ticked — on the New sheet the counter said
 *  "3 selected" while every box on the table stayed drawn empty. */
describe("pickRevision", () => {
  it("moves whenever the selection does, so cached table rows repaint", () => {
    expect(pickRevision(1, [])).not.toBe(pickRevision(1, [7]));
    expect(pickRevision(1, [7])).not.toBe(pickRevision(1, [7, 9]));
    expect(pickRevision(1, [7])).not.toBe(pickRevision(2, [7]));
  });
  it("does not care about the order things were ticked in", () => {
    expect(pickRevision(1, [9, 7, 12])).toBe(pickRevision(1, [12, 7, 9]));
  });
});

describe("PickBox", () => {
  it("is a real checkbox that reports its state and toggles", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PickBox checked={false} onToggle={onToggle} label="Include REQ-0012" />);
    const box = screen.getByRole("checkbox", { name: "Include REQ-0012" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<PickBox checked onToggle={onToggle} label="Include REQ-0012" />);
    expect(screen.getByRole("checkbox", { name: "Include REQ-0012" })).toBeChecked();
  });
});

describe("PickedTag", () => {
  it("says Picked only on a picked row", () => {
    const { rerender } = render(<PickedTag show={false} />);
    expect(screen.queryByText("Picked")).toBeNull();
    rerender(<PickedTag show />);
    expect(screen.getByText("Picked")).toBeInTheDocument();
  });
});
