import { useQuery } from "@tanstack/react-query";
import { Card, PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { approvalApi } from "../api";
import type { TeamQueueRow } from "../types";
import { ApprovalsNav } from "../components/ApprovalsNav";

export function TeamQueuePage() {
  const query = useQuery({ queryKey: ["approvals", "team-queue"], queryFn: approvalApi.teamQueue });
  const columns: Column<TeamQueueRow>[] = [
    { key: "approver", header: "Approver", render: (row) => <strong className="text-ink">{row.approver_name}</strong> },
    { key: "pending", header: "Pending", render: (row) => row.pending_count },
    { key: "overdue", header: "Overdue", render: (row) => row.overdue_count ? <span className="font-semibold text-danger">{row.overdue_count}</span> : "0" },
    { key: "oldest", header: "Oldest task", hideOnNarrow: true, render: (row) => row.oldest_waiting_since ? new Date(row.oldest_waiting_since).toLocaleString() : "—" },
    { key: "average", header: "Average wait", render: (row) => `${row.average_waiting_hours}h` },
    { key: "documents", header: "Document types", hideOnNarrow: true, render: (row) => row.document_types.join(", ") },
  ];
  return <>
    <PageHeader eyebrow="Approvals" title="Team Queue" />
    <ApprovalsNav />
    <p className="mb-4 max-w-3xl text-sm text-body">Monitor work assigned to people in your reporting line. Viewing a task does not give you approval authority; you can decide only when the workflow assigns it to you.</p>
    {query.error ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p> : <Card className="p-2"><ResponsiveList data={query.data ?? []} loading={query.isLoading} keyOf={(row) => row.approver_id} columns={columns} empty="No approval team is mapped below your active position." renderCard={(row) => <div className="space-y-1"><div className="flex justify-between"><strong className="text-ink">{row.approver_name}</strong><StatusPill status={row.overdue_count ? "OVERDUE" : "PENDING"} /></div><p className="text-sm text-body">{row.pending_count} pending · {row.overdue_count} overdue</p><p className="text-xs text-muted">Average wait {row.average_waiting_hours}h</p></div>} /></Card>}
  </>;
}
