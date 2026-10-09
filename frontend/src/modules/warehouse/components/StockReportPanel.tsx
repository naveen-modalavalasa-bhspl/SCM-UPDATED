import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip, Spinner } from "@heroui/react";
import {
  ArrowDownToLine, Boxes, Check, FileSpreadsheet, FileText, Layers, MapPin,
} from "lucide-react";
import { Alert, Button, Can, ErrorBanner, useToast } from "@/shared/components";
import { downloadStockReport, saveStockReport, stockReportScopes } from "../api";
import { fmtQty } from "../format";
import type { StockReportScopeOption, StockReportScopes } from "../types";

/**
 * Download what is in a storage location — after answering the one question that
 * decides what "in" means.
 *
 * `whs_warehouse_locations` is a tree and stock sits at whatever rung it was put down
 * on, so "the Floor 1 report" is two different files: what is booked to the floor row
 * itself, and what is on the floor including every bay beneath it. On a real building
 * the first is usually EMPTY — a floor is not somewhere anybody puts a carton down —
 * and an empty spreadsheet with nothing to explain it reads as an empty floor.
 *
 * So both answers are counted first (`GET .../report/scopes`) and the counts are on
 * the cards. "Only F1 — nothing is recorded here directly, this file would be empty"
 * beside "F1 and everything inside — 40 locations, 122 items, 3,204 units" is a
 * choice somebody takes in one look; two unlabelled radio buttons are the same choice
 * with the answer hidden.
 *
 * **Every sentence on these cards is SERVED.** The title, the scope line and the hint
 * all come from `warehouse/stock_report.py`, which is also what writes the header
 * block inside the file. Wording either of them here is how a button and the file it
 * produces come to describe the same scope differently.
 */

type Format = "xlsx" | "csv";

const FORMATS: { key: Format; label: string; hint: string; icon: typeof FileText }[] = [
  {
    key: "xlsx",
    label: "Excel",
    hint: "Styled, filterable, with a per-location summary sheet",
    icon: FileSpreadsheet,
  },
  { key: "csv", label: "CSV", hint: "Plain text, for another system to read", icon: FileText },
];

/**
 * A figure and the word for what it counts. A bare number beside a label is the thing
 * that gets read as the wrong quantity.
 *
 * `quantity` is for the one figure that is not a small count. A warehouse holds
 * 779,580.40 of something, which is ten characters where "13" is two — in four equal
 * columns it ran past its own column and the card's `overflow-hidden` sliced the last
 * digits off, so the floor's stock read as "779,580.4". A clipped quantity is worse
 * than no quantity: it looks like a whole number. Hence the smaller type, the hard
 * `nowrap`, and a strip that lets it drop onto its own line rather than shrink.
 */
