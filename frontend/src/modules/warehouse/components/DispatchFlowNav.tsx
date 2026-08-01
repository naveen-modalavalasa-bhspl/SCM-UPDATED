import { Boxes, Truck } from "lucide-react";
import { SubNav } from "@/shared/components";

const ITEMS = [
  { key: "/warehouse/dispatch/consignments", label: "Consignments", icon: Boxes },
  { key: "/warehouse/dispatch", label: "Dispatches", icon: Truck },
];

export function DispatchFlowNav() {
  return <SubNav label="Dispatch workflow" items={ITEMS} />;
}
