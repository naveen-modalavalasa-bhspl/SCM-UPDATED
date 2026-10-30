import {
  Button, Can, ConfirmModal, ErrorBanner, Field, Input, PackageCheckModal, PageHeader, Select, StatusPill,
} from "@/shared/components";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, FileText, ScanLine, Send } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { DateInput, LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { ReceiptLinePacking } from "../components/ReceiptLinePacking";
import {
  type PackEntry, PackQty, baseOf, checkFrom, checkSummary, expandPacks, greedy, hierarchyOf,
  packable, shrinkWithin, splitByCheck, usePackOptions,
} from "@/shared/packing";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { ReceiptLinkedDocuments } from "../components/LinkedDocuments";
import { ReceiptRoutingPanel } from "../components/ReceiptRouting";
import { UnitCodesModal } from "../components/UnitCodesModal";
import {
  binOptions, completeReceipt, convertReceiptToGrn, createReceipt, forwardArrival,
  despatchNoteOptions, dispatchReceiptSource, gateEntryOptions, getDespatchPrefill,
  getPoLines, getReceipt, getReceiptRouting, incomingDispatchOptions, itemOptions, poOptions,
  routeParkedReceipt, submitReceipt, myWarehouseOptions, updateReceipt, uploadAttachment, vendorOptions,
} from "../api";

import { fmtMoney, fmtQty, num, rate2, today } from "../format";
import { alerts } from "@/modules/alerts";
import { useAuth } from "@/shared/auth/AuthContext";
import type { ItemOption, Receipt, ReceiptItemWrite, ReceiptWrite } from "../types";
import { useMyPoint, usePointLabel } from "../usePointLabel";
import {
  CombinationPicker, CombinationTag, comboFrom, pickCombination, useCombinationOptions,
} from "@/shared/combination";

/**
 * One form for both a gate entry and a GRN — they are one `inb_receipts` row at two
 * points in its life, so splitting them into two screens meant retyping the vehicle,
 * the LR and the invoice at the second one.
 *
 * `receipt_type` decides how much of the form is on show: a gate entry captures the
 * paperwork, the vehicle and a head count of what came off it; a GRN adds the
 * inspection detail — accepted and rejected quantities, batch and expiry, bin and rate.
 * Asking for any of that at the gate is asking a security guard to do QC, so
 * `GRN_ONLY_LINE_COLUMNS` keeps those columns out of the inward grid entirely.
 *
 * Serials are the exception: they show on both, but only the GRN insists on a full set.
 * At the gate you capture whatever the cartons let you read — none, some, all — and the
 * GRN, which is the same row, opens with those already in the grid and will not save
 * until the rest are scanned.
 *
 * The purchase order is a typed box on both. It used to be a picker on the GRN that
 * filled the lines from the chosen order, but procurement does not raise orders in this
 * system yet, so that picker listed nothing and the lines it was there to fill had to be
 * keyed by hand anyway. The number is read off the driver's paperwork and may belong to
 * an order this system never saw.
 *
 * Quantities are the load-bearing part. `received_qty` is what came off the vehicle,
 * `accepted_qty` is what you are keeping, and `rejected_qty` is derived — never
 * typed — so the three can never disagree. `short_qty` is likewise derived from the
 * ordered quantity, which is why a PO-backed line shows it and a free line does not.
 */

const parseCodes = (arr: any): string[] | null => {
  if (!arr) return null;
  if (!Array.isArray(arr)) {
    if (arr.accepted && Array.isArray(arr.accepted)) {
      return parseCodes(arr.accepted);
    }
    return null;
  }
  if (arr.length === 0) return [];
  if (typeof arr[0] === "string") return arr;
  return arr.map((u: any) => u?.serial_number || u?.imei_no || u?.asset_code || u?.consumable_code || u?.serial_no || u?.code).filter(Boolean);
};

const emptyLine = (): ReceiptItemWrite => ({
  item_id: 0,
  uom_code: null,
  is_asset: false,
  is_serial_tracked: false,
  is_imei_tracked: false,
  ordered_qty: 0,
  received_qty: "" as any,
  accepted_qty: "" as any,
  rejected_qty: 0,
  rate: null,
  batch_no: null,
  mfg_date: null,
  expiry_date: null,
  bin_id: null,
  remarks: null,
  serial_numbers: null,
  imei_numbers: null,
});

/** Line columns a gate entry does not ask for — they belong to the GRN, after the
 *  consignment has been opened and inspected. */
const GRN_ONLY_LINE_COLUMNS = new Set([
  "accepted", "rejected", "batch", "manufactured", "expiry", "reason", "bin", "rate",
]);

const RECEIPT_TYPES = [
  { value: "PURCHASE", label: "Inward / PO receipt" },
  { value: "DIRECT", label: "Direct receipt" },
  { value: "RETURN", label: "Return receipt" },
  { value: "TRANSFER", label: "Transfer receipt" },
  // The MDP / LIP end of the chain: goods a warehouse dispatched here, inwarded the
  // same way a purchase is, so the stock only exists at this point once somebody
  // standing here says it arrived.
  { value: "DISPATCH", label: "Inward from consignment" },
];

/** What an MDP or a LIP is allowed to receive.
 *
 * Nothing arrives at the bottom of the chain from outside the company: no purchase
 * order is raised there, no vendor delivers there, and a transfer between local
 * points is not something a storekeeper books on a GRN. Leaving all five on the
 * dropdown invited a receipt type that then asked for a PO nobody has. */
const LOCAL_RECEIPT_TYPES = new Set(["DISPATCH", "DIRECT"]);

/** The rungs below the main store. Mirrors LocationTier on the backend. */
const LOCAL_POINT_TYPES = new Set(["MDP", "LIP"]);

/** Two counts in ONE hierarchy, added level by level (a part pack keeps its fill). */
function mergePacks(a?: PackEntry[] | null, b?: PackEntry[] | null): PackEntry[] | null {
  if (!a?.length || !b?.length) return null;
  const out = new Map<string, PackEntry>();
  for (const e of [...a, ...b]) {
    const key = `${e.level}|${e.fill ?? ""}`;
    const had = out.get(key);
    out.set(key, had ? { ...had, qty: num(had.qty) + num(e.qty) } : { ...e });
  }
  return [...out.values()].sort((x, y) => y.level - x.level);
}

const lifeDateLabel = (line?: Pick<ReceiptItemWrite, "is_asset"> | null) =>
  line?.is_asset ? "Warranty" : "Expiry";

export default function ReceiptForm({ mode }: { mode: "GATE_ENTRY" | "PURCHASE" }) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const editing = !!id && id !== "new";
  const isGrn = mode === "PURCHASE";

  const [form, setForm] = useState<ReceiptWrite>({
    receipt_type: mode,
    grn_date: today(),
    po_id: null,
    po_no: "",
    despatch_note_id: null,
    dispatch_id: null,
    vendor_id: null,
    warehouse_id: 0,
    project_id: null,
    invoice_no: "",
    invoice_date: null,
    invoice_amount: null,
    eway_bill_no: "",
    vehicle_no: "",
    transporter_name: "",
    lr_no: "",
    gate_entry_no: "",
    remarks: "",
    items: [],
  });
  const [touched, setTouched] = useState(false);
  const [vendorName, setVendorName] = useState<string>("");
  const [sourceGateId, setSourceGateId] = useState<number | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-receipt", id],
    queryFn: () => getReceipt(Number(id)),
    enabled: editing,
  });

  /* Gate entries still waiting to become a GRN. Converting one flips its `receipt_type`,
   * so an entry that was already converted on its own screen is gone from this list ?
   * it IS a GRN draft by then. Shares the Lookup's cache key, so this is not a second
   * request; it exists only so the field can say why it is empty rather than looking
   * broken. */
  const { data: pendingGateEntries = [] } = useQuery({
    queryKey: ["wh-lookup", "gate-entries", ""],
    queryFn: () => gateEntryOptions(),
    staleTime: 5 * 60_000,
    enabled: isGrn && !editing,
  });

  const poFallback = useMemo(() => {
    return form.po_id && form.po_no ? [{ id: form.po_id, code: form.po_no, name: form.po_no }] : undefined;
  }, [form.po_id, form.po_no]);

  const vendorFallback = useMemo(() => {
    return form.vendor_id && vendorName ? [{ id: form.vendor_id, name: vendorName, code: "" }] : undefined;
  }, [form.vendor_id, vendorName]);

  const warehouseFallback = useMemo(() => {
    return form.warehouse_id && doc?.warehouse_name 
      ? [{ id: form.warehouse_id, name: doc.warehouse_name, code: "" }] 
      : undefined;
  }, [form.warehouse_id, doc?.warehouse_name]);

  // Documents picked before the first save: they have no receipt to hang off yet.
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  /** The line whose Serial / IMEI popup is open — it opens on every line of that item. */
  const [codesLine, setCodesLine] = useState<number | null>(null);
  /** The line whose packs are being checked one by one (2026-10-27). */
  const [packCheckLine, setPackCheckLine] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"submit" | "complete" | null>(null);

  /** Loading a saved receipt back into the editable shape. */
  useEffect(() => {
    if (!doc) return;
    setForm({
      receipt_type: doc.receipt_type,
      grn_date: doc.grn_date,
      po_id: doc.po_id ?? null,
      po_no: doc.po_no ?? "",
      despatch_note_id: doc.despatch_note_id ?? null,
      // `transfer_id` carries the source document; `receipt_type` says which one.
      dispatch_id: doc.receipt_type === "DISPATCH" ? doc.transfer_id ?? null : null,
      vendor_id: doc.vendor_id ?? null,
      warehouse_id: doc.warehouse_id,
      project_id: doc.project_id ?? null,
      invoice_no: doc.invoice_no ?? "",
      invoice_date: doc.invoice_date ?? null,
      invoice_amount: doc.invoice_amount ?? null,
      eway_bill_no: doc.eway_bill_no ?? "",
      vehicle_no: doc.vehicle_no ?? "",
      transporter_name: doc.transporter_name ?? "",
      lr_no: doc.lr_no ?? "",
      gate_entry_no: doc.gate_entry_no ?? "",
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        po_item_id: l.po_item_id,
        indent_id: l.indent_id,
        item_id: l.item_id,
        ...comboFrom(l),
        item_code: l.item_code,
        item_name: l.item_name,
        uom_code: l.uom_code,
        is_asset: l.is_asset,
        is_serial_tracked: l.is_serial_tracked,
        is_imei_tracked: l.is_imei_tracked,
        ordered_qty: num(l.ordered_qty),
        received_qty: num(l.received_qty),
        accepted_qty: num(l.accepted_qty),
        rejected_qty: num(l.rejected_qty),
        rate: rate2(l.rate),
        batch_no: l.batch_no,
        mfg_date: l.mfg_date,
        expiry_date: l.expiry_date,
        bin_id: l.bin_id || null,
        rejection_reason: l.rejection_reason,
        remarks: l.remarks,
        serial_numbers: parseCodes(l.serial_numbers),
        imei_numbers: parseCodes(l.imei_numbers),
        despatch_note_item_id: l.despatch_note_item_id ?? null,
        pack_hierarchy_id: l.pack_hierarchy_id ?? null,
        declared_pack_breakdown: l.declared_pack_breakdown ?? null,
        pack_breakdown: l.pack_breakdown ?? null,
      })),
    });
    if (doc.vendor_name) setVendorName(doc.vendor_name);
  }, [doc]);

  /**
   * Pick the order once; the delivery fills itself in.
   *
   * The PO was a free-text box because, when this form was written, nothing in the
   * system raised purchase orders — so a picker would have offered an empty list while
   * the goods arrived anyway. Procurement raises them now, so the order is the one
   * thing worth identifying at the gate: every line, its unit, what was ordered and at
   * what rate comes from it, and the storekeeper is left counting rather than typing.
   *
   * `po_item_id` on each line is the part that matters beyond convenience — it is what
   * lets a part-delivery know what is still owed, and what lets the receipt push the
   * order to PARTIALLY_RECEIVED / RECEIVED when it posts.
   *
   * Lines already entered are kept. Somebody who has started counting must not lose it
   * because they then identified the order; the pending lines are appended to what is
   * there, minus any already on the form.
   */
  /** An order with nothing left on it, and who took it. Cleared when the order is. */
  const [poSettled, setPoSettled] = useState<
    { lines: number; by: string[] } | null
  >(null);

  const fillFromPo = useMutation({
    // The receipt being filled is left out of its own order's running total, or a
    // saved receipt re-filling from its order would be told the order owes nothing.
    mutationFn: (poId: number) => getPoLines(poId, doc?.id),
    onSuccess: (prefill) => {
      const already = new Set(
        form.items.map((line) => line.po_item_id).filter(Boolean) as number[],
      );
      const added = prefill.lines.filter((line) => !already.has(line.po_item_id)).map((line) => ({
        ...emptyLine(),
        po_item_id: line.po_item_id,
        indent_id: line.indent_id ?? undefined,
        item_id: line.item_id,
        ...comboFrom(line),
        item_code: line.item_code,
        item_name: line.item_name,
        uom_code: line.uom_code,
        // Off the item master, served with the line: without them a PO line read as
        // untracked and the gate was never asked for its serials or IMEIs.
        is_asset: !!line.is_asset,
        is_serial_tracked: !!line.is_serial_tracked,
        is_imei_tracked: !!line.is_imei_tracked,
        ordered_qty: num(line.ordered_qty),
        // What is still owed, as the count to confirm rather than a figure to trust:
        // the storekeeper overwrites it with what actually turned up.
        received_qty: line.pending_qty != null ? num(line.pending_qty) as any : num(line.ordered_qty) as any,
        accepted_qty: line.pending_qty != null ? num(line.pending_qty) as any : num(line.ordered_qty) as any,
        rate: rate2(line.rate),
        pack_hierarchy_id: line.pack_hierarchy_id ?? null,
        pack_breakdown: line.pack_breakdown ?? null,
      }));
      // Nothing outstanding is an ANSWER, and a toast that scrolls away is not where
      // it belongs: the storekeeper is standing at a delivery and needs to know the
      // order has already been received, by whom, before he starts counting. Held on
      // the form until the order is changed.
      setPoSettled(
        added.length === 0 && (prefill.total_lines ?? 0) > 0
          ? { lines: prefill.total_lines ?? 0, by: prefill.received_by ?? [] }
          : null,
      );
      if (!added.length) {
        void alerts.info("receipt.po_nothing_pending");
      }
      setForm((current) => ({
        ...current,
        vendor_id: current.vendor_id || prefill.vendor_id || undefined,
        project_id: current.project_id || prefill.project_id || undefined,
        invoice_amount: current.invoice_amount ?? prefill.total_amount ?? null,
        items: [...current.items, ...added],
      }));
      if (prefill.vendor_name) setVendorName(prefill.vendor_name);
      setTouched(true);
    },
  });



  /** The vendor is left to the server, which reads it off the order itself rather
   *  than trusting a field the gate could contradict.
   *
   *  Picking the order pulls the vendor's own despatch note WITH it when they have
   *  filed one — the newest, which is the delivery standing at the gate. It used to
   *  fill from the order alone and leave the note to a second picker below, so the
   *  invoice, the e-way bill, the vehicle, the transporter and every line's batch and
   *  expiry sat one click away and were simply never fetched: the receipts on this
   *  system show a linked order and an empty invoice box. The picker stays, for the
   *  delivery that is the second note against an order.
   *
   *  Falls back to the order's own lines when no note has been filed — goods turn up
   *  without paperwork and are still received. */
  const choosePo = (poId: number | null, poNo: string) => {
    setForm((current) => ({
      ...current, po_id: poId, po_no: poNo, despatch_note_id: null,
    }));
    // Whatever the last order said about itself belonged to the last order.
    setPoSettled(null);
    setTouched(true);
    if (poId) fillFromOrder.mutate(poId);
  };

  /** Whichever of the two the order actually has behind it. One mutation so the form
   *  is never filled twice from two sources racing each other. */
  const fillFromOrder = useMutation({
    mutationFn: async (poId: number) => {
      const notes = await qc.fetchQuery({
        queryKey: ["wh-lookup", "despatch-notes", poId],
        queryFn: () => despatchNoteOptions(poId),
        staleTime: 5 * 60_000,
      });
      return notes.length ? { noteId: Number(notes[0].id) } : { noteId: null };
    },
    onSuccess: ({ noteId }, poId) => {
      if (noteId) fillFromDespatch.mutate(noteId);
      else fillFromPo.mutate(poId);
    },
    // A lookup that fails must not cost the storekeeper the order they just picked.
    onError: (_error, poId) => {
      fillFromPo.mutate(poId);
    },
  });

  /**
   * Fill the whole delivery from the vendor's own despatch note.
   *
   * The stronger version of picking the order: the PO says what was bought, the note
   * says what was actually put on the vehicle — invoice, e-way bill, vehicle, LR, and
   * per line the batch, manufacture and expiry. Those last three cannot be derived
   * from anything we hold; they are properties of the physical cartons, known only to
   * whoever packed them, and they drive FEFO picking and expiry alerts for the rest of
   * the item's life. Typed at a gate off a carton, they are typed wrong.
   *
   * Replaces the lines rather than appending: a despatch note is a complete statement
   * of one delivery, and merging it with a half-typed guess produces a receipt that
   * matches neither.
   */
  const fillFromDespatch = useMutation({
    mutationFn: (noteId: number) => getDespatchPrefill(noteId, doc?.id),
    onSuccess: (prefill) => {
      setForm((current) => ({
        ...current,
        despatch_note_id: prefill.despatch_note_id,
        po_id: prefill.po_id ?? current.po_id,
        po_no: prefill.po_no ?? current.po_no,
        vendor_id: prefill.vendor_id ?? current.vendor_id ?? undefined,
        // Only where the gate has not already written something: a storekeeper who
        // typed the invoice off the paper in their hand is looking at the real
        // document, and must not be overruled by what the vendor filed earlier.
        invoice_no: current.invoice_no || (prefill.invoice_no ?? ""),
        invoice_date: current.invoice_date ?? prefill.invoice_date ?? null,
        invoice_amount: current.invoice_amount ?? prefill.invoice_amount ?? null,
        eway_bill_no: current.eway_bill_no || (prefill.eway_bill_no ?? ""),
        vehicle_no: current.vehicle_no || (prefill.vehicle_no ?? ""),
        transporter_name: current.transporter_name || (prefill.transporter_name ?? ""),
        lr_no: current.lr_no || (prefill.lr_no ?? ""),
        items: prefill.lines.map((line) => ({
          ...emptyLine(),
          po_item_id: line.po_item_id ?? undefined,
          item_id: line.item_id,
          ...comboFrom(line),
          item_code: line.item_code,
          item_name: line.item_name,
          uom_code: line.uom_code,
          is_asset: !!line.is_asset,
          is_serial_tracked: !!line.is_serial_tracked,
          is_imei_tracked: !!line.is_imei_tracked,
          ordered_qty: num(line.ordered_qty),
          // What the vendor says is on the vehicle, as the count to CONFIRM. The
          // storekeeper overwrites it with what is physically there, and the gap is
          // exactly the shortage the GRN exists to record.
          received_qty: line.despatched_qty != null ? num(line.despatched_qty) as any : num(line.ordered_qty) as any,
          accepted_qty: line.despatched_qty != null ? num(line.despatched_qty) as any : num(line.ordered_qty) as any,
          rate: rate2(line.rate),
          batch_no: line.batch_no,
          mfg_date: line.mfg_date,
          expiry_date: line.expiry_date,
          // The supplier's packing is DECLARED: copied once, fixed at the gate.
          despatch_note_item_id: line.despatch_note_item_id ?? null,
          pack_hierarchy_id: line.pack_hierarchy_id ?? null,
          declared_pack_breakdown: line.pack_breakdown ?? null,
          pack_breakdown: line.counted_pack_breakdown ?? line.pack_breakdown ?? null,
          pack_change_status: line.pack_change_status ?? null,
          ordered_pack_hierarchy_name: line.ordered_pack_hierarchy_name ?? null,
          pack_change_reason: line.pack_change_reason ?? null,
          pack_change_note: line.pack_change_note ?? null,
        })),
      }));
      if (prefill.vendor_name) setVendorName(prefill.vendor_name);
      setTouched(true);
    },
  });

  /** Whether this order has any vendor paperwork behind it at all. Advisory only —
   *  see the hint below the picker: goods turn up without a note and are received. */
  const { data: despatchNotes = [] } = useQuery({
    queryKey: ["wh-lookup", "despatch-notes", form.po_id ?? 0],
    queryFn: () => despatchNoteOptions(form.po_id as number),
    staleTime: 5 * 60_000,
    enabled: Boolean(form.po_id),
  });

  /** Snapshot labels for lines loaded from the server, so the grid needs no joins. */
  const savedLine = (index: number) => doc?.items?.[index];

  const gateEntry = useMutation({
    mutationFn: (receiptId: number) => getReceipt(receiptId),
    onSuccess: (source) => {
      setSourceGateId(source.id);
      setForm({
        receipt_type: "PURCHASE",
        grn_date: today(),
        po_id: source.po_id ?? null,
        po_no: source.po_no ?? "",
        despatch_note_id: source.despatch_note_id ?? null,
        dispatch_id: null,
        vendor_id: source.vendor_id ?? null,
        warehouse_id: source.warehouse_id,
        project_id: source.project_id ?? null,
        invoice_no: source.invoice_no ?? "",
        invoice_date: source.invoice_date ?? null,
        invoice_amount: source.invoice_amount ?? null,
        eway_bill_no: source.eway_bill_no ?? "",
        vehicle_no: source.vehicle_no ?? "",
        transporter_name: source.transporter_name ?? "",
        lr_no: source.lr_no ?? "",
        gate_entry_no: source.gate_entry_no ?? "",
        remarks: source.remarks ?? "",
        items: (source.items ?? []).map((line) => ({
          id: line.id,
          po_item_id: line.po_item_id,
          indent_id: line.indent_id,
          item_id: line.item_id,
          ...comboFrom(line),
          item_code: line.item_code,
          item_name: line.item_name,
          uom_code: line.uom_code,
          is_asset: line.is_asset,
          is_serial_tracked: line.is_serial_tracked,
          is_imei_tracked: line.is_imei_tracked,
          ordered_qty: num(line.ordered_qty),
          received_qty: num(line.received_qty),
          accepted_qty: num(line.received_qty),
          rejected_qty: 0,
          rate: rate2(line.rate),
          batch_no: line.batch_no,
          mfg_date: line.mfg_date,
          expiry_date: line.expiry_date,
          bin_id: line.bin_id || null,
          rejection_reason: null,
          remarks: line.remarks,
          serial_numbers: parseCodes(line.serial_numbers),
          imei_numbers: parseCodes(line.imei_numbers),
        })),
      });
    },
  });

  /* Pulling an incoming consignment into the inward form. The lines come off the
   * dispatch, not off the challan by hand: what was sent is what the receiver has to
   * confirm or correct, and retyping it is how a shortage gets missed. */
  const consignment = useMutation({
    mutationFn: (dispatchId: number) => dispatchReceiptSource(dispatchId, form.warehouse_id),
    onSuccess: (source) => {
      setForm((f) => ({
        ...f,
        dispatch_id: source.dispatch_id,
        warehouse_id: source.warehouse_id,
        project_id: source.project_id ?? null,
        lr_no: source.lr_no ?? "",
        vehicle_no: source.vehicle_number ?? "",
        remarks: f.remarks || `Received against ${source.dispatch_no}`,
        items: source.items.map((line) => ({ ...emptyLine(), ...line })),
      }));
    },
  });

  /* Whether this point puts things away into bins at all. An MDP or a LIP normally
   * has no floor/rack/bin structure configured, and asking a storekeeper which shelf
   * a carton went on when the point has no shelves is noise — so the bin column only
   * exists where warehouse masters say it does. Shares the warehouse Lookup's cache
   * key, so this is not a second request. */
  const { data: warehouses = [] } = useQuery({
    queryKey: ["wh-lookup", "my-warehouses", ""],
    queryFn: () => myWarehouseOptions(),
    staleTime: 5 * 60_000,
  });
  const binManaged = !!warehouses.find((w) => w.id === form.warehouse_id)?.is_bin_managed;

  /* A new receipt opens at the point the person is standing in. Left at "pick one",
   * a storekeeper tagged to a single LIP inwarded a delivery into an unrelated MDP,
   * and the stock posted correctly to a point his own screens are scoped away from —
   * every inventory page read empty with the goods sitting in the room.
   *
   * FIXED 2026-08-24 — it prefilled whenever the field was EMPTY, and clearing the
   * picker to choose another point is exactly that. The effect re-ran on the cleared
   * value and wrote the default straight back, so the field could never be changed:
   * clear, it returns; clear again, it returns. It is an OPENING value, so it is
   * written once per form and the ref remembers that it has been.
   */
  const { primary_warehouse_id: myPoint } = useMyPoint().data ?? {};
  const prefilledPoint = useRef(false);
  useEffect(() => {
    if (editing || prefilledPoint.current || form.warehouse_id) return;
    const fallback = warehouses.length === 1 ? warehouses[0].id : null;
    const mine = myPoint ?? fallback;
    if (mine) {
      prefilledPoint.current = true;
      setForm((f) => ({ ...f, warehouse_id: mine }));
    }
  }, [editing, form.warehouse_id, myPoint, warehouses]);

  const set = <K extends keyof ReceiptWrite>(key: K, value: ReceiptWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** Every line edit runs through here so the derived quantities stay derived. */
  // Pack hierarchies of every item on the receipt, in one call (2026-10-08).
  const packOptions = usePackOptions(form.items.map((line) => line.item_id));
  /** A line whose quantity comes from its packs — the received box follows them. */
  const isPacked = (line: ReceiptItemWrite) =>
    !!line.pack_breakdown?.length && packable(packOptions.data?.[line.item_id]).length > 0;
  /** Units with every code the item needs — a handset with a serial and no IMEI is
   *  not a coded unit. */
  const unitsCoded = (line: ReceiptItemWrite) => {
    const counts = [
      ...(line.is_serial_tracked ? [line.serial_numbers?.length ?? 0] : []),
      ...(line.is_imei_tracked ? [line.imei_numbers?.length ?? 0] : []),
    ];
    return counts.length ? Math.min(...counts) : 0;
  };
  /** What the despatch note declared for a line, in base units — or null for none. */
  const declaredQty = (line: ReceiptItemWrite) =>
    line.declared_pack_breakdown?.length ? baseOf(line.declared_pack_breakdown) : null;
  /** More counted than the supplier declared: the server refuses it level by level. */
  const overDeclared = (line: ReceiptItemWrite) => {
    const sent = declaredQty(line);
    return sent !== null && !blankQty(line.received_qty) && num(line.received_qty) > sent;
  };
  /**
   * A TYPED received quantity, said again as packs of the line's OWN hierarchy
   * (2026-10-21) — the hierarchy never changes here. Against a despatch note it is
   * the declared packs shrunk to that quantity, exactly as the server reads a short
   * count (`shrinkWithin` ↔ `packing.shrink_snapshot`); without one, whole packs
   * biggest-first and the rest loose. `undefined` for a line with no packing at all.
   */
  const packsFor = (line: ReceiptItemWrite, qty: number): PackEntry[] | undefined => {
    if (line.declared_pack_breakdown?.length) {
      return shrinkWithin(line.declared_pack_breakdown, Math.min(qty, baseOf(line.declared_pack_breakdown)));
    }
    const h = packingOf(line);
    return h ? greedy(h, qty) : undefined;
  };
  /** The hierarchy a line counts in: its own, else — a direct line nobody has packed
   *  yet (2026-10-27) — the item's default, which is the one the server describes it
   *  in on save anyway. Saying so on screen is what puts the packs, and the pack-by-pack
   *  check, on a direct inward before the first save rather than after it. */
  const packingOf = (line: ReceiptItemWrite) => {
    const options = packable(packOptions.data?.[line.item_id]);
    return options.find((x) => x.hierarchy_id === line.pack_hierarchy_id)
      ?? (line.pack_hierarchy_id || line.declared_pack_breakdown?.length
        ? undefined : options.find((x) => x.is_default) ?? options[0]);
  };
  /**
   * The packs a line is checked AGAINST, pack by pack (2026-10-27): the supplier's
   * despatch note when there is one — fixed, and what the server holds the count to —
   * else the packs the line held when the check was first opened, so a carton marked
   * missing stays on the list to be marked back. Null for a line with no packs.
   */
  const referencePacks = (line: ReceiptItemWrite): PackEntry[] | null => {
    const ref = line.declared_pack_breakdown?.length ? line.declared_pack_breakdown
      : line.expected_pack_breakdown?.length ? line.expected_pack_breakdown
      : line.pack_breakdown;
    return ref?.some((e) => e.level > 0 && num(e.qty) > 0) ? ref : null;
  };
  /** The name of the packing a line is in — "Box of 20" — or null for none. */
  const packName = (line: ReceiptItemWrite): string | null =>
    packable(packOptions.data?.[line.item_id])
      .find((h) => h.hierarchy_id === line.pack_hierarchy_id)?.name
    ?? hierarchyOf(line.declared_pack_breakdown ?? line.pack_breakdown) ?? null;

  // The ON brand / variant / model combinations of every item on the receipt.

  const comboOptions = useCombinationOptions(form.items.map((line) => line.item_id || 0));

  const patchLine = (index: number, patch: Partial<ReceiptItemWrite>) =>
    setForm((f) => {
      const items = f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        // Lowering the quantity takes the surplus codes with it, from the tail — the
        // last scanned are the ones still in hand — so 30 corrected to 25 does not send
        // the storekeeper into the popup to delete five by hand. Never on a blank box:
        // that is a number being retyped, not a count of zero.
        if ("received_qty" in patch && !blankQty(next.received_qty)) {
          const units = Math.floor(num(next.received_qty));
          if ((next.serial_numbers?.length ?? 0) > units) next.serial_numbers = next.serial_numbers!.slice(0, units);
          if ((next.imei_numbers?.length ?? 0) > units) next.imei_numbers = next.imei_numbers!.slice(0, units);
        }
        const received = num(next.received_qty);
        // Accepted can never exceed what arrived; rejected is the remainder.
        const accepted = Math.min(num(next.accepted_qty), received);
        return { ...next, accepted_qty: accepted, rejected_qty: Math.max(received - accepted, 0) };
      });
      return { ...f, items };
    });

  const totals = useMemo(() => {
    const rows = form.items;
    return {
      lines: rows.length,
      received: rows.reduce((s, l) => s + num(l.received_qty), 0),
      accepted: rows.reduce((s, l) => s + num(l.accepted_qty), 0),
      rejected: rows.reduce((s, l) => s + num(l.rejected_qty), 0),
      value: rows.reduce((s, l) => s + num(l.accepted_qty) * num(l.rate), 0),
    };
  }, [form.items]);

  const locked = !!doc && !["DRAFT", "GATE_ENTRY"].includes(doc.status);
  /* Filing a document is the same grant as saving one: POST /attachments is gated
   * on receipt.create, so offering "Attach a file" without it ends in a refusal
   * banner for an action the screen itself invited. Save is already <Can>-gated;
   * this keeps the Documents panel honest the same way. */
  const canFile = can("receipt.create");
  /** Lines came off a consignment, so the items are fixed by what was sent. */
  const fromConsignment = form.receipt_type === "DISPATCH";

  /* Where this GRN is being raised. The receiving point is already on the form, so
   * the same list the picker loads answers it — no extra round trip. */
  const myPoints = useQuery({
    queryKey: ["wh-my-warehouses"],
    queryFn: () => myWarehouseOptions(),
  });
  const isLocalPoint = LOCAL_POINT_TYPES.has(
    (myPoints.data ?? []).find((w) => w.id === form.warehouse_id)?.warehouse_type ?? "",
  );
  const receiptTypes = isLocalPoint
    ? RECEIPT_TYPES.filter((t) => LOCAL_RECEIPT_TYPES.has(t.value))
    : RECEIPT_TYPES;

  /* A new GRN opens as PURCHASE, which is not on offer once the receiving point
   * turns out to be an MDP or a LIP. Left alone the Select would sit on a value it
   * no longer lists, and the form would submit a purchase nobody can service. Only
   * a fresh draft is moved — an existing receipt keeps the type it was saved with. */
  useEffect(() => {
    if (editing || !isLocalPoint) return;
    if (!LOCAL_RECEIPT_TYPES.has(form.receipt_type)) {
      set("receipt_type", "DISPATCH");
    }
  }, [editing, isLocalPoint, form.receipt_type]);

  /* A quantity box opens EMPTY on purpose — a storekeeper types what came off the
   * vehicle, and a pre-filled 0 is a number nobody counted. Empty is not 0 though, so
   * it is posted as "" and the server's decimal parser rejects it: what reached this
   * banner was `items.0.received_qty: Input should be a valid decimal`, which names a
   * field the screen does not have and a rule the storekeeper cannot act on. Caught
   * here instead, by line and by item name, in the words of the column they left
   * blank. */
  const blankQty = (value: unknown) =>
    value === "" || value === null || value === undefined;

  /** The lines the storekeeper has not counted yet — read by the Save check and by
   *  the red border on the box, so both say the same thing about the same cell. */
  const uncountedLines = useMemo(() => form.items.reduce<
    { index: number; field: "received" | "accepted"; name: string }[]
  >((acc, line, index) => {
    const name = savedLine(index)?.item_name ?? line.item_name ?? "";
    if (blankQty(line.received_qty)) acc.push({ index, field: "received", name });
    // Only a GRN takes an accepted figure. On a gate entry the column is disabled and
    // mirrors what was received, so it can never be the box that was missed.
    else if (isGrn && blankQty(line.accepted_qty)) acc.push({ index, field: "accepted", name });
    return acc;
  }, []), [form.items, isGrn, doc]);

  const validateQuantities = () => {
    for (const [index, line] of form.items.entries()) {
      if (overDeclared(line)) {
        const name = savedLine(index)?.item_name ?? line.item_name ?? "";
        throw new Error(`Line ${index + 1}${name ? ` (${name})` : ""}: the supplier's despatch note `
          + `sent ${fmtQty(declaredQty(line))}, and this line receives ${fmtQty(line.received_qty)}. `
          + "Enter what actually arrived — at most what was sent.");
      }
      if (line.po_item_id && num(line.received_qty) > num(line.ordered_qty)) {
        const name = savedLine(index)?.item_name ?? line.item_name ?? "";
        throw new Error(`Line ${index + 1}${name ? ` (${name})` : ""}: You received more than was ordered. Enter a number up to the ordered quantity.`);
      }
    }
    
    if (uncountedLines.length === 0) return;
    const where = uncountedLines
      .map((l) => `line ${l.index + 1}${l.name ? ` (${l.name})` : ""}`)
      .join(", ");
    const column = uncountedLines.every((l) => l.field === "accepted")
      ? "Accepted" : "Received";
    throw new Error(
      `${column} quantity is blank on ${where}. Enter what came off the vehicle — `
      + "0 if none of it did.");
  };

  /** Serials and IMEIs must match the received quantity exactly — the server refuses
   *  anything else, at the gate too. Said here by line and item, with where to press. */
  const validateSerialLines = () => {
    for (const [index, line] of form.items.entries()) {
      if (!line.is_serial_tracked && !line.is_imei_tracked) continue;
      const name = savedLine(index)?.item_name ?? line.item_name ?? "";
      const at = `Line ${index + 1}${name ? ` (${name})` : ""}`;
      const required = Math.floor(num(line.received_qty));
      if (num(line.received_qty) !== required) {
        throw new Error(`${at}: enter a whole number of units (like 5, not 5.5) — each unit carries its own code.`);
      }
      const missing = [
        ...(line.is_serial_tracked && (line.serial_numbers?.length ?? 0) !== required ? ["serial"] : []),
        ...(line.is_imei_tracked && (line.imei_numbers?.length ?? 0) !== required ? ["IMEI"] : []),
      ];
      if (missing.length) {
        const done = unitsCoded(line);
        throw new Error(
          `${at}: ${done} of ${required} units have their ${missing.join(" and ")}. `
          + "Press Scan in the Serial / IMEI column and capture one for every unit.");
      }
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      validateQuantities();
      validateSerialLines();
      const saved = await (async () => {
        if (editing) return updateReceipt(Number(id), form);
        if (sourceGateId) {
          await updateReceipt(sourceGateId, form);
          return convertReceiptToGrn(sourceGateId);
        }
        return createReceipt(form);
      })();
      // Files picked before the record existed. Uploaded here rather than dropped,
      // and inside the mutation so a failure shows on the same banner as the save.
      for (const file of stagedFiles) {
        await uploadAttachment("RECEIPT", saved.id, file, "INWARD");
      }
      setStagedFiles([]);
      return saved;
    },
    onSuccess: (saved: Receipt) => {
      void alerts.success("receipt.saved", { number: saved.grn_no });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      qc.invalidateQueries({ queryKey: ["wh-gate-entries"] });
      qc.invalidateQueries({ queryKey: ["wh-receipt", String(saved.id)] });
      qc.invalidateQueries({ queryKey: ["wh-receipt-routing", String(saved.id)] });
      qc.invalidateQueries({ queryKey: ["wh-attachments", "RECEIPT", saved.id] });
      if (!editing) {
        if (!isGrn) {
          nav("/warehouse/material-inward", { replace: true });
          return;
        }
        nav(`/warehouse/grn/${saved.id}`, { replace: true });
      }
    },
  });

  const act = useMutation({
    /* Save first. "Submit for QC" used to post nothing but the id, so anything typed and
     * not saved — serial numbers above all, whose modal button reads "Save serials" and
     * only updates the grid — was silently dropped, and the line reached inspection
     * without the serials the storekeeper had just scanned. */
    mutationFn: async (what: "submit" | "complete") => {
      // Same check as Save, and for the same reason: this posts the whole form, so a
      // box cleared since the last save fails on the server's parser rather than here.
      if (!locked) validateQuantities();
      validateSerialLines();
      if (!locked) await updateReceipt(Number(id), form);
      return what === "submit" ? submitReceipt(Number(id)) : completeReceipt(Number(id));
    },
    onSuccess: (result, what) => {
      const number = doc?.grn_no ?? "The receipt";
      // The server decides where a submitted receipt lands: PENDING_QC only when a
      // line's item requires inspection, otherwise straight to QC_PASSED (bin-managed
      // warehouse, put-away next) or COMPLETED (stock already posted). Announce what
      // it did, not what we assumed — "sent for inspection" on a receipt that closed
      // itself is how someone ends up searching an empty QC queue.
      const key =
        what === "complete" ? "grn.posted"
        : result?.status === "PENDING_QC" ? "receipt.submitted"
        : result?.status === "QC_PASSED" ? "receipt.ready_for_putaway"
        : "receipt.posted_direct";
      void alerts.success(key, { number });
      qc.invalidateQueries({ queryKey: ["wh-receipt", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipt-routing", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipt-inspections", Number(id)] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      setConfirming(null);
    },
  });

  /* An arrived consignment whose goods are only passing through: the MDP never owned
   * them, they came here for indents whose delivery points sit further down. Builds the
   * onward drafts in one click instead of retyping 40 lines. */
  const forward = useMutation({
    mutationFn: () => forwardArrival(Number(id)),
    onSuccess: (drafts) => {
      const made = (drafts ?? []) as Array<{ issue_no?: string }>;
      if (made.length === 0) {
        // Every indent on the GRN already had a live issue here, so the service made
        // nothing. Saying "forwarded" would be a lie.
        void alerts.info("issue.forwarded_none");
        return;
      }
      void alerts.success("issue.forwarded", {
        number: made.map((d) => d.issue_no).filter(Boolean).join(", ")
          || `${made.length} draft(s)`,
      });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
      // The list lives under /transactions; /warehouse/issues is not a route, so the
      // click landed nowhere and reinforced the "did anything happen?" feeling.
      nav("/warehouse/transactions/material-issues");
    },
  });

  /* Where each line goes: QC draft or straight to putaway. A forecast off the saved
   * lines before submit, the record after it. Save and submit both refresh it. */
  const routing = useQuery({
    queryKey: ["wh-receipt-routing", id],
    queryFn: () => getReceiptRouting(Number(id)),
    enabled: editing && isGrn && !!doc && doc.status !== "CANCELLED",
  });

  /* A GRN the retired approval left at SUBMITTED: nothing was raised behind it. */
  const route = useMutation({
    mutationFn: () => routeParkedReceipt(Number(id)),
    onSuccess: () => {
      void alerts.success("receipt.submitted", { number: doc?.grn_no ?? "The receipt" });
      qc.invalidateQueries({ queryKey: ["wh-receipt", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipt-routing", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipt-inspections", Number(id)] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
    },
  });

  const convert = useMutation({
    mutationFn: () => convertReceiptToGrn(Number(id)),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wh-gate-entries"] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      nav(`/warehouse/grn/${saved.id}`);
    },
  });

  /** What the selected order still owes, per PO line — and what it owes nothing of. */
  const { data: poState } = useQuery({
    queryKey: ["wh-lookup", "po-lines", form.po_id ?? 0, doc?.id ?? 0],
    queryFn: () => getPoLines(form.po_id as number, doc?.id),
    enabled: Boolean(form.po_id) && !locked,
    staleTime: 60_000,
  });

  /**
   * What is wrong with each line, said on the line BEFORE Save — the same two rules
   * the save enforces, so the press never gets as far as the server's refusal:
   *
   * - a DUPLICATE: the same item, batch, packing AND brand / variant / model as an
   *   earlier line of this Inward (`_apply_receipt_lines`). One batch sent in two pack
   *   hierarchies is two lines (2026-10-21), and so is one item arriving as two
   *   combinations (2026-10-27) — an LG and an HP toner are different goods on the
   *   shelf even when the batch number on both cartons reads the same;
   * - an order line ALREADY RECEIVED, or taken past what it still owes
   *   (`_assert_po_fulfilment`). A line added by hand for an item the order names is
   *   checked against that item's PO line exactly as the server ties it.
   */
  const { lineProblems, duplicateOrigins } = useMemo(() => {
    const problems = new Map<number, string>();
    const origins = new Map<number, number>();
    const first = new Map<string, number>();
    form.items.forEach((l, i) => {
      if (!l.item_id) return;
      const key = [l.item_id, (l.batch_no ?? "").trim().toLowerCase(), l.pack_hierarchy_id ?? 0,
                   l.brand_id || 0, l.variant_id || 0, l.model_id || 0].join("|");
      const earlier = first.get(key);
      if (earlier === undefined) first.set(key, i);
      else {
        origins.set(i, earlier);
        const itemLabel = l.item_code ? `${l.item_code}` : "This item";
        const batch = l.batch_no?.trim() ? `batch ${l.batch_no.trim()}` : "no batch";
        const packing = packName(l);
        const combo = [l.brand_name, l.variant_name, l.model_name].filter(Boolean).join(" / ");
        const same = [batch, combo, packing].filter(Boolean).join(", ");
        problems.set(
          i,
          isGrn
            ? `Same goods as line ${earlier + 1} (${itemLabel}, ${same}). Combine the quantity `
              + `onto line ${earlier + 1}, or give this line a different batch, brand, variant `
              + `or model.`
            : `Same goods as line ${earlier + 1} (${itemLabel}, ${same}). Combine the quantity `
              + `onto line ${earlier + 1}, remove this line, or pick the brand, variant and model `
              + `that actually arrived.`,
        );
      }
    });

    if (form.po_id && poState) {
      const open = new Map(poState.lines.map((p) => [p.po_item_id, p]));
      const settled = new Map((poState.settled_lines ?? []).map((p) => [p.po_item_id, p]));
      const ofItem = new Map<number, number[]>();
      [...poState.lines, ...(poState.settled_lines ?? [])]
        .sort((a, b) => a.po_item_id - b.po_item_id)
        .forEach((p) => ofItem.set(p.item_id, [...(ofItem.get(p.item_id) ?? []), p.po_item_id]));
      const taken = new Map<number, number>();
      const by = poState.received_by?.length ? ` by ${poState.received_by.join(", ")}` : "";
      form.items.forEach((l, i) => {
        if (!l.item_id || problems.has(i)) return;
        let pid = l.po_item_id ?? null;
        if (!pid && ofItem.has(l.item_id)) {
          const candidates = ofItem.get(l.item_id)!;
          pid = candidates.find((c) =>
            num(open.get(c)?.pending_qty) - (taken.get(c) ?? 0) > 0) ?? candidates[0];
        }
        if (!pid) return;
        const running = (taken.get(pid) ?? 0) + num(l.received_qty);
        const line = open.get(pid);
        if (!line) {
          const done = settled.get(pid);
          if (done) {
            problems.set(i, `Already fully received against ${form.po_no || "this PO"} — all `
              + `${fmtQty(done.ordered_qty)}${by}. Nothing is left to receive; remove this line.`);
          }
          return;
        }
        if (running > num(line.pending_qty)) {
          problems.set(i, `Only ${fmtQty(line.pending_qty)} still to come on ${form.po_no || "this PO"} `
            + `(${fmtQty(line.received_qty)} already received${by}), and this Inward takes `
            + `${fmtQty(running)}. Enter what actually arrived.`);
        }
        taken.set(pid, running);
      });
    }
    return { lineProblems: problems, duplicateOrigins: origins };
  }, [form.items, form.po_id, form.po_no, poState, isGrn, packOptions.data]);

  const problemMessage = (() => {
    const [index, message] = lineProblems.entries().next().value ?? [];
    if (index === undefined || !message) return null;
    const code = form.items[index]?.item_code ?? savedLine(index)?.item_code;
    const more = lineProblems.size > 1 ? ` (${lineProblems.size - 1} more line${lineProblems.size === 2 ? "" : "s"} to fix)` : "";
    return `Line ${index + 1}${code ? ` · ${code}` : ""}: ${message}${more}`;
  })();

  /** Fold a duplicate line into the earlier one — its packs and its codes as well as
   *  its quantity. Summing only the quantity left the packs describing the first line
   *  alone, and a packed line's quantity IS its packs, so the next edit undid it. */
  const mergeDuplicate = (fromIndex: number, toIndex: number) => {
    const fromLine = form.items[fromIndex];
    const toLine = form.items[toIndex];
    if (!fromLine || !toLine) return;
    const packs = mergePacks(toLine.pack_breakdown, fromLine.pack_breakdown);
    const combinedReceived = packs
      ? baseOf(packs)
      : (num(toLine.received_qty) || 0) + (num(fromLine.received_qty) || 0);
    const combinedAccepted = packs
      ? combinedReceived
      : (num(toLine.accepted_qty) || 0) + (num(fromLine.accepted_qty) || 0);
    const codes = (a?: string[] | null, b?: string[] | null) =>
      a?.length || b?.length ? [...(a ?? []), ...(b ?? [])] : (a ?? b ?? null);
    setForm((current) => ({
      ...current,
      items: current.items
        .map((item, idx) => {
          if (idx === toIndex) {
            return {
              ...item,
              received_qty: combinedReceived as any,
              accepted_qty: (isGrn ? combinedAccepted : combinedReceived) as any,
              pack_breakdown: packs ?? item.pack_breakdown,
              serial_numbers: codes(item.serial_numbers, fromLine.serial_numbers),
              imei_numbers: codes(item.imei_numbers, fromLine.imei_numbers),
            };
          }
          return item;
        })
        .filter((_, idx) => idx !== fromIndex),
    }));
  };

  /** The problem on one line, under its item — where the eye already is. */
  const lineNote = (i: number) => {
    if (locked || !lineProblems.has(i)) return null;
    const earlierIdx = duplicateOrigins.get(i);
    return (
      <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-bad/30 bg-bad-bg/60 p-2 text-[11px] leading-snug text-bad">
        <div className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
          <span className="font-semibold">{lineProblems.get(i)}</span>
        </div>
        {earlierIdx !== undefined && !locked && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => mergeDuplicate(i, earlierIdx)}
              className="inline-flex items-center gap-1 rounded bg-bad px-2 py-0.5 text-[11px] font-medium text-white shadow-sm hover:bg-bad/90"
            >
              Combine quantity into Line {earlierIdx + 1}
            </button>
            <button
              type="button"
              onClick={() => set("items", form.items.filter((_, x) => x !== i))}
              className="text-[11px] font-medium text-bad underline hover:no-underline"
            >
              Remove line
            </button>
          </div>
        )}
      </div>
    );
  };

  const invalid = {
    warehouse: touched && !form.warehouse_id,
    lines: touched && form.items.length === 0,
  };

  const submitSave = () => {
    setTouched(true);
    if (!form.warehouse_id) return;
    if (form.items.length === 0) return;
    if (lineProblems.size > 0) {
      void alerts.error(
        !isGrn
          ? "Two lines are the same goods — same item, batch and packing. Combine or remove one before saving."
          : "Please resolve line errors before saving."
      );
      return;
    }
    save.mutate();
  };

  const todayDateStr = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().split("T")[0];

  const allColumns: LineColumn<ReceiptItemWrite>[] = [
    {
      key: "item",
      // The widest column by a distance: an item code is five segments long and the
      // name after it is what the storekeeper actually reads. Left to size itself it
      // collapsed to a few characters of each.
      width: "w-[30%] min-w-[15rem]",
      header: "Item",
      render: (l, i) => {
        // A saved line already carries its snapshot code/name and a line pulled from a
        // PO carries the order's, so both read as text; only a hand-added line keeps its
        // picker, and a PO-backed line is never repointed at another item.
        const saved = savedLine(i);
        const code = saved?.item_code ?? l.item_code;
        const name = saved?.item_name ?? l.item_name;
        // A consignment receipt records what turned up in the vehicle. The quantities
        // are the receiver's to correct — that is the whole point of counting at the
        // gate — but the ITEMS are the sender's, and repointing a line at another item
        // would inward something the dispatch never contained.
        if (saved || l.po_item_id || fromConsignment) {
          return (
            <div className="min-w-0">
              {/* "PO line" was the only fallback, so a consignment line with no
                  snapshot read as if it came off a purchase order. */}
              <div className="truncate text-sm font-medium text-ink">
                {name ?? (fromConsignment ? "Consignment line" : "PO line")}
              </div>
              <div className="truncate font-mono text-[11px] text-muted">{code ?? "—"}</div>
              <CombinationTag value={saved ?? l} className="mt-1" />
              {lineNote(i)}
            </div>
          );
        }
        return (
          <>
          <Lookup
            name="items"
            load={itemOptions}
            value={l.item_id || ""}
            isInvalid={lineProblems.has(i)}
            errorMessage={lineProblems.get(i)}
            formatOptionLabel={(option, defaultLabel) => {
              const otherIdx = form.items.findIndex(
                (item, idx) => idx !== i && item.item_id === option.id
              );
              if (otherIdx !== -1) {
                return `${defaultLabel} (already on line ${otherIdx + 1})`;
              }
              return defaultLabel;
            }}
            onChange={(v, option) => {
              const item = option as ItemOption | undefined;
              patchLine(i, {
                item_id: v === "" ? 0 : v,
                ...pickCombination(null),
                combination_any: false,
                item_code: item?.code ?? null,
                item_name: item?.name ?? null,
                uom_code: item?.uom_code ?? null,
                is_asset: item?.is_asset ?? false,
                is_serial_tracked: item?.is_serial_tracked ?? false,
                is_imei_tracked: item?.is_imei_tracked ?? false,
                serial_numbers: item?.is_serial_tracked ? l.serial_numbers : null,
                imei_numbers: item?.is_imei_tracked ? l.imei_numbers : null,
              });
            }}
            placeholder="Pick an item"
          />
          {!!l.item_id && !!comboOptions.data?.[String(l.item_id)]?.length && (
            <div className="mt-2">
              <CombinationPicker
                options={comboOptions.data?.[String(l.item_id)]}
                value={comboFrom(l)}
                // Off a despatch-note line the server books the supplier's stated
                // combination whatever is sent, so the screen must not offer a change
                // the save would quietly undo.
                locked={locked || !!l.despatch_note_item_id}
                ariaLabel={`Brand, variant and model for line ${i + 1}`}
                onChange={(combo) => patchLine(i, combo)}
              />
            </div>
          )}
          {lineNote(i)}
          </>
        );
      },
    },
    {
      key: "ordered",
      header: "Ordered",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (l) => <span className="tabular text-muted">{l.ordered_qty ? fmtQty(l.ordered_qty) : "—"}</span>,
    },
    {
      key: "received",
      header: "Received",
      numeric: true,
      width: "min-w-[10rem] w-40",
      render: (l, i) => (
        <div className="space-y-1">
          {/* Typed even on a packed line (2026-10-21): the packs follow it, inside the
              line's own hierarchy, and the Serial / IMEI rows are sized off it. */}
          <QtyInput
            ariaLabel={`Received quantity, line ${i + 1}`}
            value={l.received_qty}
            disabled={locked}
            max={declaredQty(l) ?? (l.po_item_id ? num(l.ordered_qty) : undefined)}
            invalid={(touched && blankQty(l.received_qty)) || overDeclared(l)}
            onChange={(v) => {
              const packs = blankQty(v) ? undefined : packsFor(l, num(v));
              const hid = l.pack_hierarchy_id ?? packingOf(l)?.hierarchy_id ?? null;
              // Off no despatch note, the packs the line held before a LOWER count
              // stay the reference for "Check packages" (the cartons that did not come
              // are still listed); a higher count is a new reference of its own.
              const before = l.declared_pack_breakdown?.length ? null
                : l.expected_pack_breakdown?.length ? l.expected_pack_breakdown : l.pack_breakdown;
              const keepRef = !!before?.length && num(v) <= baseOf(before);
              patchLine(i, { received_qty: v, accepted_qty: v,
                             ...(packs !== undefined
                               ? { pack_breakdown: packs, pack_hierarchy_id: hid,
                                   expected_pack_breakdown: keepRef ? before : null }
                               : {}) });
            }}
          />
          {overDeclared(l) && (
            <p className="text-right text-[11px] font-medium text-bad">
              The despatch note sent {fmtQty(declaredQty(l))} — more cannot be received on it.
            </p>
          )}
          {/* The count in packs, the quantity in the item's own unit under it, and
            * the hierarchy one press away (2026-10-11). */}
          {isPacked(l) && (
            <PackQty entries={l.pack_breakdown} qty={l.received_qty}
                     uom={savedLine(i)?.uom_code ?? l.uom_code}
                     hierarchies={packable(packOptions.data?.[Number(l.item_id)])}
                     itemId={Number(l.item_id) || null} align="right" />
          )}
          {/* Pack by pack (2026-10-27): which cartons arrived and which came short —
              the received quantity and the counted packs follow from it. */}
          {(() => {
            const ref = referencePacks(l);
            if (!ref) return null;
            const packs = expandPacks(ref);
            const check = checkFrom(packs, l.pack_breakdown);
            const short = splitByCheck(packs, check).lostQty > 0;
            return (
              <button type="button" onClick={() => setPackCheckLine(i)}
                      title={locked ? "View which packs arrived" : "Mark packs missing or short"}
                      className={`ml-auto flex min-h-9 w-full items-center justify-end gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-colors ${
                        short ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/15"
                          : "border-line text-brand hover:border-brand hover:bg-brand-050"}`}>
                <Boxes className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{checkSummary(packs, check, "short")}</span>
              </button>
            );
          })()}
        </div>
      ),
    },
    {
      key: "short",
      header: "Short",
      numeric: true,
      width: "w-24",
      hideOnNarrow: true,
      render: (l) => (
        <span className={Math.max(num(l.ordered_qty) - num(l.received_qty), 0) > 0 ? "text-warn" : "text-muted"}>
          {fmtQty(Math.max(num(l.ordered_qty) - num(l.received_qty), 0))}
        </span>
      ),
    },
    {
      key: "uom",
      header: "UOM",
      width: "w-20",
      hideOnNarrow: true,
      render: (l, i) => <span className="text-xs text-muted">{savedLine(i)?.uom_code ?? l.uom_code ?? "—"}</span>,
    },
    {
      key: "accepted",
      header: "Accepted",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Accepted quantity, line ${i + 1}`}
          value={l.accepted_qty ?? 0}
          max={num(l.received_qty)}
          disabled={locked || !isGrn}
          invalid={num(l.accepted_qty) > num(l.received_qty)
            || (touched && isGrn && blankQty(l.accepted_qty))}
          onChange={(v) => patchLine(i, { accepted_qty: v })}
        />
      ),
    },
    {
      key: "rejected",
      header: "Rejected",
      numeric: true,
      width: "w-24",
      render: (l) => (
        <span className={`tabular ${num(l.rejected_qty) > 0 ? "font-semibold text-bad" : "text-muted"}`}>
          {fmtQty(l.rejected_qty)}
        </span>
      ),
    },
    {
      key: "batch",
      header: "Batch",
      width: "min-w-[18rem] w-72",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Batch, line ${i + 1}`}
          value={l.batch_no}
          disabled={locked || !isGrn}
          placeholder="Batch no"
          onChange={(v) => patchLine(i, { batch_no: v })}
        />
      ),
    },
    {
      key: "manufactured",
      header: "Manufactured",
      width: "w-36",
      hideOnNarrow: true,
      render: (l, i) => (
        <DateInput
          ariaLabel={`Manufacturing date, line ${i + 1}`}
          value={l.mfg_date}
          max={todayDateStr}
          disabled={locked || !isGrn}
          onChange={(v) => patchLine(i, { mfg_date: v || null })}
        />
      ),
    },
    {
      key: "expiry",
      header: "Expiry / Warranty",
      width: "min-w-[12rem] w-48",
      hideOnNarrow: true,
      render: (l, i) => (
        <DateInput
          ariaLabel={`${lifeDateLabel(l)} date, line ${i + 1}`}
          value={l.expiry_date}
          min={todayDateStr}
          disabled={locked || !isGrn}
          onChange={(v) => patchLine(i, { expiry_date: v || null })}
        />
      ),
    },
    {
      key: "reason",
      header: "Rejection reason",
      width: "min-w-[16rem] w-64",
      hideOnNarrow: true,
      render: (l, i) => (
        <TextInput
          ariaLabel={`Rejection reason, line ${i + 1}`}
          value={l.rejection_reason}
          disabled={locked || !isGrn || num(l.rejected_qty) === 0}
          placeholder={num(l.rejected_qty) > 0 ? "Required" : "—"}
          onChange={(v) => patchLine(i, { rejection_reason: v })}
        />
      ),
    },

    {
      key: "rate",
      header: "Rate",
      numeric: true,
      width: "min-w-[10rem] w-40",
      hideOnNarrow: true,
      render: (l, i) => (
        <QtyInput
          ariaLabel={`Rate, line ${i + 1}`}
          value={l.rate ?? 0}
          step="0.01"
          disabled={locked}
          onChange={(v) => patchLine(i, { rate: rate2(v) })}
        />
      ),
    },
    {
      // Serials and IMEIs together, one row per unit in the popup (2026-10-21). They
      // were two columns opening two lists, and the server pairs position i of one
      // with position i of the other as the same handset — so two lists typed apart
      // were one mis-ordered scan from swapping two phones' IMEIs.
      key: "codes",
      header: "Serial / IMEI",
      width: "w-36",
      render: (l, i) => {
        if (!l.is_serial_tracked && !l.is_imei_tracked) {
          return <span className="text-xs text-muted">Not tracked</span>;
        }
        const units = Math.floor(num(l.received_qty));
        const done = unitsCoded(l);
        const complete = units > 0 && done >= units;
        const what = l.is_serial_tracked && l.is_imei_tracked ? "Serial + IMEI"
          : l.is_imei_tracked ? "IMEI" : "Serial";
        return (
          <button
            type="button"
            onClick={() => setCodesLine(i)}
            title={`${what} for each unit — ${done} of ${units} captured`}
            className={`group inline-flex min-h-11 w-full flex-col items-start justify-center rounded-xl border px-2.5 py-1 text-left transition-all active:scale-[0.98] ${
              complete ? "border-ok/40 bg-ok-bg/60 hover:border-ok"
                : done > 0 ? "border-warn/40 bg-warn-bg/50 hover:border-warn"
                : "border-brand/30 bg-brand-050/60 hover:border-brand"}`}
          >
            <span className={`inline-flex items-center gap-1 text-xs font-bold tabular ${
              complete ? "text-ok" : done > 0 ? "text-warn" : "text-brand"}`}>
              {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ScanLine className="h-3.5 w-3.5" />}
              {locked ? "View" : complete ? "Done" : "Scan"} {done}/{units}
            </span>
            <span className="text-[10px] font-medium text-muted">{what}</span>
          </button>
        );
      },
    },
  ];

  const columns = allColumns.filter((c) =>
    (isGrn || !GRN_ONLY_LINE_COLUMNS.has(c.key)));

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const label = isGrn ? "GRN" : "Gate entry";

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={
          editing
            ? `${label} ${(isGrn ? doc?.grn_no : doc?.gate_entry_no ?? doc?.grn_no) ?? ""}`
            : `New ${label.toLowerCase()}`
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(isGrn ? "/warehouse/grn" : "/warehouse/material-inward")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {/* A gate entry prints too — it is the paper the driver is handed at the
                gate, and it was the one inward document with no sheet at all. Same
                route component either way; it heads itself off `receipt_type`. */}
            {editing && (
              <Button
                variant="ghost"
                onClick={() => window.open(
                  isGrn
                    ? `/warehouse/grn/${id}/print`
                    : `/warehouse/gate-entries/${id}/print`,
                  "_blank",
                )}
                title="Download PDF"
              >
                <FileText className="h-4 w-4" /> Download PDF
              </Button>
            )}
            {!locked && (
              <Can do="receipt.create">
                <Button variant="soft" onClick={submitSave} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && isGrn && doc?.status === "DRAFT" && (
              <Can do="receipt.create">
                <Button onClick={() => setConfirming("submit")}>Submit GRN</Button>
              </Can>
            )}
            {editing && !isGrn && doc?.status === "GATE_ENTRY" && (
              <Can do="receipt.create">
                <Button
                  onClick={() => convert.mutate()}
                  disabled={convert.isPending}
                >
                  {convert.isPending ? "Converting…" : "Convert to GRN"}
                </Button>
              </Can>
            )}
            {/* The door into QC from the delivery itself. Submitting a GRN raises the
                inspection automatically (`_raise_inspection_for`), so this is for the
                receipt whose inspection was never raised or was cancelled — before it,
                the only way in was to open QC and find the GRN in a picker. The form
                prefills off `?receipt_id=`; the ladder and every write stay on
                `/api/warehouse/inspections`, which is gated on inspection.execute. */}
            {editing && isGrn
              && ["PENDING_QC", "QC_FAILED"].includes(doc?.status ?? "")
              && !routing.data?.inspection_id && (
              <Can do="inspection.execute">
                <Button
                  variant="ghost"
                  onClick={() => nav(`/warehouse/quality-inspection/new?receipt_id=${id}`)}
                >
                  Raise QC
                </Button>
              </Can>
            )}
            {editing && isGrn && ["QC_PASSED", "PARTIALLY_RECEIVED"].includes(doc?.status ?? "") && (
              <Can do="grn.qc">
                <Button onClick={() => setConfirming("complete")}>Post to stock</Button>
              </Can>
            )}
            {editing && doc?.receipt_type === "DISPATCH" && doc?.is_stock_posted && (
              <Can do="issue.forward">
                <Button onClick={() => forward.mutate()} disabled={forward.isPending}>
                  <Send className="h-4 w-4" />
                  {forward.isPending ? "Forwarding…" : "Forward to points below"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={(!locked && (touched || lineProblems.size > 0) ? problemMessage : null) ?? save.error ?? gateEntry.error ?? convert.error ?? forward.error ?? consignment.error ?? route.error} />

      {doc && (
        <MetaCard title="Document">
          {/* A gate entry is identified by `gate_entry_no` — the number the gate wrote
              down and the register lists it under. Its `grn_no` is a REC that gets
              re-minted the moment it converts, so showing that here named the document
              something nobody could find it by. */}
          <MetaRow
            label="Number"
            value={
              <span className="font-mono">
                {isGrn ? doc.grn_no : (doc.gate_entry_no ?? doc.grn_no)}
              </span>
            }
          />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Received by" value={doc.received_by_name} />
          <MetaRow label="Stock" value={doc.is_stock_posted ? "Posted" : "Not posted"} />
        </MetaCard>
      )}

      <Section title="Consignment">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input
              type="date"
              value={form.grn_date}
              disabled={locked}
              onChange={(e) => set("grn_date", e.target.value)}
            />
          </Field>
          {isGrn && !editing && (
            <Field label="Receipt type">
              <Select
                value={form.receipt_type}
                onChange={(value) => {
                  set("receipt_type", value || "PURCHASE");
                  if (value !== "PURCHASE") setSourceGateId(null);
                }}
                options={receiptTypes}
                ariaLabel="Receipt type"
              />
            </Field>
          )}
          {isGrn && !editing && form.receipt_type === "PURCHASE" && (
            <Field
              label="Material inward"
              hint={
                pendingGateEntries.length
                  ? "Converts the selected gate entry into this GRN."
                  : "No gate entry is waiting. One converted from its own screen is already a GRN draft — open it from the GRN list instead."
              }
            >
              <Lookup
                name="gate-entries"
                load={gateEntryOptions}
                value={sourceGateId ?? ""}
                isDisabled={gateEntry.isPending}
                onChange={(value) => {
                  const receiptId = value === "" ? null : value;
                  setSourceGateId(receiptId);
                  if (receiptId) gateEntry.mutate(receiptId);
                }}
                placeholder={
                  pendingGateEntries.length ? "Select gate entry" : "No gate entries waiting"
                }
              />
            </Field>
          )}
          <Field label={pointLabel} required>
            <Lookup
              name="my-warehouses"
              load={myWarehouseOptions}
              value={form.warehouse_id || ""}
              fallback={warehouseFallback}
              isDisabled={locked}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  warehouse_id: v === "" ? 0 : v,
                  dispatch_id: null,
                }))
              }
              placeholder={`Receiving ${pointLabel}`}
              isInvalid={invalid.warehouse}
              errorMessage={invalid.warehouse ? `Pick the receiving ${pointLabel}.` : undefined}
            />
          </Field>
          {isGrn && !editing && form.receipt_type === "DISPATCH" && (
            <Field
              label="Incoming consignment"
              hint="Fills the lines from what was dispatched here. Correct the received quantity if the load came short."
            >
              <Lookup
                name={`incoming-dispatches-${form.warehouse_id}`}
                load={(s) => incomingDispatchOptions(form.warehouse_id, s)}
                value={form.dispatch_id ?? ""}
                isDisabled={!form.warehouse_id || consignment.isPending}
                onChange={(value) => {
                  const dispatchId = value === "" ? null : value;
                  set("dispatch_id", dispatchId);
                  if (dispatchId) consignment.mutate(dispatchId);
                }}
                placeholder={
                  form.warehouse_id
                    ? "Select the consignment that arrived"
                    : `Pick the receiving ${pointLabel} first`
                }
              />
            </Field>
          )}
          {!isLocalPoint && (
            <>
              <Field
                label="Purchase order"
                hint={form.po_id
                  ? (form.despatch_note_id
                    ? "Filled from the vendor's despatch note — confirm what arrived."
                    : "Lines, units and rates come from the order — enter what arrived.")
                  : "Pick the order the goods came against."}
              >
                <Lookup
                  name="purchase-orders"
                  load={(s) => poOptions(s, form.warehouse_id)}
                  key={form.warehouse_id || 'no-wh'}
                  value={form.po_id ?? ""}
                  isDisabled={locked || fillFromPo.isPending || fillFromOrder.isPending
                    || fillFromDespatch.isPending}
                  fallback={poFallback}
                  onChange={(v, option) =>
                    choosePo(v === "" ? null : Number(v), option?.code ?? "")}
                  placeholder={fillFromPo.isPending || fillFromOrder.isPending
                    || fillFromDespatch.isPending
                    ? "Loading the delivery…" : "Purchase order"}
                />
              </Field>
              {poSettled && (
                <div className="sm:col-span-2 lg:col-span-3 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-bg/50 px-3 py-2.5 text-sm text-ink">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                  <div className="min-w-0 flex-1">
                    <b>
                      {form.po_no ?? "This order"} has already been received in full —
                      all {poSettled.lines} line{poSettled.lines === 1 ? "" : "s"}.
                    </b>{" "}
                    {poSettled.by.length > 0 && (
                      <>Taken by <b>{poSettled.by.join(", ")}</b>. </>
                    )}
                    Nothing was filled in, and a line entered by hand against it will
                    be refused at save. If these are different goods, they need their
                    own order.
                  </div>
                </div>
              )}
              {!form.po_id && (
                <Field label="PO number (not in this system)"
                       hint="Only for an order raised outside SCM.">
                  <Input
                    value={form.po_no ?? ""}
                    disabled={locked}
                    placeholder="As printed on the paperwork"
                    onChange={(e) => set("po_no", e.target.value)}
                  />
                </Field>
              )}
              {form.po_id && (
                <Field
                  label="Vendor's despatch note"
                  hint={despatchNotes.length
                    ? "Fills the paperwork and each line's batch and expiry."
                    : "The vendor has not filed one — enter the delivery by hand."}
                >
                  <Lookup
                    name={`despatch-notes-${form.po_id}`}
                    load={() => despatchNoteOptions(form.po_id as number)}
                    value={form.despatch_note_id ?? ""}
                    isDisabled={locked || !despatchNotes.length
                      || fillFromDespatch.isPending}
                    onChange={(v) => {
                      const noteId = v === "" ? null : Number(v);
                      set("despatch_note_id", noteId);
                      if (noteId) fillFromDespatch.mutate(noteId);
                    }}
                    placeholder={fillFromDespatch.isPending
                      ? "Loading despatch…"
                      : despatchNotes.length ? "Despatch note" : "None filed"}
                  />
                </Field>
              )}
              <Field label="Vendor" hint={form.po_id ? "Taken from the order." : undefined}>
                <Lookup
                  name="vendors"
                  load={vendorOptions}
                  value={form.vendor_id ?? ""}
                  fallback={vendorFallback}
                  isDisabled={locked || !!form.po_id}
                  onChange={(v) => set("vendor_id", v === "" ? null : Number(v))}
                  placeholder="Vendor"
                />
              </Field>
            </>
          )}
        </div>
      </Section>

      <Section title="Paperwork" hint="Captured once at the gate and carried onto the GRN.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Gate entry no">
            <Input value={form.gate_entry_no ?? ""}
                   disabled
                   placeholder={editing ? "" : "Generated when saved"}
                   onChange={(e) => set("gate_entry_no", e.target.value)} />
          </Field>
          <Field label="Vehicle no">
            <Input value={form.vehicle_no ?? ""} disabled={locked}
                   onChange={(e) => set("vehicle_no", e.target.value.toUpperCase())} />
          </Field>
          <Field label="Transporter">
            <Input value={form.transporter_name ?? ""} disabled={locked}
                   onChange={(e) => set("transporter_name", e.target.value)} />
          </Field>
          <Field label="LR no">
            <Input value={form.lr_no ?? ""} disabled={locked} onChange={(e) => set("lr_no", e.target.value)} />
          </Field>
          <Field label="Invoice no">
            <Input value={form.invoice_no ?? ""} disabled={locked}
                   onChange={(e) => set("invoice_no", e.target.value)} />
          </Field>
          <Field label="Invoice date">
            <Input type="date" value={form.invoice_date ?? ""} disabled={locked}
                   onChange={(e) => set("invoice_date", e.target.value || null)} />
          </Field>
          <Field label="Invoice amount">
            <Input
              type="number"
              value={form.invoice_amount == null ? "" : String(form.invoice_amount)}
              disabled={locked}
              onChange={(e) => set("invoice_amount", e.target.value === "" ? null : Number(e.target.value))}
            />
          </Field>
          <Field label="E-way bill">
            <Input value={form.eway_bill_no ?? ""} disabled={locked}
                   onChange={(e) => set("eway_bill_no", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section
          title="Lines"
          hint={
            isGrn
              ? "Rejected is received minus accepted; short is ordered minus received."
              : "Record the physical item count at the gate. Capture any serials you can read — the rest, plus batch and QC, are completed in the GRN."
          }
        >
          {invalid.lines && <ErrorBanner error="Add at least one line before saving." />}
          {!locked && problemMessage && <ErrorBanner error={problemMessage} />}
          <LinesEditor
            rows={form.items}
            columns={columns}
            keyOf={(_, i) => i}
            minTableWidth={isGrn ? "min-w-[1500px]" : "min-w-[900px]"}
            // No hand-added lines on a consignment receipt: an empty line has no item
            // to pick, and anything not on the challan did not arrive.
            // to pick, and anything not on the challan did not arrive.
            onAdd={locked || fromConsignment || !!form.po_id
              ? undefined
              : () => set("items", [...form.items, emptyLine()])}
            onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
            rowTone={(l, i) => (lineProblems.has(i) ? "bg-bad-bg/25 border-l-4 border-l-bad" : num(l.rejected_qty) > 0 ? "bg-bad-bg/40" : undefined)}
            renderDetail={(l, i) => {
              const options = packable(packOptions.data?.[l.item_id]);
              if (!l.item_id || !options.length) return null;
              return (
                <ReceiptLinePacking line={l} lineNo={i + 1} hierarchies={options} locked={locked}
                                    onChange={(patch) => patchLine(i, patch)} />
              );
            }}
            empty={fromConsignment
              ? "Pick the incoming consignment above — its lines fill in here."
              : isGrn
                ? "Pick a purchase order above, or add lines by hand."
                : "Add the items received at the gate."}
            footer={
              /* Only what the columns above show: totalling accepted, rejected and
               * value at the gate would report figures nobody entered there. */
              <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                <span className="text-muted">{totals.lines} lines</span>
                <span className="text-ink">Received <b className="tabular">{fmtQty(totals.received)}</b></span>
                {isGrn && (
                  <>
                    <span className="text-ok">Accepted <b className="tabular">{fmtQty(totals.accepted)}</b></span>
                    <span className={totals.rejected > 0 ? "text-bad" : "text-muted"}>
                      Rejected <b className="tabular">{fmtQty(totals.rejected)}</b>
                    </span>
                    <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
                  </>
                )}
              </div>
            }
          />
        </Section>

      {routing.data && (
        <ReceiptRoutingPanel
          routing={routing.data}
          onRoute={() => route.mutate()}
          routing_busy={route.isPending}
        />
      )}

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      <Section title="Documents" hint="Invoice copy, LR slip, packing list, weighbridge ticket.">
        {!locked && !canFile && (
          <p className="mb-3 text-xs text-muted">
            You can view this entry. Attaching a document needs the receipt filing
            permission — ask your admin for access.
          </p>
        )}
        <AttachmentsPanel
          entityType="RECEIPT"
          entityId={doc?.id}
          category="INWARD"
          readOnly={locked || !canFile}
          onStagedChange={setStagedFiles}
        />
      </Section>

      {/* The paper trail, read off the pointers this row already carries — the gate
          entry it arrived as, the order, the vendor's despatch note, and the inspection
          its submission raised. Only on a saved document: an unsaved one has no trail. */}
      {doc && <ReceiptLinkedDocuments receipt={doc} />}

      {packCheckLine !== null && form.items[packCheckLine] && (() => {
        const line = form.items[packCheckLine];
        const ref = referencePacks(line) ?? [];
        const packs = expandPacks(ref);
        const index = packCheckLine;
        const tracked = line.is_serial_tracked || line.is_imei_tracked;
        return (
          <PackageCheckModal
            open
            mode="receipt"
            readOnly={locked}
            packName={packs.find((p) => p.level > 0)?.entry.name ?? "pack"}
            uom={savedLine(index)?.uom_code ?? line.uom_code}
            itemLabel={[line.item_code ?? savedLine(index)?.item_code, line.item_name ?? savedLine(index)?.item_name,
                        line.batch_no ? `batch ${line.batch_no}` : null,
                        line.declared_pack_breakdown?.length ? "as the despatch note declares" : null]
              .filter(Boolean).join(" · ")
              + (tracked ? " — serials / IMEIs are matched to the new count separately" : "")}
            packages={packs}
            value={checkFrom(packs, line.pack_breakdown)}
            onClose={() => setPackCheckLine(null)}
            onSave={(check) => {
              const { kept, keptQty } = splitByCheck(packs, check);
              patchLine(index, {
                pack_breakdown: kept, received_qty: keptQty as never, accepted_qty: keptQty as never,
                expected_pack_breakdown: line.declared_pack_breakdown?.length ? null : ref,
              });
            }}
          />
        );
      })()}
      {codesLine !== null && form.items[codesLine] && (() => {
        const opened = form.items[codesLine];
        // Every line of the same item: one batch in two packings, or two batches, is
        // one popup with a tab per line — codes are unique across all of them.
        const siblings = form.items
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.item_id === opened.item_id);
        return (
          <UnitCodesModal
            isOpen
            onClose={() => setCodesLine(null)}
            readOnly={locked}
            itemName={savedLine(codesLine)?.item_name ?? opened.item_name ?? `Line ${codesLine + 1}`}
            itemCode={savedLine(codesLine)?.item_code ?? opened.item_code}
            uom={savedLine(codesLine)?.uom_code ?? opened.uom_code}
            trackSerial={!!opened.is_serial_tracked}
            trackImei={!!opened.is_imei_tracked}
            focusIndex={codesLine}
            groups={siblings.map(({ line, index }) => ({
              index,
              batchNo: line.batch_no,
              packLabel: packName(line),
              qty: num(line.received_qty),
              serials: line.serial_numbers ?? [],
              imeis: line.imei_numbers ?? [],
            }))}
            onSave={(updates) => setForm((current) => ({
              ...current,
              items: current.items.map((line, index) => {
                const update = updates.find((u) => u.index === index);
                if (!update) return line;
                return {
                  ...line,
                  ...(update.serial_numbers ? { serial_numbers: update.serial_numbers } : {}),
                  ...(update.imei_numbers ? { imei_numbers: update.imei_numbers } : {}),
                };
              }),
            }))}
          />
        );
      })()}

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit this GRN?"
        message={
          `The lines are frozen. ${routing.data?.stage === "FORECAST" ? routing.data.headline : ""}`.trim()
          + " Items that require QI get a QC draft; every other item gets a putaway draft."
        }
        confirmLabel="Submit & split"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => { setTouched(true); act.mutate("submit"); }}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "complete"}
        title="Post accepted quantity to stock?"
        message={`${fmtQty(totals.accepted)} will be added to stock and putaway tasks raised for it. Stock movements cannot be undone — a mistake is corrected with an adjustment, not a delete.`}
        confirmLabel="Post to stock"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => { setTouched(true); act.mutate("complete"); }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}