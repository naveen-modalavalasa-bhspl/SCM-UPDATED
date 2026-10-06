import { Button, Can, Card, ErrorBanner, Field, Input, PageHeader, Select } from "@/shared/components";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Plus, ScanLine, Trash2 } from "lucide-react";
import {
  batchOptions,
  binOptions,
  createStockMovementOrder,
  getStockAvailability,
  itemOptions,
  listStorageTypes,
  warehouseOptions,
  occupancyPreview
} from "../api";
import { CapacityMeter, fmtCount, volume, weight } from "../components/CapacityMeter";
import { Lookup } from "../components/Lookup";
import { Section } from "../components/DocumentMeta";
import { TrackingBadge, useTrackingMeta } from "../components/TrackingBadge";
import { CodeAssignmentScreen } from "./CodeAssignmentScreen";
import { fmtQty, num } from "../format";
import type {
  OccupancyMove, StockAvailability, StockMovementOrderItemWrite, StorageType,
  TrackingType, UnitMode,
} from "../types";
import { usePointLabel } from "../usePointLabel";

/**
 * One line as the form holds it: the write shape, plus a stable key and the
 * destination's label. The key is what the per-line availability and the unit picker
 * address a line by — an index shifts under them the moment a line above is removed.
 * Everything prefixed `_` is stripped before the write.
 */
type DraftLine = StockMovementOrderItemWrite & {
  _key: string;
  _destCode?: string | null;
  _destName?: string | null;
};

let nextKey = 0;
const newKey = () => `line-${++nextKey}`;

/** The noun for one unit when the served catalogue has not landed yet. */
const fallbackNoun = (mode?: UnitMode | null) =>
  mode === "SERIAL" ? "serial" : mode === "IMEI" ? "IMEI" : "unit code";

/**
 * What is still wrong with a line, in the words the storekeeper acts on — or null.
 *
 * Whether a line must name its units is SERVED (`units_required`, read off the item
 * master by `service._movement_units`), never inferred here: the server applies the
 * identical rule at save and on approval, and this only says so before the press.
 */
function lineProblem(line: DraftLine, avail: StockAvailability | undefined, noun: string): string | null {
  if (!line.item_id) return "Pick the item.";
  if (!line.source_bin_id) return "Pick the source location.";
  if (!line.destination_bin_id) return "Pick the destination location.";
  if (line.source_bin_id === line.destination_bin_id) return "The destination must differ from the source.";
  const qty = num(line.quantity);
  if (qty <= 0) return "Enter the quantity to move.";
  if (avail && qty > num(avail.available_qty)) {
    return `Only ${fmtQty(avail.available_qty)} is available at the source.`;
  }
  if (avail?.units_required) {
    if (!Number.isInteger(qty)) return `A quantity named by ${noun}s must be a whole number.`;
    const picked = line.serial_numbers?.length ?? 0;
    if (picked !== qty) return `Choose exactly ${qty} ${noun}${qty === 1 ? "" : "s"} — ${picked} selected.`;
  }
  return null;
}

