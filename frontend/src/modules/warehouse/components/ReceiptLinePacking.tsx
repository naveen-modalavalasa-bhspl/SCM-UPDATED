import { useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertTriangle, Ban, Boxes, Check, CheckCircle2, Clock, Eye, Layers, Lock, PackageCheck, X,
} from "lucide-react";
import {
  type PackEntry, type PackHierarchy, PackBreakdownEditor, PackChips, PackHierarchyPicker,
  baseOf, countsOf, fmtQty, greedy, hierarchyOf,
} from "@/shared/packing";
import type { ReceiptItemWrite } from "../types";

/**
 * Packing at the gate (2026-10-08), behind one press (2026-10-21).
 *
 * With a despatch note behind the line, the supplier's packing is DECLARED and fixed:
 * the storekeeper counts against it — each level at most what was sent, never a level
 * that was not. The received quantity is the count's total, so a missing box is a
 * shortage the GRN records, not a typo the GRN absorbs.
 *
 * Without one, the storekeeper states the packing directly in the order's hierarchy
 * (or any of the item's), and the count is still the quantity.
 *
 * The line carries a one-row summary — what was sent, what was counted, the buyer's
 * answer on a changed packing — and the editor opens in a popup, as it does on the
 * supplier's despatch note. Drawn inline it was a panel per line, and a delivery of
 * eight lines was eight panels deep before anybody reached Save.
 */
type Draft = { hierarchyId: number | null; packs: PackEntry[] | null };

