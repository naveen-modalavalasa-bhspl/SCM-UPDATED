import { StatusPill } from "@/shared/components";
import type { ColumnKind, ReportColumn, ReportRow } from "../types";

/** One place that turns a ledger value into something readable, driven by the
 *  column's `kind`. The backend sends ISO strings and plain numbers; formatting is
 *  a display decision and stays here. */

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const DATE_ONLY = new Intl.DateTimeFormat(undefined, {
  day: "2-digit", month: "short", year: "numeric",
});
const QTY = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

const EMPTY = <span className="text-muted">—</span>;

function formatStamp(value: string, withTime: boolean) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return withTime ? DATE_TIME.format(parsed) : DATE_ONLY.format(parsed);
}

export function renderValue(value: ReportRow[string], kind: ColumnKind) {
  if (value === null || value === undefined || value === "") return EMPTY;

  switch (kind) {
    case "datetime":
      return <span className="whitespace-nowrap">{formatStamp(String(value), true)}</span>;
    case "date":
      return <span className="whitespace-nowrap">{formatStamp(String(value), false)}</span>;
    case "qty":
      return <span className="tabular-nums">{QTY.format(Number(value))}</span>;
    case "number":
      return <span className="tabular-nums">{String(value)}</span>;
    case "status":
      return <StatusPill status={String(value)} />;
    case "direction":
      // IN and OUT are the whole point of a stock ledger, so they get colour of
      // their own rather than the status vocabulary's default grey.
      return (
        <span
          className={`inline-flex min-w-11 justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${
            String(value) === "IN"
              ? "bg-success-50 text-success-700"
              : "bg-danger-50 text-danger-700"
          }`}
        >
          {String(value)}
        </span>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

/** The mobile card: the first four columns, labelled, because a card has no header
 *  row to explain what a value is. */
export function LedgerCard({ row, columns }: { row: ReportRow; columns: ReportColumn[] }) {
  const [lead, ...rest] = columns;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-body">{renderValue(row[lead.key], lead.kind)}</span>
        {rest[0] && renderValue(row[rest[0].key], rest[0].kind)}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {rest.slice(1, 6).map((col) => (
          <div key={col.key} className="min-w-0">
            <dt className="text-muted">{col.label}</dt>
            <dd className="truncate text-body">{renderValue(row[col.key], col.kind)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
