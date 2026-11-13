import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, CheckCheck, CheckCircle2, Info, Plus, ScanLine, Trash2 } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  approveOutboundInspection, rejectOutboundInspection,
  completeOutboundInspection, createOutboundInspection, getOutboundInspection,
  getIssue, inspectableIssueOptions,
  updateOutboundInspection, warehouseOptions,
} from "../api";
import { fmtQty, num, today } from "../format";
import { PackageCheckModal } from "@/shared/components";
import type { InnerCheck } from "@/shared/components/PackageCheckModal";
import { PackQty, baseOf, shrinkWithin } from "@/shared/packing";
import { resolveAcceptedUnits, unitsForAccepted, unitsStillToReject } from "../qcUnits";
import { alerts } from "@/modules/alerts";
import type {
  OutboundInspection as Inspection, OutboundInspectionItemWrite as InspectionItemWrite, InspectionParameter, OutboundInspectionWrite as InspectionWrite, Issue as Receipt,
  IssueBox,
} from "../types";
import { usePointLabel } from "../usePointLabel";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";
import { CombinationTag } from "@/shared/combination";
import { useAuth } from "@/shared/auth/AuthContext";
import { applyQcEdit, passIfUntouched, qcLineResult, qcRate } from "../qcSummary";
import { QcResultBadge } from "../components/QcVerdict";

/**
 * Inspect a receipt line by line.
 *
 * Picking the Material Issue pulls its lines in with their issued quantities — an inspection
 * typed from scratch is how quantities came to disagree with the receipt they were
 * supposedly inspecting.
 *
 * `result` is derived from the split, not chosen: all accepted is a pass, all
 * rejected is a fail, anything between is partial. A per-line parameter table
 * (`parameters` JSON) records what was actually measured, because "failed" without a
 * reading is not something a vendor can be held to.
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

/** `basePath` re-homes the form — Inventory > Stock Transfer mounts it at
 *  `/inventory/transfers/qc` for the QC of a transfer's material issue. */
