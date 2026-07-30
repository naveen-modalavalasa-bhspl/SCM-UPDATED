import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MaterialRequestsNav } from "../components/MaterialRequestsNav";

describe("MaterialRequestsNav", () => {
  it("groups every indent area under plain-language navigation", () => {
    render(
      <MemoryRouter>
        <MaterialRequestsNav />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Indent" })).toBeInTheDocument();
    for (const label of [
      "Overview", "All requests", "Board", "Acknowledgments",
      "Activity ledger", "Alert & Notification",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("keeps the existing route paths behind the renamed labels", () => {
    render(
      <MemoryRouter>
        <MaterialRequestsNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/indents/board");
    expect(screen.getByRole("link", { name: "Alert & Notification" })).toHaveAttribute("href", "/indents/notifications");
  });
});
