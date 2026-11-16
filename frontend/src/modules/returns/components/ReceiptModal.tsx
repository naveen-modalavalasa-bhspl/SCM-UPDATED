import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera, CheckCircle2, Circle, FileText, PackageCheck, Trash2, TriangleAlert, Truck,
} from "lucide-react";
import { ConfirmModal, Input } from "@/shared/components";
import { returnsApi } from "../api";
import { money } from "../constants";
import {
  RECEIPT_BILL_CATEGORY, RECEIPT_PHOTO_CATEGORY,
  type ReceiptLineWrite, type ReturnAttachment, type ReturnLine, type StockReturn,
} from "../types";

/**
 * Signing for a return at the far end of its leg — the SAME form the indent's
 * acknowledgement uses, because it is the same act by the same kind of person.
 *
 * ADDED 2026-09-10. The press behind this used to be a bare "are you sure": one button,
 * no numbers, no evidence, and it credited the receiving point with everything that had
 * been dispatched whether or not that much came off the truck. A storekeeper standing in
 * front of eleven of fifteen drums had no way to say so, and the only record that
 * anything had been delivered at all was that somebody had clicked.
 *
 * So it asks what the indent asks, and in the same order: how much of each line arrived,
 * a photograph of it, and whether it came in one piece. Every one of those is enforced
 * again in `acknowledge_return` — the checklist below only says what is still missing, so
 * nobody presses a button that was always going to come back with an error.
 *
 * A shortage needs no control of its own: typing a smaller number IS the report, and the
 * server derives it. That is why "how did it arrive" has two answers and not three — a
 * form that could say "all fifteen arrived" and "it was short" in one breath is the
 * disagreement this whole path exists to prevent.
 */

const qty = (value: string | number | null | undefined) =>
  Number(value ?? 0).toLocaleString();

const num = (value: string | number | null | undefined) => Number(value ?? 0);

/** The most that can honestly be signed for today: what was sent, less what is signed. */
const receivable = (line: ReturnLine) =>
  Math.max(num(line.dispatched_quantity) - num(line.received_quantity), 0);

