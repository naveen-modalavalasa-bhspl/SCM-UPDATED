import {
  normalizeSimpleIndentFilterSearch,
  useSimpleIndentFiltersUrlState,
} from "./SimpleIndentFiltersUrlState";
import { INDENT_ACTIVITY_EVENT_FILTER_OPTIONS } from "../constants";

const ACTIVITY_LEDGER_PATH = "/indents/reports";
const RETURN_STATE_KEY = "activityLedgerReturnTo";
const SCROLL_STORAGE_PREFIX = "scm-erp:indents:activity-ledger:scroll:";

export function normalizeActivityLedgerSearch(input: URLSearchParams | string) {
  return normalizeSimpleIndentFilterSearch(input, {
    selectionParam: "transaction_type",
    selectionOptions: INDENT_ACTIVITY_EVENT_FILTER_OPTIONS,
    singleSelection: true,
  });
}

function relativeActivityLedgerUrl(params: URLSearchParams) {
  const search = params.toString();
  return search ? `${ACTIVITY_LEDGER_PATH}?${search}` : ACTIVITY_LEDGER_PATH;
}

export function activityLedgerReturnState(listUrl: string) {
  return { [RETURN_STATE_KEY]: listUrl };
}

export function safeActivityLedgerReturnUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    const url = new URL(value, "https://scm-erp.invalid");
    if (url.origin !== "https://scm-erp.invalid" || url.pathname !== ACTIVITY_LEDGER_PATH) {
      return null;
    }
    return relativeActivityLedgerUrl(normalizeActivityLedgerSearch(url.searchParams).params);
  } catch {
    return null;
  }
}

export function activityLedgerReturnUrlFromState(state: unknown) {
  const value = state && typeof state === "object"
    ? (state as Record<string, unknown>)[RETURN_STATE_KEY]
    : undefined;
  return safeActivityLedgerReturnUrl(value);
}

function scrollStorageKey(listUrl: string) {
  return `${SCROLL_STORAGE_PREFIX}${encodeURIComponent(listUrl)}`;
}

export function saveActivityLedgerScroll(listUrl: string, scrollY = window.scrollY) {
  try {
    const key = scrollStorageKey(listUrl);
    if (scrollY > 0) window.sessionStorage.setItem(key, String(scrollY));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function readActivityLedgerScroll(listUrl: string) {
  try {
    const stored = window.sessionStorage.getItem(scrollStorageKey(listUrl));
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function useActivityLedgerUrlState() {
  return useSimpleIndentFiltersUrlState({
    path: ACTIVITY_LEDGER_PATH,
    selectionParam: "transaction_type",
    selectionOptions: INDENT_ACTIVITY_EVENT_FILTER_OPTIONS,
    singleSelection: true,
  });
}
