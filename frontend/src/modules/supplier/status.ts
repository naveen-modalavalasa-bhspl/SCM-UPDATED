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
 * them in the third person AND describes our own bookkeeping, which is not what the
 * supplier is being asked about. DISPATCHED and COMPLETED read from inside our
 * warehouse too.
 *
 * RENAMED 2026-09-17, at the business's request: the two travelling rungs read "Draft"
 * rather than "On its way to you". A return sitting on either of them is one the
 * supplier has not answered yet — nothing has been agreed, no refund or replacement has
 * been chosen — so on THEIR board it is still an open piece of paper, and that is the
 * word they use for it. Both rungs get the same word for the same reason they always
 * did: the difference between them is our internal bookkeeping, not anything the
 * supplier acts on differently.
 *
 * Wording only. The stored status is untouched and the pill's colour still comes from
 * the real one, exactly as `vendorPoLabel` does above — so a renamed pill is not the
 * same thing as the document actually being a DRAFT on our side, which the supplier
 * portal never shows at all (`_VENDOR_VISIBLE_RETURN_STATUSES`). */
export const VENDOR_RETURN_STATUS_LABEL: Record<string, string> = {
  SENT_TO_VENDOR: "Draft",
  DISPATCHED: "Draft",
  COMPLETED: "Settled",
};

/** The statuses the supplier's own answer is allowed to re-word. Mirrors the server's
 *  `VENDOR_ANSWERABLE_RETURN_STATUSES`: a SETTLED return has been closed on our side and
 *  outranks whatever was said on the way there. */
const ANSWERABLE = new Set(["SENT_TO_VENDOR", "DISPATCHED"]);

/**
 * The pill's wording, with the supplier's ANSWER taking precedence over the leg.
 *
 * The travelling wording is true right up until they answer, and stopped being true the
 * moment they pressed Accept — yet the pill went on saying it while the page below it
 * read "Your answer is recorded". `responseLabel` is `vendor_response_label`,
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

/**
 * The same pill on the return's OWN page, where the API also sends a `status_label`.
 *
 * That field is `return_stage_label`, which words the inbound leg from inside OUR
 * warehouse ("With the vendor — awaiting their decision"), and the detail screen was
 * preferring it outright — so the board said "Draft" and the document the supplier
 * opened from that board said something else about the same rung.
 *
 * The rule is the narrow one: on the two rungs the supplier has not answered yet
 * (`ANSWERABLE`), THEIR wording wins — their own answer if they have given one, else
 * "Draft". On every later rung the served sentence is still what shows, because those
 * rungs describe a replacement or a refund actually moving and `VENDOR_RETURN_STATUS_LABEL`
 * has nothing to say about them. Wording only; nothing here is sent back.
 */
export const vendorReturnPillLabel = (
  status: string,
  responseLabel?: string | null,
  servedLabel?: string | null,
) =>
  (ANSWERABLE.has(status) ? vendorReturnLabel(status, responseLabel) : null)
  ?? servedLabel
  ?? vendorReturnLabel(status, responseLabel);

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
