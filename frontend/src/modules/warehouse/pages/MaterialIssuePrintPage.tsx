import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { getIssue, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";

export function MaterialIssuePrintPage() {
  const { id } = useParams();
  const issueId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-issue", issueId],
    queryFn: () => getIssue(issueId),
    enabled: Number.isFinite(issueId) && issueId > 0,
  });

  const { data: company } = useQuery({
    queryKey: ["print-company"],
    queryFn: () =>
      api.get<{ company?: Record<string, string> }>("/api/settings")
        .then((r) => r.data.company ?? {})
        .catch(() => ({} as Record<string, string>)),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const { data: warehouses } = useQuery({
    queryKey: ["print-warehouses"],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!query.data) return;
    const timer = setTimeout(() => window.print(), 250);
    return () => clearTimeout(timer);
  }, [query.data]);

  if (query.isLoading) return <p className="p-8 text-sm">Loading the document…</p>;
  if (query.error) return <p className="p-8 text-sm">{(query.error as Error).message}</p>;
  if (!query.data) return <p className="p-8 text-sm">Document not found.</p>;

  const issue = query.data;
  
  // WarehouseOptions returns { id, label } or { value, label } for options.
  const warehouse = warehouses?.find((w: any) => w.id === issue.warehouse_id || w.value === issue.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${issue.warehouse_id}`;

  return (
    <div className="mx-auto max-w-[820px] bg-white text-[13px] leading-snug text-black shadow-md print:shadow-none print:m-0">
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; margin: 0; padding: 0; }
          .print-container { padding: 14mm; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print p-4 flex justify-end gap-2 bg-neutral-100 border-b border-neutral-200">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-neutral-50"
        >
          Print / Save as PDF
        </button>
      </div>

      <div className="print-container p-8 print:p-14">
        <header className="flex items-start justify-between rounded-t-xl bg-gradient-to-r from-orange-600 to-orange-500 px-8 py-6 text-white shadow-sm print:rounded-none">
          <div>
            <h1 className="text-2xl font-black uppercase tracking-tight text-white">
              {company?.name || "Bavya Health Services"}
            </h1>
            {company?.legal_name && <p className="mt-1 text-[13px] font-medium text-orange-100">{company.legal_name}</p>}
            {company?.address && <p className="mt-1 max-w-[380px] text-[13px] leading-relaxed text-orange-100">{company.address}</p>}
          </div>
          <div className="text-right">
            <p className="text-xl font-black uppercase tracking-widest text-white">
              {issue.direction === "OUT" ? "Material Issue" : "Material Return"}
            </p>
            <p className="mt-1 font-mono text-[16px] font-bold text-white">{issue.issue_no || "Draft"}</p>
            <p className="mt-1 text-[13px] text-orange-100">Date: <span className="font-medium text-white">{fmtDate(issue.issue_date)}</span></p>
            <div className="mt-3 inline-block rounded bg-orange-700/50 px-3 py-1.5 shadow-inner">
              <p className="text-[10px] font-bold uppercase tracking-wider text-orange-200">Status</p>
              <p className="text-[13px] font-bold text-white">{issue.status}</p>
            </div>
          </div>
        </header>

        <div className="mt-8 flex flex-col gap-8">
          <section className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-6 shadow-sm">
            <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Document details</p>
            <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-[13px]">
              <div className="flex flex-col border-b border-neutral-100 pb-2">
                <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Warehouse</span>
                <span className="font-medium text-neutral-800">{issue.warehouse_id ? warehouseName : "—"}</span>
              </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Issued To</span>
              <span className="font-medium text-neutral-800">{issue.issued_to_name || "—"}</span>
            </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Indent</span>
              <span className="font-mono text-neutral-800">{issue.indent_no || "—"}</span>
            </div>
            <div className="flex flex-col border-b border-neutral-100 pb-2">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Department</span>
              <span className="font-mono text-neutral-800">{issue.department_id ? `DEPT-${issue.department_id}` : "—"}</span>
            </div>
            <div className="col-span-2 flex flex-col">
              <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">Destination</span>
              <span className="font-medium text-neutral-800">{issue.destination_office_name || "—"}</span>
            </div>
          </div>
        </section>
      </div>

      <table className="mt-8 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-y-2 border-neutral-800 bg-neutral-50/50 text-left text-[11px] uppercase tracking-wider text-neutral-600">
            <th className="py-2.5 pl-2 pr-2 w-[5%]">#</th>
            <th className="py-2.5 pr-2 w-[30%]">Item</th>
            <th className="py-2.5 pr-2 w-[15%]">Code/Batch</th>
            <th className="py-2.5 pr-2 text-right w-[15%]">Requested</th>
            <th className="py-2.5 pr-2 text-right w-[15%]">Issued</th>
            <th className="py-2.5 pl-2 w-[20%]">Remarks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {(issue.items || []).map((line: any, index: number) => (
            <tr key={line.id || index} className="align-top">
              <td className="py-3 pl-2 pr-2 text-neutral-500">{index + 1}</td>
              <td className="py-3 pr-2">
                <div className="font-bold text-neutral-900">{line.item_name ?? "—"}</div>
              </td>
              <td className="py-3 pr-2">
                <div className="font-mono text-[11px] text-neutral-700">{line.item_code ?? "—"}</div>
                {line.batch_no && (
                  <div className="mt-0.5 text-[11px] text-neutral-500">Batch: {line.batch_no}</div>
                )}
              </td>
              <td className="py-3 pr-2 text-right text-neutral-800">
                {fmtQty(line.requested_qty)} <span className="text-neutral-500">{line.uom_code ?? ""}</span>
              </td>
              <td className="py-3 pr-2 text-right font-medium text-neutral-900">
                {fmtQty(line.issued_qty)} <span className="text-neutral-500">{line.uom_code ?? ""}</span>
              </td>
              <td className="py-3 pl-2 text-neutral-700">{line.remarks || "—"}</td>
            </tr>
          ))}
          {(!issue.items || issue.items.length === 0) && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-neutral-500 italic">No items found.</td>
            </tr>
          )}
        </tbody>
      </table>

      {issue.remarks && (
        <section className="mt-6 rounded border border-neutral-200 bg-neutral-50/50 p-4">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Remarks</p>
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-neutral-800">{issue.remarks}</p>
        </section>
      )}

        <footer className="mt-16 flex justify-between text-[12px]">
          <div className="w-[200px]">
            <div className="h-16" />
            <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Prepared by</p>
          </div>
          <div className="w-[200px]">
            <div className="h-16" />
            <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Authorised signatory</p>
          </div>
          <div className="w-[200px]">
            <div className="h-16" />
            <p className="border-t border-neutral-300 pt-2 font-bold uppercase tracking-wider text-neutral-600">Receiver</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
