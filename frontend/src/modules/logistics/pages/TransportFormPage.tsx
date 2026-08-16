import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, Select, useAction,
} from "@/shared/components";
import { transportApi } from "../api";
import type { ModeRule, TransportMode, TRLineInput } from "../transportTypes";

const BLANK_LINE: TRLineInput = {
  item_name: "", uom_code: "", quantity: 0, package_count: 1, package_type: "",
  weight_kg: null, length_cm: null, width_cm: null, height_cm: null, is_fragile: false,
};

const num = (value: string) => (value === "" ? null : Number(value));

/**
 * Raise or edit a transport request.
 *
 * The form is driven by `/api/transport/modes`: which fields are required, and which
 * are shown at all, come from the rule the backend will validate against. Nothing on
 * this screen decides that a courier needs a carrier — the service does, and the form
 * reads its answer, so the two cannot drift.
 */
export function TransportFormPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const editing = Boolean(id);

  const [mode, setMode] = useState<TransportMode>("THIRD_PARTY");
  const [header, setHeader] = useState({
    to_location_name: "", delivery_address: "", contact_person: "", contact_phone: "",
    from_warehouse_name: "", indent_no: "", distance_km: "", expected_delivery: "",
    remarks: "",
  });
  const [provider, setProvider] = useState({
    carrier_id: "", vehicle_number: "", driver_name: "", driver_phone: "",
    trip_reference: "", handed_over_by_name: "", received_by_name: "",
  });
  const [lines, setLines] = useState<TRLineInput[]>([{ ...BLANK_LINE }]);

  const { data: modes } = useQuery({
    queryKey: ["transport-modes"],
    queryFn: transportApi.modes,
  });
  const { data: carriers } = useQuery({
    queryKey: ["transport-carriers"],
    queryFn: () => transportApi.carriers(),
  });
  const { data: existing, error: loadError } = useQuery({
    queryKey: ["transport", id],
    queryFn: () => transportApi.get(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!existing) return;
    setMode(existing.mode);
    setHeader({
      to_location_name: existing.to_location_name ?? "",
      delivery_address: existing.delivery_address ?? "",
      contact_person: existing.contact_person ?? "",
      contact_phone: existing.contact_phone ?? "",
      from_warehouse_name: existing.from_warehouse_name ?? "",
      indent_no: existing.indent_no ?? "",
      distance_km: existing.distance_km?.toString() ?? "",
      expected_delivery: existing.expected_delivery ?? "",
      remarks: existing.remarks ?? "",
    });
    setProvider({
      carrier_id: existing.carrier_id?.toString() ?? "",
      vehicle_number: existing.vehicle_number ?? "",
      driver_name: existing.driver_name ?? "",
      driver_phone: existing.driver_phone ?? "",
      trip_reference: existing.trip_reference ?? "",
      handed_over_by_name: existing.handed_over_by_name ?? "",
      received_by_name: existing.received_by_name ?? "",
    });
    if (existing.items.length) {
      setLines(existing.items.map((item) => ({
        item_id: item.item_id, item_code: item.item_code, item_name: item.item_name,
        uom_code: item.uom_code, quantity: item.quantity,
        package_count: item.package_count, package_type: item.package_type,
        weight_kg: item.weight_kg, length_cm: item.length_cm,
        width_cm: item.width_cm, height_cm: item.height_cm,
        is_fragile: item.is_fragile, remarks: item.remarks,
      })));
    }
  }, [existing]);

  const rule: ModeRule | undefined = useMemo(
    () => modes?.find((m) => m.value === mode), [modes, mode],
  );
  const needs = (field: string) => rule?.required_fields.includes(field) ?? false;

  const payload = () => ({
    mode,
    to_location_name: header.to_location_name || null,
    delivery_address: header.delivery_address || null,
    contact_person: header.contact_person || null,
    contact_phone: header.contact_phone || null,
    from_warehouse_name: header.from_warehouse_name || null,
    indent_no: header.indent_no || null,
    distance_km: header.distance_km ? Number(header.distance_km) : null,
    expected_delivery: header.expected_delivery || null,
    remarks: header.remarks || null,
    carrier_id: provider.carrier_id ? Number(provider.carrier_id) : null,
    vehicle_number: provider.vehicle_number || null,
    driver_name: provider.driver_name || null,
    driver_phone: provider.driver_phone || null,
    trip_reference: provider.trip_reference || null,
    handed_over_by_name: provider.handed_over_by_name || null,
    received_by_name: provider.received_by_name || null,
    lines: lines.filter((line) => line.item_name || line.quantity),
  });

  const save = useAction({
    run: () => (editing
      ? transportApi.update(Number(id), payload())
      : transportApi.create(payload())),
    success: editing ? "Transport request saved" : "Transport request raised",
    invalidates: [["transport"]],
    onDone: (doc) => nav(`/logistics/transport/${doc.id}`),
  });

  const setLine = (index: number, patch: Partial<TRLineInput>) =>
    setLines((all) => all.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <div>
      <PageHeader
        eyebrow="Logistics"
        title={editing ? `Edit ${existing?.tr_no ?? "request"}` : "New transport request"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/logistics/transport")}>
              Back
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
          </>
        }
      />

      <ErrorBanner error={loadError ?? save.error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold text-ink">Where it goes</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Destination">
              <Input
                value={header.to_location_name}
                placeholder="Site or office name"
                onChange={(e) => setHeader({ ...header, to_location_name: e.target.value })}
              />
            </Field>
            <Field label="From warehouse">
              <Input
                value={header.from_warehouse_name}
                onChange={(e) => setHeader({ ...header, from_warehouse_name: e.target.value })}
              />
            </Field>
            <Field label="Delivery address" hint="What the carrier is given">
              <Input
                value={header.delivery_address}
                onChange={(e) => setHeader({ ...header, delivery_address: e.target.value })}
              />
            </Field>
            <Field label="Against indent" hint="Optional — links the consignment back">
              <Input
                value={header.indent_no}
                onChange={(e) => setHeader({ ...header, indent_no: e.target.value })}
              />
            </Field>
            <Field label="Contact person">
              <Input
                value={header.contact_person}
                onChange={(e) => setHeader({ ...header, contact_person: e.target.value })}
              />
            </Field>
            <Field label="Contact phone">
              <Input
                value={header.contact_phone}
                onChange={(e) => setHeader({ ...header, contact_phone: e.target.value })}
              />
            </Field>
            <Field label="Distance (km)" hint="Used when comparing carrier quotes">
              <Input
                type="number"
                value={header.distance_km}
                onChange={(e) => setHeader({ ...header, distance_km: e.target.value })}
              />
            </Field>
            <Field label="Needed by">
              <Input
                type="date"
                value={header.expected_delivery}
                onChange={(e) => setHeader({ ...header, expected_delivery: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold text-ink">How it travels</h2>
          <Field label="Mode" hint={rule?.help}>
            <Select
              value={mode}
              options={(modes ?? []).map((m) => ({ value: m.value, label: m.label }))}
              onChange={(value) => setMode(value as TransportMode)}
            />
          </Field>

          {/* Only the fields this mode actually uses. A hand-over form asking for a
              vehicle number is how a request gets filled in wrongly. */}
          {rule?.needs_carrier && (
            <Field
              label={rule.needs_quotes ? "Carrier (optional until awarded)" : "Carrier"}
              hint={rule.needs_quotes
                ? "Leave blank — the carrier is chosen from the quotes."
                : undefined}
            >
              <Select
                value={provider.carrier_id}
                placeholder="Choose a transport provider"
                options={(carriers ?? []).map((c) => ({ value: c.id, label: c.name }))}
                onChange={(value) => setProvider({ ...provider, carrier_id: value })}
              />
            </Field>
          )}

          {needs("vehicle_number") && (
            <>
              <Field label="Vehicle number">
                <Input
                  value={provider.vehicle_number}
                  onChange={(e) => setProvider({ ...provider, vehicle_number: e.target.value })}
                />
              </Field>
              <Field label="Driver">
                <Input
                  value={provider.driver_name}
                  onChange={(e) => setProvider({ ...provider, driver_name: e.target.value })}
                />
              </Field>
              <Field label="Driver phone">
                <Input
                  value={provider.driver_phone}
                  onChange={(e) => setProvider({ ...provider, driver_phone: e.target.value })}
                />
              </Field>
              <Field
                label="Trip it rides on"
                hint="The other job the vehicle was already doing"
              >
                <Input
                  value={provider.trip_reference}
                  onChange={(e) => setProvider({ ...provider, trip_reference: e.target.value })}
                />
              </Field>
            </>
          )}

          {needs("handed_over_by_name") && (
            <>
              <Field label="Handed over by">
                <Input
                  value={provider.handed_over_by_name}
                  onChange={(e) => setProvider({ ...provider, handed_over_by_name: e.target.value })}
                />
              </Field>
              <Field label="Received by">
                <Input
                  value={provider.received_by_name}
                  onChange={(e) => setProvider({ ...provider, received_by_name: e.target.value })}
                />
              </Field>
            </>
          )}
        </Card>
      </div>

      <Card className="mt-4 space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">
              What is in the consignment
            </h2>
            <p className="text-xs text-muted">
              Weight and dimensions are what a carrier prices — fill them in before
              inviting quotes.
            </p>
          </div>
          <Button variant="ghost" onClick={() => setLines([...lines, { ...BLANK_LINE }])}>
            Add line
          </Button>
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border border-line/70 p-3 sm:grid-cols-2 lg:grid-cols-7"
            >
              <div className="lg:col-span-2">
                <Field label="Item">
                  <Input
                    value={line.item_name ?? ""}
                    onChange={(e) => setLine(index, { item_name: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Qty">
                <Input
                  type="number"
                  value={line.quantity?.toString() ?? ""}
                  onChange={(e) => setLine(index, { quantity: Number(e.target.value) })}
                />
              </Field>
              <Field label="Packages">
                <Input
                  type="number"
                  value={line.package_count?.toString() ?? ""}
                  onChange={(e) => setLine(index, { package_count: Number(e.target.value) })}
                />
              </Field>
              <Field label="Weight (kg)">
                <Input
                  type="number"
                  value={line.weight_kg?.toString() ?? ""}
                  onChange={(e) => setLine(index, { weight_kg: num(e.target.value) })}
                />
              </Field>
              <Field label="L×W×H (cm)">
                <div className="flex gap-1">
                  <Input
                    type="number"
                    value={line.length_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { length_cm: num(e.target.value) })}
                  />
                  <Input
                    type="number"
                    value={line.width_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { width_cm: num(e.target.value) })}
                  />
                  <Input
                    type="number"
                    value={line.height_cm?.toString() ?? ""}
                    onChange={(e) => setLine(index, { height_cm: num(e.target.value) })}
                  />
                </div>
              </Field>
              <div className="flex items-end justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-body">
                  <input
                    type="checkbox"
                    checked={line.is_fragile ?? false}
                    onChange={(e) => setLine(index, { is_fragile: e.target.checked })}
                  />
                  Fragile
                </label>
                {lines.length > 1 && (
                  <Button
                    variant="ghost"
                    onClick={() => setLines(lines.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
