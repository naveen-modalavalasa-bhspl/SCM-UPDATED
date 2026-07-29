import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button, Card, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column } from "@/shared/components";
import { approvalApi } from "../api";
import type { ApprovalDecisionRow } from "../types";
import { ApprovalsNav } from "../components/ApprovalsNav";

const documentLabel = (value: string) => value.replace(/_/g, " ");
const targetFor = (row: ApprovalDecisionRow) => row.doc_type === "INDENT" ? `/indents/${row.doc_id}`
  : row.doc_type === "MR" ? `/inventory/material-requests/${row.doc_id}`
    : row.doc_type === "ALLOCATION" ? `/inventory/allocation-approvals?review=${row.doc_id}` : "/approvals";

function exportRows(rows: ApprovalDecisionRow[]) {
  const header = ["Decision date", "Document type", "Document number", "Stage", "Decision", "Comments", "Requester", "Workflow status"];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((row) => [row.decision_at, row.doc_type, row.doc_no, row.stage_name, row.decision, row.comments, row.requester, row.workflow_status].map(escape).join(","));
  const href = URL.createObjectURL(new Blob([[header.map(escape).join(","), ...body].join("\n")], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = href; link.download = "my-approval-decisions.csv"; link.click(); URL.revokeObjectURL(href);
}

export function MyDecisionsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState("");
  const query = useQuery({ queryKey: ["approvals", "decisions"], queryFn: approvalApi.decisions });
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data ?? []).filter((row) => (!decision || row.decision === decision) && (!term || [row.doc_no, row.requester, row.comments, row.doc_type].some((value) => String(value ?? "").toLowerCase().includes(term))));
  }, [query.data, search, decision]);
  const columns: Column<ApprovalDecisionRow>[] = [
    { key: "date", header: "Decision date", render: (row) => row.decision_at ? new Date(row.decision_at).toLocaleString() : "—" },
    { key: "document", header: "Document", render: (row) => <div><p className="font-medium text-ink">{row.doc_no ?? `#${row.doc_id}`}</p><p className="text-xs text-muted">{documentLabel(row.doc_type)}</p></div> },
    { key: "stage", header: "Approval stage", hideOnNarrow: true, render: (row) => row.stage_name ?? `Stage ${row.stage_sequence}` },
    { key: "decision", header: "My decision", render: (row) => <StatusPill status={row.decision} /> },
    { key: "comments", header: "Comments", hideOnNarrow: true, render: (row) => row.comments ?? "—" },
    { key: "requester", header: "Requester", hideOnNarrow: true, render: (row) => row.requester ?? "—" },
    { key: "status", header: "Workflow status", render: (row) => <StatusPill status={row.workflow_status} /> },
  ];
  return <>
    <PageHeader eyebrow="Approvals" title="My Decisions" actions={<Button variant="ghost" onClick={() => exportRows(rows)} disabled={!rows.length}><Download className="h-4 w-4" /> Export CSV</Button>} />
    <ApprovalsNav />
    <p className="mb-4 text-sm text-body">This is your permanent, read-only decision history. Decisions and audit timestamps cannot be changed or removed.</p>
    <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_220px]"><Input aria-label="Search decisions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search document, requester or comment" /><Select ariaLabel="Decision" value={decision} onChange={setDecision} placeholder="All decisions" options={["APPROVED", "REJECTED", "RETURNED"].map((value) => ({ value, label: value[0] + value.slice(1).toLowerCase() }))} /></Card>
    {query.error ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p> : <ResponsiveList data={rows} loading={query.isLoading} keyOf={(row) => row.id} columns={columns} onRowClick={(row) => nav(targetFor(row))} empty="You have not made an approval decision yet." renderCard={(row) => <div className="space-y-1"><div className="flex justify-between gap-3"><strong className="mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><StatusPill status={row.decision} /></div><p className="text-sm text-body">{documentLabel(row.doc_type)} · {row.stage_name ?? `Stage ${row.stage_sequence}`}</p>{row.comments && <p className="text-sm text-muted">{row.comments}</p>}<p className="text-xs text-muted">{row.decision_at ? new Date(row.decision_at).toLocaleString() : "—"}</p></div>} />}
  </>;
}
