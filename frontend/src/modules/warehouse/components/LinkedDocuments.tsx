import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText } from "lucide-react";
import { useAuth } from "@/shared/auth/AuthContext";
import { StatusPill } from "@/shared/components";
import { Section } from "./DocumentMeta";
import { listInspections } from "../api";
import { fmtDate, fmtDateTime } from "../format";
import type { Inspection, Receipt } from "../types";

/**
 * The paper trail behind one warehouse document, at the bottom of the screen that
 * owns it.
 *
 * Every document in this system points BACKWARD at the one before it, which is what
 * makes this possible with no graph table and no new column: a receipt already holds
 * its gate entry, its order, the vendor's despatch note and the consignment it came
 * off, and an inspection already holds `receipt_id`. This panel READS those pointers.
 * Nothing is written for its benefit, so it can never name a document the row does
 * not carry.
 *
 * NOT `/api/reports/traceability`, which answers the same question across every
 * module: that is gated on `report.view`, meaning "may read across the company", and
 * a storekeeper opening their own GRN must not need it. Here each row is gated on the
 * permission for the SCREEN it opens, so the trail shows a person exactly the
 * documents they could have reached on their own.
 *
 * A row with no route has no link — the vendor's despatch note has no screen in this
 * app, and a link that 404s is worse than a number on its own.
 */

export interface LinkedDoc {
  /** What kind of document this is: "Gate entry", "Purchase order". */
  kind: string;
  /** Its number — the thing a person reads. */
  number?: string | null;
  /** Status pill, where the document has one worth showing. */
  status?: string | null;
  /** One line of context: when it happened, who it was with. */
  note?: string | null;
  /** In-app route for View. Omitted when the document has no screen. */
  to?: string;
  /** Print route for Download PDF. Omitted when it has no sheet. */
  print?: string;
  /** Permission that opens the screen. The row is hidden without it. */
  can?: string;
}

