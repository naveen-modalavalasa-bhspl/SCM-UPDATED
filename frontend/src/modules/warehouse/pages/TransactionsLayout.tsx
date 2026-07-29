import { Outlet } from "react-router-dom";
import { ArrowLeftRight, ClipboardCheck, PackageCheck, PackageOpen, Send, Truck, Undo2 } from "lucide-react";
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
  { key: "material-inward", label: "Gate entry", icon: PackageOpen },
  { key: "grn", label: "GRN", icon: PackageCheck },
  { key: "quality-inspection", label: "Inspection", icon: ClipboardCheck },
  { key: "putaway", label: "Putaway", icon: ArrowLeftRight },
  { key: "picklist", label: "Picking", icon: ClipboardCheck },
  { key: "material-issues", label: "Issues", icon: Send },
  { key: "dispatch", label: "Dispatch", icon: Truck },
  { key: "purchase-returns", label: "Returns", icon: Undo2 },
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
