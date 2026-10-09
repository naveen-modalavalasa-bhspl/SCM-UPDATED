import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Layers, RefreshCw, Search } from "lucide-react";
import { Button, Card, PageHeader } from "@/shared/components";
import { approvalsApi } from "../api";
import { IssueFromStockPanel } from "../components/IssueFromStockPanel";
import { PriorityFilter, PriorityTag } from "../components/PriorityFilter";

/** Serve-from-stock for a whole consolidation, on its own screen.
 *
 *  There is no "issue the batch": a consolidation is a view over several documents and
 *  stock is issued INTO the raiser's own point, so each indent's goods go somewhere
 *  different. One panel per indent — which is exactly why this screen needs a way to
 *  reach ONE of them: an approver with limited stock is looking for the urgent indent,
 *  or for one requester, not scrolling twenty panels to find it.
 */
export function ConsolidationIssuePage() {
  const nav = useNavigate();
  const { cycle = "" } = useParams<{ cycle: string }>();
  const back = () => nav(`/approvals/consolidation/${encodeURIComponent(cycle)}`);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");

  const query = useQuery({
    queryKey: ["approvals", "consolidation", { cycle }],
    queryFn: () => approvalsApi.consolidation({ cycle }),
  });
  const batch = query.data?.items?.[0] ?? null;
  const indents = batch?.indents ?? [];

  // Filtering is local: the whole batch is already in hand, and a round trip per
  // keystroke would tear down every open panel and the quantities typed into it.
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return indents
      .filter((row) => !priority || (row.priority ?? "NORMAL") === priority)
      .filter((row) => !needle || [
        row.indent_no, row.requested_by_name, row.region_name, row.project_name,
      ].some((value) => value?.toLowerCase().includes(needle)))
      // Urgent first — an approver spending stock they cannot spend twice should see
      // the indents that cannot wait before the ones that can.
      .sort((a, b) => Number((b.priority ?? "") === "URGENT") - Number((a.priority ?? "") === "URGENT"));
  }, [indents, search, priority]);

  const control = "h-10 rounded-lg border border-line bg-content1 text-sm text-ink outline-none focus:border-brand";

  return <>
    <PageHeader
      eyebrow="Approvals · Consolidation"
      title="Serve from own stock"
      actions={<div className="flex gap-2">
        <Button variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" /> Back</Button>
        <Button variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>}
    />
    <p className="mb-4 text-sm text-muted">
      Issue what you hold; the rest stays on the indent and goes up.
    </p>

    {query.error
      ? <p className="rounded-xl bg-danger/10 p-4 text-sm text-danger">{(query.error as Error).message}</p>
      : query.isLoading
        ? <Card className="p-8 text-center text-muted">Loading…</Card>
        : indents.length === 0
          ? <Card className="flex flex-col items-center gap-2 p-10 text-center text-muted">
              <Layers className="h-6 w-6" />
              This consolidation is no longer waiting on you.
              <Button variant="ghost" onClick={back}>Back to the consolidation</Button>
            </Card>
          : <>
              {/* Deliberately narrow. Two controls over a stack of panels, not a filter
                  bar spanning the page — it is a way to reach one indent, nothing more. */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    className={`${control} w-full pl-9 pr-3 placeholder:text-muted`}
                    type="search"
                    aria-label="Search indents"
                    placeholder="Indent no. or requester…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <PriorityFilter value={priority} onChange={setPriority} />
                <span className="text-xs text-muted">{shown.length} of {indents.length}</span>
              </div>

              {shown.length === 0
                ? <Card className="p-10 text-center text-muted">No indent matches.</Card>
                : <div className="space-y-5">
                    {shown.map((row) => (
                      <div key={row.id}>
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <strong className="font-mono text-ink">{row.indent_no}</strong>
                          <PriorityTag priority={row.priority} />
                          <span className="text-xs text-muted">
                            {[row.requested_by_name, row.project_name].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                        <IssueFromStockPanel indentId={row.id} />
                      </div>
                    ))}
                  </div>}
            </>}
  </>;
}
