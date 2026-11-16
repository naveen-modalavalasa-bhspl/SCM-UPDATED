import { CheckCircle2, CircleDashed, CircleSlash, MinusCircle, XCircle } from "lucide-react";
import {
  qcQty, qcRate, qcSentence, qcTone, type QcResult, type QcSummary, type QcTone,
} from "../qcSummary";

/**
 * How a quality inspection went, drawn once and used everywhere it is shown
 * (SCM_0164 / 0165 / 0166).
 *
 * The screens used to answer with LINE counts — "Passed 0 · Failed 0" under a sheet
 * that had just rejected two units — and each place did its own arithmetic. Every
 * figure here comes from one `QcSummary` (`../qcSummary`), which counts by QUANTITY and
 * puts a partly rejected line in its own bucket, so the panel at the top, the strip
 * under the lines, the confirm dialog and the register can never disagree.
 *
 * Read in this order, which is the order a person asks: how did it go (the ring and
 * the sentence), how much (accepted / rejected), and where (the line chips).
 */

const TONE_TEXT: Record<QcTone, string> = {
  ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted",
};
const TONE_RING: Record<QcTone, string> = {
  ok: "stroke-ok", warn: "stroke-warn", bad: "stroke-bad", idle: "stroke-line",
};
const TONE_SOFT: Record<QcTone, string> = {
  ok: "bg-ok-bg", warn: "bg-warn-bg", bad: "bg-bad-bg", idle: "bg-surface-2",
};

/** Accepted ÷ inspected as a ring. Nothing inspected draws an empty track, never 0 %. */
function PassRing({ summary, size = 92 }: { summary: QcSummary; size?: number }) {
  const tone = qcTone(summary);
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const share = summary.passRate === null ? 0 : Math.min(Math.max(summary.passRate, 0), 100) / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke}
                className={summary.rejected > 0 ? "stroke-bad/25" : "stroke-line/70"} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke}
                strokeLinecap="round" className={`${TONE_RING[tone]} transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none`}
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - share)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className={`text-xl font-bold tabular ${TONE_TEXT[tone]}`}>{qcRate(summary.passRate)}</span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted">pass rate</span>
      </div>
    </div>
  );
}

/** Accepted then rejected, as one bar. Its width IS the inspected quantity. */
export function QcBar({ summary, className = "h-2" }: { summary: QcSummary; className?: string }) {
  const total = summary.accepted + summary.rejected;
  const accepted = total > 0 ? (summary.accepted / total) * 100 : 0;
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
      role="img"
      aria-label={total > 0
        ? `${qcQty(summary.accepted)} accepted, ${qcQty(summary.rejected)} rejected`
        : "Nothing inspected yet"}
    >
      {total > 0 && (
        <>
          <span className="h-full bg-ok transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${accepted}%` }} />
          <span className="h-full bg-bad transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${100 - accepted}%` }} />
        </>
      )}
    </div>
  );
}

const RESULT_META: Record<QcResult, { label: string; icon: typeof CheckCircle2; className: string; hint: string }> = {
  PASSED: { label: "Passed", icon: CheckCircle2, className: "bg-ok-bg text-ok border-ok/25",
            hint: "Everything inspected on this line was accepted." },
  PARTIAL: { label: "Partial", icon: MinusCircle, className: "bg-warn-bg text-warn border-warn/30",
             hint: "Part of this line was accepted and part rejected." },
  FAILED: { label: "Failed", icon: XCircle, className: "bg-bad-bg text-bad border-bad/25",
            hint: "Everything inspected on this line was rejected." },
  PENDING: { label: "Pending", icon: CircleDashed, className: "bg-surface-2 text-muted border-line",
             hint: "Nothing inspected on this line yet." },
};

/** One line's result. Shown, never picked: it follows the accepted / rejected split. */
export function QcResultBadge({ result }: { result: QcResult }) {
  const meta = RESULT_META[result];
  const Icon = meta.icon;
  return (
    <span title={`${meta.hint} It follows the accepted and rejected quantities.`}
          className={`inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold ${meta.className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {meta.label}
    </span>
  );
}

/** "Passed 3 · Partial 1 · Failed 0 · Pending 2" — every line in exactly one chip.
 *  An empty bucket stays on screen, quietened, so a zero is visibly a zero. */
function LineChips({ summary, compact = false }: { summary: QcSummary; compact?: boolean }) {
  const chips: { result: QcResult; count: number }[] = [
    { result: "PASSED", count: summary.passed },
    { result: "PARTIAL", count: summary.partial },
    { result: "FAILED", count: summary.failed },
    { result: "PENDING", count: summary.pending },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Lines by result">
      {chips.map(({ result, count }) => {
        const meta = RESULT_META[result];
        const Icon = meta.icon;
        // Pending is only worth a chip while something is still pending.
        if (result === "PENDING" && count === 0) return null;
        return (
          <li key={result} title={meta.hint}
              className={`inline-flex items-center gap-1 rounded-full border px-2 ${compact ? "py-0.5" : "py-1"} text-xs font-medium ${
                count > 0 ? meta.className : "border-line bg-transparent text-muted/70"}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {meta.label} <b className="tabular">{count}</b>
          </li>
        );
      })}
    </ul>
  );
}

