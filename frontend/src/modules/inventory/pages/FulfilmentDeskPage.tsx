import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { PageHeader } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { FulfillmentQueuePage } from "./FulfillmentQueuePage";
import { AllocationApprovalsPage } from "./AllocationApprovalsPage";
import { getPendingInventoryApprovals } from "../api";

/**
 * The Fulfilment Desk — deciding what to give and signing it, in one place.
 *
 * These were two screens: the Fulfilment Queue listed what an indent was still owed
 * and took the decision, and Allocation Approvals signed it. That split was never a
 * split in the work. Where a project's ladder says NO_APPROVAL the second screen was a
 * page with one button on it; where a real ladder is configured the approver had to
 * leave the numbers behind and go find the document somewhere else. Both halves ask
 * the same question about the same rows, so they are two tabs now, not two screens.
 *
 * WHAT THIS IS NOT: it is not a way around the ladder. Pressing anything here still
 * goes through `allocations.create` / `allocations.act`, which ask
 * `platform/workflow/ladder` who signs and refuse the shelf arithmetic the same way
 * they always did. How many presses a fulfilment takes is decided on Settings >
 * Approvals Config, per project, per document type — never here.
 *
 * The tabs are gated separately on purpose. Deciding is `allocation.create`; signing
 * is `allocation.approve`. A storekeeper who allocates but does not approve sees one
 * tab, and the desk that does both sees two — the same division the two screens
 * carried, kept rather than flattened.
 */
export function FulfilmentDeskPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  const mayDecide = can("allocation.create");
  const mayApprove = can("allocation.approve");

  // What is actually waiting on this hat, for the badge. The same call the Approvals
  // tab makes for its "Waiting for me" filter, so the number on the tab and the rows
  // behind it can never disagree.
  const pending = useQuery({
    queryKey: ["inventory", "pending-approvals", "desk-badge"],
    queryFn: getPendingInventoryApprovals,
    enabled: mayApprove,
  });

  const tabs = useMemo(() => [
    ...(mayDecide ? [{ key: "queue", label: "To allocate" }] : []),
    ...(mayApprove ? [{ key: "approvals", label: "To approve",
                       badge: pending.data?.length ?? 0 }] : []),
  ], [mayDecide, mayApprove, pending.data]);

  // The tab lives in the URL so a link into the desk lands on the half it meant, and
  // so a back press out of a review returns to the approvals list rather than the
  // queue. Falls back to the first tab the login can actually see: a profile with only
  // one of the two permissions must never open on a blank half.
  const requested = params.get("tab");
  const active = tabs.some((t) => t.key === requested)
    ? (requested as string)
    : tabs[0]?.key;

  const select = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Fulfilment Desk" />
      <p className="mb-4 max-w-[75ch] text-sm text-muted">
        Decide what to give, then sign it. Nothing moves until warehouse issue.
      </p>

      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Fulfilment Desk"
          className="mb-4 inline-flex gap-1 rounded-xl border border-line/70 bg-content2/60 p-1"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={active === tab.key}
              onClick={() => select(tab.key)}
              // 44px tap target (rule 12).
              className={`flex min-h-[44px] items-center gap-2 rounded-lg px-4
                text-sm font-semibold transition-colors ${
                active === tab.key
                  ? "bg-brand text-white shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.badge ? (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  active === tab.key ? "bg-white/25 text-white" : "bg-brand/15 text-brand"
                }`}>
                  {tab.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {active === "approvals" ? (
        <AllocationApprovalsPage embedded />
      ) : active === "queue" ? (
        <FulfillmentQueuePage embedded />
      ) : (
        // Neither permission. The page permission and the action permissions are
        // granted separately, so a profile can reach the screen holding neither — say
        // so rather than painting an empty tab strip over nothing.
        <div className="flex items-start gap-2 rounded-lg border border-line/70 bg-content1 p-4 text-sm text-muted">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <span>
            You can view this screen, but acting needs
            <code className="mx-1 rounded bg-content2 px-1">allocation.create</code>
            or
            <code className="mx-1 rounded bg-content2 px-1">allocation.approve</code>.
            Ask your admin if this looks wrong.
          </span>
        </div>
      )}
    </div>
  );
}
