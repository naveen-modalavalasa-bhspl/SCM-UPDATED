import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, ShieldCheck } from "lucide-react";
import {
  Button, EmptyState, ErrorBanner, FilterBar, ResponsiveList, type Column,
} from "@/shared/components";
import { webhooksApi } from "../api";
import { HealthPill, healthOfWebhook } from "./Health";
import { WebhookFormModal } from "./WebhookFormModal";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import type { Webhook } from "../types";

/** Same page size as the applications list, so both tabs page at the same point. */
const PAGE_SIZE = 20;

/** Where one webhook lives. Its own address, so a row can be linked, opened in a
 *  second tab and returned to — the same as an application's. */
export const webhookPath = (source: string) => `/admin/integrations/webhooks/${source}`;

/**
 * Inbound webhooks — the systems allowed to push data INTO SCM, registered here
 * rather than written per partner.
 *
 * Every integration that pushes to us needs the same four things: an API key, a
 * shared secret to sign the body with, a list of event names it may send, and
 * de-duplication on an event id. Today each one gets them by having a folder
 * hand-written for it (see `adapters/cams/`), so a partner who only wants to say
 * "this employee changed" needs a release. This is that, configured.
 *
 * WHAT THIS SCREEN CANNOT DO, deliberately: describe a WRITE. There is no table
 * picker and no column mapping here, and the server would refuse one — `handler` names
 * one of a closed set it serves from `/webhook-handlers`. A screen that could point an
 * inbound feed at `stk_balance` would be a way around rule 7 and around every module's
 * own service. Adding a handler is a code change, and each one answers for its writes.
 *
 * IT IS READ AND WORKED THE SAME WAY AS THE APPLICATIONS TAB (2026-09-01), and that is
 * the whole point of the shape below. The two halves of this screen answer one question
 * — who is connected, and on what terms — but only one of them looked like it: the push
 * side had no search, no health, no setup order, and six buttons per row that pushed
 * the table wider than the page, so the actions an admin came for sat behind a
 * horizontal scrollbar. So this is now a LIST and nothing else: the register button is
 * in the PageHeader (this panel exposes `openRegister` for it), the strip above the
 * rows is the shared `FilterBar`, the last column is a `HealthPill` with the sentence
 * under it, and a row OPENS `WebhookDetailPage`, where every action lives — exactly as
 * an application's row opens `ApiClientDetailPage`.
 */
/** What each handler does, in the fewest words that are still true. Falls back to the
 *  raw key so a handler added on the server shows up here without a frontend release
 *  rather than rendering blank. */
const HANDLER_LABEL: Record<string, string> = {
  record: "records only — nothing changes",
  hcm_mirror: "updates the HCM mirror",
};
const handlerLabel = (key: string) => HANDLER_LABEL[key] ?? key;

/** The one thing the page above reaches in for: the "Register a webhook" button lives
 *  in the PageHeader, where every other create button in the app lives. */
export interface WebhooksPanelHandle {
  openRegister: () => void;
}

