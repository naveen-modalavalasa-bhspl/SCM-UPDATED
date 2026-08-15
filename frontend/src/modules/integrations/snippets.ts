import type { ApiEndpoint } from "./types";

/**
 * The copy-paste half of the console: the absolute URL and the curl line a consumer
 * is handed. Pure functions in their own file so they are testable without rendering
 * a page — a wrong snippet is a support ticket, not a visual bug.
 *
 * The host comes from the browser's own origin, never from a literal (rule 13): the
 * same screen served from localhost, the LAN box and production has to print the
 * address the person reading it actually reached.
 */
export const origin = (): string =>
  typeof window === "undefined" ? "" : window.location.origin;

export const absoluteUrl = (path: string, base = origin()): string =>
  `${base}${path}`;

export interface SnippetOptions {
  /** Shown in place of a real key — the raw value exists only at issue time. */
  keyPlaceholder?: string;
  /** Extra query params, e.g. incremental pulls. */
  params?: Record<string, string>;
}

export function queryString(params: Record<string, string> = {}): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== "" && v != null);
  if (!pairs.length) return "";
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}

export function curlFor(endpoint: Pick<ApiEndpoint, "url">, options: SnippetOptions = {},
                        base = origin()): string {
  const key = options.keyPlaceholder ?? "YOUR_API_KEY";
  const url = `${absoluteUrl(endpoint.url, base)}${queryString(options.params)}`;
  return `curl -H "X-API-Key: ${key}" "${url}"`;
}

/** What a consumer polls for changes since its last successful run. */
export function incrementalHint(updatedCol: string | null | undefined): string {
  return updatedCol
    ? `Supports ?updated_since=YYYY-MM-DD — only rows whose ${updatedCol} moved since then.`
    : "No change stamp on this dataset: pull it whole each time.";
}
