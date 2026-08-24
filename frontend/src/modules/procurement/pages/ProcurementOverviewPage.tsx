import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, Banknote, ChevronRight, Clock, FileStack, FileText, Gavel,
  Handshake, Layers, PackageCheck, Search, ShoppingCart, TrendingUp, Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, ErrorBanner, PageHeader, ResponsiveList, type Column } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate } from "@/shared/datetime";
import {
  STATS_STALE_TIME, procurementStatsApi, procurementStatsKeys,
} from "../api";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import type { DemandPoolRow } from "../types";
import {
  KpiTiles, shortMoney, shortQty, type KpiTileSpec,
} from "@/shared/components";
import {
  PROCUREMENT_PERMS as P, useConsolidationStats, usePoStats, useQuotationStats,
  useRequisitionStats, useRfqStats,
} from "../components/ProcurementKpis";

/**
 * Procurement's front door.
 *
 * It answers three questions and nothing else:
 *
 *   1. What is waiting on ME?          — the top strip, off the workflow engine
 *   2. Where is the buying chain?      — the five rungs, each a live count
 *   3. What does the company still need, and what is it costing?
 *                                      — the demand pool and the money strip
 *
 * Everything on it is a link into a register that is already filtered. Nothing is
 * decided here and nothing is written — it is five counts and one aggregate over
 * documents that exist, which is why it can be the landing page for a module whose
 * screens are each gated differently.
 *
 * ── RBAC ────────────────────────────────────────────────────────────────────
 *
 * The page's own permission (`page.pro_overview.view`) means only "may open the
 * board". Every SECTION carries the permission of the documents it reads, checked in
 * the hook that fetches it — a login holding `requisition.view` and nothing else sees
 * the requisition rung, the demand pool, and no purchase-order money at all. A
 * revoked permission removes the section, its request and its number together; there
 * is no client-side list of what to show that could get out of step with the grants.
 *
 * A login that holds the page and none of the five gets the empty state, which says
 * so plainly rather than rendering an empty scaffold.
 */

/** How many items the demand pool shows at rest. */
const DEMAND_POOL_ROWS = 5;
/** How many it shows once opened out. Capped rather than unbounded: the pool is the
 *  whole company's unbought demand and can run to hundreds, and a card that grows
 *  without limit stops being a card. Past this the register is the right screen, and
 *  the footer says so. */
const DEMAND_POOL_EXPANDED = 50;

/* --- The buying chain ------------------------------------------------------ */

interface Rung {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Documents sitting AT this rung right now — what the chain is actually holding.
   *  `undefined` while loading; `null` when this login may not read the rung. */
  live: number | null | undefined;
  /** The request behind the number failed. Drawn as a dash, like a denied rung, but
   *  still clickable — the register itself may well load fine. */
  failed?: boolean;
}

/** One rung of the chain. Reads as a step, not as a card: the arrow between them is
 *  the point — a buyer should see where a document goes next. */
