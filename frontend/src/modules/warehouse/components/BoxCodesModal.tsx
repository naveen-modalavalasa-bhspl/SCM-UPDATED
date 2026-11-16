import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Box, Check, Package, ScanLine, Sparkles, X } from "lucide-react";
import { Button } from "@/shared/components";
import { issueBoxSources } from "../api";
import type { BoxSource } from "../types";
import { fmtQty } from "../format";

/**
 * The box codes of one issue line (2026-10-26).
 *
 * An item issued in a container names BOXES — one code per box — so this lists the
 * boxes standing at the line's own batch and location, fullest first, with what each
 * holds and who holds it. Ticking boxes names them in order: whole boxes while the
 * quantity lasts, the last one taken in part. A scanned code works too, and an OLD
 * per-piece label finds the box its piece now sits in (resolved on save). With nothing
 * ticked the server chooses — an exact fill, then whole boxes, then the smallest box
 * that covers the rest.
 */
export function BoxCodesModal({
  open, onClose, onSave, itemLabel, warehouseId, itemId, batchId, binId, issueId,
  quantity, initial, readOnly = false, uom,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (codes: string[]) => void;
  itemLabel: string;
  warehouseId?: number | null;
  itemId?: number | null;
  batchId?: number | null;
  binId?: number | null;
  issueId?: number | null;
  quantity: number;
  initial: string[];
  readOnly?: boolean;
  uom?: string | null;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [scan, setScan] = useState("");
  useEffect(() => {
    if (open) {
      setPicked(initial);
      setScan("");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources = useQuery({
    queryKey: ["issue-box-sources", warehouseId, itemId, batchId, binId, issueId],
    queryFn: () => issueBoxSources({
      warehouse_id: Number(warehouseId), item_id: Number(itemId),
      batch_id: batchId || undefined, bin_id: binId || undefined,
      issue_id: issueId || undefined,
    }),
    enabled: open && !!warehouseId && !!itemId,
  });
  const boxes = sources.data ?? [];
  const byCode = useMemo(() => new Map(boxes.map((b) => [b.code, b])), [boxes]);
  const packName = boxes[0]?.pack_name ?? "box";

  // What the ticked boxes give, in order: whole while the quantity lasts, the last
  // one in part — exactly how the server holds them.
  const plan = useMemo(() => {
    let rest = quantity;
    return picked.map((code) => {
      const box = byCode.get(code);
      const take = box ? Math.max(0, Math.min(box.holds, rest)) : 0;
      rest -= take;
      return { code, box, take };
    });
  }, [picked, byCode, quantity]);
  const covered = plan.reduce((sum, row) => sum + row.take, 0);
  const unknown = plan.filter((row) => !row.box).length;
  const pct = quantity > 0 ? Math.min(100, Math.round((covered / quantity) * 100)) : 0;

  const toggle = (box: BoxSource) => {
    if (readOnly || (box.held_by && !box.held_by_this_issue)) return;
    setPicked((now) => now.includes(box.code)
      ? now.filter((c) => c !== box.code) : [...now, box.code]);
  };
  const addScan = () => {
    const code = scan.trim();
    if (code && !picked.includes(code)) setPicked((now) => [...now, code]);
    setScan("");
  };

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="2xl"
           scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Box className="h-4 w-4 text-brand" aria-hidden /> {packName} codes
          </span>
          <span className="text-xs font-normal text-muted">
            {itemLabel} · issued in {packName.toLowerCase()} — one code per {packName.toLowerCase()}
          </span>
        </ModalHeader>
        <ModalBody className="gap-4">
          {/* --- how far the ticked boxes go --- */}
          <div className="rounded-xl border border-line bg-content2/50 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-ink-700">
                {picked.length
                  ? <><b className="text-ink">{fmtQty(covered)}</b> of {fmtQty(quantity)} {uom ?? ""} covered
                      by <b className="text-ink">{picked.length}</b> {packName.toLowerCase()}{picked.length === 1 ? "" : "es"}</>
                  : <>Nothing ticked — the {packName.toLowerCase()}es are <b className="text-ink">chosen for you</b> on save</>}
              </span>
              {unknown > 0 && (
                <span className="text-xs text-muted">{unknown} scanned code{unknown === 1 ? "" : "s"} checked on save</span>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-content1">
              <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-ok" : "bg-brand"}`}
                   style={{ width: `${picked.length ? pct : 0}%` }} />
            </div>
          </div>

          {!readOnly && (
            <div className="flex gap-2">
              <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
                <ScanLine className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <input
                  value={scan}
                  onChange={(e) => setScan(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScan(); } }}
                  placeholder={`Scan a ${packName.toLowerCase()} code — an old piece label works too`}
                  aria-label="Scan a box code"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <Button variant="subtle" onClick={addScan} disabled={!scan.trim()}>Add</Button>
            </div>
          )}

          {/* --- the boxes standing here --- */}
          {sources.isLoading ? (
            <p className="py-6 text-center text-sm text-muted">Reading the shelf…</p>
          ) : boxes.length === 0 ? (
            <div className="grid place-items-center rounded-xl border border-dashed border-line px-4 py-8 text-center">
              <Package className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 text-sm text-muted">No {packName.toLowerCase()}es of this item at this batch and location.</p>
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {boxes.map((box) => {
                const order = picked.indexOf(box.code);
                const on = order >= 0;
                const other = !!box.held_by && !box.held_by_this_issue;
                const take = on ? plan[order]?.take ?? 0 : 0;
                const fill = box.size > 0 ? Math.round((box.holds / box.size) * 100) : 100;
                return (
                  <li key={box.id}>
                    <button
                      type="button"
                      onClick={() => toggle(box)}
                      disabled={readOnly || other}
                      aria-pressed={on}
                      className={`group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                        on ? "border-brand bg-brand/[0.06]"
                          : other ? "cursor-not-allowed border-line bg-content2/40 opacity-60"
                          : "border-line bg-content1 hover:border-brand/60"}`}
                    >
                      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${
                        on ? "border-brand bg-brand text-white" : "border-line text-transparent"}`}>
                        {on ? order + 1 : <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="mono block truncate text-[13px] font-semibold text-ink" title={box.code}>
                          {box.code}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                          <span className="h-1 w-16 overflow-hidden rounded-full bg-content2">
                            <span className="block h-full rounded-full bg-brand/70" style={{ width: `${fill}%` }} />
                          </span>
                          holds {fmtQty(box.holds)} of {fmtQty(box.size)}
                          {box.part && <span className="rounded bg-warn-bg px-1.5 font-semibold text-warn">Part</span>}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted">
                          {[box.batch_no && `Batch ${box.batch_no}`, box.bin_code].filter(Boolean).join(" · ")}
                        </span>
                        {on && take > 0 && take < box.holds && (
                          <span className="mt-1 block text-[11px] font-semibold text-brand">
                            Gives {fmtQty(take)} — leaves as a new part {packName.toLowerCase()} with its own code
                          </span>
                        )}
                        {other && (
                          <span className="mt-1 block text-[11px] font-semibold text-warn">Held by {box.held_by}</span>
                        )}
                        {box.held_by_this_issue && !on && (
                          <span className="mt-1 block text-[11px] text-muted">Held by this issue</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {plan.some((row) => !row.box) && (
            <div className="flex flex-wrap gap-1.5">
              {plan.filter((row) => !row.box).map((row) => (
                <span key={row.code} className="mono inline-flex items-center gap-1 rounded-full border border-line bg-content2 px-2.5 py-1 text-[11px] text-ink-700">
                  {row.code}
                  {!readOnly && (
                    <button type="button" aria-label={`Remove ${row.code}`}
                            onClick={() => setPicked((now) => now.filter((c) => c !== row.code))}
                            className="text-muted hover:text-bad">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-between gap-2">
          {!readOnly ? (
            <Button variant="ghost" onClick={() => setPicked([])} disabled={!picked.length}>
              <Sparkles size={14} /> Choose for me
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (
              <Button onClick={() => { onSave(picked); onClose(); }}>
                <Check size={14} /> Use these
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
