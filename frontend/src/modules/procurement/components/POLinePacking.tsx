import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, Boxes, Check, CheckCircle2, Info, Layers, Package, X,
} from "lucide-react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import { Can, ErrorBanner, useToast } from "@/shared/components";
import {
  PackBreakdownEditor, PackChips, PackHierarchyPicker, baseOf, fmtQty, greedy, packable,
  toPayload, usePackOptions, type PackEntry, type PackHierarchy,
} from "@/shared/packing";
import { Button } from "./ActionButton";
import { poApi } from "../api";
import type { POItem } from "../types";

/**
 * Packing can only be changed before the order is transmitted to the external supplier:
 * - DRAFT: editable
 * - RETURNED_FOR_CORRECTION: editable by raiser
 * - APPROVED: editable ONLY if not yet sent to the supplier (vendor_status is null / not sent)
 *
 * It is FORBIDDEN / HIDDEN when:
 * - SENT_TO_VENDOR: already officially sent to the supplier
 * - ACCEPTED_BY_SUPPLIER (or vendorStatus is ACCEPTED/PENDING/REJECTED)
 * - PENDING_APPROVAL / SUBMITTED: locked in active approval queue
 * - PARTIALLY_RECEIVED, RECEIVED, CLOSED, CANCELLED, REJECTED
 */
export function canEditLinePacking(poStatus: string, vendorStatus?: string | null): boolean {
  if (vendorStatus && ["PENDING", "ACCEPTED", "REJECTED"].includes(vendorStatus.toUpperCase())) {
    return false;
  }
  const status = (poStatus ?? "").toUpperCase();
  if (["DRAFT", "RETURNED_FOR_CORRECTION"].includes(status)) {
    return true;
  }
  if (status === "APPROVED") {
    return !vendorStatus;
  }
  return false;
}

/**
 * A PO line's packing, with the means to change it in a dedicated popup modal:
 * the packaging hierarchy, the level breakdown, and container distribution.
 *
 * Packing DESCRIBES the ordered quantity and never alters it — at any status, draft
 * included. Picking another hierarchy re-packs the same quantity, and the screen says
 * how many packs of each level that quantity needs.
 */
