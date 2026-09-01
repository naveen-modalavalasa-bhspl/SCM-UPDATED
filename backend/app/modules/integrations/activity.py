"""The Activity Log - everything that happened on an integration, in one list.

READ ONLY. Nothing in this file writes, and nothing anywhere writes for its benefit.
Every row it shows is already recorded somewhere else for its own reasons, so the log
cannot show an event the system does not actually carry - the same rule the Logistics
Activity Ledger follows.

FOUR SOURCES, unioned and sorted by time:

  1. Webhook deliveries - `apis.hookevt.` documents. An accepted inbound push.
  2. Adapter receipts   - any other `apis.*` document shaped like an inbound event
                          (`event_id` + `received_at`). B-CAMS writes these, and so
                          will the next adapter, without this file being told.
  3. Live API calls     - the in-memory ring in `security.py`. An outside application
                          READING SCM. Volatile by construction, so every row it
                          produces is marked `durable=False` and the screen says so.
  4. Refusals           - `sys_app_logs` rows on an `/api/ext/v1` route. These are the
                          401s, 409s and 422s: a bad signature, a stale sequence, an
                          event a webhook is not registered for. They are written by
                          `platform/admin/app_logs.capture_backend_error` through its
                          OWN session, so a refused request that rolls back still
                          leaves this row - which is what makes the failure half of
                          this log the reliable half.

WHY IT NEEDS NO MAINTENANCE. The parties are enumerated from the store every time it
is asked: applications from `apis.client.`, webhooks from `apis.hook.`, adapters from
`adapters.catalogue()`. Register an application or a webhook on the screen and it
appears here on the next refresh - there is no list in this file to add it to, and no
event name is hardcoded anywhere.

THE ONE THING IT CANNOT TELL YOU, said plainly rather than papered over: a REFUSED
inbound push is recorded against the route it hit (`/api/ext/v1/hooks/{source}`), not
against the sender, because `sys_app_logs` stores the route template and no
integration identity. So a refusal names the channel and the exact reason - which is
the part somebody acts on - and names the sender only when the path itself says who.
Fixing that means one line in `platform/admin/app_logs.py`, which is lead-owned
(rule 4), so it is left alone here.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams
from app.modules.integrations import adapters, security, store, webhooks
from app.platform.settings.models import AppLog, Setting
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations.activity")

#: Where an outside system reaches us. Every refusal on a path under this belongs to
#: an integration; everything else in `sys_app_logs` belongs to a person using a screen.
EXTERNAL_PREFIX = "/api/ext/v1"

#: `apis.` documents that are CONFIGURATION, not events. Anything under `apis.` that is
#: not one of these and carries an `event_id` is an inbound event - which is how an
#: adapter's receipts join this log without naming the adapter here.
CONFIG_PREFIXES = (store.CLIENT, store.KEY, store.ENDPOINT, webhooks.HOOK)

#: An adapter keeps its own settings at `apis.<adapter>.config`. Skipped by NAME,
#: before the row is read: an adapter's configuration is not an event, and a stale
#: `apis.cams.config` left behind by the removed inbound HMAC must not surface here.
CONFIG_SUFFIX = ".config"


def _is_config(key: str) -> bool:
    return key.startswith(CONFIG_PREFIXES) or key.endswith(CONFIG_SUFFIX)

#: How far back the log looks by default. A window, not an archive.
DEFAULT_DAYS = 7
MAX_DAYS = 90

#: The most stored events one page load will read, newest first.
#:
#: A delivery document carries its payload inline (up to 40 KB), and this screen asks
#: twice per interaction — once for the list, once for the counts above it. Unbounded,
#: that is the whole delivery store in memory on every keystroke. Higher ids are newer
#: because a delivery key is unique per event and is never rewritten, so ordering by id
#: is ordering by arrival without touching an unindexed column.
#:
#: The cap is above the stores' own ceilings (`webhooks.MAX_DELIVERIES` is 2000), so on
#: any real deployment it is not reached; it is here so that a store which has grown
#: past its prune cannot take the screen down with it.
MAX_DOCUMENTS = 3000

#: Plain words for the three things that can happen to a request. The screen shows
#: these, never a status code on its own - "401" is not an answer to "did it work".
OUTCOME_WORDS = {
    "OK": "Worked",
    "DUPLICATE": "Already had it",
    "FAILED": "Failed",
}

#: What each channel is, in one line, for a reader who does not work in IT.
CHANNEL_WORDS = {
    "WEBHOOK": "Sent in to us",
    "ADAPTER": "Sent in to us",
    "APPLICATION": "Read out of us",
}


# --------------------------------------------------------------------------- #
# Reading the store
# --------------------------------------------------------------------------- #

async def _documents(db: AsyncSession, prefix: str) -> list[tuple[str, dict]]:
    """`(key, payload)` for every `apis.` document under a prefix.

    `store.all_of` drops the key, and the key is what says which kind of document this
    is, so this reads the pair. A row whose JSON is nonsense is skipped with a warning
    rather than raising: one bad row must not empty the whole log.
    """
    rows = (await db.execute(
        select(Setting.setting_key, Setting.setting_value).where(
            Setting.category == store.CATEGORY,
            Setting.setting_key.like(f"{prefix}%"),
        ).order_by(Setting.id.desc()).limit(MAX_DOCUMENTS)
    )).all()
    out: list[tuple[str, dict]] = []
    for key, value in rows:
        if not value or _is_config(key):
            continue
        try:
            payload = json.loads(value)
        except ValueError:
            log.warning("Ignoring %s: its value is not JSON", key)
            continue
        if isinstance(payload, dict):
            out.append((key, payload))
    return out


def _stamp(value: Any) -> datetime | None:
    """Every source stores naive IST (see `shared/time.py`), so they sort together."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


