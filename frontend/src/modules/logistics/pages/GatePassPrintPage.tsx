import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PrintTemplate, type PrintColumn, type PrintField } from "@/shared/components";
import { cartonCountLabel, cartonsOf, passPackageTotal } from "../components/gatePassPackages";
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

  // Hide weight details if no details entered or weight is 0 across the document
  const hasWeight = (Number(doc.total_weight_kg) > 0)
    || items.some((line) => line.weight_kg != null && Number(line.weight_kg) > 0);

  // Columns add up to 100% so the sheet never runs off the page edge, and Packages is
  // wide enough for the carton numbers it now prints (SCM_0130).
  const columns: PrintColumn[] = hasWeight
    ? [
        { header: "Item", width: "34%" },
        { header: "UOM", width: "7%" },
        { header: "Qty", align: "right", width: "9%" },
        { header: "Packages", width: "22%" },
        { header: "Weight (kg)", align: "right", width: "11%" },
        { header: "Remarks", width: "17%" },
      ]
    : [
        { header: "Item", width: "38%" },
        { header: "UOM", width: "8%" },
        { header: "Qty", align: "right", width: "10%" },
        { header: "Packages", width: "24%" },
        { header: "Remarks", width: "20%" },
      ];

  /** Which cartons this item went in — the consignment's own record (SCM_0130). A line
   *  with no consignment behind it keeps its typed package count. */
  const packagesCell = (line: (typeof items)[number]) => {
    const cartons = cartonsOf(line.package_quantities);
    if (!cartons.length) return line.package_count;
    return (
      <span className="block break-words">
        <span className="font-semibold" style={{ color: "#141a2a" }}>{cartonCountLabel(cartons)}</span>
        <span className="block font-mono text-[8.5px]" style={{ color: "#697187" }}>
          {cartons.join(", ")}
        </span>
      </span>
    );
  };
  const totalPackages = passPackageTotal(doc);
  const totalLabel = doc.consignment_package_total
    ? `${totalPackages} carton${totalPackages === 1 ? "" : "s"}` : totalPackages;

  const receivedByDisplay = doc.received_by_name?.trim()
    || (["PENDING_APPROVAL", "DRAFT", "READY", "IN_TRANSIT", "QUOTING", "AWAITING_CARRIER"].includes(doc.status)
      ? "Pending receipt (to be signed)"
      : "—");

  return (
    <PrintTemplate
      title="DC/DOD - Document of Deliverable"
      kicker="Authority for the load to leave"
      documentNo={gatePassNo}
      dateFields={[["Pass date", fmtDate(doc.tr_date ?? doc.created_at)]]}
      status={doc.status}
      itemsTitle="The load"
      /* Which papers this one pass answers for. A gate pass with no consignment
         number on it cannot be checked against the packing list at the gate.
         Indent, Project and Distance dropped (SCM_0053): none of the three is
         something a guard checks the load against, and they crowded out the
         fields that are. The indent and project still print on the indent's own
         paperwork; the distance is still on the shipment's own detail screen. */
      metadata={[
        { label: "Shipment", value: dash(doc.tr_no), mono: true },
        { label: "Consignment", value: dash(doc.consignment_no), mono: true },
        { label: "Carriage", value: carriageLabel(doc.carriage_mode) },
        { label: "Arrangement", value: modeLabel(doc.mode) },
        { label: "Expected delivery", value: doc.expected_delivery ? fmtDate(doc.expected_delivery) : "—" },
      ]}
      blocks={[
        {
          // SCM_0053: both the LIP/MDP/Warehouse name AND its full address, on both
          // sides — "From" used to name only the origin, with no address a guard or
          // a receiving site could actually check the load against.
          title: "Where it is going",
          columns: 2,
          fields: [
            { label: "From", value: dash(doc.from_warehouse_name) },
            {
              label: "From address",
              value: <span className="whitespace-pre-line break-words">{dash(doc.from_warehouse_address)}</span>,
            },
            { label: "To", value: dash(doc.to_location_name) },
            {
              label: "To address",
              value: <span className="whitespace-pre-line break-words">{dash(doc.delivery_address)}</span>,
            },
            { label: "Contact", value: dash(doc.contact_person) },
            { label: "Contact phone", value: dash(doc.contact_phone) },
            { label: "Dispatched by", value: dash(doc.dispatched_by_name ?? doc.requested_by_name) },
            { label: "Received by", value: receivedByDisplay },
          ],
        },
        /* Filled in by whoever actually knows it — the carrier in their own portal on
           a courier or third-party leg, the desk on the two we drive ourselves. WHICH
           boxes appear belongs to the mode, not to this page. */
        { title: "Who is carrying it", fields: carrying },
      ]}
      columns={columns}
      items={items.map((line) => {
        const itemCell = (
          <>
            <span className="font-semibold break-words" style={{ color: "#141a2a" }}>{dash(line.item_name)}</span>
            {line.item_code && (
              <span className="ml-1 font-mono text-[8.5px]" style={{ color: "#697187" }}>{line.item_code}</span>
            )}
            {line.is_fragile && (
              <span className="ml-1 text-[8.5px] font-bold uppercase" style={{ color: "#CC004C" }}>· fragile</span>
            )}
          </>
        );
        return hasWeight
          ? [
              itemCell,
              displayUom(line.uom_code),
              line.quantity,
              packagesCell(line),
              line.weight_kg != null && Number(line.weight_kg) > 0 ? line.weight_kg : "—",
              dash(line.remarks),
            ]
          : [
              itemCell,
              displayUom(line.uom_code),
              line.quantity,
              packagesCell(line),
              dash(line.remarks),
            ];
      })}
      itemsTotal={
        hasWeight
          ? [
              `${doc.total_items} item${doc.total_items === 1 ? "" : "s"}`,
              "", doc.total_qty, totalLabel, doc.total_weight_kg, "",
            ]
          : [
              `${doc.total_items} item${doc.total_items === 1 ? "" : "s"}`,
              "", doc.total_qty, totalLabel, "",
            ]
      }
      remarks={doc.remarks}
      /* Three hands touch the load on the way out, and the pass is the only place all
         three sign. Printed as empty boxes on purpose — they are signed on paper. */
      signatures={["Dispatched by", "Security / gate", "Received by"]}
      footerNote="Valid for this one movement only. The gate must count the cartons on this pass against the load before the vehicle leaves; the live record of this shipment is the one held in the system."
    />
  );
}
