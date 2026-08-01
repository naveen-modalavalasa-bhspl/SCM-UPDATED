import {
  normalizeSimpleIndentFilterSearch,
  useSimpleIndentFiltersUrlState,
} from "./SimpleIndentFiltersUrlState";

const NOTIFICATIONS_PATH = "/indents/notifications";
export const NOTIFICATIONS_PAGE_SIZE = 20;
const RETURN_STATE_KEY = "notificationsReturnTo";
const SCROLL_STORAGE_PREFIX = "scm-erp:indents:notifications:scroll:";

export function normalizeNotificationsSearch(input: URLSearchParams | string) {
  const normalized = normalizeSimpleIndentFilterSearch(input, { fixedPageSize: true });
  return { ...normalized, page: normalized.state.page };
}

function relativeNotificationsUrl(params: URLSearchParams) {
  const search = params.toString();
  return search ? `${NOTIFICATIONS_PATH}?${search}` : NOTIFICATIONS_PATH;
}

export function notificationsReturnState(listUrl: string) {
  return { [RETURN_STATE_KEY]: listUrl };
}

export function safeNotificationsReturnUrl(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    const url = new URL(value, "https://scm-erp.invalid");
    if (url.origin !== "https://scm-erp.invalid" || url.pathname !== NOTIFICATIONS_PATH) {
      return null;
    }
    return relativeNotificationsUrl(normalizeNotificationsSearch(url.searchParams).params);
  } catch {
    return null;
  }
}

export function notificationsReturnUrlFromState(state: unknown) {
  const value = state && typeof state === "object"
    ? (state as Record<string, unknown>)[RETURN_STATE_KEY]
    : undefined;
  return safeNotificationsReturnUrl(value);
}

function scrollStorageKey(listUrl: string) {
  return `${SCROLL_STORAGE_PREFIX}${encodeURIComponent(listUrl)}`;
}

export function saveNotificationsScroll(listUrl: string, scrollY = window.scrollY) {
  try {
    const key = scrollStorageKey(listUrl);
    if (scrollY > 0) window.sessionStorage.setItem(key, String(scrollY));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function readNotificationsScroll(listUrl: string) {
  try {
    const stored = window.sessionStorage.getItem(scrollStorageKey(listUrl));
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function useNotificationsUrlState() {
  return useSimpleIndentFiltersUrlState({
    path: NOTIFICATIONS_PATH,
    fixedPageSize: true,
  });
}
