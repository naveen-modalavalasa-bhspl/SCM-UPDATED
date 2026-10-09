import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildStatusBreakdownData,
  getStatusTooltipPosition,
  StatusBreakdownChart,
} from "../components/StatusBreakdownChart";

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    const contentRect = {
      x: 0,
      y: 0,
      width: 320,
      height: 320,
      top: 0,
      right: 320,
      bottom: 320,
      left: 0,
      toJSON: () => ({}),
    } as DOMRectReadOnly;
    this.callback([{ target, contentRect } as ResizeObserverEntry], this);
  }

  unobserve() {}

  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const STATUS_DATA = {
  PENDING_APPROVAL: 4,
  AWAITING_ALLOCATION: 7,
  ALLOCATED: 3,
  PARTIALLY_FULFILLED: 2,
  CLOSED: 4,
  REJECTED: 1,
  DRAFT: 2,
};

/** The statuses STATUS_DATA has indents in, in lifecycle order. */
const POPULATED_STATUSES = [
  "PENDING_APPROVAL",
  "AWAITING_ALLOCATION",
  "ALLOCATED",
  "PARTIALLY_FULFILLED",
  "CLOSED",
  "REJECTED",
  "DRAFT",
];

/**
 * The tooltip is a child of the layout wrapper and is positioned against it, so
 * that — not the donut box — is the element whose bounds have to be mocked.
 */
