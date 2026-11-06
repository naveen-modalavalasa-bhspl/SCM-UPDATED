import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  INDENT_ACK_HOME, TRANSFER_ACK_HOME, ackDetailPath, isTransferRow,
} from "../ackPaths";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, Barcode, Boxes, Building2, CalendarClock,
  Camera, Check, CheckCircle2, ChevronDown, Circle, ExternalLink, Eye, FileText, Hash,
  Lock, MapPin, Package, Phone, Plus, Receipt, RectangleHorizontal, Ruler, ScanBarcode,
  PackageCheck as PackageCheckIcon, Send, Signature, Snowflake, Tag, Trash2, Truck, UserRound, Weight,
} from "lucide-react";
import { tripProgressText, tripStopLabel } from "../components/tripLeg";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader, SharedAttachmentViewer,
} from "@/shared/components";
import { alerts } from "@/modules/alerts";
import {
  PackChips, PackQty, baseOf, packsIn, shrinkWithin, usePackOptions, type PackEntry,
} from "@/shared/packing";
import { SerialNumbersModal } from "@/modules/warehouse/components/SerialNumbersModal";
import { DocLabelsDialog } from "@/modules/warehouse/components/DocLabelsDialog";
import { TrackingBadge, useTrackingMeta } from "@/modules/warehouse/components/TrackingBadge";
import type { TrackingType } from "@/modules/warehouse/types";
import { indentApi, indentKeys, receiptApi, useIndentAccountScope, type ReceiptKind } from "../api";
import { cancelIndentReceiptReads, commitConfirmedIndentReceipt } from "../receiptRefresh";
import type {
  Acknowledgement, AcknowledgementLine, AcknowledgementPackageQuantity, Indent,
  RaiserTracking, ReceiptAttachment, ShipmentTrack,
} from "../types";
import {
  BILL, PHOTO, STAGE, STAGE_HINT, TRACKING, dayStamp, lineStage, neededBy, onOrder, qty,
  receivable, shortDate,
} from "../components/acknowledgementParts";
import { CombinationTag, combinationKey, combinationLabel } from "@/shared/combination";
import { PackageCheckModal, packGroups, shortPackCode, type PackageCheck } from "@/shared/components";

/**
 * One indent's delivery, walked the way the delivery itself happens.
 *
 * It is a JOURNEY: the handover, then one stop per package. One stop is
 * on screen at a time and the rail above says where you are, so the page asks exactly
 * one question at each point. Nothing is locked — every stop on the rail is a button,
 * because a delivery is not a wizard and somebody re-checking package two is not doing
 * anything wrong.
 *
 * **Every stop keeps its OWN photos.** The proof of a sealed load and the proof of what
 * was inside a particular carton are different evidence. The package rides on
 * `doc_category` as a scope (`RECEIPT_PHOTO::P-<key>`, `service.ack_category_base` in
 * the backend) because `sys_attachments` has no column for it and adding one is a
 * platform change for a fact only this screen has. The BILL is the delivery's, not a
 * carton's, so it is added once, on the first consignment, and every bill already
 * filed — at whichever stop — is listed there.
 *
 * The receipt action itself is unchanged and still single: one Acknowledge press in
 * the footer, over everything counted at every stop, and it unlocks only once every
 * package is finished — each item counted, photographed IN THAT PACKAGE, and its
 * codes matched in that package. There is no sign-off stop and no Back/Next: the rail
 * and the package rows are the navigation.
 *
 * THE LOOK (2026-09-26). One sheet per step, one card shape, and four colours that each
 * mean one thing: the brand for what you press, green for done, amber for "you must",
 * grey for "not yet" or "optional". The previous pass drew packing tape, fake barcode
 * bars, viewfinder corners and three accent colours of its own; each was decoration
 * the eye had to learn to skip before it reached the number it came for.
 */
/** Which receipt the page is showing: an indent's, or a DIRECT material issue's
 *  (`/indents/acknowledgements/issue/:issueId`). Read by the photo tiles, which fetch
 *  their own bytes. */
const ReceiptKindContext = createContext<ReceiptKind>("indent");

export default function AcknowledgementDetailPage({ kind = "indent" }: { kind?: ReceiptKind } = {}) {
  const params = useParams();
  const nav = useNavigate();
  const indentId = Number(kind === "issue" ? params.issueId : params.indentId);
  const qc = useQueryClient();
  const accountScope = useIndentAccountScope();

  const acknowledgements = useQuery({
    queryKey: ["indent-acknowledgements", {}],
    queryFn: () => indentApi.myAcknowledgements({}),
    enabled: kind === "indent",
  });
  const directIssue = useQuery({
    queryKey: ["direct-issue-receipt", indentId],
    queryFn: () => indentApi.directIssueReceipt(indentId),
    enabled: kind === "issue",
  });
  const source = kind === "issue" ? directIssue : acknowledgements;

  const row = useMemo<Acknowledgement | undefined>(
    () => (kind === "issue"
      ? directIssue.data
      : (acknowledgements.data ?? []).find((item) => item.indent_id === indentId)),
    [kind, directIssue.data, acknowledgements.data, indentId],
  );

  // Mounted twice: under Indents for departmental receipts, and under Inventory >
  // Stock Transfer for every transfer (STR and direct STO). Back goes to the desk the
  // page was opened from — a transfer never lands on the indents list (2026-10-29).
  const transferRoute = useLocation().pathname.startsWith("/inventory/transfers");
  const back = {
    to: transferRoute ? TRANSFER_ACK_HOME
      : kind === "issue" ? `${INDENT_ACK_HOME}?view=direct` : INDENT_ACK_HOME,
    label: transferRoute ? "Back to Stock Transfer acknowledgements" : "Back to Acknowledgements",
  };

  if (source.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader title="Acknowledgement" back={back} />
        {/* The shape of the page that is coming, so nothing jumps when it lands. */}
        <div className="animate-pulse space-y-4">
          <div className="rounded-3xl bg-content1 px-5 py-5 sm:px-7">
            <div className="h-3 w-28 rounded bg-content3" />
            <div className="mt-3 h-4 w-48 rounded bg-content3" />
            <div className="mt-6 flex gap-8">
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="h-7 w-7 rounded-full bg-content3" />
              ))}
            </div>
          </div>
          <div className="h-72 rounded-3xl bg-content1" />
        </div>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="space-y-4">
        <PageHeader title="Acknowledgement" back={back} />
        <ErrorBanner error={source.error} />
        <Card className="p-4">
          <EmptyState
            title={kind === "issue" ? "This issue is not yours to acknowledge" : "This indent is not on your acknowledgements list"}
            hint="It may belong to someone else, or it has not reached the delivery stage yet."
          />
        </Card>
      </div>
    );
  }

  // An STR opened at the old indents address (a notification, a bookmark) moves to
  // the Stock Transfer desk, query intact.
  if (!transferRoute && kind === "indent" && isTransferRow(row)) {
    return <Navigate to={`${ackDetailPath(row.indent_id, true)}${window.location.search}`} replace />;
  }

  return (
    <ReceiptKindContext.Provider value={kind}>
      <AcknowledgementDetail
        row={row}
        kind={kind}
        backTo={back.to}
        backLabel={back.label}
        qc={qc}
        accountScope={accountScope}
        onDone={() => nav(back.to)}
      />
    </ReceiptKindContext.Provider>
  );
}

/* ---------------------------------------------------------------------------
 * The journey: one stop per thing a person physically does.
 * ------------------------------------------------------------------------ */

type StopKind = "gate" | "package";

interface Stop {
  key: string;
  kind: StopKind;
  /** What the rail calls it — the consignment number, the package number. */
  label: string;
  /** The same stop in the words of somebody who has never used the system: "The
   *  consignment", "Package 1 of 2", "Finish". The code is what the DOCUMENT is called;
   *  a person standing at a pallet needs to be told which of four things he is on. */
  plain: string;
  /** Which pile of proof is this stop's own. */
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
      // against it.
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
  // No sign-off stop (2026-09-26). It repeated what the packages had already said and
  // made the one press that matters the last of five; the footer's Acknowledge button
  // unlocks the moment every package is finished instead.
  return stops;
}

/** One thing that has to be true before a stop is finished, and whether it is. */
interface StepTask {
  done: boolean;
  /** Short and plain: "Count all 3 items", "Photo of each item (1 of 3)". */
  label: string;
  /** Good to have, never required to sign — drawn grey rather than amber, so the
   *  one colour that means "you must" is spent only on what you must. */
  optional?: boolean;
}

/**
 * Where a stop stands. `optional` is its own state because a step with nothing
 * REQUIRED on it is not unfinished: the consignment photo is recommended, and a rail
 * that kept that step amber forever told everybody who skipped it that they had left
 * something undone. It is drawn as a hollow ring instead — not done, not owed.
 */
type StopState = "done" | "optional" | "todo";

