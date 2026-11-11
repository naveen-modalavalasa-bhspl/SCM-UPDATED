import { AlertTriangle, GitBranch, MapPin, ShieldCheck, UserRound, X } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { fmtQty } from "../format";
import type { Issue } from "../types";

type FamilyMember = NonNullable<Issue["child_issues"]>[number];

const DEAD = new Set(["CANCELLED", "REJECTED"]);

/**
 * One issue split across floors, drawn as a family: the parent, and one card per floor
 * issue numbered off it (`…/WHI0013-001`, `-002` …). Shown on the parent AND on every
 * floor issue, so whoever holds one piece can see where the others stand.
 *
 * The suffix is what people say out loud on the floor ("dash two is done"), so it is
 * the largest thing on each card; the full number sits under it for the paperwork.
 */
export function SplitFamilyCard({
  parentNo, parentStatus, members, currentId, unfulfilled, onOpen, onDismiss,
}: {
  parentNo: string;
  /** The parent's own status — SPLIT, CLOSED or APPROVED (all children cancelled). */
  parentStatus?: string | null;
  members: FamilyMember[];
  /** The document being viewed, highlighted in the row. */
  currentId?: number;
  /** What no floor was holding at split time — still owed on the indent. */
  unfulfilled?: { item_id: number; item_code?: string | null; item_name?: string | null;
    qty: string | number }[];
  onOpen: (id: number) => void;
  onDismiss?: () => void;
}) {
  const live = members.filter((m) => !DEAD.has(m.status));
  const posted = live.filter((m) => m.is_stock_posted).length;
  const pct = live.length ? Math.round((posted / live.length) * 100) : 0;
  const suffix = (no: string) => {
    const tail = no.startsWith(parentNo) ? no.slice(parentNo.length) : "";
    return tail.replace(/^-/, "") || no;
  };
  const sentence = parentStatus === "SPLIT"
    ? `Closes by itself when every floor issue below is posted (${posted} of ${live.length} so far).`
    : parentStatus === "CLOSED"
      ? posted > 0
        ? "Every floor issue still standing has been posted — this split is finished."
        : "Closed without issuing: its floor issues were cancelled after another issue had covered the indent."
      : parentStatus === "APPROVED"
        ? "Every floor issue was cancelled, so the whole issue is back in the manager's hands — post it, or split it again."
        : null;

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-line bg-content1">
      <div className="h-1 w-full bg-content2">
        <div className="h-full bg-ok transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-050 text-brand">
            <GitBranch className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">
              Split across floors —{" "}
              <span className="font-mono">{parentNo}</span>
            </div>
            {sentence && <p className="mt-0.5 text-xs text-muted">{sentence}</p>}
          </div>
          {members.length > 1 && (
            <span className="rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold tabular-nums text-ink">
              {posted}/{live.length} posted
            </span>
          )}
          {onDismiss && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss"
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-content2">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {members.map((m) => {
            const dead = DEAD.has(m.status);
            const current = m.id === currentId;
            return (
              <li key={m.id}>
                <button type="button" onClick={() => onOpen(m.id)}
                        className={`flex min-h-11 w-full flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors hover:bg-content2/60 ${
                          current ? "border-brand ring-2 ring-brand/20" : "border-line"
                        } ${dead ? "opacity-60" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-lg px-2 py-0.5 font-mono text-sm font-bold ${
                      m.is_stock_posted ? "bg-ok-bg text-ok" : dead ? "bg-content2 text-muted line-through" : "bg-brand-050 text-brand"
                    }`}>
                      -{suffix(m.issue_no)}
                    </span>
                    {current && <span className="text-[10px] font-semibold uppercase text-brand">You are here</span>}
                    <span className="ml-auto"><StatusPill status={m.status} /></span>
                  </div>
                  <span className="truncate font-mono text-[11px] text-muted">{m.issue_no}</span>
                  <span className="flex items-center gap-1.5 text-xs text-body">
                    <MapPin className="h-3.5 w-3.5 text-muted" />
                    {m.floor_location_name ?? "—"}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs">
                    <UserRound className="h-3.5 w-3.5 text-muted" />
                    {m.in_charge_names?.length
                      ? <span className="text-body">{m.in_charge_names.join(", ")}</span>
                      : <span className="text-warn">No floor in-charge assigned</span>}
                  </span>
                  <span className="text-xs tabular-nums text-muted">
                    <b className="text-ink">{fmtQty(Number(m.total_qty))}</b>
                    {m.total_items ? ` · ${m.total_items} line${m.total_items === 1 ? "" : "s"}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {members.length > 1 && <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
          <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-ok" />
          Each floor issue carries its own share — together they add up to {parentNo}.
          An indent line issued through any one of them can never be issued again by the
          parent, a sibling, or a fresh issue.
        </p>}

        {!!unfulfilled?.length && (
          <div className="mt-3 rounded-xl border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-4 w-4" /> No floor is holding these — still owed on the indent
            </div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {unfulfilled.map((row) => (
                <li key={row.item_id}>
                  {row.item_name ?? row.item_code ?? `#${row.item_id}`} · {fmtQty(Number(row.qty))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
