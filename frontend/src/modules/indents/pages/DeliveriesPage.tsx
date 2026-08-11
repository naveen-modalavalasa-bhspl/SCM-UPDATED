import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera, CheckCircle2, Circle, FileText, ListFilter, PackageCheck, Trash2,
} from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, EmptyState, ErrorBanner, Input, ResponsiveList, Select,
  type Column,
} from "@/shared/components";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { INDENT_STATUS } from "../constants";
import { indentApi, useIndentAccountScope } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import type { Delivery, DeliveryLine, ReceiptAttachment } from "../types";

/**
 * What the requester is still owed, and confirming it arrived.
 *
 * This is the only screen that closes an indent. The warehouse issuing and dispatching
 * stock records that the goods left; nothing until now recorded that they landed, which
 * is why every indent in the system sat on ALLOCATED forever.
 *
 * One row per indent, not per line. An indent with a hundred items must not push the
 * next indent off the screen — the lines live inside the row you open.
 */

const PHOTO = "RECEIPT_PHOTO";
const BILL = "RECEIPT_BILL";

// The three states a requester's delivery is ever in from their side: set aside, part
// of it arrived, all of it arrived. The procurement statuses were noise here — nothing
// on this screen can be done about an indent that is still being bought in.
const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: INDENT_STATUS.ALLOCATED, label: "Allocated" },
  { value: INDENT_STATUS.PARTIALLY_FULFILLED, label: "Partially fulfilled" },
  { value: INDENT_STATUS.CLOSED, label: "Fulfilled" },
];

const qty = (value: number) => Number(value ?? 0).toLocaleString();

/** The most it makes sense to confirm today: what reached you but is unconfirmed. */
const receivable = (line: DeliveryLine) =>
  Math.max(line.dispatched_quantity - line.received_quantity, 0);

const outstanding = (line: DeliveryLine) =>
  Math.max(line.approved_quantity - line.received_quantity, 0);

/**
 * What the status says to the person who raised it. CLOSED reads as FULFILLED (the
 * badge does that wording), and anything that landed short of what was approved reads
 * as PARTIALLY FULFILLED — "closed" is a system word, and a requester who got 8 of 10
 * has not been fulfilled.
 */
function displayStatus(delivery: Delivery) {
  if (delivery.status !== INDENT_STATUS.CLOSED) return delivery.status;
  return delivery.lines.some((line) => outstanding(line) > 0)
    ? INDENT_STATUS.PARTIALLY_FULFILLED
    : INDENT_STATUS.CLOSED;
}

/** One line of summary for a whole indent, so the row says something without opening. */
function summarise(delivery: Delivery) {
  const waiting = delivery.lines.reduce((sum, line) => sum + receivable(line), 0);
  const open = delivery.lines.filter((line) => outstanding(line) > 0).length;
  if (waiting > 0) return `${qty(waiting)} waiting for you to confirm`;
  if (open === 0) return "Everything received";
  // Every remaining line is stuck at the same place more often than not; naming the
  // commonest is more use than counting them.
  const reasons = delivery.lines
    .filter((line) => outstanding(line) > 0)
    .map((line) => line.pending_with)
    .filter(Boolean) as string[];
  const commonest = reasons
    .sort((a, b) =>
      reasons.filter((r) => r === b).length - reasons.filter((r) => r === a).length)[0];
  return commonest ?? `${open} item${open === 1 ? "" : "s"} outstanding`;
}

