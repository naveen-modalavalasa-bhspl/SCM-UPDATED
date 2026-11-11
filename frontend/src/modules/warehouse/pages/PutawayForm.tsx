import { useEffect, useState } from "react";
import {
  PackBreakdownEditor, PackChips, PackQty, baseOf, greedy, greedyIn, heldOf, isPartial, num as packNum,
  shrinkWithin, toPayload,
  type PackEntry, type PackHierarchy,
} from "@/shared/packing";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { AlertTriangle, ArrowLeft, ScanLine } from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, DocumentScopeStrip, ErrorBanner, Field, Input, PageHeader, StatusPill,
} from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LocationPicker } from "../components/LocationPicker";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { UnitCodeLabels } from "../components/UnitCodeLabels";
import { binOptions, confirmPutaway, getPutaway, locationOccupancy, startPutaway } from "../api";
import { CapacityMeter, fmtCount, volume, weight } from "../components/CapacityMeter";
import { fmtDate, fmtDateTime, fmtQty, humanise, normaliseStatus } from "../format";
import { alerts } from "@/modules/alerts";
import { usePointLabel } from "../usePointLabel";
import { CombinationTag } from "@/shared/combination";

const parseCodes = (arr: any): string[] | null => {
  if (!arr) return null;
  if (!Array.isArray(arr)) {
    if (arr.accepted && Array.isArray(arr.accepted)) {
      return parseCodes(arr.accepted);
    }
    return null;
  }
  if (arr.length === 0) return [];
  if (typeof arr[0] === "string") return arr;
  return arr.map((u: any) => u?.serial_number || u?.imei_no || u?.asset_code || u?.consumable_code || u?.serial_no || u?.code).filter(Boolean);
};

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
  // How the goods go on the shelf, in the receipt's hierarchy (2026-10-08).
  const [shelfPacks, setShelfPacks] = useState<PackEntry[] | null>(null);
  // WHICH pack the bin is checked against — the biggest one actually going on the
  // shelf (2026-10-21). It used to be a second picker of its own ("Handling unit —
  // what is being put away") restating the shelf packs above it and free to disagree
  // with them: 1 carton shelved, the bin measured as 100 strips. No shelf packs: the
  // rung the task was raised with, else null and the server takes the default.
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

  const biggestShelfPack = (shelfPacks ?? [])
    .filter((e) => e.level > 0 && packNum(e.qty) > 0 && e.item_packaging_id)
    .sort((a, b) => b.level - a.level)[0];
  const packId = biggestShelfPack?.item_packaging_id ?? task?.item_packaging_id ?? null;

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
    // Only a placement already made — a half-finished task being resumed. Nothing is
    // prefilled otherwise: the goods go where the storekeeper puts them, and a bin
    // sitting in the box before he has looked at the shelf is a suggestion by another
    // name.
    setBinId(task.actual_bin_id ?? "");
    setSerials(parseCodes(task.serial_numbers) ?? []);
    setShelfPacks(task.pack_breakdown ?? task.received_pack_breakdown ?? null);
  }, [task]);

  // The receipt's hierarchy, as served — the putaway may change its LEVELS, never it.
  const hierarchy: PackHierarchy | null = task?.pack_levels?.length
    ? { hierarchy_id: task.pack_hierarchy_id ?? null,
        name: task.pack_hierarchy_name ?? "Packing", base_uom: task.uom_code,
        levels: task.pack_levels }
    : null;
  // Packs are MADE here: one under its level's minimum is refused by the server, so
  // the press waits until it is repacked smaller or left loose (2026-10-11).
  const packsMatch = !hierarchy || !shelfPacks?.length
    || (baseOf(shelfPacks) === qty && !(shelfPacks ?? []).some((e) => isPartial(e)
      && packNum(hierarchy.levels[e.level]?.min_fill) > 0
      && heldOf(e) < packNum(hierarchy.levels[e.level]?.min_fill)));
  // A part putaway re-reads what arrived inside the smaller quantity.
  const changeQty = (next: number) => {
    setQty(next);
    if (hierarchy && task?.packing_fixed && task.storage_levels?.length) {
      setShelfPacks(greedyIn(hierarchy, next, task.storage_levels));
    } else if (hierarchy && task?.received_pack_breakdown?.length) {
      setShelfPacks(shrinkWithin(task.received_pack_breakdown, next));
    } else if (hierarchy) {
      setShelfPacks(greedy(hierarchy, next));
    }
  };

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
        pack_breakdown: hierarchy && shelfPacks?.length ? toPayload(shelfPacks) : null,
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

  /** Resolves a scanned label against every storage location in the warehouse —
   *  `all_locations`, because a lane, a rack and a cold room all carry a label too and
   *  stock is allowed to be put down on any of them. */
  const resolveScan = async (code: string) => {
    const value = code.trim().toUpperCase();
    if (!value) return;
    try {
      const rows = await binOptions(task!.warehouse_id, value, null, null, null, true);
      const match = rows.find((b) => (b.code ?? "").toUpperCase() === value);
      if (!match) {
        setScanError(`No storage location ${value} in this warehouse.`);
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
            {/* Same code the server checks on /start and /confirm — not stock.transfer,
                which is the STO permission and would tie putaway to raising transfers. */}
            {!done && task.status === "pending" && (
              <Can do="putaway.execute">
                <Button variant="soft" onClick={() => start.mutate()} disabled={start.isPending}>
                  Start
                </Button>
              </Can>
            )}
            {!done && (
              <Can do="putaway.execute">
                <Button
                  onClick={() => setConfirming(true)}
                  // One serial per unit placed, or the bin holds stock nobody can trace.
                  disabled={
                    binId === "" || qty <= 0 || !packsMatch ||
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
      {/* Copied from its GRN (2026-11-11); nothing on an older one. */}
      {task && <DocumentScopeStrip doc={task} number={task.putaway_no} className="mb-4" />}

      <ErrorBanner error={error ?? start.error} />

      <MetaCard title="Task">
        <MetaRow label="Number" value={<span className="font-mono">{task.putaway_no}</span>} />
        <MetaRow label="Status" value={<StatusPill status={normaliseStatus(task.status)} />} />
        <MetaRow label="From GRN" value={<span className="font-mono">{task.grn_no ?? "—"}</span>} />
        <MetaRow label="Warehouse" value={task.warehouse_name} />
        <MetaRow label="Item" value={`${task.item_code ?? ""} ${task.item_name ?? ""}`.trim() || "—"} />
        {!!task.brand_id && <MetaRow label="Brand · variant · model" value={<CombinationTag value={task} />} />}
        <MetaRow label="Batch" value={task.batch_no} />
        <MetaRow label={task.is_asset ? "Warranty" : "Expiry"} value={fmtDate(task.expiry_date)} />
        <MetaRow label="Quantity" value={<span className="tabular">{fmtQty(task.qty)} {task.uom_code ?? ""}</span>} />
        {/* What will stand on the shelf (2026-10-27): the Storage containers when the
            item has them, else the packs chosen below. It used to read "Received as"
            and show the rung the space check measures in — neither what arrived nor
            what is stored. */}
        <MetaRow
          label="Stored as"
          value={
            hierarchy && shelfPacks?.length
              ? <PackChips entries={shelfPacks} uom={task.uom_code} showHierarchy={false} />
              : task.package_name
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
          {!!task.pack_breakdown?.length && (
            <div className="mt-2 flex justify-center">
              <PackQty entries={task.pack_breakdown} qty={task.qty} uom={task.uom_code}
                       hierarchy={hierarchy} />
            </div>
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
          hint="Scan the label, or walk the warehouse down to wherever the goods are actually going — a bin, a shelf, a rack, a lane or a whole floor."
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
                data-uom={task.uom_code ?? ""}
                value={String(qty)}
                onChange={(e) => changeQty(Number(e.target.value))}
              />
              {hierarchy && !!shelfPacks?.length && (
                <PackQty entries={shelfPacks} qty={qty} uom={task.uom_code} hierarchy={hierarchy}
                         className="mt-1" />
              )}
            </Field>
          </div>

          {/* HOW it goes on the shelf (2026-10-08): the receipt's hierarchy, at the
            * levels the storekeeper chooses — a carton opened into its boxes, loose strips
            * boxed. Every pack becomes a row; for a code-tracked item each is named with
            * its own code, and that level is the smallest it can ever be split into. */}
          {/* No Storage container mapped (2026-10-27): said, never defined here — the
              mapping is a master, kept on Masters › Packaging › Container Usage. */}
          {hierarchy && task.storage_defined === false && task.status !== "completed" && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-warn/40 bg-warn-bg/60 px-3 py-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <div className="min-w-0 text-xs leading-relaxed text-ink">
                <b className="font-semibold">No storage container is defined for {task.item_code ?? "this item"}.</b>{" "}
                It can still be put away in the packs below, but the shelf will not follow a
                rule. Ask an admin to set its Storage (and Issue) containers in{" "}
                <span className="font-semibold">Masters › Packaging › Container Usage</span>.
              </div>
            </div>
          )}
          {hierarchy && (
            <div className="mt-4 space-y-2 rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-ink">
                  Shelf packing
                  <span className="ml-2 text-xs font-normal text-muted">{hierarchy.name}</span>
                  {task.packing_fixed && (
                    <span className="ml-2 rounded-full bg-brand-050 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-600">
                      Storage containers
                    </span>
                  )}
                </span>
                {task.received_pack_breakdown?.length ? (
                  <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted">
                    Arrived as <PackChips entries={task.received_pack_breakdown}
                                          uom={task.uom_code} showHierarchy={false} muted />
                  </span>
                ) : null}
              </div>
              {/* Packs are MADE here, so a part pack under its level's minimum is
                * refused (2026-10-11). A short carton that arrived can be shelved as
                * smaller packs, or left loose. */}
              <PackBreakdownEditor hierarchy={hierarchy} value={shelfPacks} target={qty}
                                   uom={task.uom_code} onChange={setShelfPacks} enforceMin
                                   onlyLevels={task.packing_fixed && task.storage_levels?.length
                                     ? task.storage_levels : undefined}
                                   allowLoose={!task.packing_fixed || !!task.storage_levels?.includes(0)}
                                   readOnly={!!task.packing_fixed} allowAutoFill={!task.packing_fixed} />
              {task.packing_fixed && (
                <p className="text-[11px] text-muted">
                  Stored only in this item's Storage containers — the split between them is worked out for you.
                </p>
              )}
            </div>
          )}

          {/* The whole hierarchy this warehouse was configured with, one dropdown per
            * level. A scan or a suggested-bin chip drives it too, so there is one
            * answer to "where is this going" however it was chosen.
            *
            * `allowAnyLevel`: the goods go where the goods go. A pallet of drums
            * stands at the end of a lane and a delivery can land before its bay
            * exists — refusing anything above a bin never stopped either happening,
            * it only stopped the system being told where the stock is. The capacity
            * gates still measure the choice, and still warn rather than block. */}
          <div className="mt-4">
            <LocationPicker
              warehouseId={task.warehouse_id}
              value={binId}
              onChange={setBinId}
              allowAnyLevel
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
            ` moves into ${room?.location_code ?? "the chosen location"}.`,
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

/* `SuggestionChip` was here. Nothing suggests a location any more — see the note on
 * the location picker above. What the chip was genuinely good at, saying "this pack
 * does not go in" rather than "this bay is empty", is what the capacity meter says
 * about whichever location was actually chosen. */
