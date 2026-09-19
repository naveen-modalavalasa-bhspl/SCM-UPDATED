import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check, Image as ImageIcon, IndianRupee, Paperclip, RefreshCw, Truck, X,
} from "lucide-react";
import {
  Button, Card, ConfirmModal, ErrorBanner, errorMessage, Field, Input, PageHeader,
  ResponsiveList, StatusPill, Textarea, useToast, type Column,
} from "@/shared/components";
import { fmtDate, fmtDateTime, todayIst } from "@/shared/datetime";
import { supplierApi } from "@/modules/procurement/api";
import type {
  ReplacementDocumentRow, ReplacementDocumentType,
  VendorReturnDetail, VendorReturnItemRow,
} from "@/modules/procurement/types";
import { vendorReturnPillLabel } from "../status";

const money = (value: number | null | undefined) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value ?? 0);

/**
 * ONE QUESTION AT A TIME, and the supplier owns most of them now.
 *
 * Until 2026-09-12 this screen asked a single compound question — keep them or refuse
 * them, and if you keep them what do we get — on goods that had ALREADY been shipped to
 * the supplier. Everything else about the return was decided by the buyer's desk from a
 * phone call: whether the return was agreed at all, whose vehicle moved it, when the
 * replacement went out.
 *
 * The business works it the other way round, and so does this screen now. The buyer sends
 * the PAPERWORK; the supplier checks it against the GRN, the PO and the QC that condemned
 * the goods, and answers. Only then does anything travel.
 *
 *   1. Approve / Reject                          ← nothing has shipped; a refusal is cheap
 *   2. Refund or replacement                     ← only if approved
 *   3. Accept the collection, name the vehicle   ← only where the buyer asked US to fetch
 *   4. Record the pickup                         ← the vehicle has loaded and gone
 *   5. Dispatch the replacement                  ← with the batch and expiry of what we sent
 *
 * THERE WAS A SIXTH RUNG BETWEEN 4 AND 5 — "Sign for the goods", a separate press at the
 * supplier's own dock — and it came off the screen on 2026-09-16. A supplier standing over
 * a packed replacement carton has self-evidently received the faulty one, so the signature
 * was a gate they had to find before the screen would let them do the only thing left to
 * do. The dispatch note carries it instead: the server stamps the receipt as that press
 * goes through, so the buyer's tracker still shows the goods reaching the supplier before
 * the replacement leaves them. Nothing was lost from the trail, only a press.
 *
 * WHICH RUNG IS OPEN COMES FROM THE STATUS, which the server owns. This screen never
 * decides what is legal: it draws the press for the rung the document is standing on, and
 * the server refuses anything else. Both halves reading one ladder is what stops them
 * drifting.
 *
 * ANSWERED IS NOT DISABLED. Once a rung is answered its press comes OFF the screen rather
 * than greying out. A greyed Approve beside "Your answer is recorded" reads as the answer
 * having failed to save — suppliers pressed it again and reported the screen as broken.
 */

/** Which press the document is standing on. Keyed on the served status, never inferred
 *  from which fields happen to be filled in. */
type Rung =
  | "decide" | "settle" | "accept-transport" | "pickup" | "dispatch" | null;

function rungOf(ret: VendorReturnDetail): Rung {
  switch (ret.status) {
    case "SENT_TO_VENDOR":
      return ret.vendor_decision ? null : "decide";
    case "VENDOR_APPROVED":
      return ret.vendor_response ? null : "settle";
    case "AWAITING_VENDOR_VEHICLE":
      return "accept-transport";
    case "VENDOR_TRANSPORT_ACCEPTED":
      return "pickup";
    // ONCE THE GOODS ARE TRAVELLING, the only press left is the replacement — the dock
    // signature that used to stand between these rungs and the next is part of it now.
    // The first two are the two transport branches: our own vehicle arriving home with
    // the goods, or the buyer's logistics leg delivering them to us. VENDOR_RECEIVED is
    // here for the returns signed under the old flow, which are sitting on it and would
    // otherwise be left with nothing to press.
    case "STOCK_PICKED_UP":
    case "VEHICLE_REQUESTED":
    case "VENDOR_RECEIVED":
      return "dispatch";
    default:
      return null;
  }
}

