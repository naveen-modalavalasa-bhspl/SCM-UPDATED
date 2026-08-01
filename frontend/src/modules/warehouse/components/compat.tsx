import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import {
  Button,
  Card,
  Input as SharedInput,
  Select as SharedSelect,
} from "@/shared/components";

type SelectOption = { value: string | number; label: string };

type ErrorValue = unknown;

const messageFrom = (error: ErrorValue): string | null => {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
};

export function ErrorBanner({ error }: { error?: ErrorValue }) {
  const message = messageFrom(error);
  if (!message) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  isLoading,
  busy,
  error,
  onConfirm,
  onClose,
  tone = "primary",
  danger,
}: {
  isOpen: boolean;
  title: string;
  message?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  isLoading?: boolean;
  busy?: boolean;
  error?: ErrorValue;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  tone?: "primary" | "danger";
}) {
  const loading = isLoading || busy;
  const effectiveTone = danger ? "danger" : tone;
  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center">
      <ModalContent>
        <ModalHeader className="font-display text-lg font-bold text-ink">{title}</ModalHeader>
        <ModalBody className="text-sm text-body">
          {message}
          {children}
          <ErrorBanner error={error} />
        </ModalBody>
        <ModalFooter>
          <Button variant="subtle" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={effectiveTone === "danger" ? "danger" : "primary"} onClick={onConfirm} disabled={loading}>
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="px-6 py-10 text-center">
      <div className="font-semibold text-ink">{title}</div>
      {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
    </Card>
  );
}

export function SubNav({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { key: string; label: string }[];
  value?: string;
  onChange?: (value: string) => void;
}) {
  const active = value ?? items[0]?.key;
  return (
    <div className="mb-5 overflow-x-auto border-b border-line" aria-label={label}>
      <div className="flex min-w-max gap-1">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange?.(item.key)}
            className={`border-b-2 px-4 py-3 text-sm font-medium ${
              active === item.key
                ? "border-brand text-brand"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Select({
  ariaLabel,
  errorMessage,
  isInvalid,
  ...props
}: {
  value?: string | number | "";
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  isDisabled?: boolean;
  className?: string;
  ariaLabel?: string;
  isInvalid?: boolean;
  errorMessage?: string;
}) {
  return (
    <div aria-label={ariaLabel}>
      <SharedSelect {...props} />
      {isInvalid && errorMessage && <div className="mt-1 text-xs text-bad">{errorMessage}</div>}
    </div>
  );
}

export function Input({
  errorMessage,
  isInvalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  isInvalid?: boolean;
  errorMessage?: string;
}) {
  return (
    <>
      <SharedInput {...props} className={`${props.className ?? ""} ${isInvalid ? "border-bad" : ""}`} />
      {isInvalid && errorMessage && <div className="mt-1 text-xs text-bad">{errorMessage}</div>}
    </>
  );
}
