import { Chip } from "@heroui/react";

/** The signature status vocabulary, on a HeroUI Chip. Used across every list/detail. */
type Tone = "success" | "warning" | "danger" | "primary" | "default";

const TONE: Record<string, Tone> = {
  DRAFT: "default",
  SUBMITTED: "warning",
  PENDING_APPROVAL: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  PARTIALLY_ORDERED: "primary",
  ORDERED: "primary",
  SENT_TO_VENDOR: "primary",
  ACCEPTED_BY_SUPPLIER: "success",
  PARTIALLY_RECEIVED: "primary",
  RECEIVED: "success",
  QC_PASSED: "success",
  QC_FAILED: "danger",
  ISSUED: "success",
  CANCELLED: "danger",
  CLOSED: "default",
  IN_PROGRESS: "warning",
};

/**
 * `label` overrides the words WITHOUT touching the status.
 *
 * The supplier portal needs it: our internal "SENT_TO_VENDOR" reads as nonsense on the
 * vendor's own screen — from where they are sitting that order is simply new. The
 * status itself must not be renamed for them, because it is the same document our desk
 * is looking at, so only the wording moves and the tone still comes from the real
 * status.
 */
export function StatusPill({ status, label, variant = "flat" }: { status: string; label?: string; variant?: "solid" | "bordered" | "light" | "flat" | "faded" | "shadow" | "dot" }) {
  return (
    <Chip
      size="sm"
      radius="full"
      variant={variant}
      color={TONE[status] ?? "default"}
      classNames={{ content: "text-[11px] font-semibold uppercase tracking-wide" }}
    >
      {label ?? status.replace(/_/g, " ")}
    </Chip>
  );
}
