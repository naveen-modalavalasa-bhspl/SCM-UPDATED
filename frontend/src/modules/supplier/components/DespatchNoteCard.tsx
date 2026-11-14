import { useState } from "react";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { Button } from "@/modules/procurement/components/ActionButton";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { PackChips, fmtQty, num } from "@/shared/packing";
import { CombinationTag } from "@/shared/combination";
import type { DespatchItem, DespatchNote } from "@/modules/procurement/types";

const money = (value: number | null | undefined) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value ?? 0);

const filled = (value: string | null | undefined) => (value ?? "").trim() !== "";

/**
 * One filed dispatch note, and what was actually on the vehicle (2026-11-14).
 *
 * The list used to say only "Invoice X · 1 line(s)", so the one place a supplier
 * looks to check what they sent — and the one place a dispute about a batch or a
 * carton is answered from — could not be read at all without reopening the note as
 * a draft. Everything the note carries is here instead: the papers, how it travels,
 * and every line with its batch, its dates, the brand / variant / model and the
 * PACKS it was sent in, which is the half of a delivery that is not in base units.
 */
export function DespatchNoteCard({ note, onEdit, onCancel, cancelling }: {
  note: DespatchNote;
  onEdit: (note: DespatchNote) => void;
  onCancel: (noteId: number) => void;
  cancelling?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const lines = note.items ?? [];
  const totalQty = lines.reduce((sum, line) => sum + num(line.despatched_qty), 0);
  const uom = lines[0]?.uom_code ?? null;

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left"
        >
          <span className="font-mono text-sm font-semibold text-ink">{note.dn_no}</span>
          <StatusPill status={note.status} />
          <NoteStamp note={note} />
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {open ? "Hide details" : "Show details"}
          </span>
        </button>
        {note.status === "DRAFT" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="subtle" onClick={() => onEdit(note)}>Edit</Button>
            <Button variant="danger" disabled={cancelling} onClick={() => onCancel(note.id)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <p className="mt-1 text-xs text-muted">
        {[
          note.invoice_no && `Invoice ${note.invoice_no}`,
          note.eway_bill_no && `E-way ${note.eway_bill_no}`,
          note.vehicle_no,
          `${lines.length} line(s)`,
          totalQty > 0 && `${fmtQty(totalQty)} ${uom ?? "units"}`,
        ].filter(Boolean).join(" · ")}
      </p>

      {open && (
        <>
          {/* How the goods travelled, and the papers that say so. */}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-surface-2/60 p-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <Detail label="Note date" value={note.dn_date ? fmtDate(note.dn_date) : null} />
            <Detail label="Invoice no" value={note.invoice_no} />
            <Detail label="Invoice date" value={note.invoice_date ? fmtDate(note.invoice_date) : null} />
            <Detail
              label="Invoice amount"
              value={note.invoice_amount != null ? `₹ ${money(note.invoice_amount)}` : null}
            />
            <Detail label="E-way bill" value={note.eway_bill_no} />
            <Detail label="Vehicle" value={note.vehicle_no} />
            <Detail label="Transporter" value={note.transporter_name} />
            <Detail label="LR / docket" value={note.lr_no} />
            <Detail
              label="Expected delivery"
              value={note.expected_date ? fmtDate(note.expected_date) : null}
            />
          </dl>

          {filled(note.remarks) && (
            <p className="mt-2 rounded-lg bg-surface-2/40 px-3 py-2 text-xs text-body">
              <span className="font-semibold text-ink">Remarks: </span>{note.remarks}
            </p>
          )}

          <div className="mt-3 overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-content2 text-xs text-muted">
                <tr>
                  <th className="p-2.5">Item</th>
                  <th className="p-2.5 text-right">Sent</th>
                  <th className="p-2.5">Batch / lot</th>
                  <th className="p-2.5">Manufactured</th>
                  <th className="p-2.5">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lines.map((line, index) => (
                  <DespatchLineRow key={line.id ?? index} line={line} />
                ))}
                {!lines.length && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-xs text-muted">
                      This note carries no lines.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {lines.filter((item) => item.pack_change_status && item.pack_change_status !== "NONE")
            .map((item) => (
              <p key={`pc-${item.id}`} className={`mt-2 inline-flex flex-wrap items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                item.pack_change_status === "PENDING" ? "bg-warn-bg text-warn"
                  : item.pack_change_status === "ACCEPTED" ? "bg-ok-bg text-ok"
                    : "bg-bad-bg text-bad"}`}>
                {item.item_code}: {item.ordered_pack_hierarchy_name} → {item.pack_hierarchy_name} —{" "}
                {item.pack_change_status === "PENDING" ? "waiting for the buyer"
                  : item.pack_change_status === "ACCEPTED" ? "accepted by the buyer"
                    : `declined${item.pack_change_note ? `: ${item.pack_change_note}` : ""}`}
              </p>
            ))}
        </>
      )}
    </li>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 ${filled(value) ? "text-body" : "text-muted"}`}>
        {filled(value) ? value : "Not stated"}
      </dd>
    </div>
  );
}

/** One line: what was sent, in packs AND base units, with the batch facts that
 *  cannot be derived from the order. */
function DespatchLineRow({ line }: { line: DespatchItem }) {
  const packs = line.pack_breakdown ?? [];
  return (
    <tr>
      <td className="p-2.5 align-top">
        <strong className="text-ink">{line.item_name ?? "—"}</strong>
        <CombinationTag value={line} className="mt-1" />
        <p className="font-mono text-xs text-muted">{line.item_code}</p>
        {filled(line.remarks) && (
          <p className="mt-1 text-xs text-body">Note: {line.remarks}</p>
        )}
      </td>
      <td className="p-2.5 text-right align-top">
        {packs.length > 0 && (
          <div className="flex justify-end">
            <PackChips entries={packs} uom={line.uom_code} showTotal={false} />
          </div>
        )}
        <p className="tabular font-semibold text-ink">
          {fmtQty(line.despatched_qty)}{" "}
          <span className="text-xs font-normal text-muted">{line.uom_code ?? "units"}</span>
        </p>
        {packs.length > 0 && line.pack_hierarchy_name && (
          <p className="mt-0.5 text-[11px] text-muted">{line.pack_hierarchy_name}</p>
        )}
        {!packs.length && filled(line.pack_text) && (
          <p className="mt-0.5 text-[11px] text-muted">{line.pack_text}</p>
        )}
      </td>
      <td className="p-2.5 align-top">{filled(line.batch_no) ? line.batch_no : <span className="text-muted">—</span>}</td>
      <td className="p-2.5 align-top">{line.mfg_date ? fmtDate(line.mfg_date) : <span className="text-muted">—</span>}</td>
      <td className="p-2.5 align-top">{line.expiry_date ? fmtDate(line.expiry_date) : <span className="text-muted">—</span>}</td>
    </tr>
  );
}

/** WHEN a despatch note reached the status beside it. */
export function NoteStamp({ note }: { note: DespatchNote }) {
  const [verb, at] = note.status === "SUBMITTED"
    ? ["Submitted on", note.submitted_at ?? note.created_at]
    : note.status === "CANCELLED"
      ? ["Cancelled on", note.updated_at ?? note.created_at]
      : ["Last saved", note.updated_at ?? note.created_at];
  if (!at) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted" title={`${verb} ${fmtDateTime(at)}`}>
      <Clock aria-hidden className="h-3.5 w-3.5" />
      {verb} <time dateTime={at} className="font-medium text-body tabular">{fmtDateTime(at)}</time>
    </span>
  );
}
