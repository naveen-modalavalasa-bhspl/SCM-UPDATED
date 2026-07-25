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
    expect(screen.getByRole("navigation", { name: "Material Requests" })).toBeInTheDocument();
    for (const label of [
      "Overview", "All requests", "Status board", "Acknowledgments",
      "Activity ledger", "Notifications",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });
});
