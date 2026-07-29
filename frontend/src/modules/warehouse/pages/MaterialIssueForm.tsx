import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button, Can, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { ConfirmModal, ErrorBanner } from "../components/Feedback";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, type TimelineEntry } from "../components/Timeline";
import {
  acknowledgeIssue, binOptions, cancelIssue, createIssue, departmentOptions, employeeOptions, getIssue,
  indentOptions, itemOptions, postIssue, projectOptions, submitIssue, updateIssue, vehicleOptions,
  warehouseOptions,
} from "../api";
import { fmtDateTime, fmtMoney, fmtQty, num, today } from "../format";
import type { Issue, IssueItemWrite, IssueWrite } from "../types";

/**
 * Raise, approve and post a material issue.
 *
 * Two quantities matter and they are not the same: `requested_qty` is what was
 * asked for, `issued_qty` is what actually left the shelf. Keeping both means a
 * short issue is visible as a short issue rather than being quietly rewritten to
 * whatever was available.
 *
 * Posting is the only step that touches stock, and it is deliberately separate from
 * approval: an approved issue is a promise, a posted one is a movement. The
 * approval itself goes through the shared workflow engine — this screen only shows
 * where the document is and asks the backend to move it.
 */

const TYPES = [
  { value: "DEPARTMENT", label: "To a department" },
  { value: "PROJECT", label: "To a project" },
  { value: "VEHICLE", label: "To a vehicle" },
  { value: "CONSUMPTION", label: "Consumption" },
  { value: "SCRAP", label: "Scrap" },
];

const emptyLine = (): IssueItemWrite => ({
  item_id: 0,
  bin_id: null,
  batch_id: null,
  requested_qty: 0,
  issued_qty: 0,
  rate: null,
  remarks: null,
});

