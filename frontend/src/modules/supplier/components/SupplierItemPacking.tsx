import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Card, ErrorBanner, Input } from "@/shared/components";
import { HierarchyLadder } from "@/shared/packing";
import { supplierApi } from "@/modules/procurement/api";

/**
 * Profile > Packing (2026-10-11): how each item mapped to THIS supplier is to be
 * packed — every pack hierarchy of the item, every level with what one holds and its
 * minimum fill, the default marked. Read-only: the hierarchies are the buyer's
 * master. The server scopes the list on the vendor in the token, so a supplier only
 * ever sees their own items.
 */
export function SupplierItemPacking() {
  const [search, setSearch] = useState("");
  const { data, error, isLoading } = useQuery({
    queryKey: ["supplier-item-packing"],
    queryFn: () => supplierApi.itemPacking(),
  });
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((row) => !term
      || [row.item_code, row.item_name, row.vendor_item_code]
        .some((v) => (v ?? "").toLowerCase().includes(term)));
  }, [data, search]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        How each of your items is to be packed. A level's size is the most one pack
        holds; where a minimum is shown, a pack must not be made with less. Send a
        part pack only for what is left over, and say so on the despatch note.
      </p>
      <ErrorBanner error={error} />
      <Input placeholder="Search an item or your part number" value={search}
             onChange={(e) => setSearch(e.target.value)} />
      {isLoading ? <Card className="p-5 text-sm text-muted">Loading your items…</Card>
        : rows.length === 0 ? (
          <Card className="p-5 text-sm text-muted">
            {(data ?? []).length === 0
              ? "No items are mapped to you yet. Your buyer maps the items you supply."
              : "No item matches that search."}
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((row) => (
              <Card key={row.item_id} className="space-y-3 p-4">
                <div>
                  <div className="font-semibold text-ink">{row.item_name ?? "—"}</div>
                  <div className="font-mono text-xs text-muted">
                    {row.item_code}
                    {row.vendor_item_code && <> · your code {row.vendor_item_code}</>}
                    {row.uom_code && <> · counted in {row.uom_code}</>}
                  </div>
                </div>
                {row.hierarchies.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">
                    <Package size={14} aria-hidden /> No packing set — supplied loose, in {row.uom_code ?? "units"}.
                  </div>
                ) : row.hierarchies.map((h) => (
                  <HierarchyLadder key={h.hierarchy_id ?? h.name} hierarchy={h} uom={row.uom_code} />
                ))}
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
