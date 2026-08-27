import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { AlertTriangle, KeyRound, Plus, Radio, ShieldCheck } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, ResponsiveList, Select,
  StatusPill, useToast, type Column,
} from "@/shared/components";
import { webhooksApi } from "../api";
import { EventPicker } from "./EventPicker";
import { WebhookDocsModal } from "./WebhookDocsModal";
import { fmtDateTime } from "@/shared/datetime";
import type { Webhook, WebhookSecret, WebhookWrite } from "../types";

const BLANK: WebhookWrite = {
  source: "", name: "", description: "", events: [], handler: "record",
  require_signature: true, is_active: true,
};

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
 */
/** What each handler does, in the fewest words that are still true. Falls back to the
 *  raw key so a handler added on the server shows up here without a frontend release
 *  rather than rendering blank. */
const HANDLER_LABEL: Record<string, string> = {
  record: "records only — nothing changes",
  hcm_mirror: "updates the HCM mirror",
};
const handlerLabel = (key: string) => HANDLER_LABEL[key] ?? key;

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

export function WebhooksPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WebhookWrite | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [issued, setIssued] = useState<WebhookSecret | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const [showDocs, setShowDocs] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["apis", "webhooks"], queryFn: webhooksApi.list });
  const handlers = useQuery({
    queryKey: ["apis", "webhook-handlers"], queryFn: webhooksApi.handlers,
  });
  const eventNames = useQuery({
    queryKey: ["apis", "webhook-events"], queryFn: webhooksApi.eventNames,
  });
  const deliveries = useQuery({
    queryKey: ["apis", "webhook-deliveries", showLog],
    queryFn: () => webhooksApi.deliveries(showLog ?? undefined),
    enabled: showLog !== null,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["apis", "webhooks"] });

  const save = useMutation({
    mutationFn: (body: WebhookWrite) =>
      editing === null ? webhooksApi.create(body) : webhooksApi.update(editing, body),
    onSuccess: (hook) => {
      refresh();
      setDraft(null);
      setEditing(null);
      toast.success(
        editing === null
          ? `${hook.source} registered — issue its secret next`
          : `${hook.source} saved`,
      );
    },
    onError: (error) => setProblem(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || "That webhook could not be saved.",
    ),
  });

  const disable = useMutation({
    mutationFn: (source: string) => webhooksApi.disable(source),
    onSuccess: (hook) => { refresh(); toast.success(`${hook.source} switched off`); },
    onError: () => toast.error("That webhook could not be switched off."),
  });

  const rotate = useMutation({
    mutationFn: (source: string) => webhooksApi.rotateSecret(source),
    onSuccess: (secret) => { refresh(); setIssued(secret); },
    onError: () => toast.error("That secret could not be issued."),
  });

  const open = (hook?: Webhook) => {
    setProblem("");
    setEditing(hook?.source ?? null);
    setDraft(hook
      ? {
        source: hook.source, name: hook.name ?? "", description: hook.description ?? "",
        events: hook.events, handler: hook.handler,
        require_signature: hook.require_signature, is_active: hook.is_active,
      }
      : { ...BLANK });
  };

  const columns: Column<Webhook>[] = [
    {
      key: "source",
      header: "Source",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{row.name || row.source}</div>
          <code className="truncate text-[11px] text-muted">{row.url}</code>
        </div>
      ),
    },
    {
      key: "events",
      header: "Accepts",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-xs text-body">
            {row.events.slice(0, 3).join(", ")}
            {row.events.length > 3 && ` +${row.events.length - 3} more`}
          </div>
          {/* Whether a push CHANGES anything is the single most important fact about
            * a webhook, and it was invisible: two rows looked identical while one
            * updated the mirror and the other only filed the payload. */}
          <div className="truncate text-[11px] text-muted">
            {handlerLabel(row.handler)}
          </div>
        </div>
      ),
    },
    {
      key: "secret",
      header: "Signing",
      render: (row) => (
        row.has_secret
          ? <span className="inline-flex items-center gap-1 text-xs text-ok">
              <ShieldCheck className="h-3.5 w-3.5" /> signed
            </span>
          // A registered webhook with no secret cannot be pushed to at all unless the
          // signature requirement was explicitly turned off — so say which it is.
          : <span className="inline-flex items-center gap-1 text-xs text-warn">
              <AlertTriangle className="h-3.5 w-3.5" />
              {row.require_signature ? "no secret yet" : "UNSIGNED"}
            </span>
      ),
    },
    {
      key: "received",
      header: "Received",
      render: (row) => (
        <div className="text-xs text-muted">
          <div className="text-ink">{row.received_count}</div>
          {row.last_received_at && <div>last {fmtDateTime(row.last_received_at)}</div>}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button variant="ghost" onClick={() => setShowDocs(row.source)}>
            Details
          </Button>
          <Button variant="ghost" onClick={() => setShowLog(row.source)}>
            Received
          </Button>
          <Button variant="ghost" onClick={() => open(row)}>Edit</Button>
          <Button variant="ghost"
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate(row.source)}>
            <KeyRound className="h-3.5 w-3.5" />
            {row.has_secret ? "New secret" : "Issue secret"}
          </Button>
          {row.is_active && (
            <Button variant="ghost" onClick={() => disable.mutate(row.source)}>
              Switch off
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Systems allowed to push data into SCM. Each one signs its requests with a
          secret issued here, and may only send the events it is registered for.
        </p>
        <Button onClick={() => open()}>
          <Plus className="h-4 w-4" /> Register a webhook
        </Button>
      </div>

      {list.error && <ErrorBanner error="Webhooks could not be loaded." />}

      <ResponsiveList
        data={list.data ?? []}
        columns={columns}
        keyOf={(row) => row.source}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="Nothing is pushing into SCM yet"
            hint="Register the sending system, issue it a secret, and give it the URL. It can start posting the moment you do — no release needed."
          />
        }
        renderCard={(row) => (
          <div className="space-y-1 p-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.name || row.source}</span>
              <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />
            </div>
            <code className="block text-[11px] text-muted">{row.url}</code>
            <div className="text-xs text-body">{row.events.join(", ")}</div>
            <div className="text-xs text-muted">
              {row.received_count} received
              {row.last_received_at && ` · last ${fmtDateTime(row.last_received_at)}`}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button variant="ghost" onClick={() => setShowDocs(row.source)}>
                Details
              </Button>
              <Button variant="ghost" onClick={() => setShowLog(row.source)}>
                Received
              </Button>
              <Button variant="ghost" onClick={() => open(row)}>Edit</Button>
              <Button variant="ghost"
                      onClick={() => rotate.mutate(row.source)}>
                {row.has_secret ? "New secret" : "Issue secret"}
              </Button>
            </div>
          </div>
        )}
      />

      <WebhookDocsModal source={showDocs} onClose={() => setShowDocs(null)} />

      {/* ---- Register / edit ------------------------------------------------ */}
      <Modal isOpen={draft !== null} onClose={() => setDraft(null)} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            <span className="flex items-center gap-2">
              <Radio className="h-5 w-5 text-brand" />
              {editing === null ? "Register a webhook" : `Edit ${editing}`}
            </span>
          </ModalHeader>
          <ModalBody className="gap-3">
            {problem && <ErrorBanner error={problem} />}
            {draft && (
              <>
                <Field label="Name" hint="What this system is called, for this screen.">
                  <Input value={draft.name}
                         onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                         placeholder="HCM" />
                </Field>
                <Field
                  label="URL name"
                  hint={editing === null
                    ? "Becomes part of the address they post to: /api/ext/v1/hooks/<name>. Lower case, letters, numbers and hyphens."
                    : "Fixed once registered — changing it would break the address they are already posting to."}
                >
                  <Input value={draft.source}
                         disabled={editing !== null}
                         onChange={(e) => setDraft({
                           ...draft, source: e.target.value.toLowerCase(),
                         })}
                         placeholder="hcm" />
                </Field>
                <Field
                  label="Events it may send"
                  hint="Search the list or type the sending system's own name. Anything not listed here is refused at push time, with the list of what it takes."
                >
                  <EventPicker
                    value={draft.events}
                    options={eventNames.data ?? []}
                    onChange={(events) => setDraft({ ...draft, events })}
                  />
                </Field>
                <Field
                  label="What SCM does with it"
                  hint="A fixed list. Handling that writes to a business table is code, not configuration, so each option here answers for what it writes."
                >
                  <Select
                    value={draft.handler}
                    onChange={(value) => setDraft({ ...draft, handler: value })}
                    options={(handlers.data ?? []).map((h) => ({
                      value: h.key, label: h.label,
                    }))}
                  />
                </Field>
                <Field label="Description" hint="Optional.">
                  <Input value={draft.description ?? ""}
                         onChange={(e) => setDraft({
                           ...draft, description: e.target.value,
                         })}
                         placeholder="Employee changes pushed from HCM" />
                </Field>
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={save.isPending || !draft?.source.trim()
                              || !draft?.name.trim() || !draft?.events.length}
                    onClick={() => draft && save.mutate(draft)}>
              {editing === null ? "Register" : "Save"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* ---- The secret, shown once ----------------------------------------- */}
      <Modal isOpen={issued !== null} onClose={() => setIssued(null)} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            <span className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-brand" />
              {issued?.source}&apos;s signing secret
            </span>
          </ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm text-body">{issued?.note}</p>
            {/* A textarea, not a copy button: on the plain-http deployed host
              * navigator.clipboard does not exist, so a button would do nothing and
              * the one value that can never be shown again would be lost. */}
            <textarea
              readOnly
              value={issued?.shared_secret ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded-lg border border-line bg-content1 p-3
                         font-mono text-xs text-ink"
              rows={2}
            />
            <p className="text-xs text-muted">
              They send it back as{" "}
              <code className="text-ink">{issued?.signature_header}: sha256=&lt;HMAC-SHA256 of the raw body&gt;</code>,
              along with their API key. Rotating again invalidates this one immediately.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* ---- What arrived ---------------------------------------------------- */}
      <Modal isOpen={showLog !== null} onClose={() => setShowLog(null)} size="3xl">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            What {showLog} has sent
          </ModalHeader>
          <ModalBody>
            <ErrorBanner error={deliveries.error} />
            <Card className="p-2">
              <ResponsiveList
                data={deliveries.data?.items ?? []}
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
                      <span className="text-xs text-muted">
                        {fmtDateTime(row.received_at)}
                      </span>
                    ) },
                ]}
                keyOf={(row) => `${row.source}:${row.event_id}`}
                loading={deliveries.isLoading}
                empty="Nothing has arrived on this webhook yet."
                renderCard={(row) => (
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-ink">{row.event}</div>
                    <code className="block text-[11px] text-muted">{row.event_id}</code>
                    <div className="flex items-center gap-2">
                      <OutcomePill outcome={row.outcome} />
                      <span className="text-xs text-muted">
                        {fmtDateTime(row.received_at)}
                      </span>
                    </div>
                  </div>
                )}
              />
            </Card>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setShowLog(null)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
