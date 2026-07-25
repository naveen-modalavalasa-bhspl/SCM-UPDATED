import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Card, PageHeader } from "@/shared/components";
import { indentApi } from "../api";

export function IndentApprovalsPage() {
  const nav = useNavigate();
  const { data = [], isLoading } = useQuery({
    queryKey: ["pending-approvals"],
    queryFn: indentApi.pendingApprovals,
  });

  return (
    <>
      <PageHeader eyebrow="Approvals" title="Waiting for me" />
      <Card className="divide-y divide-line">
        {isLoading && <p className="p-5 text-sm text-muted">Loading approvals…</p>}
        {data.map((approval) => (
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
        {!isLoading && data.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">
            Nothing is waiting for your approval in this position.
          </p>
        )}
      </Card>
    </>
  );
}
