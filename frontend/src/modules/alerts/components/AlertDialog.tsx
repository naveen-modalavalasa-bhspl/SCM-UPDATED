import { useEffect, useRef } from "react";
import { Modal, ModalContent } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { Button } from "@/shared/components";
import { NoticeCard, NOTICE_TONES } from "@/shared/components/notice";
import type { ActiveAlert } from "../types";

/**
 * One popup card.
 *
 * The CARD is `shared/components/notice.tsx` — the same one the toast strip draws,
 * at the same width, with the same tone chip, the same type scale and the same
 * countdown hairline. This file owns only the SHELL: the overlay, the focus trap and
 * Escape handling, which come from HeroUI's `Modal` rather than a hand-rolled fixed
 * div because everything below a dialog is a form, and a dialog that leaks focus
 * back into that form is how people confirm the wrong record.
 *
 * Before this it drew its own: a 48px circle, a centred `text-lg` title and `pt-7`
 * padding, against the toast's 36px chip and left-aligned `text-sm`. Same news,
 * two faces, and the two share a lane on desktop.
 */

/** Drives the confirm button's colour, and nothing else on the card. `danger` is
 *  the only tone that destroys, so it is the only one that recolours. */
export function AlertDialog({
  alert,
  onResolve,
}: {
  alert: ActiveAlert;
  onResolve: (confirmed: boolean) => void;
}) {
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
    const buttons = confirmRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons?.length) return;
    // Cancel is drawn FIRST and Confirm last, the usual reading order for a pair of
    // choices, so the safe one is the first button rather than the last.
    const safeFirst = alert.variant === "danger" && isConfirm;
    (safeFirst ? buttons[0] : buttons[buttons.length - 1])?.focus();
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
        // No card chrome of its own: `NoticeCard` brings the border, the radius and
        // the shadow, and a second set around it would draw a box inside a box.
        base: "bg-transparent shadow-none md:max-w-[23rem]",
      }}
    >
      <ModalContent>
        <div data-testid="alert-dialog">
          <NoticeCard
            tone={alert.variant}
            title={alert.title}
            message={alert.message}
            onClose={() => onResolve(false)}
            countdownMs={alert.autoCloseMs}
            actions={(alert.confirmLabel || alert.cancelLabel) ? (
              <div ref={confirmRef} className="flex w-full flex-wrap items-center justify-end gap-2">
                {alert.cancelLabel && (
                  <Button variant="subtle" onClick={() => onResolve(false)}>
                    {alert.cancelLabel}
                  </Button>
                )}
                {alert.confirmLabel && (
                  <Button
                    variant={NOTICE_TONES[alert.variant].button}
                    onClick={() => onResolve(true)}
                  >
                    <span className="flex items-center justify-center gap-2">
                      {alert.variant === "danger" && isConfirm && <Trash2 className="h-4 w-4" />}
                      {alert.confirmLabel}
                    </span>
                  </Button>
                )}
              </div>
            ) : undefined}
          />
        </div>
      </ModalContent>
    </Modal>
  );
}
