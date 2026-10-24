import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  ConfirmModal,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  StatusPill,
  Textarea,
  useToast,
  TONE_DEEP_MINT,
  TONE_MINT,
  TONE_PINK,
} from "@/shared/components";
import {
  createReturn,
  getReturn,
  warehouseOptions,
  purchaseReturnReasons,
  purchaseReturnSourceDetail,
  purchaseReturnSourceOptions,
  sendPurchaseReturnToVendor,
  updateReturn,
} from "../api";
// TYPE ONLY, and that is the whole of what is left of the wizard here. `WizardLine` is
// the shape the send summary wants and there is no reason to declare a second one; a
// type import is erased at build time, so the component itself is genuinely no longer
// pulled into this screen. See the note on `sendToVendor`.
import type { WizardLine } from "../components/SendToVendorWizard";
import { fmtMoney, fmtQty, today } from "../format";
import type {
  ItemDetail,
  PurchaseReturnItemWrite,
  PurchaseReturnSourceDetail,
  PurchaseReturnWrite,
} from "../types";
import { CombinationTag } from "@/shared/combination";

/**
 * Warehouse → Vendor Purchase Return — the Storekeeper's single screen.
 *
 * Flow per spec:
 *   Select Purchase Invoice / Purchase Order
 *     → Fetch Invoice/PO details → vendor ID off the source
 *     → Fetch vendor from the existing Vendor master (never typed)
 *     → Vendor block auto-populates and stays read-only
 *     → Purchased items auto-fetch with purchased / already-returned /
 *       available quantities and unit prices
 *   Enter Return Quantity per line (0 < qty ≤ available)
 *   Enter Return Date, Reason, Remarks → Save as Draft (DRAFT, nothing sent)
 *   Review → Send to Vendor (confirm) → SENT_TO_VENDOR + sent timestamp
 *
 * No manual vendor entry, no duplicate master, no new logistics module.
 * The shipment behind a send is the existing `out_dispatches` VENDOR_RETURN.
 *
 * ONE SCREEN, TWO FRONT DOORS (2026-09-10). The warehouse raises purchase returns under
 * `/warehouse/purchase-returns`; the returns register raises the same document under
 * `/returns/purchase`. Every route this form pushes stays on the side it was opened
 * from — hardcoding `/warehouse` handed a returns reader over to the warehouse module
 * halfway through raising a document, and the rail, the tabs and the eyebrow all
 * changed under them. Same arrangement `ConsignmentForm` already has under
 * `/logistics`.
 */

const lineKey = (it: ItemDetail) =>
  `${it.item_id}:${it.grn_item_id ?? ""}:${it.po_item_id ?? ""}:${it.batch_id ?? ""}`;

/**
 * One manually typed line. Every figure is a STRING while it is being edited — an
 * empty numeric input is "" and not 0, and storing 0 for it makes "nothing entered
 * yet" indistinguishable from "the answer is zero" on a screen where zero available
 * is a meaningful thing to type.
 */
interface ManualLine {
  key: string;
  item_name: string;
  item_code: string;
  uom_code: string;
  original_qty: string;
  /**
   * No `previously_returned` here. On a sourced line that figure is DERIVED — the sum
   * of earlier returns against the same GRN line — and it is what makes Available
   * trustworthy. A manual line has no earlier returns to count, so asking for it by
   * hand produced a third number the storekeeper had to reconcile with the other two
   * themselves. Available is typed directly and is the only cap that matters.
   * `pro_return_items.previously_returned` still exists and is still filled on the
   * sourced path; manual lines simply leave it null.
   */
  returnable_qty: string;
  rate: string;
  quantity: string;
}

const blankManualLine = (): ManualLine => ({
  key: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  item_name: "", item_code: "", uom_code: "",
  original_qty: "", returnable_qty: "",
  rate: "", quantity: "",
});

/** The typed vendor. Same field names the API takes, so it posts as-is. */
const EMPTY_MANUAL_VENDOR = {
  vendor_name: "", vendor_code: "", vendor_contact_person: "", vendor_phone: "",
  vendor_email: "", vendor_address: "", vendor_city: "", vendor_state: "",
  vendor_pincode: "", vendor_gstin: "",
};

/**
 * A cell that reads as text and edits as a field.
 *
 * The manual item table has to sit beside the auto-fetched one and look like it — the
 * sourced table shows seven plain figures and ONE boxed input (the return quantity),
 * and boxing all eight here turned the same information into a wall of borders. So
 * every cell but the return quantity is drawn with no chrome at all and grows an
 * underline on hover or focus, which is enough to say "you can type here" without
 * shouting it on every row.
 *
 * Plain `<input>` rather than the shared `Input`: that one is HeroUI's, and its
 * wrapper, ring and background are the very chrome being removed.
 */
const GHOST_INPUT =
  "w-full min-w-0 bg-transparent outline-none placeholder:text-muted/60"
  + " border-b border-transparent hover:border-line focus:border-brand"
  + " disabled:cursor-not-allowed disabled:opacity-60";