function AcknowledgementDetail({ row, kind, onDone, accountScope, qc, backTo, backLabel }: {
  row: Acknowledgement;
  kind: ReceiptKind;
  onDone: () => void;
  backTo: string;
  backLabel: string;
  accountScope: ReturnType<typeof useIndentAccountScope>;
  qc: QueryClient;
}) {
  const [received, setReceived] = useState<Record<string, string>>(() =>
    initialReceivedByReceiptLine(row.lines));
  // The open stop lives in the URL, not in state (2026-09-26). Held in state, opening
  // a package added no history entry, so the browser's Back from inside a package
  // skipped every stop and left the acknowledgement altogether. `?stop=` gives each
  // stop its own entry: Back from a package lands on the consignment it came out of,
  // and a reload or a shared link reopens the same carton.
  const [params, setParams] = useSearchParams();
  const stopKey = params.get("stop") ?? "";
  const [serialTarget, setSerialTarget] = useState<ReceiptPackageLine | null>(null);
  const [pickedSerials, setPickedSerials] = useState<Record<string, string[]>>({});
  // Packages checked carton by carton, for lines issued in packages (2026-10-26).
  const [packChecks, setPackChecks] = useState<Record<string, PackageCheck>>({});
  // Labels for what was RECEIVED on one consignment (2026-10-28) — never what was sent.
  const [labelDispatch, setLabelDispatch] = useState<number | null>(null);
  const [viewing, setViewing] = useState<
    { files: ReceiptAttachment[]; index: number } | null>(null);

  const trackingMeta = useTrackingMeta();
  const server = receiptApi(kind);

  const attachments = useQuery({
    queryKey: [kind === "issue" ? "direct-issue-receipt-attachments" : "indent-receipt-attachments", row.indent_id],
    queryFn: () => server.attachments(row.indent_id),
  });

  // A direct issue has no indent to ask logistics about; its legs are on the row.
  const tracking = useQuery({
    queryKey: indentKeys.shipments(accountScope, row.indent_id),
    queryFn: ({ signal }) => indentApi.shipmentsForIndent(row.indent_id, signal),
    refetchOnWindowFocus: true,
    enabled: kind === "indent",
  });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: string }) =>
      server.upload(row.indent_id, file, category),
    onSuccess: () => attachments.refetch(),
  });

  const remove = useMutation({
    mutationFn: (attachmentId: number) => server.remove(attachmentId),
    onSuccess: () => attachments.refetch(),
  });

  const confirm = useMutation({
    mutationFn: () =>
      server.acknowledge(
        row.indent_id,
        acknowledgementPayload(row.lines, received, packChecks),
      ),
    onMutate: () => (kind === "indent"
      ? cancelIndentReceiptReads(qc, accountScope, row.indent_id) : undefined),
    onSuccess: async (updated) => {
      if (kind === "indent") {
        await commitConfirmedIndentReceipt(qc, accountScope, updated as Indent);
      }
      qc.invalidateQueries({ queryKey: ["direct-issue-acknowledgements"] });
      qc.invalidateQueries({ queryKey: ["direct-issue-receipt"] });
      qc.invalidateQueries({ queryKey: ["indent-acknowledgements"] });
      qc.invalidateQueries({ queryKey: ["indent-fulfilment"] });
      // Said out loud. The press used to drop the person back on the list with
      // nothing to say it had worked, which is how a receipt gets signed twice.
      void alerts.success("issue.acknowledged", { number: row.indent_no });
      onDone();
    },
  });

  const allAttachments = attachments.data ?? [];
  /**
   * Every filed item photo, indexed by its full scope — `I-<line>-<package hash>` —
   * so a photo belongs to ONE item in ONE package.
   *
   * Per package, not per line (2026-09-26). The same item split over two cartons of
   * five is two things to check: photographing it while the first carton was open
   * used to tick the second carton off too, before anybody had opened it. The server
   * still counts by line (`ack_category_item`), so this is the stricter of the two
   * and the save can never refuse what the screen let through.
   */
  const photosByScope = useMemo(() => {
    const index = new Map<string, ReceiptAttachment[]>();
    allAttachments.forEach((file) => {
      if (attachmentBase(file.doc_category) !== PHOTO) return;
      const scope = attachmentScope(file.doc_category);
      if (scopeItemId(scope) === null) return;
      index.set(scope, [...(index.get(scope) ?? []), file]);
    });
    return index;
  }, [allAttachments]);
  const photosOf = (line: ReceiptPackageLine, packKey: string) =>
    photosByScope.get(itemProofScope(line.indent_item_id, packKey)) ?? [];
  const bills = allAttachments.filter((file) => attachmentBase(file.doc_category) === BILL);
  const anythingToConfirm = row.lines.some((line) => receivable(line) > 0);
  const waiting = row.lines.reduce((sum, line) => sum + receivable(line), 0);
  const nothingSentYet = row.lines.every((line) => line.dispatched_quantity <= 0);
  // A leg booked but not yet released by logistics: the goods are still in the yard,
  // so there is nothing to confirm. Named, so the requester knows whom to chase
  // instead of reading "Nothing to acknowledge" as the screen being broken.
  const heldLeg = nothingSentYet
    ? (tracking.data ?? []).find((leg) =>
      ["DRAFT", "PENDING_APPROVAL", "QUOTING", "AWAITING_CARRIER", "READY"].includes(leg.status))
    : undefined;
  const receivingSummary = useMemo(() => {
    const payload = acknowledgementPayload(row.lines, received);
    return {
      quantity: payload.reduce((sum, line) => sum + line.received_quantity, 0),
      lines: payload.length,
    };
  }, [row.lines, received]);
  const entered = receivingSummary.quantity > 0;

  const consignments = useMemo(
    () => receiptConsignments(row, tracking.data),
    [row, tracking.data],
  );
  const stops = useMemo(() => journeyStops(consignments), [consignments]);
  const activeIndex = Math.max(stops.findIndex((item) => item.key === stopKey), 0);
  const stop = stops[activeIndex];

  /** This stop's own proof, and — on the first handover only — anything filed before
   *  the scope existed (or against the indent itself, before a consignment could be
   *  named), so nothing an earlier receipt attached disappears from view. */
  const proofFor = (target: Stop) => allAttachments.filter((file) => {
    const scope = attachmentScope(file.doc_category);
    return scope === target.scope
      || (Boolean(target.legacyProof) && (scope === "" || scope === LEGACY_DIRECT_SCOPE));
  });
  /** The PHOTOS of a stop. The bills are listed once, on the first consignment. */
  const photosFor = (target: Stop) => proofFor(target).filter(
    (file) => attachmentBase(file.doc_category) === PHOTO);

  /** Where one item in one package stands: counted, photographed in THIS package,
   *  and — for coded goods — every unit's code matched in THIS package. A line
   *  counted at zero owes nothing else: there is nothing there to photograph. */
  const lineProgress = (line: ReceiptPackageLine, packKey: string) => {
    const value = received[line.receipt_key] ?? "";
    const counted = value.trim() !== "";
    const count = receivedNumber(value);
    const photographed = count <= 0 || photosOf(line, packKey).length > 0;
    const serials = line.serial_numbers?.filter(Boolean) ?? [];
    const needSerials = requiredSerialCount(line, value);
    const matched = serialPickForQuantity(
      serials, pickedSerials[line.receipt_key], needSerials).length;
    return {
      counted,
      count,
      photographed,
      coded: serials.length > 0,
      serialsDone: matched >= needSerials,
    };
  };

  const countedFor = (pack?: ReceiptPackage) => {
    const lines = (pack?.lines ?? []).filter(
      (line) => Number(line.package_quantity ?? receivable(line)) > 0);
    const progress = lines.map((line) => lineProgress(line, pack?.key ?? ""));
    const present = progress.filter((item) => item.count > 0);
    const coded = present.filter((item) => item.coded);
    return {
      total: lines.length,
      done: progress.filter((item) => item.counted).length,
      // Counted over the ITEMS in the carton rather than over the photos filed
      // against it: two shots of one cable and none of the other is not "2 of 2".
      toPhotograph: present.length,
      photographed: present.filter((item) => item.photographed).length,
      coded: coded.length,
      matched: coded.filter((item) => item.serialsDone).length,
    };
  };

  /**
   * What this stop still needs, in the words of the person standing at the delivery.
   *
   * One list answers both "is it done" and "what is left": the checklist on the sheet
   * renders it and `stopState` reads it, so the tick and the to-do list cannot drift
   * apart the way two copies of a rule always eventually do.
   */
  const tasksFor = (target: Stop): StepTask[] => {
    if (target.kind === "gate") {
      // REQUIRED (2026-09-28). The sealed load, the seal and the number plate are what
      // a claim against the carrier is argued from, and a photo taken after the
      // cartons are open cannot show them. The server refuses a receipt without one.
      return [{
        done: photosFor(target).length > 0,
        label: "Photo of the consignment",
      }];
    }
    const counted = countedFor(target.pack);
    // Nothing receivable in this package: it is finished by having nothing to do,
    // and asking for a photo of it would block a delivery over an empty carton.
    if (counted.total === 0) {
      return [{ done: true, label: "Nothing to do in this package" }];
    }
    const tasks: StepTask[] = [{
      done: counted.done === counted.total,
      label: counted.total === 1 ? "Count the item" : `Count all ${counted.total} items`,
    }];
    if (counted.toPhotograph > 0) {
      tasks.push({
        // ITEM-WISE, and the count is in the label: "Photo of each item" on a
        // carton of eleven says a photo is missing and never how many.
        done: counted.photographed === counted.toPhotograph,
        label: counted.toPhotograph === 1
          ? "Photo of the item"
          : `Photo of each item (${counted.photographed} of ${counted.toPhotograph})`,
      });
    }
    if (counted.coded > 0) {
      tasks.push({
        done: counted.matched === counted.coded,
        label: counted.coded === 1
          ? "Match the serial numbers"
          : `Match serial numbers (${counted.matched} of ${counted.coded})`,
      });
    }
    return tasks;
  };

  /**
   * Read off the live counts and the filed attachments, never remembered: delete the
   * only photo and the tick goes, take another and it comes back. Only REQUIRED tasks
   * decide green; a step whose every task is optional is `optional` until it is done.
   */
  const stopState = (target: Stop): StopState => {
    const tasks = tasksFor(target);
    const required = tasks.filter((task) => !task.optional);
    if (required.length === 0) return tasks.every((task) => task.done) ? "done" : "optional";
    return required.every((task) => task.done) ? "done" : "todo";
  };

  const uploadFile = (scope: string) => (file: File, base: string) =>
    upload.mutate({ file, category: scopedCategory(base, scope) });

  const go = (index: number) => {
    const key = stops[Math.min(Math.max(index, 0), stops.length - 1)].key;
    if (key === stop.key) return;   // re-pressing the open stop is not a step to go back over
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("stop", key);
      return next;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  /** Inside a package, the header goes back to the consignment it came out of — one
   *  level up — never straight out to the list with the delivery half checked. */
  const parentStop = stop.kind === "package"
    ? stops.find((item) => item.kind === "gate" && item.consignment?.key === stop.consignment?.key)
    : undefined;

  const packageStops = stops.filter((item) => item.kind === "package");
  /** The stops still owing something. Acknowledge unlocks only when this is empty:
   *  every consignment photographed, every package counted, each item in it
   *  photographed, every code matched. */
  const unfinished = stops.filter((item) => stopState(item) !== "done");
  const ready = anythingToConfirm && entered && unfinished.length === 0;
  /** Why Acknowledge is unavailable, named rather than counted. A disabled button with
   *  nothing beside it is the single most common way a screen strands somebody who
   *  does not already know the rule; "1 package left" on a load of six sends them
   *  through every carton to find out which. */
  const blocker = !anythingToConfirm || ready
    ? null
    : unfinished.length > 0
      ? `Still to finish: ${sentenceList(unfinished.slice(0, 3).map((item) => {
        const owed = tasksFor(item).filter((task) => !task.done && !task.optional);
        return `${item.plain} (${owed.map((task) => shortTask(task.label)).join(", ")})`;
      }))}${unfinished.length > 3 ? ` and ${unfinished.length - 3} more` : ""}`
      : "Count at least one item first";

  const sharedPhotoProps = {
    indentId: row.indent_id,
    uploadPending: upload.isPending,
    removePending: remove.isPending,
    onView: (files: ReceiptAttachment[], index: number) => setViewing({ files, index }),
    onDelete: (id: number) => remove.mutate(id),
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={row.indent_no}
        back={parentStop
          ? { to: `?stop=${encodeURIComponent(parentStop.key)}`, label: `Back to ${parentStop.plain.toLowerCase()}` }
          : { to: backTo, label: backLabel }}
      />

      <ErrorBanner error={confirm.error ?? upload.error ?? remove.error} />

      {/* Once something has been acknowledged, its labels can be printed here — only
          what arrived, each package at what arrived in it (`received_labels`). */}
      {row.lines.some((line) => line.received_quantity > 0) && packedDispatches(row.lines).size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-content1 px-4 py-3">
          <span className="mr-1 flex items-center gap-2 text-sm text-ink">
            <Tag className="h-4 w-4 text-brand" aria-hidden /> Labels for what you received
          </span>
          {[...packedDispatches(row.lines).entries()].map(([dispatchId, dispatchNo]) => (
            <Button key={dispatchId} variant="subtle" onClick={() => setLabelDispatch(dispatchId)}>
              {dispatchNo || `Consignment ${dispatchId}`}
            </Button>
          ))}
        </div>
      )}
      {labelDispatch !== null && <DocLabelsDialog open={labelDispatch !== null} onClose={() => setLabelDispatch(null)}
                       doc={labelDispatch !== null ? { type: "RECEIPT", id: labelDispatch } : null} />}

      <ReceiptHeader
        row={row}
        waiting={waiting}
        anythingToConfirm={anythingToConfirm}
        nothingSentYet={nothingSentYet}
      >
        <JourneyRail
          stops={stops}
          activeIndex={activeIndex}
          stateOf={stopState}
          onJump={go}
        />
      </ReceiptHeader>

      {stop.kind === "gate" && (
        <GateStop
          stop={stop}
          tasks={tasksFor(stop)}
          photos={photosFor(stop)}
          loading={tracking.isLoading}
          failed={Boolean(tracking.error)}
          onUpload={uploadFile(stop.scope)}
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
            return {
              done: target ? stopState(target) === "done" : false,
              countedDone: counted.done,
              countedTotal: counted.total,
              // ITEMS photographed, not photos filed, so it is the same kind of number
              // as the count beside it.
              photographed: counted.photographed,
              toPhotograph: counted.toPhotograph,
            };
          }}
          // The bill is the delivery's, not a carton's: offered once, on the first
          // consignment, now that there is no sign-off stop to carry it.
          bills={stop.legacyProof ? bills : null}
          onUploadBill={uploadFile("")}
          inProcess={stop.legacyProof
            ? row.lines.filter((line) =>
              receivable(line) <= 0
              && Number(line.approved_quantity ?? 0) > Number(line.received_quantity ?? 0))
            : []}
          {...sharedPhotoProps}
        />
      )}

      {stop.kind === "package" && stop.pack && (
        <PackageStop
          pack={stop.pack}
          tasks={tasksFor(stop)}
          position={packageStops.findIndex((item) => item.key === stop.key) + 1}
          total={packageStops.length}
          photos={photosFor(stop)}
          received={received}
          pickedSerials={pickedSerials}
          packChecks={packChecks}
          onPackCheck={(key, check) => setPackChecks((current) => ({ ...current, [key]: check }))}
          photosOf={(line) => photosOf(line, stop.pack?.key ?? "")}
          onUpload={uploadFile(stop.scope)}
          // The item's own shot, filed against the LINE and the carton it was taken
          // in. `uploadFile` files against the stop; this one files against the row.
          onUploadItem={(line, file) => upload.mutate({
            file,
            category: scopedCategory(
              PHOTO, itemProofScope(line.indent_item_id, stop.pack?.key ?? "")),
          })}
          onChange={(key, value) =>
            setReceived((current) => ({ ...current, [key]: value }))}
          onPickSerials={setSerialTarget}
          {...sharedPhotoProps}
        />
      )}

      {/* One line of words, one button. No Back/Next: the rail and the package rows
          move between steps, and the only press this bar exists for is Acknowledge,
          which unlocks once every package is finished. The line wraps rather than
          truncating: on a phone the named unfinished package is the part that was
          being cut off. */}
      <div className="sticky bottom-0 z-10 -mx-1 rounded-t-2xl border-t border-line bg-content1/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className={`flex min-w-0 flex-1 items-start gap-1.5 text-xs leading-snug ${
            blocker ? "text-warn" : ready ? "font-semibold text-ok" : "text-muted"
          }`}>
            {blocker
              ? <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              : ready && <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="line-clamp-2">
              {anythingToConfirm
                ? blocker
                  ?? `Ready to acknowledge: ${qty(receivingSummary.quantity)} across ${receivingSummary.lines} item${receivingSummary.lines === 1 ? "" : "s"}`
                : heldLeg
                  ? `Nothing to acknowledge yet — shipment ${heldLeg.tr_no} is ${heldLeg.status.replace(/_/g, " ").toLowerCase()} and has not left the warehouse. Logistics must dispatch it first.`
                  : "Nothing to acknowledge."}
            </span>
          </p>
          {anythingToConfirm && (
            <div className="flex shrink-0 items-center justify-end">
              <Button
                onClick={() => confirm.mutate()}
                disabled={!ready || confirm.isPending}
              >
                <Signature className="h-4 w-4" />
                {confirm.isPending ? "Saving..." : "Acknowledge"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {viewing && (
        <SharedAttachmentViewer
          attachments={viewing.files}
          initialIndex={viewing.index}
          onClose={() => setViewing(null)}
          onDownload={(file) =>
            server.download(row.indent_id, file.id)}
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
        displayValue={shortCode}
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
  /** What the packer put in this package of the line (2026-10-22). */
  package_pack_breakdown?: PackEntry[] | null;
  /** The PACKAGES (codes) this carton holds of a line issued in packages (2026-10-26). */
  package_box_codes?: { code: string; quantity: number; received?: number | null;
    name?: string | null; path?: { code: string; name?: string | null }[] | null;
    inner?: { code: string; name?: string | null; carries: number; part?: boolean }[] | null }[] | null;
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
  /** True when `no` is a real consignment (DSP) number rather than the indent's own,
   *  the last resort for a delivery nothing was ever despatched under. */
  isConsignment: boolean;
  packages: ReceiptPackage[];
}

/** The key the one no-shipment consignment used before it was named by its DSP
 *  number. Photos filed under it are still shown on the first consignment. */
const LEGACY_DIRECT_SCOPE = proofScope("C", "direct");

/** Every consignment the packing lists name, in the order they first appear. */
function packedDispatches(lines: AcknowledgementLine[]) {
  const seen = new Map<number, string>();
  lines.forEach((line) => (line.package_quantities ?? []).forEach((part) => {
    if (part.dispatch_id && !seen.has(part.dispatch_id)) {
      seen.set(part.dispatch_id, (part.dispatch_no ?? "").trim());
    }
  }));
  return seen;
}

function receiptConsignments(
  row: Acknowledgement,
  liveTracking?: RaiserTracking[],
): ReceiptConsignment[] {
  const legs: ReceiptLeg[] = (liveTracking?.length ? liveTracking : row.shipments) ?? [];
  const dispatches = packedDispatches(row.lines);
  if (legs.length === 0) {
    // No carrier was booked — a load the warehouse gated out itself. It still left
    // under a consignment, and the DSP number is the one on the paper in the driver's
    // hand, so the stop is named after it. The indent number is only the last resort,
    // for a delivery nothing was ever packed against.
    if (dispatches.size > 0) {
      return [...dispatches].map(([dispatchId, dispatchNo], index) => ({
        key: `dispatch-${dispatchId}`,
        no: dispatchNo || `Consignment ${index + 1}`,
        isConsignment: true,
        packages: receiptPackages(row.lines, dispatchId, true),
      }));
    }
    return [{
      key: "direct",
      no: row.indent_no,
      isConsignment: false,
      packages: receiptPackages(row.lines),
    }];
  }
  return legs.map((leg, index) => ({
    // A multi-drop trip's ONE shipment can carry two of this indent's consignments,
    // so its legs are keyed by consignment too — sharing `tr_id` would file one
    // consignment's photos under the other. Single-shipment legs keep the key their
    // photos were filed under.
    key: "trip_id" in leg && leg.trip_id && leg.dispatch_id
      ? `trip-${leg.trip_id}-${leg.dispatch_id}` : `leg-${leg.tr_id ?? index}`,
    no: leg.consignment_no
      || (leg.dispatch_id ? dispatches.get(leg.dispatch_id) : "")
      || leg.tr_no
      || `Consignment ${index + 1}`,
    leg,
    isConsignment: true,
    packages: receiptPackages(row.lines, leg.dispatch_id ?? null, true),
  }));
}

function receiptPackages(
  lines: AcknowledgementLine[],
  dispatchId?: number | null,
  /** Only this consignment's packages, never the whole delivery's as a fallback: the
   *  consignments were derived FROM the packing lists, so a line with nothing in this
   *  one belongs to another and must not be listed twice. */
  strict = false,
): ReceiptPackage[] {
  // If scoped to a specific dispatch, only inspect lines that belong to that dispatch:
  const scopedLines = dispatchId
    ? lines.filter((line) =>
        (line.package_quantities ?? []).some((part) => part.dispatch_id === dispatchId)
      )
    : lines;

  // Filter out lines that were never dispatched at all (e.g. unfulfilled shortfall lines)
  const dispatchedLines = scopedLines.filter(
    (line) =>
      (line.package_quantities && line.package_quantities.length > 0) ||
      Number(line.dispatched_quantity ?? 0) > 0
  );
  const visible = dispatchedLines.length > 0 ? dispatchedLines : scopedLines;
  const byPackage = new Map<string, ReceiptPackage>();

  visible.forEach((line) => {
    const parts = packagePartsForLine(line, dispatchId, strict);
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

  if (byPackage.size > 0 || strict) return [...byPackage.values()];

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
  strict = false,
): AcknowledgementPackageQuantity[] {
  const all = (line.package_quantities ?? [])
    .filter((part) => Number(part.quantity ?? 0) > 0);
  const scoped = dispatchId
    ? all.filter((part) => part.dispatch_id === dispatchId)
    : all;
  const parts = scoped.length > 0 || strict ? scoped : all;
  if (parts.length === 0) return [];

  const partsSent = parts.reduce((sum, p) => sum + Number(p.quantity ?? 0), 0);
  const target = receivable(line) > 0
    ? Math.min(receivable(line), partsSent)
    : partsSent;
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
    package_pack_breakdown: part.pack_breakdown ?? null,
    package_box_codes: part.box_codes?.length ? part.box_codes : null,
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
  checks: Record<string, PackageCheck> = {},
) {
  return lines
    .map((line) => {
      const parts = packagePartsForLine(line);
      const total = parts.length > 0
        ? parts.reduce((sum, part) =>
          sum + receivedNumber(received[packageLineKey(line, part)]), 0)
        : receivedNumber(received[fallbackLineKey(line)]);
      // Packages that came short or missing, by code (2026-10-26).
      const packageReceipts: Record<string, number> = {};
      parts.forEach((part) => {
        const check = checks[packageLineKey(line, part)];
        if (!check) return;
        (part.box_codes ?? []).forEach((pkg) => {
          if (!check.kept.includes(pkg.code)) packageReceipts[pkg.code] = 0;
          else if ((check.partial[pkg.code] ?? 0) > 0) {
            packageReceipts[pkg.code] = Number(pkg.quantity) - check.partial[pkg.code];
          }
        });
      });
      return {
        indent_item_id: line.indent_item_id,
        received_quantity: Math.min(total, receivable(line)),
        ...(Object.keys(packageReceipts).length ? { package_receipts: packageReceipts } : {}),
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
  const kept = (selected ?? [])
    .filter((serial) => allowedSet.has(serial))
    .slice(0, required);
  // Auto-selected against the counted quantity (2026-10-07): the codes this package
  // carries are listed in the order they were packed, so the first ones not already
  // matched fill up to the count. The person counting only opens the list to swap a
  // code that is not actually in the box — they are never made to tick sixty by hand.
  if (kept.length >= required) return kept;
  const chosen = new Set(kept);
  return [...kept, ...allowed.filter((serial) => !chosen.has(serial))].slice(0, required);
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
 * receipt photo filed before the scopes — stays a photo.
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
/**
 * A unit code as the person at the delivery reads it: the tail after the last hyphen,
 * leading zeros dropped — `304040-WATER-CAN-SUPREME-SUPREME-0001-1-00003601` is 3601.
 * Every code on one line shares the long prefix, so it was the only part of each row
 * the truncation left visible. Display only: search, selection and the save still
 * use the full code, which stays on hover.
 */
function shortCode(code: string) {
  const cut = code.lastIndexOf("-");
  // No hyphen: a maker's own serial or IMEI, shown exactly as printed on the unit.
  if (cut < 0) return code;
  const tail = code.slice(cut + 1);
  if (!tail) return code;
  return tail.replace(/^0+(?=.)/, "");
}

function proofScope(prefix: "C" | "P", key: string) {
  const slug = key.toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${slug}`.slice(0, 30);
}

