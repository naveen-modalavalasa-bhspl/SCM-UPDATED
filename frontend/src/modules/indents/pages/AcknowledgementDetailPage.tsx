import {
  useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Boxes, Camera, CheckCircle2, ChevronRight, Circle, ClipboardCheck, Eye, FileText,
  Loader2, Minus, PackageCheck, Plus, ScanBarcode, ShieldCheck, Trash2, Truck, UploadCloud,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader,
} from "@/shared/components";
import { SharedAttachmentViewer } from "@/shared/components/SharedAttachmentViewer";
import { Stepper, type Step } from "@/shared/components/Stepper";
import { SerialNumbersModal } from "@/modules/warehouse/components/SerialNumbersModal";
import { indentApi, indentKeys, useIndentAccountScope } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import { IndentSummaryStatusBadge } from "../components/IndentSummaryStatusBadge";
import type {
  Acknowledgement, AcknowledgementLine, RaiserTracking, ReceiptAttachment, ShipmentTrack,
} from "../types";
import {
  BILL, PHOTO, STAGE, STAGE_HINT, TRACKING, ShipmentCard, displayStatus, lineStage,
  onOrder, outstanding, qty, receivable,
} from "../components/acknowledgementParts";

/**
 * One indent's delivery, on its own page — the receipt desk.
 *
 * REBUILT 2026-09-18. The screen follows the physical act in the order it happens:
 * the consignment that carried the goods, the proof that they turned up, the count of
 * what is in the box — then one press. Four things were wrong with the shape it had:
 *
 *  - It was a rail inside a rail. A 280px consignment column held a list, and a 260px
 *    column inside THAT held the package list, which `receiptPackages` only ever put
 *    one row in. Two thirds of the width was navigation to a single destination, on
 *    the screen where the item grid needs the width most.
 *  - The upload pair was drawn TWICE — above the package and again in its header —
 *    both filing to the same place with their own counters beside them, so the page
 *    read as two separate demands for photographs.
 *  - Its colours were sixteen literal hexes (`#fff7ed`, `#f8fafc`, `#fbf7ef`, …).
 *    Those are values, not tokens: they do not flip in dark mode and they do not move
 *    when the brand does. Every surface here is now `content1/2/3`, `brand-050` or a
 *    status token, so this is the same page in both themes.
 *  - Nothing on it moved. The one number a person wants before pressing — how much of
 *    this indent am I about to settle — was only knowable by adding up the boxes by
 *    eye. `ReceiptMeter` states it and redraws as they are typed into.
 *
 * Everything the screen SAYS is still read off the server's own facts — `pending_with`,
 * `STAGE`, `TRACKING` — and shared with the list it was opened from, so a line cannot
 * be worded one way on the register and another way here.
 *
 * The receipt CONDITION question (good / damaged) was removed on the same date at the
 * business owner's request. `condition` is omitted from the request and the server
 * defaults it to GOOD (`indents.service._delivery_condition`), so nothing downstream
 * changed shape — but note that a damage claim can no longer be raised from this
 * screen, only from logistics.
 */
export default function AcknowledgementDetailPage() {
  const params = useParams();
  const nav = useNavigate();
  const indentId = Number(params.indentId);
  const qc = useQueryClient();
  const accountScope = useIndentAccountScope();

  const acknowledgements = useQuery({
    queryKey: ["indent-acknowledgements", {}],
    queryFn: () => indentApi.myAcknowledgements({}),
  });

  const row = useMemo<Acknowledgement | undefined>(
    () => (acknowledgements.data ?? []).find((item) => item.indent_id === indentId),
    [acknowledgements.data, indentId],
  );

  const back = { to: "/indents/acknowledgements", label: "Back to Acknowledgements" };

  if (acknowledgements.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Acknowledgement" back={back} />
        <ReceiptSkeleton />
      </div>
    );
  }

  if (!row) {
    return (
      <div className="space-y-4">
        <PageHeader title="Acknowledgement" back={back} />
        <ErrorBanner error={acknowledgements.error} />
        <Card className="p-4">
          <EmptyState
            title="This indent is not on your acknowledgements list"
            hint="It may belong to someone else, or it has not reached the delivery stage yet."
          />
        </Card>
      </div>
    );
  }

  return (
    <AcknowledgementDetail
      row={row}
      qc={qc}
      accountScope={accountScope}
      onDone={() => nav("/indents/acknowledgements")}
    />
  );
}

/** The two halves of the item list: what can be acted on, and the whole indent. */
type ManifestView = "arrived" | "all";

