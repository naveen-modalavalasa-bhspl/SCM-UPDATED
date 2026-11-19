import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  PRINT_TONE, PrintPanel, PrintTemplate, PrintTh, SectionTitle, useCompanyProfile,
  type PrintField,
} from "@/shared/components";
import { fmtDate, fmtDateRange } from "@/shared/datetime";
import { displayUom } from "@/modules/indents/displayFormat";
import { transportApi } from "../api";
import { carriageLabel, modeLabel } from "../components/modeCopy";
import {
  dimensions, money, qty, rupeesInWords, volume, weight,
} from "../components/challanFormat";
import type {
  ChallanConsignment, ChallanLine, ChallanPackage, DeliveryChallan,
} from "../transportTypes";

/**
 * The Delivery Challan (2026-11-19) — the company's own challan book, on the system's
 * paper.
 *
 * Same sheet as every other print (`PrintTemplate`: letterhead with GSTIN, the
 * gradient band, the footer on every page), with what the printed book carries on top
 * of it: the GODOWN address under the letterhead — read off the source warehouse's
 * master, so a challan out of a different godown says so — the "not for sale, only
 * for own consumption" note across the page, and the book's four signatures.
 *
 * NUMBERED WITH THE DISPATCH, never a consignment: one truck can carry several
 * consignments (a multi-drop trip), and this is the one sheet for the whole load.
 *
 * The body is the load as it is packed — one block per consignment (its number,
 * how many packages, from where to where, weight and volume when they were recorded),
 * and inside it one table per PACKAGE, listing what is in that package. The columns
 * are the book's, re-ordered so the eye lands on WHAT first: Product name, Qty, HSN
 * code, Unit price, Amount. Every line is priced: the consignment's own rate, else the
 * item master's purchase price, marked "†" so nobody mistakes it for a quoted price.
 */

const ink = PRINT_TONE.ink;
const muted = PRINT_TONE.muted;
const line = PRINT_TONE.line;

const COLUMNS: { header: string; align?: "left" | "right" | "center"; width: string }[] = [
  { header: "Product name", width: "46%" },
  { header: "Qty", align: "right", width: "12%" },
  { header: "HSN code", align: "center", width: "12%" },
  { header: "Unit price (₹)", align: "right", width: "14%" },
  { header: "Amount (₹)", align: "right", width: "16%" },
];

const dash = (value?: string | null) => (value && value.trim()) || "—";

export function DeliveryChallanPrintPage() {
  const { id } = useParams();
  const trId = Number(id);
  const challan = useQuery({
    queryKey: ["delivery-challan", trId],
    queryFn: () => transportApi.deliveryChallan(trId),
    enabled: Number.isFinite(trId) && trId > 0,
  });
  const { company } = useCompanyProfile();

  if (challan.isLoading) return <p className="p-8 text-sm">Loading the delivery challan…</p>;
  if (challan.error) return <p className="p-8 text-sm">{(challan.error as Error).message}</p>;
  if (!challan.data) return <p className="p-8 text-sm">Shipment not found.</p>;

  const dc = challan.data;
  const companyName = company.legal_name || company.name;
  return (
    <PrintTemplate
      title="Delivery Challan"
      kicker={dc.is_trip ? `Multi-drop trip${dc.trip_no ? ` · ${dc.trip_no}` : ""}` : "Goods on their way"}
      documentNo={dc.dc_no ?? "Issued on dispatch"}
      dateFields={[
        ["DC date", fmtDate(dc.dc_date)],
        ["Shipment", dc.tr_no],
      ]}
      status={null}
      letterheadExtra={dc.godown.address && (
        <>
          <b style={{ color: ink }}>Godown address:</b>{" "}
          {dc.godown.name ? `${dc.godown.name}, ` : ""}{dc.godown.address}
        </>
      )}
      watermark="Not for sale · only for own consumption"
      metadata={particulars(dc)}
      blocks={[
        {
          title: dc.ship_to.length > 1 ? `M/s — ${dc.ship_to.length} drops` : "M/s — Delivered to",
          columns: 2,
          fields: shipToFields(dc),
        },
      ]}
      columns={[]}
      items={[]}
      remarks={dc.remarks}
      signatures={[
        "Receiver's signature",
        "Prepared by",
        "Checked by",
        `For ${companyName} — Authorised signatory`,
      ]}
      footerNote="Note: this is not for sale, only for own consumption. Goods move under this challan between the company's own points; the live record of this dispatch is the one held in the system."
    >
      {dc.consignments.length === 0 ? (
        <section className="mt-5">
          <PrintPanel tone="warn">This dispatch carries no consignment yet — nothing to list.</PrintPanel>
        </section>
      ) : dc.consignments.map((consignment, index) => (
        <ConsignmentBlock key={consignment.dispatch_id} consignment={consignment}
                          index={index} count={dc.consignments.length} />
      ))}

      {dc.consignments.length > 0 && <GrandTotal dc={dc} />}
    </PrintTemplate>
  );
}

