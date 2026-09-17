/**
 * How an order reads on the VENDOR's screen.
 *
 * Our statuses are written from inside the company: "SENT_TO_VENDOR" is a true
 * statement on our desk and a confusing one on theirs — the vendor is the vendor, so
 * what they are looking at is simply a new order. Same for CLOSED, which to us means
 * the file is finished and to them means they delivered it and we are done.
 *
 * Only the WORDING changes. The status on the document is untouched, the pill's colour
 * still comes from the real status, and nothing here is sent back to the server — a
 * vendor filtering by "Completed" posts CLOSED, the status the API knows.
 */
export const VENDOR_PO_STATUS_LABEL: Record<string, string> = {
  SENT_TO_VENDOR: "New order",
  ACCEPTED_BY_SUPPLIER: "Accepted",
  PARTIALLY_RECEIVED: "Part delivered",
  RECEIVED: "Delivered",
  CLOSED: "Completed",
  CANCELLED: "Cancelled",
};

export const vendorPoLabel = (status: string) =>
  VENDOR_PO_STATUS_LABEL[status] ?? status.replace(/_/g, " ");

/** The filter options, in the order an order actually travels. */
export const VENDOR_PO_STATUS_OPTIONS = [
  "SENT_TO_VENDOR", "ACCEPTED_BY_SUPPLIER", "PARTIALLY_RECEIVED",
  "RECEIVED", "CLOSED", "CANCELLED",
].map((value) => ({ value, label: vendorPoLabel(value) }));

/** Purchase-return wording, same reasoning and the sharper case for it.
 *
 * "SENT_TO_VENDOR" on a return is doubly wrong on the supplier's screen: it names
 * them in the third person AND describes the goods as leaving, when from where they
 * are standing the goods are arriving. DISPATCHED and COMPLETED read from inside our
 * warehouse too.
 *
 * Wording only. The stored status is untouched and the pill's colour still comes from
 * the real one, exactly as `vendorPoLabel` does above. */
export const VENDOR_RETURN_STATUS_LABEL: Record<string, string> = {
  SENT_TO_VENDOR: "On its way to you",
  DISPATCHED: "On its way to you",
  COMPLETED: "Settled",
};

/** The statuses the supplier's own answer is allowed to re-word. Mirrors the server's
 *  `VENDOR_ANSWERABLE_RETURN_STATUSES`: a SETTLED return has been closed on our side and
 *  outranks whatever was said on the way there. */
const ANSWERABLE = new Set(["SENT_TO_VENDOR", "DISPATCHED"]);

/**
 * The pill's wording, with the supplier's ANSWER taking precedence over the leg.
 *
 * "On its way to you" is true right up until they open the crate, and stopped being
 * true the moment they pressed Accept — yet the pill went on saying it while the page
 * below it read "Your answer is recorded". `responseLabel` is `vendor_response_label`,
 * served by the API and already worded from where the supplier is standing
 * ("Replacement being sent"), so nothing is composed here.
 *
 * Optional, and null while unanswered — every caller that passes nothing, and every
 * return raised before the portal could be answered, gets exactly the old wording.
 */
export const vendorReturnLabel = (status: string, responseLabel?: string | null) =>
  (ANSWERABLE.has(status) ? responseLabel : null)
  ?? VENDOR_RETURN_STATUS_LABEL[status]
  ?? status.replace(/_/g, " ");

/** RFQ wording, same reasoning. A CLOSED RFQ is one the vendor can no longer quote on;
 *  AWARDED is one that has been decided — theirs or somebody else's. */
export const VENDOR_RFQ_STATUS_LABEL: Record<string, string> = {
  PUBLISHED: "Open for quotes",
  CLOSED: "Closed",
  AWARDED: "Decided",
};

export const vendorRfqLabel = (status: string) =>
  VENDOR_RFQ_STATUS_LABEL[status] ?? status.replace(/_/g, " ");

export const VENDOR_RFQ_STATUS_OPTIONS = ["PUBLISHED", "CLOSED", "AWARDED"]
  .map((value) => ({ value, label: vendorRfqLabel(value) }));