function AttachmentRow({ attachment, onDelete, busy }: {
  attachment: ReceiptAttachment;
  onDelete: () => void;
  busy: boolean;
}) {
  const isBill = attachment.doc_category === BILL;
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-line bg-content1 px-3 py-2 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-ok">
        {isBill ? <FileText className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{attachment.file_name}</span>
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {isBill ? "Bill" : "Photo"}
      </span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${attachment.file_name}`}
        className="shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-bad-bg hover:text-bad disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/**
 * One item of the indent: how far it has got, and the box to say what turned up.
 *
 * A card rather than a table row — the table needed 520px and slid sideways on a phone,
 * which is exactly where someone standing at the delivery confirms it.
 */
function LineCard({ line, value, onChange }: {
  line: DeliveryLine;
  value: string;
  onChange: (value: string) => void;
}) {
  const max = receivable(line);
  const approved = Number(line.approved_quantity ?? 0);
  const settled = outstanding(line) === 0;
  // Approved is the whole bar; what was sent shades it, what you confirmed fills it.
  const width = (amount: number) =>
    (approved > 0 ? `${Math.min(100, (Number(amount ?? 0) / approved) * 100)}%` : "0%");

  return (
    <li className="rounded-xl border border-line bg-content1 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink">{line.item_name ?? line.item_code}</div>
          <div className="font-mono text-[11px] text-muted">{line.item_code}</div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            settled ? "bg-ok-bg text-ok"
              : max > 0 ? "bg-brand-050 text-brand"
                : "bg-neutral-bg text-neutral"
          }`}
        >
          {settled ? "Received" : max > 0 ? `${qty(max)} to confirm` : "On the way"}
        </span>
      </div>

      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-content3">
        <div className="absolute inset-y-0 left-0 bg-brand/30"
             style={{ width: width(line.dispatched_quantity) }} />
        <div className="absolute inset-y-0 left-0 bg-ok"
             style={{ width: width(line.received_quantity) }} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>Approved <b className="font-semibold tabular-nums text-ink">
          {qty(line.approved_quantity)}</b></span>
        <span>Sent <b className="font-semibold tabular-nums text-ink">
          {qty(line.dispatched_quantity)}</b></span>
        <span>Received <b className="font-semibold tabular-nums text-ink">
          {qty(line.received_quantity)}</b></span>
      </div>

      {!settled && line.pending_with && (
        <div className="mt-1.5 text-[11px] text-muted">{line.pending_with}</div>
      )}

      {max > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-content2 p-2">
          <span className="pl-1 text-sm font-medium text-body">Arrived now</span>
          {/* Fixed-width wrapper, not a class on the Input: `className` only reaches
              HeroUI's inputWrapper, so the field itself stays 100% wide. */}
          <div className="ml-auto w-24">
            <Input
              type="number"
              min={0}
              max={max}
              step="any"
              aria-label={`Received now for ${line.item_name ?? line.item_code}`}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(String(max))}
            className="h-11 shrink-0 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
          >
            All {qty(max)}
          </button>
        </div>
      )}
    </li>
  );
}

