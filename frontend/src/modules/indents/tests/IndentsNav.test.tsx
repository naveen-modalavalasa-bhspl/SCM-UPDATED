import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { IndentsNav } from "../components/IndentsNav";

describe("IndentsNav", () => {
  it("groups every indent area under plain-language navigation", () => {
    render(
      <MemoryRouter>
        <IndentsNav />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Indent" })).toBeInTheDocument();
    for (const label of [
      "Overview", "All requests", "Acknowledgments",
      "Activity ledger", "Alert & Notification",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Board is parked — off the tab bar, route and page kept.
    expect(screen.queryByRole("link", { name: "Board" })).not.toBeInTheDocument();
  });

  it("keeps the existing route paths behind the renamed labels", () => {
    render(
      <MemoryRouter>
        <IndentsNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "All requests" })).toHaveAttribute("href", "/indents");
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("href", "/indents/notifications");
  });
});
