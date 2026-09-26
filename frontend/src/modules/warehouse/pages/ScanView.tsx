import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Package, QrCode, ScanLine } from "lucide-react";
import { Button, ErrorBanner, Input, PageHeader, StatusPill } from "@/shared/components";
import { Section } from "../components/DocumentMeta";
import { scanCode } from "../api";
import { fmtQty } from "../format";

/**
 * What a scanned label turns out to be.
 *
 * The QR on a consignment or package label points a phone camera here rather than
 * carrying the bare document number: a scanner that reads plain text can only show
 * the operator the number they are already holding. Scan a consignment and the
 * answer is its cartons; scan a carton and the answer is the item codes, names and
 * counts inside it.
 *
 * Nothing here is public — the route sits inside the app, so the phone lands on the
 * login screen first and the payload is still gated on the same `stock.view`
 * permission the endpoint always required.
 */
export default function ScanView() {
  // A splat, not a named param: a document number carries slashes ("DSP/2026-27/00007")
  // and a package label a pipe, so the code is the whole tail of the path. Each segment
  // is percent-encoded by the label, and decoding is per-segment for the same reason.
  const params = useParams();
  const nav = useNavigate();
  const raw = params["*"] ?? "";
  const decoded = raw
    .split("/")
    .map((part) => { try { return decodeURIComponent(part); } catch { return part; } })
    .join("/");
  const [scan, setScan] = useState(decoded);

  useEffect(() => setScan(decoded), [decoded]);

  const openScan = (event: FormEvent) => {
    event.preventDefault();
    let value = scan.trim();
    if (!value) return;

    // Some handhelds paste the whole QR URL into the focused field. Accept that as
    // well as the short value printed under the barcode, so both devices behave the
    // same way for the operator.
    try {
      const url = new URL(value);
      const match = url.pathname.match(/\/(?:logistics|warehouse)\/scan\/(.+)$/);
      if (match) value = decodeURIComponent(match[1]);
    } catch {
      // A normal consignment/package code is not a URL; it is already the value wanted.
    }
    nav(`/logistics/scan/${encodeURIComponent(value)}`);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-scan", decoded],
    queryFn: () => scanCode(decoded),
    enabled: !!decoded,
    retry: false,
  });

  const packages = data?.packages ?? [];
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Logistics · Label lookup"
        title={data?.title ?? (decoded ? "Reading label" : "Scan a consignment or package")}
        actions={
          data?.deep_link ? (
            <Button onClick={() => nav(data.deep_link!)}>
              Open document <ArrowRight className="h-4 w-4" />
            </Button>
          ) : undefined
        }
      />

      <form
        onSubmit={openScan}
        className="mb-4 flex flex-col gap-2 rounded-xl border border-line bg-content1 p-3 shadow-sm sm:flex-row sm:items-center"
      >
        <div className="relative min-w-0 flex-1">
          <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand" />
          <Input
            value={scan}
            onChange={(event) => setScan(event.target.value)}
            placeholder="Scan QR/barcode or type the label code"
            aria-label="Scan QR or barcode"
            autoFocus={!decoded}
            className="pl-10 font-mono"
          />
        </div>
        <Button type="submit" disabled={!scan.trim()}>
          Show details <ArrowRight className="h-4 w-4" />
        </Button>
        <p className="text-[11px] leading-snug text-muted sm:max-w-52">
          Keep this box focused and press the scanner trigger. Most scanner guns send Enter automatically.
        </p>
      </form>

      {error ? <ErrorBanner error={error} /> : null}
      {isLoading ? <div className="py-16 text-center text-muted">Reading {decoded}...</div> : null}

      {data ? (
        <>
          <Section
            title="Label"
            hint={[data.subtitle, `Code ${data.doc_no ?? decoded}`].filter(Boolean).join(" · ")}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-content1 px-3 py-2 text-sm font-semibold text-ink">
                {data.kind === "PACKAGE" ? <Package className="h-4 w-4 text-brand" /> : <QrCode className="h-4 w-4 text-brand" />}
                {data.kind === "DISPATCH" ? "CONSIGNMENT" : data.kind}
              </span>
              {data.status ? <StatusPill status={data.status} /> : null}
              <span className="rounded-lg bg-content2 px-3 py-2 text-xs text-body">
                {data.kind === "DISPATCH" ? `${data.package_count ?? packages.length} package(s) · ` : ""}
                {data.item_count ?? items.length} item line(s) · qty {fmtQty(data.total_qty ?? 0)}
              </span>
            </div>

            {(data.meta ?? []).some((row) => row.value) && (
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(data.meta ?? []).filter((row) => row.value).map((row) => (
                  <div key={row.label ?? ""} className="min-w-0 rounded-lg border border-line bg-content1 px-3 py-2">
                    <dt className="truncate text-[10px] font-semibold uppercase text-muted">{row.label}</dt>
                    <dd className="truncate text-sm font-semibold text-ink">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>

          {packages.length > 0 && (
            <Section title="Packages" hint="What this consignment is made of. Scan a package label for its contents.">
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="min-w-[640px] w-full text-sm">
                  <thead className="bg-content2 text-left text-[11px] uppercase text-muted">
                    <tr>
                      <th className="px-3 py-2">Package</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Items</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2">Handling</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.map((pkg) => (
                      <tr key={pkg.id} className="border-t border-line">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-ink">{pkg.package_no}</div>
                          <div className="font-mono text-[11px] text-muted">{pkg.barcode ?? "—"}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-body">{pkg.package_type ?? "—"}</td>
                        <td className="px-3 py-2">{pkg.status ? <StatusPill status={pkg.status} /> : "—"}</td>
                        <td className="px-3 py-2 text-right tabular">{pkg.item_count}</td>
                        <td className="px-3 py-2 text-right tabular">{fmtQty(pkg.quantity)}</td>
                        <td className="px-3 py-2 text-xs text-body">
                          {[pkg.is_fragile ? "Fragile" : null, pkg.is_temp_controlled ? "Temp controlled" : null]
                            .filter(Boolean).join(", ") || "Standard"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* The plain-text readout. A scan is done one-handed on a phone at a
           *  pallet, and the answer the floor asked for is a short labelled list per
           *  unit — material, item, batch, code, expiry — not a six-column grid they
           *  have to scroll sideways. The table below stays for the desk. */}
          {items.length > 0 && (
            <Section title="Scanned" hint="What the label says, line by line.">
              <div className="space-y-2">
                {items.map((line, index) => (
                  <pre
                    key={`text-${line.item_code}-${line.serial_no ?? index}`}
                    className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-content2 p-3 font-mono text-xs leading-relaxed text-ink"
                  >
{[
  ["Material", line.item_code],
  ["Item", line.item_name],
  ["Batch", line.batch_no],
  ["Code", line.unit_code],
  ["Serial", line.serial_no],
  ["IMEI", line.imei_no],
  ["Expiry", line.expiry_date],
  ["Qty", `${fmtQty(line.quantity)} ${line.uom_code ?? ""}`.trim()],
  ["Package", line.package_no],
].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(String.fromCharCode(10))}
                  </pre>
                ))}
              </div>
            </Section>
          )}

          {items.length > 0 && (
            <Section title="Contents" hint="Item codes, names and counts.">
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="min-w-[640px] w-full text-sm">
                  <thead className="bg-content2 text-left text-[11px] uppercase text-muted">
                    <tr>
                      <th className="px-3 py-2">Item code</th>
                      <th className="px-3 py-2">Item name</th>
                      <th className="px-3 py-2">Batch</th>
                      <th className="px-3 py-2">Serial</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((line, index) => (
                      <tr key={`${line.item_code}-${line.serial_no ?? index}`} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-xs font-semibold text-ink">{line.item_code ?? "—"}</td>
                        <td className="px-3 py-2 text-xs text-body">{line.item_name ?? "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted">{line.batch_no ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted">{line.serial_no ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular">
                          {fmtQty(line.quantity)} {line.uom_code ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      ) : null}
    </div>
  );
}
