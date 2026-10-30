import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight, ArrowRight, CheckCircle2, Clock, PackageCheck, Truck, Warehouse,
} from "lucide-react";
import {
  Button, Card, KpiTiles, StatusPill, type KpiTileSpec,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import { indentApi } from "@/modules/indents/api";
import { ackDetailPath, issueAckDetailPath } from "@/modules/indents/ackPaths";
import type { Acknowledgement, StockTransferAck } from "@/modules/indents/types";
import { FilterBar } from "./FilterBar";
import { ErrorNote } from "./PageStates";

/**
 * Inventory > Stock Transfer > Acknowledgements (2026-10-29): EVERY transfer arriving
 * at a point this login holds — the STRs (served from the indent side) and the direct
 * STOs (their issues) — on one board, and nowhere else. A card opens the shared
 * receipt journey at Stock Transfer's own address (`ackPaths`), so a transfer never
 * walks the receiving storekeeper into Indents.
 *
 * `?id=<indent>` and `?issue=<issue>` deep-link straight into a receipt — what a
 * notification or another screen hands over.
 */
type Card =
  | { kind: "STR"; key: string; no: string; stoNos: string[]; from: string[]; to?: string | null;
      status: string; ready: boolean; consignments: string[]; carrier?: string | null;
      vehicle?: string | null; qty: number; lines: number; when?: string | null; open: string }
  | { kind: "STO"; key: string; no: string; stoNos: string[]; from: string[]; to?: string | null;
      status: string; ready: boolean; consignments: string[]; carrier?: string | null;
      vehicle?: string | null; qty: number; lines: number; when?: string | null; open: string;
      issueNo: string };

const fromStr = (row: Acknowledgement): Card => {
  const lead = row.shipments?.[0];
  return {
    kind: "STR", key: `str-${row.indent_id}`, no: row.indent_no,
    stoNos: row.sto_nos ?? [], from: row.from_warehouse_names ?? [], to: row.to_warehouse_name,
    status: row.status, ready: row.can_acknowledge,
    consignments: (row.shipments ?? []).map((s) => s.tr_no).filter(Boolean),
    carrier: lead?.carrier_name, vehicle: lead?.vehicle_number,
    qty: (row.lines ?? []).reduce((sum, l) => sum + Number(l.dispatched_quantity ?? 0), 0),
    lines: row.lines?.length ?? 0,
    when: lead?.dispatched_at ?? row.indent_date,
    open: ackDetailPath(row.indent_id, true),
  };
};

const fromSto = (row: StockTransferAck): Card => ({
  kind: "STO", key: `sto-${row.issue_id}`, no: row.sto_no ?? row.issue_no,
  stoNos: row.sto_no ? [row.sto_no] : [],
  from: [row.from_warehouse_name ?? row.warehouse_name ?? ""].filter(Boolean),
  to: row.to_warehouse_name, status: row.status, ready: row.can_acknowledge,
  consignments: (row.consignments ?? []).map((c) => c.dispatch_no),
  qty: Number(row.total_qty ?? 0), lines: row.lines?.length ?? 0,
  when: row.issue_date, open: issueAckDetailPath(row.issue_id, true), issueNo: row.issue_no,
});

export function TransferAcknowledgements() {
  const nav = useNavigate();
  const { can } = useAuth();
  // Either grant receives: the indents desk's, or the transfer-only scoped one.
  const mayReceive = can("indent.acknowledge") || can("stock.transfer.receive");
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"ready" | "all" | "done">("ready");

  // A deep link straight into one receipt.
  useEffect(() => {
    const indentId = Number(params.get("id") || 0);
    const issueId = Number(params.get("issue") || 0);
    if (indentId) nav(ackDetailPath(indentId, true), { replace: true });
    else if (issueId) nav(issueAckDetailPath(issueId, true), { replace: true });
  }, [params, nav]);

  const strs = useQuery({
    queryKey: ["transfer-acks", "str", search],
    queryFn: () => indentApi.myAcknowledgements({ search: search || undefined, indent_type: ["STR"] }),
  });
  const stos = useQuery({
    queryKey: ["transfer-acks", "sto", search],
    queryFn: () => indentApi.myStockTransferAcks({ search: search || undefined }),
  });

  const cards = useMemo(() => [
    ...(strs.data ?? []).map(fromStr),
    ...(stos.data ?? []).map(fromSto),
  ], [strs.data, stos.data]);
  const done = (c: Card) => ["ACKNOWLEDGED", "RECEIVED", "CLOSED"].includes(c.status);
  const counts = {
    ready: cards.filter((c) => c.ready).length,
    road: cards.filter((c) => !c.ready && !done(c)).length,
    done: cards.filter(done).length,
  };
  const shown = cards.filter((c) => filter === "all" ? true
    : filter === "ready" ? c.ready : done(c));
  const loading = strs.isLoading || stos.isLoading;
  const error = (strs.error || stos.error) as any;

  return (
    <div>
      <KpiTiles label="Incoming transfers" className="mb-4" tiles={[
        { key: "ready", label: "Awaiting your receipt", icon: PackageCheck,
          value: loading ? undefined : counts.ready, tone: counts.ready ? "warn" : "neutral",
          active: filter === "ready", onPress: () => setFilter("ready") },
        { key: "road", label: "On the way", icon: Truck,
          value: loading ? undefined : counts.road, tone: counts.road ? "brand" : "neutral",
          active: false, onPress: () => setFilter("all") },
        { key: "done", label: "Received", icon: CheckCircle2,
          value: loading ? undefined : counts.done, tone: counts.done ? "ok" : "neutral",
          active: filter === "done", onPress: () => setFilter("done") },
      ] satisfies KpiTileSpec[]} />

      {error && (
        <div className="mb-3">
          <ErrorNote message={error?.response?.data?.error ?? "Could not load incoming transfers"} />
        </div>
      )}

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search STR, STO, issue or item…"
        onClear={() => { setSearch(""); setFilter("ready"); }}
      >
        <div role="tablist" aria-label="Which transfers" className="inline-flex rounded-xl border border-line bg-content1 p-1">
          {([["ready", "Ready to receive"], ["all", "All"], ["done", "Received"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key}
                    onClick={() => setFilter(key)}
                    className={`min-h-9 rounded-lg px-3 text-sm font-semibold transition-colors ${
                      filter === key ? "bg-brand text-white shadow-sm" : "text-muted hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
      </FilterBar>

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((k) => <div key={k} className="h-44 animate-pulse rounded-2xl bg-content2" />)}
        </div>
      ) : shown.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
            <ArrowLeftRight className="h-6 w-6" aria-hidden />
          </span>
          <p className="font-semibold text-ink">
            {filter === "ready" ? "Nothing waiting for your receipt" : "No transfers here"}
          </p>
          <p className="max-w-md text-sm text-muted">
            Stock transfers bound for a point you hold — STRs and direct STOs — appear here
            the moment they leave the sending point.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((c) => (
            <article key={c.key}
                     className={`group flex flex-col overflow-hidden rounded-2xl border bg-content1 shadow-sm transition hover:shadow-md ${
                       c.ready ? "border-brand/40" : "border-line"}`}>
              <header className="flex flex-wrap items-center gap-2 border-b border-line/70 bg-gradient-to-r from-content2/70 to-content1 px-4 py-3">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  c.kind === "STR" ? "bg-info-bg text-info" : "bg-brand/10 text-brand"}`}>
                  {c.kind === "STR" ? <ArrowLeftRight className="h-3 w-3" aria-hidden />
                    : <Truck className="h-3 w-3" aria-hidden />}
                  {c.kind === "STR" ? "STR" : "Direct STO"}
                </span>
                <span className="min-w-0 truncate font-mono text-sm font-bold text-ink">{c.no}</span>
                <span className="ml-auto"><StatusPill status={c.status} /></span>
              </header>

              <div className="flex-1 space-y-3 px-4 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <Warehouse className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink"
                        title={c.from.join(", ")}>
                    {c.from.length ? c.from.join(", ") : "—"}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-right font-semibold text-ink"
                        title={c.to ?? undefined}>
                    {c.to ?? "Your point"}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {c.kind === "STR" && c.stoNos.length > 0 && (
                    <>
                      <dt className="text-muted">Transfer order</dt>
                      <dd className="truncate text-right font-mono font-semibold text-ink">{c.stoNos.join(", ")}</dd>
                    </>
                  )}
                  {c.kind === "STO" && (
                    <>
                      <dt className="text-muted">Material issue</dt>
                      <dd className="truncate text-right font-mono font-semibold text-ink">{c.issueNo}</dd>
                    </>
                  )}
                  <dt className="text-muted">Consignment</dt>
                  <dd className="truncate text-right font-mono text-ink">
                    {c.consignments.length ? c.consignments.join(", ") : "Handed over"}
                  </dd>
                  {(c.carrier || c.vehicle) && (
                    <>
                      <dt className="text-muted">Carrier / vehicle</dt>
                      <dd className="truncate text-right text-ink">
                        {[c.carrier, c.vehicle].filter(Boolean).join(" · ")}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">Load</dt>
                  <dd className="text-right text-ink">
                    <span className="tabular font-semibold">{c.lines}</span> line{c.lines === 1 ? "" : "s"}
                    {c.qty > 0 && <> · <span className="tabular font-semibold">{c.qty}</span> units</>}
                  </dd>
                  {c.when && (
                    <>
                      <dt className="text-muted">Sent</dt>
                      <dd className="text-right text-ink">
                        <Clock className="mr-1 inline h-3 w-3 text-muted" aria-hidden />{fmtDate(c.when)}
                      </dd>
                    </>
                  )}
                </dl>
              </div>

              <footer className="flex items-center justify-end gap-2 border-t border-line/70 px-4 py-3">
                {c.ready && mayReceive ? (
                  <Button variant="primary" onClick={() => nav(c.open)}>
                    <PackageCheck className="h-4 w-4" /> Acknowledge receipt &amp; post to stock
                  </Button>
                ) : (
                  <Button variant="subtle" onClick={() => nav(c.open)}>
                    View receipt <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
