import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IndentStatusBadge } from "../components/IndentStatusBadge";
import { StatusPill } from "@/shared/components";

/** The pill itself, whichever of the three shapes the badge took: the toned span
 *  is the one carrying the pill geometry, and a labelled badge puts its text in a
 *  truncating child one level in. */
const pillFor = (label: string) =>
  screen.getByText(label).closest("span.rounded-full") as HTMLElement | null;

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

      const badge = pillFor(label);
      expect(badge).toHaveClass(background, foreground);
      expect(badge).not.toHaveClass(otherBackground, otherForeground);
    },
  );

  /**
   * ONE palette, not three (2026-09-21).
   *
   * This file used to assert the opposite — that a DRAFT, PENDING_APPROVAL,
   * REJECTED or APPROVED badge carried none of `bg-ok-bg`/`bg-info-bg`/`text-ok`/
   * `text-info` — which was true, and was the defect: the allocation states above
   * were drawn from the design tokens while everything else reached for HeroUI's
   * separate success/warning/danger palette, so an APPROVED indent and an ALLOCATED
   * one sitting in the same column were two different greens. The test was
   * protecting the drift rather than the rule.
   *
   * The rule it protects now: every badge this component can draw wears a fill and
   * a text colour from the five measured outcome tokens, and nothing else. Statuses
   * that fall through to the shared `StatusPill` are that component's to test.
   */
  const OUTCOME_FILLS = [
    "bg-ok-bg", "bg-warn-bg", "bg-bad-bg", "bg-info-bg",
    "bg-neutral-bg", "bg-chart-returned-bg",
  ];

  it.each([
    ["PENDING_APPROVAL", "Pending Approval", "bg-warn-bg"],
    ["RETURNED_FOR_CORRECTION", "Returned for correction", "bg-chart-returned-bg"],
  ])("draws %s from the outcome tokens", (status, label, fill) => {
    render(<IndentStatusBadge status={status} />);

    const badge = pillFor(label);
    expect(badge).toHaveClass(fill);
    OUTCOME_FILLS.filter((other) => other !== fill).forEach((other) => {
      expect(badge).not.toHaveClass(other);
    });
  });

  /** "Returned" and "partially approved" are the two outcomes a requester most has
   *  to tell apart, and they shared the amber. */
  it("keeps a returned badge off the amber a pending one wears", () => {
    const { container: returned } = render(
      <IndentStatusBadge status="RETURNED_FOR_CORRECTION" />,
    );
    expect(returned.querySelector(".bg-warn-bg")).toBeNull();
  });

  /** The badge and the shared pill are the same vocabulary, so a status the badge
   *  has nothing special to say about must come out identical to `StatusPill`. */
  it("falls through to StatusPill without changing the colour", () => {
    const { container: badge } = render(<IndentStatusBadge status="APPROVED" />);
    const { container: pill } = render(<StatusPill status="APPROVED" />);
    expect(badge.firstElementChild?.className).toBe(pill.firstElementChild?.className);
  });

  it("updates existing status badge to QC: PASSED when QC completes", () => {
    render(
      <IndentStatusBadge
        status="PARTIALLY_ALLOCATED"
        journey={{
          indent_id: 33,
          indent_no: "IND0105",
          status: "PARTIALLY_ALLOCATED",
          created_at: "2026-10-31",
          current_stage_message: "",
          stages: [],
          phases: [],
          history: [],
          missing_sources: [],
          qc_status: "COMPLETED",
          qc_inspection_no: "QC0021",
        }}
      />,
    );

    expect(screen.getByText("QC: PASSED · QC0021")).toBeInTheDocument();
    expect(screen.queryByText("PARTIALLY ALLOCATED")).toBeNull();
  });

  it("updates existing status badge to CONSIGNMENT and IN TRANSIT as delivery progresses", () => {
    const { rerender } = render(
      <IndentStatusBadge
        status="PARTIALLY_ALLOCATED"
        journey={{
          indent_id: 33,
          indent_no: "IND0105",
          status: "PARTIALLY_ALLOCATED",
          created_at: "2026-10-31",
          current_stage_message: "",
          stages: [],
          phases: [],
          history: [],
          missing_sources: [],
          consignment_no: "CSG0009",
          consignment_status: "CREATED",
        }}
      />,
    );

    expect(screen.getByText("CONSIGNMENT: CREATED · CSG0009")).toBeInTheDocument();

    rerender(
      <IndentStatusBadge
        status="PARTIALLY_ALLOCATED"
        journey={{
          indent_id: 33,
          indent_no: "IND0105",
          status: "PARTIALLY_ALLOCATED",
          created_at: "2026-10-31",
          current_stage_message: "",
          stages: [],
          phases: [],
          history: [],
          missing_sources: [],
          consignment_no: "CSG0009",
          consignment_status: "IN_TRANSIT",
        }}
      />,
    );

    expect(screen.getByText("IN TRANSIT · CSG0009")).toBeInTheDocument();
  });
});