/* ---------------------------------------------------------------------------
 * A photo of one ITEM.
 *
 * A picture of the sealed pallet proves a delivery happened. It proves nothing about
 * what was in it, and every dispute three weeks later is about a particular line —
 * the wrong model of handset, one crushed box of four. So each item being confirmed
 * carries its own shot, and the scope names the indent LINE.
 *
 * ONE photo per item, never one per unit. Sixty cables are photographed once;
 * a rule that asked for sixty is a rule satisfied with sixty pictures of one bundle.
 *
 * The item id comes FIRST and the package second (`I-<line>-<package>`), because the
 * server counts by line and the screen files by carton. `indents.service`'s
 * `ack_category_item` reads the same shape, and matches on the id alone — so an item
 * split across two packages, photographed while the first was open, is not demanded
 * again when the second is opened.
 * ------------------------------------------------------------------------ */

/** The scope for one line's own photo, taken while `packKey`'s carton was open. */
function itemProofScope(indentItemId: number, packKey: string) {
  // Hashed, not sliced. The package key is `dispatch-4-package-9` today and a
  // vendor's own package_no string when the warehouse never numbered one; a slice
  // lets two long ones collide, which files one carton's proof against another.
  // The scope must also stay inside `ACK_SCOPE_MAX` (30) on the server.
  return `I-${indentItemId}-${shortHash(packKey)}`;
}

