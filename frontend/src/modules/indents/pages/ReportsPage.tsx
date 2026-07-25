import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { indentApi, masterApi } from "../api";

const statusOptions = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Awaiting approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ORDERED", label: "Ordered" },
];

export function IndentReportsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [status, setStatus] = useState("");
  const [transaction, setTransaction] = useState("");
  const [direction, setDirection] = useState("");
  const [itemId, setItemId] = useState("");
  const { data: items } = useQuery({ queryKey: ["items", "ledger"], queryFn: () => masterApi.items() });
  const filters = {
    search: search || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined,
    status: status || undefined, transaction_type: transaction || undefined,
    direction: direction || undefined, item_id: itemId ? Number(itemId) : undefined, size: 100,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["indent-activity", filters],
    queryFn: () => indentApi.activity(filters),
  });

  return (
    <>
      <PageHeader eyebrow="Material Requests" title="Activity ledger" />
      <Card className="mb-4 grid gap-3 p-4 md:grid-cols-3 lg:grid-cols-4">
        <Field label="Search">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Request, person or department" />
        </Field>
        <Field label="From"><Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></Field>
        <Select label="Status" value={status} onChange={setStatus} options={statusOptions} />
        <Select
          label="Transaction"
          value={transaction}
          onChange={setTransaction}
          options={[
            { value: "", label: "All transactions" },
            { value: "RAISED", label: "Request raised" },
            { value: "ACKNOWLEDGED", label: "Acknowledged" },
          ]}
        />
        <Select
          label="Movement"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "", label: "All movements" },
            { value: "OUTWARD", label: "Material requested (outward)" },
            { value: "INWARD", label: "Inward" },
          ]}
        />
        <Select
          label="Item"
          value={itemId}
          onChange={setItemId}
          options={[
            { value: "", label: "All items" },
            ...(items ?? []).map((item) => ({
              value: item.id, label: `${item.code ? `${item.code} · ` : ""}${item.name}`,
            })),
          ]}
        />
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-line bg-content2 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="p-3">When</th><th className="p-3">Request</th>
              <th className="p-3">Transaction</th><th className="p-3">Item / action</th>
              <th className="p-3">Qty</th><th className="p-3">Department</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.items.map((row) => (
              <tr key={row.event_id} onClick={() => nav(`/indents/${row.indent_id}`)} className="cursor-pointer hover:bg-content2">
                <td className="p-3 text-muted">{new Date(row.event_at).toLocaleDateString()}</td>
                <td className="mono p-3 font-semibold text-ink">{row.indent_no}</td>
                <td className="p-3">{row.transaction_type === "RAISED" ? "Request raised" : "Acknowledged"}</td>
                <td className="p-3">{row.item_name ?? row.actor_name ?? "Workflow action"}</td>
                <td className="p-3 tabular">{row.quantity ? `${row.quantity} ${row.uom_code ?? ""}` : "—"}</td>
                <td className="p-3 text-muted">{row.department_name ?? "—"}</td>
                <td className="p-3"><StatusPill status={row.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLoading && <p className="p-6 text-center text-sm text-muted">Loading activity…</p>}
        {!isLoading && data?.items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">No activity matches these filters.</p>
        )}
      </Card>
    </>
  );
}
