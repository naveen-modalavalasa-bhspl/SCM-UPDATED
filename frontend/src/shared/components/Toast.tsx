import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { describeError, type Notice, type NoticeLevel } from "@/shared/api/errors";
import { NoticeCard, NOTICE_WIDTH } from "./notice";

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

/* The card, the tones, the icons and the countdown all come from `notice.tsx`, so
 * the strip and the alert dialog are literally the same component wearing the same
 * measurements. They used to be two hand-kept copies that drifted. */

const DISMISS_AFTER = 3500;
/** Beyond three, a strip of toasts is a wall nobody reads. Oldest goes. */
const MAX_VISIBLE = 3;

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
        // occupy the first ~66px, and a toast pinned to the top of the viewport sat
        // ON them — covering the tabs and reading as part of the chrome.
        //
        // Same lane, same width and same card as the alert dialog (`NOTICE_WIDTH`),
        // so a toast and a dialog never look like two different systems talking.
        className={`pointer-events-none fixed left-1/2 top-20 z-100 flex ${NOTICE_WIDTH} -translate-x-1/2 flex-col items-center gap-2`}
      >
        {toasts.map((toast) => {
          // Only the two quiet levels draw a countdown; a failure with no bar is
          // itself the signal that this one is waiting to be read.
          const selfCloses = toast.tone === "success" || toast.tone === "info";
          return (
            <div key={toast.id} className="pointer-events-auto w-full">
              <NoticeCard
                tone={toast.tone}
                title={toast.title}
                message={toast.message}
                onClose={() => remove(toast.id)}
                countdownMs={selfCloses ? DISMISS_AFTER : null}
              />
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
