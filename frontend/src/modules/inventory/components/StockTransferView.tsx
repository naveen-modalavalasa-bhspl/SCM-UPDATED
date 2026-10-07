import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Calendar, Clock, MapPin, PackageCheck, Plus, Trash2, Truck } from "lucide-react";
import {
  Button, Can, Card, Field, Input, KpiTiles, PageHeader, ResponsiveList, Select,
  StatusPill, useToast, type Column, type KpiTileSpec,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import AcknowledgementsPage from "@/modules/indents/pages/AcknowledgementsPage";
import { ReportLedgerPage } from "@/modules/reports";
import { FilterBar, FilterMenu } from "./FilterBar";
import { INDENT_STATUS_OPTIONS } from "@/modules/indents/constants";
import { DetailSheet, SheetRow, SheetSection } from "./DetailSheet";
import { ErrorNote } from "./PageStates";
import { FulfillmentQueuePage } from "../pages/FulfillmentQueuePage";
import QualityInspection from "@/modules/warehouse/pages/QualityInspection";
import {
  approveSTO, createSTO, getSTO, getAllWarehouses, getStockBalances, getWarehouses, listSTOs, listSTRs,
  rejectSTO,
} from "../api";

/**
 * Inventory > Stock Transfer (REQ_020) — the whole transfer, on one screen.
 *
 *   Requests      STRs: a point asks for stock. An STR is an indent underneath
 *                 (indent_type STR), approved on its own ladder — Settings >
 *                 Approvals Config > "Stock Transfer Request (STR)".
 *   To serve      the Fulfilment Queue narrowed to STRs: pick which of your points
 *                 gives what. Signing it drafts one STO + material issue per point.
 *   Orders        STOs — from an STR, or raised directly here. Each is executed by
 *                 its material issue, worked on this screen (`/inventory/transfers/
 *                 issues/:id`), then carried by a consignment in Logistics.
 *   Acknowledge   the requester confirms what arrived; that credits their point.
 *   History       every STR and STO on one ledger, with export.
 *
 * Nothing here decides who signs or moves stock itself: approvals go through the
 * engine, stock through the issue and the acknowledgement, exactly as for an indent.
 */

type Row = Record<string, any>;

/** Where an STO has got to, in words. The stage is SERVED (`_STO_STAGE_BY_ISSUE`). */
const STAGE_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "Awaiting approval",
  TO_ISSUE: "To issue",
  ISSUED: "Issued — awaiting consignment",
  IN_TRANSIT: "In transit",
  RECEIVED: "Received",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  APPROVED: "Approved",
  DISPATCHED: "Dispatched",
  COMPLETED: "Completed",
};

const DATE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "quarter", label: "Last 90 days" },
];

/** A date preset as the `YYYY-MM-DD` the server filters from, or undefined. */
function sinceDate(preset: string): string | undefined {
  if (!preset) return undefined;
  const days = ({ today: 0, week: 7, month: 30, quarter: 90 } as Record<string, number>)[preset] ?? 0;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA");
}

