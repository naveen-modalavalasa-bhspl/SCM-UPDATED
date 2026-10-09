import { useCallback, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, FileText, Layers, Loader2, Sparkles, X } from "lucide-react";
import { Button, Field } from "@/shared/components";
import { consignmentRecommendations, issueOptions } from "../api";
import { fmtQty } from "../format";
import { Lookup } from "./Lookup";
import { RouteLine } from "./ConsignmentIdentityCard";

/** One material issue already chosen for the consignment, as the list shows it. */
export interface SelectedIssue {
  issue_id: number;
  issue_no: string;
  indent_nos: string[];
  lines: number;
  qty: number;
}

/** Where the chosen issues go. Set by the first one; every later one must match it. */
export interface IssueRoute {
  warehouseId: number;
  warehouseName?: string | null;
  destinationId?: number | null;
  destinationName?: string | null;
}

interface Props {
  selected: SelectedIssue[];
  route: IssueRoute | null;
  /** A change is being checked with the server; the list shows the last good state. */
  busy: boolean;
  /** A saved consignment: the list is shown, never changed. */
  readOnly: boolean;
  onUseSuggestion: (issueIds: number[]) => void;
  onAdd: (issueId: number) => void;
  onRemove: (issueId: number) => void;
  onClear: () => void;
}

/**
 * One column layout shared by the list's heading, every row and the total, so the
 * figures sit in one line down the page. Written out in full (never composed) because
 * Tailwind only generates classes it can read in the source.
 */
const ROW_GRID =
  "grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 " +
  "sm:grid-cols-[1.75rem_minmax(0,1.2fr)_minmax(0,1fr)_4.5rem_6.5rem_2.75rem]";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Several material issues in one consignment.
 *
 * Only issues that leave from the SAME stocking point and go to the SAME LIP/MDP can
 * share a lorry — the server refuses anything else. So the panel leads with the
 * groups the server has already found (`consignment-recommendations`), and once one
 * issue is chosen the manual picker lists only issues on that same route. Nothing
 * offered here is something the save would refuse.
 */
