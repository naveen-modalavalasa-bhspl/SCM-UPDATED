import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle, ArrowLeft, EyeOff, FileSearch, FileText, PackageCheck,
} from "lucide-react";
import {
  Button, Card, ErrorBanner, Input, PageHeader,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { approvalsApi } from "../api";
import type { DecisionLedger } from "../types";
import {
  ItemRow, LoadingLedger, PendingNow, RequestedRow, SectionHead, SummaryHeader,
} from "../components/ledgerParts";
import { MonthlyCycleLedger } from "../components/MonthlyCycleLedger";

/**
 * One decision, explained to somebody who has never seen the system.
 *
 * The screen is read top-down in the order a person asks the questions: what did I
 * decide (the sentence, in words), on what document (the chips beside it), what
 * happened to each line (the sentence again, per item, with the numbers UNDER it),
 * and where is it now (the pending panel on the right).
 *
 * There is deliberately NO approval journey on this page any more. "Complete approval
 * history" put every rung of the ladder in front of every reader, so the OE who cut a
 * line to 5 also read the DM's later cut to 3 — somebody else's decision, on a page
 * that exists to show this reader their own. What a login may read is decided on the
 * server (`_ledger_visibility`), off the trail itself rather than a map of ranks, and
 * the payload simply does not carry the stages above the reader. `visibility.note`
 * is the server saying so, in a sentence, so a short trail reads as scoped rather
 * than as data that failed to load.
 *
 * The numbers stay — an approver auditing a reduction needs all five of them — but
 * they are no longer the loudest thing on the line. Five filled grey boxes per item
 * is a spreadsheet, and the reader has to work out what the arithmetic between them
 * means before the row says anything at all. They are one quiet rail now, split
 * where the meaning splits: the three that trace the quantity through the ladder,
 * then the two that are the OUTCOME, which is what most readers came for.
 *
 * Colour carries the outcome and nothing else — green approved, amber went back or
 * was cut, red denied, blue still waiting — and it is the same vocabulary the
 * decisions list uses, so arriving here from a green row lands on a green page. The
 * vocabulary itself lives in `components/ledgerParts`, because there are TWO ledgers
 * now (see below) and a colour that means one thing on one of them and something
 * else on the other is worse than either.
 *
 * TWO LEDGERS, one route. A MONTHLY indent is not one document to the approver who
 * signed it — the Consolidation screen takes the whole cycle in a single press and
 * writes one `wf_actions` row per site — so this page renders `MonthlyCycleLedger`
 * for one instead. Same URL, same permission, same entry points from My Decisions
 * and the inbox: the SHAPE OF THE DOCUMENT decides the shape of the page, never the
 * link that was clicked, or half the ways in would land on the wrong one.
 */

/* The "Monthly consolidation tracking" sidebar that used to sit here is GONE, not
 * moved. `consolidation.is_consolidated` is true for exactly the monthly indents,
 * and a monthly indent now renders `MonthlyCycleLedger` — so the panel could never
 * draw again, and leaving it behind would have read as a second, quieter answer to
 * the question that page exists for. Everything it carried (the period, the
 * cut-off window, the consolidation number, the sibling indents) is on the cycle
 * hero and the By-site register, stated per member rather than as one row of
 * document totals with `Final 0` down the column.
 */

function QuickAnswers({ data }: { data: DecisionLedger }) {
  const rows = [
    { q: "Who requested it?", a: data.indent.requester ?? "Unavailable" },
    { q: "Who changed it?", a: data.decision.actor_name ?? "Waiting for you" },
    { q: "When?", a: data.decision.decided_at ? fmtDateTime(data.decision.decided_at) : "Pending" },
    { q: "Why?", a: data.decision.comments ?? "No comment recorded" },
    { q: "Stage", a: data.decision.stage_name ?? "Unavailable" },
  ];
  return (
    <Card className="p-4">
      <SectionHead icon={FileSearch} title="Quick answers" />
      <dl className="divide-y divide-line/70">
        {rows.map(({ q, a }) => (
          <div key={q} className="py-2 first:pt-0 last:pb-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{q}</dt>
            <dd className="mt-0.5 text-sm font-medium text-ink">{a}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** One regular indent: the page as it has always been. */
function RegularLedger({ data }: { data: DecisionLedger }) {
  const nav = useNavigate();
  const [itemSearch, setItemSearch] = useState("");
  /** One press at the top right: the decision view, or the indent as it was raised. */
  const [showOriginal, setShowOriginal] = useState(false);

  const filteredItems = useMemo(() => {
    const term = itemSearch.trim().toLowerCase();
    if (!term) return data.items;
    return data.items.filter((item) => [
      item.item_name, item.item_code, item.uom_code, item.reason,
    ].some((value) => String(value ?? "").toLowerCase().includes(term)));
  }, [data, itemSearch]);

  return (
    <>
      <PageHeader
        title="Decision Ledger"
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => nav("/approvals/decisions")}>
              <ArrowLeft className="h-4 w-4" /> My Decisions
            </Button>
            <Button
              variant={showOriginal ? "soft" : "subtle"}
              onClick={() => setShowOriginal((on) => !on)}
            >
              <FileText className="h-4 w-4" />
              {showOriginal ? "Show decisions" : "Original request"}
            </Button>
            {data.decision.mode === "WAITING" && (
              <Button variant="soft" onClick={() => nav(`/approvals?reviewIndent=${data.indent.id}`)}>
                Open approval
              </Button>
            )}
          </div>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <main className="space-y-4">
          <SummaryHeader data={data} />
          {/* Said out loud, and said by the SERVER. A page that quietly shows less
              than the document holds reads as a page with missing data; this is the
              one sentence that makes a short trail legible rather than suspicious. */}
          {data.visibility?.note && (
            <Card className="flex items-start gap-2 border-line bg-content2 p-3 text-sm text-body">
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>{data.visibility.note}</span>
            </Card>
          )}
          {data.legacy_gaps.length > 0 && (
            <Card className="border-warn/30 bg-warn-bg p-3 text-sm text-warn">
              <div className="flex gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-semibold">Legacy information unavailable</p>
                  {data.legacy_gaps.map((gap) => <p key={gap}>{gap}</p>)}
                </div>
              </div>
            </Card>
          )}
          <Card className="p-4">
            <SectionHead
              icon={showOriginal ? FileText : PackageCheck}
              title={showOriginal ? "Original request" : "Item decisions"}
              right={
                <div className="w-full sm:w-72">
                  <Input
                    aria-label="Search item decisions"
                    value={itemSearch}
                    onChange={(event) => setItemSearch(event.target.value)}
                    placeholder="Search item, code, UOM, reason"
                  />
                </div>
              }
            />
            {showOriginal && (
              <p className="-mt-1 mb-3 rounded-lg border-l-2 border-brand/40 bg-content2 px-3 py-2 text-sm text-body">
                What {data.indent.requester ?? "the requester"} asked for when this
                indent was raised, before any approver changed it.
              </p>
            )}
            <div className="space-y-2.5">
              {filteredItems.map((item) => (showOriginal
                ? <RequestedRow key={item.line_id} item={item} />
                : <ItemRow
                    key={item.line_id}
                    item={item}
                    outcomeLabel={data.visibility?.outcome_label ?? "Final approved"}
                  />))}
              {filteredItems.length === 0 && (
                <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
                  No item line matches this search.
                </div>
              )}
            </div>
          </Card>
        </main>
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <PendingNow data={data} />
          <QuickAnswers data={data} />
        </aside>
      </div>
    </>
  );
}

export function DecisionLedgerPage() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const docType = params.docType ?? "INDENT";
  const docId = Number(params.docId);
  const actionId = searchParams.get("action") ? Number(searchParams.get("action")) : null;
  const query = useQuery({
    queryKey: ["approvals", "decision-ledger", docType, docId, actionId],
    queryFn: () => approvalsApi.decisionLedger(docType, docId, actionId),
    enabled: Number.isFinite(docId),
  });
  const data = query.data;

  // The document decides, not the caller. `indent_type` is the raw enum the server
  // already serves beside the display label — matching on the label would break the
  // day somebody rewords "Monthly/Consolidation".
  if (data && data.indent.indent_type === "MONTHLY") {
    return <MonthlyCycleLedger ledger={data} />;
  }

  return (
    <>
      {!data && <PageHeader title="Decision Ledger" />}
      <ErrorBanner error={query.error} />
      {query.isLoading && <LoadingLedger />}
      {data && <RegularLedger data={data} />}
    </>
  );
}