function particulars(dc: DeliveryChallan): PrintField[] {
  const fields: PrintField[] = [
    { label: "Travels by", value: `${carriageLabel(dc.carriage_mode)} · ${modeLabel(dc.mode)}` },
    {
      label: "Expected delivery",
      value: fmtDateRange(dc.expected_delivery_from, dc.expected_delivery),
    },
    { label: "Consignments", value: String(dc.totals.consignments) },
  ];
  // Only what this dispatch actually recorded: a hand-over has no LR, a courier no
  // vehicle, and an empty box on a challan reads as something nobody filled in.
  const optional: [string, string | null | undefined, boolean?][] = [
    ["Vehicle no", dc.vehicle_number, true],
    ["Driver", [dc.driver_name, dc.driver_phone].filter(Boolean).join(" · ") || null],
    ["Carrier", dc.carrier_name],
    ["LR no", dc.lr_no, true],
    ["Docket no", dc.docket_no, true],
    ["E-way bill", dc.eway_bill_no, true],
    ["Project", dc.project_name],
  ];
  for (const [label, value, mono] of optional) {
    if (value && value.trim()) fields.push({ label, value, mono });
  }
  return fields;
}

function shipToFields(dc: DeliveryChallan): PrintField[] {
  if (dc.ship_to.length === 0) return [{ label: "Destination", value: "—", fullWidth: true }];
  return dc.ship_to.flatMap((party, i) => [
    {
      label: dc.ship_to.length > 1 ? `Drop ${i + 1}` : "Name",
      value: [party.name, party.code].filter(Boolean).join(" · ") || "—",
    },
    {
      label: "Address",
      value: <span className="whitespace-pre-line break-words">{dash(party.address)}</span>,
    },
  ]);
}

/* ── One consignment ──────────────────────────────────────────────────────── */

