import { useState } from "react";
import {
  AlertCircle, AlertTriangle, Boxes, Check, CheckCircle2, Info, Layers, Package, Sparkles, X,
} from "lucide-react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import { Field, Textarea, useToast } from "@/shared/components";
import {
  type PackEntry, type PackHierarchy, PackBreakdownEditor, PackHierarchyPicker,
  PackChips, baseOf, greedyWithPart, num, fmtQty,
} from "@/shared/packing";

export interface DespatchPackingProps {
  hierarchies: PackHierarchy[];
  orderedId?: number | null;
  hierarchyId?: number | null;
  breakdown?: PackEntry[] | null;
  reason?: string | null;
  uom?: string | null;
  /** What the order still owes. */
  owed: number;
  /** Target dispatch quantity for this specific batch / split. */
  targetQty?: number;
  itemName?: string | null;
  itemCode?: string | null;
  batchNo?: string | null;
  splitNo?: number;
  totalSplits?: number;
  /** Force inline view (used by unit tests or dense view). Defaults to false (popup modal). */
  inline?: boolean;
  onChange: (patch: {
    pack_hierarchy_id: number | null;
    pack_breakdown: PackEntry[] | null;
    pack_change_reason?: string | null;
    despatched_qty: number;
  }) => void;
}

/**
 * Packaging configuration for a supplier dispatch note line.
 *
 * Defaults to displaying in buyer-requested packages only with a clean trigger button.
 * Clicking "Change packaging" opens a dedicated popup modal form matching the PO page
 * packaging modal architecture, allowing hierarchy adjustments, container quantity
 * distribution, part packs, and buyer justification when departing from ordered packages.
 */
