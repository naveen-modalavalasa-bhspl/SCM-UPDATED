import { type ReactNode } from "react";

export interface PrintTemplateProps {
  title: string;
  documentNo?: string;
  date?: string | null;
  status?: string | null;
  companyName?: string;
  companyLegalName?: string;
  companyAddress?: string;
  metadata: { label: string; value: ReactNode; fullWidth?: boolean; mono?: boolean }[];
  columns: { header: string; className?: string }[];
  items: ReactNode[][];
  remarks?: string | null;
}

export function PrintTemplate({
  title,
  documentNo = "Draft",
  date,
  status,
  companyName = "Bavya Health Services",
  companyLegalName,
  companyAddress,
  metadata,
  columns,
  items,
  remarks,
}: PrintTemplateProps) {
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
              {companyName}
            </h1>
            {companyLegalName && <p className="mt-1 text-[13px] font-medium text-orange-100">{companyLegalName}</p>}
            {companyAddress && <p className="mt-1 max-w-[380px] text-[13px] leading-relaxed text-orange-100">{companyAddress}</p>}
          </div>
          <div className="text-right">
            <p className="text-xl font-black uppercase tracking-widest text-white">
              {title}
            </p>
            <p className="mt-1 font-mono text-[16px] font-bold text-white">{documentNo}</p>
            {date && <p className="mt-1 text-[13px] text-orange-100">Date: <span className="font-medium text-white">{date}</span></p>}
            {status && (
              <div className="mt-3 inline-block rounded bg-orange-700/50 px-3 py-1.5 shadow-inner">
                <p className="text-[10px] font-bold uppercase tracking-wider text-orange-200">Status</p>
                <p className="text-[13px] font-bold text-white">{status}</p>
              </div>
            )}
          </div>
        </header>

        <div className="mt-8 flex flex-col gap-8">
          <section className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-6 shadow-sm">
            <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Document details</p>
            <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-[13px]">
              {metadata.map((m, i) => (
                <div key={i} className={`flex flex-col border-b border-neutral-100 pb-2 ${m.fullWidth ? 'col-span-2' : ''}`}>
                  <span className="mb-1 text-[11px] font-semibold uppercase text-neutral-400">{m.label}</span>
                  <span className={`${m.mono ? 'font-mono text-neutral-800' : 'font-medium text-neutral-800'}`}>{m.value || "—"}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <table className="mt-8 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-y-2 border-neutral-800 bg-neutral-50/50 text-left text-[11px] uppercase tracking-wider text-neutral-600">
              <th className="py-2.5 pl-2 pr-2 w-[5%]">#</th>
              {columns.map((c, i) => (
                <th key={i} className={`py-2.5 pr-2 ${c.className || ''}`}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {items.map((row, i) => (
              <tr key={i} className="align-top">
                <td className="py-3 pl-2 pr-2 text-neutral-500">{i + 1}</td>
                {row.map((cell, j) => (
                  <td key={j} className="py-3 pr-2">{cell}</td>
                ))}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="py-4 text-center text-neutral-500 italic">No items found.</td>
              </tr>
            )}
          </tbody>
        </table>

        {remarks && (
          <section className="mt-6 rounded border border-neutral-200 bg-neutral-50/50 p-4">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-neutral-500">Remarks</p>
            <p className="whitespace-pre-line text-[12px] leading-relaxed text-neutral-800">{remarks}</p>
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
