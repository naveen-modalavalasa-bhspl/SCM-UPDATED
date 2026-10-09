import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, ErrorBanner, FilterBar, FilterMenu, ResponsiveList, type FilterOption,
} from "@/shared/components";
import { fmtDateTime, parseIst } from "@/shared/datetime";
import { webhooksApi } from "../api";
import { ALL_DATES, DatePresetFilter, type DateFilter } from "./DatePresetFilter";
import type { WebhookDelivery } from "../types";

/**
 * What one webhook has actually sent — the push side's `UsagePanel`, and a tab on the
 * webhook's own page for the same reason usage is a tab on an application's.
 *
 * IT IS NARROWED HERE, NOT READ TOP TO BOTTOM (2026-09-01). The list is a register of
 * every push a sender has ever made, and the questions asked of it are always the
 * small ones — did THIS event id land, what has been rejected, how much arrived today.
 * So it carries the app's own three controls: the shared search box over the event and
 * its id, the shared `FilterMenu` over the results the rows actually hold, and the
 * date presets the indents rail uses. Every one of them narrows what was fetched —
 * nothing here asks the server a different question, so a filter can never disagree
 * with the count beside it.
 */

/** What one push actually DID. The handler reports it (`upserted`, `retired`,
 *  `recorded`, `rejected`, `ignored`); anything unrecognised is shown as sent rather
 *  than swallowed, because a word we do not know is still the server's answer. */
const OUTCOME_TONE: Record<string, string> = {
  upserted: "bg-ok-bg text-ok",
  retired: "bg-warn-bg text-warn",
  recorded: "bg-content2 text-muted",
  ignored: "bg-content2 text-muted",
  rejected: "bg-bad-bg text-bad",
};

/** The same vocabulary as a fill, for the dot on the filter row — picking "rejected"
 *  and reading it back in the column ought to look like the same thing. */
const OUTCOME_DOT: Record<string, string> = {
  upserted: "bg-ok",
  retired: "bg-warn",
  recorded: "bg-muted",
  ignored: "bg-muted",
  rejected: "bg-bad",
};

/** How many rows one request brings back. Every filter below reads what was fetched,
 *  so this is also how far back "today" and "this month" can see. */
const FETCH_SIZE = 200;

const outcomeOf = (row: WebhookDelivery) => String(row.outcome?.handled ?? "—");

/** The IST calendar day a push landed on — the same clock the Received column prints
 *  with, so "Today" means the day the reader is having. */
const dayOf = (value: string): string => {
  const at = parseIst(value);
  return at ? at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "";
};

function OutcomePill({ outcome }: { outcome?: Record<string, unknown> | null }) {
  const handled = String(outcome?.handled ?? "—");
  const issued = Number(outcome?.logins_issued ?? 0);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
        OUTCOME_TONE[handled] ?? "bg-content2 text-muted"}`}>
        {handled}
      </span>
      {/* A row is not a login. Worth saying out loud on the one push where it
        * happened, because "they exist but cannot sign in" is a confusing half-state
        * to debug from the sending side. */}
      {issued > 0 && (
        <span className="text-[11px] text-muted">
          +{issued} login{issued === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

export function WebhookReceivedPanel({ source }: { source: string }) {
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("");
  const [dates, setDates] = useState<DateFilter>(ALL_DATES);

  const deliveries = useQuery({
    queryKey: ["apis", "webhook-deliveries", source, FETCH_SIZE],
    queryFn: () => webhooksApi.deliveries(source, FETCH_SIZE),
    enabled: Boolean(source),
  });

  const all = useMemo(() => deliveries.data?.items ?? [], [deliveries.data]);

  // The dropdown lists the results these rows actually hold, with how many of each —
  // so it can never offer a word this webhook has never been answered with, and the
  // counts say what happened today without opening anything.
  const outcomeOptions: FilterOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    all.forEach((row) => {
      const key = outcomeOf(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        hint: String(count),
        dot: OUTCOME_DOT[value] ?? "bg-muted",
      }));
  }, [all]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((row) => {
      if (term && !`${row.event} ${row.event_id}`.toLowerCase().includes(term)) return false;
      if (outcome && outcomeOf(row) !== outcome) return false;
      if (dates.from || dates.to) {
        const day = dayOf(row.received_at);
        if (!day) return false;
        if (dates.from && day < dates.from) return false;
        if (dates.to && day > dates.to) return false;
      }
      return true;
    });
  }, [all, search, outcome, dates]);

  const active = (search ? 1 : 0) + (outcome ? 1 : 0) + (dates.preset === "all" ? 0 : 1);
  const clearAll = () => { setSearch(""); setOutcome(""); setDates(ALL_DATES); };

  return (
    <div>
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by event or event id…"
        searchLabel="Search what has been received"
        // Wide on purpose: this strip carries two pills and a count, so a box capped
        // at 20rem left a third of the rail empty and read as a control that had
        // failed to load the rest of itself. It takes the slack instead.
        searchClassName="min-w-[260px] flex-1 sm:max-w-2xl"
        onClear={clearAll}
        active={active}
        right={
          <span className="text-sm text-muted">
            {active
              ? `${rows.length} of ${all.length} shown`
              : `${all.length} received`}
          </span>
        }
      >
        <FilterMenu
          label="Result"
          value={outcome}
          onChange={setOutcome}
          options={outcomeOptions}
        />
        <DatePresetFilter
          label="Received"
          description="When the push arrived, on SCM's clock."
          value={dates}
          onChange={setDates}
        />
      </FilterBar>

      <Card className="p-2">
        <ErrorBanner error={deliveries.error} />
        <ResponsiveList
          data={rows}
          columns={[
            { key: "event", header: "Event",
              render: (row) => <span className="text-sm text-ink">{row.event}</span> },
            { key: "id", header: "Event id",
              render: (row) => (
                <code className="text-[11px] text-muted">{row.event_id}</code>
              ) },
            { key: "did", header: "Result",
              render: (row) => <OutcomePill outcome={row.outcome} /> },
            { key: "at", header: "Received",
              render: (row) => (
                <span className="text-xs text-muted">{fmtDateTime(row.received_at)}</span>
              ) },
          ]}
          keyOf={(row) => `${row.source}:${row.event_id}`}
          loading={deliveries.isLoading}
          // Two different silences: nothing has ever arrived, or nothing matches what
          // was asked for. Saying the first when the second is true reads as data loss.
          empty={active
            ? "No push matches these filters."
            : "Nothing has arrived on this webhook yet."}
          renderCard={(row) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{row.event}</div>
              <code className="block text-[11px] text-muted">{row.event_id}</code>
              <div className="flex items-center gap-2">
                <OutcomePill outcome={row.outcome} />
                <span className="text-xs text-muted">{fmtDateTime(row.received_at)}</span>
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
