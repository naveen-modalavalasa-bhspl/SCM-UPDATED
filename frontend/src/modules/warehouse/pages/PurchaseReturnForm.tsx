import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import {
  approveReturn, cancelReturn, completeReturn, createReturn, getReceipt, getReturn,
  grnOptions, itemOptions, rejectReturn, submitReturn, updateReturn, vendorOptions,
  warehouseOptions,
} from "../api";
import { fmtMoney, fmtQty, num, today } from "../format";
import type { PurchaseReturn, PurchaseReturnItemWrite, PurchaseReturnWrite } from "../types";

/**
 * Send stock back to a vendor.
 *
 * A return is raised against a GRN, and picking one pulls in the lines that were
 * actually rejected — returning more than was received is the mistake this screen
 * exists to prevent, so the rejected quantity is the cap and it is shown next to
 * every line rather than enforced silently.
 *
 * Completing the return is what takes the stock back out, and it is separate from
 * the credit note: the goods leave when they leave, and the vendor's paperwork
 * arrives when it arrives.
 */

const emptyLine = (): PurchaseReturnItemWrite => ({
  item_id: 0,
  batch_id: null,
  quantity: 0,
  rate: null,
  reason: null,
});

export default function PurchaseReturnForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";

  const [form, setForm] = useState<PurchaseReturnWrite>({
    return_date: today(),
    po_id: null,
    grn_id: null,
    vendor_id: null,
    warehouse_id: null,
    reason: "",
    items: [],
  });
  /** Rejected quantity per pulled-in line, so a line cannot over-return. */
  const [caps, setCaps] = useState<Record<number, number>>({});
  const [confirming, setConfirming] = useState<
    "submit" | "approve" | "reject" | "complete" | "cancel" | null
  >(null);
  const [creditNote, setCreditNote] = useState("");
  const [reason, setReason] = useState("");

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-return", id],
    queryFn: () => getReturn(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      return_date: doc.return_date,
      po_id: doc.po_id ?? null,
      grn_id: doc.grn_id ?? null,
      vendor_id: doc.vendor_id ?? null,
      warehouse_id: doc.warehouse_id ?? null,
      reason: doc.reason ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        po_item_id: l.po_item_id,
        grn_item_id: l.grn_item_id,
        item_id: l.item_id,
        batch_id: l.batch_id,
        quantity: num(l.quantity),
        rate: l.rate,
        reason: l.reason,
      })),
    });
    setCreditNote(doc.credit_note_no ?? "");
  }, [doc]);

  /** Pulling the GRN in seeds the lines from what it rejected. */
  const pullGrn = useMutation({
    mutationFn: (grnId: number) => getReceipt(grnId),
    onSuccess: (receipt) => {
      const rejected = (receipt.items ?? []).filter((l) => num(l.rejected_qty) > 0);
      setForm((f) => ({
        ...f,
        po_id: receipt.po_id ?? null,
        vendor_id: receipt.vendor_id ?? null,
        warehouse_id: receipt.warehouse_id,
        items: rejected.map((l) => ({
          grn_item_id: l.id,
          po_item_id: l.po_item_id ?? null,
          item_id: l.item_id,
          batch_id: l.batch_id || null,
          quantity: num(l.rejected_qty),
          rate: l.rate ?? null,
          reason: l.rejection_reason ?? null,
        })),
      }));
      setCaps(Object.fromEntries(rejected.map((l, i) => [i, num(l.rejected_qty)])));
    },
  });

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof PurchaseReturnWrite>(key: K, value: PurchaseReturnWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const patchLine = (index: number, patch: Partial<PurchaseReturnItemWrite>) =>
    setForm((f) => ({ ...f, items: f.items.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));

  const totals = useMemo(
    () => ({
      lines: form.items.length,
      qty: form.items.reduce((s, l) => s + num(l.quantity), 0),
      value: form.items.reduce((s, l) => s + num(l.quantity) * num(l.rate), 0),
    }),
    [form.items],
  );

  const locked = !!doc && doc.status !== "DRAFT";

  const save = useMutation({
    mutationFn: () => (editing ? updateReturn(Number(id), form) : createReturn(form)),
    onSuccess: (saved: PurchaseReturn) => {
      qc.invalidateQueries({ queryKey: ["wh-returns"] });
      qc.invalidateQueries({ queryKey: ["wh-return", String(saved.id)] });
      if (!editing) nav(`/warehouse/purchase-returns/${saved.id}`, { replace: true });
    },
  });

  const act = useMutation({
    mutationFn: (what: "submit" | "approve" | "reject" | "complete" | "cancel") => {
      const numId = Number(id);
      if (what === "submit") return submitReturn(numId);
      if (what === "approve") return approveReturn(numId, reason);
      if (what === "reject") return rejectReturn(numId, reason);
      if (what === "complete") return completeReturn(numId, creditNote || undefined);
      return cancelReturn(numId, reason || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-return", id] });
      qc.invalidateQueries({ queryKey: ["wh-returns"] });
      setConfirming(null);
    },
  });

  const columns: LineColumn<PurchaseReturnItemWrite>[] = [
    {
      key: "item",
      header: "Item",
      render: (l, i) => {
        const saved = savedLine(i);
        if (saved) {
          return (
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-semibold text-ink">{saved.item_code ?? "—"}</div>
              <div className="truncate text-xs text-muted">
                {saved.item_name ?? "—"}
                {saved.batch_no ? ` · ${saved.batch_no}` : ""}
              </div>
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
      key: "cap",
      header: "Rejected on GRN",
      numeric: true,
      width: "w-32",
      hideOnNarrow: true,
      render: (_l, i) => <span className="tabular text-muted">{caps[i] != null ? fmtQty(caps[i]) : "—"}</span>,
    },
    {
      key: "qty",
      header: "Returning",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Return quantity, line ${i + 1}`}
          value={l.quantity}
          max={caps[i]}
          disabled={locked}
          invalid={caps[i] != null && num(l.quantity) > caps[i]}
          onChange={(v) => patchLine(i, { quantity: v })}
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
      key: "amount",
      header: "Amount",
      numeric: true,
      width: "w-28",
      hideOnNarrow: true,
      render: (l) => <span className="tabular text-ink">{fmtMoney(num(l.quantity) * num(l.rate))}</span>,
    },
    {
      key: "reason",
      header: "Reason",
      render: (l, i) => (
        <TextInput
          ariaLabel={`Reason, line ${i + 1}`}
          value={l.reason}
          disabled={locked}
          placeholder="Damaged, wrong item, short shelf life…"
          onChange={(v) => patchLine(i, { reason: v })}
        />
      ),
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title={editing ? `Return ${doc?.return_no ?? ""}` : "New purchase return"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/purchase-returns")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="return.create">
                <Button variant="subtle" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && doc?.status === "DRAFT" && (
              <Can do="return.create">
                <Button onClick={() => setConfirming("submit")}>Submit for approval</Button>
              </Can>
            )}
            {/* can_approve — see MaterialIssueForm: the permission says you approve
                returns, the chain says whether this one is yours. */}
            {editing && doc?.status === "PENDING_APPROVAL" && doc?.can_approve && (
              <Can do="return.approve">
                <Button variant="subtle" onClick={() => setConfirming("approve")}>Approve</Button>
                <Button variant="danger" onClick={() => setConfirming("reject")}>Reject</Button>
              </Can>
            )}
            {editing && ["APPROVED", "DISPATCHED"].includes(doc?.status ?? "") && (
              <Can do="return.approve">
                <Button onClick={() => setConfirming("complete")}>Complete return</Button>
              </Can>
            )}
            {editing && doc && !["CANCELLED", "COMPLETED"].includes(doc.status) && (
              <Can do="return.create">
                <Button variant="danger" onClick={() => setConfirming("cancel")}>Cancel</Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? pullGrn.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.return_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Against GRN" value={<span className="font-mono">{doc.grn_no ?? "—"}</span>} />
          <MetaRow label="Credit note" value={<span className="font-mono">{doc.credit_note_no ?? "—"}</span>} />
        </MetaCard>
      )}

      <Section title="Return">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={form.return_date} disabled={locked}
                   onChange={(e) => set("return_date", e.target.value)} />
          </Field>
          <Field label="Against GRN" hint="Pulls in the lines that were rejected.">
            <Lookup
              name="receipts"
              load={grnOptions}
              value={form.grn_id ?? ""}
              isDisabled={locked}
              onChange={(v) => {
                set("grn_id", v === "" ? null : v);
                if (v !== "") pullGrn.mutate(v);
              }}
              placeholder="GRN"
            />
          </Field>
          <Field label="Vendor">
            <Lookup name="vendors" load={vendorOptions} value={form.vendor_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("vendor_id", v === "" ? null : v)} placeholder="Vendor" />
          </Field>
          <Field label="From warehouse">
            <Lookup name="warehouses" load={warehouseOptions} value={form.warehouse_id ?? ""} isDisabled={locked}
                    onChange={(v) => set("warehouse_id", v === "" ? null : v)} placeholder="Warehouse" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Why it is going back">
              <Input value={form.reason ?? ""} disabled={locked}
                     onChange={(e) => set("reason", e.target.value)} />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Lines" hint="A line cannot return more than the GRN rejected.">
        <LinesEditor
          rows={form.items}
          columns={columns}
          keyOf={(_, i) => i}
          onAdd={locked ? undefined : () => set("items", [...form.items, emptyLine()])}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          empty="Pick a GRN above to pull its rejected lines in."
          footer={
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{totals.lines} lines</span>
              <span className="text-ink">Qty <b className="tabular">{fmtQty(totals.qty)}</b></span>
              <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
            </div>
          }
        />
      </Section>

      <Section title="Documents" hint="Debit note, vendor acknowledgement, photographs of the damage.">
        <AttachmentsPanel entityType="RETURN" entityId={doc?.id} category="RETURN" readOnly={locked} />
      </Section>

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for approval?"
        message="The return goes to the approval chain and can no longer be edited."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "approve" || confirming === "reject"}
        title={confirming === "approve" ? "Approve this return?" : "Reject this return?"}
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
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "complete"}
        title="Complete this return?"
        message={`${fmtQty(totals.qty)} is handed back to the vendor. QC-rejected goods were never available stock; any posted-stock lines are moved out now.`}
        confirmLabel="Complete return"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("complete")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Credit note no" hint="Leave blank if the vendor has not issued it yet.">
            <Input value={creditNote} onChange={(e) => setCreditNote(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "cancel"}
        title="Cancel this return?"
        message="The return stops here and the stock stays where it is."
        confirmLabel="Cancel return"
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