export function ReceiptLinePacking({ line, lineNo, hierarchies, locked, onChange }: {
  line: ReceiptItemWrite;
  /** 1-based, for the popup's title — "Line 4" is how the grid names it. */
  lineNo?: number;
  hierarchies: PackHierarchy[];
  locked?: boolean;
  onChange: (patch: Partial<ReceiptItemWrite>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const declared = line.declared_pack_breakdown ?? null;
  const declaredName = hierarchyOf(declared);
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === line.pack_hierarchy_id)
    ?? hierarchies.find((h) => h.name === declaredName) ?? hierarchies[0];
  if (!hierarchy) return null;

  const uom = line.uom_code ?? hierarchy.base_uom ?? "units";
  const counted = line.pack_breakdown ?? null;
  const countedTotal = baseOf(counted);
  const declaredTotal = baseOf(declared);
  const short = declared ? Math.max(declaredTotal - countedTotal, 0) : 0;
  const status = line.pack_change_status;

  const openEditor = () => {
    setDraft({ hierarchyId: hierarchy.hierarchy_id, packs: counted });
    setOpen(true);
  };
  const apply = () => {
    if (!draft) return;
    const total = baseOf(draft.packs);
    onChange({ pack_hierarchy_id: draft.hierarchyId, pack_breakdown: draft.packs,
               received_qty: total, accepted_qty: total });
    setOpen(false);
  };

  return (
    <>
      {/* ── The summary on the line ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line/70 bg-content2/40 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-700">
          <Boxes className="h-3.5 w-3.5 text-brand" aria-hidden /> Packs
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-neutral-bg px-2 py-0.5 text-[11px] font-semibold text-ink-700 ring-1 ring-line">
          <Layers className="h-3 w-3" aria-hidden /> {hierarchy.name}
        </span>
        {counted?.length
          ? <PackChips entries={counted} uom={uom} showHierarchy={false} />
          : <span className="text-xs font-medium text-warn">Not counted yet</span>}
        {declared && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted"
                title="From the supplier's despatch note — fixed at the gate">
            <Lock className="h-3 w-3" aria-hidden /> Supplier sent {fmtQty(declaredTotal)} {uom}
          </span>
        )}
        <ChangePill status={status} />
        {short > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
            <AlertTriangle className="h-3 w-3" aria-hidden /> Short {fmtQty(short)} {uom}
          </span>
        )}
        <button
          type="button"
          onClick={openEditor}
          className="group ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-050/60 px-2.5 py-1 text-xs font-semibold text-brand transition-all hover:border-brand hover:bg-brand hover:text-white active:scale-95"
        >
          {locked
            ? <><Eye className="h-3.5 w-3.5" aria-hidden /> View packs</>
            : <><Boxes className="h-3.5 w-3.5 transition-transform group-hover:scale-110" aria-hidden />
                {counted?.length ? "Recount packs" : "Count packs"}</>}
        </button>
      </div>

      {/* ── The popup ───────────────────────────────────────────────────────── */}
      {open && draft && (
        <PackCountModal
          line={line} lineNo={lineNo} hierarchies={hierarchies} locked={locked}
          uom={uom} declared={declared} declaredName={declaredName} draft={draft}
          setDraft={setDraft} onApply={apply} onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PackCountModal({
  line, lineNo, hierarchies, locked, uom, declared, declaredName, draft, setDraft, onApply, onClose,
}: {
  line: ReceiptItemWrite;
  lineNo?: number;
  hierarchies: PackHierarchy[];
  locked?: boolean;
  uom: string;
  declared: PackEntry[] | null;
  declaredName?: string;
  draft: Draft;
  setDraft: (next: Draft) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const hierarchy = hierarchies.find((h) => h.hierarchy_id === draft.hierarchyId) ?? hierarchies[0];
  const limits = declared ? countsOf(declared) : null;
  const counted = baseOf(draft.packs);
  const sent = baseOf(declared);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="2xl"
      backdrop="blur"
      scrollBehavior="inside"
      classNames={{
        base: "rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden",
        backdrop: "bg-black/50 backdrop-blur-sm",
      }}
    >
      <ModalContent>
        <div className="h-1.5 w-full bg-gradient-to-r from-brand via-violet-500 to-indigo-600" />
        <ModalHeader className="flex items-start gap-3.5 border-b border-line/60 px-6 pb-3 pt-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-050 text-brand ring-1 ring-brand/20">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-base font-bold text-ink">
              {locked ? "Packs received" : "Count the packs that arrived"}
            </h3>
            <p className="truncate text-xs font-normal text-muted">
              {lineNo ? <b className="font-semibold text-ink">Line {lineNo}</b> : null}
              {lineNo ? " · " : ""}
              <span className="font-semibold text-ink">{line.item_name ?? "Item"}</span>
              {line.item_code ? ` · ${line.item_code}` : ""}
              {line.batch_no ? ` · Batch ${line.batch_no}` : ""}
            </p>
          </div>
        </ModalHeader>

        <ModalBody className="space-y-4 px-6 py-4">
          <ChangeBanner line={line} declaredName={declaredName} />

          {/* 1. Which packing */}
          <div className="space-y-2 rounded-2xl border border-line/70 bg-content2/30 p-4">
            <StepTitle n={1} icon={<Layers className="h-4 w-4 text-brand" />}>
              How it is packed
            </StepTitle>
            {declared ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-ink-700">
                    <Lock className="h-3.5 w-3.5" aria-hidden /> Supplier sent
                  </span>
                  <PackChips entries={declared} uom={uom} muted />
                </div>
                <p className="text-xs text-muted">
                  From the supplier's despatch note, so the packing is fixed. Count each
                  level — never more than was sent.
                </p>
              </div>
            ) : hierarchies.length > 1 && !locked && !line.pack_hierarchy_id ? (
              /* Only a line with no packing yet chooses one. Once it has a hierarchy
                 the count stays in it (2026-10-21): the received quantity is re-said
                 as its packs, and a box of 20 does not become a box of 10 at the gate. */
              <PackHierarchyPicker
                hierarchies={hierarchies}
                value={hierarchy.hierarchy_id}
                uom={uom}
                onChange={(id) => {
                  const next = hierarchies.find((h) => h.hierarchy_id === id);
                  if (next) setDraft({
                    hierarchyId: id,
                    packs: greedy(next, counted || Number(line.received_qty) || 0),
                  });
                }}
              />
            ) : (
              <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Layers className="h-4 w-4 text-muted" aria-hidden /> {hierarchy.name}
              </p>
            )}
          </div>

          {/* 2. What is here */}
          <div className="space-y-3 rounded-2xl border border-line/70 bg-content2/30 p-4">
            <StepTitle n={2} icon={<PackageCheck className="h-4 w-4 text-brand" />}>
              {locked ? "Counted at the gate" : "What is physically here"}
            </StepTitle>
            {locked ? (
              <PackChips entries={draft.packs} uom={uom} />
            ) : (
              <PackBreakdownEditor
                hierarchy={hierarchy}
                value={draft.packs}
                uom={uom}
                limits={limits}
                onlyLevels={declared ? [...Object.keys(limits ?? {}).map(Number), 0] : undefined}
                allowAutoFill={false}
                onChange={(packs) => setDraft({ ...draft, packs })}
              />
            )}
          </div>

          {/* 3. The answer */}
          <Reconciliation counted={counted} sent={declared ? sent : null} uom={uom} />
        </ModalBody>

        <ModalFooter className="flex items-center justify-end gap-2 border-t border-line/70 bg-content2/30 px-6 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-ink-700 transition-all hover:bg-content2"
          >
            <X className="h-4 w-4" /> {locked ? "Close" : "Cancel"}
          </button>
          {!locked && (
            <button
              type="button"
              onClick={onApply}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand/90"
            >
              <Check className="h-4 w-4" /> Use this count · {fmtQty(counted)} {uom}
            </button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function StepTitle({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
        {n}. {children}
      </h4>
    </div>
  );
}

/** Counted against what the note says was sent — the sentence the storekeeper needs
 *  before pressing, not after the GRN has recorded it. */
function Reconciliation({ counted, sent, uom }: { counted: number; sent: number | null; uom: string }) {
  if (sent === null) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-line/70 bg-content2/30 p-3.5 text-xs text-ink-700">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <span>
          <b>{fmtQty(counted)} {uom}</b> counted — this becomes the line's received quantity.
        </span>
      </div>
    );
  }
  const gap = sent - counted;
  const tone = gap === 0
    ? "border-ok/40 bg-ok-bg/70 text-ok"
    : "border-warn/40 bg-warn-bg/70 text-warn";
  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-3.5 text-xs ${tone}`}>
      {gap === 0
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="space-y-0.5">
        <div className="font-bold">
          {gap === 0
            ? `Matches the despatch note — ${fmtQty(counted)} ${uom}`
            : `Short of the despatch note by ${fmtQty(gap)} ${uom}`}
        </div>
        <div className="opacity-90">
          {gap === 0
            ? "Everything the supplier declared is here."
            : `Counted ${fmtQty(counted)} of the ${fmtQty(sent)} sent. The GRN records the shortage against the supplier.`}
        </div>
      </div>
    </div>
  );
}

function ChangePill({ status }: { status?: string | null }) {
  if (status === "PENDING") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
      <Clock className="h-3 w-3" aria-hidden /> Packing change · buyer yet to answer
    </span>
  );
  if (status === "DECLINED") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-bad-bg px-2 py-0.5 text-[11px] font-semibold text-bad">
      <Ban className="h-3 w-3" aria-hidden /> Packing change declined
    </span>
  );
  if (status === "ACCEPTED") return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
      <PackageCheck className="h-3 w-3" aria-hidden /> Packing change accepted
    </span>
  );
  return null;
}

function ChangeBanner({ line, declaredName }: { line: ReceiptItemWrite; declaredName?: string }) {
  const status = line.pack_change_status;
  if (!status) return null;
  const tone = status === "ACCEPTED" ? "bg-ok-bg text-ok"
    : status === "DECLINED" ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn";
  const icon = status === "ACCEPTED" ? <PackageCheck className="h-4 w-4" />
    : status === "DECLINED" ? <Ban className="h-4 w-4" /> : <Clock className="h-4 w-4" />;
  return (
    <div className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ${tone}`} role="status">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        {status === "PENDING" && <>
          The supplier changed the packing ({line.ordered_pack_hierarchy_name} → {declaredName})
          and the buyer has not answered yet.
          {line.pack_change_reason ? ` Their reason: “${line.pack_change_reason}”.` : ""}
        </>}
        {status === "DECLINED" && <>
          The buyer DECLINED this packing ({line.ordered_pack_hierarchy_name} → {declaredName})
          {line.pack_change_note ? `: “${line.pack_change_note}”` : ""}. Check with procurement
          before booking it in.
        </>}
        {status === "ACCEPTED" && <>Packing changed to {declaredName} — accepted by the buyer.</>}
      </span>
    </div>
  );
}