/** One line of the "before you sign" list, ticked green the moment it is satisfied. */
function Requirement({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${met ? "text-ok" : "text-muted"}`}>
      {met ? <CheckCircle2 className="h-4 w-4 shrink-0" />
        : <Circle className="h-4 w-4 shrink-0" />}
      <span>{label}</span>
    </li>
  );
}

function AttachmentRow({ attachment, onDelete, busy }: {
  attachment: ReturnAttachment;
  onDelete: () => void;
  busy: boolean;
}) {
  const isBill = attachment.doc_category === RECEIPT_BILL_CATEGORY;
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-line bg-content1 px-3 py-2 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-ok">
        {isBill ? <FileText className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{attachment.file_name}</span>
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {isBill ? "Paperwork" : "Photo"}
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
 * One line of the return: how much left, how much is signed for, and the box to say
 * what turned up.
 *
 * A card rather than a table row — the person answering it is standing at a tailgate on
 * a phone, which is exactly where a 520px table slides sideways.
 */
function LineCard({ line, value, onChange }: {
  line: ReturnLine;
  value: string;
  onChange: (value: string) => void;
}) {
  const max = receivable(line);
  const sent = num(line.dispatched_quantity);
  const asked = num(line.quantity);
  const settled = sent > 0 && max === 0;
  // What was returned is the whole bar; what was sent shades it, what is signed fills it.
  const width = (amount: number) =>
    (asked > 0 ? `${Math.min(100, (amount / asked) * 100)}%` : "0%");

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
          {settled ? "Signed for"
            : max > 0 ? `${qty(max)} to sign for`
              : "Nothing dispatched"}
        </span>
      </div>

      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-content3">
        <div className="absolute inset-y-0 left-0 bg-brand/30" style={{ width: width(sent) }} />
        <div
          className="absolute inset-y-0 left-0 bg-ok"
          style={{ width: width(num(line.received_quantity)) }}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>Returned <b className="font-semibold tabular-nums text-ink">
          {qty(line.quantity)}</b></span>
        <span>Sent <b className="font-semibold tabular-nums text-ink">{qty(sent)}</b></span>
        <span>Signed <b className="font-semibold tabular-nums text-ink">
          {qty(line.received_quantity)}</b></span>
        {line.uom_code && <span>{line.uom_code}</span>}
      </div>

      {max > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-content2 p-2">
          <span className="pl-1 text-sm font-medium text-body">Arrived now</span>
          {/* Fixed-width wrapper rather than a class on the Input: `className` only
              reaches HeroUI's inputWrapper, so the field itself stays 100% wide. */}
          <div className="ml-auto w-24">
            <Input
              type="number"
              data-uom={line.uom_code ?? ""}
              min={0}
              max={max}
              step="any"
              aria-label={`Quantity received for ${line.item_name ?? line.item_code}`}
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

export function ReceiptModal({ doc, onClose, onDone }: {
  doc: StockReturn;
  onClose: () => void;
  /** Fired after the receipt lands, before the modal closes — for a caller that has to
   *  clear a selection or navigate. Refetching every Returns list is done here. */
  onDone?: (updated: StockReturn) => void;
}) {
  const queryClient = useQueryClient();
  const lines = doc.items ?? [];

  // Opens with the full outstanding quantity on every line, because that is what happens
  // most of the time. Someone who was given less types over it; nobody has to key a
  // complete delivery in line by line.
  const [received, setReceived] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      lines.filter((line) => receivable(line) > 0)
        .map((line) => [line.id, String(receivable(line))]),
    ));
  const [damaged, setDamaged] = useState(false);
  const [remarks, setRemarks] = useState("");
  const attachments = useQuery({
    queryKey: ["returns", doc.id, "attachments"],
    queryFn: () => returnsApi.attachments(doc.id),
  });

  const evidence = (attachments.data ?? []).filter(
    (row) => row.doc_category === RECEIPT_PHOTO_CATEGORY
      || row.doc_category === RECEIPT_BILL_CATEGORY);
  const photos = evidence.filter((row) => row.doc_category === RECEIPT_PHOTO_CATEGORY);

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      returnsApi.upload(doc.id, file, category),
    onSuccess: () => attachments.refetch(),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) =>
      returnsApi.removeAttachment(doc.id, attachmentId),
    onSuccess: () => attachments.refetch(),
  });

  const confirm = useMutation({
    mutationFn: () => {
      const body: ReceiptLineWrite[] = Object.entries(received)
        .map(([id, value]) => ({ line_id: Number(id), received_quantity: Number(value) }))
        .filter((line) => line.received_quantity > 0);
      return returnsApi.acknowledge(doc.id, {
        lines: body,
      });
    },
    onSuccess: (updated) => {
      // Every Returns list at once: the row changes on the panel behind this, the
      // register's status moves and the summary tiles move, and they must not disagree
      // for a beat.
      queryClient.invalidateQueries({ queryKey: ["returns"] });
      onDone?.(updated);
      onClose();
    },
  });

  const entered = Object.values(received).some((value) => Number(value) > 0);
  const waiting = lines.reduce((sum, line) => sum + receivable(line), 0);
  const anythingToConfirm = lines.some((line) => receivable(line) > 0);
  const signing = Object.values(received)
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
  const short = anythingToConfirm && entered && signing < waiting;
  // The backend refuses a receipt with no photograph, so a live button here would only
  // buy a round trip and an error banner.
  const ready = entered && photos.length > 0;

  return (
    <ConfirmModal
      isOpen
      title={`Sign for ${doc.return_no}`}
      confirmLabel={anythingToConfirm ? "Acknowledge receipt" : "Close"}
      tone="warning"
      busy={confirm.isPending}
      confirmDisabled={anythingToConfirm && !ready}
      error={confirm.error ?? upload.error ?? remove.error}
      onConfirm={anythingToConfirm ? () => confirm.mutate() : onClose}
      onClose={onClose}
    >
      <div className="space-y-5">
        {/* Opens with what this press does, because it moves stock — this is the last
            place it can be said before a balance changes. */}
        <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
          <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-ink">
              {anythingToConfirm
                ? `${qty(waiting)} waiting for you to sign for`
                : "Nothing left to acknowledge"}
            </div>
            <div className="text-xs text-muted">
              {anythingToConfirm ? (
                <>
                  This puts the material on{" "}
                  {doc.to_warehouse_name ?? "the receiving point"}&rsquo;s stock balance and
                  raises the purchase return against it. Check the quantity on each line,
                  then attach a photo of what arrived.
                </>
              ) : (
                "This return has already been signed for. The lines below show what was recorded."
              )}
            </div>
          </div>
          <span className="ml-auto hidden shrink-0 text-xs text-muted sm:block">
            {money(doc.value)}
          </span>
        </div>

        {/* How it travelled — the answer to "is this the load in front of me". Read off
            the document itself; this module names a shipment and never drives one. */}
        <div className="rounded-xl border border-line bg-content1 p-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-050 text-brand">
              <Truck className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-ink">
                {doc.from_warehouse_name ?? "—"} &rarr;{" "}
                {doc.to_warehouse_name ?? doc.leg_label ?? "—"}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {doc.leg_label ?? "Return leg"}
                {doc.reason_label ? ` · ${doc.reason_label}` : ""}
              </div>
            </div>
            {doc.transport?.transport_request_no && (
              <Link
                to={`/logistics/shipments/${doc.transport.transport_request_id}`}
                className="shrink-0 font-mono text-xs font-semibold text-brand hover:underline"
              >
                {doc.transport.transport_request_no}
              </Link>
            )}
          </div>
        </div>

        <ul className="space-y-2.5">
          {lines.map((line) => (
            <LineCard
              key={line.id}
              line={line}
              value={received[line.id] ?? ""}
              onChange={(value) =>
                setReceived((current) => ({ ...current, [line.id]: value }))}
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
            A photo of the material as it reached you. Add the carrier&rsquo;s paperwork
            too if you were handed any.
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
                  if (file) upload.mutate({ file, category: RECEIPT_PHOTO_CATEGORY });
                  event.target.value = "";
                }}
              />
            </label>
            <label className="flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-content1 px-4 py-2 text-sm font-medium text-body transition hover:border-brand hover:bg-brand-050 hover:text-brand">
              <FileText className="h-4 w-4" /> Add paperwork
              <input
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload.mutate({ file, category: RECEIPT_BILL_CATEGORY });
                  event.target.value = "";
                }}
              />
            </label>
          </div>

          {upload.isPending && <p className="mt-2 text-xs text-muted">Uploading…</p>}

          {evidence.length > 0 && (
            <ul className="mt-3 space-y-2">
              {evidence.map((attachment) => (
                <AttachmentRow
                  key={attachment.id}
                  attachment={attachment}
                  busy={remove.isPending}
                  onDelete={() => remove.mutate(attachment.id)}
                />
              ))}
            </ul>
          )}

          {/* The state it arrived in. Asked here, on the same card as the photo, because
              the person answering is holding the material. Two choices and not three: a
              shortage is the quantity boxes' job above, and a SHORT option here could
              contradict what was typed there. */}
          <div className="hidden">
            <div className="text-sm font-semibold text-ink">How did it arrive?</div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                aria-pressed={!damaged}
                onClick={() => setDamaged(false)}
                className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
                  !damaged ? "border-ok bg-ok-bg text-ok"
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
                  damaged ? "border-bad bg-bad-bg text-bad"
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
            {/* Said out loud rather than left for the numbers to imply. A return travels
                once, so this signature ends the leg: what is not signed for now is a
                shortage, and the shipment is claimed against for it. */}
            {short && !damaged && (
              <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-[11px] text-warn">
                You are signing for {qty(signing)} of {qty(waiting)}. The rest is recorded
                as short and raises a claim on the shipment — a return is signed for once,
                so there is no second receipt for it to arrive on.
              </p>
            )}
          </div>

          {/* Two red sentences read as errors for something you have not done yet. A
              checklist reads as what is left, and goes green as you do it. */}
          <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
            <Requirement met={entered} label="A quantity entered on at least one line" />
            <Requirement met={photos.length > 0} label="A photo of what arrived attached" />
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
