import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ScanLine, Send } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { DateInput, LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  binOptions, completeReceipt, convertReceiptToGrn, createReceipt, forwardArrival,
  dispatchReceiptSource, gateEntryOptions,
  getReceipt, incomingDispatchOptions, itemOptions, submitReceipt,
  myWarehouseOptions, updateReceipt, uploadAttachment, vendorOptions,
} from "../api";
import { fmtMoney, fmtQty, num, today } from "../format";
import { alerts } from "@/modules/alerts";
import type { ItemOption, Receipt, ReceiptItemWrite, ReceiptWrite } from "../types";
import { useMyPoint, usePointLabel } from "../usePointLabel";

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

const emptyLine = (): ReceiptItemWrite => ({
  item_id: 0,
  uom_code: null,
  is_asset: false,
  is_serial_tracked: false,
  is_imei_tracked: false,
  ordered_qty: 0,
  received_qty: 0,
  accepted_qty: 0,
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

const lifeDateLabel = (line?: Pick<ReceiptItemWrite, "is_asset"> | null) =>
  line?.is_asset ? "Warranty" : "Expiry";

export default function ReceiptForm({ mode }: { mode: "GATE_ENTRY" | "PURCHASE" }) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const isGrn = mode === "PURCHASE";

  const [form, setForm] = useState<ReceiptWrite>({
    receipt_type: mode,
    grn_date: today(),
    po_id: null,
    po_no: "",
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
  const [sourceGateId, setSourceGateId] = useState<number | null>(null);
  // Documents picked before the first save: they have no receipt to hang off yet.
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [serialLine, setSerialLine] = useState<number | null>(null);
  const [imeiLine, setImeiLine] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"submit" | "complete" | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-receipt", id],
    queryFn: () => getReceipt(Number(id)),
    enabled: editing,
  });

  /* Gate entries still waiting to become a GRN. Converting one flips its `receipt_type`,
   * so an entry that was already converted on its own screen is gone from this list —
   * it IS a GRN draft by then. Shares the Lookup's cache key, so this is not a second
   * request; it exists only so the field can say why it is empty rather than looking
   * broken. */
  const { data: pendingGateEntries = [] } = useQuery({
    queryKey: ["wh-lookup", "gate-entries", ""],
    queryFn: () => gateEntryOptions(),
    staleTime: 5 * 60_000,
    enabled: isGrn && !editing,
  });

  /** Loading a saved receipt back into the editable shape. */
  useEffect(() => {
    if (!doc) return;
    setForm({
      receipt_type: doc.receipt_type,
      grn_date: doc.grn_date,
      po_id: doc.po_id ?? null,
      po_no: doc.po_no ?? "",
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
        rate: l.rate,
        batch_no: l.batch_no,
        mfg_date: l.mfg_date,
        expiry_date: l.expiry_date,
        bin_id: l.bin_id || null,
        rejection_reason: l.rejection_reason,
        remarks: l.remarks,
        serial_numbers: l.serial_numbers,
        imei_numbers: l.imei_numbers,
      })),
    });
  }, [doc]);

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
          rate: line.rate,
          batch_no: line.batch_no,
          mfg_date: line.mfg_date,
          expiry_date: line.expiry_date,
          bin_id: line.bin_id || null,
          rejection_reason: null,
          remarks: line.remarks,
          serial_numbers: line.serial_numbers,
          imei_numbers: line.imei_numbers,
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
   * every inventory page read empty with the goods sitting in the room. */
  const { primary_warehouse_id: myPoint } = useMyPoint().data ?? {};
  useEffect(() => {
    if (editing || form.warehouse_id) return;
    const fallback = warehouses.length === 1 ? warehouses[0].id : null;
    const mine = myPoint ?? fallback;
    if (mine) setForm((f) => ({ ...f, warehouse_id: mine }));
  }, [editing, form.warehouse_id, myPoint, warehouses]);

  const set = <K extends keyof ReceiptWrite>(key: K, value: ReceiptWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** Every line edit runs through here so the derived quantities stay derived. */
  const patchLine = (index: number, patch: Partial<ReceiptItemWrite>) =>
    setForm((f) => {
      const items = f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
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

  /** Only "not more serials than units" is checked now.
   *
   *  A GRN used to demand the full set, which stopped a lorry of unlabelled goods
   *  dead — there was no serial to type. The units left without one are given a
   *  serial on submit, from the Serial format in Settings > Code Formats, and a
   *  serial the storekeeper actually read is never replaced. So a partial list is a
   *  legitimate save on both documents. */
  const validateSerialLines = () => {
    for (const [index, line] of form.items.entries()) {
      if (!line.is_serial_tracked) continue;
      const required = Math.floor(num(line.received_qty));
      if (num(line.received_qty) !== required) {
        throw new Error(`Line ${index + 1}: serialized received quantity must be a whole number.`);
      }
      const actual = line.serial_numbers?.length ?? 0;
      if (actual > required) {
        throw new Error(`Line ${index + 1}: ${actual} serial numbers for ${required} received units.`);
      }
    }

    // Same three rules for IMEIs. The backend enforces them too; this only saves the
    // storekeeper a round-trip once the lines are already on screen.
    for (const [index, line] of form.items.entries()) {
      if (!line.is_imei_tracked) continue;
      const required = Math.floor(num(line.received_qty));
      if (num(line.received_qty) !== required) {
        throw new Error(`Line ${index + 1}: IMEI-tracked received quantity must be a whole number.`);
      }
      const actual = line.imei_numbers?.length ?? 0;
      if (isGrn && actual !== required) {
        throw new Error(`Line ${index + 1}: enter exactly ${required} IMEI numbers before saving.`);
      }
      if (!isGrn && actual > required) {
        throw new Error(`Line ${index + 1}: ${actual} IMEI numbers for ${required} received units.`);
      }
    }
  };

  const save = useMutation({
    mutationFn: async () => {
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

  const convert = useMutation({
    mutationFn: () => convertReceiptToGrn(Number(id)),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wh-gate-entries"] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      nav(`/warehouse/grn/${saved.id}`);
    },
  });

  const invalid = {
    warehouse: touched && !form.warehouse_id,
    lines: touched && form.items.length === 0,
  };

  const submitSave = () => {
    setTouched(true);
    if (!form.warehouse_id) return;
    if (form.items.length === 0) return;
    save.mutate();
  };

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
            </div>
          );
        }
        return (
          <Lookup
            name="items"
            load={itemOptions}
            value={l.item_id || ""}
            onChange={(v, option) => {
              const item = option as ItemOption | undefined;
              patchLine(i, {
                item_id: v === "" ? 0 : v,
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
        <QtyInput
          ariaLabel={`Received quantity, line ${i + 1}`}
          value={l.received_qty}
          disabled={locked}
          onChange={(v) => patchLine(i, { received_qty: v, accepted_qty: v })}
        />
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
          invalid={num(l.accepted_qty) > num(l.received_qty)}
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
      key: "bin",
      header: "Bin",
      width: "w-40",
      hideOnNarrow: true,
      render: (l, i) => (
        <Lookup
          name={`bins-${form.warehouse_id}`}
          load={(s) => binOptions(form.warehouse_id, s)}
          value={l.bin_id ?? ""}
          isDisabled={locked || !isGrn || !form.warehouse_id}
          onChange={(v) => patchLine(i, { bin_id: v === "" ? null : v })}
          placeholder="Bin"
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
          disabled={locked}
          onChange={(v) => patchLine(i, { rate: v })}
        />
      ),
    },
    {
      key: "imeis",
      header: "IMEIs",
      width: "w-28",
      hideOnNarrow: true,
      render: (l, i) => {
        if (!l.is_imei_tracked) return <span className="text-xs text-muted">—</span>;
        const captured = l.imei_numbers?.length ?? 0;
        const required = Math.floor(num(l.received_qty));
        return (
          <Button variant="ghost" onClick={() => setImeiLine(i)}>
            <ScanLine className="h-4 w-4" />
            {captured || required ? `${captured}/${required}` : "Add"}
          </Button>
        );
      },
    },
    {
      key: "serials",
      header: "Serials",
      width: "w-28",
      hideOnNarrow: true,
      render: (l, i) => {
        if (!l.is_serial_tracked) return <span className="text-xs text-muted">—</span>;
        const captured = l.serial_numbers?.length ?? 0;
        const required = Math.floor(num(l.received_qty));
        return (
          <Button variant="ghost" onClick={() => setSerialLine(i)}>
            <ScanLine className="h-4 w-4" />
            {captured || required ? `${captured}/${required}` : "Add"}
          </Button>
        );
      },
    },
  ];

  const columns = allColumns.filter((c) =>
    (isGrn || !GRN_ONLY_LINE_COLUMNS.has(c.key)) && (c.key !== "bin" || binManaged));

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const label = isGrn ? "GRN" : "Gate entry";

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={editing ? `${label} ${doc?.grn_no ?? ""}` : `New ${label.toLowerCase()}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(isGrn ? "/warehouse/grn" : "/warehouse/material-inward")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="grn.create">
                <Button variant="soft" onClick={submitSave} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && isGrn && doc?.status === "DRAFT" && (
              <Can do="grn.create">
                <Button onClick={() => setConfirming("submit")}>Submit for QC</Button>
              </Can>
            )}
            {editing && !isGrn && doc?.status === "GATE_ENTRY" && (
              <Can do="grn.create">
                <Button
                  onClick={() => convert.mutate()}
                  disabled={convert.isPending}
                >
                  {convert.isPending ? "Converting…" : "Convert to GRN"}
                </Button>
              </Can>
            )}
            {/* The same two statuses `complete_receipt` accepts, and nothing else. It
              * used to offer SUBMITTED (which the backend rejects) and hide itself
              * once `is_stock_posted` was set — so a GRN whose stock had banked but
              * whose status had not caught up had no button left to finish it. Posting
              * is idempotent, so showing it on an already-posted QC_PASSED row is
              * safe and is exactly the way out of that corner. */}
            {editing && isGrn && ["QC_PASSED", "PARTIALLY_RECEIVED"].includes(doc?.status ?? "") && (
              <Can do="grn.qc">
                <Button onClick={() => setConfirming("complete")}>Post to stock</Button>
              </Can>
            )}
            {/* Only on a consignment that has actually banked its stock here. The MDP
              * is a staging point for these goods, not their destination, so the next
              * hop is offered right where the arrival is confirmed rather than making
              * the storekeeper start a fresh issue and retype every line. */}
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

      <ErrorBanner error={save.error ?? gateEntry.error ?? convert.error ?? forward.error ?? consignment.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.grn_no}</span>} />
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
          <Field label={pointLabel}>
            <Lookup
              name="my-warehouses"
              load={myWarehouseOptions}
              value={form.warehouse_id || ""}
              isDisabled={locked}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  warehouse_id: v === "" ? 0 : v,
                  // The consignment picker lists what is addressed to one point, so a
                  // different point means a different list and a stale choice.
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
          {/* Typed, not picked, on the GRN as well as the gate entry: the number comes
            * off the paperwork the driver hands over. Procurement does not raise orders
            * in this system yet, so a picker would offer a list nobody can fill and the
            * goods arrive regardless. `po_id` stays on the form so a receipt already
            * linked to an order keeps its link through an edit.
            *
            * Hidden at an MDP or LIP: nothing is bought there. Every arrival is a
            * consignment from the point above, so both fields were dead boxes that
            * only invited a storekeeper to invent a purchase order. The values stay
            * on `form` untouched, so an existing receipt keeps whatever it was saved
            * with. */}
          {!isLocalPoint && (
            <>
              <Field label="Purchase order" hint="As printed on the delivery paperwork.">
                <Input
                  value={form.po_no ?? ""}
                  disabled={locked}
                  placeholder="PO number"
                  onChange={(e) => set("po_no", e.target.value)}
                />
              </Field>
              <Field label="Vendor">
                <Lookup
                  name="vendors"
                  load={vendorOptions}
                  value={form.vendor_id ?? ""}
                  isDisabled={locked}
                  onChange={(v) => set("vendor_id", v === "" ? null : v)}
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
          <LinesEditor
            rows={form.items}
            columns={columns}
            keyOf={(_, i) => i}
            minTableWidth={isGrn ? "min-w-[1500px]" : "min-w-[900px]"}
            // No hand-added lines on a consignment receipt: an empty line has no item
            // to pick, and anything not on the challan did not arrive.
            onAdd={locked || fromConsignment
              ? undefined
              : () => set("items", [...form.items, emptyLine()])}
            onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
            rowTone={(l) => (num(l.rejected_qty) > 0 ? "bg-bad-bg/40" : undefined)}
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

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      <Section title="Documents" hint="Invoice copy, LR slip, packing list, weighbridge ticket.">
        <AttachmentsPanel
          entityType="RECEIPT"
          entityId={doc?.id}
          category="INWARD"
          readOnly={locked}
          onStagedChange={setStagedFiles}
        />
      </Section>

      <SerialNumbersModal
        isOpen={serialLine !== null}
        onClose={() => setSerialLine(null)}
        quantity={serialLine === null ? 0 : num(form.items[serialLine]?.received_qty)}
        initial={serialLine === null ? [] : form.items[serialLine]?.serial_numbers ?? []}
        itemLabel={
          serialLine === null
            ? ""
            : savedLine(serialLine)?.item_name
              ?? form.items[serialLine]?.item_name
              ?? `Line ${serialLine + 1}`
        }
        readOnly={locked}
        // Partial on a GRN too: the units nobody could read a serial off are given
        // one on submit, from Settings > Code Formats. Demanding the full set here
        // was the same wall as the old backend rule, one screen earlier.
        partial
        onSave={(serials) => serialLine !== null && patchLine(serialLine, { serial_numbers: serials })}
      />

      <SerialNumbersModal
        noun="IMEI"
        isOpen={imeiLine !== null}
        onClose={() => setImeiLine(null)}
        quantity={imeiLine === null ? 0 : num(form.items[imeiLine]?.received_qty)}
        initial={imeiLine === null ? [] : form.items[imeiLine]?.imei_numbers ?? []}
        itemLabel={
          imeiLine === null
            ? ""
            : savedLine(imeiLine)?.item_name
              ?? form.items[imeiLine]?.item_name
              ?? `Line ${imeiLine + 1}`
        }
        readOnly={locked}
        partial={!isGrn}
        onSave={(imeis) => imeiLine !== null && patchLine(imeiLine, { imei_numbers: imeis })}
      />

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for inspection?"
        message="The lines are frozen and an inspection is raised against this receipt."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
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
        onConfirm={() => act.mutate("complete")}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}