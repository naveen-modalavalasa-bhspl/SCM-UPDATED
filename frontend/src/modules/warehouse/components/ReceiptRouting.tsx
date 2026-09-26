import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Boxes, ClipboardCheck, PackageCheck, Split } from "lucide-react";
import { Button, Can, Card, StatusPill } from "@/shared/components";
import { fmtQty } from "../format";
import type { ReceiptRouteLine, ReceiptRouting } from "../types";

/**
 * Where a GRN's lines go: a QC draft for the items whose master says "Requires QI",
 * straight to putaway (or stock, on a point with no bins) for the rest.
 *
 * Before submit it is a FORECAST, drawn dashed, so the storekeeper sees what the press
 * will do before pressing it. After submit it is the RECORD, and every document the
 * split raised is one tap away. The routing and every sentence on it come from
 * `GET /receipts/{id}/routing`; this screen decides nothing.
 */

type Tone = "info" | "ok";

const TONE: Record<Tone, { icon: string; rail: string; chip: string }> = {
  info: { icon: "bg-info-bg text-info", rail: "bg-info", chip: "bg-info-bg text-info" },
  ok: { icon: "bg-ok-bg text-ok", rail: "bg-ok", chip: "bg-ok-bg text-ok" },
};

function Lane({
  tone, icon, title, caption, count, forecast, action, children,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  caption: string;
  count: number;
  forecast: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div
      className={`relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-chrome-strong ${
        forecast ? "border-dashed border-line" : "border-line"
      }`}
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${t.rail} ${forecast ? "opacity-40" : ""}`} />
      <div className="flex items-start gap-3 px-4 pt-4 pb-3 pl-5">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${t.icon}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-sm font-bold text-ink">{title}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular ${t.chip}`}>
              {count} {count === 1 ? "item" : "items"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">{caption}</p>
        </div>
      </div>
      {action && <div className="px-4 pb-3 pl-5">{action}</div>}
      <div className="flex-1 border-t border-line">{children}</div>
    </div>
  );
}

function LineRow({ line, trailing }: { line: ReceiptRouteLine; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2 pl-5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{line.item_name || line.item_code}</div>
        <div className="truncate font-mono text-[11px] text-muted">{line.item_code}</div>
      </div>
      <div className="shrink-0 text-right text-sm tabular text-ink">
        {fmtQty(line.received_qty)}
        <span className="ml-1 text-[11px] text-muted">{line.uom_code}</span>
      </div>
      {trailing}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 pl-5 text-center text-xs text-muted">{children}</div>;
}

export function ReceiptRoutingPanel({
  routing,
  onRoute,
  routing_busy,
}: {
  routing: ReceiptRouting;
  /** Offered only on a GRN the retired approval parked at SUBMITTED. */
  onRoute?: () => void;
  routing_busy?: boolean;
}) {
  const nav = useNavigate();
  const forecast = routing.stage !== "ROUTED";
  const direct = routing.is_bin_managed ? "Putaway" : "Straight to stock";
  const total = routing.qc_lines.length + routing.direct_lines.length;
  if (total === 0) return null;

  const donePct = routing.putaway_total
    ? Math.round((routing.putaway_done / routing.putaway_total) * 100)
    : 0;

  return (
    <Card className="mb-4 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-bg text-neutral">
            <Split className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-base font-bold text-ink">Where this delivery goes</h2>
              {forecast && (
                <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                  {routing.stage === "PARKED" ? "Not split yet" : "Preview · on submit"}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-body">{routing.headline}</p>
          </div>
        </div>
        {routing.stage === "PARKED" && onRoute && (
          <Can do="receipt.create">
            <Button onClick={onRoute} disabled={routing_busy}>
              <Split className="h-4 w-4" />
              {routing_busy ? "Splitting…" : "Split into QC & putaway"}
            </Button>
          </Can>
        )}
      </div>

      {/* GRN ─┬─ QC  /  └─ Putaway : the fork, stated once above the two lanes. */}
      <div className="mb-3 hidden items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted md:flex">
        <span className="font-mono normal-case tracking-normal text-ink">{routing.grn_no}</span>
        <ArrowRight className="h-3.5 w-3.5" />
        <span>split by the item master's "Requires QI"</span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Lane
          tone="info"
          icon={<ClipboardCheck className="h-5 w-5" />}
          title="Quality check"
          caption={
            forecast
              ? "A QC draft is raised for these on submit."
              : "Inspect these before they can be put away."
          }
          count={routing.qc_lines.length}
          forecast={forecast}
          action={
            !forecast && routing.inspection_id ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{routing.inspection_no}</span>
                {routing.inspection_status && <StatusPill status={routing.inspection_status} />}
                <Can do="inspection.view">
                  <Button
                    variant="soft"
                    className="ml-auto"
                    onClick={() => nav(`/warehouse/quality-inspection/${routing.inspection_id}`)}
                  >
                    {routing.inspection_status === "COMPLETED" ? "View QC" : "Open QC"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Can>
              </div>
            ) : undefined
          }
        >
          {routing.qc_lines.length === 0 ? (
            <Empty>No item on this GRN requires inspection.</Empty>
          ) : (
            routing.qc_lines.map((l) => (
              <LineRow
                key={l.receipt_item_id}
                line={l}
                trailing={!forecast && l.qc_status && l.qc_status !== "PENDING"
                  ? <StatusPill status={l.qc_status} />
                  : undefined}
              />
            ))
          )}
        </Lane>

        <Lane
          tone="ok"
          icon={routing.is_bin_managed ? <Boxes className="h-5 w-5" /> : <PackageCheck className="h-5 w-5" />}
          title={direct}
          caption={
            routing.is_bin_managed
              ? forecast
                ? "No QC needed. A putaway draft is raised for each on submit."
                : "No QC needed. Each has its own putaway task."
              : "No QC needed, and this point keeps no bins: banked into stock on submit."
          }
          count={routing.direct_lines.length}
          forecast={forecast}
          action={
            !forecast && routing.is_bin_managed && routing.putaway_total > 0 ? (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                  <span>Put away</span>
                  <span className="tabular">
                    {routing.putaway_done} of {routing.putaway_total} tasks
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-neutral-bg">
                  <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${donePct}%` }} />
                </div>
              </div>
            ) : undefined
          }
        >
          {routing.direct_lines.length === 0 ? (
            <Empty>Every item on this GRN goes through QC first.</Empty>
          ) : (
            routing.direct_lines.map((l) => (
              <LineRow
                key={l.receipt_item_id}
                line={l}
                trailing={
                  l.putaway_id ? (
                    <Can do="putaway.view">
                      <button
                        type="button"
                        onClick={() => nav(`/warehouse/putaway/${l.putaway_id}`)}
                        title={`Open ${l.putaway_no}`}
                        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ok transition-colors hover:bg-ok-bg"
                      >
                        <span className="hidden font-mono sm:inline">{l.putaway_no}</span>
                        {l.putaway_status && <StatusPill status={l.putaway_status.toUpperCase()} />}
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    </Can>
                  ) : undefined
                }
              />
            ))
          )}
        </Lane>
      </div>
    </Card>
  );
}
