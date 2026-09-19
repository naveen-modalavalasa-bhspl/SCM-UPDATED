import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Barcode, Camera, Check, CheckCircle2, Circle,
  Eye, FileText, Package, Ruler, ScanBarcode, Snowflake, Trash2, Truck, Weight,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader, SharedAttachmentViewer,
} from "@/shared/components";
import { SerialNumbersModal } from "@/modules/warehouse/components/SerialNumbersModal";
import { TrackingBadge, useTrackingMeta } from "@/modules/warehouse/components/TrackingBadge";
import type { TrackingType } from "@/modules/warehouse/types";
import { indentApi, indentKeys, useIndentAccountScope } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import type {
  Acknowledgement, AcknowledgementLine, AcknowledgementPackageQuantity,
  RaiserTracking, ReceiptAttachment, ShipmentTrack,
} from "../types";
import {
  BILL, PHOTO, STAGE, STAGE_HINT, ShipmentCard, TRACKING, lineStage, onOrder, qty,
  receivable,
} from "../components/acknowledgementParts";

/**
 * One indent's delivery, walked the way the delivery itself happens.
 *
 * REDESIGNED 2026-09-19. The screen used to put the whole receipt on one page — a
 * consignment list, a package list inside it, a manifest inside that, and one proof
 * dock above the lot. Three nested selections were on screen at once and none of them
 * said what to do next, so the two things a person actually does at a delivery — look
 * at the load before opening it, then open each package and count what is in it —
 * were somewhere inside a layout rather than being the shape of the screen.
 *
 * It is a JOURNEY now: the handover, then one stop per package, then sign off. One
 * stop is on screen at a time and the rail above says where you are, so the page asks
 * exactly one question at each point. Nothing is locked — every stop on the rail is a
 * button, because a delivery is not a wizard and somebody re-checking package two is
 * not doing anything wrong.
 *
 * **Every stop keeps its OWN photo and bill.** The proof of a sealed load and the
 * proof of what was inside a particular carton are different evidence, and they used
 * to land in one pile: both packages read "1 photo" when one of them had been
 * photographed, and a dispute over carton two was answered with a picture of carton
 * one. The package rides on `doc_category` as a scope (`RECEIPT_PHOTO::P-<key>`,
 * `service.ack_category_base` in the backend) because `sys_attachments` has no column
 * for it and adding one is a platform change for a fact only this screen has.
 *
 * The receipt action itself is unchanged and still single: one press, at the end,
 * over everything counted at every stop.
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
        <Card className="p-6 text-sm text-muted">Loading...</Card>
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

/* ---------------------------------------------------------------------------
 * The journey: one stop per thing a person physically does.
 * ------------------------------------------------------------------------ */

type StopKind = "gate" | "package" | "review";

interface Stop {
  key: string;
  kind: StopKind;
  /** What the rail calls it — the consignment number, the package number, "Sign off". */
  label: string;
  /** The same stop in the words of somebody who has never used the system: "The
   *  delivery", "Package 1 of 2", "Finish". The code is what the DOCUMENT is called;
   *  a person standing at a pallet needs to be told which of four things he is on. */
  plain: string;
  /** Which pile of proof is this stop's own. "" is the whole receipt (the sign-off). */
  scope: string;
  consignment?: ReceiptConsignment;
  pack?: ReceiptPackage;
  /** The first handover also shows proof filed before this screen scoped anything. */
  legacyProof?: boolean;
}

function journeyStops(consignments: ReceiptConsignment[]): Stop[] {
  const stops: Stop[] = [];
  const packageCount = consignments.reduce(
    (sum, consignment) => sum + consignment.packages.length, 0);
  let packageNo = 0;
  consignments.forEach((consignment, index) => {
    stops.push({
      key: `gate-${consignment.key}`,
      kind: "gate",
      label: consignment.no,
      // "The consignment" and not "the delivery": what is being photographed here is
      // the consignment the warehouse despatched, the document whose number is
      // printed on the paperwork in the driver's hand, and the photos are filed
      // against it. A generic word for it left the storekeeper matching a picture to
      // nothing in particular.
      plain: consignments.length > 1 ? `Consignment ${index + 1}` : "The consignment",
      scope: proofScope("C", consignment.key),
      consignment,
      legacyProof: index === 0,
    });
    consignment.packages.forEach((pack) => {
      packageNo += 1;
      stops.push({
        key: `pack-${consignment.key}-${pack.key}`,
        kind: "package",
        label: pack.no,
        // Numbered across the WHOLE delivery, not within its consignment: the person
        // opening cartons is counting cartons, and "Package 1 of 2" twice on one
        // screen reads as the same carton listed twice.
        plain: packageCount > 1 ? `Package ${packageNo} of ${packageCount}` : "The package",
        scope: proofScope("P", pack.key),
        consignment,
        pack,
      });
    });
  });
  stops.push({
    key: "review", kind: "review", label: "Sign off", plain: "Finish", scope: "",
  });
  return stops;
}

/** One thing that has to be true before a stop is finished, and whether it is. */
interface StepTask {
  done: boolean;
  /** An instruction, not a noun: "Photograph this package", never "Photo". */
  label: string;
}

