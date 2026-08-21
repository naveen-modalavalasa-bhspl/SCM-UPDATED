import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { transportApi } from "../api";
import { carriageLabel, modeLabel } from "../components/modeCopy";
import {
  CARRYING_LABEL, carryingFields, carryingValue,
} from "../components/gatePassFields";
import { fmtDate } from "@/shared/datetime";

/**
 * The gate pass — the paper the load leaves the gate with.
 *
 * Mounted OUTSIDE the app shell, the same way the purchase order's print view is, so
 * what comes out of the printer is the pass and not a sidebar with a pass next to it.
 * "Download PDF" is the browser's own print dialog with Save as PDF as the
 * destination: there is no server-side renderer to keep in step with this page,
 * nothing to install, and what is saved is exactly what is on the screen.
 *
 * Every field THIS MODE records is printed, including the empty ones: a blank vehicle
 * number on a gate pass is information — it says the carrier has not told us yet, and
 * the security desk should not let the load go on it. WHICH fields a mode records is
 * `carryingFields`, derived from the rule the API serves, so the paper and the dispatch
 * screen carry the same lines and neither prints an LR number on a hand-over.
 */

const dash = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || "—";
};

/** One label over its value. The whole sheet is built out of these, so a field that
 *  nobody has answered still occupies its place on the paper. */
function Cell({ label, value, wide }: {
  label: string; value?: string | number | null; wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p className="mt-0.5 text-[12px] font-medium text-neutral-900">{dash(value)}</p>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 break-inside-avoid">
      <h2 className="border-b border-neutral-300 pb-1 text-[11px] font-bold uppercase tracking-widest text-neutral-700">
        {title}
      </h2>
      <div className="mt-2 grid grid-cols-4 gap-x-4 gap-y-3">{children}</div>
    </section>
  );
}

