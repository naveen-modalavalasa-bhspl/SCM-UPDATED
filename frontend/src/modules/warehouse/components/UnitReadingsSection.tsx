import { useMemo } from "react";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { Button, Input, Select } from "@/shared/components";
import type { InspectionParameter } from "../types";

/**
 * Per-unit readings — one row per accepted AND per rejected quantity (SCM_0169).
 *
 * The old readings UI answered "what was measured on this line?" with one flat
 * `parameters` table per line, and serial / IMEI identifiers lived in a separate
 * picker. A line that kept eight units and rejected two had ten units, ten serials
 * and a single shared reading — and a supervisor reading the sheet could not tell
 * which reading was on the rejected unit. The rejection was a fact without a unit.
 *
 * This section turns the same numbers into rows: one row per accepted quantity and
 * one per rejected, each carrying its own serial or IMEI when the line is tracked,
 * and each with its own readings. The verdict on a row (Accepted / Rejected) is
 * read-only — it follows the line's split — so the inspector fills in WHAT they
 * measured on THAT unit, not what they decided about it.
 *
 * Storage: rows are persisted on the line's `parameters` JSON column under a
 * structured shape the existing flat readings also fit, so a print page that reads
 * `parameters` keeps working. The shape is:
 *
 *   [{ kind: "unit", unit: 1|"<serial>"|"<imei>", verdict, name, expected, observed, result }]
 *
 * Older rows that lack `kind` / `unit` / `verdict` are still rendered, on a single
 * "Line-level readings" row at the bottom, so nothing already captured is lost.
 */

export interface UnitReading extends InspectionParameter {
  /** Discriminator: "unit" rows are per-qty; legacy rows have no kind. */
  kind?: "unit";
  /** 1-based for bulk lines, or the serial / IMEI / asset code for tracked ones. */
  unit?: string | number;
  /** ACCEPTED or REJECTED — read-only, follows the line's split. */
  verdict?: "ACCEPTED" | "REJECTED";
}

export interface UnitReadingsSectionProps {
  /** The line's accepted qty — drives the count of Accepted rows. */
  acceptedQty: number;
  /** The line's rejected qty — drives the count of Rejected rows. */
  rejectedQty: number;
  /** Whether the line is serial / IMEI / asset / consumable tracked. */
  tracked: boolean;
  /** The accepted serial / IMEI identifiers, in row order. */
  acceptedIdentifiers?: string[] | null;
  /** The rejected serial / IMEI identifiers, in row order. */
  rejectedIdentifiers?: string[] | null;
  /** What the unit kind is called on screen — "Serial", "IMEI", "Asset code". */
  identifierLabel?: string;
  /** The existing readings — flat legacy rows OR per-unit rows. */
  readings?: UnitReading[] | null;
  /** Read-only when the inspection is locked. */
  readOnly?: boolean;
  /** Called with the next readings array on every edit. */
  onChange: (next: UnitReading[]) => void;
}

/** Build the empty row template for one unit. */
const unitRow = (
  unit: string | number,
  verdict: "ACCEPTED" | "REJECTED",
): UnitReading => ({
  kind: "unit", unit, verdict,
  name: "", expected: "", observed: "", result: verdict === "ACCEPTED" ? "PASS" : "FAIL",
});

/** The expected per-unit rows for the current split — ACCEPTED first, then REJECTED. */
function expectedRows(
  acceptedQty: number, rejectedQty: number,
  acceptedIds: string[] | null | undefined,
  rejectedIds: string[] | null | undefined,
): UnitReading[] {
  const rows: UnitReading[] = [];
  for (let i = 0; i < acceptedQty; i++) {
    const id = acceptedIds?.[i];
    rows.push(unitRow(id ?? i + 1, "ACCEPTED"));
  }
  for (let i = 0; i < rejectedQty; i++) {
    const id = rejectedIds?.[i];
    rows.push(unitRow(id ?? i + 1, "REJECTED"));
  }
  return rows;
}

/** Reconcile the stored rows against the current split — keep matching rows,
 *  drop rows for units no longer on the split, add empty rows for new units. */
function reconcile(
  stored: UnitReading[] | null | undefined,
  acceptedQty: number, rejectedQty: number,
  acceptedIds: string[] | null | undefined,
  rejectedIds: string[] | null | undefined,
): { unitRows: UnitReading[]; legacy: UnitReading[] } {
  const storedUnit = (stored ?? []).filter((r): r is UnitReading => r.kind === "unit");
  const legacy = (stored ?? []).filter((r) => !r.kind);
  const expected = expectedRows(acceptedQty, rejectedQty, acceptedIds, rejectedIds);
  const reconciled: UnitReading[] = expected.map((exp) => {
    // Match by verdict + unit identifier (serial/imei) when tracked, or by index.
    const match = storedUnit.find((r) => r.verdict === exp.verdict && String(r.unit) === String(exp.unit));
    return match ?? exp;
  });
  return { unitRows: reconciled, legacy };
}