const STO_STATUS_OPTIONS = [
  { value: "PENDING_APPROVAL", label: "Awaiting approval" },
  { value: "APPROVED", label: "Approved (in progress)" },
  { value: "DISPATCHED", label: "Dispatched" },
  { value: "RECEIVED", label: "Received" },
  { value: "COMPLETED", label: "Completed (movement)" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

const KIND_OPTIONS = [
  { value: "STO", label: "Transfers (STO)" },
  { value: "SMO", label: "Bin movements (SMO)" },
];

const ORIGIN_OPTIONS = [
  { value: "STR", label: "Against an STR" },
  { value: "DIRECT", label: "Raised directly" },
];

export function StockTransferView() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  // How much sits behind each tab, so an empty first tab never reads as "nothing
  // here" while the orders are one press away.
  const strCount = useQuery({
    queryKey: ["stock-transfer", "count", "str"],
    queryFn: () => listSTRs({ size: 1 }),
    enabled: can("stock.transfer.view"),
  });
  const stoCount = useQuery({
    queryKey: ["stock-transfer", "count", "sto"],
    queryFn: () => listSTOs({ size: 1 }),
    enabled: can("stock.transfer.view"),
  });

  const tabs: { key: string; label: string; badge?: number }[] = useMemo(() => [
    // Each tab is gated on the permission its own data and buttons need — the same
    // list Settings > Job Profiles prints beside this screen.
    ...(can("stock.transfer.view") ? [{ key: "requests", label: "Requests (STR)",
                                badge: strCount.data?.total }] : []),
    ...(can("allocation.create") ? [{ key: "serve", label: "To serve" }] : []),
    ...(can("stock.transfer.view") ? [{ key: "orders", label: "Orders (STO / SMO)",
                                        badge: stoCount.data?.total as number | undefined }] : []),
    // The outward QC of a transfer's issue is done here, not on the warehouse rail.
    ...(can("qc_outward.view") ? [{ key: "qc", label: "Outward QC" }] : []),
    ...(can("indent.acknowledge") ? [{ key: "acknowledge", label: "Acknowledgements" }] : []),
    ...(can("stock.transfer.view") ? [{ key: "history", label: "History" }] : []),
  ], [can, strCount.data, stoCount.data]);

  const requested = params.get("tab");
  const active = tabs.some((t) => t.key === requested) ? requested! : tabs[0]?.key;
  const select = (key: string) => {
    const next = new URLSearchParams();
    next.set("tab", key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Stock Transfer" />
      <p className="mb-4 max-w-[80ch] text-sm text-muted">
        Request stock from another point (STR), serve it from the points you hold, and
        follow each transfer order (STO) through issue, dispatch and acknowledgement.
      </p>

      <div role="tablist" aria-label="Stock Transfer"
           className="mb-4 flex flex-wrap gap-1 rounded-xl border border-line/70 bg-content2/60 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            type="button"
            aria-selected={active === tab.key}
            onClick={() => select(tab.key)}
            className={`flex min-h-[44px] items-center rounded-lg px-4 text-sm font-semibold
              transition-colors ${active === tab.key
                ? "bg-brand text-white shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {tab.label}
            {tab.badge ? (
              <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                active === tab.key ? "bg-white/25 text-white" : "bg-brand/15 text-brand"}`}>
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {active === "requests" && <RequestsTab />}
      {active === "serve" && <FulfillmentQueuePage embedded indentType="STR" />}
      {active === "orders" && <OrdersTab />}
      {active === "qc" && (
        <QualityInspection type="OUTGOING" title="Outward QC" stockTransfer
                           basePath="/inventory/transfers/qc" />
      )}
      {active === "acknowledge" && <AcknowledgementsPage embedded indentTypes={["STR"]} />}
      {active === "history" && <ReportLedgerPage embedded ledgerKey="stock_transfers" />}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Requests — STRs
// --------------------------------------------------------------------------- //

function RequestsTab() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [raised, setRaised] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ["stock-transfer", "strs", search, status, raised, page],
    queryFn: () => listSTRs({
      search: search.trim() || undefined, status: status || undefined,
      created_date_from: sinceDate(raised), page,
    }),
  });
  const reset = (fn: (v: string) => void) => (v: string) => { fn(v); setPage(1); };
  const filtersOn = [search, status, raised].filter(Boolean).length;

  const columns: Column<Row>[] = [
    { key: "indent_no", header: "STR No",
      render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.indent_no}</span> },
    { key: "office_name", header: "For", render: (r) => r.office_name ?? r.requested_by_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "current_approver_name", header: "With", hideOnNarrow: true,
      render: (r) => r.current_approver_name ?? "—" },
    { key: "total_items", header: "Lines", hideOnNarrow: true, render: (r) => r.total_items ?? "—" },
    { key: "requested_by_name", header: "Raised by", hideOnNarrow: true,
      render: (r) => r.requested_by_name ?? "—" },
    { key: "created_at", header: "Raised on", hideOnNarrow: true, render: (r) => fmtDate(r.created_at) },
  ];

  return (
    <>
      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search STR no., item or project…"
        onClear={() => { setSearch(""); setStatus(""); setRaised(""); setPage(1); }}
        active={filtersOn}
      >
        <FilterMenu label="Status" value={status} onChange={reset(setStatus)}
                    options={INDENT_STATUS_OPTIONS} />
        <FilterMenu label="Raised" value={raised} onChange={reset(setRaised)}
                    options={DATE_OPTIONS} icon={<Calendar className="h-4 w-4 opacity-70" />} />
        <Can do="stock.transfer.request">
          <Button variant="primary" onClick={() => nav("/indents/new?type=STR")}>
            <Plus className="h-4 w-4" /> New STR
          </Button>
        </Can>
      </FilterBar>
      {error && <div className="mb-3"><ErrorNote message="Could not load transfer requests" /></div>}
      <Card className="p-2">
        <ResponsiveList
          data={data?.items ?? []}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/indents/${r.id}`)}
          empty={filtersOn
            ? "No requests match these filters."
            : "No stock transfer requests yet. Raise one with New STR — orders raised directly are on the Orders tab."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{r.indent_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.office_name ?? "—"}</div>
              <div className="text-xs text-muted">{r.requested_by_name ?? "—"} · {fmtDate(r.created_at)}</div>
            </div>
          )}
        />
      </Card>
      <Pager page={page} total={data?.total ?? 0} size={50} onPage={setPage} />
    </>
  );
}

// --------------------------------------------------------------------------- //
// Orders — STOs
// --------------------------------------------------------------------------- //

function OrdersTab() {
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [origin, setOrigin] = useState("");
  const [fromWh, setFromWh] = useState("");
  const [toWh, setToWh] = useState("");
  const [raised, setRaised] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Row | null>(null);
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const whOptions = useMemo(() => (warehouses as any[])
    .map((w) => ({ value: String(w.id), label: w.name })), [warehouses]);
  const reset = (fn: (v: string) => void) => (v: string) => { fn(v); setPage(1); };
  const filtersOn = [search, status, kind, origin, fromWh, toWh, raised].filter(Boolean).length;
  const [creating, setCreating] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [error, setError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["stos", kind, origin, status, search, fromWh, toWh, raised, page],
    queryFn: () => listSTOs({
      kind: kind || undefined, origin: origin || undefined, status: status || undefined,
      search: search.trim() || undefined,
      from_warehouse_id: fromWh ? Number(fromWh) : undefined,
      to_warehouse_id: toWh ? Number(toWh) : undefined,
      date_from: sinceDate(raised),
      page, size: 50,
    }),
  });

  const open = useMutation({
    mutationFn: getSTO,
    onSuccess: (d: Row) => { setSelected(d); setError(""); setRejectNote(""); },
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not open that order"),
  });

  // `?review=<id>` — the approvals inbox and notifications deep-link an STO here.
  const review = params.get("review");
  useEffect(() => {
    if (review) open.mutate(Number(review));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  const refresh = (d?: Row) => {
    qc.invalidateQueries({ queryKey: ["stos"] });
    if (d) setSelected(d);
  };
  const approve = useMutation({
    mutationFn: (id: number) => approveSTO(id),
    onSuccess: (d: Row) => {
      refresh(d);
      toast.success(d.issue_no
        ? `Approved — material issue ${d.issue_no} drafted` : "Approved");
    },
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not approve"),
  });
  const reject = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => rejectSTO(id, note),
    onSuccess: (d: Row) => refresh(d),
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not reject"),
  });

  const rows: Row[] = data?.items ?? [];
  const tile = (code: string) => rows.filter((r) => (r.stage ?? r.status) === code).length;

  const columns: Column<Row>[] = [
    { key: "sto_no", header: "STO No",
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{r.sto_no}</div>
          <div className="text-[11px] text-muted">
            {r.doc_kind === "SMO" ? "Bin movement" : r.str_no ? `Against ${r.str_no}` : "Direct"}
          </div>
        </div>
      ) },
    { key: "route", header: "Route",
      render: (r) => (
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate text-body">{r.from_warehouse_name}</span>
          <ArrowRight size={14} className="shrink-0 text-muted" />
          <span className="truncate text-body">{r.to_warehouse_name}</span>
        </div>
      ) },
    { key: "stage", header: "Stage",
      render: (r) => <StatusPill status={r.stage ?? r.status} label={STAGE_LABEL[r.stage ?? r.status]} /> },
    { key: "issue_no", header: "Material issue", hideOnNarrow: true,
      render: (r) => r.issue_id ? (
        <button type="button" className="font-mono text-xs text-brand hover:underline"
                onClick={(e) => { e.stopPropagation(); nav(`/inventory/transfers/issues/${r.issue_id}`); }}>
          {r.issue_no}
        </button>
      ) : "—" },
    { key: "requested_by_name", header: "Raised by", hideOnNarrow: true,
      render: (r) => r.requested_by_name ?? "—" },
    { key: "created_at", header: "Raised on", hideOnNarrow: true, render: (r) => fmtDate(r.created_at) },
  ];

  const closeSheet = () => {
    setSelected(null);
    if (review) {
      const next = new URLSearchParams(params);
      next.delete("review");
      setParams(next, { replace: true });
    }
  };

  return (
    <>
      <KpiTiles label="Order stages" className="mb-4" tiles={([
        ["PENDING_APPROVAL", "Awaiting approval", Clock, "warn"],
        ["TO_ISSUE", "To issue", PackageCheck, "brand"],
        ["IN_TRANSIT", "In transit", Truck, "brand"],
        ["RECEIVED", "Received", PackageCheck, "ok"],
      ] as const).map(([code, label, icon, tone]) => ({
        key: code, label, value: tile(code), icon,
        tone: tile(code) ? tone : "neutral",
        active: status === code,
        // Only the stored statuses filter server-side; a stage is read off the issue.
        onPress: code === "PENDING_APPROVAL"
          ? () => setStatus((on) => (on === code ? "" : code)) : undefined,
      })) satisfies KpiTileSpec[]} />

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search STO, STR, issue or point…"
        onClear={() => {
          setSearch(""); setStatus(""); setKind(""); setOrigin(""); setFromWh(""); setToWh("");
          setRaised(""); setPage(1);
        }}
        active={filtersOn}
      >
        <FilterMenu label="Type" value={kind} onChange={reset(setKind)} options={KIND_OPTIONS} />
        <FilterMenu label="Status" value={status} onChange={reset(setStatus)}
                    options={STO_STATUS_OPTIONS} />
        <FilterMenu label="Source" value={origin} onChange={reset(setOrigin)}
                    options={ORIGIN_OPTIONS} />
        <FilterMenu label="From" value={fromWh} onChange={reset(setFromWh)} options={whOptions}
                    icon={<MapPin className="h-4 w-4 opacity-70" />} />
        <FilterMenu label="To" value={toWh} onChange={reset(setToWh)} options={whOptions}
                    icon={<MapPin className="h-4 w-4 opacity-70" />} />
        <FilterMenu label="Raised" value={raised} onChange={reset(setRaised)}
                    options={DATE_OPTIONS} icon={<Calendar className="h-4 w-4 opacity-70" />} />
        <Can do="stock.transfer">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New STO
          </Button>
        </Can>
      </FilterBar>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => open.mutate(r.id)}
          empty={filtersOn ? "No orders match these filters." : "No transfer orders yet."}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-ink">{r.sto_no}</span>
                <StatusPill status={r.stage ?? r.status} label={STAGE_LABEL[r.stage ?? r.status]} />
              </div>
              <div className="text-sm text-body">{r.from_warehouse_name} → {r.to_warehouse_name}</div>
              <div className="text-xs text-muted">
                {r.str_no ? `Against ${r.str_no}` : "Direct"} · {fmtDate(r.created_at)}
              </div>
            </div>
          )}
        />
      </Card>
      <Pager page={page} total={data?.total ?? 0} size={50} onPage={setPage} />

      <DetailSheet
        open={!!selected}
        onClose={closeSheet}
        title={selected?.sto_no ?? ""}
        subtitle={selected ? `${selected.from_warehouse_name} → ${selected.to_warehouse_name}` : undefined}
        badge={selected && <StatusPill status={selected.stage ?? selected.status}
                                       label={STAGE_LABEL[selected.stage ?? selected.status]} />}
        footer={
          <div className="flex flex-wrap gap-2">
            {selected?.status === "PENDING_APPROVAL" && (
              <Can do="stock.transfer.approve">
                <Button variant="primary" disabled={approve.isPending}
                        onClick={() => approve.mutate(selected.id)}>Approve</Button>
                <Button variant="danger" disabled={!rejectNote.trim() || reject.isPending}
                        onClick={() => reject.mutate({ id: selected.id, note: rejectNote })}>
                  Reject
                </Button>
              </Can>
            )}
            {selected?.issue_id && (
              <Button variant="secondary"
                      onClick={() => nav(`/inventory/transfers/issues/${selected.issue_id}`)}>
                Open material issue
              </Button>
            )}
            {selected?.stage === "ISSUED" && selected.issue_id && (
              <Can do="qc_outward.create">
                <Button variant="secondary"
                        onClick={() => nav(`/inventory/transfers/qc/new?issue_id=${selected.issue_id}`)}>
                  Outward QC
                </Button>
              </Can>
            )}
            {selected?.stage === "ISSUED" && (
              <Can do="dispatch.create">
                <Button variant="secondary" onClick={() => nav("/logistics/consignments/new")}>
                  Raise consignment
                </Button>
              </Can>
            )}
            <Button variant="subtle" onClick={closeSheet}>Close</Button>
          </div>
        }
      >
        {selected && (
          <>
            <SheetSection title="Progress">
              <SheetRow label="Against STR" value={selected.str_no ?? "Raised directly"} />
              <SheetRow label="Material issue"
                        value={selected.issue_no ? `${selected.issue_no} (${selected.issue_status ?? "—"})` : null} />
              <SheetRow label="Raised by" value={selected.requested_by_name} />
              <SheetRow label="Raised on" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : null} />
              <SheetRow label="Approved by" value={selected.approved_by_name} />
              <SheetRow label="Remarks" value={selected.remarks} />
            </SheetSection>
            {selected.status === "PENDING_APPROVAL" && can("stock.transfer.approve") && (
              <SheetSection title="Reject">
                <Input value={rejectNote} onChange={(e: any) => setRejectNote(e.target?.value ?? e)}
                       placeholder="Reason, required to reject" />
              </SheetSection>
            )}
            <SheetSection title={`Items (${selected.items?.length ?? 0})`}>
              <div className="space-y-2">
                {(selected.items ?? []).map((it: Row) => (
                  <div key={it.id} className="rounded-lg border border-line/70 p-3">
                    <div className="font-medium text-ink">{it.item_name}</div>
                    <div className="font-mono text-[11px] text-muted">{it.item_code}</div>
                    <div className="mt-2 text-sm">
                      Ordered <strong>{it.requested_qty}</strong>{" "}
                      <span className="text-[11px] text-muted">{it.uom_code}</span>
                    </div>
                  </div>
                ))}
              </div>
            </SheetSection>
          </>
        )}
      </DetailSheet>

      {creating && (
        <NewStoSheet
          onClose={() => setCreating(false)}
          onCreated={(d) => { setCreating(false); refresh(d); }}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------------- //
// A direct STO — no STR behind it. The source is a point this login holds (the
// server refuses any other), and the lines are what that point actually has.
// --------------------------------------------------------------------------- //

type Line = { item_id: string; qty: string };

function NewStoSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (d: Row) => void }) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<Line[]>([{ item_id: "", qty: "" }]);
  const [error, setError] = useState("");

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const { data: destinations = [] } = useQuery({ queryKey: ["warehouses", "all-points"], queryFn: getAllWarehouses });
  const stock = useQuery({
    queryKey: ["stock-transfer", "source-stock", fromId],
    queryFn: () => getStockBalances({ warehouse_id: Number(fromId), size: 500 } as any),
    enabled: !!fromId,
  });

  // One option per item, with what is free to send across every bin and batch.
  const itemOptions = useMemo(() => {
    const free = new Map<number, { label: string; qty: number; uom: string }>();
    (stock.data?.items ?? []).forEach((s: any) => {
      const cur = free.get(s.item_id);
      const qty = Number(s.available_qty ?? 0);
      if (cur) cur.qty += qty;
      else free.set(s.item_id, { label: `${s.item_code} — ${s.item_name}`, qty, uom: s.uom_code });
    });
    return [...free].filter(([, v]) => v.qty > 0).map(([id, v]) => ({
      value: String(id), label: `${v.label} (${v.qty} ${v.uom} free here)`, qty: v.qty,
    }));
  }, [stock.data]);

  const whOptions = (warehouses as any[]).map((w) => ({ value: String(w.id), label: w.name }));
  const toOptions = (destinations as any[]).map((w) => ({ value: String(w.id), label: w.name }));

  const create = useMutation({
    mutationFn: () => createSTO({
      from_warehouse_id: Number(fromId),
      to_warehouse_id: Number(toId),
      remarks: remarks || null,
      items: lines.filter((l) => l.item_id && Number(l.qty) > 0)
        .map((l) => ({ item_id: Number(l.item_id), requested_qty: Number(l.qty) })),
    }),
    onSuccess: onCreated,
    onError: (e: any) => setError(e?.response?.data?.error ?? "Could not raise the transfer"),
  });

  const over = lines.some((l) => {
    const opt = itemOptions.find((o) => o.value === l.item_id);
    return opt && Number(l.qty) > opt.qty;
  });
  const valid = fromId && toId && fromId !== toId && !over
    && lines.some((l) => l.item_id && Number(l.qty) > 0);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <DetailSheet
      open
      onClose={onClose}
      title="New stock transfer order"
      subtitle="Send stock from a point you hold. Approval follows the STO ladder."
      footer={
        <div className="flex gap-2">
          <Button variant="primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            Raise STO
          </Button>
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}
      <SheetSection title="Route">
        <div className="space-y-3">
          <Field label="From (your point)">
            <Select ariaLabel="From" value={fromId} options={whOptions}
                    onChange={(v) => { setFromId(v || ""); setLines([{ item_id: "", qty: "" }]); }} />
          </Field>
          <Field label="To">
            <Select ariaLabel="To" value={toId} options={toOptions.filter((o) => o.value !== fromId)}
                    onChange={(v) => setToId(v || "")} />
          </Field>
          <Field label="Remarks">
            <Input value={remarks} onChange={(e: any) => setRemarks(e.target?.value ?? e)} />
          </Field>
        </div>
      </SheetSection>
      <SheetSection title="Items">
        {!fromId ? (
          <p className="text-sm text-muted">Pick the source point first — the list is what it holds.</p>
        ) : !stock.isLoading && itemOptions.length === 0 ? (
          <p className="text-sm text-muted">Nothing free to send at this point.</p>
        ) : (
          <div className="space-y-3">
            {lines.map((l, i) => {
              const opt = itemOptions.find((o) => o.value === l.item_id);
              return (
                <div key={i} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="Item">
                      <Select ariaLabel="Item" value={l.item_id}
                              options={itemOptions.filter((o) => o.value === l.item_id
                                || !lines.some((x) => x.item_id === o.value))}
                              onChange={(v) => setLine(i, { item_id: v || "" })} />
                    </Field>
                  </div>
                  <div className="w-28">
                    <Field label="Qty">
                      <Input type="number" value={l.qty}
                             onChange={(e: any) => setLine(i, { qty: e.target?.value ?? e })} />
                    </Field>
                    {opt && Number(l.qty) > opt.qty && (
                      <p className="text-[11px] text-bad">Only {opt.qty} free</p>
                    )}
                  </div>
                  <Button variant="subtle" aria-label="Remove line"
                          onClick={() => setLines((cur) => cur.length > 1 ? cur.filter((_, j) => j !== i) : cur)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            <Button variant="secondary" onClick={() => setLines((cur) => [...cur, { item_id: "", qty: "" }])}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
          </div>
        )}
      </SheetSection>
    </DetailSheet>
  );
}

function Pager({ page, total, size, onPage }: {
  page: number; total: number; size: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm text-muted">
      <Button variant="subtle" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button variant="subtle" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}