export const WebhooksPanel = forwardRef<WebhooksPanelHandle>(function WebhooksPanel(_props, ref) {
  const navigate = useNavigate();
  const [registering, setRegistering] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const list = useQuery({ queryKey: ["apis", "webhooks"], queryFn: webhooksApi.list });

  useImperativeHandle(ref, () => ({ openRegister: () => setRegistering(true) }), []);

  // Searched over what a person would type looking for one: what it is called, the
  // address it answers on, and the events it takes.
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!term) return all;
    return all.filter((hook) => [
      hook.name ?? "", hook.source, hook.description ?? "", hook.events.join(" "),
    ].join(" ").toLowerCase().includes(term));
  }, [list.data, search]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // The row carries the same five facts an application's row carries, in the same
  // order: what it is, what it can reach, when it was last used, on whose terms, and
  // whether it works.
  const columns: Column<Webhook>[] = [
    {
      key: "source",
      // The NAME leads, the URL name is chipped beside it: one is what a person calls
      // this system, the other is the address it is filed under.
      header: "Webhook",
      render: (row) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{row.name || row.source}</span>
            <code className="rounded bg-content2 px-1.5 py-0.5 text-[11px] text-muted">
              {row.source}
            </code>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{row.url}</div>
        </div>
      ),
    },
    {
      key: "events",
      header: "What it accepts",
      render: (row) => (
        <div className="min-w-0 text-sm">
          <div className="truncate text-ink">
            {row.events.slice(0, 3).join(", ")}
            {row.events.length > 3 && ` +${row.events.length - 3} more`}
          </div>
          {/* Whether a push CHANGES anything is the single most important fact about
            * a webhook, and it was invisible: two rows looked identical while one
            * updated the mirror and the other only filed the payload. */}
          <div className="truncate text-xs text-muted">{handlerLabel(row.handler)}</div>
        </div>
      ),
    },
    {
      key: "received",
      header: "Last push",
      hideOnNarrow: true,
      // Relative first, the stamp underneath as the evidence — the same shape, and the
      // same IST clock, as the application list's "Last call seen".
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">
            {row.last_received_at ? fmtRelative(row.last_received_at) : "Nothing yet"}
          </div>
          {row.last_received_at && (
            <div className="text-xs text-muted">{fmtDateTime(row.last_received_at)}</div>
          )}
          <div className="text-xs text-muted">
            {row.received_count} received
            {row.last_sequence != null && ` · seq ${row.last_sequence}`}
          </div>
        </div>
      ),
    },
    {
      key: "access",
      // The push side's "Owner" column: on what terms is this address reachable, and
      // by whom. A signed webhook left unbound is reachable by EVERY live key, not
      // just the partner it was registered for — which is the difference between
      // "signed" and "only they can reach it".
      header: "On what terms",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          {row.has_secret
            ? <span className="inline-flex items-center gap-1 text-xs text-ok">
                <ShieldCheck className="h-3.5 w-3.5" /> signed
              </span>
            // A registered webhook with no secret cannot be pushed to at all unless
            // the signature requirement was explicitly turned off — so say which.
            : <span className="inline-flex items-center gap-1 text-xs text-warn">
                <AlertTriangle className="h-3.5 w-3.5" />
                {row.require_signature ? "no secret yet" : "UNSIGNED"}
              </span>}
          <div className="mt-0.5 text-xs">
            {row.client_code
              ? <code className="text-muted">{row.client_code}</code>
              : <span className="text-warn">any registered key</span>}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => {
        const health = healthOfWebhook(row);
        return (
          <div className="min-w-0">
            <HealthPill health={health} />
            <div className="mt-1 text-[11px] leading-tight text-muted">{health.note}</div>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <FilterBar
        search={search}
        onSearch={(value) => { setSearch(value); setPage(1); }}
        searchPlaceholder="Search by name, address or event…"
        searchLabel="Search webhooks"
        onClear={() => { setSearch(""); setPage(1); }}
        active={search ? 1 : 0}
        right={
          <span className="text-sm text-muted">
            {rows.length} {rows.length === 1 ? "webhook" : "webhooks"}
          </span>
        }
      />

      {list.error && <ErrorBanner error="Webhooks could not be loaded." />}

      <ResponsiveList
        data={shown}
        columns={columns}
        keyOf={(row) => row.source}
        loading={list.isLoading}
        onRowClick={(row) => navigate(webhookPath(row.source))}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="Nothing is pushing into SCM yet"
            hint="Register the sending system, issue it a secret, and give it the URL. It can start posting the moment you do — no release needed."
            action={
              <Button onClick={() => setRegistering(true)}>
                <Plus className="h-4 w-4" /> Register a webhook
              </Button>
            }
          />
        }
        renderCard={(row) => {
          const health = healthOfWebhook(row);
          return (
            <Link to={webhookPath(row.source)} className="block p-1">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">
                    {row.name || row.source}
                  </span>
                  <code className="text-[11px] text-muted">{row.url}</code>
                </span>
                <HealthPill health={health} />
              </div>
              <div className="mt-2 text-xs text-muted">{health.note}</div>
              <div className="mt-1 text-xs text-muted">
                {row.events.length} event{row.events.length === 1 ? "" : "s"} ·{" "}
                {handlerLabel(row.handler)} · {row.received_count} received
              </div>
            </Link>
          );
        }}
      />

      <WebhookFormModal
        open={registering}
        editing={null}
        onClose={() => setRegistering(false)}
        // Straight into it, the way registering an application opens the application:
        // registering is step one of three and the other two are on that screen.
        onSaved={(hook) => { setRegistering(false); navigate(webhookPath(hook.source)); }}
      />
    </div>
  );
});
