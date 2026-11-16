import { Component, type ErrorInfo, type ReactNode } from "react";

export interface FrontendErrorPayload {
  message: string;
  error_type?: string | null;
  status_code?: number | null;
  http_method?: string | null;
  endpoint?: string | null;
  page_url?: string | null;
  source_file?: string | null;
  function_name?: string | null;
  line_number?: number | null;
  column_number?: number | null;
  stack_trace?: string | null;
  request_id?: string | null;
  context?: Record<string, unknown> | null;
}

const LOG_ENDPOINT = "/api/admin/app-logs/client-errors";
const MAX_CONTEXT_BYTES = 8_000;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_ENTRIES = 30;
const MAX_CONTEXT_ARRAY = 20;
const MAX_CONTEXT_STRING = 1_000;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|credential|session|jwt|database[_-]?url|hcm[_-]?(?:key|token)/i;
const UNSAFE_CONTAINER_KEY =
  /(?:^|_)(?:body|form|form_data|request_body|response_body|headers?|query|query_string|search_params|params|payload|values)(?:$|_)/i;

function trim(value: string | null | undefined, limit: number): string | null {
  const clean = value?.trim();
  return clean ? clean.slice(0, limit) : null;
}

function redactText(value: string | null | undefined, limit: number): string | null {
  const clean = trim(value, limit);
  if (!clean) return null;
  return clean
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|database[_-]?url|hcm[_-]?(?:key|token))\b(["']?\s*[:=]\s*["']?)([^\s,;}]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b(?:mysql|postgres(?:ql)?)(?:\+\w+)?:\/\/\S+/gi,
      "[REDACTED_DATABASE_URL]",
    )
    .slice(0, limit);
}

function safeEndpoint(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    return trim(parsed.pathname, 500);
  } catch {
    return trim(value.split("?")[0].split("#")[0], 500);
  }
}

function codePath(filename?: string | null): string | null {
  if (!filename) return null;
  const clean = filename.split("\\").join("/").split("?")[0].split("#")[0];
  const src = clean.indexOf("/src/");
  if (src >= 0) return `frontend${clean.slice(src)}`;
  const frontend = clean.indexOf("/frontend/");
  if (frontend >= 0) return `frontend/${clean.slice(frontend + 10)}`;
  const assets = clean.indexOf("/assets/");
  if (assets >= 0) return `frontend/dist${clean.slice(assets)}`;
  return trim(clean, 500);
}

function stackLocation(stack?: string | null): Partial<FrontendErrorPayload> {
  if (!stack) return {};
  const lines = stack.split("\n");
  const candidate =
    lines.find((line) => line.includes("/src/")) ??
    lines.find((line) => /\.(tsx?|jsx?)(\?|:)/.test(line)) ??
    lines.find((line) => line.includes("/assets/"));
  if (!candidate) return {};

  const match = candidate.match(
    /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/,
  );
  if (!match) return {};
  return {
    function_name: match[1] || null,
    source_file: codePath(match[2]),
    line_number: Number(match[3]),
    column_number: Number(match[4]),
  };
}

function safeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.slice(0, MAX_CONTEXT_STRING);
  if (typeof value !== "object" || depth >= MAX_CONTEXT_DEPTH) return undefined;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONTEXT_ARRAY)
      .map((item) => safeValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }

  const output: Record<string, unknown> = {};
  for (const [rawKey, item] of Object.entries(value).slice(0, MAX_CONTEXT_ENTRIES)) {
    const key = rawKey.slice(0, 100);
    if (key !== "query_fields" && UNSAFE_CONTAINER_KEY.test(key)) continue;
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    const safe = safeValue(item, depth + 1, seen);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

export function sanitizeDiagnosticContext(
  context?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!context) return null;
  const safe = safeValue(context, 0, new WeakSet<object>());
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return null;
  const serialized = JSON.stringify(safe);
  if (serialized.length <= MAX_CONTEXT_BYTES) return safe as Record<string, unknown>;
  const kind = (safe as Record<string, unknown>).kind;
  return {
    ...(typeof kind === "string" ? { kind: kind.slice(0, 100) } : {}),
    context_truncated: true,
    original_size: serialized.length,
  };
}