# --------------------------------------------------------------------------- #
# Who the parties are - read fresh every time, never listed in this file
# --------------------------------------------------------------------------- #

async def _parties(db: AsyncSession) -> dict[str, str]:
    """`code -> display name` for every registered application, plus every webhook.

    An application registered a minute ago is in here. That is the whole reason this
    is a query and not a constant.
    """
    names: dict[str, str] = {}
    for doc in await store.all_of(db, store.CLIENT):
        code = str(doc.get("code") or "")
        if code:
            names[code] = str(doc.get("name") or code)
    for doc in await store.all_of(db, webhooks.HOOK):
        source = str(doc.get("source") or "")
        if source:
            names[source] = str(doc.get("name") or source)
    return names


def _client_codes(names: Mapping[str, str]) -> list[str]:
    return list(names.keys())


def _adapter_keys() -> dict[str, str]:
    """`url segment -> human name` for whatever is installed under `adapters/`."""
    return {a.key: a.name for a in adapters.catalogue()}


# --------------------------------------------------------------------------- #
# One row shape, whatever it came from
# --------------------------------------------------------------------------- #

def _row(*, at: datetime | None, direction: str, channel: str, party: str,
         party_code: str | None, event: str, outcome: str, headline: str,
         row_id: str, detail: str | None = None, status_code: int | None = None,
         rows: int | None = None, reference: str | None = None,
         request_id: str | None = None, endpoint: str | None = None,
         http_method: str | None = None, ip_address: str | None = None,
         remote_port: int | None = None, local_ip_address: str | None = None,
         local_port: int | None = None, durable: bool = True) -> dict:
    return {
        "id": row_id,
        "at": at,
        "direction": direction,
        "channel": channel,
        "channel_note": CHANNEL_WORDS.get(channel, ""),
        "party": party,
        "party_code": party_code,
        "event": event,
        "outcome": outcome,
        "outcome_word": OUTCOME_WORDS.get(outcome, outcome),
        "headline": headline,
        "detail": detail,
        "status_code": status_code,
        "rows": rows,
        "reference": reference,
        "request_id": request_id,
        "endpoint": endpoint,
        "http_method": http_method,
        "ip_address": ip_address,
        "remote_port": remote_port,
        "local_ip_address": local_ip_address,
        "local_port": local_port,
        "durable": durable,
    }


