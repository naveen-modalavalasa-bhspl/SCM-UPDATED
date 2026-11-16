import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft, Check, CheckCircle2, ChevronRight, CircleSlash, Forward, MapPinned,
  PackageCheck, ShieldCheck, ShieldOff, TriangleAlert,
} from "lucide-react";
import { Button, Card, ConfirmModal } from "@/shared/components";
import { TONE_APPROVE } from "@/shared/components/tones";
import { RouteLine, SourceChangeList } from "@/modules/indents/components/StrRoute";
import { displayUom } from "@/modules/indents/displayFormat";
import { approvalsApi } from "../api";
import { formatQuantity } from "../quantityRules";
import { FORWARD_LABEL, NO_NEXT_LEVEL_HELP, strDecision } from "../strDecision";
import type { IssueFromStockResult, StrLevel, StrReviewOption, StrSourceReview } from "../types";

interface LineInfo { name: string; unit: string }

/** The frozen ladder at a glance: who has signed, who is signing, who is still to come. */
function LevelRail({ levels }: { levels: StrLevel[] }) {
  if (levels.length < 2) return null;
  return (
    <ol aria-label="Approval levels" className="flex flex-wrap items-center gap-1">
      {levels.map((level, index) => {
        const done = level.state === "DONE";
        const current = level.state === "CURRENT";
        return (
          <li key={level.sequence} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />}
            <span
              aria-current={current ? "step" : undefined}
              title={level.position_name ?? undefined}
              className={`inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold ${
                current ? "bg-brand text-white" : done ? "bg-ok-bg text-ok" : "bg-content2 text-muted"}`}
            >
              {done && <Check className="h-3 w-3" aria-hidden />}
              {level.role_name ?? level.position_name ?? `Level ${level.sequence}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What the levels below have allocated, and whether it is holding stock yet. */
function AllocatedList({ review }: { review: StrSourceReview }) {
  if (!review.allocated.length) return null;
  return (
    <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line/70 bg-content1">
      {review.allocated.map((row, index) => (
        <li key={`${row.allocation_no}-${index}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs">
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{row.item_name}</span>
            <span className="block truncate text-muted">
              {row.warehouse_name ?? "—"}{row.allocated_by_name ? ` · by ${row.allocated_by_name}` : ""}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-semibold tabular-nums text-ink">
              {formatQuantity(row.quantity)} {displayUom(row.uom_code)}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              row.signed ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
              {row.signed ? "Stock reserved" : "Awaiting its approver"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The STR's source, judged against THIS approver's scope.
 *
 * Every level signs an STR (2026-11-05), so this answers three questions in order: is
 * anything left to serve, is the source mine to give, and is there a level above me?
 * "Last" means the configured ladder ends here, and the panel then asks for the missing
 * level instead of pretending the request has somewhere to go. Every number on this
 * card is served (`/str-source`); the quantities are the ones signed in the table below.
 */
export function StrSourcePanel({
  indentId, lines, signed, ready, blocker, onForward, onForwarded, onAllocated,
}: {
  indentId: number;
  lines: Record<number, LineInfo>;
  /** The approver's whole-line quantities: what is allocated plus what they are signing. */
  signed: { line_id: number; approved_quantity: number }[];
  /** Quantities valid and the checklist done: the same gate as Approve. */
  ready: boolean;
  blocker?: string | null;
  onForward: () => void;
  /** The source was moved and the request sent on, so it has left this approver. */
  onForwarded: () => void;
  onAllocated: (result: IssueFromStockResult) => void;
}) {
  const review = useQuery({
    queryKey: ["approvals", "str-source", indentId],
    queryFn: () => approvalsApi.strSource(indentId),
    enabled: Number.isFinite(indentId) && indentId > 0,
  });
  const [confirmSource, setConfirmSource] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [thenForward, setThenForward] = useState(false);

  const allocate = useMutation({
    mutationFn: (moveTo: number | null) => approvalsApi.strAllocate(indentId, {
      source_warehouse_id: moveTo,
      reason: moveTo ? reason.trim() : "",
      items: signed,
    }),
    onSuccess: (result) => {
      setConfirmSource(false);
      setPicking(false);
      onAllocated(result);
    },
  });
  const forward = useMutation({
    mutationFn: (moveTo: number) => approvalsApi.strForward(indentId, {
      source_warehouse_id: moveTo, reason: reason.trim(), items: signed,
    }),
    onSuccess: () => {
      setPicking(false);
      onForwarded();
    },
  });
  const moving = allocate.isPending || forward.isPending;

  const data = review.data;
  const sourceName = data?.source?.warehouse_name ?? "the source";
  const signedBy = useMemo(() => new Map(signed.map((s) => [s.line_id, s.approved_quantity])), [signed]);
  /** What a press would allocate per line from a point: owed and free, whichever is least. */
  const planFrom = (freeOf: (lineId: number) => number) =>
    (data?.source_lines ?? []).map((line) => {
      const cap = Math.min(line.owed_quantity, signedBy.get(line.line_id) ?? line.owed_quantity);
      const give = Math.max(0, Math.min(cap, freeOf(line.line_id)));
      return { ...line, cap, give };
    });
  const sourcePlan = planFrom((id) => data?.source_lines.find((l) => l.line_id === id)?.free_quantity ?? 0);
  const sourceGives = sourcePlan.filter((l) => l.give > 0).length;
  const coversAll = sourcePlan.every((l) => l.give >= l.cap);
  const chosen: StrReviewOption | undefined = data?.my_points.find((p) => p.warehouse_id === pick);
  const chosenPlan = chosen
    ? planFrom((id) => chosen.lines.find((l) => l.line_id === id)?.free_quantity ?? 0) : [];

  if (review.isLoading) {
    return (
      <div role="status" className="h-40 animate-pulse rounded-2xl bg-content2">
        <span className="sr-only">Loading the transfer source…</span>
      </div>
    );
  }
  if (review.error || !data) return null;

  const decision = strDecision(data);
  const inScope = data.in_scope;
  const last = data.is_last_level === true;
  const served = data.fully_served;
  const noNextLevel = !decision.canApprove;
  const nextName = data.next_level?.role_name ?? data.next_level?.position_name;
  const chip = inScope ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ok">
      <ShieldCheck className="h-3 w-3" aria-hidden /> In your scope
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
      <ShieldOff className="h-3 w-3" aria-hidden /> Outside your scope
    </span>
  );

  const PlanList = ({ plan }: { plan: typeof sourcePlan }) => (
    <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line/70 bg-content1">
      {plan.map((line) => {
        const info = lines[line.line_id];
        const full = line.give >= line.cap && line.cap > 0;
        return (
          <li key={line.line_id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <span className="min-w-0 truncate font-medium text-ink">{info?.name ?? `Line ${line.line_id}`}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 font-semibold tabular-nums ${
              full ? "bg-ok-bg text-ok" : line.give > 0 ? "bg-warn-bg text-warn" : "bg-content2 text-muted"}`}>
              {line.give > 0
                ? `${formatQuantity(line.give)} of ${formatQuantity(line.cap)} ${info?.unit ?? ""}`
                : `none free · ${formatQuantity(line.cap)} ${info?.unit ?? ""} owed`}
            </span>
          </li>
        );
      })}
    </ul>
  );

  // Taking the request onto your own point is useful whenever the source cannot serve
  // it from here: it is not yours, or it does not hold everything that is owed.
  const offerMove = !served && data.my_points.length > 0 && (!inScope || sourceGives < sourcePlan.length);
  const openMove = () => {
    allocate.reset();
    forward.reset();
    setPick(data.my_points[0]?.warehouse_id ?? null);
    setReason("");
    setThenForward(false);
    setPicking(true);
  };
  const barTone = served ? "bg-ok" : noNextLevel ? "bg-bad" : inScope ? "bg-ok" : "bg-warn";

  return (
    <>
      <Card className="overflow-hidden">
        <div className={`h-1 w-full ${barTone}`} />
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-050 text-brand">
                <ArrowRightLeft className="h-4.5 w-4.5" aria-hidden />
              </span>
              <div>
                <h2 className="font-display text-[15px] font-bold leading-tight text-ink">Transfer source</h2>
                <p className="text-xs text-muted">Where this stock comes from, and what is yours to decide.</p>
              </div>
            </div>
            <LevelRail levels={data.levels ?? []} />
          </div>

          <RouteLine source={data.source} destination={data.destination} sourceBadge={chip} />

          {served ? (
            <div className="rounded-2xl border border-ok/30 bg-ok-bg/40 p-3.5">
              <p className="flex items-start gap-2 text-sm font-semibold text-ok">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                Everything is already allocated.
              </p>
              <p className="mt-1 pl-6 text-xs text-body">
                Once you approve, approval ends here and the stock can be issued. Rejecting or returning gives the stock back.
              </p>
              <div className="mt-3 pl-6"><AllocatedList review={data} /></div>
            </div>
          ) : (
            <>
              {data.allocated.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-ink">Already allocated by the levels below</p>
                  <AllocatedList review={data} />
                </div>
              )}
              {noNextLevel ? (
                <div className="rounded-2xl border border-bad/30 bg-bad-bg/40 p-3.5">
                  <p className="flex items-start gap-2 text-sm font-semibold text-bad">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {`${sourceName} is not under you, and no next level is configured.`}
                  </p>
                  <p className="mt-1 pl-6 text-xs text-body">{NO_NEXT_LEVEL_HELP}</p>
                </div>
              ) : inScope ? (
                <div className="rounded-2xl border border-ok/30 bg-ok-bg/40 p-3.5">
                  <p className="flex items-start gap-2 text-sm font-semibold text-ok">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {sourceName} reports to you, so you can allocate it right here.
                  </p>
                  <p className="mt-1 pl-6 text-xs text-body">
                    Each item takes what {sourceName} has free, up to the quantity you approve below.{" "}
                    {coversAll
                      ? "It can cover everything, so approval ends with you."
                      : last
                        ? "Whatever it cannot give goes to the Fulfilment Desk."
                        : `Whatever it cannot give stays owed and goes ${nextName ? `to ${nextName}` : "to the next level"}.`}
                  </p>
                  <div className="mt-3 pl-6"><PlanList plan={sourcePlan} /></div>
                </div>
              ) : (
                <div className="rounded-2xl border border-warn/30 bg-warn-bg/40 p-3.5">
                  <p className="flex items-start gap-2 text-sm font-semibold text-warn">
                    <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {data.source
                      ? `${sourceName} is not under you${data.source.held_by?.length ? ` — it is held by ${data.source.held_by.join(", ")}` : ""}.`
                      : "No source was chosen on this request."}
                  </p>
                  <p className="mt-1 pl-6 text-xs text-body">
                    Forward it {nextName ? `to ${nextName}` : "to the next level"}, where the same check runs again, or take it over from one of your own points.
                  </p>
                </div>
              )}
            </>
          )}

          <SourceChangeList changes={data.changes} />

          {!served && !ready && blocker && (
            <p className="text-xs font-medium text-muted">{blocker}</p>
          )}

          {!served && (
            <div className="flex flex-wrap justify-end gap-2">
              {offerMove && (
                <Button
                  variant="subtle"
                  disabled={!ready || moving}
                  onClick={openMove}
                >
                  <MapPinned className="h-4 w-4" /> Change source to my point
                </Button>
              )}
              {inScope && (
                <Button
                  className={TONE_APPROVE}
                  disabled={!ready || allocate.isPending || sourceGives === 0}
                  onClick={() => { allocate.reset(); setConfirmSource(true); }}
                >
                  <PackageCheck className="h-4 w-4" />
                  {sourceGives === 0 ? `${sourceName} has nothing free` : `Approve & allocate from ${sourceName}`}
                </Button>
              )}
              {!inScope && !noNextLevel && (
                <Button className={TONE_APPROVE} disabled={!ready} onClick={onForward}>
                  <Forward className="h-4 w-4" /> {FORWARD_LABEL}
                </Button>
              )}
            </div>
          )}
          {!served && !inScope && !data.my_points.length && !noNextLevel && (
            <p className="text-right text-[11px] text-muted">None of your points has these items free, so it can only be forwarded.</p>
          )}
        </div>
      </Card>

      <ConfirmModal
        isOpen={confirmSource}
        title={`Approve & allocate from ${sourceName}?`}
        message={coversAll
          ? "This allocates everything, so approval ends here and the stock can be issued."
          : last
            ? "This allocates what the point holds. The rest goes to the Fulfilment Desk."
            : `This reserves what the point holds. The rest goes ${nextName ? `to ${nextName}` : "to the next level"}, and the stock is issued when approval ends.`}
        confirmLabel="Approve & allocate"
        busy={allocate.isPending}
        error={allocate.error}
        onClose={() => !allocate.isPending && setConfirmSource(false)}
        onConfirm={() => allocate.mutate(null)}
      >
        <PlanList plan={sourcePlan} />
      </ConfirmModal>

      <ConfirmModal
        isOpen={picking}
        title="Change the source to one of your points"
        message={`The request currently names ${sourceName}. The change is recorded on the request with your reason.`}
        confirmLabel={thenForward
          ? "Change source & forward"
          : chosen ? `Move to ${chosen.warehouse_name} & allocate` : "Move & allocate"}
        busy={moving}
        confirmDisabled={!chosen || !reason.trim() || (!thenForward && !chosenPlan.some((l) => l.give > 0))}
        error={thenForward ? forward.error : allocate.error}
        onClose={() => !moving && setPicking(false)}
        onConfirm={() => {
          if (!chosen) return;
          if (thenForward) forward.mutate(chosen.warehouse_id);
          else allocate.mutate(chosen.warehouse_id);
        }}
      >
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Your points" className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {data.my_points.map((point) => {
              const on = point.warehouse_id === pick;
              const total = data.lines_owing;
              return (
                <button
                  key={point.warehouse_id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPick(point.warehouse_id)}
                  className={`flex min-h-11 w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                    on ? "border-brand bg-brand-050/60 ring-2 ring-brand/20" : "border-line bg-content1 hover:border-brand/40"}`}
                >
                  <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${
                    on ? "border-brand" : "border-line"}`}>
                    {on && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{point.warehouse_name}</span>
                    <span className="block text-[11px] text-muted">{point.tier_label}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                    point.covers_full === total ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
                    {point.covers_full === total
                      ? "Covers every item"
                      : `${point.covers_full} of ${total} in full`}
                  </span>
                </button>
              );
            })}
          </div>

          {!last && (
            <div role="radiogroup" aria-label="What happens next" className="grid gap-2 sm:grid-cols-2">
              {([
                [false, "Allocate from it now", "Anything it cannot give goes up to the next level."],
                [true, "Only change the source", `Allocates nothing. ${nextName ?? "The next level"} decides.`],
              ] as const).map(([value, title, hint]) => (
                <button
                  key={title}
                  type="button"
                  role="radio"
                  aria-checked={thenForward === value}
                  onClick={() => setThenForward(value)}
                  className={`min-h-11 rounded-xl border p-3 text-left transition-colors ${
                    thenForward === value ? "border-brand bg-brand-050/60 ring-2 ring-brand/20" : "border-line bg-content1 hover:border-brand/40"}`}
                >
                  <span className="block text-sm font-semibold text-ink">{title}</span>
                  <span className="block text-[11px] text-muted">{hint}</span>
                </button>
              ))}
            </div>
          )}

          {chosen && !thenForward && <PlanList plan={chosenPlan} />}
          <label className="block text-sm font-semibold text-ink">
            Why change the source?
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="e.g. The chosen point is not under me; my store holds it closer to the site"
              className="mt-2 min-h-20 w-full rounded-xl border border-line bg-content1 p-3 text-sm font-normal text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/25"
            />
            {!reason.trim() && <span className="mt-1 block text-xs font-normal text-danger">A reason is required.</span>}
          </label>
        </div>
      </ConfirmModal>
    </>
  );
}
