import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IndentStatusBadge } from "../components/IndentStatusBadge";

describe("IndentStatusBadge", () => {
  it.each([
    ["ALLOCATED", "ALLOCATED", "bg-ok-bg", "text-ok", "bg-info-bg", "text-info"],
    [
      "AWAITING_ALLOCATION",
      "AWAITING ALLOCATION",
      "bg-info-bg",
      "text-info",
      "bg-ok-bg",
      "text-ok",
    ],
  ])(
    "uses the scoped allocation tone for %s",
    (status, label, background, foreground, otherBackground, otherForeground) => {
      render(<IndentStatusBadge status={status} />);

      const badge = screen.getByText(label).parentElement;
      expect(badge).toHaveClass(background, foreground);
      expect(badge).not.toHaveClass(otherBackground, otherForeground);
    },
  );

  it.each([
    ["DRAFT", "DRAFT"],
    ["PENDING_APPROVAL", "Pending Approval"],
    ["REJECTED", "REJECTED"],
    ["APPROVED", "APPROVED"],
  ])("leaves the existing %s badge tone unchanged", (status, label) => {
    const { container } = render(<IndentStatusBadge status={status} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(".bg-ok-bg, .bg-info-bg, .text-ok, .text-info")).toBeNull();
  });
});