# --------------------------------------------------------------------------- #
# Sources 1 and 2 - what arrived and was kept
# --------------------------------------------------------------------------- #

async def _inbound_rows(db: AsyncSession, names: Mapping[str, str],
                        adapter_names: Mapping[str, str]) -> list[dict]:
    """Accepted inbound pushes: webhook deliveries and any adapter's receipts.

    One code path for both. A document under `apis.` that is not configuration and
    carries an `event_id` IS an inbound event, whoever wrote it - so an adapter added
    later is listed here without this function learning its name.
    """
    out: list[dict] = []
    for key, doc in await _documents(db, store.PREFIX):
        event_id = str(doc.get("event_id") or "")
        received = _stamp(doc.get("received_at"))
        if not event_id or received is None:
            continue

        webhook = key.startswith(webhooks.DELIVERY)
        source = str(doc.get("source") or "")
        client_code = str(doc.get("client_code") or "")
        code = source or client_code or None
        # An adapter receipt has no `source`; the party that pushed it is the API
        # client on the key it used, which is exactly who a person would name.
        party = (names.get(code or "") or adapter_names.get(code or "")
                 or code or "An outside system")
        event = str(doc.get("event") or "event")
        count = doc.get("rows")
        posting = doc.get("posting")
        skipped = int(posting.get("skipped") or 0) if isinstance(posting, dict) else 0

        detail = "Received, checked and stored."
        outcome = "OK"
        endpoint = (
            str(doc.get("endpoint") or "")
            or (f"{EXTERNAL_PREFIX}/hooks/{source}" if webhook and source else None)
        )
        if skipped:
            # An accepted push whose lines could not all be posted. The push worked;
            # part of the work behind it did not, and that is worth seeing here.
            outcome = "FAILED"
            detail = (f"Received, but {skipped} "
                      f"{'line' if skipped == 1 else 'lines'} could not be applied.")
        if doc.get("payload_truncated"):
            detail += " The body was too large to keep in full."

        out.append(_row(
            at=received, direction="IN",
            channel="WEBHOOK" if webhook else "ADAPTER",
            party=party, party_code=code, event=event, outcome=outcome,
            headline=f"{party} sent '{event}'",
            detail=detail,
            rows=int(count) if isinstance(count, int) else None,
            reference=event_id, endpoint=endpoint,
            http_method=str(doc.get("http_method") or "") or "POST",
            ip_address=str(doc.get("ip_address") or "") or None,
            remote_port=(
                doc.get("remote_port")
                if isinstance(doc.get("remote_port"), int)
                else None
            ),
            local_ip_address=str(doc.get("local_ip_address") or "") or None,
            local_port=(
                doc.get("local_port")
                if isinstance(doc.get("local_port"), int)
                else None
            ),
            durable=True, row_id=f"in:{key}",
        ))
    return out


# --------------------------------------------------------------------------- #
# Source 3 - what was read out of us
# --------------------------------------------------------------------------- #

