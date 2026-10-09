"""What THIS app connects OUT to, and whether those connections are alive.

The console next door answers "who calls us" — registered client applications, their
keys and their endpoints. This file answers the opposite question, which nothing did:
**what do WE call, with which credentials, and is it working right now?**

Three outbound links, each configured only from `backend/.env` (rule 13):

  * HCM      — the employee/position mirror. `sys_hcm_sync_log` already records every
               entity of every sync, and until now those rows surfaced ONLY on the HCM
               sync screen while a run was in progress. A failed sync from Tuesday was
               readable nowhere.
  * MAIL     — SMTP out and IMAP in. `sys_mail_messages` is the send log.
  * DATABASE — the schema everything else lives in.

SECRETS ARE MASKED, always, and there is no route that unmasks one. `_mask` keeps the
first four and last four characters of anything long enough for that to be meaningless
on its own, and returns a fixed dot-string for anything shorter. That is deliberate:
an admin needs to know a key is SET, WHICH key it is (so they can tell the 8001 key
from the 8009 one) and whether it WORKS — none of which requires the value. Sending
the real one would put the database password into browser cache, screenshots, the
frontend error log and any proxy in between, for a screen whose whole job is to be
looked at. `test_link` is how "does it work" gets answered instead.

Rule 5: `integrations` sits outside the module chain and reads everything, so reading
platform's own tables here is allowed and nothing reads back.

No approval anywhere. Reading configuration is not a document, has no ladder, and
enters no workflow; every route is gated by `integration.view` alone, which is
fail-closed to Admin until a job profile grants it.
"""
import asyncio
import logging
import smtplib
import time
from urllib.parse import urlparse

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import NotFoundError
from app.core.pagination import PageParams, paginate
from app.platform.settings.models import HcmSyncLog, MailMessage

logger = logging.getLogger(__name__)

HCM = "hcm"
MAIL = "mail"
DATABASE = "database"
LINK_CODES = (HCM, MAIL, DATABASE)

#: How a link's own log rows are read. `None` where the link keeps no log of its own —
#: the database has no application-level call log and inventing one here would mean
#: writing a row per query.
_LOG_SOURCES = {HCM: "sys_hcm_sync_log", MAIL: "sys_mail_messages", DATABASE: None}


def _mask(value: str | None, *, keep: int = 4) -> str | None:
    """A secret, shown as much as diagnosis needs and no more.

    Long enough, and the first and last few characters survive so two keys can be told
    apart at a glance — which is the actual question when a deployment is pointed at
    the wrong host. Anything shorter is replaced entirely: revealing half of an eight
    character password is revealing a password.
    """
    if not value:
        return None
    if len(value) <= keep * 3:
        return "•" * 8
    return f"{value[:keep]}{'•' * 6}{value[-keep:]}"


def _field(label: str, value, *, secret: bool = False, hint: str | None = None) -> dict:
    """One configuration line. `is_set` is carried separately from the value so the
    screen can say "not configured" without the reader having to infer it from a blank
    — a masked empty string and an unset key look identical otherwise."""
    if secret:
        return {"label": label, "value": _mask(value if value else None),
                "is_secret": True, "is_set": bool(value), "hint": hint}
    shown = "" if value is None else str(value)
    return {"label": label, "value": shown, "is_secret": False,
            "is_set": bool(shown), "hint": hint}


def _db_parts() -> dict:
    """The DSN, taken apart. Never the whole string: it carries the password."""
    parsed = urlparse(settings.DATABASE_URL)
    return {
        "driver": (parsed.scheme or "").split("+")[0] or "mysql",
        "host": parsed.hostname or "",
        "port": parsed.port,
        "schema": (parsed.path or "").lstrip("/"),
        "user": parsed.username or "",
        "password": parsed.password or "",
    }


