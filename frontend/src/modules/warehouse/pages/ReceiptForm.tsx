import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ScanLine } from "lucide-react";
import { Button, Can, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { ConfirmModal, ErrorBanner } from "../components/Feedback";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { DateInput, LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  binOptions, completeReceipt, createReceipt, getPoLines, getReceipt, itemOptions, poOptions,
  projectOptions, submitReceipt, updateReceipt, vendorOptions, warehouseOptions,
} from "../api";
import { fmtMoney, fmtQty, num, today } from "../format";
import type { Receipt, ReceiptItemWrite, ReceiptWrite } from "../types";

/**
 * One form for both a gate entry and a GRN — they are one `inb_receipts` row at two
 * points in its life, so splitting them into two screens meant retyping the vehicle,
 * the LR and the invoice at the second one.
 *
 * `receipt_type` decides how much of the form is on show: a gate entry captures the
 * paperwork and the vehicle; a GRN adds the counted quantities, batches and bins.
 *
 * Quantities are the load-bearing part. `received_qty` is what came off the vehicle,
 * `accepted_qty` is what you are keeping, and `rejected_qty` is derived — never
 * typed — so the three can never disagree. `short_qty` is likewise derived from the
 * ordered quantity, which is why a PO-backed line shows it and a free line does not.
 */

const emptyLine = (): ReceiptItemWrite => ({
  item_id: 0,
  ordered_qty: 0,
  received_qty: 0,
  accepted_qty: 0,
  rejected_qty: 0,
  rate: null,
  batch_no: null,
  mfg_date: null,
  expiry_date: null,
  bin_id: null,
  remarks: null,
  serial_numbers: null,
});

export default function ReceiptForm({ mode }: { mode: "GATE_ENTRY" | "PURCHASE" }) {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const isGrn = mode === "PURCHASE";

  const [form, setForm] = useState<ReceiptWrite>({
    receipt_type: mode,
    grn_date: today(),
    po_id: null,
    vendor_id: null,
    warehouse_id: 0,
    project_id: null,
    invoice_no: "",
    invoice_date: null,
    invoice_amount: null,
    eway_bill_no: "",
    vehicle_no: "",
    transporter_name: "",
    lr_no: "",
    gate_entry_no: "",
    remarks: "",
    items: [],
  });
  const [touched, setTouched] = useState(false);
  const [serialLine, setSerialLine] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"submit" | "complete" | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-receipt", id],
    queryFn: () => getReceipt(Number(id)),
    enabled: editing,
  });

  /** Loading a saved receipt back into the editable shape. */
  useEffect(() => {
    if (!doc) return;
    setForm({
      receipt_type: doc.receipt_type,
      grn_date: doc.grn_date,
      po_id: doc.po_id ?? null,
      vendor_id: doc.vendor_id ?? null,
      warehouse_id: doc.warehouse_id,
      project_id: doc.project_id ?? null,
      invoice_no: doc.invoice_no ?? "",
      invoice_date: doc.invoice_date ?? null,
      invoice_amount: doc.invoice_amount ?? null,
      eway_bill_no: doc.eway_bill_no ?? "",
      vehicle_no: doc.vehicle_no ?? "",
      transporter_name: doc.transporter_name ?? "",
      lr_no: doc.lr_no ?? "",
      gate_entry_no: doc.gate_entry_no ?? "",
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        po_item_id: l.po_item_id,
        indent_id: l.indent_id,
        item_id: l.item_id,
        ordered_qty: num(l.ordered_qty),
        received_qty: num(l.received_qty),
        accepted_qty: num(l.accepted_qty),
        rejected_qty: num(l.rejected_qty),
        rate: l.rate,
        batch_no: l.batch_no,
        mfg_date: l.mfg_date,
        expiry_date: l.expiry_date,
        bin_id: l.bin_id || null,
        rejection_reason: l.rejection_reason,
        remarks: l.remarks,
        serial_numbers: l.serial_numbers,
      })),
    });
  }, [doc]);

  /** Snapshot labels for lines loaded from the server, so the grid needs no joins. */
  const savedLine = (index: number) => doc?.items?.[index];

  /** Pulling a PO in replaces the lines with its open ones. */
  const poLines = useMutation({
    mutationFn: (poId: number) => getPoLines(poId),
    onSuccess: (lines) =>
      setForm((f) => ({
        ...f,
        items: lines.map((l) => ({
          ...emptyLine(),
          po_item_id: l.po_item_id,
          item_id: l.item_id,
          indent_id: l.indent_id ?? null,
          ordered_qty: num(l.pending_qty),
          received_qty: num(l.pending_qty),
          accepted_qty: num(l.pending_qty),
          rate: l.rate ?? null,
        })),
      })),
  });

  const set = <K extends keyof ReceiptWrite>(key: K, value: ReceiptWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** Every line edit runs through here so the derived quantities stay derived. */
  const patchLine = (index: number, patch: Partial<ReceiptItemWrite>) =>
    setForm((f) => {
      const items = f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        const received = num(next.received_qty);
        // Accepted can never exceed what arrived; rejected is the remainder.
        const accepted = Math.min(num(next.accepted_qty), received);
        return { ...next, accepted_qty: accepted, rejected_qty: Math.max(received - accepted, 0) };
      });
      return { ...f, items };
    });

  const totals = useMemo(() => {
    const rows = form.items;
    return {
      lines: rows.length,
      received: rows.reduce((s, l) => s + num(l.received_qty), 0),
      accepted: rows.reduce((s, l) => s + num(l.accepted_qty), 0),
      rejected: rows.reduce((s, l) => s + num(l.rejected_qty), 0),
      value: rows.reduce((s, l) => s + num(l.accepted_qty) * num(l.rate), 0),
    };
  }, [form.items]);

  const locked = !!doc && !["DRAFT", "GATE_ENTRY"].includes(doc.status);

  const save = useMutation({
    mutationFn: () => (editing ? updateReceipt(Number(id), form) : createReceipt(form)),
    onSuccess: (saved: Receipt) => {
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      qc.invalidateQueries({ queryKey: ["wh-gate-entries"] });
      qc.invalidateQueries({ queryKey: ["wh-receipt", String(saved.id)] });
      if (!editing) nav(`../${saved.id}`, { replace: true });
    },
  });

  const act = useMutation({
    mutationFn: (what: "submit" | "complete") =>
      what === "submit" ? submitReceipt(Number(id)) : completeReceipt(Number(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-receipt", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      setConfirming(null);
    },
  });

  const invalid = {
    warehouse: touched && !form.warehouse_id,
    lines: touched && isGrn && form.items.length === 0,
  };

  const submitSave = () => {
    setTouched(true);
    if (!form.warehouse_id) return;
    if (isGrn && form.items.length === 0) return;
    save.mutate();
  };

  const columns: LineColumn<ReceiptItemWrite>[] = [
    {
      key: "item",
      header: "Item",
      render: (l, i) => {
        const saved = savedLine(i);
        // A saved line already carries its snapshot code/name; only a new line needs
        // the picker, and a PO-backed line is never repointed at another item.
        if (saved || l.po_item_id) {
          return (
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-semibold text-ink">
                {saved?.item_code ?? "—"}
              </div>
              <div className="truncate text-xs text-muted">{saved?.item_name ?? "PO line"}</div>
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
      key: "ordered",
      header: "Ordered",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (l) => <span className="tabular text-muted">{l.ordered_qty ? fmtQty(l.ordered_qty) : "—"}</span>,
    },
    {
      key: "received",
      header: "Received",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Received quantity, line ${i + 1}`}
          value={l.received_qty}
          disabled={locked || !isGrn}
          onChange={(v) => patchLine(i, { received_qty: v, accepted_qty: v })}
        />
      ),
    },
    {
      key: "accepted",
      header: "Accepted",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Accepted quantity, line ${i + 1}`}
          value={l.accepted_qty ?? 0}
          max={num(l.received_qty)}
          disabled={locked || !isGrn}
          invalid={num(l.accepted_qty) > num(l.received_qty)}
          onChange={(v) => patchLine(i, { accepted_qty: v })}
        />
      ),
    },
    {
      key: "rejected",
      header: "Rejected",
      numeric: true,
      width: "w-24",
      render: (l) => (
        <span className={`tabular ${num(l.rejected_qty) > 0 ? "font-semibold text-bad" : "text-muted"}`}>
          {fmtQty(l.rejected_qty)}
        </span>
      ),
    },
    {
      key: "batch",
      header: "Batch",
      width: "w-32",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Batch, line ${i + 1}`}
          value={l.batch_no}
          disabled={locked || !isGrn}
          placeholder="Batch no"
          onChange={(v) => patchLine(i, { batch_no: v })}
        />
      ),
    },
    {
      key: "expiry",
      header: "Expiry",
      width: "w-36",
      hideOnNarrow: true,
      render: (l, i) => (
        <DateInput
          ariaLabel={`Expiry, line ${i + 1}`}
          value={l.expiry_date}
          disabled={locked || !isGrn}
          onChange={(v) => patchLine(i, { expiry_date: v || null })}
        />
      ),
    },
    {
      key: "bin",
      header: "Bin",
      width: "w-40",
      hideOnNarrow: true,
      render: (l, i) => (
        <Lookup
          name={`bins-${form.warehouse_id}`}
          load={(s) => binOptions(form.warehouse_id, s)}
          value={l.bin_id ?? ""}
          isDisabled={locked || !isGrn || !form.warehouse_id}
          onChange={(v) => patchLine(i, { bin_id: v === "" ? null : v })}
          placeholder="Bin"
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
      key: "serials",
      header: "Serials",
      width: "w-28",
      hideOnNarrow: true,
      render: (l, i) => (
        <Button variant="ghost" onClick={() => setSerialLine(i)} disabled={!isGrn}>
          <ScanLine className="h-4 w-4" />
          {l.serial_numbers?.length ? `${l.serial_numbers.length}` : "Add"}
        </Button>
      ),
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const label = isGrn ? "GRN" : "Gate entry";

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title={editing ? `${label} ${doc?.grn_no ?? ""}` : `New ${label.toLowerCase()}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("..")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="grn.create">
                <Button variant="subtle" onClick={submitSave} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && isGrn && doc?.status === "DRAFT" && (
              <Can do="grn.create">
                <Button onClick={() => setConfirming("submit")}>Submit for QC</Button>
              </Can>
            )}
            {editing && isGrn && ["QC_PASSED", "SUBMITTED"].includes(doc?.status ?? "") && !doc?.is_stock_posted && (
              <Can do="grn.qc">
                <Button onClick={() => setConfirming("complete")}>Post to stock</Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? poLines.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.grn_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Received by" value={doc.received_by_name} />
          <MetaRow label="Stock" value={doc.is_stock_posted ? "Posted" : "Not posted"} />
        </MetaCard>
      )}

      <Section title="Consignment">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input
              type="date"
              value={form.grn_date}
              disabled={locked}
              onChange={(e) => set("grn_date", e.target.value)}
            />
          </Field>
          <Field label="Warehouse">
            <Lookup
              name="warehouses"
              load={warehouseOptions}
              value={form.warehouse_id || ""}
              isDisabled={locked}
              onChange={(v) => set("warehouse_id", v === "" ? 0 : v)}
              placeholder="Receiving warehouse"
              isInvalid={invalid.warehouse}
              errorMessage={invalid.warehouse ? "Pick the receiving warehouse." : undefined}
            />
          </Field>
          <Field label="Purchase order" hint={isGrn ? "Picking a PO fills the lines." : undefined}>
            <Lookup
              name="purchase-orders"
              load={poOptions}
              value={form.po_id ?? ""}
              isDisabled={locked}
              onChange={(v) => {
                set("po_id", v === "" ? null : v);
                if (v !== "" && isGrn) poLines.mutate(v);
              }}
              placeholder="Against PO"
            />
          </Field>
          <Field label="Vendor">
            <Lookup
              name="vendors"
              load={vendorOptions}
              value={form.vendor_id ?? ""}
              isDisabled={locked}
              onChange={(v) => set("vendor_id", v === "" ? null : v)}
              placeholder="Vendor"
            />
          </Field>
          <Field label="Project">
            <Lookup
              name="projects"
              load={projectOptions}
              value={form.project_id ?? ""}
              isDisabled={locked}
              onChange={(v) => set("project_id", v === "" ? null : v)}
              placeholder="Project"
            />
          </Field>
        </div>
      </Section>

      <Section title="Paperwork" hint="Captured once at the gate and carried onto the GRN.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Gate entry no">
            <Input value={form.gate_entry_no ?? ""} disabled={locked}
                   onChange={(e) => set("gate_entry_no", e.target.value)} />
          </Field>
          <Field label="Vehicle no">
            <Input value={form.vehicle_no ?? ""} disabled={locked}
                   onChange={(e) => set("vehicle_no", e.target.value.toUpperCase())} />
          </Field>
          <Field label="Transporter">
            <Input value={form.transporter_name ?? ""} disabled={locked}
                   onChange={(e) => set("transporter_name", e.target.value)} />
          </Field>
          <Field label="LR no">
            <Input value={form.lr_no ?? ""} disabled={locked} onChange={(e) => set("lr_no", e.target.value)} />
          </Field>
          <Field label="Invoice no">
            <Input value={form.invoice_no ?? ""} disabled={locked}
                   onChange={(e) => set("invoice_no", e.target.value)} />
          </Field>
          <Field label="Invoice date">
            <Input type="date" value={form.invoice_date ?? ""} disabled={locked}
                   onChange={(e) => set("invoice_date", e.target.value || null)} />
          </Field>
          <Field label="Invoice amount">
            <Input
              type="number"
              value={form.invoice_amount == null ? "" : String(form.invoice_amount)}
              disabled={locked}
              onChange={(e) => set("invoice_amount", e.target.value === "" ? null : Number(e.target.value))}
            />
          </Field>
          <Field label="E-way bill">
            <Input value={form.eway_bill_no ?? ""} disabled={locked}
                   onChange={(e) => set("eway_bill_no", e.target.value)} />
          </Field>
        </div>
      </Section>

      {isGrn && (
        <Section
          title="Lines"
          hint="Rejected is received minus accepted — it is never typed, so the three can never disagree."
        >
          {invalid.lines && <ErrorBanner error="Add at least one line before saving." />}
          <LinesEditor
            rows={form.items}
            columns={columns}
            keyOf={(_, i) => i}
            onAdd={locked ? undefined : () => set("items", [...form.items, emptyLine()])}
            onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
            rowTone={(l) => (num(l.rejected_qty) > 0 ? "bg-bad-bg/40" : undefined)}
            empty="Pick a purchase order above, or add lines by hand."
            footer={
              <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                <span className="text-muted">{totals.lines} lines</span>
                <span className="text-ink">Received <b className="tabular">{fmtQty(totals.received)}</b></span>
                <span className="text-ok">Accepted <b className="tabular">{fmtQty(totals.accepted)}</b></span>
                <span className={totals.rejected > 0 ? "text-bad" : "text-muted"}>
                  Rejected <b className="tabular">{fmtQty(totals.rejected)}</b>
                </span>
                <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
              </div>
            }
          />
        </Section>
      )}

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      <Section title="Documents" hint="Invoice copy, LR slip, packing list, weighbridge ticket.">
        <AttachmentsPanel entityType="RECEIPT" entityId={doc?.id} category="INWARD" readOnly={locked} />
      </Section>

      <SerialNumbersModal
        isOpen={serialLine !== null}
        onClose={() => setSerialLine(null)}
        quantity={serialLine === null ? 0 : num(form.items[serialLine]?.accepted_qty)}
        initial={serialLine === null ? [] : form.items[serialLine]?.serial_numbers ?? []}
        itemLabel={serialLine === null ? "" : savedLine(serialLine)?.item_name ?? `Line ${serialLine + 1}`}
        readOnly={locked}
        onSave={(serials) => serialLine !== null && patchLine(serialLine, { serial_numbers: serials })}
      />

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for inspection?"
        message="The lines are frozen and an inspection is raised against this receipt."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "complete"}
        title="Post accepted quantity to stock?"
        message={`${fmtQty(totals.accepted)} will be added to stock and putaway tasks raised for it. Stock movements cannot be undone — a mistake is corrected with an adjustment, not a delete.`}
        confirmLabel="Post to stock"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("complete")}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
