import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Printer, X } from "lucide-react";
import bavyaLogo from "@/assets/bavya-logo.png";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import {
  INDENT_QUERY_GC_TIME, INDENT_QUERY_STALE_TIME, indentApi, indentKeys,
  isIndentUnavailableError, useIndentAccountScope,
} from "../api";
import { COMPANY_FALLBACK, resolveCompany } from "../companyProfile";
import { indentTypeLabel } from "../constants";
import { displayUom, splitDeliveryOffice } from "../displayFormat";

/**
 * The printable indent — one A4 sheet the requester, the approver or the store can
 * hand over, save as PDF, or file.
 *
 * It is a ROUTE and not a client-side HTML blob on purpose: the sheet is fetched from
 * `/api/indents/{id}` under the viewer's own token, so an indent this account may not
 * read prints nothing.
 *
 * It prints the REQUISITION and nothing else — the particulars and the lines. The
 * approval trail, the document history and where the indent has reached live on the
 * journey screen, which is the live record; a sheet that carries a snapshot of them
 * is out of date the moment it is filed.
 *
 * Colours are the app's own tokens written out literally: this page renders outside
 * AppLayout and outside the theme, and a print sheet is a light document whatever
 * the viewer's theme is.
 */

const BRAND = {
  grad1: "#FABC41",
  grad2: "#FB8B00",
  grad3: "#CC004C",
  grad4: "#4D148C",
  brand: "#CC004C",
  ink: "#141a2a",
  muted: "#697187",
  line: "#e5e8ef",
  wash: "#FDF6F0",
};

const SWEEP = `linear-gradient(90deg, ${BRAND.grad1} 0%, ${BRAND.grad2} 30%, ${BRAND.grad3} 65%, ${BRAND.grad4} 100%)`;

const PRINT_CSS = `
  @page { size: A4 portrait; margin: 12mm 11mm 16mm; }
  .sheet, .sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @media print {
    .no-print { display: none !important; }
    html, body { background: #fff !important; margin: 0; padding: 0; }
    .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important;
             max-width: none !important; padding: 0 !important; }
    /* @page already pays for the sheet's margin — the on-screen padding would
       otherwise be charged a second time and push the table off the page. */
    .sheet-body { padding: 0 0 13mm 0 !important; }
    .print-footer { position: fixed; bottom: 0; left: 0; right: 0;
                    padding-left: 0 !important; padding-right: 0 !important; }
    thead { display: table-header-group; }
    tr, .avoid-break { page-break-inside: avoid; break-inside: avoid; }
    section { break-inside: auto; }
  }
`;

function dash(value?: string | number | null) {
  const text = value === 0 ? "0" : (value ?? "").toString().trim();
  return text || "—";
}

function qty(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : String(value);
}

function Field({ label, value, span }: { label: string; value: React.ReactNode; span?: boolean }) {
  return (
    <div style={{ gridColumn: span ? "span 2" : undefined, borderColor: BRAND.line }}
         className="border-b border-dotted pb-1.5">
      <div className="text-[8.5px] font-bold uppercase tracking-[0.09em]" style={{ color: BRAND.muted }}>
        {label}
      </div>
      <div className="mt-0.5 text-[11px] font-semibold leading-snug" style={{ color: BRAND.ink }}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className="inline-block h-[11px] w-[3px] rounded-full" style={{ backgroundImage: SWEEP }} />
      <h2 className="text-[10px] font-extrabold uppercase tracking-[0.14em]" style={{ color: BRAND.ink }}>
        {children}
      </h2>
      {note && <span className="text-[9px]" style={{ color: BRAND.muted }}>{note}</span>}
    </div>
  );
}

function Th({ children, align = "left", width }: {
  children?: React.ReactNode; align?: "left" | "right" | "center"; width?: string;
}) {
  return (
    <th
      style={{ width, textAlign: align, color: "#ffffff" }}
      className="px-2 py-[6px] text-[8.5px] font-bold uppercase tracking-[0.08em]"
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left", mono, strong }: {
  children?: React.ReactNode; align?: "left" | "right" | "center"; mono?: boolean; strong?: boolean;
}) {
  return (
    <td
      style={{ textAlign: align, color: strong ? BRAND.ink : "#3d4557", borderColor: BRAND.line }}
      className={`border-b px-2 py-[7px] align-top text-[10px] leading-snug ${mono ? "font-mono" : ""} ${strong ? "font-semibold" : ""}`}
    >
      {children}
    </td>
  );
}

