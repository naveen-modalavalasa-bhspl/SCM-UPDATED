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