export function MultiIssuePanel({
  selected, route, busy, readOnly, onUseSuggestion, onAdd, onRemove, onClear,
}: Props) {
  const suggestions = useQuery({
    queryKey: ["consignment-recommendations"],
    queryFn: () => consignmentRecommendations(),
    enabled: !readOnly,
    staleTime: 30_000,
  });

  const selectedIds = useMemo(() => new Set(selected.map((row) => row.issue_id)), [selected]);
  const selectedKey = selected.map((row) => row.issue_id).join(",");
  const sameSet = (ids: number[]) =>
    ids.length === selectedIds.size && ids.every((issueId) => selectedIds.has(issueId));

  // Keyed on the route and the current choice: the Lookup caches by name, and a list
  // that still offered an issue already picked, or one bound elsewhere, would invite a
  // press the server then refuses.
  const lookupName = `posted-issues-multi:${route?.warehouseId ?? 0}:${route?.destinationId ?? 0}:${selectedKey}`;
  const loadIssues = useCallback(
    (search?: string) =>
      issueOptions(search, route
        ? { warehouse_id: route.warehouseId, destination_warehouse_id: route.destinationId }
        : undefined)
        .then((rows) => rows.filter((row) => !selectedIds.has(row.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route?.warehouseId, route?.destinationId, selectedKey],
  );
  const pick = useCallback((value: number | "") => {
    if (value !== "") onAdd(value);
  }, [onAdd]);

  const totalQty = selected.reduce((sum, row) => sum + row.qty, 0);
  const totalLines = selected.reduce((sum, row) => sum + row.lines, 0);
  const rows = suggestions.data ?? [];

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      {/* ---- Header ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-050 text-brand">
            <Layers className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-[15px] font-bold text-ink">Multiple material issues — one consignment</h2>
            <p className="mt-0.5 text-xs leading-5 text-muted">
              {readOnly
                ? "These material issues travel together in this consignment."
                : "Send several issues in one lorry — same stocking point, same LIP/MDP."}
            </p>
          </div>
        </div>
        {busy && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-content2 px-3 py-1 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
          </span>
        )}
      </div>

      <div className="space-y-6 p-5 sm:p-6">
        {/* ---- The route, stated once for the whole consignment. A saved one states
            it on the identity card above, so it is not said twice. ---- */}
        {route && !readOnly && (
          <RouteLine
            from={route.warehouseName}
            to={route.destinationName}
            className="rounded-xl border border-line bg-content2/30 p-3 sm:px-4"
          />
        )}

        {/* ---- 1. What the server suggests ---- */}
        {!readOnly && (
          <div>
            <SectionLabel icon={<Sparkles className="h-3.5 w-3.5 text-brand" />}>
              Suggested — ready to go together
            </SectionLabel>
            {suggestions.isLoading ? (
              <EmptyBox>Looking for material issues going to the same place…</EmptyBox>
            ) : rows.length === 0 ? (
              <EmptyBox>
                Nothing to combine right now — no two ready material issues are going to the same LIP/MDP.
                You can still add them one by one below.
              </EmptyBox>
            ) : (
              <div className={`grid gap-3 ${rows.length > 1 ? "lg:grid-cols-2" : ""}`}>
                {rows.map((row) => {
                  const inUse = sameSet(row.issue_ids);
                  const destination = row.destination_warehouse_name ?? row.label;
                  return (
                    <article
                      key={row.key}
                      className={`flex flex-col rounded-xl border transition ${
                        inUse
                          ? "border-ok/60 bg-ok-bg/30"
                          : "border-line bg-content1 hover:border-brand/40 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 px-4 pt-4">
                        <div className="min-w-0">
                          <div className="truncate font-display text-sm font-bold text-ink" title={row.headline}>
                            {destination}
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            <span className="truncate">{row.warehouse_name ?? "—"}</span>
                            <ArrowRight className="h-3 w-3 shrink-0" />
                            <span className="truncate">{destination}</span>
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-brand-050 px-2.5 py-0.5 text-[11px] font-semibold text-brand">
                          {plural(row.issue_ids.length, "issue")}
                        </span>
                      </div>

                      <ul className="mx-4 mt-3 divide-y divide-line/70 rounded-lg border border-line/70 bg-content1">
                        {row.issues.map((issue) => (
                          <li
                            key={issue.issue_id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono font-semibold text-ink">{issue.issue_no}</div>
                              {issue.indent_no && (
                                <div className="truncate text-[11px] text-muted">Indent {issue.indent_no}</div>
                              )}
                            </div>
                            <div className="text-right tabular">
                              <div className="font-semibold text-ink">{fmtQty(issue.total_qty)}</div>
                              <div className="text-[11px] text-muted">{plural(issue.item_lines, "item")}</div>
                            </div>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-auto flex items-center justify-between gap-3 px-4 py-3">
                        <span className="text-xs text-muted">
                          Total <span className="font-semibold tabular text-ink">{fmtQty(row.total_qty)}</span>
                          {" · "}{plural(row.item_lines, "item")}
                        </span>
                        {inUse ? (
                          <span className="inline-flex min-h-11 items-center gap-1.5 px-3 text-sm font-semibold text-ok">
                            <Check className="h-4 w-4" /> Added
                          </span>
                        ) : (
                          <Button disabled={busy} onClick={() => onUseSuggestion(row.issue_ids)}>
                            Use these {row.issue_ids.length}
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ---- 2. Add one by one ---- */}
        {!readOnly && (
          <Field
            label="Add a material issue yourself"
            hint={route?.destinationName
              ? `Only material issues from ${route.warehouseName ?? "the same point"} to ${route.destinationName} are listed.`
              : "Pick the first material issue — after that, only issues going to the same LIP/MDP are listed."}
          >
            <Lookup
              name={lookupName}
              load={loadIssues}
              value=""
              isDisabled={busy}
              onChange={pick}
              placeholder="Search a material issue to add"
            />
          </Field>
        )}

        {/* ---- 3. What is in the consignment ---- */}
        <div>
          <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
            <SectionLabel flush>
              In this consignment
              <span className="rounded-full bg-content2 px-2 py-0.5 text-[10px] tracking-normal text-ink">
                {selected.length}
              </span>
            </SectionLabel>
            {!readOnly && selected.length > 0 && (
              <Button variant="ghost" disabled={busy} onClick={onClear}>Clear all</Button>
            )}
          </div>
          {selected.length === 0 ? (
            <EmptyBox>No material issues yet. Use a suggestion above or add one yourself.</EmptyBox>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              <div className={`${ROW_GRID} hidden border-b border-line bg-content2/50 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted sm:grid`}>
                <span>#</span>
                <span>Material issue</span>
                <span>Indent</span>
                <span className="text-right">Items</span>
                <span className="text-right">Quantity</span>
                <span />
              </div>

              <ul className="divide-y divide-line/70">
                {selected.map((row, index) => (
                  <li key={row.issue_id} className={`${ROW_GRID} min-h-14 px-4 py-1 transition hover:bg-brand-050/40`}>
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-050 text-[11px] font-bold text-brand">
                      {index + 1}
                    </span>
                    {/* Phone: one stacked cell. Wider: `contents`, so each span takes its own column. */}
                    <div className="min-w-0 py-1.5 sm:contents">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileText className="hidden h-3.5 w-3.5 shrink-0 text-muted sm:block" aria-hidden />
                        <span className="truncate font-mono text-xs font-semibold text-ink">{row.issue_no}</span>
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-1 pt-1 sm:pt-0">
                        <span className="text-[11px] text-muted sm:hidden">Indent</span>
                        {row.indent_nos.length ? row.indent_nos.map((no) => (
                          <span key={no} className="truncate rounded-md bg-content2 px-1.5 py-0.5 font-mono text-[11px] text-body">
                            {no}
                          </span>
                        )) : <span className="text-xs text-muted">—</span>}
                      </span>
                      <span className="block text-xs tabular text-muted sm:text-right sm:text-ink">
                        <span className="sm:hidden">{plural(row.lines, "item")} · Qty {fmtQty(row.qty)}</span>
                        <span className="hidden sm:inline">{row.lines}</span>
                      </span>
                      <span className="hidden text-right text-sm font-bold tabular text-ink sm:block">
                        {fmtQty(row.qty)}
                      </span>
                    </div>
                    <div className="flex justify-end">
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={`Remove ${row.issue_no}`}
                          title="Remove"
                          disabled={busy}
                          onClick={() => onRemove(row.issue_id)}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted transition hover:bg-bad-bg hover:text-bad disabled:opacity-40"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              <div className={`${ROW_GRID} border-t border-brand/15 bg-brand-050/60 px-4 py-3 text-xs font-semibold text-ink`}>
                <span className="col-span-2 text-[11px] uppercase tracking-[0.12em] text-brand sm:col-span-3">
                  Total · {plural(selected.length, "issue")}
                </span>
                <span className="hidden text-right tabular sm:block">{totalLines}</span>
                <span className="text-right text-sm font-bold tabular text-brand">
                  <span className="text-xs font-normal text-muted sm:hidden">{plural(totalLines, "item")} · </span>
                  {fmtQty(totalQty)}
                </span>
                <span className="hidden sm:block" />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SectionLabel({ icon, flush, children }: { icon?: ReactNode; flush?: boolean; children: ReactNode }) {
  return (
    <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted ${flush ? "" : "mb-2.5"}`}>
      {icon}
      {children}
    </div>
  );
}

function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs leading-5 text-muted">
      {children}
    </div>
  );
}