/** Fire-and-forget by design: reporting must never create another visible error. */
export function reportFrontendError(payload: FrontendErrorPayload): void {
  try {
    if (payload.endpoint?.includes(LOG_ENDPOINT)) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    const stack = redactText(payload.stack_trace, 30_000);
    const location = stackLocation(stack);
    const body: FrontendErrorPayload = {
      message: redactText(payload.message, 4_000) || "Browser error",
      error_type: trim(payload.error_type, 200),
      status_code: payload.status_code ?? null,
      http_method: trim(payload.http_method?.toUpperCase(), 10),
      endpoint: safeEndpoint(payload.endpoint),
      page_url: `${window.location.origin}${window.location.pathname}`,
      source_file: codePath(payload.source_file) ?? location.source_file ?? null,
      function_name: trim(payload.function_name, 200)
        ?? trim(location.function_name, 200),
      line_number: payload.line_number ?? location.line_number ?? null,
      column_number: payload.column_number ?? location.column_number ?? null,
      stack_trace: stack,
      request_id: trim(payload.request_id, 64),
      context: sanitizeDiagnosticContext(payload.context),
    };
    void fetch(`${import.meta.env.VITE_API_URL || ""}${LOG_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // localStorage, JSON serialization, and fetch can all fail in restricted
    // browsers. Logging is diagnostic only and must never affect the application.
  }
}

let globalLoggingInstalled = false;

export function installGlobalErrorLogging() {
  if (globalLoggingInstalled) return;
  globalLoggingInstalled = true;
  window.addEventListener("error", (event) => {
    const error = event.error instanceof Error ? event.error : null;
    reportFrontendError({
      message: error?.message || event.message || "Browser error",
      error_type: error?.name || "ErrorEvent",
      source_file: event.filename,
      line_number: event.lineno || null,
      column_number: event.colno || null,
      stack_trace: error?.stack,
      context: { kind: "window.error" },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error("Unhandled promise rejection");
    // A chunk prefetch can reject outside any <Suspense> tree, so no boundary
    // ever sees it. Same once-per-cooldown recovery as the boundary path.
    const chunkLoad = isChunkLoadError(error);
    const autoReloaded = chunkLoad ? attemptChunkReload() : false;
    reportFrontendError({
      message: error.message,
      error_type: error.name || "UnhandledRejection",
      stack_trace: error.stack,
      context: {
        kind: "unhandledrejection",
        chunk_load: chunkLoad || undefined,
        chunk_auto_reload: autoReloaded || undefined,
      },
    });
  });
}

interface BoundaryState {
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Stale-chunk recovery (2026-10-10)
//
// Every route chunk is content-hashed (HomePage-CHm2YYNA.js), and each deploy
// replaces the nginx image, so the previous build's files vanish with it. A
// tab opened BEFORE the release still points at the old filenames: opening a
// screen it has not visited yet fetches a file that no longer exists, and
// React's error boundary shows the full-page "Something went wrong" panel for
// what is really a stale file list. The log signature is unmistakable —
// TypeError "Failed to fetch dynamically imported module", no endpoint, no
// status code, reported from the boundary before any API call runs.
//
// The fix is client-side: recognise that one failure, reload ONCE (which
// fetches the new index.html and its file list), and show a friendly notice
// instead of the scary panel. The guard is timestamped rather than a plain
// flag so a much later deploy in the same tab can still recover once, while a
// genuinely broken file cannot spin the tab in a reload loop.
// ---------------------------------------------------------------------------

const CHUNK_ERROR_PATTERN =
  /failed to fetch dynamically imported module|loading chunk [\w-]+ failed|importing a module script failed|chunkloaderror/i;

/** True when the error is a route-chunk download failure, not a data bug. */
export function isChunkLoadError(error: unknown): boolean {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return CHUNK_ERROR_PATTERN.test(`${name} ${message}`);
}

const CHUNK_RELOAD_KEY = "scm-chunk-reload-at";
/** A later deploy in the same long-lived tab may recover again after this. */
const CHUNK_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Returns true exactly when an automatic reload is allowed, and records it.
 * Safe default on any storage failure: false, so a restricted browser shows
 * the friendly notice with a manual Refresh button instead of looping.
 */
export function shouldAutoReloadChunk(now: number = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    const last = raw == null ? NaN : Number(raw);
    if (Number.isFinite(last) && now - last < CHUNK_RELOAD_COOLDOWN_MS) {
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Guard + reload in one step. Returns whether the reload was attempted. */
function attemptChunkReload(): boolean {
  if (!shouldAutoReloadChunk()) return false;
  try {
    window.location.reload();
  } catch {
    // jsdom and locked-down webviews may not implement reload; the friendly
    // notice the boundary renders covers those cases with a manual button.
  }
  return true;
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A stale chunk reloads the tab (once per cooldown); every other crash
    // keeps the existing behaviour of report-and-show-the-panel.
    const chunkLoad = isChunkLoadError(error);
    const autoReloaded = chunkLoad ? attemptChunkReload() : false;
    reportFrontendError({
      message: error.message,
      error_type: error.name || "ReactRenderError",
      stack_trace: error.stack,
      context: {
        kind: "react.error-boundary",
        component_stack: info.componentStack,
        chunk_load: chunkLoad || undefined,
        chunk_auto_reload: autoReloaded || undefined,
      },
    });
  }

  private retryWithoutReload = () => {
    // Re-attempt the failed import against the CURRENT file list: covers the
    // transient network blip, where a full page reload would throw away state
    // for nothing. A redeploy-stale chunk fails again here and lands back on
    // the friendly notice (the auto-reload guard is already spent).
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (isChunkLoadError(this.state.error)) {
      return (
        <div className="grid min-h-screen place-items-center bg-content2 p-6 text-center">
          <div className="max-w-md rounded-2xl border border-line bg-content1 p-6 shadow-sm">
            <h1 className="font-display text-xl font-bold text-ink">
              A new version is available
            </h1>
            <p className="mt-2 text-sm text-muted">
              This page was updated while your tab was open. Refresh to load
              the latest version — nothing you submitted was lost.
            </p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                className="h-11 rounded-xl bg-brand px-5 text-sm font-semibold text-white"
                onClick={() => window.location.reload()}
              >
                Refresh now
              </button>
              <button
                className="h-11 rounded-xl border border-line px-5 text-sm font-semibold text-ink"
                onClick={this.retryWithoutReload}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-h-screen place-items-center bg-content2 p-6 text-center">
        <div className="max-w-md rounded-2xl border border-line bg-content1 p-6 shadow-sm">
          <h1 className="font-display text-xl font-bold text-ink">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">
            The error was recorded in Settings → App Logs.
          </p>
          <button
            className="mt-5 h-11 rounded-xl bg-brand px-5 text-sm font-semibold text-white"
            onClick={() => window.location.reload()}
          >
            Reload application
          </button>
        </div>
      </div>
    );
  }
}
