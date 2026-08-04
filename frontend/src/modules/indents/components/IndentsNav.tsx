import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  Bell, ClipboardCheck, Gauge, List, PackageCheck, ScrollText,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/shared/auth/AuthContext";

/**
 * Sub-navigation for Indent.
 *
 * `page` is the rbac_pages code that has to be granted for the tab to appear. This
 * list used to render unconditionally, so a login granted nothing but the Indents
 * group still saw all six tabs — the screens behind them only failed once their API
 * call came back "Missing permission: indent.view".
 *
 * Matched on page code, not path: grp_indents and ind_dashboard share the path
 * /indents/dashboard, so a path match would make Overview appear for someone who was
 * given only the parent.
 */
const destinations = [
  { key: "/indents/dashboard", page: "ind_dashboard", label: "Overview", icon: Gauge },
  { key: "/indents", page: "ind_list", label: "All requests", icon: List, end: true },
  // Board is parked: the route and BoardPage are still here, just off the tab bar.
  // { key: "/indents/board", page: "ind_board", label: "Board", icon: Columns3 },
  { key: "/indents/deliveries", page: "ind_deliveries", label: "My deliveries", icon: PackageCheck },
  { key: "/indents/acknowledgments", page: "ind_ack", label: "Acknowledgments", icon: ClipboardCheck },
  { key: "/indents/reports", page: "ind_reports", label: "Activity ledger", icon: ScrollText },
  { key: "/indents/notifications", page: "ind_notifications", label: "Alert & Notification", icon: Bell },
];

/** Every page code in the menu, at any depth. */
function menuCodes(nodes: { code: string; children?: unknown[] }[]): Set<string> {
  const out = new Set<string>();
  const walk = (ns: { code: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      out.add(n.code);
      walk((n.children ?? []) as { code: string; children?: unknown[] }[]);
    }
  };
  walk(nodes);
  return out;
}

export function IndentsNav({ embedded = false }: { embedded?: boolean }) {
  const prefersReducedMotion = useReducedMotion();
  const { me } = useAuth();
  const allowed = menuCodes(me?.menu ?? []);
  const visible = destinations.filter((d) => allowed.has(d.page));

  // Nothing granted below the group: render no tab strip rather than an empty bar.
  if (!visible.length) return null;

  return (
    <nav
      aria-label="Indent"
      className={`${embedded ? "" : "mb-5"} overflow-x-auto`}
    >
      <LayoutGroup id="indent-navigation">
        <div className="flex min-w-max items-stretch gap-5">
          {visible.map(({ key, label, icon: Icon, end }) => (
            <NavLink
              key={key}
              to={key}
              end={end}
              className={({ isActive }) =>
                `relative inline-flex min-h-11 shrink-0 items-center gap-2 px-1 text-sm font-medium ` +
                `transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 ` +
                `focus-visible:ring-brand focus-visible:ring-offset-2 ${
                  isActive ? "text-brand" : "text-muted hover:text-body"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="indent-active-tab"
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-brand"
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 500, damping: 38, mass: 0.65 }
                      }
                    />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </LayoutGroup>
    </nav>
  );
}
