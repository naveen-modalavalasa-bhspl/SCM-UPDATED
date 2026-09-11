import { Fragment, useEffect, type ReactNode } from "react";
import { Printer, X } from "lucide-react";
import bavyaLogo from "@/assets/bavya-logo.png";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDateTime } from "@/shared/datetime";
import {
  COMPANY_FALLBACK, resolveCompany, useCompanyProfile, type CompanyProfile,
} from "./companyProfile";

/**
 * The one sheet every printed document in the system comes out on.
 *
 * There is no server-side PDF renderer and there is not going to be one: a print
 * route is a page fetched under the VIEWER'S OWN token, and "Download PDF" is the
 * browser's print dialog with Save as PDF as the destination. That is what makes the
 * paper safe — a document this account may not read prints nothing, because the API
 * refuses it, not because a screen hid a button. A server-side renderer would have to
 * be handed an identity and would drift from what is on the screen; this cannot.
 *
 * The design is the printed indent's, promoted. Before this there were three: the
 * indent's letterhead, an orange gradient one shared by seven warehouse notes, and a
 * plain rule-under-the-header one that the purchase order and the gate pass had a
 * copy of each. Same company, same filing cabinet, four different papers.
 *
 * WHAT A SHEET NEVER CARRIES is the approval trail. The document's own status is on
 * it, because that is a fact about the paper; who signed it and where it has reached
 * live on the journey screen, which stays live. A sheet that carries a snapshot of
 * the workflow is out of date the moment it is filed, and filing it is exactly what
 * happens to it.
 *
 * Colours are written out literally rather than taken from the Tailwind theme: this
 * renders outside AppLayout, and a print sheet is a light document whatever the
 * viewer's theme is.
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
  panel: "#FBF7F3",
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

export interface PrintField {
  label: string;
  value: ReactNode;
  /** Two columns wide, for an address or an office name that will not fit one. */
  fullWidth?: boolean;
  mono?: boolean;
}

export interface PrintBlock {
  title: string;
  fields: PrintField[];
  /** Fields per row. Four suits short answers; two suits addresses. */
  columns?: 2 | 3 | 4;
}

export interface PrintColumn {
  header: string;
  align?: "left" | "right" | "center";
  width?: string;
}

export interface PrintTemplateProps {
  /** What the document is called on the paper — "Material Indent", "Purchase Order". */
  title: string;
  /** The small line above it: "Consumable requisition", "Outward". Optional. */
  kicker?: string;
  documentNo?: string;
  /** Right of the document band, one per line: [label, value]. */
  dateFields?: [string, ReactNode][];
  /** Kept for the callers that pass a single date; folded into `dateFields`. */
  date?: string | null;
  status?: string | null;
  /**
   * The letterhead. Pass it when the caller already holds the settings row; leave it
   * out and the sheet reads `/api/settings/company` itself.
   */
  company?: Partial<CompanyProfile> | null;
  /** The particulars grid under the band. */
  metadata: PrintField[];
  /** Titled field groups after the particulars — addresses, who is carrying it. */
  blocks?: PrintBlock[];
  columns: PrintColumn[];
  items: ReactNode[][];
  /** Heading over the table. "Line items" unless the document calls it something else. */
  itemsTitle?: string;
  /** A totals row across the foot of the table. One cell per column, `#` excluded. */
  itemsTotal?: ReactNode[];
  /** Anything between the table and the remarks — money totals, terms, an amendment. */
  children?: ReactNode;
  remarks?: ReactNode;
  remarksTitle?: string;
  /** Who signs. Four boxes unless the document is signed by different hands. */
  signatures?: string[];
  /** Opens the print dialog once the sheet is on the page. */
  autoPrint?: boolean;
  /** The line under the footer rule. The system-generated note unless replaced. */
  footerNote?: ReactNode;
}

function Field({ label, value, fullWidth, mono }: PrintField) {
  return (
    <div style={{ gridColumn: fullWidth ? "span 2" : undefined, borderColor: BRAND.line }}
         className="border-b border-dotted pb-1.5">
      <div className="text-[8.5px] font-bold uppercase tracking-[0.09em]" style={{ color: BRAND.muted }}>
        {label}
      </div>
      <div className={`mt-0.5 text-[11px] font-semibold leading-snug ${mono ? "font-mono" : ""}`}
           style={{ color: BRAND.ink }}>
        {value === null || value === undefined || value === "" ? "—" : value}
      </div>
    </div>
  );
}

export function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
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