function Figure({ label, value, uom, tone }: { label: string; value: number; uom?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-lg font-bold tabular ${tone ?? "text-ink"}`}>
        {qcQty(value)}
        {uom && <span className="ml-1 text-xs font-medium text-muted">{uom}</span>}
      </div>
    </div>
  );
}

/**
 * The verdict panel: ring, sentence, the accepted / rejected split, line chips.
 * `uom` is named only when every line shares one, so "units" never claims a unit.
 */
export function QcVerdictPanel({ summary, uom, title = "Inspection result" }: {
  summary: QcSummary; uom?: string; title?: string;
}) {
  const tone = qcTone(summary);
  return (
    <section aria-label={title}
             className="overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      <div aria-hidden className={`h-1 ${tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-bad" : "bg-line"}`} />
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-5">
        <PassRing summary={summary} />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted">{title}</h2>
            {/* Polite live region: the sentence re-reads itself as quantities are typed. */}
            <p aria-live="polite" className={`mt-1 text-sm font-semibold ${tone === "idle" ? "text-body" : "text-ink"}`}>
              {qcSentence(summary, uom ?? "units")}
            </p>
          </div>
          <QcBar summary={summary} className="h-2.5" />
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Inspected" value={summary.inspected} uom={uom} />
            <Figure label="Accepted" value={summary.accepted} uom={uom}
                    tone={summary.accepted > 0 ? "text-ok" : "text-ink"} />
            <Figure label="Rejected" value={summary.rejected} uom={uom}
                    tone={summary.rejected > 0 ? "text-bad" : "text-ink"} />
          </div>
          <LineChips summary={summary} />
        </div>
      </div>
    </section>
  );
}

/** The same verdict in one row — under the lines table, where the eye already is. */
export function QcVerdictStrip({ summary, uom }: { summary: QcSummary; uom?: string }) {
  const tone = qcTone(summary);
  return (
    <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <LineChips summary={summary} compact />
      <div className="flex min-w-[12rem] flex-1 items-center gap-2">
        <QcBar summary={summary} className="h-1.5" />
      </div>
      <span className="text-muted">
        Inspected <b className="tabular text-ink">{qcQty(summary.inspected)}</b>
        {uom ? ` ${uom}` : ""}
      </span>
      <span className={summary.accepted > 0 ? "text-ok" : "text-muted"}>
        Accepted <b className="tabular">{qcQty(summary.accepted)}</b>
      </span>
      <span className={summary.rejected > 0 ? "text-bad" : "text-muted"}>
        Rejected <b className="tabular">{qcQty(summary.rejected)}</b>
      </span>
      <span className={`rounded-full px-2 py-0.5 text-xs font-bold tabular ${TONE_SOFT[tone]} ${TONE_TEXT[tone]}`}>
        {qcRate(summary.passRate)}
      </span>
    </div>
  );
}

/** A register row: the bar, "8 / 10 accepted", the rejection, the rate. */
export function QcRowResult({ summary }: { summary: QcSummary }) {
  const tone = qcTone(summary);
  if (summary.inspected <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <CircleSlash className="h-3.5 w-3.5" aria-hidden /> Not inspected yet
      </span>
    );
  }
  return (
    <div className="min-w-[10rem] max-w-[15rem] space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-body">
          <b className="tabular text-ink">{qcQty(summary.accepted)}</b>/<span className="tabular">{qcQty(summary.inspected)}</span> accepted
        </span>
        <span className={`font-bold tabular ${TONE_TEXT[tone]}`}>{qcRate(summary.passRate)}</span>
      </div>
      <QcBar summary={summary} className="h-1.5" />
      {summary.rejected > 0 && (
        <div className="text-[11px] font-medium text-bad">
          {qcQty(summary.rejected)} rejected
          {summary.partial > 0 && <span className="text-warn"> · {summary.partial} partial</span>}
          {summary.failed > 0 && <span> · {summary.failed} failed</span>}
        </div>
      )}
    </div>
  );
}
