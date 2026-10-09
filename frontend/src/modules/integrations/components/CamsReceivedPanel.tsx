import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  Button, Card, ErrorBanner, FilterBar, FilterMenu, ResponsiveList, useToast,
  type FilterOption,
} from "@/shared/components";
import { fmtDateTime, parseIst } from "@/shared/datetime";
import { camsApi } from "../api";
import { useCamsWrites } from "../camsEvents";
import { ALL_DATES, DatePresetFilter, type DateFilter } from "./DatePresetFilter";
import type { CamsEvent } from "../types";

/**
 * What B-CAMS has actually sent — the adapter's `WebhookReceivedPanel`, in the same
 * shape and worked the same way, because it answers the same question about the same
 * kind of traffic.
 *
 * It carries the app's three controls over one fetch: the shared search box over the
 * event and its id, the shared `FilterMenu` over the events these rows actually hold,
 * and the date presets the indents rail uses. Every one narrows what was already
 * brought back — nothing here asks the server a different question, so a filter can
 * never disagree with the count beside it.
 *
 * WHAT IS DIFFERENT FROM A WEBHOOK'S LIST, and it is the whole reason this screen was
 * worth building: two of these five events DEDUCT STOCK. So the Result column is not
 * "what the handler called it" but how many lines moved and how many could not, and a
 * refused line is openable, because the reason is almost always that a receipt was
 * never posted in SCM — our balance is behind, not the field's count.
 */

/** How many rows one request brings back. Every filter below reads what was fetched,
 *  so this is also how far back "today" and "this month" can see. */
const FETCH_SIZE = 200;

/** What one push DID, in the vocabulary the webhook list already uses for the same
 *  idea. `recorded` is not a lesser `posted`: three of the five events were never
 *  meant to move anything, and showing them as "0 posted" reads as a failure. */
type Result = "posted" | "partial" | "refused" | "recorded";

const RESULT_TONE: Record<Result, string> = {
  posted: "bg-ok-bg text-ok",
  partial: "bg-warn-bg text-warn",
  refused: "bg-bad-bg text-bad",
  recorded: "bg-content2 text-muted",
};

const RESULT_DOT: Record<Result, string> = {
  posted: "bg-ok",
  partial: "bg-warn",
  refused: "bg-bad",
  recorded: "bg-muted",
};

const resultOf = (row: CamsEvent): Result => {
  if (!row.posting) return "recorded";
  const { posted, skipped } = row.posting;
  if (skipped === 0) return "posted";
  return posted > 0 ? "partial" : "refused";
};

/** The IST calendar day a push landed on — the same clock the Received column prints
 *  with, so "Today" means the day the reader is having. */
const dayOf = (value: string): string => {
  const at = parseIst(value);
  return at ? at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "";
};