/** A panel in the sheet's own paper stock, for anything a document adds of its own. */
export function PrintPanel({ title, tone = "plain", children }: {
  title?: string; tone?: "plain" | "warn"; children: ReactNode;
}) {
  const warn = tone === "warn";
  return (
    <div className="avoid-break rounded-lg border px-3 py-2.5 text-[10px] leading-relaxed"
         style={{
           borderColor: warn ? "#e8d5a8" : BRAND.line,
           background: warn ? "#fdf8ec" : BRAND.panel,
           color: warn ? "#8a6d0b" : BRAND.ink,
         }}>
      {title && (
        <div className="mb-1 text-[8.5px] font-bold uppercase tracking-[0.1em]"
             style={{ color: warn ? "#b7791f" : BRAND.muted }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function Th({ children, align = "left", width }: {
  children?: ReactNode; align?: "left" | "right" | "center"; width?: string;
}) {
  return (
    <th style={{ width, textAlign: align, color: "#ffffff" }}
        className="px-2 py-[6px] text-[8.5px] font-bold uppercase tracking-[0.08em]">
      {children}
    </th>
  );
}

const DEFAULT_SIGNATURES = ["Prepared by", "Verified by", "Authorised signatory", "Received by"];

export function PrintTemplate({
  title,
  kicker,
  documentNo = "Draft",
  dateFields,
  date,
  status,
  company: given,
  metadata,
  blocks,
  columns,
  items,
  itemsTitle = "Line items",
  itemsTotal,
  children,
  remarks,
  remarksTitle = "Remarks",
  signatures = DEFAULT_SIGNATURES,
  autoPrint = true,
  footerNote,
}: PrintTemplateProps) {
  const { me } = useAuth();
  // Only fetch when the caller has not already got the settings row in hand.
  const fetched = useCompanyProfile(given === undefined);
  const company = given === undefined ? fetched.company : resolveCompany(given);
  const letterheadSettled = given === undefined ? fetched.settled : true;

  useEffect(() => {
    const previous = document.title;
    document.title = `${documentNo} — ${title}`;
    return () => { document.title = previous; };
  }, [documentNo, title]);

  // The letterhead has to be resolved before the dialog opens, or the sheet goes out
  // under a header that arrived one paint too late.
  useEffect(() => {
    if (!autoPrint || !letterheadSettled) return;
    const timer = setTimeout(() => window.print(), 350);
    return () => clearTimeout(timer);
  }, [autoPrint, letterheadSettled]);

  const printedBy = me?.employee?.name?.trim() || "—";
  const dates: [string, ReactNode][] = [
    ...(date ? ([["Date", date]] as [string, ReactNode][]) : []),
    ...(dateFields ?? []),
  ];

  return (
    <div style={{ background: BRAND.wash, minHeight: "100vh" }}>
      <style>{PRINT_CSS}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b px-4 py-3"
           style={{ borderColor: BRAND.line, background: "#ffffff" }}>
        <div className="text-sm font-semibold" style={{ color: BRAND.ink }}>
          {documentNo}
          <span className="ml-2 text-xs font-normal" style={{ color: BRAND.muted }}>
            Print, or choose “Save as PDF” as the destination.
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            /* Pastel yellow, matching every other PDF button in the app. This sheet
               paints with inline styles rather than Tailwind (it is printed), so the
               tone is written out instead of imported from buttonTones. */
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
                <span>CIN: <b style={{ color: BRAND.ink }}>{company.cin || "—"}</b></span>
                <span className="mx-1.5">·</span>
                <span>GSTIN: <b style={{ color: BRAND.ink }}>{company.gstin || "—"}</b></span>
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
               style={{ borderColor: BRAND.line, background: BRAND.panel }}>
            <div>
              {kicker && (
                <div className="text-[8.5px] font-bold uppercase tracking-[0.18em]" style={{ color: BRAND.muted }}>
                  {kicker}
                </div>
              )}
              <div className="mt-0.5 text-[19px] font-black uppercase leading-none tracking-tight"
                   style={{ color: BRAND.ink }}>
                {title}
              </div>
              <div className="mt-1.5 font-mono text-[13px] font-bold" style={{ color: BRAND.brand }}>
                {documentNo}
              </div>
            </div>
            <div className="flex flex-col items-end justify-end text-right">
              <div className="text-[9.5px] leading-relaxed" style={{ color: BRAND.muted }}>
                {dates.map(([label, value]) => (
                  <div key={label}>{label}: <b style={{ color: BRAND.ink }}>{value || "—"}</b></div>
                ))}
                {status && <div>Status: <b style={{ color: BRAND.ink }}>{status}</b></div>}
              </div>
            </div>
          </div>

          {/* ── Particulars ────────────────────────────────────────────── */}
          {metadata.length > 0 && (
            <section className="mt-5">
              <SectionTitle>Document particulars</SectionTitle>
              <div className="grid grid-cols-4 gap-x-5 gap-y-2.5">
                {metadata.map((field, i) => <Field key={i} {...field} />)}
              </div>
            </section>
          )}

          {/* ── Extra field groups ─────────────────────────────────────── */}
          {blocks?.map((block) => (
            <section key={block.title} className="avoid-break mt-5">
              <SectionTitle>{block.title}</SectionTitle>
              <div className={`grid gap-x-5 gap-y-2.5 grid-cols-${block.columns ?? 4}`}
                   style={{ gridTemplateColumns: `repeat(${block.columns ?? 4}, minmax(0, 1fr))` }}>
                {block.fields.map((field, i) => <Field key={i} {...field} />)}
              </div>
            </section>
          ))}

          {/* ── Line items ─────────────────────────────────────────────── */}
          <section className="mt-5">
            <SectionTitle note={`${items.length} line${items.length === 1 ? "" : "s"}`}>
              {itemsTitle}
            </SectionTitle>
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ backgroundImage: SWEEP }}>
                  <Th width="5%">#</Th>
                  {columns.map((c, i) => (
                    <Th key={i} align={c.align} width={c.width}>{c.header}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((row, i) => (
                  <tr key={i}>
                    <td className="border-b px-2 py-[7px] text-center align-top text-[10px]"
                        style={{ color: "#3d4557", borderColor: BRAND.line }}>{i + 1}</td>
                    {row.map((cell, j) => (
                      <td key={j}
                          style={{ textAlign: columns[j]?.align ?? "left", color: "#3d4557", borderColor: BRAND.line }}
                          className="border-b px-2 py-[7px] align-top text-[10px] leading-snug">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1}
                        className="border-b px-2 py-3 text-center text-[10px] italic"
                        style={{ color: BRAND.muted, borderColor: BRAND.line }}>
                      No lines on this document.
                    </td>
                  </tr>
                )}
              </tbody>
              {itemsTotal && items.length > 0 && (
                <tfoot>
                  <tr style={{ background: BRAND.panel }}>
                    <td className="px-2 py-[7px] text-[9px] font-bold uppercase tracking-[0.1em]"
                        style={{ color: BRAND.muted, borderTop: `1.5px solid ${BRAND.brand}` }}>
                      Total
                    </td>
                    {itemsTotal.map((cell, i) => (
                      <td key={i}
                          className="px-2 py-[7px] text-[10px] font-black"
                          style={{
                            textAlign: columns[i]?.align ?? "left",
                            color: BRAND.ink,
                            borderTop: `1.5px solid ${BRAND.brand}`,
                          }}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </section>

          {/* ── Whatever this document adds of its own ─────────────────── */}
          {children}

          {/* ── Remarks ────────────────────────────────────────────────── */}
          {remarks && (
            <section className="avoid-break mt-5">
              <SectionTitle>{remarksTitle}</SectionTitle>
              <PrintPanel>
                {typeof remarks === "string"
                  ? <p className="whitespace-pre-line">{remarks}</p>
                  : remarks}
              </PrintPanel>
            </section>
          )}

          {/* ── Signatures ─────────────────────────────────────────────── */}
          {signatures.length > 0 && (
            <section className="avoid-break mt-8 grid gap-5"
                     style={{ gridTemplateColumns: `repeat(${signatures.length}, minmax(0, 1fr))` }}>
              {signatures.map((role) => (
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
          )}
        </div>

        {/* ── Footer, repeated on every printed page ───────────────────── */}
        <div className="print-footer border-t px-[11mm] py-2"
             style={{ borderColor: BRAND.line, background: "#ffffff" }}>
          <div className="flex items-center justify-between gap-4 text-[8px]" style={{ color: BRAND.muted }}>
            <span className="font-mono font-semibold" style={{ color: BRAND.ink }}>{documentNo}</span>
            <span>
              {company.legal_name || COMPANY_FALLBACK.legal_name}
              {company.gstin ? `  ·  GSTIN ${company.gstin}` : ""}
            </span>
            <span>
              Printed by {printedBy} on {fmtDateTime(new Date().toISOString())}
            </span>
          </div>
          <div className="mt-0.5 text-[7.5px]" style={{ color: BRAND.muted }}>
            {footerNote ?? (
              <Fragment>
                System-generated document from the SCM ERP. Valid without signature for internal
                circulation; the live record of this document is the one held in the system.
              </Fragment>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