/** One line of the "before you confirm" list — ticked green the moment it is satisfied. */
function Requirement({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${met ? "text-ok" : "text-muted"}`}>
      {met ? <CheckCircle2 className="h-4 w-4 shrink-0" />
        : <Circle className="h-4 w-4 shrink-0" />}
      <span>{label}</span>
    </li>
  );
}

/**
 * The whole indent, opened: every line's progress, and the fields to confirm receipt.
 *
 * Viewing and confirming are the same modal on purpose. Someone who opens a delivery to
 * ask "where is it" is exactly the person who has just been handed the box.
 */
function DeliveryModal({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const qc = useQueryClient();
  const accountScope = useIndentAccountScope();
  const [received, setReceived] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      delivery.lines
        .filter((line) => receivable(line) > 0)
        .map((line) => [line.indent_item_id, String(receivable(line))]),
    ));

  const attachments = useQuery({
    queryKey: ["indent-receipt-attachments", delivery.indent_id],
    queryFn: () => indentApi.receiptAttachments(delivery.indent_id),
  });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      indentApi.uploadReceiptAttachment(delivery.indent_id, file, category),
    onSuccess: () => attachments.refetch(),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) => indentApi.deleteReceiptAttachment(attachmentId),
    onSuccess: () => attachments.refetch(),
  });

  const confirm = useMutation({
    mutationFn: () =>
      indentApi.acknowledge(
        delivery.indent_id,
        Object.entries(received)
          .map(([id, value]) => ({
            indent_item_id: Number(id),
            received_quantity: Number(value),
          }))
          .filter((line) => line.received_quantity > 0),
      ),
    onMutate: () => cancelIndentReceiptReads(qc, accountScope, delivery.indent_id),
    onSuccess: async (updated) => {
      await commitConfirmedIndentReceipt(qc, accountScope, updated);
      qc.invalidateQueries({ queryKey: ["indent-deliveries"] });
      qc.invalidateQueries({ queryKey: ["indent-fulfilment"] });
      onClose();
    },
  });

  const photos = (attachments.data ?? []).filter((a) => a.doc_category === PHOTO);
  const entered = Object.values(received).some((value) => Number(value) > 0);
  const anythingToConfirm = delivery.lines.some((line) => receivable(line) > 0);
  const waiting = delivery.lines.reduce((sum, line) => sum + receivable(line), 0);
  const ready = entered && photos.length > 0;

  return (
    <ConfirmModal
      isOpen
      title={delivery.indent_no}
      confirmLabel={anythingToConfirm ? "I received these" : "Close"}
      busy={confirm.isPending}
      // The backend rejects a receipt with no photo, so a live button here would only
      // buy a round-trip and an error banner. The checklist below says what is missing.
      confirmDisabled={anythingToConfirm && !ready}
      error={confirm.error ?? upload.error ?? remove.error}
      onConfirm={anythingToConfirm ? () => confirm.mutate() : onClose}
      onClose={onClose}
    >
      <div className="space-y-5">
        {/* Opens with the one number that matters, so the modal answers "what do I owe
            an answer on" before anything has to be read. */}
        <div
          className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
            anythingToConfirm
              ? "border-brand/25 bg-brand-050"
              : "border-ok/25 bg-ok-bg"
          }`}
        >
          {anythingToConfirm
            ? <PackageCheck className="h-5 w-5 shrink-0 text-brand" />
            : <CheckCircle2 className="h-5 w-5 shrink-0 text-ok" />}
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-ink">
              {anythingToConfirm
                ? `${qty(waiting)} waiting for you to confirm`
                : "Nothing left to confirm"}
            </div>
            <div className="text-xs text-muted">
              {anythingToConfirm
                ? "Check the quantity on each item, then attach a photo of the goods."
                : "Everything sent to you has already been acknowledged."}
            </div>
          </div>
          {delivery.project_name && (
            <span className="ml-auto hidden shrink-0 text-xs text-muted sm:block">
              {delivery.project_name}
            </span>
          )}
        </div>

        <ul className="space-y-2.5">
          {delivery.lines.map((line) => (
            <LineCard
              key={line.indent_item_id}
              line={line}
              value={received[line.indent_item_id] ?? ""}
              onChange={(value) =>
                setReceived((current) => ({ ...current, [line.indent_item_id]: value }))}
            />
          ))}
        </ul>

        {anythingToConfirm && (
          <div className="rounded-xl border border-line bg-content2/60 p-3 sm:p-4">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-ink">Proof of delivery</span>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-bad">
                Photo required
              </span>
            </div>
            <p className="mt-0.5 mb-3 text-xs text-muted">
              A photo of the goods as they reached you. Add the bill too if you were given one.
            </p>

            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-4 py-2 text-sm font-medium text-body transition hover:border-brand hover:bg-brand-050 hover:text-brand">
                <Camera className="h-4 w-4" /> Add photo
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) upload.mutate({ file, category: PHOTO });
                    event.target.value = "";
                  }}
                />
              </label>
              <label className="flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-4 py-2 text-sm font-medium text-body transition hover:border-brand hover:bg-brand-050 hover:text-brand">
                <FileText className="h-4 w-4" /> Add bill
                <input
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) upload.mutate({ file, category: BILL });
                    event.target.value = "";
                  }}
                />
              </label>
            </div>

            {upload.isPending && (
              <p className="mt-2 text-xs text-muted">Uploading…</p>
            )}

            {(attachments.data ?? []).length > 0 && (
              <ul className="mt-3 space-y-2">
                {(attachments.data ?? []).map((attachment) => (
                  <AttachmentRow
                    key={attachment.id}
                    attachment={attachment}
                    busy={remove.isPending}
                    onDelete={() => remove.mutate(attachment.id)}
                  />
                ))}
              </ul>
            )}

            {/* Two red sentences read as errors for something you have not done yet.
                A checklist reads as what is left, and goes green as you do it. */}
            <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
              <Requirement met={entered} label="A quantity entered on at least one item" />
              <Requirement met={photos.length > 0} label="A photo of the goods attached" />
            </ul>
          </div>
        )}
      </div>
    </ConfirmModal>
  );
}