function Tally({
  value, unit, quantity = false, align = "left",
}: {
  value: string;
  unit: string;
  quantity?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col ${align === "right" ? "items-end text-right" : ""}`}>
      <span
        className={`font-display font-bold tabular leading-none text-ink whitespace-nowrap ${
          quantity ? "text-xl" : "text-2xl"
        }`}
      >
        {value}
      </span>
      <span className="mt-1 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-muted">
        {unit}
      </span>
    </div>
  );
}

function ScopeCard({
  option, selected, onSelect,
}: {
  option: StockReportScopeOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const wide = option.key === "HIERARCHY";
  const Icon = wide ? Layers : MapPin;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative w-full overflow-hidden rounded-2xl border p-5 text-left transition-all duration-300 min-h-11
        ${selected
          ? "border-primary/60 bg-primary/[0.04] shadow-lg shadow-primary/10 ring-1 ring-primary/30"
          : "border-line bg-content1 hover:border-primary/40 hover:shadow-md"}`}
    >
      {/* The selected card carries a brand rail rather than only a tint, so which one
          is armed survives a colourblind reading and a low-contrast screen. */}
      <span
        className={`absolute inset-y-0 left-0 w-1 transition-all duration-300 ${
          selected ? "bg-primary" : "bg-transparent group-hover:bg-primary/30"
        }`}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
              selected ? "bg-primary text-white" : "bg-content2 text-body group-hover:bg-primary/10 group-hover:text-primary"
            }`}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{option.title}</span>
              {option.recommended && (
                <Chip size="sm" variant="flat" color="primary" className="font-semibold">
                  Suggested
                </Chip>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{option.hint}</p>
          </div>
        </div>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all ${
            selected ? "border-primary bg-primary text-white" : "border-line bg-content1"
          }`}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      </div>

      {option.is_empty ? (
        // Said before the press, not discovered after it. This is the whole reason
        // the counts are fetched up front.
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs font-semibold text-warn">
          Nothing to download — this file would have no stock lines in it.
        </div>
      ) : (
        // Wraps rather than divides into four equal columns: the three counts are
        // short and the quantity is not, so a quarter each clipped the only figure
        // that carries decimals. When the quantity cannot sit beside them it takes
        // the next line whole.
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-line/70 pt-4">
          <div className="flex shrink-0 gap-6">
            <Tally value={option.locations.toLocaleString()} unit={option.locations === 1 ? "location" : "locations"} />
            <Tally value={option.items.toLocaleString()} unit={option.items === 1 ? "item" : "items"} />
            <Tally value={option.rows.toLocaleString()} unit={option.rows === 1 ? "line" : "lines"} />
          </div>
          <div className="ml-auto">
            <Tally value={fmtQty(option.total_qty)} unit="on hand" quantity align="right" />
          </div>
        </div>
      )}
    </button>
  );
}

