import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, X } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, ResponsiveList, Select, StatusPill, type Column } from "@/shared/components";
import { approvalApi } from "../api";
import type { ApprovalDelegation } from "../types";

type Tab = "mine" | "incoming" | "team";
const tabs: { value: Tab; label: string }[] = [
  { value: "mine", label: "My outgoing" }, { value: "incoming", label: "Delegated to me" }, { value: "team", label: "Team delegations" },
];
const docTypes = ["", "INDENT", "ALLOCATION", "MR", "PO"];
const today = () => new Date().toISOString().slice(0, 10);
const stateFor = (row: ApprovalDelegation) => {
  if (!row.is_active) return "ENDED";
  if (row.valid_to < today()) return "EXPIRED";
  if (row.valid_from > today()) return "UPCOMING";
  return "ACTIVE";
};

export function DelegationsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("mine");
  const [delegateId, setDelegateId] = useState("");
  const [docType, setDocType] = useState("");
  const [validFrom, setValidFrom] = useState(today());
  const [validTo, setValidTo] = useState(today());
  const [reason, setReason] = useState("");
  const query = useQuery({ queryKey: ["approvals", "delegations", tab], queryFn: () => approvalApi.delegations(tab) });
  const options = useQuery({ queryKey: ["approvals", "delegation-options"], queryFn: approvalApi.delegationOptions });
  const create = useMutation({
    mutationFn: () => approvalApi.createDelegation({ to_employee_id: Number(delegateId), doc_type: docType || null, valid_from: validFrom, valid_to: validTo, reason: reason || undefined }),
    onSuccess: () => { setDelegateId(""); setReason(""); qc.invalidateQueries({ queryKey: ["approvals", "delegations"] }); },
  });
  const end = useMutation({ mutationFn: (id: number) => approvalApi.endDelegation(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals", "delegations"] }) });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const columns: Column<ApprovalDelegation>[] = [
    { key: "from", header: "Delegate from", render: (row) => row.from_employee_name ?? `Employee #${row.from_employee_id}` },
    { key: "to", header: "Delegate to", render: (row) => row.to_employee_name ?? `Employee #${row.to_employee_id}` },
    { key: "documents", header: "Applies to", render: (row) => row.doc_type?.replace(/_/g, " ") ?? "All document types" },
    { key: "period", header: "Period", hideOnNarrow: true, render: (row) => `${row.valid_from} to ${row.valid_to}` },
    { key: "status", header: "Status", render: (row) => <StatusPill status={stateFor(row)} /> },
    { key: "action", header: "", render: (row) => row.from_employee_id && tab === "mine" && row.is_active && row.valid_to >= today() ? <Button variant="ghost" disabled={end.isPending} onClick={(event) => { event.stopPropagation(); end.mutate(row.id); }}><X className="h-4 w-4" /> End</Button> : null },
  ];
  const canCreate = Number(delegateId) > 0 && validFrom <= validTo && !create.isPending;
  return <>
    <PageHeader eyebrow="Approvals" title="Delegations" />
    <p className="mb-4 max-w-3xl text-sm text-body">Set temporary cover for leave, travel, or a vacancy. The original approver remains visible in the audit history, and the system prevents inactive employees and circular routes.</p>
    <Card className="mb-5 p-4"><h2 className="mb-3 flex items-center gap-2 font-semibold text-ink"><CalendarClock className="h-5 w-5" /> Create delegation</h2>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Field label="Delegate to"><Select ariaLabel="Delegate to" value={delegateId} onChange={setDelegateId} placeholder="Choose active employee" options={(options.data ?? []).map((row) => ({ value: row.id, label: row.name }))} /></Field>
        <Field label="Applies to"><Select ariaLabel="Document type" value={docType} onChange={setDocType} placeholder="All document types" options={docTypes.filter(Boolean).map((value) => ({ value, label: value.replace(/_/g, " ") }))} /></Field>
        <Field label="Start date"><Input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></Field>
        <Field label="End date"><Input type="date" min={validFrom} value={validTo} onChange={(event) => setValidTo(event.target.value)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Leave, travel, temporary responsibility" /></Field>
        <div className="flex items-end"><Button disabled={!canCreate} onClick={() => create.mutate()}>Create delegation</Button></div>
      </div>
      {create.error && <p className="mt-3 text-sm text-danger">{(create.error as Error).message}</p>}
    </Card>
    <div className="mb-4 flex flex-wrap gap-2">{tabs.map((item) => <Button key={item.value} variant={tab === item.value ? "primary" : "ghost"} onClick={() => setTab(item.value)}>{item.label}</Button>)}</div>
    {query.error ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p> : <ResponsiveList data={rows} loading={query.isLoading} keyOf={(row) => row.id} columns={columns} empty="No delegations in this view." renderCard={(row) => <div className="space-y-1"><div className="flex justify-between gap-3"><strong className="text-ink">{row.from_employee_name} → {row.to_employee_name}</strong><StatusPill status={stateFor(row)} /></div><p className="text-sm text-body">{row.doc_type ?? "All document types"} · {row.valid_from} to {row.valid_to}</p>{row.reason && <p className="text-xs text-muted">{row.reason}</p>}</div>} />}
  </>;
}
