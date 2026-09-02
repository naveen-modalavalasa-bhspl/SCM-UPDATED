import axios, { AxiosError } from "axios";

/**
 * One place that turns a failure into something a storekeeper can read.
 *
 * Every failure in the app arrives as an axios rejection, and every screen shows it
 * through one of three surfaces — `<ErrorBanner>` next to the form, a toast from
 * `useAction`, or a raw `error.message` in a page's own markup (75 of those). If the
 * wording were decided at those call sites it would be decided 75 different ways, so
 * it is decided here, once, and the shared axios interceptor rewrites `error.message`
 * with the result. A screen that renders `error.message` and knows nothing about this
 * file still says the right thing.
 *
 * Two rules:
 *
 * 1. **The server's reason wins.** `platform/workflow` refusing an approval already
 *    explains itself — "This indent is not assigned to you at the current stage" —
 *    and that sentence is better than anything a status code can produce. It is used
 *    verbatim. Only when the server says nothing useful does a status-derived default
 *    fill in.
 * 2. **Nothing technical is ever shown.** A SQL fragment, a traceback, a driver code
 *    or an axios internal that slips through the backend's own sanitising is dropped
 *    here and replaced by the status default. The user sees an answer; the detail is
 *    already in `sys_app_logs`.
 */

/** The four levels the UI has. Nothing else is a notification level. */
export type NoticeLevel = "success" | "info" | "warning" | "error";

export interface Notice {
  level: NoticeLevel;
  /**
   * Short heading, four or five words. Absent for a plain `new Error("…")` raised
   * by a screen: inventing "Could not complete that" above a sentence the screen
   * already wrote is noise, so those render as a single line.
   */
  title?: string;
  /** One sentence: what happened, why, and what to do about it. */
  message: string;
  /** The form field the message belongs against, when the server named one. */
  field?: string;
  /** Machine code from the backend envelope — `PERMISSION_DENIED`, `DUPLICATE`, … */
  code?: string;
  /** HTTP status, when there was a response. */
  status?: number;
}

interface ErrorEnvelope {
  error?: unknown;
  detail?: unknown;
  title?: unknown;
  error_code?: unknown;
  field?: unknown;
}

/**
 * Text that is about the implementation, not about the user's request.
 *
 * The backend sanitises its own errors, but a proxy, a gateway or an unhandled
 * corner can still put a stack trace or an HTML error page on the wire, and
 * `<ErrorBanner>` would render it in full. Anything matching this is dropped.
 */
const TECHNICAL = new RegExp([
  "traceback", "sqlalchemy", "pymysql", "psycopg", "aiomysql", "asyncpg",
  "\\bSQL\\b", "\\bSELECT\\b", "\\bINSERT INTO\\b", "\\bUPDATE\\b .*\\bSET\\b",
  "integrityerror", "operationalerror", "programmingerror",
  "<!doctype", "<html", "\\bat 0x", "node_modules", "\\.py\\b", "\\.tsx?:\\d",
  "cannot read propert", "is not a function", "undefined is not",
  "econnrefused", "econnreset", "enotfound", "etimedout",
].join("|"), "i");

/** Backend text that is a placeholder rather than an explanation. */
const EMPTY_ANSWERS = new Set([
  "", "request failed", "internal server error", "bad request", "not found",
  "forbidden", "unauthorized", "unprocessable entity", "conflict",
  "method not allowed", "service unavailable", "error", "failed",
  "something went wrong",
]);

function usable(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = text.trim();
  if (!clean || clean.length > 400) return undefined;
  if (EMPTY_ANSWERS.has(clean.toLowerCase().replace(/[.!]+$/, ""))) return undefined;
  if (TECHNICAL.test(clean)) return undefined;
  return clean;
}

/**
 * What to say when the server said nothing usable.
 *
 * `warning` where the person can fix it from the screen they are on — a missing
 * field, a duplicate, a rule they can satisfy. `error` where they cannot: a
 * permission they have not been granted, an expired session, a server that broke.
 * That split is the whole meaning of the two levels; anything else is decoration.
 */
function statusDefault(status: number): Notice {
  if (status >= 500) {
    return {
      level: "error",
      title: "Server problem",
      message: "We couldn't complete this request because of a server problem. "
        + "Nothing was saved. Please try again in a moment.",
    };
  }
  switch (status) {
    case 400:
    case 422:
      return {
        level: "warning",
        title: "Check the details entered",
        message: "Some of the details on this form are missing or not valid. "
          + "Correct them and try again.",
      };
    case 401:
      return {
        level: "error",
        title: "Signed out",
        message: "Your session has expired. Sign in again to continue — "
          + "anything unsaved on this screen is lost.",
      };
    case 403:
      return {
        level: "error",
        title: "You don't have permission",
        message: "You don't have permission to perform this action. "
          + "Ask an administrator if you need it.",
      };
    case 404:
      return {
        level: "error",
        title: "Not found",
        message: "We couldn't find what you asked for. "
          + "It may have been removed, or somebody else may have changed it.",
      };
    case 405:
      return {
        level: "error",
        title: "Not available here",
        message: "That action is not available on this screen.",
      };
    case 408:
      return {
        level: "error",
        title: "That took too long",
        message: "The request timed out before it finished. "
          + "Check your connection and try again.",
      };
    case 409:
      return {
        level: "warning",
        title: "Already exists",
        message: "This clashes with something already recorded. "
          + "Refresh the screen to see the current state, then try again.",
      };
    case 413:
      return {
        level: "warning",
        title: "File is too large",
        message: "The file you attached is larger than this screen accepts. "
          + "Attach a smaller file and try again.",
      };
    case 429:
      return {
        level: "warning",
        title: "Too many attempts",
        message: "Too many requests were sent in a row. "
          + "Wait a moment and try again.",
      };
    default:
      return {
        level: "warning",
        title: "Could not complete that",
        message: "We couldn't complete this request. "
          + "Check the details and try again.",
      };
  }
}

