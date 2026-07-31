import { Chip } from "@heroui/react";
import { StatusPill } from "@/shared/components";
import type { IndentJourney, IndentJourneyStage } from "../types";

function cleanStageName(value: string) {
  return value.replace(/[A-Za-z]+/g, (word) =>
    word.length > 3 && word === word.toUpperCase()
      ? `${word[0]}${word.slice(1).toLowerCase()}`
      : word
  );
}

function stageName(stage?: IndentJourneyStage) {
  const title = stage?.title.trim().replace(/\s+/g, " ");
  if (!title) return null;
  if (/Final Approval/i.test(title)) return "SPH/COO";

  let name = title
    .replace(/\s+(Review|Approval)$/i, "")
    .replace(/\s+or\s+/gi, "/")
    .replace(/\s*\/\s*/g, "/")
    .trim();

  const positionName = stage?.position_name
    ?.split("-", 1)[0]
    .trim()
    .replace(/\s+/g, " ");
  if (
    positionName
    && (
      /^(Approval|Review)$/i.test(name)
      || (/^[A-Z]{1,4}$/.test(name) && positionName.length > name.length)
    )
  ) {
    name = positionName;
  }
  return name ? cleanStageName(name) : null;
}

function pendingStageLabel(journey?: IndentJourney) {
  const name = stageName(journey?.stages.find((stage) => stage.is_current));
  return name ? `Pending at ${name}` : "Pending Approval";
}

function rejectedStageLabel(journey?: IndentJourney) {
  const name = stageName(journey?.stages.find((stage) => stage.status === "REJECTED"));
  return name ? `Rejected by ${name}` : null;
}

export function IndentStatusBadge({ status, journey }: { status: string; journey?: IndentJourney }) {
  const label = status === "PENDING_APPROVAL"
    ? pendingStageLabel(journey)
    : status === "REJECTED"
      ? rejectedStageLabel(journey)
      : null;
  if (!label) return <StatusPill status={status} />;

  return (
    <Chip
      size="sm"
      radius="full"
      variant="flat"
      color={status === "REJECTED" ? "danger" : "warning"}
      classNames={{ content: "text-[11px] font-semibold uppercase tracking-wide" }}
    >
      {label}
    </Chip>
  );
}
