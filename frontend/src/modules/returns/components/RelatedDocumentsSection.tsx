import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Network } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { returnsApi } from "../api";
import { relatedDocumentLinks } from "../documentLinks";
import type { RelatedDocument } from "../types";
import { Fact, SectionCard } from "./DetailChrome";

/**
 * The paper trail behind the item, in one section under it.
 *
 * EVERY document the material touched anywhere in the application, in the order the work
 * happened: the intent and the indent, the allocation that decided this branch got these
 * units, the material request that went short, the requisition, the RFQ, the winning
 * quotation, the PO, the vendor's despatch note, the GRN, the inbound bench, the putaway
 * that names the lot, the picklist, the issue, the outward check, the consignment it
 * left on, both legs of transport, and the purchase return once the load has gone. The
 * reviewer checks all of it in one place instead of opening seven modules.
 *
 * All resolved server-side (`/related-documents`), including each row's LABEL — this
 * renders the rows in the order they arrive and works out nothing of its own, so a
 * document type added to the trail needs no change here.
 *
 * Each row carries the two things a reviewer does with a document behind the item: OPEN
 * it on its own screen, or take it as paper — the owning module's print sheet, which is
 * where "Save as PDF" lives. Before this the row was a number and nothing else, so
 * checking the PO meant copying its number into another tab. Both open in a NEW tab,
 * because this section is read with a decision half written in the panel above it. A
 * document with no screen behind it — the intent, which is a claim the return makes
 * rather than a document — shows neither, and one with no print sheet shows only Open
 * (`documentLinks.ts` is the single place that decides).
 *
 * The two warehouses are shown as the two different facts they are: where the material
 * CAME from (which is what the destination picker pre-fills with) and where the stock
 * physically stands today (which can never be the destination).
 */
/**
 * The fallback name for a row whose `doc_label` did not arrive — a payload served by a
 * backend older than this screen. The live name is SERVED on the row
 * (`returns/enums.py TRAIL_LABELS`), because the same document is named by this
 * section, by the journey screen and by a print sheet, and three copies of that map is
 * how one of them ends up calling a consignment a dispatch.
 */
const TYPE_LABELS: Record<string, string> = {
  INTENT: "Intent",
  INDENT: "Indent",
  ALLOCATION: "Material Allocation",
  MATERIAL_REQUEST: "Material Request",
  REQUISITION: "Requisition",
  RFQ: "RFQ",
  QUOTATION: "Vendor Quotation",
  PO: "Purchase Order",
  DESPATCH_NOTE: "Vendor Despatch Note",
  GRN: "GRN / Receipt",
  QC: "QC Inspection",
  PUTAWAY: "Putaway",
  PICKLIST: "Picklist",
  MATERIAL_ISSUE: "Material Issue",
  QC_OUTWARD: "Outward QC",
  CONSIGNMENT: "Consignment",
  SHIPMENT: "Shipment",
  PURCHASE_RETURN: "Purchase Return",
};

