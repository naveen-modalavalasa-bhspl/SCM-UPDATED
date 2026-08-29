import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Check, ChevronDown, Filter, MapPin, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { Chip } from "@heroui/react";
import {
  FILTER_BADGE, FILTER_CLEAR, FILTER_FIELD, FILTER_IDLE, FILTER_ON, FILTER_PANEL,
  FILTER_RAIL, FILTER_ROW, FILTER_ROW_OFF, FILTER_ROW_ON, FILTER_SHELL, FILTER_TRIGGER,
} from "@/shared/components";
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

type FilterMode = "indents" | "activity" | "notifications";

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
  /** The rail calls the region filter something else on screens whose column says so. */
  regionFilterLabel?: string;
  showTransaction?: boolean;
  showMovement?: boolean;
  showItem?: boolean;
  searchPlaceholder?: string;
}

type ActiveMenu = "status" | "priority" | "region" | "date" | "raisedDate" | "requiredBy" | "transaction" | "movement" | null;

/** Region/Location is nullable, so "no location" needs a filter value of its own. */
export const UNASSIGNED_REGION_LABEL = "No location";
/** Sentinel for that row inside menus — never a real region id. */
const UNASSIGNED_REGION_KEY = "__unassigned__";

const MOVEMENT_OPTIONS = [
  { value: "OUTWARD", label: "Outward" },
  { value: "INWARD", label: "Inward" },
];

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

/* The look is NOT decided here — it comes from shared/components/filterChrome,
 * which the inventory, procurement and warehouse bars read too. These aliases
 * keep this file's call sites short; change the design in filterChrome. */
const PILL_BASE = `${FILTER_SHELL} gap-2 px-3.5`;
const PILL_IDLE = FILTER_IDLE;
const PILL_ON = FILTER_ON;
const PILL_QUIET = "border-transparent bg-transparent text-muted hover:bg-bad-bg hover:text-bad";
const PILL_SHELL = FILTER_SHELL;
const PILL_TRIGGER = FILTER_TRIGGER;
const PILL_CLEAR = FILTER_CLEAR;
const POPUP_SHELL = `${FILTER_PANEL} absolute top-full z-50 mt-2`;
const COUNT_BADGE = FILTER_BADGE;
const CHIP_CLASSNAMES = {
  base: "h-7 rounded-lg border border-line/70 bg-content1 px-2 shadow-[0_1px_1.5px_rgba(14,20,36,0.04)]",
  content: "text-[12px] font-semibold text-body",
  closeButton: "text-muted opacity-100 hover:text-bad",
} as const;

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
      <div className={`${PILL_SHELL} ${mobileFullWidth ? "w-full sm:w-auto" : ""} ${isActive ? PILL_ON : PILL_IDLE}`}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={isOpen}
          aria-controls={popupId}
          onClick={() => onOpenChange(!isOpen)}
          className={`${PILL_TRIGGER} ${mobileFullWidth ? "flex-1 justify-between" : ""} pl-3 ${isActive ? "pr-2" : "pr-3"}`}
        >
          <Calendar className={`h-4 w-4 ${isActive ? "text-brand" : "text-muted"}`} />
          {label}
          <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`} />
        </button>
        {isActive && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onClear();
              onOpenChange(false);
            }}
            className={PILL_CLEAR}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isOpen && (
        <div
          id={popupId}
          role="dialog"
          aria-label={`${label} filter`}
          className={`${POPUP_SHELL} right-0 max-h-[min(75vh,36rem)] w-[calc(100vw-2rem)] max-w-96 overflow-y-auto p-3.5 text-xs sm:w-96`}
        >
          <div className="mb-3 flex items-start justify-between gap-4 border-b border-line/60 pb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight text-ink">{label}</h3>
              <p className="mt-0.5 text-[11px] leading-4 text-muted">{description}</p>
            </div>
            <button
              type="button"
              aria-label={`Close ${label} filter`}
              onClick={() => onOpenChange(false)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-content2 hover:text-ink"
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
                className={`flex min-h-10 items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] font-semibold ring-1 ring-inset transition-all duration-150 ${
                  draftPreset === option.key
                    ? "bg-brand text-white ring-brand shadow-[0_2px_8px_-2px_rgba(62,99,221,0.45)]"
                    : "bg-content2/70 text-body ring-transparent hover:bg-content2 hover:ring-line"
                }`}
              >
                <span>{option.label}</span>
                {draftPreset === option.key && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>

          {isCustom && (
            <div className="mt-3 rounded-xl border border-line/60 bg-surface/60 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-date-grid`}>
                <label className="space-y-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
                  <input
                    aria-label={`${label} from`}
                    type="date"
                    value={draftFrom}
                    max={draftTo || undefined}
                    onChange={(event) => changeFrom(event.target.value)}
                    className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset ring-line transition focus:ring-2 focus:ring-brand/50"
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
                    className={`h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset transition focus:ring-2 ${rangeError ? "ring-bad focus:ring-bad/60" : "ring-line focus:ring-brand/50"}`}
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
              className="min-h-10 rounded-xl px-4 text-[13px] font-semibold text-muted transition hover:bg-bad-bg hover:text-bad"
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
              className="min-h-10 rounded-xl bg-brand px-5 text-[13px] font-semibold text-white shadow-[0_2px_10px_-2px_rgba(62,99,221,0.5)] transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
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
  if (mode === "activity") return "Activity date";
  if (mode === "notifications") return "Notification date";
  return "Raised date";
}

