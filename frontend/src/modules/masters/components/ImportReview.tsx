import { useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { Button } from "@/shared/components";
import type { ImportPreview, ImportRow } from "../api";

/**
 * What the server made of the uploaded sheet, before anything is written.
 *
 * The masters are filled in by storekeepers, and a rejected file used to be the end
 * of the road for them: a list of four hundred problems, back to Excel, guess again.
 * The names they typed are almost always right and almost always slightly off —
 * "Cipla Ltd" for "Cipla", a trailing space, a plural. So the fixing happens HERE,
 * against the master's own values, once.
 *
 * It shows the rows that need attention and hides the ones that do not. Four bad
 * cells in a four-hundred-row file is four things to fix, and scrolling past 396
 * correct rows to find them is the same problem in a nicer typeface.
 *
 * Nothing here is a check. Every fixed row goes back through the same validation on
 * commit — this screen only saves the round trip.
 */

/** A cell the sheet could not answer, with the master's real values to pick from. */
function Fix({ label, raw, message, options, value, onPick }: {
  label: string;
  raw: string | null;
  message: string;
  options: { id: number; label: string; code: string }[];
  value: number | null;
  onPick: (id: number | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle)
          || o.code.toLowerCase().includes(needle))
      : options;
    return list.slice(0, 200);
  }, [options, filter]);

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </span>
        {raw && (
          <span className="rounded bg-bad-bg px-1.5 py-0.5 font-mono text-xs text-bad">
            {raw}
          </span>
        )}
        <span className="text-xs text-muted">{message}</span>
      </div>

      {options.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {options.length > 12 && (
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search…"
              aria-label={`Search ${label}`}
              className="min-h-11 w-40 rounded-lg border border-line bg-bg px-3 text-sm"
            />
          )}
          <select
            value={value ?? ""}
            aria-label={label}
            onChange={(event) =>
              onPick(event.target.value === "" ? null : Number(event.target.value))}
            className="min-h-11 min-w-52 rounded-lg border border-line bg-bg px-3 text-sm"
          >
            <option value="">Pick the right one…</option>
            {shown.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}{option.code ? ` · ${option.code}` : ""}
              </option>
            ))}
          </select>
          {value !== null && <Check className="h-4 w-4 text-ok" />}
        </div>
      ) : (
        /* No candidates to offer — a missing required value, or a name whose master
           has nothing that could be meant. Excel is the only place to fix it. */
        <p className="mt-1 text-xs text-muted">
          Fix this in the spreadsheet and upload it again.
        </p>
      )}
    </div>
  );
}

export function ImportReview({ preview, label, busy, onCommit, onCancel }: {
  preview: ImportPreview;
  /** The master's name, for the heading. */
  label: string;
  busy: boolean;
  onCommit: (rows: ImportRow[]) => void;
  onCancel: () => void;
}) {
  // The fixes, keyed "<row>:<field>". Held here rather than written back into the
  // preview so cancelling leaves the uploaded file untouched.
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [showAll, setShowAll] = useState(false);

  const nameField = preview.columns.find((c) => c.field === "name")?.field;
  const troubled = preview.rows.filter((r) => r.problems.length > 0);
  const listed = showAll ? preview.rows : troubled;

  /** A problem is settled when it has been given a value, or never needed one. */
  const outstanding = troubled.reduce((count, row) => count + row.problems.filter(
    (p) => p.field !== null && picked[`${row.row}:${p.field}`] === undefined,
  ).length + row.problems.filter((p) => p.field === null).length, 0);

  const commit = () => {
    onCommit(preview.rows.map((row) => {
      const values = { ...row.values };
      for (const problem of row.problems) {
        if (!problem.field) continue;
        const choice = picked[`${row.row}:${problem.field}`];
        if (choice !== undefined) values[problem.field] = choice;
      }
      return { ...row, values };
    }));
  };

  return (
    <div className="mt-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Check before saving · {label}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {preview.summary.total} row{preview.summary.total === 1 ? "" : "s"} read ·{" "}
            {preview.summary.ready} ready ·{" "}
            <span className={preview.summary.blocked ? "text-bad" : ""}>
              {preview.summary.blocked} need{preview.summary.blocked === 1 ? "s" : ""} attention
            </span>
            . Nothing is saved until you press Save.
          </p>
        </div>
        <div className="flex gap-2">
          {preview.rows.length > troubled.length && (
            <Button variant="ghost" onClick={() => setShowAll((on) => !on)}>
              {showAll ? "Only show problems" : `Show all ${preview.rows.length}`}
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            <X className="h-4 w-4" /> Cancel
          </Button>
          <Button onClick={commit} disabled={busy || outstanding > 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {outstanding > 0 ? `${outstanding} still to fix` : "Save these rows"}
          </Button>
        </div>
      </div>

      {preview.file_errors.length > 0 && (
        <div className="mt-3 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          {preview.file_errors.map((line) => <div key={line}>{line}</div>)}
        </div>
      )}

      <div className="mt-3 max-h-[26rem] space-y-2 overflow-auto">
        {listed.map((row) => (
          <div key={row.row}
               className={`rounded-lg border px-3 py-2 ${row.problems.length
                 ? "border-bad/40 bg-bad-bg/30" : "border-line"}`}>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted">Row {row.row}</span>
              <span className="font-medium">
                {String((nameField && row.values[nameField]) || "—")}
              </span>
              {row.problems.length > 0 && (
                <AlertTriangle className="h-4 w-4 text-bad" />
              )}
            </div>
            {row.problems.length > 0 && (
              <div className="mt-2 space-y-2">
                {row.problems.map((problem, index) => (
                  <Fix
                    key={`${problem.field ?? "row"}-${index}`}
                    label={problem.label ?? "This row"}
                    raw={problem.raw}
                    message={problem.message}
                    options={problem.field
                      ? (problem.candidates.length
                          ? problem.candidates
                          : preview.options[problem.field] ?? [])
                      : []}
                    value={problem.field
                      ? picked[`${row.row}:${problem.field}`] ?? null
                      : null}
                    onPick={(id) => setPicked((current) => {
                      const key = `${row.row}:${problem.field}`;
                      const next = { ...current };
                      if (id === null) delete next[key]; else next[key] = id;
                      return next;
                    })}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {listed.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">
            Every row read cleanly. Press Save to write them.
          </p>
        )}
      </div>
    </div>
  );
}
