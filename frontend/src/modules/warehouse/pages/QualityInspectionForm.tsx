import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, Plus, ScanLine, Trash2 } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  cancelInspection, completeInspection, createInspection, employeeOptions, getInspection,
  getReceipt, grnOptions,
  updateInspection, warehouseOptions,
} from "../api";
import { fmtQty, num, percent, today } from "../format";
import { alerts } from "@/modules/alerts";
import { useAuth } from "@/shared/auth/AuthContext";
import type {
  Inspection, InspectionItemWrite, InspectionParameter, InspectionWrite, Receipt,
} from "../types";
import { usePointLabel } from "../usePointLabel";

/**
 * Inspect a receipt line by line.
 *
 * Picking the GRN pulls its lines in with their received quantities — an inspection
 * typed from scratch is how quantities came to disagree with the receipt they were
 * supposedly inspecting.
 *
 * `result` is derived from the split, not chosen: all accepted is a pass, all
 * rejected is a fail, anything between is partial. A per-line parameter table
 * (`parameters` JSON) records what was actually measured, because "failed" without a
 * reading is not something a vendor can be held to.
 */

const RESULTS = [
  { value: "PENDING", label: "Pending" },
  { value: "PASSED", label: "Passed" },
  { value: "FAILED", label: "Failed" },
  { value: "PARTIAL", label: "Partial" },
];

const deriveResult = (inspected: number, accepted: number): InspectionItemWrite["result"] => {
  if (inspected <= 0) return "PENDING";
  if (accepted >= inspected) return "PASSED";
  if (accepted <= 0) return "FAILED";
  return "PARTIAL";
};

