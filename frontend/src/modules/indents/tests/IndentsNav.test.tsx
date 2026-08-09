import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "@/shared/types";

// The strip renders what /api/auth/me granted, so the menu is the input under test.
const mockMenu = vi.hoisted(() => ({ current: [] as MenuItem[] }));

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ me: { menu: mockMenu.current } }),
}));

const { IndentsNav } = await import("../components/IndentsNav");

const page = (code: string, path: string, name: string): MenuItem =>
  ({ code, path, name, icon: null, module: null, children: [] } as unknown as MenuItem);

function withMenu(children: MenuItem[]) {
  mockMenu.current = [
    page("home", "/", "Home"),
    { ...page("grp_indents", "/indents/dashboard", "Indents"), children },
  ];
  return render(
    <MemoryRouter>
      <IndentsNav />
    </MemoryRouter>,
  );
}

const ALL = [
  page("ind_dashboard", "/indents/dashboard", "Overview"),
  page("ind_list", "/indents", "All Requests"),
  page("ind_deliveries", "/indents/deliveries", "My Deliveries"),
  page("ind_ack", "/indents/acknowledgments", "Acknowledgments"),
  page("ind_reports", "/indents/reports", "Activity Ledger"),
  page("ind_notifications", "/indents/notifications", "Notifications"),
];

describe("IndentsNav", () => {
  it("groups every granted indent area under plain-language navigation", () => {
    withMenu(ALL);
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
    withMenu(ALL);
    expect(screen.getByRole("link", { name: "All requests" }))
      .toHaveAttribute("href", "/indents");
    expect(screen.getByRole("link", { name: "Alert & Notification" }))
      .toHaveAttribute("href", "/indents/notifications");
  });

  it("shows only the tabs the login was granted", () => {
    // Exactly the case that was broken: Overview and All Requests ticked in Job
    // Profiles, the other four not. The strip used to advertise all six and the
    // route guard refused four of them.
    withMenu([ALL[0], ALL[1]]);
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All requests" })).toBeInTheDocument();
    for (const label of ["My deliveries", "Acknowledgments",
      "Activity ledger", "Alert & Notification"]) {
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });

  it("renders nothing when no indent page is granted", () => {
    const { container } = withMenu([]);
    expect(container).toBeEmptyDOMElement();
  });
});
