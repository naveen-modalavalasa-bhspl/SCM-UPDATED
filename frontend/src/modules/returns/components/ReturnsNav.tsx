import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ClipboardCheck, Gauge, List, Scale, Settings, Truck, Undo2,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/shared/auth/AuthContext";

/**
 * Sub-navigation for Returns — the same tab strip Indents uses, so a person moving
 * between the two modules is not learning a second navigation.
 *
 * Unlike `IndentsNav` these tabs are not filtered against `me.menu`: Returns has no
 * `rbac_pages` rows yet (the seed entry is on the outside-changes list), so filtering
 * by the menu would hide every tab and leave the module unreachable. The endpoints
 * behind each screen are permission-gated regardless — hiding a tab was never the
 * security boundary.
 */
type Tab = {
  key: string;
  label: string;
  icon: typeof Gauge;
  end?: boolean;
  permission?: string;
};

const destinations: Tab[] = [
  { key: "/returns/dashboard", label: "Overview", icon: Gauge },
  { key: "/returns", label: "All returns", icon: List, end: true },
  { key: "/returns/approvals", label: "To approve", icon: ClipboardCheck },
  // The two desks. Shown to everyone for the same reason the rest of the strip is: the
  // queues are already empty for anybody who cannot act on them — the backend filters
  // them to what this login actually holds — so hiding the tab adds nothing.
  { key: "/returns/decisions", label: "Decision desk", icon: Scale },
  { key: "/returns/sign-off", label: "Sign-off", icon: ClipboardCheck },
  { key: "/returns/mine", label: "My returns", icon: Undo2 },
  { key: "/returns/purchase", label: "Purchase returns", icon: Truck },
  // Who signs after the reporting line does. Only shown to whoever configures
  // approvals — the endpoints behind it are gated on the same code.
  {
    key: "/returns/settings/receiving",
    label: "Receiving approvers",
    icon: Settings,
    permission: "return.config.manage",
  },
];

export function ReturnsNav({ embedded = false }: { embedded?: boolean }) {
  const prefersReducedMotion = useReducedMotion();
  const { can } = useAuth();
  const tabs = destinations.filter((tab) => !tab.permission || can(tab.permission));

  return (
    <nav aria-label="Returns" className={`${embedded ? "" : "mb-5"} overflow-x-auto`}>
      <LayoutGroup id="returns-navigation">
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
                      layoutId="returns-active-tab"
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
