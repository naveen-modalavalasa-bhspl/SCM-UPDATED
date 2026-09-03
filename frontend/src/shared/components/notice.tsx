import { useEffect, useRef, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";

/**
 * The one notification card in the app.
 *
 * Three surfaces announce things: the toast strip (`Toast.tsx`), the alert dialog
 * (`modules/alerts`) and the confirm modal (`Feedback.tsx`). Each had grown its own
 * tone table, its own icon set, its own countdown bar and its own idea of how big a
 * notification is — a 48px circle and a centred `text-lg` title in one, a 36px chip
 * and a left-aligned `text-sm` one in the next, a plain modal header in the third. A
 * person using the app met the same news wearing three faces, and the two that
 * appear top-centre could land on screen together looking like two different systems
 * talking at once.
 *
 * This is the face. Everything below imports it, so the vocabulary can only be
 * changed in one place:
 *
 *   ┌───────────────────────────────────────┐
 *   │ ◍  Title                            ✕ │   32px tone chip, 14px bold title
 *   │    One sentence under it.             │   13px muted sentence
 *   │                    [Cancel] [Confirm] │   only when it asks something
 *   ├───────────────────────────────────────┤   hairline countdown, self-closers
 *   └───────────────────────────────────────┘
 *
 * Small on purpose. A notification is read at a glance and then ignored; the room a
 * card takes is room taken from the work behind it.
 */

/** Tone is about consequence, never decoration. `danger` is the only one that
 *  recolours the primary button, because it is the only one that destroys. */
export type NoticeTone = "success" | "info" | "warning" | "danger" | "error";

export const NOTICE_TONES: Record<NoticeTone, {
  icon: typeof Info;
  /** Tinted circle behind the icon — the only colour on the card. */
  chip: string;
  /** The countdown hairline. */
  bar: string;
  button: "primary" | "danger";
  /** Quiet tones are polite regions; the loud ones interrupt a screen reader. */
  loud: boolean;
}> = {
  success: { icon: CheckCircle2, chip: "bg-ok-bg text-ok", bar: "bg-ok/60", button: "primary", loud: false },
  info: { icon: Info, chip: "bg-info-bg text-info", bar: "bg-info/60", button: "primary", loud: false },
  warning: { icon: CircleAlert, chip: "bg-warn-bg text-warn", bar: "bg-warn/60", button: "primary", loud: true },
  danger: { icon: TriangleAlert, chip: "bg-bad-bg text-bad", bar: "bg-bad/60", button: "danger", loud: true },
  error: { icon: TriangleAlert, chip: "bg-bad-bg text-bad", bar: "bg-bad/60", button: "primary", loud: true },
};

/** The card's width, wherever it is drawn. Kept here so the toast strip and the
 *  dialog can never be two different sizes of the same thing. */
export const NOTICE_WIDTH = "w-[min(23rem,calc(100vw-2rem))]";

/**
 * Drains left to right for exactly as long as the notice has left.
 *
 * Written straight to the node rather than through state: the callback runs a frame
 * later, outside anything React is tracking, and a `setState` there is an act()
 * warning in every test that shows a self-closing notice.
 */
export function NoticeCountdown({ ms, tone }: { ms: number; tone: NoticeTone }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (bar.current) bar.current.style.width = "0%";
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div aria-hidden className="h-0.5 w-full bg-line/60">
      <div
        ref={bar}
        className={`h-full ${NOTICE_TONES[tone].bar}`}
        style={{ width: "100%", transition: `width ${ms}ms linear` }}
      />
    </div>
  );
}

/** The tone chip on its own, for a surface that lays out its own header — the
 *  confirm modal, whose body is a form rather than a sentence. */
export function NoticeChip({ tone }: { tone: NoticeTone }) {
  const { icon: Icon, chip } = NOTICE_TONES[tone];
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${chip}`}>
      <Icon className="h-4 w-4" />
    </span>
  );
}

export function NoticeCard({
  tone,
  title,
  message,
  actions,
  onClose,
  countdownMs = null,
  testId,
}: {
  tone: NoticeTone;
  title: ReactNode;
  message?: ReactNode;
  /** Buttons, when the card asks something. A plain announcement has none. */
  actions?: ReactNode;
  /** Supplying this draws the ✕. One label — "Close" — on every surface, because
   *  a screen reader hearing "dismiss" here and "close" there is being told these
   *  are two different controls. */
  onClose?: () => void;
  /** ms until it closes itself, or null when it waits to be read. */
  countdownMs?: number | null;
  testId?: string;
}) {
  const { loud } = NOTICE_TONES[tone];
  return (
    <div
      data-testid={testId}
      className="w-full overflow-hidden rounded-2xl border border-line/70 bg-content1 shadow-lg"
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <NoticeChip tone={tone} />
        <div className="min-w-0 flex-1">
          {/* The colour says which KIND of thing happened; the words stay dark on the
              card, where they are easiest to read. Tinting the whole card and painting
              the title in the status colour — green on green, amber on amber — is what
              this replaced, and it was the hardest of the three to actually read. */}
          <div
            role={loud ? "alert" : "status"}
            className="text-sm font-semibold leading-5 text-ink"
          >
            {title}
          </div>
          {message && (
            <div className="mt-0.5 text-[13px] leading-5 text-muted">{message}</div>
          )}
          {actions && (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {actions}
            </div>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-0.5 shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-content2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* Visible rather than a surprise: "it will go on its own" is a promise, and a
          card with no bar is one waiting to be read. */}
      {countdownMs !== null && <NoticeCountdown ms={countdownMs} tone={tone} />}
    </div>
  );
}
