import { NavLink } from "react-router-dom";

const items = [
  { to: "/approvals", label: "Waiting for Me", end: true },
  { to: "/approvals/decisions", label: "My Decisions" },
  { to: "/approvals/team-queue", label: "Team Queue" },
  { to: "/approvals/delegations", label: "Delegations" },
];

/** In-module navigation remains available even before RBAC menu rows are reseeded. */
export function ApprovalsNav() {
  return (
    <nav aria-label="Approvals navigation" className="mb-5 flex gap-2 overflow-x-auto pb-1">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            isActive ? "bg-brand text-white" : "bg-content1 text-body hover:bg-content2"
          }`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