function RungStep({ rung, last }: { rung: Rung; last: boolean }) {
  const nav = useNavigate();
  const { label, icon: Icon, href, live, failed } = rung;
  const denied = live === null;

  return (
    <>
      <button
        type="button"
        disabled={denied}
        onClick={() => nav(href)}
        aria-label={denied
          ? `${label}: not available to you`
          : `${label}: ${live ?? "loading"} in flight. Open the register`}
        className={`group flex min-h-16 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition
          ${denied
            ? "cursor-not-allowed opacity-40"
            : "hover:bg-content2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"}`}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-050 text-brand">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block font-display text-xl font-bold leading-none tabular text-ink">
            {denied || failed ? "—" : live === undefined
              ? <span className="inline-block h-5 w-8 animate-pulse rounded bg-line align-middle" />
              : live.toLocaleString("en-IN")}
          </span>
          <span className="mt-1 block truncate text-[11px] font-semibold uppercase tracking-wide text-muted">
            {label}
          </span>
        </span>
        {!denied && (
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
      </button>
      {!last && (
        <ArrowRight aria-hidden className="hidden h-4 w-4 shrink-0 self-center text-line lg:block" />
      )}
    </>
  );
}

/* --- The money strip ------------------------------------------------------- */

interface MoneyLine {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  note: string;
}

export function ProcurementOverviewPage() {
  const nav = useNavigate();
  const { can } = useAuth();

  const req = useRequisitionStats();
  const cons = useConsolidationStats();
  const rfq = useRfqStats();
  const quote = useQuotationStats();
  const po = usePoStats();

  const anySection = req.allowed || cons.allowed || rfq.allowed
    || quote.allowed || po.allowed;

  /* --- 1. What is waiting on me ------------------------------------------- */
  // One tile per document type this login actually SIGNS. Both gates matter: reading
  // the register is what makes the number legible, approving is what makes it theirs.
  // Somebody who signs nothing gets no strip at all rather than a row of zeroes.
  const myQueues: KpiTileSpec[] = useMemo(() => ([
    { key: "req", label: "Requisitions", icon: FileText, tone: "warn" as const,
      value: req.data?.awaiting_me, href: "/procurement/requisitions",
      failed: Boolean(req.error), when: req.allowed && can(P.reqApprove) },
    { key: "cons", label: "Consolidations", icon: Layers, tone: "warn" as const,
      value: cons.data?.awaiting_me, href: "/procurement/consolidations",
      failed: Boolean(cons.error), when: cons.allowed && can(P.consApprove) },
    { key: "rfq", label: "RFQs", icon: Gavel, tone: "warn" as const,
      value: rfq.data?.awaiting_me, href: "/procurement/rfqs",
      failed: Boolean(rfq.error), when: rfq.allowed && can(P.rfqApprove) },
    { key: "po", label: "Purchase orders", icon: ShoppingCart, tone: "warn" as const,
      value: po.data?.awaiting_me, href: "/pos",
      failed: Boolean(po.error), when: po.allowed && can(P.poApprove) },
  ]).filter((tile) => tile.when).map(({ href, when: _when, ...tile }) => ({
    ...tile,
    // `pending_for_me=1` is the register's own filter, off `wf_pending` — the same
    // question the count asked, so the list can only hold what the tile counted.
    onPress: () => nav(`${href}?pending_for_me=1`),
  })), [can, cons.allowed, cons.data, cons.error, nav, po.allowed, po.data, po.error,
        req.allowed, req.data, req.error, rfq.allowed, rfq.data, rfq.error]);

  /* --- 2. Where is the chain ---------------------------------------------- */
  // `failed` per rung rather than one banner: four of the five may be answering fine,
  // and a strip that pulses forever on the one that is not looks like a slow network.
  const rungs: Rung[] = [
    { key: "req", label: "Requisitions", icon: FileText,
      href: "/procurement/requisitions",
      live: req.allowed
        ? (req.data && req.data.pending_approval + req.data.approved)
        : null,
      failed: Boolean(req.error) },
    { key: "cons", label: "Consolidation", icon: Layers,
      href: "/procurement/consolidations",
      live: cons.allowed
        ? (cons.data && cons.data.pending_approval + cons.data.approved)
        : null,
      failed: Boolean(cons.error) },
    { key: "rfq", label: "RFQs", icon: Gavel, href: "/procurement/rfqs",
      live: rfq.allowed
        ? (rfq.data && rfq.data.pending_approval + rfq.data.out_to_vendors
           + rfq.data.ready_to_award)
        : null,
      failed: Boolean(rfq.error) },
    { key: "quote", label: "Quotations", icon: Handshake,
      href: "/procurement/quotations",
      live: quote.allowed ? (quote.data && quote.data.to_compare) : null,
      failed: Boolean(quote.error) },
    { key: "po", label: "Purchase orders", icon: ShoppingCart, href: "/pos",
      live: po.allowed
        ? (po.data && po.data.pending_approval + po.data.to_send + po.data.at_vendor)
        : null,
      failed: Boolean(po.error) },
  ];

  /* --- 3. What is it costing ---------------------------------------------- */
  const money: MoneyLine[] = [
    ...(req.allowed && req.data ? [{
      key: "demand", label: "Open demand", value: shortMoney(req.data.open_value),
      icon: Wallet, note: "Requisitions still moving",
    }] : []),
    ...(quote.allowed && quote.data ? [{
      key: "quoted", label: "On the table", value: shortMoney(quote.data.quoted_value),
      icon: Banknote, note: "Live and accepted quotes",
    }] : []),
    ...(po.allowed && po.data ? [{
      key: "spend", label: "Ordered this month", value: shortMoney(po.data.month_value),
      icon: TrendingUp, note: `${po.data.this_month} order${po.data.this_month === 1 ? "" : "s"}`,
    }, {
      key: "commitment", label: "Open commitment",
      value: shortMoney(po.data.open_commitment),
      icon: PackageCheck, note: "Approved, not yet received",
    }] : []),
  ];

  /* --- the demand pool ----------------------------------------------------- */
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search);
  // Five at rest: the Overview answers "what is the company short of", and a board
  // that scrolls is a board nobody reads to the bottom of.
  //
  // REVISED 2026-08-23 — the footer used to NAVIGATE to the requisition register.
  // Reading one more row cost the reader the whole dashboard, and the register is a
  // different question (which requisitions?) from the one they were asking (what are
  // we short of?). It opens out in place now, and the register link is kept for the
  // case that genuinely needs it: more demand than this card should ever hold.
  const [expanded, setExpanded] = useState(false);
  // Narrowing the pool puts the reader back at the top of a short list; leaving it
  // opened out to fifty rows of a two-row search result is just empty card.
  useEffect(() => { setExpanded(false); }, [debounced]);
  const poolParams = {
    search: debounced || undefined,
    size: expanded ? DEMAND_POOL_EXPANDED : DEMAND_POOL_ROWS,
  };
  const pool = useQuery({
    queryKey: procurementStatsKeys.demandPool(poolParams),
    queryFn: ({ signal }) => procurementStatsApi.demandPool(poolParams, signal),
    enabled: req.allowed,
    staleTime: STATS_STALE_TIME,
    placeholderData: (previous) => previous,
  });

  const poolColumns: Column<DemandPoolRow>[] = [
    {
      key: "item",
      header: "Item",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">
            {row.item_name ?? "Unnamed item"}
          </div>
          <div className="mono truncate text-[11px] text-muted">{row.item_code ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Open demand",
      className: "text-right",
      render: (row) => (
        <span className="font-display text-base font-bold tabular text-ink">
          {shortQty(row.open_qty)}
          <span className="ml-1 text-[11px] font-medium text-muted">{row.uom_code ?? ""}</span>
        </span>
      ),
    },
    {
      key: "spread",
      header: "Across",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-xs text-muted">
          {row.requisition_count} requisition{row.requisition_count === 1 ? "" : "s"}
          {row.project_count > 1 ? ` · ${row.project_count} projects` : ""}
        </span>
      ),
    },
    {
      key: "needed",
      header: "Needed by",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-xs text-muted">
          {row.earliest_required ? fmtDate(row.earliest_required) : "—"}
        </span>
      ),
    },
    {
      key: "value",
      header: "Estimated",
      className: "text-right",
      render: (row) => (
        <span className="text-sm font-semibold text-ink">{shortMoney(row.estimated_value)}</span>
      ),
    },
  ];

  if (!anySection) {
    return (
      <>
        <PageHeader eyebrow="Procurement" title="Overview" />
        <Card className="p-10 text-center">
          <p className="text-sm text-muted">
            Nothing here is available to your role yet. Ask an administrator for access
            to requisitions, consolidations, RFQs, quotations or purchase orders.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Procurement" title="Overview" />

      {/* 1 — the only thing on the page that is somebody's to DO. */}
      {myQueues.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            <Clock className="h-3.5 w-3.5" /> Waiting for your signature
          </h2>
          <KpiTiles label="Waiting for me" tiles={myQueues} />
        </section>
      )}

      {/* 2 — the chain, left to right, in the order the work happens. */}
      <Card className="mb-4 p-2">
        <div className="flex flex-col gap-1 lg:flex-row lg:items-stretch">
          {rungs.map((rung, index) => (
            <RungStep key={rung.key} rung={rung} last={index === rungs.length - 1} />
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 3a — the demand pool: what the company still needs, item by item. */}
        {req.allowed && (
          <Card className="p-5 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted">
                  <FileStack className="h-4 w-4" /> Demand pool
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  Sanctioned and not yet ordered, pooled across every requisition.
                </p>
              </div>
              <label className="relative">
                <span className="sr-only">Search the demand pool</span>
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find an item…"
                  className="h-10 w-48 rounded-lg border border-line bg-content1 pl-8 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
                />
              </label>
            </div>

            {pool.error && <ErrorBanner error={pool.error} />}
            {/* Opened out, the list scrolls inside the card rather than pushing the
                money strip and the chain off the bottom of the page. */}
            <div className={expanded ? "max-h-[26rem] overflow-y-auto pr-1" : undefined}>
            <ResponsiveList
              columns={poolColumns}
              data={pool.data?.items ?? []}
              keyOf={(row) => row.item_id}
              loading={pool.isLoading}
              // Straight to the requisitions holding it. The register's own search
              // takes an item code, so the click needs no new endpoint and lands on a
              // screen this login already holds `requisition.view` for.
              onRowClick={(row) => nav(
                `/procurement/requisitions?search=${encodeURIComponent(row.item_code ?? "")}`)}
              empty="Nothing is waiting to be bought."
              renderCard={(row) => (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">
                      {row.item_name ?? "Unnamed item"}
                    </div>
                    <div className="mono truncate text-[11px] text-muted">
                      {row.item_code ?? "—"}
                    </div>
                    <div className="mt-1 text-[11px] text-muted">
                      {row.requisition_count} requisition{row.requisition_count === 1 ? "" : "s"}
                      {row.earliest_required ? ` · by ${fmtDate(row.earliest_required)}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-display text-base font-bold tabular text-ink">
                      {shortQty(row.open_qty)}
                      <span className="ml-1 text-[11px] font-medium text-muted">
                        {row.uom_code ?? ""}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted">
                      {shortMoney(row.estimated_value)}
                    </div>
                  </div>
                </div>
              )}
            />
            </div>
            {(() => {
              const shown = pool.data?.items.length ?? 0;
              const total = pool.data?.total ?? 0;
              if (total <= shown && !expanded) return null;
              // More than this card will ever hold: the register is the honest answer,
              // and it is the same link that has always been here.
              const overflowing = expanded && total > shown;
              return (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {(total > shown || expanded) && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((open) => !open)}
                      className="rounded text-xs font-medium text-muted transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    >
                      {expanded
                        ? `Show the ${DEMAND_POOL_ROWS} largest`
                        : `Showing the ${shown} largest of ${total} items — show all`}
                    </button>
                  )}
                  {overflowing && (
                    <button
                      type="button"
                      onClick={() => nav("/procurement/requisitions")}
                      className="rounded text-xs font-medium text-muted transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    >
                      {total - shown} more — open the requisition register
                    </button>
                  )}
                </div>
              );
            })()}
          </Card>
        )}

        {/* 3b — the money, one line per question. */}
        {money.length > 0 && (
          <Card className="p-5">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted">
              <Banknote className="h-4 w-4" /> Value in flight
            </h2>
            <div className="divide-y divide-line/70">
              {money.map(({ key, label, value, icon: Icon, note }) => (
                <div key={key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-content2 text-muted">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-muted">{label}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted/80">{note}</span>
                  </span>
                  <span className="font-display text-lg font-bold tabular text-ink">{value}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
