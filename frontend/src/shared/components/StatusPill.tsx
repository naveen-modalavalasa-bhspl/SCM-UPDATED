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

export function StatusPill({ status }: { status: string }) {
  return (
    <Chip
      size="sm"
      radius="full"
      variant="flat"
      color={TONE[status] ?? "default"}
      classNames={{ content: "text-[11px] font-semibold uppercase tracking-wide" }}
    >
      {status.replace(/_/g, " ")}
    </Chip>
  );
}
