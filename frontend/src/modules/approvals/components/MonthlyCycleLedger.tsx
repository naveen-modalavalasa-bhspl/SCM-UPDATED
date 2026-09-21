import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Boxes, CalendarRange, CheckCircle2, ChevronRight, ClipboardList,
  Clock, Download, EyeOff, FileText, Layers, MapPin, MessageSquareQuote, Package,
  UserRound,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  Button, Can, Card, ErrorBanner, Input, KpiTiles, PageHeader, StatusPill,
  type KpiTileSpec,
} from "@/shared/components";
import { fmtDate, fmtDateTime } from "@/shared/datetime";
import { approvalsApi } from "../api";
import type {
  CycleLedger, CycleLedgerIndent, CycleLedgerItem, CycleLedgerItemSite,
  DecisionLedger, DecisionLedgerQuantityChange,
} from "../types";
import {
  type CycleIndentLine, indentsPerRequester, linesByIndent, reasonsOf,
} from "../cycleIndentLines";
import {
  DecisionChip, ItemRow, PendingNow, QTY_GRID, QtyArrow, SectionHead, Segment,
  SummaryHeader, initials, num, toneFor,
} from "./ledgerParts";

/**
 * A MONTH, as the approver who signed it decided it.
 *
 * The regular Decision Ledger answers "what did I do to THIS document", and for a
 * regular indent that is the whole question. A monthly indent is not one document:
 * the Consolidation screen takes the cycle in a single press and
 * `approve_consolidation` walks it indent by indent, so one click writes one
 * `wf_actions` row per site — six on the live database, nine hundred at the scale
 * this was sized for. Every one of those rows then became its own line in My
 * Decisions and its own ledger page, each carrying the same sibling table in its
 * sidebar, and the question the approver actually had was answered nowhere: how
 * much of an item did I approve across every site that asked for it, which sites
 * did I cut, and which of the month's indents never reached me.
 *
 * So the page is the CYCLE, read two ways over one payload:
 *
 *   By item   the roll-up — one row per item across every site, with the split of
 *             approved / cut / still waiting drawn as a bar, because "112 asked,
 *             62 approved" is four numbers before it is a shape. This view exists
 *             nowhere else and is therefore the one the page opens on.
 *   By indent the register — one row per indent that reached this approver, with
 *             the decision taken on it, where the document is now, and every line
 *             of it a press away.
 *
 * There was a THIRD tab, "This indent", and it is gone. It drew the one member the
 * reader happened to arrive on — the document named in the URL — a third time,
 * beside a roll-up that contains it and a register that lists it with ten siblings
 * and opens any of them in place. A cycle is MANY indents; a tab that can only ever
 * show one of them was answering a question nobody had by the time they got here.
 * The only thing it alone could say, the per-line quantity audit, moved onto the
 * line it describes (`LineAudit`), which is why the server now passes
 * `quantity_history` through onto each site of the roll-up. So did the "still
 * waiting for your decision" card that sat under it: the register says that about
 * every waiting member, on the row, with the same button.
 *
 * NOTHING ON THIS PAGE NAVIGATES ANY MORE, except the one press that is a different
 * job (Decide, which goes to the approval screen). A register row OPENS WHERE IT
 * IS — the comment the approver left, every line of that indent, and where the
 * document sits now — and a site line under an item crosses to the register and
 * opens the row there. The old "Open ledger" link went to
 * `/approvals/decisions/INDENT/<id>`, which for a MONTHLY indent renders this
 * component again against a different anchor: the reader left the month to look at
 * one member of it and arrived back at the month, having lost their filter, their
 * search and their place in the list. The panel costs no request either
 * (`../cycleIndentLines` re-keys the roll-up the payload already carries), so the
 * one thing the six-column table could not answer — which items make up 43 -> 39 —
 * is now the cheapest thing on the screen.
 *
 * DENSITY is a feature of this page, not an accident of it. It carried a hero, four
 * tiles, a four-stat context strip and then a table with six columns and two lines
 * of text in every cell, eleven rows deep — three bands of arithmetic before the
 * first fact, and "PENDING APPROVAL / with MAHENDRA Y" printed eleven times under a
 * heading that said it once. The strip is gone (the hero's bar IS requested /
 * approved / cut), the subtitles are one short line, and a collapsed row is a single
 * line of numbers with everything else a press away.
 *
 * COLOUR is the outcome and nothing else, and every outcome now has its OWN. The
 * five words an approver has to tell apart at a glance are five hues: waiting blue,
 * approved green, partially approved amber, denied red, and returned violet — that
 * last one was sharing the amber, which meant "I cut it and sent it on" and "I sent
 * it back" were the same fill on a register of eleven rows. The vocabulary lives in
 * `ledgerParts`, one copy for both ledgers.
 *
 * The BARS are the outcome at full strength — the rails down the cards, the strip
 * across the hero, the proportion bar. They were briefly lightened, on the argument
 * that a rail carries no fact of its own; pale strips read as sugary and as a page
 * that had not finished loading, and the thing that actually made eleven rails feel
 * like eleven alarms was their WIDTH. They are back to 1px and 1.5px at full colour.
 *
 * A month is MEANT to hold one indent per site, and the rule that would enforce it
 * is not written yet — so the register does not assume it: a row raised by somebody
 * who put several into this cycle says how many, and the rest say nothing.
 *
 * NOTHING is summed in the browser. Every figure comes from the server, off the
 * same `_item_snapshot` the single-indent ledger reads, so a number on the roll-up
 * and the number on an indent's own page cannot disagree. The outcome words, the
 * scope sentence and the headline are served too.
 *
 * RBAC: the payload is already cut to the members of the cycle this login is part
 * of the trail of — signed, or sitting with them now — and the whole cycle only for
 * the auditor holding `approval.trail.view_all`. What was left out is still COUNTED
 * and said out loud (`scope.note`), because a roll-up that quietly counts fewer
 * documents than the month holds reads as a page with missing data. The one action
 * on the page, opening an indent still on this approver's desk, is behind
 * `<Can do="indent.approve">` — and behind the server's own gate on the screen it
 * leads to, which is the check that matters.
 */

