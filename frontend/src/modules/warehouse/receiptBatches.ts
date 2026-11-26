import type { ReceiptItemWrite } from "./types";

const qty = (value: unknown) => Number(value) || 0;

/** Rows that are the same delivery line: one PO line, or one hand-added item. */
export const sameReceiptLine = (source: ReceiptItemWrite) => (l: ReceiptItemWrite) =>
  source.po_item_id ? l.po_item_id === source.po_item_id
    : l.item_id === source.item_id && !l.po_item_id;

/**
 * One item, a second batch (QA-5 BUG_007).
 *
 * A delivery of 100 often arrives as 60 of one batch and 40 of another. On a receipt
 * against a PO the form offers no free "Add line" — anything not on the order did not
 * arrive — so there was nowhere to put the second batch. This inserts a SIBLING of
 * row `index`: the same item, PO line, despatch-note line, brand / variant / model and
 * hierarchy, with its own batch, dates, quantity and codes, straight under the rows
 * of that line so the batches read as one item.
 *
 * It opens on what the order line still owes after every row already on it (`owed`
 * is the PO line's pending quantity) — usually 0, because the first row was prefilled
 * with all of it — so nothing is received twice by accident. A despatch-note line's
 * counted packs are dropped on BOTH rows: each is then read by its own quantity inside
 * the declared packing, instead of each claiming the whole of it.
 */
export function withAnotherBatch(items: ReceiptItemWrite[], index: number, owed: number):
  ReceiptItemWrite[] {
  const source = items[index];
  if (!source?.item_id) return items;
  const same = sameReceiptLine(source);
  const onRows = items.filter(same).reduce((total, l) => total + qty(l.received_qty), 0);
  const opening = Math.max(owed - onRows, 0);
  const dropCounted = !!source.despatch_note_item_id;
  const sibling: ReceiptItemWrite = {
    ...source,
    id: undefined,
    batch_no: null,
    mfg_date: null,
    expiry_date: null,
    received_qty: opening as ReceiptItemWrite["received_qty"],
    accepted_qty: opening as ReceiptItemWrite["accepted_qty"],
    rejected_qty: 0,
    serial_numbers: null,
    imei_numbers: null,
    pack_breakdown: null,
  };
  const next = items.map((l, i) => (i === index && dropCounted ? { ...l, pack_breakdown: null } : l));
  let at = index + 1;
  while (at < next.length && same(next[at])) at += 1;
  return [...next.slice(0, at), sibling, ...next.slice(at)];
}
