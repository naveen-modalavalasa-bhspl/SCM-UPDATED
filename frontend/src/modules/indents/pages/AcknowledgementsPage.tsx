import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera, CheckCircle2, Circle, ExternalLink, FileText, ListFilter, PackageCheck,
  Trash2, TriangleAlert, Truck,
} from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, EmptyState, ErrorBanner, Input, ResponsiveList, Select,
  type Column,
} from "@/shared/components";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import { INDENT_STATUS } from "../constants";
import { indentApi, indentKeys, useIndentAccountScope } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import type {
  Acknowledgement, AcknowledgementLine, RaiserTracking, ReceiptAttachment,
} from "../types";

/**
 * What the requester is still owed, and acknowledging it arrived.
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

// The three states a requester's goods are ever in from their side: set aside, part
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
const receivable = (line: AcknowledgementLine) =>
  Math.max(line.dispatched_quantity - line.received_quantity, 0);

const outstanding = (line: AcknowledgementLine) =>
  Math.max(line.approved_quantity - line.received_quantity, 0);

/**
 * What the status says to the person who raised it. CLOSED reads as FULFILLED (the
 * badge does that wording), and anything that landed short of what was approved reads
 * as PARTIALLY FULFILLED — "closed" is a system word, and a requester who got 8 of 10
 * has not been fulfilled.
 */
function displayStatus(row: Acknowledgement) {
  if (row.status !== INDENT_STATUS.CLOSED) return row.status;
  return row.lines.some((line) => outstanding(line) > 0)
    ? INDENT_STATUS.PARTIALLY_FULFILLED
    : INDENT_STATUS.CLOSED;
}

