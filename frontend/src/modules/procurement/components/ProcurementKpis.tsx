import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Banknote, CalendarDays, CheckCircle2, ClipboardCheck, Clock, FileStack,
  FileText, Gavel, Handshake, Hourglass, Layers, ListChecks, PackageCheck,
  PencilLine, Send, Timer, TrendingUp, Truck, Users, Wallet, XCircle,
} from "lucide-react";
import { ErrorBanner } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  STATS_STALE_TIME, procurementStatsApi, procurementStatsKeys,
} from "../api";
import { useUrlFilters } from "../urlFilters";
import {
  ContextStrip, KpiTiles, shortMoney, type ContextStatSpec, type KpiTileSpec,
} from "@/shared/components";

/**
 * The KPI strip for each procurement register — defined ONCE and rendered in two
 * places: at the top of its own register, and as a section of the Overview. Two
 * copies would be two sets of buckets, and the day one of them changed the Overview
 * would quietly start disagreeing with the screen it links to.
 *
 * ── RBAC, which is the point of this file ────────────────────────────────────
 *
 * Each strip is a hook plus a component and BOTH are gated on the same permission the
 * endpoint behind it is gated on:
 *
 *   • the query is `enabled: can(<view code>)`, so a login without it makes no
 *     request — nothing to 403, nothing in the network tab, nothing cached;
 *   • the component returns `null` when the permission is absent, so the strip is not
 *     hidden, it does not exist.
 *
 * That is the whole answer to "I turned this off and the user still sees it": there
 * is no client-side list of what to show. `can()` reads `/api/auth/me`, which is
 * rebuilt from `rbac_role_permissions` on every login and every position switch, and
 * the endpoint refuses the same code independently. Revoke `rfq.view` and the RFQ
 * strip, its request and its numbers all go at once.
 *
 * The "Waiting for me" tile carries a SECOND gate on the approve code, because a
 * buyer who can read requisitions but never signs one has no queue — a tile reading 0
 * forever is clutter, and one reading 4 would be somebody else's work.
 */

/* --- the permission codes, named once ------------------------------------- */
const P = {
  reqView: "requisition.view",
  reqApprove: "requisition.approve",
  consView: "consolidation.view",
  consApprove: "consolidation.approve",
  rfqView: "rfq.view",
  rfqApprove: "rfq.approve",
  rfqCompare: "rfq.compare",
  poView: "po.view",
  poApprove: "po.approve",
} as const;

/** A tile spec built from a SERVED filter map. `filterKey` defaults to the tile key,
 *  so the count and the press are the same word in both files. */
interface Built {
  key: string;
  label: string;
  icon: KpiTileSpec["icon"];
  tone: KpiTileSpec["tone"];
  value: number | undefined;
  /** Drop the tile entirely — used for the approve-only queues. */
  when?: boolean;
}

/** Turn the built specs into pressable tiles against one register's filter map. */
function usePressable(
  filters: Record<string, Record<string, string>> | undefined,
  built: Built[],
  /** Where the tiles live when they are NOT on the register they filter (Overview). */
  href?: string,
  /** The request behind these numbers failed — draw dashes, and do not filter. */
  failed?: boolean,
): KpiTileSpec[] {
  const { toggle, isActive } = useUrlFilters();
  const nav = useNavigate();

  return built
    .filter((spec) => spec.when !== false)
    .map(({ key, label, icon, tone, value }) => {
      const filter = filters?.[key];
      if (!filter || failed) return { key, label, icon, tone, value, failed };
      if (href) {
        // On the Overview the tile is a LINK, not a toggle: it opens the register
        // already filtered. Pressing it twice there should not clear a filter on a
        // screen the reader is not looking at.
        const query = new URLSearchParams(filter).toString();
        return {
          key, label, icon, tone, value,
          onPress: () => nav(query ? `${href}?${query}` : href),
          hint: `${label}: ${value ?? "loading"}. Open the register filtered to these`,
        };
      }
      return {
        key, label, icon, tone, value,
        onPress: () => toggle(filter),
        active: isActive(filter),
      };
    });
}

/** Shared query wiring: one cached answer per document family, whoever asks. */
function useStats<T>(
  code: string,
  key: readonly unknown[],
  fetcher: (signal?: AbortSignal) => Promise<T>,
) {
  const { can } = useAuth();
  const allowed = can(code);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetcher(signal),
    // The gate that makes a revoked permission produce no request at all.
    enabled: allowed,
    staleTime: STATS_STALE_TIME,
    placeholderData: (previous) => previous,
  });
  return { allowed, data: query.data, error: query.error };
}

/* One hook per family, exported so the Overview composes the SAME cached answers the
 * strips use — five requests for the whole module, not five per section. Each carries
 * its own `allowed`, which is the only thing any caller may branch on. */
export const useRequisitionStats = () => useStats(
  P.reqView, procurementStatsKeys.requisitions(), procurementStatsApi.requisitions);
export const useConsolidationStats = () => useStats(
  P.consView, procurementStatsKeys.consolidations(), procurementStatsApi.consolidations);
