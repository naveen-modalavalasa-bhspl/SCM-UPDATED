import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Check, X, RefreshCw, Download } from "lucide-react";
import {
  Button, Can, Card, FilterBar, FilterDateRange, FilterMenu, Input, PageHeader,
  ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import {
  listStockAdjustments, approveStockAdjustment, rejectStockAdjustment,
  getStockAdjustment, getWarehouses,
} from "../api";
import type { StockAdjustment, StockAdjustmentLine } from "../types";
import { alerts } from "@/modules/alerts";
import { claimError, isAnnouncedGlobally } from "@/shared/api/errors";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { ErrorNote } from "./PageStates";
import { TONE_APPROVE, TONE_REJECT, TONE_MINT, TONE_BLUE } from "@/shared/components/tones";

// Mirrors shared.enums.AdjustmentReason — the service refuses anything else.
const REASONS = [
  { value: "CYCLE_COUNT", label: "Stock audit (count variance)" },
  { value: "DAMAGE", label: "Damage" },
  { value: "EXPIRY", label: "Expiry" },
  { value: "EXCESS", label: "Found stock" },
  { value: "SHORTAGE", label: "Shortage" },
  { value: "QUALITY_REJECTION", label: "Quality rejection" },
  { value: "OPENING_BALANCE", label: "Opening balance" },
  { value: "OTHER", label: "Other" },
];
const reasonLabel = (v: string) => REASONS.find((r) => r.value === v)?.label ?? v;

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

const fmt = (n: number) => Number(n.toFixed(3)).toString();
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/** The difference a line states: physical - system on a counted line. */
function lineDifference(line: StockAdjustmentLine): number {
  if (line.physical_qty != null && line.system_qty != null) {
    return line.physical_qty - line.system_qty;
  }
  return line.direction === "OUT" ? -line.quantity : line.quantity;
}

export function StockAdjustmentsView() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewId = Number(searchParams.get("review")) || null;
  const [error, setError] = useState("");
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });

  // ---- the register: every filter lives in the URL, so a refresh or a shared link
  // lands on the same list ----
  const status = searchParams.get("status") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
  const reasonFilter = searchParams.get("reason") ?? "";
  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const [searchText, setSearchText] = useState(searchParams.get("q") ?? "");
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    setSearchParams(next, { replace: true });
  };
  // Debounced: one request per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((searchParams.get("q") ?? "") !== searchText.trim()) setFilter("q", searchText.trim());
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  const search = searchParams.get("q") ?? "";
  const activeFilters = [search, warehouseFilter, reasonFilter, dateFrom || dateTo].filter(Boolean).length;
  const clearFilters = () => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    setSearchText("");
    setSearchParams(next, { replace: true });
  };

  const PAGE_SIZE = 25;
  const { data, isLoading } = useQuery({
    queryKey: ["stock-adjustments", status, search, warehouseFilter, reasonFilter, dateFrom, dateTo, page],
    queryFn: () => listStockAdjustments({
      status: status || undefined,
      search: search || undefined,
      warehouse_id: warehouseFilter ? Number(warehouseFilter) : undefined,
      reason: reasonFilter || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page,
      size: PAGE_SIZE,
    }),
  });
  const rows: StockAdjustment[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const refresh = () => qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  const fail = (e: any) => setError(e?.response?.data?.error ?? "The action failed");

  // ---- the detail sheet, opened from a row or from an approvals deep link ----
  const openReview = (id: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("review", String(id)); else next.delete("review");
    setSearchParams(next, { replace: true });
  };
  const detail = useQuery({
    queryKey: ["stock-adjustment", reviewId],
    queryFn: () => getStockAdjustment(reviewId as number),
    enabled: reviewId != null,
  });
  const selected = detail.data ?? null;
  const [decisionNote, setDecisionNote] = useState("");
  useEffect(() => setDecisionNote(""), [reviewId]);

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      approve ? approveStockAdjustment(id, decisionNote) : rejectStockAdjustment(id, decisionNote),
    onSuccess: (_r, { approve }) => {
      void alerts.success(approve ? "adjustment.approved" : "adjustment.rejected", {
        item: selected?.adjustment_no ?? "The audit", qty: "its counted quantities",
      });
      setError("");
      refresh();
      void qc.invalidateQueries({ queryKey: ["stock-adjustment", reviewId] });
    },
    // SCM_0119: an approve / reject that did not go through says so in a dialog that
    // stays up — the inline note alone sat at the top of a page the sheet covers.
    onError: (e: any, { approve }) => {
      fail(e);
      if (isAnnouncedGlobally(e)) return;
      claimError(e);
      void alerts.error("adjustment.action_failed", {
        number: selected?.adjustment_no ?? "The audit",
        action: approve ? "approved" : "rejected",
        // `message` is the client's one translation of any failure (shared/api/errors).
        reason: e?.message || "the server refused it",
      });
    },
  });
  const askThenDecide = async (approve: boolean) => {
    if (!selected) return;
    if (approve && !(await alerts.confirm("adjustment.approve", { item: selected.adjustment_no }))) return;
    decide.mutate({ id: selected.id, approve });
  };

  const columns: Column<StockAdjustment>[] = [
    { key: "adjustment_no", header: "Audit No", render: (r) => <strong>{r.adjustment_no}</strong> },
    { key: "warehouse_name", header: "Warehouse", render: (r) => r.warehouse_name ?? "-" },
    { key: "reason", header: "Reason", hideOnNarrow: true, render: (r) => reasonLabel(r.reason) },
    {
      key: "status", header: "Status",
      render: (r) => (
        <div className="space-y-0.5">
          <StatusPill status={r.status} />
          {r.status === "PENDING_APPROVAL" && r.current_approver_name && (
            <div className="text-xs text-muted">With {r.current_approver_name}</div>
          )}
        </div>
      ),
    },
    { key: "created_by_name", header: "Raised By", render: (r) => r.created_by_name ?? "-", hideOnNarrow: true },
    {
      key: "created_at", header: "Created", hideOnNarrow: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "-"),
    },
  ];

  const exportCsv = () => {
    const header = ["Audit No", "Warehouse", "Reason", "Status", "Raised By", "Created At"];
    const cell = (v: unknown) => `"${v == null ? "" : String(v).replace(/"/g, '""')}"`;
    const body = rows.map((r) => [
      r.adjustment_no, r.warehouse_name, reasonLabel(r.reason), r.status, r.created_by_name,
      r.created_at ? new Date(r.created_at).toLocaleString() : "-",
    ]);
    const csv = [header, ...body].map((line) => line.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-audits-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Audit"
        actions={
          <>
            <Button className={TONE_BLUE} variant="ghost" disabled={rows.length === 0} onClick={exportCsv}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button variant="subtle" onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
            <Can do="stock.adjust">
              <Button className={TONE_MINT} onClick={() => nav("/inventory/adjustments/new")}><Plus size={14} /> New Stock Audit</Button>
            </Can>
          </>
        }
      />

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.value || "all"}
            variant={status === t.value ? "primary" : "subtle"}
            aria-pressed={status === t.value}
            onClick={() => setFilter("status", t.value)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <FilterBar
        search={searchText}
        onSearch={setSearchText}
        searchPlaceholder="Search audit no., raised by or item..."
        searchClassName="w-full sm:w-72"
        active={activeFilters}
        onClear={clearFilters}
        right={<span className="text-sm text-muted">{total} audit{total === 1 ? "" : "s"}</span>}
      >
        <FilterMenu
          label="Warehouse"
          value={warehouseFilter}
          onChange={(v) => setFilter("warehouse", v)}
          options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))}
        />
        <FilterMenu
          label="Reason"
          value={reasonFilter}
          onChange={(v) => setFilter("reason", v)}
          options={REASONS}
        />
        <FilterDateRange
          label="Created"
          from={dateFrom}
          to={dateTo}
          onFrom={(v) => setFilter("from", v)}
          onTo={(v) => setFilter("to", v)}
        />
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          page={page}
          totalPages={totalPages}
          onPageChange={(p) => setFilter("page", p > 1 ? String(p) : "")}
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => openReview(r.id)}
          empty={activeFilters || status ? "No stock audits match these filters." : "No stock audits yet."}
          renderCard={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.adjustment_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-xs text-muted">{r.warehouse_name} · {reasonLabel(r.reason)}</div>
              {r.status === "PENDING_APPROVAL" && r.current_approver_name && (
                <div className="text-xs text-muted">With {r.current_approver_name}</div>
              )}
            </div>
          )}
        />
      </Card>

      <DetailSheet
        open={reviewId != null}
        onClose={() => openReview(null)}
        title={selected?.adjustment_no ?? (detail.isError ? "Not found" : "Loading…")}
        subtitle={selected?.warehouse_name}
        badge={selected && <StatusPill status={selected.status} />}
        footer={selected?.can_act ? (
          <Can do="stock.adjust.approve">
            <div className="space-y-2">
              <Input
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Comment (required to explain a rejection)"
                aria-label="Approval comment"
              />
              <div className="flex gap-2">
                <Button className={TONE_APPROVE} disabled={decide.isPending} onClick={() => void askThenDecide(true)}>
                  <Check size={14} /> Approve
                </Button>
                <Button
                  className={TONE_REJECT} variant="subtle"
                  disabled={decide.isPending || !decisionNote.trim()}
                  onClick={() => void askThenDecide(false)}
                >
                  <X size={14} /> Reject
                </Button>
              </div>
            </div>
          </Can>
        ) : undefined}
      >
        {detail.isError && <ErrorNote message="This stock audit could not be opened." />}
        {selected && (
          <>
            <SheetSection title="Details">
              <SheetRow label="Reason" value={reasonLabel(selected.reason)} />
              <SheetRow label="Raised By" value={selected.created_by_name} />
              <SheetRow label="Created At" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : "-"} />
              {selected.status === "PENDING_APPROVAL" && (
                <SheetRow label="Waiting On" value={selected.current_approver_name ?? "An approver holding Stock Audit approval"} />
              )}
              {selected.approved_by_name && selected.status === "APPROVED" && (
                <SheetRow label="Approved By" value={selected.approved_by_name} />
              )}
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>

            <SheetSection title="System vs physical stock">
              {selected.items?.length ? (
                <div className="space-y-2.5">
                  {selected.items.map((item) => {
                    const diff = lineDifference(item);
                    return (
                      <div key={item.id} className="rounded-xl border border-line/70 p-3 space-y-2 bg-card/60">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-ink text-sm">{item.item_name || "Unknown item"}</div>
                            <div className="text-xs text-muted font-mono">{item.item_code} · {item.uom_code ?? "-"}</div>
                          </div>
                          {(item.batch_id || item.bin_id) ? (
                            <div className="flex flex-wrap gap-1 text-[11px] shrink-0">
                              {item.batch_id ? (
                                <span className="rounded-md bg-content2 px-2 py-0.5 border border-line text-body">
                                  Batch #{item.batch_id}
                                </span>
                              ) : null}
                              {item.bin_id ? (
                                <span className="rounded-md bg-content2 px-2 py-0.5 border border-line text-body">
                                  Bin #{item.bin_id}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {item.remarks && (
                          <div className="text-xs text-brand bg-brand/5 border border-brand/20 rounded-lg p-2 font-mono">
                            {item.remarks}
                          </div>
                        )}

                        <div className="grid grid-cols-3 gap-2 text-sm tabular-nums rounded-lg bg-content2/30 p-2">
                          <span>
                            <span className="block text-[10px] uppercase font-semibold text-muted">System</span>
                            {item.system_qty != null ? fmt(item.system_qty) : "—"}
                          </span>
                          <span>
                            <span className="block text-[10px] uppercase font-semibold text-muted">Physical</span>
                            {item.physical_qty != null ? fmt(item.physical_qty) : "—"}
                          </span>
                          <span className={diff ? "font-semibold text-ink" : "text-muted"}>
                            <span className="block text-[10px] uppercase font-semibold text-muted">Difference</span>
                            {signed(diff)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted">No items on this audit.</p>
              )}
            </SheetSection>
          </>
        )}
      </DetailSheet>
    </div>
  );
}
