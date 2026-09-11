"""The mail transport itself: SMTP out, IMAP in. No business rules, no database.

WHY IT IS ITS OWN FILE: `smtplib` and `imaplib` are BLOCKING. Called straight from an
async route they stop the whole event loop for as long as the mail server takes to
answer — which for a remote host on a bad link is seconds, during which every other
request in the process waits. Everything here runs through `asyncio.to_thread`, and
the rest of the app only ever sees the coroutines at the bottom.

Nothing here reads the database and nothing here decides who may send. That is
`service.py`'s job, and keeping the split means the transport can be exercised on its
own — which is how the host, port and credentials were confirmed before a line of the
screen existed.

Credentials come from `core.config`, which reads `.env` (rule 13). There is no
fallback: an unconfigured mailbox raises `MailNotConfigured`, and every caller turns
that into an explanation rather than a 500.
"""
from __future__ import annotations

import asyncio
import email
import imaplib
import logging
import re
import smtplib
from dataclasses import dataclass
from datetime import datetime, timezone
from email.header import decode_header, make_header
from html import unescape
from email.message import EmailMessage
from email.utils import formataddr, parsedate_to_datetime

from app.core.config import settings
from app.core.exceptions import AppException
from app.platform.mail import template

log = logging.getLogger(__name__)

#: How many messages the Inbox pulls in one go. IMAP fetches are round trips, and a
#: mailbox screen nobody scrolls past the first page of does not need more.
INBOX_FETCH_LIMIT = 50

# A generated document that travels with a system email.  Kept at the transport
# boundary so business modules need not know anything about MIME construction.
MailAttachment = tuple[str, bytes, str]


class MailNotConfigured(AppException):
    """No mailbox is set up on this deployment. A configuration state, not a fault —
    every screen renders it as a notice."""
    status_code = 503


class MailSendError(AppException):
    """The mail server refused or the connection failed. Carries the server's own
    words: "relay denied" and "bad credentials" need different fixes."""
    status_code = 502


@dataclass(frozen=True)
class InboxMessage:
    """One message as the Inbox lists it. Deliberately flat and read-only — nothing
    in this app owns a mailbox, it only shows one.

    BOTH halves of the message are carried, not the better one. `_body_of` used to
    return a single string, preferring `text/plain` and falling back to html — so a
    real reply chain (which is html in every modern client, with the plain part either
    absent or a one-line stub) arrived either as raw markup or as almost nothing, and
    a screen showing it as preformatted text could not tell which it had. The reader
    picks: html when the sender sent html, text otherwise.
    """
    uid: str
    from_addr: str
    to_addr: str
    subject: str
    date: datetime | None
    preview: str
    body: str
    #: The `text/html` alternative, empty when the sender sent none. NEVER trusted:
    #: this is markup from an outside mailbox, and the screen renders it inside a
    #: sandboxed frame on a null origin — see `MailBody` in `MailPage.tsx`.
    body_html: str
    seen: bool


def _decode(raw: str | None) -> str:
    """MIME-encoded header (`=?utf-8?B?...?=`) to plain text.

    Never raises: a header that cannot be decoded is still worth showing as-is, and a
    malformed subject line must not take out the whole Inbox.
    """
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:  # noqa: BLE001 - a bad header is cosmetic, never fatal
        return raw


def _body_of(msg: email.message.Message) -> tuple[str, str]:
    """Both readable halves of a message: `(text, html)`, either possibly empty.

    Returns the PAIR rather than the better of the two. A reply chain — the thing a
    person actually opens this screen for — is html in every modern client, and its
    plain-text alternative is routinely absent or a stub; collapsing the two here is
    what made a long thread arrive as either raw markup or three lines. The caller
    decides how to show each, and can only do that if it has both.

    The LAST html part wins, not the first. Some clients send the quoted history as a
    separate later part, and a mail forwarded through a list can carry the original as
    a nested `message/rfc822` whose own parts walk past — taking the first match
    truncated the thread to its newest message. Plain text keeps the FIRST, which is
    the reply itself, because concatenating plain parts is how the signature and the
    quote end up interleaved twice.

    Attachments are skipped (`Content-Disposition: attachment`) — the Inbox lists mail,
    it does not download files, and an inline base64 blob rendered as text is worse
    than nothing.
    """
    if not msg.is_multipart():
        payload = _payload(msg)
        if msg.get_content_type() == "text/html":
            return "", payload
        return payload, ""
    plain, html = "", ""
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        if "attachment" in str(part.get("Content-Disposition", "")).lower():
            continue
        if part.get_content_type() == "text/plain" and not plain:
            plain = _payload(part)
        elif part.get_content_type() == "text/html":
            candidate = _payload(part)
            # Longest wins among the html parts: a client that sends both a stub and
            # the full thread sends them in no reliable order.
            if len(candidate) > len(html):
                html = candidate
    return plain, html


