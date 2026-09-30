import { useState, type ComponentType } from "react";
import {
  ArrowRight, Boxes, Check, ChevronDown, Copy, FileText, Layers, MapPin, Package, Truck, Warehouse,
} from "lucide-react";
import { StatusPill } from "@/shared/components";
import { fmtQty } from "../format";

/** One material issue in the consignment. */
export interface ConsignmentIssue {
  issue_no: string;
  indent_nos: string[];
  qty: number;
}

/**
 * `BHS/104/2026-27/WHI0036` → [`BHS/104/2026-27/`, `WHI0036`]. The tail is the part
 * that differs between two issues in one consignment, so it is the part drawn in bold; the
 * head stays on screen, quieter, so the full number is still readable and copyable.
 */
const splitNo = (no: string): [string, string] => {
  const cut = no.lastIndexOf("/");
  return cut < 0 ? ["", no] : [no.slice(0, cut + 1), no.slice(cut + 1)];
};

interface Props {
  dispatchNo: string;
  status: string;
  from?: string | null;
  to?: string | null;
  sac?: string | null;
  /** Every material issue the consignment carries, with its share of the load. */
  issues: ConsignmentIssue[];
  packages?: number | null;
  quantity?: number | null;
}

/**
 * The consignment at a glance: the number the driver's paper carries, where it goes,
 * and how much of it there is. Laid out like a shipping label, because the number is
 * what a storekeeper reads out and copies, so it is the largest thing here and one
 * press puts it on the clipboard.
 */
export function ConsignmentIdentityCard({
  dispatchNo, status, from, to, sac, issues, packages, quantity,
}: Props) {
  // Closed by default: the count above already answers "how many", and the preview
  // line names them, so the list is there for the one who wants the detail.
  const [open, setOpen] = useState(false);
  const loadQty = issues.reduce((sum, issue) => sum + issue.qty, 0);
  // Share of the consignment; equal slices when no quantity is known, so the bar still draws.
  const share = (issue: ConsignmentIssue) =>
    loadQty > 0 ? (issue.qty / loadQty) * 100 : 100 / issues.length;
  return (
    <section className="relative mb-5 overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      <span className="absolute inset-y-0 left-0 w-1 bg-brand" aria-hidden />

      <div className="bg-gradient-to-br from-brand-050 via-content1 to-content1 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-md shadow-brand/25">
              <Truck className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brand">Consignment no</div>
              <div className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-lg font-bold text-ink sm:text-xl">{dispatchNo}</span>
                <CopyButton text={dispatchNo} />
              </div>
            </div>
          </div>
          <StatusPill status={status} />
        </div>

        <RouteLine from={from} to={to} toHint={sac ? `SAC ${sac}` : undefined} className="mt-5" />
      </div>

      <div className="grid grid-cols-3 divide-x divide-line border-t border-line">
        <Stat icon={FileText} label={issues.length === 1 ? "Material issue" : "Material issues"} value={issues.length} />
        <Stat icon={Package} label={packages === 1 ? "Package" : "Packages"} value={packages ?? 0} />
        <Stat icon={Boxes} label="Quantity" value={fmtQty(quantity ?? 0)} />
      </div>

      {/* What is bundled here: one row per issue, the full number with its telling
          part in bold, the indent behind it, and a bar for its share of the load —
          one statement of each issue, in the page's own colour. */}
      {issues.length > 0 && (
        <div className="border-t border-line">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="group flex min-h-12 w-full items-center gap-3 px-5 py-2.5 text-left transition hover:bg-brand-050/40 sm:px-6"
          >
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              <Layers className="h-3.5 w-3.5 text-brand" aria-hidden /> Bundled together
            </span>
            {/* The preview: every issue by its telling part, so the closed row already
                says which ones are on board. */}
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-ink">
              {issues.map((issue) => splitNo(issue.issue_no)[1]).join(" · ")}
            </span>
            {issues.length > 1 && (
              <span className="hidden shrink-0 text-[11px] tabular text-muted sm:inline">
                {fmtQty(loadQty)} total
              </span>
            )}
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition ${
              open ? "bg-brand text-white" : "bg-brand-050 text-brand group-hover:bg-brand group-hover:text-white"
            }`}>
              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
            </span>
          </button>
          {open && (
            <ul className="divide-y divide-line/60 border-t border-line/60 px-5 pb-1 sm:px-6">
              {issues.map((issue) => {
                const [head, tail] = splitNo(issue.issue_no);
                const pct = share(issue);
                return (
                  <li
                    key={issue.issue_no}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs" title={issue.issue_no}>
                        <span className="text-muted">{head}</span>
                        <span className="font-bold text-ink">{tail}</span>
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {issue.indent_nos.length ? `Indent ${issue.indent_nos.join(", ")}` : "No indent"}
                      </div>
                    </div>
                    {/* The bar sits in its own column on a wide screen, and drops under
                        the number on a phone, so it is never squeezed to nothing. */}
                    <div
                      className="order-last col-span-2 h-1.5 overflow-hidden rounded-full bg-brand-050 sm:order-none sm:col-span-1"
                      aria-hidden
                    >
                      {issues.length > 1 && (
                        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold tabular text-ink">{fmtQty(issue.qty)}</div>
                      {issues.length > 1 && (
                        <div className="text-[11px] tabular text-muted">{Math.round(pct)}%</div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * From → To as a journey: two stops joined by a dashed road. Shared with the
 * multiple-issue panel so a route reads the same wherever it is drawn.
 */
export function RouteLine({ from, to, toHint, className = "" }: {
  from?: string | null;
  to?: string | null;
  toHint?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-center ${className}`}>
      <Stop icon={Warehouse} label="From" name={from || "—"} />
      <div className="hidden min-w-12 flex-1 items-center sm:flex" aria-hidden>
        <span className="flex-1 border-t-2 border-dashed border-brand/30" />
        <span className="mx-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-content1 text-brand shadow-sm ring-1 ring-brand/20">
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 border-t-2 border-dashed border-brand/30" />
      </div>
      <Stop icon={MapPin} label="To" name={to || "Set by the first issue"} hint={toHint} strong />
    </div>
  );
}

function Stop({ icon: Icon, label, name, hint, strong }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  name: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 sm:max-w-[42%]">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${
        strong ? "bg-brand-050 text-brand ring-brand/20" : "bg-content1 text-muted ring-line"
      }`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</div>
        <div className={`truncate text-sm ${strong ? "font-bold text-ink" : "font-medium text-body"}`} title={name}>
          {name}
        </div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3.5 sm:px-6">
      <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-content2 text-muted sm:flex">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="font-display text-lg font-bold leading-tight tabular text-ink">{value}</div>
        <div className="truncate text-[11px] text-muted">{label}</div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // No clipboard outside a secure context (plain http on the LAN): say nothing
    // rather than claim a copy that never happened.
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy consignment number"}
      title={copied ? "Copied" : "Copy"}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-content2 hover:text-brand"
    >
      {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}
