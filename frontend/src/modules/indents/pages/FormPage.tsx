import { useEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, LibraryBig, Plus, Trash2 } from "lucide-react";
import { CardBody, Skeleton } from "@heroui/react";
import {
  PageHeader, Button, Card, DocumentNumberCard, Field, Input, Select, useToast,
} from "@/shared/components";
import {
  docNumberApi, docNumberPayload, docNumberValueFrom, emptyDocNumberValue, raiserScope,
  type DocNumberValue,
} from "@/shared/documentNumber";
import { useAuth } from "@/shared/auth/AuthContext";
import { getMyStockingPoints } from "@/modules/inventory/api";
import {
  indentApi, indentKeys, isIndentModuleQuery,
  useIndentAccountCacheIsolation, useIndentAccountScope,
} from "../api";
import { ItemCombobox } from "../components/ItemCombobox";
import { ChooseBomModal } from "../components/ChooseBomModal";
import {
  INDENT_STATUS, INDENT_TYPE, INDENT_TYPE_OPTIONS, STR_HOME, indentBase,
} from "../constants";
import {
  comparableVehicleNumber, displayUom, splitDeliveryOffice,
} from "../displayFormat";
import type { IndentCreate, IndentType, IndentUpdate, TemplateLineItem } from "../types";
import { TONE_AMBER, TONE_MINT, TONE_PINK } from "../buttonTones";
import {
  fmtQty, laddersForBrand, levelsFor, packable, usePackOptions, type PackLevel,
} from "@/shared/packing";
import {
  CombinationPicker, combinationKey, pickCombination, useCombinationOptions,
  type CombinationValue,
} from "@/shared/combination";

interface Line {
  item_id: number | "";
  quantity: number | "";
  /** Typed in an Indent container (2026-10-23): which level, and how many. The line
   *  still sends `quantity` in base units — count × the container's size. */
  packLevel?: number;
  packCount?: number | "";
  duplicateItemId?: number;
  /** Which brand / variant / model — or Any (2026-10-23). Unset reads as Any. */
  combo?: CombinationValue;
}

/** Item + combination: the same item in two combinations is two lines. */
function lineKey(line: Line) {
  const c = line.combo;
  return `${line.item_id}|${c?.combination_any || !c?.brand_id ? "any" : combinationKey(c)}`;
}

const PAST_REQUIRED_DATE_ERROR = "Required date cannot be earlier than today";
const REQUIRED_DATE_MANDATORY_ERROR = "Required date is mandatory.";
const REQUIRED_DATE_MISSING_NOTICE = {
  title: "Required date is missing",
  message: REQUIRED_DATE_MANDATORY_ERROR,
};
const REQUIRED_DATE_PAST_NOTICE = {
  title: "Required date needs attention",
  message: PAST_REQUIRED_DATE_ERROR,
};
const DUPLICATE_ITEM_ERROR = "This item is already added to the indent.";
const MISSING_QTY_ERROR = "Quantity is required for this item.";
const UOM_UNAVAILABLE = "UOM unavailable";
/**
 * Hides the browser's native number spinner. It stays `type="number"` — only the
 * arrows go; stepping 0.001 at a time was never a useful way to enter a quantity.
 */
const NO_SPINNER = "[&_input]:[appearance:textfield] " +
  "[&_input::-webkit-outer-spin-button]:m-0 [&_input::-webkit-outer-spin-button]:appearance-none " +
  "[&_input::-webkit-inner-spin-button]:m-0 [&_input::-webkit-inner-spin-button]:appearance-none";

/**
 * Hiding the arrows does not stop a `type="number"` field from stepping: the mouse
 * wheel and the up/down keys still move it, one whole `step` at a time, with nothing
 * on screen to say it happened. Scrolling the page with the cursor resting on a
 * focused Qty box is enough to walk a quantity away from what was typed — which is how
 * quantities nobody entered (9 → 7.999, 20 → 17.999) reached the database. The wheel
 * blurs the field so the page scrolls instead, and the arrows do nothing.
 */
const NO_SILENT_STEPPING = {
  onWheel: (event: WheelEvent<HTMLInputElement>) => event.currentTarget.blur(),
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
  },
};

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function duplicateItemRows(lines: Line[]) {
  const seen = new Set<string>();
  const duplicates = new Map<number, number>();
  lines.forEach((line, index) => {
    if (line.item_id === "") return;
    const key = lineKey(line);
    if (seen.has(key)) duplicates.set(index, Number(line.item_id));
    seen.add(key);
  });
  return duplicates;
}

function clearResolvedDuplicateErrors(lines: Line[]) {
  return lines.map((line, index) => {
    if (
      line.duplicateItemId === undefined
      || lines.some((other, otherIndex) =>
        otherIndex !== index && lineKey(other) === lineKey(line))
    ) {
      return line;
    }
    const validLine = { ...line };
    delete validLine.duplicateItemId;
    return validLine;
  });
}

