import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { LoadingRows } from "../components/PageStates";
import {
  approveAllocation, getAllocation, getAllocationAvailability, getAllocationHistory,
  getPendingInventoryApprovals, rejectAllocation,
} from "../api";
import { alerts } from "@/modules/alerts";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

/**
 * Full-screen review, not a popup: the popup card hid the approval history and the
 * line table behind a modal scroll region, and there was no URL a reviewer could
 * bookmark or come back to mid-decision. This is the same content, routed at
 * /inventory/allocation-approvals/:id so it is a real page.
 *
 * The give quantity is editable for whoever the allocation is currently waiting on.
 * It was read-only, so an approver who thought 60 was too generous could only reject
 * the whole thing and ask for it to be raised again. A revision is capped at what was
 * requested and at what is genuinely free at that point — the server re-checks both
 * under a row lock, so the number on screen is a guide, not the authority.
 */
export function AllocationApprovalDetailPage() {
  const { id } = useParams();
  const allocationId = Number(id);
  const [searchParams] = useSearchParams();
  const decisionView = searchParams.get("decision") === "1";
  const nav = useNavigate();
  const qc = useQueryClient();
  const [comments, setComments] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Only the lines the approver actually touched. An untouched line is not sent, so
  // approving without editing stays exactly the act it always was.
  const [edits, setEdits] = useState<Record<number, string>>({});

  const allocation = useQuery({
    queryKey: ["inventory", "allocation-decision", allocationId],
    queryFn: () => getAllocation(allocationId),
    enabled: Number.isFinite(allocationId) && allocationId > 0,
  });

  // The shelf moves while an allocation waits for a signature. This is what is free
  // at each chosen point right now, less what other un-approved allocations have
  // already promised out of it.
  const availability = useQuery({
    queryKey: ["inventory", "allocation-availability", allocationId],
    queryFn: () => getAllocationAvailability(allocationId),
    enabled: Number.isFinite(allocationId) && allocationId > 0,
    // Stale free stock is worse than none: it is the number the approver is about to
    // commit against, so it is re-read whenever the screen comes back into focus.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const freeFor = (lineId: number) =>
    (availability.data ?? []).find((row) => row.id === lineId);

  const history = useQuery({
    queryKey: ["inventory", "allocation-history", allocationId],
    queryFn: () => getAllocationHistory(allocationId),
    enabled: Number.isFinite(allocationId) && allocationId > 0,
  });

  // Status alone does not answer "is this mine to sign": a two-rung allocation is
  // still PENDING_APPROVAL after the first signature, and it was still offering
  // Approve to the person who had just signed it — a button whose only outcome was
  // the server's refusal. The inbox is the authority on whose turn it is.
  const { can, me } = useAuth();
  const isAdmin = can("admin.workflow.manage") || Boolean(me?.roles.includes("ADMIN")) || Boolean(me?.roles.includes("SUPERUSER"));

  const pending = useQuery({
    queryKey: ["inventory", "allocation-pending-mine"],
    queryFn: getPendingInventoryApprovals,
  });

  const a = allocation.data;
  const waitingOnMe = (pending.data ?? []).some((row) => row.doc_id === allocationId) || (isAdmin && a?.status === "PENDING_APPROVAL");

  const goBack = () => nav(decisionView ? "/approvals/decisions" : "/inventory/fulfilment?tab=approvals");

  // A revision only counts if the number actually changed — retyping 40 over 40 is
  // not a decision and must not read as one in the audit trail.
  const revisions = (a?.items ?? []).flatMap((item) => {
    const typed = edits[item.id];
    if (typed === undefined || typed === "") return [];
    const quantity = Number(typed);
    if (!Number.isFinite(quantity) || quantity < 0) return [];
    return quantity === Number(item.quantity) ? [] : [{ id: item.id, quantity }];
  });
  // What this signature will actually do. An allocation whose lines are all zero —
  // the shelf was empty when it was decided — reserves nothing: approving it raises
  // the material request and sends the indent to procurement. The button used to
  // promise "Approve and reserve" on exactly that document.
  const giveFor = (item: { id: number; quantity: number | string }) => {
    const typed = edits[item.id];
    const value = typed === undefined || typed === "" ? Number(item.quantity) : Number(typed);
    return Number.isFinite(value) ? value : 0;
  };
  // One indent line served from two points is two rows sharing ONE request: the desk
  // writes the whole ask on the first row (10) and 0 on the next. Requested, shortage
  // and the cap are therefore the indent LINE's, never one row's — read per row, the
  // second point's 8 was capped at 0 and drawn as "Nothing free" over 41 on the shelf.
  const groupOf = (item: { id: number; indent_item_id?: number | null }) =>
    item.indent_item_id ? `line-${item.indent_item_id}` : `row-${item.id}`;
  const groupRows = (key: string) => (a?.items ?? []).filter((row) => groupOf(row) === key);
  const askedFor = (key: string) =>
    groupRows(key).reduce((sum, row) => sum + Number(row.requested_qty), 0);
  const givenFor = (key: string) =>
    groupRows(key).reduce((sum, row) => sum + giveFor(row), 0);
  /** The most this row may give: what is free at its point, and what the line still
   *  asks for once its other rows have taken theirs. */
  const capFor = (item: { id: number; indent_item_id?: number | null }) => {
    const live = freeFor(item.id);
    if (live === undefined) return undefined;
    const key = groupOf(item);
    const others = groupRows(key)
      .filter((row) => row.id !== item.id)
      .reduce((sum, row) => sum + giveFor(row), 0);
    return Math.max(0, Math.min(live.free, askedFor(key) - others));
  };

  const givenTotal = (a?.items ?? []).reduce((sum, item) => sum + giveFor(item), 0);
  const requestedTotal = (a?.items ?? []).reduce((sum, item) => sum + Number(item.requested_qty), 0);
  const buys = givenTotal < requestedTotal;
  const approveLabel = givenTotal <= 0
    ? "Approve and raise material request"
    : buys
      ? "Approve, reserve and raise MR"
      : revisions.length ? "Approve revised and reserve" : "Approve and reserve";

  // FIXED 2026-08-21 — approving with every Give at 0 while the shelf is full is
  // almost always a slip: the approver opened a reopened allocation, read "Free now
  // 30", and pressed Approve without touching the Give column, which signs the
  // document for nothing and sends the indent back round. Giving nothing IS a real
  // decision — the request may be premature, or the goods earmarked — so this asks
  // rather than blocks.
  const freeTotal = (a?.items ?? []).reduce(
    (sum, item) => sum + Number(freeFor(item.id)?.free ?? 0), 0);
  const givingNothingWithStock = givenTotal <= 0 && freeTotal > 0;

  const overCap = (a?.items ?? []).some((item) => {
    const give = giveFor(item);
    const cap = capFor(item);
    return cap !== undefined && give > cap;
  });

  const act = useMutation({
    mutationFn: ({ approve }: { approve: boolean }) =>
      approve
        ? approveAllocation(allocationId, comments, revisions)
        : rejectAllocation(allocationId, comments),
    onSuccess: (_result, { approve }) => {
      void alerts.success(approve ? "allocation.approved" : "allocation.rejected");
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["fulfillment-queue"] });
      goBack();
    },
    onError: (err: Error) => {
      setError(err.message);
      // The refusal is almost always "the shelf moved" — so re-read the shelf, and
      // the approver sees the new number instead of the one that was just rejected.
      void availability.refetch();
    },
  });

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title={a ? `Review ${a.allocation_no}` : "Review allocation"}
        actions={
          <Button variant="subtle" onClick={goBack}>
            <ArrowLeft size={14} /> Back
          </Button>
        }
      />

      {allocation.isLoading ? (
        <LoadingRows rows={6} className="p-0" />
      ) : allocation.error || !a ? (
        <div className="rounded-lg bg-bad-bg p-4 text-sm text-bad">
          {(allocation.error as Error)?.message ?? "Allocation not found"}
        </div>
      ) : (
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-bad-bg p-3 text-sm text-bad">{error}</div>}

          <Card className="p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <div><strong>Indent:</strong> {a.indent_no}</div>
                <div><strong>Decided by:</strong> {a.allocated_by_name ?? "—"}</div>
                {a.remarks && <div><strong>Reason:</strong> {a.remarks}</div>}
              </div>
              <StatusPill status={a.status} />
            </div>
          </Card>

          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <p className="text-xs text-muted">
                {waitingOnMe
                  ? "Change a Give quantity to approve a different number. Free is what is on the shelf now, less what other pending allocations have promised."
                  : "Free is what is on the shelf now, less what other pending allocations have promised."}
              </p>
              <Button
                variant="subtle"
                onClick={() => void availability.refetch()}
                disabled={availability.isFetching}
              >
                <RefreshCw size={14} className={availability.isFetching ? "animate-spin" : ""} />
                {availability.isFetching ? "Checking…" : "Recheck stock"}
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-content2 text-xs text-muted">
                  <tr>
                    <th className="p-3">Item</th>
                    <th className="p-3">Requested</th>
                    <th className="p-3">Give</th>
                    <th className="p-3">Free now</th>
                    <th className="p-3">Warehouse</th>
                    <th className="p-3">Shortage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {a.items.map((item) => {
                    const live = freeFor(item.id);
                    const typed = edits[item.id];
                    const give = typed === undefined || typed === ""
                      ? Number(item.quantity) : Number(typed);
                    const cap = capFor(item);
                    const tooMuch = cap !== undefined && give > cap;
                    const group = groupOf(item);
                    // Requested and shortage are said once, on the line's first row.
                    const firstOfLine = groupRows(group)[0]?.id === item.id;
                    // Nothing free at any point this login can draw from: there is no
                    // number to type. The box stayed editable and accepted one, and the
                    // server then refused the approval — the shelf is the answer, not a
                    // matter of what the approver would like to give. Only once the live
                    // re-check has actually come back (`live`), so a slow request never
                    // greys out a line that does have stock.
                    // The SHELF, not the cap: a cap of 0 also means "the line's other rows
                    // already cover the request", which is not the same as nothing free.
                    const nothingFree = live !== undefined && live.free <= 0 && give <= 0;
                    return (
                      <tr key={item.id}>
                        <td className="p-3">
                          <div className="font-medium text-ink">{item.item_name}</div>
                          <div className="text-xs text-muted">{item.item_code}</div>
                        </td>
                        <td className="p-3">
                          {firstOfLine
                            ? <>{fmt(askedFor(group))} {item.uom_code}</>
                            : <span className="text-xs text-muted">same line, another point</span>}
                        </td>
                        <td className="p-3">
                          {waitingOnMe ? (
                            <div className="w-32">
                              <Input
                                type="number"
                                min={0}
                                max={cap}
                                step="any"
                                disabled={nothingFree}
                                value={nothingFree ? "0" : (typed ?? String(item.quantity))}
                                onChange={(event) => setEdits((prev) => ({
                                  ...prev, [item.id]: event.target.value,
                                }))}
                                aria-label={`Give quantity for ${item.item_name ?? item.item_code}`}
                              />
                              {nothingFree ? (
                                <p className="mt-1 text-[11px] text-muted">
                                  Nothing free — the whole line goes to procurement.
                                </p>
                              ) : tooMuch && (
                                <p className="mt-1 text-[11px] text-bad">
                                  Max {fmt(cap!)} {item.uom_code}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="font-semibold text-ok">
                              {fmt(item.quantity)} {item.uom_code}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          {availability.isLoading || !live ? (
                            <span className="text-xs text-muted">…</span>
                          ) : (
                            <div>
                              <div className={live.free < give ? "font-semibold text-bad" : "text-ink"}>
                                {fmt(live.free)} {item.uom_code}
                              </div>
                              {live.pledged_elsewhere > 0 && (
                                <div className="text-[11px] text-muted">
                                  {fmt(live.on_shelf)} on shelf · {fmt(live.pledged_elsewhere)} promised
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="p-3">{item.warehouse_name ?? "Not allocated"}</td>
                        <td className="p-3 text-warn">
                          {firstOfLine
                            ? <>{fmt(Math.max(0, askedFor(group) - givenFor(group)))} {item.uom_code}</>
                            : <span className="text-xs text-muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">Approval history</h3>
            <div className="divide-y divide-line rounded-xl border border-line">
              {history.isLoading && (
                <LoadingRows rows={3} className="p-0" />
              )}
              {(history.data ?? []).map((row, index) => (
                <div key={`${row.stage_sequence}-${index}`} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <strong className="text-ink">{row.actor_name ?? "System"}</strong>
                      <p className="text-xs text-muted">
                        {row.stage_name ?? `Step ${row.stage_sequence}`}
                        {" · "}
                        {/* The hat matters: the same person signs each step under a
                            different position. */}
                        {row.actor_position ?? "Position unavailable"}
                      </p>
                    </div>
                    <StatusPill status={row.action} />
                  </div>
                  {row.comments && <p className="mt-1 text-sm text-body">{row.comments}</p>}
                  <p className="mt-1 text-xs text-muted">
                    {row.acted_at ? new Date(row.acted_at).toLocaleString() : "—"}
                  </p>
                </div>
              ))}
              {!history.isLoading && !(history.data ?? []).length && (
                <p className="p-3 text-sm text-muted">Nothing signed yet — this is the first step.</p>
              )}
            </div>
          </Card>

          {/* A decided allocation has nothing left to sign. The buttons used to show
              on every allocation this screen could open — including one that was just
              approved — and clicking them only produced the server's refusal. */}
          {!decisionView && !pending.isLoading && !waitingOnMe && (
            <Card className="p-4 text-sm text-muted">
              {a.status === "PENDING_APPROVAL"
                ? "Signed at your level — this allocation is now waiting on the next approver."
                : `This allocation is ${a.status === "APPROVED" ? "approved" : a.status.toLowerCase()} — there is nothing left to decide here.`}
            </Card>
          )}

          {!decisionView && waitingOnMe && (
            <Card className="p-4">
              {revisions.length > 0 && (
                <div className="mb-3 rounded-lg bg-warn-bg p-3 text-sm text-warn">
                  {revisions.length} quantit{revisions.length === 1 ? "y" : "ies"} revised.
                  Approving reserves your numbers, not the ones inventory proposed, and
                  records the change against your name.
                </div>
              )}
              {buys && (
                <div className="mb-3 rounded-lg bg-warn-bg p-3 text-sm text-warn">
                  {givenTotal <= 0
                    ? "Nothing is free to reserve. Approving raises a material request for the whole quantity and sends the indent to procurement."
                    : "Approving reserves what is free and raises a material request for the shortage, which goes to procurement."}
                </div>
              )}
              <Field label="Comments">
                <Input
                  value={comments}
                  onChange={(event) => setComments(event.target.value)}
                  placeholder={revisions.length ? "Why the quantity changed" : "Optional reason or instruction"}
                />
              </Field>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="subtle" onClick={goBack}>Cancel</Button>
                {revisions.length > 0 && (
                  <Button variant="subtle" onClick={() => setEdits({})}>Undo edits</Button>
                )}
                <Button className={TONE_REJECT} variant="danger" disabled={act.isPending} onClick={() => act.mutate({ approve: false })}>
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                {/* `waitingOnMe` above is the approval config talking — the ladder
                    decides whose turn it is. This is the job profile talking. Reject
                    stays outside it on purpose: an approver must never be left with a
                    document they can neither sign nor refuse. */}
                {(can("allocation.approve_reserve") || isAdmin) && (
                  <Button
                    className={TONE_APPROVE}
                    disabled={act.isPending || overCap}
                    onClick={() => void (async () => {
                      // See `givingNothingWithStock`.
                      if (givingNothingWithStock && !(await alerts.confirm(
                        "allocation.give_nothing",
                        { free: freeTotal, requested: requestedTotal },
                      ))) return;
                      act.mutate({ approve: true });
                    })()}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {isAdmin && !waitingOnMe ? `${approveLabel} (Admin Override)` : approveLabel}
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
