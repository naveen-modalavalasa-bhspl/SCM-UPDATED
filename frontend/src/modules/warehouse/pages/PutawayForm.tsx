import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, ScanLine } from "lucide-react";
import { Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { PackSelector } from "../components/PackSelector";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LocationPicker } from "../components/LocationPicker";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { UnitCodeLabels } from "../components/UnitCodeLabels";
import { binOptions, confirmPutaway, getPutaway, locationOccupancy, startPutaway, suggestBins } from "../api";
import { CapacityBadge, CapacityMeter, fmtCount, volume, weight } from "../components/CapacityMeter";
import { fmtDate, fmtDateTime, fmtQty, humanise, normaliseStatus } from "../format";
import { alerts } from "@/modules/alerts";
import { usePointLabel } from "../usePointLabel";
import type { Bin } from "../types";

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
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const taskId = Number(id);

  const [binId, setBinId] = useState<number | "">("");
  const [qty, setQty] = useState<number>(0);
  // WHICH pack is being put away. A bin is checked against handling units, so "3 cases"
  // and "1500 eaches" are different questions about the same quantity — and only the
  // person holding the goods knows which one landed on the dock.
  const [packId, setPackId] = useState<number | null>(null);
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

  // Keyed on the pack as well as the task: the suggestions are ranked on whether THIS
  // pack goes into each bin, so picking a different rung is a different question and
  // has to produce a different answer.
  const { data: suggested = [] } = useQuery({
    queryKey: ["wh-putaway-bins", id, packId],
    queryFn: () => suggestBins(taskId, packId),
    enabled: !!task && task.status !== "completed",
    placeholderData: (previous) => previous,
  });

  /**
   * What this putaway does to the chosen location. Keyed on the bin AND the quantity
   * because both change the answer — a short putaway into a tight bin fits where the
   * full one does not, and the storekeeper is entitled to see that before they press.
   *
   * `placeholderData` keeps the previous panel on screen while the next one loads, so
   * typing in the quantity box does not make the meter flicker in and out.
   */
  const { data: room, isFetching: roomLoading } = useQuery({
    queryKey: ["wh-location-occupancy", binId, qty, packId, task?.item_id],
    queryFn: () =>
      locationOccupancy(Number(binId), {
        item_id: task!.item_id,
        qty: qty > 0 ? qty : undefined,
        direction: "IN",
        item_packaging_id: packId,
      }),
    enabled: !!task && binId !== "" && task.status !== "completed",
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!task) return;
    setQty(Number(task.qty ?? 0));
    setBinId(task.actual_bin_id ?? task.suggested_bin_id ?? "");
    setSerials(task.serial_numbers ?? []);
    // Whatever the task was raised with, else the item's default putaway unit — both
    // already resolved by the server, so the screen never picks a rung of its own.
    setPackId(task.item_packaging_id ?? null);
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
        item_packaging_id: packId,
        remarks: remarks || null,
        serial_numbers: serials,
      }),
    onSuccess: (placed) => {
      // The stock is in the bin either way — capacity never blocks a putaway. What
      // changes is which of the two things we tell them, and the overflow one stays on
      // screen until it is dismissed. Both codes come from the alert catalog.
      const verdict = placed?.capacity?.status;
      const bin = placed?.actual_bin_code ?? task?.actual_bin_code
        ?? task?.suggested_bin_code ?? "the chosen bin";
      const item = task?.item_name ?? task?.item_code ?? "The item";
      // `reason` is the sentence the server wrote for the gate that actually failed —
      // cube, payload, unit limit or doorway. Composing one here would mean writing
      // those four sentences a second time and letting them drift from the meter's.
      const reason = placed?.capacity?.detail ?? "";
      if (verdict === "WONT_FIT") {
        void alerts.warning("putaway.wont_fit", { item, bin, reason });
      } else if (verdict === "OVER") {
        void alerts.warning("putaway.over_capacity", { item, bin, reason });
      } else {
        void alerts.success("putaway.completed", { item, bin });
      }
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

  // Case-insensitive: the backend answers COMPLETED on some paths and completed on
  // others, and a strict match left "Confirm putaway" on screen after the task was
  // already done — a second press against a finished task.
  const done = task.status?.toLowerCase() === "completed";
  const overriding = !!task.suggested_bin_id && binId !== "" && Number(binId) !== task.suggested_bin_id;

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={`Putaway ${task.putaway_no}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/putaway")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!done && task.status === "pending" && (
              <Can do="stock.transfer">
                <Button variant="soft" onClick={() => start.mutate()} disabled={start.isPending}>
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
        <MetaRow
          label="Received as"
          value={
            task.package_name
              ? <span className="tabular">
                  {fmtCount(task.handling_units)} × {task.package_name}
                  {task.pack_base_qty ? ` (${fmtCount(task.pack_base_qty)} ${task.uom_code ?? "units"} each)` : ""}
                </span>
              : "No pack configured"
          }
        />
        <MetaRow
          label="Space needed"
          value={
            task.line_volume_cbm == null
              ? "Not measured"
              : <span className="tabular">
                  {volume(task.line_volume_cbm)}
                  {task.line_weight_kg != null ? ` · ${weight(task.line_weight_kg)}` : ""}
                </span>
          }
        />
        <MetaRow label="Directed" value={humanise(task.putaway_type)} />
        <MetaRow label="Assigned to" value={task.assigned_to_name} />
        <MetaRow label="Started" value={fmtDateTime(task.started_at)} />
        <MetaRow label="Completed" value={fmtDateTime(task.completed_at)} />
        <MetaRow label="Scanned by" value={task.scanned_by ? fmtDateTime(task.scanned_at) : "—"} />
        <MetaRow label="Location" value={task.actual_bin_path ?? "—"} />
        <MetaRow label="Lot" value={<span className="font-mono">{task.lot_no ?? "—"}</span>} />
      </MetaCard>

      {done ? (
        <>
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

        {/* The codes this putaway minted, ready to go onto the goods.
          *
          * Only once it is COMPLETED, because that is when they exist: a unit becomes
          * an asset by being physically somewhere, so the code is generated at confirm
          * and there is nothing to print before the press. Fetched by the panel itself
          * rather than carried on the task — a line of 500 units is 500 codes, and the
          * queue screen that also loads a task has no use for them. */}
        <UnitCodeLabels taskId={taskId} />
        </>
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

          {/* WHICH pack. Chosen before the bin, because it changes what "does this fit"
            * even means: the same 1500 eaches are three pallets or thirty cartons, and
            * a bay that takes one takes neither of the others. */}
          <div className="mt-4">
            <PackSelector
              packs={task.packs ?? []}
              value={packId}
              onChange={setPackId}
              qty={qty}
              uom={task.uom_code}
              itemLabel={task.item_name ?? task.item_code ?? "This item"}
            />
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

          {/* What this does to the shelf. Advice, never a gate: the goods are on the
            * floor whether or not the master data says they fit, so a full location is
            * announced loudly and the Confirm button stays live. */}
          {binId !== "" && (
            <CapacityMeter
              className="mt-4"
              data={room}
              loading={roomLoading && !room}
            />
          )}

          {/* An item with no measured pack cannot have a share of anything, and the meter
            * says so — but it says it about the location. This says it about the item,
            * beside the item, which is where the fix is. */}
          {task.line_volume_cbm == null && (
            <div className="mt-3 rounded-lg border border-line bg-content2 px-3 py-2 text-xs text-muted">
              {(task.packs ?? []).length === 0
                ? <>
                    {task.item_name ?? task.item_code} has no packaging ladder, so there is
                    no handling unit to measure. Add one under Masters &gt; Items on the
                    item&rsquo;s Packaging tab — a level, a container type and how many
                    fit in it.
                  </>
                : <>
                    None of {task.item_name ?? task.item_code}&rsquo;s packaging levels
                    carry a length, width and height, so the space this takes cannot be
                    worked out. Measure the container type under Masters &gt; Packages, or
                    override the sides on the rung itself.
                  </>}
            </div>
          )}

          {overriding && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
              This is not the suggested bin ({task.suggested_bin_code ?? "—"}). The override is recorded.
            </div>
          )}

          {suggested.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Suggested bins, best first
                </span>
                <span className="text-[11px] text-muted">
                  Ranked on whether {room?.pack_name ?? task.package_name ?? "this pack"}{" "}
                  goes in — not on free space.
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {suggested.map((b) => (
                  <SuggestionChip
                    key={b.id}
                    bin={b}
                    selected={Number(binId) === b.id}
                    onPick={() => setBinId(b.id)}
                  />
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
              <Button variant="soft" onClick={() => setEnteringSerials(true)}>
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
        title={
          room?.status === "WONT_FIT"
            ? "Confirm putaway into a location it does not fit?"
            : room?.status === "OVER"
              ? "Confirm putaway over capacity?"
              : "Confirm putaway?"
        }
        message={[
          `${fmtQty(qty)} ${task.uom_code ?? ""} of ${task.item_name ?? task.item_code}` +
            (room?.move_units != null
              ? ` — ${fmtCount(room.move_units)} × ${room.pack_name ?? "handling unit"} —`
              : "") +
            " moves into the chosen bin.",
          // Said again here on purpose: this is the last screen before the press, and
          // the meter is behind the modal by then. The server's own sentence for the
          // gate that failed, so the modal and the meter cannot disagree. It warns, it
          // does not refuse.
          room && (room.status === "OVER" || room.status === "WONT_FIT"
                   || room.status === "FULL")
            ? room.detail
            : "",
          "This writes a stock movement and cannot be undone — a mistake is corrected with a transfer, not a delete.",
        ].filter(Boolean).join(" ")}
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

/**
 * One suggested bin, as a card rather than a chip.
 *
 * The old chip said the bin's code and how much cube it had left, which is the one
 * thing that does not decide the question: a bay can be nine-tenths empty and still be
 * the wrong answer because the pallet does not enter it, or because its single pallet
 * slot is taken. So the headline here is `fit_status` — the server's verdict about
 * THIS pack in THIS bin, the same four gates the meter below applies — and the free
 * space is the supporting detail it always should have been.
 *
 * Ordering is the server's (`suggestion_fit` / `SUGGESTION_RANK`); this only draws it.
 */
function SuggestionChip({ bin, selected, onPick }: {
  bin: Bin; selected: boolean; onPick: () => void;
}) {
  const verdict = bin.fit_status ?? bin.capacity_status ?? null;
  const bad = verdict === "WONT_FIT" || verdict === "OVER";
  const tight = verdict === "FULL" || verdict === "TIGHT";

  // What the card leads with. One line, and it is the reason this bin is where it is
  // in the list — an ordering nobody can read is an ordering nobody trusts.
  const lead =
    verdict === "WONT_FIT" ? "This pack does not go in"
      : verdict === "OVER" ? "Would go over its limit"
        : verdict === "FULL" ? "Exactly full afterwards"
          : bin.slots_free != null
            ? `Takes ${fmtCount(bin.slots_free)} more`
            : verdict === "TIGHT" ? "Room, but not much"
              : verdict === "OK" ? "Has room"
                : "Nothing measured here";

  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={`rounded-xl border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-brand bg-brand/[0.06] ring-1 ring-brand/30"
          : bad
            ? "border-bad/30 bg-bad-bg/20 hover:border-bad/50"
            : "border-line bg-content1 hover:border-brand/40 hover:bg-content2"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs font-bold text-ink">{bin.code}</span>
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${
          bad ? "text-bad" : tight ? "text-warn" : "text-muted"
        }`}>
          {lead}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* Still shown, still useful — just no longer the thing being decided on. */}
        <CapacityBadge
          capacity={bin.capacity_volume}
          occupied={bin.occupied_volume}
          status={bin.capacity_status}
          units={bin.occupied_units}
          capacityUnits={bin.capacity_units}
        />
        {bin.slot_capacity != null && (
          <span className="text-[11px] text-muted">
            · {fmtCount(bin.occupied_units)}/{fmtCount(bin.slot_capacity)} slots
          </span>
        )}
        {bin.capacity_volume == null && bin.capacity_qty ? (
          <span className="text-[11px] text-muted">cap {fmtQty(bin.capacity_qty)}</span>
        ) : null}
      </div>
    </button>
  );
}
