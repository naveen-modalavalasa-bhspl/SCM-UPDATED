import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, ScanLine, SkipForward } from "lucide-react";
import { Button, Can, Card, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { ConfirmModal, ErrorBanner } from "../components/Feedback";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { Lookup } from "../components/Lookup";
import { binOptions, confirmPutaway, getPutaway, skipPutaway, startPutaway, suggestBins } from "../api";
import { fmtDateTime, fmtQty, humanise, normaliseStatus } from "../format";

/**
 * One putaway task: take this quantity to this bin and confirm it.
 *
 * Confirming is the moment stock moves from "received" to "in a bin", so the bin and
 * the quantity are both re-entered here rather than carried over silently — the
 * whole point of the step is that a person physically checked.
 *
 * The scan box accepts a bin barcode and resolves it against the suggestion list, so
 * the common path is scan-and-confirm with no dropdown at all.
 */
export default function PutawayForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const taskId = Number(id);

  const [binId, setBinId] = useState<number | "">("");
  const [qty, setQty] = useState<number>(0);
  const [remarks, setRemarks] = useState("");
  const [serials, setSerials] = useState<string[]>([]);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const { data: task, isLoading, error } = useQuery({
    queryKey: ["wh-putaway", id],
    queryFn: () => getPutaway(taskId),
  });

  const { data: suggested = [] } = useQuery({
    queryKey: ["wh-putaway-bins", id],
    queryFn: () => suggestBins(taskId),
    enabled: !!task && task.status !== "completed",
  });

  useEffect(() => {
    if (!task) return;
    setQty(Number(task.qty ?? 0));
    setBinId(task.actual_bin_id ?? task.suggested_bin_id ?? "");
    setSerials(task.serial_numbers ?? []);
  }, [task]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wh-putaway", id] });
    qc.invalidateQueries({ queryKey: ["wh-putaways"] });
  };

  const start = useMutation({ mutationFn: () => startPutaway(taskId), onSuccess: invalidate });

  const confirm = useMutation({
    mutationFn: () =>
      confirmPutaway(taskId, {
        actual_bin_id: Number(binId),
        qty,
        remarks: remarks || null,
        serial_numbers: serials,
      }),
    onSuccess: () => {
      invalidate();
      setConfirming(false);
      nav("..");
    },
  });

  const skip = useMutation({
    mutationFn: () => skipPutaway(taskId, remarks || undefined),
    onSuccess: () => {
      invalidate();
      setSkipping(false);
      nav("..");
    },
  });

  /** Resolves a scanned bin code against the suggestions, then the full bin list. */
  const resolveScan = async (code: string) => {
    const value = code.trim().toUpperCase();
    if (!value) return;
    const hit = suggested.find((b) => b.code.toUpperCase() === value);
    if (hit) {
      setBinId(hit.id);
      setScan("");
      setScanError(null);
      return;
    }
    try {
      const rows = await binOptions(task!.warehouse_id, value);
      const match = rows.find((b) => (b.code ?? "").toUpperCase() === value);
      if (!match) {
        setScanError(`No bin ${value} in this warehouse.`);
        return;
      }
      setBinId(match.id);
      setScan("");
      setScanError(null);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Could not look that bin up.");
    }
  };

  if (isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;
  if (!task) return <div className="py-16 text-center text-muted">Task not found.</div>;

  const done = task.status === "completed";
  const overriding = !!task.suggested_bin_id && binId !== "" && Number(binId) !== task.suggested_bin_id;

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title={`Putaway ${task.putaway_no}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("..")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!done && task.status === "pending" && (
              <Can do="stock.transfer">
                <Button variant="subtle" onClick={() => start.mutate()} disabled={start.isPending}>
                  Start
                </Button>
              </Can>
            )}
            {!done && (
              <Can do="stock.transfer">
                <Button variant="subtle" onClick={() => setSkipping(true)}>
                  <SkipForward className="h-4 w-4" /> Skip
                </Button>
              </Can>
            )}
            {!done && (
              <Can do="stock.transfer">
                <Button onClick={() => setConfirming(true)} disabled={binId === "" || qty <= 0}>
                  Confirm putaway
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={error ?? start.error} />

      <MetaCard title="Task">
        <MetaRow label="Number" value={<span className="font-mono">{task.putaway_no}</span>} />
        <MetaRow label="Status" value={<StatusPill status={normaliseStatus(task.status)} />} />
        <MetaRow label="From GRN" value={<span className="font-mono">{task.grn_no ?? "—"}</span>} />
        <MetaRow label="Warehouse" value={task.warehouse_name} />
        <MetaRow label="Item" value={`${task.item_code ?? ""} ${task.item_name ?? ""}`.trim() || "—"} />
        <MetaRow label="Batch" value={task.batch_no} />
        <MetaRow label="Quantity" value={<span className="tabular">{fmtQty(task.qty)} {task.uom_code ?? ""}</span>} />
        <MetaRow label="Directed" value={humanise(task.putaway_type)} />
        <MetaRow label="Assigned to" value={task.assigned_to_name} />
        <MetaRow label="Started" value={fmtDateTime(task.started_at)} />
        <MetaRow label="Completed" value={fmtDateTime(task.completed_at)} />
        <MetaRow label="Scanned by" value={task.scanned_by ? fmtDateTime(task.scanned_at) : "—"} />
      </MetaCard>

      {done ? (
        <Card className="px-6 py-10 text-center">
          <div className="mb-1 font-display text-lg font-bold text-ok">Put away</div>
          <p className="text-sm text-muted">
            {fmtQty(task.qty)} {task.uom_code ?? ""} placed in{" "}
            <span className="font-mono font-semibold text-ink">{task.actual_bin_code ?? "—"}</span> on{" "}
            {fmtDateTime(task.completed_at)}.
          </p>
        </Card>
      ) : (
        <Section title="Place it" hint="Scan the bin label, or pick the bin from the list.">
          <ErrorBanner error={scanError} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Field label="Scan bin">
              <label className="relative block">
                <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  value={scan}
                  onChange={(e) => setScan(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void resolveScan(scan);
                    }
                  }}
                  placeholder="Scan a bin barcode"
                  aria-label="Scan bin barcode"
                  className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
                />
              </label>
            </Field>

            <Field label="Bin">
              <Lookup
                name={`bins-${task.warehouse_id}`}
                load={(s) => binOptions(task.warehouse_id, s)}
                value={binId}
                onChange={setBinId}
                placeholder="Pick a bin"
                fallback={suggested.map((b) => ({ id: b.id, code: b.code, name: b.name ?? b.path ?? "" }))}
              />
            </Field>

            <Field label="Quantity" hint="Less than the task quantity leaves the rest outstanding.">
              <Input
                type="number"
                value={String(qty)}
                onChange={(e) => setQty(Number(e.target.value))}
              />
            </Field>
          </div>

          {overriding && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
              This is not the suggested bin ({task.suggested_bin_code ?? "—"}). The override is recorded.
            </div>
          )}

          {suggested.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Suggested bins, best first
              </div>
              <div className="flex flex-wrap gap-2">
                {suggested.map((b) => (
                  <button key={b.id} type="button" onClick={() => setBinId(b.id)}>
                    <Chip
                      size="sm"
                      variant={Number(binId) === b.id ? "solid" : "flat"}
                      color={Number(binId) === b.id ? "primary" : "default"}
                    >
                      {b.code}
                      {b.capacity_qty ? ` · cap ${fmtQty(b.capacity_qty)}` : ""}
                    </Chip>
                  </button>
                ))}
              </div>
            </div>
          )}

          {serials.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Verify accepted serials ({serials.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {serials.map((serial) => (
                  <Chip key={serial} size="sm" variant="flat">
                    <span className="font-mono">{serial}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <Field label="Remarks">
              <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>
          </div>
        </Section>
      )}

      <ConfirmModal
        isOpen={confirming}
        title="Confirm putaway?"
        message={`${fmtQty(qty)} ${task.uom_code ?? ""} of ${task.item_name ?? task.item_code} moves into the chosen bin. This writes a stock movement and cannot be undone — a mistake is corrected with a transfer, not a delete.`}
        confirmLabel="Confirm putaway"
        danger
        busy={confirm.isPending}
        error={confirm.error}
        onConfirm={() => confirm.mutate()}
        onClose={() => setConfirming(false)}
      />

      <ConfirmModal
        isOpen={skipping}
        title="Skip this task?"
        message="The stock stays where it is and the task is marked skipped. Say why."
        confirmLabel="Skip task"
        busy={skip.isPending}
        error={skip.error}
        onConfirm={() => skip.mutate()}
        onClose={() => setSkipping(false)}
      >
        <div className="mt-3">
          <Field label="Reason">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Bin full, item damaged…" />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}