export function UnitReadingsSection({
  acceptedQty, rejectedQty, tracked,
  acceptedIdentifiers, rejectedIdentifiers,
  identifierLabel = "Serial",
  readings, readOnly, onChange,
}: UnitReadingsSectionProps) {
  const { unitRows, legacy } = useMemo(
    () => reconcile(readings, acceptedQty, rejectedQty, acceptedIdentifiers, rejectedIdentifiers),
    [readings, acceptedQty, rejectedQty, acceptedIdentifiers, rejectedIdentifiers],
  );

  /** Patch one row's field. */
  const patchRow = (idx: number, patch: Partial<UnitReading>) => {
    const next = unitRows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange([...next, ...legacy]);
  };
  /** Add a reading to one row — a unit can carry more than one measurement. */
  const addReading = (idx: number) => {
    const next = [...unitRows];
    // Re-use the same row's identity for the new reading — represented as an
    // extra entry with the same unit/verdict. The renderer collapses them.
    next.splice(idx + 1, 0, unitRow(unitRows[idx].unit ?? idx + 1, unitRows[idx].verdict ?? "ACCEPTED"));
    onChange([...next, ...legacy]);
  };
  /** Remove a reading (only when more than one exists for that unit). */
  const removeReading = (idx: number) => {
    const next = unitRows.filter((_, i) => i !== idx);
    onChange([...next, ...legacy]);
  };

  /** Group rows by (verdict, unit) so multiple readings on one unit render together. */
  const groups = useMemo(() => {
    const map = new Map<string, { verdict: "ACCEPTED" | "REJECTED"; unit: string | number; readings: { idx: number; row: UnitReading }[] }>();
    for (const [idx, row] of unitRows.entries()) {
      const key = `${row.verdict}-${row.unit}`;
      const g = map.get(key) ?? { verdict: row.verdict ?? "ACCEPTED", unit: row.unit ?? idx + 1, readings: [] };
      g.readings.push({ idx, row });
      map.set(key, g);
    }
    // ACCEPTED groups first, then REJECTED; within each, by unit order.
    return [...map.values()].sort((a, b) =>
      (a.verdict === b.verdict ? 0 : a.verdict === "ACCEPTED" ? -1 : 1)
      || String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }));
  }, [unitRows]);

  if (acceptedQty + rejectedQty <= 0) {
    return (
      <p className="text-sm text-muted">
        Inspect the line above to record per-unit readings.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-content2/40 px-3 py-2 text-xs text-muted">
        One row per unit. The verdict follows the line's split — record <b>what
        was measured</b> on each, not what was decided. {tracked && (
          <>Each tracked unit is named by its {identifierLabel.toLowerCase()}.</>
        )}
      </div>

      {groups.map((g) => (
        <div key={`${g.verdict}-${g.unit}`} className="rounded-xl border border-line bg-content1 overflow-hidden">
          <div className={`flex items-center justify-between gap-2 px-3 py-2 ${
            g.verdict === "ACCEPTED" ? "bg-ok-bg/60" : "bg-bad-bg/60"}`}>
            <div className="flex items-center gap-2 text-sm">
              {g.verdict === "ACCEPTED"
                ? <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
                : <XCircle className="h-4 w-4 text-bad" aria-hidden />}
              <span className={`font-semibold ${g.verdict === "ACCEPTED" ? "text-ok" : "text-bad"}`}>
                {g.verdict === "ACCEPTED" ? "Accepted" : "Rejected"}
              </span>
              <span className="text-muted">·</span>
              <span className="font-mono text-xs text-body">
                {tracked ? `${identifierLabel} ${g.unit}` : `Unit ${g.unit}`}
              </span>
            </div>
            {!readOnly && (
              <Button variant="ghost" onClick={() => addReading(g.readings[0].idx)}>
                <Plus className="h-3.5 w-3.5" /> Add reading
              </Button>
            )}
          </div>
          <div className="divide-y divide-line/60">
            {g.readings.map(({ idx, row }) => (
              <div key={idx} className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[1fr_1fr_1fr_130px_36px]">
                <Input
                  value={row.name}
                  placeholder="Parameter"
                  disabled={readOnly}
                  aria-label={`Parameter, ${g.verdict === "ACCEPTED" ? "accepted" : "rejected"} unit ${g.unit}`}
                  onChange={(e) => patchRow(idx, { name: e.target.value })}
                />
                <Input
                  value={row.expected ?? ""}
                  placeholder="Expected"
                  disabled={readOnly}
                  aria-label={`Expected, unit ${g.unit}`}
                  onChange={(e) => patchRow(idx, { expected: e.target.value })}
                />
                <Input
                  value={row.observed ?? ""}
                  placeholder="Observed"
                  disabled={readOnly}
                  aria-label={`Observed, unit ${g.unit}`}
                  onChange={(e) => patchRow(idx, { observed: e.target.value })}
                />
                <Select
                  value={row.result ?? "PASS"}
                  isDisabled={readOnly}
                  onChange={(v) => patchRow(idx, { result: v as "PASS" | "FAIL" })}
                  options={[{ value: "PASS", label: "Pass" }, { value: "FAIL", label: "Fail" }]}
                  ariaLabel={`Result, unit ${g.unit}`}
                />
                <button
                  type="button"
                  aria-label="Remove this reading"
                  disabled={readOnly || g.readings.length <= 1}
                  onClick={() => removeReading(idx)}
                  className="inline-flex h-11 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-content2 hover:text-bad disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {legacy.length > 0 && (
        <div className="rounded-xl border border-dashed border-line bg-content2/40 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            Line-level readings (captured before per-unit readings)
          </div>
          <div className="mt-2 space-y-1 text-xs text-body">
            {legacy.map((r, i) => (
              <div key={i} className="font-mono">
                {r.name}: expected {r.expected ?? "—"}, observed {r.observed ?? "—"}, {r.result ?? "—"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
