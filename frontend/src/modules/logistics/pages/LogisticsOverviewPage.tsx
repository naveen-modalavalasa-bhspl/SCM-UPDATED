import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2, Clock, FileEdit, IndianRupee, PackageCheck, Route, ScrollText,
  Send, TriangleAlert, Truck,
} from "lucide-react";
import {
  Can, ErrorBanner, KpiTiles, PageHeader, type KpiTileSpec,
} from "@/shared/components";
import { transportApi } from "../api";

/**
 * Logistics > Overview — the module's front page.
 *
 * NEW 2026-08-23. Logistics was the only module without one: `/logistics` redirected
 * straight into Consignments, so the rail had no landing place and there was nowhere
 * that answered "what is the state of the outward leg" without opening four screens
 * and adding the numbers up by hand.
 *
 * It READS and nothing else. Every number comes from `/api/transport/summary`, which
 * the Shipments register already lives on, so this page introduces no endpoint, no
 * table and no permission — and it can never disagree with Shipments, because there is
 * one source and the two are reading it.
 *
 * RBAC: the whole page sits inside `<Can do="transport.view">`. Without that code the
 * strip is not rendered, the query never fires, and the endpoint behind it would 403
 * anyway — the gate is the server's, and this only stops us drawing a shape around a
 * number nobody is allowed to see. The tiles navigate to screens that carry their own
 * `<Can>` and their own page permission, so a tile can never be a way into a screen
 * its holder could not otherwise open.
 *
 * THE NUMBER IS THE BUTTON, as everywhere else: each tile opens the queue it counted,
 * pre-filtered to it. Nothing here is a filter of its own — this page has no list
 * under it, so a tile hands the reader to the screen that does.
 */
export function LogisticsOverviewPage() {
  const nav = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["transport-summary"],
    queryFn: transportApi.summary,
  });

  // `undefined` while in flight so the strip draws a skeleton, and `failed` once the
  // request is actually refused — a tile that pulses forever is indistinguishable from
  // a slow network. 0 is a real answer and renders as 0.
  const n = (value?: number) => (isLoading ? undefined : value ?? 0);
  const failed = Boolean(error);

  /** Shipments, narrowed to one rung. The register reads `?status=` off the URL. */
  const shipments = (status?: string) =>
    nav(status ? `/logistics/shipments?status=${status}` : "/logistics/shipments");

  // The outward leg in the order it happens: raised, priced, awarded, moving, landed.
  // Read down, the strip is the flow — which is the point of a module overview as
  // against a pile of counts.
  const queues: KpiTileSpec[] = [
    {
      key: "draft", label: "Drafts", value: n(data?.draft), icon: FileEdit,
      tone: "neutral", failed, onPress: () => shipments("DRAFT"),
    },
    {
      key: "pending", label: "In approval", value: n(data?.pending_approval),
      icon: Clock, tone: data?.pending_approval ? "warn" : "neutral", failed,
      onPress: () => shipments("PENDING_APPROVAL"),
    },
    {
      key: "quoting", label: "Out for a price", value: n(data?.quoting),
      icon: IndianRupee, tone: data?.quoting ? "brand" : "neutral", failed,
      onPress: () => shipments("QUOTING"),
    },
    {
      key: "awaiting", label: "Awaiting the carrier", value: n(data?.awaiting_carrier),
      icon: Send, tone: data?.awaiting_carrier ? "warn" : "neutral", failed,
      hint: "Awarded, waiting on the provider's own yes. Opens the shipments register.",
      onPress: () => shipments("AWAITING_CARRIER"),
    },
    {
      key: "ready", label: "Ready to move", value: n(data?.ready), icon: PackageCheck,
      tone: data?.ready ? "ok" : "neutral", failed, onPress: () => shipments("READY"),
    },
    {
      key: "transit", label: "On the road", value: n(data?.in_transit), icon: Truck,
      tone: data?.in_transit ? "brand" : "neutral", failed,
      onPress: () => shipments("IN_TRANSIT"),
    },
    {
      key: "delivered", label: "Delivered", value: n(data?.delivered), icon: Route,
      tone: data?.delivered ? "ok" : "neutral", failed,
      onPress: () => shipments("DELIVERED"),
    },
    {
      key: "closed", label: "Closed", value: n(data?.closed), icon: CheckCircle2,
      tone: "neutral", failed, onPress: () => shipments("CLOSED"),
    },
  ];

  // What is WRONG or waiting on somebody, kept apart from the flow above. A claim and
  // a shipment nobody is tracking are not rungs of the journey — they are the two
  // reasons a desk opens this page at all, so they do not get buried in a row of eight.
  const attention: KpiTileSpec[] = [
    {
      key: "claims", label: "Open claims", value: n(data?.open_claims),
      icon: TriangleAlert, tone: data?.open_claims ? "bad" : "neutral", failed,
      hint: "Short or damaged deliveries still unresolved. Opens the activity ledger.",
      onPress: () => nav("/logistics/activity?claims=1"),
    },
    {
      key: "awaiting_ack", label: "Awaiting a signature", value: n(data?.awaiting_ack),
      icon: Clock, tone: data?.awaiting_ack ? "warn" : "neutral", failed,
      hint: "Delivered by the carrier, not yet signed for by the site.",
      onPress: () => shipments("DELIVERED"),
    },
    {
      key: "untracked", label: "No carrier yet", value: n(data?.untracked),
      icon: ScrollText, tone: data?.untracked ? "warn" : "neutral", failed,
      hint: "Packed consignments with no transport raised. Opens the dispatch queue.",
      onPress: () => nav("/logistics/dispatch"),
    },
  ];

  return (
    <Can do="transport.view">
      <PageHeader eyebrow="Logistics" title="Overview" />
      <p className="mb-4 text-sm text-muted">
        The outward leg at a glance. Press a number to open the queue behind it.
      </p>

      <ErrorBanner error={error} />

      <KpiTiles label="Shipment queues" className="mb-4" tiles={queues} />

      <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wider text-muted">
        Needs attention
      </h2>
      <KpiTiles label="Needs attention" tiles={attention} />
    </Can>
  );
}

export default LogisticsOverviewPage;
