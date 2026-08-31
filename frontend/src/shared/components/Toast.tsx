import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { describeError, type Notice, type NoticeLevel } from "@/shared/api/errors";

/**
 * The app's transient notification strip.
 *
 * Deliberately narrow about what earns one. A toast is for the outcome of something
 * the user pressed — a submission, an approval, a dispatch — and for the failure of
 * one. Opening a page, changing a filter, loading a list and picking from a dropdown
 * are not outcomes and get nothing; a system that announces everything trains people
 * to look away from it.
 *
 * Four levels, and they mean different things:
 *
 *   success — the write landed. Closes itself; safe to miss.
 *   info    — a passing remark. Closes itself.
 *   warning — the operation did not go through and the person can fix it here
 *             (a missing field, a duplicate, a rule they can satisfy). Stays.
 *   error   — it did not go through and they cannot fix it here (no permission,
 *             session gone, server down). Stays.
 *
 * A failure that vanished after three seconds leaves somebody believing their work
 * saved, which is why only the two quiet levels self-close. Where a screen has a form
 * to pin the message next to, `<ErrorBanner>` is still the better surface; this is
 * for the call sites that have nowhere to pin one.
 *
 * Hand-rolled rather than a library: it is a list, a timer and a fixed div. sonner
 * and friends bring a portal system and an animation engine for the same result.
 */

type ToastTone = NoticeLevel;

/** A toast is a short title and, when it needs one, a sentence under it. */
export interface ToastContent {
  title: string;
  message?: string;
}

/** Call sites may pass a bare sentence; the older ones all do. */
export type ToastInput = string | ToastContent;

interface Toast extends ToastContent {
  id: number;
  tone: ToastTone;
  /** Identity for de-duplication: same tone, same words. */
  key: string;
}

interface ToastApi {
  /** Auto-dismisses. For a submission that landed. */
  success: (content: ToastInput) => void;
  /** Stays until dismissed — a failure must not vanish on its own. */
  error: (content: ToastInput) => void;
  /** Stays until dismissed. The operation did not go through. */
  warning: (content: ToastInput) => void;
  /** Auto-dismisses. */
  info: (content: ToastInput) => void;
  /**
   * Announce a caught failure, worded by `shared/api/errors.ts`.
   *
   * The single way a screen should report a write that failed with no banner to pin
   * it to: the level, the title and the sentence all come from the one translation,
   * so a 403 reads the same wherever it is caught.
   */
  fromError: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Deliberately the same vocabulary as `modules/alerts/components/AlertDialog.tsx`:
 * a white card, a tinted circular chip carrying the icon, a dark title and a muted
 * sentence under it. The colour says which KIND of thing happened; the words stay
 * black on white, where they are easiest to read.
 *
 * The old treatment tinted the whole card and painted the title AND the message in
 * the status colour — green text on green, amber on amber. It shouted, and it was
 * the hardest of the three to actually read.
 */
const TONES: Record<ToastTone, { icon: typeof CheckCircle2; chip: string; bar: string }> = {
  success: { icon: CheckCircle2, chip: "bg-ok-bg text-ok", bar: "bg-ok/60" },
  error: { icon: TriangleAlert, chip: "bg-bad-bg text-bad", bar: "bg-bad/60" },
  warning: { icon: CircleAlert, chip: "bg-warn-bg text-warn", bar: "bg-warn/60" },
  info: { icon: Info, chip: "bg-info-bg text-info", bar: "bg-info/60" },
};

const DISMISS_AFTER = 3500;
/** Beyond three, a strip of toasts is a wall nobody reads. Oldest goes. */
const MAX_VISIBLE = 3;

/**
 * Drains left to right for exactly as long as the toast has left.
 *
 * Written straight to the node rather than through state, for the same reason as
 * the alert dialog's: the callback runs a frame later, outside anything React is
 * tracking, and a `setState` there is an act() warning in every test that shows a
 * self-closing toast.
 */
function Countdown({ ms, className }: { ms: number; className: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (bar.current) bar.current.style.width = "0%";
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div aria-hidden className="h-0.5 w-full bg-line/60">
      <div
        ref={bar}
        className={`h-full ${className}`}
        style={{ width: "100%", transition: `width ${ms}ms linear` }}
      />
    </div>
  );
}

const asContent = (content: ToastInput): ToastContent =>
  typeof content === "string" ? { title: content } : content;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const running = timers.current;
    return () => running.forEach(clearTimeout);
  }, []);

  const push = useCallback((tone: ToastTone, content: ToastInput) => {
    const { title, message } = asContent(content);
    if (!title && !message) return;
    const key = `${tone}|${title}|${message ?? ""}`;
    const id = nextId.current++;

    setToasts((all) => {
      // Two presses of the same button, or one failure caught by both a mutation
      // handler and a screen, must not read as two separate things going wrong.
      // The existing toast stays where it is and its timer is restarted below.
      if (all.some((t) => t.key === key)) return all;
      const next = [...all, { id, tone, title, message, key }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });

    const selfCloses = tone === "success" || tone === "info";
    if (selfCloses) {
      timers.current.set(id, setTimeout(() => remove(id), DISMISS_AFTER));
    }
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    success: (content) => push("success", content),
    error: (content) => push("error", content),
    warning: (content) => push("warning", content),
    info: (content) => push("info", content),
    fromError: (error: unknown) => {
      const notice: Notice = describeError(error);
      // A cancelled request has no message and is nobody's news.
      if (!notice.message) return;
      push(notice.level, notice.title
        ? { title: notice.title, message: notice.message }
        // A screen's own thrown sentence stands alone: heading it with an invented
        // title would push the part worth reading into small print.
        : { title: notice.message });
    },
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so a screen reader announces the write landing; the visual toast
          is easy to miss and this is the only confirmation either way. */}
      <div
        aria-live="polite"
        // `top-20`, not `top-4`: the app shell's header and its module tab strip
        // occupy the first ~66px, and a toast pinned to the top of the viewport
        // sat ON them — covering the tabs and reading as part of the chrome.
        // Same width as the alert dialog (`max-w-sm`) so the two never look like
        // two different systems talking.
        className="pointer-events-none fixed left-1/2 top-20 z-100 flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((toast) => {
          const { icon: Icon, chip, bar } = TONES[toast.tone];
          const loud = toast.tone === "error" || toast.tone === "warning";
          const selfCloses = toast.tone === "success" || toast.tone === "info";
          return (
            <div
              key={toast.id}
              role={loud ? "alert" : "status"}
              className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-line/70 bg-content1 shadow-lg"
            >
              <div className="flex items-start gap-3 px-4 py-3.5">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${chip}`}>
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="font-display text-sm font-bold leading-5 text-ink">
                    {toast.title}
                  </div>
                  {toast.message && (
                    <div className="mt-1 text-sm leading-relaxed text-muted">
                      {toast.message}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => remove(toast.id)}
                  aria-label="Dismiss"
                  className="-mr-1.5 -mt-1 shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-content2 hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {/* The same countdown the alert dialog draws, so "it will go on its
                  own" is visible rather than a surprise. Failures have no bar,
                  which is itself the signal that this one is waiting to be read. */}
              {selfCloses && <Countdown ms={DISMISS_AFTER} className={bar} />}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
