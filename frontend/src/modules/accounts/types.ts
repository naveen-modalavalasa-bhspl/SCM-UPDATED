/** Accounts — vendor payments against PO payment milestones. Mirrors
 *  backend/app/modules/accounts/schemas.py. */

export type MilestoneState =
  "NOT_DUE" | "DUE" | "OVERDUE" | "PART_PAID" | "PAID" | "CONFIRM";

export interface Milestone {
  id: number;
  seq: number;
  stage: string;
  label: string;
  trigger: string;
  percent: number;
  due_days: number;
  amount: number;
  paid: number;
  /** Recorded, awaiting approval. */
  pending: number;
  /** What may still be recorded: amount − paid − pending. */
  balance: number;
  /** null = the system cannot see this event; accounts confirms it when paying. */
  trigger_met: boolean | null;
  due_date: string | null;
  state: MilestoneState;
}

export interface VendorPayment {
  id: number;
  payment_no: string;
  po_id: number;
  po_no: string | null;
  milestone_id: number;
  stage: string;
  stage_label: string | null;
  vendor_name: string | null;
  amount: number;
  paid_on: string;
  mode: string;
  reference_no: string | null;
  invoice_attachment_id: number | null;
  remarks: string | null;
  status: string;
  current_approver_name: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string | null;
  /** Bank advice / UTR screenshot / cheque scan attached by the payer. */
  proofs: FiledDocument[];
  can_act: boolean;
}

export interface FiledDocument {
  id: number;
  file_name: string;
  file_size: number | null;
  doc_category: string | null;
  uploaded_by_name: string | null;
  created_at: string | null;
}

export interface PoPayments {
  po_id: number;
  po_no: string;
  po_status: string;
  vendor_id: number;
  vendor_name: string | null;
  project_name: string | null;
  po_date: string | null;
  approved_at: string | null;
  payment_terms: string | null;
  total_amount: number;
  paid: number;
  pending: number;
  outstanding: number;
  milestones: Milestone[];
  payments: VendorPayment[];
  documents: FiledDocument[];
}

export interface PayableRow {
  po_id: number;
  po_no: string;
  po_status: string;
  vendor_name: string | null;
  project_name: string | null;
  po_date: string | null;
  payment_terms: string | null;
  total_amount: number;
  paid: number;
  pending: number;
  outstanding: number;
  invoices: number;
  next_stage: string | null;
  next_due_date: string | null;
  next_state: MilestoneState | null;
}

export interface CarrierInvoiceRow {
  attachment_id: number;
  tr_id: number;
  tr_no: string;
  tr_status: string;
  carrier_name: string | null;
  freight_amount: number | null;
  file_name: string;
  uploaded_at: string | null;
}

export interface PaymentInput {
  po_id: number;
  milestone_id: number;
  amount: number;
  paid_on: string;
  mode: string;
  reference_no?: string | null;
  invoice_attachment_id?: number | null;
  remarks?: string | null;
}

export interface Page<T> { items: T[]; total: number; page: number; size: number }

/** How each milestone state reads, and which StatusPill tone carries it. */
export const STATE_META: Record<MilestoneState, { label: string; pill: string }> = {
  NOT_DUE: { label: "Not due yet", pill: "DRAFT" },
  DUE: { label: "Due", pill: "PENDING_APPROVAL" },
  OVERDUE: { label: "Overdue", pill: "REJECTED" },
  PART_PAID: { label: "Part paid", pill: "PARTIALLY_RECEIVED" },
  PAID: { label: "Paid", pill: "APPROVED" },
  CONFIRM: { label: "Confirm before paying", pill: "SUBMITTED" },
};