/** The heading and the sentence under it, per rung. Held in one place so the card cannot
 *  say one thing while the modal asks another. */
const ASKS: Record<Exclude<Rung, null>, {
  title: string; hint: string; label: string; icon: typeof Check;
}> = {
  decide: {
    title: "Do you accept this return?",
    hint: "Check it against the GRN, the purchase order and the QC inspection below. "
      + "Nothing has been shipped yet — if this is wrong, reject it and say why. "
      + "Accepting it also asks whether you are refunding the value or replacing the "
      + "goods.",
    label: "Approve", icon: Check,
  },
  settle: {
    title: "What are you giving back?",
    hint: "You have approved the return. Refund its value, or send replacement goods.",
    label: "Choose", icon: IndianRupee,
  },
  "accept-transport": {
    title: "Send a vehicle to collect",
    hint: "The buyer has asked you to collect the goods from their warehouse. "
      + "Accept the job and name the vehicle if you already know it.",
    label: "Accept collection", icon: Truck,
  },
  pickup: {
    title: "Has your vehicle collected?",
    hint: "Record this once the vehicle has loaded and left the buyer's warehouse.",
    label: "Record pickup", icon: Truck,
  },
  dispatch: {
    title: "Dispatch the replacement",
    hint: "Tell the buyer what is on the vehicle. The batch and expiry must be those of "
      + "the goods you are sending — not the faulty batch that came back to you. Sending "
      + "it also confirms the returned goods reached you.",
    label: "Dispatch replacement", icon: RefreshCw,
  },
};

