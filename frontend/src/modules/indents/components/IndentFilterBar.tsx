import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Check, ChevronDown, Filter, MapPin, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import {
  Button as HButton, Chip, Dropdown, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger,
} from "@heroui/react";
import {
  INDENT_QUERY_GC_TIME,
  indentApi,
  indentKeys,
  useIndentAccountScope,
} from "../api";
import {
  useIndentFilters,
  type DatePreset,
  type RequiredByPreset,
} from "../context/IndentFilterContext";
import {
  INDENT_ACTIVITY_TRANSACTION_OPTIONS,
  INDENT_PRIORITY_OPTIONS,
  INDENT_STATUS_GROUPS,
  INDENT_STATUS_OPTIONS,
} from "../constants";

type FilterMode = "indents" | "acknowledgments" | "activity" | "notifications";

interface IndentFilterBarProps {
  mode?: FilterMode;
  statusFilterOptions?: { value: string; label: string }[];
  statusFilterLabel?: string;
  singleStatusSelection?: boolean;
  separateDateFilters?: boolean;
  showRequiredBy?: boolean;
  showDate?: boolean;
  showStatus?: boolean;
  showPriority?: boolean;
  showRegion?: boolean;
  showTransaction?: boolean;
  showMovement?: boolean;
  showItem?: boolean;
  searchPlaceholder?: string;
}

type ActiveMenu = "status" | "priority" | "region" | "date" | "raisedDate" | "requiredBy" | "transaction" | "movement" | null;

/** Region/Location is nullable, so "no location" needs a filter value of its own. */
export const UNASSIGNED_REGION_LABEL = "No location";

const MOVEMENT_OPTIONS = [
  { value: "OUTWARD", label: "Outward" },
  { value: "INWARD", label: "Inward" },
];

const ACKNOWLEDGMENT_STATUS_OPTIONS = [
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "PARTIALLY_FULFILLED", label: "Partially Fulfilled" },
];

const ACKNOWLEDGMENT_STATUS_GROUPS = [{
  label: "Fulfilment",
  options: ACKNOWLEDGMENT_STATUS_OPTIONS,
}];

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "custom", label: "Custom" },
];

const RAISED_DATE_PRESETS: { key: DatePreset; label: string }[] = DATE_PRESETS.map((option) => (
  option.key === "custom" ? { ...option, label: "Custom range" } : option
));

const REQUIRED_BY_PRESETS: { key: RequiredByPreset; label: string }[] = [
  { key: "any", label: "Any date" },
  { key: "today", label: "Today" },
  { key: "next_7_days", label: "Next 7 days" },
  { key: "next_30_days", label: "Next 30 days" },
  { key: "custom", label: "Custom range" },
];

const RANGE_ERROR = "To date must be the same as or later than From date.";

function localDateValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addLocalDays(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

export function getRaisedDateRange(preset: DatePreset, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "today") {
    const value = localDateValue(today);
    return { from: value, to: value };
  }
  if (preset === "this_week") {
    const monday = addLocalDays(today, -(today.getDay() === 0 ? 6 : today.getDay() - 1));
    return { from: localDateValue(monday), to: localDateValue(today) };
  }
  if (preset === "this_month") {
    return {
      from: localDateValue(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: localDateValue(today),
    };
  }
  return { from: "", to: "" };
}

export function getRequiredByDateRange(preset: RequiredByPreset, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "today") {
    const value = localDateValue(today);
    return { from: value, to: value };
  }
  if (preset === "next_7_days") {
    return { from: localDateValue(today), to: localDateValue(addLocalDays(today, 7)) };
  }
  if (preset === "next_30_days") {
    return { from: localDateValue(today), to: localDateValue(addLocalDays(today, 30)) };
  }
  return { from: "", to: "" };
}