function AcknowledgementDetail({ row, onDone, accountScope, qc }: {
  row: Acknowledgement;
  onDone: () => void;
  accountScope: ReturnType<typeof useIndentAccountScope>;
  qc: QueryClient;
}) {
  const [received, setReceived] = useState<Record<string, string>>(() =>
    initialReceivedByReceiptLine(row.lines));
  const [stopKey, setStopKey] = useState("");
  const [serialTarget, setSerialTarget] = useState<ReceiptPackageLine | null>(null);
  const [pickedSerials, setPickedSerials] = useState<Record<string, string[]>>({});
  const [viewing, setViewing] = useState<
    { files: ReceiptAttachment[]; index: number } | null>(null);

  const trackingMeta = useTrackingMeta();

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
    mutationFn: () =>
      indentApi.acknowledge(
        row.indent_id,
        acknowledgementPayload(row.lines, received),
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
  // The server's own rule for "is there proof": any photo of this delivery, whichever
  // stop it was taken at. Read through `attachmentBase`, so a package photo counts.
  const anyPhoto = allAttachments.some(
    (file) => attachmentBase(file.doc_category) === PHOTO);
  const anythingToConfirm = row.lines.some((line) => receivable(line) > 0);
  const waiting = row.lines.reduce((sum, line) => sum + receivable(line), 0);
  const nothingSentYet = row.lines.every((line) => line.dispatched_quantity <= 0);
  const receivingSummary = useMemo(() => {
    const payload = acknowledgementPayload(row.lines, received);
    return {
      quantity: payload.reduce((sum, line) => sum + line.received_quantity, 0),
      lines: payload.length,
      byLine: new Map(payload.map((line) => [line.indent_item_id, line.received_quantity])),
    };
  }, [row.lines, received]);
  const entered = receivingSummary.quantity > 0;
  const ready = entered && anyPhoto;

  const consignments = useMemo(
    () => receiptConsignments(row, tracking.data),
    [row, tracking.data],
  );
  const stops = useMemo(() => journeyStops(consignments), [consignments]);
  const activeIndex = Math.max(stops.findIndex((item) => item.key === stopKey), 0);
  const stop = stops[activeIndex];

  /** This stop's own proof, and — on the first handover only — anything filed before
   *  the scope existed, so nothing an earlier receipt attached disappears from view. */
  const proofFor = (target: Stop) => allAttachments.filter((file) => {
    if (target.kind === "review") return true;
    const scope = attachmentScope(file.doc_category);
    return scope === target.scope || (Boolean(target.legacyProof) && scope === "");
  });

  const countedFor = (pack?: ReceiptPackage) => {
    const lines = (pack?.lines ?? []).filter(
      (line) => Number(line.package_quantity ?? receivable(line)) > 0);
    const done = lines.filter(
      (line) => receivedNumber(received[line.receipt_key]) > 0).length;
    return { total: lines.length, done };
  };

  /**
   * What this stop still needs, in the words of the person standing at the delivery.
   *
   * These rules used to live only inside `stopDone`, so a grey circle on the rail was
   * the entire explanation: it said a step was unfinished and never WHICH of the two
   * things had not been done, and the only way to find out was to open the step and
   * guess. One list answers both questions now -- the strip on the card renders it and
   * `stopDone` is simply "every task ticked" -- so the tick and the to-do list cannot
   * drift apart the way two copies of a rule always eventually do.
   */
  const tasksFor = (target: Stop): StepTask[] => {
    const files = proofFor(target);
    const hasPhoto = files.some((file) => attachmentBase(file.doc_category) === PHOTO);
    if (target.kind === "gate") {
      return [{
        done: hasPhoto,
        label: "Photograph the consignment as it was received",
      }];
    }
    if (target.kind === "package") {
      const counted = countedFor(target.pack);
      // Nothing receivable in this package: it is finished by having nothing to do,
      // and asking for a photo of it would block a delivery over an empty carton.
      if (counted.total === 0) {
        return [{ done: true, label: "Nothing in this package is waiting on you" }];
      }
      return [
        {
          done: counted.done === counted.total,
          label: counted.total === 1
            ? "Enter how many arrived"
            : `Enter how many arrived, for all ${counted.total} items`,
        },
        { done: hasPhoto, label: "Photograph this package" },
      ];
    }
    return [
      { done: entered, label: "Count at least one item" },
      { done: anyPhoto, label: "Attach at least one photo" },
    ];
  };

  const stopDone = (target: Stop): boolean =>
    tasksFor(target).every((task) => task.done);

  const uploadFile = (scope: string) => (file: File, base: string) =>
    upload.mutate({ file, category: scopedCategory(base, scope) });

  const go = (index: number) =>
    setStopKey(stops[Math.min(Math.max(index, 0), stops.length - 1)].key);

  const stopFiles = proofFor(stop);
  const packageStops = stops.filter((item) => item.kind === "package");
  const nextStop = stops[activeIndex + 1];
  /** Why the sign-off is unavailable, in the order the person has to fix it. A
   *  disabled button with nothing beside it is the single most common way a screen
   *  strands somebody who does not already know the rule. */
  const blocker = !anythingToConfirm || ready
    ? null
    : !entered
      ? "Enter how many arrived before you can acknowledge"
      : "Attach at least one photo before you can acknowledge";

  return (
    <div className="space-y-4">
      <PageHeader
        title={row.indent_no}
        back={{ to: "/indents/acknowledgements", label: "Back to Acknowledgements" }}
      />

      <ErrorBanner error={confirm.error ?? upload.error ?? remove.error} />

      {/* The one strip of chrome on the page: who this is for, and where you are.
          A progress bar under a step rail was the same fact drawn twice. */}
      <div className="rounded-3xl bg-content1 px-5 py-4 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:px-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            Receiving
            {row.project_name && (
              <span className="ml-2 normal-case tracking-normal">{row.project_name}</span>
            )}
          </span>
          <span className="text-[11px] tabular-nums text-muted">
            Step {activeIndex + 1} of {stops.length}
          </span>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-body">
          {anythingToConfirm
            ? `${qty(waiting)} still to be received. Nothing is recorded until you sign at the last step.`
            : nothingSentYet
              ? "Nothing has been sent to you yet, so there is nothing to count."
              : "Everything sent to you has already been acknowledged."}
        </p>

        <JourneyRail
          stops={stops}
          activeIndex={activeIndex}
          isDone={stopDone}
          onJump={go}
        />
      </div>

      {stop.kind === "gate" && (
        <GateStop
          stop={stop}
          stepNo={activeIndex + 1}
          stepTotal={stops.length}
          indentId={row.indent_id}
          tasks={tasksFor(stop)}
          files={stopFiles}
          loading={tracking.isLoading}
          failed={Boolean(tracking.error)}
          uploadPending={upload.isPending}
          removePending={remove.isPending}
          onUpload={uploadFile(stop.scope)}
          onView={(files, index) => setViewing({ files, index })}
          onDelete={(id) => remove.mutate(id)}
          onOpenPackage={(pack) => {
            const target = stops.findIndex(
              (item) => item.kind === "package" && item.pack?.key === pack.key);
            if (target >= 0) go(target);
          }}
          packageLabel={(pack) => stops.find(
            (item) => item.kind === "package" && item.pack?.key === pack.key)?.plain ?? pack.no}
          packageProgress={(pack) => {
            const target = stops.find(
              (item) => item.kind === "package" && item.pack?.key === pack.key);
            const counted = countedFor(pack);
            const files = target ? proofFor(target) : [];
            return {
              done: target ? stopDone(target) : false,
              countedDone: counted.done,
              countedTotal: counted.total,
              photos: files.filter(
                (file) => attachmentBase(file.doc_category) === PHOTO).length,
            };
          }}
        />
      )}

      {stop.kind === "package" && stop.pack && (
        <PackageStop
          pack={stop.pack}
          stepNo={activeIndex + 1}
          stepTotal={stops.length}
          indentId={row.indent_id}
          tasks={tasksFor(stop)}
          position={packageStops.findIndex((item) => item.key === stop.key) + 1}
          total={packageStops.length}
          files={stopFiles}
          received={received}
          counted={countedFor(stop.pack)}
          pickedSerials={pickedSerials}
          uploadPending={upload.isPending}
          removePending={remove.isPending}
          onUpload={uploadFile(stop.scope)}
          onView={(files, index) => setViewing({ files, index })}
          onDelete={(id) => remove.mutate(id)}
          onChange={(key, value) =>
            setReceived((current) => ({ ...current, [key]: value }))}
          onPickSerials={setSerialTarget}
        />
      )}

      {stop.kind === "review" && (
        <ReviewStop
          row={row}
          stepNo={activeIndex + 1}
          stepTotal={stops.length}
          tasks={tasksFor(stop)}
          stops={stops}
          proofFor={proofFor}
          isDone={stopDone}
          onJump={(target) => go(stops.findIndex((item) => item.key === target.key))}
          summary={receivingSummary}
          anythingToConfirm={anythingToConfirm}
          nothingSentYet={nothingSentYet}
        />
      )}

      {/* One line of words, two buttons. The chips that used to live here said the
          same thing the step sheet says, one screen higher. */}
      <div className="sticky bottom-0 z-10 border-t border-line bg-content1/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className={`min-w-0 flex-1 truncate text-xs ${blocker ? "text-warn" : "text-muted"}`}>
            {anythingToConfirm
              ? blocker
                ?? `${qty(receivingSummary.quantity)} ready across ${receivingSummary.lines} item${receivingSummary.lines === 1 ? "" : "s"}`
              : "No receipt action is pending."}
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button
              variant="subtle"
              onClick={() => (activeIndex === 0 ? onDone() : go(activeIndex - 1))}
            >
              <ArrowLeft className="h-4 w-4" />
              {activeIndex === 0 ? "Close" : "Back"}
            </Button>
            {stop.kind === "review" ? (
              anythingToConfirm && (
                <Button
                  onClick={() => confirm.mutate()}
                  disabled={!ready || confirm.isPending}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {confirm.isPending ? "Confirming..." : "Acknowledge receipt"}
                </Button>
              )
            ) : (
              /* The button names where it goes. "Next" on its own is the reason
                 somebody presses it four times to find out what is at the end. */
              <Button onClick={() => go(activeIndex + 1)}>
                {nextStop ? `Next: ${nextStop.plain}` : "Next"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {viewing && (
        <SharedAttachmentViewer
          attachments={viewing.files}
          initialIndex={viewing.index}
          onClose={() => setViewing(null)}
          onDownload={(file) =>
            indentApi.downloadReceiptAttachment(row.indent_id, file.id)}
        />
      )}

      <SerialNumbersModal
        isOpen={!!serialTarget}
        onClose={() => setSerialTarget(null)}
        itemLabel={serialTarget ? serialTarget.item_name ?? serialTarget.item_code ?? "" : ""}
        quantity={serialTarget
          ? requiredSerialCount(serialTarget, received[serialTarget.receipt_key] ?? "")
          : 0}
        available={serialTarget?.serial_numbers?.filter(Boolean) ?? []}
        initial={serialTarget
          ? serialPickForQuantity(
            serialTarget.serial_numbers?.filter(Boolean) ?? [],
            pickedSerials[serialTarget.receipt_key],
            requiredSerialCount(serialTarget, received[serialTarget.receipt_key] ?? ""),
          )
          : []}
        pickMode="select"
        noun={serialTarget ? TRACKING[serialTarget.tracking_type ?? ""]?.unit ?? "serial" : "serial"}
        // The picker names the KIND of identifier too, from the served catalogue:
        // inside the modal the list is a column of fifteen-character strings, and
        // "IMEI" over it is the difference between scanning a handset's two printed
        // numbers correctly and scanning the wrong one.
        trackingType={(serialTarget?.tracking_type ?? null) as TrackingType | null}
        trackingMeta={trackingMeta((serialTarget?.tracking_type ?? null) as TrackingType | null)}
        onSave={(serials) => {
          if (serialTarget) {
            setPickedSerials((current) => ({
              ...current,
              [serialTarget.receipt_key]: serials,
            }));
          }
          setSerialTarget(null);
        }}
      />
    </div>
  );
}

type ReceiptLeg = (RaiserTracking | ShipmentTrack) & { consignment_no?: string | null };

type ReceiptPackageLine = AcknowledgementLine & {
  receipt_key: string;
  package_id?: number | null;
  package_no?: string | null;
  package_quantity?: number | null;
};

interface ReceiptPackage {
  key: string;
  no: string;
  lines: ReceiptPackageLine[];
  quantity: number;
  /** The package row itself — what kind of container it is, its weight, its size,
   *  how it must be handled and who sealed it. Served with the line quantities
   *  (`AcknowledgementPackageQuantity`), so the screen describes the carton in front
   *  of the person rather than naming a database id. Absent on the fallback
   *  "manifest" package, which stands for a delivery the warehouse never packed. */
  detail?: AcknowledgementPackageQuantity;
}

interface ReceiptConsignment {
  key: string;
  no: string;
  leg?: ReceiptLeg;
  packages: ReceiptPackage[];
}

function receiptConsignments(
  row: Acknowledgement,
  liveTracking?: RaiserTracking[],
): ReceiptConsignment[] {
  const legs: ReceiptLeg[] = (liveTracking?.length ? liveTracking : row.shipments) ?? [];
  if (legs.length === 0) {
    return [{
      key: "direct",
      no: row.indent_no,
      packages: receiptPackages(row.lines),
    }];
  }
  return legs.map((leg, index) => ({
    key: `leg-${leg.tr_id ?? index}`,
    no: leg.consignment_no || leg.tr_no || `Consignment ${index + 1}`,
    leg,
    packages: receiptPackages(row.lines, leg.dispatch_id ?? null),
  }));
}

function receiptPackages(
  lines: AcknowledgementLine[],
  dispatchId?: number | null,
): ReceiptPackage[] {
  const arrived = lines.filter((line) => receivable(line) > 0);
  const visible = arrived.length > 0 ? arrived : lines;
  const byPackage = new Map<string, ReceiptPackage>();

  visible.forEach((line) => {
    const parts = packagePartsForLine(line, dispatchId);
    let serialOffset = 0;
    parts.forEach((part) => {
      const key = packageKey(part);
      const no = part.package_no?.trim() || "Package manifest";
      const packageLine = receiptPackageLine(line, part, serialOffset);
      serialOffset += Math.max(Math.floor(Number(part.quantity ?? 0)), 0);
      const current = byPackage.get(key) ?? {
        key,
        no,
        lines: [],
        quantity: 0,
        // Every line of one package carries the same package row; the first to
        // arrive is as good as any, and later ones cannot disagree.
        detail: part,
      };
      current.lines.push(packageLine);
      current.quantity += packageLine.package_quantity
        ?? receivable(line)
        ?? Number(line.dispatched_quantity ?? 0);
      byPackage.set(key, current);
    });
  });

  if (byPackage.size > 0) return [...byPackage.values()];

  const quantity = visible.reduce(
    (sum, line) => sum + (receivable(line) || Number(line.dispatched_quantity ?? 0)),
    0,
  );
  return [{
    key: "manifest",
    no: "Package manifest",
    lines: visible.map((line) => ({
      ...line,
      receipt_key: fallbackLineKey(line),
      package_quantity: receivable(line) || Number(line.dispatched_quantity ?? 0),
    })),
    quantity,
  }];
}

function packagePartsForLine(
  line: AcknowledgementLine,
  dispatchId?: number | null,
): AcknowledgementPackageQuantity[] {
  const all = (line.package_quantities ?? [])
    .filter((part) => Number(part.quantity ?? 0) > 0);
  const scoped = dispatchId
    ? all.filter((part) => part.dispatch_id === dispatchId)
    : all;
  const parts = scoped.length > 0 ? scoped : all;
  if (parts.length === 0) return [];

  const target = receivable(line) > 0
    ? receivable(line)
    : Number(line.dispatched_quantity ?? 0);
  let remaining = Math.max(target, 0);
  return parts
    .map((part) => {
      const sent = Number(part.quantity ?? 0);
      const quantity = receivable(line) > 0
        ? Math.min(sent, remaining)
        : sent;
      remaining -= quantity;
      return { ...part, quantity };
    })
    .filter((part) => Number(part.quantity ?? 0) > 0);
}

function receiptPackageLine(
  line: AcknowledgementLine,
  part: AcknowledgementPackageQuantity,
  serialOffset = 0,
): ReceiptPackageLine {
  const packageQuantity = Number(part.quantity ?? 0);
  const packageSerials = (line.serial_numbers ?? []).slice(
    serialOffset,
    serialOffset + Math.max(Math.floor(packageQuantity), 0),
  );
  return {
    ...line,
    receipt_key: packageLineKey(line, part),
    package_id: part.package_id,
    package_no: part.package_no,
    package_quantity: packageQuantity,
    serial_numbers: packageSerials.length > 0 ? packageSerials : line.serial_numbers,
  };
}

function fallbackLineKey(line: AcknowledgementLine) {
  return `line-${line.indent_item_id}`;
}

function packageLineKey(
  line: AcknowledgementLine,
  part: AcknowledgementPackageQuantity,
) {
  return [
    "line",
    line.indent_item_id,
    "dispatch",
    part.dispatch_id ?? "none",
    "package",
    part.package_id ?? part.package_no ?? "none",
  ].join("-");
}

/* ---------------------------------------------------------------------------
 * Describing the carton, in words somebody standing in front of it can check.
 *
 * Each of these answers with nothing at all when the column behind it is empty,
 * and NEVER with a zero: a package drawn as "0 kg" reads as weighed and empty,
 * where a blank reads as never weighed. The warehouse fills these in when it packs
 * a load and is not required to, so both cases are normal.
 * ------------------------------------------------------------------------ */

/** "Carton", "Wooden crate", "Pallet" — the container type, said as a word. */
function packageKindLabel(pack: ReceiptPackage) {
  const raw = (pack.detail?.package_type ?? "").trim();
  if (!raw) return "Package";
  const words = raw.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function packageWeight(pack: ReceiptPackage) {
  const weight = Number(pack.detail?.weight_kg ?? 0);
  return weight > 0 ? `${weight.toLocaleString()} kg` : "";
}

/** "60 x 40 x 30 cm", only when all three sides were measured — two of three
 *  describes nothing, and guessing the third is inventing a fact. */
function packageSize(pack: ReceiptPackage) {
  const sides = [
    Number(pack.detail?.length_cm ?? 0),
    Number(pack.detail?.width_cm ?? 0),
    Number(pack.detail?.height_cm ?? 0),
  ];
  if (sides.some((side) => !(side > 0))) return "";
  return `${sides.map((side) => side.toLocaleString()).join(" × ")} cm`;
}

/** "Sealed by A Kumar, 18 Sep" — who to ask when the contents do not match. */
function packedBy(pack: ReceiptPackage) {
  const who = (pack.detail?.packed_by_name ?? "").trim();
  const when = pack.detail?.packed_at
    ? new Date(pack.detail.packed_at).toLocaleDateString(undefined, {
      day: "numeric", month: "short",
    })
    : "";
  if (who && when) return `${who}, ${when}`;
  return who || when;
}

function packageKey(part: AcknowledgementPackageQuantity) {
  return [
    "dispatch",
    part.dispatch_id ?? "none",
    "package",
    part.package_id ?? part.package_no ?? "none",
  ].join("-");
}

function initialReceivedByReceiptLine(lines: AcknowledgementLine[]) {
  return Object.fromEntries(
    receiptPackages(lines)
      .flatMap((pack) => pack.lines)
      .filter((line) => Number(line.package_quantity ?? receivable(line)) > 0)
      .map((line) => [
        line.receipt_key,
        String(line.package_quantity ?? receivable(line)),
      ]),
  );
}

function acknowledgementPayload(
  lines: AcknowledgementLine[],
  received: Record<string, string>,
) {
  return lines
    .map((line) => {
      const parts = packagePartsForLine(line);
      const total = parts.length > 0
        ? parts.reduce((sum, part) =>
          sum + receivedNumber(received[packageLineKey(line, part)]), 0)
        : receivedNumber(received[fallbackLineKey(line)]);
      return {
        indent_item_id: line.indent_item_id,
        received_quantity: Math.min(total, receivable(line)),
      };
    })
    .filter((line) => line.received_quantity > 0);
}

function receivedNumber(value: string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

function requiredSerialCount(line: AcknowledgementLine, value: string) {
  const serials = line.serial_numbers?.filter(Boolean) ?? [];
  if (serials.length === 0) return 0;
  const max = "package_quantity" in line && typeof line.package_quantity === "number"
    ? line.package_quantity
    : receivable(line);
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
  return (selected ?? [])
    .filter((serial) => allowedSet.has(serial))
    .slice(0, required);
}

function isFullTracking(leg?: ReceiptLeg): leg is RaiserTracking {
  return Boolean(leg && "events" in leg);
}

/* ---------------------------------------------------------------------------
 * Which pile of proof a file belongs to.
 *
 * `sys_attachments` has `entity_type`, `entity_id` and `doc_category` and nothing
 * else, so the package a photo was taken of rides on the category behind a separator
 * the backend knows (`indents.service.ACK_SCOPE_SEP`). Both sides read the base with
 * their own helper and neither compares the whole string, so an unscoped row — every
 * receipt photo filed before today — stays a photo.
 * ------------------------------------------------------------------------ */

const SCOPE_SEP = "::";

function scopedCategory(base: string, scope: string) {
  return scope ? `${base}${SCOPE_SEP}${scope}` : base;
}

function attachmentBase(value?: string | null) {
  return (value ?? "").split(SCOPE_SEP)[0];
}

function attachmentScope(value?: string | null) {
  const parts = (value ?? "").split(SCOPE_SEP);
  return parts.length === 2 ? parts[1] : "";
}

/** Stable, and short enough for a `String(50)` column the base already eats into. */
function proofScope(prefix: "C" | "P", key: string) {
  const slug = key.toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${slug}`.slice(0, 30);
}

/* ---------------------------------------------------------------------------
 * The look.
 *
 * Flat. One white sheet per step on the page's warm ground, hairlines instead of
 * boxes, and a large ghosted numeral where a heading would normally sit -- the page
 * reads as a numbered job card rather than a stack of framed panels.
 *
 * The previous pass nested four borders deep (card > header > strip > panel > item
 * card > fact box), and each frame cost contrast that the CONTENT then had to win
 * back with a colour. Taking the frames away leaves the numbers as the loudest thing
 * on the screen, which is what somebody standing at a pallet is looking for.
 * ------------------------------------------------------------------------ */

/** A quiet heading for a run of rows. The only structure below a step's headline. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
      {children}
    </div>
  );
}

/** "a", "a and b", "a, b and c" -- the one-line "still to do". */
function sentenceList(parts: string[]) {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Where you are in the delivery, and every other place you could be.
 *
 * Dots on a line. It was 44px rounded squares carrying an icon, a corner badge, a
 * name, a document code and a "you are here" pill -- five things per node, six nodes,
 * before the actual work started. A step rail answers one question: which of how many
 * is this. The numeral answers it; the name under it says which; green says done.
 *
 * The colours are the product's OWN rail tokens (`--color-step-*`, index.css), the
 * same three every other stepper in the system uses. The live dot was `bg-brand`,
 * which is not a colour at all here: every solid brand fill wears the four-stop
 * Bavya sweep, so a 26px disc rendered as a slice of gradient that changed hue
 * across its own diameter and matched nothing else on the page.
 */
function JourneyRail({ stops, activeIndex, isDone, onJump }: {
  stops: Stop[];
  activeIndex: number;
  isDone: (stop: Stop) => boolean;
  onJump: (index: number) => void;
}) {
  return (
    <div className="-mx-1 mt-4 overflow-x-auto pb-0.5">
      <ol className="flex min-w-max items-start">
        {stops.map((stop, index) => {
          const done = isDone(stop);
          const active = index === activeIndex;
          return (
            <li key={stop.key} className="flex items-start">
              {index > 0 && (
                <span
                  aria-hidden
                  className={`mt-[21px] h-px w-7 shrink-0 sm:w-12 ${
                    isDone(stops[index - 1]) ? "bg-step-done-rail" : "bg-line"
                  }`}
                />
              )}
              <button
                type="button"
                onClick={() => onJump(index)}
                aria-current={active ? "step" : undefined}
                title={stop.label}
                className="flex w-[80px] shrink-0 flex-col items-center gap-2 px-1 py-2 text-center sm:w-[104px]"
              >
                <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition ${
                  done
                    ? "bg-step-done text-white"
                    : active
                      ? "bg-step-live text-white ring-4 ring-step-live/20"
                      : "bg-content2 text-muted"
                }`}>
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : index + 1}
                </span>
                <span className={`line-clamp-2 text-[11px] leading-tight ${
                  active ? "font-semibold text-ink" : "text-muted"
                }`}>
                  {stop.plain}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * One step, as a sheet.
 *
 * The step number used to be set as a 48px ghosted numeral in a 25%-opacity brand
 * pink. It was the largest thing on the page and the palest, which is the one
 * combination that reads as a printing fault rather than as decoration -- and it
 * spent the page's only warm hue on a fact (“this is step one”) the rail above had
 * already answered. It is a small filled disc in the product's own step colour now,
 * the same disc the rail and every other stepper in the system use, sitting on one
 * line with the step count and what this step is about.
 *
 * Under it, in order, exactly three things -- what to do, what this refers to, and
 * what is still missing. The last of those is a sentence, because "Still to do:
 * photograph this package" is read in one pass and two amber chips are not.
 */
function StepSheet({
  stepNo, stepTotal, kicker, headline, note, code, meta, tasks, children,
}: {
  stepNo: number;
  stepTotal: number;
  /** What this step is about, in two or three words: "Consignment received". */
  kicker: string;
  headline: string;
  note: string;
  code: string;
  meta?: string;
  tasks: StepTask[];
  children: ReactNode;
}) {
  const left = tasks.filter((task) => !task.done);
  return (
    <section className="rounded-3xl bg-content1 px-5 py-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:px-7">
      <header>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-step-live text-[12px] font-bold tabular-nums text-white">
            {stepNo}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
            {kicker}
          </span>
          <span className="text-[11px] tabular-nums text-muted">
            Step {stepNo} of {stepTotal}
          </span>
        </div>
        <h2 className="mt-3 font-display text-xl font-bold leading-tight text-ink sm:text-2xl">
          {headline}
        </h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">{note}</p>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <span className="rounded-md bg-content2 px-1.5 py-0.5 font-mono text-body">{code}</span>
          {meta && <><span aria-hidden>&middot;</span><span>{meta}</span></>}
        </p>
        <p className={`mt-4 flex items-start gap-2 text-sm font-medium ${
          left.length > 0 ? "text-warn" : "text-ok"
        }`}>
          {left.length > 0
            ? <Circle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>
            {left.length > 0
              ? `Still to do: ${sentenceList(left.map((task) => lowerFirst(task.label)))}`
              : "Nothing left to do here"}
          </span>
        </p>
      </header>
      <div className="mt-7 space-y-7">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Stop 1..n-1 -- the handover, then one package at a time.
 * ------------------------------------------------------------------------ */

function GateStop({
  stop, stepNo, stepTotal, indentId, tasks, files, loading, failed, uploadPending,
  removePending, onUpload, onView, onDelete, onOpenPackage, packageLabel,
  packageProgress,
}: {
  stop: Stop;
  stepNo: number;
  stepTotal: number;
  indentId: number;
  tasks: StepTask[];
  files: ReceiptAttachment[];
  loading: boolean;
  failed: boolean;
  uploadPending: boolean;
  removePending: boolean;
  onUpload: (file: File, base: string) => void;
  onView: (files: ReceiptAttachment[], index: number) => void;
  onDelete: (attachmentId: number) => void;
  onOpenPackage: (pack: ReceiptPackage) => void;
  packageLabel: (pack: ReceiptPackage) => string;
  packageProgress: (pack: ReceiptPackage) => PackageProgress;
}) {
  const leg = stop.consignment?.leg;
  const packages = stop.consignment?.packages ?? [];
  return (
    <StepSheet
      stepNo={stepNo}
      stepTotal={stepTotal}
      kicker="Consignment received"
      headline="Consignment photos"
      note="Before anything is opened: walk around the consignment, look for damage or a broken seal, and photograph it exactly as it was received. These pictures are filed against the consignment number below."
      code={stop.consignment?.no ?? "Consignment"}
      meta={`${packages.length} package${packages.length === 1 ? "" : "s"} in this consignment`}
      tasks={tasks}
    >
      {/* The whole reason this step exists, so it is the first thing under the
          heading -- not a panel below a tracking card the person did not ask for. */}
      <ProofPanel
        title="Consignment photos"
        note="The consignment as received, sealed and unopened. Each package gets its own photos at the steps after this one."
        indentId={indentId}
        files={files}
        uploadPending={uploadPending}
        removePending={removePending}
        onUpload={onUpload}
        onView={onView}
        onDelete={onDelete}
      />

      {packages.length > 0 && (
        <section>
          <SectionLabel>Packages in this consignment</SectionLabel>
          <p className="mt-1 text-xs text-muted">
            One step each, in any order. Nothing is locked.
          </p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {packages.map((pack) => (
              <PackageCard
                key={pack.key}
                pack={pack}
                label={packageLabel(pack)}
                progress={packageProgress(pack)}
                onOpen={() => onOpenPackage(pack)}
              />
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionLabel>How it travelled</SectionLabel>
        <div className="mt-2 text-xs text-muted">
          {loading ? (
            "Checking with logistics..."
          ) : failed ? (
            <span className="text-warn">
              Tracking is temporarily unavailable. You can still count and acknowledge.
            </span>
          ) : isFullTracking(leg) ? (
            <ul className="list-none"><ShipmentCard leg={leg} /></ul>
          ) : leg ? (
            <CompactShipmentCard leg={leg} />
          ) : (
            "No logistics shipment has been created for this indent yet."
          )}
        </div>
      </section>
    </StepSheet>
  );
}

function PackageStop({
  pack, stepNo, stepTotal, indentId, tasks, position, total, files, received, counted,
  pickedSerials, uploadPending, removePending, onUpload, onView, onDelete, onChange,
  onPickSerials,
}: {
  pack: ReceiptPackage;
  stepNo: number;
  stepTotal: number;
  indentId: number;
  tasks: StepTask[];
  position: number;
  total: number;
  files: ReceiptAttachment[];
  received: Record<string, string>;
  counted: { total: number; done: number };
  pickedSerials: Record<string, string[]>;
  uploadPending: boolean;
  removePending: boolean;
  onUpload: (file: File, base: string) => void;
  onView: (files: ReceiptAttachment[], index: number) => void;
  onDelete: (attachmentId: number) => void;
  onChange: (receiptKey: string, value: string) => void;
  onPickSerials: (line: ReceiptPackageLine) => void;
}) {
  return (
    <StepSheet
      stepNo={stepNo}
      stepTotal={stepTotal}
      kicker={`Package ${position} of ${total}`}
      headline="Open it and count what is inside"
      note="Count the units yourself. Enter what is actually in the package, even if it is fewer than the paperwork says."
      code={pack.no}
      meta={`${counted.done} of ${counted.total} counted`}
      tasks={tasks}
    >
      {/* The carton, before its contents: what to pick up and open. */}
      <PackageIdentityCard pack={pack} position={position} total={total} />

      <section>
        <SectionLabel>
          {pack.lines.length === 1 ? "What is in it" : `What is in it (${pack.lines.length} items)`}
        </SectionLabel>
        <ul className="mt-1 divide-y divide-line">
          {pack.lines.map((line) => (
            <PackageLineRow
              key={line.receipt_key}
              line={line}
              value={received[line.receipt_key] ?? ""}
              onChange={(value) => onChange(line.receipt_key, value)}
              selectedSerials={pickedSerials[line.receipt_key] ?? []}
              onPickSerials={() => onPickSerials(line)}
            />
          ))}
        </ul>
      </section>

      <ProofPanel
        title={`Photos of ${pack.no}`}
        note="Kept against this package alone, so a question about this one is answered with this one's picture."
        indentId={indentId}
        files={files}
        uploadPending={uploadPending}
        removePending={removePending}
        onUpload={onUpload}
        onView={onView}
        onDelete={onDelete}
      />
    </StepSheet>
  );
}

/** How far one package has got, read off the same rules its own stop is judged by:
 *  never a second copy of them. */
interface PackageProgress {
  done: boolean;
  countedDone: number;
  countedTotal: number;
  photos: number;
}

/**
 * One package in the consignment, drawn as the parcel it is.
 *
 * It was a text row -- a dot, a name, a code and "1 item, 10" -- repeated down a
 * divided list. On a screen whose whole job is "go and find this box on the floor
 * and open it", every package looked exactly like every other package, and the two
 * things that tell them apart on the floor (what kind of container, what is printed
 * on the label) were the smallest text in the row.
 *
 * So the card is a parcel: a strip of packing tape across the lid, a shipping label
 * with the package number set at the size it is printed at, the barcode under it,
 * and the state of the work as a footer. Each of those is a real value off
 * `out_dispatch_packages`, not decoration -- the barcode is drawn only where the
 * warehouse actually recorded one, because a made-up barcode is a scannable-looking
 * thing that does not scan.
 *
 * The state is the SAME three facts the step itself is judged on (counted, then
 * photographed), read through `packageProgress` off the one set of rules, so a card
 * saying "ready" and a rail dot saying "not yet" cannot happen.
 */
function PackageCard({ pack, label, progress, onOpen }: {
  pack: ReceiptPackage;
  label: string;
  progress: PackageProgress;
  onOpen: () => void;
}) {
  const { done, countedDone, countedTotal, photos } = progress;
  const started = countedDone > 0 || photos > 0;
  const weight = packageWeight(pack);
  const size = packageSize(pack);
  const barcode = (pack.detail?.barcode ?? "").trim();
  const state = done
    ? { tone: "text-ok", chip: "bg-ok text-white", word: "Done" }
    : started
      ? { tone: "text-warn", chip: "bg-warn-bg text-warn", word: "In progress" }
      : { tone: "text-muted", chip: "bg-content2 text-muted", word: "Not opened" };

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`group flex h-full w-full flex-col overflow-hidden rounded-2xl border text-left transition hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(16,24,40,0.08)] ${
          done ? "border-ok/40 bg-ok-bg/25" : "border-line bg-content1"
        }`}
      >
        {/* The tape across the lid. Decoration, and the only piece on the card that
            is: it is what makes a list of these read as parcels at a glance rather
            than as another table. Kept to a 6px strip in the card's own state
            colour so it carries the status too. */}
        <span
          aria-hidden
          className={`h-1.5 w-full ${done ? "bg-step-done" : started ? "bg-warn" : "bg-line"}`}
        />

        <span className="flex flex-1 flex-col gap-3 p-3.5">
          <span className="flex items-start gap-3">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${
              done
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-line bg-content2 text-ink-500"
            }`}>
              <Package className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink group-hover:text-brand">
                {label}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">
                {packageKindLabel(pack)}
                {weight && ` · ${weight}`}
                {size && ` · ${size}`}
              </span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${state.chip}`}>
              {done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> : state.word}
            </span>
          </span>

          {/* The shipping label, at label size. The number printed on the carton is
              the one thing the person can match against what is in front of them,
              and it was 11px grey under the row title. */}
          <span className="block rounded-xl border border-dashed border-line bg-content2/50 px-3 py-2">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[15px] font-bold tracking-tight text-ink">
                {pack.no}
              </span>
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-body">
                {pack.lines.length} item{pack.lines.length === 1 ? "" : "s"} &middot; {qty(pack.quantity)}
              </span>
            </span>
            {barcode && (
              <>
                <span
                  aria-hidden
                  className="mt-1.5 block h-5 w-full rounded-[2px] opacity-80 [background-image:repeating-linear-gradient(90deg,var(--color-ink)_0_2px,transparent_2px_5px,var(--color-ink)_5px_6px,transparent_6px_10px,var(--color-ink)_10px_13px,transparent_13px_15px,var(--color-ink)_15px_16px,transparent_16px_21px)]"
                />
                <span className="mt-1 block truncate font-mono text-[10px] tracking-wide text-muted">
                  {barcode}
                </span>
              </>
            )}
          </span>

          {(pack.detail?.is_fragile || pack.detail?.is_temp_controlled) && (
            <span className="flex flex-wrap gap-1.5">
              {pack.detail?.is_fragile && (
                <Handling icon={AlertTriangle} tone="bg-warn-bg text-warn" label="Fragile" />
              )}
              {pack.detail?.is_temp_controlled && (
                <Handling icon={Snowflake} tone="bg-info-bg text-info" label="Keep cold" />
              )}
            </span>
          )}

          {/* What is left to do on this one, in the same two steps the package stop
              asks for -- count, then photograph. */}
          <span className="mt-auto flex items-center gap-2 border-t border-line pt-2.5 text-xs">
            <span className={`min-w-0 flex-1 truncate font-medium ${state.tone}`}>
              {done
                ? "Counted and photographed"
                : countedTotal === 0
                  ? "Nothing here is waiting on you"
                  : `${countedDone} of ${countedTotal} counted · ${
                    photos > 0 ? `${photos} photo${photos === 1 ? "" : "s"}` : "no photo yet"}`}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-brand">
              {started || done ? "Open" : "Open and count"}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The carton, drawn as the thing standing in front of you.
 *
 * A package used to be named by its number and nothing else, which identifies it only
 * if the printed label happens to be facing the person reading the screen -- two
 * identical cartons off one pallet were told apart by walking round them. Everything
 * here already exists on `out_dispatch_packages` and is now served beside the line
 * quantities: the container type, the weight, the three sides, the handling rules and
 * who sealed it, plus what the manifest says is inside.
 *
 * A fact with nothing behind it is NOT drawn. An unweighed package is not a package
 * weighing zero, and a grid of "0 kg / 0 x 0 x 0 cm" would have the screen state
 * measurements that were never taken.
 */
function PackageIdentityCard({ pack, position, total }: {
  pack: ReceiptPackage;
  position: number;
  total: number;
}) {
  const weight = packageWeight(pack);
  const size = packageSize(pack);
  const sealed = packedBy(pack);
  const barcode = (pack.detail?.barcode ?? "").trim();
  const facts = [
    {
      key: "contains",
      icon: Package,
      label: "Manifest says",
      value: `${pack.lines.length} item${pack.lines.length === 1 ? "" : "s"}, ${qty(pack.quantity)}`,
    },
    weight && { key: "weight", icon: Weight, label: "Weight", value: weight },
    size && { key: "size", icon: Ruler, label: "Size", value: size },
    barcode && { key: "barcode", icon: Barcode, label: "Barcode", value: barcode, mono: true },
  ].filter(Boolean) as { key: string; icon: typeof Package; label: string; value: string; mono?: boolean }[];

  return (
    <section
      aria-label={`Package ${pack.no}`}
      className="overflow-hidden rounded-2xl border border-line bg-content2/35"
    >
      <div className="flex items-start gap-4 px-4 py-4">
        {/* A box, drawn as a box. The one place on this screen an illustration
            earns its space: it is what the person is looking for on the floor. */}
        <span
          aria-hidden
          className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-line bg-content1 text-ink-500 shadow-[0_1px_2px_rgba(16,24,40,0.05)]"
        >
          <Package className="h-7 w-7" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-base font-semibold tracking-tight text-ink">
              {pack.no}
            </span>
            <span className="text-sm text-muted">{packageKindLabel(pack)}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            Package {position} of {total}
            {pack.detail?.dispatch_no && (
              <> &middot; sent on <span className="font-mono">{pack.detail.dispatch_no}</span></>
            )}
            {sealed && <> &middot; packed by {sealed}</>}
          </div>
          {/* Handling first, and only when it applies: a chip that shows on every
              package teaches the eye to skip the one that matters. */}
          {(pack.detail?.is_fragile || pack.detail?.is_temp_controlled) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pack.detail?.is_fragile && (
                <Handling icon={AlertTriangle} tone="bg-warn-bg text-warn" label="Fragile - open carefully" />
              )}
              {pack.detail?.is_temp_controlled && (
                <Handling icon={Snowflake} tone="bg-info-bg text-info" label="Temperature controlled" />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hairline-separated cells rather than four bordered tiles: the same four
          facts, without four more frames on a page that already has enough. */}
      {/* auto-fit rather than a fixed four: most packages in the live data carry a
          type, a barcode and nothing else — a four-column grid with two cells in it
          leaves half a card of hairline for facts that were never recorded. */}
      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:[grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        {facts.map((fact) => (
          <div key={fact.key} className="bg-content1 px-3 py-2.5">
            <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              <fact.icon className="h-3 w-3" aria-hidden />
              {fact.label}
            </dt>
            <dd className={`mt-1 truncate text-sm font-semibold text-ink ${fact.mono ? "font-mono text-[13px]" : ""}`}
              title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Handling({ icon: Icon, tone, label }: {
  icon: typeof AlertTriangle;
  tone: string;
  label: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * One item in one package: what was sent in THIS package, and what you actually count.
 *
 * A row, not a card. Name and code on the left, the count on the right, and the three
 * reference figures as one quiet line underneath -- they were three bordered boxes,
 * which gave the numbers you cannot change the same weight as the one you can.
 *
 * The stepper stays: often a phone, often one hand, and 44px of button beats a
 * keyboard at a pallet. The box is still there for 37 of something.
 */
function PackageLineRow({ line, value, onChange, selectedSerials, onPickSerials }: {
  line: ReceiptPackageLine;
  value: string;
  onChange: (value: string) => void;
  selectedSerials: string[];
  onPickSerials: () => void;
}) {
  const max = Number(line.package_quantity ?? receivable(line));
  const serials = line.serial_numbers?.filter(Boolean) ?? [];
  const requiredSerials = requiredSerialCount(line, value);
  const displayedSerials = serialPickForQuantity(serials, selectedSerials, requiredSerials);
  const tracking = TRACKING[line.tracking_type ?? ""]
    ?? (line.is_serial_tracked ? TRACKING.SERIAL : null);
  const unit = (tracking ?? TRACKING.SERIAL).unit;
  const serialComplete = displayedSerials.length === requiredSerials && requiredSerials > 0;
  const current = receivedNumber(value);
  const short = max > 0 && current < max;
  const label = line.item_name ?? line.item_code ?? "item";

  return (
    <li className="py-5 first:pt-4">
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-snug text-ink">
            {line.item_name ?? line.item_code}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted">{line.item_code}</div>
          <div className="mt-2 text-xs text-muted">
            <b className="font-semibold tabular-nums text-body">{qty(max)}</b> sent in this
            package &middot; {qty(line.approved_quantity)} approved &middot; {qty(line.received_quantity)} received so far
          </div>
        </div>
        {max > 0 ? (
          <QuantityStepper value={value} max={max} onChange={onChange} label={label} />
        ) : (
          <span className="text-xs text-muted">
            {line.pending_with || "Nothing to confirm here"}
          </span>
        )}
      </div>

      {max > 0 && (
        /* Three states, because they mean three different things and one of them is
           not a problem. Not started is grey -- every line begins there, and opening
           a package to a wall of amber teaches somebody to ignore amber. */
        <p className={`mt-2.5 flex items-start gap-1.5 text-xs leading-relaxed ${
          current <= 0 ? "text-muted" : short ? "text-warn" : "text-ok"
        }`}>
          {current > 0 && !short
            ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span>
            {current <= 0
              ? "Not counted yet."
              : short
                ? `Confirming ${qty(current)} of ${qty(max)}. The other ${qty(max - current)} can still arrive later.`
                : `All ${qty(max)} counted.`}
          </span>
        </p>
      )}

      {serials.length > 0 && (
        <SerialPanel
          heading={(tracking ?? TRACKING.SERIAL).heading}
          unit={unit}
          trackingType={(line.tracking_type ?? "SERIAL") as TrackingType}
          sent={serials.length}
          required={requiredSerials}
          picked={displayedSerials}
          complete={serialComplete}
          counted={current > 0}
          onPick={onPickSerials}
        />
      )}
    </li>
  );
}

/**
 * Which physical units this line is being confirmed against.
 *
 * It was one 44px strip with a counter on the right -- the quietest thing on a row
 * that also carried a stepper, a status sentence and three reference figures -- for
 * the one fact on the page that names individual pieces of equipment. A serial
 * confirmed against the wrong handset is not a quantity that can be corrected later:
 * the asset register now says a different device is standing in this office.
 *
 * So it is a panel, and it says four things the strip could not: WHICH kind of
 * identifier is being asked for (the served `TrackingBadge` -- a serial, an IMEI, an
 * asset tag and a lot code are fifteen characters of upper case apiece and the item
 * is the only thing that knows which was printed on the goods), how far through the
 * match is, WHICH codes have been ticked so far, and what to press. The ticked codes
 * are on screen rather than behind the modal, because the check somebody actually
 * performs is reading a number off a box and finding it in a list.
 *
 * Three states, and only one of them is a problem: nothing counted yet is neutral
 * (the quantity has to be entered before there is anything to match), part-matched is
 * amber, matched is green.
 */
function SerialPanel({
  heading, unit, trackingType, sent, required, picked, complete, counted, onPick,
}: {
  heading: string;
  unit: string;
  trackingType: TrackingType;
  /** How many coded units the warehouse sent in this package. */
  sent: number;
  /** How many the entered quantity asks for. Zero until something is counted. */
  required: number;
  picked: string[];
  complete: boolean;
  counted: boolean;
  onPick: () => void;
}) {
  const meta = useTrackingMeta();
  const tone = complete
    ? "border-ok/35 bg-ok-bg/40"
    : counted
      ? "border-warn/35 bg-warn-bg/40"
      : "border-line bg-content2/40";
  // A bar that is 0% wide at the start of the job is a bar that says nothing; it
  // only appears once there is something to be part-way through.
  const progress = required > 0 ? Math.round((picked.length / required) * 100) : 0;

  return (
    <div className={`mt-3.5 rounded-2xl border px-3.5 py-3 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            complete ? "bg-ok text-white" : "bg-content1 text-ink-500"
          }`}>
            {complete
              ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
              : <ScanBarcode className="h-4 w-4" aria-hidden />}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-ink">{heading}</span>
              <TrackingBadge type={trackingType} meta={meta(trackingType)} size="sm" />
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {required > 0
                ? `Match the ${unit} printed on each unit against the ${sent} sent in this package.`
                : `Enter how many arrived first, then match the ${unit} on each unit.`}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-display text-xl font-bold tabular-nums leading-none ${
            complete ? "text-ok" : counted ? "text-warn" : "text-muted"
          }`}>
            {picked.length}<span className="text-sm font-semibold text-muted">/{required}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted">matched</div>
        </div>
      </div>

      {required > 0 && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-content1">
          <div
            className={`h-full rounded-full transition-[width] ${complete ? "bg-ok" : "bg-warn"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* The codes themselves. Wrapped chips, monospace, at a size a number can be
          read back off a label at -- a count alone never let anybody check one. */}
      {picked.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {picked.map((code) => (
            <li
              key={code}
              className="rounded-md border border-line bg-content1 px-2 py-1 font-mono text-[12px] font-semibold tracking-tight text-ink"
            >
              {code}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs font-medium ${complete ? "text-ok" : counted ? "text-warn" : "text-muted"}`}>
          {required <= 0
            ? "Nothing to match yet"
            : complete
              ? `All ${required} ${required === 1 ? unit : `${unit}s`} matched`
              : `${required - picked.length} still to match`}
        </span>
        <Button variant={complete ? "subtle" : "soft"} onClick={onPick} disabled={required <= 0}>
          <ScanBarcode className="h-4 w-4" />
          {picked.length > 0 ? "Change selection" : `Match the ${unit}s`}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function QuantityStepper({ value, max, onChange, label }: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  label: string;
}) {
  const current = receivedNumber(value);
  const set = (next: number) =>
    onChange(String(Math.min(Math.max(Number(next.toFixed(3)), 0), max)));
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`One less for ${label}`}
          disabled={current <= 0}
          onClick={() => set(current - 1)}
          className="h-11 w-11 rounded-full bg-content2 text-lg font-semibold text-body transition hover:bg-brand-050 hover:text-brand disabled:opacity-40"
        >
          &minus;
        </button>
        <div className="w-[72px]">
          <Input
            type="number"
            min={0}
            max={max}
            step="any"
            aria-label={`How many arrived for ${label}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <button
          type="button"
          aria-label={`One more for ${label}`}
          disabled={current >= max}
          onClick={() => set(current + 1)}
          className="h-11 w-11 rounded-full bg-content2 text-lg font-semibold text-body transition hover:bg-brand-050 hover:text-brand disabled:opacity-40"
        >
          +
        </button>
      </div>
      <button
        type="button"
        onClick={() => onChange(String(max))}
        className="mt-1.5 block w-full text-center text-[11px] font-semibold text-brand hover:underline"
      >
        All {qty(max)} arrived
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The last stop.
 * ------------------------------------------------------------------------ */

function ReviewStop({
  row, stepNo, stepTotal, tasks, stops, proofFor, isDone, onJump, summary,
  anythingToConfirm, nothingSentYet,
}: {
  row: Acknowledgement;
  stepNo: number;
  stepTotal: number;
  tasks: StepTask[];
  stops: Stop[];
  proofFor: (stop: Stop) => ReceiptAttachment[];
  isDone: (stop: Stop) => boolean;
  onJump: (stop: Stop) => void;
  summary: { quantity: number; lines: number; byLine: Map<number, number> };
  anythingToConfirm: boolean;
  nothingSentYet: boolean;
}) {
  const slip = row.lines.filter((line) => (summary.byLine.get(line.indent_item_id) ?? 0) > 0);
  const inProcess = row.lines.filter((line) =>
    receivable(line) <= 0
    && Number(line.approved_quantity ?? 0) > Number(line.received_quantity ?? 0));
  const evidence = stops.filter((stop) => stop.kind !== "review");

  return (
    <StepSheet
      stepNo={stepNo}
      stepTotal={stepTotal}
      kicker="Sign off"
      headline="Sign for what you received"
      note="One press records everything counted at the steps behind you. Anything not on this list stays open and can still arrive."
      code={row.indent_no}
      meta={`${summary.lines} item${summary.lines === 1 ? "" : "s"}`}
      tasks={tasks}
    >
      {/* The slip: exactly what the press will record, the way a till receipt reads. */}
      <section>
        <SectionLabel>You are signing for</SectionLabel>
        {slip.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {anythingToConfirm
              ? "Nothing counted yet. Go back into a package and enter how many arrived."
              : nothingSentYet
                ? "Nothing has been dispatched to you yet."
                : "Everything sent to you has already been acknowledged."}
          </p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-line">
              {slip.map((line) => (
                <li key={line.indent_item_id} className="flex items-baseline gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {line.item_name ?? line.item_code}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {line.item_code}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-ink">
                    {qty(summary.byLine.get(line.indent_item_id) ?? 0)}
                    <span className="ml-1 text-[11px] font-normal text-muted">
                      {line.uom_code ?? ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-semibold text-body">Total</span>
              <span className="font-display text-2xl font-bold tabular-nums text-ink">
                {qty(summary.quantity)}
              </span>
            </div>
          </>
        )}
      </section>

      <section>
        <SectionLabel>Consignment and package photos</SectionLabel>
        <p className="mt-1 text-xs text-muted">
          At least one is needed to sign. Press a step to go back and add it.
        </p>
        <ul className="mt-2 divide-y divide-line">
          {evidence.map((stop) => {
            const files = proofFor(stop);
            const photos = files.filter(
              (file) => attachmentBase(file.doc_category) === PHOTO).length;
            const bills = files.filter(
              (file) => attachmentBase(file.doc_category) === BILL).length;
            const done = isDone(stop);
            return (
              <li key={stop.key}>
                <button
                  type="button"
                  onClick={() => onJump(stop)}
                  className="group flex min-h-[52px] w-full items-center gap-3 py-2.5 text-left"
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                    done ? "bg-ok text-white" : "bg-warn-bg text-warn"
                  }`}>
                    {done
                      ? <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      : <Camera className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink group-hover:text-brand">
                      {stop.plain}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {stop.label}
                    </span>
                  </span>
                  <span className={`shrink-0 text-xs ${photos === 0 ? "text-warn" : "text-muted"}`}>
                    {photos === 0 ? "No photo" : `${photos} photo${photos === 1 ? "" : "s"}`}
                    {bills > 0 ? `, ${bills} bill${bills === 1 ? "" : "s"}` : ""}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted group-hover:text-brand" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {inProcess.length > 0 && <InProcessPanel lines={inProcess} />}
    </StepSheet>
  );
}

/* ---------------------------------------------------------------------------
 * Proof, and the small parts.
 * ------------------------------------------------------------------------ */

/**
 * One stop's photos and bill.
 *
 * The same component at every stop, over a DIFFERENT pile: the consignment's own, and
 * then one per package. It shows only what belongs here, which is the whole point --
 * "1 photo" against a package now means that package was photographed.
 *
 * Two dropzones, one required and one not, and the captions say which. They were
 * identical grey chips reading "0 photo" and "0 bill" though only one of the two
 * stands between the storekeeper and the sign-off.
 */
function ProofPanel({
  title, note, indentId, files, uploadPending, removePending, onUpload, onView,
  onDelete,
}: {
  title: string;
  note: string;
  /** Whose files these are — the thumbnails fetch their bytes off this indent's own
   *  gated route, never a URL of their own (the same rule the shared viewer keeps). */
  indentId: number;
  files: ReceiptAttachment[];
  uploadPending: boolean;
  removePending: boolean;
  onUpload: (file: File, base: string) => void;
  onView: (files: ReceiptAttachment[], index: number) => void;
  onDelete: (attachmentId: number) => void;
}) {
  const photos = files.filter((file) => attachmentBase(file.doc_category) === PHOTO);
  const bills = files.filter((file) => attachmentBase(file.doc_category) === BILL);
  // Split for DRAWING, which is a different question from what a file is FOR: a bill
  // photographed on a phone is a bill and is also a picture, and hiding it in a file
  // row because of its category would be the screen ignoring what it can see.
  const images = files.filter(isImage);
  const documents = files.filter((file) => !isImage(file));
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionLabel>{title}</SectionLabel>
        {uploadPending && <span className="text-[11px] text-muted">Uploading...</span>}
      </div>
      <p className="mt-1 max-w-prose text-xs text-muted">{note}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <UploadTile
          icon={<Camera className="h-5 w-5" />}
          label={photos.length > 0 ? "Add another photo" : "Take a photo"}
          caption={photos.length > 0
            ? `${photos.length} attached`
            : "Needed before you can sign"}
          done={photos.length > 0}
          accept="image/*"
          category={PHOTO}
          onUpload={onUpload}
        />
        <UploadTile
          icon={<FileText className="h-5 w-5" />}
          label="Add the bill"
          caption={bills.length > 0 ? `${bills.length} attached` : "Optional"}
          done={bills.length > 0}
          accept="image/*,application/pdf"
          category={BILL}
          onUpload={onUpload}
        />
      </div>

      {/* What was actually photographed, as pictures. A receipt screen that lists
          "IMG_20260919_101422.jpg" makes the person open each file to find out
          whether the damaged corner was caught -- the one check the photo exists
          for. Anything that is not an image (a PDF bill, most often) keeps the file
          row underneath, because there is nothing to show. */}
      {images.length > 0 && (
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((file) => (
            <PhotoThumb
              key={file.id}
              indentId={indentId}
              file={file}
              busy={removePending}
              onView={() => onView(files, files.indexOf(file))}
              onDelete={() => onDelete(file.id)}
            />
          ))}
        </ul>
      )}

      {documents.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {documents.map((file) => (
            <AttachmentTile
              key={file.id}
              attachment={file}
              busy={removePending}
              onView={() => onView(files, files.indexOf(file))}
              onDelete={() => onDelete(file.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** An image is anything the browser will draw; everything else keeps a file row. */
const isImage = (file: ReceiptAttachment) =>
  (file.mime_type ?? "").toLowerCase().startsWith("image/");

/**
 * One filed photo, as the photo.
 *
 * The bytes come down the same gated route the viewer uses -- the files are not
 * public URLs and there is no thumbnail service -- so the tile fetches its own blob
 * once and hands back the object URL when it goes away. One request per photo on a
 * step, and a step carries a handful; the alternative is a filename, which is what
 * this replaces.
 */
function PhotoThumb({ indentId, file, onView, onDelete, busy }: {
  indentId: number;
  file: ReceiptAttachment;
  onView: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dropped = false;
    let made = "";
    indentApi.downloadReceiptAttachment(indentId, file.id)
      .then((blob) => {
        if (dropped) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => { if (!dropped) setFailed(true); });
    return () => {
      dropped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [indentId, file.id]);

  const isBill = attachmentBase(file.doc_category) === BILL;
  return (
    <li className="group relative overflow-hidden rounded-xl border border-line bg-content2">
      <button
        type="button"
        onClick={onView}
        className="block aspect-[4/3] w-full"
        title={file.file_name}
      >
        {url ? (
          <img src={url} alt={file.file_name} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center text-[11px] text-muted">
            {failed ? "Preview unavailable" : "Loading..."}
          </span>
        )}
      </button>
      {/* The caption sits ON the picture: a row under it would put the tile's height
          at the mercy of a filename, and the grid would stop being a grid. */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5 text-[10px] font-medium text-white">
        {isBill
          ? <FileText className="h-3 w-3 shrink-0" aria-hidden />
          : <Camera className="h-3 w-3 shrink-0" aria-hidden />}
        <span className="truncate">{file.file_name}</span>
      </span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${file.file_name}`}
        className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-content1/90 text-muted opacity-0 transition hover:text-bad focus:opacity-100 disabled:opacity-50 group-hover:opacity-100"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

function UploadTile({ icon, label, caption, done, accept, category, onUpload }: {
  icon: ReactNode;
  label: string;
  caption: string;
  done: boolean;
  accept: string;
  category: string;
  onUpload: (file: File, category: string) => void;
}) {
  return (
    /* A dropzone, at the size of a button rather than a billboard. It was a 92px
       centred tile with a crimson icon in it, twice, side by side -- the loudest
       colour on the page spent on the two things that are not yet evidence, above
       the pictures that are. Left-aligned, half the height, and the icon carries the
       tile's own state instead of the brand. */
    <label className={`flex min-h-[64px] cursor-pointer items-center gap-3 rounded-xl border border-dashed px-3.5 py-3 text-left transition ${
      done
        ? "border-ok/40 bg-ok-bg/40 hover:border-ok"
        : "border-line bg-content2/40 hover:border-ink-500/40 hover:bg-content2"
    }`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
        done ? "bg-ok/12 text-ok" : "bg-content1 text-ink-500"
      }`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-body">{label}</span>
        <span className={`block truncate text-[11px] ${done ? "text-ok" : "text-muted"}`}>
          {caption}
        </span>
      </span>
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

/** A filed photo or bill: open it, or take it back off the receipt. */
function AttachmentTile({ attachment, onView, onDelete, busy }: {
  attachment: ReceiptAttachment;
  onView: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const isBill = attachmentBase(attachment.doc_category) === BILL;
  return (
    <li className="flex min-h-11 items-center gap-2.5 py-1.5 text-sm">
      <span className={`shrink-0 ${isBill ? "text-info" : "text-ok"}`}>
        {isBill ? <FileText className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
      </span>
      <button
        type="button"
        onClick={onView}
        className="min-w-0 flex-1 truncate text-left text-ink hover:text-brand"
      >
        {attachment.file_name}
      </button>
      <button
        type="button"
        onClick={onView}
        aria-label={`Open ${attachment.file_name}`}
        className="shrink-0 rounded-lg p-2 text-muted transition hover:text-brand"
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${attachment.file_name}`}
        className="shrink-0 rounded-lg p-2 text-muted transition hover:text-bad disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

function InProcessPanel({ lines }: { lines: AcknowledgementLine[] }) {
  return (
    <section>
      <SectionLabel>Still in process</SectionLabel>
      <p className="mt-1 text-xs text-muted">
        {lines.length} approved item{lines.length === 1 ? " is" : "s are"} not in this
        delivery yet. Nothing here needs anything from you.
      </p>
      <ul className="mt-2 divide-y divide-line">
        {lines.map((line) => (
          <InProcessLine key={line.indent_item_id} line={line} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One approved item that is not in the opened package.
 *
 * It reads the same way a line that DID arrive reads -- the stage it has got to and
 * the quantity that proves it -- because "with procurement" on its own answers where
 * the goods are and not how much of the line is there. A line served in rounds is the
 * common case: two of ten off the shelf, eight being bought in, and the eight showed
 * here as a sentence with no number against it. `lineStage` / `STAGE` / `STAGE_HINT`
 * are the list screen's own vocabulary (`acknowledgementParts`), so the two screens
 * cannot word or colour the same state differently.
 */
function InProcessLine({ line }: { line: AcknowledgementLine }) {
  const stage = lineStage(line);
  const { label, tone, icon: StageIcon, caption } = STAGE[stage];
  const ordered = onOrder(line);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold leading-snug text-ink">
          {line.item_name ?? line.item_code}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-muted">{line.item_code}</div>
        <div className="mt-1.5 text-xs text-muted">
          {qty(line.approved_quantity)} approved
          {/* Only where there is one: a zero on every other row is noise, and on the
              row that has it this is the whole answer. */}
          {ordered > 0 && (
            <> &middot; <b className="font-semibold tabular-nums text-warn">{qty(ordered)}</b> on order</>
          )}
          {" "}&middot; {qty(line.dispatched_quantity)} sent &middot; {qty(line.received_quantity)} received
        </div>
      </div>
      <div className="min-w-0 shrink-0 sm:max-w-[240px] sm:text-right">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ${tone}`}>
          <StageIcon className="h-3.5 w-3.5" aria-hidden />
          {stage === "on_order" && ordered > 0 ? `${label} ${qty(ordered)}` : label}
        </span>
        {/* The server's sentence, so the screen and the documents behind it cannot
            word the same state differently. */}
        <div className="mt-1 text-xs font-medium text-body">
          {line.pending_with || caption}
        </div>
        <div className="mt-0.5 text-[11px] text-muted">
          {STAGE_HINT[stage] ?? "No receipt quantity is open for this item yet."}
        </div>
      </div>
    </li>
  );
}

/** The shipment in one line, for a leg with no event trail to show. */
function CompactShipmentCard({ leg }: { leg: ReceiptLeg }) {
  const handle = leg.lr_no ?? leg.docket_no ?? null;
  const who = leg.carrier_name
    || [leg.vehicle_number, leg.driver_name].filter(Boolean).join(" | ");
  return (
    <div className="flex items-start gap-2.5">
      <Truck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0">
        <div className="text-sm text-body">{who || "Hand delivery"}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
          <span className="font-mono">{leg.tr_no}</span>
          <span aria-hidden>&middot;</span>
          <span>{leg.status.replace(/_/g, " ").toLowerCase()}</span>
          {handle && (
            <>
              <span aria-hidden>&middot;</span>
              <span>docket <span className="font-mono text-body">{handle}</span></span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