export function DespatchPacking({
  hierarchies,
  orderedId,
  hierarchyId,
  breakdown,
  reason,
  uom,
  owed,
  targetQty,
  itemName,
  itemCode,
  batchNo,
  splitNo,
  totalSplits,
  inline = false,
  onChange,
}: DespatchPackingProps) {
  const toast = useToast();
  const currentHierarchy = hierarchies.find((h) => h.hierarchy_id === hierarchyId)
    ?? hierarchies.find((h) => h.hierarchy_id === orderedId)
    ?? hierarchies[0];

  const orderedHierarchy = hierarchies.find((h) => h.hierarchy_id === orderedId);
  const isOrderedHierarchy = orderedId == null || currentHierarchy?.hierarchy_id === orderedId;
  const sent = baseOf(breakdown);
  const currentTarget = targetQty != null ? targetQty : (sent > 0 ? sent : owed);

  // Modal local draft state
  const [open, setOpen] = useState(false);
  const [draftHierarchyId, setDraftHierarchyId] = useState<number | null>(null);
  const [draftPacks, setDraftPacks] = useState<PackEntry[] | null>(null);
  const [draftReason, setDraftReason] = useState<string>("");

  const handleOpenModal = () => {
    const activeHid = hierarchyId ?? orderedId ?? currentHierarchy?.hierarchy_id ?? null;
    const activeH = hierarchies.find((h) => h.hierarchy_id === activeHid) ?? currentHierarchy;
    setDraftHierarchyId(activeHid);
    setDraftReason(reason ?? "");

    if (breakdown?.length && hierarchyId === activeHid) {
      setDraftPacks(breakdown);
    } else if (activeH && currentTarget > 0) {
      setDraftPacks(greedyWithPart(activeH, currentTarget));
    } else {
      setDraftPacks(null);
    }
    setOpen(true);
  };

  const activeDraftHierarchy = hierarchies.find((h) => h.hierarchy_id === draftHierarchyId)
    ?? currentHierarchy;
  const draftPackedTotal = baseOf(draftPacks);
  const draftMatches = draftPackedTotal === currentTarget;
  const draftDiff = Math.abs(draftPackedTotal - currentTarget);
  const isDraftDifferent = orderedId != null && draftHierarchyId != null && draftHierarchyId !== orderedId;

  const handleApplyPackaging = () => {
    if (!activeDraftHierarchy) return;
    onChange({
      pack_hierarchy_id: activeDraftHierarchy.hierarchy_id,
      pack_breakdown: draftPacks,
      pack_change_reason: isDraftDifferent ? draftReason : null,
      despatched_qty: draftPackedTotal > 0 ? draftPackedTotal : currentTarget,
    });
    toast.success("Packaging configuration updated successfully.");
    setOpen(false);
  };

  // Inline view fallback for backwards-compatibility or unit tests
  if (inline && currentHierarchy) {
    const changed = orderedId != null && currentHierarchy.hierarchy_id !== orderedId;
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
          value={currentHierarchy.hierarchy_id}
          orderedId={orderedId}
          uom={uom}
          onChange={(id) => {
            const next = hierarchies.find((h) => h.hierarchy_id === id);
            if (!next) return;
            const target = sent > 0 ? sent : owed;
            const packs = greedyWithPart(next, target);
            onChange({
              pack_hierarchy_id: id,
              pack_breakdown: packs,
              despatched_qty: baseOf(packs),
              pack_change_reason: id === orderedId ? null : reason ?? "",
            });
          }}
        />
        <PackBreakdownEditor usage="PURCHASE"
          hierarchy={currentHierarchy}
          value={breakdown}
          uom={uom}
          allowAutoFill={false}
          onChange={(packs) => onChange({
            pack_hierarchy_id: currentHierarchy.hierarchy_id,
            pack_breakdown: packs,
            despatched_qty: baseOf(packs),
            pack_change_reason: changed ? reason ?? "" : null,
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
                The order asks for <b>{orderedHierarchy?.name ?? "a different packing"}</b>; you are
                sending <b>{currentHierarchy.name}</b>. The buyer is asked to accept the change when
                you submit this note.
              </span>
            </p>
            <Field label="Why the packing changed" required>
              <Textarea
                value={reason ?? ""}
                minRows={2}
                placeholder="e.g. Strips of 10 are out of stock this month"
                onChange={(e) => onChange({
                  pack_hierarchy_id: currentHierarchy.hierarchy_id,
                  pack_breakdown: breakdown ?? null,
                  despatched_qty: sent,
                  pack_change_reason: e.target.value,
                })}
              />
            </Field>
          </div>
        )}
      </div>
    );
  }

  if (!hierarchies.length || !currentHierarchy) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      {/* ── Table Cell Trigger (Compact, non-distorting, in buyer requested packages) ── */}
      <div className="flex flex-wrap items-center gap-2">
        {breakdown?.length ? (
          <PackChips entries={breakdown} uom={uom} />
        ) : (
          <span className="text-xs text-muted">
            Buyer requested packages ({currentTarget} {uom ?? "units"})
          </span>
        )}

        {isOrderedHierarchy ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
            <CheckCircle2 size={11} className="text-emerald-600" /> As Ordered
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200">
            <AlertTriangle size={11} className="text-amber-600" /> Custom ({currentHierarchy.name})
          </span>
        )}

        <button
          type="button"
          onClick={handleOpenModal}
          className="group inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-050/60 px-2.5 py-1 text-xs font-semibold text-brand shadow-2xs transition-all hover:border-brand hover:bg-brand hover:text-white hover:shadow-xs active:scale-95 cursor-pointer"
          title="Change packaging hierarchy, container counts, or part packs"
        >
          <Boxes className="h-3.5 w-3.5 transition-transform group-hover:scale-110" aria-hidden />
          <span>Change packaging</span>
        </button>

        {!isOrderedHierarchy && !(reason ?? "").trim() && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-red-200 animate-pulse">
            Reason required
          </span>
        )}
      </div>

      {/* ── Modal Pop-up Form (Exact match with PO Page Packaging Modal) ────────── */}
      {open && activeDraftHierarchy && (
        <Modal
          isOpen={open}
          onClose={() => setOpen(false)}
          size="2xl"
          backdrop="blur"
          scrollBehavior="inside"
          classNames={{
            base: "rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden",
            backdrop: "bg-black/50 backdrop-blur-sm",
          }}
        >
          <ModalContent>
            {/* Top aesthetic gradient bar */}
            <div className="h-1.5 w-full bg-gradient-to-r from-brand via-violet-500 to-indigo-600" />

            <ModalHeader className="flex items-start justify-between gap-3 px-6 pb-3 pt-5 border-b border-line/60">
              <div className="flex items-start gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-050 text-brand ring-1 ring-brand/20 shadow-xs">
                  <Boxes className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-ink">
                      Configure Dispatch Packaging & Pack Hierarchy
                    </h3>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
                      Batch Target: {fmtQty(currentTarget)} {uom ?? "units"}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    <span className="font-semibold text-ink">{itemName ?? "Selected Item"}</span>
                    {itemCode ? ` · ${itemCode}` : ""}
                    {batchNo ? ` · Batch: ${batchNo}` : ""}
                    {totalSplits && totalSplits > 1 ? ` · Split ${splitNo ?? 1} of ${totalSplits}` : ""}
                  </p>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="space-y-4 px-6 py-4 max-h-[75vh] overflow-y-auto">
              {/* 1. Hierarchy Selection Card */}
              <div className="rounded-2xl border border-line/70 bg-content2/30 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-brand" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                    1. Packaging Hierarchy Architecture
                  </h4>
                </div>
                <p className="text-xs text-muted">
                  Choose how this product is grouped from supplier into outer containers, boxes, or strips.
                </p>
                <PackHierarchyPicker
                  hierarchies={hierarchies}
                  value={activeDraftHierarchy.hierarchy_id}
                  orderedId={orderedId}
                  uom={uom}
                  onChange={(id) => {
                    const next = hierarchies.find((h) => h.hierarchy_id === id);
                    if (!next) return;
                    setDraftHierarchyId(id);
                    setDraftPacks(greedyWithPart(next, currentTarget));
                  }}
                />
              </div>

              {/* 2. Container Quantity Breakdown Card */}
              <div className="rounded-2xl border border-line/70 bg-content2/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-brand" />
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                      2. Container & Pack Quantity Distribution
                    </h4>
                  </div>
                  {!draftMatches && (
                    <button
                      type="button"
                      onClick={() => setDraftPacks(greedyWithPart(activeDraftHierarchy, currentTarget))}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"
                    >
                      <Sparkles size={12} /> Auto-fill {fmtQty(currentTarget)} {uom ?? "units"}
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted">
                  Specify counts of full outer containers, boxes, or loose pieces to meet the required batch total.
                </p>
                <PackBreakdownEditor usage="PURCHASE"
                  hierarchy={activeDraftHierarchy}
                  value={draftPacks}
                  uom={uom}
                  allowAutoFill={false}
                  onChange={setDraftPacks}
                />
                <PacksNeeded hierarchy={activeDraftHierarchy} qty={currentTarget} uom={uom} />
              </div>

              {/* 3. Live Brain-Feeding Reconciliation Status */}
              <div className={`flex items-start gap-3 rounded-2xl border p-3.5 text-xs transition-all ${
                draftMatches
                  ? "border-emerald-300/80 bg-emerald-50/80 text-emerald-900"
                  : draftPackedTotal < currentTarget
                  ? "border-amber-300/80 bg-amber-50/80 text-amber-900"
                  : "border-red-300/80 bg-red-50/80 text-red-900"
              }`}>
                {draftMatches ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : draftPackedTotal < currentTarget ? (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                )}
                <div className="space-y-0.5 leading-relaxed">
                  <div className="font-bold">
                    {draftMatches
                      ? `100% Fully Allocated (${fmtQty(draftPackedTotal)} of ${fmtQty(currentTarget)} ${uom ?? "units"})`
                      : draftPackedTotal < currentTarget
                      ? `Under-Allocated by ${fmtQty(draftDiff)} ${uom ?? "units"}`
                      : `Over-Allocated by ${fmtQty(draftDiff)} ${uom ?? "units"}`}
                  </div>
                  <div className="text-[11px] opacity-90">
                    {draftMatches
                      ? "The container packaging distribution perfectly accounts for the entire batch dispatch quantity."
                      : draftPackedTotal < currentTarget
                      ? `Only ${fmtQty(draftPackedTotal)} ${uom ?? "units"} are packed. Add ${fmtQty(draftDiff)} more units in full packs, partial packs, or loose items.`
                      : `Total packaging sum is ${fmtQty(draftPackedTotal)} ${uom ?? "units"}. Please reduce pack counts by ${fmtQty(draftDiff)} units.`}
                  </div>
                </div>
              </div>

              {/* 4. Buyer Justification Departure Banner (when packaging hierarchy is changed) */}
              {isDraftDifferent && (
                <div className="space-y-2 rounded-2xl border border-amber-300 bg-amber-50/90 p-3.5">
                  <p className="flex items-start gap-2 text-xs text-amber-900 leading-relaxed">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                    <span>
                      The buyer ordered in <b>{orderedHierarchy?.name ?? "Buyer Requested Hierarchy"}</b>;
                      you are dispatching in <b>{activeDraftHierarchy.name}</b>. The buyer is asked to accept
                      this packaging variation upon receiving.
                    </span>
                  </p>
                  <Field label="Why the packaging changed (visible to buyer)" required>
                    <Textarea
                      value={draftReason}
                      minRows={2}
                      placeholder="e.g. Standard cartons temporarily unavailable; dispatched in 15-pack boxes with buyer alignment."
                      onChange={(e) => setDraftReason(e.target.value)}
                    />
                  </Field>
                </div>
              )}

              {/* Helpful Guidance Notice */}
              <div className="flex items-center gap-2 rounded-xl bg-neutral-bg/60 px-3.5 py-2.5 text-[11px] text-muted">
                <Info className="h-4 w-4 shrink-0 text-muted" />
                <span>
                  The dispatch quantity is {fmtQty(currentTarget)} {uom ?? ""} — packaging describes how it is boxed and shipped.
                </span>
              </div>
            </ModalBody>

            <ModalFooter className="flex items-center justify-end gap-2 border-t border-line/70 bg-content2/30 px-6 py-3.5">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-content2 transition-all cursor-pointer"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
              <button
                type="button"
                disabled={!draftMatches || (isDraftDifferent && !draftReason.trim())}
                onClick={handleApplyPackaging}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                <Check className="h-4 w-4" /> Apply Packaging
              </button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </div>
  );
}

/**
 * Helper displaying how many containers the target quantity needs in this hierarchy.
 */
function PacksNeeded({ hierarchy, qty, uom }: {
  hierarchy: PackHierarchy; qty: number; uom?: string | null;
}) {
  const levels = hierarchy.levels.filter((lv) => lv.level > 0 && Number(lv.size) > 0)
    .sort((a, b) => a.level - b.level);
  if (!levels.length || qty <= 0) return null;
  const unit = uom ?? hierarchy.base_uom ?? "units";
  return (
    <div className="rounded-xl border border-line bg-content1 px-3 py-2 text-xs text-ink-700">
      <span className="font-semibold">{fmtQty(qty)} {unit} needs</span>{" "}
      {levels.map((lv, i) => (
        <span key={lv.level} className="tabular">
          {i > 0 && " · "}
          <b>{fmtQty(Math.ceil(qty / Number(lv.size)))} {lv.name}</b>{" "}
          ({fmtQty(lv.size)} {unit} each)
        </span>
      ))}
    </div>
  );
}