function AcknowledgementDetail({ row, onDone, accountScope, qc }: {
  row: Acknowledgement;
  onDone: () => void;
  accountScope: ReturnType<typeof useIndentAccountScope>;
  qc: QueryClient;
}) {
  const [received, setReceived] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      row.lines
        .filter((line) => receivable(line) > 0)
        .map((line) => [line.indent_item_id, String(receivable(line))]),
    ));
  const [openConsignment, setOpenConsignment] = useState("");
  const [view, setView] = useState<ManifestView>(
    row.lines.some((line) => receivable(line) > 0) ? "arrived" : "all",
  );
  const [serialTarget, setSerialTarget] = useState<AcknowledgementLine | null>(null);
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const [pickedSerials, setPickedSerials] = useState<Record<number, string[]>>(() =>
    Object.fromEntries(
      row.lines
        .filter((line) => (line.serial_numbers?.length ?? 0) > 0)
        .map((line) => [line.indent_item_id, line.serial_numbers ?? []]),
    ));

  const attachments = useQuery({
    queryKey: ["indent-receipt-attachments", row.indent_id],
    queryFn: () => indentApi.receiptAttachments(row.indent_id),
  });

  const tracking = useQuery({
    queryKey: indentKeys.shipments(accountScope, row.indent_id),
    queryFn: ({ signal }) => indentApi.shipmentsForIndent(row.indent_id, signal),
    refetchOnWindowFocus: true,
  });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      indentApi.uploadReceiptAttachment(row.indent_id, file, category),
    onSuccess: () => attachments.refetch(),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) => indentApi.deleteReceiptAttachment(attachmentId),
    onSuccess: () => attachments.refetch(),
  });

  const confirm = useMutation({
    // No `condition` — see the note on the module docstring. The server defaults it.
    mutationFn: () =>
      indentApi.acknowledge(
        row.indent_id,
        Object.entries(received)
          .map(([id, value]) => ({
            indent_item_id: Number(id),
            received_quantity: Number(value),
          }))
          .filter((line) => line.received_quantity > 0),
      ),
    onMutate: () => cancelIndentReceiptReads(qc, accountScope, row.indent_id),
    onSuccess: async (updated) => {
      await commitConfirmedIndentReceipt(qc, accountScope, updated);
      qc.invalidateQueries({ queryKey: ["indent-acknowledgements"] });
      qc.invalidateQueries({ queryKey: ["indent-fulfilment"] });
      onDone();
    },
  });

  const allAttachments = attachments.data ?? [];
  const photos = allAttachments.filter((a) => a.doc_category === PHOTO);
  const bills = allAttachments.filter((a) => a.doc_category === BILL);

  // Every figure the page states is derived here, once, and read from one object — the
  // hero, the meter, the manifest header and the sticky bar cannot disagree about how
  // much is arriving, which is what happens when four places each sum the same lines
  // their own way.
  const totals = useMemo(() => totalsOf(row.lines, received), [row.lines, received]);
  const entered = totals.entering > 0;
  const anythingToConfirm = totals.receivable > 0;
  const nothingSentYet = row.lines.every((line) => line.dispatched_quantity <= 0);
  const ready = entered && photos.length > 0;
  const arrivedLines = row.lines.filter((line) => receivable(line) > 0).length;

  const consignments = useMemo(
    () => receiptConsignments(row, tracking.data),
    [row, tracking.data],
  );
  const activeConsignment = consignments.find((item) => item.key === openConsignment)
    ?? consignments[0];

  const visibleLines = view === "arrived"
    ? row.lines.filter((line) => receivable(line) > 0)
    : row.lines;

  const uploadFile = (file: File, category: string) => upload.mutate({ file, category });
  const setLine = (id: number, value: string) =>
    setReceived((current) => ({ ...current, [id]: value }));
  const serialTargetRequired = serialTarget
    ? requiredSerialCount(serialTarget, received[serialTarget.indent_item_id] ?? "")
    : 0;
  const serialTargetAvailable = serialTarget?.serial_numbers?.filter(Boolean) ?? [];
  const serialTargetInitial = serialTarget
    ? serialPickForQuantity(
      serialTargetAvailable,
      pickedSerials[serialTarget.indent_item_id],
      serialTargetRequired,
    )
    : [];
  const fillAll = () =>
    setReceived(Object.fromEntries(
      row.lines
        .filter((line) => receivable(line) > 0)
        .map((line) => [line.indent_item_id, String(receivable(line))]),
    ));
  const clearAll = () => setReceived({});

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title={row.indent_no}
        back={{ to: "/indents/acknowledgements", label: "Back to Acknowledgements" }}
        actions={<IndentSummaryStatusBadge status={displayStatus(row)} />}
      />

      <ErrorBanner error={confirm.error ?? upload.error ?? remove.error} />

      <ReceiptHero
        row={row}
        totals={totals}
        photos={photos.length}
        bills={bills.length}
        consignments={consignments.length}
        anythingToConfirm={anythingToConfirm}
        nothingSentYet={nothingSentYet}
        entered={entered}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-4">
          <DeliveryPanel
            consignments={consignments}
            active={activeConsignment}
            onOpen={setOpenConsignment}
            loading={tracking.isLoading}
            refreshing={tracking.isFetching && !tracking.isLoading}
            failed={Boolean(tracking.error)}
          />

          <ManifestPanel
            lines={visibleLines}
            arrived={arrivedLines}
            total={row.lines.length}
            view={view}
            onView={setView}
            received={received}
            onChange={setLine}
            onFillAll={fillAll}
            onClearAll={clearAll}
            pickedSerials={pickedSerials}
            onPickSerials={setSerialTarget}
            actionable={anythingToConfirm}
          />
        </div>

        {/* The wrapper is the grid item and stretches to the row; the card inside it
            is what sticks. A sticky element can only travel inside its own parent, so
            with the card AS the grid item there was nowhere for it to go. */}
        <div className="xl:sticky xl:top-20 xl:self-start">
          <ProofPanel
            indentId={row.indent_id}
            photos={photos}
            bills={bills}
            attachments={allAttachments}
            uploadPending={upload.isPending}
            removePending={remove.isPending}
            onUpload={uploadFile}
            onDelete={(attachmentId) => remove.mutate(attachmentId)}
            onPreview={setPreviewAt}
            required={anythingToConfirm}
          />
        </div>
      </div>

      <ActionBar
        anythingToConfirm={anythingToConfirm}
        ready={ready}
        pending={confirm.isPending}
        entered={entered}
        hasPhoto={photos.length > 0}
        totals={totals}
        onCancel={onDone}
        onConfirm={() => confirm.mutate()}
      />

      <SerialNumbersModal
        isOpen={!!serialTarget}
        onClose={() => setSerialTarget(null)}
        itemLabel={serialTarget ? serialTarget.item_name ?? serialTarget.item_code ?? "" : ""}
        quantity={serialTargetRequired}
        available={serialTargetAvailable}
        initial={serialTargetInitial}
        pickMode="select"
        noun={serialTarget ? TRACKING[serialTarget.tracking_type ?? ""]?.unit ?? "serial" : "serial"}
        onSave={(serials) => {
          if (serialTarget) {
            setPickedSerials((current) => ({
              ...current,
              [serialTarget.indent_item_id]: serials,
            }));
          }
          setSerialTarget(null);
        }}
      />

      {previewAt !== null && allAttachments[previewAt] && (
        <SharedAttachmentViewer
          attachments={allAttachments}
          initialIndex={previewAt}
          onClose={() => setPreviewAt(null)}
          onDownload={(attachment) =>
            indentApi.downloadReceiptAttachment(row.indent_id, attachment.id)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the arithmetic */

interface Totals {
  approved: number;
  dispatched: number;
  /** Everything acknowledged on earlier receipts. */
  receivedSoFar: number;
  /** Still owed after everything acknowledged to date. */
  outstanding: number;
  /** Arrived and unconfirmed — the most this press could settle. */
  receivable: number;
  /** What is typed into the boxes right now, clamped to what each line may take. */
  entering: number;
  /** How many lines carry a quantity. */
  touched: number;
}

/**
 * Every number on the page, from one pass over the lines.
 *
 * `entering` is clamped PER LINE rather than summed raw: the box is a text field, and
 * a mistyped 100 against 10 arrived must not be announced at the top of the screen as
 * a hundred units on their way in. The save is still guarded server-side — this only
 * decides what the page says.
 */
function totalsOf(lines: AcknowledgementLine[], received: Record<number, string>): Totals {
  return lines.reduce<Totals>((sum, line) => {
    const max = receivable(line);
    const typed = Number(received[line.indent_item_id] ?? 0);
    const entering = Number.isFinite(typed) ? Math.min(Math.max(typed, 0), max) : 0;
    return {
      approved: sum.approved + Number(line.approved_quantity ?? 0),
      dispatched: sum.dispatched + Number(line.dispatched_quantity ?? 0),
      receivedSoFar: sum.receivedSoFar + Number(line.received_quantity ?? 0),
      outstanding: sum.outstanding + outstanding(line),
      receivable: sum.receivable + max,
      entering: sum.entering + entering,
      touched: sum.touched + (entering > 0 ? 1 : 0),
    };
  }, {
    approved: 0, dispatched: 0, receivedSoFar: 0, outstanding: 0,
    receivable: 0, entering: 0, touched: 0,
  });
}

function requiredSerialCount(line: AcknowledgementLine, value: string) {
  const serials = line.serial_numbers?.filter(Boolean) ?? [];
  if (serials.length === 0) return 0;
  const max = receivable(line);
  if (max <= 0) return serials.length;
  const typed = Math.floor(Number(value) || 0);
  return Math.min(Math.max(typed, 0), serials.length, Math.floor(max));
}

function serialPickForQuantity(
  available: string[],
  selected: string[] | undefined,
  required: number,
) {
  if (required <= 0) return [];
  const allowed = available.filter(Boolean);
  const allowedSet = new Set(allowed);
  const picked = (selected ?? []).filter((serial) => allowedSet.has(serial));
  const pickedSet = new Set(picked);
  const filled = [
    ...picked,
    ...allowed.filter((serial) => !pickedSet.has(serial)),
  ];
  return filled.slice(0, required);
}

/* ----------------------------------------------------------------------- the hero */

/**
 * What state this delivery is in, said once and said large.
 *
 * The rail underneath is the shared `Stepper` — the same four-dot vocabulary the PO,
 * the supplier portal and the send-to-vendor wizard use, so "done" looks the same here
 * as everywhere else in the product. Its steps are derived from live state, not from a
 * wizard position: attach a photo and the Proof dot fills, whichever order the work
 * was done in.
 */
function ReceiptHero({
  row, totals, photos, bills, consignments, anythingToConfirm, nothingSentYet, entered,
}: {
  row: Acknowledgement;
  totals: Totals;
  photos: number;
  bills: number;
  consignments: number;
  anythingToConfirm: boolean;
  nothingSentYet: boolean;
  entered: boolean;
}) {
  const tone = anythingToConfirm ? "brand" : nothingSentYet ? "neutral" : "ok";
  const headline = anythingToConfirm
    ? `${qty(totals.receivable)} waiting for your acknowledgement`
    : nothingSentYet
      ? "Nothing has reached you yet"
      : "Nothing left to acknowledge";
  const subline = anythingToConfirm
    ? "Check the consignment, attach a photo of what turned up, count what is in the box — then acknowledge once."
    : nothingSentYet
      ? "The consignment trail fills in as the warehouse issues and dispatches. The count unlocks the moment goods leave for you."
      : "Everything sent to you has been acknowledged. The proof filed against the receipt is kept below.";

  const nextAction = !anythingToConfirm
    ? "Receipt is closed"
    : photos <= 0
      ? "Attach delivery photo"
      : !entered
        ? "Count arrived items"
        : "Ready to acknowledge";

  const steps: Step[] = [
    {
      id: "delivery",
      label: "Consignment",
      status: nothingSentYet ? "current" : "complete",
      description: consignments === 1 ? "1 leg" : `${consignments} legs`,
    },
    {
      id: "proof",
      label: "Proof",
      status: photos > 0 ? "complete" : anythingToConfirm ? "current" : "upcoming",
      description: `${photos} photo${photos === 1 ? "" : "s"}${bills ? `, ${bills} bill` : ""}`,
    },
    {
      id: "count",
      label: "Count",
      status: entered ? "complete" : anythingToConfirm ? "current" : "upcoming",
      description: entered
        ? `${totals.touched} line${totals.touched === 1 ? "" : "s"}`
        : "Nothing counted",
    },
    {
      id: "sign",
      label: "Acknowledge",
      status: !anythingToConfirm
        ? "complete"
        : entered && photos > 0 ? "current" : "upcoming",
      description: anythingToConfirm ? "One press" : "Signed",
    },
  ];

  return (
    <Card className="overflow-hidden p-0">
      {/* The Bavya sweep, as a hairline. `.bg-brand` carries the four-stop gradient as
          a background IMAGE, so this is the brand itself rather than a colour chosen
          to look like it — and it re-tints with the brand rather than beside it. */}
      <div className="h-1 w-full bg-brand" aria-hidden />

      <div className="relative">
        {/* A brand-tinted glow rather than a literal gradient: `brand-050` re-points on
            `.dark`, so one rule paints both themes. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(860px_320px_at_100%_-45%,var(--color-brand-050),transparent_62%)]"
          aria-hidden
        />

        <div className="relative grid gap-0 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand-050 px-2.5 py-1 text-brand">
                <ScanBarcode className="h-3.5 w-3.5" /> Receipt desk
              </span>
              {row.project_name && (
                <span className="rounded-full bg-content2 px-2.5 py-1 text-muted">
                  {row.project_name}
                </span>
              )}
              {row.required_date && (
                <span className="rounded-full bg-content2 px-2.5 py-1 text-muted">
                  Needed by {row.required_date}
                </span>
              )}
            </div>

            <div className="mt-4 flex items-start gap-3">
              <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${
                tone === "brand"
                  ? "bg-brand-050 text-brand"
                  : tone === "ok" ? "bg-ok-bg text-ok" : "bg-neutral-bg text-neutral"
              }`}
              >
                {tone === "brand"
                  ? <PackageCheck className="h-6 w-6" />
                  : tone === "ok"
                    ? <CheckCircle2 className="h-6 w-6" />
                    : <Truck className="h-6 w-6" />}
              </span>
              <div className="min-w-0">
                <h2 className="font-display text-[22px] font-bold leading-tight text-ink sm:text-[26px]">
                  {headline}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-body">{subline}</p>
              </div>
            </div>

            <ReceiptMeter totals={totals} />
          </div>

          <div className="border-t border-line/70 bg-content2/35 p-4 lg:border-l lg:border-t-0">
            <div className="mb-3 rounded-xl border border-line bg-content1 p-3 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                Next action
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-ink">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                  !anythingToConfirm || (entered && photos > 0)
                    ? "bg-ok-bg text-ok"
                    : "bg-brand-050 text-brand"
                }`}
                >
                  {!anythingToConfirm || (entered && photos > 0)
                    ? <CheckCircle2 className="h-4 w-4" />
                    : <ScanBarcode className="h-4 w-4" />}
                </span>
                <span className="min-w-0 truncate">{nextAction}</span>
              </div>
            </div>

            <div className="mb-3 grid gap-2">
              <HeroGate
                icon={Truck}
                label="Consignment opened"
                met={!nothingSentYet}
                detail={consignments === 1 ? "1 leg available" : `${consignments} legs available`}
              />
              <HeroGate
                icon={ClipboardCheck}
                label="Photo proof"
                met={photos > 0}
                detail={photos > 0 ? `${photos} filed` : "Required before submit"}
              />
              <HeroGate
                icon={Boxes}
                label="Arrived quantity"
                met={entered || !anythingToConfirm}
                detail={entered ? `${qty(totals.entering)} counted` : "Waiting for count"}
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <HeroMetric label="Legs" value={consignments} icon={Truck} />
              <HeroMetric label="Items" value={row.lines.length} icon={Boxes} />
              <HeroMetric
                label="Proof"
                value={photos + bills}
                icon={ClipboardCheck}
                tone={photos > 0 ? "ok" : undefined}
              />
            </div>
            <p className="mt-3 rounded-xl bg-content2 px-3 py-2 text-[11px] leading-4 text-muted">
              One press closes this receipt. Photos and bills are evidence filed
              against it, never a second confirmation.
            </p>
          </div>
        </div>

        <div className="relative border-t border-line/70">
          <Stepper steps={steps} className="!py-3" />
        </div>
      </div>
    </Card>
  );
}

/**
 * The whole indent as one bar: acknowledged, arriving on this press, sent but not yet
 * counted, and the rest.
 *
 * Every band is measured against APPROVED, so the bar and the four figures beneath it
 * are the same facts read twice. The striped band is the only thing on the page that
 * moves while it is open, and that is the point: the question a person actually has
 * before pressing is "how much of this am I about to settle", and it used to be
 * answerable only by adding up the boxes by eye.
 */
function ReceiptMeter({ totals }: { totals: Totals }) {
  const base = totals.approved || 1;
  const pct = (value: number) => `${Math.min(100, Math.max(0, (value / base) * 100))}%`;
  const untyped = Math.max(totals.receivable - totals.entering, 0);

  return (
    <div className="mt-4">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-content3"
        role="img"
        aria-label={`${qty(totals.receivedSoFar)} of ${qty(totals.approved)} already `
          + `acknowledged, ${qty(totals.entering)} on this receipt`}
      >
        <span
          className="h-full bg-ok transition-[width] duration-500 ease-out"
          style={{ width: pct(totals.receivedSoFar) }}
        />
        {/* Striped, not solid: this band is a claim being typed, not a fact yet. */}
        <span
          className="h-full bg-brand/70 bg-[repeating-linear-gradient(135deg,transparent_0_5px,rgba(255,255,255,.4)_5px_10px)] transition-[width] duration-300 ease-out"
          style={{ width: pct(totals.entering) }}
        />
        <span
          className="h-full bg-brand/20 transition-[width] duration-300 ease-out"
          style={{ width: pct(untyped) }}
        />
      </div>
      <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
        <MeterFigure label="Approved" value={totals.approved} />
        <MeterFigure label="Acknowledged" value={totals.receivedSoFar} tone="text-ok" />
        <MeterFigure label="On this receipt" value={totals.entering} tone="text-brand" />
        <MeterFigure label="Still owed" value={totals.outstanding} />
      </dl>
    </div>
  );
}

function MeterFigure({ label, value, tone = "text-ink" }: {
  label: string; value: number; tone?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-semibold tabular-nums ${tone}`}>{qty(value)}</dd>
    </div>
  );
}

function HeroMetric({ label, value, icon: Icon, tone }: {
  label: string;
  value: number;
  icon: typeof Truck;
  tone?: "ok";
}) {
  return (
    <div className="rounded-xl border border-line/70 bg-content1 px-2 py-2.5 text-center shadow-sm">
      <span className={`mx-auto mb-1.5 grid h-7 w-7 place-items-center rounded-lg ${
        tone === "ok" ? "bg-ok-bg text-ok" : "bg-content2 text-muted"}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="font-display text-lg font-bold leading-none tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-1 truncate text-[10px] font-medium text-muted">{label}</div>
    </div>
  );
}

function HeroGate({ icon: Icon, label, met, detail }: {
  icon: typeof Truck;
  label: string;
  met: boolean;
  detail: string;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${
      met ? "border-ok/25 bg-ok-bg/50" : "border-line bg-content1"
    }`}
    >
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
        met ? "bg-ok text-white" : "bg-brand-050 text-brand"}`}
      >
        {met ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[10px] text-muted">{detail}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------- the delivery */

/**
 * How this indent travelled.
 *
 * The consignment list is a STRIP of chips and it is drawn only when there is more
 * than one leg. A 280px rail of navigation to a single destination was the old
 * screen's biggest waste of width.
 */
function DeliveryPanel({ consignments, active, onOpen, loading, refreshing, failed }: {
  consignments: ReceiptConsignment[];
  active?: ReceiptConsignment;
  onOpen: (key: string) => void;
  loading: boolean;
  refreshing: boolean;
  failed: boolean;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <SectionHead
        id="delivery"
        icon={Truck}
        title="How it travelled"
        hint="The leg that carried these goods, and the docket to chase it with."
        right={refreshing ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing
          </span>
        ) : consignments.length > 1 ? (
          <span className="text-[11px] text-muted">{consignments.length} legs</span>
        ) : null}
      />

      {consignments.length > 1 && (
        <div className="flex gap-2 overflow-x-auto border-b border-line bg-content2/60 px-3 py-2.5">
          {consignments.map((item, index) => {
            const on = active?.key === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={on}
                onClick={() => onOpen(item.key)}
                className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  on
                    ? "border-brand bg-brand-050 text-brand"
                    : "border-line bg-content1 text-body hover:border-brand/40"
                }`}
              >
                <span className={`grid h-6 w-6 place-items-center rounded-md text-[11px] font-bold ${
                  on ? "bg-brand/15 text-brand" : "bg-content2 text-muted"}`}
                >
                  {index + 1}
                </span>
                <span className="font-mono text-xs font-semibold">{item.no}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="p-3 sm:p-4">
        {loading ? (
          <div className="h-24 animate-pulse rounded-xl bg-content2" />
        ) : failed ? (
          <div className="rounded-xl border border-warn/30 bg-warn-bg px-3 py-3 text-xs text-warn">
            Tracking is temporarily unavailable. You can still acknowledge the receipt —
            the count and the proof below do not depend on it.
          </div>
        ) : !active?.leg ? (
          <div className="rounded-xl border border-dashed border-line bg-content2/50 px-3 py-5 text-center text-xs text-muted">
            No logistics shipment has been raised for this indent yet.
          </div>
        ) : (
          /* `ShipmentCard` is an <li> — it is shared with the list screen, where it
             sits in one. Wrapped rather than forked, so neither screen owns the
             other's markup. */
          <ul className="list-none">
            {isFullTracking(active.leg)
              ? <ShipmentCard leg={active.leg} />
              : <CompactShipmentCard leg={active.leg} />}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- the manifest */

function ManifestPanel({
  lines, arrived, total, view, onView, received, onChange, onFillAll, onClearAll,
  pickedSerials, onPickSerials, actionable,
}: {
  lines: AcknowledgementLine[];
  arrived: number;
  total: number;
  view: ManifestView;
  onView: (view: ManifestView) => void;
  received: Record<number, string>;
  onChange: (id: number, value: string) => void;
  onFillAll: () => void;
  onClearAll: () => void;
  pickedSerials: Record<number, string[]>;
  onPickSerials: (line: AcknowledgementLine) => void;
  actionable: boolean;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <SectionHead
        id="count"
        icon={Boxes}
        title="What is in the box"
        hint="Count each item against what was sent, and tick off the codes on the labels."
        right={(
          <div className="flex items-center gap-1 rounded-lg bg-content2 p-1">
            <ViewTab on={view === "arrived"} onClick={() => onView("arrived")}
                     label="Arrived" count={arrived} />
            <ViewTab on={view === "all"} onClick={() => onView("all")}
                     label="All items" count={total} />
          </div>
        )}
      />

      {actionable && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-content2/50 px-3 py-2.5 sm:px-4">
          <span className="text-[11px] font-medium text-muted">Everything turned up?</span>
          <button
            type="button"
            onClick={onFillAll}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-ok/40 bg-ok-bg px-3 text-xs font-semibold text-ok transition hover:border-ok focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ok/40"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Fill every line
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex min-h-9 items-center rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-body transition hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            Clear
          </button>
        </div>
      )}

      {lines.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="Nothing has arrived yet"
            hint="Switch to All items to see where each line of this indent has got to."
          />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {lines.map((line) => (
            <ManifestLine
              key={line.indent_item_id}
              line={line}
              value={received[line.indent_item_id] ?? ""}
              onChange={(value) => onChange(line.indent_item_id, value)}
              selectedSerials={pickedSerials[line.indent_item_id] ?? []}
              onPickSerials={() => onPickSerials(line)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ViewTab({ on, onClick, label, count }: {
  on: boolean; onClick: () => void; label: string; count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        on ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-body"}`}
    >
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
        on ? "bg-brand-050 text-brand" : "bg-content3 text-muted"}`}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * One item: where it has got to, and the box that says what turned up.
 *
 * The stage pill, its sentence and its hint are `STAGE` / `pending_with` /
 * `STAGE_HINT` — the same three the list row reads — so an item cannot be described
 * one way on the register and another way here. The green band of the bar includes
 * what is being TYPED, so the row fills as it is counted.
 */
function ManifestLine({ line, value, onChange, selectedSerials, onPickSerials }: {
  line: AcknowledgementLine;
  value: string;
  onChange: (value: string) => void;
  selectedSerials: string[];
  onPickSerials: () => void;
}) {
  const max = receivable(line);
  const approved = Number(line.approved_quantity ?? 0) || 1;
  const ordered = onOrder(line);
  const stage = lineStage(line);
  const { tone, icon: StageIcon } = STAGE[stage];
  const label = stage === "arrived" ? `${qty(max)} to acknowledge` : STAGE[stage].label;
  const serials = line.serial_numbers?.filter(Boolean) ?? [];
  const tracking = TRACKING[line.tracking_type ?? ""]
    ?? (line.is_serial_tracked ? TRACKING.SERIAL : null);
  const typed = Math.min(Math.max(Number(value) || 0, 0), max);
  const requiredSerials = requiredSerialCount(line, value);
  const countedSerials = serialPickForQuantity(serials, selectedSerials, requiredSerials);
  const serialComplete = requiredSerials > 0 && countedSerials.length === requiredSerials;
  const serialMessage = requiredSerials <= 0
    ? "Enter an arrived quantity before selecting codes"
    : serialComplete
      ? `${requiredSerials} matched against the labels`
      : `${countedSerials.length} of ${requiredSerials} matched - open to tick `
        + `off each ${(tracking ?? TRACKING.SERIAL).unit}`;
  const width = (amount: number) =>
    `${Math.min(100, Math.max(0, (Number(amount ?? 0) / approved) * 100))}%`;

  return (
    <li className={`p-3 transition-colors sm:p-4 ${typed > 0 ? "bg-brand-050/40" : ""}`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-ink">{line.item_name ?? line.item_code}</div>
              <div className="font-mono text-[11px] text-muted">{line.item_code}</div>
            </div>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
              <StageIcon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </span>
          </div>

          {/* Same band order as the hero meter, per line. On order is a promise from
              procurement rather than progress, so it starts where the physical bands
              END instead of being drawn over them — overlapping showed a line that was
              fully accounted for as three quarters of a bar. */}
          <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-content3">
            <div
              className="absolute inset-y-0 bg-warn/40"
              style={{ left: width(line.issued_quantity), width: width(ordered) }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-brand/20"
              style={{ width: width(line.issued_quantity) }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-brand/45"
              style={{ width: width(line.dispatched_quantity) }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-ok transition-[width] duration-300 ease-out"
              style={{ width: width(Number(line.received_quantity ?? 0) + typed) }}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            <span>Approved <b className="font-semibold tabular-nums text-ink">
              {qty(line.approved_quantity)}</b></span>
            {ordered > 0 && (
              <span>On order <b className="font-semibold tabular-nums text-warn">
                {qty(ordered)}</b></span>
            )}
            <span>Sent <b className="font-semibold tabular-nums text-ink">
              {qty(line.dispatched_quantity)}</b></span>
            <span>Received <b className="font-semibold tabular-nums text-ink">
              {qty(line.received_quantity)}</b></span>
          </div>

          {outstanding(line) > 0 && (
            <div className="mt-1.5 text-[11px] text-muted">
              <span className="font-medium text-body">
                {line.pending_with || STAGE[stage].caption}
              </span>
              {STAGE_HINT[stage] && <span className="mt-0.5 block">{STAGE_HINT[stage]}</span>}
            </div>
          )}
        </div>

        {max > 0 ? (
          <QuantityBox
            max={max}
            value={value}
            onChange={onChange}
            uom={line.uom_code}
            label={line.item_name ?? line.item_code ?? "this item"}
          />
        ) : (
          <div className="grid place-items-center rounded-xl border border-dashed border-line bg-content2/50 px-3 py-4 text-center text-[11px] text-muted">
            Nothing to confirm on this line yet.
          </div>
        )}
      </div>

      {serials.length > 0 && (
        <button
          type="button"
          onClick={onPickSerials}
          disabled={requiredSerials <= 0}
          className={`mt-3 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            serialComplete
              ? "border-ok/35 bg-ok-bg/60 hover:border-ok"
              : "border-line bg-content2/60 hover:border-brand/40 disabled:cursor-not-allowed disabled:opacity-60"
          }`}
        >
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            serialComplete ? "bg-ok text-white" : "bg-content1 text-muted"}`}
          >
            {serialComplete ? <ShieldCheck className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-body">
              {(tracking ?? TRACKING.SERIAL).heading}
            </span>
            <span className="block text-[11px] text-muted">{serialMessage}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
        </button>
      )}
    </li>
  );
}

/**
 * The count for one line: minus, the figure, plus, and the whole of what arrived.
 *
 * A bare number field is fine at a desk and poor in a warehouse — the person doing
 * this is holding a box. The steppers are 44px, the field is still typeable, and
 * "All" is the right answer almost every time, so it is one press rather than a
 * keystroke. The box changes colour at nothing / part / all, which is the fastest
 * read down a long manifest.
 */
function QuantityBox({ max, value, onChange, uom, label }: {
  max: number;
  value: string;
  onChange: (value: string) => void;
  uom?: string | null;
  label: string;
}) {
  const current = Math.min(Math.max(Number(value) || 0, 0), max);
  const full = current === max && current > 0;
  const step = (delta: number) =>
    onChange(String(Math.min(Math.max(current + delta, 0), max)));

  return (
    <div className={`rounded-xl border p-2.5 transition ${
      full
        ? "border-ok/40 bg-ok-bg/50"
        : current > 0 ? "border-brand/35 bg-content1" : "border-line bg-content2/60"
    }`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Arrived now
        </span>
        <span className="text-[11px] tabular-nums text-muted">
          of {qty(max)}{uom ? ` ${uom}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <StepButton onClick={() => step(-1)} disabled={current <= 0}
                    label={`One less of ${label}`}>
          <Minus className="h-4 w-4" />
        </StepButton>
        <div className="min-w-0 flex-1">
          <Input
            type="number"
            min={0}
            max={max}
            step="any"
            aria-label={`Received now for ${label}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <StepButton onClick={() => step(1)} disabled={current >= max}
                    label={`One more of ${label}`}>
          <Plus className="h-4 w-4" />
        </StepButton>
      </div>
      <button
        type="button"
        onClick={() => onChange(String(max))}
        disabled={full}
        className={`mt-1.5 h-9 w-full rounded-lg border text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
          full
            ? "border-ok/40 bg-ok-bg text-ok"
            : "border-line bg-content1 text-brand hover:border-brand hover:bg-brand-050"
        }`}
      >
        {full ? "All of it" : `All ${qty(max)}`}
      </button>
    </div>
  );
}

function StepButton({ onClick, disabled, label, children }: {
  onClick: () => void; disabled: boolean; label: string; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line bg-content1 text-body transition hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40 disabled:hover:border-line disabled:hover:text-body"
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- the proof */

/**
 * The evidence, filed once.
 *
 * It used to be drawn twice — above the package and again inside its header — both
 * filing to the same place with their own counters, which read as two separate
 * demands for photographs. One dock, in the column beside the count and sticky to the
 * viewport on a wide screen, so the thing the press is blocked on stays in sight
 * while the manifest is being worked down.
 */
function ProofPanel({
  indentId, photos, bills, attachments, uploadPending, removePending,
  onUpload, onDelete, onPreview, required,
}: {
  indentId: number;
  photos: ReceiptAttachment[];
  bills: ReceiptAttachment[];
  attachments: ReceiptAttachment[];
  uploadPending: boolean;
  removePending: boolean;
  onUpload: (file: File, category: string) => void;
  onDelete: (attachmentId: number) => void;
  onPreview: (index: number) => void;
  required: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const missingPhoto = required && photos.length === 0;
  // A dropped file carries no category, so it is read off the file itself: a picture
  // is what the goods looked like, anything else is paperwork that came with them.
  const drop = (files: FileList | null) => {
    Array.from(files ?? []).forEach((file) =>
      onUpload(file, file.type.startsWith("image/") ? PHOTO : BILL));
  };

  return (
    <Card className={`overflow-hidden p-0 ${missingPhoto ? "ring-1 ring-bad/25" : ""}`}>
      <SectionHead
        id="proof"
        icon={ClipboardCheck}
        title="Proof of receipt"
        hint="What the goods looked like, and any bill that came with them."
        right={missingPhoto ? (
          <span className="rounded-full bg-bad-bg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-bad">
            Photo required
          </span>
        ) : null}
      />

      <div className="p-3 sm:p-4">
        <div
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            drop(event.dataTransfer.files);
          }}
          className={`rounded-xl border-2 border-dashed px-3 py-5 text-center transition ${
            dragging
              ? "border-brand bg-brand-050"
              : missingPhoto
                ? "border-bad/35 bg-bad-bg/40"
                : "border-line bg-content2/50"}`}
        >
          <span className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-content1 text-brand shadow-sm">
            {uploadPending
              ? <Loader2 className="h-5 w-5 animate-spin" />
              : <UploadCloud className="h-5 w-5" />}
          </span>
          <div className="text-xs font-semibold text-ink">
            {uploadPending ? "Uploading…" : "Drop a photo or a bill here"}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            Pictures file as proof of the goods, anything else as paperwork.
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <UploadButton label="Take a photo" icon={<Camera className="h-4 w-4" />}
                          accept="image/*" category={PHOTO} onUpload={onUpload} />
            <UploadButton label="Add a bill" icon={<FileText className="h-4 w-4" />}
                          accept="image/*,application/pdf" category={BILL} onUpload={onUpload} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <ProofChip met={photos.length > 0}
                     label={`${photos.length} photo${photos.length === 1 ? "" : "s"}`} />
          <ProofChip met={bills.length > 0}
                     label={`${bills.length} bill${bills.length === 1 ? "" : "s"}`} />
        </div>

        {attachments.length === 0 ? (
          <p className="mt-3 rounded-lg bg-content2/60 px-3 py-2 text-[11px] leading-4 text-muted">
            A photo of what arrived is what this receipt is later checked against.
            Nothing is filed against it yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attachments.map((attachment, index) => (
              <ProofRow
                key={attachment.id}
                indentId={indentId}
                attachment={attachment}
                busy={removePending}
                onOpen={() => onPreview(index)}
                onDelete={() => onDelete(attachment.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * One filed document, with its own thumbnail.
 *
 * Fetched through the module's own gated route — nested under the indent, which is
 * the only door the backend checks this login's visibility on — once per file and
 * only for images. A list of file NAMES is not proof anybody can check, and the
 * commonest mistake on this screen is filing the picture of the wrong pallet.
 */
function ProofRow({ indentId, attachment, busy, onOpen, onDelete }: {
  indentId: number;
  attachment: ReceiptAttachment;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const isBill = attachment.doc_category === BILL;
  const isImage = (attachment.mime_type ?? "").startsWith("image/");
  const [thumb, setThumb] = useState<string | null>(null);
  // Guarded against the unmount that happens when a row is deleted mid-fetch: without
  // it the object URL is created AFTER the cleanup that was meant to revoke it, and
  // the blob is held for the life of the tab.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let url = "";
    if (isImage) {
      indentApi.downloadReceiptAttachment(indentId, attachment.id)
        .then((blob) => {
          if (!alive.current) return;
          url = URL.createObjectURL(blob);
          setThumb(url);
        })
        .catch(() => undefined);
    }
    return () => {
      alive.current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [indentId, attachment.id, isImage]);

  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-line bg-content1 p-2">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${attachment.file_name}`}
        className="group relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-content2 text-muted transition hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {thumb
          ? <img src={thumb} alt="" className="h-full w-full object-cover" />
          : isBill ? <FileText className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
        <span className="absolute inset-0 grid place-items-center bg-ink/55 text-white opacity-0 transition group-hover:opacity-100">
          <Eye className="h-4 w-4" />
        </span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left focus-visible:outline-none"
      >
        <span className="block truncate text-xs font-medium text-ink">
          {attachment.file_name}
        </span>
        <span className="block text-[10px] uppercase tracking-wide text-muted">
          {isBill ? "Bill" : "Photo"}
          {attachment.created_at ? ` · ${attachment.created_at.slice(0, 10)}` : ""}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${attachment.file_name}`}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-bad-bg hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bad/40 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

/* ----------------------------------------------------------------- the one press */

/**
 * The bar that never leaves the screen.
 *
 * The checklist used to sit in a card of its own, several screens above the button it
 * governed, so "why is this disabled" was answered somewhere the reader was not
 * looking. Each requirement is a chip beside the press now, and each one JUMPS to the
 * section it is asking for — which is the whole of its job on a phone, where the
 * proof dock has stacked below a long manifest.
 */
function ActionBar({
  anythingToConfirm, ready, pending, entered, hasPhoto, totals, onCancel, onConfirm,
}: {
  anythingToConfirm: boolean;
  ready: boolean;
  pending: boolean;
  entered: boolean;
  hasPhoto: boolean;
  totals: Totals;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const readiness = !anythingToConfirm ? 100
    : ((entered ? 1 : 0) + (hasPhoto ? 1 : 0)) * 50;

  return (
    <div className="sticky bottom-0 z-20 border-t border-line bg-chrome-strong px-2 py-2.5 shadow-[0_-10px_30px_-24px_var(--color-ink)] backdrop-blur sm:px-3">
      {anythingToConfirm && (
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-content3">
          <div
            className="h-full bg-brand transition-[width] duration-300 ease-out"
            style={{ width: `${readiness}%` }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {anythingToConfirm && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <ReadyChip met={entered} label="Quantity counted" onJump={() => jump("count")} />
            <ReadyChip met={hasPhoto} label="Photo attached" onJump={() => jump("proof")} />
            {ready && (
              <span className="text-[11px] font-medium text-body">
                Acknowledging{" "}
                <b className="tabular-nums text-ink">{qty(totals.entering)}</b>
                {" "}across {totals.touched} line{totals.touched === 1 ? "" : "s"}.
              </span>
            )}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="subtle" onClick={onCancel}>
            {anythingToConfirm ? "Cancel" : "Back"}
          </Button>
          {anythingToConfirm && (
            <Button onClick={onConfirm} disabled={!ready || pending}>
              {pending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CheckCircle2 className="h-4 w-4" />}
              {pending ? "Confirming…" : "Acknowledge receipt"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One thing standing between the reader and the press — and the way to it. */
function ReadyChip({ met, label, onJump }: {
  met: boolean; label: string; onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        met
          ? "border-ok/30 bg-ok-bg text-ok"
          : "border-bad/30 bg-bad-bg text-bad hover:border-bad"
      }`}
    >
      {met ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

/* ----------------------------------------------------------------------- the bits */

/** One section's title bar. The `id` is what the sticky bar's chips scroll to. */
function SectionHead({ id, icon: Icon, title, hint, right }: {
  id?: string;
  icon: typeof Truck;
  title: string;
  hint: string;
  right?: ReactNode;
}) {
  return (
    <div
      id={id}
      className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-content1 px-3 py-3 sm:px-4"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-050 text-brand">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{title}</div>
          <div className="text-[11px] text-muted">{hint}</div>
        </div>
      </div>
      {right}
    </div>
  );
}

function UploadButton({ label, icon, accept, category, onUpload }: {
  label: string;
  icon: ReactNode;
  accept: string;
  category: string;
  onUpload: (file: File, category: string) => void;
}) {
  return (
    <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-content1 px-3 py-2 text-xs font-semibold text-body shadow-sm transition hover:border-brand hover:bg-brand-050 hover:text-brand">
      {icon}
      {label}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file, category);
          event.target.value = "";
        }}
      />
    </label>
  );
}

function ProofChip({ met, label }: { met: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold ${
      met ? "bg-ok-bg text-ok" : "bg-content2 text-muted"
    }`}
    >
      {met ? <ShieldCheck className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

/** The shape of the page while the list it is read from is still in flight. A spinner
 *  says "wait"; this says what is about to be there, which is the difference between a
 *  page that feels slow and one that feels like it is loading. */
function ReceiptSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Block className="h-44" />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-4">
          <Block className="h-32" />
          <Block className="h-72" />
        </div>
        <Block className="h-64" />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the consignments */

type ReceiptLeg = (RaiserTracking | ShipmentTrack) & { consignment_no?: string | null };

interface ReceiptConsignment {
  key: string;
  no: string;
  leg?: ReceiptLeg;
}

/** The live tracking read if logistics answered, the row's own snapshot otherwise. */
function receiptConsignments(
  row: Acknowledgement,
  liveTracking?: RaiserTracking[],
): ReceiptConsignment[] {
  const legs: ReceiptLeg[] = (liveTracking?.length ? liveTracking : row.shipments) ?? [];
  if (legs.length === 0) return [{ key: "direct", no: row.indent_no }];
  return legs.map((leg, index) => ({
    key: `leg-${leg.tr_id ?? index}`,
    no: leg.consignment_no || leg.tr_no || `Consignment ${index + 1}`,
    leg,
  }));
}

function isFullTracking(leg?: ReceiptLeg): leg is RaiserTracking {
  return Boolean(leg && "events" in leg);
}

/** What an older tracking shape can fill: no event trail, so no timeline to draw. */
function CompactShipmentCard({ leg }: { leg: ReceiptLeg }) {
  const handle = leg.lr_no ?? leg.docket_no ?? null;
  const who = leg.carrier_name
    || [leg.vehicle_number, leg.driver_name].filter(Boolean).join(" · ");
  return (
    <li className="rounded-xl border border-line bg-content1 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-050 text-brand">
          <Truck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs font-semibold text-ink">{leg.tr_no}</span>
            <span className="text-[11px] uppercase tracking-wide text-muted">
              {leg.status.replace(/_/g, " ").toLowerCase()}
            </span>
          </div>
          <div className="text-sm text-body">{who || "Hand delivery"}</div>
          {handle && (
            <div className="mt-0.5 text-xs text-muted">
              Docket <span className="font-mono text-ink">{handle}</span>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** One pulsing panel of the skeleton, at the size the real one lands at. */
function Block({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl border border-line/70 bg-content2 ${className}`}
    />
  );
}
