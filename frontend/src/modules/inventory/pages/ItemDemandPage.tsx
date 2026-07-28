import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { PageHeader, Button, Card, ResponsiveList, StatCard, type Column } from "@/shared/components";
import { FilterSelect } from "../components/FilterBar";
import { api } from "@/shared/api/client";
import { getCatalogItems } from "../api";
import type { CatalogItemOption } from "../types";

/**
 * One item, all the indents waiting on it, and the stock there is to go round.
 *
 * The per-indent screen answers "what does this request get". This one answers the
 * question that actually decides it: 60 bags of cement, four projects want it, who
 * gets what. The planned split is a scratchpad — nothing is committed until the
 * indent's own allocation screen is opened, so the numbers here never move stock.
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

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

const daysTo = (s: string | null) =>
  s ? Math.ceil((new Date(s).getTime() - Date.now()) / 86_400_000) : null;

export function ItemDemandPage() {
  const nav = useNavigate();
  const [itemId, setItemId] = useState("");
  const [split, setSplit] = useState<Record<number, string>>({});

  const { data: items } = useQuery({ queryKey: ["catalog-items"], queryFn: getCatalogItems });

  const { data, isLoading, error } = useQuery({
    queryKey: ["item-demand", itemId],
    queryFn: () => api.get<ItemDemand>(`/api/allocations/demand/${itemId}`).then((r) => r.data),
    enabled: Boolean(itemId),
  });

  useEffect(() => setSplit({}), [itemId]);

  const totals = useMemo(() => {
    const asked = (data?.demand ?? []).reduce((n, r) => n + r.requested_qty, 0);
    const planned = Object.values(split).reduce((n, v) => n + Number(v || 0), 0);
    return { asked, planned, left: (data?.available_total ?? 0) - planned };
  }, [data, split]);

  /** Give everyone their full ask, oldest first, until the stock runs out. */
  const suggestSplit = () => {
    if (!data) return;
    let left = data.available_total;
    const next: Record<number, string> = {};
    [...data.demand]
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "URGENT" ? -1 : 1;
        return (a.required_date ?? "9999").localeCompare(b.required_date ?? "9999");
      })
      .forEach((r) => {
        const give = Math.min(r.requested_qty, left);
        left -= give;
        next[r.indent_item_id] = String(give);
      });
    setSplit(next);
  };

  const columns: Column<DemandRow>[] = [
    {
      key: "indent",
      header: "Indent",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.indent_no}</div>
          <div className="text-[11px] text-muted">raised {fmtDate(r.raised_at)}</div>
        </div>
      ),
    },
    {
      key: "who",
      header: "Requested by",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.requested_by_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">
            {r.department_name ?? "—"}{r.project_name ? ` · ${r.project_name}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      render: (r) => (
        <Chip size="sm" variant="flat" color={r.priority === "URGENT" ? "danger" : "default"}>{r.priority}</Chip>
      ),
    },
    {
      key: "needed",
      header: "Needed By",
      hideOnNarrow: true,
      render: (r) => {
        const d = daysTo(r.required_date);
        return (
          <div>
            <div className="text-sm text-body">{fmtDate(r.required_date)}</div>
            {d !== null && (
              <div className={`text-[11px] ${d < 0 ? "text-danger" : d <= 3 ? "text-warning" : "text-muted"}`}>
                {d < 0 ? `${Math.abs(d)}d overdue` : `in ${d}d`}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "wants",
      header: "Wants",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-ink">
          {r.requested_qty} <span className="text-[11px] font-normal text-muted">{data?.uom_code}</span>
        </span>
      ),
    },
    {
      key: "plan",
      header: "Plan to give",
      render: (r) => (
        <input
          type="number"
          min={0}
          max={r.requested_qty}
          value={split[r.indent_item_id] ?? ""}
          placeholder="0"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setSplit((p) => ({ ...p, [r.indent_item_id]: e.target.value }))}
          className="h-11 w-24 rounded-lg border border-line bg-content1 px-2 text-right text-sm text-ink outline-none focus:border-brand"
        />
      ),
    },
    {
      key: "go",
      header: "",
      render: (r) => (
        <Button variant="ghost" onClick={() => nav(`/inventory/allocate/${r.indent_id}`)}>Commit</Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Demand by Item"
        actions={
          data && data.demand.length > 0 ? (
            <Button variant="ghost" onClick={suggestSplit}>Suggest a split</Button>
          ) : undefined
        }
      />

      <p className="mb-4 text-sm text-muted">
        Every indent still waiting on one item, and the stock there is to go round. Plan the split
        here, then commit it on each indent — nothing on this screen moves stock.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-content1 p-2">
        <FilterSelect
          value={itemId}
          onChange={setItemId}
          placeholder="Pick an item…"
          options={(items ?? []).map((i: CatalogItemOption) => ({
            value: String(i.id),
            label: `${i.code} — ${i.name}`,
          }))}
        />
        {data && (
          <span className="text-sm text-muted">
            {data.warehouses.map((w) => `${w.warehouse_name}: ${w.available_qty}`).join(" · ") || "No stock anywhere"}
          </span>
        )}
      </div>

      {!itemId && (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
          Choose an item to see who is waiting for it.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(error as Error).message}
        </p>
      )}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="On Hand" value={`${data.available_total} ${data.uom_code ?? ""}`} />
            <StatCard label="Total Asked" value={`${totals.asked} ${data.uom_code ?? ""}`} tone={totals.asked > data.available_total ? "text-warning" : "text-ink"} />
            <StatCard label="Planned" value={totals.planned} />
            <StatCard label="Left After" value={totals.left} tone={totals.left < 0 ? "text-danger" : "text-ink"} />
          </div>

          {totals.left < 0 && (
            <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              The plan gives out {Math.abs(totals.left)} {data.uom_code} more than there is. Reduce something.
            </p>
          )}

          <Card className="p-2">
            <ResponsiveList
              data={data.demand}
              columns={columns}
              keyOf={(r) => r.indent_item_id}
              loading={isLoading}
              empty="Nothing is waiting on this item."
              renderCard={(r) => (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-ink">{r.indent_no}</span>
                    <Chip size="sm" variant="flat" color={r.priority === "URGENT" ? "danger" : "default"}>
                      {r.priority}
                    </Chip>
                  </div>
                  <p className="text-sm text-body">{r.requested_by_name ?? "—"} · {r.department_name ?? "—"}</p>
                  <p className="text-sm">Wants <strong>{r.requested_qty} {data.uom_code}</strong> by {fmtDate(r.required_date)}</p>
                  <Button variant="ghost" onClick={() => nav(`/inventory/allocate/${r.indent_id}`)}>Commit</Button>
                </div>
              )}
            />
          </Card>
        </>
      )}
    </div>
  );
}
