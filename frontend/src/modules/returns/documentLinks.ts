import type { RelatedDocument } from "./types";

/**
 * Where each document in the trail can be READ, and where it can be printed.
 *
 * The trail behind a return is a dozen other modules' documents, and a reviewer who has
 * to check one had only its number to go on — they were typing "BHS/104/2026-27/PO0012"
 * into another tab's search box. Every one of these screens already exists; nothing new
 * is served, this only names the address.
 *
 * `print` is the document as paper — the same `/print` routes the owning module's own
 * screens use, which render the sheet and open the browser's print dialog, where "Save
 * as PDF" is. A type with no print route returns null and the row simply omits the
 * action rather than offering one that lands on a blank page.
 *
 * Three kinds of row deliberately address NOTHING, and they are not omissions:
 * the intent, which is a claim the return makes rather than a document; the vendor's
 * despatch note, which is read on the GRN it prefills and has no screen of its own; and
 * a document whose id did not survive (an indent named only by the number snapshotted
 * onto the return). Each still earns its place in the trail — a number a reviewer can
 * quote is worth more than a gap — and each renders with no buttons.
 *
 * A quotation is the one row whose link is not built from its own id: a quote means
 * something only beside the ones it was compared against, so it opens the RFQ's
 * comparison sheet. `extra.rfq_id` rides on the row for exactly that.
 *
 * Both open in a NEW TAB on purpose: this section is read mid-decision, with a comment
 * half typed in the panel above it, and navigating away throws that away.
 */
export interface DocumentLinks {
  open: string | null;
  print: string | null;
}

/** A number off `extra`, or null. The payload is typed `Record<string, unknown>`
 *  because it carries a different shape per document type, so every read of it is
 *  checked rather than cast. */
function extraId(doc: RelatedDocument, key: string): number | null {
  const value = doc.extra?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function relatedDocumentLinks(doc: RelatedDocument): DocumentLinks {
  const id = doc.doc_id;
  if (doc.doc_type === "QUOTATION") {
    const rfqId = extraId(doc, "rfq_id");
    return { open: rfqId ? `/procurement/rfqs/${rfqId}` : null, print: null };
  }
  if (!id) return { open: null, print: null };
  switch (doc.doc_type) {
    case "INDENT":
      return { open: `/indents/${id}`, print: `/indents/${id}/print` };
    case "ALLOCATION":
      // The approval screen, which is where an allocation is read whether or not a
      // ladder is configured for it — there is no second, plainer view of one.
      return { open: `/inventory/allocation-approvals/${id}`, print: null };
    case "MATERIAL_REQUEST":
      return { open: `/inventory/material-requests/${id}`, print: null };
    case "REQUISITION":
      return { open: `/procurement/requisitions/${id}`, print: null };
    case "RFQ":
      return { open: `/procurement/rfqs/${id}`, print: null };
    case "PO":
      return { open: `/pos/${id}`, print: `/pos/${id}/print` };
    case "GRN":
      return { open: `/warehouse/grn/${id}`, print: `/warehouse/grn/${id}/print` };
    case "QC": {
      // One table, two points in the flow (`inb_inspections.inspection_type`), and the
      // print sheet asks which — served on the row rather than assumed, even though the
      // chain only ever reaches this through a GRN.
      const type = typeof doc.extra?.inspection_type === "string"
        ? doc.extra.inspection_type
        : null;
      return {
        open: `/warehouse/quality-inspection/${id}`,
        print: `/warehouse/inspections/${id}/print${type ? `?type=${type}` : ""}`,
      };
    }
    case "QC_OUTWARD":
      // A different table (`whs_inspections`) and its own screen, but the SAME print
      // page — it renders either direction and asks which by query string.
      return {
        open: `/warehouse/qc-outward/${id}`,
        print: `/warehouse/inspections/${id}/print?type=OUTGOING`,
      };
    case "PUTAWAY":
      return { open: `/warehouse/putaway/${id}`, print: `/warehouse/putaway/${id}/print` };
    case "PICKLIST":
      // The screen is `picklist`, the print sheet is `picklists`. Both are the live
      // routes; the inconsistency is theirs and copying it here is what makes the
      // links work.
      return {
        open: `/warehouse/picklist/${id}`,
        print: `/warehouse/picklists/${id}/print`,
      };
    case "MATERIAL_ISSUE":
      return {
        open: `/warehouse/material-issues/${id}`,
        print: `/warehouse/material-issues/${id}/print`,
      };
    case "CONSIGNMENT":
      // Logistics' door onto the warehouse's document: `/logistics/consignments` is
      // where the outward leg is worked, and the gate pass still prints off the
      // warehouse route that renders it.
      return {
        open: `/logistics/consignments/${id}`,
        print: `/warehouse/consignments/${id}/print`,
      };
    case "SHIPMENT":
      // No print: the sheet behind a shipment is the GATE PASS, which is a different
      // document about a different moment, and offering it under "PDF" here would hand
      // a reviewer the wrong piece of paper.
      return { open: `/logistics/shipments/${id}`, print: null };
    case "PURCHASE_RETURN":
      return { open: `/warehouse/purchase-returns/${id}`, print: null };
    default:
      return { open: null, print: null };
  }
}