const OFFLINE: Notice = {
  level: "error",
  title: "Can't reach the server",
  message: "Unable to connect to the server. Nothing was saved. "
    + "Check your connection and try again.",
};

/** A sign-in attempt, as opposed to a request made with an expired token. */
function isSignInAttempt(url: string): boolean {
  return /\/(auth|supplier|carrier)\/login\b/.test(url)
    || url.includes("/login/access-token");
}

/** Is this an axios rejection, i.e. does it carry a `response` / `config` at all? */
function asAxios(error: unknown): AxiosError<ErrorEnvelope> | null {
  return (error as AxiosError | null)?.isAxiosError
    ? (error as AxiosError<ErrorEnvelope>)
    : null;
}

/**
 * The one translation. Give it anything a `catch` can hold.
 *
 * A plain `Error` a screen threw itself comes back as its own message with no title:
 * the screen already wrote the sentence and knows its own context.
 */
export function describeError(error: unknown): Notice {
  if (axios.isCancel(error)) {
    // Not a failure. TanStack Query aborts in-flight reads on every navigation and
    // every keystroke in a search box, and there is nobody left to tell.
    return { level: "info", message: "" };
  }

  const failure = asAxios(error);
  if (!failure) {
    const message = error instanceof Error
      ? error.message
      : typeof error === "string" ? error : "";
    return usable(message)
      ? { level: "error", message }
      : { ...statusDefault(0), level: "error" };
  }

  const url = String(failure.config?.url ?? "");

  if (!failure.response) {
    return failure.code === "ECONNABORTED" || /timeout/i.test(failure.message ?? "")
      ? { ...statusDefault(408), status: undefined }
      : OFFLINE;
  }

  const status = failure.response.status;
  const body = (failure.response.data ?? {}) as ErrorEnvelope;
  const fallback = statusDefault(status);

  // A rejected sign-in is not an expired session. The backend already answers it in
  // one sentence that never says whether the account exists, and that sentence is
  // the one the login form shows.
  const detail = usable(body.detail) ?? usable(body.error);
  const serverTitle = status === 401 && !isSignInAttempt(url)
    ? fallback.title // an expired token: the endpoint's own wording is not the story
    : usable(body.title);

  const message = status >= 500 || (status === 401 && !isSignInAttempt(url))
    // Never repeat a 5xx body: it is the one case where the text on the wire may
    // not have been through the backend's sanitising at all.
    ? fallback.message
    : detail ?? fallback.message;

  return {
    level: fallback.level,
    title: serverTitle ?? fallback.title,
    message,
    field: typeof body.field === "string" ? body.field : undefined,
    code: typeof body.error_code === "string" ? body.error_code : undefined,
    status,
  };
}

/** Just the sentence — what `error.message` is rewritten to. */
export function errorMessage(error: unknown): string {
  return describeError(error).message;
}

/**
 * Failures a screen is already showing inline.
 *
 * Twelve screens pin a mutation's error to an `<ErrorBanner>` next to the form AND
 * run that mutation through `useAction`, which toasts failures as a backstop. One
 * refused save, announced twice, in two places, in the same words. Neither side can
 * see the other, so the banner registers the error object it is rendering and the
 * toast asks before it speaks.
 *
 * A `WeakSet` because the key is the rejection itself: it holds nothing alive, and an
 * error object that goes out of scope takes its entry with it. Nothing is ever
 * un-claimed — a banner that stops rendering has been replaced by the next failure,
 * which is a different object.
 */
const claimed = new WeakSet<object>();

/** Called by the surface that is showing this failure inline. */
export function claimError(error: unknown): void {
  if (error && typeof error === "object") claimed.add(error as object);
}

/** Is some part of the screen already showing this failure? */
export function isErrorClaimed(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && claimed.has(error as object);
}

/**
 * Has the shared layer already put this on screen?
 *
 * A dropped connection raises the `network.unreachable` dialog and a 401 bounces the
 * browser to the sign-in page with `session.expired` behind it, both from
 * `modules/alerts/apiAlerts.ts`. A toast saying the same thing is the same news
 * twice, which is the definition of a duplicate notification. A cancelled request is
 * not news at all.
 */
export function isAnnouncedGlobally(error: unknown): boolean {
  if (axios.isCancel(error)) return true;
  const failure = asAxios(error);
  if (!failure) return false;
  if (!failure.response) return true;
  return failure.response.status === 401
    && !isSignInAttempt(String(failure.config?.url ?? ""));
}
