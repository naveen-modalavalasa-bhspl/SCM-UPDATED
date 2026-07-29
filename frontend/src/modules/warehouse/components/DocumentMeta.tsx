import type { ReactNode } from "react";
import { Card } from "@/shared/components";

/**
 * The label/value block at the top of every warehouse document.
 *
 * Every detail screen was laying this out by hand with a different column count and
 * a different label size, so a GRN and an issue looked like two products. One grid,
 * one label treatment, one place to change it.
 */

export function MetaGrid({ children, columns = 4 }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  const cols = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  }[columns];
  return <div className={`grid grid-cols-1 gap-x-6 gap-y-4 ${cols}`}>{children}</div>;
}

export function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="truncate text-sm text-ink">{value ?? "—"}</div>
    </div>
  );
}

export function MetaCard({
  title,
  actions,
  children,
  columns = 4,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  columns?: 2 | 3 | 4;
}) {
  return (
    <Card className="mb-4 p-4 sm:p-5">
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="font-display text-base font-bold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <MetaGrid columns={columns}>{children}</MetaGrid>
    </Card>
  );
}

/** A plain titled section for form blocks that are not a label/value grid. */
export function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="mb-4 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}