/** "" -> null, so an untouched box is not posted as 0. */
const numOrNull = (raw: string): number | null => {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

export default function PurchaseReturnForm() {
  const { id } = useParams<{ id: string }>();
  const existingId = id ? Number(id) : null;
  const isEdit = existingId !== null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  // The register on this side is the base of every path below it, so one value answers
  // Back, Cancel, where a saved draft lands and where a sent return opens.
  const inReturns = useLocation().pathname.startsWith("/returns");
  const basePath = inReturns ? "/returns/purchase" : "/warehouse/purchase-returns";

  // --- source picker ---
  const [pickedSource, setPickedSource] = useState<{ type: string; id: number } | null>(null);
  const [sourceSearch, setSourceSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(sourceSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [sourceSearch]);

  // TWO WAYS IN (2026-09-10).
  //
  //   `list`   — pick a real purchase transaction and everything auto-fetches off it.
  //              The original flow, unchanged, and still the default.
  //   `manual` — the goods are real and their paperwork never reached this system, so
  //              the vendor and the lines are TYPED. Posts down a separate service
  //              path (`_create_manual_return`) that skips the vendor lock.
  //
  // There was briefly a third thing here, a box that resolved a typed indent/PO/GRN
  // number against the register, and it was removed at the business owner's request:
  // the two questions a storekeeper actually has are "show me what I can return
  // against" and "this one was never recorded here", and a number lookup sat awkwardly
  // between them. The endpoint behind it (`/warehouse/returns/source-lookup`) is still
  // served, so putting it back is a screen change and not a backend one.
  const [sourceMode, setSourceMode] = useState<"list" | "manual">("list");
  const manualEntry = sourceMode === "manual";
  // Which family the list shows. Client-side: the query already holds all sixty rows,
  // so filtering here costs nothing and keeps the list stable while it is browsed.
  const [listKind, setListKind] = useState<"" | "GRN" | "PO" | "INDENT">("");
  const [manualVendor, setManualVendor] = useState({ ...EMPTY_MANUAL_VENDOR });
  const [manualLines, setManualLines] = useState<ManualLine[]>([blankManualLine()]);
  // WHICH OF OUR POINTS THE GOODS ARE STANDING ON, asked only on a manual return.
  // A sourced return reads it off the purchase it is returning against; a manual one has
  // no purchase, so this was posting null and the document reached the transport band
  // unable to say where the vehicle collects from — `out_dispatches.warehouse_id` is NOT
  // NULL, so the consignment could not be raised at all. The server still resolves it
  // (`_ensure_return_warehouse`) for drafts raised before this and for anyone who leaves
  // it alone; this is for the case the resolver cannot answer — goods standing at a
  // point other than the raiser's own, or a person holding posts at two stores.
  const [manualWarehouseId, setManualWarehouseId] = useState<string>("");

  // --- form state ---
  const [returnDate, setReturnDate] = useState<string>(today());
  const [reason, setReason] = useState<string>("");
  const [remarks, setRemarks] = useState<string>("");
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Send to Vendor is one press behind a confirm. The six-step wizard that used to
  // stand here asked for transport nobody knows yet — see the note on `sendToVendor`.
  const [confirmSend, setConfirmSend] = useState(false);

  // size 100 so the picker holds the WHOLE set the endpoint can offer in one page (it
  // serves at most 20 receipts + 20 POs + 20 indents), the way the field-return form's
  // indent picker loads its list once and lets the box filter it. Before this the
  // dropdown was a second-class control behind the search box beside it: it opened
  // showing only a placeholder, so "what can I return against?" — the first question
  // this screen has to answer — had no answer on screen until something was typed.
  const { data: sourcePage, isLoading: sourcesLoading, error: sourcesError } = useQuery({
    queryKey: ["warehouse", "purchase-return", "source-options", debouncedSearch],
    queryFn: () => purchaseReturnSourceOptions({
      size: 100, search: debouncedSearch || undefined,
    }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Reason is REQUIRED to save or send, so an empty list is a form that can never be
  // completed. Its error is read for the same reason the source list's is: with
  // `retry: false` and an `= []` default, one lost call left a mandatory dropdown
  // silently empty and the disabled buttons as the only symptom.
  const { data: reasons = [], error: reasonsError } = useQuery({
    queryKey: ["warehouse", "purchase-return", "reasons"],
    queryFn: purchaseReturnReasons,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Scoped to the points this login actually holds — the same list every other
  // warehouse picker in the module uses.
  const { data: warehousePoints } = useQuery({
    queryKey: ["warehouse", "options", "warehouses"],
    queryFn: () => warehouseOptions(),
    enabled: manualEntry,
  });

  const { data: existing } = useQuery({
    queryKey: ["warehouse", "purchase-return", existingId],
    queryFn: () => getReturn(existingId as number),
    enabled: existingId !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: detail, isFetching: detailLoading } = useQuery<PurchaseReturnSourceDetail>({
    queryKey: ["warehouse", "purchase-return", "source-detail", pickedSource],
    queryFn: () => purchaseReturnSourceDetail(pickedSource!.type, pickedSource!.id),
    enabled: pickedSource !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Hydrate from an existing draft. Only a DRAFT is editable — anything further
  // along belongs to the detail screen.
  useEffect(() => {
    if (!existing) return;
    setReturnDate(existing.return_date ?? today());
    setReason(existing.reason ?? "");
    setRemarks(existing.remarks ?? "");
    // A manual draft reopens in the mode it was raised in, with everything typed back
    // into the boxes it was typed into.
    if (existing.is_manual) {
      setSourceMode("manual");
      setManualWarehouseId(existing.warehouse_id ? String(existing.warehouse_id) : "");
      setManualVendor({
        vendor_name: existing.vendor_name ?? "",
        vendor_code: existing.vendor_code ?? "",
        vendor_contact_person: existing.vendor_contact_person ?? "",
        vendor_phone: existing.vendor_phone ?? "",
        vendor_email: existing.vendor_email ?? "",
        vendor_address: existing.vendor_address ?? "",
        vendor_city: existing.vendor_city ?? "",
        vendor_state: existing.vendor_state ?? "",
        vendor_pincode: existing.vendor_pincode ?? "",
        vendor_gstin: existing.vendor_gstin ?? "",
      });
      if (existing.items?.length) {
        setManualLines(existing.items.map((l) => ({
          ...blankManualLine(),
          item_name: l.item_name ?? "",
          item_code: l.item_code ?? "",
          uom_code: l.uom_code ?? "",
          original_qty: l.original_qty != null ? String(l.original_qty) : "",
          returnable_qty: l.returnable_qty != null ? String(l.returnable_qty) : "",
          rate: l.rate != null ? String(l.rate) : "",
          quantity: l.quantity != null ? String(l.quantity) : "",
        })));
      }
      return;
    }
    if (!pickedSource) {
      if (existing.grn_id) setPickedSource({ type: "GRN", id: existing.grn_id });
      else if (existing.po_id) setPickedSource({ type: "PO", id: existing.po_id });
    }
    if (existing.items?.length && Object.keys(qtyByLine).length === 0) {
      const next: Record<string, string> = {};
      for (const l of existing.items) {
        next[`${l.item_id}:${l.grn_item_id ?? ""}:${l.po_item_id ?? ""}:${l.batch_id ?? ""}`] =
          String(l.quantity ?? "");
      }
      setQtyByLine(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing]);

  const locked = !!existing && existing.status !== "DRAFT";

  // Each mode owns its own selection. Switching clears it rather than carrying it
  // across: a document chosen from the list, still selected under an empty number box,
  // reads as though the box had found it — and the reverse leaves a list row
  // highlighted that the typed number has since replaced.
  const switchMode = (mode: "list" | "manual") => {
    if (mode === sourceMode) return;
    setSourceMode(mode);
    setPickedSource(null);
    setQtyByLine({});
    setError(null);
    if (mode === "manual") setSourceSearch("");
  };

  const pickSource = (val: string) => {
    setError(null);
    if (!val) {
      setPickedSource(null);
      setQtyByLine({});
      return;
    }
    const [type, sid] = val.split(":");
    setPickedSource({ type, id: Number(sid) });
    setQtyByLine({});
  };

  // --- derived blocks (all auto-fetched, never typed) ---
  const vendor = detail?.vendor;
  const purchase = detail?.purchase;
  const items = useMemo(() => detail?.items ?? [], [detail]);

  const setQty = (key: string, val: string) =>
    setQtyByLine((prev) => ({ ...prev, [key]: val }));

  const lineState = useMemo(() => items.map((it) => {
    const key = lineKey(it);
    const raw = (qtyByLine[key] ?? "").trim();
    const qty = raw === "" ? 0 : Number(raw);
    const available = Number(it.returnable_qty ?? 0);
    const price = Number(it.unit_price ?? 0);
    let problem: string | null = null;
    if (raw !== "") {
      if (!Number.isFinite(qty) || qty <= 0) problem = "Return quantity must be greater than 0";
      else if (qty > available)
        problem = `Cannot exceed available quantity of ${fmtQty(available)}`;
    }
    return { it, key, raw, qty, available, price, problem, amount: qty * price };
  }), [items, qtyByLine]);

  const activeLines = lineState.filter((l) => l.raw !== "" && Number.isFinite(l.qty) && l.qty > 0);

  // --- manual lines, priced the same way the sourced ones are -----------------------
  const setManualLine = (key: string, field: keyof ManualLine, value: string) =>
    setManualLines((prev) => prev.map(
      (l) => (l.key === key ? { ...l, [field]: value } : l)));
  const addManualLine = () =>
    setManualLines((prev) => [...prev, blankManualLine()]);
  const removeManualLine = (key: string) =>
    setManualLines((prev) => (prev.length === 1
      ? [blankManualLine()]                       // never leave the table with no row
      : prev.filter((l) => l.key !== key)));

  const manualState = useMemo(() => manualLines.map((l) => {
    const qty = Number(l.quantity);
    const price = Number(l.rate);
    const available = l.returnable_qty.trim() === "" ? null : Number(l.returnable_qty);
    const named = l.item_name.trim() !== "";
    const hasQty = l.quantity.trim() !== "" && Number.isFinite(qty) && qty > 0;
    let problem: string | null = null;
    if (l.quantity.trim() !== "" && (!Number.isFinite(qty) || qty <= 0)) {
      problem = "Return quantity must be greater than 0";
    } else if (hasQty && !named) {
      problem = "Enter the item name for this line";
    } else if (hasQty && available != null && Number.isFinite(available)
               && available > 0 && qty > available) {
      problem = `Cannot exceed the available quantity of ${fmtQty(available)}`;
    }
    return {
      line: l, named, hasQty, problem,
      // Return amount = return qty x unit price, live as either is typed. The server
      // recomputes it on save — this is the same arithmetic, shown early.
      amount: (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(price) ? price : 0),
    };
  }), [manualLines]);

  const activeManual = manualState.filter((l) => l.hasQty && l.named && !l.problem);
  const manualTotalQty = activeManual.reduce(
    (s, l) => s + Number(l.line.quantity), 0);
  const manualTotalValue = activeManual.reduce((s, l) => s + l.amount, 0);
  const firstManualProblem = manualState.find((l) => l.problem)?.problem ?? null;

  const totalQty = manualEntry ? manualTotalQty : activeLines.reduce((s, l) => s + l.qty, 0);
  const totalValue = manualEntry
    ? manualTotalValue
    : activeLines.reduce((s, l) => s + l.amount, 0);
  const remarksRequired = reason === "OTHER" && !remarks.trim();
  const missing: string[] = [];
  if (manualEntry) {
    if (!manualVendor.vendor_name.trim()) missing.push("the vendor's name");
    if (activeManual.length === 0) missing.push("at least one item with a return quantity");
  } else {
    if (!pickedSource) missing.push("an indent, purchase order or GRN");
    if (activeLines.length === 0) missing.push("at least one return quantity");
  }
  if (!returnDate) missing.push("a return date");
  if (!reason) missing.push("a return reason");
  if (remarksRequired) missing.push("remarks (required for Other)");
  // A source that names no purchase order and no GRN cannot be saved: `create_return`
  // refuses it ("Select a Purchase Invoice/GRN or Purchase Order first") and there is
  // no vendor to send the goods back to either. This is reachable from the LIST, which
  // offers every recent indent including the ones nothing was ever ordered against —
  // and the reader used to find out only after filling the whole form in. Typing a
  // number is already stopped earlier, by `can_return` on the lookup.
  const sourceProblem = !manualEntry && pickedSource && !detailLoading && detail
    && !purchase?.grn_id && !purchase?.po_id
    ? `${pickedSource.type === "INDENT" ? "This indent has" : "This document has"} no purchase order or GRN behind it, so there is no vendor to return the goods to. Pick the GRN or PO the goods actually came in on.`
    : null;
  const firstProblem = manualEntry
    ? firstManualProblem
    : sourceProblem ?? lineState.find((l) => l.problem)?.problem ?? null;
  const canSave = missing.length === 0 && !firstProblem;

  const buildItems = (): PurchaseReturnItemWrite[] =>
    manualEntry
      ? activeManual.map((l) => ({
          is_manual: true,
          item_id: null,
          item_name: l.line.item_name.trim(),
          item_code: l.line.item_code.trim() || null,
          uom_code: l.line.uom_code.trim() || null,
          original_qty: numOrNull(l.line.original_qty),
          // Left null on purpose — see `ManualLine`. The column still exists and the
          // sourced path still fills it.
          previously_returned: null,
          returnable_qty: numOrNull(l.line.returnable_qty),
          quantity: Number(l.line.quantity),
          rate: numOrNull(l.line.rate),
          reason,
        }))
      : activeLines.map((l) => ({
          item_id: l.it.item_id,
          grn_item_id: l.it.grn_item_id ?? null,
          po_item_id: l.it.po_item_id ?? null,
          batch_id: l.it.batch_id ?? null,
          quantity: l.qty,
          rate: Number.isFinite(l.price) && l.price > 0 ? l.price : null,
          reason,
        }));

  const draftPayload = (): PurchaseReturnWrite =>
    manualEntry
      ? {
          return_date: returnDate,
          is_manual: true,
          // `source_ref_no` is deliberately not posted: the box that captured it was
          // removed from this screen. The column and the API field remain, so a
          // reference can be reinstated without a migration.
          ...Object.fromEntries(Object.entries(manualVendor).map(
            ([k, v]) => [k, v.trim() || null])),
          warehouse_id: existing?.warehouse_id ?? null,
          reason: reason || null,
          remarks: remarks.trim() || null,
          items: buildItems(),
        }
      : {
          return_date: returnDate,
          grn_id: purchase?.grn_id ?? (pickedSource?.type === "GRN" ? pickedSource.id : null),
          po_id: purchase?.po_id ?? (pickedSource?.type === "PO" ? pickedSource.id : null),
          vendor_id: vendor?.vendor_id ?? existing?.vendor_id ?? null,
          warehouse_id: detail?.warehouse_id ?? existing?.warehouse_id ?? null,
          reason: reason || null,
          remarks: remarks.trim() || null,
          items: buildItems(),
        };

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["warehouse", "purchase-return"] });

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!canSave) {
        throw new Error(
          firstProblem ?? `Please enter ${missing.join(", ")} before saving.`);
      }
      const payload = draftPayload();
      return isEdit && existingId
        ? updateReturn(existingId, payload)
        : createReturn(payload);
    },
    onSuccess: (saved) => {
      setError(null);
      invalidate();
      toast.success(`Draft ${saved.return_no} saved. Nothing has been sent to the vendor.`);
      navigate(basePath);
    },
    onError: (e: unknown) =>
      setError(errorText(e, "Save failed")),
  });

  /**
   * Send to Vendor — ONE PRESS, straight to the supplier's portal (2026-09-11).
   *
   * This used to open a six-step wizard that asked how the goods travel, who drove,
   * what was hired and who signed, and only then sent. All of that is transport, and
   * none of it is known when a storekeeper is filling in what is going back and why —
   * so it stood between a finished return and the supplier seeing it, on every single
   * send. The return is what the supplier needs; the trip is somebody else's job.
   *
   * So the send posts NO logistics block. `send_to_vendor` treats the block as
   * optional and always has, and the leg is raised for the logistics desk as a DRAFT
   * shipment on their own Dispatch board, where the vehicle, the carrier and the gate
   * pass are decided by the people who decide them. The supplier sees the return
   * immediately either way.
   *
   * `SendToVendorWizard` is deliberately left on disk and unimported, the same way the
   * retired warehouse Dispatch screens are: the API still accepts what it posted, and
   * putting it back is a screen change rather than a rebuild.
   */
  const sendToVendor = useMutation({
    mutationFn: async () => {
      if (!canSave) {
        throw new Error(
          firstProblem ?? `Please enter ${missing.join(", ")} before sending.`);
      }
      // The send acts on a saved draft: persist the latest screen first so the
      // quantities the vendor sees are the quantities just reviewed.
      let docId = existingId;
      if (!docId) {
        const created = await createReturn(draftPayload());
        docId = created.id;
      } else {
        await updateReturn(docId, draftPayload());
      }
      return sendPurchaseReturnToVendor(docId as number, {
        return_reason: reason,
        remarks: remarks.trim() || null,
        items: buildItems(),
        // A manual return binds no source and no master vendor — posting either would
        // ask the server to re-lock a vendor against a purchase that does not exist.
        grn_id: manualEntry
          ? null
          : purchase?.grn_id ?? (pickedSource?.type === "GRN" ? pickedSource.id : null),
        po_id: manualEntry
          ? null
          : purchase?.po_id ?? (pickedSource?.type === "PO" ? pickedSource.id : null),
        vendor_id: manualEntry ? null : vendor?.vendor_id ?? null,
        warehouse_id: manualEntry
          ? (manualWarehouseId ? Number(manualWarehouseId) : null)
          : detail?.warehouse_id ?? null,
      });
    },
    onSuccess: (sent) => {
      setError(null);
      setConfirmSend(false);
      invalidate();
      toast.success(
        `Purchase Return ${sent.return_no} sent — the supplier can see it now.`);
      navigate(`${basePath}/${sent.id}`);
    },
    // The confirm STAYS OPEN on a failure so the server's sentence is read beside the
    // press that caused it, rather than behind a dialog that closed itself.
    onError: (e: unknown) => setError(errorText(e, "Send to Vendor failed")),
  });

  const busy = saveDraft.isPending || sendToVendor.isPending;

  // --- what the send confirm shows --------------------------------------------------
  //
  // The two entry modes produce the same three things — the lines going back, who
  // they go to, and why — off different sources, so they are flattened HERE rather
  // than branched on again where they are read. The confirm restates a send; it has
  // no business knowing a return can be raised two ways.
  const sendLines: WizardLine[] = manualEntry
    ? activeManual.map((l) => ({
        key: l.line.key,
        item_name: l.line.item_name.trim(),
        item_code: l.line.item_code.trim() || null,
        uom_code: l.line.uom_code.trim() || null,
        batch_no: null,
        quantity: Number(l.line.quantity),
        rate: numOrNull(l.line.rate),
        amount: l.amount,
      }))
    : activeLines.map((l) => ({
        key: l.key,
        item_name: l.it.item_name ?? l.it.item_code ?? "",
        item_code: l.it.item_code ?? null,
        uom_code: l.it.uom_code ?? null,
        batch_no: l.it.batch_no ?? null,
        quantity: l.qty,
        rate: l.price || null,
        amount: l.amount,
      }));

  const sendVendor = manualEntry
    ? {
        vendor_name: manualVendor.vendor_name,
        vendor_code: manualVendor.vendor_code,
        gstin: manualVendor.vendor_gstin,
        contact_person: manualVendor.vendor_contact_person,
        phone: manualVendor.vendor_phone,
        email: manualVendor.vendor_email,
        address: [manualVendor.vendor_address, manualVendor.vendor_city,
                  manualVendor.vendor_state, manualVendor.vendor_pincode]
          .map((v) => v.trim()).filter(Boolean).join(", "),
      }
    : {
        vendor_name: vendor?.vendor_name ?? existing?.vendor_name ?? null,
        vendor_code: vendor?.vendor_code ?? existing?.vendor_code ?? null,
        gstin: vendor?.gstin ?? existing?.vendor_gstin ?? null,
        contact_person: vendor?.contact_person ?? existing?.vendor_contact_person ?? null,
        phone: vendor?.phone ?? existing?.vendor_phone ?? null,
        email: vendor?.email ?? existing?.vendor_email ?? null,
        address: [vendor?.address ?? existing?.vendor_address,
                  vendor?.city ?? existing?.vendor_city,
                  vendor?.state ?? existing?.vendor_state,
                  vendor?.pincode].filter(Boolean).join(", "),
      };

  // The label, not the code: the confirm reads "because of damaged goods", and
  // "DEFECTIVE" in the middle of a sentence is a database value on a screen.
  const reasonLabel = reasons.find((r) => r.value === reason)?.label ?? reason;

  // Built with `filter(Boolean).join(" · ")` rather than a template string: a PO with no
  // vendor snapshot and no first line used to render as "PO PO0007 · No vendor · " with
  // a separator hanging off the end.
  const allSourceRows = sourcePage?.items ?? [];
  const sourceOptions = allSourceRows
    // The type filter. Without it the three families are one flat list of sixty rows
    // ordered GRN, PO, INDENT — so every indent sat below forty purchases and reaching
    // one meant scrolling past the whole of the other two.
    .filter((opt) => !listKind || opt.source_type === listKind)
    .map((opt) => ({
      value: `${opt.source_type}:${opt.source_id}`,
      label: [
        `${opt.source_type} ${opt.source_no}`,
        opt.vendor_name ?? "No vendor",
        opt.item_name,
        opt.source_date ? new Date(opt.source_date).toLocaleDateString() : null,
      ].filter(Boolean).join(" · "),
    }));
  const countOf = (kind: string) =>
    allSourceRows.filter((o) => o.source_type === kind).length;
  const KIND_TABS: { key: "" | "GRN" | "PO" | "INDENT"; label: string }[] = [
    { key: "", label: "All" },
    { key: "GRN", label: "GRN" },
    { key: "PO", label: "PO" },
    { key: "INDENT", label: "Indent" },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="RETURNS"
        title={isEdit
          ? `Edit Purchase Return${existing?.return_no ? ` ${existing.return_no}` : " Draft"}`
          : "New Purchase Return"}
        back={{ to: basePath, label: "Back to Purchase returns" }}
      />

      {error && <ErrorBanner error={error} />}

      {locked && (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This return is <StatusPill status={existing?.status ?? ""} /> and can no longer be
          edited.{" "}
          <Button variant="soft" onClick={() => navigate(`${basePath}/${existingId}`)}>
            Open review
          </Button>
        </Card>
      )}

      {/* REMOVED 2026-09-10: the read-only header block (Return No / Status /
          Warehouse / Created by). On a NEW return every one of its four values was a
          placeholder describing what would happen later — "Auto generated on save",
          "DRAFT on save", "Auto from source", "Logged-in storekeeper" — which is a row
          of chrome that tells the storekeeper nothing they did not already know.
          On an EDIT the only value of the four that was not already elsewhere on the
          screen was the return number, so that moved into the page title instead. */}

      {/* Source Transaction */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">
          Indent / Purchase Order / GRN
        </h3>
        <p className="mb-3 text-xs text-muted">
          Name the purchase the goods came in on — pick it from the list, or type its
          number if you already know it. Vendor, items and available quantities are
          auto-fetched from existing records either way.
        </p>

        {/* Browsing and knowing are two different questions; the screen asks which. */}
        <div className="mb-3 inline-flex rounded-lg border border-line bg-content2 p-1">
          {([["list", "Pick from list"], ["manual", "Enter manually"]] as const).map(
            ([mode, label]) => (
              <button
                key={mode}
                type="button"
                disabled={locked}
                aria-pressed={sourceMode === mode}
                onClick={() => switchMode(mode)}
                className={`min-h-9 rounded-md px-3 text-sm font-semibold transition ${
                  sourceMode === mode
                    ? "bg-content1 text-ink shadow-sm"
                    : "text-muted hover:text-body"}`}
              >
                {label}
              </button>
            ))}
        </div>
        {/* The picker FIRST and across the full width, the search box under it as the
            narrower it actually is. The two used to sit side by side as equals, which
            read as "type here, then choose there" — so the screen opened with an empty
            dropdown and the reader had to guess what to search for before it would show
            anything. The list is loaded up front now, exactly as the field return's
            indent picker is, and the box below only matters once somebody is reaching
            past what the list holds. */}
        <div className={`grid grid-cols-1 gap-4 ${sourceMode === "list" ? "" : "hidden"}`}>
          {/* Which family. Counts on the tabs so "there are no indents" and "the
              indents are further down" stop looking like the same thing. */}
          <div className="flex flex-wrap gap-1">
            {KIND_TABS.map(({ key, label }) => {
              const n = key ? countOf(key) : allSourceRows.length;
              return (
                <button
                  key={key || "all"}
                  type="button"
                  disabled={locked}
                  aria-pressed={listKind === key}
                  onClick={() => setListKind(key)}
                  className={`min-h-8 rounded-full border px-3 text-xs font-semibold transition ${
                    listKind === key
                      ? "border-brand bg-brand-050 text-brand"
                      : "border-line bg-content1 text-muted hover:text-body"}`}
                >
                  {label}
                  <span className="ml-1.5 tabular opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
          <Field
            label="Select Indent / PO / GRN"
            required
            hint={
              sourcesLoading
                ? "Loading the purchases you can return against…"
                : sourceOptions.length > 0
                  ? `${sourceOptions.length} ${listKind ? `${listKind.toLowerCase()} ` : ""}document${sourceOptions.length === 1 ? "" : "s"} you can return against.`
                  : undefined
            }
          >
            <Select
              value={pickedSource ? `${pickedSource.type}:${pickedSource.id}` : ""}
              onChange={pickSource}
              options={sourceOptions}
              placeholder={
                sourcesLoading
                  ? "Loading purchases…"
                  : sourceOptions.length === 0
                    ? "No purchases to return against"
                    : "Pick a purchase transaction"
              }
              ariaLabel="Source transaction"
              isDisabled={locked || sourceOptions.length === 0}
            />
          </Field>
          {/* Said out loud, in both directions. An empty picker used to be
              indistinguishable from a picker that had not been asked a question yet, and
              a FAILED request looked exactly the same as "there is nothing here" —
              `retry: false` meant one lost call left the reader staring at a dropdown
              with nothing in it and no sentence anywhere on the screen. */}
          {sourcesError ? (
            <p className="text-xs text-red-600">
              The list of purchases could not be loaded. Reload the page — nothing here
              can be typed in by hand, so a return cannot be raised until it comes back.
            </p>
          ) : !sourcesLoading && sourceOptions.length === 0 ? (
            <p className="text-xs text-muted">
              {debouncedSearch
                ? `Nothing matches “${debouncedSearch}”. Clear the search to see the most recent purchases.`
                : "No goods receipt, purchase order or indent is available to return against on your warehouses."}
            </p>
          ) : null}
          <Field
            label="Search purchase transactions"
            hint="Only if what you want is not in the list above — the list holds the most recent documents, and this reaches further back. Indent / GRN / invoice / PO / vendor. If you know the exact number, “Type the number” above is quicker."
          >
            <Input
              value={sourceSearch}
              onChange={(e) => setSourceSearch(e.target.value)}
              placeholder="Type an indent, GRN, invoice, PO or vendor…"
              aria-label="Search purchase transactions"
              disabled={locked}
            />
          </Field>
        </div>

        {/* MANUAL. No fields of its own — the whole of a manual return is the vendor
            block and the item lines below, so this only says where to go next rather
            than adding a third place to look. */}
        {manualEntry && (
          <p className="rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">
            Nothing is auto-fetched in this mode. Type the vendor and the item lines
            below — the return will be raised without a purchase transaction behind it.
          </p>
        )}

        {!manualEntry
          && (purchase?.po_no || purchase?.grn_no || purchase?.invoice_no || purchase?.indent_no) && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><div className="text-xs text-muted">Purchase Order</div><div className="text-ink">{purchase?.po_no ?? "—"}</div></div>
            <div><div className="text-xs text-muted">GRN</div><div className="text-ink">{purchase?.grn_no ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Vendor Invoice</div><div className="text-ink">{purchase?.invoice_no ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Indent</div><div className="text-ink">{purchase?.indent_no ?? "—"}</div></div>
          </div>
        )}
        {/* Said here, beside the thing that is wrong, and not only in the small print
            under the buttons at the bottom of a long form. */}
        {sourceProblem && (
          <p className="mt-3 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
            {sourceProblem}
          </p>
        )}
      </Card>

      {/* Auto-fetched Vendor Details — read-only */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">
          {manualEntry ? "Vendor Details — entered manually" : "Vendor Details — auto-fetched, read-only"}
        </h3>
        {manualEntry ? (
          <>
            <p className="mb-3 text-xs text-muted">
              Type the vendor exactly as the paperwork names them. Nothing here is
              looked up, and this return is not tied to a vendor master record.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Leaving from which warehouse"
                     hint="The point the goods are standing on. Left blank, the return
                           takes the stocking point you work.">
                <Select
                  value={manualWarehouseId}
                  onChange={setManualWarehouseId}
                  options={(warehousePoints ?? []).map((w) => ({
                    value: String(w.id),
                    label: w.code ? `${w.code} — ${w.name}` : w.name,
                  }))}
                  placeholder="Pick the warehouse the goods are standing in"
                  ariaLabel="Leaving from which warehouse"
                  isDisabled={locked}
                />
              </Field>
              <Field label="Vendor Name" required>
                <Input
                  value={manualVendor.vendor_name}
                  onChange={(e) => setManualVendor((v) => ({ ...v, vendor_name: e.target.value }))}
                  placeholder="Who the goods go back to"
                  aria-label="Vendor name"
                  isInvalid={!manualVendor.vendor_name.trim()}
                  disabled={locked}
                />
              </Field>
              <Field label="Vendor Code">
                <Input value={manualVendor.vendor_code}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_code: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor code" disabled={locked} />
              </Field>
              <Field label="GSTIN">
                <Input value={manualVendor.vendor_gstin}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_gstin: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor GSTIN" disabled={locked} />
              </Field>
              <Field label="Contact Person">
                <Input value={manualVendor.vendor_contact_person}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_contact_person: e.target.value }))}
                       placeholder="Optional" aria-label="Contact person" disabled={locked} />
              </Field>
              <Field label="Phone">
                <Input value={manualVendor.vendor_phone}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_phone: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor phone" disabled={locked} />
              </Field>
              <Field label="Email">
                <Input value={manualVendor.vendor_email}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_email: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor email" disabled={locked} />
              </Field>
              <div className="md:col-span-3">
                <Field label="Address">
                  <Input value={manualVendor.vendor_address}
                         onChange={(e) => setManualVendor((v) => ({ ...v, vendor_address: e.target.value }))}
                         placeholder="Optional" aria-label="Vendor address" disabled={locked} />
                </Field>
              </div>
              <Field label="City">
                <Input value={manualVendor.vendor_city}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_city: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor city" disabled={locked} />
              </Field>
              <Field label="State">
                <Input value={manualVendor.vendor_state}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_state: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor state" disabled={locked} />
              </Field>
              <Field label="Pincode">
                <Input value={manualVendor.vendor_pincode}
                       onChange={(e) => setManualVendor((v) => ({ ...v, vendor_pincode: e.target.value }))}
                       placeholder="Optional" aria-label="Vendor pincode" disabled={locked} />
              </Field>
            </div>
          </>
        ) : !vendor && !existing?.vendor_name ? (
          <p className="text-sm text-muted">Pick or type an indent / PO / GRN above to auto-fetch the vendor.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <div><div className="text-xs text-muted">Vendor ID</div><div className="text-ink">{vendor?.vendor_id ?? existing?.vendor_id ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Vendor Code</div><div className="text-ink">{vendor?.vendor_code ?? existing?.vendor_code ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Vendor Name</div><div className="font-medium text-ink">{vendor?.vendor_name ?? existing?.vendor_name ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Contact Person</div><div className="text-ink">{vendor?.contact_person ?? existing?.vendor_contact_person ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Phone</div><div className="text-ink">{vendor?.phone ?? existing?.vendor_phone ?? "—"}</div></div>
            <div><div className="text-xs text-muted">Email</div><div className="break-all text-ink">{vendor?.email ?? existing?.vendor_email ?? "—"}</div></div>
            <div className="md:col-span-2"><div className="text-xs text-muted">Address</div><div className="text-ink">{[vendor?.address ?? existing?.vendor_address, vendor?.city ?? existing?.vendor_city, vendor?.state ?? existing?.vendor_state, vendor?.pincode].filter(Boolean).join(", ") || "—"}</div></div>
            <div><div className="text-xs text-muted">GSTIN</div><div className="text-ink">{vendor?.gstin ?? existing?.vendor_gstin ?? "—"}</div></div>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          {manualEntry
            ? "These details are stored on this return only — no vendor master record is created or changed."
            : "The vendor comes from the selected Invoice / PO and cannot be changed."}
        </p>
      </Card>

      {/* Auto-fetched Items */}
      <Card className="mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink">
          {manualEntry ? "Items — entered manually" : "Items — auto-fetched"}
        </h3>
        {manualEntry ? (
          /* THE SAME TABLE AS THE AUTO-FETCHED ONE BELOW, TYPED INSTEAD OF READ.
             Asked for in exactly those terms. Same columns in the same order, the same
             item cell (name on top, code · UOM · batch muted underneath), the same
             right-aligned figures and the same footer — so a storekeeper who has used
             one has already used the other.
             The only control that keeps a box is Return qty, because that is the only
             box on the sourced table; every other figure is a GHOST input that reads
             as text and shows its edge on hover or focus. Boxing all eight turned a
             neat row of numbers into a wall of borders. */
          <>
            <div className="overflow-x-auto">
              <table className="min-w-[1000px] w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase text-muted">
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3 text-right">Purchased</th>
                    {/* No "Already returned" here, unlike the sourced table below.
                        There it is DERIVED — the sum of earlier returns against the
                        same GRN line — and it is what makes Available trustworthy. A
                        manual line has no earlier returns to count, so the column was
                        a third figure asking to be reconciled with the other two by
                        hand. Available is typed directly instead. */}
                    <th className="py-2 pr-3 text-right">Available</th>
                    <th className="py-2 pr-3 text-right">Unit price</th>
                    <th className="py-2 pr-3 text-right">Return qty</th>
                    <th className="py-2 pr-3 text-right">Amount</th>
                    <th className="py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {manualState.map(({ line, problem, amount }) => (
                    <tr key={line.key} className="group border-b border-line/60 last:border-0">
                      {/* Name, code and UOM on ONE line. They were stacked — name over
                          a muted meta row, mirroring the sourced table — but the code
                          then sat under the name with the whole width of the column
                          empty beside it, so it reads better across. Name takes the
                          slack; code and UOM stay muted and fixed so the three never
                          fight for the same space. */}
                      <td className="py-2 pr-3 min-w-[400px]">
                        <div className="flex items-baseline gap-2">
                          <input
                            value={line.item_name}
                            onChange={(e) => setManualLine(line.key, "item_name", e.target.value)}
                            placeholder="Item name"
                            aria-label="Item name"
                            disabled={locked}
                            className={GHOST_INPUT + " min-w-[140px] flex-1 font-medium text-ink"}
                          />
                          <input
                            value={line.item_code}
                            onChange={(e) => setManualLine(line.key, "item_code", e.target.value)}
                            placeholder="item code"
                            aria-label="Item code"
                            disabled={locked}
                            className={GHOST_INPUT + " w-[170px] shrink-0 text-xs text-muted"}
                          />
                          <span aria-hidden className="text-xs text-muted">·</span>
                          <input
                            value={line.uom_code}
                            onChange={(e) => setManualLine(line.key, "uom_code", e.target.value)}
                            placeholder="uom"
                            aria-label="Unit of measure"
                            disabled={locked}
                            className={GHOST_INPUT + " w-[56px] shrink-0 text-xs text-muted"}
                          />
                        </div>
                        {problem && <p className="mt-1 text-xs text-bad">{problem}</p>}
                      </td>

                      {([
                        ["original_qty", "Purchased quantity"],
                        ["returnable_qty", "Available quantity"],
                        ["rate", "Unit price"],
                      ] as const).map(([field, label]) => (
                        <td key={field} className="py-2 pr-3 w-[108px]">
                          <input
                            type="number"
                            min="0"
                            value={line[field]}
                            onChange={(e) => setManualLine(line.key, field, e.target.value)}
                            placeholder="—"
                            aria-label={`${label} for ${line.item_name || "this line"}`}
                            disabled={locked}
                            className={GHOST_INPUT + " text-right tabular text-ink"}
                          />
                        </td>
                      ))}

                      {/* The one boxed field, exactly as on the sourced table. */}
                      <td className="py-2 pr-3 w-[130px]">
                        <Input
                          type="number"
                          min="0"
                          value={line.quantity}
                          onChange={(e) => setManualLine(line.key, "quantity", e.target.value)}
                          placeholder="0"
                          aria-label={`Return quantity for ${line.item_name || "this line"}`}
                          isInvalid={!!problem}
                          disabled={locked}
                        />
                      </td>

                      <td className="py-2 pr-3 text-right tabular">
                        {amount ? fmtMoney(amount) : "—"}
                      </td>
                      {/* Out of the way until the row is under the cursor — a Remove
                          on every row competed with the figures beside it. */}
                      <td className="py-2 text-right align-middle">
                        <button
                          type="button"
                          onClick={() => removeManualLine(line.key)}
                          disabled={locked}
                          aria-label={`Remove ${line.item_name || "this line"}`}
                          title="Remove this line"
                          className="rounded-md px-1.5 py-0.5 text-base leading-none text-muted
                                     opacity-0 transition hover:bg-bad-bg hover:text-bad
                                     focus:opacity-100 group-hover:opacity-100"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* The sourced table's footer, plus the one control this table needs. */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={addManualLine}
                  disabled={locked}
                  className="rounded-lg border border-dashed border-line px-3 py-1.5
                             text-xs font-semibold text-muted transition
                             hover:border-brand hover:text-brand"
                >
                  + Add item
                </button>
                <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                  <span className="text-muted">
                    {activeManual.length} of {manualLines.length} lines
                  </span>
                  <span className="text-ink">Return qty <b className="tabular">{fmtQty(manualTotalQty)}</b></span>
                  <span className="text-ink">Total <b className="tabular">₹ {fmtMoney(manualTotalValue)}</b></span>
                </div>
              </div>
            </div>
          </>
        ) : !pickedSource ? (
          <p className="text-sm text-muted">Pick or type an indent / PO / GRN to see the purchased items.</p>
        ) : detailLoading ? (
          <p className="text-sm text-muted">Fetching items…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">No returnable lines on this transaction.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-muted">
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 pr-3 text-right">Purchased</th>
                  <th className="py-2 pr-3 text-right">Already returned</th>
                  <th className="py-2 pr-3 text-right">Available</th>
                  <th className="py-2 pr-3 text-right">Unit price</th>
                  <th className="py-2 pr-3 text-right">Return qty</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineState.map((l) => (
                  <tr key={l.key} className="border-b border-line/60 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-ink">{l.it.item_name ?? l.it.item_code}</div>
                      <CombinationTag value={l.it} className="mt-1" />
                      <div className="text-xs text-muted">
                        {[l.it.item_code, l.it.uom_code, l.it.batch_no ? `Batch ${l.it.batch_no}` : null].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular">{fmtQty(l.it.original_qty)}</td>
                    <td className="py-2 pr-3 text-right tabular">{fmtQty(l.it.previously_returned)}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular">{fmtQty(l.available)}</td>
                    <td className="py-2 pr-3 text-right tabular">{l.price ? fmtMoney(l.price) : "—"}</td>
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        min="0"
                        value={l.raw}
                        onChange={(e) => setQty(l.key, e.target.value)}
                        placeholder="0"
                        aria-label={`Return quantity for ${l.it.item_name ?? l.it.item_code}`}
                        isInvalid={!!l.problem}
                        disabled={locked || l.available <= 0}
                      />
                      {l.problem && <p className="mt-1 text-xs text-red-600">{l.problem}</p>}
                    </td>
                    <td className="py-2 text-right tabular">{l.amount ? fmtMoney(l.amount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{activeLines.length} of {items.length} lines</span>
              <span className="text-ink">Return qty <b className="tabular">{fmtQty(totalQty)}</b></span>
              <span className="text-ink">Total <b className="tabular">₹ {fmtMoney(totalValue)}</b></span>
            </div>
          </div>
        )}
      </Card>

      {/* Return details */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Return Date" required>
            <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)}
                   aria-label="Return date" disabled={locked} />
          </Field>
          <Field label="Return Reason" required>
            <Select
              value={reason}
              onChange={setReason}
              options={reasons.map((r) => ({ value: r.value, label: r.label }))}
              placeholder={reasonsError ? "Reasons could not be loaded" : "Select reason"}
              ariaLabel="Return reason"
              isDisabled={locked}
            />
            {reasonsError && (
              <p className="mt-1 text-xs text-red-600">
                The return reasons could not be loaded, and one is required. Reload the
                page — the list is served, so it cannot be typed in here.
              </p>
            )}
          </Field>
          <div className="md:col-span-2">
            <Field label={reason === "OTHER" ? "Remarks / Notes (required for Other)" : "Remarks / Notes"}
                   required={reason === "OTHER"}>
              <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
                        placeholder="Enter remarks" aria-label="Remarks"
                        isInvalid={remarksRequired} disabled={locked} />
            </Field>
          </div>
        </div>
      </Card>

      {/* Actions */}
      {!locked && (
        <div className="flex flex-wrap gap-3">
          <Button variant="soft" className={TONE_PINK} onClick={() => navigate(basePath)}>
            Cancel
          </Button>
          <Button variant="soft" className={TONE_MINT} disabled={!canSave || busy}
                  onClick={() => saveDraft.mutate()}>
            {saveDraft.isPending ? "Saving…" : isEdit ? "Save Changes" : "Save as Draft"}
          </Button>
          <Button className={TONE_DEEP_MINT} disabled={!canSave || busy}
                  onClick={() => { setError(null); setConfirmSend(true); }}>
            {sendToVendor.isPending ? "Sending…" : "Send to Vendor"}
          </Button>
        </div>
      )}
      {!locked && !canSave && (
        <p className="mt-2 text-xs text-muted">
          To {sendToVendor.isPending ? "send" : "save"}: enter {missing.join(", ")}
          {firstProblem ? ` — ${firstProblem}` : ""}.
        </p>
      )}

      {/* One press, and the supplier has it. The only thing standing in the way is the
          fact that a send cannot be taken back — so it is a confirm, not a wizard. */}
      <ConfirmModal
        isOpen={confirmSend}
        title="Send this return to the vendor?"
        confirmLabel="Send to Vendor"
        tone="warning"
        busy={sendToVendor.isPending}
        error={sendToVendor.error}
        onConfirm={() => sendToVendor.mutate()}
        onClose={() => { if (!sendToVendor.isPending) setConfirmSend(false); }}
      >
        <p className="text-sm text-body">
          Returning <b>{fmtQty(totalQty)}</b> across <b>{sendLines.length}</b>{" "}
          line{sendLines.length === 1 ? "" : "s"}
          {totalValue > 0 && <> worth <b>₹ {fmtMoney(totalValue)}</b></>} to{" "}
          <b>{sendVendor.vendor_name?.trim() || "the vendor"}</b>
          {reasonLabel ? <>, because of <b>{reasonLabel.toLowerCase()}</b></> : null}.
          This cannot be undone.
        </p>
        <p className="mt-2 text-xs text-muted">
          {manualEntry
            ? "This return was entered by hand, so no consignment and no shipment are raised — those goods were never on this system's books. The return itself is recorded as sent."
            : "The supplier sees it straight away. A draft shipment is raised on the Logistics Dispatch board at the same time, and that desk arranges the vehicle, the gate pass and the carrier."}
        </p>
      </ConfirmModal>
    </div>
  );
}

function errorText(e: unknown, fallback: string): string {
  const resp = (e as { response?: { data?: { error?: unknown } }; message?: unknown }) ?? {};
  const server = resp.response?.data?.error;
  if (typeof server === "string" && server) return server;
  if (typeof resp.message === "string" && resp.message) return resp.message;
  return fallback;
}
