import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { api } from "@/shared/api/client";
import { errorMessage } from "@/shared/components";
import { accountsApi } from "@/modules/accounts/api";
import { DocumentFiles } from "@/modules/accounts/components/DocumentFiles";
import {
  MilestoneTable, PaymentList, PaymentTotals,
} from "@/modules/accounts/components/PaymentSchedule";
import type { FiledDocument } from "@/modules/accounts/types";

/**
 * What accounts has paid against this order, milestone by milestone, and the invoices
 * and delivery challans the supplier filed on the portal. Read-only here: recording
 * and approving a payment is the accounts desk's. It reads the SAME answer the desk
 * does (`/api/pos/{id}/payments`), so the PO team sees a payment the moment its
 * ladder signs it.
 */
export function POPaymentsPanel({ poId }: { poId: number }) {
  const data = useQuery({
    queryKey: ["po-payments", poId],
    queryFn: () => accountsApi.poForBuyer(poId),
  });
  return (
    <div className="overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white shadow-sm">
      <div className="h-1 w-full bg-gradient-to-r from-emerald-500 to-teal-500" />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center gap-2 text-emerald-700">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-600 text-white"><Wallet className="h-4 w-4" /></div>
          <h2 className="text-sm font-extrabold uppercase tracking-widest">Payments & supplier documents</h2>
        </div>
        {data.error && <p className="text-sm font-semibold text-red-600">{errorMessage(data.error)}</p>}
        {data.data && (
          <>
            <PaymentTotals data={data.data} />
            <MilestoneTable milestones={data.data.milestones} />
            {data.data.payments.length > 0 && <PaymentList payments={data.data.payments}
              proofUrl={(p, id) => `/api/pos/${poId}/payments/${p.id}/proofs/${id}/download`} />}
          </>
        )}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Invoices & delivery challans</h3>
          <DocumentFiles queryKey={["po-documents", poId]}
            emptyText="The supplier has not uploaded an invoice or DC yet."
            endpoints={{
              list: () => api.get<FiledDocument[]>(`/api/pos/${poId}/documents`).then((r) => r.data),
              downloadUrl: (id) => `/api/pos/${poId}/documents/${id}/download`,
            }} />
        </div>
      </div>
    </div>
  );
}
