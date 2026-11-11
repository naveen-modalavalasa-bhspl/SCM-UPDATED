import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PrintTemplate } from "@/shared/components";
import { getIssue, warehouseOptions } from "../api";
import { fmtDate, fmtQty } from "../format";
import { combinationLabel } from "@/shared/combination";

/**
 * The material issue note — the paper that leaves the store with the goods.
 *
 * The sheet is `@/shared/components/PrintTemplate`; this page decides only what an
 * issue says. It used to carry its own inlined copy of the old shared template, which
 * is why an issue note and a GRN raised the same morning looked like two companies'
 * paper the moment either was edited.
 */
export function MaterialIssuePrintPage() {
  const { id } = useParams();
  const issueId = Number(id);

  const query = useQuery({
    queryKey: ["warehouse-issue", issueId],
    queryFn: () => getIssue(issueId),
    enabled: Number.isFinite(issueId) && issueId > 0,
  });

  const warehousesQuery = useQuery({
    queryKey: ["print-warehouses"],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const warehouses = warehousesQuery.data;

  // The sheet opens the print dialog on its own once it is mounted, so a warehouse
  // name still in flight would go to paper as "WH-3". Hold until it has answered.
  if (query.isLoading || warehousesQuery.isLoading)
    return <p className="p-8 text-sm">Loading the document…</p>;
  if (query.error) return <p className="p-8 text-sm">{(query.error as Error).message}</p>;
  if (!query.data) return <p className="p-8 text-sm">Document not found.</p>;

  const issue = query.data;
  // warehouseOptions returns { id, label } or { value, label } for options.
  const warehouse = warehouses?.find(
    (w: any) => w.id === issue.warehouse_id || w.value === issue.warehouse_id) as any;
  const warehouseName = warehouse?.label || warehouse?.name || `WH-${issue.warehouse_id}`;
  const outward = issue.direction === "OUT";

  // What this issue was raised against, named for what it is. It used to print one
  // "Indent" box, so an issue executing a stock transfer order read "Indent —" with the
  // STO number nowhere on the paper. An STO raised from an STR names both.
  const strNo = issue.sto_str_no ?? (issue.indent_type === "STR" ? issue.indent_no : null);
  const against: { label: string; value: string; mono: true }[] = [];
  if (strNo) against.push({ label: "STR", value: strNo, mono: true });
  if (issue.sto_no) against.push({ label: "STO", value: issue.sto_no, mono: true });
  if (!against.length) {
    against.push({
      label: "Indent",
      value: issue.indent_no || (outward ? "— (direct issue)" : "—"),
      mono: true,
    });
  }
  const destination = issue.sto_to_warehouse_name
    || issue.destination_warehouse_name || issue.destination_office_name || "—";

  return (
    <PrintTemplate
      title={outward ? "Material Issue" : "Material Return"}
      kicker={outward ? "Outward from store" : "Inward to store"}
      documentNo={issue.issue_no || "Draft"}
      dateFields={[["Issue date", fmtDate(issue.issue_date)]]}
      status={issue.status}
      metadata={[
        { label: "Warehouse", value: issue.warehouse_id ? warehouseName : "—" },
        { label: "Issued to", value: issue.issued_to_name || "—" },
        ...against,
        // Only when the issue names a department — an empty "Department —" box on
        // a stock transfer's paper reads as a field somebody forgot to fill.
        ...(issue.department_name || issue.department_id
          ? [{ label: "Department", value: issue.department_name || `DEPT-${issue.department_id}` }]
          : []),
        { label: "Destination", value: destination, fullWidth: true },
      ]}
      columns={[
        { header: "Item", width: "30%" },
        { header: "Code / Batch", width: "18%" },
        { header: "Bin", width: "12%" },
        { header: "Requested", align: "right", width: "12%" },
        { header: "Issued", align: "right", width: "12%" },
        { header: "Remarks", width: "16%" },
      ]}
      items={(issue.items || []).map((line: any) => [
        <span className="font-semibold" style={{ color: "#141a2a" }}>{line.item_name ?? "—"}</span>,
        <>
          <div className="font-mono text-[9px]">{line.item_code ?? "—"}</div>
          {combinationLabel(line) && <div className="text-[9px]">{combinationLabel(line)}</div>}
          {line.batch_no && (
            <div className="mt-0.5 text-[9px]" style={{ color: "#697187" }}>Batch: {line.batch_no}</div>
          )}
        </>,
        // `IssueItemRead` serves bin_code and nothing else, so it is the field that
        // actually fills this column; the other two are kept for a line that carries them.
        line.location_name ?? line.bin_name ?? line.bin_code ?? "—",
        <>{fmtQty(line.requested_qty)} <span style={{ color: "#697187" }}>{line.uom_code ?? ""}</span></>,
        <span className="font-semibold" style={{ color: "#141a2a" }}>
          {fmtQty(line.issued_qty)} <span className="font-normal" style={{ color: "#697187" }}>{line.uom_code ?? ""}</span>
        </span>,
        line.remarks || "—",
      ])}
      remarks={issue.remarks}
      signatures={["Prepared by", "Store keeper", "Authorised signatory", "Received by"]}
    />
  );
}
