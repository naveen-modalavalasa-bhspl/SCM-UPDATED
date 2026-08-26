import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Inbox, Mail, PenLine, Search, Send, ShieldCheck,
  XCircle,
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
//: Confirming a reset address is a USERS decision, not a mailbox one — approving one
//  is deciding who may take over an account. Matches the route's own dependency.
const CLAIMS_PERM = "admin.users.manage";

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

/** An address somebody typed into "forgot password", waiting to be confirmed as
 *  theirs. See `platform/mail/service.request_reset` for why it is not taken on
 *  trust: emp codes are on every user list, so the typed address alone would let
 *  anyone have somebody else's reset link delivered to their own inbox. */
interface EmailClaim {
  id: number;
  employee_id: number;
  employee_code?: string | null;
  employee_name?: string | null;
  email: string;
  status: string;
  requested_ip?: string | null;
  created_at?: string | null;
  decided_at?: string | null;
  decided_by_name?: string | null;
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
  claims: (status?: string) =>
    api.get<Paginated<EmailClaim>>("/api/mail/email-claims", {
      params: { status: status || undefined, size: 50 },
    }).then((r) => r.data),
  decideClaim: (id: number, approve: boolean) =>
    api.post<EmailClaim>(`/api/mail/email-claims/${id}/decide`, { approve })
      .then((r) => r.data),
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

  // Gated on the USERS right, not a mail one, and the server agrees: deciding this
  // is deciding who may take over an account.
  const canDecideClaims = can(CLAIMS_PERM);
  const claims = useQuery({
    queryKey: ["mail", "claims"],
    queryFn: () => mailApi.claims(),
    enabled: tab === "claims" && canDecideClaims,
    staleTime: 15_000,
  });
  const pendingClaims = (claims.data?.items ?? [])
    .filter((c) => c.status === "PENDING").length;

