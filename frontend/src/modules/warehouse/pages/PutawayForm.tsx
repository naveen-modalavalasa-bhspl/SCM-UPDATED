import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, ScanLine } from "lucide-react";
import { Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LocationPicker } from "../components/LocationPicker";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { binOptions, confirmPutaway, getPutaway, startPutaway, suggestBins } from "../api";
import { fmtDate, fmtDateTime, fmtQty, humanise, normaliseStatus } from "../format";
import { alerts } from "@/modules/alerts";

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
  const [enteringSerials, setEnteringSerials] = useState(false);

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
      void alerts.success("putaway.completed", {
        item: task?.item_name ?? task?.item_code ?? "The item",
        bin: task?.actual_bin_code ?? task?.suggested_bin_code ?? "the chosen bin",
      });
      invalidate();
      setConfirming(false);
      nav("/warehouse/putaway", { replace: true });
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
            <Button variant="ghost" onClick={() => nav("/warehouse/putaway")}>
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
                <Button
                  onClick={() => setConfirming(true)}
                  // One serial per unit placed, or the bin holds stock nobody can trace.
                  disabled={
                    binId === "" || qty <= 0 ||
                    (!!task.is_serial_tracked && serials.length !== Math.floor(qty))
                  }
                >
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
        <MetaRow label={task.is_asset ? "Warranty" : "Expiry"} value={fmtDate(task.expiry_date)} />
        <MetaRow label="Quantity" value={<span className="tabular">{fmtQty(task.qty)} {task.uom_code ?? ""}</span>} />
        <MetaRow label="Directed" value={humanise(task.putaway_type)} />
        <MetaRow label="Assigned to" value={task.assigned_to_name} />
        <MetaRow label="Started" value={fmtDateTime(task.started_at)} />
        <MetaRow label="Completed" value={fmtDateTime(task.completed_at)} />
        <MetaRow label="Scanned by" value={task.scanned_by ? fmtDateTime(task.scanned_at) : "—"} />
        <MetaRow label="Location" value={task.actual_bin_path ?? "—"} />
        <MetaRow label="Lot" value={<span className="font-mono">{task.lot_no ?? "—"}</span>} />
      </MetaCard>

      {done ? (
        <Card className="px-6 py-10 text-center">
          <div className="mb-1 font-display text-lg font-bold text-ok">Put away</div>
          <p className="text-sm text-muted">
            {fmtQty(task.qty)} {task.uom_code ?? ""} placed in{" "}
            <span className="font-mono font-semibold text-ink">
              {task.actual_bin_path ?? task.actual_bin_code ?? "—"}
            </span>{" "}
            on {fmtDateTime(task.completed_at)}.
          </p>
          {task.lot_no && (
            <p className="mt-2 text-sm text-muted">
              Lot <span className="font-mono font-semibold text-ink">{task.lot_no}</span>
            </p>
          )}
          {task.expiry_date && (
            <p className="mt-2 text-sm text-muted">
              {task.is_asset ? "Warranty" : "Expiry"}{" "}
              <span className="font-semibold text-ink">{fmtDate(task.expiry_date)}</span>
            </p>
          )}
        </Card>
      ) : (
        <Section
          title="Place it"
          hint="Scan the bin label, or walk the warehouse down to the bin."
        >
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

            <Field label="Quantity" hint="Less than the task quantity leaves the rest outstanding.">
              <Input
                type="number"
                value={String(qty)}
                onChange={(e) => setQty(Number(e.target.value))}
              />
            </Field>
          </div>

          {/* The whole hierarchy this warehouse was configured with, one dropdown per
            * level. A scan or a suggested-bin chip drives it too, so there is one
            * answer to "where is this going" however it was chosen. */}
          <div className="mt-4">
            <LocationPicker
              warehouseId={task.warehouse_id}
              value={binId}
              onChange={setBinId}
            />
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

          {/* Putaway is where every unit is named. The GRN and the inspection may each
            * have captured serials or none — this step cannot, because a unit going into
            * a bin unidentified is a unit nobody can find again. Whatever came down from
            * upstream is prefilled; the rest is read off the units here. */}
          {task.is_serial_tracked && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Serial numbers
                </span>
                <span className={`text-xs font-semibold ${
                  serials.length === Math.floor(qty) ? "text-ok" : "text-warn"
                }`}>
                  {serials.length} of {Math.floor(qty)} captured
                </span>
              </div>
              <div className="mb-2 flex flex-wrap gap-2">
                {serials.map((serial) => (
                  <Chip key={serial} size="sm" variant="flat">
                    <span className="font-mono">{serial}</span>
                  </Chip>
                ))}
                {serials.length === 0 && (
                  <span className="text-sm text-muted">None captured yet.</span>
                )}
              </div>
              <Button variant="subtle" onClick={() => setEnteringSerials(true)}>
                <ScanLine className="h-4 w-4" />
                {serials.length ? "Edit serials" : "Enter serials"}
              </Button>
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

      <SerialNumbersModal
        isOpen={enteringSerials}
        onClose={() => setEnteringSerials(false)}
        quantity={qty}
        initial={serials}
        itemLabel={task.item_name ?? task.item_code ?? ""}
        onSave={setSerials}
      />
    </div>
  );
}