export function POLinePacking({ poId, poStatus, vendorStatus, line, showChips = true }: {
  poId: number; poStatus: string; vendorStatus?: string | null; line: POItem;
  /** Off where the quantity cell already shows the packs (`PackQty`). */
  showChips?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = usePackOptions([line.item_id]);
  const hierarchies = packable(options.data?.[line.item_id]);
  const [open, setOpen] = useState(false);
  const [hierarchyId, setHierarchyId] = useState<number | null>(null);
  const [packs, setPacks] = useState<PackEntry[] | null>(null);

  const hierarchy = hierarchies.find((h) => h.hierarchy_id === hierarchyId) ?? hierarchies[0];
  const save = useMutation({
    mutationFn: () => poApi.repackLine(poId, line.id, {
      pack_hierarchy_id: hierarchy!.hierarchy_id!, pack_breakdown: toPayload(packs),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
      toast.success("Packing configuration saved successfully.");
      setOpen(false);
    },
  });

  const start = () => {
    const current = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
      ?? hierarchies[0];
    setHierarchyId(current?.hierarchy_id ?? null);
    setPacks(line.pack_breakdown?.length && current?.hierarchy_id === line.pack_hierarchy_id
      ? line.pack_breakdown : current ? greedy(current, Number(line.quantity)) : null);
    setOpen(true);
  };

  const chips = !showChips ? null : line.pack_breakdown?.length
    ? <PackChips entries={line.pack_breakdown} uom={line.uom_code} />
    : <span className="text-xs text-muted">Not packed</span>;

  const isEditable = canEditLinePacking(poStatus, vendorStatus);

  if (!hierarchies.length || !isEditable) {
    return line.pack_breakdown?.length && chips ? <div className="mt-1">{chips}</div> : null;
  }

  const ordered = Number(line.quantity);
  const packedTotal = baseOf(packs);
  const matches = packedTotal === ordered;
  const diff = Math.abs(packedTotal - ordered);

  return (
    <div className="mt-1">
      {/* ── Table Cell Trigger (compact & non-distorting) ───────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {chips}
        <Can do="po.edit">
          <button
            type="button"
            onClick={start}
            className="group inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-050/60 px-2.5 py-1 text-xs font-semibold text-brand shadow-2xs transition-all hover:border-brand hover:bg-brand hover:text-white hover:shadow-xs"
          >
            <Boxes className="h-3.5 w-3.5 transition-transform group-hover:scale-110" aria-hidden />
            <span>Change packing</span>
          </button>
        </Can>
      </div>

      {/* ── Modal Pop-up Form ─────────────────────────────────────────── */}
      {open && hierarchy && (
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
                      Configure Line Packaging & Pack Hierarchy
                    </h3>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
                      Target: {fmtQty(ordered)} {line.uom_code ?? "units"}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    <span className="font-semibold text-ink">{line.item_name}</span>
                    {line.item_code ? ` · ${line.item_code}` : ""}
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
                  value={hierarchy.hierarchy_id}
                  uom={line.uom_code}
                  onChange={(id) => {
                    const next = hierarchies.find((h) => h.hierarchy_id === id);
                    if (!next) return;
                    setHierarchyId(id);
                    setPacks(greedy(next, ordered));
                  }}
                />
              </div>

              {/* 2. Container Quantity Breakdown Card */}
              <div className="rounded-2xl border border-line/70 bg-content2/30 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-brand" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                    2. Container & Pack Quantity Distribution
                  </h4>
                </div>
                <p className="text-xs text-muted">
                  Specify counts of full outer containers, boxes, or loose pieces to meet the required line total.
                </p>
                <PackBreakdownEditor usage="PURCHASE"
                  hierarchy={hierarchy}
                  value={packs}
                  uom={line.uom_code}
                  target={ordered}
                  enforceMin
                  onChange={setPacks}
                />
                <PacksNeeded hierarchy={hierarchy} qty={ordered} uom={line.uom_code} />
              </div>

              {/* 3. Live Brain-Feeding Reconciliation Status */}
              <div className={`flex items-start gap-3 rounded-2xl border p-3.5 text-xs transition-all ${
                matches
                  ? "border-emerald-300/80 bg-emerald-50/80 text-emerald-900"
                  : packedTotal < ordered
                  ? "border-amber-300/80 bg-amber-50/80 text-amber-900"
                  : "border-red-300/80 bg-red-50/80 text-red-900"
              }`}>
                {matches ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : packedTotal < ordered ? (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                )}
                <div className="space-y-0.5 leading-relaxed">
                  <div className="font-bold">
                    {matches
                      ? `100% Fully Allocated (${fmtQty(packedTotal)} of ${fmtQty(ordered)} ${line.uom_code ?? "units"})`
                      : packedTotal < ordered
                      ? `Under-Allocated by ${fmtQty(diff)} ${line.uom_code ?? "units"}`
                      : `Over-Allocated by ${fmtQty(diff)} ${line.uom_code ?? "units"}`}
                  </div>
                  <div className="text-[11px] opacity-90">
                    {matches
                      ? "The container packaging distribution perfectly accounts for the entire line quantity."
                      : packedTotal < ordered
                      ? `Only ${fmtQty(packedTotal)} ${line.uom_code ?? "units"} are packed. Add ${fmtQty(diff)} more units in packs or loose items.`
                      : `Total packaging sum is ${fmtQty(packedTotal)} ${line.uom_code ?? "units"}. Please reduce pack counts by ${fmtQty(diff)}.`}
                  </div>
                </div>
              </div>

              {/* Helpful Guidance Notice */}
              <div className="flex items-center gap-2 rounded-xl bg-neutral-bg/60 px-3.5 py-2.5 text-[11px] text-muted">
                <Info className="h-4 w-4 shrink-0 text-muted" />
                <span>
                  The ordered quantity stays {fmtQty(ordered)} {line.uom_code ?? ""} — packing only says how it is packed. To buy more or less, change the quantity{poStatus === "DRAFT" ? " on the order" : " by amending the order"}.
                </span>
              </div>

              <ErrorBanner error={save.error} />
            </ModalBody>

            <ModalFooter className="flex items-center justify-end gap-2 border-t border-line/70 bg-content2/30 px-6 py-3.5">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
              <Button
                disabled={!matches || save.isPending}
                onClick={() => save.mutate()}
                className="gap-1.5"
              >
                <Check className="h-4 w-4" /> {save.isPending ? "Saving..." : "Save packing"}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </div>
  );
}

/**
 * How many of each pack the ordered quantity needs in this hierarchy, rounded UP to
 * whole packs — "500 NOS needs 2 Pack (450 each) · 1 Carton (6,750 each)".
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
