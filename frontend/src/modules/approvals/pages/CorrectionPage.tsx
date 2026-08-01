import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Send } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { approvalsApi } from "../api";

export function ApprovalCorrectionPage({
  indentId: suppliedIndentId,
  onClose,
}: { indentId?: number; onClose?: () => void } = {}) {
  const { id } = useParams();
  const indentId = suppliedIndentId ?? Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["approvals", "correction", indentId], queryFn: () => approvalsApi.getCorrection(indentId), enabled: Number.isFinite(indentId) });
  const [requiredDate, setRequiredDate] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [remarks, setRemarks] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!query.data) return;
    setRequiredDate(query.data.required_date ?? "");
    setPriority(query.data.priority);
    setRemarks(query.data.remarks ?? "");
    setQuantities(Object.fromEntries(query.data.items.map((line) => [line.id, String(line.quantity)])));
  }, [query.data]);

  const payload = () => ({
    required_date: requiredDate || null,
    priority,
    remarks: remarks || null,
    items: (query.data?.items ?? []).map((line) => ({
      item_id: line.item_id,
      quantity: Number(quantities[line.id]),
      remarks: line.remarks ?? undefined,
    })),
  });
  const invalid = (query.data?.items ?? []).some((line) => !Number.isFinite(Number(quantities[line.id])) || Number(quantities[line.id]) <= 0);
  const save = useMutation({ mutationFn: () => approvalsApi.saveCorrection(indentId, payload()), onSuccess: (data) => qc.setQueryData(["approvals", "correction", indentId], data) });
  const resubmit = useMutation({
    mutationFn: async () => { await approvalsApi.saveCorrection(indentId, payload()); return approvalsApi.resubmitCorrection(indentId); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["approvals"] }); nav("/indents"); },
  });
  const error = save.error || resubmit.error;

  if (query.isLoading) return <p className="p-6 text-muted">Loading correction…</p>;
  if (query.error) return <p className="rounded-lg bg-danger/10 p-4 text-danger">{(query.error as Error).message}</p>;
  if (!query.data) return null;
  const close = () => onClose ? onClose() : nav("/indents");
  return <>
    <button className="mb-3 inline-flex h-11 items-center gap-2 text-sm text-muted" onClick={close}><ArrowLeft className="h-4 w-4" /> Back to approvals</button>
    <PageHeader eyebrow="Returned for correction" title={query.data.indent_no} actions={<StatusPill status={query.data.status} />} />
    <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-3"><Field label="Required date"><Input type="date" value={requiredDate} onChange={(event) => setRequiredDate(event.target.value)} /></Field><Field label="Priority"><select className="h-11 w-full rounded-lg border border-line bg-content1 px-3 text-sm text-ink" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></select></Field><Field label="Remarks"><Input value={remarks} onChange={(event) => setRemarks(event.target.value)} /></Field></Card>
    <Card className="divide-y divide-line p-0">{query.data.items.map((line) => <div key={line.id} className="grid items-center gap-3 p-4 sm:grid-cols-[1fr_180px]"><div><strong className="text-ink">{line.item_name}</strong><p className="font-mono text-xs text-muted">{line.item_code}</p></div><Field label={`Quantity (${line.uom_code ?? "UOM"})`}><Input type="number" min="0.001" step="0.001" value={quantities[line.id] ?? ""} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))} /></Field></div>)}</Card>
    {invalid && <p className="mt-3 text-sm text-danger">Every quantity must be greater than zero.</p>}
    {error && <p className="mt-3 rounded-lg bg-danger/10 p-3 text-sm text-danger">{(error as Error).message}</p>}
    <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" disabled={invalid || save.isPending || resubmit.isPending} onClick={() => save.mutate()}><Save className="h-4 w-4" /> Save correction</Button><Button disabled={invalid || save.isPending || resubmit.isPending} onClick={() => resubmit.mutate()}><Send className="h-4 w-4" /> Save and resubmit</Button></div>
  </>;
}
