import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Clock3, RefreshCw } from "lucide-react";
import { Button, Card, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { approvalApi } from "../api";
import type { PendingApproval } from "../types";
import { ApprovalsNav } from "../components/ApprovalsNav";

const DOC_LABELS: Record<string, string> = {
  INDENT: "Indent", ALLOCATION: "Inventory allocation", MR: "Material request",
  PO: "Purchase order", GRN: "Goods receipt", ISSUE: "Material issue",
};

const HOURS = 3_600_000;
const label = (docType: string) => DOC_LABELS[docType] ?? docType.replace(/_/g, " ");

export function waitLabel(value?: string | null) {
  if (!value) return "Waiting time unavailable";
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / HOURS));
  return hours < 24 ? `Waiting ${hours}h` : `Waiting ${Math.floor(hours / 24)}d`;
}

export function dueLabel(value?: string | null) {
  if (!value) return "No SLA due date";
  const hours = Math.ceil((new Date(value).getTime() - Date.now()) / HOURS);
  return hours < 0 ? `${Math.abs(hours)}h overdue` : hours === 0 ? "Due now" : `Due in ${hours}h`;
}

export function filterPendingApprovals(approvals: PendingApproval[], search: string, docType = "") {
  const term = search.trim().toLocaleLowerCase();
  return approvals.filter((approval) => {
    if (docType && approval.doc_type !== docType) return false;
    if (!term) return true;
    return [approval.doc_no, approval.summary, approval.requested_by_name, approval.current_stage_name, approval.doc_type, String(approval.doc_id)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(term));
  });
}

function targetFor(approval: PendingApproval) {
  if (approval.doc_type === "INDENT") return `/indents/${approval.doc_id}`;
  if (approval.doc_type === "ALLOCATION") return `/inventory/allocation-approvals?review=${approval.doc_id}`;
  if (approval.doc_type === "MR") return `/inventory/material-requests/${approval.doc_id}`;
  if (approval.doc_type === "PO") return "/pos";
  return "/approvals";
}

export function IndentApprovalsPage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [search, setSearch] = useState("");
  const [docType, setDocType] = useState("");
  const queue = useQuery({ queryKey: ["approvals", "waiting"], queryFn: approvalApi.pending });
  const rows = useMemo(
    () => filterPendingApprovals(queue.data ?? [], search, docType),
    [queue.data, search, docType],
  );
  const documentTypes = useMemo(() => [...new Set((queue.data ?? []).map((row) => row.doc_type))], [queue.data]);
  const now = Date.now();
  const overdue = rows.filter((row) => row.due_at && new Date(row.due_at).getTime() < now).length;

  const columns: Column<PendingApproval>[] = [
    {
      key: "priority", header: "Attention", className: "w-12",
      render: (row) => row.due_at && new Date(row.due_at).getTime() < now
        ? <AlertTriangle className="h-4 w-4 text-danger" aria-label="Overdue" />
        : <Clock3 className="h-4 w-4 text-muted" aria-label="Awaiting review" />,
    },
    {
      key: "document", header: "Document",
      render: (row) => <div><p className="font-medium text-ink">{label(row.doc_type)}</p><p className="mono text-xs text-muted">{row.doc_no ?? `#${row.doc_id}`}</p></div>,
    },
    { key: "description", header: "Description", hideOnNarrow: true, render: (row) => row.summary ?? "Approval awaiting review" },
    { key: "requester", header: "Requested by", hideOnNarrow: true, render: (row) => row.requested_by_name ?? "—" },
    { key: "stage", header: "Current stage", render: (row) => row.current_stage_name ?? `Stage ${row.stage_sequence}` },
    {
      key: "timing", header: "SLA", render: (row) => <div><p className={row.due_at && new Date(row.due_at).getTime() < now ? "text-danger" : "text-body"}>{dueLabel(row.due_at)}</p><p className="text-xs text-muted">{waitLabel(row.waiting_since)}</p></div>,
    },
    { key: "review", header: "", render: () => <span className="inline-flex items-center gap-1 text-brand">Review <ArrowRight className="h-4 w-4" /></span> },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Approvals"
        title="Waiting for Me"
        actions={<Button variant="ghost" onClick={() => queue.refetch()} disabled={queue.isFetching}><RefreshCw className="h-4 w-4" /> Refresh</Button>}
      />
      <ApprovalsNav />
      <p className="mb-4 max-w-3xl text-sm text-body">
        You are approving as {me?.active_position?.name ?? "your active position"}. Only documents assigned to that position appear here; review the document before making a decision.
      </p>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_240px_auto]">
        <Input aria-label="Search approvals" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search document, requester or description" />
        <Select ariaLabel="Document type" value={docType} onChange={setDocType} placeholder="All document types" options={documentTypes.map((value) => ({ value, label: label(value) }))} />
        <div className="flex items-center text-sm text-muted">{rows.length} waiting{overdue ? ` · ${overdue} overdue` : ""}</div>
      </Card>
      {queue.error ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(queue.error as Error).message}</p> : (
        <ResponsiveList
          data={rows} loading={queue.isLoading} keyOf={(row) => `${row.instance_id}-${row.stage_sequence}`}
          columns={columns} onRowClick={(row) => nav(targetFor(row))}
          empty="No approvals are assigned to your active position. When work is assigned to you or delegated to you, it will appear here."
          renderCard={(row) => <div className="space-y-1.5"><div className="flex items-start justify-between gap-3"><div><p className="font-medium text-ink">{row.doc_no ?? `#${row.doc_id}`}</p><p className="text-xs text-muted">{label(row.doc_type)} · {row.current_stage_name ?? `Stage ${row.stage_sequence}`}</p></div><StatusPill status={row.due_at && new Date(row.due_at).getTime() < now ? "OVERDUE" : "PENDING"} /></div><p className="text-sm text-body">{row.summary ?? "Approval awaiting review"}</p><p className="text-xs text-muted">{row.requested_by_name ?? "Unknown requester"} · {dueLabel(row.due_at)}</p></div>}
        />
      )}
    </>
  );
}
