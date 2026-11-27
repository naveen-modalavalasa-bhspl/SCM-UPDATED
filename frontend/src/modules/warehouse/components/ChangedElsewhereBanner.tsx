import { RefreshCw, MonitorSmartphone } from "lucide-react";
import type { AxiosError } from "axios";

/** Did the server refuse this save because the document changed after it was opened?
 *  (`_assert_issue_not_stale`: 409, error code CONFLICT.) */
export function isStaleSave(error: unknown): boolean {
  const response = (error as AxiosError<{ error?: { code?: string } }> | null)?.response;
  return response?.status === 409;
}

/**
 * The issue was saved somewhere else while this window had it open (QA-5 BUG_006).
 *
 * Said once, at the top, with the one thing to do about it. The form underneath is
 * left exactly as the storekeeper typed it, so they can read what they had before
 * deciding to reload — a reload is their choice, never something done to them.
 */
export function ChangedElsewhereBanner({ onReload }: { onReload: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-warn/40 bg-warn-bg/70 px-4 py-3 shadow-sm"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
        <MonitorSmartphone className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">Changed in another window</p>
        <p className="text-xs leading-relaxed text-muted">
          This issue was saved again after you opened it — on another computer, in another
          tab or by someone else. Your edits here have not been saved. Reload to see the
          latest version, then make your change again.
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-warn px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50"
      >
        <RefreshCw className="h-4 w-4" aria-hidden />
        Reload latest
      </button>
    </div>
  );
}