export default function StockMovementForm() {
  const pointLabel = usePointLabel();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const trackingMeta = useTrackingMeta();

  const [warehouseId, setWarehouseId] = useState<number>(0);
  const [isBinManaged, setIsBinManaged] = useState<boolean>(true);
  const [reason, setReason] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  /** Each line's source, as the server describes it. Keyed by `_key`. */
  const [sources, setSources] = useState<Record<string, StockAvailability | undefined>>({});
  /** The line whose units are being picked — the picker is a whole screen. */
  const [pickKey, setPickKey] = useState<string | null>(null);

  const [touched, setTouched] = useState(false);

  const storageTypes = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: () => listStorageTypes(),
  });

  const save = useMutation({
    mutationFn: () => createStockMovementOrder({
      warehouse_id: warehouseId,
      reason,
      items: lines.map(({ _key, _destCode, _destName, ...line }) => line),
    }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-orders"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-stock"] });
      // The units now stand somewhere else; every cached page of them is stale.
      queryClient.invalidateQueries({ queryKey: ["wh-issue-codes"] });
      queryClient.invalidateQueries({ queryKey: ["wh-serials"] });
      queryClient.invalidateQueries({ queryKey: ["wh-item-locations"] });

      const base = window.location.pathname.replace(/\/new$/, "");
      nav(`${base}/view?order_no=${encodeURIComponent(result.order_no)}`, { replace: true });
    },
  });

  const addLine = () => {
    setLines([...lines, {
      _key: newKey(),
      item_id: 0,
      source_bin_id: 0,
      destination_bin_id: 0,
      quantity: 0,
      batch_id: null,
      serial_numbers: [],
    }]);
  };

  const removeLine = (key: string) => {
    setLines(lines.filter((l) => l._key !== key));
    setSources(({ [key]: _gone, ...rest }) => rest);
  };

  const patchLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => {
      if (line._key !== key) return line;
      const next = { ...line, ...patch };
      // The units belong to one (item, source, batch). Change any of them and the
      // ones already picked are units of somewhere else.
      if ("item_id" in patch || "source_bin_id" in patch || "batch_id" in patch) {
        next.serial_numbers = [];
      }
      // A source bin is only offered because it holds the item that was chosen.
      // Change the item and the bin underneath it is a bin for something else — kept,
      // it was posted as a source with no stock in it and the save came back "Only 0
      // is available". Same for the batch, which is read off the source.
      if ("item_id" in patch) {
        next.source_bin_id = 0;
        next.batch_id = null;
      }
      // Never leave the destination sitting on the bin just chosen as the source.
      if ("source_bin_id" in patch && patch.source_bin_id === next.destination_bin_id) {
        next.destination_bin_id = 0;
        next._destCode = null;
        next._destName = null;
      }
      // Lowering the quantity takes the surplus identifiers with it, from the tail —
      // the last ones scanned. Otherwise correcting 10 to 6 sends the storekeeper back
      // into the picker to unpick four by hand.
      if ("quantity" in patch) {
        const room = Math.max(0, Math.floor(num(next.quantity)));
        if ((next.serial_numbers?.length ?? 0) > room) {
          next.serial_numbers = (next.serial_numbers ?? []).slice(0, room);
        }
      }
      return next;
    }));
  };

  const nounFor = (avail?: StockAvailability) =>
    trackingMeta(avail?.tracking_type as TrackingType | null)?.unit ?? fallbackNoun(avail?.unit_mode);

  const problems = lines.map((line) => lineProblem(line, sources[line._key], nounFor(sources[line._key])));
  const isInvalid = !warehouseId || lines.length === 0 || problems.some(Boolean);

  const outwardMoves = useMemo<OccupancyMove[]>(
    () => lines
      .filter((l) => l.source_bin_id && l.item_id && num(l.quantity) > 0)
      .map((l) => ({
        location_id: Number(l.source_bin_id),
        item_id: Number(l.item_id),
        qty: num(l.quantity),
        direction: "OUT" as const,
      })),
    [lines]
  );

  const inwardMoves = useMemo<OccupancyMove[]>(
    () => lines
      .filter((l) => l.destination_bin_id && l.item_id && num(l.quantity) > 0)
      .map((l) => ({
        location_id: Number(l.destination_bin_id),
        item_id: Number(l.item_id),
        qty: num(l.quantity),
        direction: "IN" as const,
      })),
    [lines]
  );

  const combinedMoves = useMemo(() => [...outwardMoves, ...inwardMoves], [outwardMoves, inwardMoves]);

  const { data: capacityData = [], isFetching: capacityLoading } = useQuery({
    queryKey: ["wh-movement-occupancy", combinedMoves],
    queryFn: () => occupancyPreview(combinedMoves),
    enabled: isBinManaged && combinedMoves.length > 0,
    placeholderData: (previous) => previous,
  });

  const freedCapacity = useMemo(() => capacityData.filter((r) => outwardMoves.some(m => m.location_id === r.location_id)), [capacityData, outwardMoves]);
  const consumedCapacity = useMemo(() => capacityData.filter((r) => inwardMoves.some(m => m.location_id === r.location_id)), [capacityData, inwardMoves]);

  const freedUnmeasured = useMemo(() => freedCapacity.reduce((sum, row) => sum + row.unmeasured_lines, 0), [freedCapacity]);
  const consumedUnmeasured = useMemo(() => consumedCapacity.reduce((sum, row) => sum + row.unmeasured_lines, 0), [consumedCapacity]);

  /* What the whole transfer moves, in the unit the floor actually handles.
   *
   * A movement is the one document where both halves are read at once — the same packs
   * leave one shelf and land on another — so the totals are worth stating over the
   * meters rather than leaving a storekeeper to add four cards up. Summed from the
   * server's own per-location figures, never recomputed here. */
  const totalOf = (rows: typeof capacityData, key: "move_units" | "move_volume" | "move_weight") =>
    rows.reduce((sum, row) => sum + Math.abs(Number(row[key] ?? 0)), 0);
  const load = useMemo(() => ({
    units: totalOf(consumedCapacity, "move_units"),
    volume: totalOf(consumedCapacity, "move_volume"),
    weight: totalOf(consumedCapacity, "move_weight"),
    worst: consumedCapacity.find((row) => row.status === "OVER" || row.status === "WONT_FIT"),
  }), [consumedCapacity]);

  const picking = pickKey ? lines.find((l) => l._key === pickKey) : undefined;
  const pickingSource = picking ? sources[picking._key] : undefined;
  const pickingType = (pickingSource?.tracking_type ?? "NONE") as TrackingType;

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title="New Stock Movement Order"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/stock-movements")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Can do="movement.create">
              <Button
                onClick={() => {
                  setTouched(true);
                  if (!isInvalid) save.mutate();
                }}
                disabled={save.isPending}
              >
                {save.isPending ? "Saving…" : "Save draft"}
              </Button>
            </Can>
          </>
        }
      />

      <ErrorBanner error={save.error} />
      {touched && isInvalid && (
        <div className="mb-4 rounded-xl border border-bad/40 bg-bad-bg/30 px-4 py-3 text-sm text-ink">
          <b>Not ready to move yet.</b>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {!warehouseId && <li>Pick the warehouse.</li>}
            {warehouseId > 0 && lines.length === 0 && <li>Add at least one item.</li>}
            {problems.map((problem, i) => problem && (
              <li key={lines[i]._key}>Line {i + 1}: {problem}</li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Header Details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-2">
          <Field label="Warehouse">
            <Lookup
              name="movement-warehouse"
              load={warehouseOptions}
              value={warehouseId || ""}
              onChange={(value, option) => {
                setWarehouseId(value === "" ? 0 : value);
                setIsBinManaged((option as any)?.is_bin_managed ?? true);
                setLines([]);
                setSources({});
              }}
              placeholder="Warehouse"
            />
          </Field>
          <Field label="Remarks / Reason">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="E.g. Replenishment, Relocation..."
            />
          </Field>
        </div>
      </Section>

      <div className="mt-8 mb-4 flex items-center justify-between">
        <h3 className="text-lg font-medium text-body">Movement Lines</h3>
        {/* "flat" is a raw HeroUI variant; this project's Button exposes its own set. */}
        <Button variant="subtle" onClick={addLine} disabled={!warehouseId}>
          <Plus className="mr-2 h-4 w-4" />
          Add Item
        </Button>
      </div>

      <div className="space-y-6">
        {lines.map((line, index) => (
          <MovementLineEditor
            key={line._key}
            index={index}
            line={line}
            warehouseId={warehouseId}
            isBinManaged={isBinManaged}
            storageTypes={storageTypes.data ?? []}
            problem={touched ? problems[index] : null}
            onPatch={(patch) => patchLine(line._key, patch)}
            onRemove={() => removeLine(line._key)}
            onSource={(data) => setSources((current) => (
              current[line._key] === data ? current : { ...current, [line._key]: data }
            ))}
            onPickUnits={() => setPickKey(line._key)}
          />
        ))}
        {lines.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted">
            {warehouseId
              ? "No items added yet. Click \"Add Item\" to start."
              : "Pick the warehouse first, then add the items to move."}
          </div>
        )}
      </div>

      {/* The load, once, before the two halves are drawn. It is the same packs on both
        * sides of the move, so stating it per section would say it twice and invite the
        * reader to wonder why the numbers match. */}
      {isBinManaged && load.units > 0 && (
        <div className={`mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3 ${
          load.worst ? "border-bad/40 bg-bad-bg/30" : "border-line bg-content2"
        }`}>
          <div className="flex items-baseline gap-1.5">
            <span className="tabular font-display text-2xl font-black leading-none text-ink">
              {fmtCount(load.units)}
            </span>
            <span className="text-xs font-semibold text-body">
              handling unit{load.units === 1 ? "" : "s"} on the move
            </span>
          </div>
          {load.volume > 0 && (
            <span className="tabular text-xs text-muted">{volume(load.volume)}</span>
          )}
          {load.weight > 0 && (
            <span className="tabular text-xs text-muted">{weight(load.weight)}</span>
          )}
          <span className="ml-auto text-xs text-muted">
            {load.worst
              ? <span className="font-semibold text-bad">{load.worst.headline}</span>
              : "Every destination has room for it."}
          </span>
        </div>
      )}

      {isBinManaged && outwardMoves.length > 0 && (
        <Section
          title="Space freed (Source locations)"
          hint="What the source locations get back when this movement completes."
        >
          {freedCapacity.length === 0 && capacityLoading ? (
            <CapacityMeter loading />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {freedCapacity.map((row) => (
                <CapacityMeter key={row.location_id} data={row} compact />
              ))}
            </div>
          )}
          {freedUnmeasured > 0 && (
            <p className="mt-3 text-xs text-muted">
              {freedUnmeasured} line{freedUnmeasured === 1 ? "" : "s"} could not be
              measured, so the space they free is not in these figures. Measure the
              container type under Masters &gt; Packages, or override the sides on the
              item&rsquo;s own packaging rung.
            </p>
          )}
        </Section>
      )}

      {isBinManaged && inwardMoves.length > 0 && (
        <Section
          title="Space required (Destination locations)"
          hint="What the destination locations will hold after this movement."
        >
          {consumedCapacity.length === 0 && capacityLoading ? (
            <CapacityMeter loading />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {consumedCapacity.map((row) => (
                <CapacityMeter key={row.location_id} data={row} compact />
              ))}
            </div>
          )}
          {consumedUnmeasured > 0 && (
            <p className="mt-3 text-xs text-muted">
              {consumedUnmeasured} line{consumedUnmeasured === 1 ? "" : "s"} could not be
              measured, so the space they consume is not in these figures. Measure the
              container type under Masters &gt; Packages, or override the sides on the
              item&rsquo;s own packaging rung.
            </p>
          )}
        </Section>
      )}

      {/* Naming the units is a SCREEN, not a dialog — the same one a material issue
        * uses. Scoped to the SOURCE location and batch, where the units physically
        * stand; its "At destination" view lists what the target bay already holds of
        * this item and batch, which is where these units will be found afterwards. */}
      <CodeAssignmentScreen
        open={!!picking}
        onClose={() => setPickKey(null)}
        backLabel="Back to the movement"
        quantity={picking ? num(picking.quantity) : 0}
        initial={picking?.serial_numbers ?? []}
        trackingType={pickingType}
        trackingMeta={trackingMeta(pickingType)}
        noun={nounFor(pickingSource)}
        unitMode={(pickingSource?.unit_mode ?? "SERIAL") as UnitMode}
        itemId={picking?.item_id || undefined}
        warehouseId={warehouseId || undefined}
        binId={picking?.source_bin_id || undefined}
        batchId={picking?.batch_id || undefined}
        unbatched
        claimFree
        scope={{
          batchNo: pickingSource?.batch_no,
          binCode: pickingSource?.bin_code,
          binPath: pickingSource?.bin_path,
          available: pickingSource ? num(pickingSource.available_qty) : null,
        }}
        destination={picking?.destination_bin_id ? {
          binId: picking.destination_bin_id,
          binCode: picking._destCode,
          binPath: picking._destName,
          batchId: picking.batch_id,
          batchNo: pickingSource?.batch_no,
        } : undefined}
        itemLabel={picking ? `Line ${lines.indexOf(picking) + 1}` : ""}
        onSave={(codes) => picking && patchLine(picking._key, { serial_numbers: codes })}
      />
    </div>
  );
}

function MovementLineEditor({
  index,
  line,
  warehouseId,
  isBinManaged,
  storageTypes,
  problem,
  onPatch,
  onRemove,
  onSource,
  onPickUnits,
}: {
  index: number;
  line: DraftLine;
  warehouseId: number;
  isBinManaged: boolean;
  storageTypes: StorageType[];
  problem: string | null;
  onPatch: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
  onSource: (data: StockAvailability | undefined) => void;
  onPickUnits: () => void;
}) {
  const [storageType, setStorageType] = useState<number | string | "">("");
  const trackingMeta = useTrackingMeta();

  const availability = useQuery({
    queryKey: ["wh-stock-movement-availability", warehouseId, line.source_bin_id, line.item_id, line.batch_id],
    queryFn: () => getStockAvailability(warehouseId, line.source_bin_id, line.item_id, line.batch_id),
    enabled: !!warehouseId && (line.source_bin_id !== undefined && (isBinManaged ? !!line.source_bin_id : true)) && !!line.item_id,
  });

  // Handed up so the form can validate the whole document and open the picker.
  // Through a ref, because the parent passes a fresh closure every render.
  const report = useRef(onSource);
  report.current = onSource;
  const ready = availability.isSuccess && !!line.item_id && !!line.source_bin_id;
  useEffect(() => {
    report.current(ready ? availability.data : undefined);
  }, [ready, availability.data]);

  const avail = ready ? availability.data : undefined;
  const type = (avail?.tracking_type ?? "NONE") as TrackingType;
  const meta = trackingMeta(type);

  return (
    <Card className={`relative p-6 bg-content1 shadow-sm transition-all hover:shadow-md ${
      problem ? "ring-1 ring-bad/40" : ""
    }`}>
      <div className="absolute right-4 top-4">
        <Button variant="ghost" className="text-danger h-8 w-8 p-0" onClick={onRemove} aria-label={`Remove line ${index + 1}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-muted uppercase tracking-wider">
        Line {index + 1}
        {avail?.units_required && <TrackingBadge type={type} meta={meta} size="sm" />}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Item">
          <Lookup
            name={`line-item-${index}`}
            load={itemOptions}
            value={line.item_id || ""}
            onChange={(value) => onPatch({
              item_id: value === "" ? 0 : value,
              ...(!isBinManaged ? { source_bin_id: 0, destination_bin_id: 0 } : {}),
            })}
            placeholder="Select Item"
          />
        </Field>

        {isBinManaged && (
          /* Only the bins that actually hold this item. The name carries the item and
           * the batch because Lookup keys its cache on it — without them the first
           * line's list was reused for every later item, and every bin in the
           * warehouse was on offer for stock standing in three of them. */
          <Field label="Source location"
                 hint={!line.item_id ? "Pick the item first." : undefined}>
            <Lookup
              name={`line-source-${index}-${warehouseId}-${line.item_id}-${line.batch_id ?? 0}`}
              load={(search) => binOptions(warehouseId, search, line.item_id, line.batch_id)}
              value={line.source_bin_id || ""}
              isDisabled={!warehouseId || !line.item_id}
              onChange={(value) => onPatch({ source_bin_id: value === "" ? 0 : value })}
              placeholder={line.item_id ? "Source location" : "Select the item first"}
            />
          </Field>
        )}

        <Field label="Batch">
          <Lookup
            name={`line-batch-${index}-${line.item_id}-${line.source_bin_id}`}
            load={() => batchOptions(line.item_id, warehouseId, line.source_bin_id)}
            value={line.batch_id ?? ""}
            isDisabled={!line.item_id || (isBinManaged && !line.source_bin_id)}
            onChange={(value) => onPatch({ batch_id: value === "" ? null : value })}
            placeholder="Batch"
          />
        </Field>

        <Field
          label="Quantity"
          hint={avail ? `Available: ${fmtQty(avail.available_qty)}` : undefined}
        >
          <Input
            type="number"
            value={String(line.quantity || "")}
            onChange={(event) => onPatch({ quantity: Number(event.target.value) })}
            placeholder="Qty"
            className={avail && Number(line.quantity) > num(avail.available_qty) ? "border-danger text-danger" : ""}
          />
        </Field>

        <Field label="Destination storage type"
               hint="Choose a type to narrow the destination locations.">
          <Select
            value={String(storageType)}
            onChange={(val) => {
              setStorageType(val || "");
              // The bin below no longer belongs to the type now selected.
              onPatch({ destination_bin_id: 0, _destCode: null, _destName: null });
            }}
            options={storageTypes
              .filter((type) => type.is_active)
              .map((type) => ({ value: String(type.id), label: type.name }))}
            placeholder="Select storage type"
            ariaLabel="Storage type filter"
          />
        </Field>

        {isBinManaged && (
          /* Every storage location, narrowed to the chosen storage type, and never the
           * source bin — a move to where it already is is not a move. All three are in
           * the cache name for the same reason the source's are.
           *
           * `all_locations` because putaway may now place stock on a lane or a rack
           * rather than in a bay (see `confirm_putaway`), and a destination the service
           * accepts has to be one the picker offers — otherwise stock that CAN be put
           * on a rack can never be moved onto one. */
          <Field label="Destination location"
                 hint={!storageType ? "Select the destination storage type first." : undefined}>
            <Lookup
              name={`line-dest-${index}-${warehouseId}-${storageType || "any"}-${line.source_bin_id}`}
              load={(search) => binOptions(
                warehouseId, search, undefined, undefined, String(storageType) || undefined,
                true, line.source_bin_id || undefined,
              )}
              value={line.destination_bin_id || ""}
              isDisabled={!warehouseId || !storageType}
              onChange={(value, option) => onPatch({
                destination_bin_id: value === "" ? 0 : value,
                _destCode: option?.code ?? null,
                _destName: option?.name ?? null,
              })}
              placeholder={storageType ? "Select destination location" : "Select storage type first"}
            />
          </Field>
        )}
      </div>

      {avail?.units_required && (
        <UnitsTile
          line={line}
          avail={avail}
          type={type}
          noun={meta?.unit ?? fallbackNoun(avail.unit_mode)}
          hint={meta?.hint}
          onPick={onPickUnits}
        />
      )}

      {problem && (
        <p className="mt-4 flex items-center gap-2 text-xs font-medium text-bad">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {problem}
        </p>
      )}
    </Card>
  );
}

/**
 * The units a line carries, stated where the line is — how many are named, how many
 * are wanted, what the source can give, where they go — with the one button that
 * opens the picker. The storekeeper should never have to open the screen to find out
 * whether the line is finished.
 */
function UnitsTile({ line, avail, type, noun, hint, onPick }: {
  line: DraftLine;
  avail: StockAvailability;
  type: TrackingType;
  noun: string;
  hint?: string | null;
  onPick: () => void;
}) {
  const qty = num(line.quantity);
  const wanted = Number.isInteger(qty) ? qty : Math.floor(qty);
  const picked = line.serial_numbers ?? [];
  const complete = wanted > 0 && picked.length === wanted;
  const supply = avail.units_available ?? null;
  const short = supply !== null && !avail.units_capped && wanted > supply;
  const plural = (n: number) => `${noun}${n === 1 ? "" : "s"}`;
  const PREVIEW = 6;

  return (
    <div className={`mt-5 rounded-xl border px-4 py-3 transition-colors ${
      complete ? "border-ok/40 bg-ok/5" : short ? "border-bad/40 bg-bad-bg/20" : "border-line bg-content2/50"
    }`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          {complete
            ? <CheckCircle2 className="h-5 w-5 text-ok" />
            : <ScanLine className="h-5 w-5 text-muted" />}
          <div>
            <p className="text-sm font-semibold text-ink">
              <span className="tabular">{picked.length}</span>
              <span className="text-muted"> / {wanted || "—"}</span> {plural(wanted)} selected
            </p>
            <p className="text-[11px] text-muted">
              {hint ?? `One ${noun} per unit moved, required by the item master.`}
            </p>
          </div>
        </div>

        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-content3">
          <div className={`h-full transition-all duration-300 ${complete ? "bg-ok" : "bg-warn"}`}
               style={{ width: `${wanted ? Math.min(100, (picked.length / wanted) * 100) : 0}%` }} />
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span className="font-mono text-ink">{avail.bin_code ?? "source"}</span>
          <ArrowRight className="h-3.5 w-3.5 text-ok" />
          <span className="font-mono text-ink">{line._destCode ?? "destination"}</span>
        </div>

        <Button variant={complete ? "subtle" : "soft"} onClick={onPick} disabled={wanted <= 0}>
          <ScanLine className="h-4 w-4" />
          {wanted <= 0 ? "Enter the quantity first" : complete ? `Review ${plural(2)}` : `Select ${plural(2)}`}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted">
          Source holds{" "}
          <b className="tabular text-ink">
            {supply === null ? "—" : `${supply.toLocaleString()}${avail.units_capped ? "+" : ""}`}
          </b>{" "}
          {plural(supply ?? 0)} free to move
          {avail.batch_no ? <> in batch <b className="font-mono text-ink">{avail.batch_no}</b></> : null}.
        </span>
        {picked.slice(0, PREVIEW).map((code) => (
          <span key={code} className="rounded-md border border-line bg-content1 px-1.5 py-0.5 font-mono text-ink">
            {code}
          </span>
        ))}
        {picked.length > PREVIEW && (
          <span className="text-muted">+{picked.length - PREVIEW} more</span>
        )}
        {type !== "NONE" && short && (
          <span className="basis-full font-medium text-bad">
            Only {supply} {plural(supply ?? 0)} of this item and batch are at this location —
            lower the quantity, or move the rest from another source.
          </span>
        )}
      </div>
    </div>
  );
}
