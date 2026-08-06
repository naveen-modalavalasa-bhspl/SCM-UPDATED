import { useEffect, useRef } from "react";
import { Modal, ModalContent } from "@heroui/react";
import {
  CheckCircle2, CircleAlert, Info, Trash2, TriangleAlert, X,
} from "lucide-react";
import { Button } from "@/shared/components";
import type { ActiveAlert, AlertVariant } from "../types";

/**
 * One popup card.
 *
 * Built on HeroUI's `Modal` for the overlay, focus trap and Escape handling
 * rather than a hand-rolled fixed div — everything below it is a form, and a
 * dialog that leaks focus back into that form is how people confirm the wrong
 * record. The card itself is composed here because this is a module-owned
 * surface; the buttons still come from `@/shared/components` per CLAUDE.md.
 */

const LOOK: Record<AlertVariant, {
  icon: typeof Info;
  /** Tinted circle behind the icon. */
  ring: string;
  button: "primary" | "danger";
}> = {
  success: { icon: CheckCircle2, ring: "bg-ok-bg text-ok", button: "primary" },
  info: { icon: Info, ring: "bg-info-bg text-info", button: "primary" },
  warning: { icon: CircleAlert, ring: "bg-warn-bg text-warn", button: "primary" },
  danger: { icon: TriangleAlert, ring: "bg-bad-bg text-bad", button: "danger" },
  error: { icon: TriangleAlert, ring: "bg-bad-bg text-bad", button: "primary" },
};

/** Drains left to right for exactly as long as the dialog has left. */
function Countdown({ ms }: { ms: number }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Written straight to the node rather than through state: the callback runs
    // a frame later, outside anything React is tracking, and a `setState` there
    // is an act() warning in every test that opens a self-closing alert.
    const frame = requestAnimationFrame(() => {
      if (bar.current) bar.current.style.width = "0%";
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div aria-hidden className="mt-5 h-1 w-full overflow-hidden rounded-full bg-line">
      <div
        ref={bar}
        className="h-full rounded-full bg-brand"
        style={{ width: "100%", transition: `width ${ms}ms linear` }}
      />
    </div>
  );
}

export function AlertDialog({
  alert,
  onResolve,
}: {
  alert: ActiveAlert;
  onResolve: (confirmed: boolean) => void;
}) {
  const { icon: Icon, ring, button } = LOOK[alert.variant];
  const isConfirm = alert.mode === "confirm";
  // The one line that decides the whole desktop treatment below. A dialog that
  // drains its own countdown is a notification — it must not seize the page. A
  // dialog that waits for a click is a decision, and the dim is what stops the
  // wrong record being deleted by someone reading the screen behind it.
  const isTransient = alert.autoCloseMs !== null;
  const confirmRef = useRef<HTMLDivElement>(null);

  // Focus the safe choice. On a destructive confirm the keyboard should not be
  // one Enter away from deleting the record, so Cancel takes focus there.
  useEffect(() => {
    const target = confirmRef.current?.querySelector<HTMLButtonElement>(
      alert.variant === "danger" && isConfirm ? "button:last-of-type" : "button:first-of-type",
    );
    target?.focus();
  }, [alert.id, alert.variant, isConfirm]);

  return (
    <Modal
      isOpen
      hideCloseButton
      size="sm"
      placement="center"
      // Only a plain alert can be waved away. A confirm has to be answered, or
      // "did I cancel or did it just close?" becomes a support ticket.
      isDismissable={!isConfirm}
      isKeyboardDismissDisabled={false}
      // A self-closing card in the corner must not shift the page behind it; a
      // dialog waiting for an answer should hold everything still.
      shouldBlockScroll={!isTransient}
      onClose={() => onResolve(false)}
      // Below 768px nothing changes: centred over a dimmed, blurred page,
      // because there the dialog *is* the screen.
      //
      // On desktop every dialog is a small card pinned top-centre — never
      // centred, never covering the work. Only the backdrop differs:
      //
      //   self-closing    clear. It is a notification; the page behind it stays
      //                   readable and keeps its place.
      //   needs an answer blurred. The blur is what pulls the eye onto a
      //                   Delete/Cancel pair instead of the screen behind it.
      //
      // `md:` variants land after the base utilities in Tailwind's output, so
      // each one wins over the slot class it overrides without `!important`.
      classNames={{
        backdrop: isTransient
          ? "bg-overlay/50 backdrop-blur-sm md:bg-transparent md:backdrop-filter-none"
          : "bg-overlay/50 backdrop-blur-sm",
        wrapper: "md:items-start md:justify-center md:pt-4",
        base: "rounded-2xl border border-line/70 bg-content1 md:max-w-sm md:shadow-2xl",
      }}
    >
      <ModalContent>
        <div
          className="relative px-6 pb-6 pt-7 text-center md:px-5 md:pb-5 md:pt-6"
          data-testid="alert-dialog"
        >
          <button
            type="button"
            onClick={() => onResolve(false)}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-lg p-1.5 text-muted transition hover:bg-content2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>

          <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${ring}`}>
            <Icon className="h-6 w-6" />
          </div>

          <h2
            role={alert.variant === "success" || alert.variant === "info" ? "status" : "alert"}
            className="font-display text-lg font-bold text-ink"
          >
            {alert.title}
          </h2>
          {alert.message && (
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
              {alert.message}
            </p>
          )}

          {(alert.confirmLabel || alert.cancelLabel) && (
            <div
              ref={confirmRef}
              className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center"
            >
              {alert.confirmLabel && (
                <Button
                  variant={button}
                  onClick={() => onResolve(true)}
                  className="w-full sm:flex-1"
                >
                  <span className="flex items-center justify-center gap-2">
                    {alert.variant === "danger" && isConfirm && <Trash2 className="h-4 w-4" />}
                    {alert.confirmLabel}
                  </span>
                </Button>
              )}
              {alert.cancelLabel && (
                <Button
                  variant="subtle"
                  onClick={() => onResolve(false)}
                  className="w-full sm:flex-1"
                >
                  {alert.cancelLabel}
                </Button>
              )}
            </div>
          )}

          {alert.autoCloseMs !== null && <Countdown ms={alert.autoCloseMs} />}
        </div>
      </ModalContent>
    </Modal>
  );
}