function Row({ doc }: { doc: LinkedDoc }) {
  const nav = useNavigate();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-100 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {doc.kind}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-ink">
            {doc.number || "—"}
          </span>
          {doc.status && <StatusPill status={doc.status} />}
        </div>
        {doc.note && <div className="mt-0.5 truncate text-[11px] text-muted">{doc.note}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {doc.to && (
          <button
            type="button"
            title={`Open ${doc.number || doc.kind}`}
            aria-label={`Open ${doc.number || doc.kind}`}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={() => nav(doc.to!)}
          >
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">Open</span>
          </button>
        )}
        {doc.print && (
          <button
            type="button"
            title={`Download ${doc.number || doc.kind} as PDF`}
            aria-label={`Download ${doc.number || doc.kind} as PDF`}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
            onClick={() => window.open(doc.print!, "_blank")}
          >
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">PDF</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function LinkedDocuments({
  docs,
  title = "Linked documents",
  hint = "The trail behind this document. Open one, or download it as a PDF.",
}: {
  docs: LinkedDoc[];
  title?: string;
  hint?: string;
}) {
  const { can } = useAuth();
  // Gated per ROW, not per panel: a storekeeper who may read receipts but not orders
  // should see the gate entry and not the PO, rather than losing the whole trail.
  const visible = docs.filter((d) => d.number && (!d.can || can(d.can)));
  if (visible.length === 0) return null;
  return (
    <Section title={title} hint={hint}>
      <div>
        {visible.map((d, i) => <Row key={`${d.kind}-${d.number}-${i}`} doc={d} />)}
      </div>
    </Section>
  );
}

/**
 * The trail behind a receipt — the gate entry it arrived as, what was ordered, and
 * the inspection its submission raised.
 *
 * The gate entry is THE SAME ROW (`inb_receipts`, `receipt_type` says which), so it is
 * not a second document to look up: `gate_entry_no` and `gate_entry_at` are on the
 * receipt in hand. Its sheet is the gate-entry heading of the same print component.
 */
export function ReceiptLinkedDocuments({ receipt }: { receipt: Receipt }) {
  const atGate = receipt.receipt_type === "GATE_ENTRY";
  const { can } = useAuth();

  // Only the inspections raised off THIS receipt, and only for a login that may read
  // inspections at all — without `inspection.view` the request would 403 on every
  // GRN screen.
  const inspections = useQuery({
    queryKey: ["wh-receipt-inspections", receipt.id],
    queryFn: () => listInspections({ receipt_id: receipt.id, size: 20 }),
    enabled: !!receipt.id && !atGate && can("inspection.view"),
    staleTime: 30_000,
  });

  const docs = useMemo<LinkedDoc[]>(() => {
    const rows: LinkedDoc[] = [];

    if (!atGate && receipt.gate_entry_no) {
      rows.push({
        kind: "Gate entry",
        number: receipt.gate_entry_no,
        note: receipt.gate_entry_at
          ? `Arrived ${fmtDateTime(receipt.gate_entry_at)}`
          : "Recorded at the gate",
        // The same row read as the document it was at the gate. It is only editable
        // there while it is still typed GATE_ENTRY, which by definition it is not —
        // so this opens the GRN screen, and the PDF is the gate-entry sheet.
        to: `/warehouse/grn/${receipt.id}`,
        print: `/warehouse/gate-entries/${receipt.id}/print`,
        can: "receipt.view",
      });
    }

    if (receipt.po_no) {
      rows.push({
        kind: "Purchase order",
        number: receipt.po_no,
        note: receipt.vendor_name ? `Ordered from ${receipt.vendor_name}` : null,
        to: receipt.po_id ? `/pos/${receipt.po_id}` : undefined,
        print: receipt.po_id ? `/pos/${receipt.po_id}/print` : undefined,
        can: "po.view",
      });
    }

    if (receipt.despatch_note_no) {
      // Procurement owns this document and it has no screen here, so it is stated and
      // not linked.
      rows.push({
        kind: "Despatch note",
        number: receipt.despatch_note_no,
        note: "Filed by the vendor before the vehicle left",
        can: "po.view",
      });
    }

    if (receipt.transfer_no) {
      const consignment = receipt.receipt_type === "DISPATCH";
      rows.push({
        kind: consignment ? "Consignment" : "Stock transfer",
        number: receipt.transfer_no,
        note: consignment ? "Dispatched from another stocking point" : null,
        to: consignment && receipt.transfer_id
          ? `/warehouse/consignments/${receipt.transfer_id}`
          : undefined,
        print: consignment && receipt.transfer_id
          ? `/warehouse/consignments/${receipt.transfer_id}/print`
          : undefined,
        can: consignment ? "dispatch.view" : "receipt.view",
      });
    }

    for (const qc of (inspections.data?.items ?? []) as Inspection[]) {
      rows.push({
        kind: "Quality inspection",
        number: qc.inspection_no,
        status: qc.status,
        note: qc.inspection_date ? `Inspected ${fmtDate(qc.inspection_date)}` : null,
        to: `/warehouse/quality-inspection/${qc.id}`,
        print: `/warehouse/inspections/${qc.id}/print?type=INCOMING`,
        can: "inspection.view",
      });
    }

    return rows;
  }, [receipt, atGate, inspections.data]);

  return (
    <LinkedDocuments
      docs={docs}
      hint={
        atGate
          ? "What this entry was raised against. The GRN appears here once it is converted."
          : "The trail behind this receipt. Open one, or download it as a PDF."
      }
    />
  );
}

/** The trail behind an incoming inspection: the GRN it was raised off, and what that
 *  delivery itself came in on. */
export function InspectionLinkedDocuments({
  inspection,
  receipt,
}: {
  inspection: Inspection;
  receipt?: Receipt | null;
}) {
  const docs = useMemo<LinkedDoc[]>(() => {
    const rows: LinkedDoc[] = [];
    if (inspection.receipt_id && (inspection.grn_no || receipt?.grn_no)) {
      rows.push({
        kind: "Goods receipt note",
        number: inspection.grn_no || receipt?.grn_no,
        status: receipt?.status ?? null,
        note: receipt?.grn_date ? `Received ${fmtDate(receipt.grn_date)}` : null,
        to: `/warehouse/grn/${inspection.receipt_id}`,
        print: `/warehouse/grn/${inspection.receipt_id}/print`,
        can: "receipt.view",
      });
    }
    if (receipt?.gate_entry_no && inspection.receipt_id) {
      rows.push({
        kind: "Gate entry",
        number: receipt.gate_entry_no,
        note: receipt.gate_entry_at ? `Arrived ${fmtDateTime(receipt.gate_entry_at)}` : null,
        print: `/warehouse/gate-entries/${inspection.receipt_id}/print`,
        can: "receipt.view",
      });
    }
    if (receipt?.po_no) {
      rows.push({
        kind: "Purchase order",
        number: receipt.po_no,
        note: receipt.vendor_name ? `Ordered from ${receipt.vendor_name}` : null,
        to: receipt.po_id ? `/pos/${receipt.po_id}` : undefined,
        print: receipt.po_id ? `/pos/${receipt.po_id}/print` : undefined,
        can: "po.view",
      });
    }
    return rows;
  }, [inspection, receipt]);

  return (
    <LinkedDocuments
      docs={docs}
      hint="The delivery this inspection was raised off. Open it, or download it as a PDF."
    />
  );
}
