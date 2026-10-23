import { useState } from "react";
import { Check, ShieldAlert, ShoppingCart } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PageHeader, Button, Card, Field, Input, ResponsiveList, StatusPill, useToast,
  type Column,
} from "@/shared/components";
import {
  approveMaterialRequest, getMaterialRequest, rejectMaterialRequest,
  resubmitMaterialRequestCorrection, reviseMaterialRequest, sendBackMaterialRequest,
  sendMaterialRequestFurtherBack,
} from "../api";
import { MRCorrectionForm } from "../components/MRCorrectionForm";
import { MRClaimsPanel } from "../components/MRClaimsPanel";
import { ErrorNote, LoadingRows } from "../components/PageStates";
// Reaching across into procurement for one call, the same direction the chain already
// runs on the backend: inventory raises the request, procurement picks it up.
import { requisitionApi } from "@/modules/procurement/api";
// The approval trail and the component that draws it, from the module that owns
// approvals. One timeline, drawn the same way on every document that has a ladder.
import { approvalsApi } from "@/modules/approvals/api";
import { HistoryTimeline } from "@/modules/approvals/components/HistoryTimeline";
import { alerts } from "@/modules/alerts";
import { useAuth } from "@/shared/auth/AuthContext";
import type { MaterialRequestItem } from "../types";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

/**
 * One material request: the shortfall an allocation could not cover, and the buttons
 * procurement uses to accept or refuse it.
 *
 * The quantity is editable while the request is awaiting approval. What the allocation
 * was short of is a starting figure, not a purchase decision — procurement buys a whole
 * case rather than the exact 7, or trims a line already on its way — and before this the
 * only way to change it was to reject the whole request and re-run the allocation.
 */
