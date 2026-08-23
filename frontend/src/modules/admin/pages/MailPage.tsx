import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Inbox, Mail, PenLine, Search, Send, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, Input, Textarea } from "@heroui/react";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, SubNav, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { api } from "@/shared/api/client";
import { fmtDateTime } from "@/shared/datetime";
import type { Paginated } from "@/shared/types";

/**
 * Settings > Mail — the company mailbox: Inbox, Sent and Compose.
 *
 * ONE shared mailbox for the deployment, not a per-user inbox. That is why it lives
 * under Settings and why its permissions are Admin-only until granted: everything
 * here reads or writes `scm@…`, the same address that sends every password-reset
 * link, so it is the company's voice rather than anybody's personal mail.
 *
 * ── What comes from where ───────────────────────────────────────────────────
 *
 *   Inbox   live over IMAP, READ-ONLY. Opening it never marks a message seen and
 *           never moves one — we are showing a mailbox the mail server owns.
 *   Sent    OUR OWN log (`sys_mail_messages`), not the mailbox's Sent folder. A
 *           message the server refused never reaches that folder, and that is
 *           exactly the one somebody comes here looking for. Failures are rows too.
 *   Compose SMTP, logged before it is attempted.
 *
 * ── RBAC ────────────────────────────────────────────────────────────────────
 *
 * Two codes, checked on the server on every route: `mail.view` reads, `mail.send`
 * sends. The Compose tab is not merely hidden without `mail.send` — it is not
 * rendered and its endpoint refuses independently.
 *
 * The tab list is also driven by what the MAILBOX can do, served from
 * `/api/mail/status`: a host offering SMTP and no IMAP gets no Inbox tab rather than
 * one that only ever errors.
 */

const SEND_PERM = "mail.send";

interface MailboxStatus {
  can_send: boolean;
  can_read: boolean;
  from_address: string;
  from_name: string;
}

interface InboxMessage {
  uid: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  date?: string | null;
  preview: string;
  body: string;
  seen: boolean;
}

interface SentMessage {
  id: number;
  to_addrs: string;
  cc_addrs?: string | null;
  subject?: string | null;
  body?: string | null;
  status: string;
  error?: string | null;
  kind: string;
  sent_by_name?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
}

const mailApi = {
  status: () => api.get<MailboxStatus>("/api/mail/status").then((r) => r.data),
  inbox: (search?: string) =>
    api.get<InboxMessage[]>("/api/mail/inbox", {
      params: { search: search || undefined },
    }).then((r) => r.data),
  sent: (search?: string) =>
    api.get<Paginated<SentMessage>>("/api/mail/sent", {
      params: { search: search || undefined, size: 50 },
    }).then((r) => r.data),
  send: (body: { to: string[]; cc: string[]; subject: string; body: string }) =>
    api.post<SentMessage>("/api/mail", body).then((r) => r.data),
};

/** Comma or semicolon separated, trimmed, blanks dropped. Splitting is the SCREEN's
 *  job — the API takes a list, which is the only shape that cannot silently send to
 *  an address somebody meant as two. */
const splitAddresses = (raw: string): string[] =>
  raw.split(/[,;]/).map((a) => a.trim()).filter(Boolean);

const STATUS_TONE: Record<string, { icon: LucideIcon; className: string }> = {
  SENT: { icon: CheckCircle2, className: "bg-ok-bg text-ok" },
  QUEUED: { icon: Clock, className: "bg-warn-bg text-warn" },
  FAILED: { icon: XCircle, className: "bg-bad-bg text-bad" },
};

