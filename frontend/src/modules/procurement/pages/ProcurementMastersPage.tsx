import { MastersShell, PROCUREMENT_MASTER_GROUPS } from "@/modules/masters/pages/MastersPage";

/** Procurement > Masters — who we buy from, at what rate, and at what tax.
 *
 *  The vendor register behind the RFQ and PO pickers, plus the HSN codes a PO and a
 *  GRN read their tax off. Same components as `/masters`; gated by
 *  `page.pro_masters.view`, inheriting from `page.masters.view`. */
export function ProcurementMastersPage() {
  return <MastersShell groups={PROCUREMENT_MASTER_GROUPS} eyebrow="Procurement" title="Procurement masters" />;
}