export function MaterialRequestDetailPage() {
  const { id } = useParams();
  const mrId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, me, isAdmin: isSystemAdmin } = useAuth();
  const isAdmin = isSystemAdmin || can("admin.workflow.manage") || Boolean(me?.roles?.includes("ADMIN")) || Boolean(me?.roles?.includes("SUPERUSER"));
  const toast = useToast();
  const [comments, setComments] = useState("");
  // Only the lines actually touched, keyed by line id. Absent means "unchanged" —
  // seeding this from the server would send every line back on every save and make an
  // untouched line indistinguishable from one edited to the same number.
  const [edits, setEdits] = useState<Record<number, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["material-request", mrId],
    queryFn: () => getMaterialRequest(mrId),
    enabled: Number.isFinite(mrId),
  });

  // Who signed what, in order. Unpermissioned (the endpoint scopes itself to the
  // raiser, the pending approver and past actors), so a reader who is none of those
  // simply gets an empty trail rather than an error.
  const history = useQuery({
    queryKey: ["approvals", "history", "MR", mrId],
    queryFn: () => approvalsApi.history("MR", mrId),
    enabled: Number.isFinite(mrId),
  });

  const act = useMutation({
    mutationFn: (approve: boolean) =>
      approve ? approveMaterialRequest(mrId, comments) : rejectMaterialRequest(mrId, comments),
    onSuccess: (_result, approve) => {
      const number = data?.mr_no ?? "The request";
      void alerts.success(
        approve ? "material_request.approved" : "material_request.rejected",
        { number },
      );
      qc.invalidateQueries({ queryKey: ["material-request", mrId] });
      qc.invalidateQueries({ queryKey: ["material-requests"] });
    },
  });

  const save = useMutation({
    // Only the lines whose number actually moved. Sending a box that was focused and
    // left alone would write an audit row saying 10 became 10.
    mutationFn: () =>
      reviseMaterialRequest(
        mrId,
        (data?.items ?? [])
          .filter((row) => {
            const raw = edits[row.id];
            return raw !== undefined && raw.trim() !== "" && Number(raw) !== row.quantity;
          })
          .map((row) => ({ id: row.id, quantity: Number(edits[row.id]) })),
        comments,
      ),
    onSuccess: () => {
      setEdits({});
      void alerts.success("material_request.revised", { number: data?.mr_no ?? "" });
      qc.invalidateQueries({ queryKey: ["material-request", mrId] });
      qc.invalidateQueries({ queryKey: ["material-requests"] });
    },
  });

  /** Hand the approved request to Purchase, lines and all.
   *
   *  The one join in the chain a buyer was making by hand: the endpoint existed, no
   *  screen called it, so an approved MR sat still and its lines were retyped into a
   *  blank requisition — the one place a quantity could change between two documents.
   *  Only what is still owed comes across, so a second pass carries the remainder. */
  const raiseRequisition = useMutation({
    mutationFn: () => requisitionApi.createFromMr(mrId),
    onSuccess: (requisition) => {
      void alerts.success("material_request.requisition_raised", {
        number: requisition.req_no,
      });
      qc.invalidateQueries({ queryKey: ["material-request", mrId] });
      nav(`/procurement/requisitions/${requisition.id}`);
    },
  });

  // Send back and Reject both need a reason: the person it lands with has to know why.
  const [reasonError, setReasonError] = useState("");
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["material-request", mrId] });
    qc.invalidateQueries({ queryKey: ["material-requests"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
  const sendBack = useMutation({
    mutationFn: () => sendBackMaterialRequest(mrId, comments.trim()),
    onSuccess: (updated) => {
      toast.success(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`);
      setComments("");
      invalidate();
    },
  });
  const sendBackWithReason = () => {
    if (sendBack.isPending) return;
    if (!comments.trim()) {
      setReasonError("Enter a reason in Comments before sending this request back.");
      return;
    }
    setReasonError("");
    sendBack.mutate();
  };
  // The holder of a sent-back request: a comment (optional to resubmit, required to
  // pass it further down).
  const [fixComment, setFixComment] = useState("");
  const [fixError, setFixError] = useState("");
  const resubmit = useMutation({
    mutationFn: () => resubmitMaterialRequestCorrection(mrId, fixComment.trim()),
    onSuccess: () => {
      toast.success("Resubmitted for approval");
      setFixComment("");
      invalidate();
    },
  });
  const sendFurtherBack = useMutation({
    mutationFn: () => sendMaterialRequestFurtherBack(mrId, fixComment.trim()),
    onSuccess: (updated) => {
      toast.success(`Sent back to ${updated.current_approver_name ?? "the previous approver"}`);
      setFixComment("");
      invalidate();
    },
  });
  const sendFurtherBackWithReason = () => {
    if (sendFurtherBack.isPending) return;
    if (!fixComment.trim()) {
      setFixError("Enter a reason before sending this request further back.");
      return;
    }
    setFixError("");
    sendFurtherBack.mutate();
  };

  const decide = async (approve: boolean) => {
    if (act.isPending || save.isPending || !data) return;
    if (!approve && !comments.trim()) {
      setReasonError("Enter a reason in Comments before rejecting this request.");
      return;
    }
    const first = data.items[0];
    // One line: name it. More: count them — quoting only the first line's quantity
    // described a five-line request by one of its lines.
    // The number ON SCREEN, not the stored one: the edit is saved as part of this
    // press, so quoting the old quantity would ask the approver to confirm a figure
    // that is about to be replaced.
    const lines = data.items.length === 1 && first
      ? `${shown(first)} ${first.uom_code ?? ""} of ${first.item_name ?? first.item_code}`.replace(/\s+/g, " ")
      : `${data.items.length} lines`;
    const asked = approve
      ? await alerts.confirm("material_request.approve", { number: data.mr_no, lines })
      : await alerts.confirm("material_request.reject", { number: data.mr_no });
    if (!asked) return;
    // Approving IS the save. A separate "Save quantities" press before it was a second
    // button for one decision — and the only thing standing between the two was a
    // warning saying the approval would sign the old number. The edit is written
    // first, so what gets signed is what is on screen; if the write is refused the
    // approval never runs and the error stands where it happened.
    if (approve && dirty) {
      try {
        await save.mutateAsync();
      } catch {
        return;
      }
    }
    act.mutate(approve);
  };

  if (isLoading) return <LoadingRows rows={6} className="mt-2" />;
  if (error) return <div className="p-6"><ErrorNote message={(error as Error).message} /></div>;
  if (!data) return null;

  const open = data.status === "PENDING_APPROVAL";
  const mine = open && (data.can_act === true || isAdmin);

  /** What the box should show: the pending edit if there is one, else the saved value. */
  const shown = (row: MaterialRequestItem) =>
    edits[row.id] ?? String(row.quantity);

  /** A quantity that cannot be saved. Zero is not "no change" — it is a request for
   *  nothing, which is a rejection and has its own button. Already-ordered units are a
   *  fact, so a line cannot be cut below them; the backend enforces both.
   *
   *  There is deliberately no ceiling. An MR is a request to BUY, not a claim on the
   *  shelf: procurement routinely orders a full case above the shortfall, or trims a
   *  line already part-covered. The allocation screen caps at what is free because
   *  giving away stock you do not have is a different mistake. */
  const problem = (row: MaterialRequestItem): string | null => {
    const raw = edits[row.id];
    if (raw === undefined) return null;
    const value = Number(raw);
    if (raw.trim() === "" || Number.isNaN(value)) return "Enter a number";
    if (value <= 0) return "Must be more than zero — reject instead";
    if (value < row.ordered_quantity) return `${row.ordered_quantity} already ordered`;
    return null;
  };

  /** Typed a different number, not merely touched the box. Retyping 10 over 10 left the
   *  "unsaved changes" warning on screen and Approve disabled with nothing to save. */
  const isChanged = (row: MaterialRequestItem) => {
    const raw = edits[row.id];
    return raw !== undefined && raw.trim() !== "" && Number(raw) !== row.quantity;
  };

  const items = data.items ?? [];
  const problems = items.map(problem).filter(Boolean);
  const dirty = items.some(isChanged);

  const quantityCell = (row: MaterialRequestItem) => {
    if (!open) {
      return (
        <span className="tabular font-semibold text-ink">
          {row.quantity} {row.uom_code ?? ""}
        </span>
      );
    }
    const issue = problem(row);
    return (
      <div className="min-w-[11rem]">
        <div className="flex items-center gap-1.5">
          {/* Deliberately not type="number". The spinner arrows eat the right-hand end
              of a narrow box, which hid the digits being typed, and the scroll-wheel
              changes a quantity nobody meant to touch. `inputMode` still brings up the
              numeric keypad on a phone. */}
          <Input
            inputMode="decimal"
            aria-label={`Quantity for ${row.item_name ?? row.item_code ?? "line"}`}
            value={shown(row)}
            onChange={(e) =>
              setEdits((current) => ({ ...current, [row.id]: e.target.value }))}
            className="w-28"
          />
          <span className="text-xs text-muted">{row.uom_code ?? ""}</span>
        </div>
        {issue && <p className="mt-1 text-xs text-danger">{issue}</p>}
        {!issue && isChanged(row) && (
          <p className="mt-1 text-xs text-muted">was {row.quantity}</p>
        )}
      </div>
    );
  };

  const columns: Column<MaterialRequestItem>[] = [
    { key: "line", header: "#", render: (r) => <span className="tabular text-muted">{r.line_no}</span> },
    { key: "code", header: "Code", render: (r) => <span className="mono text-muted">{r.item_code}</span> },
    {
      key: "name",
      header: "Item",
      render: (r) => (
        <div>
          <div>{r.item_name ?? "—"}</div>
          <MRClaimsPanel mrId={mrId} itemId={r.item_id} uom={r.uom_code} />
        </div>
      ),
    },
    {
      key: "qty",
      header: "Needed",
      render: (r) => (
        <span className="tabular font-semibold text-ink">
          {r.quantity} {r.uom_code ?? ""}
        </span>
      ),
    },
    {
      key: "ordered",
      header: "Ordered",
      render: (r) => <span className="tabular text-muted">{r.ordered_quantity}</span>,
      hideOnNarrow: true,
    },
  ];

  return (
    <>
      <PageHeader
        back={{ to: "/inventory/material-requests", label: "Back to Material requests" }}
        eyebrow="Material request"
        title={data.mr_no}
        // The rung, not the person: "Pending at Regional Manager" is what tells a
        // reader where the request is, and the name behind that post changes with a
        // transfer. Falls back to the plain status when nothing is resolved.
        actions={data.status === "PENDING_APPROVAL" && data.current_stage_name
          ? <StatusPill status={`Pending at ${data.current_stage_name}`} />
          : <StatusPill status={data.status} />}
      />

      <Card className="mb-4 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Raised for</dt>
            <dd className="mono font-semibold text-ink">
              <button className="underline" onClick={() => nav(`/indents/${data.indent_id}`)}>
                {data.indent_no ?? "—"}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Department</dt>
            <dd className="text-ink">{data.department_name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">With</dt>
            <dd className="text-ink">{data.current_approver_name ?? "—"}</dd>
          </div>
        </dl>
        {data.remarks && <p className="mt-3 text-sm text-muted">{data.remarks}</p>}
      </Card>

      {/* The handoff into Procurement. Shown only once the request is approved: before
        * that there is nothing to buy, and after it this is the only thing left to do
        * on this screen. The backend refuses a second one, so a request that already
        * crossed says so rather than raising a duplicate demand. */}
      {data.status === "APPROVED" && !data.has_requisition && (
        // A one-line handoff strip, not a hero panel: the decision on this screen is
        // already made, and the next step is somebody else's document. Left-aligned
        // beside the rest of the page — a centred block in the middle of a left-aligned
        // form read as an empty state rather than as an action.
        <Card className="mb-4 border border-ok/30 bg-ok-bg/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok-bg text-ok">
                <ShoppingCart size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Ready for purchase</p>
                <p className="text-xs text-muted">
                  Carries what is still owed on {data.mr_no} onto a requisition.
                </p>
              </div>
            </div>
            {/* Permission-gated exactly as before, but read with `can` rather than
              * <Can>: without `requisition.create` the strip still says where the
              * request has got to, and a hidden button left an approved MR looking
              * unfinished to everyone who cannot buy. */}
            {can("requisition.create") ? (
              <Button
                onClick={() => raiseRequisition.mutate()}
                disabled={raiseRequisition.isPending}
              >
                {raiseRequisition.isPending ? "Raising…" : "Raise requisition"}
              </Button>
            ) : (
              <span className="text-xs text-muted">Procurement raises the requisition.</span>
            )}
          </div>
          {raiseRequisition.error && (
            <p className="mt-2 text-sm text-danger">
              {(raiseRequisition.error as Error).message}
            </p>
          )}
        </Card>
      )}

      {/* Two renderings on purpose, not a table with an input in it.
        *
        * HeroUI's Table (behind ResponsiveList) is a react-aria COLLECTION: it rebuilds
        * its cell nodes on every render, so a text box living in a cell is remounted on
        * each keystroke and loses focus — you type a digit, the caret leaves, and the
        * field appears not to accept anything. Read-only lines stay in the table, where
        * it is the right component; the editable form is plain rows, exactly as the
        * allocation screen builds its "Give" boxes. */}
      {open ? (
        <Card className="divide-y divide-line p-0">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Lines</h2>
            <p className="text-xs text-muted">Edit a quantity to buy more or less</p>
          </div>
          {items.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No lines on this request.
            </p>
          )}
          {items.map((row) => (
            <div key={row.id} className="flex flex-wrap items-start gap-4 px-4 py-3">
              <span className="tabular pt-3 text-sm text-muted">{row.line_no}</span>
              <div className="min-w-[14rem] flex-1">
                <span className="mono text-xs text-muted">{row.item_code}</span>
                <p className="font-semibold text-ink">{row.item_name ?? "—"}</p>
                <MRClaimsPanel mrId={mrId} itemId={row.item_id} uom={row.uom_code} />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Needed
                </span>
                {quantityCell(row)}
              </div>
              <div className="pt-5 text-sm text-muted">
                <span className="tabular">{row.ordered_quantity}</span> ordered
              </div>
            </div>
          ))}
        </Card>
      ) : (
        <ResponsiveList
          data={items}
          keyOf={(r) => r.id}
          columns={columns}
          empty="No lines on this request."
          renderCard={(r) => (
            <div className="space-y-1">
              <span className="mono text-xs text-muted">{r.item_code}</span>
              <p className="font-semibold text-ink">{r.item_name}</p>
              <p className="tabular text-sm text-muted">
                {r.quantity} {r.uom_code ?? ""}
              </p>
              <MRClaimsPanel mrId={mrId} itemId={r.item_id} uom={r.uom_code} />
            </div>
          )}
        />
      )}

      {(history.data ?? []).length > 0 && (
        <Card className="mt-4 p-0">
          <h2 className="px-4 pt-4 text-sm font-semibold text-ink sm:px-5">
            Approval history
          </h2>
          <HistoryTimeline rows={history.data!} />
        </Card>
      )}

      {open && !mine && (
        <p className="mt-4 text-sm text-muted">
          Waiting on {data.current_stage_name ?? "the next approver"}
          {data.current_approver_name ? ` · ${data.current_approver_name}` : ""}. There
          is nothing for you to do here under the position you are working as.
        </p>
      )}

      {open && !data.can_act && isAdmin && (
        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-amber-900 dark:text-amber-200">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div className="text-sm">
            <span className="font-bold">Admin Override Active: </span>
            Currently waiting on {data.current_stage_name ?? "assigned approver"} {data.current_approver_name ? `(${data.current_approver_name})` : ""}, but as Administrator you have full authority to review, adjust quantities, approve, or reject.
          </div>
        </div>
      )}

      {data.status === "RETURNED_FOR_CORRECTION" && (
        <Card className="mt-4 border border-warn/40 bg-warn-bg/40 p-4 text-sm">
          <p className="font-semibold text-ink">
            Sent back to {data.correction?.owner_name ?? data.current_approver_name ?? "the previous approver"}
            {data.correction?.returned_by_name ? ` by ${data.correction.returned_by_name}` : ""}
          </p>
          {data.correction?.reason && (
            <p className="mt-2 text-ink">Reason: {data.correction.reason}</p>
          )}
          {data.can_resubmit_correction && (
            <>
              <p className="mt-2 text-ink">
                {data.can_edit_correction
                  ? "Edit the request below, Save changes, then resubmit."
                  : data.can_pass_correction_down
                    ? "You can resubmit it as it is, or send it further back to the person below you."
                    : "Add a comment if needed and resubmit."}
              </p>
              <div className="mt-3">
                <Field label={data.can_pass_correction_down ? "Comment (required to send further back)" : "Comment (optional)"}>
                  <Input
                    value={fixComment}
                    onChange={(e) => { setFixComment(e.target.value); setFixError(""); }}
                    placeholder="Visible to the approver"
                  />
                </Field>
              </div>
              {fixError && <p className="mt-2 text-danger">{fixError}</p>}
              {resubmit.error && <p className="mt-2 text-danger">{(resubmit.error as Error).message}</p>}
              {sendFurtherBack.error && <p className="mt-2 text-danger">{(sendFurtherBack.error as Error).message}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {data.can_pass_correction_down && (
                  <Button variant="subtle" onClick={sendFurtherBackWithReason}
                    disabled={sendFurtherBack.isPending || resubmit.isPending}>
                    {sendFurtherBack.isPending ? "Sending…" : "Send further back"}
                  </Button>
                )}
                <Button onClick={() => resubmit.mutate()} disabled={resubmit.isPending || sendFurtherBack.isPending}>
                  {resubmit.isPending ? "Resubmitting…" : "Resubmit for approval"}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {data.status === "RETURNED_FOR_CORRECTION" && data.can_edit_correction && (
        <MRCorrectionForm
          key={`${data.id}-${(data.items ?? []).map((i) => `${i.id}:${i.quantity}`).join(",")}`}
          mr={data}
          onSaved={invalidate}
        />
      )}

      {mine && (
        <div className="mt-4 space-y-3">
          <Field label="Comments">
            <Input
              value={comments}
              onChange={(e) => { setComments(e.target.value); setReasonError(""); }}
              placeholder="Required for Send back and Reject, optional for Approve"
            />
          </Field>
          {reasonError && <p className="text-danger">{reasonError}</p>}
          {act.error && <p className="text-danger">{(act.error as Error).message}</p>}
          {save.error && <p className="text-danger">{(save.error as Error).message}</p>}
          {sendBack.error && <p className="text-danger">{(sendBack.error as Error).message}</p>}
          <div className="flex flex-wrap gap-2">
            {(can("mr.approve") || isAdmin) && (
              <Button variant="subtle" onClick={sendBackWithReason}
                disabled={act.isPending || sendBack.isPending}>
                Send back
              </Button>
            )}
            {(can("mr.approve") || isAdmin) && (
              <Button className={TONE_APPROVE}
                onClick={() => void decide(true)}
                disabled={act.isPending || save.isPending || problems.length > 0}
              >
                <Check className="h-4 w-4" />
                {save.isPending ? "Saving…" : (!data.can_act && isAdmin ? "Approve (Admin Override)" : "Approve")}
              </Button>
            )}
            {(can("mr.reject") || isAdmin) && (
              <Button className={TONE_REJECT} variant="subtle" onClick={() => void decide(false)} disabled={act.isPending}>
                Reject
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