function dateDescription(mode: FilterMode) {
  if (mode === "activity") return "When the activity happened.";
  if (mode === "notifications") return "When the notification was created.";
  return "When the indent was created or raised.";
}

interface FilterMenuGroup {
  label?: string;
  options: { value: string; label: string }[];
}

/**
 * One typable multi-select filter: pill trigger + a panel with its own search
 * box, so long lists (locations, statuses) are narrowed by typing rather than
 * scrolled. Replaces the HeroUI dropdowns, which could not be typed into.
 *
 * The accessible name of the trigger carries the count — "Status (2)" — so the
 * bar reads the same to a screen reader as it looks on screen.
 */
function MultiSelectMenu({
  idPrefix, label, icon, groups, selected, isOpen, onOpenChange, onToggle, onClear,
  closeOnSelect = false,
}: {
  idPrefix: string;
  label: string;
  icon: ReactNode;
  groups: FilterMenuGroup[];
  selected: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (value: string) => void;
  onClear: () => void;
  /** A single-choice menu has nothing left to ask once a row is picked, and
   *  leaving it open turns the next press on the trigger into a close. */
  closeOnSelect?: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = `${idPrefix}-filter-menu`;
  const count = selected.length;

  useEffect(() => {
    if (!isOpen) setQuery("");
    else searchRef.current?.focus();
  }, [isOpen]);

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => (
    needle
      ? groups
        .map((group) => ({
          ...group,
          options: group.options.filter((option) => option.label.toLowerCase().includes(needle)),
        }))
        .filter((group) => group.options.length > 0)
      : groups
  ), [groups, needle]);
  const totalVisible = visibleGroups.reduce((sum, group) => sum + group.options.length, 0);

  return (
    <div className="relative">
      <div className={`${PILL_SHELL} ${count > 0 ? PILL_ON : PILL_IDLE}`}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={isOpen ? menuId : undefined}
          aria-label={count > 0 ? `${label} (${count})` : undefined}
          onClick={() => onOpenChange(!isOpen)}
          className={`${PILL_TRIGGER} pl-3.5 ${count > 0 ? "pr-2" : "pr-3"}`}
        >
          <span className={count > 0 ? "text-brand" : "text-muted"}>{icon}</span>
          {label}
          {count > 0 && <span className={COUNT_BADGE}>{count}</span>}
          <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`} />
        </button>
        {count > 0 && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onClear();
              setQuery("");
              onOpenChange(false);
            }}
            className={PILL_CLEAR}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isOpen && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${label} filters`}
          className={`${POPUP_SHELL} right-0 w-[calc(100vw-2rem)] max-w-80 overflow-hidden text-[13px] sm:w-80`}
        >
          <div className="border-b border-line/60 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                aria-label={`Search ${label.toLowerCase()} options`}
                className={`${FILTER_FIELD} h-10 pl-8 pr-3 text-[13px]`}
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto overscroll-contain p-1.5">
            {visibleGroups.map((group, index) => (
              <div key={group.label ?? `group-${index}`}>
                {group.label && (
                  <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                    {group.label}
                  </div>
                )}
                {group.options.map((option) => {
                  const on = selected.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onToggle(option.value);
                        if (closeOnSelect) onOpenChange(false);
                      }}
                      className={`${FILTER_ROW} ${on ? FILTER_ROW_ON : FILTER_ROW_OFF}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition-all duration-150 ${
                          on ? "border-brand bg-brand text-white shadow-[0_1px_4px_-1px_rgba(62,99,221,0.6)]" : "border-line bg-content1"
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {totalVisible === 0 && (
              <p className="px-2.5 py-3 font-medium text-muted">No match for “{needle}”.</p>
            )}
          </div>

          {count > 0 && (
            <div className="border-t border-line/60 p-1.5">
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setQuery("");
                }}
                className="min-h-10 w-full rounded-lg px-3 font-semibold text-muted transition hover:bg-bad-bg hover:text-bad"
              >
                Clear {label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
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
  // Only the screens that filter over indents themselves: notifications read
  // from wf_actions, which carries no region.
  showRegion = mode === "indents" || mode === "activity",
  regionFilterLabel = "Region",
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
  const statusGroups = INDENT_STATUS_GROUPS;
  const statusOptions = statusFilterOptions ?? INDENT_STATUS_OPTIONS;
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
    /* No backdrop-blur here: a filter on the container opens a stacking context
     * and this bar's own popups then paint UNDER the cards below it.
     *
     * z-10, NOT z-20: the app header is `sticky top-0 z-20`, and this bar sits
     * later in the DOM — on the same layer it won the tie and scrolled OVER the
     * header instead of under it. Ten still beats the unpositioned cards below,
     * which is all the popups need. */
    <section
      ref={containerRef}
      className={`mb-5 ${FILTER_RAIL}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className={isSimplePageFilter
          ? "relative min-w-0 flex-1 basis-full sm:min-w-[220px] sm:basis-72"
          : "relative min-w-[220px] flex-1 basis-72"}
        >
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label={searchAriaLabel}
            value={localSearch}
            onChange={(event) => setLocalSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className={`${FILTER_FIELD} pl-10 pr-9`}
          />
          {localSearch && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setLocalSearch("");
                setSearch("");
              }}
              className="absolute right-2.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-content3 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* A hairline splits the rail into "what am I looking for" and "narrow it
            down" — only where the row does not wrap, since a divider that lands
            mid-wrap reads as a stray line. */}
        <div className={isSimplePageFilter
          ? "flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto xl:border-l xl:border-line/70 xl:pl-2.5"
          : "ml-auto flex flex-wrap items-center gap-2 xl:border-l xl:border-line/70 xl:pl-2.5"}
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
          <div className={`${PILL_SHELL} ${hasAnyDateFilter ? PILL_ON : PILL_IDLE}`}>
            <button
              type="button"
              aria-expanded={activeMenu === "date"}
              onClick={() => setActiveMenu((current) => (current === "date" ? null : "date"))}
              className={`${PILL_TRIGGER} pl-3.5 ${hasAnyDateFilter ? "pr-2" : "pr-3"}`}
            >
              <Calendar className={`h-4 w-4 ${hasAnyDateFilter ? "text-brand" : "text-muted"}`} />
              Date
              {hasAnyDateFilter && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              )}
              <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${activeMenu === "date" ? "rotate-180" : ""}`} />
            </button>
            {hasAnyDateFilter && (
              <button
                type="button"
                aria-label="Clear date"
                onClick={() => {
                  setDatePreset("all");
                  setRequiredByFrom("");
                  setRequiredByTo("");
                  setShowRequiredByRange(false);
                  setActiveMenu(null);
                }}
                className={PILL_CLEAR}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {activeMenu === "date" && (
            <div className={`${POPUP_SHELL} left-0 max-h-[min(75vh,34rem)] w-[calc(100vw-2rem)] max-w-80 overflow-y-auto p-3.5 text-xs sm:w-80`}>
              <div className="mb-3 flex items-center justify-between border-b border-line/60 pb-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">{dateLabel}</span>
                <button
                  type="button"
                  aria-label="Close date filters"
                  onClick={() => setActiveMenu(null)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-content2 hover:text-ink"
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
                    className={`flex min-h-10 items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] font-semibold ring-1 ring-inset transition-all duration-150 ${
                      datePreset === preset.key
                        ? "bg-brand text-white ring-brand shadow-[0_2px_8px_-2px_rgba(62,99,221,0.45)]"
                        : "bg-content2/70 text-body ring-transparent hover:bg-content2 hover:ring-line"
                    }`}
                  >
                    <span>{preset.label}</span>
                    {datePreset === preset.key && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>

              {datePreset === "custom" && (
                <div className="mt-3 rounded-xl border border-line/60 bg-surface/60 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
                      <input
                        aria-label={`${dateLabel.replace(" date", "")} from date`}
                        type="date"
                        value={startDate}
                        onChange={(event) => setStartDate(event.target.value)}
                        className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset ring-line transition focus:ring-2 focus:ring-brand/50"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
                      <input
                        aria-label={`${dateLabel.replace(" date", "")} to date`}
                        type="date"
                        value={endDate}
                        onChange={(event) => setEndDate(event.target.value)}
                        className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset ring-line transition focus:ring-2 focus:ring-brand/50"
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
                  className="mt-3 flex min-h-10 w-full items-center justify-between rounded-xl border border-dashed border-line bg-content2/60 px-3 text-left text-[13px] font-semibold text-brand transition hover:border-brand hover:bg-brand-050"
                >
                  <span>Add required-by filter</span>
                  {hasRequiredByFilter && <span aria-hidden="true" title="Required-by filter active" className="h-2 w-2 rounded-full bg-brand" />}
                </button>
              )}

              {showRequiredBy && showRequiredByRange && (
                <div className="mt-4 border-t border-line/60 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">Required-by date</span>
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
                        className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset ring-line transition focus:ring-2 focus:ring-brand/50"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
                      <input
                        aria-label="Required by to"
                        type="date"
                        value={requiredByTo}
                        onChange={(event) => setRequiredByTo(event.target.value)}
                        className="h-10 w-full rounded-lg border-0 bg-content1 px-2.5 text-xs font-medium text-body outline-none ring-1 ring-inset ring-line transition focus:ring-2 focus:ring-brand/50"
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
          <MultiSelectMenu
            idPrefix="status"
            label={statusLabel}
            icon={<Filter className="h-3.5 w-3.5" />}
            isOpen={activeMenu === "status"}
            onOpenChange={(open) => setActiveMenu(open ? "status" : null)}
            groups={statusFilterOptions
              ? [{ options: statusFilterOptions }]
              : statusGroups.map((group) => ({ label: group.label, options: group.options }))}
            selected={selectedStatuses}
            onToggle={(value) => {
              const isSelected = selectedStatuses.includes(value);
              applyStatuses(
                isSelected
                  ? selectedStatuses.filter((status) => status !== value)
                  : singleStatusSelection
                    ? [value]
                    : [...selectedStatuses, value],
              );
            }}
            onClear={() => applyStatuses([])}
            closeOnSelect={singleStatusSelection}
          />
        )}

        {showPriority && (
          <MultiSelectMenu
            idPrefix="priority"
            label="Priority"
            icon={<Filter className="h-3.5 w-3.5" />}
            isOpen={activeMenu === "priority"}
            onOpenChange={(open) => setActiveMenu(open ? "priority" : null)}
            groups={[{ options: INDENT_PRIORITY_OPTIONS }]}
            selected={selectedPriorities}
            onToggle={togglePriority}
            onClear={() => selectedPriorities.forEach(togglePriority)}
          />
        )}

        {showRegion && (
          <MultiSelectMenu
            idPrefix="region"
            label={regionFilterLabel}
            icon={<MapPin className="h-3.5 w-3.5" />}
            isOpen={activeMenu === "region"}
            onOpenChange={(open) => setActiveMenu(open ? "region" : null)}
            groups={[{
              options: [
                { value: UNASSIGNED_REGION_KEY, label: UNASSIGNED_REGION_LABEL },
                ...regionOptions.map((option) => ({ value: String(option.id), label: option.name })),
              ],
            }]}
            selected={[
              ...selectedRegions.map((id) => String(id)),
              ...(includeUnassignedRegion ? [UNASSIGNED_REGION_KEY] : []),
            ]}
            onToggle={(value) => {
              if (value === UNASSIGNED_REGION_KEY) setIncludeUnassignedRegion(!includeUnassignedRegion);
              else toggleRegion(Number(value));
            }}
            onClear={() => {
              setSelectedRegions([]);
              setIncludeUnassignedRegion(false);
            }}
          />
        )}

        {hasMoreFilters && (
          <button
            type="button"
            aria-expanded={showMoreFilters}
            onClick={() => setShowMoreFilters((current) => !current)}
            className={`${PILL_BASE} ${activeMoreFilterCount ? PILL_ON : PILL_IDLE}`}
          >
            <SlidersHorizontal className={`h-4 w-4 ${activeMoreFilterCount ? "text-brand" : "text-muted"}`} />
            More filters
            {activeMoreFilterCount > 0 && <span className={COUNT_BADGE}>{activeMoreFilterCount}</span>}
            <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${showMoreFilters ? "rotate-180" : ""}`} />
          </button>
        )}

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              resetFilters();
              setShowRequiredByRange(false);
            }}
            className={`${PILL_BASE} ${PILL_QUIET}`}
          >
            <RotateCcw className="h-4 w-4" />
            Clear all
          </button>
        )}
        </div>
      </div>

      {hasMoreFilters && showMoreFilters && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/50 pt-3">
          {showTransaction && (
            <MultiSelectMenu
              idPrefix="transaction"
              label="Transaction"
              icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
              isOpen={activeMenu === "transaction"}
              onOpenChange={(open) => setActiveMenu(open ? "transaction" : null)}
              groups={[{ options: INDENT_ACTIVITY_TRANSACTION_OPTIONS }]}
              selected={transactionType ? [transactionType] : []}
              onToggle={(value) => setTransactionType(transactionType === value ? "" : value)}
              onClear={() => setTransactionType("")}
              closeOnSelect
            />
          )}

          {showMovement && (
            <MultiSelectMenu
              idPrefix="movement"
              label="Movement"
              icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
              isOpen={activeMenu === "movement"}
              onOpenChange={(open) => setActiveMenu(open ? "movement" : null)}
              groups={[{ options: MOVEMENT_OPTIONS }]}
              selected={direction ? [direction] : []}
              onToggle={(value) => setDirection(direction === value ? "" : value)}
              onClear={() => setDirection("")}
              closeOnSelect
            />
          )}

          {showItem && (
            <input
              aria-label="Item ID"
              inputMode="numeric"
              value={itemId}
              onChange={(event) => setItemId(event.target.value.replace(/\D/g, ""))}
              placeholder="Item ID"
              className="h-10 w-24 rounded-xl border-0 bg-surface/70 px-3 text-[13px] font-medium text-body outline-none ring-1 ring-inset ring-line/80 transition focus:bg-content1 focus:ring-2 focus:ring-brand/50"
            />
          )}
        </div>
      )}

      {activeFilterCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/50 pt-3">
          {search && (
            <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setSearch("")}>
              {isSimplePageFilter ? `Search: “${search}”` : `Search: ${search}`}
            </Chip>
          )}
          {hasDateFilter && separateDateFilters && (
            <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={clearRaisedDate}>
              {dateChipLabel(
                isSimplePageFilter ? dateLabel : "Raised",
                datePreset,
                startDate,
                endDate,
                RAISED_DATE_PRESETS,
              )}
            </Chip>
          )}
          {hasDateFilter && !separateDateFilters && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setDatePreset("all")}>Date: {startDate || "Any"} to {endDate || "Any"}</Chip>}
          {hasRequiredByFilter && separateDateFilters && (
            <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={clearRequiredByDate}>
              {dateChipLabel("Required by", requiredByPreset, requiredByFrom, requiredByTo, REQUIRED_BY_PRESETS)}
            </Chip>
          )}
          {hasRequiredByFilter && !separateDateFilters && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => { setRequiredByFrom(""); setRequiredByTo(""); }}>Required-by: {requiredByFrom || "Any"} to {requiredByTo || "Any"}</Chip>}
          {isSimplePageFilter
            ? selectedStatuses.map((status) => (
              <Chip
                key={status}
                size="sm"
                variant="flat"
              classNames={CHIP_CLASSNAMES}
                onClose={() => applyStatuses(
                  selectedStatuses.filter((value) => value !== status),
                )}
              >
                {statusLabel}: {joinLabel([status], statusOptions)}
              </Chip>
            ))
            : selectedStatuses.length > 0 && (
              <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setSelectedStatuses([])}>
                Status: {joinLabel(selectedStatuses, statusOptions)}
              </Chip>
            )}
          {selectedPriorities.length > 0 && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => selectedPriorities.forEach(togglePriority)}>Priority: {joinLabel(selectedPriorities, INDENT_PRIORITY_OPTIONS)}</Chip>}
          {showRegion && includeUnassignedRegion && (
            <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setIncludeUnassignedRegion(false)}>
              {regionFilterLabel}: {UNASSIGNED_REGION_LABEL}
            </Chip>
          )}
          {showRegion && selectedRegions.length > 0 && (
            <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setSelectedRegions([])}>
              {/* The id is the fallback: a region can be filtered from a shared URL
                  before the options list has arrived, and dropping the chip then
                  would leave an invisible filter narrowing the results. */}
              {regionFilterLabel}: {selectedRegions
                .map((id) => regionNameById.get(id) ?? `#${id}`)
                .join(", ")}
            </Chip>
          )}
          {transactionType && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setTransactionType("")}>Transaction: {joinLabel([transactionType], INDENT_ACTIVITY_TRANSACTION_OPTIONS)}</Chip>}
          {showMovement && direction && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setDirection("")}>Movement: {joinLabel([direction], MOVEMENT_OPTIONS)}</Chip>}
          {itemId && <Chip size="sm" variant="flat" classNames={CHIP_CLASSNAMES} onClose={() => setItemId("")}>Item: {itemId}</Chip>}
        </div>
      )}
    </section>
  );
}