export function IndentPrintPage() {
  const { id } = useParams();
  const indentId = Number(id);
  const { me } = useAuth();
  const accountScope = useIndentAccountScope();

  const indentQuery = useQuery({
    queryKey: indentKeys.detail(accountScope, indentId),
    queryFn: ({ signal }) => indentApi.get(indentId, signal),
    enabled: Number.isFinite(indentId),
    staleTime: INDENT_QUERY_STALE_TIME,
    gcTime: INDENT_QUERY_GC_TIME,
  });

  const companyQuery = useQuery({
    queryKey: indentKeys.company(accountScope),
    queryFn: ({ signal }) => indentApi.company(signal),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const indent = indentQuery.data;
  const company = useMemo(() => resolveCompany(companyQuery.data), [companyQuery.data]);

  // The letterhead has to be resolved before the dialog opens, or the sheet goes out
  // under a header that arrived one paint too late.
  const ready = Boolean(indent) && !companyQuery.isLoading;
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => window.print(), 350);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    const previous = document.title;
    if (indent) document.title = `${indent.indent_no} — Indent`;
    return () => { document.title = previous; };
  }, [indent]);

  if (indentQuery.isLoading) {
    return <p className="p-10 text-sm text-neutral-600">Preparing the indent…</p>;
  }
  if (isIndentUnavailableError(indentQuery.error)) {
    return <p className="p-10 text-sm text-neutral-700">This indent is not available to your account.</p>;
  }
  if (indentQuery.error || !indent) {
    return (
      <p className="p-10 text-sm text-neutral-700">
        {(indentQuery.error as Error | null)?.message ?? "This indent could not be loaded."}
      </p>
    );
  }

  const delivery = splitDeliveryOffice(indent.office_name, indent.vehicle_number);
  const totalQty = indent.items.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const totalApproved = indent.items.reduce((sum, line) => sum + (Number(line.approved_quantity) || 0), 0);
  const totalReceived = indent.items.reduce((sum, line) => sum + (Number(line.received_quantity) || 0), 0);
  const printedBy = me?.employee?.name?.trim() || "—";

  return (
    <div style={{ background: BRAND.wash, minHeight: "100vh" }}>
      <style>{PRINT_CSS}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b px-4 py-3"
           style={{ borderColor: BRAND.line, background: "#ffffff" }}>
        <div className="text-sm font-semibold" style={{ color: BRAND.ink }}>
          {indent.indent_no}
          <span className="ml-2 text-xs font-normal" style={{ color: BRAND.muted }}>
            Print, or choose “Save as PDF” as the destination.
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            /* Pastel yellow, matching every other PDF button in the module. This
               sheet paints with inline styles rather than Tailwind (it is printed),
               so the tone is written out instead of imported from buttonTones. */
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold shadow-sm"
            style={{ background: "#fdf4d3", color: "#8a6d0b", borderColor: "#d9b40b" }}
          >
            <Printer className="h-4 w-4" /> Download PDF
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium"
            style={{ borderColor: BRAND.line, color: BRAND.muted }}
          >
            <X className="h-4 w-4" /> Close
          </button>
        </div>
      </div>

      {/* A print sheet is laid out for A4, not for a 375px viewport — its only
          consumer is window.print(). */}
      {/* mobile-ok: print sheet, fixed A4 width by design */}
      <div className="sheet mx-auto my-6 bg-white shadow-md" style={{ width: "210mm", color: BRAND.ink }}>
        <div className="sheet-body px-[11mm] py-[10mm]">

          {/* ── Letterhead ─────────────────────────────────────────────── */}
          <header className="avoid-break flex items-start justify-between gap-6">
            <div className="flex items-start gap-3">
              <img src={bavyaLogo} alt={company.name} style={{ height: 40, width: "auto" }} />
            </div>
            <div className="text-right">
              <div className="text-[15px] font-black uppercase leading-tight tracking-tight"
                   style={{ color: BRAND.brand }}>
                {company.legal_name || company.name}
              </div>
              <div className="mt-1 max-w-[92mm] text-[9px] leading-[1.45]" style={{ color: BRAND.muted }}>
                {company.address}
              </div>
              <div className="mt-1 text-[9px] font-medium" style={{ color: BRAND.muted }}>
                <span>CIN: <b style={{ color: BRAND.ink }}>{dash(company.cin)}</b></span>
                <span className="mx-1.5">·</span>
                <span>GSTIN: <b style={{ color: BRAND.ink }}>{dash(company.gstin)}</b></span>
              </div>
              {(company.phone || company.email) && (
                <div className="mt-0.5 text-[9px]" style={{ color: BRAND.muted }}>
                  {[company.phone, company.email].filter(Boolean).join("  ·  ")}
                </div>
              )}
            </div>
          </header>

          <div className="mt-3 h-[3px] w-full rounded-full" style={{ backgroundImage: SWEEP }} />

          {/* ── Document band ──────────────────────────────────────────── */}
          <div className="avoid-break mt-4 flex items-stretch justify-between gap-4 rounded-lg border px-4 py-3"
               style={{ borderColor: BRAND.line, background: "#FBF7F3" }}>
            <div>
              <div className="text-[8.5px] font-bold uppercase tracking-[0.18em]" style={{ color: BRAND.muted }}>
                {indentTypeLabel(indent.indent_type)} requisition
              </div>
              <div className="mt-0.5 text-[19px] font-black uppercase leading-none tracking-tight"
                   style={{ color: BRAND.ink }}>
                Material Indent
              </div>
              <div className="mt-1.5 font-mono text-[13px] font-bold" style={{ color: BRAND.brand }}>
                {indent.indent_no}
              </div>
            </div>
            <div className="flex flex-col items-end justify-end text-right">
              <div className="text-[9.5px] leading-relaxed" style={{ color: BRAND.muted }}>
                <div>Indent date: <b style={{ color: BRAND.ink }}>{fmtDate(indent.indent_date ?? indent.created_at)}</b></div>
                <div>Required by: <b style={{ color: BRAND.ink }}>{fmtDate(indent.required_date)}</b></div>
                <div>Priority: <b style={{ color: BRAND.ink }}>{dash(indent.priority)}</b></div>
              </div>
            </div>
          </div>

          {/* ── Requisition particulars ────────────────────────────────── */}
          <section className="mt-5">
            <SectionTitle>Requisition particulars</SectionTitle>
            <div className="grid grid-cols-4 gap-x-5 gap-y-2.5"
                 style={{ borderColor: BRAND.line }}>
              <Field label="Requested by" value={dash(indent.requested_by_name)} />
              <Field label="Position" value={dash(indent.position_name)} />
              <Field label="Department" value={dash(indent.department_name)} />
              <Field label="Region / Location" value={dash(indent.region_name)} />
              <Field label="Project" value={dash(indent.project_name)} />
              <Field label="Indent type" value={indentTypeLabel(indent.indent_type)} />
              <Field label="Raised on" value={fmtDateTime(indent.created_at)} />
              <Field label="Approved on" value={indent.approved_at ? fmtDateTime(indent.approved_at) : "—"} />
              <Field label="Deliver to" value={delivery.officeName} span />
              <Field label="Service area code" value={dash(indent.office_sac)} />
              <Field label="Vehicle" value={dash(delivery.vehicleNumber)} />
              <Field label="Total line items" value={qty(indent.total_items ?? indent.items.length)} />
              <Field label="Total quantity" value={qty(indent.total_qty ?? totalQty)} />
            </div>
          </section>

          {/* ── Line items ─────────────────────────────────────────────── */}
          <section className="mt-5">
            <SectionTitle note={`${indent.items.length} line${indent.items.length === 1 ? "" : "s"}`}>
              Line items
            </SectionTitle>
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ backgroundImage: SWEEP }}>
                  <Th width="5%">#</Th>
                  <Th width="34%">Item</Th>
                  <Th width="8%">UOM</Th>
                  <Th width="10%" align="right">Requested</Th>
                  <Th width="10%" align="right">Approved</Th>
                  <Th width="10%" align="right">Ordered</Th>
                  <Th width="10%" align="right">Received</Th>
                  <Th width="13%">Remarks</Th>
                </tr>
              </thead>
              <tbody>
                {indent.items.map((line, index) => (
                  <tr key={line.id ?? index}>
                    <Td align="center">{index + 1}</Td>
                    <Td strong>
                      <div>{dash(line.item_name)}</div>
                      <div className="mt-0.5 font-mono text-[8.5px] font-normal" style={{ color: BRAND.muted }}>
                        {dash(line.item_code)}
                      </div>
                    </Td>
                    <Td>{dash(displayUom(line.uom_code))}</Td>
                    <Td align="right" strong>{qty(line.quantity)}</Td>
                    <Td align="right">{qty(line.approved_quantity)}</Td>
                    <Td align="right">{qty(line.ordered_quantity)}</Td>
                    <Td align="right">{qty(line.received_quantity)}</Td>
                    <Td>{dash(line.remarks)}</Td>
                  </tr>
                ))}
                {indent.items.length === 0 && (
                  <tr>
                    <Td align="center">—</Td>
                    <Td>No line items on this indent.</Td>
                    <Td /><Td /><Td /><Td /><Td /><Td />
                  </tr>
                )}
              </tbody>
              {indent.items.length > 0 && (
                <tfoot>
                  <tr style={{ background: "#FBF7F3" }}>
                    <td colSpan={3}
                        className="px-2 py-[7px] text-[9px] font-bold uppercase tracking-[0.1em]"
                        style={{ color: BRAND.muted, borderTop: `1.5px solid ${BRAND.brand}` }}>
                      Total
                    </td>
                    <td className="px-2 py-[7px] text-right text-[10px] font-black"
                        style={{ color: BRAND.ink, borderTop: `1.5px solid ${BRAND.brand}` }}>{qty(totalQty)}</td>
                    <td className="px-2 py-[7px] text-right text-[10px] font-black"
                        style={{ color: BRAND.ink, borderTop: `1.5px solid ${BRAND.brand}` }}>{qty(totalApproved)}</td>
                    <td style={{ borderTop: `1.5px solid ${BRAND.brand}` }} />
                    <td className="px-2 py-[7px] text-right text-[10px] font-black"
                        style={{ color: BRAND.ink, borderTop: `1.5px solid ${BRAND.brand}` }}>{qty(totalReceived)}</td>
                    <td style={{ borderTop: `1.5px solid ${BRAND.brand}` }} />
                  </tr>
                </tfoot>
              )}
            </table>
          </section>

          {/* ── Remarks ────────────────────────────────────────────────── */}
          {(indent.remarks || indent.correction_comment) && (
            <section className="avoid-break mt-5">
              <SectionTitle>Remarks</SectionTitle>
              <div className="rounded-lg border px-3 py-2.5 text-[10px] leading-relaxed"
                   style={{ borderColor: BRAND.line, background: "#FBF7F3", color: BRAND.ink }}>
                {indent.remarks && <p className="whitespace-pre-line">{indent.remarks}</p>}
                {indent.correction_comment && (
                  <p className="mt-1.5 whitespace-pre-line" style={{ color: "#b7791f" }}>
                    <b>Returned for correction:</b> {indent.correction_comment}
                    {indent.returned_from_stage ? ` (at ${indent.returned_from_stage})` : ""}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* ── Signatures ─────────────────────────────────────────────── */}
          <section className="avoid-break mt-8 grid grid-cols-4 gap-5">
            {["Requested by", "Verified by", "Approved by", "Received by"].map((role) => (
              <div key={role}>
                <div className="h-11" />
                <div className="h-[1.5px] w-full" style={{ background: BRAND.line }} />
                <div className="mt-1 text-[8.5px] font-bold uppercase tracking-[0.1em]" style={{ color: BRAND.muted }}>
                  {role}
                </div>
                <div className="text-[8px]" style={{ color: BRAND.muted }}>Name · Signature · Date</div>
              </div>
            ))}
          </section>
        </div>

        {/* ── Footer, repeated on every printed page ───────────────────── */}
        <div className="print-footer border-t px-[11mm] py-2"
             style={{ borderColor: BRAND.line, background: "#ffffff" }}>
          <div className="flex items-center justify-between gap-4 text-[8px]" style={{ color: BRAND.muted }}>
            <span className="font-mono font-semibold" style={{ color: BRAND.ink }}>{indent.indent_no}</span>
            <span>
              {company.legal_name || COMPANY_FALLBACK.legal_name}
              {company.gstin ? `  ·  GSTIN ${company.gstin}` : ""}
            </span>
            <span>
              Printed by {printedBy} on {fmtDateTime(new Date().toISOString())}
            </span>
          </div>
          <div className="mt-0.5 text-[7.5px]" style={{ color: BRAND.muted }}>
            System-generated document from the SCM ERP. Valid without signature for internal
            circulation; the live record of this indent is the one held in the system.
          </div>
        </div>
      </div>
    </div>
  );
}