export default function DeliveriesPage() {
  const [open, setOpen] = useState<Delivery | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [onlyActionable, setOnlyActionable] = useState(false);

  // Filtering happens server-side so the list stays honest when it grows past a page.
  const filters = useMemo(
    () => ({ search: search.trim() || undefined, status: status || undefined,
             only_actionable: onlyActionable || undefined }),
    [search, status, onlyActionable],
  );

  const deliveries = useQuery({
    queryKey: ["indent-deliveries", filters],
    queryFn: () => indentApi.myDeliveries(filters),
  });

  const rows = deliveries.data ?? [];

  const columns: Column<Delivery>[] = [
    {
      key: "indent",
      header: "Indent",
      render: (row) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{row.indent_no}</div>
          <div className="text-[11px] text-muted">
            {row.required_date ? `Needed by ${row.required_date}` : row.indent_date ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (row) => <span className="text-sm text-muted">{row.project_name ?? "—"}</span>,
    },
    {
      key: "items",
      header: "Items",
      render: (row) => <span className="tabular-nums">{row.lines.length}</span>,
    },
    {
      key: "progress",
      header: "Progress",
      render: (row) => <span className="text-sm text-muted">{summarise(row)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <IndentSummaryStatusBadge status={displayStatus(row)} />,
    },
    {
      key: "action",
      header: "",
      // can_acknowledge is the document's answer ("is this line mine to receive");
      // the permission is the login's. Both have to hold.
      render: (row) => (row.can_acknowledge ? (
        <Can do="indent.acknowledge">
          <Button onClick={() => setOpen(row)}>
            <CheckCircle2 className="h-4 w-4" /> Confirm
          </Button>
        </Can>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Same header as the other indent screens, minus the shared filter bar: this list
          has its own, and the shared one filters a different query shape. */}
      <IndentModuleHeader title="My deliveries" showCreate={false} showFilters={false} />
      <p className="-mt-2 text-sm text-muted">
        What you asked for, how far it has got, and confirming it reached you.
      </p>

      <Card className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Search deliveries"
            placeholder="Search indent no., project or item…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="w-full md:w-56">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(value) => setStatus(String(value ?? ""))}
            options={STATUS_OPTIONS}
            placeholder="Any status"
          />
        </div>
        {/* A filter, not an action — so it is a pill and never wears the solid button or
            the tick icon the row's Confirm uses. Lit when on, quiet when off, and it
            says so to a screen reader through aria-pressed. */}
        <button
          type="button"
          aria-pressed={onlyActionable}
          onClick={() => setOnlyActionable((current) => !current)}
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
            onlyActionable
              ? "border-brand bg-brand/10 text-brand"
              : "border-line bg-content1 text-body hover:bg-content2"
          }`}
        >
          <ListFilter className="h-4 w-4" /> Ready to confirm
        </button>
      </Card>

      <ErrorBanner error={deliveries.error} />

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.indent_id}
        loading={deliveries.isLoading}
        onRowClick={(row) => setOpen(row)}
        empty={
          <EmptyState
            title={search || status || onlyActionable ? "Nothing matches" : "Nothing on its way"}
            hint={
              search || status || onlyActionable
                ? "Try a different search or clear the filters."
                : "Indents you raise appear here once they are approved, so you can track them and confirm what arrives."
            }
          />
        }
        renderCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-xs font-semibold text-ink">{row.indent_no}</div>
                <div className="text-[11px] text-muted">{row.project_name ?? "—"}</div>
              </div>
              <IndentSummaryStatusBadge status={displayStatus(row)} />
            </div>
            <div className="text-sm text-muted">{summarise(row)}</div>
            <div className="text-[11px] text-muted">
              {row.lines.length} item{row.lines.length === 1 ? "" : "s"}
              {row.required_date ? ` · needed by ${row.required_date}` : ""}
            </div>
            {row.can_acknowledge && (
              <Can do="indent.acknowledge">
                <Button onClick={() => setOpen(row)}>
                  <CheckCircle2 className="h-4 w-4" /> Confirm receipt
                </Button>
              </Can>
            )}
          </div>
        )}
      />

      {open && <DeliveryModal delivery={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