def _outbound_rows(names: Mapping[str, str]) -> list[dict]:
    """Every call an application made, from the in-memory ring.

    `durable=False` on all of them: this ring empties on restart and is per worker.
    The screen says that out loud rather than letting a quiet morning read as silence.
    """
    out: list[dict] = []
    for code in _client_codes(names):
        for index, entry in enumerate(security.calls_for(code)):
            at = _stamp(entry.get("at"))
            if at is None:
                continue
            status = int(entry.get("status_code") or 200)
            slug = str(entry.get("slug") or "") or "an API"
            party = names.get(code, code)
            rows = entry.get("row_count")
            failed = status >= 400
            if failed:
                detail = str(entry.get("error") or "The request was refused.")
            elif isinstance(rows, int):
                detail = f"{rows} {'row' if rows == 1 else 'rows'} sent."
            else:
                detail = "Answered."
            out.append(_row(
                at=at, direction="OUT", channel="APPLICATION", party=party,
                party_code=code, event=slug,
                outcome="FAILED" if failed else "OK",
                headline=(f"{party} was refused '{slug}'" if failed
                          else f"{party} read '{slug}'"),
                detail=detail,
                status_code=status,
                rows=rows if isinstance(rows, int) else None,
                reference=str(entry.get("key_prefix") or "") or None,
                endpoint=str(entry.get("endpoint") or "") or f"{EXTERNAL_PREFIX}/{slug}",
                http_method=str(entry.get("http_method") or "") or "GET",
                ip_address=str(entry.get("ip_address") or "") or None,
                remote_port=(
                    entry.get("remote_port")
                    if isinstance(entry.get("remote_port"), int)
                    else None
                ),
                local_ip_address=str(entry.get("local_ip_address") or "") or None,
                local_port=(
                    entry.get("local_port")
                    if isinstance(entry.get("local_port"), int)
                    else None
                ),
                durable=False, row_id=f"out:{code}:{index}:{at.isoformat()}",
            ))
    return out


# --------------------------------------------------------------------------- #
# Source 4 - what we turned away
# --------------------------------------------------------------------------- #

def _classify(endpoint: str, adapter_names: Mapping[str, str]) -> tuple[str, str]:
    """`(channel, party)` for a refusal, from the route it hit.

    The route template is all `sys_app_logs` keeps, so this names the channel exactly
    and the party only when the path itself says who.
    """
    tail = endpoint[len(EXTERNAL_PREFIX):].strip("/") if endpoint else ""
    head = tail.split("/", 1)[0] if tail else ""
    if head == "hooks":
        return "WEBHOOK", "A registered webhook"
    if head in adapter_names:
        return "ADAPTER", adapter_names[head]
    return "APPLICATION", "An application"


async def _refusal_rows(db: AsyncSession, since: datetime,
                        adapter_names: Mapping[str, str]) -> list[dict]:
    """Refusals and failures on an external route, from the durable error log."""
    rows = (await db.execute(
        select(AppLog).where(
            AppLog.source == "BACKEND",
            AppLog.created_at >= since,
            AppLog.endpoint.like(f"{EXTERNAL_PREFIX}%"),
        ).order_by(AppLog.created_at.desc()).limit(1000)
    )).scalars().all()

    out: list[dict] = []
    for entry in rows:
        channel, party = _classify(entry.endpoint or "", adapter_names)
        status = int(entry.status_code or 0)
        context = entry.context_data if isinstance(entry.context_data, dict) else {}
        out.append(_row(
            at=_stamp(entry.created_at),
            direction="OUT" if channel == "APPLICATION" else "IN",
            channel=channel, party=party, party_code=None,
            event=(entry.endpoint or "").rsplit("/", 1)[-1] or "request",
            outcome="FAILED",
            headline=f"{party} was turned away",
            # The message is the actionable half - "Signature does not match",
            # "HCM sequence gap", "API key is revoked" - so it is shown, not a code.
            detail=entry.message or "The request failed.",
            status_code=status or None,
            request_id=entry.request_id,
            endpoint=entry.endpoint,
            http_method=entry.http_method,
            ip_address=entry.ip_address,
            remote_port=(
                context.get("remote_port")
                if isinstance(context.get("remote_port"), int)
                else None
            ),
            local_ip_address=str(context.get("local_ip_address") or "") or None,
            local_port=(
                context.get("local_port")
                if isinstance(context.get("local_port"), int)
                else None
            ),
            durable=True, row_id=f"err:{entry.id}",
        ))
    return out


# --------------------------------------------------------------------------- #
# The feed
# --------------------------------------------------------------------------- #

