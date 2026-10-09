import type { ReactNode } from "react";
import { Alert as HAlert } from "@heroui/react";

/**
 * The one inline alert in the app, on HeroUI's `Alert`.
 *
 * The screens had grown their own: a `role="alert"` div with a triangle and a
 * red tint here, a tinted `<p>` there, a `<Card>` with a coloured left edge on
 * a third. Same message, three shapes. This is the shape — everything else
 * imports it, and the tone decides the colour, the icon and the ARIA role.
 *
 * Tone is about consequence, not decoration:
 *   danger  — a write failed or is about to be lost. Announced, stays put.
 *   warning — the action will go through, but not the way it reads.
 *   success — a write landed. Safe to miss; prefer a toast for these.
 *   info    — context the screen needs and nothing more.
 *
 * `danger` and `warning` get `role="alert"` so a screen reader is interrupted;
 * the quiet tones are polite regions, because interrupting somebody to say a
 * thing worked is how alert fatigue starts.
 */
export type AlertTone = "danger" | "warning" | "success" | "info";

const HERO_COLOR = {
  danger: "danger",
  warning: "warning",
  success: "success",
  info: "primary",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  action,
  onClose,
  className = "",
}: {
  tone?: AlertTone;
  /** Bold first line. With no children this is the whole message. */
  title?: ReactNode;
  children?: ReactNode;
  /** A button that resolves the alert — Retry, Review, Go to settings. */
  action?: ReactNode;
  /** Supplying this renders HeroUI's dismiss ✕. */
  onClose?: () => void;
  className?: string;
}) {
  const loud = tone === "danger" || tone === "warning";
  return (
    <HAlert
      color={HERO_COLOR[tone]}
      variant="flat"
      radius="lg"
      role={loud ? "alert" : "status"}
      aria-live={loud ? "assertive" : "polite"}
      title={title}
      endContent={action}
      onClose={onClose}
      className={className}
      classNames={{
        base: "items-start gap-2.5 border border-current/15 px-3.5 py-3",
        title: "text-sm font-semibold leading-5",
        description: "text-sm leading-5 opacity-90",
        iconWrapper: "shrink-0",
      }}
    >
      {children}
    </HAlert>
  );
}
