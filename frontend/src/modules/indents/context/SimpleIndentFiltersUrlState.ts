import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";
import type { DatePreset, IndentFilterContextType } from "./IndentFilterContext";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE = 1_000_000;
const ALLOWED_DATE_PRESETS = new Set<DatePreset>([
  "today",
  "this_week",
  "this_month",
  "custom",
]);

interface SimpleFilterState {
  search: string;
  datePreset: DatePreset;
  startDate: string;
  endDate: string;
  selectedStatuses: string[];
  page: number;
  size: number;
}

export interface NormalizedSimpleFilterState {
  params: URLSearchParams;
  state: SimpleFilterState;
}

function validInteger(value: string | null, fallback: number, maximum: number) {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function validDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? value
    : "";
}

export function normalizeSimpleIndentFilterSearch(
  input: URLSearchParams | string,
  {
    fixedPageSize = false,
    selectionParam = "status",
    selectionOptions = INDENT_REQUEST_STATUS_FILTER_OPTIONS,
    singleSelection = false,
  }: {
    fixedPageSize?: boolean;
    selectionParam?: string;
    selectionOptions?: readonly { value: string }[];
    singleSelection?: boolean;
  } = {},
): NormalizedSimpleFilterState {
  const source = typeof input === "string"
    ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
    : input;
  const params = new URLSearchParams();
  const search = (source.get("search") ?? "").trim();
  const selectedStatuses = selectionOptions
    .map((option) => option.value)
    .filter((status) => source.getAll(selectionParam).includes(status))
    .slice(0, singleSelection ? 1 : undefined);
  const from = validDate(source.get("date_from"));
  const to = validDate(source.get("date_to"));
  const hasValidCompleteRange = Boolean(from && to && from <= to);
  const rawPreset = source.get("date_preset") as DatePreset | null;
  const datePreset = hasValidCompleteRange
    ? rawPreset && ALLOWED_DATE_PRESETS.has(rawPreset) ? rawPreset : "custom"
    : "all";
  const page = validInteger(source.get("page"), 1, MAX_PAGE);
  const size = fixedPageSize
    ? DEFAULT_PAGE_SIZE
    : validInteger(source.get("size"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  if (search) params.set("search", search);
  selectedStatuses.forEach((status) => params.append(selectionParam, status));
  if (hasValidCompleteRange) {
    params.set("date_preset", datePreset);
    params.set("date_from", from);
    params.set("date_to", to);
  }
  if (!fixedPageSize && size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
  if (page !== 1) params.set("page", String(page));

  return {
    params,
    state: {
      search,
      datePreset,
      startDate: hasValidCompleteRange ? from : "",
      endDate: hasValidCompleteRange ? to : "",
      selectedStatuses,
      page,
      size,
    },
  };
}

type ParamsMutation = (params: URLSearchParams) => void;

export function useSimpleIndentFiltersUrlState({
  path,
  fixedPageSize = false,
  selectionParam = "status",
  selectionOptions = INDENT_REQUEST_STATUS_FILTER_OPTIONS,
  singleSelection = false,
}: {
  path: string;
  fixedPageSize?: boolean;
  selectionParam?: string;
  selectionOptions?: readonly { value: string }[];
  singleSelection?: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const normalized = useMemo(
    () => normalizeSimpleIndentFilterSearch(searchParams, {
      fixedPageSize,
      selectionParam,
      selectionOptions,
      singleSelection,
    }),
    [fixedPageSize, searchParams, selectionOptions, selectionParam, singleSelection],
  );
  const normalizedKey = normalized.params.toString();
  const currentParams = useRef(normalized.params);
  currentParams.current = normalized.params;

  useEffect(() => {
    if (searchParams.toString() !== normalizedKey) {
      setSearchParams(normalized.params, { replace: true });
    }
  }, [normalized.params, normalizedKey, searchParams, setSearchParams]);

  const update = useCallback((mutation: ParamsMutation, replace = false) => {
    const next = new URLSearchParams(currentParams.current);
    mutation(next);
    const canonical = normalizeSimpleIndentFilterSearch(next, {
      fixedPageSize,
      selectionParam,
      selectionOptions,
      singleSelection,
    }).params;
    currentParams.current = canonical;
    setSearchParams(canonical, { replace });
  }, [fixedPageSize, selectionOptions, selectionParam, setSearchParams, singleSelection]);
  const updateFilter = useCallback((mutation: ParamsMutation) => {
    update((params) => {
      mutation(params);
      params.delete("page");
    });
  }, [update]);
  const clearDate = useCallback(() => updateFilter((params) => {
    params.delete("date_preset");
    params.delete("date_from");
    params.delete("date_to");
  }), [updateFilter]);
  const setPage = useCallback((page: number, replace = false) => update((params) => {
    const nextPage = Number.isInteger(page) && page > 1 ? page : 1;
    if (nextPage === 1) params.delete("page");
    else params.set("page", String(nextPage));
  }, replace), [update]);
  const replacePage = useCallback((page: number) => setPage(page, true), [setPage]);
  const state = normalized.state;
  const noop = useCallback(() => undefined, []);

  const filters = useMemo<IndentFilterContextType>(() => ({
    search: state.search,
    setSearch: (value) => {
      const next = value.trim();
      if (next === state.search) return;
      updateFilter((params) => {
        if (next) params.set("search", next);
        else params.delete("search");
      });
    },
    datePreset: state.datePreset,
    setDatePreset: (preset) => {
      if (preset === "all") clearDate();
    },
    startDate: state.startDate,
    setStartDate: noop,
    endDate: state.endDate,
    setEndDate: noop,
    requiredByFrom: "",
    setRequiredByFrom: noop,
    requiredByTo: "",
    setRequiredByTo: noop,
    requiredByPreset: "any",
    applyRaisedDate: (preset, from, to) => {
      if (preset === "all") {
        clearDate();
        return;
      }
      if (!from || !to || from > to) return;
      updateFilter((params) => {
        params.set("date_preset", preset);
        params.set("date_from", from);
        params.set("date_to", to);
      });
    },
    clearRaisedDate: clearDate,
    applyRequiredByDate: noop,
    clearRequiredByDate: noop,
    selectedStatuses: state.selectedStatuses,
    setSelectedStatuses: (values) => updateFilter((params) => {
      params.delete(selectionParam);
      const allowedSelections = values
        .filter((value) => selectionOptions.some((option) => option.value === value))
        .slice(0, singleSelection ? 1 : undefined);
      allowedSelections.forEach((value) => params.append(selectionParam, value));
    }),
    toggleStatus: noop,
    selectedPriorities: [],
    setSelectedPriorities: noop,
    togglePriority: noop,
    selectedDepartments: [],
    setSelectedDepartments: noop,
    toggleDepartment: noop,
    selectedProjects: [],
    setSelectedProjects: noop,
    toggleProject: noop,
    selectedWarehouses: [],
    setSelectedWarehouses: noop,
    toggleWarehouse: noop,
    selectedItems: [],
    setSelectedItems: noop,
    toggleItem: noop,
    selectedCreatedBy: [],
    setSelectedCreatedBy: noop,
    toggleCreatedBy: noop,
    transactionType: "",
    setTransactionType: noop,
    direction: "",
    setDirection: noop,
    itemId: "",
    setItemId: noop,
    departmentId: null,
    setDepartmentId: noop,
    sortBy: "created_at",
    setSortBy: noop,
    sortDir: "desc",
    setSortDir: noop,
    page: state.page,
    setPage,
    resetFilters: () => update((params) => {
      [...params.keys()].forEach((key) => params.delete(key));
    }),
    activeFilterCount: (state.search ? 1 : 0)
      + (state.datePreset !== "all" ? 1 : 0)
      + state.selectedStatuses.length,
  }), [clearDate, noop, selectionParam, setPage, singleSelection, state, update, updateFilter]);

  const query = normalized.params.toString();
  return {
    filters,
    page: state.page,
    size: state.size,
    listUrl: query ? `${path}?${query}` : path,
    setPage,
    replacePage,
  };
}
