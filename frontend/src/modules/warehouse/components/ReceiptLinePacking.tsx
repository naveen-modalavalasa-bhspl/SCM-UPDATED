import { AlertTriangle, Ban, Clock, Lock, PackageCheck } from "lucide-react";
import {
  type PackEntry, type PackHierarchy, PackBreakdownEditor, PackChips, PackHierarchyPicker,
  baseOf, countsOf, greedy, hierarchyOf,
} from "@/shared/packing";
import type { ReceiptItemWrite } from "../types";

/**
 * Packing at the gate (2026-10-08).
 *
 * With a despatch note behind the line, the supplier's packing is DECLARED and fixed:
 * shown locked, and the storekeeper counts against it — each level at most what was
 * sent, never a level that was not. The received quantity is the count's total, so a
 * missing box is a shortage the GRN records, not a typo the GRN absorbs.
 *
 * Without one, the storekeeper states the packing directly in the order's hierarchy
 * (or any of the item's), and the count is still the quantity.
 */
export function ReceiptLinePacking({ line, hierarchies, locked, onChange }: {
  line: ReceiptItemWrite;
  hierarchies: PackHierarchy[];
  locked?: boolean;
  onChange: (patch: Partial<ReceiptItemWrite>) => void;
}) {
  const declared = line.declared_pack_breakdown ?? null;
  const declaredName = hierarchyOf(declared);
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
    ?? hierarchies.find((h) => h.name === declaredName) ?? hierarchies[0];
  if (!hierarchy) return null;
  const uom = line.uom_code ?? hierarchy.base_uom;
  const counted = line.pack_breakdown ?? null;
  const limits = declared ? countsOf(declared) : null;
  const status = line.pack_change_status;

  const set = (packs: PackEntry[], hierarchyId = hierarchy.hierarchy_id) => {
    const total = baseOf(packs);
    onChange({ pack_hierarchy_id: hierarchyId, pack_breakdown: packs,
               received_qty: total, accepted_qty: total });
  };

  return (
    <div className="space-y-2 rounded-xl border border-line bg-content2/40 p-3">
      {status === "PENDING" && (
        <Banner tone="warn" icon={<Clock className="h-4 w-4" />}>
          The supplier changed the packing ({line.ordered_pack_hierarchy_name} →{" "}
          {declaredName}) and the buyer has not answered yet.
          {line.pack_change_reason ? ` Their reason: “${line.pack_change_reason}”.` : ""}
        </Banner>
      )}
      {status === "DECLINED" && (
        <Banner tone="bad" icon={<Ban className="h-4 w-4" />}>
          The buyer DECLINED this packing ({line.ordered_pack_hierarchy_name} →{" "}
          {declaredName}){line.pack_change_note ? `: “${line.pack_change_note}”` : ""}.
          Check with procurement before booking it in.
        </Banner>
      )}
      {status === "ACCEPTED" && (
        <Banner tone="ok" icon={<PackageCheck className="h-4 w-4" />}>
          Packing changed to {declaredName} — accepted by the buyer.
        </Banner>
      )}

      {declared ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wider text-ink-700">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Supplier sent
          </span>
          <PackChips entries={declared} uom={uom} muted />
          <span className="text-muted">— from the despatch note, fixed. Count what is here.</span>
        </div>
      ) : (
        !locked && hierarchies.length > 1 && (
          <PackHierarchyPicker
            hierarchies={hierarchies}
            value={hierarchy.hierarchy_id}
            uom={uom}
            onChange={(id) => {
              const next = hierarchies.find((h) => h.hierarchy_id === id);
              if (next) set(greedy(next, baseOf(counted) || Number(line.received_qty) || 0), id);
            }}
          />
        )
      )}

      {locked ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold uppercase tracking-wider text-ink-700">Counted</span>
          <PackChips entries={counted} uom={uom} />
        </div>
      ) : (
        <PackBreakdownEditor
          hierarchy={hierarchy}
          value={counted}
          uom={uom}
          limits={limits}
          onlyLevels={declared ? [...Object.keys(limits ?? {}).map(Number), 0] : undefined}
          allowAutoFill={false}
          onChange={(packs) => set(packs)}
        />
      )}
      {declared && !locked && baseOf(counted) < baseOf(declared) && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Short of the despatch note by {(baseOf(declared) - baseOf(counted)).toLocaleString("en-IN")} {uom} — the GRN records it.
        </p>
      )}
    </div>
  );
}

function Banner({ tone, icon, children }: {
  tone: "ok" | "warn" | "bad"; icon: React.ReactNode; children: React.ReactNode;
}) {
  const cls = tone === "ok" ? "bg-ok-bg text-ok" : tone === "warn" ? "bg-warn-bg text-warn"
    : "bg-bad-bg text-bad";
  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-medium ${cls}`}
         role="status">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
