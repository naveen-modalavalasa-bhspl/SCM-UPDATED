import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Thermometer } from "lucide-react";
import { Button, Can, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { ConfirmModal, ErrorBanner } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, toTimeline } from "../components/Timeline";
import {
  addDispatchEvent, approveDispatch, cancelDispatch, carrierOptions, createDispatch,
  dispatchGateOut, getDispatch, getIssueDispatchSource, issueOptions, itemOptions,
  projectOptions, rejectDispatch, submitDispatch, updateDispatch, vehicleOptions,
  vendorOptions, warehouseOptions,
} from "../api";
import { fmtMoney, fmtQty, num, today } from "../format";
import type { Dispatch, DispatchItemWrite, DispatchWrite } from "../types";

/**
 * Build a consignment, get it approved, and send it out of the gate.
 *
 * Packing and labelling deliberately live on the Outward labelling screen, not here:
 * this form is the commercial document (what, to whom, on which vehicle), and
 * packing is a physical job done later by someone else at a bench.
 *
 * The cold-chain event box is on this screen because a temperature reading has to be
 * recordable the moment it is taken, including after the consignment has left.
 */

const TYPES = [
  { value: "TRANSFER", label: "Stock transfer" },
  { value: "CUSTOMER", label: "To a customer" },
  { value: "VENDOR_RETURN", label: "Vendor return" },
  { value: "PROJECT", label: "To a project site" },
];

const MODES = [
  { value: "ROAD", label: "Road" },
  { value: "RAIL", label: "Rail" },
  { value: "AIR", label: "Air" },
  { value: "SEA", label: "Sea" },
  { value: "COURIER", label: "Courier" },
];

const EVENTS = [
  { value: "PICKED_UP", label: "Picked up" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "TEMPERATURE_CHECK", label: "Temperature check" },
  { value: "DELAYED", label: "Delayed" },
  { value: "DELIVERED", label: "Delivered" },
];

const emptyLine = (): DispatchItemWrite => ({
  item_id: 0,
  batch_id: null,
  serial_no: null,
  quantity: 0,
  rate: null,
  remarks: null,
});

