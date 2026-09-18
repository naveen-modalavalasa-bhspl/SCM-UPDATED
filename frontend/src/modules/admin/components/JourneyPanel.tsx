/** The whole journey, end to end, for the project on screen.
 *
 *  The list above answers "who signs this document". It cannot answer "what happens
 *  when someone asks for something", because that is a *sequence* of documents and the
 *  sequence forks: if the stock is already on a shelf it is allocated and issued; if it
 *  is not, the request turns into a purchase and comes back as a receipt. An admin
 *  configuring approvals is really configuring that journey, so it is drawn here.
 *
 *  The branches are the business flow of `docs/04_SCM_BUSINESS_FLOW.md` — a constant,
 *  like the enums, not configuration. Everything shown *inside* a node (its approvers,
 *  its policy, whether it is set up at all) comes from the same overview rows the list
 *  is built from, so the two can never disagree.
 */
import { ArrowRight, CornerDownRight } from "lucide-react";

import { Card } from "@/shared/components";
import type { FlowRow } from "../types";

const BRANCHES: { title: string; note: string; codes: string[] }[] = [
  {
    title: "Stock is available",
    note: "Served from the shelf",
    codes: ["INDENT", "ALLOCATION", "WH_ISSUE"],
  },
  {
    title: "Stock is not available",
    note: "Bought in, then served",
    codes: ["INDENT", "MR", "REQUISITION", "RFQ", "PO", "GRN", "WH_ISSUE"],
  },
];

export function JourneyPanel({ rows, projectName, onOpen }: {
  rows: FlowRow[];
  projectName: string | null;
  onOpen: (code: string) => void;
}) {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  // Every branch starts with the indent, so who may raise ONE is who starts the whole
  // journey — said once at the top instead of on both branches.
  const raisers = byCode.get("INDENT")?.raised_by ?? [];

  return (
    <Card className="mt-6 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          End to end
        </h2>
        <span className="text-xs text-muted" title={raisers.join(", ") || undefined}>
          {projectName ?? "Every project"}
          {/* Nine job profiles can raise an indent. Naming them all turns the one line
            * that orients the reader into a paragraph, so only the first few show and
            * the rest are a count with the full list on hover. */}
          {raisers.length > 0 && ` · started by ${raisers.slice(0, 3).join(", ")}`}
          {raisers.length > 3 && ` +${raisers.length - 3} more`}
        </span>
      </div>

      <div className="space-y-4">
        {BRANCHES.map((branch) => (
          <div key={branch.title}>
            <p className="mb-1.5 flex items-center gap-1.5 text-[13px]">
              <CornerDownRight size={13} className="text-muted" />
              <span className="font-medium">{branch.title}</span>
              <span className="text-muted">· {branch.note}</span>
            </p>
            <div className="flex flex-wrap items-stretch gap-1.5">
              {branch.codes.map((code, index) => {
                const row = byCode.get(code);
                if (!row) return null;
                return (
                  <span key={code} className="flex items-center gap-1.5">
                    {index > 0 && <ArrowRight size={13} className="shrink-0 text-muted" />}
                    <Node row={row} onOpen={onOpen} />
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs text-muted">
        Click any step to change who signs it.
      </p>
    </Card>
  );
}

/** One document in the journey: what it is, and in one line, who signs it. */
function Node({ row, onOpen }: { row: FlowRow; onOpen: (code: string) => void }) {
  const noApproval = row.self_approval_policy === "NO_APPROVAL";
  const selfOk = row.self_approval_policy === "CREATOR_ALLOWED";
  const label =
    row.code === "STOCK_RETURN"
      ? "Indent Return"
      : row.code === "STOCK_RETURN_RECEIPT"
        ? "Decision Desk"
        : row.label;

  return (
    <button
      type="button"
      onClick={() => onOpen(row.code)}
      title={row.summary || undefined}
      className="min-h-11 max-w-[13rem] rounded-lg border border-line/70 bg-content1 px-2.5 py-1.5 text-left transition-colors hover:border-primary hover:bg-content2"
    >
      <span className="block truncate text-[13px] font-medium">{label}</span>
      {noApproval ? (
        <span className="block text-[11px] text-ok">No signature needed</span>
      ) : !row.is_configured ? (
        <span className="block text-[11px] text-warn">Not set up</span>
      ) : (
        <span className="block truncate text-[11px] text-muted">
          {row.summary}
          {selfOk && " · raiser may sign"}
        </span>
      )}
    </button>
  );
}