export function IndentFormPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const editParam = searchParams.get("edit");
  const editId = editParam === null ? null : Number(editParam);
  const isEditing = editId !== null && Number.isFinite(editId);
  const { me } = useAuth();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const qc = useQueryClient();
  const toast = useToast();
  const initializedDraftId = useRef<number | null>(null);
  const initializedPrefill = useRef<string | null>(null);
  const [priority, setPriority] = useState("NORMAL");
  // /inventory/transfers/new (or `?type=STR`) opens this form as a Stock Transfer
  // Request: same lines, same document, its own ladder and number series on the server.
  const strRoute = useLocation().pathname.startsWith("/inventory/transfers");
  const [indentType, setIndentType] = useState<IndentType>(
    strRoute || searchParams.get("type") === INDENT_TYPE.STR ? INDENT_TYPE.STR : INDENT_TYPE.REGULAR);
  const isStr = indentType === INDENT_TYPE.STR;
  // The number series this document is drawn from: an STR its own, a monthly indent its
  // own (MI-IND), every other indent the indent series. The card reads it off the server.
  const numberDocType = isStr ? "str" : indentType === INDENT_TYPE.MONTHLY ? "monthly_indent" : "indent";
  // Organisation, project / department and year (2026-11-09). What HCM fixes for the
  // raiser is filled and locked (`raiserScope`); the save fixes the same values.
  const [scope, setScope] = useState<DocNumberValue>(emptyDocNumberValue);
  const [scopeReady, setScopeReady] = useState(false);
  const numberCard = useQuery({
    queryKey: ["document-number-card", numberDocType],
    queryFn: () => docNumberApi.card(numberDocType),
  });
  const raiser = numberCard.data ? raiserScope(numberCard.data) : { locks: {}, patch: {} };
  const docLabel = isStr ? "request" : "indent";
  const detailPath = (id: number) => `${indentBase(indentType)}/${id}`;
  const [vehicleId, setVehicleId] = useState<number | "">("");
  // Where an STR asks the stock to come FROM (2026-11-04). Required on an STR.
  const [sourceId, setSourceId] = useState<number | "">("");
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [deliveryOfficeId, setDeliveryOfficeId] = useState<number | "">(
    me?.active_position?.office_id ?? me?.employee.office_id ?? "",
  );
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  // Each item's ladders, for the Indent containers (2026-10-23).
  const packOptions = usePackOptions(lines.map((line) => Number(line.item_id) || 0));
  /** The line's ladder (its brand's, else the first) and its Indent containers. */
  const indentContainers = (line: Line) => {
    if (line.item_id === "") return { ladder: undefined, levels: [] as PackLevel[] };
    const ladder = laddersForBrand(packable(packOptions.data?.[Number(line.item_id)]),
                                   line.combo?.brand_id)[0];
    const levels = ladder && !ladder.unmapped_usages?.includes("INDENT")
      ? levelsFor(ladder, "INDENT").filter((lv) => lv.level > 0) : [];
    return { ladder, levels };
  };
  // Each item's brand / variant / model combinations that are on (2026-10-23).
  const comboOptions = useCombinationOptions(lines.map((line) => Number(line.item_id) || 0));
  const [error, setError] = useState<string | null>(null);
  const [bomPickerOpen, setBomPickerOpen] = useState(false);
  const [bomNotice, setBomNotice] = useState<string | null>(null);
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const today = localDateString();
  const requiredDateError = !requiredDate
    ? REQUIRED_DATE_MANDATORY_ERROR
    : requiredDate < today
      ? PAST_REQUIRED_DATE_ERROR
      : null;
  const visibleRequiredDateError = hasAttemptedSubmit ? requiredDateError : null;

  const showRequiredDateNotice = () => {
    toast.warning(requiredDate ? REQUIRED_DATE_PAST_NOTICE : REQUIRED_DATE_MISSING_NOTICE);
    requestAnimationFrame(() => {
      const field = document.getElementById("indent-required-date");
      field?.scrollIntoView({ behavior: "smooth", block: "center" });
      field?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    if (requiredDateError === REQUIRED_DATE_MANDATORY_ERROR) {
      toast.dismiss("warning", REQUIRED_DATE_PAST_NOTICE);
      return;
    }
    if (requiredDateError === PAST_REQUIRED_DATE_ERROR) {
      toast.dismiss("warning", REQUIRED_DATE_MISSING_NOTICE);
      return;
    }
    toast.dismiss("warning", REQUIRED_DATE_MISSING_NOTICE);
    toast.dismiss("warning", REQUIRED_DATE_PAST_NOTICE);
  }, [requiredDateError, toast]);

  // The narrowed picker, not the whole item master: an item tagged to another role or
  // region is not offered here. Until an administrator tags something this returns
  // exactly what the master returned, so nothing changes on deploy.
  const { data: items = [], error: itemCatalogError } = useQuery({
    queryKey: indentKeys.items(accountScope, "form-eligible"),
    queryFn: () => indentApi.eligibleItems(),
  });

  const { data: offices = [] } = useQuery({
    queryKey: indentKeys.offices(accountScope),
    queryFn: () => indentApi.offices(),
    enabled: !isEditing,
  });

  // What the raiser's own point IS (2026-10-29). A warehouse or an MDP is a building
  // goods are trucked INTO by the sender — it runs no vehicle of its own and carries no
  // service area code — so the form stops asking for either there. Only an LIP (or a
  // point we cannot read) keeps them. Read once; a login without stock.view has no
  // answer, and the fields stay exactly as they were.
  const { can } = useAuth();
  const { data: myPoint } = useQuery({
    queryKey: ["indent-form", "my-point", accountScope],
    queryFn: getMyStockingPoints,
    enabled: can?.("stock.view") ?? false,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const pointType = (myPoint?.point_type ?? "").toUpperCase();

  // The points this STR may name as its source: the same rank on the same tier,
  // network-wide, less the raiser's own — served, never worked out here.
  const { data: strSources = [], isLoading: isSourcesLoading } = useQuery({
    queryKey: indentKeys.strSources(accountScope),
    queryFn: () => indentApi.strSources(),
    enabled: isStr,
    staleTime: 5 * 60_000,
  });

  const { data: vehicles = [], isLoading: isVehiclesLoading } = useQuery({
    queryKey: indentKeys.vehicles(accountScope),
    queryFn: () => indentApi.vehicles(),
  });

  const {
    data: draft,
    isLoading: isDraftLoading,
    error: draftLoadError,
  } = useQuery({
    queryKey: indentKeys.detail(accountScope, editId ?? 0),
    queryFn: () => indentApi.get(editId!),
    enabled: isEditing,
  });
  const hasExistingIndent = (editId !== null && Number.isFinite(editId)) || Boolean(draft?.id);

  const canEditLoadedIndent = Boolean(
    draft
    && (
      draft.status === INDENT_STATUS.DRAFT
      || (
        draft.status === INDENT_STATUS.RETURNED_FOR_CORRECTION
        && draft.can_edit_correction
      )
    ),
  );
  const isCorrectionEdit = Boolean(
    draft?.status === INDENT_STATUS.RETURNED_FOR_CORRECTION
    && draft.can_edit_correction,
  );

  useEffect(() => {
    if (!draft || !canEditLoadedIndent || initializedDraftId.current === draft.id) return;
    initializedDraftId.current = draft.id;
    setPriority(draft.priority || "NORMAL");
    setIndentType((draft.indent_type as IndentType) || INDENT_TYPE.REGULAR);
    setVehicleId(draft.vehicle_id ?? "");
    setSourceId(draft.source_warehouse_id ?? "");
    setScope(docNumberValueFrom(draft));
    setRequiredDate(draft.required_date ?? "");
    setRemarks(draft.remarks ?? "");
    setDeliveryOfficeId(draft.office_id ?? "");
    setLines(draft.items.map((item) => ({
      item_id: item.item_id,
      quantity: Number(item.quantity),
      combo: {
        brand_id: item.brand_id || null, variant_id: item.variant_id || null,
        model_id: item.model_id || null, brand_name: item.brand_name ?? null,
        variant_name: item.variant_name ?? null, model_name: item.model_name ?? null,
        combination_any: !!item.combination_any,
      },
    })));
  }, [canEditLoadedIndent, draft]);

  // Replenishment sends a shortage here as ?item_id=&quantity=. Guarded rather than
  // trusted: a non-numeric or non-positive id prefills nothing, and an unusable
  // quantity leaves the box EMPTY rather than writing a zero — a zero reads as a
  // decision somebody made. The key is the parameters themselves, so it runs once and
  // never fights the user's own edits on a re-render; editing is left alone entirely.
  useEffect(() => {
    if (isEditing) return;
    const itemParam = searchParams.get("item_id");
    const quantityParam = searchParams.get("quantity");
    const prefillKey = `${itemParam ?? ""}:${quantityParam ?? ""}`;
    if (initializedPrefill.current === prefillKey) return;

    const itemId = Number(itemParam);
    if (!Number.isFinite(itemId) || itemId <= 0) return;

    const quantity = Number(quantityParam);
    initializedPrefill.current = prefillKey;
    setLines([{
      item_id: itemId,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : "",
    }]);
  }, [isEditing, searchParams]);

  // An indent saved before organisations keeps its fields and its number as they were.
  const olderDraft = isEditing && Boolean(draft) && !draft?.organization_id;

  // A NEW document opens on what HCM fixes, then the card fills the rest (organisation,
  // year, and a project only when HCM fixes nothing).
  useEffect(() => {
    if (isEditing || scopeReady || !numberCard.data) return;
    setScope((current) => ({ ...current, ...raiserScope(numberCard.data!).patch }));
    setScopeReady(true);
  }, [isEditing, numberCard.data, scopeReady]);

  const payload = (): IndentCreate => ({
    ...(olderDraft ? {} : docNumberPayload(scope)),
    priority,
    indent_type: indentType,
    vehicle_id: hideVehicleAndSac || resolvedVehicleId === "" ? null : Number(resolvedVehicleId),
    ...(isStr ? { source_warehouse_id: sourceId === "" ? null : Number(sourceId) } : {}),
    required_date: requiredDate || null,
    remarks: remarks || null,
    items: lines
      .filter((l) => l.item_id !== "" && l.quantity !== "" && Number(l.quantity) > 0)
      .map((l) => ({
        item_id: Number(l.item_id), quantity: Number(l.quantity),
        // Only an item that HAS combinations says which (or Any); one with none sends
        // the line exactly as before.
        ...(comboOptions.data?.[String(l.item_id)]?.length ? {
          brand_id: l.combo?.combination_any ? null : l.combo?.brand_id ?? null,
          variant_id: l.combo?.combination_any ? null : l.combo?.variant_id ?? null,
          model_id: l.combo?.combination_any ? null : l.combo?.model_id ?? null,
          combination_any: !l.combo?.brand_id || !!l.combo?.combination_any,
        } : {}),
      })),
  });

  const updatePayload = (): IndentUpdate => ({
    ...payload(),
    office_id: draft?.office_id ?? null,
  });

  const save = useMutation({
    mutationFn: () => isEditing
      ? indentApi.update(editId!, updatePayload())
      : indentApi.create(payload()),
    onSuccess: (indent) => {
      qc.invalidateQueries({ predicate: isIndentModuleQuery });
      nav(`${indentBase(indent.indent_type)}/${indent.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((current) => clearResolvedDuplicateErrors(
      current.map((line, index) => (index === i ? { ...line, ...patch } : line)),
    ));
  const setLineItem = (i: number, value: number | "") =>
    setLines((current) => {
      // The same item may be added again, in another combination (2026-10-23): it
      // starts on the first one no other line of the item has taken, else on Any.
      const options = value === "" ? [] : comboOptions.data?.[String(value)] ?? [];
      // An item with no combinations on another line is the plain duplicate it always was.
      if (value !== "" && !options.length
          && current.some((line, index) => index !== i && line.item_id === value)) {
        return current.map((line, index) =>
          index === i ? { ...line, duplicateItemId: value } : line);
      }
      const taken = new Set(current
        .filter((line, index) => index !== i && line.item_id === value)
        .map((line) => lineKey(line)));
      const free = taken.size
        ? options.find((o) => !taken.has(`${value}|${combinationKey(o)}`))
        : undefined;
      const updated: Line[] = current.map((line, index) => {
        if (index !== i) return line;
        const validLine = { ...line };
        delete validLine.duplicateItemId;
        return value === ""
          ? { ...validLine, item_id: "", quantity: "", combo: undefined }
          : { ...validLine, item_id: value,
              combo: free ? pickCombination(free) : pickCombination(null, true) };
      });
      return clearResolvedDuplicateErrors(updated);
    });
  const rejectDuplicateItem = (i: number, itemId: number) =>
    setLines((current) => current.map((line, index) =>
      index === i ? { ...line, duplicateItemId: itemId } : line));
  const removeLine = (i: number) =>
    setLines((current) => clearResolvedDuplicateErrors(
      current.filter((_, index) => index !== i),
    ));
  const addTemplateItems = (templateItems: TemplateLineItem[], unavailableCount: number) => {
    const existingIds = new Set(
      lines.filter((line) => line.item_id !== "").map((line) => Number(line.item_id)),
    );
    const newItems = templateItems.filter((item) => !existingIds.has(item.item_id));
    const duplicateCount = templateItems.length - newItems.length;

    if (newItems.length > 0) {
      setLines((current) => {
        const retained = current.filter((line) => line.item_id !== "");
        const imported: Line[] = newItems.map((item) => ({
          item_id: item.item_id,
          quantity: item.quantity != null && Number(item.quantity) > 0
            ? Number(item.quantity)
            : "",
        }));
        return clearResolvedDuplicateErrors([
          ...retained,
          ...imported,
        ]);
      });
    }

    const notices = [];
    if (duplicateCount > 0) notices.push("Some items were already added and were skipped.");
    if (unavailableCount > 0) {
      notices.push(
        `${unavailableCount} unavailable ${unavailableCount === 1 ? "item was" : "items were"} skipped.`,
      );
    }
    setBomNotice(notices.join(" ") || `${newItems.length} ${newItems.length === 1 ? "item" : "items"} added.`);
  };
  const hasSelectedItems = lines.some((line) => line.item_id !== "");
  const duplicateRows = duplicateItemRows(lines);
  const hasDuplicateError = duplicateRows.size > 0
    || lines.some((line) => line.duplicateItemId !== undefined);
  // A row is missing its quantity when an item is selected but qty is empty, zero, or negative.
  const missingQtyRows = new Set<number>(
    lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.item_id !== "" && (line.quantity === "" || Number(line.quantity) <= 0))
      .map(({ i }) => i),
  );
  const hasMissingQtyError = missingQtyRows.size > 0;

  const itemOptions = items.map((it) => ({ value: it.id, label: `${it.code} — ${it.name}` }));
  /** The office this indent delivers to, for display only.
   *
   *  An existing indent shows what it was raised against; a new one shows the office
   *  the raiser's position carries. The master list is the last resort — the position
   *  snapshot can name an office the offices endpoint does not return. */
  const rawDeliveryOfficeName = hasExistingIndent
    ? (draft?.office_name ?? "—")
    : (me?.active_position?.office_name
      ?? me?.employee.office_name
      ?? offices.find((office) => office.id === deliveryOfficeId)?.name
      ?? "No office assigned to your position");
  const delivery = splitDeliveryOffice(rawDeliveryOfficeName, draft?.vehicle_number);
  const inferredVehicle = delivery.vehicleNumber
    ? vehicles.find((vehicle) =>
      comparableVehicleNumber(vehicle.name || vehicle.code)
      === comparableVehicleNumber(delivery.vehicleNumber))
    : undefined;
  const resolvedVehicleId = vehicleId === "" ? (inferredVehicle?.id ?? "") : vehicleId;
  const vehicleNumber = draft?.vehicle_number
    ?? vehicles.find((vehicle) => vehicle.id === resolvedVehicleId)?.name
    ?? delivery.vehicleNumber
    ?? "No vehicle assigned to your delivery location";
  /** The delivery office's service area code, matched by office id rather than taken
   *  from the active position.
   *
   *  An indent being edited can name an office the raiser does not sit at, and the
   *  SAC of the office they happen to be posted to now would be the wrong code
   *  against that indent. Matching on the id means an office we hold no SAC for
   *  reads as absent instead of borrowing someone else's. */
  /** A Warehouse / MDP delivery point asks for neither a vehicle nor a SAC. A draft
   *  that already carries a vehicle keeps showing it — hiding a value that is saved on
   *  the document would be hiding the document. */
  // The tier is served (2026-11-04): the draft's own delivery point when there is one,
  // else the raiser's point. No point type is compared by name here.
  const needsVehicleAndSac = draft?.needs_vehicle_and_sac ?? myPoint?.needs_vehicle_and_sac;
  const hideVehicleAndSac = needsVehicleAndSac === false && !draft?.vehicle_number;
  const pointLabel = myPoint?.point_label ?? (pointType || "Warehouse");
  const sourceMissing = isStr && sourceId === "";
  const showSourceError = hasAttemptedSubmit && sourceMissing;
  const sourceOptions = strSources.map((point) => {
    const held = (point.held_by ?? []).filter(Boolean);
    return {
      value: point.warehouse_id,
      label: [
        point.warehouse_name ?? `Point ${point.warehouse_id}`,
        point.warehouse_code ? `· ${point.warehouse_code}` : "",
        held.length ? `— ${held.slice(0, 2).join(", ")}${held.length > 2 ? ` +${held.length - 2}` : ""}` : "",
      ].filter(Boolean).join(" "),
    };
  });
  // A draft whose saved source is no longer offered still shows it, rather than a
  // blank box that reads as "nothing chosen".
  if (isStr && sourceId !== "" && !sourceOptions.some((o) => o.value === sourceId)
      && draft?.source_warehouse_name) {
    sourceOptions.unshift({ value: sourceId, label: draft.source_warehouse_name });
  }
  const chosenSource = strSources.find((point) => point.warehouse_id === sourceId);
  const officeSac = draft?.office_sac?.trim()
    || (deliveryOfficeId === ""
      ? null
      : (me?.active_position?.office_id === deliveryOfficeId
        ? me.active_position.office_sac
        : me?.employee.office_id === deliveryOfficeId
          ? me.employee.office_sac
          : me?.positions.find((position) => position.office_id === deliveryOfficeId)
            ?.office_sac) ?? null);

  if (isEditing && isDraftLoading) return <Skeleton className="h-40 rounded-2xl" />;

  if (isEditing && (draftLoadError || !draft)) {
    return (
      <Card>
        <CardBody className="gap-4 p-5">
          <p className="text-sm font-semibold text-bad">
            {draftLoadError instanceof Error ? draftLoadError.message : `Could not load this ${docLabel}.`}
          </p>
          <Button variant="secondary" onClick={() => nav(detailPath(editId!))}>Back to {docLabel}</Button>
        </CardBody>
      </Card>
    );
  }

  if (isEditing && draft && !canEditLoadedIndent) {
    return (
      <Card>
        <CardBody className="gap-4 p-5">
          <p className="text-sm font-semibold text-body">
            {draft.status === INDENT_STATUS.RETURNED_FOR_CORRECTION
              ? "This indent is not available for correction editing."
              : "Only Draft indents can be edited."}
          </p>
          <Button variant="secondary" onClick={() => nav(detailPath(editId!))}>Back to {docLabel}</Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        back={isStr ? { to: STR_HOME, label: "Back to Stock Transfer" }
          : { to: "/indents", label: "Back to All indents" }}
        eyebrow={isStr ? "Stock Transfer" : "Indents"}
        title={isCorrectionEdit
          ? `Edit correction ${draft?.indent_no ?? docLabel}`
          : isEditing ? `Edit ${draft?.indent_no ?? docLabel}`
            : isStr ? "New stock transfer request" : "New request"}
        actions={!isEditing ? (
          <Button variant="primary" onClick={() => setBomPickerOpen(true)} className={TONE_AMBER}>
            <LibraryBig className="h-4 w-4" /> Choose BOM
          </Button>
        ) : undefined}
      />

      {!olderDraft && (
        <div className="mb-5">
          <DocumentNumberCard
            docType={numberDocType} value={scope}
            onChange={(patch) => setScope((current) => ({ ...current, ...patch }))}
            ready={scopeReady} locks={raiser.locks} exclusive defaultProject={!raiser.locks.project}
            showInvalid={hasAttemptedSubmit}
            savedNumber={isEditing ? draft?.indent_no ?? null : null}
          />
        </div>
      )}

      {bomNotice && (
        <div className="mb-4 rounded-xl bg-ok-bg px-4 py-3 text-sm font-medium text-ok" role="status">
          {bomNotice}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Line items</h2>
            <div className="space-y-3">
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => Number(it.id) === Number(line.item_id));
                const duplicateItemId = line.duplicateItemId ?? duplicateRows.get(i);
                const duplicateErrorId = `indent-item-${i}-duplicate-error`;
                const missingQtyErrorId = `indent-item-${i}-qty-error`;
                const showMissingQtyError = hasAttemptedSubmit && missingQtyRows.has(i);
                const uom = displayUom(selectedItem?.uom_code)
                  || (selectedItem ? UOM_UNAVAILABLE : "");
                const quantityLabel = selectedItem
                  ? `Quantity (${uom})`
                  : "Quantity";
                // An item already on the indent stays pickable: another line of it is
                // another brand / variant / model (2026-10-23).
                const rowItemOptions = itemOptions.map((option) => ({
                  ...option,
                  isDisabled: option.value !== line.item_id
                    && !comboOptions.data?.[String(option.value)]?.length
                    && lines.some((other, otherIndex) =>
                      otherIndex !== i && other.item_id === option.value),
                }));
                const rowCombos = line.item_id === ""
                  ? undefined : comboOptions.data?.[String(line.item_id)];
                return (
                  <div key={i}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px] sm:items-end">
                      <Field label={i === 0 ? "Item" : ""} required={i === 0}>
                        <ItemCombobox
                          placeholder="Type item code or name…"
                          value={line.item_id}
                          onChange={(value) => setLineItem(i, value)}
                          onDisabledSelect={(itemId) => rejectDuplicateItem(i, itemId)}
                          options={rowItemOptions}
                          isInvalid={duplicateItemId !== undefined}
                          errorId={duplicateErrorId}
                        />
                      </Field>
                      <Field label={i === 0 ? "Qty" : ""} required={i === 0}>
                        <Input
                          type="number"
                          data-uom={uom ?? ""}
                          min={0}
                          step="0.001"
                          aria-label={quantityLabel}
                          aria-invalid={showMissingQtyError ? "true" : undefined}
                          aria-describedby={showMissingQtyError ? missingQtyErrorId : undefined}
                          disabled={line.item_id === ""}
                          placeholder={line.item_id === "" ? "—" : undefined}
                          className={`${NO_SPINNER}${line.item_id === "" ? " [&_input]:text-center" : ""}`}
                          value={String(line.quantity)}
                          onChange={(e) => setLine(i, { quantity: e.target.value ? Number(e.target.value) : "" })}
                          {...NO_SILENT_STEPPING}
                          isInvalid={showMissingQtyError}
                          {...(uom ? {
                            endContent: (
                              <span
                                className="pointer-events-none inline-flex min-w-[2.5rem] shrink-0 items-center justify-end whitespace-nowrap pl-2 text-xs font-medium text-muted"
                                title={uom}
                              >
                                {uom}
                              </span>
                            ),
                          } : {})}
                        />
                      </Field>
                      <button
                        onClick={() => removeLine(i)}
                        disabled={lines.length === 1}
                        className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-bad-bg hover:text-bad disabled:opacity-30"
                        aria-label="Remove line"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {(() => {
                      const { ladder, levels } = indentContainers(line);
                      if (!ladder || !levels.length) return null;
                      const level = levels.find((lv) => lv.level === line.packLevel) ?? levels[levels.length - 1];
                      const count = line.packLevel === level.level ? line.packCount ?? "" : "";
                      return (
                        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px] sm:items-end">
                          <Field label="Indent in">
                            <Select
                              value={level.level}
                              ariaLabel={`Indent container for line ${i + 1}`}
                              options={levels.map((lv) => ({
                                value: lv.level,
                                label: `${lv.name} · ${fmtQty(lv.size)} ${uom}`,
                              }))}
                              onChange={(v) => setLine(i, { packLevel: Number(v), packCount: "" })}
                            />
                          </Field>
                          <Field label={`No. of ${level.name}`}>
                            <Input
                              type="number" min={0} step="1"
                              data-decimals={0}
                              aria-label={`Number of ${level.name}`}
                              className={NO_SPINNER}
                              value={String(count)}
                              {...NO_SILENT_STEPPING}
                              onChange={(e) => {
                                const n = e.target.value ? Math.max(0, Math.floor(Number(e.target.value))) : "";
                                setLine(i, { packLevel: level.level, packCount: n,
                                             quantity: n === "" ? "" : n * level.size });
                              }}
                            />
                          </Field>
                          <span className="pb-3 text-xs text-muted tabular">
                            {count !== "" ? `= ${fmtQty(Number(count) * level.size)}` : ""}
                          </span>
                        </div>
                      );
                    })()}
                    {!!rowCombos?.length && (
                      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px]">
                        <Field label="Brand · variant · model">
                          <CombinationPicker
                            options={rowCombos}
                            value={line.combo ?? pickCombination(null, true)}
                            allowAny
                            invalid={duplicateItemId !== undefined}
                            ariaLabel={`Brand, variant and model for line ${i + 1}`}
                            onChange={(combo) => setLine(i, { combo })}
                          />
                        </Field>
                      </div>
                    )}
                    {duplicateItemId !== undefined && (
                      <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px]">
                        <span
                          id={duplicateErrorId}
                          className="block text-xs font-medium text-bad"
                        >
                          {DUPLICATE_ITEM_ERROR}
                        </span>
                      </div>
                    )}
                    {showMissingQtyError && (
                      <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_44px]">
                        <div />
                        <span
                          id={missingQtyErrorId}
                          className="block text-xs font-medium text-bad"
                        >
                          {MISSING_QTY_ERROR}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => setLines((ls) => [...ls, { item_id: "", quantity: "" }])}
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-600"
            >
              <Plus className="h-4 w-4" /> Add line
            </button>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardBody className="gap-4 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Details</h2>
            {!isStr && (
              <Field label="Indent type">
                <Select
                  ariaLabel="Indent type"
                  value={indentType}
                  onChange={(v) => setIndentType((v || INDENT_TYPE.REGULAR) as IndentType)}
                  options={INDENT_TYPE_OPTIONS}
                />
              </Field>
            )}
            <Field label="Priority">
              <Select
                value={priority}
                onChange={(v) => setPriority(v || "NORMAL")}
                options={[{ value: "NORMAL", label: "Normal" }, { value: "URGENT", label: "Urgent" }]}
              />
            </Field>
            <Field label="Required date" required>
              <Input
                id="indent-required-date"
                type="date"
                min={today}
                value={requiredDate}
                required
                aria-label="Required date"
                aria-invalid={visibleRequiredDateError ? "true" : undefined}
                aria-describedby={visibleRequiredDateError ? "required-date-error" : undefined}
                isInvalid={Boolean(visibleRequiredDateError)}
                onChange={(e) => setRequiredDate(e.target.value)}
              />
              {visibleRequiredDateError && (
                <span id="required-date-error" className="mt-1 block text-xs font-medium text-bad">
                  {visibleRequiredDateError}
                </span>
              )}
            </Field>
            <Field label="Raised as">
              <Input value={me?.active_position?.name ?? "No position assigned"} disabled />
            </Field>
            {/* Read-only, like "Raised as" above it. Where the goods land follows the
                raiser's position — it is not theirs to choose, and letting them pick
                meant an indent could be delivered to an office they do not work at.
                The id is still submitted; only the choosing is gone. */}
            <Field label={isStr ? "Destination" : "Delivery location"}>
              <Input value={delivery.officeName} disabled />
            </Field>
            {isStr && (
              <div className={`rounded-2xl border p-3 transition-colors ${
                showSourceError ? "border-bad/50 bg-bad-bg/40" : "border-brand/25 bg-brand-050/40"}`}>
                <Field label="Source" required>
                  <Select
                    ariaLabel="Source point"
                    value={sourceId}
                    isInvalid={showSourceError}
                    isDisabled={isSourcesLoading}
                    placeholder={isSourcesLoading ? "Finding points you can transfer from…"
                      : sourceOptions.length ? "Select the point to transfer from"
                        : !me?.active_position ? "Pick a working position first"
                          : "No point to transfer from"}
                    options={sourceOptions}
                    onChange={(v) => setSourceId(v === "" ? "" : Number(v))}
                  />
                </Field>
                {showSourceError ? (
                  <p id="str-source-error" className="mt-1.5 text-xs font-medium text-bad">
                    Choose where this stock should come from.
                  </p>
                ) : chosenSource ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-body">
                    <ArrowRightLeft className="mt-px h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                    <span>
                      <b className="font-semibold text-ink">{chosenSource.warehouse_name}</b>
                      {chosenSource.tier_label ? ` · ${chosenSource.tier_label}` : ""}
                      {" "}→ <b className="font-semibold text-ink">{delivery.officeName}</b>
                    </span>
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted">
                    {strSources.length
                      ? `${strSources.length} point${strSources.length === 1 ? "" : "s"} you can transfer from. Each approver sees whether it is in their scope.`
                      : !me?.active_position
                        ? "An STR is raised as a position. Pick your working position (bottom left) to see where you can transfer from."
                        : "A warehouse transfers from other warehouses; an MDP or LIP from points held at the same level."}
                  </p>
                )}
              </div>
            )}
            {hideVehicleAndSac ? (
              <div className="flex items-start gap-2 rounded-lg border border-dashed border-line bg-content2/50 px-3 py-2.5 text-xs text-muted">
                <span className="mt-0.5 rounded bg-brand/10 px-1.5 py-px text-[10px] font-bold uppercase text-brand">
                  {pointLabel}
                </span>
                <span>
                  Delivered to {myPoint?.point_name ?? `this ${pointLabel}`} — no vehicle or
                  service area code is needed. The sending point arranges the transport.
                </span>
              </div>
            ) : (
              <>
                <Field label="Vehicle">
                  <Input value={vehicleNumber} disabled />
                </Field>
                {/* Read-only like the two above it: the SAC belongs to the delivery
                    office, so it follows that office rather than being chosen. */}
                <Field label="Service area code (SAC)">
                  <Input
                    value={officeSac ?? "No service area code for this location"}
                    disabled
                  />
                </Field>
              </>
            )}
            <Field label="Remarks">
              <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
            </Field>
          </CardBody>
        </Card>
      </div>

      {error && (
        <div className="mt-4 rounded-xl bg-bad-bg px-4 py-3 text-sm font-medium text-bad">{error}</div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
        <Button
          variant="soft"
          className={`flex-1 md:flex-none ${TONE_PINK}`}
          onClick={() => nav(isEditing ? detailPath(editId!) : isStr ? STR_HOME : "/indents")}
        >
          Cancel
        </Button>
        <Button
          className={`flex-1 md:flex-none ${TONE_MINT}`}
          disabled={
            !hasSelectedItems
            || hasDuplicateError
            || save.isPending
            || (!hideVehicleAndSac && Boolean(delivery.vehicleNumber) && isVehiclesLoading)
          }
          onClick={() => {
            setError(null);
            setHasAttemptedSubmit(true);
            if (requiredDateError) {
              showRequiredDateNotice();
              return;
            }
            if (hasMissingQtyError) return;
            if (sourceMissing) {
              toast.warning({ title: "Source is missing", message: "Choose where this stock should come from." });
              return;
            }
            const duplicates = duplicateItemRows(lines);
            if (duplicates.size) {
              setLines((current) => current.map((line, index) => {
                const duplicateItemId = duplicates.get(index);
                return duplicateItemId === undefined
                  ? line
                  : { ...line, item_id: "", duplicateItemId };
              }));
              return;
            }
            save.mutate();
          }}
        >
          {save.isPending
            ? (isEditing ? "Saving…" : "Creating…")
            : (isCorrectionEdit ? "Save correction" : isEditing ? "Save changes" : isStr ? "Create request" : "Create indent")}
        </Button>
      </div>

      {!isEditing && (
        <ChooseBomModal
          isOpen={bomPickerOpen}
          accountScope={accountScope}
          availableItems={items}
          itemCatalogError={itemCatalogError}
          onClose={() => setBomPickerOpen(false)}
          onUse={addTemplateItems}
        />
      )}
    </>
  );
}
