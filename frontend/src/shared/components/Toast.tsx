import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { useInRouterContext, useLocation } from "react-router-dom";
import { describeError, type Notice, type NoticeLevel } from "@/shared/api/errors";
import { NoticeCard, NOTICE_WIDTH } from "./notice";

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
  duration: number;
  /** Identity for de-duplication: same tone, same words. */
  key: string;
}

interface ToastApi {
  /** Auto-dismisses. For a submission that landed. */
  success: (content: ToastInput) => void;
  /** Auto-dismisses after 6s or when dismissed / navigated away. */
  error: (content: ToastInput) => void;
  /** Auto-dismisses after 6s or when dismissed / navigated away. */
  warning: (content: ToastInput) => void;
  /** Auto-dismisses. */
  info: (content: ToastInput) => void;
  /** Remove one specific notice once the screen condition that raised it is fixed. */
  dismiss: (tone: ToastTone, content: ToastInput) => void;
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

const DISMISS_AFTER = 3500;
const ERROR_DISMISS_AFTER = 6000;
/** Beyond three, a strip of toasts is a wall nobody reads. Oldest goes. */
const MAX_VISIBLE = 3;

const asContent = (content: ToastInput): ToastContent =>
  typeof content === "string" ? { title: content } : content;

const toastKey = (tone: ToastTone, content: ToastInput) => {
  const { title, message } = asContent(content);
  return `${tone}|${title}|${message ?? ""}`;
};

function RouteWatcher({ onNavigate }: { onNavigate: () => void }) {
  const inRouter = useInRouterContext();
  if (!inRouter) return null;
  return <RouteWatcherInner onNavigate={onNavigate} />;
}

function RouteWatcherInner({ onNavigate }: { onNavigate: () => void }) {
  const location = useLocation();
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current !== location.pathname) {
      lastPath.current = location.pathname;
      onNavigate();
    }
  }, [location.pathname, onNavigate]);
  return null;
}

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

  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const running = timers.current;
    return () => running.forEach(clearTimeout);
  }, []);

  const push = useCallback((tone: ToastTone, content: ToastInput) => {
    const { title, message } = asContent(content);
    if (!title && !message) return;
    const key = toastKey(tone, content);
    const id = nextId.current++;
    const duration = (tone === "success" || tone === "info") ? DISMISS_AFTER : ERROR_DISMISS_AFTER;

    setToasts((all) => {
      if (all.some((t) => t.key === key)) return all;
      const next = [...all, { id, tone, title, message, key, duration }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });

    timers.current.set(id, setTimeout(() => remove(id), duration));
  }, [remove]);

  const dismiss = useCallback((tone: ToastTone, content: ToastInput) => {
    const key = toastKey(tone, content);
    setToasts((all) =>
      all.filter((toast) => {
        if (toast.key !== key) return true;
        const timer = timers.current.get(toast.id);
        if (timer) clearTimeout(timer);
        timers.current.delete(toast.id);
        return false;
      }));
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (content) => push("success", content),
    error: (content) => push("error", content),
    warning: (content) => push("warning", content),
    info: (content) => push("info", content),
    dismiss,
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
  }), [dismiss, push]);

  return (
    <ToastContext.Provider value={api}>
      <RouteWatcher onNavigate={clearAll} />
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
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto w-full">
            <NoticeCard
              tone={toast.tone}
              title={toast.title}
              message={toast.message}
              onClose={() => remove(toast.id)}
              countdownMs={toast.duration}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
