import {
  ArrowLeftRight, Building2, Car, ClipboardList, FolderKanban, Lock, MapPin, PackageOpen,
  Phone, Truck, UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TransferContext } from "../types";

/**
 * What a consignment, a dispatch and an in-person handover inherit from the material
 * issue behind them (2026-10-29): the STR / STO number, where it goes, the department
 * and project, who it is issued to, the SAC and the vehicle. Served by
 * `GET /issues/{id}/transfer-context` (or the consignment's), never retyped — each fact
 * was decided once, on the issue, and is shown here locked.
 */
const KIND: Record<TransferContext["kind"], { label: string; icon: LucideIcon; tone: string }> = {
  STR: { label: "STR", icon: ArrowLeftRight, tone: "bg-info-bg text-info" },
  STO: { label: "STO", icon: Truck, tone: "bg-brand/10 text-brand" },
  INDENT: { label: "Indent", icon: ClipboardList, tone: "bg-ok-bg text-ok" },
  DIRECT: { label: "Direct", icon: PackageOpen, tone: "bg-warn-bg text-warn" },
};

function Fact({ icon: Icon, label, value, sub, wide }: {
  icon: LucideIcon; label: string; value?: string | null; sub?: string | null; wide?: boolean;
}) {
  return (
    <div className={`flex min-w-0 items-start gap-2.5 rounded-xl border border-line/70 bg-content1 px-3 py-2.5 ${wide ? "sm:col-span-2" : ""}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
        <p className={`truncate text-sm font-semibold ${value ? "text-ink" : "text-muted"}`}
           title={value ?? undefined}>
          {value || "—"}
        </p>
        {sub && <p className="truncate text-xs text-muted" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

export function TransferContextStrip({ context, title = "Carried from the material issue" }: {
  context: TransferContext;
  title?: string;
}) {
  const kind = KIND[context.kind] ?? KIND.DIRECT;
  const KindIcon = kind.icon;
  const person = [context.issued_to_code, context.issued_to_phone].filter(Boolean).join(" · ");
  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-content2/70 via-content1 to-content1 shadow-sm"
             aria-label="Transfer details">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${kind.tone}`}>
          <KindIcon className="h-3.5 w-3.5" aria-hidden /> {kind.label}
        </span>
        <span className="font-mono text-sm font-bold text-ink">{context.reference_no ?? context.issue_no}</span>
        {context.kind === "STO" && context.str_no && (
          <span className="rounded-full bg-info-bg px-2 py-0.5 text-[11px] font-semibold text-info">
            STR <span className="font-mono">{context.str_no}</span>
          </span>
        )}
        {context.kind === "STR" && context.sto_no && (
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
            STO <span className="font-mono">{context.sto_no}</span>
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {title} <span className="font-mono font-semibold text-ink-700">{context.issue_no}</span>
        </span>
      </header>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact icon={MapPin} label="Destination" wide
              value={context.destination_warehouse_name ?? context.destination_office_name}
              sub={context.destination_warehouse_name && context.destination_office_name
                && context.destination_office_name !== context.destination_warehouse_name
                ? context.destination_office_name : null} />
        <Fact icon={UserRound} label="Issued to" wide value={context.issued_to_name}
              sub={person || null} />
        <Fact icon={Building2} label="Department" value={context.department_name} />
        <Fact icon={FolderKanban} label="Project" value={context.project_name} />
        <Fact icon={Phone} label="Service area code" value={context.sac} />
        <Fact icon={Car} label="Vehicle" value={context.vehicle_number} />
      </div>
    </section>
  );
}
