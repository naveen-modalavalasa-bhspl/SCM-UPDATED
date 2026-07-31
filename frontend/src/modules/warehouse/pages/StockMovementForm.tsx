import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ScanLine } from "lucide-react";
import { Button, Can, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { batchOptions, binOptions, createStockMovement, getStockAvailability, itemOptions, warehouseOptions } from "../api";
import { ErrorBanner } from "@/shared/components";
import { Lookup } from "../components/Lookup";
import { Section } from "../components/DocumentMeta";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import { fmtQty, num } from "../format";
import type { StockMovementWrite } from "../types";

const MOVEMENT_TYPES = [
  { value: "BIN_TO_BIN", label: "Bin to bin" },
  { value: "TRANSFER", label: "Transfer" },
  { value: "REPLENISHMENT", label: "Replenishment" },
  { value: "QUARANTINE", label: "Quarantine" },
];

const EMPTY: StockMovementWrite = {
  movement_type: "BIN_TO_BIN",
  warehouse_id: 0,
  source_bin_id: 0,
  destination_bin_id: 0,
  item_id: 0,
  batch_id: null,
  quantity: 0,
  serial_numbers: [],
  remarks: "",
};

export default function StockMovementForm() {
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<StockMovementWrite>(EMPTY);
  const [serialsOpen, setSerialsOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof StockMovementWrite>(
    key: K,
    value: StockMovementWrite[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const availability = useQuery({
    queryKey: [
      "wh-stock-movement-availability",
      form.warehouse_id,
      form.source_bin_id,
      form.item_id,
      form.batch_id,
    ],
    queryFn: () => getStockAvailability(
      form.warehouse_id,
      form.source_bin_id,
      form.item_id,
      form.batch_id,
    ),
    enabled: !!form.warehouse_id && !!form.source_bin_id && !!form.item_id,
  });

  useEffect(() => {
    set("serial_numbers", []);
    // Serial choices belong to the exact source dimensions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.warehouse_id, form.source_bin_id, form.item_id, form.batch_id]);

  const save = useMutation({
    mutationFn: () => createStockMovement(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wh-stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-stock"] });
      nav("..", { replace: true });
    },
  });

  const isInvalid = (
    !form.warehouse_id
    || !form.source_bin_id
    || !form.destination_bin_id
    || !form.item_id
    || form.quantity <= 0
    || form.source_bin_id === form.destination_bin_id
    || form.quantity > num(availability.data?.available_qty)
  );

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title="New stock movement"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("..")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Can do="stock.transfer">
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

      <ErrorBanner error={save.error ?? availability.error} />
      {touched && isInvalid && <ErrorBanner error="Complete the source, destination, item and valid quantity." />}

      <Section title="Movement">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Movement type">
            <Select
              value={form.movement_type}
              onChange={(value) => set("movement_type", value || "BIN_TO_BIN")}
              options={MOVEMENT_TYPES}
              ariaLabel="Movement type"
            />
          </Field>
          <Field label="Warehouse">
            <Lookup
              name="movement-warehouse"
              load={warehouseOptions}
              value={form.warehouse_id || ""}
              onChange={(value) => set("warehouse_id", value === "" ? 0 : value)}
              placeholder="Warehouse"
            />
          </Field>
          <Field label="Source bin">
            <Lookup
              name={`movement-source-${form.warehouse_id}`}
              load={(search) => binOptions(form.warehouse_id, search)}
              value={form.source_bin_id || ""}
              isDisabled={!form.warehouse_id}
              onChange={(value) => set("source_bin_id", value === "" ? 0 : value)}
              placeholder="Source bin"
            />
          </Field>
          <Field label="Destination bin">
            <Lookup
              name={`movement-destination-${form.warehouse_id}`}
              load={(search) => binOptions(form.warehouse_id, search)}
              value={form.destination_bin_id || ""}
              isDisabled={!form.warehouse_id}
              onChange={(value) => set("destination_bin_id", value === "" ? 0 : value)}
              placeholder="Destination bin"
            />
          </Field>
          <Field label="Item">
            <Lookup
              name="movement-item"
              load={itemOptions}
              value={form.item_id || ""}
              onChange={(value) => set("item_id", value === "" ? 0 : value)}
              placeholder="Item"
            />
          </Field>
          <Field label="Batch">
            <Lookup
              name={`movement-batch-${form.item_id}-${form.source_bin_id}`}
              load={() => batchOptions(form.item_id, form.warehouse_id, form.source_bin_id)}
              value={form.batch_id ?? ""}
              isDisabled={!form.item_id || !form.source_bin_id}
              onChange={(value) => set("batch_id", value === "" ? null : value)}
              placeholder="Batch"
            />
          </Field>
          <Field
            label="Quantity"
            hint={`Available: ${fmtQty(availability.data?.available_qty ?? 0)}`}
          >
            <Input
              type="number"
              value={String(form.quantity)}
              onChange={(event) => set("quantity", Number(event.target.value))}
            />
          </Field>
          <Field label="Serialized units">
            <Button
              variant="subtle"
              onClick={() => setSerialsOpen(true)}
              disabled={!availability.data?.serial_numbers.length}
            >
              <ScanLine className="h-4 w-4" />
              {form.serial_numbers?.length ?? 0} selected
            </Button>
          </Field>
        </div>
      </Section>

      <Card className="p-4">
        <Field label="Remarks">
          <Input
            value={form.remarks ?? ""}
            onChange={(event) => set("remarks", event.target.value)}
          />
        </Field>
      </Card>

      <SerialNumbersModal
        isOpen={serialsOpen}
        onClose={() => setSerialsOpen(false)}
        quantity={form.quantity}
        initial={form.serial_numbers ?? []}
        itemLabel="Serials currently in the selected source bin"
        onSave={(serials) => set("serial_numbers", serials)}
      />
      {availability.data?.serial_numbers.length ? (
        <div className="mt-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Select serials in source bin
          </div>
          <div className="flex flex-wrap gap-2">
            {availability.data.serial_numbers.map((serial) => {
              const selected = form.serial_numbers?.includes(serial) ?? false;
              return (
                <button
                  key={serial}
                  type="button"
                  onClick={() => set(
                    "serial_numbers",
                    selected
                      ? (form.serial_numbers ?? []).filter((value) => value !== serial)
                      : [...(form.serial_numbers ?? []), serial],
                  )}
                  className={`min-h-11 rounded-lg border px-3 font-mono text-xs ${
                    selected
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-line bg-content1 text-body"
                  }`}
                >
                  {serial}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
