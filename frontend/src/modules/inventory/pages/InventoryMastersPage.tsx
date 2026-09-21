import { INVENTORY_MASTER_GROUPS, MastersShell } from "@/modules/masters/pages/MastersPage";

/** Inventory > Masters — the item catalogue, where a stock line's item comes from.
 *
 *  It renders the masters module's own screen over the inventory slice of it, so
 *  there is exactly one implementation of every tab and `/masters` keeps working
 *  untouched. Gated by `page.inv_masters.view`, which inherits from
 *  `page.masters.view` (see platform/rbac/permissions.py). */
export function InventoryMastersPage() {
  return <MastersShell groups={INVENTORY_MASTER_GROUPS} eyebrow="Inventory" title="Item masters" />;
}
