import {
  Button, Can, ConfirmModal, DocumentScopeStrip, ErrorBanner, Field, Input, PackageCheckModal,
  PageHeader, Select, StatusPill,
} from "@/shared/components";
import {
  type PackEntry, baseOf, checkFrom, checkSummary, expandPacks, shrinkWithin, splitByCheck,
} from "@/shared/packing";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { ArrowLeft, Boxes, CheckCheck, FileText, Plus, ScanLine, Trash2 } from "lucide-react";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, TextInput, type LineColumn } from "../components/LinesEditor";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { InspectionLinkedDocuments } from "../components/LinkedDocuments";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  cancelInspection, completeInspection, createInspection, getInspection,
  getReceipt, grnOptions,
  updateInspection, warehouseOptions,
} from "../api";
import { fmtQty, num, today } from "../format";
import { applyQcEdit, passIfUntouched, qcLineResult, qcRate, qcSentence, summarizeQc } from "../qcSummary";
import { QcResultBadge, QcVerdictPanel, QcVerdictStrip } from "../components/QcVerdict";
import { resolveAcceptedUnits } from "../qcUnits";
import { alerts } from "@/modules/alerts";
import { useAuth } from "@/shared/auth/AuthContext";
import type {
  Inspection, InspectionItemWrite, InspectionParameter, InspectionWrite, Receipt,
} from "../types";
import { usePointLabel } from "../usePointLabel";
import { CombinationTag, comboFrom } from "@/shared/combination";

/**
 * Inspect a receipt line by line.
 *
 * Picking the GRN pulls its lines in with their received quantities — an inspection
 * typed from scratch is how quantities came to disagree with the receipt they were
 * supposedly inspecting.
 *
 * `result` is derived from the split, not chosen: all accepted is a pass, all
 * rejected is a fail, anything between is partial. A per-line parameter table
 * (`parameters` JSON) records what was actually measured, because "failed" without a
 * reading is not something a vendor can be held to.
 */


/** The GRN picker on this screen, narrowed server-side to deliveries still awaiting QC.
 *  Declared out here so the `Lookup` gets a stable function and does not refetch on
 *  every keystroke of the rest of the form. */
const awaitingQcOptions = (search?: string) => grnOptions(search, undefined, true);


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