# --------------------------------------------------------------------------- #
#  What each link is configured as
# --------------------------------------------------------------------------- #
def _hcm_link() -> dict:
    return {
        "code": HCM,
        "name": "HCM",
        "kind": "Employee & position mirror",
        "direction": "OUTBOUND",
        "icon": "refresh-cw",
        "endpoint": settings.HCM_BASE_URL,
        "configured": bool(settings.HCM_BASE_URL and settings.HCM_API_KEY),
        "summary": (
            "Employees, positions, departments, offices and sections are pulled from "
            "here. `hcm_*` tables are read-only to the rest of the app — only the sync "
            "writes them."),
        "fields": [
            _field("Base URL", settings.HCM_BASE_URL),
            _field("API key", settings.HCM_API_KEY, secret=True,
                   hint="Sent as the X-API-Key header on every request"),
            _field("Timeout", f"{settings.HCM_TIMEOUT_SECONDS:g}s"),
            _field("Retries", settings.HCM_RETRIES),
        ],
        "log_label": "Sync history",
        "has_log": True,
    }


def _mail_link() -> dict:
    imap_user = settings.MAIL_IMAP_USERNAME or settings.MAIL_USERNAME
    imap_pass = settings.MAIL_IMAP_PASSWORD or settings.MAIL_PASSWORD
    return {
        "code": MAIL,
        "name": "Mail",
        "kind": "SMTP out, IMAP in",
        "direction": "BOTH",
        "icon": "send",
        "endpoint": (f"{settings.MAIL_SMTP_HOST}:{settings.MAIL_SMTP_PORT}"
                     if settings.MAIL_SMTP_HOST else None),
        "configured": settings.mail_configured,
        "summary": (
            "Every password-reset link and everything sent from Settings > Mail goes "
            "out through this account. The Inbox reads IMAP live and is never copied "
            "into our database."),
        "fields": [
            _field("SMTP host", settings.MAIL_SMTP_HOST),
            _field("SMTP port", settings.MAIL_SMTP_PORT),
            _field("Username", settings.MAIL_USERNAME),
            _field("Password", settings.MAIL_PASSWORD, secret=True),
            _field("From", settings.MAIL_FROM),
            _field("From name", settings.MAIL_FROM_NAME),
            _field("STARTTLS", "on" if settings.MAIL_STARTTLS else "off"),
            _field("SSL", "on" if settings.MAIL_SMTP_SSL else "off"),
            _field("IMAP host", settings.MAIL_IMAP_HOST,
                   hint="Blank disables the Inbox tab; sending still works"),
            _field("IMAP port", settings.MAIL_IMAP_PORT),
            _field("IMAP username", imap_user),
            _field("IMAP password", imap_pass, secret=True),
        ],
        "log_label": "Sent mail",
        "has_log": True,
    }


def _database_link() -> dict:
    parts = _db_parts()
    return {
        "code": DATABASE,
        "name": "Database",
        "kind": "MySQL",
        "direction": "OUTBOUND",
        "icon": "database",
        "endpoint": f"{parts['host']}:{parts['port'] or 3306}/{parts['schema']}",
        "configured": bool(parts["host"] and parts["schema"]),
        "summary": (
            "Everything the app owns lives here. Shown broken into parts on purpose — "
            "the DSN itself carries the password and is never sent to a browser."),
        "fields": [
            _field("Driver", parts["driver"]),
            _field("Host", parts["host"]),
            _field("Port", parts["port"] or 3306),
            _field("Schema", parts["schema"]),
            _field("User", parts["user"]),
            _field("Password", parts["password"], secret=True),
        ],
        "log_label": None,
        "has_log": False,
    }


_BUILDERS = {HCM: _hcm_link, MAIL: _mail_link, DATABASE: _database_link}


def _link(code: str) -> dict:
    builder = _BUILDERS.get(code)
    if builder is None:
        raise NotFoundError(f"{code!r} is not one of this app's integrations")
    return builder()


# --------------------------------------------------------------------------- #
#  Read
# --------------------------------------------------------------------------- #
async def list_links(db: AsyncSession) -> list[dict]:
    """Every outbound link with its last-known activity, but WITHOUT touching the
    network: opening a settings screen must not hang on a dead SMTP server. Pressing
    Test is what makes a live call."""
    out = []
    for code in LINK_CODES:
        link = _link(code)
        link["last_activity"] = await _last_activity(db, code)
        out.append(link)
    return out


async def get_link(db: AsyncSession, code: str) -> dict:
    link = _link(code)
    link["last_activity"] = await _last_activity(db, code)
    return link


