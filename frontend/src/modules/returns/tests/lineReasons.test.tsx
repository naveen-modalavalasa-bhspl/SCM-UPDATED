import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LineReasons } from "../components/LineReasons";
import { newReasonRow } from "../reasonRows";

const REASONS = [
  { value: "DAMAGED", label: "Damaged" }, { value: "EXPIRED", label: "Expired" },
];

describe("LineReasons — why one item is going back (SCM_0129)", () => {
  it("opens on one reason for the whole line, and splits it on request", () => {
    const onChange = vi.fn();
    render(
      <LineReasons
        rows={[{ ...newReasonRow("5"), reason: "DAMAGED" }]}
        reasons={REASONS} total={5} uom="PCS" itemLabel="Handset" onChange={onChange}
      />,
    );
    expect(screen.getByText("Why is it coming back?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Split reasons"));
    const next = onChange.mock.calls[0][0];
    // Two rows that already add up to the line: 4 keep the first reason, 1 is to name.
    expect(next.map((r: { reason: string; quantity: string }) => [r.reason, r.quantity]))
      .toEqual([["DAMAGED", "4"], ["", "1"]]);
  });

  it("folds a split back to its first reason, for all of the line", () => {
    const onChange = vi.fn();
    render(
      <LineReasons
        rows={[{ ...newReasonRow("3"), reason: "DAMAGED" }, { ...newReasonRow("2"), reason: "EXPIRED" }]}
        reasons={REASONS} total={5} itemLabel="Handset" onChange={onChange}
      />,
    );
    expect(screen.getByText("Reasons for Handset")).toBeInTheDocument();
    fireEvent.click(screen.getByText("One reason"));
    expect(onChange.mock.calls[0][0].map((r: { reason: string; quantity: string }) =>
      [r.reason, r.quantity])).toEqual([["DAMAGED", "5"]]);
  });

  it("reads as chips once the return has left the raiser", () => {
    render(
      <LineReasons
        rows={[{ ...newReasonRow("3"), reason: "DAMAGED" }, { ...newReasonRow("2"), reason: "EXPIRED", note: "past" }]}
        reasons={REASONS} total={5} itemLabel="Handset" readOnly onChange={() => undefined}
      />,
    );
    expect(screen.getByText("Damaged")).toBeInTheDocument();
    expect(screen.getByText("· past")).toBeInTheDocument();
    expect(screen.queryByText("Split reasons")).not.toBeInTheDocument();
  });
});