/** One line of summary for a whole indent, so the row says something without opening. */
function summarise(row: Acknowledgement) {
  const waiting = row.lines.reduce((sum, line) => sum + receivable(line), 0);
  const open = row.lines.filter((line) => outstanding(line) > 0).length;
  if (waiting > 0) return `${qty(waiting)} waiting for you to acknowledge`;
  if (open === 0) return "Everything received";
  // Every remaining line is stuck at the same place more often than not; naming the
  // commonest is more use than counting them.
  const reasons = row.lines
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
  line: AcknowledgementLine;
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
          {settled ? "Received" : max > 0 ? `${qty(max)} to acknowledge` : "On the way"}
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

/** The handle a requester actually chases a parcel with, whichever the mode issued. */
const trackingHandle = (leg: { lr_no?: string | null; docket_no?: string | null }) =>
  leg.lr_no ?? leg.docket_no ?? null;

/**
 * How this delivery is travelling — the answer to "where is my stuff".
 *
 * Logistics knows the courier, the docket and the carrier's tracking page; the person
 * waiting on the goods held none of it, and had no screen they were permitted to read
 * it on. It rides on this row instead: told once, on the same card as the button that
 * says it arrived.
 */
function ShipmentCard({ leg }: { leg: RaiserTracking }) {
  const handle = trackingHandle(leg);
  // An outside company is carrying it — a courier or a third-party truck. That is
  // exactly when "how is it coming" stops being obvious to the person waiting for it,
  // and it is read off the carrier rather than off a list of mode names, because this
  // module may not import logistics' mode tables (rule 5). A hand-over and a company
  // vehicle have no carrier, and their answer to "where is it" is the driver below.
  const outside = Boolean(leg.carrier_name);

  const who = leg.carrier_name
    || [leg.vehicle_number, leg.driver_name].filter(Boolean).join(" · ");
  const landed = leg.acknowledged_at ?? leg.delivered_at;
  const latest = [...(leg.events ?? [])].sort(
    (left, right) => Date.parse(right.event_at) - Date.parse(left.event_at),
  )[0];
  return (
    <li className="rounded-xl border border-line bg-content1 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-050 text-brand">
          <Truck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs font-semibold text-ink">{leg.tr_no}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted">
              {leg.status.replace(/_/g, " ").toLowerCase()}
            </span>
          </div>
          <div className="text-sm text-body">{who || "Hand delivery"}</div>
          {outside && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px] font-medium text-body">
                {leg.carriage_label ?? "Road"}
              </span>
              <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-medium text-brand">
                {leg.mode_label ?? leg.mode}
              </span>
            </div>
          )}
          {handle && (
            <div className="mt-0.5 text-xs text-muted">
              Docket <span className="font-mono text-ink">{handle}</span>
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-muted">
            {landed
              ? `Arrived ${landed.slice(0, 10)}`
              : leg.dispatched_at
                ? `Sent ${leg.dispatched_at.slice(0, 10)}${
                  leg.expected_delivery ? ` · due ${leg.expected_delivery}` : ""}`
                : "Not yet sent"}
          </div>
          {latest && (
            <div className={`mt-2 rounded-lg px-2.5 py-2 text-xs ${
              latest.is_exception ? "bg-bad-bg text-bad" : "bg-content2 text-body"
            }`}>
              <span className="font-semibold capitalize">
                {latest.event_type.replace(/_/g, " ").toLowerCase()}
              </span>
              {latest.location_name ? ` · ${latest.location_name}` : ""}
              {latest.description && (
                <span className="mt-0.5 block text-[11px] text-muted">{latest.description}</span>
              )}
            </div>
          )}
        </div>
        {leg.tracking_url && (
          <a
            href={leg.tracking_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg border border-line px-3 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
          >
            Track <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

    </li>
  );
}

/** One line of the "before you acknowledge" list — ticked green the moment it is satisfied. */
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
 * Viewing and confirming are the same modal on purpose. Someone who opens a row to
 * ask "where is it" is exactly the person who has just been handed the box.
 */
function AcknowledgementModal({ row, onClose }: {
  row: Acknowledgement;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const accountScope = useIndentAccountScope();
  const [received, setReceived] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      row.lines
        .filter((line) => receivable(line) > 0)
        .map((line) => [line.indent_item_id, String(receivable(line))]),
    ));
  // Damage is the ONE thing the quantities above cannot say. A shortage needs no
  // control here — typing a smaller number is the report — so there is no SHORT
  // option to contradict what was entered.
  const [damaged, setDamaged] = useState(false);
  const [remarks, setRemarks] = useState("");

  const attachments = useQuery({
    queryKey: ["indent-receipt-attachments", row.indent_id],
    queryFn: () => indentApi.receiptAttachments(row.indent_id),
  });

  // Tracking is an extra read-only answer to "where is it?". It does not replace or
  // submit the existing indent receipt form below.
  const tracking = useQuery({
    queryKey: indentKeys.shipments(accountScope, row.indent_id),
    queryFn: ({ signal }) => indentApi.shipmentsForIndent(row.indent_id, signal),
    refetchOnWindowFocus: true,
  });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      indentApi.uploadReceiptAttachment(row.indent_id, file, category),
    onSuccess: () => attachments.refetch(),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) => indentApi.deleteReceiptAttachment(attachmentId),
    onSuccess: () => attachments.refetch(),
  });

  const confirm = useMutation({
    mutationFn: () =>
      indentApi.acknowledge(
        row.indent_id,
        Object.entries(received)
          .map(([id, value]) => ({
            indent_item_id: Number(id),
            received_quantity: Number(value),
          }))
          .filter((line) => line.received_quantity > 0),
        damaged
          ? { condition: "DAMAGED", remarks: remarks.trim() }
          : { condition: "GOOD" },
      ),
    onMutate: () => cancelIndentReceiptReads(qc, accountScope, row.indent_id),
    onSuccess: async (updated) => {
      await commitConfirmedIndentReceipt(qc, accountScope, updated);
      qc.invalidateQueries({ queryKey: ["indent-acknowledgements"] });
      qc.invalidateQueries({ queryKey: ["indent-fulfilment"] });
      onClose();
    },
  });

  const photos = (attachments.data ?? []).filter((a) => a.doc_category === PHOTO);
  const entered = Object.values(received).some((value) => Number(value) > 0);
  const anythingToConfirm = row.lines.some((line) => receivable(line) > 0);
  const waiting = row.lines.reduce((sum, line) => sum + receivable(line), 0);
  // Two very different reasons there is no button, and one message used to cover both:
  // "already acknowledged" told a requester whose goods had not left the warehouse
  // that they had signed for them. Nothing dispatched at all is the other case, and
  // the honest thing to say is that there is nothing here yet.
  const nothingSentYet = row.lines.every((line) => line.dispatched_quantity <= 0);
  // Reporting damage without saying what was damaged gives the claim nothing to be
  // investigated from, and the backend refuses it — so the button waits here too.
  const ready = entered && photos.length > 0 && (!damaged || remarks.trim().length > 0);

  return (
    <ConfirmModal
      isOpen
      title={row.indent_no}
      confirmLabel={anythingToConfirm ? "Acknowledge receipt" : "Close"}
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
              : nothingSentYet
                ? "border-line bg-content2"
                : "border-ok/25 bg-ok-bg"
          }`}
        >
          {anythingToConfirm
            ? <PackageCheck className="h-5 w-5 shrink-0 text-brand" />
            : nothingSentYet
              ? <Truck className="h-5 w-5 shrink-0 text-muted" />
              : <CheckCircle2 className="h-5 w-5 shrink-0 text-ok" />}
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-ink">
              {anythingToConfirm
                ? `${qty(waiting)} waiting for you to acknowledge`
                : nothingSentYet
                  ? "Nothing has reached you yet"
                  : "Nothing left to acknowledge"}
            </div>
            <div className="text-xs text-muted">
              {anythingToConfirm
                ? "Check the quantity on each item, then attach a photo of the goods."
                : nothingSentYet
                  ? "Nothing on this indent has been dispatched to you yet. "
                    + "Follow it below; the confirm box opens once it is on its way."
                  : "Everything sent to you has already been acknowledged."}
            </div>
          </div>
          {row.project_name && (
            <span className="ml-auto hidden shrink-0 text-xs text-muted sm:block">
              {row.project_name}
            </span>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-ink">Material tracking</div>
            {tracking.isFetching && <span className="text-[11px] text-muted">Refreshing…</span>}
          </div>
          {tracking.isLoading ? (
            <div className="rounded-xl border border-line bg-content2 px-3 py-4 text-xs text-muted">
              Checking with logistics…
            </div>
          ) : tracking.error ? (
            <div className="rounded-xl border border-warn/30 bg-warn-bg px-3 py-3 text-xs text-warn">
              Tracking is temporarily unavailable. You can still acknowledge the receipt below.
            </div>
          ) : (tracking.data ?? []).length > 0 ? (
            <ul className="space-y-2">
              {(tracking.data ?? []).map((leg) => (
                <ShipmentCard key={leg.tr_id} leg={leg} />
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed border-line bg-content2/60 px-3 py-4 text-xs text-muted">
              No logistics shipment has been created for this indent yet.
            </div>
          )}
        </div>

        <ul className="space-y-2.5">
          {row.lines.map((line) => (
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
                  accept="image/*,application/pdf"
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

            {/* The state the goods arrived in. Asked here, on the same card as the
                photo, because the person answering it is holding the box. Two choices
                and not three: a shortage is the quantity field's job above, and a
                SHORT option here could contradict what was typed there. */}
            <div className="mt-4 border-t border-line pt-3">
              <div className="text-sm font-semibold text-ink">How did it arrive?</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  aria-pressed={!damaged}
                  onClick={() => setDamaged(false)}
                  className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
                    !damaged
                      ? "border-ok bg-ok-bg text-ok"
                      : "border-line bg-content1 text-body hover:border-ok/40"
                  }`}
                >
                  <CheckCircle2 className="h-4 w-4" /> Good condition
                </button>
                <button
                  type="button"
                  aria-pressed={damaged}
                  onClick={() => setDamaged(true)}
                  className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
                    damaged
                      ? "border-bad bg-bad-bg text-bad"
                      : "border-line bg-content1 text-body hover:border-bad/40"
                  }`}
                >
                  <TriangleAlert className="h-4 w-4" /> Something was damaged
                </button>
              </div>
              {damaged && (
                <div className="mt-2">
                  <textarea
                    aria-label="What was damaged"
                    value={remarks}
                    onChange={(event) => setRemarks(event.target.value)}
                    rows={3}
                    placeholder="What was damaged, and how much of it?"
                    className="w-full rounded-xl border border-line bg-content1 px-3 py-2 text-sm text-ink outline-none transition placeholder:text-muted focus:border-brand"
                  />
                  <p className="mt-1 text-[11px] text-muted">
                    This opens a claim on the shipment for the logistics desk to chase.
                  </p>
                </div>
              )}
            </div>

            {/* Two red sentences read as errors for something you have not done yet.
                A checklist reads as what is left, and goes green as you do it. */}
            <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
              <Requirement met={entered} label="A quantity entered on at least one item" />
              <Requirement met={photos.length > 0} label="A photo of the goods attached" />
              {damaged && (
                <Requirement
                  met={remarks.trim().length > 0}
                  label="A description of the damage"
                />
              )}
            </ul>
          </div>
        )}
      </div>
    </ConfirmModal>
  );
}

export default function AcknowledgementsPage() {
  const [open, setOpen] = useState<Acknowledgement | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [onlyActionable, setOnlyActionable] = useState(false);

  // Filtering happens server-side so the list stays honest when it grows past a page.
  const filters = useMemo(
    () => ({ search: search.trim() || undefined, status: status || undefined,
             only_actionable: onlyActionable || undefined }),
    [search, status, onlyActionable],
  );

  const acknowledgements = useQuery({
    queryKey: ["indent-acknowledgements", filters],
    queryFn: () => indentApi.myAcknowledgements(filters),
  });

  const rows = acknowledgements.data ?? [];
  // What the pill would leave on screen. The endpoint returns the whole list rather
  // than a page, so counting the loaded rows is the true number; with the filter
  // already on, the server has narrowed it and every row here is one of them.
  const readyCount = rows.filter((row) => row.can_acknowledge).length;

  const columns: Column<Acknowledgement>[] = [
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
      render: (row) => {
        // The docket, on the row. Someone scanning this list for "has mine shipped"
        // should not have to open every one of them to find out.
        const leg = row.shipments[0];
        const handle = leg ? trackingHandle(leg) : null;
        return (
          <div className="min-w-0">
            <div className="text-sm text-muted">{summarise(row)}</div>
            {leg && (
              <div className="truncate text-[11px] text-muted">
                {leg.carrier_name ?? leg.vehicle_number ?? "Hand delivery"}
                {handle ? ` · ${handle}` : ""}
              </div>
            )}
          </div>
        );
      },
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
            <CheckCircle2 className="h-4 w-4" /> Acknowledge
          </Button>
        </Can>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Same header as the other indent screens, minus the shared filter bar: this list
          has its own, and the shared one filters a different query shape. */}
      <IndentModuleHeader title="Acknowledgements" showCreate={false} showFilters={false} />

      <Card className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Search acknowledgements"
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
            the tick icon the row's Acknowledge uses. Lit when on, quiet when off, and it
            says so to a screen reader through aria-pressed. The count is the point of
            the pill: it tells you whether pressing it is worth anything before you do. */}
        <button
          type="button"
          aria-pressed={onlyActionable}
          title={onlyActionable
            ? "Showing only what you can acknowledge — press to show everything"
            : "Show only the indents waiting for your acknowledgement"}
          onClick={() => setOnlyActionable((current) => !current)}
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
            onlyActionable
              ? "border-brand bg-brand/10 text-brand"
              : "border-line bg-content1 text-body hover:border-brand/40 hover:bg-content2"
          }`}
        >
          <ListFilter className="h-4 w-4" />
          Ready to acknowledge
          {readyCount > 0 && (
            <span
              className={`min-w-5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                onlyActionable ? "bg-brand text-white" : "bg-brand-050 text-brand"
              }`}
            >
              {readyCount}
            </span>
          )}
        </button>
      </Card>

      <ErrorBanner error={acknowledgements.error} />

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.indent_id}
        loading={acknowledgements.isLoading}
        onRowClick={(row) => setOpen(row)}
        empty={
          <EmptyState
            title={search || status || onlyActionable ? "Nothing matches" : "Nothing on its way"}
            hint={
              search || status || onlyActionable
                ? "Try a different search or clear the filters."
                : "Indents you raise appear here once they are approved, so you can track them and acknowledge what arrives."
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
                  <CheckCircle2 className="h-4 w-4" /> Acknowledge receipt
                </Button>
              </Can>
            )}
          </div>
        )}
      />

      {open && <AcknowledgementModal row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
