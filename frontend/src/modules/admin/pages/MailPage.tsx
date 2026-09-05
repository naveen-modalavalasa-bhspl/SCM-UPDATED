import { useCallback, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Clock, ImageOff, Inbox, Mail,
  MoreHorizontal, PenLine, Search, Send, ShieldCheck, X, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, Input, Textarea } from "@heroui/react";
import {
  Card, ErrorBanner, PageHeader, ResponsiveList, type Column,
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
  /** The sender's own html, empty when they sent none. Rendered in a sandboxed frame
   *  and never in our document — see `HtmlBody`. */
  body_html: string;
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

/** The four groups a mail list falls into, newest first. Outlook's own headings,
 *  because they are the ones a person already reads a mailbox by: nobody scans for
 *  "12 Sep", they scan for "today" and then give up. */
const DAY_MS = 86_400_000;

function dayBucket(when?: string | null): string {
  if (!when) return "Undated";
  const then = new Date(when);
  if (Number.isNaN(then.getTime())) return "Undated";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const age = midnight.getTime() - then.getTime();
  if (age <= 0) return "Today";
  if (age <= DAY_MS) return "Yesterday";
  if (age <= 7 * DAY_MS) return "Last week";
  return "Older";
}

/** Time for something from today, a weekday for this week, a date for anything
 *  older — the same shortening every mail client does, for the same reason: a
 *  column of identical full timestamps carries no information. */
function listStamp(when?: string | null): string {
  if (!when) return "";
  const then = new Date(when);
  if (Number.isNaN(then.getTime())) return "";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const age = midnight.getTime() - then.getTime();
  if (age <= 0) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (age <= 6 * DAY_MS) {
    return then.toLocaleDateString(undefined, { weekday: "short" });
  }
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Rows into ordered day groups. Order is preserved from the server, which already
 *  sends newest first — this only inserts the headings, it never re-sorts. */
function groupByDay<T>(rows: T[], dateOf: (row: T) => string | null | undefined) {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dayBucket(dateOf(row));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** The display name out of `"Kelly Rao" <kelly@x.com>`, falling back to the address.
 *  A column of raw angle-bracket headers is unreadable, and the address is still one
 *  click away in the reading pane. */
function senderName(raw: string): string {
  const quoted = raw.match(/^\s*"?([^"<]+?)"?\s*</);
  if (quoted) return quoted[1].trim();
  return raw.trim() || "(unknown sender)";
}

/** Everything the two list shapes have in common, so one list component draws both.
 *  Inbox rows come live from IMAP and Sent rows from our own log — different tables,
 *  same three lines on screen. */
interface ListRow {
  key: string;
  who: string;
  subject: string;
  preview: string;
  when?: string | null;
  unread: boolean;
  /** Sent rows only: FAILED has to be visible in the LIST, not just on open. A
   *  message the server refused is the one somebody came here to find. */
  status?: string;
}

export function MailPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("inbox");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  /* The two dividers. Widths belong to the VIEWER, not the document — somebody
     working the reset queue wants a wide rail, somebody reading long threads wants
     none — so they are remembered per browser and never sent anywhere. */
  const rail = useSplit("scm.mail.rail", 224, 168, 360);
  const list = useSplit("scm.mail.list", 400, 280, 680);

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

  const inboxRows = inbox.data ?? [];
  const sentRows = sent.data?.items ?? [];
  const unreadCount = inboxRows.filter((m) => !m.seen).length;

  /* The folders. UNCHANGED in what decides them: the mailbox's own capabilities from
     `/api/mail/status`, plus `mail.send` and `admin.users.manage`. A folder nobody
     may open is not rendered, and its endpoint refuses independently — hiding a
     folder is not the security, the server check is (rule 6). */
  const folders = [
    ...(canRead
      ? [{ key: "inbox", label: "Inbox", icon: Inbox, count: unreadCount }] : []),
    { key: "sent", label: "Sent", icon: Send },
    ...(canSend ? [{ key: "compose", label: "Compose", icon: PenLine }] : []),
    ...(canDecideClaims
      ? [{ key: "claims", label: "Reset requests", icon: ShieldCheck,
           count: pendingClaims }] : []),
  ];
  // The mailbox may be send-only, in which case Inbox is not offered and the default
  // folder has to move — otherwise the screen opens on one that is not in the rail.
  const activeTab = folders.some((f) => f.key === tab) ? tab : (folders[0]?.key ?? "sent");

  // Tailwind cannot express "this width only from md up", and an inline style has
  // no breakpoints — so the width is applied through a CSS variable that the class
  // below only reads at md and wider.
  const listPaneStyle = { "--list-w": `${list.width}px` } as React.CSSProperties;

  const isInboxFolder = activeTab === "inbox";
  const isListFolder = isInboxFolder || activeTab === "sent";

  const rows: ListRow[] = isInboxFolder
    ? inboxRows.map((m) => ({
        key: m.uid,
        who: senderName(m.from_addr),
        subject: m.subject || "(no subject)",
        preview: m.preview,
        when: m.date,
        unread: !m.seen,
      }))
    : sentRows.map((m) => ({
        key: String(m.id),
        who: m.to_addrs,
        subject: m.subject || "(no subject)",
        // A password-reset row carries no body on purpose — see MailKind. Saying so
        // is better than an empty line that reads as a bug.
        preview: m.kind === "PASSWORD_RESET"
          ? "Password reset link — body not stored"
          : (m.body ?? "").replace(/\s+/g, " ").trim(),
        when: m.sent_at ?? m.created_at,
        // Nothing in the Sent log is "unread"; FAILED is what earns the bold row.
        unread: m.status === "FAILED",
        status: m.status,
      }));

  const shown = unreadOnly ? rows.filter((r) => r.unread) : rows;
  const groups = groupByDay(shown, (r) => r.when);
  const listLoading = isInboxFolder ? inbox.isLoading : sent.isLoading;
  const listError = isInboxFolder ? inbox.error : sent.error;

  const openInbox = isInboxFolder
    ? inboxRows.find((m) => m.uid === openKey) ?? null : null;
  const openSent = activeTab === "sent"
    ? sentRows.find((m) => String(m.id) === openKey) ?? null : null;
  const open = openInbox ?? openSent;

  function pickFolder(key: string) {
    setTab(key);
    setOpenKey(null);
    setSearch("");
    setUnreadOnly(false);
  }

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

      <ErrorBanner error={status.error} />

      {/* The three panes. One bordered surface rather than three cards: a mail client
          reads as one window with dividers in it, and stacked cards put a gutter
          where the divider should be.

          The height is FIXED so each pane scrolls independently — which is the whole
          point of the layout. A page that grows instead means picking a message from
          last week scrolls the rail and the reading pane off the top. */}
      <div className="mail-shell flex h-[calc(100dvh-15rem)] min-h-[34rem] overflow-hidden rounded-2xl border border-line/70 bg-content1">

        {/* ── Folders ───────────────────────────────────────────────────────── */}
        <nav
          aria-label="Mail folders"
          style={{ width: rail.width }}
          className="hidden shrink-0 flex-col gap-1 overflow-y-auto bg-content2/40 p-3 lg:flex"
        >
          <p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            {status.data?.from_name || "Mailbox"}
          </p>
          {folders.map((f) => {
            const Icon = f.icon;
            const on = f.key === activeTab;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => pickFolder(f.key)}
                aria-current={on ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors ${
                  on
                    ? "bg-brand/10 font-semibold text-brand"
                    : "text-body hover:bg-content3/60"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                {Boolean(f.count) && (
                  <span className={`shrink-0 text-xs font-semibold ${on ? "text-brand" : "text-muted"}`}>
                    {f.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="hidden lg:block">
          <SplitHandle
            label="Resize the folder list"
            onDrag={rail.start}
            onNudge={(d) => rail.nudge(d)}
            onReset={rail.reset}
          />
        </div>

        {/* Compose and Reset requests are not lists — they take the whole window to
            the right of the rail rather than pretending to be a mailbox. */}
        {activeTab === "compose" && (
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            <MobileFolders folders={folders} active={activeTab} onPick={pickFolder} />
            <ComposeTab
              from={status.data?.from_address ?? ""}
              onSent={() => {
                // The Sent log has a new row; the mailbox may too, but that is the
                // mail server's business and refetching IMAP here would be a round
                // trip for something the user has not asked to look at.
                queryClient.invalidateQueries({ queryKey: ["mail", "sent"] });
                pickFolder("sent");
              }}
            />
          </div>
        )}

        {activeTab === "claims" && (
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            <MobileFolders folders={folders} active={activeTab} onPick={pickFolder} />
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
          </div>
        )}

        {isListFolder && (isInboxFolder && !canRead ? (
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            <MobileFolders folders={folders} active={activeTab} onPick={pickFolder} />
            <NotConfigured what="This mailbox is send-only." />
          </div>
        ) : (
          <>
            {/* ── The list ──────────────────────────────────────────────────── */}
            <section
              /* A width only once there is a second pane beside it. Below `md` the
                 list IS the screen and a stored pixel width would crop it. */
              style={listPaneStyle}
              className={`min-w-0 flex-col md:flex md:w-[var(--list-w)] md:shrink-0 ${
                open ? "hidden md:flex" : "flex flex-1"
              }`}
            >
              <div className="shrink-0 border-b border-line/70 p-3">
                <MobileFolders folders={folders} active={activeTab} onPick={pickFolder} />
                <label className="relative block">
                  <span className="sr-only">Search</span>
                  <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={isInboxFolder
                      ? "Search the mailbox…" : "Search recipients or subject…"}
                    className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
                  />
                </label>

                <div className="mt-3 flex items-center gap-4 px-1">
                  {/* All / Unread, exactly as a mail client offers it. On Sent the
                      second word is "Failed", because that is what the same filter
                      means over a log of what went out. */}
                  {[
                    { key: false, label: "All" },
                    { key: true, label: isInboxFolder ? "Unread" : "Failed" },
                  ].map((f) => (
                    <button
                      key={String(f.key)}
                      type="button"
                      onClick={() => setUnreadOnly(f.key)}
                      className={`relative pb-2 text-sm transition-colors ${
                        unreadOnly === f.key
                          ? "font-semibold text-brand after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                  <span className="ml-auto pb-2 text-xs text-muted">
                    {shown.length} {shown.length === 1 ? "message" : "messages"}
                  </span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <ErrorBanner error={listError} />
                {listLoading && (
                  <p className="p-6 text-sm text-muted">Loading…</p>
                )}
                {!listLoading && shown.length === 0 && (
                  <p className="p-6 text-sm text-muted">
                    {isInboxFolder
                      ? (unreadOnly ? "Nothing unread." : "No messages.")
                      : (unreadOnly
                        ? "Nothing has failed to send."
                        : "Nothing has been sent from this app yet.")}
                  </p>
                )}
                {groups.map((group) => (
                  <div key={group.label}>
                    {/* Sticky, so the heading of the group being read stays visible
                        while scrolling through a long one. */}
                    <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-content2/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted backdrop-blur">
                      <ChevronDown className="h-3 w-3" /> {group.label}
                    </div>
                    {group.rows.map((row) => (
                      <button
                        key={row.key}
                        type="button"
                        onClick={() => setOpenKey(row.key)}
                        aria-current={openKey === row.key ? "true" : undefined}
                        className={`flex w-full min-h-11 items-start gap-3 border-b border-line/50 px-4 py-3 text-left transition-colors ${
                          openKey === row.key ? "bg-brand/10" : "hover:bg-content2/70"
                        }`}
                      >
                        {/* The unread accent. A bar rather than a dot: it also marks
                            the row's full height, which is what makes an unread run
                            readable as a block at a glance. */}
                        <span
                          aria-hidden
                          className={`mt-0.5 w-0.5 shrink-0 self-stretch rounded-full ${
                            row.unread ? "bg-brand" : "bg-transparent"
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className={`min-w-0 flex-1 truncate text-sm ${
                              row.unread ? "font-semibold text-ink" : "text-body"
                            }`}>
                              {row.who}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted">
                              {listStamp(row.when)}
                            </span>
                          </span>
                          <span className={`mt-0.5 block truncate text-[13px] ${
                            row.unread ? "font-semibold text-brand" : "text-body"
                          }`}>
                            {row.subject}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-muted">
                              {row.preview || "—"}
                            </span>
                            {row.status && row.status !== "SENT" && (
                              <StatusChip status={row.status} />
                            )}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </section>

            <SplitHandle
              label="Resize the message list"
              onDrag={list.start}
              onNudge={(d) => list.nudge(d)}
              onReset={list.reset}
            />

            {/* ── The reading pane ──────────────────────────────────────────── */}
            <section className={`min-w-0 flex-1 flex-col ${open ? "flex" : "hidden md:flex"}`}>
              {open ? (
                <ReadingPane message={open} onClose={() => setOpenKey(null)} />
              ) : (
                <div className="grid h-full place-items-center p-10 text-center">
                  <div>
                    <Mail className="mx-auto h-8 w-8 text-muted/60" />
                    <p className="mt-3 text-sm text-muted">
                      Pick a message to read it here.
                    </p>
                  </div>
                </div>
              )}
            </section>
          </>
        ))}
      </div>
    </div>
  );
}

/** The folder rail, for the widths that have no room for one. Same list, same
 *  gating — it is the rail's data, rendered as a strip. */
function MobileFolders({ folders, active, onPick }: {
  folders: { key: string; label: string; icon: LucideIcon; count?: number }[];
  active: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
      {folders.map((f) => {
        const Icon = f.icon;
        const on = f.key === active;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onPick(f.key)}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors ${
              on ? "bg-brand/10 font-semibold text-brand" : "text-body hover:bg-content3/60"
            }`}
          >
            <Icon className="h-4 w-4" />
            {f.label}
            {Boolean(f.count) && <span className="text-xs font-semibold">{f.count}</span>}
          </button>
        );
      })}
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

/* --------------------------------------------------------------------------- */
/*  Resizable splits                                                            */
/* --------------------------------------------------------------------------- */

/**
 * One draggable divider's width, remembered per pane.
 *
 * Kept in `localStorage` rather than on the server: how wide somebody likes their
 * folder rail is a per-viewer convenience, not company data, and a round trip to
 * store it would be a write on every drag. A blocked or cleared store just means the
 * default width, which is why every access is wrapped — a browser set to refuse site
 * data throws on read, and an unusable mail screen would be a poor trade for a
 * remembered pixel count.
 */
function useSplit(storageKey: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch { /* no store, or refused — the default is a fine answer */ }
    return initial;
  });

  const start = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = width;
    // Pointer events on the WINDOW, not the handle: a drag that outruns the mouse
    // must keep tracking, and the pointer leaves a 6px handle immediately.
    const move = (e: PointerEvent) => {
      const next = Math.min(max, Math.max(min, originWidth + (e.clientX - originX)));
      setWidth(next);
    };
    const done = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const next = Math.min(max, Math.max(min, originWidth + (e.clientX - originX)));
      try { localStorage.setItem(storageKey, String(next)); } catch { /* see above */ }
    };
    // Held on the BODY for the length of the drag: without it the cursor flickers
    // back to a text caret every time the pointer crosses a label.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }, [width, min, max, storageKey]);

  const persist = (next: number) => {
    setWidth(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* see above */ }
  };

  return {
    width,
    start,
    nudge: (delta: number) => persist(Math.min(max, Math.max(min, width + delta))),
    reset: () => persist(initial),
  };
}

/** The divider itself. A 1px line with a 9px grab area around it — a hairline is the
 *  right thing to LOOK at and the wrong thing to aim a mouse at.
 *
 *  Keyboard-operable, because a pane somebody cannot widen without a mouse is a pane
 *  somebody cannot read: arrows nudge, Home restores the default. */
function SplitHandle({ label, onDrag, onNudge, onReset }: {
  label: string;
  onDrag: (event: React.PointerEvent) => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onDrag}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); onNudge(-24); }
        if (e.key === "ArrowRight") { e.preventDefault(); onNudge(24); }
        if (e.key === "Home") { e.preventDefault(); onReset(); }
      }}
      className="group relative hidden w-[9px] shrink-0 cursor-col-resize touch-none md:block"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/70 transition-colors group-hover:bg-brand/60 group-focus-visible:bg-brand"
      />
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*  The body of one message                                                     */
/* --------------------------------------------------------------------------- */

/** Where a plain-text reply stops being the reply and starts being the thread it is
 *  answering. Every client marks it differently and none of them agree, so this is
 *  the union of the four that actually appear in this mailbox. */
const QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{5,}\s*$/m,
  /^On .{4,120}\bwrote:\s*$/im,
  /^From:.*$\n^Sent:/im,
  /^>{1,}\s/m,
];

/** The reply, and everything under it. Split rather than trimmed: the history is the
 *  half a person scrolls to when the reply alone does not explain itself, so it is
 *  always kept and only folded away. */
function splitQuoted(text: string): { head: string; quoted: string } {
  let cut = -1;
  for (const marker of QUOTE_MARKERS) {
    const found = text.search(marker);
    if (found > 0 && (cut === -1 || found < cut)) cut = found;
  }
  // Under a few lines of reply there is nothing worth folding, and a fold that hides
  // two lines is just a button in the way.
  if (cut < 0 || text.slice(0, cut).trim().length < 40) {
    return { head: text, quoted: "" };
  }
  return { head: text.slice(0, cut).trimEnd(), quoted: text.slice(cut) };
}

/**
 * The html a sender sent, rendered — inside a sandboxed frame, never in our document.
 *
 * THIS IS THE SECURITY OF THE SCREEN. The markup is written by whoever emailed the
 * company mailbox; `dangerouslySetInnerHTML` would run it on our own origin with the
 * session of whoever holds `mail.view`, which is stored XSS with an invitation. The
 * frame is `srcDoc`, so it has a NULL origin and can reach nothing of ours, and the
 * sandbox grants no scripts at all — only `allow-popups`, so a link in the message
 * still opens, in a new tab, and can never navigate the app away from itself.
 *
 * REMOTE IMAGES ARE BLOCKED until asked for, by a CSP inside the frame. A mail image
 * is a tracking pixel as often as it is a picture, and loading one tells the sender
 * the company mailbox is being read, by whom, and when — off a screen that is
 * supposed to be read-only. `data:` images are allowed throughout: they are already
 * in the message and fetch nothing.
 */
function HtmlBody({ html, showImages }: { html: string; showImages: boolean }) {
  const srcDoc = useMemo(() => {
    const imgSrc = showImages ? "img-src data: https: http: cid:;" : "img-src data:;";
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; `
      + `${imgSrc} style-src 'unsafe-inline'; font-src data:;">`
      // Every link leaves the frame rather than replacing the message inside it.
      + `<base target="_blank">`
      + `<style>`
      + `html,body{margin:0;padding:0;background:#fff;color:#141a2a;`
      + `font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;`
      + `word-wrap:break-word;overflow-wrap:break-word;}`
      + `body{padding:4px 2px 24px;}`
      // A mail table is routinely 600-800px wide and the pane is not.
      + `img,table,pre{max-width:100%!important;}img{height:auto;}`
      + `table{border-collapse:collapse;}`
      + `blockquote{margin:8px 0 8px 12px;padding-left:12px;border-left:2px solid #e5e8ef;color:#697187;}`
      + `a{color:#CC004C;}`
      + `</style></head><body>${html}</body></html>`;
  }, [html, showImages]);

  return (
    <iframe
      // Keyed on the document so switching messages remounts the frame rather than
      // leaving the previous mail on screen while the new srcDoc settles.
      key={srcDoc.length + (showImages ? "-img" : "")}
      title="Message"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="h-full w-full border-0 bg-white"
    />
  );
}

/** Plain text, with the quoted thread folded under a control rather than dropped. */
function TextBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { head, quoted } = useMemo(() => splitQuoted(text), [text]);
  return (
    <div className="px-5 py-4">
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-body">
        {head}
      </pre>
      {quoted && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line/70 px-3 text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            <MoreHorizontal className="h-4 w-4" />
            {open ? "Hide earlier messages" : "Show earlier messages"}
          </button>
          {open && (
            <pre className="mt-3 whitespace-pre-wrap break-words border-l-2 border-line pl-3 font-sans text-sm leading-relaxed text-muted">
              {quoted}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One message, in the pane beside the list.
 *
 * Not a route: a mail body is a read, not a screen, and a URL for it would have to
 * carry an IMAP uid that changes when the mailbox is reorganised.
 *
 * Html when the sender sent html, text otherwise — and the two are separate fields on
 * the wire now (`body`, `body_html`) precisely so this can be a decision rather than
 * a guess. A reply chain is html in every modern client, and rendering it as
 * preformatted text is what showed a thread as a wall of tags or as three lines.
 */
function ReadingPane({ message, onClose }: {
  message: InboxMessage | SentMessage;
  onClose: () => void;
}) {
  const isInbox = "uid" in message;
  const [showImages, setShowImages] = useState(false);

  const subject = isInbox ? message.subject : (message.subject || "(no subject)");
  const when = isInbox ? message.date : (message.sent_at ?? message.created_at);
  const html = isInbox ? (message.body_html || "") : "";
  const text = isInbox
    ? (message.body || "")
    : (message.body
      || (message.kind === "PASSWORD_RESET"
        ? "The body of a password-reset message is deliberately not stored — it "
          + "contains a live reset link, and this log is readable by anyone who "
          + "can open this screen."
        : "(no body)"));

  return (
    <>
      <header className="shrink-0 border-b border-line/70 px-5 py-4">
        <div className="flex items-start gap-3">
          {/* Back on a phone, where the pane replaced the list; Close on a desk,
              where both are on screen and this only clears the selection. */}
          <Button
            size="sm"
            variant="light"
            radius="md"
            onPress={onClose}
            className="-ml-2 shrink-0 md:hidden"
            startContent={<ArrowLeft className="h-4 w-4" />}
          >
            Back
          </Button>
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold leading-snug text-ink">
            {subject}
          </h2>
          <Button
            size="sm" variant="light" radius="md" onPress={onClose}
            className="hidden shrink-0 md:inline-flex"
          >
            Close
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {isInbox ? (
            <>
              <span className="font-semibold text-ink">{senderName(message.from_addr)}</span>
              <span className="truncate">{message.from_addr}</span>
              <span className="truncate">to {message.to_addr}</span>
            </>
          ) : (
            <>
              <span className="truncate">To <span className="text-ink">{message.to_addrs}</span></span>
              {message.cc_addrs && <span className="truncate">cc {message.cc_addrs}</span>}
              <span>{message.sent_by_name ?? "System"}</span>
              <StatusChip status={message.status} />
            </>
          )}
          <span className="ml-auto whitespace-nowrap">{fmtDateTime(when ?? undefined)}</span>
        </div>

        {html && !showImages && (
          /* Said out loud rather than silently swallowed: a message whose pictures
             are missing with no explanation reads as a broken screen. */
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-content2 px-3 py-1.5 text-[11px] text-muted">
            <ImageOff className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Pictures are blocked — loading them tells the sender this mailbox was read.
            </span>
            <button
              type="button"
              onClick={() => setShowImages(true)}
              className="shrink-0 font-semibold text-brand hover:underline"
            >
              Show pictures
            </button>
          </div>
        )}
      </header>

      {!isInbox && message.status === "FAILED" && message.error && (
        <div className="mx-5 mt-4 rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">
          {/* The mail server's own words, kept: "relay access denied" and
              "authentication failed" need different fixes. */}
          {message.error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {html
          ? <HtmlBody html={html} showImages={showImages} />
          : <TextBody text={text || "(no readable text in this message)"} />}
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------- */
/*  Addresses, as chips                                                         */
/* --------------------------------------------------------------------------- */

/** Deliberately loose. The SERVER validates with `EmailStr` and is the only thing
 *  that decides whether an address is acceptable; this only decides whether a chip
 *  turns red before the round trip, and a rule stricter than the server's would mark
 *  a legal address as wrong. */
const LOOKS_LIKE_EMAIL = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]+$/;

/**
 * One address per chip.
 *
 * WHY, and it is not decoration: the field was one text box holding
 * `a@x.in, b@x.in`, and the separator was invisible in a box that shows about
 * thirty characters. Pasting two addresses joined by a SPACE instead of a comma
 * produced one string that the server then rejected as a single malformed address —
 * "The part after the @-sign contains invalid characters: '@', SPACE" — after the
 * whole message had been typed. A chip commits the moment it is complete, so the
 * mistake is visible while it is being made rather than at Send.
 *
 * Enter, Tab, comma, semicolon and space all commit; so does leaving the field, so a
 * typed address is never silently dropped by pressing Send. Backspace on an empty
 * box takes the last chip back for editing rather than deleting it outright.
 */
function AddressField({ id, label, value, onChange, placeholder, required }: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    // Pasting a whole To: line is the common case, so the same separators are honoured
    // on paste as on keypress.
    const parts = raw.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    onChange(next);
    setDraft("");
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-body">
        {label}{required && <span className="text-bad"> *</span>}
      </label>
      {/* The wrapper is the box; the input inside it has no border of its own, so
          chips and the caret sit on one surface rather than in two nested fields. */}
      <div
        onClick={() => document.getElementById(id)?.focus()}
        className="flex min-h-12 w-full flex-wrap items-center gap-1.5 rounded-lg border border-line bg-content1 px-2 py-1.5 focus-within:border-brand"
      >
        {value.map((address) => {
          const bad = !LOOKS_LIKE_EMAIL.test(address);
          return (
            <span
              key={address}
              className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-[13px] ${
                bad ? "bg-bad-bg text-bad" : "bg-brand/10 text-ink"
              }`}
            >
              {bad && <AlertTriangle className="h-3 w-3 shrink-0" />}
              <span className="truncate">{address}</span>
              <button
                type="button"
                aria-label={`Remove ${address}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((a) => a !== address));
                }}
                className="shrink-0 rounded text-muted transition-colors hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          value={draft}
          onChange={(e) => {
            // A separator typed mid-string commits everything before it, so typing
            // straight through a list works exactly as it does in a mail client.
            if (/[,;\s]/.test(e.target.value)) commit(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab") {
              if (draft.trim()) { e.preventDefault(); commit(draft); }
            } else if (e.key === "Backspace" && !draft && value.length) {
              // Back into the box, not gone: a mistyped address is nearly always
              // meant to be corrected rather than retyped.
              setDraft(value[value.length - 1]);
              onChange(value.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\s]/.test(pasted)) { e.preventDefault(); commit(draft + pasted); }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          placeholder={value.length ? "" : placeholder}
          className="min-w-[12rem] flex-1 bg-transparent px-1 py-1 text-sm text-ink placeholder:text-muted focus:outline-none"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

/**
 * Compose.
 *
 * `to` and `cc` are ARRAYS here, not comma-separated strings, all the way from the
 * chip field to the request — which is the shape the API always took. The old text
 * boxes rebuilt that list at submit time by splitting on commas, so two addresses
 * separated by a space (a paste, or a habit) went out as one malformed string and
 * came back as a server-side validation error after the whole message was typed.
 */
function ComposeTab({ from, onSent }: { from: string; onSent: () => void }) {
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ok, setOk] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: mailApi.send,
    onSuccess: (row) => {
      setOk(`Sent to ${row.to_addrs}`);
      setTo([]); setCc([]); setSubject(""); setBody("");
      onSent();
    },
  });

  // Every chip has to look like an address before Send is offered. The SERVER still
  // decides — this only stops a round trip that was always going to be refused.
  const malformed = [...to, ...cc].filter((a) => !LOOKS_LIKE_EMAIL.test(a));
  const ready = to.length > 0 && !malformed.length && subject.trim() && body.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    setOk(null);
    send.mutate({ to, cc, subject: subject.trim(), body });
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="rounded-lg border border-line/70 bg-content2 px-3 py-2 text-xs text-muted">
          From <span className="font-semibold text-ink">{from || "the configured mailbox"}</span>
          {" — every recipient sees the company address, not yours."}
        </div>

        <AddressField
          id="mail-to"
          label="To"
          value={to}
          onChange={setTo}
          placeholder="someone@company.com"
          required
        />
        <AddressField
          id="mail-cc"
          label="Cc"
          value={cc}
          onChange={setCc}
          placeholder="Optional"
        />
        <p className="-mt-2 text-xs text-muted">
          Press Enter, comma or space after each address. {to.length + cc.length > 1
            && `${to.length + cc.length} recipients so far.`}
        </p>
        {Boolean(malformed.length) && (
          <div className="rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">
            {malformed.join(", ")} {malformed.length === 1 ? "does" : "do"} not look
            like an email address. Remove or correct it before sending.
          </div>
        )}
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
