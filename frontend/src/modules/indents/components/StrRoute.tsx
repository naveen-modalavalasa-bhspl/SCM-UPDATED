import type { ReactNode } from "react";
import { ArrowRight, ArrowRightLeft, History, MapPin, Repeat2, UserRound, Warehouse } from "lucide-react";
import { fmtDateTime } from "@/shared/datetime";
import type { StrPoint, StrSourceChange } from "../types";

/**
 * A Stock Transfer Request's route, read at a glance (2026-11-04): where the stock
 * comes FROM, where it goes TO, and every time an approver moved the source.
 *
 * Shared by the STR detail page and the approval screen, so the two never describe
 * the same route in different words. The tier and "held by" are served — nothing here
 * decides what kind of point a point is.
 */

type Tone = "from" | "to";

const TONE: Record<Tone, { ring: string; chip: string; icon: string; label: string }> = {
  from: {
    ring: "border-brand/30 bg-brand-050/40",
    chip: "bg-brand/10 text-brand",
    icon: "bg-brand text-white",
    label: "From · source",
  },
  to: {
    ring: "border-ok/30 bg-ok-bg/50",
    chip: "bg-ok/10 text-ok",
    icon: "bg-ok text-white",
    label: "To · destination",
  },
};

/** One end of the route. */
export function PointTile({
  point, tone, empty, badge,
}: {
  point?: StrPoint | null;
  tone: Tone;
  empty?: string;
  badge?: ReactNode;
}) {
  const skin = TONE[tone];
  const Icon = tone === "from" ? Warehouse : MapPin;
  return (
    <div className={`min-w-0 rounded-2xl border p-3.5 ${skin.ring}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{skin.label}</span>
        {badge}
      </div>
      {point?.warehouse_name ? (
        <div className="mt-2 flex items-start gap-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${skin.icon}`}>
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-display text-[15px] font-bold leading-snug text-ink" title={point.warehouse_name}>
              {point.warehouse_name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {point.warehouse_code && (
                <span className="font-mono text-[11px] text-muted">{point.warehouse_code}</span>
              )}
              {point.tier_label && (
                <span className={`rounded-full px-2 py-px text-[10px] font-semibold ${skin.chip}`}>
                  {point.tier_label}
                </span>
              )}
            </div>
            {!!point.held_by?.length && (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-body">
                <UserRound className="mt-px h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0">{point.held_by.join(", ")}</span>
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty ?? "Not on record"}</p>
      )}
    </div>
  );
}

/** Source → destination, with the arrow between them. */
export function RouteLine({
  source, destination, sourceBadge,
}: {
  source?: StrPoint | null;
  destination?: StrPoint | null;
  sourceBadge?: ReactNode;
}) {
  return (
    <div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-3">
      <PointTile point={source} tone="from" empty="No source chosen" badge={sourceBadge} />
      <div className="flex items-center justify-center" aria-hidden>
        <span className="grid h-9 w-9 rotate-90 place-items-center rounded-full border border-line bg-content1 text-muted shadow-sm sm:rotate-0">
          <ArrowRight className="h-4 w-4" />
        </span>
      </div>
      <PointTile point={destination} tone="to" empty="Delivery point not on record" />
    </div>
  );
}

/** Every move of the source, oldest first. */
export function SourceChangeList({ changes }: { changes?: StrSourceChange[] }) {
  if (!changes?.length) return null;
  return (
    <div className="rounded-xl border border-warn/30 bg-warn-bg/40 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
        <History className="h-3.5 w-3.5" aria-hidden />
        Source changed {changes.length === 1 ? "once" : `${changes.length} times`} during approval
      </p>
      <ol className="mt-2 space-y-2">
        {changes.map((change) => (
          <li key={change.id} className="flex gap-2.5 text-xs">
            <Repeat2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
            <div className="min-w-0">
              <p className="text-ink">
                <span className="text-muted line-through">{change.from_warehouse_name ?? "No source"}</span>
                {" → "}
                <b className="font-semibold">{change.to_warehouse_name}</b>
              </p>
              <p className="text-muted">
                {change.changed_by_name ?? "An approver"}
                {change.stage_name ? ` · ${change.stage_name}` : change.position_name ? ` · ${change.position_name}` : ""}
                {" · "}{fmtDateTime(change.created_at)}
              </p>
              {change.reason && <p className="mt-0.5 italic text-body">“{change.reason}”</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The whole card, as the STR detail page shows it. */
export function StrRouteCard({
  source, destination, changes,
}: {
  source?: StrPoint | null;
  destination?: StrPoint | null;
  changes?: StrSourceChange[];
}) {
  return (
    <section aria-label="Transfer route" className="mb-5 rounded-2xl border border-line bg-content1 p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-050 text-brand">
          <ArrowRightLeft className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="font-display text-[15px] font-bold leading-tight text-ink">Transfer route</h2>
          <p className="text-xs text-muted">Where this stock comes from and where it is delivered.</p>
        </div>
      </div>
      <RouteLine source={source} destination={destination} />
      {!!changes?.length && <div className="mt-3"><SourceChangeList changes={changes} /></div>}
    </section>
  );
}
