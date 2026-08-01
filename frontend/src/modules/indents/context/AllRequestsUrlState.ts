import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { INDENT_PRIORITY_OPTIONS, INDENT_REQUEST_STATUS_FILTER_OPTIONS } from "../constants";
import type {
  DatePreset,
  IndentFilterContextType,
  RequiredByPreset,
} from "./IndentFilterContext";

const ALL_REQUESTS_PATH = "/indents";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE = 1_000_000;
const RETURN_STATE_KEY = "allRequestsReturnTo";
const SCROLL_STORAGE_PREFIX = "scm-erp:indents:all-requests:scroll:";

const ALLOWED_STATUSES = new Set(
  INDENT_REQUEST_STATUS_FILTER_OPTIONS.map((option) => option.value),
);
const ALLOWED_PRIORITIES = new Set(
  INDENT_PRIORITY_OPTIONS.map((option) => option.value),
);
const RAISED_PRESETS = new Set<DatePreset>([
  "today",
  "this_week",
  "this_month",
  "custom",
]);
const REQUIRED_BY_PRESETS = new Set<RequiredByPreset>([
  "today",
  "next_7_days",
  "next_30_days",
  "custom",
]);

interface ParsedAllRequestsState {
  search: string;
  datePreset: DatePreset;
  startDate: string;
  endDate: string;
  requiredByPreset: RequiredByPreset;
  requiredByFrom: string;
  requiredByTo: string;
  selectedStatuses: string[];
  selectedPriorities: string[];
  page: number;
  size: number;
}

interface NormalizedAllRequestsState {
  params: URLSearchParams;
  state: ParsedAllRequestsState;
}

function validInteger(value: string | null, fallback: number, maximum: number) {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function validDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : "";
}

function validRange(params: URLSearchParams, fromKey: string, toKey: string) {
  const from = validDate(params.get(fromKey));
  const to = validDate(params.get(toKey));
  return from && to && from <= to ? { from, to } : { from: "", to: "" };
}

function uniqueAllowed(values: string[], allowed: Set<string>) {
  return [...new Set(values.filter((value) => allowed.has(value)))];
}