export default function MaterialIssueForm({ direction = "OUT" }: { direction?: "OUT" | "IN" }) {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";

  const [form, setForm] = useState<IssueWrite>({
    issue_type: "DEPARTMENT",
    issue_date: today(),
    indent_id: null,
    picking_id: null,
    warehouse_id: 0,
    department_id: null,
    project_id: null,
    vehicle_id: null,
    issued_to_id: null,
    direction,
    original_issue_id: null,
    remarks: "",
    items: [],
  });
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState<"submit" | "post" | "ack" | "cancel" | null>(null);
  const [reason, setReason] = useState("");

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-issue", id],
    queryFn: () => getIssue(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      issue_type: doc.issue_type,
      issue_date: doc.issue_date,
      indent_id: doc.indent_id ?? null,
      picking_id: doc.picking_id ?? null,
      warehouse_id: doc.warehouse_id,
      department_id: doc.department_id ?? null,
      project_id: doc.project_id ?? null,
      vehicle_id: doc.vehicle_id ?? null,
      issued_to_id: doc.issued_to_id ?? null,
      direction: doc.direction,
      original_issue_id: doc.original_issue_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        indent_item_id: l.indent_item_id,
        item_id: l.item_id,
        bin_id: l.bin_id,
        batch_id: l.batch_id,
        requested_qty: num(l.requested_qty),
        issued_qty: num(l.issued_qty),
        rate: l.rate,
        remarks: l.remarks,
      })),
    });
  }, [doc]);

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof IssueWrite>(key: K, value: IssueWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const patchLine = (index: number, patch: Partial<IssueItemWrite>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));

  const totals = useMemo(
    () => ({
      lines: form.items.length,
      requested: form.items.reduce((s, l) => s + num(l.requested_qty), 0),
      issued: form.items.reduce((s, l) => s + num(l.issued_qty), 0),
      value: form.items.reduce((s, l) => s + num(l.issued_qty) * num(l.rate), 0),
    }),
    [form.items],
  );

  const short = totals.requested - totals.issued;
  const locked = !!doc && doc.status !== "DRAFT";

  const save = useMutation({
    mutationFn: () => (editing ? updateIssue(Number(id), form) : createIssue(form)),
    onSuccess: (saved: Issue) => {
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      qc.invalidateQueries({ queryKey: ["wh-issue", String(saved.id)] });
      if (!editing) nav(`../${saved.id}`, { replace: true });
    },
  });

  const act = useMutation({
    mutationFn: (what: "submit" | "post" | "ack" | "cancel") => {
      const numId = Number(id);
      if (what === "submit") return submitIssue(numId);
      if (what === "post") return postIssue(numId);
      if (what === "ack") return acknowledgeIssue(numId, reason || undefined);
      return cancelIssue(numId, reason || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      setConfirming(null);
      setReason("");
    },
  });

  const trail: TimelineEntry[] = doc
    ? [
        { id: "created", title: "Raised", at: doc.created_at, by: doc.created_by_name, tone: "done" as const },
        doc.approved_at
          ? { id: "approved", title: "Approved", at: doc.approved_at, by: doc.approved_by_name, tone: "done" as const }
          : doc.status === "PENDING_APPROVAL"
            ? { id: "pending", title: "Awaiting approval", by: doc.current_approver_name ?? "unassigned" }
            : null,
        doc.posted_at
          ? { id: "issued", title: "Issued from stock", at: doc.posted_at, by: doc.issued_by_name, tone: "done" as const }
          : null,
        doc.acknowledged_at
          ? {
              id: "ack",
              title: "Acknowledged by receiver",
              at: doc.acknowledged_at,
              by: doc.acknowledged_by_name,
              tone: "done" as const,
            }
          : null,
      ].filter(Boolean) as TimelineEntry[]
    : [];

  const columns: LineColumn<IssueItemWrite>[] = [
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
      key: "bin",
      header: "From bin",
      width: "w-40",
      hideOnNarrow: true,
      render: (l, i) => (
        <Lookup
          name={`bins-${form.warehouse_id}`}
          load={(s) => binOptions(form.warehouse_id, s)}
          value={l.bin_id ?? ""}
          isDisabled={locked || !form.warehouse_id}
          onChange={(v) => patchLine(i, { bin_id: v === "" ? null : v })}
          placeholder="Any bin"
        />
      ),
    },
    {
      key: "requested",
      header: "Requested",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Requested quantity, line ${i + 1}`}
          value={l.requested_qty}
          disabled={locked}
          onChange={(v) => patchLine(i, { requested_qty: v, issued_qty: num(l.issued_qty) || v })}
        />
      ),
    },
    {
      key: "issued",
      header: "Issued",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Issued quantity, line ${i + 1}`}
          value={l.issued_qty ?? 0}
          max={num(l.requested_qty)}
          disabled={locked && doc?.is_stock_posted}
          invalid={num(l.issued_qty) > num(l.requested_qty)}
          onChange={(v) => patchLine(i, { issued_qty: v })}
        />
      ),
    },
    {
      key: "short",
      header: "Short",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (l) => {
        const gap = num(l.requested_qty) - num(l.issued_qty);
        return (
          <span className={`tabular ${gap > 0 ? "font-semibold text-warn" : "text-muted"}`}>{fmtQty(gap)}</span>
        );
      },
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
      key: "remarks",
      header: "Remarks",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Remarks, line ${i + 1}`}
          value={l.remarks}
          disabled={locked}
          onChange={(v) => patchLine(i, { remarks: v })}
        />
      ),
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const noun = direction === "OUT" ? "issue" : "return";

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title={editing ? `${doc?.issue_no ?? ""}` : `New material ${noun}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("..")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="issue.create">
                <Button
                  variant="subtle"
                  onClick={() => {
                    setTouched(true);
                    if (form.warehouse_id && form.items.length) save.mutate();
                  }}
                  disabled={save.isPending}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && doc?.status === "DRAFT" && (
              <Can do="issue.create">
                <Button onClick={() => setConfirming("submit")}>Submit for approval</Button>
              </Can>
            )}
            {editing && doc?.status === "APPROVED" && !doc?.is_stock_posted && (
              <Can do="issue.issue">
                <Button onClick={() => setConfirming("post")}>Issue from stock</Button>
              </Can>
            )}
            {editing && doc?.status === "ISSUED" && (
              <Can do="issue.view">
                <Button variant="subtle" onClick={() => setConfirming("ack")}>Acknowledge</Button>
              </Can>
            )}
            {editing && doc && !["CANCELLED", "ACKNOWLEDGED"].includes(doc.status) && (
              <Can do="issue.create">
                <Button variant="danger" onClick={() => setConfirming("cancel")}>Cancel</Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error} />
      {touched && !form.warehouse_id && <ErrorBanner error="Pick the issuing warehouse." />}
      {touched && form.items.length === 0 && <ErrorBanner error="Add at least one line." />}

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.issue_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Stock" value={doc.is_stock_posted ? `Posted ${fmtDateTime(doc.posted_at)}` : "Not posted"} />
          <MetaRow label="Against indent" value={<span className="font-mono">{doc.indent_no ?? "—"}</span>} />
          <MetaRow label="Picklist" value={<span className="font-mono">{doc.pick_no ?? "—"}</span>} />
          <MetaRow label="Issued by" value={doc.issued_by_name} />
          <MetaRow label="Acknowledged by" value={doc.acknowledged_by_name} />
          <MetaRow
            label="Reverses"
            value={doc.original_issue_no ? <span className="font-mono">{doc.original_issue_no}</span> : "—"}
          />
        </MetaCard>
      )}

      <Section title={`${direction === "OUT" ? "Issue" : "Return"} details`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={form.issue_date} disabled={locked}
                   onChange={(e) => set("issue_date", e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={form.issue_type} onChange={(v) => set("issue_type", v)} options={TYPES}
                    isDisabled={locked} ariaLabel="Issue type" />
          </Field>
          <Field label="From warehouse">
            <Lookup name="warehouses" load={warehouseOptions} value={form.warehouse_id || ""}
                    isDisabled={locked} onChange={(v) => set("warehouse_id", v === "" ? 0 : v)}
                    placeholder="Warehouse" />
          </Field>
          <Field label="Against indent">
            <Lookup name="indents" load={indentOptions} value={form.indent_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("indent_id", v === "" ? null : v)} placeholder="Indent" />
          </Field>
          <Field label="Department">
            <Lookup name="departments" load={departmentOptions} value={form.department_id ?? ""}
                    isDisabled={locked} onChange={(v) => set("department_id", v === "" ? null : v)}
                    placeholder="Department" />
          </Field>
          <Field label="Project">
            <Lookup name="projects" load={projectOptions} value={form.project_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("project_id", v === "" ? null : v)} placeholder="Project" />
          </Field>
          <Field label="Vehicle">
            <Lookup name="vehicles" load={vehicleOptions} value={form.vehicle_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("vehicle_id", v === "" ? null : v)} placeholder="Vehicle" />
          </Field>
          <Field label="Issued to">
            <Lookup name="employees" load={employeeOptions} value={form.issued_to_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("issued_to_id", v === "" ? null : v)} placeholder="Person" />
          </Field>
        </div>
      </Section>

      <Section title="Lines" hint="Issued below requested leaves the line short — that is recorded, not hidden.">
        <LinesEditor
          rows={form.items}
          columns={columns}
          keyOf={(_, i) => i}
          onAdd={locked ? undefined : () => set("items", [...form.items, emptyLine()])}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          rowTone={(l) => (num(l.requested_qty) > num(l.issued_qty) ? "bg-warn-bg/30" : undefined)}
          empty="Add the items leaving the store."
          footer={
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{totals.lines} lines</span>
              <span className="text-ink">Requested <b className="tabular">{fmtQty(totals.requested)}</b></span>
              <span className="text-ink">Issued <b className="tabular">{fmtQty(totals.issued)}</b></span>
              {short > 0 && <span className="text-warn">Short <b className="tabular">{fmtQty(short)}</b></span>}
              <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
            </div>
          }
        />
      </Section>

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      {doc && (
        <Section title="Progress">
          <Timeline entries={trail} />
        </Section>
      )}

      <Section title="Documents" hint="Gate pass, signed acknowledgement.">
        <AttachmentsPanel entityType="ISSUE" entityId={doc?.id} category="ISSUE" readOnly={locked} />
      </Section>

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for approval?"
        message="The document goes to the approval chain and can no longer be edited."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "post"}
        title="Issue this stock?"
        message={`${fmtQty(totals.issued)} leaves the warehouse now. This writes stock movements and cannot be undone — a mistake is corrected with a return, not a delete.`}
        confirmLabel="Issue from stock"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("post")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "ack"}
        title="Acknowledge receipt?"
        message="Confirms the receiver has the goods."
        confirmLabel="Acknowledge"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("ack")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Remarks">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "cancel"}
        title="Cancel this document?"
        message="Cancelling stops the document here. Stock already posted stays posted."
        confirmLabel="Cancel document"
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
