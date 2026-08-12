import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Info, ScanLine } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, approvalsToTimeline, type TimelineEntry } from "../components/Timeline";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  acknowledgeIssue, approveIssue, batchOptions, binOptions, cancelIssue, createIssue, departmentOptions,
  employeeOptions, getIndentIssueSource, getIssue, getPickingIssueSource, indentOptions,
  issueApprovalHistory, itemOptions, listSerials, postIssue, projectOptions,
  returnableIssueOptions, rejectIssue, setIssueSerials, submitIssue, updateIssue,
  warehouseOptions,
} from "../api";
import { fmtDateTime, fmtMoney, fmtQty, num, today } from "../format";
import { alerts } from "@/modules/alerts";
import type { Issue, IssueItemWrite, IssueWrite, ItemOption } from "../types";
import { usePointLabel } from "../usePointLabel";

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
  serial_numbers: [],
});

export default function MaterialIssueForm({ direction = "OUT" }: { direction?: "OUT" | "IN" }) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const pickingSourceId = Number(searchParams.get("picking_id") || 0);
  /* Absolute, not `".."`. This screen is mounted at two depths (under
   * /warehouse/... and under /warehouse/transactions/...), and a relative Back
   * resolves against the matched route, so it landed on the dashboard from one
   * of them and on the list from the other. */
  const listPath = direction === "OUT" ? "/warehouse/material-issues" : "/warehouse/material-returns";

  const [form, setForm] = useState<IssueWrite>({
    issue_type: "DEPARTMENT",
    issue_date: today(),
    indent_id: null,
    picking_id: null,
    warehouse_id: 0,
    department_id: null,
    project_id: null,
    vehicle_id: null,
    vehicle_number: null,
    issued_to_id: null,
    direction,
    original_issue_id: null,
    remarks: "",
    items: [],
  });
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState<
    "submit" | "approve" | "reject" | "post" | "ack" | "cancel" | null
  >(null);
  const [reason, setReason] = useState("");
  const [serialLine, setSerialLine] = useState<number | null>(null);
  const [destination, setDestination] = useState("");
  // The employee dropdown loads one page of names, so the indent raiser this form
  // defaults to is usually not in it. Hold the name that came with the id, or the
  // field shows its placeholder over a person who IS selected.
  const [issuedToName, setIssuedToName] = useState<string | null>(null);
  // Some of the reserved stock was received for another project, or for none.
  // Worth saying out loud — the issue still goes through.
  const [mixedProjects, setMixedProjects] = useState(false);
  const [isBinManaged, setIsBinManaged] = useState(true);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-issue", id],
    queryFn: () => getIssue(Number(id)),
    enabled: editing,
  });

  // The rungs already passed. Only the engine has them — see issueApprovalHistory.
  const { data: approvals } = useQuery({
    queryKey: ["wh-issue-approvals", id],
    queryFn: () => issueApprovalHistory(Number(id)),
    enabled: editing,
  });

  const pickingSource = useQuery({
    queryKey: ["wh-picking-issue-source", pickingSourceId],
    queryFn: () => getPickingIssueSource(pickingSourceId),
    enabled: !editing && direction === "OUT" && pickingSourceId > 0,
  });

  useEffect(() => {
    if (!doc) return;
    setDestination(doc.destination_office_name ?? "");
    setIssuedToName(doc.issued_to_name ?? null);
    if (doc.warehouse_id) {
      warehouseOptions().then((opts) => {
        const w = opts.find(o => o.id === doc.warehouse_id);
        if (w) setIsBinManaged((w as any).is_bin_managed ?? true);
      });
    }
    setForm({
      issue_type: doc.issue_type,
      issue_date: doc.issue_date,
      indent_id: doc.indent_id ?? null,
      picking_id: doc.picking_id ?? null,
      warehouse_id: doc.warehouse_id,
      department_id: doc.department_id ?? null,
      project_id: doc.project_id ?? null,
      vehicle_id: doc.vehicle_id ?? null,
      vehicle_number: doc.vehicle_number ?? null,
      issued_to_id: doc.issued_to_id ?? null,
      direction: doc.direction,
      original_issue_id: doc.original_issue_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        indent_item_id: l.indent_item_id,
        item_id: l.item_id,
        item_code: l.item_code,
        item_name: l.item_name,
        is_serial_tracked: l.is_serial_tracked,
        bin_id: l.bin_id,
        batch_id: l.batch_id,
        requested_qty: num(l.requested_qty),
        issued_qty: num(l.issued_qty),
        rate: l.rate,
        remarks: l.remarks,
        serial_numbers: l.serial_numbers ?? [],
      })),
    });
  }, [doc]);

  useEffect(() => {
    if (!pickingSource.data) return;
    const source = pickingSource.data;
    setMixedProjects(!!source.mixed_projects);
    if (source.issued_to_id) setIssuedToName(source.issued_to_name ?? null);
    setForm((current) => ({
      ...current,
      picking_id: source.picking_id,
      warehouse_id: source.warehouse_id,
      indent_id: source.indent_id ?? null,
      department_id: source.department_id ?? null,
      project_id: source.project_id ?? null,
      issued_to_id: source.issued_to_id ?? current.issued_to_id,
      vehicle_id: source.vehicle_id ?? current.vehicle_id,
      vehicle_number: source.vehicle_number ?? current.vehicle_number,
      items: source.items,
    }));
  }, [pickingSource.data]);

  const savedLine = (i: number) => doc?.items?.[i];
  const activeSerialLine = serialLine === null ? null : form.items[serialLine];
  // 0 is the "no bin" / "no batch" sentinel the warehouse writes, not a real id, and
  // an issue drafted from an allocation carries it on every line. Narrowing the
  // serial list by it would match nothing.
  const sourceId = (value: number | null | undefined) => (value ? value : undefined);
  const activeSerialLineReady = !!(activeSerialLine?.item_id && form.warehouse_id);
  const availableSerials = useQuery({
    queryKey: [
      "wh-issue-serials",
      form.warehouse_id,
      activeSerialLine?.item_id ?? 0,
      activeSerialLine?.batch_id ?? 0,
      activeSerialLine?.bin_id ?? 0,
      serialLine,
    ],
    queryFn: () =>
      listSerials({
        item_id: activeSerialLine!.item_id,
        batch_id: sourceId(activeSerialLine!.batch_id),
        warehouse_id: form.warehouse_id,
        bin_id: isBinManaged ? sourceId(activeSerialLine!.bin_id) : undefined,
        status: "available",
        size: 500,
      }),
    enabled: serialLine !== null && !!activeSerialLine?.is_serial_tracked && activeSerialLineReady,
  });

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
  // Serials are the one thing still open after approval: the approver signed off on
  // quantities, but which physical units go out is decided at the shelf, and
  // "Issue from stock" refuses an incomplete set. Saved straight away through the
  // serials endpoint, because the document itself is no longer editable.
  const serialsLocked = locked && !(doc?.status === "APPROVED" && !doc?.is_stock_posted);
  const payload = (): IssueWrite => ({
    ...form,
    items: form.items.map(({ item_code, item_name, is_serial_tracked, ...line }) => line),
  });

  const save = useMutation({
    mutationFn: () => (editing ? updateIssue(Number(id), payload()) : createIssue(payload())),
    onSuccess: (saved: Issue) => {
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      qc.invalidateQueries({ queryKey: ["wh-issue", String(saved.id)] });
      if (!editing) nav(`${listPath}/${saved.id}`, { replace: true });
    },
  });

  const saveSerials = useMutation({
    mutationFn: (line: { id: number; serial_numbers: string[] }) =>
      setIssueSerials(Number(id), [line]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
    },
  });

  const pullIndent = useMutation({
    mutationFn: (indentId: number) => getIndentIssueSource(indentId, form.warehouse_id),
    onSuccess: (source) => {
      setDestination(source.destination_office_name ?? "");
      setMixedProjects(!!source.mixed_projects);
      if (source.issued_to_id) setIssuedToName(source.issued_to_name ?? null);
      setForm((current) => ({
        ...current,
        indent_id: source.indent_id,
        department_id: source.department_id ?? current.department_id,
        project_id: source.project_id ?? current.project_id,
        issued_to_id: source.issued_to_id ?? current.issued_to_id,
        vehicle_id: source.vehicle_id ?? current.vehicle_id,
        vehicle_number: source.vehicle_number ?? current.vehicle_number,
        items: source.items,
      }));
    },
  });

  const pullOriginal = useMutation({
    mutationFn: (issueId: number) => getIssue(issueId),
    onSuccess: (source) => {
      setForm((current) => ({
        ...current,
        original_issue_id: source.id,
        warehouse_id: source.warehouse_id,
        department_id: source.department_id ?? null,
        project_id: source.project_id ?? null,
        issued_to_id: source.issued_to_id ?? null,
        items: (source.items ?? [])
          .map((line) => {
            const open = Math.max(num(line.issued_qty) - num(line.returned_qty), 0);
            return {
              ...emptyLine(),
              item_id: line.item_id,
              bin_id: line.bin_id,
              batch_id: line.batch_id,
              requested_qty: open,
              issued_qty: open,
              rate: line.rate,
              serial_numbers: line.serial_numbers ?? [],
            };
          })
          .filter((line) => line.requested_qty > 0),
      }));
    },
  });

  const act = useMutation({
    mutationFn: (what: "submit" | "approve" | "reject" | "post" | "ack" | "cancel") => {
      const numId = Number(id);
      if (what === "submit") return submitIssue(numId);
      if (what === "approve") return approveIssue(numId, reason);
      if (what === "reject") return rejectIssue(numId, reason);
      if (what === "post") return postIssue(numId);
      if (what === "ack") return acknowledgeIssue(numId, reason || undefined);
      return cancelIssue(numId, reason || undefined);
    },
    onSuccess: (_result, what) => {
      const number = doc?.issue_no ?? "The issue";
      // Only the outcomes that change what the storekeeper does next are announced;
      // submit and approve are already obvious from the status pill moving.
      if (what === "post") void alerts.success("issue.posted", { number });
      else if (what === "ack") void alerts.success("issue.acknowledged", { number });
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
      qc.invalidateQueries({ queryKey: ["wh-issue-approvals", id] });
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      // A posted issue is exactly what the consignment screen offers as its source,
      // and that picker is a Lookup holding its list for five minutes. Without this
      // the storekeeper who has just posted an issue opens Consignments, cannot find
      // it, and has to hard-refresh the browser before the flow will continue.
      // Every act here changes dispatchability one way or the other — post adds the
      // issue to that list, cancel and acknowledge take it back off.
      qc.invalidateQueries({ queryKey: ["wh-lookup", "posted-issues"] });
      setConfirming(null);
      setReason("");
    },
  });

  // Raised, then every rung the engine recorded, then where it is waiting now, then
  // what happened to the stock. The approvals come from wf_actions rather than the
  // document's own approved_at/approved_by_name: those are written only when the whole
  // ladder completes, so on a multi-rung ladder they hide every approval but the last.
  const trail: TimelineEntry[] = doc
    ? [
        { id: "created", title: "Raised", at: doc.created_at, by: doc.created_by_name, tone: "done" as const },
        ...approvalsToTimeline(approvals),
        // A document approved without an engine instance behind it — nothing to read
        // from wf_actions, so fall back to the document's own stamp rather than
        // showing an approved issue with no approval on it at all.
        approvals?.length === 0 && doc.approved_at
          ? { id: "approved", title: "Approved", at: doc.approved_at, by: doc.approved_by_name, tone: "done" as const }
          : null,
        doc.status === "PENDING_APPROVAL"
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
      width: "w-96",
      render: (l, i) => {
        const saved = savedLine(i);
        if (saved || l.item_code || l.item_name) {
          const code = saved?.item_code ?? l.item_code;
          const name = saved?.item_name ?? l.item_name;
          return (
            <div className="min-w-80 max-w-[28rem]">
              <div className="break-words font-mono text-xs font-semibold leading-5 text-ink">{code ?? "—"}</div>
              <div className="break-words text-xs leading-5 text-muted">{name ?? "—"}</div>
            </div>
          );
        }
        return (
          <Lookup
            name="items"
            load={itemOptions}
            value={l.item_id || ""}
            onChange={(v, option) => {
              const item = option as ItemOption | undefined;
              patchLine(i, {
                item_id: v === "" ? 0 : v,
                item_code: item?.code ?? null,
                item_name: item?.name ?? null,
                is_serial_tracked: !!item?.is_serial_tracked,
                is_batch_tracked: !!item?.is_batch_tracked,
                batch_id: null,
                bin_id: null,
                serial_numbers: [],
              });
            }}
            placeholder="Pick an item"
            serverSearch=""
          />
        );
      },
    },
    {
      key: "batch",
      header: "Batch",
      width: "w-64",
      hideOnNarrow: true,
      render: (line, index) => (
        <Lookup
          name={`issue-batches-${line.item_id}-${form.warehouse_id}`}
          load={() => batchOptions(line.item_id, form.warehouse_id)}
          value={line.batch_id ?? ""}
          isDisabled={locked || !line.item_id || !form.warehouse_id}
          onChange={(value) => patchLine(index, {
            batch_id: value === "" ? null : value,
            bin_id: null,
            serial_numbers: [],
          })}
          placeholder="Batch"
        />
      ),
    },
    ...(isBinManaged ? [{
      key: "bin",
      header: "From bin",
      width: "w-64",
      hideOnNarrow: true,
      render: (l: IssueItemWrite, i: number) => (
        <Lookup
          name={`bins-${form.warehouse_id}-${l.batch_id ?? 0}`}
          load={(s) => binOptions(form.warehouse_id, s, l.item_id, l.batch_id)}
          value={l.bin_id ?? ""}
          isDisabled={locked || !form.warehouse_id || !l.batch_id}
          onChange={(v) => patchLine(i, { bin_id: v === "" ? null : v, serial_numbers: [] })}
          placeholder={l.batch_id ? "From bin" : "Pick batch first"}
        />
      ),
    } as LineColumn<IssueItemWrite>] : []),
    {
      key: "requested",
      header: "Requested",
      numeric: true,
      width: "w-36",
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
      width: "w-36",
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
      width: "w-32",
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
      width: "w-36",
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
      width: "w-32",
      hideOnNarrow: true,
      render: (line, index) => {
        if (!line.is_serial_tracked) return <span className="text-xs text-muted">—</span>;
        const needsBatch = (line as any).is_batch_tracked && !line.batch_id;
        const needsBin = isBinManaged && !line.bin_id;
        // Only while the line is still editable. After approval the batch and bin
        // pickers are locked, so demanding them here would leave the storekeeper
        // with no way to name the units — and the serial he picks carries its own
        // bin and batch anyway.
        const needsSource = !locked && (needsBatch || needsBin);
        return (
          <Button
            variant="ghost"
            onClick={() => setSerialLine(index)}
            disabled={serialsLocked || needsSource}
            title={needsSource ? "Pick batch and from bin first" : "Select serials"}
          >
            <ScanLine className="h-4 w-4" />
            {line.serial_numbers?.length ?? 0}
          </Button>
        );
      },
    },
    {
      key: "remarks",
      header: "Remarks",
      width: "w-56",
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
        eyebrow={pointLabel}
        title={editing ? `${doc?.issue_no ?? ""}` : `New material ${noun}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(listPath)}>
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
            {/* can_approve, not just the permission: the whole warehouse shares one
                HCM rank, so all eleven hold `issue.issue` while only the approver the
                chain named may act. Showing it to the rest sent them into a
                "You are not a valid approver" error after clicking. */}
            {editing && doc?.status === "PENDING_APPROVAL" && doc?.can_approve && (
              <Can do="issue.issue">
                <Button onClick={() => setConfirming("approve")}>Approve</Button>
                <Button variant="danger" onClick={() => setConfirming("reject")}>Reject</Button>
              </Can>
            )}
            {editing && doc?.status === "APPROVED" && !doc?.is_stock_posted && (
              <Can do="issue.issue">
                <Button onClick={() => setConfirming("post")}>Issue from stock</Button>
              </Can>
            )}
            {/* Only once the raiser has confirmed what reached them. Until then the
                store that shipped the goods would be signing for its own delivery. */}
            {editing && ["ISSUED", "DISPATCHED"].includes(doc?.status ?? "") && (
              <Can do="issue.view">
                {doc?.can_acknowledge ? (
                  <Button onClick={() => setConfirming("ack")}>Acknowledge</Button>
                ) : (
                  <Button disabled title="Waiting for the requester to confirm this delivery in My deliveries">
                    Acknowledge
                  </Button>
                )}
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

      <ErrorBanner error={save.error ?? saveSerials.error ?? pullIndent.error ?? pickingSource.error} />
      {mixedProjects && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-info/30 bg-info-bg px-4 py-3 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Some lines draw on stock received for another project, or for none. That is
            allowed — stock is one pool. Each line keeps its source project in the ledger.
          </span>
        </div>
      )}
      {touched && !form.warehouse_id && <ErrorBanner error="Pick the issuing warehouse." />}
      {touched && form.items.length === 0 && <ErrorBanner error="Add at least one line." />}

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.issue_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Stock" value={doc.is_stock_posted ? `Posted ${fmtDateTime(doc.posted_at)}` : "Not posted"} />
          <MetaRow label="Against indent" value={<span className="font-mono">{doc.indent_no ?? "—"}</span>} />
          <MetaRow label="Fulfilment" value={<span className="font-mono">{doc.pick_no ?? "—"}</span>} />
          {/* `issued_by` is only stamped when stock is posted; before that the row
            * still has an author, and a blank field read as missing data. */}
          <MetaRow label="Issued by" value={doc.issued_by_name || doc.created_by_name || "—"} />
          <MetaRow label="Acknowledged by" value={doc.acknowledged_by_name || "—"} />
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
                    isDisabled={locked || !!form.picking_id || direction === "IN"}
                    onChange={(v, option) => {
                      setForm({ ...form, warehouse_id: Number(v) || 0, items: [] });
                      setIsBinManaged((option as any)?.is_bin_managed ?? true);
                    }}
                    placeholder="Warehouse" />
          </Field>
          <Field label="Against indent" hint="Loads the approved stock reservation.">
            <Lookup name={`indents-${form.warehouse_id}`}
                    load={(search) => indentOptions(search, form.warehouse_id || undefined)}
                    // The loader lists indents still open to be issued, so once this
                    // issue exists its own indent has left that list. Without the
                    // fallback the field on a saved document reads "Indent" in grey
                    // while the header above it names IND/2026-27/00196.
                    fallback={doc?.indent_id
                      ? [{ id: doc.indent_id, name: doc.indent_no ?? String(doc.indent_id) }]
                      : []}
                    value={form.indent_id ?? ""} isDisabled={locked || !form.warehouse_id}
                    onChange={(v) => {
                const indentId = v === "" ? null : v;
                set("indent_id", indentId);
                if (!indentId) setDestination("");
                if (indentId && form.warehouse_id) pullIndent.mutate(indentId);
              }} placeholder={form.warehouse_id ? "Indent" : "Pick warehouse first"} />
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
          <Field label="Issued to">
            <Lookup name="employees" load={employeeOptions} value={form.issued_to_id ?? ""} isDisabled={locked}
                    // The list is the first page of employees, so a person outside it
                    // — the indent raiser this draft defaulted to — would render as the
                    // grey "Person" placeholder over a value that is set.
                    fallback={form.issued_to_id
                      ? [{ id: form.issued_to_id, name: issuedToName ?? String(form.issued_to_id) }]
                      : []}
                    onChange={(v, option) => {
                      set("issued_to_id", v === "" ? null : v);
                      setIssuedToName(option?.name ?? null);
                    }} placeholder="Person" />
          </Field>
          <Field label="Vehicle">
            <Input value={form.vehicle_number ?? ""} disabled={locked}
                   onChange={(e) => set("vehicle_number", e.target.value)} placeholder="Vehicle number" />
          </Field>
          <Field label="Destination" hint="Office of the issued-to employee from the selected indent.">
            <Input value={destination || "—"} disabled />
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
          minTableWidth="min-w-[1600px]"
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

      <SerialNumbersModal
        isOpen={serialLine !== null}
        onClose={() => setSerialLine(null)}
        quantity={serialLine === null ? 0 : num(form.items[serialLine]?.issued_qty)}
        initial={serialLine === null ? [] : form.items[serialLine]?.serial_numbers ?? []}
        available={availableSerials.data?.items.map((row) => row.serial_number) ?? []}
        pickMode="select"
        itemLabel={
          serialLine === null
            ? ""
            : savedLine(serialLine)?.item_name
              ?? form.items[serialLine]?.item_name
              ?? `Line ${serialLine + 1}`
        }
        readOnly={serialsLocked}
        onSave={(serials) => {
          if (serialLine === null) return;
          patchLine(serialLine, { serial_numbers: serials });
          // On a draft the serials ride along with the next save. On an approved
          // issue there is no save left to ride, so they go to the server now.
          const lineId = savedLine(serialLine)?.id;
          if (locked && lineId) saveSerials.mutate({ id: lineId, serial_numbers: serials });
        }}
      />

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
        isOpen={confirming === "approve" || confirming === "reject"}
        title={confirming === "approve" ? "Approve this issue?" : "Reject this issue?"}
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
          {direction === "IN" && (
            <Field label="Original material issue" hint="Loads only the quantity still returnable.">
              <Lookup
                name="original-issues"
                load={returnableIssueOptions}
                value={form.original_issue_id ?? ""}
                isDisabled={locked}
                onChange={(value) => {
                  const issueId = value === "" ? null : value;
                  set("original_issue_id", issueId);
                  if (issueId) pullOriginal.mutate(issueId);
                }}
                placeholder="Select issued document"
              />
            </Field>
          )}
        </div>
      </ConfirmModal>

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