type View = "ITEM" | "SITE";

/** The month's split, as a shape. Approved, cut and still-waiting are the three
 *  things that can happen to a requested unit and they always add to the ask, so
 *  one bar states the whole row before a number is read. A segment under 2% still
 *  draws — a single denied unit out of nine hundred is exactly the thing somebody
 *  came to this page to find. */
function SplitBar({ approved, cut, waiting, label }: {
  approved: number; cut: number; waiting: number; label: string;
}) {
  const total = approved + cut + waiting;
  if (total <= 0) return null;
  // Full strength, like the rails. A summary bar is the one element on the page
  // whose whole job is to be read from across the room, and the pale version of it
  // read as a loading skeleton. The legend under it uses the same tokens, so the
  // dot beside "Approved 360" and the green it is pointing at are the same green
  // rather than two shades that invite the question of what the difference means.
  const parts = [
    { key: "approved", value: approved, tone: "bg-ok-rail", text: "approved" },
    { key: "cut", value: cut, tone: "bg-bad-rail", text: "cut" },
    { key: "waiting", value: waiting, tone: "bg-info-rail", text: "still with you" },
  ].filter((part) => part.value > 0);
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-content2"
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${num(p.value)} ${p.text}`).join(", ")}`}
    >
      {parts.map((part) => (
        <span
          key={part.key}
          className={`${part.tone} h-full`}
          style={{ width: `${Math.max((part.value / total) * 100, 2)}%` }}
        />
      ))}
    </div>
  );
}

/** The three words the bar is drawn from, spelled out once under it. */
function SplitLegend({ approved, cut, waiting, uom }: {
  approved: number; cut: number; waiting: number; uom?: string | null;
}) {
  const parts = [
    { key: "a", dot: "bg-ok", label: "Approved", value: approved, show: true },
    { key: "c", dot: "bg-bad", label: "Cut", value: cut, show: cut > 0 },
    { key: "w", dot: "bg-info", label: "Still with you", value: waiting, show: waiting > 0 },
  ].filter((part) => part.show);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {parts.map((part) => (
        <span key={part.key} className="inline-flex items-center gap-1.5 text-muted">
          <span className={`h-2 w-2 rounded-full ${part.dot}`} />
          {part.label}
          <span className="tabular font-bold text-ink">{num(part.value)}</span>
          {uom ? <span className="text-muted">{uom}</span> : null}
        </span>
      ))}
    </div>
  );
}

/* ---------------- By item ---------------- */

/** One site under an item. Pressing it no longer LEAVES: it crosses to the
 *  register and opens that indent in place, which is the same month read the other
 *  way round rather than a different page. */
function SiteLine({ site, onOpen }: {
  site: CycleLedgerItemSite;
  onOpen: (indentId: number) => void;
}) {
  const tone = toneFor(site.decision);
  return (
    <button
      type="button"
      onClick={() => onOpen(site.indent_id)}
      title={`Open ${site.indent_no} in the register`}
      className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line/70 bg-content1 px-2.5 py-2 text-left transition hover:border-brand/40 hover:bg-content2"
    >
      <span className={`h-6 w-1 shrink-0 rounded-full ${tone.bar}`} aria-hidden="true" />
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-content2 text-[10px] font-bold text-muted">
        {initials(site.requester ?? "?")}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">
          {site.requester ?? "Requester unavailable"}
        </span>
        <span className="mono block truncate text-[11px] text-muted">
          {site.indent_no}
          {site.office_name ? ` · ${site.office_name}` : ""}
        </span>
      </span>
      <QtyArrow requested={site.requested} approved={site.approved} className="shrink-0 text-sm" />
      {site.is_excluded && <DroppedChip />}
      <DecisionChip value={site.decision} />
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
    </button>
  );
}

