import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { TrendingDown, Clock, FilePlus2, Info, Trash2, Plus } from "lucide-react";
import {
  Button, Card, ConfirmModal, Field, Input, PageHeader, ResponsiveList, Select,
  StatCard, useAction, type Column,
  ResponsiveGrid,
} from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import {
  deleteReplenishmentRule, getCatalogItems, getReplenishments, getWarehouses,
  listReplenishmentRules, saveReplenishmentRule,
} from "../api";
import type { ReplenishmentRule } from "../types";

/**
 * Items whose available quantity has fallen under their reorder level.
 *
 * The screen raises nothing by itself. It used to carry a "Create PO" button wired to
 * a stub that threw — buying starts with an indent, so the action here hands the item
 * to the indent form and the normal approval chain takes over from there.
 */

type Row = Record<string, any>;

const CRITICALITY: Record<string, "danger" | "warning" | "default"> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "default",
};

const BLANK: ReplenishmentRule = {
  warehouse_id: 0, item_id: 0, min_qty: 0, max_qty: 0, reorder_qty: 0,
};

type Tab = "shortfall" | "rules";

const TABS: { key: Tab; label: string }[] = [
  { key: "shortfall", label: "Needs reordering" },
  { key: "rules", label: "Rules" },
];

/**
 * Segmented control — one track, the selected segment raised out of it.
 *
 * Two `<Button>`s side by side read as two independent actions ("do this", "do that")
 * rather than one setting with two positions. A shared recessed track is what tells
 * the eye these are alternatives.
 */
function SegmentedTabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" aria-label="Replenishment view"
         className="inline-flex rounded-xl border border-line/70 bg-content2 p-1">
      {TABS.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`h-10 rounded-lg px-4 text-sm font-semibold transition-colors ${
              on ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Min / max / reorder quantity for one item in one warehouse.
 *
 * The rule is what the shortfall list and the below-minimum notification are both
 * judged against, so it is edited here rather than hidden in Masters: the reorder
 * level on the item master is a company-wide default, this is what a given warehouse
 * actually needs on its own shelf.
 */
function RulesPanel({ warehouses }: { warehouses: { id: number; name: string }[] }) {
  const [draft, setDraft] = useState<ReplenishmentRule | null>(null);

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["replenishment-rules"],
    queryFn: () => listReplenishmentRules(),
  });
  const { data: items = [] } = useQuery({ queryKey: ["catalog-items"], queryFn: getCatalogItems });

  const [ruleToDelete, setRuleToDelete] = useState<ReplenishmentRule | null>(null);
  const invalidates = [["replenishment-rules"], ["replenishment"]];

  const save = useAction({
    run: saveReplenishmentRule,
    success: (rule) => `Rule saved for ${rule.item_code ?? "item"} at ${rule.warehouse_name ?? "warehouse"}`,
    invalidates,
    onDone: () => setDraft(null),
  });

  // Deleting stops the below-minimum alert for this item entirely, which is a quiet
  // failure nobody notices until stock runs out. Worth one question first.
  const remove = useAction({
    run: (r: ReplenishmentRule) => deleteReplenishmentRule(r.warehouse_id, r.item_id),
    success: "Replenishment rule removed",
    invalidates,
    onDone: () => { setRuleToDelete(null); setDraft(null); },
  });

  const set = (patch: Partial<ReplenishmentRule>) =>
    setDraft((d) => ({ ...(d ?? BLANK), ...patch }));

  const invalid =
    !draft?.warehouse_id || !draft?.item_id || draft.max_qty < draft.min_qty;

  const columns: Column<ReplenishmentRule>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.item_name}</div>
          <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
        </div>
      ),
    },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "—" },
    {
      key: "available_qty",
      header: "Available",
      className: "text-right",
      render: (r) => (
        <span className={r.is_breached ? "font-semibold text-danger" : "text-body"}>
          {r.available_qty} <span className="text-[11px] font-normal text-muted">{r.uom_code}</span>
        </span>
      ),
    },
    { key: "min_qty", header: "Min", className: "text-right", render: (r) => r.min_qty },
    { key: "max_qty", header: "Max", className: "text-right", render: (r) => r.max_qty },
    { key: "reorder_qty", header: "Reorder Qty", className: "text-right", render: (r) => r.reorder_qty },
    {
      key: "state",
      header: "Status",
      render: (r) => (
        <Chip size="sm" variant="flat" color={r.is_breached ? "danger" : "success"}>
          {r.is_breached ? "Below min" : "OK"}
        </Chip>
      ),
    },
    {
      key: "action",
      header: "",
      render: (r) => (
        <div className="flex gap-1">
          <Button variant="subtle" onClick={() => setDraft(r)}>Edit</Button>
          <Button variant="subtle" onClick={() => setRuleToDelete(r)} aria-label="Delete rule">
            <Trash2 size={14} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          When available stock drops under the minimum, the warehouse in-charge and
          everyone on the stock-alert notification rule are told.
        </p>
        {!draft && (
          <Button onClick={() => setDraft(BLANK)}><Plus size={14} /> Add rule</Button>
        )}
      </div>

      {draft && (
        <Card className="mb-4 p-4">
          {/* Every control sits in a <Field>, so all five labels share one baseline.
              Select's own `label` floats inside the box and would sit a row lower than
              the Inputs' labels — hence ariaLabel here and the label on the Field. */}
          <div className="grid items-start gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Warehouse">
              <Select
                ariaLabel="Warehouse"
                value={draft.warehouse_id ? String(draft.warehouse_id) : ""}
                onChange={(v) => set({ warehouse_id: Number(v) })}
                placeholder="Pick a warehouse"
                options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))}
              />
            </Field>
            <Field label="Item">
              <Select
                ariaLabel="Item"
                value={draft.item_id ? String(draft.item_id) : ""}
                onChange={(v) => set({ item_id: Number(v) })}
                placeholder="Pick an item"
                options={items.map((i) => ({ value: String(i.id), label: `${i.code} — ${i.name}` }))}
              />
            </Field>
            <Field label="Minimum" hint="Alert below this">
              <Input type="number" min={0} value={String(draft.min_qty)}
                     onChange={(e) => set({ min_qty: Number(e.target.value) })} />
            </Field>
            <Field label="Maximum" hint="Top back up to this">
              <Input type="number" min={0} value={String(draft.max_qty)}
                     onChange={(e) => set({ max_qty: Number(e.target.value) })} />
            </Field>
            <Field label="Reorder quantity" hint="Minimum order size">
              <Input type="number" min={0} value={String(draft.reorder_qty)}
                     onChange={(e) => set({ reorder_qty: Number(e.target.value) })} />
            </Field>
          </div>
          {draft.max_qty < draft.min_qty && (
            <p className="mt-3 text-sm text-danger">Maximum cannot be below the minimum.</p>
          )}
          {save.error && <p className="mt-3 text-sm text-danger">{(save.error as Error).message}</p>}
          <div className="mt-4 flex gap-2 border-t border-line/60 pt-4">
            <Button disabled={invalid || save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save rule"}
            </Button>
            <Button variant="subtle" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <Card className="p-2">
        <ResponsiveList
          data={rules}
          columns={columns}
          keyOf={(r) => `${r.warehouse_id}-${r.item_id}`}
          loading={isLoading}
          empty="No replenishment rules yet. Add one to start watching an item in a warehouse."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-ink">{r.item_name}</span>
                <Chip size="sm" variant="flat" color={r.is_breached ? "danger" : "success"}>
                  {r.is_breached ? "Below min" : "OK"}
                </Chip>
              </div>
              <div className="text-xs text-muted">{r.warehouse_name}</div>
              <div className="text-sm">
                Available <strong>{r.available_qty}</strong> · min {r.min_qty} · max {r.max_qty} · reorder {r.reorder_qty}
              </div>
              <Button variant="subtle" onClick={() => setDraft(r)}>Edit</Button>
            </div>
          )}
        />
      </Card>

      <ConfirmModal
        isOpen={ruleToDelete !== null}
        title="Remove this replenishment rule?"
        message={
          <>
            <strong>{ruleToDelete?.item_name}</strong> at{" "}
            <strong>{ruleToDelete?.warehouse_name}</strong> will no longer be watched, and
            nobody is told when it drops below {ruleToDelete?.min_qty}.
          </>
        }
        confirmLabel="Remove rule"
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => ruleToDelete && remove.mutate(ruleToDelete)}
        onClose={() => setRuleToDelete(null)}
      />
    </>
  );
}

export function StockReplenishmentView() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("shortfall");
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [criticality, setCriticality] = useState("");

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  const { data = [], isLoading } = useQuery<Row[]>({
    queryKey: ["replenishment", warehouseId, criticality],
    queryFn: () =>
      getReplenishments({
        warehouse_id: warehouseId ? Number(warehouseId) : undefined,
        criticality: criticality || undefined,
      }),
  });

  // Only the text search is client-side: the endpoint returns the full shortfall list,
  // which is small by definition, and a round trip per keystroke buys nothing.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (r) => r.item_name?.toLowerCase().includes(q) || r.item_code?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const kpis = useMemo(() => {
    const critical = rows.filter((r) => ["CRITICAL", "HIGH"].includes(r.criticality)).length;
    const longLead = rows.filter((r) => (r.lead_time_days ?? 0) > 14).length;
    return { critical, longLead };
  }, [rows]);

  const raiseIndent = (r: Row) =>
    navigate(`/indents/new?item_id=${r.item_id}&quantity=${Math.ceil(r.suggested_order_qty || 0)}`);

  const columns: Column<Row>[] = [
    {
      key: "item",
      header: "Item",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.item_name}</div>
          <div className="font-mono text-[11px] text-muted">
            {r.item_code}{r.category_name ? ` · ${r.category_name}` : ""}
          </div>
        </div>
      ),
    },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "—", hideOnNarrow: true },
    {
      key: "available",
      header: "Available",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-danger">
          {r.available_qty} <span className="text-[11px] font-normal text-muted">{r.uom_code}</span>
        </span>
      ),
    },
    {
      key: "reorder_level",
      header: "Reorder Level",
      className: "text-right",
      render: (r) => <span className="text-body">{r.reorder_level}</span>,
    },
    {
      key: "shortfall",
      header: "Shortfall",
      className: "text-right",
      render: (r) => <span className="text-warning">{Math.max(0, r.reorder_level - r.available_qty).toFixed(2)}</span>,
    },
    {
      key: "suggested_order_qty",
      header: "Suggested Order",
      className: "text-right",
      render: (r) => <span className="font-semibold text-ink">{r.suggested_order_qty}</span>,
    },
    {
      key: "lead_time_days",
      header: "Lead Time",
      hideOnNarrow: true,
      render: (r) => (r.lead_time_days ? `${r.lead_time_days} days` : "—"),
    },
    {
      key: "criticality",
      header: "Criticality",
      render: (r) =>
        r.criticality ? (
          <Chip size="sm" variant="flat" color={CRITICALITY[r.criticality] ?? "default"}>{r.criticality}</Chip>
        ) : "—",
    },
    {
      key: "action",
      header: "",
      render: (r) => (
        <Button variant="subtle" onClick={() => raiseIndent(r)}>
          <FilePlus2 size={14} /> Raise request
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Replenishment"
        actions={<SegmentedTabs value={tab} onChange={setTab} />}
      />

      {tab === "rules" ? (
        <RulesPanel warehouses={warehouses} />
      ) : (
      <>
      <ResponsiveGrid cols={3} className="mb-4">
        <StatCard label="Items Below Reorder" value={rows.length} icon={<TrendingDown size={16} />} tone={rows.length ? "text-danger" : "text-muted"} />
        <StatCard label="Critical / High" value={kpis.critical} tone={kpis.critical ? "text-danger" : "text-muted"} />
        <StatCard label="Lead Time > 14 days" value={kpis.longLead} icon={<Clock size={16} />} />
      </ResponsiveGrid>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search item code or name…"
        onClear={() => { setSearch(""); setWarehouseId(""); setCriticality(""); }}
        active={[search, warehouseId, criticality].filter(Boolean).length}
      >
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          placeholder="All warehouses"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          value={criticality}
          onChange={setCriticality}
          placeholder="Any criticality"
          options={["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((c) => ({ value: c, label: c }))}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => `${r.item_id}-${r.warehouse_id ?? 0}`}
          loading={isLoading}
          empty={
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Info className="h-5 w-5 text-muted" />
              <p className="text-sm font-medium text-ink">Nothing needs reordering</p>
              <p className="max-w-md text-sm text-muted">
                This list is built from the replenishment rules and, where an item has no rule,
                its reorder level on the item master. Nothing is below its limit right now.
              </p>
              <Button variant="subtle" onClick={() => setTab("rules")}>Add a rule</Button>
            </div>
          }
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-ink">{r.item_name}</span>
                {r.criticality && (
                  <Chip size="sm" variant="flat" color={CRITICALITY[r.criticality] ?? "default"}>{r.criticality}</Chip>
                )}
              </div>
              <div className="font-mono text-[11px] text-muted">{r.item_code}</div>
              <div className="flex gap-4 text-sm">
                <span className="text-danger">Available {r.available_qty}</span>
                <span className="text-muted">Reorder at {r.reorder_level}</span>
              </div>
              <div className="text-sm">Suggested order: <strong>{r.suggested_order_qty} {r.uom_code}</strong></div>
              <Button variant="subtle" onClick={() => raiseIndent(r)}>
                <FilePlus2 size={14} /> Raise request
              </Button>
            </div>
          )}
        />
      </Card>
      </>
      )}
    </div>
  );
}
