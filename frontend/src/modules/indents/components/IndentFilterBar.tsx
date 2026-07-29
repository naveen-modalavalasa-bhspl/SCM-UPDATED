import { useEffect, useRef, useState } from "react";
import { Calendar, Check, ChevronDown, Filter, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import {
  Button as HButton, Chip, Dropdown, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger,
} from "@heroui/react";
import { useIndentFilters, type DatePreset } from "../context/IndentFilterContext";
import { INDENT_PRIORITY_OPTIONS, INDENT_STATUS_GROUPS, INDENT_STATUS_OPTIONS } from "../constants";

type FilterMode = "indents" | "acknowledgments" | "activity";

interface IndentFilterBarProps {
  mode?: FilterMode;
  showRequiredBy?: boolean;
  showDate?: boolean;
  showStatus?: boolean;
  showPriority?: boolean;
  showTransaction?: boolean;
  showMovement?: boolean;
  showItem?: boolean;
  searchPlaceholder?: string;
}

type ActiveMenu = "status" | "priority" | "date" | "transaction" | "movement" | null;

const TRANSACTION_OPTIONS = [
  { value: "RAISED", label: "Request raised" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "RETURNED", label: "Returned" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
];

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

function joinLabel(values: string[], options: { value: string; label: string }[]) {
  return values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ");
}

function primaryDateLabel(mode: FilterMode) {
  if (mode === "acknowledgments") return "Acknowledgment date";
  if (mode === "activity") return "Activity date";
  return "Raised date";
}

export function IndentFilterBar({
  mode = "indents",
  showRequiredBy = true,
  showDate = true,
  showStatus = true,
  showPriority = true,
  showTransaction = mode === "activity",
  showMovement = mode === "activity",
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
    selectedStatuses,
    setSelectedStatuses,
    selectedPriorities,
    togglePriority,
    transactionType,
    setTransactionType,
    direction,
    setDirection,
    itemId,
    setItemId,
    resetFilters,
    activeFilterCount,
  } = useIndentFilters();

  const [localSearch, setLocalSearch] = useState(search);
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null);
  const [showRequiredByRange, setShowRequiredByRange] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const hasDateFilter = datePreset !== "all" || Boolean(startDate) || Boolean(endDate);
  const hasRequiredByFilter = Boolean(requiredByFrom) || Boolean(requiredByTo);
  const hasAnyDateFilter = hasDateFilter || hasRequiredByFilter;
  const hasMoreFilters = Boolean(showTransaction || showMovement || showItem);
  const activeMoreFilterCount = (transactionType ? 1 : 0) + (direction ? 1 : 0) + (itemId ? 1 : 0);
  const dateLabel = primaryDateLabel(mode);

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(localSearch), 300);
    return () => window.clearTimeout(timer);
  }, [localSearch, setSearch]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    if (hasRequiredByFilter) setShowRequiredByRange(true);
  }, [hasRequiredByFilter]);

  return (
    <section ref={containerRef} className="mb-5 rounded-lg border border-line/70 bg-content1 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 basis-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label="Search indents"
            value={localSearch}
            onChange={(event) => setLocalSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-10 w-full rounded-lg border border-line bg-content2 pl-9 pr-9 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
        {showDate && (
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
                Status{selectedStatuses.length ? ` (${selectedStatuses.length})` : ""}
              </HButton>
            </DropdownTrigger>
            <DropdownMenu aria-label="Status filters">
              {INDENT_STATUS_GROUPS.map((group) => (
                <DropdownSection key={group.label} title={group.label}>
                  {group.options.map((option) => {
                    const selected = selectedStatuses.includes(option.value);
                    return (
                      <DropdownItem
                        key={option.value}
                        onPress={() => {
                          setSelectedStatuses(
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
                {TRANSACTION_OPTIONS.map((option) => (
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
          {search && <Chip size="sm" variant="flat" onClose={() => setSearch("")}>Search: {search}</Chip>}
          {hasDateFilter && <Chip size="sm" variant="flat" onClose={() => setDatePreset("all")}>Date: {startDate || "Any"} to {endDate || "Any"}</Chip>}
          {hasRequiredByFilter && <Chip size="sm" variant="flat" onClose={() => { setRequiredByFrom(""); setRequiredByTo(""); }}>Required-by: {requiredByFrom || "Any"} to {requiredByTo || "Any"}</Chip>}
          {selectedStatuses.length > 0 && <Chip size="sm" variant="flat" onClose={() => setSelectedStatuses([])}>Status: {joinLabel(selectedStatuses, INDENT_STATUS_OPTIONS)}</Chip>}
          {selectedPriorities.length > 0 && <Chip size="sm" variant="flat" onClose={() => selectedPriorities.forEach(togglePriority)}>Priority: {joinLabel(selectedPriorities, INDENT_PRIORITY_OPTIONS)}</Chip>}
          {transactionType && <Chip size="sm" variant="flat" onClose={() => setTransactionType("")}>Transaction: {joinLabel([transactionType], TRANSACTION_OPTIONS)}</Chip>}
          {direction && <Chip size="sm" variant="flat" onClose={() => setDirection("")}>Movement: {joinLabel([direction], MOVEMENT_OPTIONS)}</Chip>}
          {itemId && <Chip size="sm" variant="flat" onClose={() => setItemId("")}>Item: {itemId}</Chip>}
        </div>
      )}
    </section>
  );
}
