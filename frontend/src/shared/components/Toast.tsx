import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

/**
 * Transient confirmation that a write landed.
 *
 * Deliberately narrow: this is for successes and passing remarks, not for failures.
 * A toast disappears, and a failed write that disappears leaves someone believing
 * their work saved — that is what `<ErrorBanner>` is for, pinned next to the form
 * that failed. `useAction` still toasts errors as a backstop for call sites with
 * nowhere to pin a banner, and those toasts never auto-dismiss.
 *
 * Hand-rolled rather than a library: it is a list, a timer and a fixed div. sonner
 * and friends bring a portal system and an animation engine for the same result.
 */

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  /** Auto-dismisses after 4s. */
  success: (message: string) => void;
  /** Stays until dismissed — a failure must not vanish on its own. */
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONES: Record<ToastTone, { icon: typeof CheckCircle2; className: string }> = {
  success: { icon: CheckCircle2, className: "border-ok/30 bg-ok-bg text-ok" },
  error: { icon: TriangleAlert, className: "border-bad/30 bg-bad-bg text-bad" },
  info: { icon: Info, className: "border-line bg-content2 text-body" },
};

const DISMISS_AFTER = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, tone, message }]);
    // Errors stay. Something went wrong and the person needs to read it.
    if (tone !== "error") setTimeout(() => remove(id), DISMISS_AFTER);
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    success: (message) => push("success", message),
    error: (message) => push("error", message),
    info: (message) => push("info", message),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so a screen reader announces the write landing; the visual toast
          is easy to miss and this is the only confirmation either way. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed left-1/2 top-4 z-[100] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((toast) => {
          const { icon: Icon, className } = TONES[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex w-full items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg ${className}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{toast.message}</span>
              <button
                onClick={() => remove(toast.id)}
                aria-label="Dismiss"
                className="-mr-1 -mt-1 rounded p-1 opacity-70 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
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
