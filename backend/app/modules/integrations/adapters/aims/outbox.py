"""The AIMS outbox: record an event with the stock movement, deliver it after commit.

Flow, and why each step is where it is:

1. `on_stock_in` runs inside `inventory.move_stock`'s transaction (via
   `inventory.hooks.ON_STOCK_IN`, in its own savepoint). For an ASSET item it writes one
   document `apis.aims.out.<event_id>` with status `pending`. Same transaction as the
   ledger row, so an event exists exactly when the stock does — a rolled-back GRN or
   acknowledgement leaves no event, a committed one always leaves one.
2. After that transaction COMMITS, delivery is kicked off in the background
   (`_deliver_after_commit`). Posting over HTTP inside the transaction would hold row
   locks for a network round trip and could "send" an event that then rolls back.
3. `deliver` POSTs each pending event to the configured AIMS URL, signed exactly like
   SCM's inbound webhooks are verified (`webhooks.expected_signature`: HMAC-SHA256 over
   `<timestamp>.<raw body>`). A failure keeps the event as `failed` with the error; the
   next event, or "Send pending" on the console, retries it. AIMS de-duplicates on
   `event_id`, so a retry after a lost response is harmless.

Nothing is recorded until an administrator has set a URL, minted a secret and switched
the integration on — installing the adapter changes no behaviour by itself.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import Any

import httpx
from sqlalchemy import event as sa_event
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.integrations import store
from app.modules.integrations.webhooks import (
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    expected_signature,
)
from app.platform.settings.models import Setting
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations.aims")

CONFIG_KEY = f"{store.PREFIX}aims.config"
EVENT_PREFIX = f"{store.PREFIX}aims.out."
EVENT_HEADER = "X-Event-Id"
EVENT_TYPE = "stock.arrived"
MAX_ATTEMPTS = 48          # retried every 5 minutes (`resend_loop`): about four hours
MAX_EVENTS = 5000           # the outbox keeps at most this many; the oldest SENT go first
DELIVERY_BATCH = 50
TIMEOUT_SECONDS = 10.0
STATUSES = ("pending", "sent", "failed")

_PENDING = "aims_outbox_pending"
_TASKS: set[asyncio.Task] = set()      # strong refs, so a running delivery is not GC'd


def event_key(event_id: str) -> str:
    return f"{EVENT_PREFIX}{event_id}"


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

async def config(db: AsyncSession) -> dict:
    return await store.get(db, CONFIG_KEY) or {}


def _secret_bytes(cfg: dict) -> bytes | None:
    stored = str(cfg.get("secret_hmac_key") or "")
    try:
        return bytes.fromhex(stored) if stored else None
    except ValueError:
        log.error("AIMS outbound secret is not readable — rotate it")
        return None


def public_config(cfg: dict) -> dict:
    """What the console may show: never the secret itself."""
    return {
        "url": cfg.get("url") or "",
        "enabled": bool(cfg.get("enabled")),
        "client_code": cfg.get("client_code") or "",
        "has_secret": bool(cfg.get("secret_hmac_key")),
        "rotated_at": cfg.get("rotated_at"),
        "rotated_by_name": cfg.get("rotated_by_name"),
        "updated_at": cfg.get("updated_at"),
        "updated_by_name": cfg.get("updated_by_name"),
    }


async def save_config(db: AsyncSession, user, *, url: str, enabled: bool,
                      client_code: str) -> dict:
    url = (url or "").strip()
    if url and not (url.startswith("https://") or url.startswith("http://")):
        raise ValidationError("The AIMS URL must start with https:// or http://")
    if enabled and not url:
        raise ValidationError("Set the AIMS URL before switching the push on")
    cfg = await config(db)
    if enabled and not cfg.get("secret_hmac_key"):
        raise ValidationError("Mint a signing secret before switching the push on")
    doc = {**cfg, "url": url, "enabled": bool(enabled),
           "client_code": (client_code or "").strip().upper(),
           "updated_at": ist_now().isoformat(),
           "updated_by_name": getattr(user, "full_name", None)}
    await store.put(db, CONFIG_KEY, doc, "AIMS outbound push settings")
    await db.commit()
    log.info("AIMS push settings saved by %s (enabled=%s)", doc["updated_by_name"], enabled)
    return public_config(doc)


async def rotate_secret(db: AsyncSession, user) -> dict:
    """Mint the signing secret. The only response that carries it — shown once."""
    raw = secrets.token_urlsafe(32)
    doc = {**await config(db),
           "secret_hmac_key": raw.encode("utf-8").hex(),
           "rotated_at": ist_now().isoformat(),
           "rotated_by_name": getattr(user, "full_name", None)}
    await store.put(db, CONFIG_KEY, doc, "AIMS outbound push settings")
    await db.commit()
    log.info("AIMS signing secret rotated by %s", doc["rotated_by_name"] or "?")
    return {"shared_secret": raw, "rotated_at": doc["rotated_at"],
            "note": "Shown once. Put it in AIMS as AIMS_SCM_WEBHOOK_SECRET now — "
                    "SCM cannot show it again."}


# --------------------------------------------------------------------------- #
# Recording (inside the stock movement's transaction)
# --------------------------------------------------------------------------- #

def _units(movement) -> list[str]:
    raw = getattr(movement, "serial_numbers", None)
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return [part.strip() for part in raw.split(",") if part.strip()]
    return [str(code) for code in raw] if isinstance(raw, list) else []


async def on_stock_in(db: AsyncSession, movement, user) -> None:
    """The `inventory.hooks.ON_STOCK_IN` hook. Writes one pending event per movement
    of an ASSET item while the push is switched on; does nothing otherwise."""
    cfg = await config(db)
    if not (cfg.get("enabled") and cfg.get("url")):
        return
    from app.shared.models.master import Item
    from app.shared.models.warehouse import Warehouse

    item = await db.get(Item, movement.item_id)
    if item is None or not item.is_asset:
        return   # consumables are SCM's alone; AIMS tracks assets
    warehouse = await db.get(Warehouse, movement.warehouse_id)
    event_id = f"stk-{int(movement.id):012d}"
    payload = {
        "event_id": event_id,
        "event_type": EVENT_TYPE,
        "occurred_at": ist_now().isoformat(),
        "movement": {
            "ledger_id": movement.id, "direction": "IN", "ref_type": movement.ref_type,
            "ref_id": movement.ref_id, "ref_no": movement.ref_no,
            "quantity": str(movement.quantity), "project_id": movement.project_id or None,
        },
        "item": {"id": item.id, "code": item.code, "name": item.name,
                 "uom_code": getattr(item, "uom_code", None), "is_asset": True},
        "warehouse": {
            "id": movement.warehouse_id,
            "code": getattr(warehouse, "code", None),
            "name": getattr(warehouse, "name", None) or movement.warehouse_name,
            "type": getattr(warehouse, "warehouse_type", None),
            "office_id": getattr(warehouse, "office_id", None),
        },
        "units": _units(movement),
        # Who received it: the GRN poster, or the person who acknowledged the indent /
        # issue / consignment at the destination. AIMS makes them the store custodian.
        "received_by": {"employee_id": getattr(user, "id", None),
                        "emp_code": getattr(user, "emp_code", None),
                        "name": getattr(user, "full_name", None)},
    }
    await store.put(db, event_key(event_id), {
        "event_id": event_id, "status": "pending", "attempts": 0,
        "created_at": payload["occurred_at"], "sent_at": None, "last_error": None,
        "last_status_code": None, "ref_no": movement.ref_no, "item_code": item.code,
        "warehouse_name": payload["warehouse"]["name"], "quantity": str(movement.quantity),
        "payload": payload,
    }, "AIMS outbound event")
    _deliver_after_commit(db, event_id)


def _deliver_after_commit(db: AsyncSession, event_id: str) -> None:
    """Queue the event for delivery once the OUTER transaction commits."""
    info = db.sync_session.info
    fresh = _PENDING not in info
    info.setdefault(_PENDING, set()).add(event_id)
    if not fresh:
        return

    def _committed(session) -> None:
        ids = session.info.pop(_PENDING, set())
        if not ids:
            return
        try:
            task = asyncio.get_running_loop().create_task(deliver(sorted(ids)))
        except RuntimeError:     # no running loop (a sync script) — the console retries
            return
        _TASKS.add(task)
        task.add_done_callback(_TASKS.discard)

    def _rolled_back(session) -> None:
        session.info.pop(_PENDING, None)   # nothing was saved; nothing to send

    sa_event.listen(db.sync_session, "after_commit", _committed, once=True)
    sa_event.listen(db.sync_session, "after_rollback", _rolled_back, once=True)


# --------------------------------------------------------------------------- #
# Delivery (after commit, own session)
# --------------------------------------------------------------------------- #

def signed_headers(secret: bytes, body: bytes, event_id: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    return {"Content-Type": "application/json", EVENT_HEADER: event_id,
            TIMESTAMP_HEADER: timestamp,
            SIGNATURE_HEADER: expected_signature(secret, timestamp, body)}


async def deliver(event_ids: list[str] | None = None) -> dict:
    """Send the given events, or every pending/failed one (oldest first)."""
    from app.core.database import SessionLocal

    try:
        async with SessionLocal() as db:
            return await deliver_with(db, event_ids)
    except Exception:  # noqa: BLE001 - background delivery must never crash the loop
        log.exception("AIMS delivery run failed")
        return {"sent": 0, "failed": 0}


async def deliver_with(db: AsyncSession, event_ids: list[str] | None = None) -> dict:
    cfg = await config(db)
    secret = _secret_bytes(cfg)
    if not (cfg.get("enabled") and cfg.get("url") and secret):
        return {"sent": 0, "failed": 0, "skipped": "AIMS push is not switched on"}
    if event_ids is None:
        docs = [d for d in await store.all_of(db, EVENT_PREFIX)
                if d.get("status") in ("pending", "failed")
                and int(d.get("attempts") or 0) < MAX_ATTEMPTS][:DELIVERY_BATCH]
    else:
        docs = [d for d in [await store.get(db, event_key(i)) for i in event_ids] if d]
    sent = failed = 0
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        for doc in docs:
            if doc.get("status") == "sent":
                continue
            body = json.dumps(doc["payload"], default=str, separators=(",", ":")).encode()
            doc["attempts"] = int(doc.get("attempts") or 0) + 1
            try:
                response = await client.post(cfg["url"], content=body,
                                             headers=signed_headers(secret, body,
                                                                    doc["event_id"]))
                doc["last_status_code"] = response.status_code
                if 200 <= response.status_code < 300:
                    doc.update(status="sent", sent_at=ist_now().isoformat(), last_error=None)
                    sent += 1
                else:
                    doc.update(status="failed",
                               last_error=f"HTTP {response.status_code}: {response.text[:300]}")
                    failed += 1
            except httpx.HTTPError as exc:
                doc.update(status="failed", last_error=f"{type(exc).__name__}: {exc}"[:400])
                failed += 1
            await store.put(db, event_key(doc["event_id"]), doc)
            await db.commit()
    await _prune(db)
    return {"sent": sent, "failed": failed}


RESEND_EVERY_SECONDS = 300


async def resend_loop() -> None:
    """Every few minutes, resend what is pending or failed. Started by `main.py` on the
    one process that runs schedulers; `deliver` never raises and is a no-op while the
    push is switched off, so this loop only ever stops when the app does."""
    while True:
        await asyncio.sleep(RESEND_EVERY_SECONDS)
        result = await deliver()
        if result.get("sent") or result.get("failed"):
            log.info("AIMS resend: %s", result)


async def test_connection(db: AsyncSession) -> dict:
    """Send AIMS a signed `scm.ping` and say what came back.

    AIMS checks the signature BEFORE the event type, so an unknown type answered with
    422 SCM_EVENT_INVALID proves the URL and the secret are both right — and it records
    nothing, so a test leaves no trace in AIMS."""
    cfg = await config(db)
    secret = _secret_bytes(cfg)
    if not cfg.get("url"):
        return {"ok": False, "message": "Set the AIMS address first."}
    if secret is None:
        return {"ok": False, "message": "Issue a signing secret first."}
    event_id = f"ping-{int(time.time())}"
    body = json.dumps({"event_id": event_id, "event_type": "scm.ping"},
                      separators=(",", ":")).encode()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.post(cfg["url"], content=body,
                                         headers=signed_headers(secret, body, event_id))
    except httpx.HTTPError as exc:
        return {"ok": False, "message": f"Could not reach AIMS at {cfg['url']}: "
                                        f"{type(exc).__name__} {exc}"[:300]}
    code, text = response.status_code, response.text[:300]
    if 200 <= code < 300 or (code == 422 and "SCM_EVENT_INVALID" in text):
        return {"ok": True, "status_code": code,
                "message": "Connected. AIMS accepted SCM's signature."}
    reasons = {
        401: "AIMS rejected the signature: the secret in AIMS is not the one SCM issued. "
             "Issue a new secret here and put it in AIMS.",
        503: "AIMS has no SCM secret set (AIMS_SCM_WEBHOOK_SECRET).",
        404: "Nothing answers at that address. Check the URL ends in "
             "/api/v1/integrations/scm/events.",
    }
    return {"ok": False, "status_code": code,
            "message": reasons.get(code, f"AIMS answered HTTP {code}: {text}")}


async def _prune(db: AsyncSession) -> None:
    """Keep the outbox bounded: drop the oldest SENT events beyond `MAX_EVENTS`."""
    total = int(await db.scalar(select(func.count()).select_from(Setting).where(
        Setting.category == store.CATEGORY,
        Setting.setting_key.like(f"{EVENT_PREFIX}%"))) or 0)
    if total <= MAX_EVENTS:
        return
    for doc in [d for d in await store.all_of(db, EVENT_PREFIX)
                if d.get("status") == "sent"][: total - MAX_EVENTS]:
        await store.drop(db, event_key(doc["event_id"]))
    await db.commit()


# --------------------------------------------------------------------------- #
# Reading (console)
# --------------------------------------------------------------------------- #

def _row(doc: dict) -> dict[str, Any]:
    return {k: doc.get(k) for k in ("event_id", "status", "attempts", "created_at",
                                    "sent_at", "last_error", "last_status_code", "ref_no",
                                    "item_code", "warehouse_name", "quantity")}


async def events(db: AsyncSession, *, status: str | None, page: int, size: int) -> dict:
    docs = list(reversed(await store.all_of(db, EVENT_PREFIX)))   # newest first
    if status:
        docs = [d for d in docs if d.get("status") == status]
    window = docs[(page - 1) * size:(page - 1) * size + size]
    return {"items": [_row(d) for d in window], "total": len(docs), "page": page,
            "size": size}


async def event(db: AsyncSession, event_id: str) -> dict | None:
    return await store.get(db, event_key(event_id))


async def summary(db: AsyncSession) -> dict:
    docs = await store.all_of(db, EVENT_PREFIX)
    counts = {s: 0 for s in STATUSES}
    for d in docs:
        counts[d.get("status") or "pending"] = counts.get(d.get("status") or "pending", 0) + 1
    sent = [d.get("sent_at") for d in docs if d.get("sent_at")]
    return {"config": public_config(await config(db)), "counts": counts,
            "last_sent_at": max(sent) if sent else None}


async def retry(db: AsyncSession, event_id: str) -> dict | None:
    doc = await store.get(db, event_key(event_id))
    if doc is None:
        return None
    doc.update(status="pending", attempts=0, last_error=None)
    await store.put(db, event_key(event_id), doc)
    await db.commit()
    await deliver_with(db, [event_id])
    return _row(await store.get(db, event_key(event_id)) or doc)
