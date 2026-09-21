import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes, Building2, ClipboardList, History, Layers, PackageCheck, ScrollText, Truck,
} from "lucide-react";
import {
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  ErrorBanner,
  Field,
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
  DRAFT_DELETE_PERMISSION,
  deletePurchaseReturn,
  getReturn,
  purchaseReturnDossier,
  purchaseReturnReasons,
  sendPurchaseReturnToVendor,
} from "../api";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDate, fmtDateTime, fmtMoney, fmtQty } from "../format";
import {
  Fact, FactGroup, PurchaseReturnHistory, PurchaseReturnJourney, PurchaseReturnTrail,
} from "../components/PurchaseReturnDossier";
import { PurchaseReturnLeg } from "../components/PurchaseReturnLeg";

/**
 * Purchase Return review — the screen a draft is read on before it goes out,
 * and the only place a DRAFT can be sent from.
 *
 * Opening it is the whole auto-fetch: one `GET /api/warehouse/returns/{id}` walks the
 * chain the document already points backward along — the return's own header, its GRN
 * and that GRN's PO and vendor invoice, the indent behind it, each line's item with what
 * was purchased / already returned / still available, and the full vendor record read
 * live off `mst_vendors`. Nothing on this screen is typed and nothing is a second copy:
 * the vendor is whichever vendor the source transaction names and cannot be swapped.
 *
 * DRAFT: Edit, Delete and Send to Vendor (behind a confirm) are offered.
 * SENT_TO_VENDOR (or anything further along): read-only, with the sent
 * timestamp as the proof it went. A sent return can never be sent again —
 * the button is gone and the backend refuses it too.
 *
 * ONE SCREEN, TWO FRONT DOORS (2026-09-10). The warehouse works purchase returns under
 * `/warehouse/purchase-returns`; the returns register opens the same document under
 * `/returns/purchase`. Every route this screen pushes has to stay on the side it was
 * opened from — hardcoding `/warehouse` handed a returns reader over to the warehouse
 * module mid-flow, and the module rail, the tabs and the eyebrow all changed under
 * them. Same arrangement Consignments already has under `/logistics`.
 *
 * THE DOSSIER (2026-09-10). Most purchase returns in this build are not typed by
 * anybody: a branch sends material up the chain, the warehouse acknowledges the load,
 * and the DRAFT appears. The person who opens it did not raise it, and the first two
 * questions they have are "where did this come from" and "who are we sending it back
 * to" — neither of which the old flat field grid answered, though every fact needed to
 * answer both was already in the database. `GET /returns/{id}/dossier` reads the whole
 * trail (indent → requisition → RFQ → quotation → PO → GRN → QC on the buying side,
 * the branch return and its consignment on the way back) plus the merged history of
 * every desk that touched either document.
 *
 * WHY TABS AND NOT ONE LONG PAGE. There are now upwards of sixty facts behind this
 * document. Shown at once they are a wall nobody reads; the screen therefore answers
 * ONE question per tab and leads with the two that are always asked — the hero says
 * what this is and where it came from, and the supplier band says where it goes. The
 * tabs are local state on purpose: switching them is not navigation and must not push
 * a history entry the browser's Back button then has to walk through.
 */

/** The hero's accent, keyed on where the document has got to. */
const STATUS_TONES: Record<string, { stripe: string; wash: string }> = {
  DRAFT: { stripe: "bg-warn", wash: "from-warn-bg/70" },
  SENT_TO_VENDOR: { stripe: "bg-info", wash: "from-info-bg/70" },
  DISPATCHED: { stripe: "bg-info", wash: "from-info-bg/70" },
  // The return leg: the material is agreed and on its way back. Info blue throughout —
  // it is in motion, and only arriving turns it green.
  VENDOR_APPROVED: { stripe: "bg-info", wash: "from-info-bg/70" },
  AWAITING_VENDOR_VEHICLE: { stripe: "bg-info", wash: "from-info-bg/70" },
  VEHICLE_REQUESTED: { stripe: "bg-info", wash: "from-info-bg/70" },
  IN_TRANSIT: { stripe: "bg-info", wash: "from-info-bg/70" },
  RECEIVED_AT_WAREHOUSE: { stripe: "bg-ok", wash: "from-ok-bg/70" },
  COMPLETED: { stripe: "bg-ok", wash: "from-ok-bg/70" },
  CANCELLED: { stripe: "bg-bad", wash: "from-bad-bg/70" },
  REJECTED: { stripe: "bg-bad", wash: "from-bad-bg/70" },
};

