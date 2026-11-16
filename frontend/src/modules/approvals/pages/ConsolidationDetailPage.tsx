import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Layers, RefreshCw } from "lucide-react";
import { Button, Card, PageHeader } from "@/shared/components";
import { approvalsApi } from "../api";
import { BatchCard, batchRef } from "./ConsolidationPage";

/** One consolidation, on its own screen.
 *
 *  A consolidation is stored nowhere — it is a GROUP BY over the approver's pending
 *  queue — so there is no `/consolidations/{id}` to fetch. The cycle in the URL is the
 *  group key, and the workspace endpoint filtered to that cycle returns exactly one
 *  batch. That also makes the URL shareable and survivable across a refresh, which an
 *  in-page selection was not.
 */
export function ConsolidationDetailPage() {
  const nav = useNavigate();
  const { cycle = "" } = useParams<{ cycle: string }>();
  const back = () => nav("/approvals/consolidation");

  const query = useQuery({
    queryKey: ["approvals", "consolidation", { cycle }],
    queryFn: () => approvalsApi.consolidation({ cycle }),
  });
  const batch = query.data?.items?.[0] ?? null;

  return <>
    <PageHeader
      eyebrow="Approvals · Consolidation"
      title={batch ? batchRef(batch) : `CONS-${cycle}`}
      actions={<div className="flex gap-2">
        <Button variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <Button variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>}
    />
    <p className="mb-4 text-sm text-body">
      Everything this cycle asked for, one row per item, with the total everyone
      requested. Open an item to see which indents asked for it, then set each indent's
      quantity or exclude it in its own row. Approve all sends every indent in this
      consolidation on at those quantities.
    </p>

    {query.error
      ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p>
      : query.isLoading
        ? <Card className="p-8 text-center text-muted">Loading…</Card>
        : batch
          // Everything in this consolidation has been approved (or moved on) — the
          // cycle no longer comes back, which is the answer, not an error.
          ? <BatchCard batch={batch} onBack={back} />
          : <Card className="flex flex-col items-center gap-2 p-10 text-center text-muted">
              <Layers className="h-6 w-6" />
              This consolidation is no longer waiting on you.
              <Button variant="ghost" onClick={back}>Back to consolidations</Button>
            </Card>}
  </>;
}
