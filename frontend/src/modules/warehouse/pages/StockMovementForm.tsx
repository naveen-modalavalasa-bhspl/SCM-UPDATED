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
  warehouseOptions
} from "../api";
import { Lookup } from "../components/Lookup";
import { Section } from "../components/DocumentMeta";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { fmtQty, num } from "../format";
import type { StockMovementOrderItemWrite } from "../types";
import { usePointLabel } from "../usePointLabel";

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
