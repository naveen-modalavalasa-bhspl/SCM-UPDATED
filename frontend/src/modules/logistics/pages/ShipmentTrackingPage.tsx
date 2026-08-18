import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Send } from "lucide-react";
import {
  Button, Can, Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatCard,
  StatusPill, useAction, type Column,
} from "@/shared/components";
import { fmtDate, fmtRelative, todayIst } from "@/shared/datetime";
import { transportApi } from "../api";
import { modeLabel, modeTint } from "../components/modeCopy";
import type { TRListRow } from "../transportTypes";

const SIZE = 20;

/** What Logistics still owns after the gate.
 *
 * IN_TRANSIT and DELIVERED were always here. ACKNOWLEDGED is here because the
 * Acknowledgements tab has left the module: signing is the indent raiser's act and
 * their screen carries it, but CLOSING the shipment is still this desk's, and a signed
 * transport request that appears on no logistics screen is one nobody closes. The
 * board therefore runs from the moment it leaves to the moment it can be shut.
 *
 * Nothing before dispatch belongs here — that is Provider Selection's and Dispatch's
 * work — and nothing after CLOSED, which is the register's. */
const VIEWS = [
  {
    key: "active",
    label: "All open",
    status: "IN_TRANSIT,DELIVERED,ACKNOWLEDGED",
    empty: "Nothing on the road and nothing waiting to be closed.",
  },
  {
    key: "moving",
    label: "On the road",
    status: "IN_TRANSIT",
    empty: "Nothing in transit.",
  },
  {
    key: "landed",
    label: "Delivered",
    status: "DELIVERED",
    empty: "Nothing delivered and unsigned.",
  },
  {
    key: "signed",
    label: "Signed, not closed",
    status: "ACKNOWLEDGED",
    empty: "Nothing signed and waiting to be closed.",
  },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

/** Days late against the needed-by date. Only a shipment that has not landed can be
 *  late: once it is delivered the date it was wanted is history, not an alarm. */
function daysLate(row: TRListRow): number {
  if (row.status !== "IN_TRANSIT" || !row.expected_delivery) return 0;
  const due = new Date(`${row.expected_delivery.slice(0, 10)}T00:00:00`).getTime();
  const today = new Date(`${todayIst()}T00:00:00`).getTime();
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

/**
 * What is on the road, and what has landed but is not closed.
 *
 * "Share tracking" sits on the row rather than only on the detail screen: doc D5 is a
 * batch job — the logistics desk works down the list telling each site where its
 * material is — and making that four clicks deep guarantees it stops happening. The
 * row says when it was last shared, so the same site is not told three times.
 */
export function ShipmentTrackingPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [viewKey, setViewKey] = useState<ViewKey>("active");

  const view = VIEWS.find((v) => v.key === viewKey) ?? VIEWS[0];

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport", "tracking", viewKey, search, page],
    queryFn: () => transportApi.list({
      status: view.status,
      search: search.trim() || undefined,
      page, size: SIZE,
    }),
  });

  const share = useAction({
    run: (id: number) => transportApi.shareTracking(id),
    success: "Tracking shared with the field",
    invalidates: [["transport"]],
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const moving = rows.filter((r) => r.status === "IN_TRANSIT").length;
  const landed = rows.filter((r) => r.status === "DELIVERED").length;
  const signed = rows.filter((r) => r.status === "ACKNOWLEDGED").length;
  const late = rows.filter((r) => daysLate(r) > 0).length;

  const columns: Column<TRListRow>[] = [
    {
      key: "tr",
      header: "Consignment",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.tr_no}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `Indent ${r.indent_no}` : r.from_warehouse_name ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        const over = daysLate(r);
        return (
          <div className="flex flex-wrap items-center gap-1">
            <StatusPill status={r.status} />
            {over > 0 && (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                {over}d late
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "mode",
      header: "Mode",
      hideOnNarrow: true,
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modeTint(r.mode)}`}>
          {modeLabel(r.mode)}
        </span>
      ),
    },
    { key: "to", header: "Destination", render: (r) => r.to_location_name ?? "—" },
    { key: "carrier", header: "Carrier", hideOnNarrow: true, render: (r) => r.carrier_name ?? "—" },
    {
      key: "tracking",
      header: "LR / Docket",
      render: (r) => (
        <span className="font-mono text-xs">{r.lr_no ?? r.docket_no ?? "—"}</span>
      ),
    },
    {
      // What actually happened to it last, not just when it is wanted. A tracking
      // board that cannot say how long something has been moving is a list.
      key: "last",
      header: "Last move",
      hideOnNarrow: true,
      render: (r) => {
        const [label, when] = r.acknowledged_at
          ? ["Signed", r.acknowledged_at]
          : r.delivered_at
            ? ["Delivered", r.delivered_at]
            : ["Dispatched", r.dispatched_at];
        return (
          <div className="min-w-0">
            <div className="text-xs text-body">{label}</div>
            <div className="text-[11px] text-muted">{fmtRelative(when)}</div>
          </div>
        );
      },
    },
    {
      key: "due",
      header: "Due",
      hideOnNarrow: true,
      render: (r) => (
        <span className={daysLate(r) > 0 ? "font-semibold text-rose-600" : ""}>
          {fmtDate(r.expected_delivery)}
        </span>
      ),
    },
    {
      key: "act",
      header: "",
      render: (r) => (
        <Can do="transport.track">
          <div className="flex flex-col items-end gap-0.5">
            <Button
              variant="ghost"
              onClick={() => share.mutate(r.id)}
              disabled={share.isPending}
            >
              <Send size={14} className="mr-1" />
              {r.tracking_shared_at ? "Share again" : "Share tracking"}
            </Button>
            {r.tracking_shared_at && (
              <span className="flex items-center gap-1 text-[10px] text-muted">
                <CheckCircle2 size={10} className="text-emerald-600" aria-hidden />
                Sent {fmtRelative(r.tracking_shared_at)}
              </span>
            )}
          </div>
        </Can>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Shipment Tracking" />
      <p className="-mt-2 mb-4 text-sm text-muted">
        Every shipment from the gate to the day it is closed. Damage, shortage and
        delay claims sit on each shipment's own timeline — open a row to read or raise
        one.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="On the road" value={moving} />
        <StatCard
          label="Running late"
          value={late}
          tone={late ? "text-rose-600" : "text-ink"}
        />
        <StatCard label="Delivered, not signed" value={landed} />
        <StatCard label="Signed, not closed" value={signed} />
      </div>

      <ErrorBanner error={error ?? share.error} />

      <Card className="p-2">
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1">
          <div className="flex gap-1 rounded-lg bg-surface p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => { setViewKey(v.key); setPage(1); }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  v.key === viewKey
                    ? "bg-content1 text-ink shadow-sm"
                    : "text-muted hover:text-ink"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Input
              value={search}
              placeholder="TR no, LR, docket, destination…"
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
        </div>
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => nav(`/logistics/transport/${r.id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty={view.empty}
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.tr_no}</span>
                <StatusPill status={r.status} />
              </div>
              <div className="text-sm text-body">{r.to_location_name ?? "—"}</div>
              <div className="text-xs text-muted">
                {r.carrier_name ?? modeLabel(r.mode)}
                {r.lr_no || r.docket_no ? ` · ${r.lr_no ?? r.docket_no}` : ""}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span>
                  {r.acknowledged_at
                    ? `Signed ${fmtRelative(r.acknowledged_at)}`
                    : r.delivered_at
                      ? `Delivered ${fmtRelative(r.delivered_at)}`
                      : `Dispatched ${fmtRelative(r.dispatched_at)}`}
                </span>
                {daysLate(r) > 0 && (
                  <span className="rounded-full bg-rose-50 px-2 py-0.5 font-semibold text-rose-700">
                    {daysLate(r)}d late
                  </span>
                )}
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