export function StockReportPanel({
  warehouseId, locationId, itemId,
}: {
  warehouseId: number;
  /** Null means the whole warehouse — both scopes are then the same file. */
  locationId: number | null;
  itemId: number | null;
}) {
  const toast = useToast();
  const [scope, setScope] = useState<"LOCATION" | "HIERARCHY">("HIERARCHY");
  const [format, setFormat] = useState<Format>("xlsx");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const scopes = useQuery<StockReportScopes>({
    queryKey: ["wh-stock-report-scopes", warehouseId, locationId, itemId],
    queryFn: () => stockReportScopes({
      warehouse_id: warehouseId, location_id: locationId, item_id: itemId,
    }),
    enabled: !!warehouseId,
  });

  // The server works out which scope answers the question for THIS rung — a floor
  // holding nothing itself points at the wide one — and the screen follows it until
  // the person overrides. Their choice then stands while they are on that location;
  // moving to another location is a new question, so the suggestion applies again.
  useEffect(() => { setTouched(false); }, [locationId, warehouseId]);
  useEffect(() => {
    if (touched || !scopes.data) return;
    const suggested = scopes.data.options.find((o) => o.recommended);
    if (suggested) setScope(suggested.key);
  }, [scopes.data, touched]);

  const options = scopes.data?.options ?? [];
  const chosen = options.find((o) => o.key === scope);
  const identical = options.some((o) => o.same_as_other);

  const download = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await downloadStockReport({
        warehouse_id: warehouseId, scope, location_id: locationId,
        item_id: itemId, format,
      });
      saveStockReport(blob, filename);
      toast.success({ title: "Report downloaded", message: filename });
    } catch (error) {
      // `fromError` is the one way a screen reports a caught write failure, so a 403
      // on this reads exactly as a 403 anywhere else.
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Can do="stock.view">
      <section className="overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-gradient-to-r from-primary/[0.06] via-content2/60 to-content1 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ArrowDownToLine className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-ink">Download stock report</h3>
              <p className="text-xs text-muted">
                {scopes.data
                  ? `${scopes.data.location_label}${scopes.data.location_kind ? ` · ${scopes.data.location_kind}` : ""}`
                  : "Everything held at the location you are browsing"}
              </p>
            </div>
          </div>
          {scopes.isFetching && <Spinner size="sm" color="primary" />}
        </header>

        <div className="space-y-5 p-5">
          <ErrorBanner error={scopes.error} />

          {scopes.isLoading && (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1].map((key) => (
                <div key={key} className="h-40 animate-pulse rounded-2xl bg-content2" />
              ))}
            </div>
          )}

          {scopes.data && (
            <>
              {/* Where you are in the building, so the file's scope is never taken on
                  trust from a code like F1-A1-R1-B2 that reads like four others. */}
              {scopes.data.location_path.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {scopes.data.location_path.filter(Boolean).map((step, index, all) => (
                    <span key={`${step}-${index}`} className="flex items-center gap-1.5">
                      <span className={index === all.length - 1 ? "font-semibold text-ink" : ""}>
                        {step}
                      </span>
                      {index < all.length - 1 && <span className="opacity-40">›</span>}
                    </span>
                  ))}
                </div>
              )}

              {identical ? (
                // One file, so there is no choice to draw. The title and the sentence
                // are still the SERVED ones — writing "has nothing inside it" here is
                // how the whole-warehouse case came to claim a building with 26 items
                // in it was empty.
                <Alert tone="info" title={chosen?.title ?? "One file to download"}>
                  {chosen?.hint}
                </Alert>
              ) : (
                <div>
                  <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
                    How much of the building?
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {options.map((option) => (
                      <ScopeCard
                        key={option.key}
                        option={option}
                        selected={option.key === scope}
                        onSelect={() => { setTouched(true); setScope(option.key); }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {scopes.data.floor_restricted && (
                <Alert tone="warning" title="Limited to your floors">
                  You are assigned to specific floors, so this file covers only those.
                  Somebody with wider access may pull a longer one.
                </Alert>
              )}

              {chosen && chosen.rows >= scopes.data.row_cap && (
                <Alert tone="warning" title="This report will be cut short">
                  A file stops at {scopes.data.row_cap.toLocaleString()} stock lines.
                  Filter by item, or pick a location further inside, to get all of it.
                </Alert>
              )}

              <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line pt-5">
                <div>
                  <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
                    File format
                  </p>
                  <div className="inline-flex rounded-xl border border-line bg-content2 p-1">
                    {FORMATS.map(({ key, label, hint, icon: Icon }) => (
                      <button
                        key={key}
                        type="button"
                        title={hint}
                        onClick={() => setFormat(key)}
                        className={`flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-all ${
                          format === key
                            ? "bg-content1 text-primary shadow-sm ring-1 ring-primary/20"
                            : "text-muted hover:text-ink"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  {/* The sentence under the button is the SAME line the file prints in
                      its own header block, so what was promised and what arrived
                      cannot disagree. */}
                  {chosen && (
                    <p className="max-w-sm text-right text-xs text-muted">{chosen.sentence}</p>
                  )}
                  <Button
                    variant="primary"
                    onClick={download}
                    disabled={busy || !chosen || chosen.is_empty}
                    className="px-6 shadow-lg shadow-primary/20"
                  >
                    {busy ? (
                      <span className="flex items-center gap-2">
                        <Spinner size="sm" color="current" />
                        Building…
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <ArrowDownToLine className="h-4 w-4" />
                        {chosen && !chosen.is_empty
                          ? `Download ${chosen.rows.toLocaleString()} ${chosen.rows === 1 ? "line" : "lines"}`
                          : "Download"}
                      </span>
                    )}
                  </Button>
                </div>
              </div>

              {chosen?.is_empty && (
                <div className="flex items-center gap-2 rounded-xl border border-dashed border-line bg-content2/40 px-4 py-3 text-xs text-muted">
                  <Boxes className="h-4 w-4 shrink-0 opacity-50" />
                  There is nothing to put in this file. Pick the other option, or a
                  location that holds stock.
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </Can>
  );
}
