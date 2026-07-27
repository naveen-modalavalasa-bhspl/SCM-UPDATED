import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Button, Card, Field, Input, Select } from "@/shared/components";
import { api } from "@/shared/api/client";
import { getCatalogItems } from "../api";
import type { CatalogItemOption } from "../types";

/**
 * One item, all the indents waiting on it, and the stock there is to go round.
 *
 * The per-indent screen answers "what does this request get". This one answers the
 * question that actually decides it: 60 bags of cement, four projects want it, who
 * gets what. Allocating one indent at a time hides the competition, which is the
 * information the allocator most needs.
 */
interface DemandRow {
  indent_id: number;
  indent_no: string;
  indent_item_id: number;
  requested_by_name: string | null;
  department_name: string | null;
  project_name: string | null;
  priority: string;
  required_date: string | null;
  requested_qty: number;
  raised_at: string | null;
}

interface ItemDemand {
  item_id: number;
  item_code: string | null;
  item_name: string | null;
  uom_code: string | null;
  available_total: number;
  warehouses: { warehouse_id: number; warehouse_name: string | null; available_qty: number }[];
  demand: DemandRow[];
}

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";
}

export function ItemDemandPage() {
  const nav = useNavigate();
  const [itemId, setItemId] = useState("");
  const [split, setSplit] = useState<Record<number, string>>({});

  const { data: items } = useQuery({
    queryKey: ["catalog-items"],
    queryFn: getCatalogItems,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["item-demand", itemId],
    queryFn: () =>
      api.get<ItemDemand>(`/api/allocations/demand/${itemId}`).then((r) => r.data),
    enabled: Boolean(itemId),
  });

  useEffect(() => setSplit({}), [itemId]);

  const totals = useMemo(() => {
    const asked = (data?.demand ?? []).reduce((n, r) => n + r.requested_qty, 0);
    const giving = Object.values(split).reduce((n, v) => n + Number(v || 0), 0);
    return { asked, giving, left: (data?.available_total ?? 0) - giving };
  }, [data, split]);

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Demand by item" />

      <p className="mb-4 text-sm text-muted">
        Every indent still waiting on one item, and the stock there is to go round.
        Plan the split here, then open each indent to commit it.
      </p>

      <Card className="mb-4 p-4">
        <Select
          label="Item"
          value={itemId}
          onChange={setItemId}
          placeholder="Pick an item…"
          options={(items ?? []).map((i: CatalogItemOption) => ({
            value: String(i.id),
            label: `${i.code} — ${i.name}`,
          }))}
        />
      </Card>

      {!itemId && <p className="text-muted">Choose an item to see who is waiting for it.</p>}
      {error && <p className="rounded-lg bg-danger-50 p-4 text-danger">{(error as Error).message}</p>}
      {isLoading && itemId && <p className="text-muted">Loading…</p>}

      {data && (
        <>
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <p className="text-muted">On hand</p>
                <p className="tabular text-lg font-semibold text-ink">
                  {data.available_total} {data.uom_code}
                </p>
              </div>
              <div>
                <p className="text-muted">Total asked</p>
                <p className="tabular text-lg font-semibold text-ink">
                  {totals.asked} {data.uom_code}
                </p>
              </div>
              <div>
                <p className="text-muted">Planned</p>
                <p className="tabular text-lg font-semibold text-ink">{totals.giving}</p>
              </div>
              <div>
                <p className="text-muted">Left after</p>
                <p
                  className={`tabular text-lg font-semibold ${
                    totals.left < 0 ? "text-danger" : "text-ink"
                  }`}
                >
                  {totals.left}
                </p>
              </div>
            </div>
            {totals.left < 0 && (
              <p className="mt-2 text-sm text-danger">
                Planning to give more than there is. Reduce something.
              </p>
            )}
            {data.warehouses.length > 0 && (
              <p className="mt-3 text-sm text-muted">
                {data.warehouses
                  .map((w) => `${w.warehouse_name}: ${w.available_qty}`)
                  .join(" · ")}
              </p>
            )}
          </Card>

          {data.demand.length === 0 ? (
            <p className="text-muted">Nothing is waiting on this item.</p>
          ) : (
            <div className="space-y-3">
              {data.demand.map((row) => (
                <Card key={row.indent_item_id} className="p-4">
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="mono font-semibold text-ink">{row.indent_no}</span>
                      <p className="text-sm text-muted">
                        {row.requested_by_name ?? "—"} · {row.department_name ?? "—"}
                        {row.project_name ? ` · ${row.project_name}` : ""}
                      </p>
                    </div>
                    <div className="text-sm text-muted">
                      wants{" "}
                      <span className="tabular font-semibold text-ink">
                        {row.requested_qty}
                      </span>{" "}
                      {data.uom_code} · needed {fmtDate(row.required_date)}
                      {row.priority === "URGENT" && (
                        <span className="ml-2 text-warning">URGENT</span>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Plan to give">
                      <Input
                        type="number"
                        min={0}
                        value={split[row.indent_item_id] ?? ""}
                        placeholder="0"
                        onChange={(e) =>
                          setSplit((p) => ({ ...p, [row.indent_item_id]: e.target.value }))
                        }
                      />
                    </Field>
                    <div className="flex items-end">
                      <Button
                        variant="ghost"
                        onClick={() => nav(`/inventory/allocate/${row.indent_id}`)}
                      >
                        Open and commit
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