function ConsignmentBlock({ consignment: c, index, count }: {
  consignment: ChallanConsignment; index: number; count: number;
}) {
  const facts: [string, ReactNode][] = [
    ["Packages", String(c.package_count)],
  ];
  const w = weight(c.weight_kg);
  const v = volume(c.volume_cbm);
  if (w) facts.push(["Weight", w]);
  if (v) facts.push(["Volume", v]);
  if (c.expected_delivery_from || c.expected_delivery) {
    facts.push(["Expected", fmtDateRange(c.expected_delivery_from, c.expected_delivery)]);
  }

  return (
    <section className="mt-6" style={{ breakInside: "auto" }}>
      {/* The heading and the consignment's own band travel together: a heading left
          at the foot of one page with its band on the next reads as an empty block. */}
      <div className="avoid-break">
      <SectionTitle note={count > 1 ? `${index + 1} of ${count}` : undefined}>
        Consignment
      </SectionTitle>

      {/* The consignment's own band: its number, the route, and the load in one row. */}
      <div className="overflow-hidden rounded-lg border" style={{ borderColor: line }}>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"
             style={{ background: PRINT_TONE.panel }}>
          <div className="min-w-0">
            <div className="font-mono text-[12px] font-bold" style={{ color: PRINT_TONE.brand }}>
              {c.consignment_no}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] font-semibold" style={{ color: ink }}>
              <span>{dash(c.source.name)}</span>
              <span style={{ color: PRINT_TONE.brand }}>→</span>
              <span>{dash(c.destination.name)}</span>
            </div>
            {c.destination.address && (
              <div className="mt-0.5 max-w-[110mm] text-[8.5px] leading-snug" style={{ color: muted }}>
                {c.destination.address}
                {(c.destination.contact_person || c.destination.contact_phone) && (
                  <> · {[c.destination.contact_person, c.destination.contact_phone].filter(Boolean).join(", ")}</>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-3 text-right">
            {facts.map(([label, value]) => (
              <div key={label}>
                <div className="text-[7.5px] font-bold uppercase tracking-[0.1em]" style={{ color: muted }}>{label}</div>
                <div className="text-[10.5px] font-bold" style={{ color: ink }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>

      {c.packages.map((pkg) => (
        <PackageTable key={pkg.id ?? `loose-${pkg.sequence}`} pkg={pkg}
                      total={c.packages.filter((p) => p.id !== null).length} />
      ))}

      {/* What this consignment adds up to. */}
      <div className="avoid-break mt-2 flex items-center justify-end gap-6 rounded-md px-3 py-1.5 text-[10px]"
           style={{ background: PRINT_TONE.wash, color: muted }}>
        <span className="text-[8.5px] font-bold uppercase tracking-[0.1em]">{c.consignment_no} total</span>
        <span>Qty <b style={{ color: ink }}>{qty(c.total_qty)}</b></span>
        <span>Amount <b style={{ color: ink }}>₹ {money(c.total_amount)}</b></span>
      </div>
    </section>
  );
}

/* ── One package and what is in it ────────────────────────────────────────── */

function PackageTable({ pkg, total }: { pkg: ChallanPackage; total: number }) {
  const loose = pkg.id === null;
  const meta = [
    pkg.package_type && !loose ? titleCase(pkg.package_type) : null,
    weight(pkg.weight_kg),
    volume(pkg.volume_cbm),
    dimensions(pkg.dimensions_cm),
    pkg.is_fragile ? "Fragile" : null,
    pkg.is_temp_controlled ? "Temperature controlled" : null,
  ].filter(Boolean) as string[];

  return (
    <div className="mt-3">
      <div className="avoid-break mb-1 flex flex-wrap items-baseline gap-x-2 text-[9.5px]"
           style={{ breakAfter: "avoid" }}>
        <span className="font-extrabold uppercase tracking-[0.08em]" style={{ color: ink }}>
          {loose ? "Not in a package" : `Package ${pkg.sequence}${total > 1 ? ` of ${total}` : ""}`}
        </span>
        {pkg.package_no && (
          <span className="font-mono font-bold" style={{ color: PRINT_TONE.brand }}>{pkg.package_no}</span>
        )}
        {meta.length > 0 && <span style={{ color: muted }}>· {meta.join(" · ")}</span>}
      </div>
      {/* mobile-ok: print sheet, fixed A4 width by design (PrintTemplate) */}
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ backgroundImage: PRINT_TONE.sweep }}>
            {COLUMNS.map((col) => (
              <PrintTh key={col.header} align={col.align} width={col.width}>{col.header}</PrintTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {pkg.lines.map((row, i) => <LineRow key={`${row.item_id}-${row.batch_no ?? ""}-${i}`} row={row} />)}
          {pkg.lines.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="border-b px-2 py-2.5 text-center text-[9.5px] italic"
                  style={{ color: muted, borderColor: line }}>
                Nothing recorded in this package.
              </td>
            </tr>
          )}
        </tbody>
        {pkg.lines.length > 1 && (
          <tfoot>
            <tr>
              <td className="px-2 py-[5px] text-right text-[8.5px] font-bold uppercase tracking-[0.08em]"
                  style={{ color: muted }}>
                Package total
              </td>
              <td className="px-2 py-[5px] text-right text-[10px] font-black" style={{ color: ink }}>
                {qty(pkg.total_qty)}
              </td>
              <td />
              <td />
              <td className="px-2 py-[5px] text-right text-[10px] font-black" style={{ color: ink }}>
                {money(pkg.total_amount)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function LineRow({ row }: { row: ChallanLine }) {
  const cell = "border-b px-2 py-[6px] align-top text-[10px] leading-snug";
  const sub = [
    row.item_code,
    row.batch_no ? `Batch ${row.batch_no}` : null,
    row.expiry_date ? `Exp ${fmtDate(row.expiry_date)}` : null,
  ].filter(Boolean).join(" · ");
  const uom = displayUom(row.uom_code);
  return (
    <tr>
      <td className={cell} style={{ color: "#3d4557", borderColor: line }}>
        <div className="font-semibold" style={{ color: ink }}>{dash(row.item_name)}</div>
        {sub && <div className="text-[8.5px]" style={{ color: muted }}>{sub}</div>}
        {row.codes.length > 0 && (
          <div className="mt-0.5 break-words font-mono text-[7.5px]" style={{ color: muted }}>
            {row.codes.slice(0, 12).join(", ")}
            {row.codes.length > 12 && ` +${row.codes.length - 12} more`}
          </div>
        )}
      </td>
      <td className={`${cell} text-right`} style={{ color: ink, borderColor: line }}>
        <b>{qty(row.quantity)}</b>
        {uom && uom !== "—" && <span className="ml-1 text-[8.5px]" style={{ color: muted }}>{uom}</span>}
      </td>
      <td className={`${cell} text-center font-mono`} style={{ color: "#3d4557", borderColor: line }}>
        {dash(row.hsn_code)}
      </td>
      <td className={`${cell} text-right`} style={{ color: "#3d4557", borderColor: line }}>
        {money(row.unit_price)}
        {row.price_source === "ITEM_MASTER" && (
          <sup className="ml-0.5" style={{ color: PRINT_TONE.brand }} title="Item master price">†</sup>
        )}
      </td>
      <td className={`${cell} text-right font-semibold`} style={{ color: ink, borderColor: line }}>
        {money(row.amount)}
      </td>
    </tr>
  );
}

/* ── The whole load ───────────────────────────────────────────────────────── */

function GrandTotal({ dc }: { dc: DeliveryChallan }) {
  const anyMasterPrice = dc.consignments.some((c) =>
    c.packages.some((p) => p.lines.some((l) => l.price_source === "ITEM_MASTER")));
  const cells: [string, string][] = [
    ["Consignments", String(dc.totals.consignments)],
    ["Packages", String(dc.totals.packages)],
    ["Total qty", qty(dc.totals.quantity)],
  ];
  const w = weight(dc.totals.weight_kg);
  const v = volume(dc.totals.volume_cbm);
  if (w) cells.push(["Weight", w]);
  if (v) cells.push(["Volume", v]);
  return (
    <section className="avoid-break mt-6">
      <SectionTitle>Challan total</SectionTitle>
      <div className="overflow-hidden rounded-lg border" style={{ borderColor: line }}>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr)) 1.6fr` }}>
          {cells.map(([label, value]) => (
            <div key={label} className="border-r px-3 py-2" style={{ borderColor: line }}>
              <div className="text-[7.5px] font-bold uppercase tracking-[0.1em]" style={{ color: muted }}>{label}</div>
              <div className="text-[11px] font-bold" style={{ color: ink }}>{value}</div>
            </div>
          ))}
          <div className="px-3 py-2 text-right" style={{ backgroundImage: PRINT_TONE.sweep }}>
            <div className="text-[7.5px] font-bold uppercase tracking-[0.1em] text-white/85">Amount</div>
            <div className="text-[15px] font-black text-white">₹ {money(dc.totals.amount)}</div>
          </div>
        </div>
        <div className="border-t px-3 py-1.5 text-[9px]" style={{ borderColor: line, color: muted }}>
          <b style={{ color: ink }}>In words:</b> {rupeesInWords(dc.totals.amount)}
        </div>
      </div>
      {anyMasterPrice && (
        <p className="mt-1 text-[8px]" style={{ color: muted }}>
          <span style={{ color: PRINT_TONE.brand }}>†</span> Valued at the item master's purchase price — the consignment line carried no rate of its own.
        </p>
      )}
    </section>
  );
}

function titleCase(value: string) {
  return value.toLowerCase().replace(/(^|[\s_])(\w)/g, (_, sep: string, ch: string) =>
    `${sep === "_" ? " " : sep}${ch.toUpperCase()}`);
}