export function GatePassPrintPage() {
  const { id } = useParams();
  const trId = Number(id);
  const [params] = useSearchParams();
  // Opened from "Download PDF" rather than from "Print". Same dialog either way — the
  // difference is only which destination the person is told to pick.
  const saving = params.get("save") === "1";

  const tr = useQuery({
    queryKey: ["transport", String(trId)],
    queryFn: () => transportApi.get(trId),
    enabled: Number.isFinite(trId) && trId > 0,
  });

  // What this mode records. The pass asks the same served rule the dispatch screen
  // does, rather than printing all seventeen boxes on every leg.
  const { data: modes } = useQuery({
    queryKey: ["transport-modes"], queryFn: transportApi.modes,
  });

  // Whose paper this pass is issued on. Read from settings rather than hardcoded —
  // there is one company today and the header still has to say which.
  const { data: company } = useQuery({
    queryKey: ["print-company"],
    queryFn: () =>
      api.get<{ company?: Record<string, string> }>("/api/settings")
        .then((r) => r.data.company ?? {})
        .catch(() => ({} as Record<string, string>)),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Print once the pass is actually on the page. Firing on mount opens the dialog
  // over an empty sheet.
  useEffect(() => {
    if (!tr.data) return;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [tr.data]);

  if (tr.isLoading) return <p className="p-8 text-sm">Loading the gate pass…</p>;
  if (tr.error) return <p className="p-8 text-sm">{(tr.error as Error).message}</p>;
  if (!tr.data) return <p className="p-8 text-sm">Shipment not found.</p>;

  const doc = tr.data;
  const items = doc.items ?? [];
  const rule = modes?.find((m) => m.value === doc.mode);
  const gatePassNo = doc.gate_pass_no || `GP/${doc.consignment_no ?? doc.tr_no}`;

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-[13px] leading-snug text-black print:p-0">
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print mb-4 flex items-center justify-between gap-2">
        <p className="text-[12px] text-neutral-600">
          {saving
            ? "Choose “Save as PDF” as the destination in the dialog."
            : "The dialog opens on its own — pick the printer, or Save as PDF."}
        </p>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          Print / Save as PDF
        </button>
      </div>

      <header className="flex items-start justify-between border-b-2 border-neutral-800 pb-5">
        <div>
          <h1 className="text-xl font-black uppercase tracking-tight text-neutral-900">
            {company?.name || "Gate pass"}
          </h1>
          {company?.legal_name && (
            <p className="mt-1 text-[12px] font-medium text-neutral-700">{company.legal_name}</p>
          )}
          {company?.address && (
            <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-neutral-600">
              {company.address}
            </p>
          )}
          <p className="mt-2 text-[12px] text-neutral-500">
            {company?.gstin ? <span className="font-medium">GSTIN {company.gstin}</span> : ""}
            {company?.phone ? ` · ${company.phone}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-black uppercase tracking-widest text-neutral-800">
            Gate Pass
          </p>
          <p className="mt-1 font-mono text-[15px] font-bold text-neutral-900">
            {gatePassNo}
          </p>
          <p className="mt-1 text-[12px] text-neutral-600">
            Date: <span className="font-medium text-neutral-900">{fmtDate(doc.tr_date ?? doc.created_at)}</span>
          </p>
          <div className="mt-2 inline-block rounded border border-neutral-200 bg-neutral-50 px-2 py-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-600">Status</p>
            <p className="text-[12px] font-medium text-neutral-900">{doc.status}</p>
          </div>
        </div>
      </header>

      {/* Which papers this one pass answers for. A gate pass with no consignment
          number on it cannot be checked against the packing list at the gate. */}
      <Block title="The documents">
        <Cell label="Shipment" value={doc.tr_no} />
        <Cell label="Consignment" value={doc.consignment_no} />
        <Cell label="Indent" value={doc.indent_no} />
        <Cell label="Project" value={doc.project_name} />
      </Block>

      <Block title="Where it is going">
        <Cell label="From" value={doc.from_warehouse_name} wide />
        <Cell label="To" value={doc.to_location_name} wide />
        <Cell label="Delivery address" value={doc.delivery_address} wide />
        <Cell label="Contact" value={doc.contact_person} />
        <Cell label="Contact phone" value={doc.contact_phone} />
      </Block>

      <Block title="How it travels">
        <Cell label="Carriage" value={carriageLabel(doc.carriage_mode)} />
        <Cell label="Arrangement" value={modeLabel(doc.mode)} />
        <Cell label="Distance" value={doc.distance_km ? `${doc.distance_km} km` : null} />
      </Block>

      {/* Filled in by whoever actually knows it — the carrier in their own portal on a
          courier or third-party leg, the desk on the two we drive ourselves. WHICH
          boxes appear belongs to the mode, not to this page. */}
      <Block title="Who is carrying it">
        {carryingFields(rule, doc).map((field) => (
          <Cell key={field} label={CARRYING_LABEL[field]}
            value={carryingValue(field, doc)} />
        ))}
      </Block>

      <section className="mt-5">
        <h2 className="border-b border-neutral-300 pb-1 text-[11px] font-bold uppercase tracking-widest text-neutral-700">
          The load
        </h2>
        <table className="mt-2 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wider text-neutral-500">
              <th className="py-1.5 pr-2 font-semibold">#</th>
              <th className="py-1.5 pr-2 font-semibold">Item</th>
              <th className="py-1.5 pr-2 text-right font-semibold">Qty</th>
              <th className="py-1.5 pr-2 text-right font-semibold">Packages</th>
              <th className="py-1.5 text-right font-semibold">Weight (kg)</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-neutral-500">
                  No lines on this shipment.
                </td>
              </tr>
            )}
            {items.map((line) => (
              <tr key={line.id} className="border-b border-neutral-200 align-top">
                <td className="py-1.5 pr-2 text-neutral-600">{line.line_no}</td>
                <td className="py-1.5 pr-2">
                  <span className="font-medium text-neutral-900">{dash(line.item_name)}</span>
                  {line.item_code && (
                    <span className="ml-1 font-mono text-[11px] text-neutral-500">
                      {line.item_code}
                    </span>
                  )}
                  {line.is_fragile && (
                    <span className="ml-1 text-[10px] font-bold uppercase text-neutral-700">
                      · fragile
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right">
                  {line.quantity} {line.uom_code ?? ""}
                </td>
                <td className="py-1.5 pr-2 text-right">{line.package_count}</td>
                <td className="py-1.5 text-right">{line.weight_kg ?? "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-800 font-semibold">
              <td className="py-2 pr-2" colSpan={2}>
                Total · {doc.total_items} item{doc.total_items === 1 ? "" : "s"}
              </td>
              <td className="py-2 pr-2 text-right">{doc.total_qty}</td>
              <td className="py-2 pr-2 text-right">{doc.total_packages}</td>
              <td className="py-2 text-right">{doc.total_weight_kg}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      {/* Three hands touch the load on the way out, and the pass is the only place all
          three sign. Printed as empty boxes on purpose — they are signed on paper. */}
      <section className="mt-10 grid grid-cols-3 gap-6 break-inside-avoid">
        {[
          ["Dispatched by", doc.dispatched_by_name ?? doc.requested_by_name],
          ["Security / gate", null],
          ["Received by", doc.received_by_name],
        ].map(([label, name]) => (
          <div key={label as string}>
            <div className="h-12 border-b border-neutral-400" />
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {label}
            </p>
            <p className="text-[12px] text-neutral-800">{dash(name)}</p>
          </div>
        ))}
      </section>

      <p className="mt-6 text-[10px] text-neutral-500">
        Printed {fmtDate(new Date().toISOString())} · {doc.tr_no}
        {doc.consignment_no ? ` · ${doc.consignment_no}` : ""}
      </p>
    </div>
  );
}
