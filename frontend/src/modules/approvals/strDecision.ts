import type { StrSourceReview } from "./types";

export const FORWARD_LABEL = "Approve and forward to next level";

/** Where the fix lives, said wherever an approver is told there is no next level. */
export const NO_NEXT_LEVEL_HELP =
  "Ask your admin to add the next level on Settings > Approvals Config. Until then you can change the source to one of your points, return the request or reject it.";

export interface StrDecision {
  /** The word on the Approve button. */
  label: string;
  /** False when nothing above can take it and the source is not this approver's. */
  canApprove: boolean;
  /** Why it cannot be approved. Shown beside the disabled button. */
  blocker: string | null;
  /** Forwarding a source that is not theirs says why, for the next level. */
  needsReason: boolean;
  /** The sentence on the confirm dialog: what this press does. */
  message: string;
}

/**
 * What approving an STR means for this approver, in one place, so the panel, the button
 * and the confirm dialog cannot tell three different stories. Every input is served:
 * this only words it. "Last" is the configured ladder running out, never HCM.
 */
export function strDecision(review: StrSourceReview | undefined): StrDecision {
  const plain = {
    label: "Approve",
    canApprove: true,
    blocker: null,
    needsReason: false,
    message: "The saved quantities move to the next approval level or complete the approval.",
  };
  if (!review || review.is_last_level == null) return plain;

  const last = review.is_last_level;
  const next = review.next_level?.role_name ?? review.next_level?.position_name;
  const to = next ? `to ${next}` : "to the next level";
  const owing = review.lines_owing > 0;

  if (!owing) {
    return { ...plain, message: "Everything is allocated, so approval ends here and the stock can be issued." };
  }
  if (!last) {
    return {
      ...plain,
      label: FORWARD_LABEL,
      needsReason: !review.in_scope,
      message: review.in_scope
        ? `You allocate nothing here. What is owed goes ${to}.`
        : `The source is not in your scope, so the request goes ${to}, where the same check runs again.`,
    };
  }
  if (review.in_scope) {
    return {
      ...plain,
      label: "Approve without allocating",
      message: "You are the last level. The request goes to the Fulfilment Desk, where the source point allocates what is owed.",
    };
  }
  return {
    ...plain,
    label: FORWARD_LABEL,
    canApprove: false,
    blocker: "No next level is configured, so this can't be forwarded.",
    message: NO_NEXT_LEVEL_HELP,
  };
}
