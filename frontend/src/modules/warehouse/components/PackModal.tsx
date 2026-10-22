import type { ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { AlertTriangle, Boxes, Check, CheckCircle2, X } from "lucide-react";
import { fmtQty } from "@/shared/packing";

/**
 * The frame every packing popup in the warehouse is drawn in (2026-10-22) — the
 * same one as the PO's "Change packing" and the supplier's despatch note: a brand
 * bar, an icon header with what it is about, numbered sections, and the answer
 * above the footer. Plain headings only.
 */
export function PackModal({
  title, subtitle, badge, icon, onClose, children, footer, size = "2xl",
}: {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "lg" | "xl" | "2xl" | "3xl" | "4xl";
}) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      size={size}
      backdrop="blur"
      scrollBehavior="inside"
      classNames={{
        base: "rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden",
        backdrop: "bg-black/50 backdrop-blur-sm",
      }}
    >
      <ModalContent>
        <div className="h-1.5 w-full bg-gradient-to-r from-brand via-violet-500 to-indigo-600" />
        <ModalHeader className="flex items-start justify-between gap-3 border-b border-line/60 px-6 pb-3 pt-5">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-050 text-brand ring-1 ring-brand/20">
              {icon ?? <Boxes className="h-5 w-5" />}
            </div>
            <div className="min-w-0 space-y-1">
              <h3 className="text-base font-bold text-ink">{title}</h3>
              {subtitle && <div className="truncate text-xs font-normal text-muted">{subtitle}</div>}
            </div>
          </div>
          {badge}
        </ModalHeader>
        <ModalBody className="max-h-[75vh] space-y-4 overflow-y-auto px-6 py-4">{children}</ModalBody>
        {footer && (
          <ModalFooter className="flex items-center justify-end gap-2 border-t border-line/70 bg-content2/30 px-6 py-3.5">
            {footer}
          </ModalFooter>
        )}
      </ModalContent>
    </Modal>
  );
}

/** One numbered card inside a `PackModal`. */
export function PackSection({ n, title, icon, action, children }: {
  n?: number; title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-line/70 bg-content2/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
            {n ? `${n}. ` : ""}{title}
          </h4>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The packs against the quantity they must hold — green, amber or red, one line. */
export function PackBalance({ packed, target, uom }: {
  packed: number; target: number; uom?: string | null;
}) {
  const unit = uom ?? "units";
  const gap = Math.round((target - packed) * 1000) / 1000;
  const tone = gap === 0 ? "border-ok/40 bg-ok-bg/70 text-ok"
    : gap > 0 ? "border-warn/40 bg-warn-bg/70 text-warn" : "border-bad/40 bg-bad-bg/70 text-bad";
  return (
    <div className={`flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 text-xs font-bold ${tone}`}
         role="status">
      {gap === 0 ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
      {gap === 0
        ? `${fmtQty(packed)} ${unit} — matches`
        : gap > 0
          ? `${fmtQty(packed)} of ${fmtQty(target)} ${unit} — ${fmtQty(gap)} short`
          : `${fmtQty(packed)} of ${fmtQty(target)} ${unit} — ${fmtQty(-gap)} over`}
    </div>
  );
}

export function ModalCancel({ onClick, label = "Cancel" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-ink-700 transition-all hover:bg-content2">
      <X className="h-4 w-4" /> {label}
    </button>
  );
}

export function ModalConfirm({ onClick, disabled, busy, children }: {
  onClick: () => void; disabled?: boolean; busy?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50">
      <Check className="h-4 w-4" /> {busy ? "Saving…" : children}
    </button>
  );
}
