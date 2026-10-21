import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PrintTemplate, type PrintColumn, type PrintField } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { displayUom } from "@/modules/indents/displayFormat";
import { transportApi } from "../api";
import { carriageLabel, modeLabel } from "../components/modeCopy";
import {
  CARRYING_LABEL, carryingFields, carryingValue,
} from "../components/gatePassFields";

/**
 * The gate pass — the paper the load leaves the gate with.
 *
 * Mounted OUTSIDE the app shell, the same way the purchase order's print view is, so
 * what comes out of the printer is the pass and not a sidebar with a pass next to it.
 * "Download PDF" is the browser's own print dialog with Save as PDF as the
 * destination: there is no server-side renderer to keep in step with this page,
 * nothing to install, and what is saved is exactly what is on the screen.
 *
 * The sheet is `@/shared/components/PrintTemplate` — the same paper as the indent the
 * load is serving and the order it was bought on, which is what a guard checking one
 * against another needs them to be.
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

export function GatePassPrintPage() {
  const { id } = useParams();
  const trId = Number(id);

  const tr = useQuery({
    queryKey: ["transport", String(trId)],
    queryFn: () => transportApi.get(trId),
    enabled: Number.isFinite(trId) && trId > 0,
  });

  // What this mode records. The pass asks the same served rule the dispatch screen
  // does, rather than printing all seventeen boxes on every leg.
  const modes = useQuery({
    queryKey: ["transport-modes"], queryFn: transportApi.modes,
  });

  // The pass must not go to the printer before the mode rule has landed, or it prints
  // every field on a leg that records four of them.
  if (tr.isLoading || modes.isLoading) return <p className="p-8 text-sm">Loading the gate pass…</p>;
  if (tr.error) return <p className="p-8 text-sm">{(tr.error as Error).message}</p>;
  if (!tr.data) return <p className="p-8 text-sm">Shipment not found.</p>;

  const doc = tr.data;
  const items = doc.items ?? [];
  const rule = modes.data?.find((m) => m.value === doc.mode);
  const gatePassNo = doc.gate_pass_no || `GP/${doc.consignment_no ?? doc.tr_no}`;

  const carrying: PrintField[] = carryingFields(rule, doc).map((field) => ({
    label: CARRYING_LABEL[field],
    value: dash(carryingValue(field, doc)),
  }));

  const columns: PrintColumn[] = [
    { header: "Item", width: "39%" },
    { header: "UOM", width: "9%" },
    { header: "Qty", align: "right", width: "12%" },
    { header: "Packages", align: "right", width: "12%" },
    { header: "Weight (kg)", align: "right", width: "13%" },
    { header: "Remarks", width: "15%" },
  ];

  return (
    <PrintTemplate
      title="DC/DOD - Document of Deliverable"
      kicker="Authority for the load to leave"
      documentNo={gatePassNo}
      dateFields={[["Pass date", fmtDate(doc.tr_date ?? doc.created_at)]]}
      status={doc.status}
      itemsTitle="The load"
      /* Which papers this one pass answers for. A gate pass with no consignment
         number on it cannot be checked against the packing list at the gate. */
      metadata={[
        { label: "Shipment", value: dash(doc.tr_no), mono: true },
        { label: "Consignment", value: dash(doc.consignment_no), mono: true },
        { label: "Indent", value: dash(doc.indent_no), mono: true },
        { label: "Project", value: dash(doc.project_name) },
        { label: "Carriage", value: carriageLabel(doc.carriage_mode) },
        { label: "Arrangement", value: modeLabel(doc.mode) },
        { label: "Distance", value: doc.distance_km ? `${doc.distance_km} km` : "—" },
        { label: "Expected delivery", value: doc.expected_delivery ? fmtDate(doc.expected_delivery) : "—" },
      ]}
      blocks={[
        {
          title: "Where it is going",
          columns: 2,
          fields: [
            { label: "From", value: dash(doc.from_warehouse_name) },
            { label: "To", value: dash(doc.to_location_name) },
            {
              label: "Delivery address",
              value: <span className="whitespace-pre-line break-words">{dash(doc.delivery_address)}</span>,
              fullWidth: true,
            },
            { label: "Contact", value: dash(doc.contact_person) },
            { label: "Contact phone", value: dash(doc.contact_phone) },
            { label: "Dispatched by", value: dash(doc.dispatched_by_name ?? doc.requested_by_name) },
            { label: "Received by", value: dash(doc.received_by_name) },
          ],
        },
        /* Filled in by whoever actually knows it — the carrier in their own portal on
           a courier or third-party leg, the desk on the two we drive ourselves. WHICH
           boxes appear belongs to the mode, not to this page. */
        { title: "Who is carrying it", fields: carrying },
      ]}
      columns={columns}
      items={items.map((line) => [
        <>
          <span className="font-semibold" style={{ color: "#141a2a" }}>{dash(line.item_name)}</span>
          {line.item_code && (
            <span className="ml-1 font-mono text-[8.5px]" style={{ color: "#697187" }}>{line.item_code}</span>
          )}
          {line.is_fragile && (
            <span className="ml-1 text-[8.5px] font-bold uppercase" style={{ color: "#CC004C" }}>· fragile</span>
          )}
        </>,
        displayUom(line.uom_code),
        line.quantity,
        line.package_count,
        line.weight_kg ?? "—",
        dash(line.remarks),
      ])}
      itemsTotal={[
        `${doc.total_items} item${doc.total_items === 1 ? "" : "s"}`,
        "", doc.total_qty, doc.total_packages, doc.total_weight_kg, "",
      ]}
      remarks={doc.remarks}
      /* Three hands touch the load on the way out, and the pass is the only place all
         three sign. Printed as empty boxes on purpose — they are signed on paper. */
      signatures={["Dispatched by", "Security / gate", "Received by"]}
      footerNote="Valid for this one movement only. The gate must check the package count on this pass against the load before the vehicle leaves; the live record of this shipment is the one held in the system."
    />
  );
}