export const useRfqStats = () => useStats(
  P.rfqView, procurementStatsKeys.rfqs(), procurementStatsApi.rfqs);
export const useQuotationStats = () => useStats(
  P.rfqCompare, procurementStatsKeys.quotations(), procurementStatsApi.quotations);
export const usePoStats = () => useStats(
  P.poView, procurementStatsKeys.pos(), procurementStatsApi.pos);

export const PROCUREMENT_PERMS = P;

interface StripProps {
  /** Set on the Overview: tiles navigate to this register instead of toggling. */
  href?: string;
  /** Hide the quiet context row — the registers show it, compact views may not. */
  context?: boolean;
}

/* --------------------------------------------------------------------------- */
/*  Requisitions                                                               */
/* --------------------------------------------------------------------------- */

export function RequisitionKpis({ href, context = true }: StripProps = {}) {
  const { can } = useAuth();
  const { allowed, data, error } = useRequisitionStats();
  const tiles = usePressable(data?.filters, [
    { key: "awaiting_me", label: "Waiting for me", icon: Clock, tone: "warn",
      value: data?.awaiting_me, when: can(P.reqApprove) },
    { key: "pending_approval", label: "In approval", icon: Hourglass, tone: "info",
      value: data?.pending_approval },
    { key: "approved", label: "Ready to buy", icon: CheckCircle2, tone: "ok",
      value: data?.approved },
    { key: "draft", label: "In draft", icon: PencilLine, tone: "neutral",
      value: data?.draft },
  ], href, Boolean(error));

  if (!allowed) return null;
  const stats: ContextStatSpec[] = [
    { key: "total", label: "Requisitions", value: data?.total ?? "–", icon: FileText },
    { key: "month", label: "Raised this month", value: data?.this_month ?? "–",
      icon: CalendarDays },
    { key: "value", label: "Open value",
      value: data ? shortMoney(data.open_value) : "–", icon: Wallet },
    { key: "lines", label: "Lines", value: data?.total_lines ?? "–", icon: ListChecks },
  ];
  return (
    <>
      <KpiTiles label="Requisition queues" tiles={tiles} />
      {/* Said out loud, not left as a row of pulsing skeletons: a strip that cannot
          reach its endpoint looks exactly like a slow network until somebody waits a
          minute. A 403 lands here too, which is the honest answer when a permission
          was revoked mid-session. */}
      {error && <ErrorBanner error={error} className="mt-3" />}
      {context && !error && <ContextStrip stats={stats} className="mt-3" />}
    </>
  );
}

/* --------------------------------------------------------------------------- */
/*  Consolidation                                                              */
/* --------------------------------------------------------------------------- */

export function ConsolidationKpis({ href, context = true }: StripProps = {}) {
  const { can } = useAuth();
  const { allowed, data, error } = useConsolidationStats();
  const tiles = usePressable(data?.filters, [
    { key: "awaiting_me", label: "Waiting for me", icon: Clock, tone: "warn",
      value: data?.awaiting_me, when: can(P.consApprove) },
    { key: "pending_approval", label: "In approval", icon: Hourglass, tone: "info",
      value: data?.pending_approval },
    { key: "approved", label: "Ready to tender", icon: CheckCircle2, tone: "ok",
      value: data?.approved },
    { key: "draft", label: "In draft", icon: PencilLine, tone: "neutral",
      value: data?.draft },
  ], href, Boolean(error));

  if (!allowed) return null;
  const stats: ContextStatSpec[] = [
    { key: "total", label: "Sheets", value: data?.total ?? "–", icon: Layers },
    { key: "rolled", label: "Requisitions rolled up",
      value: data?.requisitions_rolled ?? "–", icon: FileStack },
    { key: "items", label: "Items", value: data?.total_items ?? "–", icon: ListChecks },
    { key: "value", label: "Estimated value",
      value: data ? shortMoney(data.estimated_value) : "–", icon: Wallet },
  ];
  return (
    <>
      <KpiTiles label="Consolidation queues" tiles={tiles} />
      {/* Said out loud, not left as a row of pulsing skeletons: a strip that cannot
          reach its endpoint looks exactly like a slow network until somebody waits a
          minute. A 403 lands here too, which is the honest answer when a permission
          was revoked mid-session. */}
      {error && <ErrorBanner error={error} className="mt-3" />}
      {context && !error && <ContextStrip stats={stats} className="mt-3" />}
    </>
  );
}

/* --------------------------------------------------------------------------- */
/*  RFQs                                                                       */
/* --------------------------------------------------------------------------- */