export default function OutboundQualityInspectionForm({
  type = "OUTGOING",
  basePath,
}: {
  type?: "INCOMING" | "OUTGOING";
  basePath?: string;
}) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const { me } = useAuth();
  /* Absolute: this screen is mounted at two depths, so `".."` resolved against the
   * matched route and Back landed somewhere different depending on the entry URL. */
  const listPath = basePath ?? "/warehouse/qc-outward";
  const [searchParams] = window.location.search ? [new URLSearchParams(window.location.search)] : [new URLSearchParams()];
  const initialIssueId = searchParams.get("issue_id");

  const [form, setForm] = useState<InspectionWrite>({
    inspection_date: today(),
    issue_id: initialIssueId ? Number(initialIssueId) : 0 as any,
    warehouse_id: null,
    inspector_id: null,
    remarks: "",
    items: [],
  });
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pulled, setPulled] = useState<Receipt | null>(null);
  const [paramsFor, setParamsFor] = useState<number | null>(null);
  const [serialsFor, setSerialsFor] = useState<number | null>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-inspection", id],
    queryFn: () => getOutboundInspection(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      inspection_date: doc.inspection_date,
      issue_id: doc.issue_id ?? null,
      warehouse_id: doc.warehouse_id ?? null,
      inspector_id: doc.inspector_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        issue_item_id: l.issue_item_id,
        item_id: l.item_id,
        batch_no: l.batch_no,
        inspected_qty: num(l.inspected_qty),
        accepted_qty: num(l.accepted_qty),
        rejected_qty: num(l.rejected_qty),
        parameters: l.parameters ?? [],
        result: l.result,
        defect_type: l.defect_type,
        rejection_reason: l.rejection_reason ?? l.defect_type,
        remarks: l.remarks,
        // Left null when the line carries no decision yet — the picker reads that as
        // "nothing rejected", where [] would mean "every unit rejected".
        serial_numbers: parseCodes(l.serial_numbers),
        pack_rejections: (l as { pack_rejections?: Record<string, number> | null }).pack_rejections ?? null,
      })),
    });
  }, [doc]);

  // A stock transfer's QC is worked on Inventory > Stock Transfer. Whatever link
  // opened it here — the approvals inbox, a notification, the issue list's QC button —
  // hand it over there, same id, same issue.
  const { data: startIssue } = useQuery({
    queryKey: ["wh-issue", String(initialIssueId ?? "")],
    queryFn: () => getIssue(Number(initialIssueId)),
    enabled: !basePath && !editing && !!initialIssueId,
  });
  useEffect(() => {
    if (basePath) return;
    if (editing && (doc as { is_stock_transfer?: boolean } | undefined)?.is_stock_transfer) {
      nav(`/inventory/transfers/qc/${id}`, { replace: true });
    } else if (!editing && (startIssue as { is_stock_transfer?: boolean } | undefined)?.is_stock_transfer) {
      nav(`/inventory/transfers/qc/new?issue_id=${initialIssueId}`, { replace: true });
    }
  }, [basePath, editing, doc, startIssue, id, initialIssueId, nav]);

  useEffect(() => {
    if (!editing && initialIssueId && !pulled) {
      pullIssue.mutate(Number(initialIssueId));
    }
  }, [editing, initialIssueId, pulled]);

  /* The Material Issue's serials, by receipt line. They were read off the units at material issue,
   * so inspection picks from them: a serial typed here is one that was never issued,
   * and completion rejects any accepted serial that is not on the Material Issue. */
  const { data: issueDoc } = useQuery({
    queryKey: ["wh-issue", String(doc?.issue_id ?? "")],
    queryFn: () => getIssue(Number(doc?.issue_id)),
    enabled: !!doc?.issue_id,
  });

  const issueFallback = useMemo(
    () => (doc?.issue_id
      ? [{ id: doc.issue_id, code: doc.issue_no ?? String(doc.issue_id),
           name: doc.issue_no ?? String(doc.issue_id) }]
      : []),
    [doc?.issue_id, doc?.issue_no],
  );

  /* A saved inspection that carries an issue but no lines. It should not exist —
   * picking the issue seeds the lines — but one was raised before this screen had a
   * working issue lookup, and an inspection with an empty grid can never be completed
   * or corrected. Seeding from the issue is what picking it would have done, and the
   * guard on `items.length` means a real inspection is never overwritten. */
  useEffect(() => {
    if (!doc || !doc.issue_id) return;
    if ((doc.items ?? []).length > 0 || pulled) return;
    if (doc.status !== "DRAFT" && doc.status !== "IN_PROGRESS") return;
    pullIssue.mutate(doc.issue_id);
  }, [doc, pulled]);

  const delivery = issueDoc ?? pulled;

  /** The issue line's packs, cut to the quantity inspected (2026-10-22) — the same
   *  reading the server gives a saved line. Codes stay per unit. */
  const packsOf = (issueItemId: number | null | undefined, qty: number) => {
    const line = (delivery?.items ?? []).find((x) => x.id === issueItemId);
    const packs = line?.pack_breakdown;
    if (!packs?.length || qty <= 0) return null;
    return Math.abs(baseOf(packs) - qty) < 1e-6 ? packs : shrinkWithin(packs, qty);
  };

  // The strip-by-strip detail behind each line's package check (2026-10-28). Only the
  // rolled-up figure per package goes to the server; this keeps the detail on screen.
  const [innerByLine, setInnerByLine] = useState<Record<number, Record<string, InnerCheck>>>({});

  const deliveryMeta = useMemo(() => {
    const byLine = new Map<number, {
      is_serial_tracked?: boolean, serials: string[], boxes: Map<string, number> | null,
      packName: string, info: Map<string, IssueBox>, issued: number,
    }>();
    for (const line of delivery?.items ?? []) {
      byLine.set(line.id, {
        is_serial_tracked: line.is_serial_tracked || line.is_imei_tracked,
        serials: parseCodes(line.unit_keys?.length ? line.unit_keys : line.serial_numbers) ?? [],
        // Issued in BOXES (2026-10-26): each box code and what it carried of the line.
        boxes: line.issue_in_boxes && line.box_codes?.length
          ? new Map(line.box_codes.map((b) => [b.code, Number(b.take) || 0])) : null,
        packName: (line.box_codes?.[0]?.pack_name ?? "box").toLowerCase(),
        // Where each box sits and the strips inside it (2026-10-28).
        info: new Map((line.box_codes ?? []).map((b) => [b.code, b])),
        // What the issue line sent: the cap on Inspected, and the figure shown beside
        // a line that starts un-inspected at 0 (SCM_0124).
        issued: num(line.issued_qty),
      });
    }
    return byLine;
  }, [delivery]);

  /** The boxes a line issued in boxes sent, code -> what each carried; null otherwise. */
  const boxesOf = (index: number | null) => {
    if (index === null) return null;
    const id = form.items[index]?.issue_item_id;
    return id ? deliveryMeta.get(id)?.boxes ?? null : null;
  };
  /** "1 strip" / "11 strips" — a package count in the issue container's name. */
  const packCount = (index: number, count: number) => {
    const id = form.items[index]?.issue_item_id;
    const name = (id && deliveryMeta.get(id)?.packName) || "box";
    const plural = /(x|s|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
    return `${count} ${count === 1 ? name : plural}`;
  };
  /** The packages of a package line, in the issue's order, with what each carries. */
  const packagesOf = (index: number) => {
    const boxes = boxesOf(index);
    const info = deliveryMeta.get(form.items[index]?.issue_item_id ?? 0)?.info;
    // Drawn as the tree they came out of — carton, box, strip — and a kept box can be
    // checked strip by strip (2026-10-28).
    return boxes ? [...boxes.entries()].map(([code, carries]) => {
      const b = info?.get(code);
      return { code, carries, name: b?.name ?? b?.pack_name, path: b?.path, inner: b?.inner };
    }) : [];
  };
  /** Rejected base units placed in packages: whole packages left out, plus units
   *  rejected out of kept ones (2026-10-26). */
  const placedRejected = (index: number) => {
    const boxes = boxesOf(index);
    if (!boxes) return 0;
    const kept = resolvedSerials(index);
    const partial = form.items[index]?.pack_rejections ?? {};
    return [...boxes.entries()].reduce((sum, [code, carries]) => sum + (kept.includes(code)
      ? Math.min(Number(partial[code] ?? 0), carries) : carries), 0);
  };

  const isSerialTracked = (index: number | null) => {
    if (index === null) return false;
    const issueItemId = form.items[index]?.issue_item_id;
    if (!issueItemId) return false;
    return deliveryMeta.get(issueItemId)?.is_serial_tracked ?? false;
  };

  /** The units the issue LINE sent out — its own batch and its own storage location,
   *  never the whole batch. Two lines of one batch in two bays are two lists. */
  const unitsOfLine = (line?: InspectionItemWrite | null) => {
    const issueItemId = line?.issue_item_id;
    if (!issueItemId) return null;
    const meta = deliveryMeta.get(issueItemId);
    return meta?.serials?.length ? meta.serials : null;
  };
  /** The Material Issue serials behind an inspection line. Serial-tracked items must already have
   *  these from material issue, so QC selects accepted units from this list. */
  const availableSerials = (index: number | null) =>
    index === null ? null : unitsOfLine(form.items[index]);

  /** What the line is keeping, with pre-seed rows repaired: a line raised before
   *  every kind was seeded carries nothing stored while accepting the whole
   *  offered set, which reads as "every unit rejected" unless it is resolved
   *  back to the offered set here. Read-only — the form keeps what it was
   *  given until the modal writes an explicit decision. */
  const resolvedSerials = (index: number): string[] => {
    const line = form.items[index];
    if (!line) return [];
    const boxes = boxesOf(index);
    if (boxes) {
      // Untouched means every box kept; a stored choice keeps only the boxes sent.
      const stored = (line.serial_numbers ?? []).filter((code) => boxes.has(code));
      return stored.length || num(line.accepted_qty) <= 0 ? stored : [...boxes.keys()];
    }
    return resolveAcceptedUnits(
      line.serial_numbers, availableSerials(index), num(line.accepted_qty));
  };

  /** Pulling the receipt in seeds the lines from what was actually issued. */
  const pullIssue = useMutation({
    mutationFn: (issueId: number) => getIssue(issueId),
    onSuccess: (receipt) => {
      setPulled(receipt);
      // Only the lines whose item asks for outward QC. The rest go to packing at
      // their issued quantity; an issue raised before the flag was served carries
      // none, and is inspected whole as it always was.
      const all = receipt.items ?? [];
      const flagged = all.filter((l) => l.requires_qc);
      setForm((f) => ({
        ...f,
        warehouse_id: receipt.warehouse_id,
        items: (flagged.length > 0 ? flagged : all).map((l) => ({
          issue_item_id: l.id,
          item_id: l.item_id,
          // Carried through so the line can name itself before the first save.
          item_code: l.item_code,
          item_name: l.item_name,
          batch_no: l.batch_no,
          // SCM_0124: UN-INSPECTED. Nothing is counted or accepted until the inspector
          // says so; "Pass all un-inspected" does it in one press for a clean load.
          inspected_qty: 0,
          accepted_qty: 0,
          rejected_qty: 0,
          parameters: [],
          result: "PENDING" as const,
          defect_type: null,
          rejection_reason: null,
          remarks: null,
          serial_numbers: null,
        })),
      }));
    },
  });

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof InspectionWrite>(key: K, value: InspectionWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** The line's units after its accepted quantity moves — see `unitsForAccepted`. */
  const keepUnitsInStep = (line: InspectionItemWrite, accepted: number) => {
    // A box line keeps its boxes when the accepted quantity comes down: some units
    // rejected inside a kept box is normal (2026-10-26).
    if (line.issue_item_id && deliveryMeta.get(line.issue_item_id)?.boxes) return line.serial_numbers;
    const offered = unitsOfLine(line);
    return offered
      ? unitsForAccepted(line.serial_numbers, offered, num(line.accepted_qty), accepted)
      : line.serial_numbers;
  };

  /** How many more units the inspector still has to tick as rejected on a line. */
  const unitsToReject = (index: number) => availableSerials(index) && !boxesOf(index)
    ? unitsStillToReject(resolvedSerials(index).length, num(form.items[index]?.accepted_qty))
    : 0;

  /** What the issue line sent — Inspected never goes past it. */
  const issuedOf = (line: InspectionItemWrite) =>
    deliveryMeta.get(line.issue_item_id ?? 0)?.issued;

  const patchLine = (index: number, patch: Partial<InspectionItemWrite>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        // A package line is inspected WHOLE — every package sent is looked at — so its
        // Inspected is what was sent the moment anything is recorded on it.
        const wholePackages = !!(l.issue_item_id && deliveryMeta.get(l.issue_item_id)?.boxes);
        // SCM_0124: one rule for every edit (`applyQcEdit`) — typing Inspected alone
        // never rejects anything, and the line stays Pending until it is accounted for.
        const { inspected, accepted, rejected } = applyQcEdit(
          { inspected: wholePackages ? issuedOf(l) ?? num(l.inspected_qty) : num(l.inspected_qty),
            accepted: num(l.accepted_qty), rejected: num(l.rejected_qty) },
          {
            ...(patch.inspected_qty !== undefined ? { inspected: num(patch.inspected_qty) } : {}),
            ...(patch.accepted_qty !== undefined ? { accepted: num(patch.accepted_qty) } : {}),
            ...(patch.rejected_qty !== undefined ? { rejected: num(patch.rejected_qty) } : {}),
          },
          issuedOf(l),
        );

        return {
          ...next,
          inspected_qty: inspected,
          accepted_qty: accepted,
          rejected_qty: rejected,
          // SCM_0124: the result follows the numbers — the server's rule — and a line
          // not yet accounted for stays Pending.
          result: qcLineResult(inspected, accepted, rejected),
          serial_numbers: patch.serial_numbers !== undefined
            ? patch.serial_numbers
            : keepUnitsInStep(l, accepted),
        };
      }),
    }));

  /** A line is seeded PENDING when the receipt raises the inspection, and the server
   *  derives its real result from the accepted/inspected split on save
   *  (`_derive_result`). Counting the stored PENDING as neither pass nor fail is how
   *  the confirm modal announced "0 pass, 0 fail" over a full sheet of accepted lines.
   *  Count what the save is about to write, by the same rule. */
  const resultOf = (line: InspectionItemWrite) =>
    qcLineResult(num(line.inspected_qty), num(line.accepted_qty), num(line.rejected_qty));

  /** SCM_0124: a clean load is still one press, but a deliberate one — every line
   *  nobody has touched becomes fully inspected and accepted; lines being worked stay. */
  const splitOf = (line: InspectionItemWrite) => ({
    inspected: num(line.inspected_qty), accepted: num(line.accepted_qty),
    rejected: num(line.rejected_qty),
  });
  const untouchedLines = form.items.filter(
    (line) => passIfUntouched(splitOf(line), issuedOf(line) ?? 0) !== null);
  const passAllUntouched = () =>
    setForm((f) => ({
      ...f,
      items: f.items.map((line) => {
        const passed = passIfUntouched(splitOf(line), issuedOf(line) ?? 0);
        return passed
          ? { ...line, inspected_qty: passed.inspected, accepted_qty: passed.accepted,
              rejected_qty: 0, result: "PASSED" as const,
              // Every unit / package kept: left unnamed, the line resolves to all.
              serial_numbers: null, pack_rejections: null }
          : line;
      }),
    }));

  const totals = useMemo(
    () => ({
      lines: form.items.length,
      passed: form.items.filter((l) => resultOf(l) === "PASSED").length,
      failed: form.items.filter((l) => resultOf(l) === "FAILED").length,
      partial: form.items.filter((l) => resultOf(l) === "PARTIAL").length,
      inspected: form.items.reduce((s, l) => s + num(l.inspected_qty), 0),
      rejected: form.items.reduce((s, l) => s + num(l.rejected_qty), 0),
    }),
    [form.items],
  );

  const locked = !!doc && doc.status !== "DRAFT" && doc.status !== "IN_PROGRESS";

  /** A line whose issue line sent out named units — serials, IMEIs, asset tags or
   *  consumable codes. Those are picked here whatever the kind; the server checks each
   *  against what the issue line actually carried. Whole-unit rules for counted UOMs
   *  (Nos, Box…) are the server's, which knows the unit master. */
  const validateAcceptedSerials = () => {
    for (const [index, line] of form.items.entries()) {
      const available = availableSerials(index);
      if (!available && !isSerialTracked(index)) continue;
      const label = `Line ${index + 1} (${line.item_code ?? line.item_name ?? "item"})`;
      if (boxesOf(index)) {
        // Issued in boxes: the kept boxes must hold what is accepted (2026-10-26).
        // Every rejected unit is placed in a package (2026-10-26).
        if (Math.abs(placedRejected(index) - num(line.rejected_qty)) > 1e-6) {
          throw new Error(`${label}: ${num(line.rejected_qty)} rejected, but `
            + `${placedRejected(index)} is placed in packages. Open Accepted units and say which `
            + "packages it came out of.");
        }
        continue;
      }
      const required = Math.floor(num(line.accepted_qty));
      if (num(line.accepted_qty) !== required) {
        const rest = num(line.inspected_qty) - required;
        throw new Error(
          `${label}: units named one by one are accepted whole. ` +
          `Accept ${required} and reject the remaining ${rest} with a reason.`,
        );
      }
      if (!available) continue;
      const actual = resolvedSerials(index).length;
      if (actual !== required) {
        const rejectedQty = num(line.inspected_qty) - required;
        const left = actual - required;
        throw new Error(left > 0
          ? `${label}: ${rejectedQty} rejected — tick ${left} more rejected ${left === 1 ? "unit" : "units"} in Accepted units.`
          : `${label}: ${required} accepted but only ${actual} units are kept. Open Accepted units and accept ${required - actual} more.`);
      }
    }
  };

  /** An untouched picker means "every unit passed" (see the column below). Say so on
   *  the wire: the server counts what it is sent, and null reads as zero selected.
   *  `resolvedSerials` also repairs pre-seed rows back to the offered set, so the
   *  repair is what gets stored and the row opens correctly ever after. */
  const payload = (): InspectionWrite => ({
    ...form,
    items: form.items.map((line, index) => ({
      ...line,
      serial_numbers: resolvedSerials(index),
    })),
  });

  const save = useMutation({
    mutationFn: () => {
      validateAcceptedSerials();
      return editing
        ? updateOutboundInspection(Number(id), payload())
        : createOutboundInspection(payload());
    },
    onSuccess: (saved: Inspection) => {
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-inspection", String(saved.id)] });
      if (!editing) nav(`${listPath}/${saved.id}`, { replace: true });
    },
  });

  const complete = useMutation({
    /* Save first. The server refuses to complete while any *saved* line is PENDING, and
     * a line is seeded PENDING when the receipt raises the inspection — so an inspector
     * who filled the grid and pressed Complete was told the lines were still pending
     * while the confirm modal in front of them counted their own unsaved passes. */
    mutationFn: async () => {
      validateAcceptedSerials();
      await updateOutboundInspection(Number(id), payload());
      return completeOutboundInspection(Number(id));
    },
    onSuccess: () => {
      void alerts.success("inspection.completed", {
        number: doc?.inspection_no ?? "The inspection",
      });
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
      setConfirming(false);
    },
  });

  /* Only ever reachable where an admin configured a QC_OUTWARD ladder on Approvals
   * Config. With none — every project today — Complete finishes the check outright and
   * the document never stops at PENDING_APPROVAL, so these buttons never draw. */
  const decide = useMutation({
    mutationFn: (action: "APPROVE" | "REJECT") =>
      action === "APPROVE"
        ? approveOutboundInspection(Number(id))
        : rejectOutboundInspection(Number(id), "Rejected on the Outward QC screen"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
    },
  });

  /* Cancelling hands the Material Issue back: the server walks an untouched receipt out of
   * PENDING_QC to DRAFT, which is the only way to correct lines — serials above all —
   * once the receipt has been submitted. */
  const cancel = useMutation({
    mutationFn: () => null as any, // cancelOutboundInspection(Number(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-issues"] });
      setCancelling(false);
    },
  });

  const columns: LineColumn<InspectionItemWrite>[] = [
    {
      key: "item",
      header: "Item",
      render: (l, i) => {
        const saved = savedLine(i);
        return (
          <div className="min-w-0">
            {/* Saved snapshot first, then what the Material Issue pull carried in. Only a line
                with neither falls back to the id. */}
            <div className="truncate font-mono text-xs font-semibold text-ink">
              {saved?.item_code ?? l.item_code ?? `Item ${l.item_id}`}
            </div>
            <div className="truncate text-xs text-muted">
              {saved?.item_name ?? l.item_name ?? "—"}
              {l.batch_no ? ` · batch ${l.batch_no}` : ""}
            </div>
            <CombinationTag value={saved ?? l} className="mt-1" />
            {(() => {
              const packs = saved?.pack_breakdown ?? packsOf(l.issue_item_id, num(l.inspected_qty));
              return packs?.length ? (
                <PackQty entries={packs} qty={l.inspected_qty} uom={saved?.uom_code ?? (delivery?.items ?? []).find((x) => x.id === l.issue_item_id)?.uom_code}
                         itemId={l.item_id} className="mt-1" />
              ) : null;
            })()}
          </div>
        );
      },
    },
    {
      key: "issued",
      header: "Issued",
      numeric: true,
      width: "w-24",
      // SCM_0124: what went out, beside a line that starts un-inspected — so "0
      // inspected" reads as "not checked yet", never as nothing sent.
      render: (l, i) => (
        <span className="tabular text-sm text-body">
          {fmtQty(issuedOf(l) ?? 0)}
          <span className="ml-1 text-[11px] text-muted">{savedLine(i)?.uom_code ?? ""}</span>
        </span>
      ),
    },
    {
      key: "inspected",
      header: "Inspected",
      numeric: true,
      width: "w-28",
      render: (l, i) => boxesOf(i) ? (
        // Issued in packages (2026-10-26): every package sent is inspected.
        <div className="text-sm">
          <div className="font-semibold text-ink">{packCount(i, boxesOf(i)!.size)}</div>
          <div className="text-[11px] text-muted">{fmtQty(num(l.inspected_qty))} base</div>
        </div>
      ) : (
        <QtyInput
          ariaLabel={`Inspected quantity, line ${i + 1}`}
          value={l.inspected_qty}
          disabled={locked}
          onChange={(v) => patchLine(i, { inspected_qty: v })}
        />
      ),
    },
    {
      key: "accepted",
      header: "Accepted",
      numeric: true,
      width: "w-28",
      render: (l, i) => boxesOf(i) ? (
        // Worked out, never typed: what the kept packages carry, less what was
        // rejected out of them (2026-10-26).
        <div className="text-sm">
          <div className="font-semibold text-ink">{fmtQty(num(l.accepted_qty))}</div>
          <div className="text-[11px] text-muted">in {packCount(i, resolvedSerials(i).length)}</div>
        </div>
      ) : (
        <QtyInput
          ariaLabel={`Accepted quantity, line ${i + 1}`}
          value={l.accepted_qty}
          max={num(l.inspected_qty)}
          disabled={locked}
          onChange={(v) => patchLine(i, { accepted_qty: v })}
        />
      ),
    },
    {
      key: "rejected",
      header: "Rejected",
      numeric: true,
      width: "w-28",
      render: (l, i) => boxesOf(i) ? (
        // Rejected in BASE units; every one of them is then placed in a package.
        <div>
          <QtyInput
            ariaLabel={`Rejected quantity, line ${i + 1}`}
            value={l.rejected_qty}
            max={num(l.inspected_qty)}
            disabled={locked}
            onChange={(v) => patchLine(i, { rejected_qty: v })}
          />
          {num(l.rejected_qty) > 0 && (
            Math.abs(placedRejected(i) - num(l.rejected_qty)) > 1e-6 ? (
              <button type="button" onClick={() => setSerialsFor(i)} disabled={locked}
                      className="mt-0.5 text-[11px] font-semibold text-warn underline">
                {fmtQty(placedRejected(i))} of {fmtQty(num(l.rejected_qty))} placed — say which packs
              </button>
            ) : (
              <div className="mt-0.5 text-[11px] text-ok">All placed in packs</div>
            )
          )}
        </div>
      ) : (
        <QtyInput
          ariaLabel={`Rejected quantity, line ${i + 1}`}
          value={l.rejected_qty}
          max={num(l.inspected_qty)}
          disabled={locked}
          onChange={(v) => patchLine(i, { rejected_qty: v })}
        />
      ),
    },
    {
      key: "result",
      header: "Result",
      width: "w-32",
      // Shown, not picked (SCM_0124): it follows the numbers, as on inward QC — a
      // dropdown here let a line read "Pass" over goods nobody had counted.
      render: (l) => <QcResultBadge result={resultOf(l)} />,
    },
    {
      key: "defect",
      header: "Rejection reason",
      width: "w-36",
      // Always shown: the save refuses a rejection without it, so hiding it under
      // 1024 px left a laptop inspector unable to reject anything.
      render: (l, i) => (
        <TextInput
          ariaLabel={`Defect, line ${i + 1}`}
          value={l.rejection_reason ?? l.defect_type}
          disabled={locked || num(l.rejected_qty) === 0}
          placeholder={num(l.rejected_qty) > 0 ? "Required" : "—"}
          onChange={(v) => patchLine(i, { rejection_reason: v, defect_type: v })}
        />
      ),
    },
    {
      key: "serials",
      // Serials, IMEIs, asset tags and consumable codes alike: whatever named the
      // units this issue line sent out. Only serial-tracked lines used to get it.
      header: "Accepted units",
      width: "w-40",
      hideOnNarrow: true,
      render: (_line, index) => {
        const available = availableSerials(index);
        if (!available && !isSerialTracked(index)) return <span className="text-muted">—</span>;
        // An untouched line has decided nothing, which means nothing rejected — show it
        // as all accepted rather than as zero. `resolvedSerials` additionally repairs
        // pre-seed rows (nothing stored, whole set accepted) back to the offered set.
        const accepted = resolvedSerials(index).length;
        const boxes = boxesOf(index);
        if (boxes) {
          const whole = boxes.size - accepted;
          const partial = Object.values(form.items[index]?.pack_rejections ?? {})
            .filter((n) => Number(n) > 0).length;
          const placed = Math.abs(placedRejected(index) - num(form.items[index]?.rejected_qty)) < 1e-6;
          return (
            <div>
              <Button variant="ghost" onClick={() => setSerialsFor(index)}
                      title={locked ? "View the packages" : "Say which packages were rejected"}>
                {placed && !whole && !partial ? <CheckCircle2 className="h-4 w-4 text-ok" />
                  : <ScanLine className={`h-4 w-4 ${placed ? "text-ok" : "text-warn"}`} />}
                {accepted}/{boxes.size} kept
              </Button>
              {(whole > 0 || partial > 0) && (
                <div className="mt-0.5 text-[11px] text-muted">
                  {whole > 0 && <span className="text-bad">{packCount(index, whole)} rejected</span>}
                  {whole > 0 && partial > 0 && " · "}
                  {partial > 0 && <span className="text-warn">{partial} part-rejected</span>}
                </div>
              )}
            </div>
          );
        }
        const toPick = unitsToReject(index);
        if (toPick > 0 && !locked) {
          return (
            <Button variant="soft" onClick={() => setSerialsFor(index)}
                    title="Tick the units that failed — only the rejected ones">
              <ScanLine className="h-4 w-4 text-warn" />
              <span className="text-warn">Pick {toPick} rejected</span>
            </Button>
          );
        }
        return (
          <Button variant="ghost" onClick={() => setSerialsFor(index)}
                  title={locked ? "View the accepted units" : "All units are accepted. Open to change which are rejected."}>
            {available && accepted === available.length
              ? <CheckCircle2 className="h-4 w-4 text-ok" />
              : <ScanLine className="h-4 w-4" />}
            {available ? `${accepted}/${available.length}` : accepted}
          </Button>
        );
      },
    },
    {
      key: "params",
      header: "Readings",
      width: "w-28",
      hideOnNarrow: true,
      render: (l, i) => (
        <Button variant="ghost" onClick={() => setParamsFor(i)}>
          {l.parameters?.length ? `${l.parameters.length}` : "Add"}
        </Button>
      ),
    },
  ];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const params = paramsFor === null ? [] : form.items[paramsFor]?.parameters ?? [];
  const setParams = (rows: InspectionParameter[]) =>
    paramsFor !== null && patchLine(paramsFor, { parameters: rows });

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={editing ? `Inspection ${doc?.inspection_no ?? ""}` : "New inspection"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(listPath)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do={editing ? "qc_outward.update" : "qc_outward.create"}>
                <Button variant="soft" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="qc_outward.delete">
                <Button variant="dangerSoft" onClick={() => setCancelling(true)}>
                  Cancel inspection
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="qc_outward.approve">
                <Button onClick={() => setConfirming(true)} disabled={form.items.length === 0}>
                  Complete inspection
                </Button>
              </Can>
            )}
            {editing && doc?.status === "PENDING_APPROVAL" && (
              <Can do="qc_outward.approve">
                <Button className={TONE_REJECT} variant="dangerSoft" onClick={() => decide.mutate("REJECT")}
                        disabled={decide.isPending}>
                  Reject
                </Button>
                <Button className={TONE_APPROVE} onClick={() => decide.mutate("APPROVE")} disabled={decide.isPending}>
                  {decide.isPending ? "Working…" : "Approve"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? pullIssue.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.inspection_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          {doc.current_approver_name && (
            <MetaRow label="With" value={doc.current_approver_name} />
          )}
          <MetaRow
            label="Pass rate"
            // By quantity, as served (SCM_0165) — passed LINES over all lines read 0 % on
            // a line that kept most of itself.
            value={<span className="tabular">{qcRate(doc.pass_rate ?? null)}</span>}
          />
        </MetaCard>
      )}

      <Section title="Inspection">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input
              type="date"
              value={form.inspection_date}
              disabled={locked}
              onChange={(e) => set("inspection_date", e.target.value)}
            />
          </Field>
          <Field label="Against Material Issue" hint="Pulls the issued lines in.">
            <Lookup
              name="inspectable-issues"
              load={inspectableIssueOptions}
              /* The loader lists issues that still owe a check, so an issue already
                 inspected by THIS document is not on it. Without the fallback the
                 Select finds no option matching the id and draws its placeholder over
                 a field that plainly has a value — which is why a saved inspection
                 showed "Material Issue" instead of the number it was raised against. */
              fallback={issueFallback}
              value={form.issue_id || ""}
              isDisabled={locked}
              onChange={(v) => {
                set("issue_id", v === "" ? 0 as any : Number(v));
                if (v !== "") pullIssue.mutate(Number(v));
              }}
              placeholder="Material Issue"
            />
          </Field>
          <Field label="Warehouse">
            <Lookup
              name="warehouses"
              load={warehouseOptions}
              value={form.warehouse_id ?? ""}
              isDisabled={locked}
              onChange={(v) => set("warehouse_id", v === "" ? null : v)}
              placeholder="Warehouse"
            />
          </Field>
          {/* SCM_0160, as SCM_0097 inward: the inspector is whoever is signed in and
            * doing the check. The picker here listed every employee in HCM and a
            * signed sheet could carry anybody's name; the server now records the
            * signed-in user on create and keeps them on every edit, so this is shown,
            * never chosen. */}
          <Field label="Inspector" hint={editing ? "Recorded when this check was started." : "You — the signed-in user."}>
            <Input value={(editing ? doc?.inspector_name : me?.employee?.name) ?? "—"} disabled />
          </Field>
        </div>
      </Section>

      {(() => {
        const covered = new Set(form.items.map((line) => line.issue_item_id));
        const skipped = (delivery?.items ?? []).filter(
          (line) => !line.requires_qc && !covered.has(line.id) && num(line.issued_qty) > 0);
        if (skipped.length === 0) return null;
        return (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-content2/50 px-4 py-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div>
              <p className="font-semibold text-ink">
                {skipped.length} {skipped.length === 1 ? "line needs" : "lines need"} no outward QC
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {skipped.map((line) => `${line.item_code ?? line.item_id}${line.batch_no ? ` / ${line.batch_no}` : ""}`).join(", ")}
                {" "}— not inspected here, and packed at the full issued quantity.
              </p>
            </div>
          </div>
        );
      })()}

      <Section
        title="Lines"
        hint="Lines start un-inspected. Enter what you checked, then what you accept or reject — tick the rejected units where asked."
        actions={!locked && untouchedLines.length > 0 ? (
          <Button variant="soft" onClick={passAllUntouched}>
            <CheckCheck aria-hidden className="h-4 w-4" />
            Pass all un-inspected ({untouchedLines.length})
          </Button>
        ) : undefined}
      >
        <LinesEditor
          rows={form.items}
          columns={columns}
          // Wide enough for every column's own width: narrower, and the auto table
          // squeezed the Result dropdown and the quantities until they read "Pa…".
          minTableWidth="min-w-[1160px]"
          keyOf={(_, i) => i}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          rowTone={(l) => (l.result === "FAILED" ? "bg-bad-bg/40" : undefined)}
          empty="Pick a Material Issue above to pull its lines in."
          footer={
            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span className="text-muted">{totals.lines} lines</span>
              <span className="text-ok">Passed <b className="tabular">{totals.passed}</b></span>
              <span className={totals.failed > 0 ? "text-bad" : "text-muted"}>
                Failed <b className="tabular">{totals.failed}</b>
              </span>
              <span className="text-ink">Inspected <b className="tabular">{fmtQty(totals.inspected)}</b></span>
              <span className={totals.rejected > 0 ? "text-bad" : "text-muted"}>
                Rejected <b className="tabular">{fmtQty(totals.rejected)}</b>
              </span>
            </div>
          }
        />
      </Section>

      {paramsFor !== null && (
        <Section
          title={`Readings — line ${paramsFor + 1}`}
          hint="What was measured, and what it should have been."
          actions={
            <>
              <Button
                variant="subtle"
                onClick={() => setParams([...params, { name: "", expected: "", observed: "", result: "PASS" }])}
                disabled={locked}
              >
                <Plus className="h-4 w-4" /> Add reading
              </Button>
              <Button variant="ghost" onClick={() => setParamsFor(null)}>Close</Button>
            </>
          }
        >
          {params.length === 0 ? (
            <p className="text-sm text-muted">No readings recorded for this line.</p>
          ) : (
            <div className="space-y-2">
              {params.map((p, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_130px_44px]">
                  <Input
                    value={p.name}
                    placeholder="Parameter"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, name: e.target.value } : r)))
                    }
                  />
                  <Input
                    value={p.expected ?? ""}
                    placeholder="Expected"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, expected: e.target.value } : r)))
                    }
                  />
                  <Input
                    value={p.observed ?? ""}
                    placeholder="Observed"
                    disabled={locked}
                    onChange={(e) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, observed: e.target.value } : r)))
                    }
                  />
                  <Select
                    value={p.result ?? "PASS"}
                    onChange={(v) =>
                      setParams(params.map((r, x) => (x === i ? { ...r, result: v as "PASS" | "FAIL" } : r)))
                    }
                    options={[{ value: "PASS", label: "Pass" }, { value: "FAIL", label: "Fail" }]}
                    isDisabled={locked}
                    ariaLabel={`Reading ${i + 1} result`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove reading ${i + 1}`}
                    disabled={locked}
                    onClick={() => setParams(params.filter((_, x) => x !== i))}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      <Section title="Evidence" hint="Test certificates, photographs of the defect.">
        <AttachmentsPanel entityType="OUTBOUND_INSPECTION" entityId={doc?.id} category="QC" readOnly={locked} />
      </Section>

      <PackageCheckModal
        open={serialsFor !== null && !!boxesOf(serialsFor)}
        onClose={() => setSerialsFor(null)}
        mode="qc"
        packages={serialsFor === null ? [] : packagesOf(serialsFor)}
        value={{
          kept: serialsFor === null ? [] : resolvedSerials(serialsFor),
          partial: (serialsFor === null ? null : form.items[serialsFor]?.pack_rejections) ?? {},
          inner: serialsFor === null ? {} : innerByLine[serialsFor] ?? {},
        }}
        target={serialsFor === null ? undefined : num(form.items[serialsFor]?.rejected_qty)}
        packName={serialsFor === null ? "package"
          : deliveryMeta.get(form.items[serialsFor]?.issue_item_id ?? 0)?.packName ?? "package"}
        uom={serialsFor === null ? null : savedLine(serialsFor)?.uom_code ?? null}
        itemLabel={serialsFor === null ? ""
          : `${form.items[serialsFor]?.item_code ?? ""} — ${form.items[serialsFor]?.item_name ?? ""}`}
        readOnly={locked}
        onSave={({ kept, partial, inner }) => {
          if (serialsFor === null) return;
          setInnerByLine((now) => ({ ...now, [serialsFor]: inner ?? {} }));
          const boxes = boxesOf(serialsFor)!;
          const lost = [...boxes.entries()].reduce((sum, [code, carries]) => sum + (kept.includes(code)
            ? Math.min(partial[code] ?? 0, carries) : carries), 0);
          patchLine(serialsFor, { serial_numbers: kept, pack_rejections: partial, rejected_qty: lost });
        }}
      />

      <SerialNumbersModal
        isOpen={serialsFor !== null && !boxesOf(serialsFor)}
        onClose={() => setSerialsFor(null)}
        quantity={serialsFor === null ? 0 : boxesOf(serialsFor)
          ? resolvedSerials(serialsFor).length : num(form.items[serialsFor]?.accepted_qty)}
        initial={serialsFor === null ? null : resolvedSerials(serialsFor)}
        available={availableSerials(serialsFor)}
        enforceCount
        itemLabel={
          serialsFor === null
            ? ""
            : savedLine(serialsFor)?.item_name ?? `Line ${serialsFor + 1}`
        }
        readOnly={locked}
        onSave={(accepted) => {
          // The units kept are the quantity accepted — one serial is one unit, so
          // letting the inspector type a different number could only disagree with it.
          if (serialsFor !== null) {
            const boxes = boxesOf(serialsFor);
            if (boxes) {
              // A box unticked is rejected whole: the accepted quantity drops to what
              // the kept boxes hold, never rises above what was accepted.
              // The packages kept ARE the accepted quantity (2026-10-26).
              patchLine(serialsFor, {
                serial_numbers: accepted,
                accepted_qty: accepted.reduce((sum, code) => sum + (boxes.get(code) ?? 0), 0),
              });
              return;
            }
            patchLine(serialsFor, {
              serial_numbers: accepted,
              ...(availableSerials(serialsFor) ? { accepted_qty: accepted.length } : {}),
            });
          }
        }}
      />

      <ConfirmModal
        isOpen={confirming}
        title="Complete this inspection?"
        message={
          <>
            The result is written back onto the Material Issue lines: {totals.passed} pass, {totals.failed} fail
            {totals.partial > 0 && <>, {totals.partial} partial</>}, {fmtQty(totals.rejected)}{" "}
            rejected. The inspection can no longer be edited.
            {totals.failed > 0 && (
              <Chip size="sm" variant="flat" color="danger" className="ml-2">
                Failed lines will block the receipt from posting in full
              </Chip>
            )}
          </>
        }
        confirmLabel="Complete"
        danger={totals.failed > 0}
        busy={complete.isPending}
        error={complete.error}
        onConfirm={() => complete.mutate()}
        onClose={() => setConfirming(false)}
      />

      <ConfirmModal
        isOpen={cancelling}
        title="Cancel this inspection?"
        message={
          <>
            The inspection is closed and its Material Issue goes back to draft, so the lines can be
            corrected and submitted again. A Material Issue with stock already released stays where
            it is.
          </>
        }
        confirmLabel="Cancel inspection"
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelling(false)}
      />
    </div>
  );
}
