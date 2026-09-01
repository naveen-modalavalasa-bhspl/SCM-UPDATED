import { TONES, type Tone } from "@/shared/components";
import { fmtRelative } from "@/shared/datetime";
import type { ApiClient, Webhook } from "../types";

/**
 * Is this integration actually working?
 *
 * ACTIVE / INACTIVE was the only thing the row said, and it answered a different
 * question — whether an admin had switched the record off — while looking like it
 * answered this one. An application registered an hour ago, with no key and no
 * endpoint, read ACTIVE in green beside one serving ten thousand rows a night.
 *
 * The four states below are read off numbers the list already carries, so nothing new
 * is fetched and nothing new is stored. They are ordered by what stops a call from
 * landing, most fundamental first: switched off beats missing credentials, missing
 * credentials beat never having been called.
 */
export interface Health {
  label: string;
  tone: Tone;
  /** The sentence under the pill — what it means, or what is still missing. */
  note: string;
}

export function healthOf(client: Pick<ApiClient,
  "is_active" | "active_keys" | "endpoints" | "last_called_at">): Health {
  if (!client.is_active) {
    return {
      label: "Switched off", tone: "neutral",
      note: "Its keys are refused until it is switched back on.",
    };
  }
  // What is still missing, in the words of the two things that have to exist. Both
  // can be missing at once, which is the usual state five minutes after registering.
  const missing = [
    client.endpoints === 0 ? "an API to call" : "",
    client.active_keys === 0 ? "a key" : "",
  ].filter(Boolean);
  if (missing.length) {
    return {
      label: "Not usable yet", tone: "warn",
      note: `Still needs ${missing.join(" and ")}.`,
    };
  }
  if (!client.last_called_at) {
    // Carefully worded: `last_called_at` is read off the server's in-memory call
    // ring, which empties on every restart. "Nothing has ever called this" is a
    // claim the console cannot make, and it would read as a fault on an integration
    // that has been running for a year.
    return {
      label: "Ready", tone: "info",
      note: "Set up. No call seen since the server last started.",
    };
  }
  return { label: "Live", tone: "ok", note: `Last call ${fmtRelative(client.last_called_at)}.` };
}

/** The pill itself. Same tint vocabulary as the KPI strip and the status pills, so a
 *  green here means what green means everywhere else in the app. */
export function HealthPill({ health }: { health: Health }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
                      text-[11px] font-semibold uppercase tracking-wide ${TONES[health.tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {health.label}
    </span>
  );
}

/**
 * The same question, asked of an inbound webhook: is this thing actually working?
 *
 * ACTIVE / INACTIVE was all the webhook row said, exactly as it once was on the
 * application row — and it answered whether an admin had switched the record on,
 * while a webhook with no secret issued refuses every push that reaches it. Read off
 * numbers the list already carries, ordered by what stops a push from landing:
 * switched off beats a missing secret, a missing secret beats never having been sent
 * anything.
 */
export function healthOfWebhook(hook: Pick<Webhook,
  "is_active" | "has_secret" | "require_signature" | "events" | "last_received_at">): Health {
  if (!hook.is_active) {
    return {
      label: "Switched off", tone: "neutral",
      note: "Every push is refused until it is switched back on.",
    };
  }
  // The two things a registration needs before a push can land, in the words of the
  // things themselves — both can be missing at once, which is the state a webhook is
  // in the minute after it is registered.
  const missing = [
    hook.require_signature && !hook.has_secret ? "a signing secret" : "",
    hook.events.length === 0 ? "an event it may send" : "",
  ].filter(Boolean);
  if (missing.length) {
    return {
      label: "Not usable yet", tone: "warn",
      note: `Still needs ${missing.join(" and ")}.`,
    };
  }
  if (!hook.require_signature) {
    // Not a fault, but never the resting state: an unsigned webhook trusts the API
    // key alone, so anything holding a live key can post events into SCM here.
    return {
      label: "Unsigned", tone: "warn",
      note: "Bodies are not signed — any live key can post here.",
    };
  }
  if (!hook.last_received_at) {
    // Unlike an application's last call, this stamp is stored, so the absence is
    // evidence: nothing has ever arrived on this address.
    return {
      label: "Ready", tone: "info",
      note: "Set up. Nothing has been pushed to it yet.",
    };
  }
  return {
    label: "Live", tone: "ok",
    note: `Last push ${fmtRelative(hook.last_received_at)}.`,
  };
}