/** A label/value pair in the fact grids. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-ink">{children ?? "—"}</dd>
    </div>
  );
}

/** A file size a person reads, not a byte count. */
function fileSize(bytes: number | null | undefined): string | null {
  if (!bytes || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ONE OF THE REPLACEMENT'S FILE SLOTS — empty, or filled with what was attached.
 *
 * REQUIRED IS SERVED, NOT DECIDED HERE. The asterisk and the press that
 * `blockedBecause` disables both read `type.required`, which is the same flag the
 * server's dispatch guard reads — so the invoice becoming optional was one edit in
 * `enums.REPLACEMENT_DOCUMENT_META` and nothing in this file.
 *
 * A LABEL WRAPPING A REAL `<input type="file">`, never a button that clicks a hidden
 * one. `capture` — currently off for both slots, see the meta — only opens the camera
 * on a genuine user gesture against the input itself; driving it from `ref.click()` is
 * treated as synthetic by several mobile browsers and silently falls back to the file
 * picker. Keeping the real input means turning `capture` back on is a server-side edit.
 *
 * `capture` is SPREAD rather than passed as `capture={type.capture}`: to the HTML
 * parser the attribute being present at all is the instruction, so `capture={false}`
 * still asks a phone for the camera and hides the gallery behind it.
 *
 * The input's value is cleared after every pick so choosing the SAME file again still
 * fires `change` — the case where somebody attached the wrong photo, went back to the
 * camera roll and picked the right one with the same name.
 */
function DocumentSlot({ type, onFile, busy, disabled, onPick, onClear }: {
  type: ReplacementDocumentType;
  onFile: ReplacementDocumentRow | null;
  busy: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
  onClear: (attachmentId: number) => void;
}) {
  // Off what the slot ACCEPTS, not off `capture`. The image slot stopped forcing the
  // camera when it became "Upload image" (a forced camera hides the gallery, so a photo
  // taken earlier could not be attached) — and keying the icon on `capture` meant both
  // slots silently turned into the same paperclip the moment it did.
  const imagesOnly = type.accept.trim() === "image/*";
  const Icon = imagesOnly ? ImageIcon : Paperclip;
  const size = fileSize(onFile?.file_size);

  return (
    <div className={`rounded-lg border p-3 transition-colors ${
      onFile ? "border-success/40 bg-success/5" : "border-dashed border-line"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Icon className="h-4 w-4 shrink-0 text-muted" />
            {type.label}
            {type.required && <span className="text-danger">*</span>}
          </p>
          {onFile ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-success">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{onFile.file_name}</span>
              {size && <span className="shrink-0 text-muted">· {size}</span>}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted">{type.hint}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* 44px tap target (rule 12), which a bare `<input type="file">` is not. */}
          <label className={`inline-flex min-h-[44px] cursor-pointer items-center rounded-lg
                             border border-line px-3 text-sm font-medium text-ink
                             transition-colors hover:bg-surface-2
                             ${disabled ? "pointer-events-none opacity-50" : ""}`}>
            {/* "Attach" on every slot. The image slot said "Capture", which was only
                ever true on a phone — `capture` is ignored on a desktop browser, so the
                word promised a camera to everybody working the portal at a desk and
                opened a file browser instead. */}
            {busy ? "Uploading…" : onFile ? "Replace" : "Attach"}
            <input
              type="file"
              className="sr-only"
              accept={type.accept}
              disabled={disabled}
              {...(type.capture ? { capture: "environment" as const } : {})}
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) onPick(picked);
              }}
            />
          </label>
          {onFile && (
            <Button variant="ghost" disabled={disabled} className="px-3"
                    aria-label={`Remove ${onFile.file_name}`}
                    onClick={() => onClear(onFile.id)}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A NAMED export, and it must stay one: `App.tsx` lazy-imports this route as
 *  `.then((m) => ({ default: m.SupplierReturnDetailPage }))`, so a default-only export
 *  compiles and then renders an empty route at runtime. */
export function SupplierReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const qc = useQueryClient();
  const toast = useToast();

  const [asking, setAsking] = useState<Rung>(null);
  const [note, setNote] = useState("");
  const [settlement, setSettlement] = useState<"REFUNDED" | "REPLACED">("REFUNDED");
  const [refundAmount, setRefundAmount] = useState("");
  const [vehicle, setVehicle] = useState({
    vehicle_no: "", driver_name: "", driver_phone: "",
    transporter_name: "", lr_no: "", expected_date: "",
  });
  const [dispatch, setDispatch] = useState({
    dispatch_no: "", dispatch_date: "", expected_date: "",
    transporter_name: "", vehicle_no: "", lr_no: "",
  });
  const [lots, setLots] = useState<Record<number, {
    batch_no: string; mfg_date: string; expiry_date: string;
  }>>({});

  const { data: ret, isLoading, error } = useQuery({
    queryKey: ["supplier-return", returnId],
    queryFn: () => supplierApi.return(returnId),
    enabled: Number.isFinite(returnId) && returnId > 0,
    retry: false,
  });

  // THE REPLACEMENT'S FILE SLOTS, and what each one asks for. Served rather than written
  // here: `accept`, `capture` and `required` are the same rules the upload route and the
  // dispatch guard enforce, and a copy in the screen would be free to offer something
  // the server then refuses — or to keep demanding a file the business has since made
  // optional, which is exactly what happened to the invoice. Never changes between
  // loads, hence `staleTime: Infinity` — this is a form definition, not a document.
  const { data: docTypes = [] } = useQuery({
    queryKey: ["supplier-replacement-document-types"],
    queryFn: supplierApi.replacementDocumentTypes,
    staleTime: Infinity,
    retry: false,
  });

  const close = () => {
    setAsking(null);
    setNote("");
    setRefundAmount("");
  };

  const settled = (fresh: VendorReturnDetail, message: string) => {
    qc.setQueryData(["supplier-return", returnId], fresh);
    qc.invalidateQueries({ queryKey: ["supplier-returns"] });
    close();
    toast.success(message);
  };

  const lotOf = (line: VendorReturnItemRow) =>
    lots[line.line_no] ?? { batch_no: "", mfg_date: "", expiry_date: "" };
  const setLot = (lineNo: number, patch: Partial<{
    batch_no: string; mfg_date: string; expiry_date: string;
  }>) => setLots((prev) => ({
    ...prev,
    [lineNo]: { ...(prev[lineNo] ?? { batch_no: "", mfg_date: "", expiry_date: "" }),
      ...patch },
  }));

  const act = useMutation({
    mutationFn: async () => {
      if (!ret) throw new Error("not loaded");
      switch (asking) {
        case "decide": {
          const decided = await supplierApi.decideReturn(returnId, {
            action: decision, remarks: note.trim() || null,
          });
          // A rejection ends here; an approval carries straight on into the settlement
          // the same dialog collected. Sequential rather than parallel: the settle route
          // refuses a return that is not yet VENDOR_APPROVED, so the decision has to be
          // on the row before the second call goes out. If the settle fails the approval
          // still stands — the document lands on the `settle` rung and the supplier is
          // asked the one question that did not get through, which is the pre-merge
          // behaviour and not a dead end.
          if (decision !== "APPROVED") return decided;
          return supplierApi.settleReturn(returnId, {
            settlement,
            refund_amount: settlement === "REFUNDED" ? Number(refundAmount) : null,
            remarks: note.trim() || null,
          });
        }
        case "settle":
          return supplierApi.settleReturn(returnId, {
            settlement,
            refund_amount: settlement === "REFUNDED" ? Number(refundAmount) : null,
            remarks: note.trim() || null,
          });
        case "accept-transport":
          return supplierApi.acceptReturnTransport(returnId, {
            ...trimmedVehicle(), remarks: note.trim() || null,
          });
        case "pickup":
          return supplierApi.recordReturnPickup(returnId, {
            ...trimmedVehicle(), remarks: note.trim() || null,
          });
        case "dispatch":
          return supplierApi.dispatchReplacement(returnId, {
            dispatch_no: dispatch.dispatch_no.trim() || null,
            dispatch_date: dispatch.dispatch_date || null,
            expected_date: dispatch.expected_date || null,
            transporter_name: dispatch.transporter_name.trim() || null,
            vehicle_no: dispatch.vehicle_no.trim() || null,
            lr_no: dispatch.lr_no.trim() || null,
            remarks: note.trim() || null,
            lines: (ret.items ?? []).map((line) => {
              const lot = lotOf(line);
              return {
                line_no: line.line_no,
                batch_no: lot.batch_no.trim() || null,
                mfg_date: lot.mfg_date || null,
                expiry_date: lot.expiry_date || null,
              };
            }),
          });
        default:
          throw new Error("nothing to do");
      }
    },
    onSuccess: (fresh) => settled(fresh, MESSAGES[asking ?? "decide"]),
  });

  // --- the two files, uploaded as they are picked rather than with the dispatch ------
  //
  // ON PICK, not on confirm. The bytes are the slow part of this press — a phone
  // photograph over a warehouse connection — and doing it inside the dispatch would put
  // that wait between "Dispatch replacement" and any sign the file was even accepted,
  // with a rejected type (a PDF in the camera slot) only surfacing after the whole
  // upload. Uploading here means the modal can show the file's name, let it be swapped,
  // and enable the press only once both slots are genuinely filled on the server.
  //
  // Both mutations answer with the whole return, so the cache is replaced rather than
  // invalidated and the slots redraw without a second round trip.
  const [docError, setDocError] = useState<string | null>(null);
  const attach = useMutation({
    mutationFn: ({ category, file }: { category: string; file: File }) =>
      supplierApi.uploadReplacementDocument(returnId, category, file),
    onMutate: () => setDocError(null),
    onSuccess: (fresh) => {
      qc.setQueryData(["supplier-return", returnId], fresh);
    },
    onError: (e) => setDocError(errorMessage(e)),
  });
  const detach = useMutation({
    mutationFn: (attachmentId: number) =>
      supplierApi.deleteReplacementDocument(returnId, attachmentId),
    onMutate: () => setDocError(null),
    onSuccess: (fresh) => {
      qc.setQueryData(["supplier-return", returnId], fresh);
    },
    onError: (e) => setDocError(errorMessage(e)),
  });

  const [decision, setDecision] = useState<"APPROVED" | "REJECTED">("APPROVED");

  const trimmedVehicle = () => ({
    vehicle_no: vehicle.vehicle_no.trim() || null,
    driver_name: vehicle.driver_name.trim() || null,
    driver_phone: vehicle.driver_phone.trim() || null,
    transporter_name: vehicle.transporter_name.trim() || null,
    lr_no: vehicle.lr_no.trim() || null,
    expected_date: vehicle.expected_date || null,
  });

  if (error) {
    return (
      <>
        <PageHeader eyebrow="Goods returned to you" title="Return"
                    back={{ to: "/supplier/returns", label: "Back to returns" }} />
        <ErrorBanner error={error} />
      </>
    );
  }
  if (isLoading || !ret) {
    return (
      <>
        <PageHeader eyebrow="Goods returned to you" title="Return"
                    back={{ to: "/supplier/returns", label: "Back to returns" }} />
        <p className="text-sm text-muted">Opening the return…</p>
      </>
    );
  }

  const rung = rungOf(ret);
  const ask = rung ? ASKS[rung] : null;
  // MERGED 2026-09-19. Approving and saying what you are giving back are ONE press.
  // They were two: Approve closed, the card came back reading "What are you giving
  // back?", and the supplier pressed again. The second press asks nothing the first
  // could not — a supplier who has decided to accept a return has, by then, decided
  // whether they are refunding it — and a return left sitting on VENDOR_APPROVED
  // because nobody came back for the second press is a return the warehouse cannot
  // move either. The `settle` rung stays reachable on its own for exactly those rows:
  // anything already approved under the old two-press flow still lands on it.
  const settling = asking === "settle"
    || (asking === "decide" && decision === "APPROVED");
  const returnedValue = Number(ret.total_value ?? 0);
  const parsedRefund = Number(refundAmount);
  const refundValid = refundAmount.trim() !== "" && Number.isFinite(parsedRefund)
    && parsedRefund > 0 && parsedRefund <= returnedValue;

  // What the modal will not let through, said before the press rather than after it.
  const blockedBecause = (() => {
    if (asking === "decide" && decision === "REJECTED" && !note.trim()) {
      return "Say why you are rejecting this return — the warehouse that raised it "
        + "has to act on your answer.";
    }
    if (settling && settlement === "REFUNDED" && !refundValid) {
      if (refundAmount.trim() === "") return "Enter the amount you are refunding.";
      if (!(parsedRefund > 0)) return "Enter a refund greater than zero.";
      return `The refund cannot exceed the ₹ ${money(returnedValue)} of goods returned.`;
    }
    if (asking === "dispatch") {
      // The two files first: they sit at the top of the form, and a message about a
      // batch on line 3 while the photograph slot is still empty points at the wrong
      // thing. Read off what the SERVER says is on file, which is the same list its own
      // guard checks — the press cannot be enabled over a requirement the save refuses.
      const missing = docTypes.filter(
        (type) => type.required
          && !(ret.replacement_documents ?? []).some((d) => d.doc_category === type.value));
      if (missing.length) {
        // `noun`, not `label` — the caption is an instruction on a button ("Upload
        // image") and reads as nonsense inside a sentence. Same wording the server's
        // own refusal uses, off the same served entry.
        return `Attach the ${missing.map((m) => m.noun).join(" and the ")}.`;
      }
      for (const line of ret.items ?? []) {
        const lot = lotOf(line);
        if (line.needs_batch && !lot.batch_no.trim()) {
          return `Line ${line.line_no}: give the batch number of the replacement goods `
            + "you are sending.";
        }
        if (line.needs_expiry && !lot.expiry_date) {
          const life = line.life_label ?? "expiry";
          return `Line ${line.line_no}: give the ${life} date of the replacement goods.`;
        }
      }
    }
    return null;
  })();

  const columns: Column<VendorReturnItemRow>[] = [
    {
      key: "item", header: "Item",
      render: (line) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{line.item_name ?? "—"}</p>
          <p className="text-xs text-muted">
            {[line.item_code, line.batch_no ? `batch ${line.batch_no}` : null]
              .filter(Boolean).join(" · ")}
          </p>
        </div>
      ),
    },
    {
      key: "qty", header: "Quantity", className: "text-right",
      render: (line) => <>{line.quantity} {line.uom_code ?? ""}</>,
    },
    {
      key: "reason", header: "Reason", hideOnNarrow: true,
      render: (line) => line.reason_label ?? "—",
    },
    {
      key: "amount", header: "Value", className: "text-right",
      render: (line) => <>₹ {money(line.amount)}</>,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Goods returned to you"
        title={ret.return_no}
        back={{ to: "/supplier/returns", label: "Back to returns" }}
        actions={<StatusPill status={ret.status}
                             label={vendorReturnPillLabel(ret.status,
                                                          ret.vendor_response_label,
                                                          ret.status_label)} />}
      />

      {/* ---- the one thing being asked, above everything read-only ---- */}
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-ink">
              {ask ? ask.title : "Nothing is waiting on you"}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {ask ? ask.hint
                : ret.status_label
                  ?? "This return is with the buyer. There is nothing to answer here."}
            </p>
          </div>

          {/* GONE once answered, never greyed — see the file docstring. */}
          {rung === "decide" ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary"
                      onClick={() => { setDecision("APPROVED"); setNote(""); setAsking("decide"); }}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button variant="dangerSoft"
                      onClick={() => { setDecision("REJECTED"); setNote(""); setAsking("decide"); }}>
                <X className="h-4 w-4" /> Reject
              </Button>
            </div>
          ) : ask ? (
            <Button variant="primary" onClick={() => { setNote(""); setAsking(rung); }}>
              <ask.icon className="h-4 w-4" /> {ask.label}
            </Button>
          ) : null}
        </div>

        {/* ---- what has already been answered, stated as fact ---- */}
        {ret.vendor_decision && (
          <div className="mt-3 space-y-1.5 rounded-lg bg-content2/60 px-3 py-2.5 text-sm">
            <p className="text-ink">
              <span className="font-semibold">
                You {ret.vendor_decision === "APPROVED" ? "approved" : "rejected"} this
                return
              </span>
              {ret.vendor_decision_at && ` on ${fmtDate(ret.vendor_decision_at)}`}
              {ret.vendor_decision_note && <> — “{ret.vendor_decision_note}”</>}
            </p>
            {ret.vendor_refund_amount != null && (
              <p className="text-ink">
                Refund agreed:{" "}
                <span className="font-semibold">₹ {money(ret.vendor_refund_amount)}</span>
              </p>
            )}
            {ret.vendor_response === "REPLACED" && (
              <p className="text-muted">
                You are sending replacement goods.
                {ret.vehicle_arrangement_label && ` ${ret.vehicle_arrangement_label}.`}
              </p>
            )}
            {ret.vendor_receipt_confirmed_at && (
              <p className="text-muted">
                Signed for on {fmtDateTime(ret.vendor_receipt_confirmed_at)}
                {ret.vendor_receipt_by_name && ` by ${ret.vendor_receipt_by_name}`}.
              </p>
            )}
            {ret.replacement_dispatched_at && (
              <p className="text-muted">
                Replacement dispatched
                {ret.replacement_dispatch_no && ` on note ${ret.replacement_dispatch_no}`}
                {ret.replacement_expected_date
                  && `, expected ${fmtDate(ret.replacement_expected_date)}`}.
              </p>
            )}
          </div>
        )}
      </Card>

      {/* ---- what the return is, and what to check it against ---- */}
      <Card className="mb-5 p-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label="Returned on">
            {ret.return_date ? fmtDate(ret.return_date) : "—"}
          </Fact>
          <Fact label="Reason">{ret.reason_label ?? "—"}</Fact>
          <Fact label="Quantity">
            {ret.total_qty} in {ret.total_items} line{ret.total_items === 1 ? "" : "s"}
          </Fact>
          <Fact label="Value">₹ {money(ret.total_value)}</Fact>
          {/* The three documents the business requires a supplier to be able to verify a
              return against, before they answer it. The QC was on no screen at all until
              2026-09-12 — it is the evidence for the claim being made. */}
          <Fact label="Purchase order">{ret.po_no ?? "—"}</Fact>
          <Fact label="Goods receipt">{ret.grn_no ?? "—"}</Fact>
          <Fact label="QC inspection">{ret.inspection_no ?? "—"}</Fact>
          <Fact label="Their reference">{ret.dispatch_no ?? "—"}</Fact>
        </dl>
        {ret.remarks && (
          <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
            “{ret.remarks}”
          </p>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <h2 className="mb-3 font-display text-sm font-bold text-ink">
            What is coming back to you
          </h2>
          <ResponsiveList
            data={ret.items ?? []}
            columns={columns}
            keyOf={(line) => line.line_no}
            renderCard={(line) => (
              <div className="space-y-1">
                <p className="font-medium text-ink">{line.item_name ?? line.item_code}</p>
                <p className="text-xs text-muted">
                  {line.quantity} {line.uom_code ?? ""} · ₹ {money(line.amount)}
                </p>
                {line.reason_label && (
                  <p className="text-xs text-muted">{line.reason_label}</p>
                )}
              </div>
            )}
          />
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-display text-sm font-bold text-ink">
            How it is travelling
          </h2>
          <dl className="space-y-3">
            <Fact label="Arrangement">{ret.vehicle_arrangement_label ?? "Not yet decided"}</Fact>
            <Fact label="Vehicle">{ret.vehicle_number ?? "—"}</Fact>
            <Fact label="Driver">{ret.driver_name ?? "—"}</Fact>
            <Fact label="LR / docket">{ret.lr_no ?? "—"}</Fact>
            <Fact label="Expected">
              {ret.expected_delivery ? fmtDate(ret.expected_delivery) : "—"}
            </Fact>
          </dl>
          {ret.delivery_address && (
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {ret.delivery_address}
            </p>
          )}
        </Card>
      </div>

      {/* ---- one modal, shaped by the rung it was opened on ---- */}
      <ConfirmModal
        isOpen={!!asking}
        title={ask?.title ?? ""}
        confirmLabel={asking === "decide"
          ? (decision !== "APPROVED"
              ? "Reject"
              : settlement === "REFUNDED" ? "Approve and refund" : "Approve and replace")
          : (ask?.label ?? "Confirm")}
        tone={asking === "decide" && decision === "REJECTED" ? "danger" : "warning"}
        busy={act.isPending}
        error={act.error}
        confirmDisabled={!!blockedBecause}
        onConfirm={() => act.mutate()}
        onClose={close}
        message=""
      >
        <div className="space-y-4">
          {settling && (
            <div className="grid gap-2">
              {([
                ["REFUNDED", "Refund the value", IndianRupee],
                ["REPLACED", "Send replacement goods", RefreshCw],
              ] as const).map(([value, label, Icon]) => (
                <button key={value} type="button"
                        onClick={() => setSettlement(value)}
                        className={`flex items-center gap-2 rounded-lg border p-3
                                    text-left text-sm ${
                          settlement === value
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "border-line"}`}>
                  <Icon className="h-4 w-4 text-muted" />
                  <span className="font-medium text-ink">{label}</span>
                </button>
              ))}
            </div>
          )}

          {settling && settlement === "REFUNDED" && (
            <Field label="Refund amount"
                   hint={`Up to ₹ ${money(returnedValue)} — the value returned to you.`}>
              <div className="flex gap-2">
                <Input value={refundAmount} inputMode="decimal"
                       onChange={(e) => setRefundAmount(e.target.value)}
                       placeholder="0.00" />
                <Button variant="soft" type="button"
                        onClick={() => setRefundAmount(String(returnedValue))}>
                  Full value
                </Button>
              </div>
            </Field>
          )}

          {(asking === "accept-transport" || asking === "pickup") && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Vehicle number">
                <Input value={vehicle.vehicle_no}
                       onChange={(e) => setVehicle({ ...vehicle, vehicle_no: e.target.value })} />
              </Field>
              <Field label="Driver">
                <Input value={vehicle.driver_name}
                       onChange={(e) => setVehicle({ ...vehicle, driver_name: e.target.value })} />
              </Field>
              <Field label="Driver phone">
                <Input value={vehicle.driver_phone}
                       onChange={(e) => setVehicle({ ...vehicle, driver_phone: e.target.value })} />
              </Field>
              <Field label="Transporter">
                <Input value={vehicle.transporter_name}
                       onChange={(e) => setVehicle({ ...vehicle, transporter_name: e.target.value })} />
              </Field>
              <Field label="LR / docket">
                <Input value={vehicle.lr_no}
                       onChange={(e) => setVehicle({ ...vehicle, lr_no: e.target.value })} />
              </Field>
              <Field label={asking === "pickup" ? "Collected on" : "Expected to collect"}>
                {/* A collection still to happen cannot be dated in the past; the same
                    field recording a collection that ALREADY happened can be, so the
                    floor is only on the forward-looking half. */}
                <Input type="date" value={vehicle.expected_date}
                       min={asking === "pickup" ? undefined : todayIst()}
                       onChange={(e) => setVehicle({ ...vehicle, expected_date: e.target.value })} />
              </Field>
            </div>
          )}

          {asking === "dispatch" && (
            <>
              {/* THE FILE SLOTS, first in the form because the required one gates
                  everything below it. One slot per served type: the picture of the goods
                  as they are loaded, and the invoice for them. Which carries the
                  asterisk — and which blocks the press — is `type.required`, so neither
                  is decided here. */}
              <div className="space-y-2">
                {docTypes.map((type) => (
                  <DocumentSlot
                    key={type.value}
                    type={type}
                    onFile={(ret.replacement_documents ?? [])
                      .find((d) => d.doc_category === type.value) ?? null}
                    busy={attach.isPending && attach.variables?.category === type.value}
                    disabled={attach.isPending || detach.isPending}
                    onPick={(file) => attach.mutate({ category: type.value, file })}
                    onClear={(id) => detach.mutate(id)}
                  />
                ))}
                {docError && <p className="text-xs text-danger">{docError}</p>}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Your dispatch note no">
                  <Input value={dispatch.dispatch_no}
                         onChange={(e) => setDispatch({ ...dispatch, dispatch_no: e.target.value })} />
                </Field>
                <Field label="Dispatched on">
                  <Input type="date" value={dispatch.dispatch_date}
                         onChange={(e) => setDispatch({ ...dispatch, dispatch_date: e.target.value })} />
                </Field>
                <Field label="Expected to reach them">
                  <Input type="date" value={dispatch.expected_date} min={todayIst()}
                         onChange={(e) => setDispatch({ ...dispatch, expected_date: e.target.value })} />
                </Field>
                <Field label="Transporter">
                  <Input value={dispatch.transporter_name}
                         onChange={(e) => setDispatch({ ...dispatch, transporter_name: e.target.value })} />
                </Field>
                <Field label="Vehicle">
                  <Input value={dispatch.vehicle_no}
                         onChange={(e) => setDispatch({ ...dispatch, vehicle_no: e.target.value })} />
                </Field>
                <Field label="LR / docket">
                  <Input value={dispatch.lr_no}
                         onChange={(e) => setDispatch({ ...dispatch, lr_no: e.target.value })} />
                </Field>
              </div>

              {/* WHAT IS IN THE CARTON, per line. Never prefilled from the return's own
                  batch: that is the faulty stock travelling the other way, and copying it
                  would put a wrong lot number on the buyer's goods receipt. */}
              <div className="space-y-3 border-t border-line pt-3">
                <p className="text-xs text-muted">
                  Give the batch and life dates of the goods you are sending. The buyer
                  cannot receive them without these.
                </p>
                {(ret.items ?? []).map((line) => {
                  const lot = lotOf(line);
                  return (
                    <div key={line.line_no} className="rounded-lg border border-line p-3">
                      <p className="mb-2 text-sm font-medium text-ink">
                        Line {line.line_no} · {line.item_name ?? line.item_code}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label={`Batch${line.needs_batch ? " *" : ""}`}>
                          <Input value={lot.batch_no}
                                 onChange={(e) =>
                                   setLot(line.line_no, { batch_no: e.target.value })} />
                        </Field>
                        <Field label="Manufactured">
                          <Input type="date" value={lot.mfg_date}
                                 onChange={(e) =>
                                   setLot(line.line_no, { mfg_date: e.target.value })} />
                        </Field>
                        <Field
                          label={`${line.life_label ?? "Expiry"}${line.needs_expiry ? " *" : ""}`}>
                          <Input type="date" value={lot.expiry_date}
                                 onChange={(e) =>
                                   setLot(line.line_no, { expiry_date: e.target.value })} />
                        </Field>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <Field label={asking === "decide" && decision === "REJECTED"
            ? "Why are you rejecting it?" : "Anything to add?"}>
            <Textarea value={note} minRows={3}
                      onChange={(e) => setNote(e.target.value)} />
          </Field>

          {blockedBecause && (
            <p className="text-xs text-danger">{blockedBecause}</p>
          )}
        </div>
      </ConfirmModal>
    </>
  );
}

/** What the toast says once each rung is answered. */
const MESSAGES: Record<Exclude<Rung, null>, string> = {
  decide: "Your answer has been sent to the buyer.",
  settle: "Recorded — the buyer has been told how this is being settled.",
  "accept-transport": "Recorded — the buyer knows your vehicle is coming.",
  pickup: "Recorded — the goods have left the buyer's warehouse.",
  dispatch: "Replacement dispatched — the buyer is expecting it.",
};
