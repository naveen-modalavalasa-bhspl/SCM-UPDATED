import { Button, Can, Card, ErrorBanner, Field, Input, PageHeader, Select } from "@/shared/components";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScanLine, Trash2 } from "lucide-react";
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
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { fmtQty, num } from "../format";
import type { StockMovementOrderItemWrite, OccupancyMove } from "../types";
import { usePointLabel } from "../usePointLabel";
import { useMemo } from "react";

export default function StockMovementForm() {
  const pointLabel = usePointLabel();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const [warehouseId, setWarehouseId] = useState<number>(0);
  const [isBinManaged, setIsBinManaged] = useState<boolean>(true);
  const [reason, setReason] = useState<string>("");
  const [lines, setLines] = useState<StockMovementOrderItemWrite[]>([]);

  const [touched, setTouched] = useState(false);

  const storageTypes = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: () => listStorageTypes(),
  });

  const save = useMutation({
    mutationFn: () => createStockMovementOrder({ warehouse_id: warehouseId, reason, items: lines }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-orders"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-stock"] });
      nav("/warehouse/stock-movements", { replace: true });
    },
  });

  const addLine = () => {
    setLines([...lines, {
      item_id: 0,
      source_bin_id: 0,
      destination_bin_id: 0,
      quantity: 0,
      batch_id: null,
      serial_numbers: [],
    }]);
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const setLine = <K extends keyof StockMovementOrderItemWrite>(index: number, key: K, value: StockMovementOrderItemWrite[K]) => {
    const newLines = [...lines];
    newLines[index] = { ...newLines[index], [key]: value };
    // Clear serial numbers if dimensions change
    if (key === "item_id" || key === "source_bin_id" || key === "batch_id") {
      newLines[index].serial_numbers = [];
    }
    // A source bin is only offered because it holds the item that was chosen. Change
    // the item and the bin underneath it is a bin for something else — kept, it was
    // posted as a source with no stock in it and the save came back "Only 0 is
    // available". Same for the batch, which is read off the source.
    if (key === "item_id") {
      newLines[index].source_bin_id = 0;
      newLines[index].batch_id = null;
    }
    // Never leave the destination sitting on the bin just chosen as the source.
    if (key === "source_bin_id" && value === newLines[index].destination_bin_id) {
      newLines[index].destination_bin_id = 0;
    }
    setLines(newLines);
  };

  const isInvalid = !warehouseId || lines.length === 0 || lines.some(l =>
    !l.item_id || !l.source_bin_id || !l.destination_bin_id || l.quantity <= 0 || l.source_bin_id === l.destination_bin_id ||
    // Strict validation if it's a known serial-tracked line:
    (l as any)._is_serial_tracked && (l.serial_numbers?.length ?? 0) !== Math.floor(l.quantity)
  );

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
                {save.isPending ? "Moving…" : "Complete movement"}
              </Button>
            </Can>
          </>
        }
      />

      <ErrorBanner error={save.error} />
      {touched && isInvalid && <ErrorBanner error="Complete all fields for the warehouse and lines. Ensure destination differs from source and quantity is valid." />}

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
        <Button variant="subtle" onClick={addLine}>
          <Plus className="mr-2 h-4 w-4" />
          Add Item
        </Button>
      </div>

      <div className="space-y-6">
        {lines.map((line, index) => (
          <MovementLineEditor
            key={index}
            index={index}
            line={line}
            warehouseId={warehouseId}
            isBinManaged={isBinManaged}
            storageTypes={storageTypes.data ?? []}
            onChange={(key, value) => setLine(index, key, value)}
            onRemove={() => removeLine(index)}
          />
        ))}
        {lines.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted">
            No items added yet. Click "Add Item" to start.
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
    </div>
  );
}

