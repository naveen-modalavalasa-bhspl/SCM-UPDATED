import type { ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Inbox } from "lucide-react";
// Straight from ./ui, not the barrel: the barrel re-exports this file, and a module
// that imports its own barrel is a cycle waiting to bite at load time.
import { Button, Card } from "./ui";
import { Alert } from "./Alert";
import { NoticeChip, NOTICE_TONES, type NoticeTone } from "./notice";
import { claimError, describeError } from "@/shared/api/errors";

/**
 * Error, empty and confirm surfaces.
 *
 * The screens this replaced popped an antd `message` toast for every failure, which
 * vanished after three seconds and left the form looking like it had saved. A failed
 * write stays on screen here until the user does something about it. That rule still
 * holds now this lives in `shared/`: `<Toast>` announces successes, which are safe to
 * miss; failures belong in an `<ErrorBanner>` that stays put.
 */

/**
 * Renders nothing when there is no error, so call sites need no conditional.
 *
 * The wording is not decided here: `describeError` in `shared/api/errors.ts` is the
 * one translation from a failure to something a storekeeper can read, and the dozens
 * of call sites that pass a raw axios rejection straight in get it without being
 * touched. A refusal the person can fix on this screen (a missing field, a duplicate)
 * shows amber; one they cannot (no permission, session gone, server down) shows red.
 */
export function ErrorBanner({ error, className = "" }: { error?: unknown; className?: string }) {
  if (!error) return null;
  const notice = describeError(error);
  if (!notice.message) return null;
  // This failure now has somewhere to be read. `useAction` checks before adding a
  // toast, so the twelve screens that do both stop saying it twice.
  claimError(error);
  return (
    <Alert
      tone={notice.level === "warning" ? "warning" : "danger"}
      // A screen that threw its own `new Error("Pick at least one row")` gets no
      // title: it wrote the sentence and heading it with a generic one is noise.
      title={notice.title ?? notice.message}
      className={`mb-4 ${className}`}
    >
      {notice.title ? notice.message : undefined}
    </Alert>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <Inbox className="h-8 w-8 text-muted" />
      <div className="font-display text-lg font-semibold text-ink">{title}</div>
      {hint && <p className="max-w-md text-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}

/**
 * Confirms an action that posts stock or closes a document.
 *
 * `danger` is for the irreversible ones — completing a receipt writes a ledger row
 * and there is no undo, so those get the red button and a spelled-out consequence.
 *
 * Wears the same face as every other popup in the app: the tone chip, the title
 * scale and the button pair all come from `notice.tsx`, so this and the catalog
 * dialog in `modules/alerts` read as one system rather than two. It was a plain
 * HeroUI header/body/footer at `size="lg"` before — no chip, no tone, and a large
 * box for a question that is often two lines long.
 *
 * It sizes itself to what it holds: a bare question is the same small card the
 * alert dialog draws, and only a body that collects something (a list to pick from,
 * a reason to type) opens out. A modal bigger than its contents reads as though
 * something failed to load.
 */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  tone,
  busy = false,
  confirmDisabled = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  isOpen: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Overrides the chip where the question is neither destructive nor neutral —
   *  a warning for one that moves a document or touches stock. */
  tone?: NoticeTone;
  busy?: boolean;
  /**
   * For a modal whose body collects something required. Without it the caller's
   * only defence is to ignore the click, which reads to the user as a dead button.
   */
  confirmDisabled?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const shown = tone ?? (danger ? "danger" : "info");
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size={children ? "lg" : "sm"}
      scrollBehavior="inside"
      classNames={{ base: "rounded-2xl border border-line/70" }}
    >
      <ModalContent>
        {/* Chip and title on one row, at the notification card's scale. `gap-3`
            and the 32px chip are the same measurements, so a confirm and a toast
            line up when they are on screen together. */}
        <ModalHeader className="flex items-start gap-3 pb-2">
          <NoticeChip tone={shown} />
          <span className="min-w-0 flex-1 pt-1 text-sm font-semibold leading-5 text-ink">
            {title}
          </span>
        </ModalHeader>
        <ModalBody className="pt-0">
          <ErrorBanner error={error} />
          {/* Indented to the chip, so the sentence hangs off the title rather than
              starting again at the card's edge. */}
          {message && <p className="text-[13px] leading-5 text-muted sm:pl-11">{message}</p>}
          {children}
        </ModalBody>
        <ModalFooter className="pt-2">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button
            variant={NOTICE_TONES[shown].button}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
