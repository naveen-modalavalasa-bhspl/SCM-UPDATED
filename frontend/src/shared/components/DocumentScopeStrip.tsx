import { Building2, CalendarRange, FolderKanban, Hash } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * Where a document nobody fills a card for got its number from: a quotation, a change
 * request or a despatch note copies everything from the document before. Read-only, and
 * says nothing on a document older than organisations.
 */
export function DocumentScopeStrip({ doc, number, className = "" }: {
  doc: {
    organization_name?: string | null; project_name?: string | null;
    org_department_name?: string | null; fiscal_year?: string | null;
  };
  number?: string | null;
  className?: string;
}) {
  if (!doc.organization_name) return null;
  const scope = doc.project_name ?? doc.org_department_name;
  const chip = (Icon: ComponentType<{ className?: string }>, title: string, value: ReactNode) => (
    <div className="flex min-w-0 items-center gap-2">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-content1 text-brand ring-1 ring-line">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{title}</span>
        <span className="block truncate text-sm font-semibold text-ink">{value}</span>
      </span>
    </div>
  );
  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-gradient-to-r from-brand-050/70 to-surface-2/50 px-3.5 py-2.5 ${className}`}>
      {number && chip(Hash, "Number", <span className="font-mono">{number}</span>)}
      {chip(Building2, "Organisation", doc.organization_name)}
      {scope && chip(FolderKanban, doc.project_name ? "Project" : "Department", scope)}
      {doc.fiscal_year && chip(CalendarRange, "Financial year", doc.fiscal_year)}
    </div>
  );
}
