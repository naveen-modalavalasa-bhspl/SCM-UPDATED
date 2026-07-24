import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, Button, Can, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { indentApi } from "../api";
import type { IndentListRow } from "../types";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "PENDING_APPROVAL", label: "In approval" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
];

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

export function IndentListPage() {
  const [status, setStatus] = useState("");
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["indents", status],
    queryFn: () => indentApi.list({ status: status || undefined, size: 50 }),
  });

  const columns: Column<IndentListRow>[] = [
    { key: "no", header: "Indent", render: (r) => <span className="mono font-semibold text-ink">{r.indent_no}</span> },
    { key: "req", header: "Requested by", render: (r) => r.requested_by_name ?? "—", hideOnNarrow: true },
    { key: "dept", header: "Department", render: (r) => r.department_name ?? "—" },
    { key: "items", header: "Lines", render: (r) => <span className="tabular text-muted">{r.total_items}</span> },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "date", header: "Raised", render: (r) => <span className="text-muted">{fmtDate(r.created_at)}</span>, hideOnNarrow: true },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Indents"
        title="All indents"
        actions={
          <Can do="indent.create">
            <Button onClick={() => nav("/indents/new")}><Plus className="h-4 w-4" /> New indent</Button>
          </Can>
        }
      />

      <Tabs
        aria-label="Filter by status"
        variant="solid"
        color="primary"
        radius="full"
        selectedKey={status || "all"}
        onSelectionChange={(k) => setStatus(k === "all" ? "" : String(k))}
        classNames={{ base: "mb-4", tabList: "bg-content2 p-1" }}
      >
        {FILTERS.map((f) => <Tab key={f.key} title={f.label} />)}
      </Tabs>

      <ResponsiveList
        data={data?.items ?? []}
        loading={isLoading}
        keyOf={(r) => r.id}
        onRowClick={(r) => nav(`/indents/${r.id}`)}
        columns={columns}
        empty="No indents match this filter yet."
        renderCard={(r) => (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="mono font-semibold text-ink">{r.indent_no}</span>
              <StatusPill status={r.status} />
            </div>
            <div className="flex items-center justify-between text-sm text-muted">
              <span>{r.department_name ?? "—"}</span>
              <span className="tabular">{r.total_items} lines · {fmtDate(r.created_at)}</span>
            </div>
          </div>
        )}
      />
    </>
  );
}