export default function DispatchForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";

  const [form, setForm] = useState<DispatchWrite>({
    dispatch_type: "TRANSFER",
    dispatch_date: today(),
    warehouse_id: 0,
    to_warehouse_id: null,
    customer_id: null,
    vendor_id: null,
    project_id: null,
    delivery_address: "",
    contact_person: "",
    contact_phone: "",
    ref_type: null,
    ref_id: null,
    transport_mode: "ROAD",
    carrier_id: null,
    vehicle_id: null,
    driver_name: "",
    driver_phone: "",
    lr_no: "",
    eway_bill_no: "",
    freight_amount: null,
    expected_delivery: null,
    remarks: "",
    items: [],
  });
  const [confirming, setConfirming] = useState<
    "submit" | "approve" | "reject" | "gate" | "cancel" | null
  >(null);
  const [gatePass, setGatePass] = useState("");
  const [reason, setReason] = useState("");
  const [event, setEvent] = useState({ event_type: "IN_TRANSIT", location_name: "", temperature_c: "", notes: "" });

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-dispatch", id],
    queryFn: () => getDispatch(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      dispatch_type: doc.dispatch_type,
      dispatch_date: doc.dispatch_date,
      warehouse_id: doc.warehouse_id,
      to_warehouse_id: doc.to_warehouse_id ?? null,
      customer_id: doc.customer_id ?? null,
      vendor_id: doc.vendor_id ?? null,
      project_id: doc.project_id ?? null,
      delivery_address: doc.delivery_address ?? "",
      contact_person: doc.contact_person ?? "",
      contact_phone: doc.contact_phone ?? "",
      ref_type: doc.ref_type ?? null,
      ref_id: doc.ref_id ?? null,
      transport_mode: doc.transport_mode ?? "ROAD",
      carrier_id: doc.carrier_id ?? null,
      vehicle_id: doc.vehicle_id ?? null,
      driver_name: doc.driver_name ?? "",
      driver_phone: doc.driver_phone ?? "",
      lr_no: doc.lr_no ?? "",
      eway_bill_no: doc.eway_bill_no ?? "",
      freight_amount: doc.freight_amount ?? null,
      expected_delivery: doc.expected_delivery ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        package_id: l.package_id,
        indent_id: l.indent_id,
        item_id: l.item_id,
        batch_id: l.batch_id,
        serial_no: l.serial_no,
        quantity: num(l.quantity),
        rate: l.rate,
        remarks: l.remarks,
      })),
    });
  }, [doc]);

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof DispatchWrite>(key: K, value: DispatchWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const patchLine = (index: number, patch: Partial<DispatchItemWrite>) =>
    setForm((f) => ({ ...f, items: f.items.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));

  const totals = useMemo(
    () => ({
      lines: form.items.length,
      qty: form.items.reduce((s, l) => s + num(l.quantity), 0),
      value: form.items.reduce((s, l) => s + num(l.quantity) * num(l.rate), 0),
    }),
    [form.items],
  );

  const locked = !!doc && doc.status !== "DRAFT";

  const save = useMutation({
    mutationFn: () => (editing ? updateDispatch(Number(id), form) : createDispatch(form)),
    onSuccess: (saved: Dispatch) => {
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(saved.id)] });
      if (!editing) nav(`../${saved.id}`, { replace: true });
    },
  });

  const pullIssue = useMutation({
    mutationFn: (issueId: number) => getIssueDispatchSource(issueId),
    onSuccess: (source) => {
      setForm((current) => ({
        ...current,
        warehouse_id: source.warehouse_id,
        project_id: source.project_id ?? current.project_id,
        ref_type: "WH_ISSUE",
        ref_id: source.issue_id,
        items: source.items,
      }));
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wh-dispatch", id] });
    qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
  };

  const act = useMutation({
    mutationFn: (what: "submit" | "approve" | "reject" | "gate" | "cancel") => {
      const numId = Number(id);
      if (what === "submit") return submitDispatch(numId);
      if (what === "approve") return approveDispatch(numId, reason);
      if (what === "reject") return rejectDispatch(numId, reason);
      if (what === "gate") return dispatchGateOut(numId, gatePass || undefined);
      return cancelDispatch(numId, reason || undefined);
    },
    onSuccess: () => {
      invalidate();
      setConfirming(null);
    },
  });

  const logEvent = useMutation({
    mutationFn: () =>
      addDispatchEvent(Number(id), {
        event_type: event.event_type,
        location_name: event.location_name || null,
        temperature_c: event.temperature_c === "" ? null : Number(event.temperature_c),
        notes: event.notes || null,
      }),
    onSuccess: () => {
      invalidate();
      setEvent({ event_type: "IN_TRANSIT", location_name: "", temperature_c: "", notes: "" });
    },
  });

  const columns: LineColumn<DispatchItemWrite>[] = [
    {
      key: "item",
      header: "Item",
      render: (l, i) => {
        const saved = savedLine(i);
        if (saved) {
          return (
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-semibold text-ink">{saved.item_code ?? "—"}</div>
              <div className="truncate text-xs text-muted">{saved.item_name ?? "—"}</div>
            </div>
          );
        }
        return (
          <Lookup
            name="items"
            load={itemOptions}
            value={l.item_id || ""}
            onChange={(v) => patchLine(i, { item_id: v === "" ? 0 : v })}
            placeholder="Pick an item"
          />
        );
      },
    },
    {
      key: "qty",
      header: "Quantity",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Quantity, line ${i + 1}`}
          value={l.quantity}
          disabled={locked}
          onChange={(v) => patchLine(i, { quantity: v })}
        />
      ),
    },
    {
      key: "delivered",
      header: "Delivered",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (_l, i) => (
        <span className="tabular text-muted">{fmtQty(savedLine(i)?.delivered_qty ?? 0)}</span>
      ),
    },
    {
      key: "serial",
      header: "Serial",
      width: "w-36",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Serial, line ${i + 1}`}
          value={l.serial_no}
          disabled={locked}
          onChange={(v) => patchLine(i, { serial_no: v })}
        />
      ),
    },
    {
      key: "rate",
      header: "Rate",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Rate, line ${i + 1}`}
          value={l.rate ?? 0}
          disabled={locked}
          onChange={(v) => patchLine(i, { rate: v })}
        />
      ),
    },
    {
      key: "package",
      header: "Package",
      width: "w-28",
      hideOnNarrow: true,
      render: (_l, i) => {
        const pkg = doc?.packages?.find((p) => p.id === savedLine(i)?.package_id);
        return <span className="text-xs text-muted">{pkg?.package_no ?? "unpacked"}</span>;
      },
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title={editing ? `Dispatch ${doc?.dispatch_no ?? ""}` : "New dispatch"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("..")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="dispatch.create">
                <Button variant="subtle" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && doc?.status === "DRAFT" && (
              <Can do="dispatch.create">
                <Button onClick={() => setConfirming("submit")}>Submit for approval</Button>
              </Can>
            )}
            {editing && doc?.status === "PENDING_APPROVAL" && (
              <Can do="dispatch.approve">
                <Button variant="subtle" onClick={() => setConfirming("approve")}>Approve</Button>
                <Button variant="danger" onClick={() => setConfirming("reject")}>Reject</Button>
              </Can>
            )}
            {editing && ["APPROVED", "PACKED"].includes(doc?.status ?? "") && (
              <Can do="dispatch.gate_out">
                <Button onClick={() => setConfirming("gate")}>Gate out</Button>
              </Can>
            )}
            {editing && doc && !["CANCELLED", "ACKNOWLEDGED", "DELIVERED"].includes(doc.status) && (
              <Can do="dispatch.approve">
                <Button variant="danger" onClick={() => setConfirming("cancel")}>Cancel</Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? pullIssue.error} />

      {doc && (
        <MetaCard title="Consignment">
          <MetaRow label="Number" value={<span className="font-mono">{doc.dispatch_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Gate pass" value={<span className="font-mono">{doc.gate_pass_no ?? "—"}</span>} />
          <MetaRow label="Packages" value={doc.total_packages} />
          <MetaRow label="Weight" value={`${fmtQty(doc.total_weight_kg)} kg`} />
          <MetaRow label="Approved by" value={doc.approved_by_name} />
          <MetaRow label="Acknowledged by" value={doc.acknowledged_by_name} />
          <MetaRow
            label="POD"
            value={
              doc.pod_url ? (
                <a href={doc.pod_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  View
                </a>
              ) : "—"
            }
          />
        </MetaCard>
      )}

      <Section title="Destination">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={form.dispatch_date} disabled={locked}
                   onChange={(e) => set("dispatch_date", e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={form.dispatch_type} onChange={(v) => set("dispatch_type", v)} options={TYPES}
                    isDisabled={locked} ariaLabel="Dispatch type" />
          </Field>
          <Field label="From warehouse">
            <Lookup name="warehouses" load={warehouseOptions} value={form.warehouse_id || ""} isDisabled={locked}
                    onChange={(v) => set("warehouse_id", v === "" ? 0 : v)} placeholder="Origin" />
          </Field>
          <Field label="To warehouse">
            <Lookup name="warehouses" load={warehouseOptions} value={form.to_warehouse_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("to_warehouse_id", v === "" ? null : v)} placeholder="Destination site" />
          </Field>
          <Field label="Vendor">
            <Lookup name="vendors" load={vendorOptions} value={form.vendor_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("vendor_id", v === "" ? null : v)} placeholder="Vendor" />
          </Field>
          <Field label="Project">
            <Lookup name="projects" load={projectOptions} value={form.project_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("project_id", v === "" ? null : v)} placeholder="Project" />
          </Field>
          <Field label="Against posted issue" hint="Optional; avoids moving stock twice.">
            <Lookup name="posted-issues" load={issueOptions} value={form.ref_id ?? ""} isDisabled={locked}
                    onChange={(v) => {
                      const issueId = v === "" ? null : v;
                      setForm((current) => ({
                        ...current,
                        ref_type: issueId ? "WH_ISSUE" : null,
                        ref_id: issueId,
                      }));
                      if (issueId) pullIssue.mutate(issueId);
                    }} placeholder="Material issue" />
          </Field>
          <Field label="Expected delivery">
            <Input type="date" value={form.expected_delivery ?? ""} disabled={locked}
                   onChange={(e) => set("expected_delivery", e.target.value || null)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Delivery address">
              <Input value={form.delivery_address ?? ""} disabled={locked}
                     onChange={(e) => set("delivery_address", e.target.value)} />
            </Field>
          </div>
          <Field label="Contact person">
            <Input value={form.contact_person ?? ""} disabled={locked}
                   onChange={(e) => set("contact_person", e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <Input value={form.contact_phone ?? ""} disabled={locked}
                   onChange={(e) => set("contact_phone", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="Transport">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Mode">
            <Select value={form.transport_mode ?? "ROAD"} onChange={(v) => set("transport_mode", v)}
                    options={MODES} isDisabled={locked} ariaLabel="Transport mode" />
          </Field>
          <Field label="Carrier">
            <Lookup name="carriers" load={carrierOptions} value={form.carrier_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("carrier_id", v === "" ? null : v)} placeholder="Carrier" />
          </Field>
          <Field label="Vehicle">
            <Lookup name="vehicles" load={vehicleOptions} value={form.vehicle_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("vehicle_id", v === "" ? null : v)} placeholder="Vehicle" />
          </Field>
          <Field label="Driver">
            <Input value={form.driver_name ?? ""} disabled={locked}
                   onChange={(e) => set("driver_name", e.target.value)} />
          </Field>
          <Field label="Driver phone">
            <Input value={form.driver_phone ?? ""} disabled={locked}
                   onChange={(e) => set("driver_phone", e.target.value)} />
          </Field>
          <Field label="LR no">
            <Input value={form.lr_no ?? ""} disabled={locked} onChange={(e) => set("lr_no", e.target.value)} />
          </Field>
          <Field label="E-way bill">
            <Input value={form.eway_bill_no ?? ""} disabled={locked}
                   onChange={(e) => set("eway_bill_no", e.target.value)} />
          </Field>
          <Field label="Freight">
            <Input
              type="number"
              value={form.freight_amount == null ? "" : String(form.freight_amount)}
              disabled={locked}
              onChange={(e) => set("freight_amount", e.target.value === "" ? null : Number(e.target.value))}
            />
          </Field>
        </div>
      </Section>

      <Section title="Lines">
        <LinesEditor
          rows={form.items}
          columns={columns}
          keyOf={(_, i) => i}
          onAdd={locked ? undefined : () => set("items", [...form.items, emptyLine()])}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          empty="Add what is going on the vehicle."
          footer={
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{totals.lines} lines</span>
              <span className="text-ink">Qty <b className="tabular">{fmtQty(totals.qty)}</b></span>
              <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
            </div>
          }
        />
      </Section>

      {doc && (
        <Section
          title="Custody trail"
          hint="Every scan, stop and temperature reading, in order."
          actions={
            <Can do="dispatch.view">
              <Button variant="subtle" onClick={() => logEvent.mutate()} disabled={logEvent.isPending}>
                {logEvent.isPending ? "Recording…" : "Record event"}
              </Button>
            </Can>
          }
        >
          <ErrorBanner error={logEvent.error} />

          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Event">
              <Select
                value={event.event_type}
                onChange={(v) => setEvent((e) => ({ ...e, event_type: v }))}
                options={EVENTS}
                ariaLabel="Event type"
              />
            </Field>
            <Field label="Location">
              <Input value={event.location_name}
                     onChange={(e) => setEvent((v) => ({ ...v, location_name: e.target.value }))} />
            </Field>
            <Field label="Temperature (°C)">
              <Input type="number" value={event.temperature_c}
                     onChange={(e) => setEvent((v) => ({ ...v, temperature_c: e.target.value }))} />
            </Field>
            <Field label="Notes">
              <Input value={event.notes} onChange={(e) => setEvent((v) => ({ ...v, notes: e.target.value }))} />
            </Field>
          </div>

          {doc.events?.some((e) => e.is_breach) && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
              <Thermometer className="h-4 w-4" /> This consignment has a recorded temperature breach.
            </div>
          )}

          <Timeline entries={toTimeline(doc.events)} empty="No events recorded for this consignment." />
        </Section>
      )}

      <Section title="Documents" hint="LR copy, e-way bill, proof of delivery.">
        <AttachmentsPanel entityType="DISPATCH" entityId={doc?.id} category="DISPATCH" />
      </Section>

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for approval?"
        message="The consignment goes to the approval chain and can no longer be edited."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "approve" || confirming === "reject"}
        title={confirming === "approve" ? "Approve this dispatch?" : "Reject this dispatch?"}
        message="This records your decision in the shared approval history."
        confirmLabel={confirming === "approve" ? "Approve" : "Reject"}
        danger={confirming === "reject"}
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate(confirming === "approve" ? "approve" : "reject")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Comments">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "gate"}
        title="Send it out of the gate?"
        message="The consignment is marked dispatched and security records the gate pass."
        confirmLabel="Gate out"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("gate")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Gate pass no">
            <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "cancel"}
        title="Cancel this dispatch?"
        message="The consignment stops here."
        confirmLabel="Cancel dispatch"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("cancel")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}
