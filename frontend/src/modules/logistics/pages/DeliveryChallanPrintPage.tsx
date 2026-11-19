import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  PRINT_TONE, PrintPanel, PrintTemplate, PrintTh, SectionTitle, useCompanyProfile,
  type PrintField,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { displayUom } from "@/modules/indents/displayFormat";
import { transportApi } from "../api";
import { carriageLabel, modeLabel } from "../components/modeCopy";
import { money, qty, rupeesInWords, volume, weight } from "../components/challanFormat";
import type { ChallanLine, DeliveryChallan } from "../transportTypes";

/**
 * The Delivery Challan — the company's own challan book, on the system's paper.
 *
 * Same sheet as every other print (`PrintTemplate`: letterhead with GSTIN, the
 * gradient band, the footer on every page), with what the printed book carries: the
 * GODOWN address under the letterhead — read off the source warehouse's master — and
 * the book's four signatures. NUMBERED WITH THE DISPATCH, never a consignment.
 *
 * The body is ONE table of what is on the truck (2026-11-20): Product name, Qty, HSN
 * code, Unit price, Amount — the same item and batch added up across every
 * consignment and package. No consignment numbers, no package or box numbers and no
 * codes (asset, consumable, serial, IMEI): the challan says WHAT and HOW MUCH; the
 * packing list and the labels say which carton. Every line is priced: the line's own
 * rate, else the item master's purchase price, marked "†".
 *
 * The book's note — "Note: this is not for sale, only for own consumption." — sits
 * BEHIND the line items as a faint slanted band, repeated down the table so it
 * prints on every page the table reaches, and pale enough that every figure stays
 * readable over it.
 */

const ink = PRINT_TONE.ink;
const muted = PRINT_TONE.muted;
const line = PRINT_TONE.line;

const NOTE = "Note: this is not for sale, only for own consumption.";

const COLUMNS: { header: string; align?: "left" | "right" | "center"; width: string }[] = [
  { header: "#", align: "center", width: "5%" },
  { header: "Product name", width: "43%" },
  { header: "Qty", align: "right", width: "12%" },
  { header: "HSN code", align: "center", width: "12%" },
  { header: "Unit price (₹)", align: "right", width: "13%" },
  { header: "Amount (₹)", align: "right", width: "15%" },
];

const dash = (value?: string | null) => (value && value.trim()) || "—";

/** The note as a repeating background tile: an SVG, so it prints crisp, tiled down the
 *  table's height so every printed page of the table carries it. */
function noteTile(): string {
  // 760 × 190 tile, scaled to the table's width: the note runs across it at a
  // gentle slant, sized to fit inside the tile, so no line of it is ever cut off.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 760 190' width='760' height='190'>`
    + `<text x='380' y='104' text-anchor='middle' transform='rotate(-8 380 95)' `
    + `font-family='Inter, Helvetica, Arial, sans-serif' font-size='23' font-weight='800' `
    + `letter-spacing='0.6' fill='${PRINT_TONE.brand}' fill-opacity='0.085'>${NOTE}</text></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

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
  const lines = dc.lines ?? [];
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
      footerNote={`${NOTE} Goods move under this challan between the company's own points; the live record of this dispatch is the one held in the system.`}
    >
      {lines.length === 0 ? (
        <section className="mt-5">
          <PrintPanel tone="warn">This dispatch carries nothing yet — no lines to list.</PrintPanel>
        </section>
      ) : (
        <>
          <LineItems lines={lines} dc={dc} />
          <GrandTotal dc={dc} />
        </>
      )}
    </PrintTemplate>
  );
}

