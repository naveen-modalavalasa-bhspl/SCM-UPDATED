/**
 * The words on a purchase order's status pill, with the vendor's despatch taken into
 * account.
 *
 * A PO stays ACCEPTED_BY_SUPPLIER until a goods receipt moves it, but once the supplier
 * has submitted a despatch note the goods are on their way and "Accepted" undersells it.
 * `despatch_status` is DERIVED on the server (enums.DespatchStatus) from the submitted
 * notes; this only changes the WORDING while the order sits on that rung. The status
 * itself — and so the pill's tone and every filter — is untouched.
 */
export const DESPATCH_STATUS_LABEL: Record<string, string> = {
  PARTIALLY_DISPATCHED: "Partially dispatched",
  DISPATCHED: "Dispatched",
};

/** Rungs on which the despatch stage is the most useful thing to say: accepted and
 *  nothing received yet. Once a receipt lands, PARTIALLY_RECEIVED/RECEIVED say more. */
const DESPATCH_RUNGS = new Set(["ACCEPTED_BY_SUPPLIER"]);

/** The despatch label to show instead of the status, or null to keep the status. */
export function despatchLabel(status: string, despatchStatus?: string | null): string | null {
  if (!despatchStatus || !DESPATCH_RUNGS.has(status)) return null;
  return DESPATCH_STATUS_LABEL[despatchStatus] ?? null;
}
