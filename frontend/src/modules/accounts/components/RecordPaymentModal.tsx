import { useEffect, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Button, Field, Input, Select, Textarea, errorMessage } from "@/shared/components";
import { todayISO } from "../paymentRules";
import type { FiledDocument, Milestone, PaymentInput } from "../types";
import { money } from "./PaymentSchedule";

/** Record one payment against one milestone. It counts as paid once its approval
 *  ladder signs it; until then it holds its amount so nobody records it twice. */
export function RecordPaymentModal({
  poId, poNo, milestone, modes, invoices, saving, error, onClose, onSave,
}: {
  poId: number;
  poNo: string;
  milestone: Milestone | null;
  modes: string[];
  invoices: FiledDocument[];
  saving: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (body: PaymentInput, proofs: File[]) => void;
}) {
  const [proofs, setProofs] = useState<File[]>([]);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayISO());
  const [mode, setMode] = useState("NEFT");
  const [reference, setReference] = useState("");
  const [invoice, setInvoice] = useState("");
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    if (!milestone) return;
    setAmount(String(milestone.balance));
    setPaidOn(todayISO());
    setReference(""); setInvoice(""); setRemarks(""); setProofs([]);
  }, [milestone]);

  const value = Number(amount);
  const tooMuch = milestone ? value > milestone.balance + 0.004 : false;
  const needsRef = mode !== "CASH" && !reference.trim();
  const invalid = !value || value <= 0 || tooMuch || needsRef || !paidOn;

  return (
    <Modal isOpen={!!milestone} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        {milestone && (
          <>
            <ModalHeader className="flex flex-col gap-0.5">
              Record payment · {milestone.label}
              <span className="text-xs font-normal text-muted">
                {poNo} · {money(milestone.balance)} left of {money(milestone.amount)}
              </span>
            </ModalHeader>
            <ModalBody className="space-y-3">
              {milestone.trigger_met === null && (
                <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
                  The system cannot see this event ({milestone.trigger.toLowerCase()}).
                  Confirm it has happened before you pay.
                </p>
              )}
              {milestone.trigger_met === false && (
                <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
                  Not due yet: {milestone.trigger.toLowerCase()} has not happened. You can
                  still record it if it was agreed early.
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Amount (₹)" required
                  hint={tooMuch ? `At most ${money(milestone.balance)}` : undefined}>
                  <Input type="number" min="0" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label="Paid on" required>
                  <Input type="date" value={paidOn} max={todayISO()}
                    onChange={(e) => setPaidOn(e.target.value)} />
                </Field>
                <Field label="Mode" required>
                  <Select value={mode} onChange={(v) => setMode(v || "NEFT")}
                    options={modes.map((m) => ({ value: m, label: m }))} />
                </Field>
                <Field label="UTR / cheque / reference no." required={mode !== "CASH"}>
                  <Input value={reference} maxLength={100}
                    onChange={(e) => setReference(e.target.value)} />
                </Field>
              </div>
              {invoices.length > 0 && (
                <Field label="Against supplier invoice" hint="Optional — the invoice this settles.">
                  <Select value={invoice} placeholder="Not linked"
                    onChange={(v) => setInvoice(v ?? "")}
                    options={invoices.map((d) => ({ value: String(d.id), label: d.file_name }))} />
                </Field>
              )}
              <Field label="Payment proof"
                hint="Bank advice, UTR screenshot or cheque scan — PDF or image, 20 MB each. The approver sees it.">
                <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    setProofs((prev) => [...prev, ...picked]);
                  }}
                  className="block w-full text-sm text-body file:mr-3 file:min-h-11 file:rounded-xl file:border file:border-line file:bg-content1 file:px-4 file:text-sm file:font-semibold file:text-brand" />
                {proofs.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {proofs.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm text-ink">
                        <span className="truncate">{f.name}</span>
                        <button type="button" className="min-h-11 px-2 text-xs font-semibold text-red-600"
                          onClick={() => setProofs((prev) => prev.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
              <Field label="Remarks">
                <Textarea value={remarks} maxLength={2000}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRemarks(e.target.value)} />
              </Field>
              {error != null && <p className="text-sm font-semibold text-red-600">{errorMessage(error)}</p>}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={invalid || saving} onClick={() => onSave({
                po_id: poId, milestone_id: milestone.id, amount: value, paid_on: paidOn,
                mode, reference_no: reference.trim() || null,
                invoice_attachment_id: invoice ? Number(invoice) : null,
                remarks: remarks.trim() || null,
              }, proofs)}>
                {saving ? "Saving…" : "Record payment"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
