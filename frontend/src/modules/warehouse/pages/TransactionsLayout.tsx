import { Outlet } from "react-router-dom";
import {
  ClipboardCheck, FileText, PackageCheck, RotateCcw, Send, Truck,
} from "lucide-react";
import { SubNav, type SubNavItem } from "@/shared/components";

/**
 * Warehouse transaction sections.
 *
 * Uses the shared SubNav so this strip matches Material Requests and Inventory;
 * it previously used underlined HeroUI tabs, which made the module look like a
 * different application.
 */
const sections: SubNavItem[] = [
  { key: "/warehouse/transactions/material-inward", label: "Material inward", icon: Truck },
  { key: "/warehouse/transactions/grn", label: "Goods receipt", icon: FileText },
  { key: "/warehouse/transactions/quality-inspection", label: "Quality inspection", icon: ClipboardCheck },
  { key: "/warehouse/transactions/putaway", label: "Put-away", icon: PackageCheck },
  { key: "/warehouse/transactions/purchase-returns", label: "Purchase returns", icon: RotateCcw },
  { key: "/warehouse/transactions/material-issues", label: "Material issues", icon: Send },
];

export function TransactionsLayout() {
  return (
    <div className="space-y-6">
      <SubNav label="Warehouse transactions" items={sections} />
      <Outlet />
    </div>
  );
}

export default TransactionsLayout;
