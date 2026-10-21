import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { usePackOptions } from "@/shared/packing";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionItem } from "@heroui/react";
import { ArrowLeft, Info, Lock, MapPin, FileText, ChevronRight, ChevronDown } from "lucide-react";
import { LiveStockPanel } from "../components/LiveStockPanel";
import { SplitFamilyCard } from "../components/SplitFamilyCard";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { Lookup } from "../components/Lookup";
import { ItemPicker } from "../components/ItemPicker";
import { IssueSplitEditor } from "../components/IssueSplitEditor";
import { TrackingBadge, useTrackingMeta } from "../components/TrackingBadge";
import {
  groupIssueLines, normalizeSplits, round, sourceKey, splitProblems, trackingOf,
} from "../issueSplits";
import { unitSupplyKey } from "../components/IssueSplitEditor";
import type { IssueGroup, IssueSplit } from "../issueSplits";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, approvalsToTimeline, type TimelineEntry } from "../components/Timeline";
import { CodeAssignmentScreen } from "./CodeAssignmentScreen";
import { SearchPicker, type PickerRow } from "../components/SearchPicker";
import {
  acknowledgeIssue, approveIssue, auditUnlocatedStock, cancelIssue, createIssue, departmentOptions,
  employeeOptions, getEmployeeDestination, repairUnlocatedStock, searchIssueDestinations, searchIssueEmployees, getIndentIssueSource, getIssue, getPickingIssueSource, indentOptions,
  issueApprovalHistory,  postIssue, projectOptions,
  occupancyPreview,
  itemHandlingUnits,
  returnableIssueOptions, rejectIssue, setIssueSerials, splitIssue, submitIssue, updateIssue,
  warehouseOptions,
  issueStockSources, listSerials,
  issueUnitSupply,
} from "../api";
import type { IssueSplitResult } from "../api";
import { fmtCount, volume } from "../components/CapacityMeter";
import { fmtDateTime, fmtMoney, fmtQty, num, today } from "../format";
import { alerts } from "@/modules/alerts";
import type {
  HandlingUnit,
  Issue, IssueItemWrite, IssueStockSource, IssueWrite, ItemOption, OccupancyMove,
  TrackingType, UnitMode, UnitSupply,
  IssueDestinationOption, IssueEmployeeOption,
} from "../types";
import { usePointLabel } from "../usePointLabel";
import { TONE_APPROVE, TONE_BLUE, TONE_REJECT, TONE_SUBMIT } from "@/shared/components/tones";

/**
 * Raise, approve and post a material issue.
 *
 * Two quantities matter and they are not the same: `requested_qty` is what was
 * asked for, `issued_qty` is what actually left the shelf. Keeping both means a
 * short issue is visible as a short issue rather than being quietly rewritten to
 * whatever was available.
 *
 * Posting is the only step that touches stock, and it is deliberately separate from
 * approval: an approved issue is a promise, a posted one is a movement. The
 * approval itself goes through the shared workflow engine — this screen only shows
 * where the document is and asks the backend to move it.
 */

/** What the issue IS, not what it was for. The five it replaces named the REASON,
 *  which the department, project and vehicle fields below already carry - see the
 *  note on `IssueType` in the backend enums. Kept as a field rather than derived
 *  outright so a storekeeper can still say so on a document, but it follows the
 *  indent box whenever that is touched: the two disagreeing is not a state anybody
 *  means to be in. */
const TYPES = [
  { value: "INDENT_BASED", label: "Indent based" },
  { value: "DIRECT", label: "Direct" },
];

const emptyLine = (): IssueItemWrite => ({
  item_id: 0,
  bin_id: null,
  batch_id: null,
  requested_qty: 0,
  issued_qty: 0,
  rate: null,
  remarks: null,
  serial_numbers: [],
});

