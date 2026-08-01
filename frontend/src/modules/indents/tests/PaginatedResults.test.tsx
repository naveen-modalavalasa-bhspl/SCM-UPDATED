import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaginatedResults } from "../components/PaginatedResults";

function bounds(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 800,
    height,
    top: 0,
    right: 800,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function footer() {
  return (
    <div data-testid="pagination-footer">
      <button type="button">Previous</button>
      <button type="button">Next</button>
    </div>
  );
}

function results(pageKey: number, isFetching: boolean, label: string) {
  return (
    <PaginatedResults
      ariaLabel="Results"
      isFetching={isFetching}
      hasData
      pageKey={pageKey}
      footer={footer()}
    >
      <div>{label}</div>
    </PaginatedResults>
  );
}

describe("PaginatedResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("locks the current height only during fetch, then transitions from taller to shorter", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        return bounds(this.textContent?.includes("Short page") ? 120 : 480);
      });

    const { rerender } = render(results(1, false, "Tall page"));
    const shell = screen.getByTestId("paginated-results-shell");
    const content = screen.getByTestId("paginated-results-content");
    const paginationFooter = screen.getByTestId("pagination-footer");
    expect(shell.style.height).toBe("");
    expect(shell.style.minHeight).toBe("");

    rerender(results(2, true, "Tall page"));
    expect(shell).toHaveStyle({ height: "480px", overflow: "hidden", transition: "none" });
    expect(content).toHaveClass("duration-150", "opacity-70");
    expect(screen.getByRole("region", { name: "Results" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating results…");
    expect(content).not.toContainElement(paginationFooter);

    rerender(results(2, false, "Short page"));
    expect(shell).toHaveStyle({
      height: "120px",
      overflow: "hidden",
      transition: "height 180ms ease",
    });
    expect(content).toHaveClass("duration-150", "opacity-100");

    fireEvent.transitionEnd(shell, { propertyName: "height" });
    expect(shell.style.height).toBe("");
    expect(shell.style.minHeight).toBe("");
    expect(shell.style.overflow).toBe("");
    expect(shell.style.transition).toBe("");
  });

  it("transitions from a shorter page to a taller page and restores natural height", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        return bounds(this.textContent?.includes("Tall page") ? 510 : 135);
      });

    const { rerender } = render(results(1, false, "Short page"));
    const shell = screen.getByTestId("paginated-results-shell");

    rerender(results(2, true, "Short page"));
    expect(shell).toHaveStyle({ height: "135px" });
    rerender(results(2, false, "Tall page"));
    expect(shell).toHaveStyle({ height: "510px", transition: "height 180ms ease" });

    fireEvent.transitionEnd(shell, { propertyName: "height" });
    expect(shell.style.height).toBe("");
    expect(shell.style.overflow).toBe("");
  });

  it("does not retain a session maximum after a tall page settles to a short page", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        return bounds(this.textContent?.includes("Tall page") ? 600 : 150);
      });

    const { rerender } = render(results(1, false, "Tall page"));
    const shell = screen.getByTestId("paginated-results-shell");
    rerender(results(2, true, "Tall page"));
    rerender(results(2, false, "Short page"));
    expect(shell).toHaveStyle({ height: "150px" });
    fireEvent.transitionEnd(shell, { propertyName: "height" });

    rerender(results(3, true, "Short page"));
    expect(shell).toHaveStyle({ height: "150px" });
    expect(shell.style.minHeight).toBe("");
  });

  it("animates an immediately available cached page without remounting the shell or footer", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        return bounds(this.textContent?.includes("Cached page") ? 220 : 420);
      });
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = render(results(1, false, "Current page"));
    const shell = screen.getByTestId("paginated-results-shell");
    const nextButton = screen.getByRole("button", { name: "Next" });
    rerender(results(2, false, "Cached page"));

    expect(screen.getByTestId("paginated-results-shell")).toBe(shell);
    expect(screen.getByRole("button", { name: "Next" })).toBe(nextButton);
    expect(shell).toHaveStyle({ height: "220px", transition: "height 180ms ease" });
    rerender(results(3, true, "Cached page"));
    expect(shell).toHaveStyle({ height: "220px", transition: "none" });
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves the footer directly after naturally sized last-page content", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        return bounds(this.textContent?.includes("13 notifications") ? 390 : 600);
      });

    const { rerender } = render(results(1, false, "20 notifications"));
    const shell = screen.getByTestId("paginated-results-shell");
    const content = screen.getByTestId("paginated-results-content");
    const paginationFooter = screen.getByTestId("pagination-footer");
    rerender(results(2, true, "20 notifications"));
    rerender(results(2, false, "13 notifications"));
    expect(shell).toHaveStyle({ height: "390px" });
    fireEvent.transitionEnd(shell, { propertyName: "height" });

    expect(shell.style.height).toBe("");
    expect(shell.style.minHeight).toBe("");
    expect(content).not.toContainElement(paginationFooter);
    expect(shell.nextElementSibling).toContainElement(paginationFooter);
  });
});