function ResultPill({ row }: { row: CamsEvent }) {
  const result = resultOf(row);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${RESULT_TONE[result]}`}>
        {result}
      </span>
      {row.posting && (
        <span className="text-[11px] text-muted">
          {row.posting.posted} of {row.rows ?? 0} moved stock
        </span>
      )}
    </span>
  );
}

export function CamsReceivedPanel() {
  const toast = useToast();
  const { nameOf } = useCamsWrites();
  const [search, setSearch] = useState("");
  const [event, setEvent] = useState("");
  const [dates, setDates] = useState<DateFilter>(ALL_DATES);
  const [open, setOpen] = useState<CamsEvent | null>(null);

  const events = useQuery({
    queryKey: ["cams", "events", FETCH_SIZE],
    queryFn: () => camsApi.events(undefined, FETCH_SIZE),
  });

  // The list carries no bodies — a nightly sweep's payload is far too big for a table
  // — so opening one asks for it by id.
  const detail = useMutation({
    mutationFn: camsApi.event,
    onSuccess: (row) => setOpen(row),
    onError: (error: Error) => toast.error(error.message),
  });

  const all = useMemo(() => events.data?.items ?? [], [events.data]);

  // The dropdown lists the events these rows actually hold, with how many of each, so
  // it can never offer one B-CAMS has never sent. The dot is the row's own result
  // vocabulary; an event that has only ever been refused shows red here too.
  const eventOptions: FilterOption[] = useMemo(() => {
    const counts = new Map<string, { count: number; worst: Result }>();
    const rank: Result[] = ["recorded", "posted", "partial", "refused"];
    all.forEach((row) => {
      const held = counts.get(row.event) ?? { count: 0, worst: "recorded" as Result };
      const result = resultOf(row);
      counts.set(row.event, {
        count: held.count + 1,
        worst: rank.indexOf(result) > rank.indexOf(held.worst) ? result : held.worst,
      });
    });
    return [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([value, { count, worst }]) => ({
        value,
        label: nameOf(value),
        hint: String(count),
        dot: RESULT_DOT[worst],
      }));
  }, [all, nameOf]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((row) => {
      if (term && !`${nameOf(row.event)} ${row.event} ${row.event_id}`
        .toLowerCase().includes(term)) return false;
      if (event && row.event !== event) return false;
      if (dates.from || dates.to) {
        const day = dayOf(row.received_at);
        if (!day) return false;
        if (dates.from && day < dates.from) return false;
        if (dates.to && day > dates.to) return false;
      }
      return true;
    });
  }, [all, search, event, dates, nameOf]);

  const active = (search ? 1 : 0) + (event ? 1 : 0) + (dates.preset === "all" ? 0 : 1);
  const clearAll = () => { setSearch(""); setEvent(""); setDates(ALL_DATES); };

  return (
    <div>
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by event or event id…"
        searchLabel="Search what has been received"
        searchClassName="min-w-[260px] flex-1 sm:max-w-2xl"
        onClear={clearAll}
        active={active}
        right={
          <span className="text-sm text-muted">
            {active ? `${rows.length} of ${all.length} shown` : `${all.length} received`}
          </span>
        }
      >
        <FilterMenu
          label="Event"
          value={event}
          onChange={setEvent}
          options={eventOptions}
        />
        <DatePresetFilter
          label="Received"
          description="When the push arrived, on SCM's clock."
          value={dates}
          onChange={setDates}
        />
      </FilterBar>

      <Card className="p-2">
        <ErrorBanner error={events.error} />
        <ResponsiveList
          data={rows}
          columns={[
            { key: "event", header: "Event",
              render: (row) => (
                <span className="text-sm text-ink">{nameOf(row.event)}</span>
              ) },
            { key: "id", header: "Event id",
              render: (row) => (
                <code className="text-[11px] text-muted">{row.event_id}</code>
              ) },
            { key: "did", header: "Result", render: (row) => <ResultPill row={row} /> },
            { key: "at", header: "Received",
              render: (row) => (
                <span className="text-xs text-muted">{fmtDateTime(row.received_at)}</span>
              ) },
          ]}
          keyOf={(row) => row.event_id}
          loading={events.isLoading}
          onRowClick={(row) => detail.mutate(row.event_id)}
          // Two different silences: nothing has ever arrived, or nothing matches what
          // was asked for. Saying the first when the second is true reads as data loss.
          empty={active
            ? "No push matches these filters."
            : "Nothing has arrived from B-CAMS yet."}
          renderCard={(row) => (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">{nameOf(row.event)}</div>
              <code className="block text-[11px] text-muted">{row.event_id}</code>
              <div className="flex flex-wrap items-center gap-2">
                <ResultPill row={row} />
                <span className="text-xs text-muted">{fmtDateTime(row.received_at)}</span>
              </div>
            </div>
          )}
        />
      </Card>

      {/* One push in full: the body they sent and, where it moved stock, every line
          that could not be posted and why. That list is the whole reason this panel
          exists — a refused line almost always means a receipt was never posted in
          SCM, not that the field is wrong. */}
      <Modal isOpen={open !== null} onClose={() => setOpen(null)} size="3xl">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            {open ? nameOf(open.event) : ""} · {open?.event_id}
          </ModalHeader>
          <ModalBody className="gap-3">
            <div className="max-h-[60vh] overflow-y-auto overscroll-y-contain pr-1">
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-muted">Received: </span>
                    <span className="text-ink">{fmtDateTime(open?.received_at ?? "")}</span>
                  </div>
                  <div>
                    <span className="text-muted">Sent by: </span>
                    <span className="text-ink">{open?.client_code ?? "—"}</span>
                  </div>
                </div>

                {open?.posting && open.posting.problems.length > 0 && (
                  <div className="rounded-lg border border-bad/30 bg-bad-bg/40 p-3">
                    <p className="mb-1 text-sm font-semibold text-bad">
                      {open.posting.skipped} line
                      {open.posting.skipped === 1 ? "" : "s"} could not be posted
                    </p>
                    <ul className="space-y-1 text-xs text-body">
                      {open.posting.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {open?.payload_truncated && (
                  <p className="text-xs text-muted">
                    The body was too large to store and was logged instead; only its
                    digest and header fields are kept.
                  </p>
                )}

                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                    What they sent
                  </p>
                  <pre className="whitespace-pre-wrap break-all rounded-lg bg-content1 p-3
                                  font-mono text-xs text-body">
                    {JSON.stringify(open?.payload ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setOpen(null)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
