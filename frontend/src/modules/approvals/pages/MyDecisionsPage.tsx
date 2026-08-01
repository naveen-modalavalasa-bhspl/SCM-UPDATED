import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { BarChart3, Download } from "lucide-react";
import * as XLSX from "xlsx";
import {
  Button, Card, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column,
} from "@/shared/components";
import { approvalsApi } from "../api";
import { approvalDocumentPath } from "../documentRoutes";
import type { ApprovalDecisionRow } from "../types";
import { ApprovalPager } from "../components/Pager";

function exportExcel(rows: ApprovalDecisionRow[]) {
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    "Decision date": row.decision_at ? new Date(row.decision_at).toLocaleString() : "",
    "Document type": row.doc_type,
    "Document number": row.doc_no ?? `#${row.doc_id}`,
    "Approval stage": row.stage_name ?? `Stage ${row.stage_sequence}`,
    Decision: row.decision,
    Comments: row.comments ?? "",
    Requester: row.requester ?? "",
    "Workflow status": row.workflow_status,
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "My Decisions");
  XLSX.writeFile(workbook, "my-approval-decisions.xlsx");
}

export function MyDecisionsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState("");
  const [page, setPage] = useState(1);
  const size = 20;
  const query = useQuery({ queryKey: ["approvals", "decisions", page, size, search, decision], queryFn: () => approvalsApi.decisions(page, size, { search: search.trim(), decision }) });
  useEffect(() => setPage(1), [decision, search]);
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data?.items ?? []).filter((row) => (!decision || row.decision === decision)
      && (!term || [row.doc_no, row.requester, row.comments, row.doc_type]
        .some((value) => String(value ?? "").toLowerCase().includes(term))));
  }, [decision, query.data?.items, search]);
  const openDecision = (row: ApprovalDecisionRow) => nav(approvalDocumentPath(row));
  const columns: Column<ApprovalDecisionRow>[] = [
    { key: "date", header: "Decision date", render: (row) => row.decision_at ? new Date(row.decision_at).toLocaleString() : "—" },
    { key: "document", header: "Document", render: (row) => <div><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><p className="text-xs text-muted">{row.doc_type.replace(/_/g, " ")}</p></div> },
    { key: "stage", header: "Approval stage", render: (row) => row.stage_name ?? `Stage ${row.stage_sequence}` },
    { key: "decision", header: "My decision", render: (row) => <StatusPill status={row.decision} /> },
    { key: "comments", header: "Comments", hideOnNarrow: true, render: (row) => row.comments ?? "—" },
    { key: "status", header: "Workflow status", render: (row) => <StatusPill status={row.workflow_status} /> },
    { key: "action", header: "", render: (row) => <Button onClick={() => openDecision(row)}>View details</Button> },
  ];
  return <>
    <PageHeader eyebrow="Approvals" title="My Decisions" actions={<div className="flex gap-2"><Button variant="ghost" onClick={() => nav("/approvals?view=reports")}><BarChart3 className="h-4 w-4" /> Reports</Button><Button variant="ghost" disabled={!rows.length} onClick={() => exportExcel(rows)}><Download className="h-4 w-4" /> Export Excel</Button></div>} />
    <p className="mb-4 text-sm text-body">Your permanent, read-only approval history.</p>
    <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_220px]"><Input aria-label="Search decisions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search document, requester or comment" /><Select ariaLabel="Decision" value={decision} onChange={setDecision} placeholder="All decisions" options={["APPROVED", "REJECTED", "RETURNED"].map((value) => ({ value, label: value[0] + value.slice(1).toLowerCase() }))} /></Card>
    {query.error
      ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p>
      : <ResponsiveList data={rows} loading={query.isLoading} keyOf={(row) => row.id} columns={columns} onRowClick={openDecision} empty="You have not made an approval decision yet." renderCard={(row) => <div className="space-y-2"><div className="flex justify-between"><strong className="font-mono text-ink">{row.doc_no ?? `#${row.doc_id}`}</strong><StatusPill status={row.decision} /></div><p className="text-sm text-body">{row.doc_type.replace(/_/g, " ")} · {row.stage_name}</p><p className="text-xs text-muted">{row.decision_at ? new Date(row.decision_at).toLocaleString() : "—"}</p><Button onClick={() => openDecision(row)}>View details</Button></div>} />}
    {!query.error && <ApprovalPager page={page} size={size} total={query.data?.total ?? 0} onPage={setPage} />}
  </>;
}