function formatDateForChip(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function dateChipLabel<P extends string>(
  prefix: string,
  preset: P,
  from: string,
  to: string,
  options: { key: P; label: string }[],
) {
  if (preset === "custom" && from && to) {
    return `${prefix}: ${formatDateForChip(from)} – ${formatDateForChip(to)}`;
  }
  return `${prefix}: ${options.find((option) => option.key === preset)?.label ?? preset}`;
}

interface DateRangeFilterControlProps<P extends string> {
  idPrefix: string;
  label: string;
  description: string;
  options: { key: P; label: string }[];
  neutralPreset: P;
  activePreset: P;
  activeFrom: string;
  activeTo: string;
  isActive: boolean;
  isOpen: boolean;
  resolvePreset: (preset: P) => { from: string; to: string };
  onOpenChange: (open: boolean) => void;
  onApply: (preset: P, from: string, to: string) => void;
  onClear: () => void;
  applyPresetsImmediately?: boolean;
  mobileFullWidth?: boolean;
}

function DateRangeFilterControl<P extends string>({
  idPrefix,
  label,
  description,
  options,
  neutralPreset,
  activePreset,
  activeFrom,
  activeTo,
  isActive,
  isOpen,
  resolvePreset,
  onOpenChange,
  onApply,
  onClear,
  applyPresetsImmediately = false,
  mobileFullWidth = false,
}: DateRangeFilterControlProps<P>) {
  const [draftPreset, setDraftPreset] = useState(activePreset);
  const [draftFrom, setDraftFrom] = useState(activeFrom);
  const [draftTo, setDraftTo] = useState(activeTo);
  const [rangeError, setRangeError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const isCustom = draftPreset === "custom";
  const applyDisabled = isCustom && (!draftFrom || !draftTo || Boolean(rangeError));
  const errorId = `${idPrefix}-range-error`;
  const popupId = `${idPrefix}-filter-popup`;

  useEffect(() => {
    if (isOpen) {
      setDraftPreset(activePreset);
      setDraftFrom(activeFrom);
      setDraftTo(activeTo);
      setRangeError("");
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = isOpen;
  }, [activeFrom, activePreset, activeTo, isOpen]);

  const selectPreset = (preset: P) => {
    setDraftPreset(preset);
    setRangeError("");
    if (preset === "custom") {
      if (activePreset !== preset) {
        setDraftFrom("");
        setDraftTo("");
      }
      return;
    }
    const range = resolvePreset(preset);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    if (applyPresetsImmediately) {
      if (preset === neutralPreset) onClear();
      else onApply(preset, range.from, range.to);
      onOpenChange(false);
    }
  };

  const changeFrom = (value: string) => {
    setDraftFrom(value);
    if (value && draftTo && value > draftTo) {
      setDraftTo("");
      setRangeError(RANGE_ERROR);
      return;
    }
    setRangeError(value && draftTo && value > draftTo ? RANGE_ERROR : "");
  };

  const changeTo = (value: string) => {
    setDraftTo(value);
    setRangeError(draftFrom && value && value < draftFrom ? RANGE_ERROR : "");
  };

  return (
    <div className={mobileFullWidth ? "relative min-w-0 flex-1 sm:flex-none" : "relative"}>
      <HButton
        ref={triggerRef}
        variant="bordered"
        size="sm"
        aria-expanded={isOpen}
        aria-controls={popupId}
        onClick={() => onOpenChange(!isOpen)}
        className={`h-10 border-line bg-content2 text-xs ${mobileFullWidth ? "w-full sm:w-auto" : ""} ${isActive ? "border-brand text-brand" : "text-body"}`}
        startContent={<Calendar className="h-3.5 w-3.5 text-muted" />}
        endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
      >
        {label}
      </HButton>

      {isOpen && (
        <div
          id={popupId}
          role="dialog"
          aria-label={`${label} filter`}
          className="absolute right-0 top-full z-50 mt-2 max-h-[min(75vh,36rem)] w-[calc(100vw-2rem)] max-w-96 overflow-y-auto rounded-lg border border-line bg-content1 p-4 text-xs shadow-xl sm:w-96"
        >
          <div className="mb-3 flex items-start justify-between gap-4 border-b border-line/60 pb-3">
            <div>
              <h3 className="font-semibold text-ink">{label}</h3>
              <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
            </div>
            <button
              type="button"
              aria-label={`Close ${label} filter`}
              onClick={() => onOpenChange(false)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted hover:bg-content2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {options.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => selectPreset(option.key)}
                className={`flex min-h-10 items-center justify-between rounded-lg px-3 py-2 text-left font-medium transition ${
                  draftPreset === option.key ? "bg-brand text-white" : "bg-content2 text-body hover:bg-content3"
                }`}
              >
                <span>{option.label}</span>
                {draftPreset === option.key && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>

          {isCustom && (
            <div className="mt-4 rounded-lg border border-line/60 bg-content2/70 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-date-grid`}>
                <label className="space-y-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
                  <input
                    aria-label={`${label} from`}
                    type="date"
                    value={draftFrom}
                    max={draftTo || undefined}
                    onChange={(event) => changeFrom(event.target.value)}
                    className="h-10 w-full rounded-lg border border-line bg-content1 px-2 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
                  <input
                    aria-label={`${label} to`}
                    aria-invalid={rangeError ? "true" : undefined}
                    aria-describedby={rangeError ? errorId : undefined}
                    type="date"
                    value={draftTo}
                    min={draftFrom || undefined}
                    onChange={(event) => changeTo(event.target.value)}
                    className={`h-10 w-full rounded-lg border bg-content1 px-2 text-xs text-body outline-none focus:ring-2 ${rangeError ? "border-bad focus:border-bad focus:ring-bad/20" : "border-line focus:border-brand focus:ring-brand/20"}`}
                  />
                </label>
              </div>
              {rangeError && <p id={errorId} className="mt-2 text-xs font-medium text-bad">{rangeError}</p>}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-line/60 pt-3">
            <button
              type="button"
              onClick={() => {
                onClear();
                setDraftPreset(neutralPreset);
                setDraftFrom("");
                setDraftTo("");
                setRangeError("");
                onOpenChange(false);
              }}
              className="min-h-10 rounded-lg px-4 font-semibold text-muted transition hover:bg-content2 hover:text-bad"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={applyDisabled}
              onClick={() => {
                if (applyDisabled) return;
                onApply(draftPreset, draftFrom, draftTo);
                onOpenChange(false);
              }}
              className="min-h-10 rounded-lg bg-brand px-4 font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function joinLabel(values: string[], options: { value: string; label: string }[]) {
  return values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ");
}

function primaryDateLabel(mode: FilterMode) {
  if (mode === "acknowledgments") return "Acknowledgment date";
  if (mode === "activity") return "Activity date";
  if (mode === "notifications") return "Notification date";
  return "Raised date";
}

function dateDescription(mode: FilterMode) {
  if (mode === "activity") return "When the activity happened.";
  if (mode === "notifications") return "When the notification was created.";
  return "When the indent was created or raised.";
}

export function IndentFilterBar({
  mode = "indents",
  statusFilterOptions,
  statusFilterLabel,
  singleStatusSelection = false,
  separateDateFilters = false,
  showRequiredBy = true,
  showDate = true,
  showStatus = true,
  showPriority = true,
  // Only the screens that filter over indents themselves: acknowledgments and
  // notifications read from wf_actions, which carries no region.
  showRegion = mode === "indents" || mode === "activity",
  showTransaction = mode === "activity",
  showMovement = false,
  showItem = mode === "activity",
  searchPlaceholder = "Search indents...",
}: IndentFilterBarProps) {
  const {
    search,
    setSearch,
    datePreset,
    setDatePreset,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    requiredByFrom,
    setRequiredByFrom,
    requiredByTo,
    setRequiredByTo,
    requiredByPreset,
    applyRaisedDate,
    clearRaisedDate,
    applyRequiredByDate,
    clearRequiredByDate,
    selectedStatuses,
    setSelectedStatuses,
    selectedPriorities,
    togglePriority,
    selectedRegions,
    setSelectedRegions,
    toggleRegion,
    includeUnassignedRegion,
    setIncludeUnassignedRegion,
    transactionType,
    setTransactionType,
    direction,
    setDirection,
    itemId,
    setItemId,
    resetFilters,
    activeFilterCount,
  } = useIndentFilters();

  const accountScope = useIndentAccountScope();
  // The options are the locations present on the caller's own indents, so they change
  // about as often as the org chart does — cached for the session, never refetched on
  // a filter change.
  const { data: regionOptions = [] } = useQuery({
    queryKey: indentKeys.regions(accountScope),
    queryFn: () => indentApi.regions(),
    enabled: showRegion,
    staleTime: Infinity,
    gcTime: INDENT_QUERY_GC_TIME,
  });
  const regionNameById = useMemo(
    () => new Map(regionOptions.map((option) => [option.id, option.name])),
    [regionOptions],
  );
  const regionFilterCount = selectedRegions.length + (includeUnassignedRegion ? 1 : 0);

  const [localSearch, setLocalSearch] = useState(search);
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [showRequiredByRange, setShowRequiredByRange] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const hasDateFilter = datePreset !== "all" || Boolean(startDate) || Boolean(endDate);
  const hasRequiredByFilter = Boolean(requiredByFrom) || Boolean(requiredByTo);
  const hasAnyDateFilter = hasDateFilter || hasRequiredByFilter;
  const hasMoreFilters = Boolean(showTransaction || showMovement || showItem);
  const activeMoreFilterCount = (
    (showTransaction && transactionType ? 1 : 0)
    + (showMovement && direction ? 1 : 0)
    + (showItem && itemId ? 1 : 0)
  );
  const dateLabel = primaryDateLabel(mode);
  const isSimplePageFilter = mode === "activity" || mode === "notifications";
  const statusLabel = statusFilterLabel ?? (isSimplePageFilter ? "Indent status" : "Status");
  const searchAriaLabel = mode === "notifications"
      ? "Search notifications"
      : "Search indents";
  const statusGroups = mode === "acknowledgments"
    ? ACKNOWLEDGMENT_STATUS_GROUPS
    : INDENT_STATUS_GROUPS;
  const statusOptions = mode === "acknowledgments"
    ? ACKNOWLEDGMENT_STATUS_OPTIONS
    : statusFilterOptions ?? INDENT_STATUS_OPTIONS;
  const applyStatuses = (values: string[]) => {
    if (isSimplePageFilter && localSearch !== search) setSearch(localSearch);
    setSelectedStatuses(values);
  };

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  useEffect(() => {
    if (localSearch === search) return;
    const timer = window.setTimeout(() => setSearch(localSearch), 300);
    return () => window.clearTimeout(timer);
  }, [localSearch, search, setSearch]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setActiveMenu(null);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (hasRequiredByFilter) setShowRequiredByRange(true);
  }, [hasRequiredByFilter]);

  return (
    <section ref={containerRef} className="mb-5 rounded-lg border border-line/70 bg-content1 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className={isSimplePageFilter
          ? "relative min-w-0 flex-1 basis-full sm:min-w-[220px] sm:basis-72"
          : "relative min-w-[220px] flex-1 basis-72"}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label={searchAriaLabel}
            value={localSearch}
            onChange={(event) => setLocalSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-10 w-full rounded-lg border border-line bg-content2 pl-9 pr-9 text-sm text-ink outline-none transition [&::-webkit-search-cancel-button]:hidden focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          {localSearch && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setLocalSearch("");
                setSearch("");
              }}
              className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-content3 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className={isSimplePageFilter
          ? "flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"
          : "ml-auto flex flex-wrap items-center gap-2"}
        >
        {showDate && separateDateFilters && (
          <DateRangeFilterControl
            idPrefix={mode === "activity" ? "activity" : mode === "notifications" ? "notification" : "raised"}
            label={dateLabel}
            description={dateDescription(mode)}
            options={RAISED_DATE_PRESETS}
            neutralPreset="all"
            activePreset={datePreset}
            activeFrom={startDate}
            activeTo={endDate}
            isActive={hasDateFilter}
            isOpen={activeMenu === "raisedDate"}
            resolvePreset={getRaisedDateRange}
            onOpenChange={(open) => setActiveMenu(open ? "raisedDate" : null)}
            onApply={applyRaisedDate}
            onClear={clearRaisedDate}
            applyPresetsImmediately={isSimplePageFilter}
            mobileFullWidth={isSimplePageFilter}
          />
        )}

        {showDate && showRequiredBy && separateDateFilters && (
          <DateRangeFilterControl
            idPrefix="required-by"
            label="Required by"
            description="When the requester needs the items."
            options={REQUIRED_BY_PRESETS}
            neutralPreset="any"
            activePreset={requiredByPreset}
            activeFrom={requiredByFrom}
            activeTo={requiredByTo}
            isActive={hasRequiredByFilter}
            isOpen={activeMenu === "requiredBy"}
            resolvePreset={getRequiredByDateRange}
            onOpenChange={(open) => setActiveMenu(open ? "requiredBy" : null)}
            onApply={applyRequiredByDate}
            onClear={clearRequiredByDate}
          />
        )}

        {showDate && !separateDateFilters && (
        <div className="relative">
          <HButton
            variant="bordered"
            size="sm"
            onClick={() => setActiveMenu((current) => (current === "date" ? null : "date"))}
            className={`h-10 border-line bg-content2 text-xs ${hasAnyDateFilter ? "border-brand text-brand" : "text-body"}`}
            startContent={<Calendar className="h-3.5 w-3.5 text-muted" />}
            endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
          >
            Date{hasAnyDateFilter ? " *" : ""}
          </HButton>

          {activeMenu === "date" && (
            <div className="absolute left-0 top-full z-50 mt-2 max-h-[min(75vh,34rem)] w-[calc(100vw-2rem)] max-w-80 overflow-y-auto rounded-lg border border-line bg-content1 p-4 text-xs shadow-xl sm:w-80">
              <div className="mb-3 flex items-center justify-between border-b border-line/60 pb-2">
                <span className="font-semibold uppercase tracking-wider text-muted">{dateLabel}</span>
                <button
                  type="button"
                  aria-label="Close date filters"
                  onClick={() => setActiveMenu(null)}
                  className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-content2 hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {DATE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => {
                      const isSelected = datePreset === preset.key;
                      setDatePreset(preset.key);
                      if (preset.key !== "custom" || isSelected) {
                        setActiveMenu(null);
                      }
                    }}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-left font-medium transition ${
                      datePreset === preset.key ? "bg-brand text-white" : "bg-content2 text-body hover:bg-content3"
                    }`}
                  >
                    <span>{preset.label}</span>
                    {datePreset === preset.key && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>

              {datePreset === "custom" && (
                <div className="mt-4 rounded-lg border border-line/60 bg-content2/70 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
                      <input
                        aria-label={`${dateLabel.replace(" date", "")} from date`}
                        type="date"
                        value={startDate}
                        onChange={(event) => setStartDate(event.target.value)}
                        className="h-9 w-full rounded-lg border border-line bg-content1 px-2 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
                      <input
                        aria-label={`${dateLabel.replace(" date", "")} to date`}
                        type="date"
                        value={endDate}
                        onChange={(event) => setEndDate(event.target.value)}
                        className="h-9 w-full rounded-lg border border-line bg-content1 px-2 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </label>
                  </div>
                </div>
              )}

              {showRequiredBy && (
                <button
                  type="button"
                  aria-pressed={showRequiredByRange}
                  onClick={() => {
                    if (showRequiredByRange) {
                      setRequiredByFrom("");
                      setRequiredByTo("");
                      setShowRequiredByRange(false);
                    } else {
                      setShowRequiredByRange(true);
                    }
                  }}
                  className="mt-4 flex w-full items-center justify-between rounded-lg border border-dashed border-line bg-content2 px-3 py-2 text-left text-xs font-semibold text-brand transition hover:border-brand hover:bg-content3"
                >
                  <span>Add required-by filter</span>
                  {hasRequiredByFilter && <span aria-hidden="true" title="Required-by filter active" className="h-2 w-2 rounded-full bg-brand" />}
                </button>
              )}

              {showRequiredBy && showRequiredByRange && (
                <div className="mt-4 border-t border-line/60 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold uppercase tracking-wider text-muted">Required-by date</span>
                    {hasRequiredByFilter && (
                      <button
                        type="button"
                        onClick={() => {
                          setRequiredByFrom("");
                          setRequiredByTo("");
                        }}
                        className="text-[11px] font-semibold text-brand hover:text-brand-600"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
                      <input
                        aria-label="Required by from"
                        type="date"
                        value={requiredByFrom}
                        onChange={(event) => setRequiredByFrom(event.target.value)}
                        className="h-9 w-full rounded-lg border border-line bg-content2 px-2 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
                      <input
                        aria-label="Required by to"
                        type="date"
                        value={requiredByTo}
                        onChange={(event) => setRequiredByTo(event.target.value)}
                        className="h-9 w-full rounded-lg border border-line bg-content2 px-2 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        )}

        {showStatus && (
          <Dropdown
            isOpen={activeMenu === "status"}
            onOpenChange={(open) => setActiveMenu(open ? "status" : null)}
            closeOnSelect={false}
          >
            <DropdownTrigger>
              <HButton
                variant="bordered"
                size="sm"
                className={`h-10 border-line bg-content2 text-xs ${selectedStatuses.length ? "border-brand text-brand" : "text-body"}`}
                startContent={<Filter className="h-3.5 w-3.5 text-muted" />}
                endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
              >
                {statusLabel}{selectedStatuses.length ? ` (${selectedStatuses.length})` : ""}
              </HButton>
            </DropdownTrigger>
            <DropdownMenu aria-label={`${statusLabel} filters`}>
              {statusFilterOptions
                ? statusFilterOptions.map((option) => {
                    const selected = selectedStatuses.includes(option.value);
                    return (
                      <DropdownItem
                        key={option.value}
                        onPress={() => {
                          applyStatuses(
                            selected
                              ? selectedStatuses.filter((status) => status !== option.value)
                              : singleStatusSelection
                                ? [option.value]
                              : [...selectedStatuses, option.value],
                          );
                        }}
                        startContent={selected ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                      >
                        {option.label}
                      </DropdownItem>
                    );
                  })
                : statusGroups.map((group) => (
                  <DropdownSection key={group.label} title={group.label}>
                    {group.options.map((option) => {
                    const selected = selectedStatuses.includes(option.value);
                    return (
                      <DropdownItem
                        key={option.value}
                        onPress={() => {
                          applyStatuses(
                            selected
                              ? selectedStatuses.filter((status) => status !== option.value)
                              : [...selectedStatuses, option.value],
                          );
                        }}
                        startContent={selected ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                      >
                        {option.label}
                      </DropdownItem>
                    );
                    })}
                  </DropdownSection>
                ))}
            </DropdownMenu>
          </Dropdown>
        )}

        {showPriority && (
          <Dropdown
            isOpen={activeMenu === "priority"}
            onOpenChange={(open) => setActiveMenu(open ? "priority" : null)}
            closeOnSelect={false}
          >
            <DropdownTrigger>
              <HButton
                variant="bordered"
                size="sm"
                className={`h-10 border-line bg-content2 text-xs ${selectedPriorities.length ? "border-brand text-brand" : "text-body"}`}
                startContent={<Filter className="h-3.5 w-3.5 text-muted" />}
                endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
              >
                Priority{selectedPriorities.length ? ` (${selectedPriorities.length})` : ""}
              </HButton>
            </DropdownTrigger>
            <DropdownMenu aria-label="Priority filters">
              {INDENT_PRIORITY_OPTIONS.map((option) => (
                <DropdownItem
                  key={option.value}
                  onPress={() => togglePriority(option.value)}
                  startContent={selectedPriorities.includes(option.value) ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                >
                  {option.label}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </Dropdown>
        )}

        {showRegion && (
          <Dropdown
            isOpen={activeMenu === "region"}
            onOpenChange={(open) => setActiveMenu(open ? "region" : null)}
            closeOnSelect={false}
          >
            <DropdownTrigger>
              <HButton
                variant="bordered"
                size="sm"
                className={`h-10 border-line bg-content2 text-xs ${regionFilterCount ? "border-brand text-brand" : "text-body"}`}
                startContent={<MapPin className="h-3.5 w-3.5 text-muted" />}
                endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
              >
                Region{regionFilterCount ? ` (${regionFilterCount})` : ""}
              </HButton>
            </DropdownTrigger>
            <DropdownMenu
              aria-label="Region filters"
              className="max-h-80 overflow-y-auto"
              emptyContent="No locations on these indents yet."
            >
              {[
                <DropdownItem
                  key="region-unassigned"
                  onPress={() => setIncludeUnassignedRegion(!includeUnassignedRegion)}
                  startContent={includeUnassignedRegion ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                >
                  {UNASSIGNED_REGION_LABEL}
                </DropdownItem>,
                ...regionOptions.map((option) => (
                  <DropdownItem
                    key={`region-${option.id}`}
                    onPress={() => toggleRegion(option.id)}
                    startContent={selectedRegions.includes(option.id) ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                  >
                    {option.name}
                  </DropdownItem>
                )),
              ]}
            </DropdownMenu>
          </Dropdown>
        )}

        {hasMoreFilters && (
          <HButton
            variant="bordered"
            size="sm"
            onClick={() => setShowMoreFilters((current) => !current)}
            className={`h-10 border-line bg-content2 text-xs ${activeMoreFilterCount ? "border-brand text-brand" : "text-body"}`}
            startContent={<SlidersHorizontal className="h-3.5 w-3.5 text-muted" />}
            endContent={<ChevronDown className="h-3.5 w-3.5 text-muted" />}
          >
            More filters{activeMoreFilterCount ? ` (${activeMoreFilterCount})` : ""}
          </HButton>
        )}

        {activeFilterCount > 0 && (
          <HButton
            variant="light"
            size="sm"
            onClick={() => {
              resetFilters();
              setShowRequiredByRange(false);
            }}
            className="h-10 px-2 text-xs text-muted hover:text-bad"
            startContent={<RotateCcw className="h-3.5 w-3.5" />}
          >
            Clear all
          </HButton>
        )}
        </div>
      </div>

      {hasMoreFilters && showMoreFilters && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/50 pt-3">
          {showTransaction && (
            <Dropdown isOpen={activeMenu === "transaction"} onOpenChange={(open) => setActiveMenu(open ? "transaction" : null)}>
              <DropdownTrigger>
                <HButton variant="bordered" size="sm" className={`h-10 border-line bg-content2 text-xs ${transactionType ? "border-brand text-brand" : "text-body"}`}>
                  Transaction
                </HButton>
              </DropdownTrigger>
              <DropdownMenu aria-label="Transaction filters">
                {INDENT_ACTIVITY_TRANSACTION_OPTIONS.map((option) => (
                  <DropdownItem key={option.value} onPress={() => setTransactionType(transactionType === option.value ? "" : option.value)}>
                    {option.label}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}

          {showMovement && (
            <Dropdown isOpen={activeMenu === "movement"} onOpenChange={(open) => setActiveMenu(open ? "movement" : null)}>
              <DropdownTrigger>
                <HButton variant="bordered" size="sm" className={`h-10 border-line bg-content2 text-xs ${direction ? "border-brand text-brand" : "text-body"}`}>
                  Movement
                </HButton>
              </DropdownTrigger>
              <DropdownMenu aria-label="Movement filters">
                {MOVEMENT_OPTIONS.map((option) => (
                  <DropdownItem key={option.value} onPress={() => setDirection(direction === option.value ? "" : option.value)}>
                    {option.label}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}

          {showItem && (
            <input
              aria-label="Item ID"
              inputMode="numeric"
              value={itemId}
              onChange={(event) => setItemId(event.target.value.replace(/\D/g, ""))}
              placeholder="Item ID"
              className="h-10 w-24 rounded-lg border border-line bg-content2 px-3 text-xs text-body outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          )}
        </div>
      )}

      {activeFilterCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/50 pt-3">
          {search && (
            <Chip size="sm" variant="flat" onClose={() => setSearch("")}>
              {isSimplePageFilter ? `Search: “${search}”` : `Search: ${search}`}
            </Chip>
          )}
          {hasDateFilter && separateDateFilters && (
            <Chip size="sm" variant="flat" onClose={clearRaisedDate}>
              {dateChipLabel(
                isSimplePageFilter ? dateLabel : "Raised",
                datePreset,
                startDate,
                endDate,
                RAISED_DATE_PRESETS,
              )}
            </Chip>
          )}
          {hasDateFilter && !separateDateFilters && <Chip size="sm" variant="flat" onClose={() => setDatePreset("all")}>Date: {startDate || "Any"} to {endDate || "Any"}</Chip>}
          {hasRequiredByFilter && separateDateFilters && (
            <Chip size="sm" variant="flat" onClose={clearRequiredByDate}>
              {dateChipLabel("Required by", requiredByPreset, requiredByFrom, requiredByTo, REQUIRED_BY_PRESETS)}
            </Chip>
          )}
          {hasRequiredByFilter && !separateDateFilters && <Chip size="sm" variant="flat" onClose={() => { setRequiredByFrom(""); setRequiredByTo(""); }}>Required-by: {requiredByFrom || "Any"} to {requiredByTo || "Any"}</Chip>}
          {isSimplePageFilter
            ? selectedStatuses.map((status) => (
              <Chip
                key={status}
                size="sm"
                variant="flat"
                onClose={() => applyStatuses(
                  selectedStatuses.filter((value) => value !== status),
                )}
              >
                {statusLabel}: {joinLabel([status], statusOptions)}
              </Chip>
            ))
            : selectedStatuses.length > 0 && (
              <Chip size="sm" variant="flat" onClose={() => setSelectedStatuses([])}>
                Status: {joinLabel(selectedStatuses, statusOptions)}
              </Chip>
            )}
          {selectedPriorities.length > 0 && <Chip size="sm" variant="flat" onClose={() => selectedPriorities.forEach(togglePriority)}>Priority: {joinLabel(selectedPriorities, INDENT_PRIORITY_OPTIONS)}</Chip>}
          {showRegion && includeUnassignedRegion && (
            <Chip size="sm" variant="flat" onClose={() => setIncludeUnassignedRegion(false)}>
              Region: {UNASSIGNED_REGION_LABEL}
            </Chip>
          )}
          {showRegion && selectedRegions.length > 0 && (
            <Chip size="sm" variant="flat" onClose={() => setSelectedRegions([])}>
              {/* The id is the fallback: a region can be filtered from a shared URL
                  before the options list has arrived, and dropping the chip then
                  would leave an invisible filter narrowing the results. */}
              Region: {selectedRegions
                .map((id) => regionNameById.get(id) ?? `#${id}`)
                .join(", ")}
            </Chip>
          )}
          {transactionType && <Chip size="sm" variant="flat" onClose={() => setTransactionType("")}>Transaction: {joinLabel([transactionType], INDENT_ACTIVITY_TRANSACTION_OPTIONS)}</Chip>}
          {showMovement && direction && <Chip size="sm" variant="flat" onClose={() => setDirection("")}>Movement: {joinLabel([direction], MOVEMENT_OPTIONS)}</Chip>}
          {itemId && <Chip size="sm" variant="flat" onClose={() => setItemId("")}>Item: {itemId}</Chip>}
        </div>
      )}
    </section>
  );
}
