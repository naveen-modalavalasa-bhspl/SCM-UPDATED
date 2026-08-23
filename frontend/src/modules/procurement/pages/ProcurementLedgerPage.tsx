import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pagination } from "@heroui/react";
import {
  Card, FilterBar, FilterMenu, PageHeader, ResponsiveList, StatusPill,
  type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { ledgerApi } from "../api";
import type { ProcurementLedgerRow } from "../types";
import { money } from "./RequisitionListPage";
import { FileText, Gavel, Handshake, ShoppingCart } from "lucide-react";
import { KpiTiles, type KpiTileSpec } from "@/shared/components";
import { useUrlFilters } from "../urlFilters";

/**
 * The buying trail: requisition -> RFQ -> quotation -> purchase order, in one register.
 *
 * In Procurement rather than the reports module because it reads nothing outside
 * procurement, and because a reader wants to click a row through to the document —
 * which is a procurement screen. See `backend/app/modules/procurement/ledger.py`.
 *
 * Everything is decided server-side: the filter options come off the DATA (so they
 * cannot drift from what exists), the filtering and paging run in SQL over the union,
 * and this screen sends what was picked and renders what came back. Nothing is sliced
 * here — 133 rows today, and it has to survive four figures.
 */
const SIZE = 20;

/** Where a row leads. Every kind has a detail screen except a quotation, which is read
 *  on the RFQ it answers — the comparison sheet is where a quote means anything. */
const destinationFor = (row: ProcurementLedgerRow): string | null => {
  switch (row.doc_kind) {
    case "REQUISITION": return `/procurement/requisitions/${row.doc_id}`;
    case "RFQ": return `/procurement/rfqs/${row.doc_id}`;
    case "PO": return `/pos/${row.doc_id}`;
    default: return null;
  }
};

const KIND_LABEL: Record<string, string> = {
  REQUISITION: "Requisition", RFQ: "RFQ", QUOTATION: "Quotation", PO: "Order",
};

/** Every filter this screen owns, so Clear knows what to drop. */
const FILTER_KEYS = ["doc_kind", "status", "project", "vendor", "search"];

/** One glyph per rung of the buying chain. The LABELS come from the server
 *  (`ledger.DOC_KINDS`), so the strip cannot offer a kind the register does not
 *  carry; only the icon and the tint are decided here. */
const KIND_ICON: Record<string, KpiTileSpec["icon"]> = {
  REQUISITION: FileText, RFQ: Gavel, QUOTATION: Handshake, PO: ShoppingCart,
};
const KIND_TONE: Record<string, KpiTileSpec["tone"]> = {
  REQUISITION: "info", RFQ: "brand", QUOTATION: "warn", PO: "ok",
};

export function ProcurementLedgerPage() {
  const nav = useNavigate();
  // Filters live in the URL — see `../urlFilters`. The KPI strip above sets
  // `doc_kind`, and every screen in the module reads its filters the same way.
  const { get, set, clear, toggle, isActive, page, setPage, activeCount } =
    useUrlFilters();
  const docKind = get("doc_kind");
  const status = get("status");
  const project = get("project");
  const vendor = get("vendor");
  const search = get("search");

  const filters = useQuery({
    queryKey: ["procurement-ledger-filters"],
    queryFn: () => ledgerApi.filters(),
  });

  // Every filter EXCEPT doc_kind — that is the one the tiles set, so the four counts
  // always add up to the total shown beside the search box.
  const stripParams = {
    status: status || undefined,
    project: project || undefined,
    vendor: vendor || undefined,
    search: search.trim() || undefined,
  };
  const strip = useQuery({
    queryKey: ["procurement-ledger-stats", stripParams],
    queryFn: ({ signal }) => ledgerApi.stats(stripParams, signal),
    placeholderData: (previous) => previous,
  });

  const rows = useQuery({
    queryKey: ["procurement-ledger", page, docKind, status, project, vendor, search],
    queryFn: () => ledgerApi.rows({
      page, size: SIZE,
      doc_kind: docKind || undefined,
      ...stripParams,
    }),
  });

  // Built from what the SERVER says the register holds, keyed by the same names it
  // counted — so a tile can never filter to something it did not count.
  const kindTiles: KpiTileSpec[] = (filters.data?.doc_kinds ?? []).map((kind) => ({
    key: kind.value,
    label: kind.label,
    icon: KIND_ICON[kind.value] ?? FileText,
    tone: KIND_TONE[kind.value] ?? "neutral",
    value: strip.data?.by_kind[kind.value],
    // A count that never arrived draws a dash and stops filtering, rather than
    // pulsing forever — see `KpiStrip.display`.
    failed: Boolean(strip.error),
    onPress: () => toggle(strip.data?.filters[kind.value] ?? { doc_kind: kind.value }),
    active: isActive({ doc_kind: kind.value }),
  }));

  const opts = (values: string[] | undefined) =>
    (values ?? []).map((v) => ({ value: v, label: v }));

  const columns: Column<ProcurementLedgerRow>[] = useMemo(() => [
    {
      key: "doc",
      header: "Document",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-ink">
            {r.doc_no}
          </div>
          <div className="text-[11px] text-muted">
            {KIND_LABEL[r.doc_kind] ?? r.doc_kind}
            {r.doc_date ? ` · ${fmtDate(r.doc_date)}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "party",
      header: "Vendor / Project",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{r.party ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{r.title ?? ""}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (r.status ? <StatusPill status={r.status} /> : "—"),
    },
    {
      key: "value",
      header: "Value",
      // An enquiry carries no money — asking is not committing — so a blank here is
      // meaningful, and is never rendered as a zero.
      render: (r) => (r.value == null
        ? <span className="text-xs text-muted">—</span>
        : <span className="tabular">{money(Number(r.value))}</span>),
    },
    {
      key: "ref",
      header: "Raised from",
      hideOnNarrow: true,
      render: (r) => (
        <span className="font-mono text-[11px] text-muted">{r.ref_no ?? "—"}</span>
      ),
    },
    {
      key: "with",
      header: "With",
      hideOnNarrow: true,
      render: (r) => <span className="text-xs text-muted">{r.with_whom ?? "—"}</span>,
    },
  ], []);

  const total = rows.data?.total ?? 0;

  return (
    <div>
      <PageHeader eyebrow="Procurement" title="Procurement Ledger" />
      <p className="mb-4 max-w-[75ch] text-sm text-body">
        Every requisition, RFQ, quotation and purchase order, newest first. Read-only —
        nothing is written for this register, so it can only ever show what the
        documents themselves carry. Raised from is what each one came off, which is how
        a single order can be traced back to the request that started it.
      </p>

      {/* One tile per rung of the buying chain, counting what the register is showing
          under every OTHER filter — so the four always add up to the total beside the
          search box, and pressing one narrows to exactly the rows it counted. Same
          `po.view` as the register itself; there is nothing extra to grant. */}
      <div className="mb-4">
        <KpiTiles label="Document kinds" tiles={kindTiles} />
      </div>

      {/* Same filter idiom as the PO list beside it — the shared FilterMenu, not a
          second bar invented here. Every option list comes from the server so it can
          only ever offer values the register actually contains. */}
      <FilterBar
        search={search}
        onSearch={(value) => set({ search: value })}
        searchPlaceholder="Search any document number, vendor or project…"
        active={activeCount(FILTER_KEYS)}
        onClear={() => clear(FILTER_KEYS)}
        right={
          <span className="text-xs text-muted">
            {rows.isLoading ? "…" : `${total} document${total === 1 ? "" : "s"}`}
          </span>
        }
      >
        {/* Document kind is on the strip above; repeating it here would be two
            controls for one filter, disagreeing the moment either is pressed. */}
        <FilterMenu label="Status" value={status}
                    onChange={(value) => set({ status: value })}
                    options={opts(filters.data?.statuses)} />
        <FilterMenu label="Project" value={project}
                    onChange={(value) => set({ project: value })}
                    options={opts(filters.data?.projects)} />
        <FilterMenu label="Vendor" value={vendor}
                    onChange={(value) => set({ vendor: value })}
                    options={opts(filters.data?.vendors)} />
      </FilterBar>

      {rows.error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {(rows.error as Error).message}
        </p>
      ) : (
        <Card className="p-2">
          <ResponsiveList
            data={rows.data?.items ?? []}
            loading={rows.isLoading}
            keyOf={(r) => `${r.doc_kind}-${r.doc_id}`}
            columns={columns}
            // A quotation has no screen of its own — it is read on the RFQ it answers,
            // where the comparison sheet gives it meaning. A row that leads nowhere is
            // simply not clickable, rather than being a dead end.
            onRowClick={(r) => {
              const to = destinationFor(r);
              if (to) nav(to);
            }}
            empty="No procurement document matches these filters."
            renderCard={(r) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">
                    {r.doc_no}
                  </span>
                  {r.status ? <StatusPill status={r.status} /> : null}
                </div>
                <p className="text-sm text-body">
                  {KIND_LABEL[r.doc_kind] ?? r.doc_kind} · {r.party ?? "—"}
                </p>
                <p className="text-xs text-muted">
                  {r.doc_date ? fmtDate(r.doc_date) : "—"}
                  {r.value == null ? "" : ` · ${money(Number(r.value))}`}
                  {r.ref_no ? ` · from ${r.ref_no}` : ""}
                </p>
              </div>
            )}
          />
          {total > SIZE && (
            <div className="mt-4 flex justify-center pb-2">
              <Pagination
                isCompact showControls color="primary" page={page}
                total={Math.max(1, Math.ceil(total / SIZE))}
                onChange={setPage}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