export default function QualityInspectionForm({
  type = "INCOMING",
}: {
  type?: "INCOMING" | "OUTGOING";
}) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  /* Absolute: this screen is mounted at two depths, so `".."` resolved against the
   * matched route and Back landed somewhere different depending on the entry URL. */
  const listPath = type === "OUTGOING" ? "/warehouse/qc-outward" : "/warehouse/quality-inspection";

  const [form, setForm] = useState<InspectionWrite>({
    inspection_date: today(),
    receipt_id: null,
    warehouse_id: null,
    inspection_type: type,
    inspector_id: null,
    remarks: "",
    items: [],
  });
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pulled, setPulled] = useState<Receipt | null>(null);
  const [paramsFor, setParamsFor] = useState<number | null>(null);
  const [serialsFor, setSerialsFor] = useState<number | null>(null);
  const [paramsForImeis, setParamsForImeis] = useState<number | null>(null);
  /** The line whose packs are being inspected one by one (2026-10-27). */
  const [packsFor, setPacksFor] = useState<number | null>(null);

  /* The inspector is whoever is standing at the bench. Left at "pick one" it was a
   * list of every active employee in HCM with the person actually inspecting somewhere
   * in it, so a signed inspection could carry anybody's name. Shown read-only from the
   * login (SCM_0097): the server records the signed-in user when the sheet is saved
   * and again when it is submitted, so a picker here would only offer a choice the
   * save ignores. A draft auto-raised from a GRN carries NO inspector — the store
   * keeper who submitted the GRN is not the person doing the check — so the field
   * reads the signed-in user until the sheet is signed, then the recorded name. */
  const { me } = useAuth();
  const prefilledInspector = useRef(false);
  useEffect(() => {
    if (editing || prefilledInspector.current || form.inspector_id || !me) return;
    prefilledInspector.current = true;
    setForm((f) => ({ ...f, inspector_id: me.employee.id }));
  }, [editing, form.inspector_id, me]);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-inspection", id],
    queryFn: () => getInspection(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      inspection_date: doc.inspection_date,
      receipt_id: doc.receipt_id ?? null,
      warehouse_id: doc.warehouse_id ?? null,
      inspection_type: doc.inspection_type,
      inspector_id: doc.inspector_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        receipt_item_id: l.receipt_item_id,
        ...comboFrom(l),
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
        imei_numbers: parseCodes(l.imei_numbers),
        accepted_pack_breakdown: l.accepted_pack_breakdown ?? null,
        rejected_pack_breakdown: l.rejected_pack_breakdown ?? null,
      })),
    });
  }, [doc]);

  /* The GRN's serials, by receipt line. They were read off the units at goods receipt,
   * so inspection picks from them: a serial typed here is one that was never received,
   * and completion rejects any accepted serial that is not on the GRN. */
  const { data: grn } = useQuery({
    queryKey: ["wh-receipt", String(doc?.receipt_id ?? "")],
    queryFn: () => getReceipt(Number(doc?.receipt_id)),
    enabled: !!doc?.receipt_id,
  });

  const [warehouseName, setWarehouseName] = useState("");
  const [grnNo, setGrnNo] = useState("");

  const grnFallback = useMemo(() => {
    const no = doc?.grn_no || grnNo;
    return form.receipt_id && no ? [{ id: form.receipt_id, name: no, code: no }] : undefined;
  }, [form.receipt_id, doc?.grn_no, grnNo]);

  const warehouseFallback = useMemo(() => {
    const wName = doc?.warehouse_name || warehouseName;
    return form.warehouse_id && wName ? [{ id: form.warehouse_id, name: wName, code: "" }] : undefined;
  }, [form.warehouse_id, doc?.warehouse_name, warehouseName]);

  /** The delivery being inspected: the receipt loaded off a saved inspection, or the
   *  one just pulled in on a new one. QC was showing the lines and nothing about where
   *  they came from, so an inspector could not see the order, the vendor or the invoice
   *  the goods arrived on without opening the GRN in another tab. */
  const delivery = grn ?? pulled;

  const deliveryMeta = useMemo(() => {
    const byLine = new Map<number, { is_serial_tracked?: boolean, serials: string[], is_imei_tracked?: boolean, imeis: string[], packs: PackEntry[] | null, uom?: string | null, received: number }>();
    for (const line of delivery?.items ?? []) {
      byLine.set(line.id, {
        is_serial_tracked: line.is_serial_tracked,
        serials: parseCodes(line.serial_numbers) ?? [],
        is_imei_tracked: line.is_imei_tracked,
        imeis: parseCodes(line.imei_numbers) ?? [],
        // What the GRN COUNTED, in packs — what QC keeps or rejects pack by pack.
        packs: line.pack_breakdown?.some((e) => e.level > 0 && num(e.qty) > 0)
          ? line.pack_breakdown : null,
        uom: line.uom_code,
        // What arrived on the GRN line: the cap on Inspected, and the figure shown
        // beside a line that starts un-inspected at 0 (SCM_0124).
        received: num(line.received_qty),
      });
    }
    return byLine;
  }, [delivery]);

  const isSerialTracked = (index: number | null) => {
    if (index === null) return false;
    const receiptItemId = form.items[index]?.receipt_item_id;
    if (!receiptItemId) return false;
    return deliveryMeta.get(receiptItemId)?.is_serial_tracked ?? false;
  };

  const isImeiTracked = (index: number | null) => {
    if (index === null) return false;
    const receiptItemId = form.items[index]?.receipt_item_id;
    if (!receiptItemId) return false;
    return deliveryMeta.get(receiptItemId)?.is_imei_tracked ?? false;
  };

  /** The GRN serials behind an inspection line. Serial-tracked items must already have
   *  these from goods receipt, so QC selects accepted units from this list. */
  const availableSerials = (index: number | null) => {
    if (index === null) return null;
    const receiptItemId = form.items[index]?.receipt_item_id;
    if (!receiptItemId) return null;
    const meta = deliveryMeta.get(receiptItemId);
    return meta?.serials?.length ? meta.serials : null;
  };

  /** The packs the GRN counted for a line, when QC can decide it pack by pack: the
   *  whole delivery is being inspected (a part inspection judges units, not packs). */
  const receivedPacks = (index: number | null): PackEntry[] | null => {
    if (index === null) return null;
    const line = form.items[index];
    const meta = line?.receipt_item_id ? deliveryMeta.get(line.receipt_item_id) : undefined;
    if (!meta?.packs) return null;
    return Math.abs(baseOf(meta.packs) - num(line.inspected_qty)) < 1e-6 ? meta.packs : null;
  };
  /** A line's pack verdict as the modal reads it: what was decided, else the accepted
   *  quantity cut down out of the counted packs (how a typed number reads). */
  const packCheckOf = (index: number) => {
    const ref = receivedPacks(index) ?? [];
    const packs = expandPacks(ref);
    const line = form.items[index];
    const kept = line.accepted_pack_breakdown
      ?? shrinkWithin(ref, Math.min(num(line.accepted_qty), baseOf(ref)));
    return { packs, check: checkFrom(packs, kept) };
  };

  /** The GRN IMEIs behind an inspection line. */
  const availableImeis = (index: number | null) => {
    if (index === null) return null;
    const receiptItemId = form.items[index]?.receipt_item_id;
    if (!receiptItemId) return null;
    const meta = deliveryMeta.get(receiptItemId);
    return meta?.imeis?.length ? meta.imeis : null;
  };

  /** What the line is keeping, with pre-seed rows repaired: a line stored with
   *  nothing while accepting the whole offered set reads as "every unit
   *  rejected" unless it is resolved back to the offered set here. Read-only —
   *  the form keeps what it was given until the modal writes an explicit
   *  decision. */
  const resolvedSerials = (index: number): string[] => {
    const line = form.items[index];
    if (!line) return [];
    return resolveAcceptedUnits(
      line.serial_numbers, availableSerials(index), num(line.accepted_qty));
  };
  const resolvedImeis = (index: number): string[] => {
    const line = form.items[index];
    if (!line) return [];
    return resolveAcceptedUnits(
      line.imei_numbers, availableImeis(index), num(line.accepted_qty));
  };

  /** Pulling the receipt in seeds the lines from what was actually received. */
  const pullReceipt = useMutation({
    mutationFn: (receiptId: number) => getReceipt(receiptId),
    onSuccess: (receipt) => {
      setPulled(receipt);
      setForm((f) => ({
        ...f,
        warehouse_id: receipt.warehouse_id,
        // Only the lines the item master sends to QC. The rest went straight to
        // putaway when the GRN was submitted, and the server refuses them here.
        items: (receipt.items ?? []).filter((l) => l.requires_qi).map((l) => ({
          receipt_item_id: l.id,
          item_id: l.item_id,
          ...comboFrom(l),
          item_code: l.item_code,
          item_name: l.item_name,
          batch_no: l.batch_no,
          // SCM_0124: UN-INSPECTED. Nothing is counted or accepted until the inspector
          // says so; "Pass all un-inspected" does it in one press for a clean delivery.
          inspected_qty: 0,
          accepted_qty: 0,
          rejected_qty: 0,
          parameters: [],
          result: "PENDING" as const,
          defect_type: null,
          rejection_reason: null,
          remarks: null,
          serial_numbers: null,
          imei_numbers: null,
        })),
      }));
      if (receipt.warehouse_name) setWarehouseName(receipt.warehouse_name);
      if (receipt.grn_no) setGrnNo(receipt.grn_no);
    },
  });

  /* Opened straight off a GRN: `?receipt_id=` names the delivery, so the inspector
   * lands on a form already pointed at it rather than hunting it out of a picker.
   * New documents only, and once — a saved inspection's receipt is its own. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (editing || prefilled.current) return;
    const fromUrl = Number(search.get("receipt_id"));
    if (!Number.isFinite(fromUrl) || fromUrl <= 0) return;
    prefilled.current = true;
    set("receipt_id", fromUrl);
    pullReceipt.mutate(fromUrl);
    // `pullReceipt`/`set` are recreated each render; the ref is what makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, search]);

  const savedLine = (i: number) => doc?.items?.[i];

  const set = <K extends keyof InspectionWrite>(key: K, value: InspectionWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** What arrived on a line's GRN line — Inspected never goes past it. */
  const receivedOf = (line: InspectionItemWrite) =>
    deliveryMeta.get(line.receipt_item_id ?? 0)?.received;

  const patchLine = (index: number, patch: Partial<InspectionItemWrite>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...patch };
        // SCM_0124: one rule for every edit (`applyQcEdit`) — typing Inspected alone
        // never rejects anything, and the line stays Pending until it is accounted for.
        const { inspected, accepted, rejected } = applyQcEdit(
          { inspected: num(l.inspected_qty), accepted: num(l.accepted_qty),
            rejected: num(l.rejected_qty) },
          {
            ...(patch.inspected_qty !== undefined ? { inspected: num(patch.inspected_qty) } : {}),
            ...(patch.accepted_qty !== undefined ? { accepted: num(patch.accepted_qty) } : {}),
            ...(patch.rejected_qty !== undefined ? { rejected: num(patch.rejected_qty) } : {}),
          },
          receivedOf(l),
        );

        // A pack verdict that no longer adds up — the number was typed, or the serials
        // picked a different count — is dropped rather than sent: the server refuses
        // packs that disagree with the quantity, and the typed number is the newer word.
        const packsAgree = !next.accepted_pack_breakdown
          || (Math.abs(baseOf(next.accepted_pack_breakdown) - accepted) < 1e-6
              && Math.abs(accepted + baseOf(next.rejected_pack_breakdown) - inspected) < 1e-6);
        return {
          ...next,
          accepted_qty: accepted,
          rejected_qty: rejected,
          ...(packsAgree ? {} : { accepted_pack_breakdown: null, rejected_pack_breakdown: null }),
          // SCM_0164 / 0124: the result FOLLOWS the numbers, as the server's does.
          inspected_qty: inspected,
          result: qcLineResult(inspected, accepted, rejected),
        };
      }),
    }));

  /** A line's result, live: always its own split (SCM_0164), which is what the save
   *  writes — the server derives it the same way. A line seeded PENDING with a full
   *  split is counted as what it is about to be, not as nothing; that is how the
   *  confirm dialog once announced "0 pass, 0 fail" over a sheet of accepted lines. */
  const resultOf = (line: InspectionItemWrite) =>
    qcLineResult(num(line.inspected_qty), num(line.accepted_qty), num(line.rejected_qty));

  /** SCM_0124: a clean delivery is still one press, but a deliberate one — every line
   *  nobody has touched becomes fully inspected and accepted; lines being worked stay. */
  const splitOf = (line: InspectionItemWrite) => ({
    inspected: num(line.inspected_qty), accepted: num(line.accepted_qty),
    rejected: num(line.rejected_qty),
  });
  const untouchedLines = form.items.filter(
    (line) => passIfUntouched(splitOf(line), receivedOf(line) ?? 0) !== null);
  const passAllUntouched = () =>
    setForm((f) => ({
      ...f,
      items: f.items.map((line) => {
        const passed = passIfUntouched(splitOf(line), receivedOf(line) ?? 0);
        return passed
          ? { ...line, inspected_qty: passed.inspected, accepted_qty: passed.accepted,
              rejected_qty: 0, result: "PASSED" as const,
              // Every unit kept: left unnamed, the line resolves to all of them.
              serial_numbers: null, imei_numbers: null,
              accepted_pack_breakdown: null, rejected_pack_breakdown: null }
          : line;
      }),
    }));

  /** Every total on this screen, by QUANTITY (SCM_0164 / 0165 / 0166) — the panel,
   *  the strip under the lines, the Document card and the confirm dialog all read it,
   *  so none of them can disagree with another. See `../qcSummary`. */
  const summary = useMemo(
    () => summarizeQc(form.items.map((line) => ({ ...line, result: resultOf(line) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.items],
  );
  /** The unit, named only when every line shares one: "10 PCS" is a fact, "10 units"
   *  over a box of strips and a carton of bottles is not. */
  const sharedUom = useMemo(() => {
    const uoms = new Set(form.items.map((line, i) =>
      savedLine(i)?.uom_code ?? deliveryMeta.get(line.receipt_item_id ?? 0)?.uom ?? ""));
    const [only] = uoms;
    return uoms.size === 1 && only ? only : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.items, deliveryMeta, doc]);

  const locked = !!doc && doc.status !== "DRAFT" && doc.status !== "IN_PROGRESS";

  const validateAcceptedUnits = () => {
    for (const [index, line] of form.items.entries()) {
      const required = Math.floor(num(line.accepted_qty));

      const availableSerialsForLine = availableSerials(index);
      if (availableSerialsForLine) {
        if (num(line.accepted_qty) !== required) {
          throw new Error(`Line ${index + 1}: Accepted quantity must be a full number (like 5, not 5.5).`);
        }
        const actual = resolvedSerials(index).length;
        if (actual !== required) {
          const rejectedQty = num(line.inspected_qty) - required;
          throw new Error(`Line ${index + 1}: You rejected ${rejectedQty} pieces. Pick those ${rejectedQty} serial numbers from the list.`);
        }
      }

      const availableImeisForLine = availableImeis(index);
      if (availableImeisForLine) {
        if (num(line.accepted_qty) !== required) {
          throw new Error(`Line ${index + 1}: Accepted quantity must be a full number (like 5, not 5.5).`);
        }
        const actual = resolvedImeis(index).length;
        if (actual !== required) {
          const rejectedQty = num(line.inspected_qty) - required;
          throw new Error(`Line ${index + 1}: You rejected ${rejectedQty} pieces. Pick those ${rejectedQty} IMEI numbers from the list.`);
        }
      }
    }
  };

  const save = useMutation({
    mutationFn: () => {
      validateAcceptedUnits();
      const payload = {
        ...form,
        items: form.items.map((line, index) => ({
          ...line,
          serial_numbers: resolvedSerials(index),
          imei_numbers: resolvedImeis(index),
        })),
      };
      return editing ? updateInspection(Number(id), payload) : createInspection(payload);
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
      validateAcceptedUnits();
      const payload = {
        ...form,
        items: form.items.map((line, index) => ({
          ...line,
          serial_numbers: resolvedSerials(index),
          imei_numbers: resolvedImeis(index),
        })),
      };
      await updateInspection(Number(id), payload);
      return completeInspection(Number(id));
    },
    onSuccess: () => {
      void alerts.success("inspection.completed", {
        number: doc?.inspection_no ?? "The inspection",
      });
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
      setConfirming(false);
    },
  });

  /* Cancelling hands the GRN back: the server walks an untouched receipt out of
   * PENDING_QC to DRAFT, which is the only way to correct lines — serials above all —
   * once the receipt has been submitted. */
  const cancel = useMutation({
    mutationFn: () => cancelInspection(Number(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-inspection", id] });
      qc.invalidateQueries({ queryKey: [`wh-inspections-${type}`] });
      qc.invalidateQueries({ queryKey: ["wh-receipts"] });
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
            {/* Saved snapshot first, then what the GRN pull carried in. Only a line
                with neither falls back to the id. */}
            <div className="truncate font-mono text-xs font-semibold text-ink">
              {saved?.item_code ?? l.item_code ?? `Item ${l.item_id}`}
            </div>
            <div className="truncate text-xs text-muted">
              {saved?.item_name ?? l.item_name ?? "—"}
              {l.batch_no ? ` · batch ${l.batch_no}` : ""}
            </div>
            <CombinationTag value={saved ?? l} className="mt-1" />
          </div>
        );
      },
    },
    {
      key: "received",
      header: "Received",
      numeric: true,
      width: "w-24",
      // SCM_0124: what arrived, beside a line that starts un-inspected — so "0
      // inspected" reads as "not checked yet", never as missing goods.
      render: (l, i) => (
        <span className="tabular text-sm text-body">
          {fmtQty(receivedOf(l) ?? 0)}
          <span className="ml-1 text-[11px] text-muted">
            {savedLine(i)?.uom_code ?? deliveryMeta.get(l.receipt_item_id ?? 0)?.uom ?? ""}
          </span>
        </span>
      ),
    },
    {
      key: "inspected",
      header: "Inspected",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
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
      width: "min-w-[9rem] w-36",
      render: (l, i) => {
        const ref = receivedPacks(i);
        const verdict = ref ? packCheckOf(i) : null;
        const lost = verdict ? splitByCheck(verdict.packs, verdict.check).lostQty : 0;
        return (
          <div className="space-y-1">
            <QtyInput
              ariaLabel={`Accepted quantity, line ${i + 1}`}
              value={l.accepted_qty}
              max={num(l.inspected_qty)}
              disabled={locked}
              onChange={(v) => patchLine(i, { accepted_qty: v })}
            />
            {/* Pack by pack (2026-10-27): reject a carton whole, or a few units out of
                one that is kept — the accepted quantity follows. */}
            {verdict && (
              <button type="button" onClick={() => setPacksFor(i)}
                      title={locked ? "View which packs were kept" : "Keep or reject each pack"}
                      className={`flex min-h-9 w-full items-center justify-end gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-colors ${
                        lost > 0 ? "border-bad/30 bg-bad/5 text-bad hover:bg-bad/10"
                          : "border-line text-brand hover:border-brand hover:bg-brand-050"}`}>
                <Boxes className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {checkSummary(verdict.packs, verdict.check, "rejected")}
                  {!l.accepted_pack_breakdown && lost > 0 && " · check packs"}
                </span>
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: "rejected",
      header: "Rejected",
      numeric: true,
      width: "w-28",
      render: (l, i) => (
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
      // Shown, not picked (SCM_0164): it follows the accepted / rejected split, as the
      // save does. A dropdown here let a line read "Passed" over rejected units.
      render: (l) => <QcResultBadge result={resultOf(l)} />,
    },
    {
      key: "defect",
      header: "Rejection reason",
      width: "w-36",
      hideOnNarrow: true,
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
      key: "imeis",
      header: "Accepted IMEIs",
      width: "w-32",
      hideOnNarrow: true,
      render: (_line, index) => {
        if (!isImeiTracked(index)) return <span className="text-muted">—</span>;

        const available = availableImeis(index);
        const accepted = resolvedImeis(index).length;
        return (
          <Button variant="ghost" onClick={() => setParamsForImeis(index)} disabled={locked}>
            <ScanLine className="h-4 w-4" />
            {available ? `${accepted}/${available.length}` : accepted}
          </Button>
        );
      },
    },
    {
      key: "serials",
      header: "Accepted serials",
      width: "w-32",
      hideOnNarrow: true,
      render: (_line, index) => {
        if (!isSerialTracked(index)) return <span className="text-muted">—</span>;

        const available = availableSerials(index);
        // An untouched line has decided nothing, which means nothing rejected — show it
        // as all accepted rather than as zero. `resolvedSerials` additionally repairs
        // pre-seed rows (nothing stored, whole set accepted) back to the offered set.
        const accepted = resolvedSerials(index).length;
        return (
          <Button variant="ghost" onClick={() => setSerialsFor(index)} disabled={locked}>
            <ScanLine className="h-4 w-4" />
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
            {editing && (
              <Button
                variant="ghost"
                onClick={() => window.open(`/warehouse/inspections/${id}/print?type=${type}`, "_blank")}
                title="Download PDF"
              >
                <FileText className="h-4 w-4" /> Download PDF
              </Button>
            )}
            {!locked && (
              <Can do="grn.qc">
                <Button variant="soft" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="grn.qc">
                <Button variant="dangerSoft" onClick={() => setCancelling(true)}>
                  Cancel inspection
                </Button>
              </Can>
            )}
            {editing && !locked && (
              <Can do="grn.qc">
                <Button onClick={() => setConfirming(true)} disabled={form.items.length === 0}>
                  Complete inspection
                </Button>
              </Can>
            )}
          </>
        }
      />
      {/* Copied from its GRN (2026-11-11); nothing on an older one. */}
      {doc && <DocumentScopeStrip doc={{ ...doc, project_name: grn?.project_name ?? null }} number={doc.inspection_no} className="mb-4" />}

      <ErrorBanner error={save.error ?? pullReceipt.error} />

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.inspection_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Type" value={doc.inspection_type} />
          {/* SCM_0165: accepted ÷ inspected QUANTITY, live off the lines on screen. It
              was passed LINES ÷ all lines off the last save, so a new inspection read
              0 % and a line keeping 8 of 10 counted as nothing passed. */}
          <MetaRow
            label="Pass rate"
            value={<span className={`tabular font-semibold ${summary.passRate === null ? "text-muted"
              : summary.rejected > 0 ? "text-warn" : "text-ok"}`}>{qcRate(summary.passRate)}</span>}
          />
          <MetaRow
            label="Rejected quantity"
            value={<span className={`tabular font-semibold ${summary.rejected > 0 ? "text-bad" : "text-muted"}`}>
              {fmtQty(summary.rejected)}{sharedUom ? ` ${sharedUom}` : ""}
            </span>}
          />
        </MetaCard>
      )}

      {/* Where the goods came from, carried straight off the GRN — which carried it off
        * the vendor's own despatch note. Nothing here is typed at QC. */}
      {delivery && (
        <MetaCard title="Delivery">
          <MetaRow label="GRN" value={<span className="font-mono">{delivery.grn_no}</span>} />
          {delivery.po_no && <MetaRow label="Purchase order" value={delivery.po_no} />}
          {delivery.despatch_note_no
            && <MetaRow label="Despatch note" value={delivery.despatch_note_no} />}
          {delivery.vendor_name && <MetaRow label="Vendor" value={delivery.vendor_name} />}
          {delivery.invoice_no && <MetaRow label="Invoice" value={delivery.invoice_no} />}
          {delivery.eway_bill_no && <MetaRow label="E-way bill" value={delivery.eway_bill_no} />}
          {delivery.vehicle_no && <MetaRow label="Vehicle" value={delivery.vehicle_no} />}
          {delivery.transporter_name
            && <MetaRow label="Transporter" value={delivery.transporter_name} />}
          {delivery.lr_no && <MetaRow label="LR / docket" value={delivery.lr_no} />}
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
          <Field
            label="Against GRN"
            hint="Deliveries awaiting QC. Pulls the received lines in."
          >
            <Lookup
              name="receipts"
              /* Narrowed to what an inspection can still be raised against — the same
                 `for_qc` test the list screen's Awaiting QC filter uses. Unnarrowed it
                 offered every receipt ever booked in, so an inspector picked a GRN
                 whose QC finished months ago and typed a second inspection over it.
                 A SAVED inspection's own GRN is no longer in that set, which is what
                 `grnFallback` is for — the field still reads its own number. */
              load={awaitingQcOptions}
              value={form.receipt_id ?? ""}
              fallback={grnFallback}
              isDisabled={locked}
              onChange={(v) => {
                set("receipt_id", v === "" ? null : v);
                if (v !== "") pullReceipt.mutate(v);
              }}
              placeholder="GRN"
            />
          </Field>
          <Field label="Warehouse">
            <Lookup
              name="warehouses"
              load={warehouseOptions}
              value={form.warehouse_id ?? ""}
              fallback={warehouseFallback}
              isDisabled={locked}
              onChange={(v) => set("warehouse_id", v === "" ? null : v)}
              placeholder="Warehouse"
            />
          </Field>
          <Field
            label="Inspector"
            hint={locked ? "Recorded when this check was submitted." : "You — the signed-in user."}
          >
            <Input value={(locked ? doc?.inspector_name : me?.employee?.name) ?? "—"} disabled />
          </Field>
        </div>
      </Section>

      {/* SCM_0164 / 0165 / 0166: how the inspection is going, by quantity, live as the
          numbers are typed — before the lines, because it is the first thing asked. */}
      {form.items.length > 0 && (
        <div className="mb-4">
          <QcVerdictPanel summary={summary} uom={sharedUom}
                          title={locked ? "Inspection result" : "Inspection so far"} />
        </div>
      )}

      <Section
        title="Lines"
        hint="Lines start un-inspected. Enter what you checked, then what you accept or reject — the result follows."
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
          minTableWidth="min-w-[1280px]"
          keyOf={(_, i) => i}
          onRemove={locked ? undefined : (i) => set("items", form.items.filter((_, x) => x !== i))}
          rowTone={(l) => {
            const result = resultOf(l);
            return result === "FAILED" ? "bg-bad-bg/40" : result === "PARTIAL" ? "bg-warn-bg/40" : undefined;
          }}
          empty="Pick a GRN above to pull its lines in."
          // SCM_0166: every line in exactly one bucket — Partial included, which the
          // old Passed / Failed pair left out — beside the quantities they came from.
          footer={<QcVerdictStrip summary={summary} uom={sharedUom} />}
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
        <AttachmentsPanel entityType="INSPECTION" entityId={doc?.id} category="QC" readOnly={locked} />
      </Section>

      {/* The delivery this inspection was raised off, and what it arrived on. Read off
          `receipt_id`, which `_raise_inspection_for` stamped on submit — nothing here
          is written for this panel. */}
      {doc && <InspectionLinkedDocuments inspection={doc} receipt={delivery} />}

      <SerialNumbersModal
        noun="IMEI"
        isOpen={paramsForImeis !== null}
        onClose={() => setParamsForImeis(null)}
        quantity={paramsForImeis === null ? 0 : num(form.items[paramsForImeis]?.accepted_qty)}
        initial={paramsForImeis === null ? null : resolvedImeis(paramsForImeis)}
        available={availableImeis(paramsForImeis)}
        itemLabel={
          paramsForImeis === null
            ? ""
            : savedLine(paramsForImeis)?.item_name ?? `Line ${paramsForImeis + 1}`
        }
        readOnly={locked}
        onSave={(accepted) => {
          if (paramsForImeis !== null) {
            patchLine(paramsForImeis, {
              imei_numbers: accepted,
              ...(availableImeis(paramsForImeis) ? { accepted_qty: accepted.length } : {}),
            });
          }
        }}
      />

      {packsFor !== null && form.items[packsFor] && (() => {
        const index = packsFor;
        const line = form.items[index];
        const { packs, check } = packCheckOf(index);
        const tracked = isSerialTracked(index) || isImeiTracked(index);
        const saved = savedLine(index);
        return (
          <PackageCheckModal
            open
            mode="qc"
            readOnly={locked}
            packName={packs.find((p) => p.level > 0)?.entry.name ?? "pack"}
            uom={saved?.uom_code ?? deliveryMeta.get(line.receipt_item_id ?? 0)?.uom}
            itemLabel={[saved?.item_code ?? line.item_code, saved?.item_name ?? line.item_name,
                        line.batch_no ? `batch ${line.batch_no}` : null].filter(Boolean).join(" · ")
              + (tracked ? " — then pick the accepted serials / IMEIs to match" : "")}
            packages={packs}
            value={check}
            onClose={() => setPacksFor(null)}
            onSave={(next) => {
              const { kept, lost, keptQty } = splitByCheck(packs, next);
              patchLine(index, {
                accepted_qty: keptQty,
                accepted_pack_breakdown: kept,
                rejected_pack_breakdown: lost.length ? lost : null,
              });
            }}
          />
        );
      })()}
      <SerialNumbersModal
        isOpen={serialsFor !== null}
        onClose={() => setSerialsFor(null)}
        quantity={serialsFor === null ? 0 : num(form.items[serialsFor]?.accepted_qty)}
        initial={serialsFor === null ? null : resolvedSerials(serialsFor)}
        available={availableSerials(serialsFor)}
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
          <div className="space-y-3">
            <p className="font-semibold text-ink">{qcSentence(summary, sharedUom ?? "units")}</p>
            <QcVerdictStrip summary={summary} uom={sharedUom} />
            <p>
              The result is written back onto the GRN lines and the inspection can no
              longer be edited.
            </p>
            {summary.rejected > 0 && (
              <Chip size="sm" variant="flat" color="danger">
                {fmtQty(summary.rejected)}{sharedUom ? ` ${sharedUom}` : ""} rejected will not go into stock
              </Chip>
            )}
          </div>
        }
        confirmLabel="Complete"
        danger={summary.failed > 0}
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
            The inspection is closed and its GRN goes back to draft, so the lines can be
            corrected and submitted again. A GRN with stock already released stays where
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
