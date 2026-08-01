import { describe, expect, it, vi } from "vitest";
// fireEvent, not user-event: the latter is not a dependency of this project.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SubNav, type SubNavItem } from "./SubNav";

const routeItems: SubNavItem[] = [
  { key: "/indents", label: "All requests", end: true },
  { key: "/indents/board", label: "Status board" },
];

const tabItems: SubNavItem[] = [
  { key: "balance", label: "Stock balance" },
  { key: "ledger", label: "Stock ledger" },
];

describe("SubNav", () => {
  it("renders links when no onChange is given", () => {
    render(
      <MemoryRouter initialEntries={["/indents/board"]}>
        <SubNav label="Material Requests" items={routeItems} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Status board" })).toHaveAttribute(
      "href", "/indents/board",
    );
  });

  it("marks the current route so it is announced, not only coloured", () => {
    render(
      <MemoryRouter initialEntries={["/indents/board"]}>
        <SubNav label="Material Requests" items={routeItems} />
      </MemoryRouter>,
    );
    // NavLink sets aria-current on the active link.
    expect(screen.getByRole("link", { name: "Status board" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("renders buttons and reports the choice when onChange is given", () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <SubNav label="Inventory" items={tabItems} value="balance" onChange={onChange} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stock ledger" }));
    expect(onChange).toHaveBeenCalledWith("ledger");
  });

  it("marks the selected tab in state mode too", () => {
    render(
      <MemoryRouter>
        <SubNav label="Inventory" items={tabItems} value="ledger" onChange={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Stock ledger" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Stock balance" }))
      .not.toHaveAttribute("aria-current");
  });

  it("names the strip for screen readers", () => {
    render(
      <MemoryRouter>
        <SubNav label="Inventory" items={tabItems} value="balance" onChange={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Inventory" })).toBeInTheDocument();
  });
});