async def _last_activity(db: AsyncSession, code: str) -> dict | None:
    """The most recent thing this link did, off the log it already keeps.

    Nothing is written for this panel's benefit — a status that could disagree with
    the log under it would be worse than no status at all.
    """
    if code == HCM:
        row = (await db.execute(
            select(HcmSyncLog).order_by(HcmSyncLog.id.desc()).limit(1)
        )).scalars().first()
        if row is None:
            return None
        return {
            "at": row.finished_at or row.started_at,
            "status": row.status,
            "detail": (row.error_message
                       or f"{row.entity}: {row.records_upserted or 0} of "
                          f"{row.records_fetched or 0} rows"),
        }
    if code == MAIL:
        row = (await db.execute(
            select(MailMessage).order_by(MailMessage.id.desc()).limit(1)
        )).scalars().first()
        if row is None:
            return None
        return {
            "at": row.sent_at or row.created_at,
            "status": row.status,
            "detail": row.error or f"{row.subject or '(no subject)'} → {row.to_addrs}",
        }
    return None


async def link_logs(db: AsyncSession, code: str, params: PageParams,
                    status: str | None = None) -> dict:
    """One link's own log, normalised to a single row shape so the screen renders both
    with the same table. Read-only over tables the platform already writes."""
    _link(code)  # 404s on an unknown code before touching the database
    if code == HCM:
        stmt = select(HcmSyncLog).order_by(HcmSyncLog.id.desc())
        if status:
            stmt = stmt.where(HcmSyncLog.status == status.strip().upper())
        page = await paginate(db, stmt, params)
        page["items"] = [{
            "id": r.id,
            "at": r.finished_at or r.started_at,
            "status": r.status,
            "subject": r.entity,
            "detail": (f"{r.records_upserted or 0} upserted of "
                       f"{r.records_fetched or 0} fetched"),
            "error": r.error_message,
            "actor": r.source,
        } for r in page["items"]]
        return page

    if code == MAIL:
        stmt = select(MailMessage).order_by(MailMessage.id.desc())
        if status:
            stmt = stmt.where(MailMessage.status == status.strip().upper())
        page = await paginate(db, stmt, params)
        page["items"] = [{
            "id": r.id,
            "at": r.sent_at or r.created_at,
            "status": r.status,
            "subject": r.subject or "(no subject)",
            # The recipients and what raised it. NOT the body: password-reset mail is
            # logged with no body precisely because it carries a live reset link.
            "detail": f"{r.to_addrs} · {r.kind}",
            "error": r.error,
            "actor": r.sent_by_name,
        } for r in page["items"]]
        return page

    return {"items": [], "total": 0, "page": params.page, "size": params.size}


async def link_stats(db: AsyncSession, code: str) -> dict:
    """Counts by status over the whole log, for the strip above the table."""
    if code == HCM:
        rows = (await db.execute(
            select(HcmSyncLog.status, func.count(HcmSyncLog.id))
            .group_by(HcmSyncLog.status))).all()
    elif code == MAIL:
        rows = (await db.execute(
            select(MailMessage.status, func.count(MailMessage.id))
            .group_by(MailMessage.status))).all()
    else:
        return {"by_status": {}, "total": 0}
    by_status = {str(status): int(count) for status, count in rows}
    return {"by_status": by_status, "total": sum(by_status.values())}


# --------------------------------------------------------------------------- #
#  Does it actually work?
# --------------------------------------------------------------------------- #
# One live call per link, on demand. This is what replaces showing the secret: an
# admin does not need to read the key to find out the key is wrong.

async def test_link(db: AsyncSession, code: str) -> dict:
    link = _link(code)
    if not link["configured"]:
        return {"code": code, "ok": False, "ms": 0,
                "detail": f"{link['name']} is not configured in backend/.env"}
    started = time.monotonic()
    try:
        detail = await _PROBES[code](db)
        ok = True
    except Exception as exc:  # noqa: BLE001 — a failed probe is the ANSWER here
        detail = f"{type(exc).__name__}: {exc}"[:400]
        ok = False
        logger.warning("Integration probe failed for %s: %s", code, exc)
    return {"code": code, "ok": ok,
            "ms": int((time.monotonic() - started) * 1000), "detail": detail}