/** A line the approver took OFF the indent entirely, which is not the same event as
 *  cutting it to zero and must not wear the same word. */
function DroppedChip() {
  return (
    <span className="shrink-0 rounded-full bg-bad-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-bad">
      Dropped
    </span>
  );
}

const SITES_SHOWN = 12;

function ItemCard({ item, onOpenIndent }: {
  item: CycleLedgerItem;
  onOpenIndent: (indentId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const tone = toneFor(item.decision);
  const cut = Math.max(item.decided_requested - item.approved, 0);
  const sites = all ? item.sites : item.sites.slice(0, SITES_SHOWN);
  return (
    <div className="flex overflow-hidden rounded-xl border border-line bg-content1">
      <span aria-hidden="true" className={`w-1 shrink-0 ${tone.bar}`} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((on) => !on)}
          className="w-full p-3 text-left transition hover:bg-content2/50"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-ink">
                {item.item_name ?? item.item_code ?? `Item #${item.item_id}`}
              </p>
              <p className="mono text-xs text-muted">
                {item.item_code ?? "No code"}{item.uom_code ? ` · ${item.uom_code}` : ""}
              </p>
            </div>
            <DecisionChip value={item.decision} />
          </div>

          <div className="mt-3">
            <SplitBar
              approved={item.approved}
              cut={cut}
              waiting={item.waiting_quantity}
              label={item.item_name ?? item.item_code ?? "Item"}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
              <SplitLegend
                approved={item.approved}
                cut={cut}
                waiting={item.waiting_quantity}
                uom={item.uom_code}
              />
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand">
                <MapPin className="h-3.5 w-3.5" />
                {item.request_count} {item.request_count === 1 ? "indent" : "indents"}
                {item.site_count > 0 && `, ${item.site_count} ${item.site_count === 1 ? "site" : "sites"}`}
                {item.reduced_sites > 0 ? ` · ${item.reduced_sites} cut` : ""}
                {item.excluded_sites > 0 ? ` · ${item.excluded_sites} dropped` : ""}
                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
              </span>
            </div>
          </div>
        </button>

        {open && (
          <div className="space-y-1.5 border-t border-line bg-content2/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Who asked for this, and what you gave them
            </p>
            {sites.map((site) => (
              <SiteLine key={site.line_id} site={site} onOpen={onOpenIndent} />
            ))}
            {item.sites.length > SITES_SHOWN && (
              <Button variant="ghost" onClick={() => setAll((on) => !on)}>
                {all
                  ? `Show the first ${SITES_SHOWN}`
                  : `Show all ${item.sites.length} indents`}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- By indent ---------------- */

/* The register used to be a six-column table whose last column was a link OUT of
 * the page, and for a monthly indent that link led back to this page against a
 * different anchor. Eleven rows of "PENDING APPROVAL / with MAHENDRA Y" under a
 * heading saying the same thing eleven times was most of the text on the screen,
 * and the one question a row could not answer -- WHICH items make up 43 -> 39 --
 * was the reason to press it.
 *
 * So a row opens where it is. The collapsed line is the whole decision at a glance
 * (who, how much, what you did, where it sits now); everything the other columns
 * carried is inside it, said once. `ResponsiveList` is deliberately not used here,
 * for the reason the By-item list above already does not use it: a HeroUI table row
 * cannot carry a panel under itself. Rule 12's point is that a list must never be a
 * table a phone has to scroll sideways, and a card list that stacks is the other
 * half of that rule rather than an exception to it.
 */

/** One width for the quantity column, on the heading and on every row, so the
 *  arrows line up down the panel instead of wandering with the item name — but only
 *  from `sm`. On a phone a fixed column leaves the item name a sliver, and the item
 *  is the reason the panel was opened. Below that the arrow sizes itself and the
 *  change column drops out entirely: it is arithmetic on two numbers already on the
 *  row, which is the first thing to lose when there is no room.
 *
 *  Wide enough for the HEADING to sit in the same three tracks as the numbers —
 *  "Reached you" ending where the left figures end, "Approved" starting where the
 *  right ones start. A heading centred over a column of numbers it does not share a
 *  grid with is the other half of the raggedness. */
const QTY_COL = "shrink-0 sm:w-[168px]";
const CHANGE_COL = "hidden shrink-0 text-right sm:block sm:w-[76px]";

/**
 * Who moved this line, from what to what, at which rung.
 *
 * This is the whole of what the retired "This indent" tab could say that the
 * register cannot — so it moved here rather than being dropped with the tab. That
 * tab was the one document the reader happened to arrive on, shown a third time
 * beside a roll-up that contains it and a register that lists it with ten siblings;
 * a monthly cycle is many indents, and a tab that can only ever show one of them
 * was answering a question the URL had already answered.
 *
 * Drawn ONLY where there are events. `ItemRow` on the regular ledger says "(no
 * change to this line)" and "(legacy detail unavailable)" instead, which is right
 * on a page about one document and is six rows of nothing on a panel about eleven.
 * Closed by default, always: a disclosure that opens itself is not a disclosure.
 */
function LineAudit({ history }: { history: DecisionLedgerQuantityChange[] }) {
  if (!history.length) return null;
  return (
    <details className="group mt-1.5">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-[11px] font-semibold text-brand transition-colors hover:bg-brand-050 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        Who changed this ({history.length})
      </summary>
      <div className="mt-1.5 space-y-1.5 border-l-2 border-line pl-2.5">
        {history.map((event) => (
          <div key={event.audit_id} className="text-xs">
            <p className="tabular font-semibold text-ink">
              {num(event.previous_quantity)}
              <span className="mx-1 font-normal text-muted">&rarr;</span>
              {num(event.new_quantity)}
              {event.reduction > 0 && (
                <span className="ml-1.5 font-normal text-bad">
                  −{num(event.reduction)}
                </span>
              )}
            </p>
            <p className="text-muted">
              {event.actor_name ?? "Actor unavailable"}
              {event.stage_name ? ` · ${event.stage_name}` : ""}
              {event.changed_at ? ` · ${fmtDateTime(event.changed_at)}` : ""}
            </p>
            {event.reason && <p className="italic text-body">{event.reason}</p>}
          </div>
        ))}
      </div>
    </details>
  );
}

function LineTable({ lines }: { lines: CycleIndentLine[] }) {
  return (
    <div className="space-y-1">
      {/* ONE set of headings for the whole panel, not a label per number. */}
      <div className="hidden items-end gap-3 px-2.5 text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted sm:flex">
        <span className="h-2 w-2 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">Item</span>
        {/* The SAME grid the rows use, so each half of the heading lands over the
            figures it names instead of floating centred above both. */}
        <span className={`grid ${QTY_GRID} ${QTY_COL}`}>
          <span className="text-right">Reached you</span>
          <span aria-hidden="true" />
          <span className="text-left">Approved</span>
        </span>
        <span className={CHANGE_COL}>Change</span>
      </div>
      {lines.map((line) => {
        const tone = toneFor(line.decision);
        const change = line.change;
        return (
          <div
            key={line.line_id}
            className="rounded-lg border border-line/70 bg-content1 px-2.5 py-2"
          >
            <div className="flex items-center gap-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${tone.solid}`}
                title={tone.label}
                aria-label={tone.label}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink">
                    {line.item_name ?? line.item_code ?? `Item #${line.item_id}`}
                  </span>
                  {line.is_excluded && <DroppedChip />}
                </span>
                <span className="mono block truncate text-[11px] text-muted">
                  {line.item_code ?? "No code"}{line.uom_code ? ` · ${line.uom_code}` : ""}
                </span>
              </span>
              <QtyArrow
                aligned
                requested={line.requested}
                approved={line.approved}
                className={`text-sm ${QTY_COL}`}
              />
              <span className={`tabular text-sm font-semibold ${CHANGE_COL} ${
                change == null ? "text-muted" : change < 0 ? "text-bad"
                  : change > 0 ? "text-ok" : "text-muted"
              }`}>
                {change == null
                  ? "—"
                  : change === 0
                    ? "0"
                    : `${change < 0 ? "−" : "+"}${num(Math.abs(change))}`}
              </span>
            </div>
            <LineAudit history={line.quantity_history} />
          </div>
        );
      })}
    </div>
  );
}

function IndentCard({ row, lines, open, onToggle, onDecide, siblings }: {
  row: CycleLedgerIndent;
  lines: CycleIndentLine[];
  open: boolean;
  onToggle: () => void;
  onDecide: () => void;
  /** How many indents this requester raised into this cycle. A month is MEANT to be
   *  one indent per site and the rule that would enforce it is not written yet, so
   *  the register has to read correctly when it is not -- but only a row that IS one
   *  of several says so. "1 of 1" on every line of an eleven-row list is noise. */
  siblings: number;
}) {
  const tone = toneFor(row.decision);
  const Icon = tone.icon;
  const reasons = reasonsOf(lines);
  const where = row.on_my_desk
    ? "with you"
    : row.current_approver_name
      ? `with ${row.current_approver_name}`
      : row.current_stage_name ?? "complete";
  return (
    <div
      id={`cycle-indent-${row.id}`}
      className={`flex overflow-hidden rounded-xl border bg-content1 transition-colors ${
        open ? "border-brand/40 ring-1 ring-brand/15" : "border-line"
      }`}
    >
      <span aria-hidden="true" className={`w-1 shrink-0 ${tone.bar}`} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-left transition hover:bg-content2/50"
        >
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone.className}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="mono truncate text-sm font-bold text-ink">{row.indent_no}</span>
              {row.is_anchor && (
                <span className="rounded bg-brand-050 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-brand">
                  Opened
                </span>
              )}
              {siblings > 1 && (
                <span
                  className="rounded bg-content2 px-1.5 py-px text-[10px] font-semibold text-muted"
                  title="This requester raised more than one indent into this cycle"
                >
                  {siblings} this month
                </span>
              )}
            </span>
            {/* What the old table spent four columns on, in one quiet line. Where
                the document sits NOW is the only part of it tinted, and only when
                that place is this reader's own desk. */}
            <span className="mt-0.5 block truncate text-xs text-muted">
              {row.requester ?? "Requester unavailable"}
              {row.office_name ? ` · ${row.office_name}` : ""}
              {` · ${row.line_count} ${row.line_count === 1 ? "line" : "lines"} · `}
              <span className={row.on_my_desk ? "font-semibold text-brand" : ""}>{where}</span>
            </span>
          </span>
          {/* Two fixed lanes from `sm`, for the same reason the panel has them: the
              chips are three different widths ("Approved", "Partially approved",
              "Waiting"), so a qty that merely sits before one lands somewhere new on
              every row and eleven identical decisions read as eleven different
              shapes. Below `sm` both go back to the flow and wrap. */}
          <QtyArrow
            aligned
            requested={row.requested}
            approved={row.approved}
            className="shrink-0 text-sm sm:w-[140px]"
          />
          <span className="flex shrink-0 sm:w-[168px]">
            <DecisionChip value={row.decision} />
          </span>
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>

        {open && (
          <div className="space-y-2.5 border-t border-line bg-content2/40 p-3">
            {/* WHY, in the approver's own words, and said ONCE: `reason` is the
                comment on the ACTION, stamped onto every line that action covered,
                so printing it per line prints one sentence six times. */}
            {reasons.map((reason) => (
              <p
                key={reason}
                className="flex items-start gap-2 rounded-lg border-l-2 border-brand/40 bg-content1 px-3 py-2 text-sm italic text-body"
              >
                <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0 not-italic text-brand" />
                {reason}
              </p>
            ))}
            {lines.length ? <LineTable lines={lines} /> : (
              <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
                No line of this indent is in your part of the cycle.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2.5">
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <StatusPill status={row.status} />
                {row.decided_at
                  ? `You signed ${fmtDateTime(row.decided_at)}${
                    row.stage_name ? ` as ${row.stage_name}` : ""}`
                  : "You have not answered this one yet."}
              </span>
              {row.on_my_desk && (
                <Can do="indent.approve">
                  <Button variant="soft" onClick={onDecide}>
                    Decide <ChevronRight className="h-4 w-4" />
                  </Button>
                </Can>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Export ---------------- */

function exportCycle(data: CycleLedger) {
  const rows = data.items.flatMap((item) => item.sites.map((site) => ({
    Item: item.item_name ?? "",
    "Item code": item.item_code ?? "",
    UOM: item.uom_code ?? "",
    Indent: site.indent_no,
    Requester: site.requester ?? "",
    Site: site.office_name ?? "",
    "Reached you": site.requested,
    "You approved": site.approved ?? "",
    Change: site.change ?? "",
    Decision: site.decision,
    "Line dropped": site.is_excluded ? "Yes" : "",
    "Indent status": site.indent_status,
  })));
  const roll = data.items.map((item) => ({
    Item: item.item_name ?? "",
    "Item code": item.item_code ?? "",
    UOM: item.uom_code ?? "",
    Indents: item.request_count,
    Sites: item.site_count,
    Requested: item.requested,
    "Decided by you": item.decided_requested,
    Approved: item.approved,
    "Still with you": item.waiting_quantity,
    Change: item.change ?? "",
    Decision: item.decision,
  }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(roll), "By item");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Item by site");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(
    data.indents.map((row) => ({
      Indent: row.indent_no,
      Requester: row.requester ?? "",
      Site: row.office_name ?? "",
      Project: row.project_name ?? "",
      Lines: row.line_count,
      "Reached you": row.requested,
      "You approved": row.approved ?? "",
      Change: row.change ?? "",
      Decision: row.decision,
      Stage: row.stage_name ?? "",
      When: row.decided_at ? new Date(row.decided_at).toLocaleString() : "",
      "Indent status": row.status,
      "Now with": row.current_approver_name ?? "",
    })),
  ), "By site");
  const name = data.cycle.consolidation_no ?? data.cycle.period ?? "cycle";
  XLSX.writeFile(book, `monthly-cycle-${name.replace(/[^\w-]+/g, "-")}.xlsx`);
}

/* ---------------- The header ---------------- */

function CycleHero({ data }: { data: CycleLedger }) {
  const tone = toneFor(
    data.decision.mode === "WAITING" ? "WAITING"
      : data.totals.change < 0 ? "PARTIALLY_APPROVED" : "APPROVED",
  );
  const cut = Math.max(data.totals.decided_requested - data.totals.approved, 0);
  const window = [data.cycle.earliest_required_date, data.cycle.latest_required_date]
    .filter(Boolean) as string[];
  /* The "Your signature on this cycle" panel that stood to the right of this is
   * GONE. It was five labelled rows, and four of the five were said elsewhere on
   * the same screen: the signed count is a tile, the waiting count is a tile, and
   * the two timestamps are one fact about one press. A hero is the ONE sentence and
   * the shape of the month; a second column of dt/dd beside it turns the top of the
   * page into a form nobody filled in. What was only there — when it was signed, and
   * at which rung — is a chip now, beside the other facts about the document. */
  const signed = data.decision.last_decided_at
    ? `Signed ${fmtDateTime(data.decision.last_decided_at)}${
      data.decision.stage_names.length ? ` as ${data.decision.stage_names.join(", ")}` : ""}`
    : data.decision.stage_names.length
      ? `Your rung: ${data.decision.stage_names.join(", ")}`
      : null;
  const chips = [
    ...(data.cycle.consolidation_no
      ? [{ icon: ClipboardList, text: data.cycle.consolidation_no, mono: true }] : []),
    ...(data.cycle.period_label
      ? [{ icon: CalendarRange, text: data.cycle.period_label, mono: false }] : []),
    ...(data.cycle.project_name
      ? [{ icon: Layers, text: data.cycle.project_name, mono: false }] : []),
    ...(signed ? [{ icon: UserRound, text: signed, mono: false }] : []),
    ...(window.length
      ? [{
          icon: CalendarRange,
          text: window[0] === window[window.length - 1]
            ? `Needed ${fmtDate(window[0])}`
            : `Needed ${fmtDate(window[0])} – ${fmtDate(window[window.length - 1])}`,
          mono: false,
        }]
      : []),
  ];
  return (
    <Card className="overflow-hidden">
      <div aria-hidden="true" className={`h-1.5 w-full ${tone.bar}`} />
      <div className="p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-050 px-2 py-1 text-xs font-bold uppercase tracking-wide text-brand">
            Monthly cycle
          </span>
          {data.cycle.consolidation_status && (
            <StatusPill status={data.cycle.consolidation_status} />
          )}
        </div>
        {/* Served. The screen never composes a sentence about what an approver did —
            that is the same rule that would otherwise put a second copy of the
            arithmetic in the browser. */}
        <h2 className="font-display text-xl font-bold leading-snug text-ink sm:text-2xl">
          {data.decision.summary}
        </h2>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.text}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-content2 px-2.5 py-1 text-xs font-medium text-body"
            >
              <chip.icon className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className={`truncate ${chip.mono ? "mono" : ""}`}>{chip.text}</span>
            </span>
          ))}
        </div>
        <div className="mt-4">
          <SplitBar
            approved={data.totals.approved}
            cut={cut}
            waiting={data.totals.waiting_quantity}
            label="This cycle"
          />
          <div className="mt-2">
            <SplitLegend
              approved={data.totals.approved}
              cut={cut}
              waiting={data.totals.waiting_quantity}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- The page ---------------- */

export function MonthlyCycleLedger({ ledger }: {
  /** The single-document ledger the reader arrived on. Its own view is one of the
   *  three tabs, rendered by the regular ledger's own components — the cycle
   *  payload carries each member's own `action_id`, so nothing here needs to be
   *  told which press it was opened from. */
  ledger: DecisionLedger;
}) {
  const nav = useNavigate();
  const [view, setView] = useState<View>("ITEM");
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("");
  /** Which indent in the register is open. One at a time, deliberately: the panel
   *  is a document, and eleven documents unrolled at once is the wall of text the
   *  register was built to stop being. */
  const [openIndentId, setOpenIndentId] = useState<number | null>(null);
  /** Set only when the reader crossed from the By-item view, so the effect below
   *  scrolls to the row it just opened. Opening a row by pressing it must NOT
   *  scroll: the row is already under the cursor. */
  const scrollTo = useRef<number | null>(null);

  const query = useQuery({
    queryKey: ["approvals", "cycle-ledger", ledger.indent.id],
    queryFn: () => approvalsApi.cycleLedger("INDENT", ledger.indent.id),
  });
  const data = query.data;

  /** The outcome chips are the outcomes PRESENT, never a fixed list: a cycle
   *  nobody denied anything in must not offer a "Denied" filter that can only ever
   *  empty the screen. */
  const outcomes = useMemo(() => {
    if (!data) return [];
    const rows = view === "SITE" ? data.indents : data.items;
    return [...new Set(rows.map((row) => row.decision))].sort();
  }, [data, view]);

  const items = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.items.filter((item) => (
      (!outcome || item.decision === outcome)
      && (!term || [item.item_name, item.item_code, item.uom_code]
        .some((value) => String(value ?? "").toLowerCase().includes(term))
        || item.sites.some((site) => [site.indent_no, site.requester, site.office_name]
          .some((value) => String(value ?? "").toLowerCase().includes(term))))
    ));
  }, [data, search, outcome]);

  const indents = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.indents.filter((row) => (
      (!outcome || row.decision === outcome)
      && (!term || [row.indent_no, row.requester, row.office_name, row.project_name,
        row.status, row.stage_name]
        .some((value) => String(value ?? "").toLowerCase().includes(term)))
    ));
  }, [data, search, outcome]);

  /** Every line of every member, re-keyed by indent. The register opens a row out
   *  of THIS, not out of a second request: `cycle_ledger` already serves the whole
   *  cross-product for the roll-up above. */
  const linesFor = useMemo(() => linesByIndent(data?.items ?? []), [data]);
  const siblingsFor = useMemo(
    () => (data ? indentsPerRequester(data) : new Map<number, number>()), [data],
  );

  /** Crossing from an item's site line. It opens the indent in the REGISTER — the
   *  same month read the other way round — rather than navigating to a page which,
   *  for a monthly indent, is this page again against a different anchor. */
  const openIndent = (indentId: number) => {
    setView("SITE");
    // Both filters are cleared, or the row this press exists to open is the one row
    // the register will not draw: an item search ("cotton") matches nothing on an
    // indent, and an outcome chip set on the roll-up need not hold for the member.
    setOutcome("");
    setSearch("");
    setOpenIndentId(indentId);
    scrollTo.current = indentId;
  };

  useEffect(() => {
    const id = scrollTo.current;
    if (id === null || view !== "SITE") return;
    scrollTo.current = null;
    // Not every test environment has it, and a missed scroll must never throw on a
    // page whose whole job is to be readable.
    document.getElementById(`cycle-indent-${id}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [view, openIndentId]);

  // Four tiles, four tints, four different questions. Two of them used to wear the
  // brand pink and read as one number split in half, and a fifth band of arithmetic
  // (the hero's dt/dd panel) said two of these again in words.
  const tiles: KpiTileSpec[] = data ? [
    {
      key: "indents", label: "Indents you signed", icon: CheckCircle2, tone: "ok",
      // Against the month, not on its own: "1" is a fact and "1 of 11" is the fact
      // somebody came to this page for.
      value: `${data.decision.signed_count} of ${data.scope.total_in_cycle}`,
    },
    {
      // The only tile that is a JOB rather than a total, which is why it keeps the
      // waiting blue the register and the split bar use for the same thing.
      key: "waiting", label: "Still with you", icon: Clock, tone: "info",
      value: data.decision.waiting_count,
    },
    { key: "items", label: "Distinct items", icon: Boxes, tone: "neutral", value: data.totals.items },
    {
      key: "approved", label: "Units approved", icon: Package, tone: "brand",
      value: num(data.totals.approved),
    },
  ] : [];

  return (
    <>
      <PageHeader
        eyebrow="Approvals"
        title="Monthly Cycle Ledger"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => nav("/approvals/decisions")}>
              <ArrowLeft className="h-4 w-4" /> My Decisions
            </Button>
            <Button variant="ghost" disabled={!data} onClick={() => data && exportCycle(data)}>
              <Download className="h-4 w-4" /> Export Excel
            </Button>
          </div>
        }
      />
      <ErrorBanner error={query.error} />
      {/* The cycle failed to load, so fall back to the ONE document the reader
          arrived on — already in hand, and drawn by the regular ledger's own
          components. A monthly indent whose month cannot be read must not leave
          the approver with an error and an empty page: the decision they came to
          check is right here. */}
      {query.isError && (
        <div className="space-y-4">
          <SummaryHeader data={ledger} />
          <Card className="p-4">
            <SectionHead
              icon={FileText}
              title={`This indent — ${ledger.indent.indent_no}`}
              subtitle="The cycle roll-up could not be loaded. This is the single document."
            />
            <div className="space-y-2.5">
              {ledger.items.map((item) => (
                <ItemRow
                  key={item.line_id}
                  item={item}
                  outcomeLabel={ledger.visibility?.outcome_label ?? "Final approved"}
                />
              ))}
            </div>
          </Card>
          <PendingNow data={ledger} />
        </div>
      )}
      {query.isLoading && (
        <div className="space-y-4">
          <div className="h-48 animate-pulse rounded-2xl bg-content2" />
          <div className="h-20 animate-pulse rounded-2xl bg-content2" />
          <div className="h-72 animate-pulse rounded-2xl bg-content2" />
        </div>
      )}
      {data && (
        <div className="space-y-4">
          <CycleHero data={data} />
          {/* The ContextStrip that used to sit here is GONE. Units requested, units
              cut, requesters and lines were a third band of arithmetic under two
              that already said it: the hero's bar IS requested / approved / cut, and
              the tiles are the counts. Three rows of numbers before the first row of
              the list is how a page stops being read at all. */}
          <KpiTiles label="This cycle at a glance" tiles={tiles} />

          {/* Said out loud, and said by the SERVER. A roll-up that counts fewer
              documents than the cycle holds reads as a page with missing data. */}
          {data.scope.note && (
            <Card className="flex items-start gap-2 border-line bg-content2 p-3 text-sm text-body">
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>{data.scope.note}</span>
            </Card>
          )}

          <Card className="p-4">
            {/* Short, because the rows explain themselves now: a subtitle telling
                the reader what a row is, above rows that open to show it, is a
                sentence spent on something the next press answers. */}
            <SectionHead
              icon={view === "ITEM" ? Boxes : FileText}
              title={view === "ITEM" ? "Item by item" : "Indent by indent"}
              subtitle="Open a row to read it here."
              right={
                <Segment<View>
                  ariaLabel="How to read this cycle"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "ITEM", label: "By item", icon: Boxes, count: data.totals.items },
                    { value: "SITE", label: "By indent", icon: FileText, count: data.totals.indents },
                  ]}
                />
              }
            />

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1">
                  <Input
                    aria-label="Search this cycle"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={view === "ITEM"
                      ? "Search item, code, requester, indent number"
                      : "Search indent number, requester, site, stage"}
                  />
                </div>
                {outcomes.length > 1 && (
                  <div role="group" aria-label="Outcome" className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      aria-pressed={!outcome}
                      onClick={() => setOutcome("")}
                      className={`inline-flex min-h-10 items-center rounded-full px-3.5 text-sm font-semibold ring-1 transition ${
                        !outcome
                          ? "bg-brand-050 text-brand ring-brand/40"
                          : "bg-content1 text-muted ring-line hover:text-ink"
                      }`}
                    >
                      All
                    </button>
                    {outcomes.map((value) => {
                      const meta = toneFor(value);
                      const Icon = meta.icon;
                      const active = outcome === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setOutcome(active ? "" : value)}
                          className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold ring-1 transition ${
                            active
                              ? `${meta.className} ring-current/40`
                              : "bg-content1 text-muted ring-line hover:text-ink"
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {meta.label}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            {view === "ITEM" && (
              <div className="space-y-2.5">
                {items.map((item) => (
                  <ItemCard key={item.item_id} item={item} onOpenIndent={openIndent} />
                ))}
                {!items.length && (
                  <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
                    No item in this cycle matches that search.
                  </div>
                )}
              </div>
            )}

            {view === "SITE" && (
              <div className="space-y-2.5">
                {indents.map((row) => (
                  <IndentCard
                    key={row.id}
                    row={row}
                    lines={linesFor.get(row.id) ?? []}
                    open={openIndentId === row.id}
                    onToggle={() => setOpenIndentId((id) => (id === row.id ? null : row.id))}
                    onDecide={() => nav(`/approvals?reviewIndent=${row.id}`)}
                    siblings={row.requested_by_id
                      ? siblingsFor.get(row.requested_by_id) ?? 1 : 1}
                  />
                ))}
                {!indents.length && (
                  <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
                    No indent in this cycle matches that search.
                  </div>
                )}
              </div>
            )}

          </Card>

          {/* The "this indent is still waiting for you" card that stood here is
              gone with the tab. It said one thing about ONE member of the cycle,
              and the register now says it about every member that is waiting, on
              the row itself, with the same button on it. */}
        </div>
      )}
    </>
  );
}
