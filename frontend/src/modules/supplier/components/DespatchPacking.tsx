import { AlertTriangle } from "lucide-react";
import { Field, Textarea } from "@/shared/components";
import {
  type PackEntry, type PackHierarchy, PackBreakdownEditor, PackHierarchyPicker, baseOf,
  greedyWithPart, num,
} from "@/shared/packing";

/**
 * How the supplier packed one despatch line (2026-10-08).
 *
 * The order's hierarchy comes first and is badged "As ordered". Any mix of its levels
 * is fine — 2 Carton or 24 Box are the same order — and the packs ARE the quantity
 * sent. Choosing a DIFFERENT hierarchy is allowed but never silent: the buyer is asked
 * to accept it, so the supplier must say why, in words the buyer will read.
 */
export function DespatchPacking({ hierarchies, orderedId, hierarchyId, breakdown, reason,
                                  uom, owed, onChange }: {
  hierarchies: PackHierarchy[];
  orderedId?: number | null;
  hierarchyId?: number | null;
  breakdown?: PackEntry[] | null;
  reason?: string | null;
  uom?: string | null;
  /** What the order still owes — the packs are checked against it before the press. */
  owed: number;
  onChange: (patch: { pack_hierarchy_id: number | null; pack_breakdown: PackEntry[] | null;
                      pack_change_reason?: string | null; despatched_qty: number }) => void;
}) {
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === hierarchyId)
    ?? hierarchies.find((h) => h.hierarchy_id === orderedId) ?? hierarchies[0];
  if (!hierarchy) return null;
  const changed = orderedId != null && hierarchy.hierarchy_id !== orderedId;
  const ordered = hierarchies.find((h) => h.hierarchy_id === orderedId);
  const sent = baseOf(breakdown);

  return (
    <div className="space-y-3 rounded-xl border border-line bg-content2/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-ink-700">
          How is it packed?
        </span>
        <span className="text-xs text-muted">
          Any mix of the levels is fine — the packs are the quantity you send.
        </span>
      </div>
      <PackHierarchyPicker
        hierarchies={hierarchies}
        value={hierarchy.hierarchy_id}
        orderedId={orderedId}
        uom={uom}
        onChange={(id) => {
          const next = hierarchies.find((h) => h.hierarchy_id === id);
          if (!next) return;
          const targetQty = sent > 0 ? sent : owed;
          const packs = greedyWithPart(next, targetQty);
          onChange({ pack_hierarchy_id: id, pack_breakdown: packs,
                     despatched_qty: baseOf(packs),
                     pack_change_reason: id === orderedId ? null : reason ?? "" });
        }}
      />
      <PackBreakdownEditor
        hierarchy={hierarchy}
        value={breakdown}
        uom={uom}
        allowAutoFill={false}
        onChange={(packs) => onChange({
          pack_hierarchy_id: hierarchy.hierarchy_id, pack_breakdown: packs,
          despatched_qty: baseOf(packs), pack_change_reason: changed ? reason ?? "" : null,
        })}
      />
      {sent > owed && (
        <p className="rounded-lg bg-bad-bg px-3 py-2 text-xs font-medium text-bad">
          That is {num(sent - owed).toLocaleString("en-IN")} {uom ?? "units"} more than the
          order still owes.
        </p>
      )}
      {changed && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              The order asks for <b>{ordered?.name ?? "a different packing"}</b>; you are
              sending <b>{hierarchy.name}</b>. The buyer is asked to accept the change when
              you submit this note.
            </span>
          </p>
          <Field label="Why the packing changed" required>
            <Textarea value={reason ?? ""} minRows={2}
                      placeholder="e.g. Strips of 10 are out of stock this month"
                      onChange={(e) => onChange({
                        pack_hierarchy_id: hierarchy.hierarchy_id,
                        pack_breakdown: breakdown ?? null, despatched_qty: sent,
                        pack_change_reason: e.target.value,
                      })} />
          </Field>
        </div>
      )}
    </div>
  );
}
