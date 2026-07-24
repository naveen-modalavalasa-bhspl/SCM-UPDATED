import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/shared/components/ui";
import { indentApi } from "../api";
import type { IndentListRow } from "../types";

// Board columns map to the indent lifecycle. Several raw statuses fold into one column.
const COLUMNS: { title: string; statuses: string[]; dot: string }[] = [
  { title: "Draft", statuses: ["DRAFT"], dot: "bg-neutral" },
  { title: "In approval", statuses: ["PENDING_APPROVAL", "SUBMITTED"], dot: "bg-warn" },
  { title: "Approved", statuses: ["APPROVED"], dot: "bg-ok" },
  { title: "Ordered", statuses: ["ORDERED", "PARTIALLY_ORDERED"], dot: "bg-info" },
  { title: "Rejected", statuses: ["REJECTED"], dot: "bg-bad" },
];

export function IndentBoardPage() {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ["indents-board"], queryFn: () => indentApi.list({ size: 200 }) });
  const rows = data?.items ?? [];
  const bucket = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status));

  return (
    <>
      <PageHeader eyebrow="Indents" title="Board" />
      {/* Horizontal scroll on small screens; never scrolls the page body */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        <div className="flex min-w-max gap-4 md:grid md:min-w-0 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = bucket(col.statuses);
            return (
              <div key={col.title} className="w-64 shrink-0 rounded-xl border border-line bg-surface/40 md:w-auto">
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-semibold text-body">
                    <span className={`h-2 w-2 rounded-full ${col.dot}`} />
                    {col.title}
                  </span>
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-white px-1.5 text-xs font-bold tabular text-muted">
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2 px-2 pb-2">
                  {items.map((i: IndentListRow) => (
                    <button key={i.id} onClick={() => nav(`/indents/${i.id}`)} className="block w-full rounded-lg border border-line bg-white p-3 text-left transition-shadow hover:shadow-sm">
                      <div className="mono text-sm font-semibold text-ink">{i.indent_no}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">{i.department_name ?? "—"}</div>
                      <div className="mt-1 text-[11px] tabular text-muted">{i.total_items} lines</div>
                    </button>
                  ))}
                  {items.length === 0 && <p className="px-1 py-4 text-center text-xs text-muted">Empty</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