function particulars(dc: DeliveryChallan): PrintField[] {
  const fields: PrintField[] = [
    { label: "Travels by", value: `${carriageLabel(dc.carriage_mode)} · ${modeLabel(dc.mode)}` },
    { label: "Dispatch date", value: fmtDate(dc.dispatch_date ?? dc.expected_delivery_from ?? dc.dc_date) },
    { label: "Expected delivery", value: fmtDate(dc.expected_delivery) },
  ];
  // Only what this dispatch actually recorded: a hand-over has no LR, a courier no
  // vehicle, and an empty box on a challan reads as something nobody filled in.
  const optional: [string, string | null | undefined, boolean?][] = [
    ["Vehicle no", dc.vehicle_number, true],
    ["Vehicle type", dc.vehicle_type_name],
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

/* ── The goods ────────────────────────────────────────────────────────────── */

function LineItems({ lines, dc }: { lines: ChallanLine[]; dc: DeliveryChallan }) {
  const cell = "border-b px-2 py-[7px] align-top text-[10px] leading-snug";
  return (
    <section className="mt-5">
      <SectionTitle note={`${lines.length} line${lines.length === 1 ? "" : "s"}`}>Goods despatched</SectionTitle>
      {/* The note lives on the table's own background, tiled down its height: behind
          every row, on every page the table runs to, under the text rather than over it. */}
      <div style={{
        backgroundImage: noteTile(), backgroundRepeat: "repeat-y",
        backgroundPosition: "center center", backgroundSize: "100% auto",
      }}>
        {/* mobile-ok: print sheet, fixed A4 width by design (PrintTemplate) */}
        <table className="w-full border-collapse" style={{ background: "transparent" }}>
          <thead>
            <tr style={{ backgroundImage: PRINT_TONE.sweep }}>
              {COLUMNS.map((col) => (
                <PrintTh key={col.header} align={col.align} width={col.width}>{col.header}</PrintTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((row, i) => {
              const sub = [
                row.item_code,
                row.batch_no ? `Batch ${row.batch_no}` : null,
                row.expiry_date ? `Exp ${fmtDate(row.expiry_date)}` : null,
              ].filter(Boolean).join(" · ");
              const uom = displayUom(row.uom_code);
              return (
                <tr key={`${row.item_id}-${row.batch_no ?? ""}-${i}`}>
                  <td className={`${cell} text-center`} style={{ color: muted, borderColor: line }}>{i + 1}</td>
                  <td className={cell} style={{ borderColor: line }}>
                    <div className="font-semibold" style={{ color: ink }}>{dash(row.item_name)}</div>
                    {sub && <div className="text-[8.5px]" style={{ color: muted }}>{sub}</div>}
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
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: PRINT_TONE.panel }}>
              <td colSpan={2} className="px-2 py-[7px] text-[9px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: muted, borderTop: `1.5px solid ${PRINT_TONE.brand}` }}>
                Total
              </td>
              <td className="px-2 py-[7px] text-right text-[10px] font-black"
                  style={{ color: ink, borderTop: `1.5px solid ${PRINT_TONE.brand}` }}>
                {qty(dc.totals.quantity)}
              </td>
              <td colSpan={2} style={{ borderTop: `1.5px solid ${PRINT_TONE.brand}` }} />
              <td className="px-2 py-[7px] text-right text-[10px] font-black"
                  style={{ color: ink, borderTop: `1.5px solid ${PRINT_TONE.brand}` }}>
                {money(dc.totals.amount)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/* ── The whole load ───────────────────────────────────────────────────────── */

function GrandTotal({ dc }: { dc: DeliveryChallan }) {
  const anyMasterPrice = (dc.lines ?? []).some((l) => l.price_source === "ITEM_MASTER");
  const cells: [string, string][] = [
    ["Items", String((dc.lines ?? []).length)],
    ["Packages", String(dc.totals.packages)],
    ["Total qty", qty(dc.totals.quantity)],
  ];
  const w = weight(dc.totals.weight_kg);
  const v = volume(dc.totals.volume_cbm);
  if (w) cells.push(["Weight", w]);
  if (v) cells.push(["Volume", v]);
  return (
    <section className="avoid-break mt-5">
      <div className="overflow-hidden rounded-lg border" style={{ borderColor: line }}>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr)) 1.6fr` }}>
          {cells.map(([label, value]) => (
            <div key={label} className="border-r px-3 py-2" style={{ borderColor: line }}>
              <div className="text-[7.5px] font-bold uppercase tracking-[0.1em]" style={{ color: muted }}>{label}</div>
              <div className="text-[11px] font-bold" style={{ color: ink }}>{value}</div>
            </div>
          ))}
          <div className="px-3 py-2 text-right" style={{ backgroundImage: PRINT_TONE.sweep }}>
            <div className="text-[7.5px] font-bold uppercase tracking-[0.1em] text-white/85">Challan value</div>
            <div className="text-[15px] font-black text-white">₹ {money(dc.totals.amount)}</div>
          </div>
        </div>
        <div className="border-t px-3 py-1.5 text-[9px]" style={{ borderColor: line, color: muted }}>
          <b style={{ color: ink }}>In words:</b> {rupeesInWords(dc.totals.amount)}
        </div>
      </div>
      {anyMasterPrice && (
        <p className="mt-1 text-[8px]" style={{ color: muted }}>
          <span style={{ color: PRINT_TONE.brand }}>†</span> Valued at the item master's purchase price — the line carried no rate of its own.
        </p>
      )}
    </section>
  );
}
