import { useQuery } from "@tanstack/react-query";
import { Box, CalendarDays, MapPin, Package, RefreshCw, Route, ShieldCheck, Warehouse } from "lucide-react";
import { useParams } from "react-router-dom";
import scmMark from "@/assets/scm-mark.png";
import { getPublicLabel, type ScanResult } from "../api";
import { fmtQty, fmtSerialSuffix } from "../format";

type PublicMeta = [string, string][];

const valueOf = (meta: PublicMeta, label: string) =>
  meta.find(([key]) => key.toLowerCase() === label.toLowerCase())?.[1];

const humanStatus = (value?: string) => value?.replace(/_/g, " ") || "Recorded";

const cleanMeta = (result: ScanResult): PublicMeta =>
  (result.meta ?? []).flatMap(({ label, value }) =>
    label?.trim() && value?.trim() ? [[label.trim(), value.trim()] as [string, string]] : [],
  );

/** Public by design, but never an application screen: no login, sidebar, document
 * links or deep link. The signed QR token retrieves only this label's current data. */
export default function PublicConsignmentScanPage() {
  const { token = "" } = useParams<{ token: string }>();
  const query = useQuery({
    queryKey: ["public-consignment-label", token],
    queryFn: () => getPublicLabel(token),
    enabled: Boolean(token),
    retry: 1,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  if (!token || query.isError) {
    return (
      <PublicMessage
        title="Label could not be opened"
        message={token
          ? "The label is invalid, no longer available, or the server cannot be reached. Check your connection and scan it again."
          : "This QR is incomplete or damaged. Please scan the printed label again."}
        retry={token ? () => query.refetch() : undefined}
      />
    );
  }

  if (!query.data) {
    return <PublicMessage title="Loading label details" message="Getting the latest consignment information…" loading />;
  }

  return <PublicLabel result={query.data} refreshing={query.isFetching} />;
}

function PublicLabel({ result, refreshing }: { result: ScanResult; refreshing: boolean }) {
  const meta = cleanMeta(result);
  const kind = result.kind.toUpperCase();
  // A stock pack (a carton or a box on the shelf) or one coded unit (2026-10-27):
  // what it is, where it is now and what is inside it.
  if (kind === "PACK" || kind === "UNIT") {
    return <StockLabel result={result} meta={meta} refreshing={refreshing} />;
  }
  const isPackage = kind === "PACKAGE";
  const status = result.status ?? valueOf(meta, "Status");
  const from = valueOf(meta, "From");
  const destination = valueOf(meta, "Destination");
  const date = valueOf(meta, "Date");
  const quantity = isPackage && result.total_qty != null ? fmtQty(result.total_qty) : undefined;
  const packageCount = result.package_count ?? result.packages?.length;
  const primaryLabels = new Set(["status", "from", "destination", "date", "quantity", "qty", "packages"]);
  const extra = meta.filter(([key]) => !primaryLabels.has(key.toLowerCase()));
  const items = result.items ?? [];

  return (
    <main className="min-h-screen bg-content2 text-ink">
      <div className="mx-auto w-full max-w-xl px-4 py-5 sm:py-8">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-content1 shadow-sm ring-1 ring-line">
              <img src={scmMark} alt="SCM" className="h-7 w-7 object-contain" />
            </span>
            <div>
              <div className="font-display text-sm font-bold leading-tight">SCM Logistics</div>
              <div className="text-[10px] text-muted">Live shipping details</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[10px] font-semibold text-ok">
            {refreshing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {refreshing ? "Updating" : "Read only"}
          </span>
        </header>

        <section className="overflow-hidden rounded-3xl border border-brand/20 bg-content1 shadow-sm">
          <div className="bg-gradient-to-br from-brand-050 via-content1 to-content1 px-5 py-5 sm:px-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand">
              {isPackage ? "Package" : "Consignment"}
            </div>
            <h1 className="mt-1 break-words font-display text-xl font-bold leading-tight text-ink sm:text-2xl">
              {result.doc_no || result.title || "Shipping label"}
            </h1>
            {result.subtitle && <p className="mt-1 text-xs leading-relaxed text-muted">{result.subtitle}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">
                {humanStatus(status)}
              </span>
              {!isPackage && packageCount != null && (
                <span className="rounded-full bg-content2 px-3 py-1 text-[11px] font-semibold text-body">
                  {packageCount} {packageCount === 1 ? "package" : "packages"}
                </span>
              )}
              {quantity && (
                <span className="rounded-full bg-content2 px-3 py-1 text-[11px] font-semibold text-body">Qty {quantity}</span>
              )}
            </div>
          </div>

          {(from || destination) && (
            <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:px-6">
              <Place icon={Warehouse} label="From" value={from || "Not specified"} />
              <Route className="hidden h-4 w-4 text-brand sm:block" />
              <Place icon={MapPin} label="Destination" value={destination || "Not specified"} strong />
            </div>
          )}

          {(date || extra.length > 0) && (
            <dl className="grid grid-cols-2 gap-2 border-t border-line bg-content2/50 px-5 py-4 sm:grid-cols-3 sm:px-6">
              {date && <Fact label="Date" value={date} icon={<CalendarDays className="h-3.5 w-3.5" />} />}
              {extra.map(([key, value]) => <Fact key={key} label={key} value={value} />)}
            </dl>
          )}
        </section>

        {isPackage && items.length > 0 && (
          <section className="mt-4 rounded-3xl border border-line bg-content1 p-5 shadow-sm sm:p-6">
            <SectionHeading icon={Box} title="Contents"
              note={`${items.length} item ${items.length === 1 ? "line" : "lines"}`} />
            <div className="mt-3 space-y-2.5">
              {items.map((item, index) => {
                const serial = fmtSerialSuffix(item.unit_code ?? item.serial_no);
                const details = [
                  item.package_no && ["Package", item.package_no],
                  item.batch_no && ["Batch", item.batch_no],
                  serial && ["Serial", serial],
                  item.imei_no && ["IMEI", item.imei_no],
                  item.expiry_date && ["Expiry", item.expiry_date],
                ].filter((row): row is [string, string] => Boolean(row));
                return (
                  <article key={`${item.item_code}-${item.serial_no ?? index}`} className="rounded-2xl border border-line bg-content2/60 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-display text-sm font-bold leading-snug text-ink">{item.item_name || "Material"}</div>
                        <div className="mt-1 break-all font-mono text-[10px] font-semibold text-brand">{item.item_code || "Code unavailable"}</div>
                      </div>
                      <span className="shrink-0 rounded-lg bg-content1 px-2.5 py-1 text-xs font-bold tabular shadow-sm ring-1 ring-line">
                        {fmtQty(item.quantity)} {item.uom_code ?? ""}
                      </span>
                    </div>
                    {details.length > 0 && (
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3">
                        {details.map(([key, value]) => (
                          <div key={`${key}-${value}`} className="min-w-0">
                            <dt className="text-[9px] font-bold uppercase tracking-wide text-muted">{key}</dt>
                            <dd className="mt-0.5 break-all font-mono text-[10px] font-semibold text-body">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <footer className="px-5 py-6 text-center text-[10px] leading-relaxed text-muted">
          Current read-only shipping information from SCM Logistics.<br />
          This page does not provide access to the SCM application.
        </footer>
      </div>
    </main>
  );
}

/** The live page behind a carton, box or unit label. Facts first, in the order the
 *  floor asked for them — item, where it is, what is inside, batch, brand — then the
 *  packs inside it, each scannable on its own label. */
function StockLabel({ result, meta, refreshing }: { result: ScanResult; meta: PublicMeta; refreshing: boolean }) {
  const isPack = result.kind.toUpperCase() === "PACK";
  const location = valueOf(meta, "Location");
  const facts = meta.filter(([key]) => !["location", "item code"].includes(key.toLowerCase()));
  const packages = result.packages ?? [];
  return (
    <main className="min-h-screen bg-content2 text-ink">
      <div className="mx-auto w-full max-w-xl px-4 py-5 sm:py-8">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-content1 shadow-sm ring-1 ring-line">
              <img src={scmMark} alt="SCM" className="h-7 w-7 object-contain" />
            </span>
            <div>
              <div className="font-display text-sm font-bold leading-tight">SCM Inventory</div>
              <div className="text-[10px] text-muted">Live label details</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[10px] font-semibold text-ok">
            {refreshing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {refreshing ? "Updating" : "Read only"}
          </span>
        </header>

        <section className="overflow-hidden rounded-3xl border border-brand/20 bg-content1 shadow-sm">
          <div className="bg-gradient-to-br from-brand-050 via-content1 to-content1 px-5 py-5 sm:px-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand">
              {isPack ? (result.subtitle?.split(" · ")[0] ?? "Pack") : "Unit"}
            </div>
            <h1 className="mt-1 break-words font-display text-xl font-bold leading-tight text-ink sm:text-2xl">
              {result.title || result.doc_no}
            </h1>
            <p className="mt-1 break-all font-mono text-xs font-semibold text-brand">
              {valueOf(meta, "Item code")} · {result.doc_no}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">
                {humanStatus(result.status ?? undefined)}
              </span>
              {isPack && (result.package_count ?? 0) > 0 && (
                <span className="rounded-full bg-content2 px-3 py-1 text-[11px] font-semibold text-body">
                  {result.package_count} {result.package_count === 1 ? "package" : "packages"} inside
                </span>
              )}
              {isPack && result.total_qty != null && (
                <span className="rounded-full bg-content2 px-3 py-1 text-[11px] font-semibold text-body">
                  Holds {fmtQty(result.total_qty)}
                </span>
              )}
            </div>
          </div>
          {location && (
            <div className="border-t border-line px-5 py-4 sm:px-6">
              <Place icon={MapPin} label="Where it is now" value={location} strong />
            </div>
          )}
          {facts.length > 0 && (
            <dl className="grid grid-cols-2 gap-2 border-t border-line bg-content2/50 px-5 py-4 sm:grid-cols-3 sm:px-6">
              {facts.map(([key, value]) => <Fact key={key} label={key} value={value} />)}
            </dl>
          )}
        </section>

        {packages.length > 0 && (
          <section className="mt-4 rounded-3xl border border-line bg-content1 p-5 shadow-sm sm:p-6">
            <SectionHeading icon={Package} title="Inside"
              note={`${packages.length} ${packages.length === 1 ? "package" : "packages"}`} />
            <ul className="mt-3 space-y-2">
              {packages.map((pkg) => (
                <li key={pkg.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-content2/60 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold capitalize text-ink">{pkg.package_type ?? "Pack"}</div>
                    <div className="break-all font-mono text-[10px] font-semibold text-brand">{pkg.package_no}</div>
                  </div>
                  <span className="shrink-0 rounded-lg bg-content1 px-2.5 py-1 text-xs font-bold tabular shadow-sm ring-1 ring-line">
                    {fmtQty(pkg.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="px-5 py-6 text-center text-[10px] leading-relaxed text-muted">
          Current read-only stock information from SCM.<br />
          This page does not provide access to the SCM application.
        </footer>
      </div>
    </main>
  );
}

function PublicMessage({
  title, message, retry, loading = false,
}: {
  title: string;
  message: string;
  retry?: () => void;
  loading?: boolean;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-content2 px-5 py-10">
      <section className="w-full max-w-sm rounded-3xl border border-line bg-content1 p-7 text-center shadow-sm">
        <img src={scmMark} alt="SCM" className="mx-auto h-11 w-11 object-contain" />
        <h1 className="mt-4 font-display text-xl font-bold text-ink">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{message}</p>
        {loading && <div className="mx-auto mt-5 h-1.5 w-28 overflow-hidden rounded-full bg-content2"><div className="h-full w-1/2 animate-pulse rounded-full bg-brand" /></div>}
        {retry && (
          <button type="button" onClick={retry}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white">
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        )}
        <p className="mt-5 text-[10px] text-muted">Read-only label page · No application access</p>
      </section>
    </main>
  );
}

function SectionHeading({ icon: Icon, title, note }: { icon: typeof Package; title: string; note: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-050 text-brand"><Icon className="h-4 w-4" /></span>
        <h2 className="font-display text-base font-bold text-ink">{title}</h2>
      </div>
      <span className="text-[10px] font-medium text-muted">{note}</span>
    </div>
  );
}

function Place({ icon: Icon, label, value, strong = false }: { icon: typeof MapPin; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${strong ? "bg-brand-050 text-brand" : "bg-content2 text-muted"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-wide text-muted">{label}</div>
        <div className="mt-0.5 text-xs font-semibold leading-snug text-ink">{value}</div>
      </div>
    </div>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-content1 px-3 py-2.5 ring-1 ring-line">
      <dt className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-muted">{icon}{label}</dt>
      <dd className="mt-1 break-words text-xs font-semibold text-ink">{value}</dd>
    </div>
  );
}