function BreakdownGroup({
  group,
  picks,
  freed,
  itemPackagings,
  sourcesByItem,
  savedLine,
  trackingMeta,
}: {
  group: IssueGroup;
  picks: IssueSplit[];
  freed: any[];
  itemPackagings: Record<number, any>;
  sourcesByItem: Record<number, any[]>;
  savedLine: (index: number) => any;
  trackingMeta: (type: any) => any;
}) {
  const [expanded, setExpanded] = useState(false);
  const pack = itemPackagings[group.itemId];
  const unitVol = num(pack?.volume_cbm || 0);
  const qty = picks.reduce((sum, split) => sum + split.issued, 0);
  const multiple = picks.length > 1;

  return (
    <tbody className="divide-y divide-line/70 border-t border-line/70">
      <tr
        className={`transition-colors hover:bg-content2/50 ${multiple ? "cursor-pointer" : ""}`}
        onClick={() => multiple && setExpanded(!expanded)}
      >
        <td className="px-4 py-3 align-top">
          <div className="flex flex-wrap items-center gap-2">
            {multiple && (
              expanded ? <ChevronDown className="h-4 w-4 text-muted shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted shrink-0" />
            )}
            <span className="font-mono text-xs font-semibold text-ink">
              {group.itemCode}
            </span>
            <TrackingBadge
              type={group.trackingType}
              meta={trackingMeta(group.trackingType)}
              size="sm"
            />
          </div>
          <div
            className={`max-w-[220px] truncate text-xs text-muted ${multiple ? "ml-6" : ""}`}
            title={group.itemName || ""}
          >
            {group.itemName}
          </div>
        </td>
        <td className="px-4 py-3 align-top font-mono text-xs text-body">
          {multiple ? (
            "—"
          ) : (
            (() => {
              const split = picks[0];
              const source = (sourcesByItem[group.itemId] ?? []).find(
                (row) => sourceKey(row.batch_id, row.bin_id)
                  === sourceKey(split.line.batch_id, split.line.bin_id),
              );
              return source?.batch_no ?? savedLine(split.index)?.batch_no ?? "—";
            })()
          )}
        </td>
        <td className="px-4 py-3 align-top font-mono text-xs font-semibold text-body">
          {multiple ? (
            <span className="text-muted font-sans font-normal">{picks.length} locations</span>
          ) : (
            (() => {
              const split = picks[0];
              const location = freed.find((f) => f.location_id === split.line.bin_id);
              const binCode = location
                ? location.location_code
                : savedLine(split.index)?.bin_code ?? `Bin ${split.line.bin_id}`;
              return (
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                  {binCode}
                </span>
              );
            })()
          )}
        </td>
        <td className="px-4 py-3 text-right align-top tabular font-medium text-body">
          {fmtQty(qty)}
        </td>
        <td className="px-4 py-3 text-right align-top tabular text-muted">
          {unitVol > 0 ? volume(unitVol) : (
            <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn">
              Unmeasured
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right align-top tabular font-bold text-ok">
          {unitVol > 0 ? volume(qty * unitVol) : "—"}
        </td>
      </tr>

      {expanded && multiple && picks.map((split, position) => {
        const location = freed.find((f) => f.location_id === split.line.bin_id);
        const binCode = location
          ? location.location_code
          : savedLine(split.index)?.bin_code ?? `Bin ${split.line.bin_id}`;
        const source = (sourcesByItem[group.itemId] ?? []).find(
          (row) => sourceKey(row.batch_id, row.bin_id)
            === sourceKey(split.line.batch_id, split.line.bin_id),
        );
        return (
          <tr key={split.index} className="transition-colors hover:bg-content2/50 bg-content2/20">
            <td className="px-4 py-3 align-top pl-10 text-xs text-muted">
              split {position + 1} of {picks.length}
            </td>
            <td className="px-4 py-3 align-top font-mono text-xs text-body">
              {source?.batch_no ?? savedLine(split.index)?.batch_no ?? "—"}
            </td>
            <td className="px-4 py-3 align-top font-mono text-xs font-semibold text-body">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                {binCode}
              </span>
            </td>
            <td className="px-4 py-3 text-right align-top tabular font-medium text-body">
              {fmtQty(split.issued)}
            </td>
            <td className="px-4 py-3 text-right align-top tabular text-muted">
              {unitVol > 0 ? volume(unitVol) : "—"}
            </td>
            <td className="px-4 py-3 text-right align-top tabular font-bold text-ok">
              {unitVol > 0 ? volume(split.issued * unitVol) : "—"}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

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

/** `basePath` re-homes the screen: Inventory > Stock Transfer mounts this same form at
 *  `/inventory/transfers/issues` so an STO's issue is worked without leaving it. */
export default function MaterialIssueForm({ direction = "OUT", basePath }: {
  direction?: "OUT" | "IN"; basePath?: string;
}) {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const pickingSourceId = Number(searchParams.get("picking_id") || 0);
  /* Absolute, not `".."`. This screen is mounted at two depths (under
   * /warehouse/... and under /warehouse/transactions/...), and a relative Back
   * resolves against the matched route, so it landed on the dashboard from one
   * of them and on the list from the other. */
  const listPath = basePath
    ?? (direction === "OUT" ? "/warehouse/material-issues" : "/warehouse/material-returns");

  const [form, setForm] = useState<IssueWrite>({
    issue_type: "DIRECT",
    issue_date: today(),
    indent_id: null,
    picking_id: null,
    warehouse_id: 0,
    department_id: null,
    project_id: null,
    vehicle_id: null,
    vehicle_number: null,
    issued_to_id: null,
    direction,
    original_issue_id: null,
    remarks: "",
    items: [],
  });
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState<
    "submit" | "approve" | "reject" | "post" | "split" | "ack" | "cancel" | null
  >(null);
  const [reason, setReason] = useState("");
  const [serialLine, setSerialLine] = useState<number | null>(null);
  const [destination, setDestination] = useState("");
  // The destination office's service area code. Held beside the destination name and
  // filled from the same answer, because it belongs to the office the goods are going
  // to — never to whoever happens to be raising the issue.
  const [destinationSac, setDestinationSac] = useState<string | null>(null);
  // The employee dropdown loads one page of names, so the indent raiser this form
  // defaults to is usually not in it. Hold the name that came with the id, or the
  // field shows its placeholder over a person who IS selected.
  const [issuedToName, setIssuedToName] = useState<string | null>(null);
  // A direct issue's chosen destination point and issued-to person, held whole so each
  // picker can fill and narrow the others (see `choosePoint` / `chooseEmployee`).
  const [destPoint, setDestPoint] = useState<IssueDestinationOption | null>(null);
  const [issuedTo, setIssuedTo] = useState<IssueEmployeeOption | null>(null);
  // The employee list follows the destination's office unless the store asks for all.
  const [everyone, setEveryone] = useState(false);
  const [departmentName, setDepartmentName] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  // Some of the reserved stock was received for another project, or for none.
  // Worth saying out loud — the issue still goes through.
  const [mixedProjects, setMixedProjects] = useState(false);
  const [isBinManaged, setIsBinManaged] = useState(true);
  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-issue", id],
    queryFn: () => getIssue(Number(id)),
    enabled: editing,
  });

  // The rungs already passed. Only the engine has them — see issueApprovalHistory.
  const { data: approvals } = useQuery({
    queryKey: ["wh-issue-approvals", id],
    queryFn: () => issueApprovalHistory(Number(id)),
    enabled: editing,
  });

  const pickingSource = useQuery({
    queryKey: ["wh-picking-issue-source", pickingSourceId],
    queryFn: () => getPickingIssueSource(pickingSourceId),
    enabled: !editing && direction === "OUT" && pickingSourceId > 0,
  });

  useEffect(() => {
    if (!doc) return;
    setDestination(doc.destination_office_name ?? "");
    setDestinationSac(doc.destination_office_sac ?? null);
    setIssuedToName(doc.issued_to_name ?? null);
    setIssuedTo(doc.issued_to_id
      ? { id: doc.issued_to_id, name: doc.issued_to_name ?? String(doc.issued_to_id) }
      : null);
    setDestPoint(doc.destination_warehouse_id
      ? {
          warehouse_id: doc.destination_warehouse_id,
          name: doc.destination_warehouse_name ?? doc.destination_office_name ?? "",
          warehouse_type: doc.destination_warehouse_type ?? null,
          office_id: doc.destination_office_id ?? null,
          office_name: doc.destination_office_name ?? null,
          sac: doc.destination_office_sac ?? null,
          vehicle_number: null,
        }
      : null);
    setDepartmentName(doc.department_name ?? null);
    setProjectName(doc.project_name ?? null);
    if (doc.warehouse_id) {
      warehouseOptions().then((opts) => {
        const w = opts.find(o => o.id === doc.warehouse_id);
        if (w) setIsBinManaged((w as any).is_bin_managed ?? true);
      });
    }
    setForm({
      issue_type: doc.issue_type,
      issue_date: doc.issue_date,
      indent_id: doc.indent_id ?? null,
      picking_id: doc.picking_id ?? null,
      warehouse_id: doc.warehouse_id,
      department_id: doc.department_id ?? null,
      project_id: doc.project_id ?? null,
      vehicle_id: doc.vehicle_id ?? null,
      vehicle_number: doc.vehicle_number ?? null,
      issued_to_id: doc.issued_to_id ?? null,
      destination_warehouse_id: doc.destination_warehouse_id ?? null,
      direction: doc.direction,
      original_issue_id: doc.original_issue_id ?? null,
      remarks: doc.remarks ?? "",
      items: (doc.items ?? []).map((l) => ({
        id: l.id,
        indent_item_id: l.indent_item_id,
        item_id: l.item_id,
        item_code: l.item_code,
        item_name: l.item_name,
        is_serial_tracked: l.is_serial_tracked,
        is_imei_tracked: l.is_imei_tracked,
        unit_mode: l.unit_mode,
        // What the badge says, and what the parity message calls one unit. Served
        // per line, so it has to be carried onto the editable copy — without it the
        // screen falls back to guessing from the item flags, and every asset-coded
        // item read as a consumable lot.
        tracking_type: l.tracking_type,
        has_units: l.has_units,
        units_available: l.units_available,
        bin_id: l.bin_id,
        // The snapshot labels the document already carries. Without them a saved pick
        // renders as an empty location until `issueStockSources` answers, which on a
        // fifty-line issue is a visible second of a document that looks unfinished.
        bin_code: l.bin_code,
        batch_id: l.batch_id,
        batch_no: l.batch_no,
        requested_qty: num(l.requested_qty),
        issued_qty: num(l.issued_qty),
        rate: l.rate,
        remarks: l.remarks,
        pack_hierarchy_id: l.pack_hierarchy_id ?? null,
        pack_breakdown: l.pack_breakdown ?? null,
        break_bulk: !!l.break_bulk,
        // Stated in the currency the item is validated on — the serial for a
        // serialized item, the IMEI for a handset, the asset/consumable code
        // otherwise. The backend resolves any of the three back to the same unit.
        serial_numbers: parseCodes(l.unit_keys ?? l.serial_numbers) ?? [],
      })),
    });
  }, [doc]);

  useEffect(() => {
    if (!pickingSource.data) return;
    const source = pickingSource.data;
    setMixedProjects(!!source.mixed_projects);
    if (source.issued_to_id) setIssuedToName(source.issued_to_name ?? null);
    if (source.department_id) setDepartmentName((source as any).department_name ?? null);
    if (source.project_id) setProjectName((source as any).project_name ?? null);
    setForm((current) => ({
      ...current,
      picking_id: source.picking_id,
      warehouse_id: source.warehouse_id,
      indent_id: source.indent_id ?? null,
      department_id: source.department_id ?? null,
      project_id: source.project_id ?? null,
      issued_to_id: source.issued_to_id ?? current.issued_to_id,
      vehicle_id: source.vehicle_id ?? current.vehicle_id,
      vehicle_number: source.vehicle_number ?? current.vehicle_number,
      items: source.items,
    }));
  }, [pickingSource.data]);

  const savedLine = (i: number) => doc?.items?.[i];
  const activeSerialLine = serialLine === null ? null : form.items[serialLine];
  // 0 is the "no bin" / "no batch" sentinel the warehouse writes, not a real id, and
  // an issue drafted from an allocation carries it on every line. Narrowing the
  // serial list by it would match nothing.
  const sourceId = (value: number | null | undefined) => (value ? value : undefined);
  // The codes themselves are NOT fetched here any more. `CodeAssignmentScreen` owns
  // that query, because it is the only thing that draws them and it has to page: one
  // bay can hold hundreds of thousands of coded units, and pulling the pool into this
  // form meant every keystroke on the header re-rendered a list nothing was showing.
  const unitMode = (line?: IssueItemWrite): UnitMode =>
    line?.unit_mode
      ?? (line?.is_serial_tracked ? "SERIAL" : line?.is_imei_tracked ? "IMEI" : "CODE");
  const activeUnitMode = unitMode(activeSerialLine ?? undefined);
  const unitNoun = (mode: UnitMode) =>
    mode === "SERIAL" ? "serial" : mode === "IMEI" ? "IMEI" : "code";
  const activeTracking: TrackingType = activeSerialLine
    ? trackingOf(activeSerialLine)
    : "NONE";
  const set = <K extends keyof IssueWrite>(key: K, value: IssueWrite[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const patchLine = (index: number, patch: Partial<IssueItemWrite>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));

  const setLines = (items: IssueItemWrite[]) => setForm((f) => ({ ...f, items }));

  /**
   * A pick has just been given its batch and location: fill its asset / consumable
   * codes there and then, oldest first, up to the quantity it issues (2026-10-12).
   *
   * Those codes are the system's own labels — nobody reads them off a maker's box — so
   * the storekeeper should see them the moment the source is decided, not after a
   * save. The server still checks every one on save (`_reserve_issue_serials`) and tops
   * up anything missing (`_autofill_codes`); this only makes the choice visible early.
   * They stay swappable in the code screen. Serial / IMEI picks are read off the goods
   * and are never pre-filled.
   */
  const fillCodesFor = async (index: number, line: IssueItemWrite) => {
    const type = line.tracking_type;
    if (type !== "ASSET" && type !== "CONSUMABLE") return;
    const need = Math.trunc(num(line.issued_qty));
    if (!need || !line.item_id || !form.warehouse_id) return;
    try {
      const page = await listSerials({
        item_id: line.item_id,
        warehouse_id: form.warehouse_id,
        batch_id: line.batch_id || undefined,
        bin_id: line.bin_id || undefined,
        unbatched: !line.batch_id || undefined,
        issue_id: editing ? Number(id) : undefined,
        issue_line_id: line.id || undefined,
        claim_free: !line.id || undefined,
        status: "available",
        page: 1,
        size: Math.min(need, 500),
      });
      const codes = (page.items ?? [])
        .map((row) => row.asset_code ?? row.consumable_code ?? row.serial_number)
        .filter((code): code is string => !!code)
        .slice(0, need);
      setForm((f) => ({
        ...f,
        items: f.items.map((l, i) => (
          i === index && l.batch_id === line.batch_id && l.bin_id === line.bin_id
            ? { ...l, serial_numbers: codes } : l)),
      }));
    } catch {
      // Not fatal: the save fills them (`_autofill_codes`) and says so if it cannot.
    }
  };

  /* ----------------------------------------------- where the stock actually is --
   *
   * A line names ONE batch and ONE bin; the shelf regularly holds the quantity in
   * two. Read once for every item on the document, so a group can be SPLIT over the
   * locations that can serve it instead of being written against one that cannot —
   * and so each split can say what its own location holds, beside the quantity being
   * taken out of it.
   *
   * Off `stk_balance`, not the unit table: see `issue_stock_sources`.
   */
  const itemIds = useMemo(
    () => Array.from(new Set(form.items.map((l) => l.item_id).filter(Boolean))),
    [form.items],
  );
  const {
    data: sources = [], isSuccess: sourcesReady, dataUpdatedAt: sourcesAt,
    isFetching: sourcesFetching, refetch: refetchSources,
  } = useQuery({
    queryKey: ["wh-issue-sources", form.warehouse_id, form.indent_id ?? 0,
      form.project_id ?? 0, (editing ? Number(id) : (doc?.id ?? 0)), itemIds],
    queryFn: () => issueStockSources(form.warehouse_id, itemIds, form.indent_id,
      form.project_id, editing ? Number(id) : (doc?.id ?? null)),
    // Only while the picks are still open. Once the stock is posted the balances
    // have already moved, and drawing "available" against a document that has gone
    // out would report every split as over-issued.
    enabled: !!form.warehouse_id && itemIds.length > 0 && !doc?.is_stock_posted,
    // LIVE: other storekeepers are drawing on the same shelf. Re-read every 15 s and
    // whenever the window comes back into focus, keeping the last answer on screen
    // while the next one loads so nothing flickers.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  const sourcesByItem = useMemo(() => {
    const map: Record<number, IssueStockSource[]> = {};
    for (const row of sources) (map[row.item_id] ??= []).push(row);
    return map;
  }, [sources]);

  /* ------------------------------------------- how many units each pick can name --
   *
   * A SECOND question about the same pick, with a different answer off a different
   * table: `stock-sources` says how much quantity is at a (batch, location), this
   * says how many physical units there carry an identifier the line could put on the
   * document. Stock put away before the item was coded has the first and not the
   * second.
   *
   * The saved line carries an answer already (`units_available`), but it is the
   * answer for the bay the line named when it was last SAVED — so the moment a
   * storekeeper repoints a pick, the number beside it belongs to somewhere he is no
   * longer standing. Probed live, for the whole grid in one call, and debounced with
   * the same 400 ms the occupancy preview uses: typing "1", "1 5" in an Issue qty box
   * must not fire a probe a digit.
   */
  const supplyPicks = useMemo(
    () => form.items
      .filter((line) => line.item_id && num(line.issued_qty) > 0)
      .map((line) => ({
        item_id: line.item_id,
        batch_id: line.batch_id ?? null,
        bin_id: isBinManaged ? line.bin_id ?? null : null,
        need: Math.trunc(num(line.issued_qty)),
        line_id: line.id ?? null,
      })),
    [form.items, isBinManaged],
  );
  const [settledPicks, setSettledPicks] = useState(supplyPicks);
  useEffect(() => {
    const timer = setTimeout(() => setSettledPicks(supplyPicks), 400);
    return () => clearTimeout(timer);
  }, [supplyPicks]);

  const { data: supplyRows = [] } = useQuery({
    queryKey: ["wh-issue-unit-supply", form.warehouse_id, id ?? 0, settledPicks],
    queryFn: () => issueUnitSupply(
      form.warehouse_id,
      // Deduplicated per (item, batch, location), keeping the largest need: the probe
      // answers per combination, so two picks on one bay would otherwise ask twice and
      // the second answer — bounded to a smaller need — would overwrite the first.
      Object.values(settledPicks.reduce((all, pick) => {
        const key = unitSupplyKey(pick.item_id, pick.batch_id, pick.bin_id);
        if (!all[key] || all[key].need < pick.need) all[key] = pick;
        return all;
      }, {} as Record<string, (typeof settledPicks)[number]>)),
      editing ? Number(id) : null,
      direction,
    ),
    enabled: !!form.warehouse_id && settledPicks.length > 0 && !doc?.is_stock_posted,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const unitSupply = useMemo(() => {
    const map: Record<string, UnitSupply> = {};
    for (const row of supplyRows) {
      map[unitSupplyKey(row.item_id, row.batch_id, row.bin_id)] = row;
    }
    return map;
  }, [supplyRows]);

  const trackingMeta = useTrackingMeta();
  /** One group's identifier, named in the plural the server chose. */
  const unitLabel = useCallback(
    (type: TrackingType, count: number) => {
      const unit = trackingMeta(type)?.unit ?? "unit";
      return count === 1 ? unit : `${unit}s`;
    },
    [trackingMeta],
  );

  const groups = useMemo(
    () => groupIssueLines(form.items, sourcesByItem),
    [form.items, sourcesByItem],
  );

  /**
   * Everything wrong with the allocation, and where.
   *
   * Errors block Save and Submit; warnings are documents that save but cannot be
   * posted — an unassigned identifier is the commonest, and it has to be said BEFORE
   * approval, because approval freezes the batch and bin the units would come from.
   */
  const problems = useMemo(
    () => splitProblems(groups, {
      binManaged: isBinManaged,
      unitLabel,
      requireUnits: doc?.status === "APPROVED" && !doc?.is_stock_posted,
      // The LIVE count, not the one saved on the line: that one describes the bay the
      // pick named when it was last saved, so a storekeeper who has just repointed it
      // would be warned about stock he is no longer taking. Falls back to the saved
      // answer while the probe is in flight.
      unitsAt: (split) => {
        const supply = unitSupply[unitSupplyKey(
          split.line.item_id, split.line.batch_id,
          isBinManaged ? split.line.bin_id : null,
        )];
        return supply ? supply.available : split.unitsAvailable;
      },
    }),
    [groups, isBinManaged, unitLabel, unitSupply, doc?.status, doc?.is_stock_posted],
  );
  const blocking = problems.filter((p) => p.level === "error");
  const problemAt = useMemo(() => {
    const map = new Map<number, { level: "error" | "warn"; message: string }>();
    for (const problem of problems) {
      if (problem.index === undefined) continue;
      // An error outranks a warning on the same row: fix what blocks first.
      const held = map.get(problem.index);
      if (!held || (held.level === "warn" && problem.level === "error")) {
        map.set(problem.index, { level: problem.level, message: problem.message });
      }
    }
    return map;
  }, [problems]);

  /** Which split the picker is open on, and what that exact location holds. */
  const activeScope = (() => {
    if (serialLine === null || !activeSerialLine) return undefined;
    const group = groups.find((g) => g.splits.some((s) => s.index === serialLine));
    const split = group?.splits.find((s) => s.index === serialLine);
    const source = (sourcesByItem[activeSerialLine.item_id] ?? []).find(
      (row) => sourceKey(row.batch_id, row.bin_id)
        === sourceKey(activeSerialLine.batch_id, activeSerialLine.bin_id),
    );
    return {
      batchNo: source?.batch_no ?? savedLine(serialLine)?.batch_no ?? null,
      binCode: source?.bin_code ?? savedLine(serialLine)?.bin_code ?? null,
      binPath: split?.binPath ?? source?.bin_path ?? null,
      available: split?.available ?? null,
      splitLabel:
        group && group.splits.length > 1
          ? `Pick ${group.splits.findIndex((s) => s.index === serialLine) + 1} of ${group.splits.length}`
          : null,
    };
  })();


  const totals = useMemo(
    () => ({
      lines: form.items.length,
      requested: form.items.reduce((s, l) => s + num(l.requested_qty), 0),
      issued: form.items.reduce((s, l) => s + num(l.issued_qty), 0),
      value: form.items.reduce((s, l) => s + num(l.issued_qty) * num(l.rate), 0),
    }),
    [form.items],
  );

  const short = totals.requested - totals.issued;
  const locked = !!doc && doc.status !== "DRAFT";

  /**
   * The space this issue gives back, per location it draws from.
   *
   * Only lines that name a bin, an item and a quantity count — a line whose bin has
   * not been chosen yet is not yet a claim on anybody's shelf. The moves are sent as
   * one request and netted per location on the server, because two lines out of the
   * same bin free their sum and adding volumes up in a screen is how that goes subtly
   * wrong.
   */
  const outwardMoves = useMemo<OccupancyMove[]>(
    () => form.items
      .filter((l) => l.bin_id && l.item_id && num(l.issued_qty) > 0)
      .map((l) => ({
        location_id: Number(l.bin_id),
        item_id: Number(l.item_id),
        qty: num(l.issued_qty),
        direction: "OUT" as const,
      })),
    [form.items],
  );


  // Typing "1", "1 3", "1 3 0" in an Issued box rewrites every move, and each
  // rewrite refired both the occupancy preview and the pack lookup — three round
  // trips per digit, on the field a storekeeper touches most. The shelf's answer is
  // only worth asking for once he has stopped typing.
  const [settledMoves, setSettledMoves] = useState<OccupancyMove[]>(outwardMoves);
  useEffect(() => {
    const timer = setTimeout(() => setSettledMoves(outwardMoves), 400);
    return () => clearTimeout(timer);
  }, [outwardMoves]);

  const uniqueItemIds = useMemo(() => {
    return Array.from(new Set(settledMoves.map(m => m.item_id)));
  }, [settledMoves]);

  const { data: itemPackagings = {} } = useQuery({
    queryKey: ["wh-issue-item-packs", uniqueItemIds],
    queryFn: async () => {
      const packs: Record<number, HandlingUnit> = {};
      await Promise.all(uniqueItemIds.map(async (id) => {
        try {
          const units = await itemHandlingUnits(id);
          const base = units.find((u: HandlingUnit) => num(u.base_qty) === 1) || units.find((u: HandlingUnit) => u.is_default) || units[0];
          if (base) packs[id] = base;
        } catch (e) {
          // ignore
        }
      }));
      return packs;
    },
    enabled: uniqueItemIds.length > 0,
  });

  const { data: freed = [] } = useQuery({
    queryKey: ["wh-issue-occupancy", settledMoves],
    queryFn: () => occupancyPreview(settledMoves),
    // Bin-managed warehouses only (bulk stock has no location to free), and only
    // while the stock is still on the shelf. Occupancy is READ from stock, so once the
    // issue is posted the location already reports the lower figure — subtracting the
    // same lines again would show a shelf emptier than it is.
    enabled: isBinManaged && settledMoves.length > 0 && !doc?.is_stock_posted,
    placeholderData: (previous) => previous,
  });

  /** What the whole document takes off the shelves, for the lines footer. */
  // Both, because they answer different questions: the cube is what the shelf gets
  // back, and the pack count is what a storekeeper actually carries off it.
  const freedUnits = useMemo(
    () => freed.reduce((sum, row) => sum + Number(row.move_units ?? 0), 0),
    [freed],
  );
  const freedVolume = useMemo(
    () => freed.reduce((sum, row) => sum + Number(row.move_volume ?? 0), 0),
    [freed],
  );
  const freedUnmeasured = useMemo(
    () => freed.reduce((sum, row) => sum + row.unmeasured_lines, 0),
    [freed],
  );
  // Serials are the one thing still open after approval: the approver signed off on
  // quantities, but which physical units go out is decided at the shelf, and
  // "Issue from stock" refuses an incomplete set. Saved straight away through the
  // serials endpoint, because the document itself is no longer editable.
  // Only once APPROVED, and only for the person it is with (or their reporting line, or an approver):
  // picking units on a draft or during approval is what got lost on the way through.
  const awaitingIssue = doc?.status === "APPROVED" && !doc?.is_stock_posted;
  const unitsHidden = direction === "OUT"
    && (!doc || doc.status === "DRAFT" || doc.status === "PENDING_APPROVAL");
  const serialsLocked = unitsHidden || (locked && !(awaitingIssue && doc?.can_issue_from_stock));
  // Asset/consumable codes are auto-assigned and swappable: on a draft, and once
  // approved by the issuer OR anyone who approved it (`can_swap_codes`).
  const codesLocked = locked && (unitsHidden || !(awaitingIssue && doc?.can_swap_codes));
  // Pack hierarchies of every item on the issue, in one call (2026-10-08).
  const packOptions = usePackOptions(form.items.map((line) => line.item_id));
  const payload = (): IssueWrite => ({
    ...form,
    // `normalizeSplits` first: the splits of one ask share its requested quantity
    // between them, and the server refuses a line requesting nothing or issuing more
    // than it asked for. Done once here rather than on every keystroke, so the number
    // in the Issue qty box stays the storekeeper's until he saves. See issueSplits.ts.
    items: normalizeSplits(form.items).map(
      ({ item_code, item_name, is_serial_tracked, is_imei_tracked, unit_mode, unit_keys,
         tracking_type, has_units, units_available, bin_code, bin_path, batch_no,
         ...line }) => line,
    ),
  });

  // What each line's own batch and bin can actually give it, straight from the
  // backend. A serial-tracked line short of units is a document that cannot be
  // posted, and once it is approved the batch is frozen — so it is said here, on the
  // draft, where the batch can still be changed.
  const unitShort = (doc?.items ?? [])
    .map((l) => ({
      // Named by its SOURCE, not by its position. With one ask spread over several
      // picks, "line 3" no longer identifies anything a storekeeper can point at;
      // the batch and the bin do.
      key: l.id,
      code: l.item_code,
      batch: l.batch_no,
      bin: l.bin_code,
      need: Math.trunc(num(l.issued_qty)),
      have: l.units_available ?? null,
      strict: !!l.has_units,
    }))
    .filter((r) => r.strict && r.need > 0 && r.have !== null && r.have < r.need);

  const save = useMutation({
    mutationFn: () => (editing ? updateIssue(Number(id), payload()) : createIssue(payload())),
    onSuccess: (saved: Issue) => {
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      qc.invalidateQueries({ queryKey: ["wh-issue", String(saved.id)] });
      // Saving moves holds (a direct issue's own, a relocated allocation's), so the
      // shelf this screen is showing has just changed.
      qc.invalidateQueries({ queryKey: ["wh-issue-sources"] });
      if (!editing) nav(`${listPath}/${saved.id}`, { replace: true });
    },
  });

  const saveSerials = useMutation({
    mutationFn: (line: { id: number; serial_numbers: string[] }) =>
      setIssueSerials(Number(id), [line]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
    },
  });

  const pullIndent = useMutation({
    mutationFn: (indentId: number) => getIndentIssueSource(indentId, form.warehouse_id),
    onSuccess: (source) => {
      setDestination(source.destination_office_name ?? "");
      setDestinationSac(source.destination_office_sac ?? null);
      setMixedProjects(!!source.mixed_projects);
      if (source.issued_to_id) setIssuedToName(source.issued_to_name ?? null);
      if (source.department_id) setDepartmentName((source as any).department_name ?? null);
      if (source.project_id) setProjectName((source as any).project_name ?? null);
      setForm((current) => ({
        ...current,
        indent_id: source.indent_id,
        issue_type: source.indent_id ? "INDENT_BASED" : current.issue_type,
        department_id: source.department_id ?? current.department_id,
        project_id: source.project_id ?? current.project_id,
        issued_to_id: source.issued_to_id ?? current.issued_to_id,
        vehicle_id: source.vehicle_id ?? current.vehicle_id,
        vehicle_number: source.vehicle_number ?? current.vehicle_number,
        items: source.items,
      }));
    },
  });

  /** A destination point chosen: it fills Destination, SAC and Vehicle, and narrows
   *  the people offered to its office. A person already chosen from ANOTHER office no
   *  longer fits, so they are cleared rather than silently kept. */
  const choosePoint = (point: IssueDestinationOption | null) => {
    setEveryone(false);
    if (!point) {
      setDestPoint(null);
      setForm((f) => ({ ...f, destination_warehouse_id: null }));
      // Back to the derived answer: the person's office, else nothing.
      if (form.issued_to_id) pullEmployee.mutate(form.issued_to_id);
      else { setDestination(""); setDestinationSac(null); }
      return;
    }
    setDestPoint(point);
    setDestination(point.office_name || point.name);
    setDestinationSac(point.sac ?? null);
    const keepPerson = !issuedTo?.office_id || !point.office_id
      || issuedTo.office_id === point.office_id;
    if (!keepPerson) { setIssuedTo(null); setIssuedToName(null); }
    setForm((f) => ({
      ...f,
      destination_warehouse_id: point.warehouse_id,
      // An MDP or a warehouse is served by no MMU, so it carries no vehicle.
      vehicle_number: point.vehicle_number ?? null,
      issued_to_id: keepPerson ? f.issued_to_id : null,
    }));
  };

  /** A person chosen: their office fills the rest (`pullEmployee`), and when no point
   *  was chosen yet, the one stocking point on their office becomes the destination. */
  const chooseEmployee = (person: IssueEmployeeOption | null) => {
    setIssuedTo(person);
    setIssuedToName(person?.name ?? null);
    set("issued_to_id", person?.id ?? null);
    if (!person) {
      if (!destPoint && !form.indent_id) { setDestination(""); setDestinationSac(null); }
      return;
    }
    pullEmployee.mutate(person.id);
    if (!destPoint && person.office_id) {
      searchIssueDestinations("", { fromWarehouseId: form.warehouse_id, officeId: person.office_id })
        .then((found) => {
          if (found.items.length !== 1) return;
          const point = found.items[0];
          setDestPoint(point);
          setForm((f) => ({
            ...f,
            destination_warehouse_id: point.warehouse_id,
            vehicle_number: f.vehicle_number || point.vehicle_number || null,
          }));
        })
        .catch(() => undefined);
    }
  };

  const pointKind = (type?: string | null) =>
    type === "LIP" ? "LIP" : type === "MDP" ? "MDP" : "Warehouse";
  const pointRow = (p: IssueDestinationOption): PickerRow => ({
    id: p.warehouse_id,
    title: p.name,
    subtitle: [
      p.office_name && p.office_name !== p.name ? p.office_name : null,
      p.sac ? `SAC ${p.sac}` : null,
      p.vehicle_number ? `Vehicle ${p.vehicle_number}` : null,
    ].filter(Boolean).join(" · ") || null,
    badges: [{ text: pointKind(p.warehouse_type), tone: p.warehouse_type === "LIP" ? "ok" : "brand" }],
  });
  const sacRow = (p: IssueDestinationOption): PickerRow => ({
    id: p.warehouse_id,
    title: p.sac ?? "—",
    subtitle: p.name,
    badges: [{ text: pointKind(p.warehouse_type), tone: p.warehouse_type === "LIP" ? "ok" : "brand" }],
  });
  const personRow = (e: IssueEmployeeOption): PickerRow => ({
    id: e.id,
    title: e.name,
    subtitle: [e.position_name, e.office_name, e.department_name].filter(Boolean).join(" · ") || null,
    // Employee code, then every post held — the post is what the store recognises.
    badges: [
      ...(e.code ? [{ text: e.code, tone: "muted" as const }] : []),
      ...(e.position_codes ?? []).map((code) => ({ text: code, tone: "brand" as const })),
    ],
  });
  // Whose people the Issued-to list shows: the chosen point's office, unless widened.
  const personOffice = !everyone ? destPoint?.office_id ?? null : null;
  // A point with no service area code (an MDP, a main warehouse) says "None" there.
  const pointHasNoSac = !!destPoint && !destPoint.sac;
  const direct = !form.indent_id && direction === "OUT";

  const pullEmployee = useMutation({
    mutationFn: (employeeId: number) => getEmployeeDestination(employeeId),
    onSuccess: (source) => {
      // Issued-to wins over the indent for where the goods are headed — the same
      // precedence `_issue_destination` applies on a saved issue — so picking the
      // person fills Destination / SAC from their office. The vehicle follows only
      // when the office name carries one; an indent-set number is kept otherwise.
      // A destination point the store CHOSE wins here exactly as it does on save.
      if (!destPoint) {
        setDestination(source.destination_office_name ?? "");
        setDestinationSac(source.destination_office_sac ?? null);
      }
      if (source.issued_to_name) setIssuedToName(source.issued_to_name);
      if (source.vehicle_number && !destPoint) {
        setForm((current) => ({ ...current, vehicle_number: source.vehicle_number ?? current.vehicle_number }));
      }
      // Department / Project from the person's HCM record — only into a BLANK field:
      // an indent's own (or a hand-picked) value always wins.
      setForm((current) => {
        const fillDept = !current.department_id && source.department_id;
        const fillProject = !current.project_id && source.project_id;
        if (fillDept) setDepartmentName(source.department_name ?? null);
        if (fillProject) setProjectName(source.project_name ?? null);
        return {
          ...current,
          department_id: fillDept ? source.department_id! : current.department_id,
          project_id: fillProject ? source.project_id! : current.project_id,
        };
      });
    },
  });

  const pullOriginal = useMutation({
    mutationFn: (issueId: number) => getIssue(issueId),
    onSuccess: (source) => {
      setForm((current) => ({
        ...current,
        original_issue_id: source.id,
        warehouse_id: source.warehouse_id,
        department_id: source.department_id ?? null,
        project_id: source.project_id ?? null,
        issued_to_id: source.issued_to_id ?? null,
        items: (source.items ?? [])
          .map((line) => {
            const open = Math.max(num(line.issued_qty) - num(line.returned_qty), 0);
            return {
              ...emptyLine(),
              item_id: line.item_id,
              bin_id: line.bin_id,
              batch_id: line.batch_id,
              requested_qty: open,
              issued_qty: open,
              rate: line.rate,
              serial_numbers: parseCodes(line.serial_numbers) ?? [],
            };
          })
          .filter((line) => line.requested_qty > 0),
      }));
    },
  });

  const [splitResult, setSplitResult] = useState<IssueSplitResult | null>(null);
  const split = useMutation({
    mutationFn: () => splitIssue(Number(id)),
    onSuccess: (result) => {
      setSplitResult(result);
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
    },
  });

  const act = useMutation({
    mutationFn: async (what: "submit" | "approve" | "reject" | "post" | "ack" | "cancel") => {
      const numId = Number(id);
      if (what === "submit") {
        if (editing) {
          await save.mutateAsync();
        }
        return submitIssue(numId);
      }
      if (what === "approve") return approveIssue(numId, reason);
      if (what === "reject") return rejectIssue(numId, reason);
      if (what === "post") return postIssue(numId);
      if (what === "ack") return acknowledgeIssue(numId, reason || undefined);
      return cancelIssue(numId, reason || undefined);
    },
    onSuccess: (_result, what) => {
      const number = doc?.issue_no ?? "The issue";
      // Only the outcomes that change what the storekeeper does next are announced;
      // submit and approve are already obvious from the status pill moving.
      if (what === "post") void alerts.success("issue.posted", { number });
      else if (what === "ack") void alerts.success("issue.acknowledged", { number });
      qc.invalidateQueries({ queryKey: ["wh-issue", id] });
      qc.invalidateQueries({ queryKey: ["wh-issue-sources"] });
      qc.invalidateQueries({ queryKey: ["wh-issue-approvals", id] });
      qc.invalidateQueries({ queryKey: [`wh-issues-${direction}`] });
      // A posted issue is exactly what the consignment screen offers as its source,
      // and that picker is a Lookup holding its list for five minutes. Without this
      // the storekeeper who has just posted an issue opens Consignments, cannot find
      // it, and has to hard-refresh the browser before the flow will continue.
      // Every act here changes dispatchability one way or the other — post adds the
      // issue to that list, cancel and acknowledge take it back off.
      qc.invalidateQueries({ queryKey: ["wh-lookup", "posted-issues"] });
      setConfirming(null);
      setReason("");
    },
  });

  // Raised, then every rung the engine recorded, then where it is waiting now, then
  // what happened to the stock. The approvals come from wf_actions rather than the
  // document's own approved_at/approved_by_name: those are written only when the whole
  // ladder completes, so on a multi-rung ladder they hide every approval but the last.
  const trail: TimelineEntry[] = doc
    ? [
        { id: "created", title: "Raised", at: doc.created_at, by: doc.created_by_name, tone: "done" as const },
        ...approvalsToTimeline(approvals),
        // A document approved without an engine instance behind it — nothing to read
        // from wf_actions, so fall back to the document's own stamp rather than
        // showing an approved issue with no approval on it at all.
        approvals?.length === 0 && doc.approved_at
          ? { id: "approved", title: "Approved", at: doc.approved_at, by: doc.approved_by_name, tone: "done" as const }
          : null,
        doc.status === "PENDING_APPROVAL"
          ? { id: "pending", title: "Awaiting approval", by: doc.current_approver_name ?? "unassigned" }
          : null,
        doc.posted_at
          ? { id: "issued", title: "Issued from stock", at: doc.posted_at, by: doc.issued_by_name, tone: "done" as const }
          : null,
        doc.acknowledged_at
          ? {
              id: "ack",
              title: "Acknowledged by receiver",
              at: doc.acknowledged_at,
              by: doc.acknowledged_by_name,
              tone: "done" as const,
            }
          : null,
      ].filter(Boolean) as TimelineEntry[]
    : [];

  /* ------------------------------------------------------ what the grid renders --
   *
   * The grid is one row per ITEM with its picks under it (see IssueSplitEditor).
   * These three are the cells the form still owns, because they depend on the
   * document rather than on the split: which item a brand-new group is for, what the
   * goods cost, and which line the identifier picker is being opened for.
   */
  const renderItemPicker = (split: IssueSplit) => (
    <ItemPicker
      warehouseId={form.warehouse_id}
      indentId={form.indent_id}
      projectId={form.project_id}
      value={split.line.item_id || ""}
      isDisabled={locked}
      // A saved line whose item the point no longer stocks still has to render as
      // itself. The list it came from cannot be relied on to contain it.
      fallback={split.line.item_id
        ? { id: split.line.item_id, code: split.line.item_code ?? null,
            name: split.line.item_name ?? `Item ${split.line.item_id}` }
        : null}
      onChange={(v, option) => {
        const item = option as ItemOption | undefined;
        patchLine(split.index, {
          item_id: v === "" ? 0 : v,
          item_code: item?.code ?? null,
          item_name: item?.name ?? null,
          is_serial_tracked: !!item?.is_serial_tracked,
          is_imei_tracked: !!item?.is_imei_tracked,
          is_batch_tracked: !!item?.is_batch_tracked,
          // Unknown until the backend reads the line back; undefined means "offer the
          // picker", which is right for a line just picked.
          unit_mode: null,
          tracking_type: null,
          has_units: undefined,
          batch_id: null,
          bin_id: null,
          serial_numbers: [],
        });
      }}
    />
  );


  const removeGroup = (group: IssueGroup) => {
    const owned = new Set(group.splits.map((s) => s.index));
    setLines(form.items.filter((_, i) => !owned.has(i)));
  };

  /**
   * One more item on an issue nobody raised an indent for.
   *
   * A main store issues to departments, writes off scrap and moves stock for reasons
   * no indent covers — `_build_issue` has always allowed it, and only a LIP (the
   * bottom of the chain, where everything held arrived against a request) is refused.
   * The grid simply never offered the button, so the only way to raise an issue was to
   * pull an indent in: the item picker existed, the empty line it needed had no way of
   * being created. The ask starts at zero and is the storekeeper's to type, because
   * there is no indent line to inherit it from.
   */
  const addItem = () => setLines([...form.items, emptyLine()]);

  /**
   * Items whose single location cannot serve the whole ask, and where the rest of it
   * IS on this floor.
   *
   * Nothing is rearranged automatically. A machine spreading an ask over the oldest
   * stock it can find writes picks nobody decided, and the storekeeper — who can see
   * which bay is reachable and which pallet is behind another — then has to unpick
   * them. What the screen owes him is the fact, with the numbers that make the case:
   * this item is short where you are being sent, and there is more in N other places.
   */
  const needsAnotherLocation = groups.filter(
    (g) => g.itemId
      && g.splits.length === 1
      && g.splits[0].drawable !== null
      && round(g.requested - g.splits[0].drawable) > 0
      && g.spare.length > 0,
  );

  /** Items whose picks have moved off the locations inventory reserved for them.
   *  Saving frees those holds and takes the same quantity where the picks now point
   *  — a real change to somebody else's availability, so it is said once at the top
   *  of the grid as well as on the item it belongs to. */
  const relocating = groups.filter((g) => g.allocated.length > 0 && g.releasing.length > 0);

  /* Picks drafted before this point kept locations: bin 0 in a bin-managed
   * warehouse. They match no source row, so they read as "nothing here" while the
   * stock waits one bay away in UNLOCATED. Brain-first name: "Waiting to be
   * placed" — the goods are here, the address is old. */
  const waitingPlacement = isBinManaged
    ? form.items
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.item_id && !line.bin_id)
        .filter(({ line }) => (sourcesByItem[line.item_id] ?? []).some(
          (row) => (row.bin_code || "").toUpperCase().includes("UNLOCATED"),
        ))
    : [];
  const { data: unlocatedAudit } = useQuery({
    queryKey: ["wh-unlocated-audit", form.warehouse_id],
    queryFn: () => auditUnlocatedStock(form.warehouse_id),
    enabled: !!form.warehouse_id && isBinManaged && waitingPlacement.length > 0,
    staleTime: 30_000,
  });
  const repairUnlocated = useMutation({
    mutationFn: () => repairUnlocatedStock(form.warehouse_id, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-issue-sources"] });
      qc.invalidateQueries({ queryKey: ["wh-issue-unit-supply"] });
      qc.invalidateQueries({ queryKey: ["wh-unlocated-audit"] });
    },
  });
  const pointStaleAt = (index: number) => {
    const line = form.items[index];
    if (!line?.item_id) return false;
    const rows = sourcesByItem[line.item_id] ?? [];
    const target = rows.find((row) => (row.bin_code || "").toUpperCase().includes("UNLOCATED"));
    if (!target || line.bin_id) return false;
    patchLine(index, { bin_id: target.bin_id ?? null, bin_code: target.bin_code ?? null });
    void fillCodesFor(index, { ...line, bin_id: target.bin_id ?? null });
    return true;
  };
  /* Bay empty but batch/point has codes: "same batch, other bay" / "whole point".
   * Read off the widened unit-supply probes so the grid says WHERE the codes are,
   * not just that this bay has none. */
  const widerCodes = groups.filter((g) => g.splits.some((s) => {
    const supply = unitSupply[unitSupplyKey(
      s.line.item_id, s.line.batch_id, isBinManaged ? s.line.bin_id : null)];
    return (supply?.available ?? 0) <= 0
      && ((supply?.batch_available ?? 0) > 0 || (supply?.point_available ?? 0) > 0);
  }));


  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;

  const noun = direction === "OUT" ? "issue" : "return";

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={editing ? `${doc?.issue_no ?? ""}` : `New material ${noun}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(listPath)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {!locked && (
              <Can do="issue.create">
                {/* Refused here rather than by the server, because the server can
                  * only say which LINE it rejected, and after normalisation a line is
                  * no longer the thing the storekeeper edited. The banner over the
                  * grid names the item and the split. */}
                <Button
                  variant="subtle"
                  onClick={() => {
                    setTouched(true);
                    if (form.warehouse_id && form.items.length && blocking.length === 0) {
                      save.mutate();
                    }
                  }}
                  disabled={save.isPending || blocking.length > 0}
                  title={blocking.length > 0 ? blocking[0].message : undefined}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </Can>
            )}
            {editing && doc?.status === "DRAFT" && (
              <Can do="issue.create">
                <Button
                  className={TONE_SUBMIT}
                  onClick={() => setConfirming("submit")}
                  disabled={blocking.length > 0}
                  title={blocking.length > 0 ? blocking[0].message : undefined}
                >
                  Submit for approval
                </Button>
              </Can>
            )}
            {/* can_approve, not just the permission: the whole warehouse shares one
                HCM rank, so all eleven hold `issue.issue` while only the approver the
                chain named may act. Showing it to the rest sent them into a
                "You are not a valid approver" error after clicking. */}
            {editing && doc?.status === "PENDING_APPROVAL" && doc?.can_approve && (
              <Can do="issue.issue">
                <Button className={TONE_APPROVE} onClick={() => setConfirming("approve")}>Approve</Button>
                <Button className={TONE_REJECT} variant="danger" onClick={() => setConfirming("reject")}>Reject</Button>
              </Can>
            )}
            {editing && doc?.status === "APPROVED" && !doc?.is_stock_posted && (
              <Can do="issue.issue">
                <Button
                  onClick={() => setConfirming("post")}
                  disabled={problems.length > 0 || !doc?.can_issue_from_stock}
                  title={!doc?.can_issue_from_stock
                    ? `With ${doc?.currently_with ?? "another person"} — only they, someone they report to, or an approver of this issue can issue it`
                    : problems.length > 0 ? problems[0].message : undefined}
                >
                  Issue from stock
                </Button>
              </Can>
            )}
            {/* The manager's other option on the same approved issue: hand it to the
                floors instead of doing it themselves. Only on a parent — a child is
                already one floor's share and splitting it again means nothing. */}
            {editing && doc?.status === "APPROVED" && !doc?.is_stock_posted
              && !doc?.parent_issue_id && (
              <Can do="issue.split">
                <Button className={TONE_BLUE} disabled={split.isPending}
                        onClick={() => setConfirming("split")}>
                  {split.isPending ? "Splitting…" : "Split across floors"}
                </Button>
              </Can>
            )}
            {/* Never on a split parent: its floor issues are what get cancelled, and
                the server refuses it here. */}
            {editing && doc && !doc.is_stock_posted
              && !["CANCELLED", "ACKNOWLEDGED", "SPLIT", "CLOSED"].includes(doc.status) && (
              <Can do="issue.create">
                <Button variant="danger" onClick={() => setConfirming("cancel")}>Cancel</Button>
              </Can>
            )}
            {editing && doc && (
              <Button 
                variant="subtle" 
                onClick={() => window.open(`/warehouse/material-issues/${doc.id}/print`, "_blank")}
              >
                <FileText className="mr-2 h-4 w-4" />
                Print / Save PDF
              </Button>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? saveSerials.error ?? pullIndent.error ?? pullEmployee.error ?? pickingSource.error} />

      {/* What the split actually handed out. Shown here rather than as a toast: the
          shortfall is the half that matters and it must not scroll away — a quantity
          no floor was holding is a shortage on the indent, and the manager is the
          only person who sees this screen at the moment it is known. */}
      {/* A split parent is carried by its floor issues: say so, and which of them it is
          still waiting on, since its own status is rolled up from theirs. Hidden while
          the just-split result is up — that card already lists the same children. */}
      {!splitResult && doc && (doc.child_issues?.length ?? 0) > 0 && (
        <SplitFamilyCard
          parentNo={doc.parent_issue_no ?? doc.issue_no}
          parentStatus={doc.parent_issue_id ? null : doc.status}
          members={doc.child_issues!}
          currentId={doc.id}
          onOpen={(childId) => nav(`${listPath}/${childId}`)}
        />
      )}

      {splitResult && (
        <SplitFamilyCard
          parentNo={splitResult.parent_issue_no}
          parentStatus="SPLIT"
          members={splitResult.children.map((child) => ({
            id: child.id, issue_no: child.issue_no, status: "DRAFT" as const,
            floor_location_name: child.floor_location_name, is_stock_posted: false,
            total_qty: Number(child.total_qty), total_items: child.total_items,
            in_charge_names: child.in_charge_names,
          }))}
          unfulfilled={splitResult.unfulfilled}
          onOpen={(childId) => nav(`${listPath}/${childId}`)}
          onDismiss={() => setSplitResult(null)}
        />
      )}
      {mixedProjects && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-info/30 bg-info-bg px-4 py-3 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Some lines draw on stock received for another project, or for none. That is
            allowed — stock is one pool. Each line keeps its source project in the ledger.
          </span>
        </div>
      )}
      {touched && !form.warehouse_id && <ErrorBanner error="Pick the issuing warehouse." />}
      {touched && form.items.length === 0 && <ErrorBanner error="Add at least one line." />}

      {doc && (
        <MetaCard title="Document">
          <MetaRow label="Number" value={<span className="font-mono">{doc.issue_no}</span>} />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow
            label="Currently with"
            value={doc.currently_with
              ? `${doc.currently_with}${awaitingIssue ? " — to issue from stock" : ""}`
              : "—"}
          />
          <MetaRow label="Stock" value={doc.is_stock_posted ? `Posted ${fmtDateTime(doc.posted_at)}` : "Not posted"} />
          <MetaRow label={doc.indent_type === "STR" ? "Against STR" : "Against indent"} value={<span className="font-mono">{doc.indent_no ?? "—"}</span>} />
          {doc.pick_no && (
            <MetaRow label="Fulfilment" value={<span className="font-mono">{doc.pick_no}</span>} />
          )}
          {/* `issued_by` is stamped only when stock is posted — whoever pressed Issue
            * from stock. Before that the field is the SUBMITTER, never the creator: an
            * allocation drafts the issue under its approver's name (SCM_0010). */}
          {doc.is_stock_posted ? (
            <MetaRow label="Issued by" value={doc.issued_by_name || "—"} />
          ) : (
            <MetaRow label="Submitted by"
                     value={doc.submitted_by_name || doc.created_by_name || "—"} />
          )}
          <MetaRow label="Acknowledged by" value={doc.acknowledged_by_name || "—"} />
          {doc.parent_issue_id && (
            <MetaRow
              label="Split of"
              value={
                <button type="button" className="font-mono underline"
                        onClick={() => nav(`${listPath}/${doc.parent_issue_id}`)}>
                  {doc.parent_issue_no}
                </button>
              }
            />
          )}
          {doc.floor_location_name && (
            <MetaRow
              label="Handed to"
              value={
                <span>
                  {doc.floor_location_name} ·{" "}
                  {doc.floor_in_charge_names?.length
                    ? doc.floor_in_charge_names.join(", ")
                    : <span className="text-warn">no floor in-charge assigned</span>}
                </span>
              }
            />
          )}
          {doc.original_issue_no && (
            <MetaRow label="Reverses" value={<span className="font-mono">{doc.original_issue_no}</span>} />
          )}
        </MetaCard>
      )}

      <Section title={`${direction === "OUT" ? "Issue" : "Return"} details`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date">
            <Input type="date" value={form.issue_date} disabled={locked}
                   onChange={(e) => set("issue_date", e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={form.issue_type} onChange={(v) => set("issue_type", v)}
                    options={doc?.indent_type === "STR"
                      ? TYPES.map((t) => (t.value === "INDENT_BASED" ? { ...t, label: "Stock transfer (STR)" } : t))
                      : TYPES}
                    isDisabled={locked} ariaLabel="Issue type" />
          </Field>
          <Field label="From warehouse">
            <Lookup name="warehouses" load={warehouseOptions} value={form.warehouse_id || ""}
                    isDisabled={locked || !!form.picking_id || direction === "IN"}
                    onChange={(v, option) => {
                      setForm({ ...form, warehouse_id: Number(v) || 0, items: [] });
                      if (destPoint && destPoint.warehouse_id === Number(v)) choosePoint(null);
                      setIsBinManaged((option as any)?.is_bin_managed ?? true);
                    }}
                    placeholder="Warehouse" />
          </Field>
          <Field label="Against indent / STR" hint="Loads the approved stock reservation.">
            <Lookup name={`indents-${form.warehouse_id}`}
                    load={(search) => indentOptions(search, form.warehouse_id || undefined)}
                    // The loader lists indents still open to be issued, so once this
                    // issue exists its own indent has left that list. Without the
                    // fallback the field on a saved document reads "Indent" in grey
                    // while the header above it names IND/2026-27/00196.
                    fallback={doc?.indent_id
                      ? [{ id: doc.indent_id, name: doc.indent_no ?? String(doc.indent_id) }]
                      : []}
                    value={form.indent_id ?? ""} isDisabled={locked || !form.warehouse_id}
                    onChange={(v) => {
                const indentId = v === "" ? null : v;
                setForm((f) => ({
                  ...f, indent_id: indentId,
                  issue_type: indentId ? "INDENT_BASED" : "DIRECT",
                  destination_warehouse_id: indentId ? null : f.destination_warehouse_id,
                }));
                if (indentId) setDestPoint(null);
                if (!indentId) { setDestination(""); setDestinationSac(null); }
                if (indentId && form.warehouse_id) pullIndent.mutate(indentId);
              }} placeholder={form.warehouse_id ? "Indent / STR" : "Pick warehouse first"} />
          </Field>
          <Field label="Department">
            <Lookup name="departments" load={departmentOptions} value={form.department_id ?? ""}
                    isDisabled={locked}
                    fallback={form.department_id
                      ? [{ id: form.department_id, name: departmentName ?? String(form.department_id) }]
                      : []}
                    onChange={(v, option) => {
                      set("department_id", v === "" ? null : v);
                      setDepartmentName(option?.name ?? null);
                    }}
                    placeholder="Department" />
          </Field>
          <Field label="Project">
            <Lookup name="projects" load={projectOptions} value={form.project_id ?? ""} isDisabled={locked}
                    fallback={form.project_id
                      ? [{ id: form.project_id, name: projectName ?? String(form.project_id) }]
                      : []}
                    onChange={(v, option) => {
                      set("project_id", v === "" ? null : v);
                      setProjectName(option?.name ?? null);
                    }} placeholder="Project" />
          </Field>
          {direct ? (
            <>
              <div className="sm:col-span-2">
                <SearchPicker<IssueDestinationOption>
                  label="Destination"
                  hint="Any warehouse, MDP or LIP but your own. Search a name, a SAC or a vehicle number."
                  placeholder={destination || "Search warehouse, MDP or LIP"}
                  value={destPoint ? pointRow(destPoint) : null}
                  onChange={choosePoint}
                  queryKey={["issue-destinations", form.warehouse_id]}
                  load={(q) => searchIssueDestinations(q, { fromWarehouseId: form.warehouse_id })}
                  toRow={pointRow}
                  emptyText="No other warehouse, MDP or LIP is active."
                  disabled={locked}
                />
              </div>
              {pointHasNoSac ? (
                <div>
                  <span className="mb-1.5 block text-sm font-medium text-body">Service area code (SAC)</span>
                  <div className="flex min-h-11 items-center rounded-md border border-dashed border-line bg-content2/40 px-3 text-sm text-muted">
                    None
                  </div>
                  <span className="mt-1 block text-xs text-muted">
                    {pointKind(destPoint?.warehouse_type)}s carry no service area code.
                  </span>
                </div>
              ) : (
                <SearchPicker<IssueDestinationOption>
                  label="Service area code (SAC)"
                  hint="Picking a SAC picks its LIP as the destination."
                  placeholder={destinationSac || "Search SAC"}
                  value={destPoint?.sac ? sacRow(destPoint) : null}
                  onChange={choosePoint}
                  queryKey={["issue-sacs", form.warehouse_id]}
                  load={(q) => searchIssueDestinations(q, { fromWarehouseId: form.warehouse_id, withSac: true })}
                  toRow={sacRow}
                  emptyText="No point with a service area code."
                  disabled={locked}
                />
              )}
              <Field label="Vehicle" hint={destPoint && !destPoint.vehicle_number && !form.vehicle_number
                ? `None for ${pointKind(destPoint.warehouse_type) === "Warehouse" ? "a warehouse" : `an ${pointKind(destPoint.warehouse_type)}`} — type one if a vehicle is taking it.`
                : "Filled from the destination; type over it if another vehicle goes."}>
                <Input value={form.vehicle_number ?? ""} disabled={locked}
                       onChange={(e) => set("vehicle_number", e.target.value)}
                       placeholder={destPoint && !destPoint.vehicle_number ? "None" : "Vehicle number"} />
              </Field>
              <div className="sm:col-span-2">
                <SearchPicker<IssueEmployeeOption>
                  label="Issued to"
                  hint={destPoint?.office_id && !everyone
                    ? "People at the destination. Choosing one fills Department and Project."
                    : "Search every employee by name, code, office or department."}
                  placeholder="Search name, employee or position code"
                  value={issuedTo ? personRow(issuedTo) : (form.issued_to_id
                    ? { id: form.issued_to_id, title: issuedToName ?? String(form.issued_to_id) }
                    : null)}
                  onChange={chooseEmployee}
                  queryKey={["issue-employees", personOffice]}
                  load={(q) => searchIssueEmployees(q, personOffice)}
                  toRow={personRow}
                  emptyText={personOffice ? "Nobody is recorded at this office." : "No active employees."}
                  filterNote={personOffice ? (
                    <span>
                      Showing people at <b className="text-ink">{destPoint?.office_name || destPoint?.name}</b>.{" "}
                      <button type="button" className="font-semibold text-brand hover:underline"
                              onClick={() => setEveryone(true)}>
                        Show everyone
                      </button>
                    </span>
                  ) : destPoint?.office_id ? (
                    <span>
                      Showing everyone.{" "}
                      <button type="button" className="font-semibold text-brand hover:underline"
                              onClick={() => setEveryone(false)}>
                        Only people at the destination
                      </button>
                    </span>
                  ) : undefined}
                  disabled={locked}
                />
              </div>
            </>
          ) : (
            <>
          <Field label="Issued to">
            <Lookup name="employees" load={employeeOptions} value={form.issued_to_id ?? ""} isDisabled={locked}
                    // The list is the first page of employees, so a person outside it
                    // — the indent raiser this draft defaulted to — would render as the
                    // grey "Person" placeholder over a value that is set.
                    fallback={form.issued_to_id
                      ? [{ id: form.issued_to_id, name: issuedToName ?? String(form.issued_to_id) }]
                      : []}
                    onChange={(v, option) => {
                      const personId = v === "" ? null : v;
                      set("issued_to_id", personId);
                      setIssuedToName(option?.name ?? null);
                      if (personId) pullEmployee.mutate(personId);
                      else if (!form.indent_id) { setDestination(""); setDestinationSac(null); }
                    }} placeholder="Person" />
          </Field>
          <Field label="Vehicle">
            <Input value={form.vehicle_number ?? ""} disabled={locked}
                   onChange={(e) => set("vehicle_number", e.target.value)} placeholder="Vehicle number" />
          </Field>
          <Field label="Destination" hint="Office of the issued-to employee — from the indent when one is picked, else from the person.">
            <Input value={destination || "—"} disabled />
          </Field>
          {/* Read-only like Destination above it, and filled from the same answer: the
              SAC belongs to the office receiving the goods, so it follows the indent
              when one is picked and the issued-to person otherwise. */}
          <Field label="Service area code (SAC)" hint="Of the destination office — from the indent when one is picked, else from the person.">
            <Input
              value={destinationSac ?? (destination ? "No service area code for this office" : "—")}
              disabled
            />
          </Field>
            </>
          )}
        </div>
      </Section>

      <Section
        title="Lines"
        hint="One row per item, with every batch and storage location it is picked from inside it. Issuing below the request leaves the item short — that is recorded, not hidden."
      >
        {unitShort.length > 0 && (
          <div className="mb-3 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-sm text-ink">
            <b>These picks cannot be posted as they stand.</b> Approval freezes the
            batch, and issuing from stock needs one identified unit per issued unit — change the batch,
            split the quantity onto another location, or reduce it now.
            <ul className="mt-1 list-disc pl-5">
              {unitShort.map((row) => (
                <li key={row.key}>
                  {row.code} — the pick from{" "}
                  {row.batch ? <b>batch {row.batch}</b> : "the unbatched stock"}
                  {row.bin ? <> in <b>{row.bin}</b></> : null} needs{" "}
                  <b className="tabular">{row.need}</b> and holds{" "}
                  <b className="tabular">{row.have}</b>
                </li>
              ))}
            </ul>
          </div>
        )}


        {direction === "OUT" && !doc?.is_stock_posted && !!form.warehouse_id && (
          <LiveStockPanel lines={form.items} sources={sources} updatedAt={sourcesAt}
                          fetching={sourcesFetching} onRefresh={() => void refetchSources()} />
        )}

        {/* A direct issue has no allocation behind it, so it holds its own stock. */}
        {direction === "OUT" && !form.indent_id && !doc?.is_stock_posted
          && form.items.length > 0 && (
          <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-ok/30 bg-ok-bg px-3 py-2.5 text-sm text-ink">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <div className="min-w-0 flex-1">
              {editing && sources.some((row) => num(row.issue_hold_qty ?? 0) > 0) ? (
                <>
                  <b>
                    {fmtQty(sources.reduce((sum, row) => sum + num(row.issue_hold_qty ?? 0), 0))}{" "}
                    reserved for this issue.
                  </b>{" "}
                  Nobody else can take it until this issue is issued from stock or
                  cancelled — cancelling gives it straight back to the shelf.
                </>
              ) : (
                <>
                  <b>Saving reserves these quantities for this issue.</b> A direct issue has
                  no allocation behind it, so it holds its own stock from the moment it is
                  saved until it is issued or cancelled.
                </>
              )}
            </div>
          </div>
        )}

        {/* Stated, never acted on. Which bay the goods actually come out of is the
          * storekeeper's decision, and "Add batch / storage location" on the item is
          * where he makes it. */}
        {!locked && needsAnotherLocation.length > 0 && (
          <div className="mb-3 flex flex-wrap items-start gap-2.5 rounded-xl border border-info/30 bg-info-bg px-3 py-2.5 text-sm text-info">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <b>
                {needsAnotherLocation.length === 1
                  ? `${needsAnotherLocation[0].itemCode ?? "One item"} needs a second location.`
                  : `${needsAnotherLocation.length} items need a second location.`}
              </b>{" "}
              The one named cannot give the whole quantity, and the rest of it is on
              other shelves at this point. Add the location it is really coming from
              on the item below — one pick per place you walk to.
            </div>
          </div>
        )}

        {/* A hold does not follow a document by itself. Changing a batch or a
          * location here MOVES what inventory reserved, and the bay being left goes
          * back to free stock the moment this is saved. */}
        {!locked && relocating.length > 0 && (
          <div className="mb-3 flex flex-wrap items-start gap-2.5 rounded-xl border border-brand/30 bg-brand/[0.06] px-3 py-2.5 text-sm text-ink">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <b>
                {relocating.length === 1
                  ? `${relocating[0].itemCode ?? "One item"} is being picked somewhere else than inventory allocated.`
                  : `${relocating.length} items are being picked somewhere else than inventory allocated.`}
              </b>{" "}
              That is allowed — saving releases the reservation on the location being
              left, so the stock there is free for anybody again, and takes the same
              quantity where the picks now point. Each item says which locations
              those are.
            </div>
          </div>
        )}

        {/* Waiting to be placed: picks drafted before this point kept locations.
          * One press points them at the UNLOCATED bay their stock now stands in —
          * no retyping, no lost reservation. */}
        {!locked && waitingPlacement.length > 0 && (
          <div className="mb-3 overflow-hidden rounded-2xl border border-warn/40 bg-gradient-to-r from-warn/10 via-warn/[0.06] to-transparent px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-warn/15 text-warn">
                <MapPin className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink">
                  {waitingPlacement.length} pick{waitingPlacement.length === 1 ? "" : "s"} waiting to be placed
                </p>
                <p className="text-xs text-body">
                  Made before this point kept locations. The stock is in{" "}
                  <b className="font-mono">UNLOCATED</b>
                  {unlocatedAudit && (unlocatedAudit.stranded_units ?? 0) > 0
                    ? ` along with ${unlocatedAudit.stranded_units} unpacked codes`
                    : ""}
                  {" "}— point them there in one press.
                </p>
              </div>
              <Button
                variant="soft"
                disabled={repairUnlocated.isPending}
                onClick={() => {
                  waitingPlacement.forEach(({ index }) => pointStaleAt(index));
                  repairUnlocated.mutate();
                }}
              >
                {repairUnlocated.isPending ? "Placing…" : "Place in UNLOCATED"}
              </Button>
            </div>
          </div>
        )}

        {/* Codes beyond this bay: the quantity is here, the identity is next door.
          * The picker switch ("This batch, any bay" / "Whole point") already lists
          * them — this only says the fact before the picker is opened. */}
        {!locked && waitingPlacement.length === 0 && widerCodes.length > 0 && (
          <div className="mb-3 flex flex-wrap items-start gap-2.5 rounded-xl border border-info/30 bg-info-bg px-3 py-2.5 text-sm text-info">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <b>
                {widerCodes.length === 1
                  ? `${widerCodes[0].itemCode ?? "One item"} has its codes beyond this bay.`
                  : `${widerCodes.length} items have their codes beyond this bay.`}
              </b>{" "}
              Open the code picker and widen to “This batch, any bay” or “Whole
              point” — the bay on the pick is empty of codes, the point is not.
            </div>
          </div>
        )}

        <IssueSplitEditor
          groups={groups}
          lines={form.items}
          onChange={setLines}
          sourcesByItem={sourcesByItem}
          warehouseId={form.warehouse_id}
          indentId={form.indent_id}
          binManaged={isBinManaged}
          locked={locked}
          unitsLocked={serialsLocked}
          codesLocked={codesLocked}
          unitsHidden={unitsHidden}
          onPickUnits={setSerialLine}
          onSourcePicked={(index, line) => { void fillCodesFor(index, line); }}
          meta={trackingMeta}
          problemAt={problemAt}
          unitSupply={unitSupply}
          sourcesReady={sourcesReady}
          renderItemPicker={renderItemPicker}
          onAddItem={locked ? undefined : addItem}
          onRemoveGroup={locked ? undefined : removeGroup}
          packOptionsByItem={packOptions.data}
        />

        <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 rounded-2xl border border-line/70 bg-content2/50 px-3 py-2 text-sm">
          <span className="text-muted">
            {groups.length} item{groups.length === 1 ? "" : "s"}
            {totals.lines > groups.length && ` · ${totals.lines} picks`}
          </span>
          <span className="text-ink">Requested <b className="tabular">{fmtQty(totals.requested)}</b></span>
          <span className="text-ink">Issued <b className="tabular">{fmtQty(totals.issued)}</b></span>
          {short > 0 && <span className="text-warn">Short <b className="tabular">{fmtQty(short)}</b></span>}
          {/* What leaving the shelves gives back. Only shown once it is knowable —
            * a zero here would claim the issue frees nothing, when the truth is
            * usually that the items have not been measured. */}
          {freedUnits > 0 && (
            <span className="mr-3">
              Frees <b className="tabular">{fmtCount(freedUnits)}</b> handling
              unit{freedUnits === 1 ? "" : "s"}
            </span>
          )}
          {freedVolume > 0 && (
            <span className="text-ok">
              Frees <b className="tabular">{volume(freedVolume)}</b>
            </span>
          )}
          <span className="text-ink">Value <b className="tabular">₹ {fmtMoney(totals.value)}</b></span>
        </div>
      </Section>

      {/* The space this document gives back, per location it actually draws from.
        * Grouped exactly as the grid above is - one block per item, one row per pick
        * - because the two describe the same picks, and a breakdown showing one bin
        * for a quantity taken out of two was the same defect one screen further down.
        * An item's subtotal is a sum of its own rows, never a separately computed
        * figure that could disagree with them. */}
      {isBinManaged && outwardMoves.length > 0 && !doc?.is_stock_posted && (
        <Accordion variant="splitted" className="mt-8 px-0">
          <AccordionItem
            key="calculation-breakdown"
            aria-label="Calculation breakdown"
            title={
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-lg font-bold text-ink">Calculation breakdown</h2>
                <p className="text-sm font-normal text-muted">What each pick takes off its shelf. Volumes come from the item's default putaway pack.</p>
              </div>
            }
            classNames={{ title: "py-2" }}
          >
          <div className="overflow-x-auto rounded-2xl border border-line/70 bg-content1 mb-4">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-content2 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Item</th>
                  <th className="px-4 py-2.5 font-semibold">Batch</th>
                  <th className="px-4 py-2.5 font-semibold">Storage location</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Issued qty</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Unit volume</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Space freed</th>
                </tr>
              </thead>
              {groups
                .map((group) => ({
                  group,
                  picks: group.splits.filter(
                    (split) => split.line.bin_id && split.line.item_id && split.issued > 0,
                  ),
                }))
                .filter(({ picks }) => picks.length > 0)
                .map(({ group, picks }) => (
                  <BreakdownGroup
                    key={group.key}
                    group={group}
                    picks={picks}
                    freed={freed}
                    itemPackagings={itemPackagings}
                    sourcesByItem={sourcesByItem}
                    savedLine={savedLine}
                    trackingMeta={trackingMeta}
                  />
                ))}
            </table>
          </div>
          {freedUnmeasured > 0 && (
            <p className="mb-4 text-xs text-muted">
              {freedUnmeasured} pick{freedUnmeasured === 1 ? " has" : "s have"} no measured
              putaway pack, so the space they free is not counted here.
            </p>
          )}
          </AccordionItem>
        </Accordion>
      )}

      <Section title="Remarks">
        <Input value={form.remarks ?? ""} disabled={locked} onChange={(e) => set("remarks", e.target.value)} />
      </Section>

      {doc && (
        <Section title="Progress">
          <Timeline entries={trail} />
        </Section>
      )}

      <Section title="Documents" hint="Gate pass, signed acknowledgement.">
        <AttachmentsPanel entityType="ISSUE" entityId={doc?.id} category="ISSUE" readOnly={locked} />
      </Section>

      {/* Naming the units is a SCREEN, not a dialog — see CodeAssignmentScreen. It
        * owns its own paged query, so the whole pool is reachable however large the
        * bay is, and the selection it hands back spans every page it was made on. */}
      <CodeAssignmentScreen
        open={serialLine !== null}
        onClose={() => setSerialLine(null)}
        quantity={serialLine === null ? 0 : num(form.items[serialLine]?.issued_qty)}
        initial={serialLine === null ? [] : form.items[serialLine]?.serial_numbers ?? []}
        trackingType={activeTracking}
        trackingMeta={trackingMeta(activeTracking)}
        noun={unitNoun(activeUnitMode)}
        unitMode={activeUnitMode}
        scope={activeScope}
        // Asset and consumable codes are auto-assigned but swappable (`codesLocked`).
        // Serial/IMEI keep the document-wide rule.
        readOnly={activeTracking === "ASSET" || activeTracking === "CONSUMABLE"
          ? codesLocked
          : serialsLocked}
        itemId={activeSerialLine?.item_id}
        warehouseId={form.warehouse_id}
        batchId={sourceId(activeSerialLine?.batch_id)}
        binId={isBinManaged ? sourceId(activeSerialLine?.bin_id) : undefined}
        issueId={editing ? Number(id) : undefined}
        issueLineId={activeSerialLine?.id}
        itemLabel={(() => {
          if (serialLine === null) return "";
          const name = savedLine(serialLine)?.item_name ?? form.items[serialLine]?.item_name ?? `Line ${serialLine + 1}`;
          const code = savedLine(serialLine)?.item_code ?? form.items[serialLine]?.item_code ?? null;
          return code ? `${code} — ${name}` : name;
        })()}
        onSave={(serials) => {
          if (serialLine === null) return;
          patchLine(serialLine, { serial_numbers: serials });
          // On a draft the serials ride along with the next save. On an approved
          // issue there is no save left to ride, so they go to the server now.
          const lineId = savedLine(serialLine)?.id;
          if (locked && lineId) saveSerials.mutate({ id: lineId, serial_numbers: serials });
        }}
      />

      <ConfirmModal
        isOpen={confirming === "submit"}
        title="Submit for approval?"
        message="The document goes to the approval chain and can no longer be edited."
        confirmLabel="Submit"
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("submit")}
        onClose={() => setConfirming(null)}
      >
        {/* Approval freezes the batch and the bin, and issuing from stock needs one
          * named unit per issued unit - so an identifier still unassigned here is a
          * document that can be approved and then never posted. Said before the
          * press, not after it. */}
        {problems.length > 0 && (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-sm text-ink">
            <b>Still unfinished:</b>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {problems.slice(0, 5).map((problem, i) => (
                <li key={i}>{problem.message}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">
              Approval freezes the batch and storage location these units come from.
            </p>
          </div>
        )}
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "approve" || confirming === "reject"}
        title={confirming === "approve" ? "Approve this issue?" : "Reject this issue?"}
        message="This records your decision in the shared approval history."
        confirmLabel={confirming === "approve" ? "Approve" : "Reject"}
        danger={confirming === "reject"}
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate(confirming === "approve" ? "approve" : "reject")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Comments">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {direction === "IN" && (
            <Field label="Original material issue" hint="Loads only the quantity still returnable.">
              <Lookup
                name="original-issues"
                load={returnableIssueOptions}
                value={form.original_issue_id ?? ""}
                isDisabled={locked}
                onChange={(value) => {
                  const issueId = value === "" ? null : value;
                  set("original_issue_id", issueId);
                  if (issueId) pullOriginal.mutate(issueId);
                }}
                placeholder="Select issued document"
              />
            </Field>
          )}
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "split"}
        title="Split this issue across the floors?"
        message={"One issue is created per floor that is holding stock for these items, "
          + "each for the quantity that floor actually has, numbered off this one — "
          + `${doc?.issue_no ?? "this issue"}-001, -002 and so on. The floor in-charges see `
          + "their own and nobody else's. Anything no floor is holding stays unfulfilled "
          + "and is listed for you. Nothing leaves the warehouse yet."}
        confirmLabel="Split across floors"
        busy={split.isPending}
        error={split.error}
        onConfirm={() => { split.mutate(); setConfirming(null); }}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "post"}
        title="Issue this stock?"
        message={`${fmtQty(totals.issued)} leaves the warehouse now. This writes stock movements and cannot be undone — a mistake is corrected with a return, not a delete.`}
        confirmLabel="Issue from stock"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("post")}
        onClose={() => setConfirming(null)}
      />

      <ConfirmModal
        isOpen={confirming === "cancel"}
        title="Cancel this document?"
        message="Cancelling stops the document here. Stock already posted stays posted."
        confirmLabel="Cancel document"
        danger
        busy={act.isPending}
        error={act.error}
        onConfirm={() => act.mutate("cancel")}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}
