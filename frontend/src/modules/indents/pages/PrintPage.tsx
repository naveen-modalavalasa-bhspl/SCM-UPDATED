import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PrintTemplate } from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import {
  INDENT_QUERY_GC_TIME, INDENT_QUERY_STALE_TIME, indentApi, indentKeys,
  isIndentUnavailableError, useIndentAccountScope,
} from "../api";
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
 * The paper itself — letterhead, band, table, signatures, footer — is
 * `@/shared/components/PrintTemplate`, which every other printed document in the
 * system now comes out on. This page is the one that decides WHAT an indent says.
 */

function dash(value?: string | number | null) {
  const text = value === 0 ? "0" : (value ?? "").toString().trim();
  return text || "—";
}

function qty(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : String(value);
}

export function IndentPrintPage() {
  const { id } = useParams();
  const indentId = Number(id);
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
  // Handed to the sheet rather than left for it to fetch: the module already asks for
  // the letterhead on its own key, and two queries for one row would print twice.
  // Always a value, never undefined — undefined is what tells the sheet to go and
  // fetch the letterhead itself, and it must not do that behind this page.
  const company = useMemo(() => companyQuery.data ?? null, [companyQuery.data]);

  if (indentQuery.isLoading || companyQuery.isLoading) {
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

  return (
    <PrintTemplate
      title="Material Indent"
      kicker={`${indentTypeLabel(indent.indent_type)} requisition`}
      documentNo={indent.indent_no}
      company={company}
      dateFields={[
        ["Indent date", fmtDate(indent.indent_date ?? indent.created_at)],
        ["Required by", fmtDate(indent.required_date)],
        ["Priority", dash(indent.priority)],
      ]}
      metadata={[
        { label: "Requested by", value: dash(indent.requested_by_name) },
        { label: "Position", value: dash(indent.position_name) },
        { label: "Department", value: dash(indent.department_name) },
        { label: "Region / Location", value: dash(indent.region_name) },
        { label: "Raised By", value: dash(indent.project_name) },
        { label: "Indent type", value: indentTypeLabel(indent.indent_type) },
        { label: "Raised on", value: fmtDateTime(indent.created_at) },
        { label: "Approved on", value: indent.approved_at ? fmtDateTime(indent.approved_at) : "—" },
        { label: "Deliver to", value: delivery.officeName, fullWidth: true },
        { label: "Service area code", value: dash(indent.office_sac) },
        { label: "Vehicle", value: dash(delivery.vehicleNumber) },
        { label: "Total line items", value: qty(indent.total_items ?? indent.items.length) },
        { label: "Total quantity", value: qty(indent.total_qty ?? totalQty) },
      ]}
      columns={[
        { header: "Item", width: "34%" },
        { header: "UOM", width: "8%" },
        { header: "Requested", align: "right", width: "10%" },
        { header: "Approved", align: "right", width: "10%" },
        { header: "Ordered", align: "right", width: "10%" },
        { header: "Received", align: "right", width: "10%" },
        { header: "Remarks", width: "13%" },
      ]}
      items={indent.items.map((line) => [
        <>
          <div className="font-semibold" style={{ color: "#141a2a" }}>{dash(line.item_name)}</div>
          <div className="mt-0.5 font-mono text-[8.5px] font-normal" style={{ color: "#697187" }}>
            {dash(line.item_code)}
          </div>
          {(line.brand_name || line.combination_any) && (
            <div className="mt-0.5 text-[8.5px] font-semibold" style={{ color: "#697187" }}>
              {line.combination_any ? "Any brand"
                : [line.brand_name, line.variant_name, line.model_name].filter(Boolean).join(" · ")}
            </div>
          )}
        </>,
        dash(displayUom(line.uom_code)),
        <span className="font-semibold" style={{ color: "#141a2a" }}>{qty(line.quantity)}</span>,
        qty(line.approved_quantity),
        qty(line.ordered_quantity),
        qty(line.received_quantity),
        dash(line.remarks),
      ])}
      itemsTotal={[
        "", "",
        qty(totalQty), qty(totalApproved), "", qty(totalReceived), "",
      ]}
      remarks={
        (indent.remarks || indent.correction_comment) ? (
          <>
            {indent.remarks && <p className="whitespace-pre-line">{indent.remarks}</p>}
            {indent.correction_comment && (
              <p className="mt-1.5 whitespace-pre-line" style={{ color: "#b7791f" }}>
                <b>Returned for correction:</b> {indent.correction_comment}
                {indent.returned_from_stage ? ` (at ${indent.returned_from_stage})` : ""}
              </p>
            )}
          </>
        ) : null
      }
      signatures={["Requested by", "Verified by", "Approved by", "Received by"]}
      footerNote="System-generated document from the SCM ERP. Valid without signature for internal circulation; the live record of this indent is the one held in the system."
    />
  );
}
