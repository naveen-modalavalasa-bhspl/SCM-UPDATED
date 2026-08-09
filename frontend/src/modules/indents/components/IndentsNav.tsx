import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  Bell, ClipboardCheck, Gauge, List, PackageCheck, ScrollText,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/shared/auth/AuthContext";
import type { MenuItem } from "@/shared/types";

/**
 * Sub-navigation for Indent.
 *
 * The tab a user gets is decided by `/api/auth/me` menu, exactly like every other
 * module's tab strip. This list only supplies the label, icon and order — it is NOT
 * the source of truth for what is visible. It used to be, which is why unticking
 * "My deliveries" in Job Profiles left the tab on screen and only the route guard
 * stopped it: the strip advertised four screens the login could not open.
 */
const destinations = [
  { key: "/indents/dashboard", label: "Overview", icon: Gauge },
  { key: "/indents", label: "All requests", icon: List, end: true },
  // Board is parked: the route and BoardPage are still here, just off the tab bar.
  // { key: "/indents/board", label: "Board", icon: Columns3 },
  { key: "/indents/deliveries", label: "My deliveries", icon: PackageCheck },
  { key: "/indents/acknowledgments", label: "Acknowledgments", icon: ClipboardCheck },
  { key: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  { key: "/indents/notifications", label: "Alert & Notification", icon: Bell },
];

/** Every path under the Indents group this login was granted. */
function grantedPaths(menu: MenuItem[] | undefined): Set<string> {
  const group = (menu ?? []).find((m) => m.code === "grp_indents");
  const out = new Set<string>();
  const walk = (nodes: MenuItem[]) => {
    for (const n of nodes) {
      out.add(n.path);
      walk(n.children ?? []);
    }
  };
  walk(group?.children ?? []);
  return out;
}

export function IndentsNav({ embedded = false }: { embedded?: boolean }) {
  const prefersReducedMotion = useReducedMotion();
  const { me } = useAuth();
  const allowed = grantedPaths(me?.menu);
  const tabs = destinations.filter((d) => allowed.has(d.key));

  // Nothing granted: render no strip at all rather than an empty bordered row.
  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Indent"
      className={`${embedded ? "" : "mb-5"} overflow-x-auto`}
    >
      <LayoutGroup id="indent-navigation">
        <div className="flex min-w-max items-stretch gap-5">
          {tabs.map(({ key, label, icon: Icon, end }) => (
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
