import { useEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LibraryBig, Plus, Trash2 } from "lucide-react";
import { CardBody, Skeleton } from "@heroui/react";
import { PageHeader, Button, Card, Field, Input, Select, useToast } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import {
  indentApi, indentKeys, isIndentModuleQuery,
  useIndentAccountCacheIsolation, useIndentAccountScope,
} from "../api";
import { ItemCombobox } from "../components/ItemCombobox";
import { ChooseBomModal } from "../components/ChooseBomModal";
import { INDENT_STATUS, INDENT_TYPE, INDENT_TYPE_OPTIONS } from "../constants";
import {
  comparableVehicleNumber, displayUom, splitDeliveryOffice,
} from "../displayFormat";
import type { IndentCreate, IndentType, IndentUpdate, TemplateLineItem } from "../types";
import { TONE_AMBER, TONE_MINT, TONE_PINK } from "../buttonTones";

interface Line {
  item_id: number | "";
  quantity: number | "";
  duplicateItemId?: number;
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
  const seen = new Set<number>();
  const duplicates = new Map<number, number>();
  lines.forEach((line, index) => {
    if (line.item_id === "") return;
    const itemId = Number(line.item_id);
    if (seen.has(itemId)) duplicates.set(index, itemId);
    seen.add(itemId);
  });
  return duplicates;
}

function clearResolvedDuplicateErrors(lines: Line[]) {
  return lines.map((line, index) => {
    if (
      line.duplicateItemId === undefined
      || lines.some((other, otherIndex) =>
        otherIndex !== index && other.item_id === line.duplicateItemId)
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
  const [priority, setPriority] = useState("NORMAL");
  const [indentType, setIndentType] = useState<IndentType>(INDENT_TYPE.REGULAR);
  const [vehicleId, setVehicleId] = useState<number | "">("");
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [deliveryOfficeId, setDeliveryOfficeId] = useState<number | "">(
    me?.active_position?.office_id ?? me?.employee.office_id ?? "",
  );
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
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
    setRequiredDate(draft.required_date ?? "");
    setRemarks(draft.remarks ?? "");
    setDeliveryOfficeId(draft.office_id ?? "");
    setLines(draft.items.map((item) => ({
      item_id: item.item_id,
      quantity: Number(item.quantity),
    })));
  }, [canEditLoadedIndent, draft]);

  const payload = (): IndentCreate => ({
    priority,
    indent_type: indentType,
    vehicle_id: resolvedVehicleId === "" ? null : Number(resolvedVehicleId),
    required_date: requiredDate || null,
    remarks: remarks || null,
    items: lines
      .filter((l) => l.item_id !== "" && l.quantity !== "" && Number(l.quantity) > 0)
      .map((l) => ({ item_id: Number(l.item_id), quantity: Number(l.quantity) })),
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
      nav(`/indents/${indent.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((current) => clearResolvedDuplicateErrors(
      current.map((line, index) => (index === i ? { ...line, ...patch } : line)),
    ));
  const setLineItem = (i: number, value: number | "") =>
    setLines((current) => {
      if (
        value !== ""
        && current.some((line, index) => index !== i && line.item_id === value)
      ) {
        return current.map((line, index) =>
          index === i ? { ...line, duplicateItemId: value } : line);
      }
      const updated: Line[] = current.map((line, index) => {
        if (index !== i) return line;
        const validLine = { ...line };
        delete validLine.duplicateItemId;
        return value === ""
          ? { ...validLine, item_id: "", quantity: "" }
          : { ...validLine, item_id: value };
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
            {draftLoadError instanceof Error ? draftLoadError.message : "Could not load this indent."}
          </p>
          <Button variant="secondary" onClick={() => nav(`/indents/${editId}`)}>Back to indent</Button>
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
          <Button variant="secondary" onClick={() => nav(`/indents/${editId}`)}>Back to indent</Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        back={{ to: "/indents", label: "Back to All indents" }}
        eyebrow="Indents"
        title={isCorrectionEdit
          ? `Edit correction ${draft?.indent_no ?? "indent"}`
          : isEditing ? `Edit ${draft?.indent_no ?? "indent"}` : "New request"}
        actions={!isEditing ? (
          <Button variant="primary" onClick={() => setBomPickerOpen(true)} className={TONE_AMBER}>
            <LibraryBig className="h-4 w-4" /> Choose BOM
          </Button>
        ) : undefined}
      />

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
                const rowItemOptions = itemOptions.map((option) => ({
                  ...option,
                  isDisabled: option.value !== line.item_id
                    && lines.some((other, otherIndex) =>
                      otherIndex !== i && other.item_id === option.value),
                }));
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
            <Field label="Indent type">
              <Select
                ariaLabel="Indent type"
                value={indentType}
                onChange={(v) => setIndentType((v || INDENT_TYPE.REGULAR) as IndentType)}
                options={INDENT_TYPE_OPTIONS}
              />
            </Field>
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
            <Field label="Delivery location">
              <Input value={delivery.officeName} disabled />
            </Field>
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
          onClick={() => nav(isEditing ? `/indents/${editId}` : "/indents")}
        >
          Cancel
        </Button>
        <Button
          className={`flex-1 md:flex-none ${TONE_MINT}`}
          disabled={
            !hasSelectedItems
            || hasDuplicateError
            || save.isPending
            || (Boolean(delivery.vehicleNumber) && isVehiclesLoading)
          }
          onClick={() => {
            setError(null);
            setHasAttemptedSubmit(true);
            if (requiredDateError) {
              showRequiredDateNotice();
              return;
            }
            if (hasMissingQtyError) return;
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
            : (isCorrectionEdit ? "Save correction" : isEditing ? "Save changes" : "Create indent")}
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
