import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
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
  approveOutboundInspection, rejectOutboundInspection,
  completeOutboundInspection, createOutboundInspection, employeeOptions, getOutboundInspection,
  getIssue, inspectableIssueOptions,
  updateOutboundInspection, warehouseOptions,
} from "../api";
import { fmtQty, num, percent, today } from "../format";
import { alerts } from "@/modules/alerts";
import type {
  OutboundInspection as Inspection, OutboundInspectionItemWrite as InspectionItemWrite, InspectionParameter, OutboundInspectionWrite as InspectionWrite, Issue as Receipt,
} from "../types";
import { usePointLabel } from "../usePointLabel";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

/**
 * Inspect a receipt line by line.
 *
 * Picking the Material Issue pulls its lines in with their issued quantities — an inspection
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

export default function OutboundQualityInspectionForm({
  type = "OUTGOING",
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
  const listPath = "/warehouse/qc-outward";
  const [searchParams] = window.location.search ? [new URLSearchParams(window.location.search)] : [new URLSearchParams()];
  const initialIssueId = searchParams.get("issue_id");

  const [form, setForm] = useState<InspectionWrite>({
    inspection_date: today(),
    issue_id: initialIssueId ? Number(initialIssueId) : 0 as any,
    warehouse_id: null,
    inspector_id: null,
    remarks: "",
    items: [],
  });
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pulled, setPulled] = useState<Receipt | null>(null);
  const [paramsFor, setParamsFor] = useState<number | null>(null);
  const [serialsFor, setSerialsFor] = useState<number | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-inspection", id],
    queryFn: () => getOutboundInspection(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      inspection_date: doc.inspection_date,
      issue_id: doc.issue_id ?? null,
      warehouse_id: doc.warehouse_id ?? null,
      inspector_id: doc.inspector_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        issue_item_id: l.issue_item_id,
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
        serial_numbers: Array.isArray(l.serial_numbers) 
          ? l.serial_numbers 
          : ((l.serial_numbers as any)?.accepted ?? null),
      })),
    });
  }, [doc]);

  useEffect(() => {
    if (!editing && initialIssueId && !pulled) {
      pullIssue.mutate(Number(initialIssueId));
    }
  }, [editing, initialIssueId, pulled]);

  /* The Material Issue's serials, by receipt line. They were read off the units at material issue,
   * so inspection picks from them: a serial typed here is one that was never issued,
   * and completion rejects any accepted serial that is not on the Material Issue. */
  const { data: issueDoc } = useQuery({
    queryKey: ["wh-issue", String(doc?.issue_id ?? "")],
    queryFn: () => getIssue(Number(doc?.issue_id)),
    enabled: !!doc?.issue_id,
  });

  const issueFallback = useMemo(
    () => (doc?.issue_id
      ? [{ id: doc.issue_id, code: doc.issue_no ?? String(doc.issue_id),
           name: doc.issue_no ?? String(doc.issue_id) }]
      : []),
    [doc?.issue_id, doc?.issue_no],
  );

  /* A saved inspection that carries an issue but no lines. It should not exist —
   * picking the issue seeds the lines — but one was raised before this screen had a
   * working issue lookup, and an inspection with an empty grid can never be completed
   * or corrected. Seeding from the issue is what picking it would have done, and the
   * guard on `items.length` means a real inspection is never overwritten. */
  useEffect(() => {
    if (!doc || !doc.issue_id) return;
    if ((doc.items ?? []).length > 0 || pulled) return;
    if (doc.status !== "DRAFT" && doc.status !== "IN_PROGRESS") return;
    pullIssue.mutate(doc.issue_id);
  }, [doc, pulled]);

  const delivery = issueDoc ?? pulled;

  const deliveryMeta = useMemo(() => {
    const byLine = new Map<number, { is_serial_tracked?: boolean, serials: string[] }>();
    for (const line of delivery?.items ?? []) {
      byLine.set(line.id, {
        is_serial_tracked: line.is_serial_tracked,
        serials: line.serial_numbers ?? [],
      });
    }
    return byLine;
  }, [delivery]);

  const isSerialTracked = (index: number | null) => {
    if (index === null) return false;
    const issueItemId = form.items[index]?.issue_item_id;
    if (!issueItemId) return false;
    return deliveryMeta.get(issueItemId)?.is_serial_tracked ?? false;
  };

  /** The Material Issue serials behind an inspection line. Serial-tracked items must already have
   *  these from material issue, so QC selects accepted units from this list. */
  const availableSerials = (index: number | null) => {
    if (index === null) return null;
    const issueItemId = form.items[index]?.issue_item_id;
    if (!issueItemId) return null;
    const meta = deliveryMeta.get(issueItemId);
    return meta?.serials?.length ? meta.serials : null;
  };

  /** Pulling the receipt in seeds the lines from what was actually issued. */
  const pullIssue = useMutation({
    mutationFn: (issueId: number) => getIssue(issueId),
    onSuccess: (receipt) => {
      setPulled(receipt);
      setForm((f) => ({
        ...f,
        warehouse_id: receipt.warehouse_id,
        items: (receipt.items ?? []).map((l) => ({
          issue_item_id: l.id,
          item_id: l.item_id,
          // Carried through so the line can name itself before the first save.
          item_code: l.item_code,
          item_name: l.item_name,
          batch_no: l.batch_no,
          inspected_qty: num(l.issued_qty),
          accepted_qty: num(l.issued_qty),
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

  /** A line whose issue line sent out named units — serials, IMEIs, asset tags or
   *  consumable codes. Those are picked here whatever the kind; the server checks each
   *  against what the issue line actually carried. Whole-unit rules for counted UOMs
   *  (Nos, Box…) are the server's, which knows the unit master. */
  const validateAcceptedSerials = () => {
    for (const [index, line] of form.items.entries()) {
      const available = availableSerials(index);
      if (!available && !isSerialTracked(index)) continue;
      const label = `Line ${index + 1} (${line.item_code ?? line.item_name ?? "item"})`;
      const required = Math.floor(num(line.accepted_qty));
      if (num(line.accepted_qty) !== required) {
        const rest = num(line.inspected_qty) - required;
        throw new Error(
          `${label}: units named one by one are accepted whole. ` +
          `Accept ${required} and reject the remaining ${rest} with a reason.`,
        );
      }
      if (!available) continue;
      const actual = line.serial_numbers?.length ?? available.length;
      if (actual !== required) {
        throw new Error(`${label}: select exactly ${required} accepted units.`);
      }
    }
  };

  /** An untouched picker means "every unit passed" (see the column below). Say so on
   *  the wire: the server counts what it is sent, and null reads as zero selected. */
  const payload = (): InspectionWrite => ({
    ...form,
    items: form.items.map((line, index) => {
      const available = availableSerials(index);
      return line.serial_numbers == null && available
        ? { ...line, serial_numbers: available }
        : line;
    }),
  });

  const save = useMutation({
    mutationFn: () => {
      validateAcceptedSerials();
      return editing
        ? updateOutboundInspection(Number(id), payload())
        : createOutboundInspection(payload());
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
      await updateOutboundInspection(Number(id), payload());
      return completeOutboundInspection(Number(id));
    },
    onSuccess: () => {
      void alerts.success("inspection.completed", {
        number: doc?.inspection_no ?? "The inspection",
      });
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
      setConfirming(false);
    },
  });

  /* Only ever reachable where an admin configured a QC_OUTWARD ladder on Approvals
   * Config. With none — every project today — Complete finishes the check outright and
   * the document never stops at PENDING_APPROVAL, so these buttons never draw. */
  const decide = useMutation({
    mutationFn: (action: "APPROVE" | "REJECT") =>
      action === "APPROVE"
        ? approveOutboundInspection(Number(id))
        : rejectOutboundInspection(Number(id), "Rejected on the Outward QC screen"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
    },
  });

  /* Cancelling hands the Material Issue back: the server walks an untouched receipt out of
   * PENDING_QC to DRAFT, which is the only way to correct lines — serials above all —
   * once the receipt has been submitted. */
  const cancel = useMutation({
    mutationFn: () => null as any, // cancelOutboundInspection(Number(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
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
            {/* Saved snapshot first, then what the Material Issue pull carried in. Only a line
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
      // Serials, IMEIs, asset tags and consumable codes alike: whatever named the
      // units this issue line sent out. Only serial-tracked lines used to get it.
      header: "Accepted units",
      width: "w-32",
      hideOnNarrow: true,
      render: (line, index) => {
        const available = availableSerials(index);
        if (!available && !isSerialTracked(index)) return <span className="text-muted">—</span>;
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
              <Can do={editing ? "qc_outward.update" : "qc_outward.create"}>
                <Button variant="soft" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="qc_outward.delete">
                <Button variant="dangerSoft" onClick={() => setCancelling(true)}>
                  Cancel inspection
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="qc_outward.approve">
                <Button onClick={() => setConfirming(true)} disabled={form.items.length === 0}>
                  Complete inspection
                </Button>
              </Can>
            )}
            {editing && doc?.status === "PENDING_APPROVAL" && (
              <Can do="qc_outward.approve">
                <Button className={TONE_REJECT} variant="dangerSoft" onClick={() => decide.mutate("REJECT")}
                        disabled={decide.isPending}>
                  Reject
                </Button>
                <Button className={TONE_APPROVE} onClick={() => decide.mutate("APPROVE")} disabled={decide.isPending}>
                  {decide.isPending ? "Working…" : "Approve"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? pullIssue.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.inspection_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          {doc.current_approver_name && (
            <MetaRow label="With" value={doc.current_approver_name} />
          )}
          <MetaRow
            label="Pass rate"
            value={<span className="tabular">{percent(doc.passed_items, doc.total_items)}%</span>}
          />
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
          <Field label="Against Material Issue" hint="Pulls the issued lines in.">
            <Lookup
              name="inspectable-issues"
              load={inspectableIssueOptions}
              /* The loader lists issues that still owe a check, so an issue already
                 inspected by THIS document is not on it. Without the fallback the
                 Select finds no option matching the id and draws its placeholder over
                 a field that plainly has a value — which is why a saved inspection
                 showed "Material Issue" instead of the number it was raised against. */
              fallback={issueFallback}
              value={form.issue_id || ""}
              isDisabled={locked}
              onChange={(v) => {
                set("issue_id", v === "" ? 0 as any : Number(v));
                if (v !== "") pullIssue.mutate(Number(v));
              }}
              placeholder="Material Issue"
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
          empty="Pick a Material Issue above to pull its lines in."
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
            The result is written back onto the Material Issue lines: {totals.passed} pass, {totals.failed} fail
            {totals.partial > 0 && <>, {totals.partial} partial</>}, {fmtQty(totals.rejected)}{" "}
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
            The inspection is closed and its Material Issue goes back to draft, so the lines can be
            corrected and submitted again. A Material Issue with stock already released stays where
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
