import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  Bell, Gauge, List, PackageCheck, ScrollText, type LucideIcon,
} from "lucide-react";
import { NavLink } from "react-router-dom";

import { useAuth } from "@/shared/auth/AuthContext";

/**
 * Sub-navigation for Indent.
 */
interface Destination {
  key: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Paths this screen was routed at before, still honoured when matching grants. */
  was?: string[];
}

const destinations: Destination[] = [
  { key: "/indents/dashboard", label: "Overview", icon: Gauge },
  { key: "/indents", label: "All requests", icon: List, end: true },
  // Board is parked: the route and BoardPage are still here, just off the tab bar.
  // { key: "/indents/board", label: "Board", icon: Columns3 },
  // One screen, not two: acknowledging a delivery is what this list is FOR, and the
  // separate Acknowledgments tab listed the same documents a second time.
  //
  // `was` lists the paths this screen used to be routed at. On a database the rename
  // migration has not reached, rbac_pages still says "/indents/deliveries" (and may
  // still carry the deleted duplicate at "/indents/acknowledgments"), so matching only
  // the new path would hide the tab there.
  { key: "/indents/acknowledgements", label: "Acknowledgements", icon: PackageCheck,
    was: ["/indents/deliveries", "/indents/acknowledgments"] },
  { key: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  { key: "/indents/notifications", label: "Alert & Notification", icon: Bell },
];

export function IndentsNav({ embedded = false }: { embedded?: boolean }) {
  const prefersReducedMotion = useReducedMotion();
  // AppLayout keeps grp_indents out of the data-driven tab strip, so these tabs are
  // the only place indents screens are listed. Hardcoding them ignored rbac_pages:
  // unticking a page in Job Profiles left the tab up and only failed on click.
  const { me } = useAuth();
  const granted = new Set(
    (me?.menu ?? [])
      .filter((root) => root.code === "grp_indents")
      .flatMap((root) => [root.path, ...(root.children ?? []).map((c) => c.path)]),
  );
  const visible = destinations.filter(
    (d) => granted.has(d.key) || (d.was ?? []).some((path) => granted.has(path)),
  );
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
