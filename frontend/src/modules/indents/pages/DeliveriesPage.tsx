import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, FileText, Trash2 } from "lucide-react";
import {
  Button, Card, ConfirmModal, EmptyState, ErrorBanner, Input, ResponsiveList, Select,
  StatusPill, type Column,
} from "@/shared/components";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
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

// PARTIALLY_ORDERED and ORDERED are offered even though no live indent holds either
// yet: they are reachable the moment procurement starts raising POs off indents, and
// a status you cannot filter is a status you cannot find.
const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "ALLOCATED", label: "Allocated" },
  { value: "PARTIALLY_FULFILLED", label: "Partly received" },
  { value: "PARTIALLY_ORDERED", label: "Partly ordered" },
  { value: "ORDERED", label: "Ordered" },
  { value: "PENDING_PROCUREMENT", label: "With procurement" },
  // Fully received. The list used to end at the statuses still owing goods, so an
  // indent disappeared the moment its last line was confirmed.
  { value: "CLOSED", label: "Completed" },
];

const qty = (value: number) => Number(value ?? 0).toLocaleString();

/** The most it makes sense to confirm today: what reached you but is unconfirmed. */
const receivable = (line: DeliveryLine) =>
  Math.max(line.dispatched_quantity - line.received_quantity, 0);

const outstanding = (line: DeliveryLine) =>
  Math.max(line.approved_quantity - line.received_quantity, 0);

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
    <li className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
      {isBill ? <FileText className="h-4 w-4 shrink-0 text-muted" />
        : <Camera className="h-4 w-4 shrink-0 text-muted" />}
      <span className="min-w-0 flex-1 truncate">{attachment.file_name}</span>
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">
        {isBill ? "Bill" : "Photo"}
      </span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${attachment.file_name}`}
        className="shrink-0 rounded p-1 text-muted hover:text-bad disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
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

  // The file inputs are driven by ref rather than by a wrapping <label>; `pending`
  // is only so the right button reads "Uploading…" while its file is in flight.
  const photoInput = useRef<HTMLInputElement>(null);
  const billInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);

  const attachments = useQuery({
    queryKey: ["indent-receipt-attachments", delivery.indent_id],
    queryFn: () => indentApi.receiptAttachments(delivery.indent_id),
  });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      indentApi.uploadReceiptAttachment(delivery.indent_id, file, category),
    onSuccess: () => attachments.refetch(),
    onSettled: () => setPending(null),
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

  return (
    <ConfirmModal
      isOpen
      title={delivery.indent_no}
      confirmLabel={anythingToConfirm ? "I received these" : "Close"}
      busy={confirm.isPending}
      error={confirm.error ?? upload.error ?? remove.error}
      onConfirm={anythingToConfirm ? () => confirm.mutate() : onClose}
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="px-2 py-2 text-right font-medium">Approved</th>
                <th className="px-2 py-2 text-right font-medium">Sent</th>
                <th className="px-2 py-2 text-right font-medium">Received</th>
                {anythingToConfirm && (
                  <th className="py-2 pl-2 text-right font-medium">Arrived now</th>
                )}
              </tr>
            </thead>
            <tbody>
              {delivery.lines.map((line) => {
                const max = receivable(line);
                return (
                  <tr key={line.indent_item_id} className="border-t border-line align-top">
                    <td className="py-2.5 pr-3">
                      <div className="text-ink">{line.item_name ?? line.item_code}</div>
                      <div className="font-mono text-[11px] text-muted">{line.item_code}</div>
                      {outstanding(line) > 0 && line.pending_with && (
                        <div className="mt-0.5 text-[11px] text-muted">{line.pending_with}</div>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {qty(line.approved_quantity)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {qty(line.dispatched_quantity)}
                    </td>
                    <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-ink">
                      {qty(line.received_quantity)}
                    </td>
                    {anythingToConfirm && (
                      <td className="py-2.5 pl-2">
                        {/* Fixed-width wrapper, not a class on the Input: `className`
                            only reaches HeroUI's inputWrapper, so the field itself stays
                            100% wide and would squash the columns beside it. */}
                        <div className="ml-auto w-24">
                          <Input
                            type="number"
                            min={0}
                            max={max}
                            step="any"
                            disabled={max === 0}
                            aria-label={`Received now for ${line.item_name ?? line.item_code}`}
                            value={received[line.indent_item_id] ?? ""}
                            onChange={(event) =>
                              setReceived((current) => ({
                                ...current,
                                [line.indent_item_id]: event.target.value,
                              }))}
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {anythingToConfirm && (
          <div>
            <div className="mb-1 text-sm font-semibold text-ink">
              Photo of the goods <span className="text-bad">*</span>
            </div>
            <p className="mb-2 text-xs text-muted">
              Required. Add the bill too if you were given one.
            </p>
            {/* Real buttons that click a ref'd input, NOT a <label> wrapping a
                `display:none` input. The label form silently stopped opening the
                picker inside this modal: a `display:none` input is not focusable, and
                the modal's focus scope swallows the forwarded click, so the only
                visible effect of pressing "Add photo" was the label text getting
                selected. `sr-only` keeps the input rendered and reachable. */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => photoInput.current?.click()}
                disabled={upload.isPending}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm transition-colors hover:bg-default disabled:opacity-60"
              >
                <Camera className="h-4 w-4" />
                {upload.isPending && pending === PHOTO ? "Uploading…" : "Add photo"}
              </button>
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setPending(PHOTO);
                    upload.mutate({ file, category: PHOTO });
                  }
                  event.target.value = "";
                }}
              />

              <button
                type="button"
                onClick={() => billInput.current?.click()}
                disabled={upload.isPending}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm transition-colors hover:bg-default disabled:opacity-60"
              >
                <FileText className="h-4 w-4" />
                {upload.isPending && pending === BILL ? "Uploading…" : "Add bill"}
              </button>
              <input
                ref={billInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setPending(BILL);
                    upload.mutate({ file, category: BILL });
                  }
                  event.target.value = "";
                }}
              />
            </div>

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

            {photos.length === 0 && (
              <p className="mt-2 text-xs text-bad">
                Attach at least one photo before confirming.
              </p>
            )}
            {!entered && (
              <p className="mt-2 text-xs text-bad">
                Enter what you received on at least one line.
              </p>
            )}
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
      render: (row) => <StatusPill status={row.status} />,
    },
    {
      key: "action",
      header: "",
      render: (row) => (row.can_acknowledge ? (
        <Button onClick={() => setOpen(row)}>
          <CheckCircle2 className="h-4 w-4" /> Confirm
        </Button>
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
        <Button
          variant={onlyActionable ? "primary" : "subtle"}
          onClick={() => setOnlyActionable((current) => !current)}
        >
          <CheckCircle2 className="h-4 w-4" /> Ready to confirm
        </Button>
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
              <StatusPill status={row.status} />
            </div>
            <div className="text-sm text-muted">{summarise(row)}</div>
            <div className="text-[11px] text-muted">
              {row.lines.length} item{row.lines.length === 1 ? "" : "s"}
              {row.required_date ? ` · needed by ${row.required_date}` : ""}
            </div>
            {row.can_acknowledge && (
              <Button onClick={() => setOpen(row)}>
                <CheckCircle2 className="h-4 w-4" /> Confirm receipt
              </Button>
            )}
          </div>
        )}
      />

      {open && <DeliveryModal delivery={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
