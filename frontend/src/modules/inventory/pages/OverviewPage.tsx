import { useQuery } from "@tanstack/react-query";
import { Boxes, Database, Wrench } from "lucide-react";
import { Card, PageHeader } from "@/shared/components";
import { inventoryApi } from "../api";

export function InventoryOverviewPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["inventory-overview"],
    queryFn: inventoryApi.overview,
  });

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Inventory workspace" />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <Boxes className="mb-3 h-5 w-5 text-brand" />
          <h2 className="font-semibold text-ink">Module isolated</h2>
          <p className="mt-1 text-sm text-muted">
            Inventory frontend and backend code now have their own module folders.
          </p>
        </Card>
        <Card className="p-5">
          <Wrench className="mb-3 h-5 w-5 text-warn" />
          <h2 className="font-semibold text-ink">Ready for development</h2>
          <p className="mt-1 text-sm text-muted">
            {isLoading ? "Checking backend…" : data?.status.replace(/_/g, " ")}
          </p>
        </Card>
        <Card className="p-5">
          <Database className="mb-3 h-5 w-5 text-info" />
          <h2 className="font-semibold text-ink">Frozen schema protected</h2>
          <p className="mt-1 text-sm text-muted">
            Database models remain empty until approved inventory tables are mapped.
          </p>
        </Card>
      </div>
    </>
  );
}