async def _probe_hcm(db: AsyncSession) -> str:
    """One real request, bypassing `HcmClient` on purpose.

    The client carries a process-wide circuit breaker whose failure count never decays,
    so after a bad sync it answers "circuit is open" without calling anybody — which is
    the one answer a Test button must never give. This asks HCM itself.
    """
    url = f"{settings.HCM_BASE_URL.rstrip('/')}/offices/"
    headers = {"X-API-Key": settings.HCM_API_KEY} if settings.HCM_API_KEY else {}
    async with httpx.AsyncClient(timeout=settings.HCM_TIMEOUT_SECONDS) as http:
        resp = await http.get(url, params={"limit": 1}, headers=headers)
    if resp.status_code == 401 or resp.status_code == 403:
        raise RuntimeError(
            f"HTTP {resp.status_code} — the host answered but rejected the API key")
    resp.raise_for_status()
    body = resp.json()
    count = body.get("count") if isinstance(body, dict) else len(body or [])
    return f"HTTP {resp.status_code} · {count} offices visible"


async def _probe_mail(db: AsyncSession) -> str:
    """Connect and authenticate, then hang up. Nothing is sent — a Test button that
    delivered a real email to a real person would be its own bug report."""
    def _connect() -> str:
        host, port = settings.MAIL_SMTP_HOST, settings.MAIL_SMTP_PORT
        timeout = settings.MAIL_TIMEOUT_SECONDS
        if settings.MAIL_SMTP_SSL:
            server = smtplib.SMTP_SSL(host, port, timeout=timeout)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
            if settings.MAIL_STARTTLS:
                server.starttls()
        try:
            server.login(settings.MAIL_USERNAME, settings.MAIL_PASSWORD)
            return f"Signed in to {host}:{port} as {settings.MAIL_USERNAME}"
        finally:
            try:
                server.quit()
            except Exception:  # noqa: BLE001 — the probe already has its answer
                pass

    # smtplib is blocking; off the event loop so a dead host cannot stall every other
    # request on this worker.
    return await asyncio.to_thread(_connect)


async def _probe_database(db: AsyncSession) -> str:
    parts = _db_parts()
    version = (await db.execute(text("SELECT VERSION()"))).scalar()
    tables = (await db.execute(text(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = :s"
    ), {"s": parts["schema"]})).scalar()
    return f"MySQL {version} · {tables} tables in {parts['schema']}"


_PROBES = {HCM: _probe_hcm, MAIL: _probe_mail, DATABASE: _probe_database}


# --------------------------------------------------------------------------- #
#  Reveal — the real values, on demand, on a higher permission, and audited
# --------------------------------------------------------------------------- #
# The panel stays masked by default and no LIST route ever carries a live secret: a
# screen that sits open all day must not put the database password into every page
# load, the browser cache, a screenshot or the frontend error log.
#
# This is the deliberate exception, shaped so it cannot become the default. It is a
# separate POST — never part of a read — gated on `integration.keys.manage` rather than
# the `integration.view` the rest of the panel uses, because reading a credential is
# the same class of act as issuing one. Every call writes an audit row naming the
# person and the link, so "who read the SMTP password" is a question the log answers.

def _secrets(code: str) -> dict[str, str | None]:
    """The real values behind one link's masked rows, under the same field labels."""
    if code == HCM:
        return {"API key": settings.HCM_API_KEY}
    if code == MAIL:
        return {
            "Password": settings.MAIL_PASSWORD,
            "IMAP password": settings.MAIL_IMAP_PASSWORD or settings.MAIL_PASSWORD,
        }
    if code == DATABASE:
        return {"Password": _db_parts()["password"]}
    return {}


async def reveal_secrets(db: AsyncSession, code: str, user) -> dict:
    """Hand back one link's real credentials, and record that it happened."""
    from app.platform.settings.service import write_audit
    from app.shared.enums import AuditAction

    link = _link(code)
    values = {label: value for label, value in _secrets(code).items() if value}

    await write_audit(
        db, entity="integration_link", entity_id=0, entity_no=code,
        action=AuditAction.ACCESS_GRANTED, actor=user,
        after={"link": link["name"], "revealed": sorted(values)},
        summary=f"Revealed {link['name']} credentials")
    await db.commit()
    logger.warning("%s revealed the %s credentials",
                   getattr(user, "full_name", None) or getattr(user, "id", "?"),
                   link["name"])
    return {"code": code,
            "fields": [{"label": label, "value": value}
                       for label, value in values.items()]}
