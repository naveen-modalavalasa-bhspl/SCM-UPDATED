import {
  ArrowLeftRight, ArrowRight, Building2, Car, ClipboardList, FolderKanban, Lock, MapPin,
  PackageOpen, Phone, Truck, UserRound, Warehouse,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TransferContext } from "../types";
import { scopeFact, smallFacts, tierLabel, type SmallFact } from "./transferFacts";

/**
 * What a consignment, a dispatch and an in-person handover inherit from the material
 * issue behind them (2026-10-29): the STR / STO number, where it goes, the department
 * and project, who it is issued to, the SAC and the vehicle. Served by
 * `GET /issues/{id}/transfer-context` (or the consignment's), never retyped — each fact
 * was decided once, on the issue, and is shown here locked.
 *
 * Laid out as the journey (2026-11-19): source → destination on one band, who it is
 * issued to beside it, and underneath only the facts that APPLY — project or
 * department (never both), and SAC and vehicle for an LIP only. Which ones is
 * `transferFacts.ts`; the row stretches over whatever is left, so nothing reads as a
 * gap or a box somebody forgot to fill in.
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
  const destinationName = context.destination_warehouse_name ?? context.destination_office_name;
  const destinationSub = [
    tierLabel(context.destination_warehouse_type),
    context.destination_warehouse_name && context.destination_office_name
      && context.destination_office_name !== context.destination_warehouse_name
      ? context.destination_office_name : null,
  ].filter(Boolean).join(" · ");
  const sourceSub = [tierLabel(context.from_warehouse_type), context.from_warehouse_code]
    .filter(Boolean).join(" · ");
  const scope = scopeFact(context);
  const facts = smallFacts(context);
  // One column per fact that applies, so one fact spans the row and three share it.
  const factCols: Record<number, string> = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" };

  const renderFact = (fact: SmallFact) => {
    if (fact === "scope" && scope) {
      return scope.kind === "project"
        ? <Fact key="scope" icon={FolderKanban} label="Project" value={scope.value} />
        : <Fact key="scope" icon={Building2} label="Department" value={scope.value} />;
    }
    if (fact === "sac") return <Fact key="sac" icon={Phone} label="Service area code" value={context.sac} />;
    if (fact === "vehicle") return <Fact key="vehicle" icon={Car} label="Vehicle" value={context.vehicle_number} />;
    return null;
  };

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
      <div className="space-y-2 p-3">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* The journey, both ends on one band: where it leaves from and where it
              is going. The source used to be missing from the card altogether. */}
          <div className="grid grid-cols-1 items-stretch gap-2 rounded-xl border border-line/70 bg-content1 p-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <RouteEnd icon={Warehouse} label="Source" value={context.from_warehouse_name}
                      sub={sourceSub || null} />
            <div className="hidden items-center justify-center sm:flex" aria-hidden>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-brand/10 text-brand">
                <ArrowRight className="h-4 w-4" />
              </span>
            </div>
            <RouteEnd icon={MapPin} label="Destination" value={destinationName}
                      sub={destinationSub || null} accent />
          </div>
          {/* One fact left (a project, say) sits under "Issued to" rather than
              stretching alone across a row of its own. */}
          {facts.length === 1 ? (
            <div className="grid grid-cols-1 gap-2">
              <Fact icon={UserRound} label="Issued to" value={context.issued_to_name}
                    sub={person || null} />
              {renderFact(facts[0])}
            </div>
          ) : (
            <Fact icon={UserRound} label="Issued to" value={context.issued_to_name}
                  sub={person || null} />
          )}
        </div>
        {facts.length > 1 && (
          <div className={`grid grid-cols-1 gap-2 ${factCols[facts.length] ?? "sm:grid-cols-3"}`}>
            {facts.map(renderFact)}
          </div>
        )}
      </div>
    </section>
  );
}

function RouteEnd({ icon: Icon, label, value, sub, accent }: {
  icon: LucideIcon; label: string; value?: string | null; sub?: string | null; accent?: boolean;
}) {
  return (
    <div className={`flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 ${accent ? "bg-brand/[0.04]" : ""}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${accent ? "text-brand" : "text-muted"}`} aria-hidden />
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
