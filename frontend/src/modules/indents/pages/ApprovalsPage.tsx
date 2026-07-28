import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import type { PendingApproval } from "../types";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentFilterProvider, useIndentFilters } from "../context/IndentFilterContext";

export function filterPendingApprovals(approvals: PendingApproval[], search: string) {
  const term = search.trim().toLocaleLowerCase();
  const indentApprovals = approvals.filter((approval) => approval.doc_type === "INDENT");
  if (!term) return indentApprovals;

  return indentApprovals.filter((approval) =>
    [
      approval.doc_no,
      approval.summary,
      approval.requested_by_name,
      String(approval.doc_id),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(term))
  );
}

function IndentApprovalsContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const { search } = useIndentFilters();
  const { data = [], isLoading } = useQuery({
    queryKey: indentKeys.pendingApprovals(accountScope),
    queryFn: indentApi.pendingApprovals,
  });
  const filtered = filterPendingApprovals(data, search);

  return (
    <>
      <IndentModuleHeader
        title="Waiting for me"
        showCreate={false}
        showRequiredBy={false}
        showDate={false}
        showStatus={false}
        showPriority={false}
      />
      <Card className="divide-y divide-line">
        {isLoading && <p className="p-5 text-sm text-muted">Loading approvals...</p>}
        {filtered.map((approval) => (
          <button
            key={approval.instance_id}
            onClick={() => {
              if (approval.doc_type === "INDENT") nav(`/indents/${approval.doc_id}`);
            }}
            className="flex w-full items-start gap-3 p-4 text-left hover:bg-content2"
          >
            <span className="rounded-full bg-warn-bg p-2 text-warn">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <span>
              <strong className="mono text-sm text-ink">
                {approval.doc_no ?? `Request #${approval.doc_id}`}
              </strong>
              <span className="mt-1 block text-sm text-body">
                {approval.summary ?? "Material request awaiting your decision"}
              </span>
              {approval.requested_by_name && (
                <span className="mt-1 block text-xs text-muted">
                  Raised by {approval.requested_by_name}
                </span>
              )}
            </span>
          </button>
        ))}
        {!isLoading && filtered.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">
            Nothing is waiting for your approval in this position.
          </p>
        )}
      </Card>
    </>
  );
}

export function IndentApprovalsPage() {
  return (
    <IndentFilterProvider>
      <IndentApprovalsContent />
    </IndentFilterProvider>
  );
}
