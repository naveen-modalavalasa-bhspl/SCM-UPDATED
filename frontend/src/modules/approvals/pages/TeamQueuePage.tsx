import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { BarChart3, Bell } from "lucide-react";
import { Button, Card, PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { approvalsApi } from "../api";
import { alerts } from "@/modules/alerts";
import type { TeamQueueRow } from "../types";

export function TeamQueuePage() {
  const nav = useNavigate();
  const query = useQuery({ queryKey: ["approvals", "team-queue"], queryFn: approvalsApi.teamQueue });
  // Named in the alert: on a queue of eight approvers, "Reminder sent" alone does
  // not say which row the click landed on.
  const remind = useMutation({
    mutationFn: (row: TeamQueueRow) =>
      approvalsApi.remind(row.approver_id).then(() => row.approver_name),
    onSuccess: (name) => void alerts.success("reminder.sent", { name }),
  });
  const columns: Column<TeamQueueRow>[] = [
    { key: "approver", header: "Approver", render: (row) => <strong className="text-ink">{row.approver_name}</strong> },
    { key: "pending", header: "Pending", render: (row) => row.pending_count },
    { key: "overdue", header: "Overdue", render: (row) => <span className={row.overdue_count ? "font-semibold text-danger" : ""}>{row.overdue_count}</span> },
    { key: "oldest", header: "Oldest task", hideOnNarrow: true, render: (row) => row.oldest_waiting_since ? new Date(row.oldest_waiting_since).toLocaleString() : "—" },
    { key: "average", header: "Average wait", render: (row) => `${row.average_waiting_hours}h` },
    { key: "documents", header: "Document types", hideOnNarrow: true, render: (row) => row.document_types.join(", ") },
    { key: "reminder", header: "", render: (row) => <Button variant="ghost" disabled={!row.pending_count || remind.isPending} onClick={() => remind.mutate(row)}><Bell className="h-4 w-4" /> Remind</Button> },
  ];
  return <>
    <PageHeader eyebrow="Approvals" title="Team Queue" actions={<Button variant="ghost" onClick={() => nav("/approvals?view=reports")}><BarChart3 className="h-4 w-4" /> Reports</Button>} />
    <p className="mb-4 text-sm text-body">Monitor work assigned to your reporting team. This screen does not give you authority to decide for another approver.</p>
    {remind.error &&<p className="mb-3 rounded-lg bg-danger/10 p-3 text-sm text-danger">{(remind.error as Error).message}</p>}
    <Card className="p-2"><ResponsiveList data={query.data ?? []} loading={query.isLoading} keyOf={(row) => row.approver_id} columns={columns} empty="No approval team is mapped below your active position." renderCard={(row) => <div className="space-y-2"><div className="flex justify-between"><strong className="text-ink">{row.approver_name}</strong><StatusPill status={row.overdue_count ? "OVERDUE" : "PENDING"} /></div><p className="text-sm text-body">{row.pending_count} pending · {row.overdue_count} overdue</p><p className="text-xs text-muted">Average wait {row.average_waiting_hours}h</p><Button variant="ghost" disabled={!row.pending_count || remind.isPending} onClick={() => remind.mutate(row)}><Bell className="h-4 w-4" /> Send reminder</Button></div>} /></Card>
  </>;
}
