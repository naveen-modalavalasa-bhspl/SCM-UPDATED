import type { ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { AlertTriangle, Inbox } from "lucide-react";
import { Button, Card } from "@/shared/components";

/**
 * Error, empty and confirm surfaces.
 *
 * The screens this replaced popped an antd `message` toast for every failure, which
 * vanished after three seconds and left the form looking like it had saved. A failed
 * write stays on screen here until the user does something about it.
 */

/** Renders nothing when there is no error, so call sites need no conditional. */
export function ErrorBanner({ error, className = "" }: { error?: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={`mb-4 flex items-start gap-2 rounded-xl border border-bad/30 bg-bad-bg px-4 py-3 text-sm text-bad ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
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
 */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
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
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
