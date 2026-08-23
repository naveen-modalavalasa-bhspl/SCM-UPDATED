import type { ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Inbox } from "lucide-react";
// Straight from ./ui, not the barrel: the barrel re-exports this file, and a module
// that imports its own barrel is a cycle waiting to bite at load time.
import { Button, Card } from "./ui";
import { Alert } from "./Alert";

/**
 * Error, empty and confirm surfaces.
 *
 * The screens this replaced popped an antd `message` toast for every failure, which
 * vanished after three seconds and left the form looking like it had saved. A failed
 * write stays on screen here until the user does something about it. That rule still
 * holds now this lives in `shared/`: `<Toast>` announces successes, which are safe to
 * miss; failures belong in an `<ErrorBanner>` that stays put.
 */

/** Renders nothing when there is no error, so call sites need no conditional. */
export function ErrorBanner({ error, className = "" }: { error?: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  // The shape lives in <Alert> now, so the dozens of call sites already using
  // ErrorBanner pick up the new one without being touched.
  return <Alert tone="danger" title={message} className={`mb-4 ${className}`} />;
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
 */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
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
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">{title}</ModalHeader>
        <ModalBody>
          <ErrorBanner error={error} />
          {message && <p className="text-sm text-body">{message}</p>}
          {children}
        </ModalBody>
        <ModalFooter>
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
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