function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? { icon: Clock, className: "bg-neutral-bg text-neutral" };
  const Icon = tone.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.className}`}>
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
}

/** Shown when the mailbox cannot do what a tab needs. A configuration state, said
 *  plainly, rather than a tab that renders an error on every open. */
function NotConfigured({ what }: { what: string }) {
  return (
    <Card className="p-10 text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-warn" />
      <p className="mt-3 text-sm font-semibold text-ink">{what}</p>
      <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted">
        Set the mail keys in <span className="mono">backend/.env</span> and restart the
        API. They are never stored in the database or in source.
      </p>
    </Card>
  );
}

export function MailPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("inbox");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<InboxMessage | SentMessage | null>(null);

  const status = useQuery({ queryKey: ["mail", "status"], queryFn: mailApi.status });
  const canSend = Boolean(status.data?.can_send) && can(SEND_PERM);
  const canRead = Boolean(status.data?.can_read);

  const inbox = useQuery({
    queryKey: ["mail", "inbox", search],
    queryFn: () => mailApi.inbox(search),
    enabled: tab === "inbox" && canRead,
    // A mailbox is not a document: refetching it on every focus is a round trip to a
    // remote IMAP server for a screen somebody is reading, not editing.
    staleTime: 60_000,
  });

  const sent = useQuery({
    queryKey: ["mail", "sent", search],
    queryFn: () => mailApi.sent(search),
    enabled: tab === "sent",
    staleTime: 30_000,
  });

  const tabs = [
    ...(canRead ? [{ key: "inbox", label: "Inbox", icon: Inbox }] : []),
    { key: "sent", label: "Sent", icon: Send },
    ...(canSend ? [{ key: "compose", label: "Compose", icon: PenLine }] : []),
  ];
  // The mailbox may be send-only, in which case Inbox is not offered and the default
  // tab has to move — otherwise the screen opens on a tab that is not in the strip.
  const activeTab = tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? "sent");

  const inboxColumns: Column<InboxMessage>[] = [
    {
      key: "from",
      header: "From",
      render: (row) => (
        <div className="min-w-0">
          <div className={`truncate text-sm ${row.seen ? "text-body" : "font-semibold text-ink"}`}>
            {row.from_addr || "(unknown sender)"}
          </div>
          <div className="truncate text-[11px] text-muted">{row.to_addr}</div>
        </div>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (row) => (
        <div className="min-w-0">
          <div className={`truncate text-sm ${row.seen ? "text-body" : "font-semibold text-ink"}`}>
            {row.subject}
          </div>
          <div className="truncate text-[11px] text-muted">{row.preview}</div>
        </div>
      ),
    },
    {
      key: "date",
      header: "Received",
      hideOnNarrow: true,
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {row.date ? fmtDateTime(row.date) : "—"}
        </span>
      ),
    },
  ];

  const sentColumns: Column<SentMessage>[] = [
    {
      key: "to",
      header: "To",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">{row.to_addrs}</div>
          {row.cc_addrs && (
            <div className="truncate text-[11px] text-muted">cc {row.cc_addrs}</div>
          )}
        </div>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-body">{row.subject || "(no subject)"}</div>
          {/* A password-reset row carries no body on purpose — see MailKind. Saying so
              is better than an empty cell that reads as a bug. */}
          {row.kind === "PASSWORD_RESET" && (
            <div className="text-[11px] text-muted">Password reset link — body not stored</div>
          )}
        </div>
      ),
    },
    { key: "status", header: "Status", render: (row) => <StatusChip status={row.status} /> },
    {
      key: "by",
      header: "Sent by",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-xs text-muted">{row.sent_by_name ?? "System"}</span>
      ),
    },
    {
      key: "when",
      header: "When",
      hideOnNarrow: true,
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {fmtDateTime(row.sent_at ?? row.created_at ?? undefined)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Settings"
        title="Mail"
        actions={
          status.data?.from_address ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-line/70 bg-content1 px-3 py-1.5 text-xs text-muted">
              <Mail className="h-3.5 w-3.5" />
              Sending as <span className="font-semibold text-ink">{status.data.from_address}</span>
            </span>
          ) : undefined
        }
      />

      <SubNav
        label="Mail"
        items={tabs.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
        value={activeTab}
        onChange={(key) => { setTab(key); setOpen(null); }}
      />

      <ErrorBanner error={status.error} />

      {activeTab === "compose" && <ComposeTab
        from={status.data?.from_address ?? ""}
        onSent={() => {
          // The Sent log has a new row; the mailbox may too, but that is the mail
          // server's business and refetching IMAP here would be a round trip for
          // something the user has not asked to look at.
          queryClient.invalidateQueries({ queryKey: ["mail", "sent"] });
          setTab("sent");
        }}
      />}

      {activeTab === "inbox" && (
        !canRead ? (
          <NotConfigured what="This mailbox is send-only." />
        ) : (
          <>
            <SearchRow value={search} onChange={setSearch} placeholder="Search the mailbox…" />
            <ErrorBanner error={inbox.error} />
            <Card className="p-2">
              <ResponsiveList
                data={inbox.data ?? []}
                columns={inboxColumns}
                keyOf={(row) => row.uid}
                loading={inbox.isLoading}
                onRowClick={(row) => setOpen(row)}
                empty="No messages."
                renderCard={(row) => (
                  <div className="space-y-1">
                    <div className={`text-sm ${row.seen ? "text-body" : "font-semibold text-ink"}`}>
                      {row.subject}
                    </div>
                    <div className="text-xs text-muted">{row.from_addr}</div>
                    <div className="text-xs text-muted">{row.preview}</div>
                  </div>
                )}
              />
            </Card>
          </>
        )
      )}

      {activeTab === "sent" && (
        <>
          <SearchRow value={search} onChange={setSearch} placeholder="Search recipients or subject…" />
          <ErrorBanner error={sent.error} />
          <Card className="p-2">
            <ResponsiveList
              data={sent.data?.items ?? []}
              columns={sentColumns}
              keyOf={(row) => row.id}
              loading={sent.isLoading}
              onRowClick={(row) => setOpen(row)}
              empty="Nothing has been sent from this app yet."
              renderCard={(row) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{row.to_addrs}</span>
                    <StatusChip status={row.status} />
                  </div>
                  <div className="text-xs text-body">{row.subject || "(no subject)"}</div>
                  <div className="text-xs text-muted">
                    {fmtDateTime(row.sent_at ?? row.created_at ?? undefined)}
                  </div>
                </div>
              )}
            />
          </Card>
        </>
      )}

      {open && <MessageDetail message={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SearchRow({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="mb-4">
      <label className="relative block max-w-sm">
        <span className="sr-only">{placeholder}</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
        />
      </label>
    </div>
  );
}

/** One message, opened in place. Not a route: a mail body is a read, not a screen,
 *  and a URL for it would have to carry an IMAP uid that changes when the mailbox
 *  is reorganised. */
function MessageDetail({ message, onClose }: {
  message: InboxMessage | SentMessage;
  onClose: () => void;
}) {
  const isInbox = "uid" in message;
  return (
    <Card className="mt-4 p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold text-ink">
            {isInbox ? message.subject : (message.subject || "(no subject)")}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {isInbox
              ? `${message.from_addr} → ${message.to_addr}`
              : `To ${message.to_addrs}${message.cc_addrs ? ` · cc ${message.cc_addrs}` : ""}`}
          </p>
        </div>
        <Button size="sm" variant="light" onPress={onClose}>Close</Button>
      </div>

      {!isInbox && message.status === "FAILED" && message.error && (
        <div className="mb-3 rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">
          {/* The mail server's own words, kept: "relay access denied" and
              "authentication failed" need different fixes. */}
          {message.error}
        </div>
      )}

      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/70 bg-content2 p-4 text-sm text-body">
        {isInbox
          ? (message.body || "(no readable text in this message)")
          : (message.body
            || (message.kind === "PASSWORD_RESET"
              ? "The body of a password-reset message is deliberately not stored — it "
                + "contains a live reset link, and this log is readable by anyone who "
                + "can open this screen."
              : "(no body)"))}
      </pre>
    </Card>
  );
}

function ComposeTab({ from, onSent }: { from: string; onSent: () => void }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ok, setOk] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: mailApi.send,
    onSuccess: (row) => {
      setOk(`Sent to ${row.to_addrs}`);
      setTo(""); setCc(""); setSubject(""); setBody("");
      onSent();
    },
  });

  const recipients = splitAddresses(to);
  const ready = recipients.length > 0 && subject.trim() && body.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    setOk(null);
    send.mutate({
      to: recipients,
      cc: splitAddresses(cc),
      subject: subject.trim(),
      body,
    });
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="rounded-lg border border-line/70 bg-content2 px-3 py-2 text-xs text-muted">
          From <span className="font-semibold text-ink">{from || "the configured mailbox"}</span>
          {" — every recipient sees the company address, not yours."}
        </div>

        <Input
          label="To"
          variant="bordered"
          radius="md"
          value={to}
          onValueChange={setTo}
          placeholder="someone@company.com, another@company.com"
          description={recipients.length > 1
            ? `${recipients.length} recipients`
            : "Separate several addresses with a comma"}
          isRequired
        />
        <Input
          label="Cc"
          variant="bordered"
          radius="md"
          value={cc}
          onValueChange={setCc}
          placeholder="Optional"
        />
        <Input
          label="Subject"
          variant="bordered"
          radius="md"
          value={subject}
          onValueChange={setSubject}
          isRequired
        />
        <Textarea
          label="Message"
          variant="bordered"
          radius="md"
          minRows={10}
          value={body}
          onValueChange={setBody}
          isRequired
        />

        <ErrorBanner error={send.error} />
        {ok && (
          <div className="rounded-xl bg-ok-bg px-3 py-2 text-sm font-medium text-ok">{ok}</div>
        )}

        <div className="flex justify-end">
          <Button
            type="submit"
            color="primary"
            radius="md"
            isLoading={send.isPending}
            isDisabled={!ready}
            startContent={!send.isPending && <Send className="h-4 w-4" />}
            className="h-11 font-semibold"
          >
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
