import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Right-anchored detail sheet.
 *
 * Detail used to open in a centred modal, which forced every field into a narrow
 * column and pushed the actions off-screen. A sheet keeps the list visible behind it
 * and gives the record a full-height column to breathe in. HeroUI 2.8 has no Drawer,
 * and a fixed panel is ~40 lines — not worth a dependency.
 */
export function DetailSheet({
  open, onClose, title, subtitle, badge, footer, children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        aria-label="Close details"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="relative flex h-full w-full max-w-[540px] flex-col border-l border-line bg-content1 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line/70 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-lg font-bold text-ink">{title}</h2>
              {badge}
            </div>
            {subtitle && <p className="mt-0.5 truncate font-mono text-xs text-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-content2 hover:text-ink"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line/70 px-5 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}

/** Label/value row used inside a sheet. Keeps every detail screen aligned the same. */
export function SheetRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/50 py-2 last:border-0">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="text-right text-sm font-medium text-ink">{value ?? "—"}</span>
    </div>
  );
}

/** Section heading inside a sheet. */
export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">{title}</h3>
      {children}
    </section>
  );
}