export default function QualityInspectionForm({
  type = "INCOMING",
}: {
  type?: "INCOMING" | "OUTGOING";
}) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  /* Absolute: this screen is mounted at two depths, so `".."` resolved against the
   * matched route and Back landed somewhere different depending on the entry URL. */
  const listPath = type === "OUTGOING" ? "/warehouse/qc-outward" : "/warehouse/quality-inspection";

  const [form, setForm] = useState<InspectionWrite>({
    inspection_date: today(),
    receipt_id: null,
    warehouse_id: null,
    inspection_type: type,
    inspector_id: null,
    remarks: "",
    items: [],
  });
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pulled, setPulled] = useState<Receipt | null>(null);
  const [paramsFor, setParamsFor] = useState<number | null>(null);
  const [serialsFor, setSerialsFor] = useState<number | null>(null);

  /* The inspector is whoever is standing at the bench. Left at "pick one" it was a
   * list of every active employee in HCM with the person actually inspecting somewhere
   * in it, so a signed inspection could carry anybody's name. Prefilled from the
   * login, and once only — same rule as the receiving point: clearing it to name a
   * colleague must not have it written straight back. Still editable; a bench where
   * one person inspects and another signs off is a real arrangement. */
  const { me } = useAuth();
  const prefilledInspector = useRef(false);
  useEffect(() => {
    if (editing || prefilledInspector.current || form.inspector_id || !me) return;
    prefilledInspector.current = true;
    setForm((f) => ({ ...f, inspector_id: me.employee.id }));
  }, [editing, form.inspector_id, me]);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-inspection", id],
    queryFn: () => getInspection(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      inspection_date: doc.inspection_date,
      receipt_id: doc.receipt_id ?? null,
      warehouse_id: doc.warehouse_id ?? null,
      inspection_type: doc.inspection_type,
      inspector_id: doc.inspector_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        receipt_item_id: l.receipt_item_id,
        item_id: l.item_id,
        batch_no: l.batch_no,
        inspected_qty: num(l.inspected_qty),
        accepted_qty: num(l.accepted_qty),
        rejected_qty: num(l.rejected_qty),
        parameters: l.parameters ?? [],
        result: l.result,
        defect_type: l.defect_type,
        rejection_reason: l.rejection_reason ?? l.defect_type,
        remarks: l.remarks,
        // Left null when the line carries no decision yet — the picker reads that as
        // "nothing rejected", where [] would mean "every unit rejected".
        serial_numbers: l.serial_numbers ?? null,
      })),
    });
  }, [doc]);

  /* The GRN's serials, by receipt line. They were read off the units at goods receipt,
   * so inspection picks from them: a serial typed here is one that was never received,
   * and completion rejects any accepted serial that is not on the GRN. */
  const { data: grn } = useQuery({
    queryKey: ["wh-receipt", String(doc?.receipt_id ?? "")],
    queryFn: () => getReceipt(Number(doc?.receipt_id)),
    enabled: !!doc?.receipt_id,
  });

  const grnSerials = useMemo(() => {
    const byLine = new Map<number, string[]>();
    for (const line of grn?.items ?? []) byLine.set(line.id, line.serial_numbers ?? []);
    return byLine;
  }, [grn]);

  /** The GRN serials behind an inspection line. Serial-tracked items must already have
   *  these from goods receipt, so QC selects accepted units from this list. */
  const availableSerials = (index: number | null) => {
    if (index === null) return null;
    const receiptItemId = form.items[index]?.receipt_item_id;
    const serials = receiptItemId ? grnSerials.get(receiptItemId) : undefined;
    return serials?.length ? serials : null;
  };

  /** The delivery being inspected: the receipt loaded off a saved inspection, or the
   *  one just pulled in on a new one. QC was showing the lines and nothing about where
   *  they came from, so an inspector could not see the order, the vendor or the invoice
   *  the goods arrived on without opening the GRN in another tab. */
  const delivery = grn ?? pulled;

  /** Pulling the receipt in seeds the lines from what was actually received. */
  const pullReceipt = useMutation({
    mutationFn: (receiptId: number) => getReceipt(receiptId),
    onSuccess: (receipt) => {
      setPulled(receipt);
      setForm((f) => ({
        ...f,
        warehouse_id: receipt.warehouse_id,
        items: (receipt.items ?? []).map((l) => ({
          receipt_item_id: l.id,
          item_id: l.item_id,
          // Carried through so the line can name itself before the first save.
          item_code: l.item_code,
          item_name: l.item_name,
          batch_no: l.batch_no,
          inspected_qty: num(l.received_qty),
          accepted_qty: num(l.received_qty),
          rejected_qty: 0,
          parameters: [],
          result: "PASSED" as const,
          defect_type: null,
          rejection_reason: null,
          remarks: null,
          serial_numbers: l.serial_numbers ?? [],
        })),
      }));
    },
  });

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof InspectionWrite>(key: K, value: InspectionWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const patchLine = (index: number, patch: Partial<InspectionItemWrite>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        const inspected = num(next.inspected_qty);
        const accepted = Math.min(num(next.accepted_qty), inspected);
        return {
          ...next,
          accepted_qty: accepted,
          rejected_qty: Math.max(inspected - accepted, 0),
          // An explicitly chosen result wins; otherwise it follows the split.
          result: patch.result ?? deriveResult(inspected, accepted),
        };
      }),
    }));

  /** A line is seeded PENDING when the receipt raises the inspection, and the server
   *  derives its real result from the accepted/inspected split on save
   *  (`_derive_result`). Counting the stored PENDING as neither pass nor fail is how
   *  the confirm modal announced "0 pass, 0 fail" over a full sheet of accepted lines.
   *  Count what the save is about to write, by the same rule. */
  const resultOf = (line: InspectionItemWrite) =>
    line.result && line.result !== "PENDING"
      ? line.result
      : deriveResult(num(line.inspected_qty), num(line.accepted_qty));

  const totals = useMemo(
    () => ({
      lines: form.items.length,
      passed: form.items.filter((l) => resultOf(l) === "PASSED").length,
      failed: form.items.filter((l) => resultOf(l) === "FAILED").length,
      partial: form.items.filter((l) => resultOf(l) === "PARTIAL").length,
      inspected: form.items.reduce((s, l) => s + num(l.inspected_qty), 0),
      rejected: form.items.reduce((s, l) => s + num(l.rejected_qty), 0),
    }),
    [form.items],
  );

  const locked = !!doc && doc.status !== "DRAFT" && doc.status !== "IN_PROGRESS";

  const validateAcceptedSerials = () => {
    for (const [index, line] of form.items.entries()) {
      const available = availableSerials(index);
      if (!available) continue;
      const required = Math.floor(num(line.accepted_qty));
      if (num(line.accepted_qty) !== required) {
        throw new Error(`Line ${index + 1}: accepted quantity must be a whole number for serialized items.`);
      }
      const actual = line.serial_numbers?.length ?? available.length;
      if (actual !== required) {
        throw new Error(`Line ${index + 1}: select exactly ${required} accepted serial numbers.`);
      }
    }
  };

  const save = useMutation({
    mutationFn: () => {
      validateAcceptedSerials();
      return editing ? updateInspection(Number(id), form) : createInspection(form);
    },
    onSuccess: (saved: Inspection) => {
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-inspection", String(saved.id)] });
      if (!editing) nav(`${listPath}/${saved.id}`, { replace: true });
    },
  });

  const complete = useMutation({
    /* Save first. The server refuses to complete while any *saved* line is PENDING, and
     * a line is seeded PENDING when the receipt raises the inspection — so an inspector
     * who filled the grid and pressed Complete was told the lines were still pending
     * while the confirm modal in front of them counted their own unsaved passes. */
    mutationFn: async () => {
      validateAcceptedSerials();
      await updateInspection(Number(id), form);
      return completeInspection(Number(id));
    },
    onSuccess: () => {
      void alerts.success("inspection.completed", {
        number: doc?.inspection_no ?? "The inspection",
      });
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      setConfirming(false);
    },
  });

  /* Cancelling hands the GRN back: the server walks an untouched receipt out of
   * PENDING_QC to DRAFT, which is the only way to correct lines — serials above all —
   * once the receipt has been submitted. */
  const cancel = useMutation({
    mutationFn: () => cancelInspection(Number(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      setCancelling(false);
    },
  });

  const columns: LineColumn<InspectionItemWrite>[] = [
    {
      key: "item",
      header: "Item",
      render: (l, i) => {
        const saved = savedLine(i);
        return (
          <div className="min-w-0">
            {/* Saved snapshot first, then what the GRN pull carried in. Only a line
                with neither falls back to the id. */}
            <div className="truncate font-mono text-xs font-semibold text-ink">
              {saved?.item_code ?? l.item_code ?? `Item ${l.item_id}`}
            </div>
            <div className="truncate text-xs text-muted">
              {saved?.item_name ?? l.item_name ?? "—"}
              {l.batch_no ? ` · batch ${l.batch_no}` : ""}
            </div>
          </div>
        );
      },
    },
    {
      key: "inspected",
      header: "Inspected",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Inspected quantity, line ${i + 1}`}
          value={l.inspected_qty}
          disabled={locked}
          onChange={(v) => patchLine(i, { inspected_qty: v })}
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
          value={l.accepted_qty}
          max={num(l.inspected_qty)}
          disabled={locked}
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
      key: "result",
      header: "Result",
      width: "w-36",
      render: (l, i) => (
        <Select
          value={l.result}
          onChange={(v) => patchLine(i, { result: v as InspectionItemWrite["result"] })}
          options={RESULTS}
          isDisabled={locked}
          ariaLabel={`Result, line ${i + 1}`}
        />
      ),
    },
    {
      key: "defect",
      header: "Rejection reason",
      width: "w-36",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Defect, line ${i + 1}`}
          value={l.rejection_reason ?? l.defect_type}
          disabled={locked || num(l.rejected_qty) === 0}
          placeholder={num(l.rejected_qty) > 0 ? "Required" : "—"}
          onChange={(v) => patchLine(i, { rejection_reason: v, defect_type: v })}
        />
      ),
    },
    {
      key: "serials",
      header: "Accepted serials",
      width: "w-32",
      hideOnNarrow: true,
      render: (line, index) => {
        const available = availableSerials(index);
        // An untouched line has decided nothing, which means nothing rejected — show it
        // as all accepted rather than as zero.
        const accepted = line.serial_numbers?.length ?? available?.length ?? 0;
        return (
          <Button variant="ghost" onClick={() => setSerialsFor(index)} disabled={locked}>
            <ScanLine className="h-4 w-4" />
            {available ? `${accepted}/${available.length}` : accepted}
          </Button>
        );
      },
    },
    {
      key: "params",
      header: "Readings",
      width: "w-28",
      hideOnNarrow: true,
      render: (l, i) => (
        <Button variant="ghost" onClick={() => setParamsFor(i)}>
          {l.parameters?.length ? `${l.parameters.length}` : "Add"}
        </Button>
      ),
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const params = paramsFor === null ? [] : form.items[paramsFor]?.parameters ?? [];
  const setParams = (rows: InspectionParameter[]) =>
    paramsFor !== null && patchLine(paramsFor, { parameters: rows });

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={editing ? `Inspection ${doc?.inspection_no ?? ""}` : "New inspection"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(listPath)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="grn.qc">
                <Button variant="soft" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="grn.qc">
                <Button variant="dangerSoft" onClick={() => setCancelling(true)}>
                  Cancel inspection
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="grn.qc">
                <Button onClick={() => setConfirming(true)} disabled={form.items.length === 0}>
                  Complete inspection
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? pullReceipt.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.inspection_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Type" value={doc.inspection_type} />
          <MetaRow
            label="Pass rate"
            value={<span className="tabular">{percent(doc.passed_items, doc.total_items)}%</span>}
          />
        </MetaCard>
      )}

      {/* Where the goods came from, carried straight off the GRN — which carried it off
        * the vendor's own despatch note. Nothing here is typed at QC. */}
      {delivery && (
        <MetaCard title="Delivery">
          <MetaRow label="GRN" value={<span className="font-mono">{delivery.grn_no}</span>} />
          {delivery.po_no && <MetaRow label="Purchase order" value={delivery.po_no} />}
          {delivery.despatch_note_no
            && <MetaRow label="Despatch note" value={delivery.despatch_note_no} />}
          {delivery.vendor_name && <MetaRow label="Vendor" value={delivery.vendor_name} />}
          {delivery.invoice_no && <MetaRow label="Invoice" value={delivery.invoice_no} />}
          {delivery.eway_bill_no && <MetaRow label="E-way bill" value={delivery.eway_bill_no} />}
          {delivery.vehicle_no && <MetaRow label="Vehicle" value={delivery.vehicle_no} />}
          {delivery.transporter_name
            && <MetaRow label="Transporter" value={delivery.transporter_name} />}
          {delivery.lr_no && <MetaRow label="LR / docket" value={delivery.lr_no} />}
        </MetaCard>
      )}

      <Section title="Inspection">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input
              type="date"
              value={form.inspection_date}
              disabled={locked}
              onChange={(e) => set("inspection_date", e.target.value)}
            />
          </Field>
          <Field label="Against GRN" hint="Pulls the received lines in.">
            <Lookup
              name="receipts"
              load={grnOptions}
              value={form.receipt_id ?? ""}
              isDisabled={locked}
              onChange={(v) => {
                set("receipt_id", v === "" ? null : v);
                if (v !== "") pullReceipt.mutate(v);
              }}
              placeholder="GRN"
            />
          </Field>
          <Field label="Warehouse">
            <Lookup
              name="warehouses"
              load={warehouseOptions}
              value={form.warehouse_id ?? ""}
              isDisabled={locked}
              onChange={(v) => set("warehouse_id", v === "" ? null : v)}
              placeholder="Warehouse"
            />
          </Field>
          <Field label="Inspector">
            <Lookup
              name="employees"
              load={employeeOptions}
              value={form.inspector_id ?? ""}
              isDisabled={locked}
              // The options list is capped, so the signed-in inspector is not
              // guaranteed to be in it — without this their own name renders as the
              // placeholder on a document that plainly has one.
              fallback={me ? [{
                id: me.employee.id,
                code: me.employee.code ?? "",
                name: me.employee.name,
              }] : undefined}
              onChange={(v) => set("inspector_id", v === "" ? null : v)}
              placeholder="Inspector"
            />
          </Field>
        </div>
      </Section>

      <Section title="Lines" hint="Result follows the accepted/rejected split unless you override it.">
        <LinesEditor
          rows={form.items}
          columns={columns}
          keyOf={(_, i) => i}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          rowTone={(l) => (l.result === "FAILED" ? "bg-bad-bg/40" : undefined)}
          empty="Pick a GRN above to pull its lines in."
          footer={
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{totals.lines} lines</span>
              <span className="text-ok">Passed <b className="tabular">{totals.passed}</b></span>
              <span className={totals.failed > 0 ? "text-bad" : "text-muted"}>
                Failed <b className="tabular">{totals.failed}</b>
              </span>
              <span className="text-ink">Inspected <b className="tabular">{fmtQty(totals.inspected)}</b></span>
              <span className={totals.rejected > 0 ? "text-bad" : "text-muted"}>
                Rejected <b className="tabular">{fmtQty(totals.rejected)}</b>
              </span>
            </div>
          }
        />
      </Section>

      {paramsFor !== null && (
        <Section
          title={`Readings — line ${paramsFor + 1}`}
          hint="What was measured, and what it should have been."
          actions={
            <>
              <Button
                variant="subtle"
                onClick={() => setParams([...params, { name: "", expected: "", observed: "", result: "PASS" }])}
                disabled={locked}
              >
                <Plus className="h-4 w-4" /> Add reading
              </Button>
              <Button variant="ghost" onClick={() => setParamsFor(null)}>Close</Button>
            </>
          }
        >
          {params.length === 0 ? (
            <p className="text-sm text-muted">No readings recorded for this line.</p>
          ) : (
            <div className="space-y-2">
              {params.map((p, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_130px_44px]">
                  <Input
                    value={p.name}
                    placeholder="Parameter"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, name: e.target.value } : r)))
                    }
                  />
                  <Input
                    value={p.expected ?? ""}
                    placeholder="Expected"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, expected: e.target.value } : r)))
                    }
                  />
                  <Input
                    value={p.observed ?? ""}
                    placeholder="Observed"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, observed: e.target.value } : r)))
                    }
                  />
                  <Select
                    value={p.result ?? "PASS"}
                    onChange={(v) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, result: v as "PASS" | "FAIL" } : r)))
                    }
                    options={[{ value: "PASS", label: "Pass" }, { value: "FAIL", label: "Fail" }]}
                    isDisabled={locked}
                    ariaLabel={`Reading ${i + 1} result`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove reading ${i + 1}`}
                    disabled={locked}
                    onClick={() => setParams(params.filter((_, x) => x !== i))}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      <Section title="Evidence" hint="Test certificates, photographs of the defect.">
        <AttachmentsPanel entityType="INSPECTION" entityId={doc?.id} category="QC" readOnly={locked} />
      </Section>

      <SerialNumbersModal
        isOpen={serialsFor !== null}
        onClose={() => setSerialsFor(null)}
        quantity={serialsFor === null ? 0 : num(form.items[serialsFor]?.accepted_qty)}
        initial={serialsFor === null ? null : form.items[serialsFor]?.serial_numbers}
        available={availableSerials(serialsFor)}
        itemLabel={
          serialsFor === null
            ? ""
            : savedLine(serialsFor)?.item_name ?? `Line ${serialsFor + 1}`
        }
        readOnly={locked}
        onSave={(accepted) => {
          // The units kept are the quantity accepted — one serial is one unit, so
          // letting the inspector type a different number could only disagree with it.
          if (serialsFor !== null) {
            patchLine(serialsFor, {
              serial_numbers: accepted,
              ...(availableSerials(serialsFor) ? { accepted_qty: accepted.length } : {}),
            });
          }
        }}
      />

      <ConfirmModal
        isOpen={confirming}
        title="Complete this inspection?"
        message={
          <>
            The result is written back onto the GRN lines: {totals.passed} pass, {totals.failed} fail
            {totals.partial > 0 && <>, {totals.partial} partial</>}, <b>{fmtQty(totals.rejected)}</b>{" "}
            rejected. The inspection can no longer be edited.
            {totals.failed > 0 && (
              <Chip size="sm" variant="flat" color="danger" className="ml-2">
                Failed lines will block the receipt from posting in full
              </Chip>
            )}
          </>
        }
        confirmLabel="Complete"
        danger={totals.failed > 0}
        busy={complete.isPending}
        error={complete.error}
        onConfirm={() => complete.mutate()}
        onClose={() => setConfirming(false)}
      />

      <ConfirmModal
        isOpen={cancelling}
        title="Cancel this inspection?"
        message={
          <>
            The inspection is closed and its GRN goes back to draft, so the lines can be
            corrected and submitted again. A GRN with stock already released stays where
            it is.
          </>
        }
        confirmLabel="Cancel inspection"
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelling(false)}
      />
    </div>
  );
}
