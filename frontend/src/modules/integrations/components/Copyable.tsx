import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button, Card, useToast } from "@/shared/components";
import { errorMessage } from "@/shared/api/errors";

export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    const written = navigator.clipboard?.writeText(text);
    if (written) {
      await written;
      return true;
    }
  } catch {
    // Fall through to the textarea carrier below.
  }

  return fallbackCopy(text);
}

function fallbackCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  // Into the open dialog, not onto `document.body`. HeroUI's modal contains focus:
  // a carrier parked outside it has focus pulled straight back out from under
  // `select()`, so `execCommand` copied nothing and the press said nothing — which
  // is exactly where the most important copy on this console lives ("Copy this key
  // now"). The topmost dialog is the layer the reader is actually looking at.
  const dialogs = document.querySelectorAll<HTMLElement>("[role='dialog'], dialog");
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  const restore = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.top = "0";
  host.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    // The dialog keeps the focus it had, so the copy does not move the reader.
    if (restore && restore !== document.body) restore.focus?.();
  }
}

export function CopyButton({
  value,
  label = "Copy",
  title,
  disabled,
}: {
  value: string;
  label?: string;
  title?: string;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    const ok = await writeToClipboard(value);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast.success("Copied to clipboard");
    } else {
      toast.error("Copy did not work. Select the text with your mouse and press Ctrl+C.");
    }
  };

  return (
    <Button variant="ghost" onClick={copy} disabled={disabled || !value} className="min-w-0" title={title}>
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CopyChip({
  value,
  display,
  title,
  tag,
  copiedMessage,
  resolve,
}: {
  value: string;
  display: string;
  title?: string;
  /** Names what the press actually puts on the clipboard, when that is less than
   *  the row shows — a masked key copies the whole key behind the dots. */
  tag?: string;
  copiedMessage?: string;
  /** Fetches what to copy when the row itself only holds a masked stand-in. It is
   *  called on pointer-down, hover and focus as well as on the press, so the value is
   *  already in hand by the time the click lands and the clipboard write stays inside
   *  the gesture — a write that happens after an await is refused by some browsers,
   *  and on a plain-http LAN host there is no `navigator.clipboard` at all, only the
   *  `execCommand` carrier below, which needs the activation the click still holds.
   *  Hover does not exist on a touch screen; pointer-down always fires, and fires
   *  before the click. The caller caches, so the extra calls cost one request. */
  resolve?: () => Promise<string>;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let text = value;
    if (resolve) {
      try {
        text = await resolve();
      } catch (err) {
        // The server's own sentence, not a shrug. "Only this key's hash is stored"
        // is a different problem from a dropped connection and has a different
        // answer, and a press that reported neither left the reader retrying.
        toast.error(errorMessage(err));
        return;
      }
    }
    if (!text) return;
    const ok = await writeToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      toast.success(copiedMessage ?? "Copied to clipboard");
    } else {
      toast.error("Copy did not work. Select the text with your mouse and press Ctrl+C.");
    }
  };

  const warm = () => {
    if (resolve) void resolve().catch(() => undefined);
  };

  return (
    <button
      type="button"
      title={title}
      onClick={copy}
      onPointerDown={warm}
      onMouseEnter={warm}
      onFocus={warm}
      className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line
                 bg-content2 px-2 py-1 font-mono text-[11px] text-muted transition
                 hover:border-brand/40 hover:text-ink focus-visible:outline-none
                 focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <span className="truncate">{display}</span>
      {tag && (
        <span className="shrink-0 rounded border border-line bg-content1 px-1 text-[9px]
                         font-semibold uppercase tracking-wider text-muted">
          {tag}
        </span>
      )}
      {copied ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

export function SecretField({
  label,
  value,
  revealed = false,
  note,
}: {
  label: string;
  value: string;
  revealed?: boolean;
  note?: string;
}) {
  const [open, setOpen] = useState(revealed);
  const shown = open ? value : "••••••••••••••••••••••••••••••••";

  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-ink">{label}</div>
          {note && <div className="mt-0.5 text-xs text-muted">{note}</div>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setOpen((held) => !held)}>
            {open ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {open ? "Hide" : "Reveal"}
          </Button>
          <CopyButton value={value} disabled={!value} />
        </div>
      </div>
      <textarea
        readOnly
        value={shown}
        onFocus={(event) => event.currentTarget.select()}
        className={`w-full rounded-lg border border-line bg-content1 p-3 font-mono text-xs
                    text-ink ${open ? "" : "select-none blur-[1.5px]"}`}
        rows={2}
      />
    </Card>
  );
}
