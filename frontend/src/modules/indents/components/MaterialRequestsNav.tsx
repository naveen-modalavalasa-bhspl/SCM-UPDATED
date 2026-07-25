import { NavLink } from "react-router-dom";
import {
  Bell, ClipboardCheck, Columns3, Gauge, List, ScrollText,
} from "lucide-react";

const destinations = [
  { to: "/indents/dashboard", label: "Overview", icon: Gauge },
  { to: "/indents", label: "All requests", icon: List, end: true },
  { to: "/indents/board", label: "Status board", icon: Columns3 },
  { to: "/indents/acknowledgments", label: "Acknowledgments", icon: ClipboardCheck },
  { to: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  { to: "/indents/notifications", label: "Notifications", icon: Bell },
];

export function MaterialRequestsNav({ embedded = false }: { embedded?: boolean }) {
  return (
    <nav
      aria-label="Material Requests"
      className={`${embedded ? "" : "mb-5"} overflow-x-auto`}
    >
      <div className={`flex min-w-max gap-1 p-1 ${
        embedded ? "" : "rounded-xl border border-line bg-content1"
      }`}>
        {destinations.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold ${
                isActive ? "bg-brand text-white" : "text-muted hover:bg-content2 hover:text-body"
              }`
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
