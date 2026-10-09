import { Outlet } from "react-router-dom";
import { Layers, Map, Warehouse } from "lucide-react";
import { PageHeader, SubNav } from "@/shared/components";
import { usePointLabel } from "../../usePointLabel";

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
  // Every kind of storage location, cold rooms and chillers included — a chiller is a
  // kind of location, not a separate idea, which is what "Refrigeration types" made it.
  { key: "storage-types", label: "Storage types", icon: Layers },
];

export default function MastersLayout() {
  const label = usePointLabel();
  return (
    <div>
      <PageHeader eyebrow={label} title="Master data" />
      {/* Written here rather than as a `subtitle` prop: `PageHeader` is shared and only
          the lead edits it (rule 12). Three tabs whose relationship is not obvious from
          their names is worth one sentence. */}
      <p className="-mt-3 mb-4 max-w-2xl text-sm leading-relaxed text-muted">
        The sites, the storage locations inside them, and the kinds of location they are
        built out of. A location's kind decides where it may sit and whether stock is
        held in it — so <span className="font-medium text-body">Storage types</span> is
        where the shape of a warehouse is set, and the floor plan is what that shape
        came to.
      </p>
      <SubNav label={`${label} masters`} items={ITEMS} />
      <Outlet />
    </div>
  );
}
