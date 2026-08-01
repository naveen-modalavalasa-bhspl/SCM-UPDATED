import { Outlet } from "react-router-dom";
import { Map, Snowflake, Warehouse } from "lucide-react";
import { PageHeader } from "@/shared/components";
import { SubNav } from "../../components/compat";

/**
 * The warehouse master shell.
 *
 * Only two things live here: the warehouse/bin master and the floor plan that draws
 * it. Items, vendors, UOM and projects belong to the Masters module — the old
 * warehouse masters screen duplicated all of them, which meant two places to edit an
 * item and no agreement about which one won.
 */
const ITEMS = [
  { key: "warehouses", label: "Warehouses", icon: Warehouse },
  { key: "floor-plan", label: "Floor plan", icon: Map },
  { key: "storage-types", label: "Refrigeration types", icon: Snowflake },
];

export default function MastersLayout() {
  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Master data" />
      <SubNav label="Warehouse masters" items={ITEMS} />
      <Outlet />
    </div>
  );
}