function setContainerBounds(container: HTMLElement = screen.getByTestId("status-breakdown-layout")) {
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 50,
    width: 320,
    height: 320,
    top: 50,
    right: 420,
    bottom: 370,
    left: 100,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("StatusBreakdownChart tooltip interaction", () => {
  it("positions beside the pointer and follows movement within the same slice", () => {
    render(<StatusBreakdownChart byStatus={STATUS_DATA} />);
    const slice = screen.getByTestId("status-donut-slice-AWAITING_ALLOCATION");
    setContainerBounds();

    fireEvent.mouseEnter(slice, { clientX: 180, clientY: 130 });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-tooltip-x", "92");
    expect(tooltip).toHaveAttribute("data-tooltip-y", "92");
    expect(tooltip).toHaveStyle({ left: "92px", top: "92px" });
    expect(tooltip).toHaveClass("pointer-events-none", "duration-100");

    fireEvent.mouseMove(slice, { clientX: 220, clientY: 170 });

    expect(screen.getByRole("tooltip")).toHaveAttribute("data-tooltip-x", "132");
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-tooltip-y", "132");
  });

  it("flips and clamps coordinates to keep the tooltip inside every edge", () => {
    expect(getStatusTooltipPosition({
      pointerX: 315,
      pointerY: 315,
      containerWidth: 320,
      containerHeight: 320,
      tooltipWidth: 160,
      tooltipHeight: 72,
    })).toEqual({ x: 143, y: 231 });

    expect(getStatusTooltipPosition({
      pointerX: -40,
      pointerY: -30,
      containerWidth: 320,
      containerHeight: 320,
      tooltipWidth: 160,
      tooltipHeight: 72,
    })).toEqual({ x: 8, y: 8 });
  });

  it("dismisses on slice or donut leave and also opens from status-row hover", () => {
    render(<StatusBreakdownChart byStatus={STATUS_DATA} />);
    const container = screen.getByTestId("status-donut-container");
    const slice = screen.getByTestId("status-donut-slice-AWAITING_ALLOCATION");
    const row = screen.getByTestId("status-legend-row-AWAITING_ALLOCATION");
    setContainerBounds();

    fireEvent.mouseEnter(slice, { clientX: 180, clientY: 130 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(slice);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // Hovering a legend row anchors the same tooltip to that row's slice.
    fireEvent.mouseEnter(row);
    expect(row).toHaveAttribute("data-hovered", "true");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(slice, { clientX: 180, clientY: 130 });
    fireEvent.mouseLeave(container);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps hover and selection independent", () => {
    // The chart is read-only: selection arrives as a prop from the filter bar, so
    // hovering a slice must never disturb which rows are marked selected.
    render(<StatusBreakdownChart byStatus={STATUS_DATA} selectedStatuses={["DRAFT"]} />);
    const awaitingSlice = screen.getByTestId("status-donut-slice-AWAITING_ALLOCATION");
    const awaitingRow = screen.getByTestId("status-legend-row-AWAITING_ALLOCATION");
    const draftRow = screen.getByTestId("status-legend-row-DRAFT");
    setContainerBounds();

    fireEvent.mouseEnter(awaitingSlice, { clientX: 180, clientY: 130 });
    expect(awaitingSlice).toHaveAttribute("data-active", "true");
    expect(awaitingRow).toHaveAttribute("data-selected", "false");
    expect(draftRow).toHaveAttribute("data-selected", "true");

    fireEvent.mouseLeave(awaitingSlice);
    expect(awaitingSlice).toHaveAttribute("data-active", "false");
    expect(awaitingRow).toHaveAttribute("data-selected", "false");
    expect(draftRow).toHaveAttribute("data-selected", "true");
  });

  it("dismisses when the selected filter or filtered chart data changes", () => {
    const { rerender } = render(<StatusBreakdownChart byStatus={STATUS_DATA} />);
    const slice = screen.getByTestId("status-donut-slice-AWAITING_ALLOCATION");
    setContainerBounds();

    fireEvent.mouseEnter(slice, { clientX: 180, clientY: 130 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(
      <StatusBreakdownChart
        byStatus={STATUS_DATA}
        selectedStatuses={["AWAITING_ALLOCATION"]}
      />,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const updatedSlice = screen.getByTestId("status-donut-slice-AWAITING_ALLOCATION");
    setContainerBounds();
    fireEvent.mouseEnter(updatedSlice, { clientX: 180, clientY: 130 });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(
      <StatusBreakdownChart
        byStatus={{ AWAITING_ALLOCATION: 3 }}
        selectedStatuses={["AWAITING_ALLOCATION"]}
      />,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("StatusBreakdownChart presentation", () => {
  it("lists the populated statuses in lifecycle order and buckets nothing into Other", () => {
    render(<StatusBreakdownChart byStatus={STATUS_DATA} />);

    expect(screen.getAllByTestId(/^status-legend-row-/).map((row) => (
      row.getAttribute("data-testid")?.replace("status-legend-row-", "")
    ))).toEqual(POPULATED_STATUSES);
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-legend-row-OTHER")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-marker-OTHER")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-donut-slice-OTHER")).not.toBeInTheDocument();
    // Neither of these has an indent in it, so neither takes a row.
    expect(screen.queryByTestId("status-legend-row-APPROVED")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-legend-row-RETURNED_FOR_CORRECTION")).not.toBeInTheDocument();
  });

  it("draws the later lifecycle statuses instead of dropping them from the total", () => {
    // The reported bug: 74 indents on the card, 63 in the donut, because the 11 in
    // PENDING_PROCUREMENT had no slice.
    const byStatus = {
      PENDING_APPROVAL: 17,
      CLOSED: 17,
      ALLOCATED: 15,
      PENDING_PROCUREMENT: 11,
      AWAITING_ALLOCATION: 6,
      PARTIALLY_FULFILLED: 6,
      DRAFT: 1,
      REJECTED: 1,
    };

    const { total } = buildStatusBreakdownData(byStatus);

    expect(total).toBe(74);
    render(<StatusBreakdownChart byStatus={byStatus} />);
    expect(screen.getByTestId("status-donut-total")).toHaveAccessibleName("74 total indents");
    expect(screen.getByTestId("status-legend-count-PENDING_PROCUREMENT")).toHaveTextContent(/^11$/);
    // Pending procurement no longer shares Allocated's violet, which would have read
    // as one 26-indent arc.
    expect(screen.getByTestId("status-donut-slice-PENDING_PROCUREMENT"))
      .toHaveAttribute("fill", "#db2777");
  });

  it("draws a status it has never been told about rather than losing its count", () => {
    const { entries, total } = buildStatusBreakdownData({ ALLOCATED: 4, SOMETHING_NEW: 6 });

    expect(total).toBe(10);
    expect(entries.find(({ status }) => status === "SOMETHING_NEW")?.label)
      .toBe("Something new");
  });

  it("calculates the centre total and percentages across every reported status", () => {
    const byStatus = {
      PENDING_APPROVAL: 4,
      AWAITING_ALLOCATION: 5,
      ALLOCATED: 2,
      PARTIALLY_FULFILLED: 3,
      CLOSED: 4,
      REJECTED: 3,
      DRAFT: 1,
      APPROVED: 80,
      ORDERED: 20,
    };

    const { entries, total } = buildStatusBreakdownData(byStatus);

    expect(total).toBe(122);
    // Lifecycle order: the two later statuses take their place mid-list rather than
    // being appended on the end.
    expect(entries.map(({ status }) => status)).toEqual([
      "PENDING_APPROVAL",
      "APPROVED",
      "AWAITING_ALLOCATION",
      "ALLOCATED",
      "PARTIALLY_FULFILLED",
      "ORDERED",
      "CLOSED",
      "REJECTED",
      "DRAFT",
    ]);
    expect(entries.map(({ percentage }) => percentage)).toEqual([3, 66, 4, 2, 2, 16, 3, 2, 1]);

    render(<StatusBreakdownChart byStatus={byStatus} />);
    expect(screen.getByTestId("status-donut-total")).toHaveAccessibleName("122 total indents");
    expect(screen.getByTestId("status-legend-percentage-APPROVED")).toHaveTextContent("66%");
    expect(screen.getByTestId("status-legend-percentage-DRAFT")).toHaveTextContent("1%");
  });

  it("leaves an empty status off the legend entirely rather than printing a zero row", () => {
    render(
      <StatusBreakdownChart
        byStatus={{ ALLOCATED: 6, DRAFT: 0, REJECTED: Number.NaN, APPROVED: 40 }}
      />,
    );

    // Only the two statuses holding indents. A "Draft 0 0%" row spends a line of the
    // card saying nothing, and an unreadable count is treated the same as an empty one.
    expect(screen.getAllByTestId(/^status-legend-row-/)).toHaveLength(2);
    expect(screen.queryByTestId("status-legend-row-DRAFT")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-legend-row-REJECTED")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-donut-slice-DRAFT")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^status-donut-slice-/)).toHaveLength(2);
    expect(screen.getByTestId("status-donut-total")).toHaveAccessibleName("46 total indents");
  });

  it("uses padded responsive sizing and the preserved status colours", () => {
    render(<StatusBreakdownChart byStatus={STATUS_DATA} />);

    expect(screen.getByTestId("status-donut-slice-DRAFT")).toHaveAttribute("fill", "var(--color-neutral)");
    expect(screen.getByTestId("status-donut-slice-ALLOCATED")).toHaveAttribute("fill", "#8b5cf6");
    expect(screen.getByTestId("status-donut-slice-PARTIALLY_FULFILLED")).toHaveAttribute("fill", "#0891b2");
    expect(screen.getByTestId("status-donut-slice-CLOSED")).toHaveAttribute("fill", "var(--color-ok)");
    expect(screen.getByTestId("status-donut-container")).toHaveClass(
      "h-[250px]",
      "max-w-[250px]",
      "sm:h-[290px]",
      "sm:max-w-[290px]",
      "md:h-[330px]",
      "md:max-w-[330px]",
    );

    const draft = screen.getByTestId("status-donut-slice-DRAFT");
    expect(Number(draft.getAttribute("data-inner-radius")) / Number(draft.getAttribute("data-outer-radius")))
      .toBeCloseTo(69 / 90, 2);
  });

  it("does not apply a selected or focus outline to a slice", () => {
    render(
      <StatusBreakdownChart byStatus={STATUS_DATA} selectedStatuses={["DRAFT"]} />,
    );

    const selectedSlice = screen.getByTestId("status-donut-slice-DRAFT");
    const selectedPath = selectedSlice.querySelector("path");
    const unselectedPath = screen.getByTestId("status-donut-slice-ALLOCATED").querySelector("path");
    expect(selectedSlice).not.toHaveAttribute("stroke");
    expect(selectedSlice).not.toHaveClass("focus-visible:stroke-brand", "focus-visible:stroke-[3px]");
    expect(selectedPath).toHaveAttribute("stroke", "hsl(var(--heroui-content1))");
    expect(selectedPath).toHaveAttribute("stroke-width", "2");
    expect(unselectedPath).toHaveAttribute("stroke", "hsl(var(--heroui-content1))");
    expect(unselectedPath).toHaveAttribute("stroke-width", "2");
  });

  it("renders a selected single status as one clean solid full ring", () => {
    render(
      <StatusBreakdownChart
        byStatus={{ ALLOCATED: 6 }}
        selectedStatuses={["ALLOCATED"]}
      />,
    );

    const slice = screen.getByTestId("status-donut-slice-ALLOCATED");
    const path = slice.querySelector("path");
    expect(screen.getAllByTestId(/^status-donut-slice-/)).toHaveLength(1);
    expect(slice).not.toHaveAttribute("stroke");
    expect(path).toHaveAttribute("stroke", "none");
    expect(path).toHaveAttribute("stroke-width", "0");
    expect(path).not.toHaveAttribute("filter");
    expect(path).not.toHaveAttribute("transform");
    expect(Number(slice.getAttribute("data-inner-radius")) / Number(slice.getAttribute("data-outer-radius")))
      .toBeCloseTo(69 / 90, 2);
    expect(path?.getAttribute("d")).toContain("A");
    expect(path?.getAttribute("d")).not.toContain("NaN");
  });
});