type TabKey = "overview" | "journey" | "trail" | "history" | "items";

export default function PurchaseReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const navigate = useNavigate();
  // The register on this side is the base of every path below it, so one value answers
  // Back, Edit and where a delete lands.
  const inReturns = useLocation().pathname.startsWith("/returns");
  const basePath = inReturns ? "/returns/purchase" : "/warehouse/purchase-returns";
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<TabKey>("overview");
  // The send's own reason and remarks. Seeded from the draft when the confirm opens —
  // but a return raised automatically off a branch consignment carries the reason as
  // prose ("Damaged in transit"), and the send only accepts one of the served codes, so
  // that is where the storekeeper picks one. See `PurchaseReturn.reason_code`.
  const [sendReason, setSendReason] = useState("");
  const [sendRemarks, setSendRemarks] = useState("");

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["warehouse", "purchase-return", returnId],
    queryFn: () => getReturn(returnId),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The trail and the history. Its own query rather than part of the detail: it reads
  // six other modules' tables and must never be able to keep the document — or the
  // Send button on it — off the screen when one of them is unreachable.
  const { data: dossier, isLoading: dossierLoading, error: dossierError } = useQuery({
    queryKey: ["warehouse", "purchase-return", returnId, "dossier"],
    queryFn: () => purchaseReturnDossier(returnId),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: reasons = [] } = useQuery({
    queryKey: ["warehouse", "purchase-return", "reasons"],
    queryFn: purchaseReturnReasons,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["warehouse", "purchase-return"] });
    qc.invalidateQueries({ queryKey: ["warehouse-purchase-returns"] });
  };

  const send = useMutation({
    mutationFn: () => {
      if (!doc) throw new Error("Return not loaded yet");
      return sendPurchaseReturnToVendor(doc.id, {
        return_reason: sendReason,
        remarks: sendRemarks.trim() || null,
        // The lines exactly as they stand on the saved draft — the send commits what was
        // just reviewed, it does not re-quantify anything. The backend re-checks every
        // one against what the source document still allows back.
        items: (doc.items ?? []).map((l) => ({
          item_id: l.item_id,
          grn_item_id: l.grn_item_id ?? null,
          po_item_id: l.po_item_id ?? null,
          batch_id: l.batch_id ?? null,
          quantity: Number(l.quantity),
          rate: l.rate ?? null,
          reason: l.reason ?? sendReason,
        })),
        // Stored where the document has them, traced where it does not. Posting the
        // traced chain is what BINDS it: the backend re-reads every id and refuses a
        // vendor that disagrees with the source, so nothing here can move a return to
        // a vendor the purchase trail does not name.
        grn_id: doc.grn_id ?? doc.traced_grn_id ?? null,
        po_id: doc.po_id ?? doc.traced_po_id ?? null,
        vendor_id: doc.vendor_id ?? doc.traced_vendor_id ?? null,
        warehouse_id: doc.warehouse_id ?? null,
      });
    },
    onSuccess: (sent) => {
      setConfirmSend(false);
      invalidate();
      toast.success(`Purchase Return ${sent.return_no} sent to the vendor.`);
    },
    // The modal stays open on failure, carrying the server's sentence — closing it
    // threw away both the message and the reason just picked.
  });

  const remove = useMutation({
    mutationFn: () => deletePurchaseReturn(returnId),
    onSuccess: () => {
      invalidate();
      toast.success("Draft deleted.");
      navigate(basePath);
    },
  });

  if (isLoading) return <p className="text-sm text-muted">Loading return…</p>;
  if (error || !doc) {
    return (
      <div>
        <PageHeader eyebrow="RETURNS" title="Purchase Return"
                    back={{ to: basePath, label: "Back to Purchase returns" }} />
        <ErrorBanner error={error ?? "Purchase Return not found"} />
      </div>
    );
  }

  const isDraft = doc.status === "DRAFT";
  // Sending is no longer the same question as editing (2026-09-19). A return that has
  // been through its ladder is APPROVED, not DRAFT, and the server will now take it —
  // so the button follows the SERVER's answer (`can_send_to_vendor`) rather than the
  // status, and cannot drift from what the save would accept. Edit and Delete stay
  // DRAFT-only: an approved return is not a document to rewrite.
  const maySend = isDraft || !!doc.can_send_to_vendor;
  const mayDelete = isDraft && can(DRAFT_DELETE_PERMISSION.return);
  // Stored first, traced second. A return the returns module raised off a branch
  // consignment carries neither GRN nor PO nor vendor of its own, and the chain behind
  // its stock is read for it (`chain_traced`). Sending posts these back and binds them.
  const grnNo = doc.grn_no ?? doc.traced_grn_no ?? null;
  const poNo = doc.po_no ?? doc.traced_po_no ?? null;
  const vendorId = doc.vendor_id ?? doc.traced_vendor_id ?? null;
  const vendorName = doc.vendor_name ?? doc.traced_vendor_name ?? null;
  // Every line has to be within what the source document still allows back before the
  // send is offered: the backend refuses the whole request otherwise, and an editable
  // draft is exactly where an over-quantity gets corrected.
  const overLines = (doc.items ?? []).filter(
    (l) => l.returnable_qty != null && Number(l.quantity) > Number(l.returnable_qty));
  const blocked = !doc.can_send_to_vendor
    ? vendorId == null
      ? "No vendor on this return, and none could be read from the stock it is sending back. Use Edit to pick the Purchase Invoice / PO it was bought on — the vendor comes from that."
      : !doc.items?.length
        ? "This return has no lines to send."
        : null
    : overLines.length > 0
      ? `${overLines.length} line(s) ask for more than is available. Edit the draft first.`
      : null;
  const remarksRequired = sendReason === "OTHER" && !sendRemarks.trim();

  const openSend = () => {
    setSendReason(doc.reason_code ?? "");
    setSendRemarks(doc.remarks ?? "");
    send.reset();
    setConfirmSend(true);
  };

  const tone = STATUS_TONES[doc.status] ?? { stripe: "bg-neutral", wash: "from-content2" };
  const address = [doc.vendor_address, doc.vendor_city, doc.vendor_state, doc.vendor_pincode]
    .filter(Boolean).join(", ");

  // One sentence saying where this document came from, because on most of them the
  // answer is "nobody typed it" and that is not obvious from a status pill.
  const provenance = doc.is_manual
    ? <>Entered by hand by {doc.created_by_name ?? "—"} on {fmtDate(doc.created_at)}
        {doc.source_ref_no
          ? <> · reference <b className="text-ink">{doc.source_ref_no}</b></>
          : null}</>
    : doc.source_return_no
      ? <>Raised automatically when <b className="text-ink">{doc.source_return_no}</b> was
          acknowledged at {doc.warehouse_name ?? "this warehouse"}
          {doc.source_category_label ? <> · {doc.source_category_label}</> : null}</>
      : <>Raised by {doc.created_by_name ?? "—"} on {fmtDate(doc.created_at)}</>;

  const tabs: { key: TabKey; label: string; icon: typeof Boxes; count?: number }[] = [
    { key: "overview", label: "Overview", icon: ClipboardList },
    // The journey sits beside the trail rather than inside it: the trail answers "where
    // did this come from", the journey answers "where has it got to", and a reader opens
    // the document for one or the other.
    { key: "journey", label: "Journey", icon: Truck,
      count: dossier?.journey?.length },
    { key: "trail", label: "Paper trail", icon: ScrollText, count: dossier?.documents.length },
    { key: "history", label: "History", icon: History, count: dossier?.timeline.length },
    { key: "items", label: "Items", icon: Boxes, count: doc.items?.length ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="RETURNS"
        title={`Purchase Return ${doc.return_no}`}
        back={{ to: basePath, label: "Back to Purchase returns" }}
      />

      {/* A failed send keeps its modal open and shows the server's sentence there, so
          it is deliberately not repeated here. */}
      <ErrorBanner error={remove.error} />

      {/* ---------------------------------------------------------------- hero -- */}
      <Card className="mb-4 overflow-hidden p-0">
        <div className="flex">
          <span className={`w-1.5 shrink-0 ${tone.stripe}`} aria-hidden />
          <div className={`flex-1 bg-gradient-to-r ${tone.wash} to-transparent p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {/* `status_label` where the supplier has answered. The stored status
                      is untouched and still decides the colour — this is wording, and
                      the pill falls back to it the moment there is no answer. */}
                  <StatusPill status={doc.status} label={doc.status_label ?? undefined} />
                  {doc.source_category_label && (
                    <span className="rounded-full border border-line bg-content1 px-2.5 py-0.5
                                     text-[11px] font-semibold text-body">
                      {doc.source_category_label}
                    </span>
                  )}
                  {doc.chain_traced && (
                    <span className="rounded-full bg-warn-bg px-2.5 py-0.5 text-[11px]
                                     font-semibold uppercase tracking-wider text-warn">
                      chain traced
                    </span>
                  )}
                  {doc.is_manual && (
                    <span className="rounded-full bg-info-bg px-2.5 py-0.5 text-[11px]
                                     font-semibold uppercase tracking-wider text-info">
                      manual entry
                    </span>
                  )}
                </div>
                <h2 className="mt-1.5 font-mono text-xl font-bold text-ink">{doc.return_no}</h2>
                <p className="mt-0.5 text-xs text-muted">{provenance}</p>
              </div>

              {/* The three numbers the whole document is about. */}
              <div className="flex gap-5">
                {[
                  ["Lines", String(doc.total_items ?? 0)],
                  ["Quantity", fmtQty(doc.total_qty)],
                  ["Value", `₹ ${fmtMoney(doc.total_value)}`],
                ].map(([label, value]) => (
                  <div key={label} className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {label}
                    </div>
                    <div className="font-display text-xl font-bold tabular text-ink">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Said out loud, never quietly merged into the fields below: everything
                about the purchase is READ off the stock, because the document itself
                names none. Sending binds it. */}
            {doc.chain_traced && doc.chain_note && (
              <p className="mt-3 rounded-lg border border-warn/30 bg-content1/70 px-3 py-2
                            text-xs text-warn">
                {doc.chain_note}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------- the return leg -- */}
      {/* WHAT HAPPENS AFTER IT HAS GONE, and the band a sent return is actually worked
          from: Approve / Reject, then whose vehicle brings the material back, then the
          vehicle itself and the signature at the gate. Directly under the hero and above
          everything descriptive, because on a sent return this is the only part of the
          screen anybody has anything to DO on. Draws nothing on a draft. */}
      <PurchaseReturnLeg doc={doc} journey={dossier?.journey ?? []} />

      {/* ----------------------------------------------------- supplier's answer -- */}
      {/* WHAT CAME BACK FROM THE PORTAL, and the first thing anybody opens a SENT
          return to find out. The columns have been written since the portal learned to
          answer and no internal screen served them, so a return the supplier had
          accepted — with an inbound receipt already raised against it and waiting at
          the store — read here exactly as it had the day it was sent.

          Its own card rather than a Fact in the grid below, and above the supplier block
          rather than under it: this is the newest thing that happened to the document,
          and the receipt number is the one string a storekeeper will go and quote. */}
      {doc.vendor_response && (
        <Card className="mb-4 overflow-hidden p-0">
          <div className="flex">
            <span className="w-1.5 shrink-0 bg-ok" aria-hidden />
            <div className="flex-1 p-4">
              <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase
                             tracking-widest text-muted">
                <PackageCheck className="h-3.5 w-3.5" />
                What the supplier answered
              </h3>
              <p className="mt-1 font-display text-lg font-bold text-ink">
                {/* Served wording, never mapped here — a legacy answer that predates the
                    refund/replacement split still reads correctly because the server is
                    the only thing that words one. */}
                {doc.vendor_response_label ?? doc.vendor_response}
              </p>
              <p className="text-xs text-muted">
                {doc.vendor_response_at
                  ? `Answered on ${fmtDateTime(doc.vendor_response_at)}`
                  : "Answered on the supplier portal"}
              </p>

              {doc.vendor_response_note && (
                <p className="mt-2 text-sm text-body">
                  <span className="text-muted">Supplier's note: </span>
                  {doc.vendor_response_note}
                </p>
              )}

              {/* Money, on a refund. Kept apart from the goods sentence below because a
                  credit and a consignment are not the same kind of fact. */}
              {doc.vendor_refund_amount != null && (
                <p className="mt-3 text-sm text-body">
                  Refund of{" "}
                  <b className="tabular text-ink">₹ {fmtMoney(doc.vendor_refund_amount)}</b>
                  {" "}against ₹ {fmtMoney(doc.total_value)} returned.
                </p>
              )}

              {/* THE DOCUMENT THE GOODS WILL LAND ON. Said in words as well as shown,
                  because "a receipt exists" and "the receipt is still a draft nobody has
                  submitted" are different instructions to the store, and only the second
                  one tells them there is something left to do. Deliberately NOT a link:
                  this screen is opened from two modules (see the note at the top) and a
                  jump to the warehouse GRN screen would strand a returns reader. */}
              {doc.vendor_followup_receipt_no && (
                <p className="mt-3 rounded-lg border border-line bg-content2/60 px-3 py-2
                              text-xs text-body">
                  Inbound receipt{" "}
                  <b className="font-mono text-ink">{doc.vendor_followup_receipt_no}</b>
                  {doc.warehouse_name ? ` raised at ${doc.warehouse_name}` : " raised"} so the
                  store expects the goods. It is a DRAFT until the store receives against
                  it — nothing has been added to stock yet.
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ supplier -- */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase
                           tracking-widest text-muted">
              <Building2 className="h-3.5 w-3.5" />
              Supplier — where this goes back to
            </h3>
            <p className="mt-1 font-display text-lg font-bold text-ink">
              {vendorName ?? "No vendor resolved"}
            </p>
            <p className="text-xs text-muted">
              {[doc.vendor_code, vendorId ? `ID ${vendorId}` : null, doc.vendor_gstin]
                .filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          {/* Whether the vendor is the document's own or read off the trail. This is
              the one distinction on the screen a storekeeper must not miss: a traced
              vendor becomes binding only when Send to Vendor is pressed. */}
          {/* A MANUAL return's vendor was typed and may have no master record at all —
              that is not the same failure as a sourced return whose trail named
              nobody, and colouring it red said the document was broken when it was
              simply entered by hand. */}
          <span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
            doc.is_manual
              ? "bg-info-bg text-info"
              : doc.vendor_id
                ? "bg-ok-bg text-ok"
                : vendorId ? "bg-warn-bg text-warn" : "bg-bad-bg text-bad"}`}>
            {doc.is_manual
              ? "Entered manually"
              : doc.vendor_id
                ? "Bound to this return"
                : vendorId
                  ? `Read from ${grnNo ? `GRN ${grnNo}` : poNo ? `PO ${poNo}` : "the purchase trail"} — binds on send`
                  : "Not resolved"}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3
                        sm:grid-cols-4">
          <Fact label="Contact person">{doc.vendor_contact_person ?? "—"}</Fact>
          <Fact label="Phone">{doc.vendor_phone ?? "—"}</Fact>
          <Fact label="Email">{doc.vendor_email ?? "—"}</Fact>
          <Fact label="Vendor invoice">
            {doc.invoice_no ?? "—"}
            {doc.invoice_date && (
              <span className="ml-1 text-xs text-muted">({fmtDate(doc.invoice_date)})</span>
            )}
          </Fact>
          <Fact label="Address" wide>{address || "—"}</Fact>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- tabs -- */}
      <div className="mb-3 flex flex-wrap gap-1 rounded-xl border border-line/70 bg-content2 p-1">
        {tabs.map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? "true" : undefined}
            className={`flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold
                        transition ${tab === key
                          ? "bg-content1 text-ink shadow-sm"
                          : "text-muted hover:text-body"}`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {count != null && (
              <span className="rounded-full bg-content2 px-1.5 text-[11px] tabular">{count}</span>
            )}
          </button>
        ))}
      </div>

      <Card className="mb-4 p-4">
        {tab === "overview" && (
          <div className="space-y-3">
            <FactGroup title="This return" icon={<ClipboardList className="h-3.5 w-3.5" />}>
              <Fact label="Return date">{fmtDate(doc.return_date)}</Fact>
              <Fact label="Raised by">{doc.created_by_name ?? "—"}</Fact>
              <Fact label="Raised on">{fmtDateTime(doc.created_at)}</Fact>
              <Fact label="Sent at">{doc.sent_at ? fmtDateTime(doc.sent_at) : "—"}</Fact>
              <Fact label="Warehouse">{doc.warehouse_name ?? "—"}</Fact>
              <Fact label="Source">{doc.source_category_label ?? "—"}</Fact>
              <Fact label="Return reason">{doc.reason_label ?? doc.reason ?? "—"}</Fact>
              <Fact label="Remarks / notes" wide>{doc.remarks ?? "—"}</Fact>
            </FactGroup>

            <FactGroup title="The purchase behind it" icon={<Layers className="h-3.5 w-3.5" />}>
              <Fact label="Indent">{doc.indent_no ?? "—"}</Fact>
              <Fact label="Purchase order">{poNo ?? "—"}</Fact>
              <Fact label="GRN">
                {grnNo ?? "—"}
                {doc.grn_date && (
                  <span className="ml-1 text-xs text-muted">({fmtDate(doc.grn_date)})</span>
                )}
              </Fact>
              {/* THE QC THAT CONDEMNED THE GOODS. Beside the GRN it was taken on,
                  because it is the evidence the vendor is being asked to accept, and
                  until 2026-09-12 this document could not name it at all. Null where the
                  return names no goods receipt, or where nobody inspected the one it
                  names — said as a dash rather than invented. */}
              <Fact label="QC inspection">{doc.inspection_no ?? "—"}</Fact>
              <Fact label="Vendor invoice">{doc.invoice_no ?? "—"}</Fact>
              <Fact label="Invoice date">
                {doc.invoice_date ? fmtDate(doc.invoice_date) : "—"}
              </Fact>
              <Fact label="Vendor">{vendorName ?? "—"}</Fact>
            </FactGroup>

            <FactGroup title="How it came back, and what leaves on it"
                       icon={<Truck className="h-3.5 w-3.5" />}>
              <Fact label="Branch return">{doc.source_return_no ?? "—"}</Fact>
              <Fact label="Dispatch">
                {doc.dispatch_no
                  ?? (doc.is_manual ? "Not raised — manual entry" : "—")}
              </Fact>
              <Fact label="Credit note">{doc.credit_note_no ?? "—"}</Fact>
              {doc.is_manual && (
                <Fact label="Typed reference">{doc.source_ref_no ?? "—"}</Fact>
              )}
            </FactGroup>
          </div>
        )}

        {tab === "journey" && (
          dossierLoading
            ? <p className="text-sm text-muted">Reading the journey…</p>
            : dossierError
              ? <ErrorBanner error={dossierError} />
              : <PurchaseReturnJourney legs={dossier?.journey ?? []}
                                       message={dossier?.current_stage_message}
                                       sequence={dossier?.current_sequence} />
        )}

        {tab === "trail" && (
          dossierLoading
            ? <p className="text-sm text-muted">Reading the trail…</p>
            : dossierError
              ? <ErrorBanner error={dossierError} />
              : <PurchaseReturnTrail documents={dossier?.documents ?? []}
                                     note={dossier?.trail_note} />
        )}

        {tab === "history" && (
          dossierLoading
            ? <p className="text-sm text-muted">Reading the history…</p>
            : dossierError
              ? <ErrorBanner error={dossierError} />
              : <PurchaseReturnHistory events={dossier?.timeline ?? []} />
        )}

        {tab === "items" && (
          !doc.items?.length ? (
            <EmptyState title="No lines" hint="This return has no items." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[860px] w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase text-muted">
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3 text-right">Purchased</th>
                    <th className="py-2 pr-3 text-right">Already returned</th>
                    <th className="py-2 pr-3 text-right">Available</th>
                    <th className="py-2 pr-3 text-right">Return qty</th>
                    <th className="py-2 pr-3 text-right">Unit price</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.items.map((l) => {
                    // The one line-level fault that stops the send, called out where it
                    // is rather than only counted in the sentence under the buttons.
                    const over = l.returnable_qty != null
                      && Number(l.quantity) > Number(l.returnable_qty);
                    return (
                      <tr key={l.id} className="border-b border-line/60 last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-ink">{l.item_name ?? l.item_code}</div>
                          <div className="text-xs text-muted">
                            {[l.item_code, l.uom_code, l.batch_no ? `Batch ${l.batch_no}` : null]
                              .filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right tabular">{l.original_qty != null ? fmtQty(l.original_qty) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular">{l.previously_returned != null ? fmtQty(l.previously_returned) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular">{l.returnable_qty != null ? fmtQty(l.returnable_qty) : "—"}</td>
                        <td className={`py-2 pr-3 text-right font-semibold tabular ${over ? "text-bad" : ""}`}>
                          {fmtQty(l.quantity)}
                          {over && <div className="text-[10px] font-normal">over available</div>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular">{l.rate ? fmtMoney(l.rate) : "—"}</td>
                        <td className="py-2 text-right tabular">{l.amount ? fmtMoney(l.amount) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                <span className="text-muted">{doc.total_items} lines</span>
                <span className="text-ink">Qty <b className="tabular">{fmtQty(doc.total_qty)}</b></span>
                <span className="text-ink">Total <b className="tabular">₹ {fmtMoney(doc.total_value)}</b></span>
              </div>
            </div>
          )
        )}
      </Card>

      <div className="flex flex-wrap gap-3">
        {maySend && !isDraft && (
          <Button className={TONE_DEEP_MINT} disabled={!!blocked || send.isPending}
                  onClick={openSend}>
            {send.isPending ? "Sending…" : "Send to Vendor"}
          </Button>
        )}
        {isDraft && (
          <>
            <Button variant="soft" className={TONE_MINT}
                    onClick={() => navigate(`${basePath}/${doc.id}/edit`)}>
              Edit
            </Button>
            <Button className={TONE_DEEP_MINT} disabled={!!blocked || send.isPending}
                    onClick={openSend}>
              {send.isPending ? "Sending…" : "Send to Vendor"}
            </Button>
            {mayDelete && (
              <Button variant="soft" className={TONE_PINK} disabled={remove.isPending}
                      onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </>
        )}
        {/* A sent return is no longer a dead end, so this no longer says it is one.
            It states the two things that are still true — it went, and it cannot be
            edited or sent again — and leaves WHERE IT HAS GOT TO to the return-leg band
            above, which is the one place that words it. Saying it twice is how the
            screen would come to word one document two ways. */}
        {!isDraft && (
          <p className="text-sm text-muted">
            {doc.return_no} was sent to {vendorName ?? "the vendor"}
            {doc.sent_at ? ` on ${fmtDateTime(doc.sent_at)}` : ""} — it can no longer be
            edited or sent again.
            {doc.can_arrange_transport || doc.can_confirm_receipt
              || doc.awaiting_vendor_decision || doc.awaiting_vendor_settlement
              || doc.awaiting_vendor_transport || doc.awaiting_vendor_receipt
              || doc.awaiting_replacement_dispatch
              // …and the replacement's own intake, which is outstanding work on this
              // return long after every `awaiting_*` flag has gone quiet: the goods
              // receipt, its QC and its putaway. Without it the screen said nothing
              // happened next while the store still had three documents to work.
              || doc.replacement_intake_stage
              ? " What happens next is above."
              : ""}
          </p>
        )}
      </div>
      {isDraft && blocked && <p className="mt-2 text-xs text-muted">{blocked}</p>}

      <ConfirmModal
        isOpen={confirmSend}
        title="Send to Vendor?"
        message="Are you sure you want to send this Purchase Return to the Vendor?"
        confirmLabel="Send to Vendor"
        tone="warning"
        busy={send.isPending}
        confirmDisabled={!sendReason || remarksRequired}
        error={send.error}
        onConfirm={() => send.mutate()}
        onClose={() => { if (!send.isPending) setConfirmSend(false); }}
      >
        <p className="text-sm text-body">
          Returning <b>{fmtQty(doc.total_qty)}</b> across <b>{doc.total_items}</b> line(s)
          to <b>{vendorName ?? "the vendor"}</b>. This cannot be undone.
        </p>
        {/* The traced chain is named in full before the press, because pressing is what
            binds it to the document. */}
        {doc.chain_traced && (
          <p className="mt-2 text-xs text-amber-800">
            This will also bind the return to {grnNo ? <>GRN <b>{grnNo}</b></> : "the goods receipt"}
            {poNo ? <> / PO <b>{poNo}</b></> : ""} and vendor <b>{vendorName ?? "—"}</b>, read from
            the purchase behind this stock.
          </p>
        )}
        <div className="mt-3 space-y-3">
          <Field label="Return Reason" required>
            <Select
              value={sendReason}
              onChange={setSendReason}
              options={reasons.map((r) => ({ value: r.value, label: r.label }))}
              placeholder="Select reason"
              ariaLabel="Return reason"
            />
          </Field>
          {/* Said out loud rather than silently discarded: the draft's own wording is
              what the field wrote, and it is not one of the codes the vendor's copy
              carries. It stays in the remarks below. */}
          {!doc.reason_code && doc.reason && (
            <p className="text-xs text-muted">
              Raised as “{doc.reason_label ?? doc.reason}” — pick the reason code the
              vendor's copy should carry.
            </p>
          )}
          <Field label={sendReason === "OTHER" ? "Remarks / Notes (required for Other)" : "Remarks / Notes"}
                 required={sendReason === "OTHER"}>
            <Textarea
              value={sendRemarks}
              onChange={(event) => setSendRemarks(event.target.value)}
              placeholder="Enter remarks"
              aria-label="Remarks"
              isInvalid={remarksRequired}
            />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete this purchase return draft?"
        message={<><strong>{doc.return_no}</strong> will be removed permanently. It is still a draft, so nothing depends on it. This cannot be undone.</>}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
        onClose={() => { if (!remove.isPending) setConfirmDelete(false); }}
      />
    </div>
  );
}