  const tabs = [
    ...(canRead ? [{ key: "inbox", label: "Inbox", icon: Inbox }] : []),
    { key: "sent", label: "Sent", icon: Send },
    ...(canSend ? [{ key: "compose", label: "Compose", icon: PenLine }] : []),
    ...(canDecideClaims
      ? [{ key: "claims", label: "Reset requests", icon: ShieldCheck }] : []),
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

      {activeTab === "claims" && (
        <ClaimsTab
          claims={claims.data?.items ?? []}
          loading={claims.isLoading}
          error={claims.error}
          pending={pendingClaims}
          canSend={Boolean(status.data?.can_send)}
          onDecided={() => {
            queryClient.invalidateQueries({ queryKey: ["mail", "claims"] });
            // Approving SENDS a link, so the Sent log has a new row.
            queryClient.invalidateQueries({ queryKey: ["mail", "sent"] });
          }}
        />
      )}

      {open && <MessageDetail message={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * Reset requests — confirm that an address really belongs to the person asking.
 *
 * WHY A HUMAN IS IN THIS LOOP. `request_reset` finds the account by
 * `hcm_employees.email`, and HCM serves no employee email at all (the only address in
 * its payload belongs to the person's MANAGER), so the mirror starts with none and
 * there is nothing to match a typed address against. Taking the typed address on
 * trust would be an account takeover: emp codes are printed on every user list,
 * approval and document, so anyone could enter somebody else's code with their own
 * address and be handed that person's reset link.
 *
 * Approve does BOTH halves — records the address on the employee and sends the link —
 * so there is no state where an address is trusted but the person is still stuck.
 * Every later reset for that person then skips this queue entirely.
 *
 * Two rows for one employee with DIFFERENT addresses is the case this screen exists
 * to make visible. Read them together before approving either.
 */
function ClaimsTab({ claims, loading, error, pending, canSend, onDecided }: {
  claims: EmailClaim[];
  loading: boolean;
  error: unknown;
  pending: number;
  canSend: boolean;
  onDecided: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState<unknown>(null);

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      mailApi.decideClaim(id, approve),
    onMutate: ({ id }) => { setBusyId(id); setFailed(null); },
    onError: (err) => setFailed(err),
    onSettled: () => setBusyId(null),
    onSuccess: onDecided,
  });

  //: More than one live claim on one account. Not an error — it is the shape an
  //  attempted takeover takes, and the reason to read before pressing.
  const contested = new Set(
    claims
      .filter((c) => c.status === "PENDING")
      .map((c) => c.employee_id)
      .filter((id, i, all) => all.indexOf(id) !== i),
  );

  const columns: Column<EmailClaim>[] = [
    {
      key: "who",
      header: "Employee",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">
            {row.employee_name || `Employee ${row.employee_id}`}
          </div>
          <div className="truncate text-[11px] text-muted">{row.employee_code}</div>
        </div>
      ),
    },
    {
      key: "email",
      header: "Address asked for",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{row.email}</div>
          {contested.has(row.employee_id) && row.status === "PENDING" && (
            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-warn-bg px-1.5 py-0.5 text-[11px] font-semibold text-warn">
              <AlertTriangle className="h-3 w-3" />
              more than one address claimed
            </span>
          )}
        </div>
      ),
    },
    {
      key: "asked",
      header: "Asked",
      render: (row) => (
        <div className="text-xs text-muted">
          <div>{fmtDateTime(row.created_at ?? undefined)}</div>
          {row.requested_ip && <div>from {row.requested_ip}</div>}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        row.status === "PENDING"
          ? <StatusChip status="QUEUED" />
          : (
            <div className="text-xs">
              <StatusChip status={row.status === "APPROVED" ? "SENT" : "FAILED"} />
              {row.decided_by_name && (
                <div className="mt-0.5 text-muted">by {row.decided_by_name}</div>
              )}
            </div>
          )
      ),
    },
    {
      key: "decide",
      header: "",
      render: (row) => (
        row.status !== "PENDING" ? null : (
          <div className="flex justify-end gap-2">
            <Button
              size="sm" variant="bordered" radius="md"
              isDisabled={busyId === row.id}
              onPress={() => decide.mutate({ id: row.id, approve: false })}
            >
              Not theirs
            </Button>
            <Button
              size="sm" color="primary" radius="md"
              isLoading={busyId === row.id}
              onPress={() => decide.mutate({ id: row.id, approve: true })}
            >
              Confirm &amp; send
            </Button>
          </div>
        )
      ),
    },
  ];

  return (
    <>
      {!canSend && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-bg/60 p-3 text-sm text-body">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <span>
            No mailbox is configured, so confirming a request records the address but
            the link cannot be delivered. Set the SMTP settings first.
          </span>
        </div>
      )}
      <div className="mb-4 text-sm text-muted">
        {pending === 0
          ? "Nothing is waiting to be confirmed."
          : `${pending} ${pending === 1 ? "request is" : "requests are"} waiting. ` +
            "Confirm only an address you know belongs to that person — approving sends " +
            "them a link that sets a new password."}
      </div>
      <ErrorBanner error={failed ?? error} />
      <Card className="p-2">
        <ResponsiveList
          data={claims}
          columns={columns}
          keyOf={(row) => row.id}
          loading={loading}
          empty="Nobody has asked for a password reset yet."
          renderCard={(row) => (
            <div className="space-y-1">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink">
                  {row.employee_name || `Employee ${row.employee_id}`}
                </span>
                <StatusChip status={row.status === "PENDING" ? "QUEUED"
                  : row.status === "APPROVED" ? "SENT" : "FAILED"} />
              </div>
              <div className="text-xs text-body">{row.email}</div>
              <div className="text-xs text-muted">{row.employee_code}</div>
              {row.status === "PENDING" && (
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm" variant="bordered" radius="md" className="flex-1"
                    isDisabled={busyId === row.id}
                    onPress={() => decide.mutate({ id: row.id, approve: false })}
                  >
                    Not theirs
                  </Button>
                  <Button
                    size="sm" color="primary" radius="md" className="flex-1"
                    isLoading={busyId === row.id}
                    onPress={() => decide.mutate({ id: row.id, approve: true })}
                  >
                    Confirm &amp; send
                  </Button>
                </div>
              )}
            </div>
          )}
        />
      </Card>
    </>
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
