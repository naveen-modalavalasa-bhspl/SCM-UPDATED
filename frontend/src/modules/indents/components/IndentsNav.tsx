import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  Bell, ClipboardCheck, Columns3, Gauge, List, ScrollText,
} from "lucide-react";
import { NavLink } from "react-router-dom";

/**
 * Sub-navigation for Indent.
 */
const destinations = [
  { key: "/indents/dashboard", label: "Overview", icon: Gauge },
  { key: "/indents", label: "All requests", icon: List, end: true },
  { key: "/indents/board", label: "Board", icon: Columns3 },
  { key: "/indents/acknowledgments", label: "Acknowledgments", icon: ClipboardCheck },
  { key: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  { key: "/indents/notifications", label: "Alert & Notification", icon: Bell },
];

export function IndentsNav({ embedded = false }: { embedded?: boolean }) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <nav
      aria-label="Indent"
      className={`${embedded ? "" : "mb-5"} overflow-x-auto`}
    >
      <LayoutGroup id="indent-navigation">
        <div className="flex min-w-max items-stretch gap-5">
          {destinations.map(({ key, label, icon: Icon, end }) => (
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