def _days(days: int | None) -> int:
    return max(1, min(int(days or DEFAULT_DAYS), MAX_DAYS))


def _window(days: int | None) -> datetime:
    return ist_now() - timedelta(days=_days(days))


def _matches(row: Mapping[str, Any], *, direction: str | None, outcome: str | None,
             party: str | None, channel: str | None, search: str | None) -> bool:
    if direction and row["direction"] != direction:
        return False
    if outcome and row["outcome"] != outcome:
        return False
    if channel and row["channel"] != channel:
        return False
    if party and party not in {row.get("party_code"), row.get("party")}:
        return False
    if search:
        hay = " ".join(str(row.get(field) or "") for field in
                       ("party", "event", "headline", "detail", "reference",
                        "request_id")).lower()
        if search.lower().strip() not in hay:
            return False
    return True


async def _collect(db: AsyncSession, since: datetime) -> list[dict]:
    names = await _parties(db)
    adapter_names = _adapter_keys()
    rows = (
        await _inbound_rows(db, names, adapter_names)
        + _outbound_rows(names)
        + await _refusal_rows(db, since, adapter_names)
    )
    rows = [row for row in rows if row["at"] is not None and row["at"] >= since]
    rows.sort(key=lambda row: row["at"], reverse=True)
    return rows


async def feed(db: AsyncSession, params: PageParams, *, direction: str = "",
               outcome: str = "", party: str = "", channel: str = "",
               search: str = "", days: int | None = None) -> dict:
    """One page of the log, newest first."""
    rows = [row for row in await _collect(db, _window(days))
            if _matches(row, direction=direction or None, outcome=outcome or None,
                        party=party or None, channel=channel or None,
                        search=search or None)]
    window = rows[params.offset:params.offset + params.size]
    return {"items": window, "total": len(rows),
            "page": params.page, "size": params.size}


async def summary(db: AsyncSession, *, days: int | None = None) -> dict:
    """The four numbers the screen leads with, plus a line per party.

    Deliberately over the SAME rows the list shows, so a count and the list under it
    can never disagree.
    """
    rows = await _collect(db, _window(days))

    by_party: dict[str, dict] = {}
    for row in rows:
        name = row["party"]
        line = by_party.setdefault(name, {
            "party": name, "party_code": row.get("party_code"),
            "channel": row["channel"], "total": 0, "failed": 0, "last_at": None,
        })
        line["total"] += 1
        if row["outcome"] == "FAILED":
            line["failed"] += 1
        if line["last_at"] is None:
            line["last_at"] = row["at"]

    failed = [row for row in rows if row["outcome"] == "FAILED"]
    return {
        "days": _days(days),
        "total": len(rows),
        "inbound": sum(1 for row in rows if row["direction"] == "IN"),
        "outbound": sum(1 for row in rows if row["direction"] == "OUT"),
        "failed": len(failed),
        "last_at": rows[0]["at"] if rows else None,
        "last_failure_at": failed[0]["at"] if failed else None,
        # Said on the screen, not implied: the read half of this log is a ring buffer.
        "reads_since_restart": True,
        "by_party": sorted(by_party.values(),
                           key=lambda line: (-line["failed"], -line["total"])),
    }


async def filters(db: AsyncSession) -> dict:
    """What the pickers offer - SERVED, so a system registered today is selectable
    today and no filter list lives in the browser."""
    names = await _parties(db)
    adapter_names = _adapter_keys()
    parties = [{"code": code, "name": name} for code, name in
               sorted(names.items(), key=lambda pair: pair[1].lower())]
    parties += [{"code": key, "name": name} for key, name in
                sorted(adapter_names.items(), key=lambda pair: pair[1].lower())
                if key not in names]
    return {
        "parties": parties,
        "channels": [{"code": code, "name": word}
                     for code, word in CHANNEL_WORDS.items()],
        "outcomes": [{"code": code, "name": word}
                     for code, word in OUTCOME_WORDS.items()],
    }