/** Which line a filed photo is OF, or null for a shot of the load or a carton. */
function scopeItemId(scope: string): number | null {
  const match = /^I-(\d+)(?:-|$)/.exec(scope);
  return match ? Number(match[1]) : null;
}

/** Six hex characters, deterministic, from any key. FNV-1a — no dependency, and the
 *  only property needed is that two different cartons do not land on one string. */
function shortHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
}

/* ---------------------------------------------------------------------------
 * The frame: who this is for, where you are, and one sheet per step.
 * ------------------------------------------------------------------------ */

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

/** A task's label cut to the one word the footer has room for: "count", "photo",
 *  "serial numbers". Read off the same labels `tasksFor` writes, never a second list. */
function shortTask(label: string) {
  if (label.startsWith("Count")) return "count";
  if (label.startsWith("Photo")) return "photo";
  if (label.startsWith("Match")) return "serial numbers";
  return label.toLowerCase();
}

/**
 * The one strip of chrome on the page: whose delivery this is, how much of it is
 * waiting on you, and — as its children — the rail that says where you are.
 *
 * The step count used to be written three times (a "Step 2 of 5" caption, the rail,
 * and a numbered disc on the sheet) and the job three more (a Count → Photo → Sign
 * strip, the sheet's checklist, the footer). The rail says the first and the sheet
 * says the second; this says only what nothing else on the page does.
 */