def _strip_tags(html: str) -> str:
    """Enough of an html-to-text pass to build a ONE-LINE PREVIEW, and nothing more.

    Never used for the body: the body keeps its markup and is rendered in a sandboxed
    frame. A regex is the wrong tool for trusting html and the right one for throwing
    it away, which is all this does.
    """
    if not html:
        return ""
    text = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</>", " ", html)
    text = re.sub(r"(?i)<[^>]+>", " ", text)
    return unescape(text)


def _payload(part: email.message.Message) -> str:
    try:
        raw = part.get_payload(decode=True)
        if raw is None:
            return ""
        charset = part.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")
    except Exception:  # noqa: BLE001 - one unreadable part must not empty the list
        return ""


# --------------------------------------------------------------------------- #
#  SMTP
# --------------------------------------------------------------------------- #

def _attach_logos(message: EmailMessage, html: str) -> None:
    """Attach each brand logo the html actually references, as an inline `cid:` part.

    Only the referenced ones: a message that shows no logo must not carry 40 KB of
    PNG, and an unreferenced inline part is what makes some clients draw a paperclip
    on a mail with no attachments.

    A missing file is skipped, never raised. The logos are decoration; a deployment
    that lost them from the image still has to be able to send a password reset, and
    the `alt` text on each `<img>` is the wordmark spelled out.
    """
    for cid, path in template.LOGO_CIDS.items():
        if f"cid:{cid}" not in html:
            continue
        try:
            data = path.read_bytes()
        except OSError as exc:  # noqa: PERF203 - one missing logo, not a failed send
            log.warning("mail logo %s could not be read: %s", path, exc)
            continue
        # `<cid>` angle brackets are the Content-ID form; the `src="cid:name"` in the
        # html is the same name WITHOUT them, which `add_related` handles.
        message.get_payload()[1].add_related(
            data, maintype="image", subtype="png", cid=f"<{cid}>",
            filename=path.name, disposition="inline",
        )


def _send_sync(to_addrs: list[str], subject: str, body: str,
               cc_addrs: list[str] | None = None,
               reply_to: str | None = None,
               html: str | None = None,
               attachments: list[MailAttachment] | None = None) -> None:
    """One connection, one message. Blocking — always called via `asyncio.to_thread`.

    With `html`, the message is `multipart/alternative`: `body` is the `text/plain`
    half and `html` the rich one, and the client picks. Both halves are always
    present — a mail with no plain part is scored as spam by several filters, and some
    readers are configured to show plain text only.
    """
    if not settings.mail_configured:
        raise MailNotConfigured("No mailbox is configured on this server.")

    message = EmailMessage()
    message["From"] = formataddr((settings.MAIL_FROM_NAME, settings.mail_from_address))
    message["To"] = ", ".join(to_addrs)
    if cc_addrs:
        message["Cc"] = ", ".join(cc_addrs)
    if reply_to:
        message["Reply-To"] = reply_to
    message["Subject"] = subject
    message.set_content(body)
    if html:
        message.add_alternative(html, subtype="html")
        _attach_logos(message, html)
    for filename, content, mime_type in attachments or []:
        maintype, _, subtype = mime_type.partition("/")
        message.add_attachment(content, maintype=maintype or "application",
                               subtype=subtype or "octet-stream", filename=filename)

    host, port = settings.MAIL_SMTP_HOST, settings.MAIL_SMTP_PORT
    timeout = settings.MAIL_TIMEOUT_SECONDS
    try:
        if settings.MAIL_SMTP_SSL:
            server = smtplib.SMTP_SSL(host, port, timeout=timeout)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
        with server:
            server.ehlo()
            if settings.MAIL_STARTTLS and not settings.MAIL_SMTP_SSL:
                server.starttls()
                server.ehlo()
            server.login(settings.MAIL_USERNAME, settings.MAIL_PASSWORD)
            server.send_message(message, to_addrs=to_addrs + list(cc_addrs or []))
    except MailNotConfigured:
        raise
    except Exception as exc:  # noqa: BLE001 - smtplib raises a dozen unrelated types
        # The server's own words, kept: "relay access denied" and "authentication
        # failed" are different problems for whoever has to fix the mailbox.
        raise MailSendError(f"{type(exc).__name__}: {exc}") from exc