function MovementLineEditor({
  index,
  line,
  warehouseId,
  isBinManaged,
  storageTypes,
  onChange,
  onRemove
}: {
  index: number;
  line: StockMovementOrderItemWrite;
  warehouseId: number;
  isBinManaged: boolean;
  storageTypes: any[];
  onChange: <K extends keyof StockMovementOrderItemWrite>(key: K, val: StockMovementOrderItemWrite[K]) => void;
  onRemove: () => void;
}) {
  const [serialsOpen, setSerialsOpen] = useState(false);
  const [storageType, setStorageType] = useState<number | string | "">("");

  /* Only the storage types stock is actually counted in. The full BinType list was on
   * offer — BLOCK, FLOOR, LANE, RACK, SHELF — and every one of them is structure you
   * walk past on the way to a bin: picking one gave an empty destination list, and
   * `all_locations` let a rack be chosen anyway, which the service then rejected with
   * "Stock can move only between stock-holding bins". Mirrors BIN_TYPES on the server. */
  const STORAGE_ENUMS = ["BIN", "COLD_STORAGE_BIN"];

  const availability = useQuery({
    queryKey: ["wh-stock-movement-availability", warehouseId, line.source_bin_id, line.item_id, line.batch_id],
    queryFn: () => getStockAvailability(warehouseId, line.source_bin_id, line.item_id, line.batch_id),
    enabled: !!warehouseId && (line.source_bin_id !== undefined && (isBinManaged ? !!line.source_bin_id : true)) && !!line.item_id,
  });

  // Track it locally so the top-level form can validate
  useEffect(() => {
    if (availability.data?.is_serial_tracked !== undefined) {
      (line as any)._is_serial_tracked = availability.data.is_serial_tracked;
    }
  }, [availability.data?.is_serial_tracked, line]);

  return (
    <Card className="relative p-6 bg-content1 shadow-sm transition-all hover:shadow-md">
      <div className="absolute right-4 top-4">
        <Button variant="ghost" className="text-danger h-8 w-8 p-0" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mb-4 text-sm font-semibold text-muted uppercase tracking-wider">
        Line {index + 1}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Item">
          <Lookup
            name={`line-item-${index}`}
            load={itemOptions}
            value={line.item_id || ""}
            onChange={(value) => {
              onChange("item_id", value === "" ? 0 : value);
              if (!isBinManaged) {
                onChange("source_bin_id", 0);
                onChange("destination_bin_id", 0);
              }
            }}
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
              onChange={(value) => onChange("source_bin_id", value === "" ? 0 : value)}
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
            onChange={(value) => onChange("batch_id", value === "" ? null : value)}
            placeholder="Batch"
          />
        </Field>

        <Field
          label="Quantity"
          hint={availability.data ? `Available: ${fmtQty(availability.data.available_qty)}` : undefined}
        >
          <Input
            type="number"
            value={String(line.quantity || "")}
            onChange={(event) => onChange("quantity", Number(event.target.value))}
            placeholder="Qty"
            className={availability.data && Number(line.quantity) > num(availability.data.available_qty) ? "border-danger text-danger" : ""}
          />
        </Field>

        <Field label="Destination Storage Type">
          <Select
            value={String(storageType)}
            onChange={(val) => {
              setStorageType(val || "");
              // The bin below no longer belongs to the type now selected.
              onChange("destination_bin_id", 0);
            }}
            options={[
              ...STORAGE_ENUMS.map(e => ({ value: e, label: e })),
              ...storageTypes.map(st => ({ value: String(st.id), label: st.name }))
            ]}
            ariaLabel="Storage type filter"
          />
        </Field>

        {isBinManaged && (
          /* Stock-holding bins only (never `all_locations`, which offered racks and
           * floors the service refuses), narrowed to the chosen storage type, and never
           * the source bin — a move to where it already is is not a move. All three are
           * in the cache name for the same reason the source's are. */
          <Field label="Destination location">
            <Lookup
              name={`line-dest-${index}-${warehouseId}-${storageType || "any"}-${line.source_bin_id}`}
              load={(search) => binOptions(
                warehouseId, search, undefined, undefined, String(storageType) || undefined,
                false, line.source_bin_id || undefined,
              )}
              value={line.destination_bin_id || ""}
              isDisabled={!warehouseId}
              onChange={(value) => onChange("destination_bin_id", value === "" ? 0 : value)}
              placeholder="Destination location"
            />
          </Field>
        )}

        {availability.data?.is_serial_tracked && (
          <Field label="Serial Numbers">
            <Button
              variant="subtle"
              onClick={() => setSerialsOpen(true)}
              className={`w-full justify-start ${(line.serial_numbers?.length ?? 0) !== Math.floor(line.quantity) ? 'border-danger text-danger' : ''}`}
            >
              <ScanLine className="mr-2 h-4 w-4" />
              {line.serial_numbers?.length ?? 0} selected (needs {Math.floor(line.quantity)})
            </Button>
          </Field>
        )}
      </div>

      <SerialNumbersModal
        isOpen={serialsOpen}
        onClose={() => setSerialsOpen(false)}
        quantity={line.quantity}
        initial={line.serial_numbers ?? []}
        itemLabel="Serials in source bin"
        onSave={(serials) => onChange("serial_numbers", serials)}
        available={availability.data?.serial_numbers ?? []}
        pickMode="select"
      />
    </Card>
  );
}