function ReceiptHeader({ row, waiting, anythingToConfirm, nothingSentYet, children }: {
  row: Acknowledgement;
  waiting: number;
  anythingToConfirm: boolean;
  nothingSentYet: boolean;
  children: ReactNode;
}) {
  const due = neededBy(row);
  return (
    <section className="rounded-3xl bg-content1 px-5 py-4 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:px-7">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <SectionLabel>Receiving</SectionLabel>
          <div className="mt-1 truncate text-sm font-semibold text-ink">
            {row.project_name ?? "Your indent"}
          </div>
          {due && (
            <div className={`mt-0.5 inline-flex items-center gap-1 text-xs ${
              due.overdue ? "font-semibold text-bad" : "text-muted"
            }`}>
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {due.text}
            </div>
          )}
        </div>
        <div className="text-right">
          {anythingToConfirm ? (
            <>
              <div className="font-display text-3xl font-bold leading-none tabular-nums text-ink">
                {qty(waiting)}
              </div>
              <div className="mt-1 text-xs text-muted">waiting for you to confirm</div>
            </>
          ) : (
            <div className="text-sm text-body">
              {nothingSentYet
                ? "Nothing has been sent to you yet."
                : "Everything sent to you is already received."}
            </div>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Where you are in the delivery, and every other place you could be.
 *
 * Dots on a line: the numeral says which of how many, the name under it says which,
 * green says done. A step with only optional work is a DASHED ring, so skipping the
 * consignment photo does not read as unfinished business. The colours are the
 * product's own rail tokens (`--color-step-*`), the same three every other stepper in
 * the system uses — never the solid brand fill, which draws the brand sweep.
 */
function JourneyRail({ stops, activeIndex, stateOf, onJump }: {
  stops: Stop[];
  activeIndex: number;
  stateOf: (stop: Stop) => StopState;
  onJump: (index: number) => void;
}) {
  return (
    <div className="-mx-1 mt-4 overflow-x-auto border-t border-line pt-3">
      <ol className="flex min-w-max items-start">
        {stops.map((stop, index) => {
          const state = stateOf(stop);
          const active = index === activeIndex;
          const done = state === "done";
          const optional = state === "optional";
          return (
            <li key={stop.key} className="flex items-start">
              {index > 0 && (
                <span
                  aria-hidden
                  className={`mt-[21px] h-0.5 w-6 shrink-0 rounded-full sm:w-12 ${
                    stateOf(stops[index - 1]) === "done" ? "bg-step-done-rail" : "bg-line"
                  }`}
                />
              )}
              <button
                type="button"
                onClick={() => onJump(index)}
                aria-current={active ? "step" : undefined}
                aria-label={`${stop.plain}${done ? ", finished" : optional ? ", optional" : ""}`}
                title={stop.label}
                className="group flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center transition hover:bg-content2/60 sm:w-[100px]"
              >
                {/* Finished wins the colour, the current step keeps its ring: "where am
                    I" and "is it done" are both answered by the one disc. */}
                <span className={`grid h-[26px] w-[26px] place-items-center rounded-full text-[11px] font-semibold tabular-nums transition ${
                  done
                    ? `bg-step-done text-white ${active ? "ring-4 ring-step-done/25" : ""}`
                    : active
                      ? "bg-step-live text-white ring-4 ring-step-live/20"
                      : optional
                        ? "border-2 border-dashed border-line bg-content1 text-muted"
                        : "bg-content2 text-muted"
                }`}>
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : index + 1}
                </span>
                <span className={`line-clamp-2 text-[11px] leading-tight ${
                  active ? "font-semibold text-ink" : done ? "text-body" : "text-muted"
                }`}>
                  {stop.plain}
                </span>
                {optional && !active && (
                  <span className="-mt-1 text-[10px] text-muted">Optional</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * One step, as a sheet: what this step is, what to do, and the checklist of what it
 * needs — one chip per task, green the moment it is true, amber while it is owed, grey
 * when it is only recommended. Then the work.
 */
function StepSheet({ kicker, headline, note, tasks, children }: {
  /** Which step this is, in two or three words: "At the gate", "Package 1 of 3". */
  kicker: string;
  headline: string;
  note: string;
  tasks: StepTask[];
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl bg-content1 px-5 py-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:px-7">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-step-live">
          {kicker}
        </div>
        <h2 className="mt-1.5 font-display text-xl font-bold leading-tight text-ink sm:text-2xl">
          {headline}
        </h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">{note}</p>
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="This step needs">
          {tasks.map((task) => (
            <li
              key={task.label}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                task.done
                  ? "bg-ok-bg text-ok"
                  : task.optional ? "bg-content2 text-muted" : "bg-warn-bg text-warn"
              }`}
            >
              {task.done
                ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                : <Circle className="h-4 w-4 shrink-0" aria-hidden />}
              <span>{task.label}</span>
              <span className="sr-only">{task.done ? "(done)" : "(not done yet)"}</span>
            </li>
          ))}
        </ul>
      </header>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

/** What every photo strip on the page is handed, whichever pile it is showing. */
interface PhotoProps {
  indentId: number;
  uploadPending: boolean;
  removePending: boolean;
  onView: (files: ReceiptAttachment[], index: number) => void;
  onDelete: (attachmentId: number) => void;
}

/* ---------------------------------------------------------------------------
 * Stop 1: the load at the gate, before anything is opened.
 * ------------------------------------------------------------------------ */

/**
 * Somebody is standing in front of a truck with a delivery note in their hand: the
 * first thing they do is match the paper to the load, the second is photograph it
 * before a single box moves, the third is find the cartons. So: the slip, the camera,
 * the packages — and the trail of how it got here folded away underneath, open on its
 * own only when something went wrong on the road.
 */
function GateStop({
  stop, tasks, photos, loading, failed, onUpload, onOpenPackage, packageLabel,
  packageProgress, bills, onUploadBill, inProcess, ...photoProps
}: {
  stop: Stop;
  tasks: StepTask[];
  photos: ReceiptAttachment[];
  loading: boolean;
  failed: boolean;
  onUpload: (file: File, base: string) => void;
  onOpenPackage: (pack: ReceiptPackage) => void;
  packageLabel: (pack: ReceiptPackage) => string;
  packageProgress: (pack: ReceiptPackage) => PackageProgress;
  /** The delivery's bills, or null on every consignment but the first. */
  bills: ReceiptAttachment[] | null;
  onUploadBill: (file: File, base: string) => void;
  /** Approved lines not in this delivery at all — context, never work. */
  inProcess: AcknowledgementLine[];
} & PhotoProps) {
  const leg = stop.consignment?.leg;
  const packages = stop.consignment?.packages ?? [];
  return (
    <StepSheet
      kicker="At the gate"
      headline="Check the delivery before you open it"
      note="Match the number below with the paper the driver gives you. Walk around the load and photograph anything broken, wet or crushed."
      tasks={tasks}
    >
      <ConsignmentSlip
        no={stop.consignment?.no ?? "Consignment"}
        isConsignment={stop.consignment?.isConsignment ?? false}
        leg={leg}
        packages={packages}
        loading={loading}
        failed={failed}
      />

      <PhotoStrip
        // Named for what the pictures ARE, in the word the paperwork uses: they are
        // the consignment's photos, filed against the number on the slip above.
        title="Consignment photos"
        note="The load, the seal, the number plate and anything damaged. At least one is needed before you can acknowledge."
        required
        buttonLabel="Add photos"
        files={photos}
        onUpload={(file) => onUpload(file, PHOTO)}
        {...photoProps}
      />

      {packages.length > 0 && (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <SectionLabel>
              {packages.length === 1 ? "The package" : `Packages (${packages.length})`}
            </SectionLabel>
            <span className="text-[11px] text-muted">Open them in any order</span>
          </div>
          <ul className="mt-2.5 space-y-2">
            {packages.map((pack) => (
              <PackageRow
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

      {bills && (
        <PhotoStrip
          title="Bill or delivery challan"
          note="If the vendor's bill or a challan came with the goods, add it here. A photo or a PDF."
          optional
          buttonLabel="Add the bill"
          buttonIcon={Receipt}
          accept="image/*,application/pdf"
          files={bills}
          onUpload={(file) => onUploadBill(file, BILL)}
          {...photoProps}
        />
      )}

      {leg && <ArrivalTrail leg={leg} loading={loading} failed={failed} />}

      {inProcess.length > 0 && <InProcessPanel lines={inProcess} />}
    </StepSheet>
  );
}

/**
 * The consignment, drawn as the slip that came with it.
 *
 * The number at the size it is printed on the paperwork, because it is the one string
 * on this screen matched character by character against a piece of paper. Under it the
 * facts, and under those the two things on the card that are ACTIONS rather than facts
 * — ring the driver, open the carrier's tracking page — as real buttons at thumb size,
 * because a load two cartons short is chased while the truck is still outside.
 *
 * The coloured edge is the card's state — green once the carrier has marked it
 * delivered, brand crimson while it is still their responsibility, grey before it
 * leaves — read off the DATES on the row rather than off the status word, so this
 * module never keeps a second private vocabulary for logistics' statuses. There is no
 * status pill; the edge is enough. A fact with nothing behind it is not drawn.
 */
function ConsignmentSlip({ no, isConsignment, leg, packages, loading, failed }: {
  no: string;
  isConsignment: boolean;
  leg?: ReceiptLeg;
  packages: ReceiptPackage[];
  loading: boolean;
  failed: boolean;
}) {
  const landed = leg?.delivered_at ?? leg?.acknowledged_at ?? null;
  const moving = Boolean(leg?.dispatched_at);
  const edge = landed
    ? "var(--color-step-done)"
    : moving ? "var(--color-brand)" : "var(--color-step-off)";

  const packed = packages.some((pack) => Boolean(pack.detail));
  const itemCount = new Set(
    packages.flatMap((pack) => pack.lines.map((line) => line.indent_item_id))).size;
  const weight = consignmentWeight(packages);
  const summary = [
    // The fallback "manifest" package is not a package: it is a delivery the
    // warehouse never packed, and calling it "1 package" sends somebody looking for
    // a carton with a number printed on it that was never printed.
    packed
      ? `${packages.length} package${packages.length === 1 ? "" : "s"}`
      : "Not packed into cartons",
    itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : "",
    weight,
  ].filter(Boolean).join(" · ");

  const handle = leg?.lr_no ?? leg?.docket_no ?? null;
  // How it travels in words, and who signed it out, exist only on the LIVE tracking
  // payload -- the copy carried on the acknowledgement row itself is the smaller
  // shape. Read through the narrowing so a leg served either way still draws.
  const rich = leg && isFullTracking(leg) ? leg : undefined;
  const dispatchNo = (rich?.gate_pass_no ?? "").trim();
  const carrier = (leg?.carrier_name ?? "").trim();
  const own = !carrier && Boolean(leg?.vehicle_number || leg?.driver_name);
  const due = dueNote(leg);
  const facts = [
    (carrier || own) && {
      key: "carrier",
      icon: carrier ? Building2 : Truck,
      label: carrier ? "Carrier" : "Brought by",
      value: carrier || "Company vehicle",
      note: [rich?.mode_label ?? leg?.mode, rich?.carriage_label]
        .filter(Boolean).join(" · "),
    },
    rich?.trip_no && {
      key: "trip", icon: MapPin, label: "Shared truck",
      value: tripStopLabel(rich),
      note: `${rich.trip_no} · ${tripProgressText(rich)}`,
    },
    leg?.vehicle_number && {
      key: "vehicle", icon: RectangleHorizontal, label: "Vehicle",
      value: leg.vehicle_number, mono: true,
    },
    leg?.driver_name && {
      key: "driver", icon: UserRound, label: "Driver", value: leg.driver_name,
      note: leg.driver_phone ?? undefined,
    },
    handle && {
      key: "docket", icon: FileText, label: "Tracking no.", value: handle, mono: true,
    },
    leg?.dispatched_at && {
      key: "sent", icon: CalendarClock, label: "Sent on",
      value: shortDate(leg.dispatched_at),
    },
    leg?.expected_delivery && {
      key: "due", icon: CalendarClock, label: "Expected on",
      value: shortDate(leg.expected_delivery),
      note: due?.text, noteTone: due?.tone,
    },
    rich?.handed_over_by_name && {
      key: "handover", icon: Signature, label: "Handed over by",
      value: rich.handed_over_by_name,
    },
  ].filter(Boolean) as SlipFactRow[];

  const phone = leg?.driver_phone?.replace(/\s+/g, "");
  const trackUrl = leg?.tracking_url;

  const footnote = loading
    ? "Loading the carrier details..."
    : failed
      ? "Carrier details could not be loaded. You can still count and acknowledge."
      : leg
        ? ""
        // No leg at all: the stop is named after the consignment the packing list
        // names, or after the INDENT when nothing was packed. Say there is no carrier.
        : "No carrier was booked for this delivery. You can still count and acknowledge.";

  return (
    <section
      aria-label={isConsignment ? `Consignment ${no}` : `Delivery for indent ${no}`}
      /* The consignment wears the brand crimson (its tile the brand sweep), the package
         the brand's warm orange: the two things being checked at this delivery each wear
         one, so a glance says which card is the load and which is the carton. No status
         pill — the left edge still carries the STATE. */
      className="overflow-hidden rounded-2xl border-2 border-l-4 border-brand/25 bg-brand/5 shadow-[0_10px_28px_-20px_var(--color-brand)]"
      style={{ borderLeftColor: edge }}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand text-white shadow-[0_8px_18px_-8px_var(--color-brand)]"
          >
            <Truck className="h-6 w-6" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand">
              {leg ? "Consignment note" : isConsignment ? "Consignment" : "Indent"}
            </div>
            <div className="mt-0.5 break-all font-mono text-lg font-bold leading-tight tracking-tight text-ink sm:text-xl">
              {no}
            </div>
            {summary && <div className="mt-1 text-xs text-muted">{summary}</div>}
            {/* The DISPATCH's own number (the gate pass, DSP), paired under the
                consignment's (CON): the consignment is what was packed, the dispatch is
                what sent it — and the paper in the driver's hand carries both. */}
            {dispatchNo && (
              <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dashed border-brand/35 bg-content1/80 py-1 pl-1.5 pr-2.5">
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand">
                  <Send className="h-3 w-3" aria-hidden />
                  Dispatch
                </span>
                <span title={dispatchNo} className="truncate font-mono text-xs font-semibold text-ink">
                  {dispatchNo}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-brand/15 bg-content1/70 px-4 py-3.5 sm:grid-cols-3">
          {facts.map(({ key, ...fact }) => <SlipFact key={key} {...fact} />)}
        </dl>
      )}

      {(phone || trackUrl) && (
        <div className="flex flex-wrap gap-2 border-t border-brand/15 bg-content1/70 px-4 py-3">
          {phone && (
            <a
              href={`tel:${phone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-content1 px-3.5 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
            >
              <Phone className="h-4 w-4" aria-hidden />
              Call the driver
            </a>
          )}
          {trackUrl && (
            <a
              href={trackUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-content1 px-3.5 text-xs font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Track the shipment
            </a>
          )}
        </div>
      )}

      {footnote && (
        <p className={`border-t border-brand/15 bg-content1/70 px-4 py-2.5 text-xs ${
          failed ? "text-warn" : "text-muted"
        }`}>
          {footnote}
        </p>
      )}
    </section>
  );
}

interface SlipFactRow {
  key: string;
  icon: typeof Truck;
  label: string;
  value: string;
  mono?: boolean;
  note?: string;
  noteTone?: string;
}

function SlipFact({ icon: Icon, label, value, mono, note, noteTone }: Omit<SlipFactRow, "key">) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        <Icon className="h-3 w-3 text-brand" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5">
        <span
          title={value}
          className={`block truncate text-sm font-semibold text-ink ${mono ? "font-mono text-[13px]" : ""}`}
        >
          {value}
        </span>
        {note && (
          <span className={`block truncate text-[11px] ${noteTone ?? "text-muted"}`}>
            {note}
          </span>
        )}
      </dd>
    </div>
  );
}

/** One thing that happened to the load on the way here. */
interface TrailMark {
  key: string;
  at: string;
  title: string;
  where?: string;
  detail?: string;
  bad?: boolean;
}

/**
 * How it got here, in order — folded to one line by default.
 *
 * The trail is the answer to "why is this late / short", which is a question most
 * deliveries never raise, so it no longer costs every delivery the tallest block on
 * the step. It opens ON ITS OWN when the road had an exception, because "held at
 * Hyderabad hub, seal replaced" is the line a claim is written from and must not be
 * behind a press. Nothing is composed here that the shipment does not carry.
 */
function ArrivalTrail({ leg, loading, failed }: {
  leg: ReceiptLeg;
  loading: boolean;
  failed: boolean;
}) {
  const marks: TrailMark[] = [];
  if (leg.dispatched_at) {
    marks.push({ key: "sent", at: leg.dispatched_at, title: "Left the warehouse" });
  }
  if (isFullTracking(leg)) {
    [...leg.events]
      .sort((left, right) => Date.parse(left.event_at) - Date.parse(right.event_at))
      .forEach((event, index) => marks.push({
        key: `event-${index}`,
        at: event.event_at,
        title: humanise(event.event_type),
        where: event.location_name ?? "",
        detail: event.description ?? "",
        bad: event.is_exception,
      }));
  }
  if (leg.delivered_at) {
    marks.push({ key: "delivered", at: leg.delivered_at, title: "Delivered" });
  }
  const trouble = marks.some((mark) => mark.bad);
  const [open, setOpen] = useState(trouble);
  if (marks.length === 0 || loading || failed) return null;
  const latest = marks[marks.length - 1];

  return (
    <section className="rounded-2xl border border-line">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
          trouble ? "bg-bad-bg text-bad" : "bg-content2 text-ink-500"
        }`}>
          {trouble ? <AlertTriangle className="h-4 w-4" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            How it got here
            <span className="ml-1.5 text-xs font-normal text-muted">
              {marks.length} update{marks.length === 1 ? "" : "s"}
            </span>
          </span>
          <span className={`block truncate text-[11px] ${trouble ? "text-bad" : "text-muted"}`}>
            {trouble ? "Something went wrong on the way. " : "Latest: "}
            {latest.title} · {stamp(latest.at)}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {open && (
        <ol className="border-t border-line px-4 py-3.5">
          {marks.map((mark, index) => {
            const last = index === marks.length - 1;
            return (
              <li key={mark.key} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && (
                  <span aria-hidden className="absolute bottom-0 left-[6px] top-4 w-px bg-line" />
                )}
                <span
                  aria-hidden
                  className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                    mark.bad
                      ? "border-bad bg-bad"
                      : last
                        ? "border-step-done bg-step-done"
                        : "border-step-done-rail bg-content1"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`text-sm font-semibold ${mark.bad ? "text-bad" : "text-ink"}`}>
                      {mark.title}
                    </span>
                    <span className="text-[11px] tabular-nums text-muted">{stamp(mark.at)}</span>
                  </div>
                  {(mark.where || mark.detail) && (
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                      {mark.where && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                          {mark.where}
                        </span>
                      )}
                      {mark.where && mark.detail && <span aria-hidden>&middot;</span>}
                      {mark.detail && <span>{mark.detail}</span>}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * The named shots the gate USED to ask for.
 *
 * The gate once drew four tiles -- the load, the seal, the plate, the damage -- and
 * each wrote its name into the photo's FILE NAME on the way up. The labels stay,
 * read-only, because photos already filed under them still carry the name, and the
 * gallery captions them by it. Do not reword one: that orphans the caption on every
 * photo already filed under the old words.
 * ------------------------------------------------------------------------ */

const GATE_SHOTS: { key: string; label: string; icon: typeof Camera }[] = [
  { key: "LOAD", label: "The load as it stands", icon: Boxes },
  { key: "SEAL", label: "The seal or lock", icon: Lock },
  { key: "PLATE", label: "The number plate", icon: RectangleHorizontal },
  { key: "DAMAGE", label: "Anything damaged", icon: AlertTriangle },
];

const SHOT_SEP = " - ";

/** Which named shot a filed photo was taken for, or nothing. */
function shotOf(fileName?: string | null) {
  const name = (fileName ?? "").toLowerCase();
  return GATE_SHOTS.find(
    (shot) => name.startsWith(`${shot.label.toLowerCase()}${SHOT_SEP}`));
}

/* ---------------------------------------------------------------------------
 * Reading the load, and the clock.
 * ------------------------------------------------------------------------ */

/** The load's weight, only when EVERY package in it was weighed: a sum over three of
 *  five packages is a number that looks like the whole load and is not. */
function consignmentWeight(packages: ReceiptPackage[]) {
  const weights = packages.map((pack) => Number(pack.detail?.weight_kg ?? 0));
  if (weights.length === 0 || weights.some((weight) => !(weight > 0))) return "";
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return `${Number(total.toFixed(2)).toLocaleString()} kg`;
}

/** `IN_TRANSIT` -> `In transit`. The status is PRINTED, never re-worded: a private map
 *  of logistics' statuses kept inside indents is a second vocabulary for the same
 *  rungs, and the two drift the first time logistics adds one. */
const humanise = (value: string) =>
  value.replace(/_/g, " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());

function stamp(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Early, late, or still to come — measured against the day the carrier marked it
 * delivered where there is one and against today where there is not, so a load still
 * on the road reads as overdue, and the same load once delivered reads as how late it
 * was.
 */
function dueNote(leg?: ReceiptLeg) {
  const due = dayStamp(leg?.expected_delivery);
  if (!Number.isFinite(due)) return null;
  const landed = dayStamp(leg?.delivered_at ?? leg?.acknowledged_at);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const arrived = Number.isFinite(landed);
  const days = Math.round(((arrived ? landed : today) - due) / 86_400_000);
  const plural = (count: number) => `${count} day${count === 1 ? "" : "s"}`;
  if (arrived) {
    if (days > 0) return { text: `${plural(days)} late`, tone: "text-warn" };
    if (days < 0) return { text: `${plural(-days)} early`, tone: "text-ok" };
    return { text: "On time", tone: "text-ok" };
  }
  if (days > 0) return { text: `${plural(days)} overdue`, tone: "text-bad" };
  if (days === 0) return { text: "Due today", tone: "text-warn" };
  return { text: `In ${plural(-days)}`, tone: "text-muted" };
}

/** How far one package has got, read off the same rules its own stop is judged by:
 *  never a second copy of them. */
interface PackageProgress {
  done: boolean;
  countedDone: number;
  countedTotal: number;
  /** How many ITEMS in this carton have a picture of themselves — not how many
   *  photos are filed. */
  photographed: number;
  /** How many need one: the items counted above zero. */
  toPhotograph: number;
}

/**
 * One package in the consignment, as one row you press to open it.
 *
 * Name, the number printed on the carton, what kind of container it is — the three
 * things that tell two cartons apart on the floor — then the work left on it as two
 * fractions (counted, photographed), the same two the package's own step asks for.
 */
function PackageRow({ pack, label, progress, onOpen }: {
  pack: ReceiptPackage;
  label: string;
  progress: PackageProgress;
  onOpen: () => void;
}) {
  const { done, countedDone, countedTotal, photographed, toPhotograph } = progress;
  const nothing = countedTotal === 0;
  const weight = packageWeight(pack);
  const size = packageSize(pack);
  const facts = [
    packageKindLabel(pack),
    weight,
    size,
    `${pack.lines.length} item${pack.lines.length === 1 ? "" : "s"}, ${qty(pack.quantity)}`,
  ].filter(Boolean).join(" · ");

  return (
    <li>
      {/* Drawn as the carton's own TAG (2026-09-26): an orange label stub carrying the
          number printed on the box, torn off along a perforation from the work left
          on it. The brand's warm orange is the package's colour everywhere on this
          screen, as crimson is the consignment's, so the row reads as "a carton" before a word of it is read. */}
      <button
        type="button"
        onClick={onOpen}
        className={`group relative flex min-h-[4.75rem] w-full overflow-hidden rounded-2xl border-2 text-left transition hover:-translate-y-0.5 hover:shadow-[0_12px_26px_-18px_var(--color-signal)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
          done ? "border-ok/40 bg-ok-bg/20" : "border-signal/25 bg-content1 hover:border-signal/60"
        }`}
      >
        <span className={`flex w-[5.5rem] shrink-0 flex-col items-center justify-center gap-1.5 border-r-2 border-dashed px-2 py-3 sm:w-24 ${
          done ? "border-ok/30 bg-ok-bg/40" : "border-signal/30 bg-signal/8"
        }`}>
          <span className={`grid h-9 w-9 place-items-center rounded-xl text-white shadow-[0_6px_14px_-8px_var(--color-signal)] ${
            done ? "bg-ok" : "bg-signal"
          }`}>
            {done
              ? <Check className="h-5 w-5" strokeWidth={3} aria-hidden />
              : <Package className="h-5 w-5" strokeWidth={1.8} aria-hidden />}
          </span>
          <span
            title={pack.no}
            className={`max-w-full truncate font-mono text-[11px] font-bold tracking-tight ${done ? "text-ok" : "text-brand"}`}
          >
            {pack.no}
          </span>
        </span>

        <span className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-3.5 py-3 sm:px-4">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-ink group-hover:text-brand">{label}</span>
            {pack.detail?.is_fragile && (
              <Handling icon={AlertTriangle} tone="bg-warn-bg text-warn" label="Fragile" />
            )}
            {pack.detail?.is_temp_controlled && (
              <Handling icon={Snowflake} tone="bg-info-bg text-info" label="Keep cold" />
            )}
          </span>
          <span className="truncate text-[11px] text-muted" title={facts}>{facts}</span>
          {!nothing && (
            <span className="flex flex-wrap gap-x-5 gap-y-2">
              <PackageMeter icon={Hash} label="Counted" done={countedDone} of={countedTotal} />
              {toPhotograph > 0 && (
                <PackageMeter icon={Camera} label="Photographed" done={photographed} of={toPhotograph} />
              )}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center pr-3 sm:pr-4">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-content2 text-muted transition group-hover:bg-signal group-hover:text-white">
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
          </span>
        </span>
      </button>
    </li>
  );
}

/** One of the two things a carton owes, as a fraction over a thin bar. */
function PackageMeter({ icon: Icon, label, done, of }: {
  icon: typeof Hash;
  label: string;
  done: number;
  of: number;
}) {
  const complete = of > 0 && done >= of;
  const pct = of > 0 ? Math.min(100, Math.round((done / of) * 100)) : 0;
  const text = complete ? "text-ok" : done > 0 ? "text-warn" : "text-muted";
  return (
    <span className="flex min-w-[7.5rem] flex-1 basis-28 flex-col gap-1 sm:max-w-[11rem]">
      <span className="flex items-center justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-muted">
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </span>
        <span className={`font-semibold tabular-nums ${text}`}>{done}/{of}</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-content2" aria-hidden>
        <span
          className={`block h-full rounded-full transition-[width] ${complete ? "bg-ok" : "bg-warn"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

function Handling({ icon: Icon, tone, label }: {
  icon: typeof AlertTriangle;
  tone: string;
  label: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Stops 2..n-1: one package at a time.
 * ------------------------------------------------------------------------ */

function PackageStop({
  pack, tasks, position, total, photos, received, pickedSerials, packChecks, onPackCheck,
  photosOf, onUpload, onUploadItem, onChange, onPickSerials, ...photoProps
}: {
  pack: ReceiptPackage;
  tasks: StepTask[];
  position: number;
  total: number;
  photos: ReceiptAttachment[];
  received: Record<string, string>;
  pickedSerials: Record<string, string[]>;
  packChecks: Record<string, PackageCheck>;
  onPackCheck: (receiptKey: string, check: PackageCheck) => void;
  /** This item's own photos, taken while THIS package was open. */
  photosOf: (line: ReceiptPackageLine) => ReceiptAttachment[];
  onUpload: (file: File, base: string) => void;
  onUploadItem: (line: ReceiptPackageLine, file: File) => void;
  onChange: (receiptKey: string, value: string) => void;
  onPickSerials: (line: ReceiptPackageLine) => void;
} & PhotoProps) {
  return (
    <StepSheet
      kicker={total > 1 ? `Package ${position} of ${total}` : "The package"}
      headline="Open it, count, and photograph each item"
      note="Enter what you really find, even if it is less than the paper says. One photo per item is enough."
      tasks={tasks}
    >
      <PackageIdentityCard pack={pack} />

      <section>
        <SectionLabel>
          {pack.lines.length === 1 ? "Item inside" : `Items inside (${pack.lines.length})`}
        </SectionLabel>
        <ul className="mt-2.5 space-y-3">
          {pack.lines.map((line) => (
            <PackageLineRow
              key={line.receipt_key}
              line={line}
              value={received[line.receipt_key] ?? ""}
              onChange={(value) => onChange(line.receipt_key, value)}
              selectedSerials={pickedSerials[line.receipt_key] ?? []}
              onPickSerials={() => onPickSerials(line)}
              packCheck={packChecks[line.receipt_key]}
              onPackCheck={(check) => onPackCheck(line.receipt_key, check)}
              photos={photosOf(line)}
              onUploadPhoto={(file) => onUploadItem(line, file)}
              {...photoProps}
            />
          ))}
        </ul>
      </section>

      <PhotoStrip
        title="Photos of the box"
        note="The outside, the seal or the label. Useful if the box arrived damaged."
        optional
        buttonLabel="Add photos"
        files={photos}
        onUpload={(file) => onUpload(file, PHOTO)}
        {...photoProps}
      />
    </StepSheet>
  );
}

/**
 * The carton, described so it can be checked against the thing standing in front of
 * you: the number printed on its label at the size it is printed, the container type,
 * the measurements the warehouse took, who sealed it — and, set apart on the right,
 * the one number the rest of the step counts up to: what should be inside. A fact
 * with nothing behind it is NOT drawn; the barcode is printed as its text, because a
 * drawing of bars is a scannable-looking thing that does not scan.
 */
function PackageIdentityCard({ pack }: { pack: ReceiptPackage }) {
  const weight = packageWeight(pack);
  const size = packageSize(pack);
  const sealed = packedBy(pack);
  const barcode = (pack.detail?.barcode ?? "").trim();
  const itemCount = pack.lines.length;
  const facts = [
    weight && { key: "weight", icon: Weight, value: weight },
    size && { key: "size", icon: Ruler, value: size },
    barcode && { key: "barcode", icon: Barcode, value: barcode, mono: true },
    sealed && { key: "sealed", icon: UserRound, value: `Packed by ${sealed}` },
    pack.detail?.dispatch_no && {
      key: "dispatch", icon: Truck, value: pack.detail.dispatch_no, mono: true,
    },
  ].filter(Boolean) as { key: string; icon: typeof Package; value: string; mono?: boolean }[];

  return (
    <section
      aria-label={`Package ${pack.no}`}
      /* The package's own colour (brand orange) beside the consignment's crimson — see
         ConsignmentSlip — so the load and the carton are never mistaken for each
         other at a glance. */
      className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-signal/30 bg-signal/5 p-4 shadow-[0_10px_28px_-20px_var(--color-signal)]"
    >
      <span
        aria-hidden
        className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-signal text-white shadow-[0_8px_18px_-8px_var(--color-signal)]"
      >
        <Package className="h-6 w-6" strokeWidth={1.8} />
      </span>

      <div className="min-w-0 flex-1 basis-56">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand">
          Package label
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="break-all font-mono text-xl font-bold leading-tight tracking-tight text-ink">
            {pack.no}
          </span>
          <span className="rounded-full bg-signal/12 px-2.5 py-0.5 text-[11px] font-bold text-brand">
            {packageKindLabel(pack)}
          </span>
        </div>
        {facts.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {facts.map((fact) => (
              <li key={fact.key} className="inline-flex min-w-0 items-center gap-1.5">
                <fact.icon className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                <span className={`truncate ${fact.mono ? "font-mono text-body" : ""}`} title={fact.value}>
                  {fact.value}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* Handling only when it applies: a chip on every package teaches the eye to
            skip the one that matters. */}
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

      <div className="shrink-0 rounded-2xl border-2 border-dashed border-signal/35 bg-content1 px-4 py-2.5 text-center">
        <div className="font-display text-3xl font-bold leading-none tabular-nums text-brand">
          {qty(pack.quantity)}
        </div>
        <div className="mt-1 text-[11px] font-medium text-muted">
          should be inside
          <span className="block text-[10px]">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * One item in one package, as one card: what it is and what was sent on the left, the
 * count on the right, the verdict on the count under both — then its proof as a quiet
 * footer: the photo it needs, and (for coded goods) the codes to check.
 *
 * The card goes green when the item has been counted, photographed and (for coded
 * goods) matched in THIS package — what Acknowledge waits for — so a carton of
 * eleven can be scanned for the one that is not.
 */
function PackageLineRow({
  line, value, onChange, selectedSerials, onPickSerials, packCheck, onPackCheck, photos,
  onUploadPhoto, ...photoProps
}: {
  line: ReceiptPackageLine;
  value: string;
  onChange: (value: string) => void;
  selectedSerials: string[];
  onPickSerials: () => void;
  packCheck?: PackageCheck;
  onPackCheck: (check: PackageCheck) => void;
  /** This line's own pictures, taken in this package. */
  photos: ReceiptAttachment[];
  onUploadPhoto: (file: File) => void;
} & PhotoProps) {
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
  const finished = max > 0 && current > 0 && photos.length > 0
    && (serials.length === 0 || serialComplete);
  // A line issued in PACKAGES (2026-10-26): counted package by package.
  const packs = line.package_box_codes ?? [];
  const [checking, setChecking] = useState(false);
  // Signed for already: each package says what arrived in it (2026-10-26).
  const signedOff = packs.length > 0 && packs.every((p) => p.received != null);
  const check: PackageCheck = packCheck ?? (signedOff
    ? { kept: packs.filter((p) => Number(p.received) > 0).map((p) => p.code),
        partial: Object.fromEntries(packs
          .filter((p) => Number(p.received) > 0 && Number(p.received) < Number(p.quantity))
          .map((p) => [p.code, Number(p.quantity) - Number(p.received)])) }
    : { kept: packs.map((p) => p.code), partial: {} });
  const arrivedQty = packs.reduce((sum, p) => sum + Number(p.received ?? 0), 0);
  const packName = (line.package_pack_breakdown ?? line.pack_breakdown)
    ?.find((e) => Number(e.level) > 0)?.name ?? "package";
  const packWord = (n: number) => {
    const name = packName.toLowerCase();
    return `${n} ${n === 1 ? name : /(x|s|ch|sh)$/.test(name) ? `${name}es` : `${name}s`}`;
  };

  return (
    <li className={`rounded-2xl border bg-content1 p-4 transition-colors ${
      finished ? "border-ok/45" : "border-line"
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex items-start gap-2">
            {finished && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />}
            <div className="min-w-0">
              <div className="text-[15px] font-semibold leading-snug text-ink">
                {line.item_name ?? line.item_code}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted">{line.item_code}</div>
              <ReceivedCombination line={line} />
              {/* The packs this package holds of it, as the packer left them — codes
                  stay per unit (2026-10-22). Older consignments fall back to the
                  line's packs cut to this package's quantity. */}
              {packsFor(line.package_pack_breakdown ?? line.pack_breakdown, max) && (
                <PackQty entries={packsFor(line.package_pack_breakdown ?? line.pack_breakdown, max)}
                         qty={max} uom={line.uom_code} className="mt-1.5" />
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span>Sent <b className="font-semibold tabular-nums text-body">{qty(max)}</b></span>
            <ConsumptionPacks line={line} quantity={max} />
            <span>Approved <b className="font-semibold tabular-nums text-body">{qty(line.approved_quantity)}</b></span>
            {Number(line.received_quantity ?? 0) > 0 && (
              <span>Received before <b className="font-semibold tabular-nums text-body">{qty(line.received_quantity)}</b></span>
            )}
          </div>
        </div>
        {signedOff ? (
          // Signed for: what arrived, package by package (2026-10-26).
          <div className="flex flex-col items-end gap-0.5 text-right">
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${
              arrivedQty < max ? "bg-warn/10 text-warn" : "bg-ok/10 text-ok"}`}>
              <PackageCheckIcon className="h-4 w-4" />
              {qty(arrivedQty)} of {qty(max)} {line.uom_code ?? ""} received
            </span>
            <span className="text-[11px] text-muted">
              {check.kept.length}/{packWord(packs.length)} arrived
              {packs.length - check.kept.length > 0 && ` · ${packs.length - check.kept.length} missing`}
            </span>
          </div>
        ) : max > 0 && packs.length > 0 ? (
          // Counted by the PACKAGE: the base quantity follows from what is checked.
          <div className="flex flex-col items-end gap-1">
            <Button variant={check.kept.length === packs.length && !Object.keys(check.partial).length
                      ? "soft" : "subtle"}
                    onClick={() => setChecking(true)}>
              <PackageCheckIcon className="h-4 w-4" />
              {check.kept.length}/{packWord(packs.length)} arrived
            </Button>
            <span className="text-[11px] text-muted">{qty(current)} of {qty(max)} {line.uom_code ?? ""} received</span>
          </div>
        ) : max > 0 ? (
          <QuantityStepper value={value} max={max} onChange={onChange} label={label} uom={line.uom_code} />
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
              ? "Not counted yet"
              : short
                ? `${qty(max - current)} missing. They can still come later.`
                : `All ${qty(max)} here`}
          </span>
        </p>
      )}

      {(max > 0 || serials.length > 0 || packs.length > 0) && (
        <div className="mt-3.5 space-y-2.5 border-t border-line pt-3.5">
          {max > 0 && (
            <ItemProofStrip
              label={label}
              photos={photos}
              onUpload={onUploadPhoto}
              {...photoProps}
            />
          )}
          {packs.length > 0 && (
            // This carton's packages, each as it arrived (2026-10-26).
            <div className="rounded-xl border border-line bg-content2/50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-ink">
                  Packages in this carton
                  <span className="ml-2 text-xs font-normal text-muted">{packWord(packs.length)}</span>
                </span>
                {!signedOff && (
                  <button type="button" onClick={() => setChecking(true)}
                          className="text-xs font-semibold text-brand hover:underline">
                    Check packages
                  </button>
                )}
              </div>
              {/* Grouped by the carton (and opened box) each package came out of
                  (2026-10-28): "4 boxes + 5 strips" reads as one carton. */}
              <div className="mt-2 space-y-1.5">
                {packGroups(packs).map(([label, list]) => (
                  <div key={label || "-"} className="flex flex-wrap items-center gap-1.5">
                    {label && (
                      <span className="mr-1 text-[11px] font-semibold capitalize text-muted">{label}</span>
                    )}
                    {list.map((pkg) => {
                      const kept = check.kept.includes(pkg.code);
                      const shortIn = check.partial[pkg.code] ?? 0;
                      return (
                        <span key={pkg.code} title={pkg.code}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${
                                !kept ? "border-bad/30 bg-bad/5" : shortIn ? "border-warn/40 bg-warn/5"
                                  : "border-line bg-content1"}`}>
                          <span className="font-semibold text-ink">
                            {pkg.name && <span className="capitalize">{pkg.name.toLowerCase()} </span>}
                            <span className="mono">{pkg.name ? shortPackCode(pkg.code) : pkg.code}</span>
                          </span>
                          <span className={!kept ? "font-semibold text-bad" : shortIn ? "font-semibold text-warn" : "text-muted"}>
                            {!kept ? "missing" : shortIn
                              ? `${qty(Number(pkg.quantity) - shortIn)} of ${qty(pkg.quantity)}`
                              : `${qty(pkg.quantity)} ${line.uom_code ?? ""}`}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
          <PackageCheckModal
            open={checking}
            onClose={() => setChecking(false)}
            mode="receipt"
            // Drawn as carton › box › strip; a kept box can be checked strip by strip
            // (2026-10-28) — only the box's own figure is sent on.
            packages={packs.map((p) => ({ code: p.code, carries: Number(p.quantity),
                                          name: p.name, path: p.path, inner: p.inner }))}
            value={check}
            packName={packName}
            uom={line.uom_code}
            itemLabel={`${line.item_code ?? ""} — ${line.item_name ?? ""}`}
            onSave={(next) => {
              onPackCheck(next);
              const lost = packs.reduce((sum, p) => sum + (next.kept.includes(p.code)
                ? Math.min(next.partial[p.code] ?? 0, Number(p.quantity)) : Number(p.quantity)), 0);
              onChange(String(Math.max(0, max - lost)));
            }}
          />
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
        </div>
      )}
    </li>
  );
}

/**
 * The picture of THIS item, as it came out of the carton — the one thing on the row
 * that is required rather than merely useful, because every dispute is about whether
 * the thing inside was the right thing and what state it was in.
 *
 * **One photo is enough, and the quantity is irrelevant to that.** Sixty cables are
 * photographed once. More than one is allowed and never asked for: the second shot is
 * the damaged corner.
 *
 * A strip, not a panel: a line of state, one press, and the shots at thumbnail size.
 * Amber until it has a picture and green once it does — the same two colours the
 * count above it uses, for the same reason. The press carries `capture`, which opens
 * the rear camera on a phone; a laptop ignores it and opens the file picker.
 */
function ItemProofStrip({ label, photos, onUpload, ...photoProps }: {
  label: string;
  photos: ReceiptAttachment[];
  onUpload: (file: File) => void;
} & PhotoProps) {
  const has = photos.length > 0;
  return (
    <div>
      <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl px-3 py-2 ${
        has ? "bg-ok-bg/50" : "bg-warn-bg/60"
      }`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            has ? "bg-ok text-white" : "bg-content1 text-warn"
          }`}>
            {has
              ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
              : <Camera className="h-4 w-4" aria-hidden />}
          </span>
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${has ? "text-ok" : "text-warn"}`}>
              {has
                ? `Photo added${photos.length > 1 ? ` (${photos.length})` : ""}`
                : "Photo needed"}
              <span className="sr-only"> (required)</span>
            </div>
            <p className="text-[11px] leading-snug text-muted">
              {has
                ? "Add more if something is damaged."
                : "One photo is enough, however many there are."}
            </p>
          </div>
        </div>
        <UploadButton
          label={has ? "Add another" : "Take a photo"}
          ariaLabel={`Photograph ${label}`}
          strong={!has}
          accept="image/*"
          capture
          pending={photoProps.uploadPending}
          onFiles={(files) => files[0] && onUpload(files[0])}
        />
      </div>

      {has && (
        <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {photos.map((file) => (
            <PhotoThumb
              key={file.id}
              indentId={photoProps.indentId}
              file={file}
              compact
              busy={photoProps.removePending}
              onView={() => photoProps.onView(photos, photos.indexOf(file))}
              onDelete={() => photoProps.onDelete(file.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which physical units this line is being confirmed against.
 *
 * A serial confirmed against the wrong handset is not a quantity that can be corrected
 * later, so the panel says WHICH kind of identifier is being asked for (the served
 * `TrackingBadge` — a serial, an IMEI, an asset tag and a lot code are fifteen
 * characters of upper case apiece), how far through the match is, and which codes have
 * been ticked, on screen rather than behind the modal: the check somebody actually
 * performs is reading a number off a box and finding it in a list.
 *
 * Nothing counted yet is neutral, part-matched is amber, matched is green.
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
  const tone = complete ? "bg-ok-bg/50" : counted ? "bg-warn-bg/50" : "bg-content2/60";
  return (
    <div className={`rounded-xl px-3 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
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
              <span className={`text-xs font-bold tabular-nums ${
                complete ? "text-ok" : counted ? "text-warn" : "text-muted"
              }`}>
                {picked.length}/{required} matched
              </span>
            </div>
            <p className="text-[11px] leading-snug text-muted">
              {required > 0
                ? `Auto-selected for the ${required} counted (${sent} sent). Change any ${unit} that is not in the box.`
                : `Count first — the ${unit}s are then selected for you.`}
            </p>
          </div>
        </div>
        <Button variant={complete ? "subtle" : "soft"} onClick={onPick} disabled={required <= 0}>
          <ScanBarcode className="h-4 w-4" />
          {picked.length > 0 ? "Change" : `Check ${unit}s`}
        </Button>
      </div>

      {picked.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {picked.map((code) => (
            <li
              key={code}
              title={code}
              className="rounded-md border border-line bg-content1 px-2 py-0.5 font-mono text-[12px] font-semibold tracking-tight text-ink"
            >
              {shortCode(code)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Often a phone, often one hand: 44px of button beats a keyboard at a pallet, and
 *  the box is still there for 37 of something. */
function QuantityStepper({ value, max, onChange, label, uom }: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  label: string;
  /** The line's unit: a whole unit refuses the "." as it is typed (2026-11-03). */
  uom?: string | null;
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
            data-uom={uom ?? ""}
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
        disabled={current === max}
        className="mt-1 block min-h-8 w-full text-center text-[11px] font-semibold text-brand hover:underline disabled:text-muted disabled:no-underline"
      >
        All {qty(max)} arrived
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Proof, and the small parts.
 * ------------------------------------------------------------------------ */

/**
 * The press that adds a file: a `<label>` around a hidden input, so a thumb anywhere
 * on it opens the camera or the picker. `strong` is the one that is owed (amber, the
 * colour of "you must"); the rest are quiet, because an optional photo shouting for
 * attention is how the required one gets missed.
 */
function UploadButton({
  label, ariaLabel, strong = false, accept, multiple = false, capture = false,
  pending, icon: Icon = Camera, onFiles,
}: {
  label: string;
  ariaLabel?: string;
  strong?: boolean;
  accept: string;
  multiple?: boolean;
  /** Open the rear camera on a phone. */
  capture?: boolean;
  pending: boolean;
  icon?: typeof Camera;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label className={`inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-xs font-semibold transition focus-within:ring-2 focus-within:ring-brand/40 ${
      strong
        ? "bg-warn text-white hover:brightness-95"
        : "border border-line bg-content1 text-body hover:border-brand hover:text-brand"
    } ${pending ? "pointer-events-none opacity-60" : ""}`}>
      {pending ? <Circle className="h-4 w-4 animate-pulse" aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
      {pending ? "Uploading…" : label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        {...(capture ? { capture: "environment" as const } : {})}
        className="sr-only"
        aria-label={ariaLabel ?? label}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

/**
 * One pile of proof — a stop's photos, or the delivery's bills — as a heading, one
 * press, and what has been filed. The same component everywhere a file is added other
 * than an item's own shot, so the consignment, the box and the bill cannot drift on
 * how a filed file is drawn or taken back. Images are drawn as the pictures (a
 * filename makes the person open each one to see whether the damaged corner was
 * caught); anything else keeps a file row.
 */
function PhotoStrip({
  title, note, optional = false, required = false, buttonLabel, buttonIcon,
  accept = "image/*", files, onUpload, ...photoProps
}: {
  title: string;
  note: string;
  optional?: boolean;
  /** Owed before Acknowledge unlocks: a red star by the title, an amber button until
   *  something is filed. */
  required?: boolean;
  buttonLabel: string;
  buttonIcon?: typeof Camera;
  accept?: string;
  files: ReceiptAttachment[];
  onUpload: (file: File) => void;
} & PhotoProps) {
  const images = files.filter(isImage);
  const documents = files.filter((file) => !isImage(file));
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <SectionLabel>
              {title}
              {required && (
                <>
                  <span className="ml-0.5 text-sm leading-none text-danger" aria-hidden>*</span>
                  <span className="sr-only"> (required)</span>
                </>
              )}
            </SectionLabel>
            {optional && <span className="text-[11px] text-muted">Optional</span>}
            {files.length > 0 && (
              <span className="text-[11px] font-semibold text-ok">{files.length} added</span>
            )}
          </div>
          <p className="mt-0.5 max-w-prose text-xs text-muted">{note}</p>
        </div>
        <UploadButton
          label={files.length > 0 ? "Add more" : buttonLabel}
          strong={required && files.length === 0}
          icon={files.length > 0 ? Plus : buttonIcon}
          accept={accept}
          multiple
          pending={photoProps.uploadPending}
          onFiles={(picked) => picked.forEach(onUpload)}
        />
      </div>

      {images.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {images.map((file) => (
            <PhotoThumb
              key={file.id}
              indentId={photoProps.indentId}
              file={file}
              busy={photoProps.removePending}
              onView={() => photoProps.onView(files, files.indexOf(file))}
              onDelete={() => photoProps.onDelete(file.id)}
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
              busy={photoProps.removePending}
              onView={() => photoProps.onView(files, files.indexOf(file))}
              onDelete={() => photoProps.onDelete(file.id)}
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

/** One filed attachment's bytes as an object URL, fetched down the indent's own
 *  gated route — the files are not public URLs and there is no thumbnail service.
 *  Shared by the tile and by the slip thumbnail, so there is one place that knows. */
function useReceiptImage(indentId: number, fileId: number) {
  const kind = useContext(ReceiptKindContext);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dropped = false;
    let made = "";
    receiptApi(kind).download(indentId, fileId)
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
  }, [kind, indentId, fileId]);

  return { url, failed };
}

/**
 * One filed photo, as the photo. `compact` drops the caption — on an item's own
 * strip every shot is of that item, and a caption on a 64px tile covers the picture.
 * The delete press is always visible on a phone: it only appeared on hover, and a
 * phone has no hover, so a wrong shot could not be taken back where it was taken.
 */
function PhotoThumb({ indentId, file, onView, onDelete, busy, compact = false }: {
  indentId: number;
  file: ReceiptAttachment;
  onView: () => void;
  onDelete: () => void;
  busy: boolean;
  compact?: boolean;
}) {
  const { url, failed } = useReceiptImage(indentId, file.id);
  const isBill = attachmentBase(file.doc_category) === BILL;
  // What it is a picture OF, where the shot was named on the way up. A file name is
  // what the phone called it, which is the one thing nobody needs to read back.
  const shot = shotOf(file.file_name);
  return (
    <li className="group relative overflow-hidden rounded-xl border border-line bg-content2">
      <button
        type="button"
        onClick={onView}
        className={`block w-full ${compact ? "aspect-square" : "aspect-[4/3]"}`}
        title={file.file_name}
      >
        {url ? (
          <img src={url} alt={file.file_name} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center text-[10px] text-muted">
            {failed ? "No preview" : <span className="h-full w-full animate-pulse bg-content3" />}
          </span>
        )}
      </button>
      {!compact && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5 text-[10px] font-medium text-white">
          {isBill
            ? <FileText className="h-3 w-3 shrink-0" aria-hidden />
            : shot
              ? <shot.icon className="h-3 w-3 shrink-0" aria-hidden />
              : <Camera className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{shot?.label ?? file.file_name}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Remove ${file.file_name}`}
        className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-content1/90 text-muted shadow-sm transition hover:text-bad focus:opacity-100 disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

/** A filed file that is not a picture — a PDF bill, most often: open it, or take it
 *  back off the receipt. */
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

/**
 * The approved items that are not in this delivery, folded to one line: there is
 * nothing to do about them here, and on the handover they are context, not work. Open,
 * each reads the way it does on the list screen — the stage it has got to and the
 * quantity that proves it (`lineStage` / `STAGE` / `STAGE_HINT`), so the two screens
 * cannot word or colour the same state differently.
 */
function InProcessPanel({ lines }: { lines: AcknowledgementLine[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-2xl border border-line">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-content2 text-ink-500">
          <Truck className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            Coming later
            <span className="ml-1.5 text-xs font-normal text-muted">
              {lines.length} item{lines.length === 1 ? "" : "s"}
            </span>
          </span>
          <span className="block truncate text-[11px] text-muted">
            Not in this delivery. Nothing to do for {lines.length === 1 ? "it" : "them"} now.
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line px-4">
          {lines.map((line) => (
            <InProcessLine key={line.indent_item_id} line={line} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A line's packs cut to the quantity being shown — the line was sent as one set of
 *  packs and may arrive split over several cartons (2026-10-22). */
/**
 * The brand that ARRIVED, not the one the indent asked for (2026-10-26). The desk may
 * give another brand, or stock with no brand recorded; the issue lines say which, and
 * the indent's own brand is shown underneath as "Asked for" whenever they differ.
 */
function ReceivedCombination({ line }: { line: AcknowledgementLine }) {
  const issued = line.issued_combinations ?? [];
  const differs = issued.length > 0 && (line.combination_any
    || issued.some((c) => combinationKey(c) !== combinationKey(line)));
  if (!differs) return <CombinationTag value={line} className="mt-1" />;
  const asked = line.combination_any ? "Any brand" : combinationLabel(line) || "no brand";
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {issued.map((c) => (
          <span key={combinationKey(c)} className="inline-flex items-center gap-1">
            <CombinationTag value={c} />
            {issued.length > 1 && (
              <span className="text-[11px] text-muted">× {c.quantity}</span>
            )}
          </span>
        ))}
      </div>
      {!line.combination_any && (
        <div className="text-[11px] font-medium text-warn">Asked for {asked}</div>
      )}
    </div>
  );
}

function packsFor(packs: PackEntry[] | null | undefined, qty: number): PackEntry[] | null {
  if (!packs?.length || qty <= 0) return null;
  return Math.abs(baseOf(packs) - qty) < 1e-6 ? packs : shrinkWithin(packs, qty);
}

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
        <ReceivedCombination line={line} />
        {packsFor(line.pack_breakdown, Number(line.dispatched_quantity ?? 0)) && (
          <PackQty entries={packsFor(line.pack_breakdown, Number(line.dispatched_quantity ?? 0))}
                   qty={line.dispatched_quantity} uom={line.uom_code} className="mt-1.5" />
        )}
        <div className="mt-1.5 text-xs text-muted">
          {qty(line.approved_quantity)} approved
          {/* Only where there is one: a zero on every other row is noise, and on the
              row that has it this is the whole answer. */}
          {ordered > 0 && (
            <> &middot; <b className="font-semibold tabular-nums text-warn">{qty(ordered)}</b> on order</>
          )}
          {" "}&middot; {qty(line.dispatched_quantity)} sent &middot; {qty(line.received_quantity)} received
        </div>
        <div className="mt-1 text-xs">
          <ConsumptionPacks line={line} quantity={Number(line.received_quantity ?? 0)} />
        </div>
      </div>
      <div className="min-w-0 shrink-0 sm:max-w-[240px] sm:text-right">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ${tone}`}>
          <StageIcon className="h-3.5 w-3.5" aria-hidden />
          {stage === "on_order" && ordered > 0 ? `${label} ${qty(ordered)}` : label}
        </span>
        {/* ONE sentence under the pill: the server's where it has one, the list
            screen's hint where it does not. */}
        <div className="mt-1 text-xs text-muted">
          {line.pending_with || STAGE_HINT[stage] || caption}
        </div>
      </div>
    </li>
  );
}


/** What a quantity comes to in the item's CONSUMPTION containers (2026-10-23) —
 *  "Use in 15 Strip". Nothing when the item has none mapped. */
function ConsumptionPacks({ line, quantity }: { line: AcknowledgementLine; quantity: number }) {
  const options = usePackOptions(line.item_id ? [line.item_id] : []);
  const packs = packsIn(options.data?.[line.item_id ?? 0], quantity, "CONSUMPTION", line.brand_id);
  if (!packs) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      Use in <PackChips entries={packs} uom={line.uom_code} showHierarchy={false} showTotal={false} />
    </span>
  );
}