export function RFQKpis({ href, context = true }: StripProps = {}) {
  const { can } = useAuth();
  const { allowed, data, error } = useRfqStats();
  const tiles = usePressable(data?.filters, [
    { key: "awaiting_me", label: "Waiting for me", icon: Clock, tone: "warn",
      value: data?.awaiting_me, when: can(P.rfqApprove) },
    { key: "pending_approval", label: "In approval", icon: Hourglass, tone: "info",
      value: data?.pending_approval },
    { key: "out_to_vendors", label: "Out to vendors", icon: Send, tone: "brand",
      value: data?.out_to_vendors },
    { key: "ready_to_award", label: "Ready to award", icon: Gavel, tone: "ok",
      value: data?.ready_to_award },
  ], href, Boolean(error));

  if (!allowed) return null;
  const stats: ContextStatSpec[] = [
    { key: "total", label: "Tenders", value: data?.total ?? "–", icon: FileText },
    { key: "closing", label: "Closing in 7 days", value: data?.closing_soon ?? "–",
      icon: Timer },
    { key: "invited", label: "Vendors invited", value: data?.vendors_invited ?? "–",
      icon: Users },
    { key: "replies", label: "Quotes received", value: data?.quotes_received ?? "–",
      icon: Handshake },
  ];
  return (
    <>
      <KpiTiles label="RFQ queues" tiles={tiles} />
      {/* Said out loud, not left as a row of pulsing skeletons: a strip that cannot
          reach its endpoint looks exactly like a slow network until somebody waits a
          minute. A 403 lands here too, which is the honest answer when a permission
          was revoked mid-session. */}
      {error && <ErrorBanner error={error} className="mt-3" />}
      {context && !error && <ContextStrip stats={stats} className="mt-3" />}
    </>
  );
}

/* --------------------------------------------------------------------------- */
/*  Quotations                                                                 */
/* --------------------------------------------------------------------------- */

export function QuotationKpis({ href, context = true }: StripProps = {}) {
  const { allowed, data, error } = useQuotationStats();
  const tiles = usePressable(data?.filters, [
    { key: "to_compare", label: "To compare", icon: ClipboardCheck, tone: "warn",
      value: data?.to_compare },
    { key: "accepted", label: "Accepted", icon: CheckCircle2, tone: "ok",
      value: data?.accepted },
    { key: "not_selected", label: "Not selected", icon: XCircle, tone: "bad",
      value: data?.not_selected },
    { key: "draft", label: "Awaiting vendor", icon: Hourglass, tone: "neutral",
      value: data?.draft },
  ], href, Boolean(error));

  if (!allowed) return null;
  const stats: ContextStatSpec[] = [
    { key: "total", label: "Quotations", value: data?.total ?? "–", icon: FileText },
    { key: "rfqs", label: "Tenders covered", value: data?.rfqs_covered ?? "–",
      icon: Layers },
    { key: "vendors", label: "Vendors quoting", value: data?.vendors_quoting ?? "–",
      icon: Users },
    { key: "value", label: "Quoted value",
      value: data ? shortMoney(data.quoted_value) : "–", icon: Banknote },
  ];
  return (
    <>
      <KpiTiles label="Quotation queues" tiles={tiles} />
      {/* Said out loud, not left as a row of pulsing skeletons: a strip that cannot
          reach its endpoint looks exactly like a slow network until somebody waits a
          minute. A 403 lands here too, which is the honest answer when a permission
          was revoked mid-session. */}
      {error && <ErrorBanner error={error} className="mt-3" />}
      {context && !error && <ContextStrip stats={stats} className="mt-3" />}
    </>
  );
}

/* --------------------------------------------------------------------------- */
/*  Purchase orders                                                            */
/* --------------------------------------------------------------------------- */

export function POKpis({ href, context = true }: StripProps = {}) {
  const { can } = useAuth();
  const { allowed, data, error } = usePoStats();
  const tiles = usePressable(data?.filters, [
    { key: "awaiting_me", label: "Waiting for me", icon: Clock, tone: "warn",
      value: data?.awaiting_me, when: can(P.poApprove) },
    { key: "pending_approval", label: "In approval", icon: Hourglass, tone: "info",
      value: data?.pending_approval },
    { key: "to_send", label: "To send out", icon: Send, tone: "brand",
      value: data?.to_send },
    { key: "at_vendor", label: "With vendor", icon: Truck, tone: "ok",
      value: data?.at_vendor },
  ], href, Boolean(error));

  if (!allowed) return null;
  const stats: ContextStatSpec[] = [
    { key: "total", label: "Orders", value: data?.total ?? "–", icon: FileText },
    { key: "month", label: "Raised this month", value: data?.this_month ?? "–",
      icon: CalendarDays },
    { key: "spend", label: "Ordered this month",
      value: data ? shortMoney(data.month_value) : "–", icon: TrendingUp },
    { key: "commitment", label: "Open commitment",
      value: data ? shortMoney(data.open_commitment) : "–", icon: PackageCheck },
  ];
  return (
    <>
      <KpiTiles label="Purchase order queues" tiles={tiles} />
      {/* Said out loud, not left as a row of pulsing skeletons: a strip that cannot
          reach its endpoint looks exactly like a slow network until somebody waits a
          minute. A 403 lands here too, which is the honest answer when a permission
          was revoked mid-session. */}
      {error && <ErrorBanner error={error} className="mt-3" />}
      {context && !error && <ContextStrip stats={stats} className="mt-3" />}
    </>
  );
}