async def send(to_addrs: list[str], subject: str, body: str,
               cc_addrs: list[str] | None = None,
               reply_to: str | None = None,
               html: str | None = None,
               attachments: list[MailAttachment] | None = None) -> None:
    """Send one message. Raises `MailNotConfigured` or `MailSendError`.

    `body` is the plain-text half and is never optional; `html` is the rich half, and
    when given the brand logos it references ride along inline (see `_attach_logos`).
    """
    await asyncio.to_thread(
        _send_sync, to_addrs, subject, body, cc_addrs, reply_to, html, attachments)


# --------------------------------------------------------------------------- #
#  IMAP
# --------------------------------------------------------------------------- #

def _fetch_sync(mailbox: str, limit: int, search: str | None) -> list[InboxMessage]:
    """The newest `limit` messages in `mailbox`. Blocking."""
    if not settings.imap_configured:
        raise MailNotConfigured("This mailbox is send-only — no IMAP host is configured.")

    host, port = settings.MAIL_IMAP_HOST, settings.MAIL_IMAP_PORT
    try:
        conn = (imaplib.IMAP4_SSL(host, port) if settings.MAIL_IMAP_SSL
                else imaplib.IMAP4(host, port))
    except Exception as exc:  # noqa: BLE001
        raise MailSendError(f"Could not reach the mail server: {exc}") from exc

    try:
        conn.login(settings.imap_username, settings.imap_password)
        # Read-only: this screen must never mark a message seen or move one just
        # because somebody looked at the list.
        status, _ = conn.select(f'"{mailbox}"', readonly=True)
        if status != "OK":
            raise MailSendError(f'Mailbox "{mailbox}" could not be opened.')

        if search:
            # Quoted and passed as a separate argument, never interpolated into the
            # command string — a search term with a quote in it would otherwise change
            # the IMAP command being run.
            typ, data = conn.uid("SEARCH", None, "TEXT", f'"{search}"')
        else:
            typ, data = conn.uid("SEARCH", None, "ALL")
        if typ != "OK":
            return []

        uids = (data[0] or b"").split()
        # Newest first, and only as many as the screen shows: a mailbox with 10,000
        # messages would otherwise be 10,000 round trips.
        uids = uids[-limit:][::-1]

        out: list[InboxMessage] = []
        for uid in uids:
            typ, payload = conn.uid("FETCH", uid, "(FLAGS RFC822)")
            if typ != "OK" or not payload or not isinstance(payload[0], tuple):
                continue
            flags = str(payload[0][0])
            msg = email.message_from_bytes(payload[0][1])
            body, body_html = _body_of(msg)
            when = None
            try:
                when = parsedate_to_datetime(msg.get("Date"))
                if when and when.tzinfo:
                    when = when.astimezone(timezone.utc).replace(tzinfo=None)
            except Exception:  # noqa: BLE001 - an unparseable Date is not an error
                when = None
            out.append(InboxMessage(
                uid=uid.decode(),
                from_addr=_decode(msg.get("From")),
                to_addr=_decode(msg.get("To")),
                subject=_decode(msg.get("Subject")) or "(no subject)",
                date=when,
                # The preview reads off whichever half exists. A message with only
                # an html part had a blank preview line before, which on a list of
                # thirty rows reads as thirty broken messages.
                preview=" ".join((body or _strip_tags(body_html)).split())[:180],
                body=body,
                body_html=body_html,
                seen="\\Seen" in flags,
            ))
        return out
    except MailNotConfigured:
        raise
    except MailSendError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise MailSendError(f"{type(exc).__name__}: {exc}") from exc
    finally:
        try:
            conn.logout()
        except Exception:  # noqa: BLE001 - already closed is not worth reporting
            pass


async def fetch_inbox(mailbox: str = "INBOX", limit: int = INBOX_FETCH_LIMIT,
                      search: str | None = None) -> list[InboxMessage]:
    """The newest messages in a mailbox, read-only."""
    return await asyncio.to_thread(_fetch_sync, mailbox, limit, search)