export function RelatedDocumentsSection({ returnId }: { returnId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", returnId, "related-documents"],
    queryFn: () => returnsApi.relatedDocuments(returnId),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <SectionCard icon={<Network className="h-4 w-4" />} title="Related documents — under the item">
        <p className="text-sm text-muted">Loading related documents…</p>
      </SectionCard>
    );
  }
  if (error) {
    return (
      <SectionCard
        tone="bad"
        icon={<Network className="h-4 w-4" />}
        title="Related documents — under the item"
      >
        <p className="text-sm text-bad">
          The related documents could not be loaded — the decision still works below.
        </p>
      </SectionCard>
    );
  }
  if (!data) return null;

  const facts: { label: string; value: string; note?: string; bad?: boolean }[] = [
    {
      label: "Originating warehouse",
      value: data.originating_warehouse_name ?? "—",
      note: data.originating_is_resolved
        ? (data.originating_source_doc ?? undefined)
        : "not named by any document — addressed-to point",
    },
    {
      label: "Where it is now",
      value: data.current_warehouse_name ?? "—",
      note: "cannot be the destination",
    },
    {
      label: "Material issue",
      value: data.material_issue_no ?? "—",
    },
    {
      label: "Intent",
      value: data.intent_label ?? data.intent ?? "—",
    },
    {
      // The category is a coarse three-way filter over a chain of THREE rungs, so the
      // rung this document actually resolved to is served beside it (and says when it
      // is a fallback rather than a fact). Composing that sentence here would mean this
      // screen deciding what a stocking point is called, which `inventory.locations`
      // already owns.
      label: "Purchase return will be filed as",
      value: data.purchase_return_category_label ?? "—",
      note: data.purchase_return_source_detail ?? undefined,
    },
    {
      label: "QC rejected after GRN",
      value: data.qc_rejected_tag ? "Yes — tagged" : "No",
      bad: data.qc_rejected_tag,
    },
  ];

  if (data.warehouse_return_no) {
    facts.push({
      label: "Warehouse document",
      value: data.warehouse_return_no,
      note: "raised when the vehicle left",
    });
  }

  return (
    <SectionCard
      icon={<Network className="h-4 w-4" />}
      title="Related documents — under the item"
      subtitle="Everything behind this material, so the whole call can be made here."
      aside={data.documents.length > 0 ? (
        <span className="tabular rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
          {data.documents.length}
        </span>
      ) : undefined}
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-xl border border-line bg-content2/50 p-3.5 md:grid-cols-3">
        {facts.map((fact) => (
          <Fact
            key={fact.label}
            label={fact.label}
            value={fact.value}
            note={fact.note}
            tone={fact.bad ? "font-semibold text-bad" : "text-ink"}
          />
        ))}
      </dl>

      {/* Only rendered when the server says a kind was capped — the normal case is a
        * complete trail and a permanent "there may be more" would read as one. */}
      {data.documents_note && (
        <p className="mb-2 text-xs text-muted">{data.documents_note}</p>
      )}

      {data.documents.length === 0 ? (
        <p className="text-sm text-muted">No related documents found for these items.</p>
      ) : (
        <ol className="space-y-2">
          {data.documents.map((doc, index) => (
            <li
              key={`${doc.doc_type}-${doc.doc_id ?? index}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3 transition-colors hover:border-brand/30 hover:bg-content2/50 motion-reduce:transition-none"
            >
              <div className="flex min-w-0 items-center gap-3">
                {/* The step number: a trail is a sequence, and the order the server sends
                  * these in IS the order the material travelled. */}
                <span
                  aria-hidden="true"
                  className="tabular grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/10 text-[11px] font-bold text-brand"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {doc.doc_label ?? TYPE_LABELS[doc.doc_type] ?? doc.doc_type}
                    </span>
                    <span className="mono truncate text-sm font-semibold text-ink">
                      {doc.doc_no ?? "—"}
                    </span>
                  </div>
                  {/* The qualifier LAST, after the facts every row carries, so the
                    * column of dates stays a column. */}
                  <div className="mt-1 text-xs text-muted">
                    {[doc.warehouse_name, doc.vendor_name, doc.date, doc.note]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {doc.status && <StatusPill status={doc.status} />}
                <DocumentActions doc={doc} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

/** Open / PDF for one row of the trail. Renders nothing at all when the document has
 *  neither address — an empty toolbar reads as a broken one. */
function DocumentActions({ doc }: { doc: RelatedDocument }) {
  const { open, print } = relatedDocumentLinks(doc);
  if (!open && !print) return null;
  const label = doc.doc_no ?? doc.doc_type;
  const style = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs "
    + "font-semibold text-muted transition-colors hover:bg-content2 hover:text-brand "
    + "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 "
    + "motion-reduce:transition-none";
  return (
    <>
      {open && (
        <a
          href={open}
          target="_blank"
          rel="noopener noreferrer"
          className={style}
          aria-label={`Open ${label}`}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open
        </a>
      )}
      {print && (
        <a
          href={print}
          target="_blank"
          rel="noopener noreferrer"
          className={style}
          aria-label={`${label} as a PDF`}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> PDF
        </a>
      )}
    </>
  );
}
