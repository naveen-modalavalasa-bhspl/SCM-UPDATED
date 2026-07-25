import {
  Bell, ClipboardCheck, Columns3, Gauge, List, ScrollText,
} from "lucide-react";
import { SubNav, type SubNavItem } from "@/shared/components";

/**
 * Sub-navigation for Material Requests.
 *
 * The strip itself is shared, so Inventory and Warehouse look identical to this;
 * this file only owns the destinations.
 */
const destinations: SubNavItem[] = [
  { key: "/indents/dashboard", label: "Overview", icon: Gauge },
  { key: "/indents", label: "All requests", icon: List, end: true },
  { key: "/indents/board", label: "Status board", icon: Columns3 },
  { key: "/indents/acknowledgments", label: "Acknowledgments", icon: ClipboardCheck },
  { key: "/indents/reports", label: "Activity ledger", icon: ScrollText },
  { key: "/indents/notifications", label: "Notifications", icon: Bell },
];

export function MaterialRequestsNav({ embedded = false }: { embedded?: boolean }) {
  return <SubNav label="Material Requests" items={destinations} bare={embedded} />;
}
