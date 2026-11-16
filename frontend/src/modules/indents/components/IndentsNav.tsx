import {
  LayoutDashboard, List, PackageCheck, ScrollText, type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/shared/auth/AuthContext";
import { ModuleTabs } from "@/shared/layout/ModuleTabs";

/**
 * Sub-navigation for Indent.
 *
 * The LOOK is not here — it is `ModuleTabs`, which every module's strip renders.
 * This file only decides which indent screens the caller is allowed to see.
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
  // LayoutDashboard, not Gauge: every other module's Dashboard is the `layout-dashboard`
  // row from rbac_pages (Approvals, Inventory, Warehouse, Procurement), and Indents was
  // the one tab strip drawing a different glyph for the same screen.
  { key: "/indents/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "/indents", label: "All requests", icon: List, end: true },
  // Board is parked: the route and BoardPage are still here, just off the tab bar.
  // { key: "/indents/board", label: "Board", icon: Columns3 },
  // `was` lists the paths this screen used to be routed at. On a database the rename
  // migration has not reached, rbac_pages still says "/indents/deliveries" (and may
  // still carry the deleted duplicate at "/indents/acknowledgments"), so matching only
  // the new path would hide the tab there.
  { key: "/indents/acknowledgements", label: "Acknowledgements", icon: PackageCheck,
    was: ["/indents/deliveries", "/indents/acknowledgments"] },
  { key: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  // SCM_0056: moved to the top-level Alerts & Notifications page (/notifications),
  // which is `always_on` and never carried a grant this strip needs to check.
];

export function IndentsNav({ embedded = false }: { embedded?: boolean }) {
  // AppLayout keeps grp_indents out of the data-driven tab strip, so these tabs are
  // the only place indents screens are listed. Hardcoding them ignored rbac_pages:
  // unticking a page in Job Profiles left the tab up and only failed on click.
  const { me } = useAuth();
  const granted = new Set(
    (me?.menu ?? [])
      .filter((root) => root.code === "grp_indents")
      .flatMap((root) => [root.path, ...(root.children ?? []).map((c) => c.path)]),
  );

  return (
    <ModuleTabs
      ariaLabel="Indent"
      layoutId="indent-navigation"
      embedded={embedded}
      items={destinations
        .filter((d) => granted.has(d.key) || (d.was ?? []).some((path) => granted.has(path)))
        .map(({ key, label, icon: Icon, end }) => ({
          path: key,
          label,
          end,
          icon: <Icon className="h-4 w-4" />,
        }))}
    />
  );
}
