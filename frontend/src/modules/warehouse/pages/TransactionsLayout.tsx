import { Outlet } from "react-router-dom";
import { ArrowLeftRight, ClipboardCheck, PackageCheck, PackageOpen, Send, Boxes, Truck, Undo2 } from "lucide-react";
import { PageHeader, SubNav } from "@/shared/components";

/**
 * The transactions shell — one strip over the whole warehouse document chain.
 *
 * The strip is the shared `<SubNav>` rather than the module's old HeroUI underline
 * tabs, so moving from Inventory to Warehouse no longer changes what a tab looks
 * like. The order is the physical order of the goods: in at the gate, inspected, put
 * away, picked, issued, dispatched, returned.
 */
const ITEMS = [
  { key: "/warehouse/transactions/material-inward", label: "Gate entry", icon: PackageOpen },
  { key: "/warehouse/transactions/grn", label: "GRN", icon: PackageCheck },
  { key: "/warehouse/transactions/quality-inspection", label: "Inspection", icon: ClipboardCheck },
  { key: "/warehouse/transactions/putaway", label: "Putaway", icon: ArrowLeftRight },
  { key: "/warehouse/transactions/stock-movements", label: "Stock movement", icon: ArrowLeftRight },
  { key: "/warehouse/transactions/picklist", label: "Picking", icon: ClipboardCheck },
  { key: "/warehouse/transactions/material-issues", label: "Issues", icon: Send },
  { key: "/warehouse/transactions/material-returns", label: "Issue returns", icon: Undo2 },
  { key: "/warehouse/transactions/consignments", label: "Consignments", icon: Boxes },
  { key: "/warehouse/transactions/dispatch", label: "Dispatch", icon: Truck },
  { key: "/warehouse/transactions/purchase-returns", label: "Returns", icon: Undo2 },
];

export default function TransactionsLayout() {
  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Transactions" />
      <SubNav label="Warehouse transactions" items={ITEMS} />
      <Outlet />
    </div>
  );
}