export function normalizeAllRequestsSearch(
  input: URLSearchParams | string,
): NormalizedAllRequestsState {
  const source = typeof input === "string"
    ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
    : input;
  const params = new URLSearchParams();
  const search = (source.get("search") ?? "").trim();
  const selectedStatuses = uniqueAllowed(source.getAll("status"), ALLOWED_STATUSES);
  const selectedPriorities = uniqueAllowed(source.getAll("priority"), ALLOWED_PRIORITIES);
  const raisedRange = validRange(source, "created_date_from", "created_date_to");
  const requiredByRange = validRange(source, "required_by_from", "required_by_to");
  const rawRaisedPreset = source.get("raised_preset") as DatePreset | null;
  const rawRequiredByPreset = source.get("required_by_preset") as RequiredByPreset | null;
  const datePreset: DatePreset = raisedRange.from
    ? rawRaisedPreset && RAISED_PRESETS.has(rawRaisedPreset) ? rawRaisedPreset : "custom"
    : "all";
  const requiredByPreset: RequiredByPreset = requiredByRange.from
    ? rawRequiredByPreset && REQUIRED_BY_PRESETS.has(rawRequiredByPreset)
      ? rawRequiredByPreset
      : "custom"
    : "any";
  const page = validInteger(source.get("page"), 1, MAX_PAGE);
  const size = validInteger(source.get("size"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  if (search) params.set("search", search);
  selectedStatuses.forEach((status) => params.append("status", status));
  selectedPriorities.forEach((priority) => params.append("priority", priority));
  if (raisedRange.from) {
    params.set("raised_preset", datePreset);
    params.set("created_date_from", raisedRange.from);
    params.set("created_date_to", raisedRange.to);
  }
  if (requiredByRange.from) {
    params.set("required_by_preset", requiredByPreset);
    params.set("required_by_from", requiredByRange.from);
    params.set("required_by_to", requiredByRange.to);
  }
  if (size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
  if (page !== 1) params.set("page", String(page));

  return {
    params,
    state: {
      search,
      datePreset,
      startDate: raisedRange.from,
      endDate: raisedRange.to,
      requiredByPreset,
      requiredByFrom: requiredByRange.from,
      requiredByTo: requiredByRange.to,
      selectedStatuses,
      selectedPriorities,
      page,
      size,
    },
  };
}

function relativeAllRequestsUrl(params: URLSearchParams) {
  const search = params.toString();
  return search ? `${ALL_REQUESTS_PATH}?${search}` : ALL_REQUESTS_PATH;
}

export function allRequestsReturnState(listUrl: string) {
  return { [RETURN_STATE_KEY]: listUrl };
}

export function safeAllRequestsReturnUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return ALL_REQUESTS_PATH;
  try {
    const url = new URL(value, "https://scm-erp.invalid");
    if (url.origin !== "https://scm-erp.invalid" || url.pathname !== ALL_REQUESTS_PATH) {
      return ALL_REQUESTS_PATH;
    }
    return relativeAllRequestsUrl(normalizeAllRequestsSearch(url.searchParams).params);
  } catch {
    return ALL_REQUESTS_PATH;
  }
}

export function allRequestsReturnUrlFromState(state: unknown) {
  const value = state && typeof state === "object"
    ? (state as Record<string, unknown>)[RETURN_STATE_KEY]
    : undefined;
  return safeAllRequestsReturnUrl(value);
}

function scrollStorageKey(listUrl: string) {
  return `${SCROLL_STORAGE_PREFIX}${encodeURIComponent(listUrl)}`;
}

export function saveAllRequestsScroll(listUrl: string, scrollY = window.scrollY) {
  try {
    const key = scrollStorageKey(listUrl);
    if (scrollY > 0) window.sessionStorage.setItem(key, String(scrollY));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function readAllRequestsScroll(listUrl: string) {
  try {
    const stored = window.sessionStorage.getItem(scrollStorageKey(listUrl));
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

type ParamsMutation = (params: URLSearchParams) => void;

export function useAllRequestsUrlState(): {
  filters: IndentFilterContextType;
  size: number;
  listUrl: string;
  replacePage: (page: number) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const normalized = useMemo(
    () => normalizeAllRequestsSearch(searchParams),
    [searchParams],
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
    const canonical = normalizeAllRequestsSearch(next).params;
    currentParams.current = canonical;
    setSearchParams(canonical, { replace });
  }, [setSearchParams]);

  const resetPage = useCallback((params: URLSearchParams) => params.delete("page"), []);
  const updateFilter = useCallback((mutation: ParamsMutation) => {
    update((params) => {
      mutation(params);
      resetPage(params);
    });
  }, [resetPage, update]);
  const setArray = useCallback((key: string, values: string[]) => {
    updateFilter((params) => {
      params.delete(key);
      values.forEach((value) => params.append(key, value));
    });
  }, [updateFilter]);
  const clearRaisedDate = useCallback(() => {
    updateFilter((params) => {
      params.delete("raised_preset");
      params.delete("created_date_from");
      params.delete("created_date_to");
    });
  }, [updateFilter]);
  const clearRequiredByDate = useCallback(() => {
    updateFilter((params) => {
      params.delete("required_by_preset");
      params.delete("required_by_from");
      params.delete("required_by_to");
    });
  }, [updateFilter]);
  const setPage = useCallback((page: number, replace = false) => {
    update((params) => {
      const nextPage = Number.isInteger(page) && page > 1 ? page : 1;
      if (nextPage === 1) params.delete("page");
      else params.set("page", String(nextPage));
    }, replace);
  }, [update]);
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
      if (preset === "all") clearRaisedDate();
    },
    startDate: state.startDate,
    setStartDate: (value) => updateFilter((params) => params.set("created_date_from", value)),
    endDate: state.endDate,
    setEndDate: (value) => updateFilter((params) => params.set("created_date_to", value)),
    requiredByFrom: state.requiredByFrom,
    setRequiredByFrom: (value) => updateFilter((params) => params.set("required_by_from", value)),
    requiredByTo: state.requiredByTo,
    setRequiredByTo: (value) => updateFilter((params) => params.set("required_by_to", value)),
    requiredByPreset: state.requiredByPreset,
    applyRaisedDate: (preset, from, to) => updateFilter((params) => {
      params.set("raised_preset", preset);
      params.set("created_date_from", from);
      params.set("created_date_to", to);
    }),
    clearRaisedDate,
    applyRequiredByDate: (preset, from, to) => updateFilter((params) => {
      params.set("required_by_preset", preset);
      params.set("required_by_from", from);
      params.set("required_by_to", to);
    }),
    clearRequiredByDate,
    selectedStatuses: state.selectedStatuses,
    setSelectedStatuses: (values) => setArray("status", values),
    toggleStatus: (status) => updateFilter((params) => {
      const values = params.getAll("status");
      params.delete("status");
      (values.includes(status)
        ? values.filter((value) => value !== status)
        : [...values, status]
      ).forEach((value) => params.append("status", value));
    }),
    selectedPriorities: state.selectedPriorities,
    setSelectedPriorities: (values) => setArray("priority", values),
    togglePriority: (priority) => updateFilter((params) => {
      const values = params.getAll("priority");
      params.delete("priority");
      (values.includes(priority)
        ? values.filter((value) => value !== priority)
        : [...values, priority]
      ).forEach((value) => params.append("priority", value));
    }),
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
      + (state.startDate ? 1 : 0)
      + (state.requiredByFrom ? 1 : 0)
      + state.selectedStatuses.length
      + state.selectedPriorities.length,
  }), [
    clearRaisedDate,
    clearRequiredByDate,
    noop,
    setArray,
    setPage,
    state,
    update,
    updateFilter,
  ]);

  return {
    filters,
    size: state.size,
    listUrl: relativeAllRequestsUrl(normalized.params),
    replacePage,
  };
}
