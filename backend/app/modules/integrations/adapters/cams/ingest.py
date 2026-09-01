"""Taking a write from B-CAMS: signature, de-duplication, storage.

**What this does and does not do.** It authenticates the caller, proves the body was
not altered in flight, refuses a replay, validates the payload and records it.

Two of the five events then POST (2026-08-26): `facility.consumption` and
`facility.wastage` deduct what the field reported, so SCM's stock reflects what was
actually used at each LIP/MDP. That work is in `apply.py` and it goes through
`inventory.service.move_stock_out()` like every other movement in the system — nothing
here assigns to `stk_balance` and nothing writes a ledger row of its own (rule 7).

The other three still only record. An issue's status belongs to the warehouse module
(rule 9) and a field stock-balance report is a statement about somebody else's shelf,
not a movement of ours; both stay a durable, ordered, de-duplicated queue for those
modules to consume when the work to apply them is done.

**Storage.** `sys_settings`, as documents under `apis.cams.`, the same store the
console keeps its clients and keys in — this module owns no tables. The column is a
MySQL TEXT, so a payload over `MAX_STORED_PAYLOAD` is recorded by its digest, its row
count and its header fields, and the body itself is logged rather than stored. Said out
loud on the receipt (`payload_truncated`) rather than silently dropped.
"""
import hashlib
import hmac
import json
import logging
import secrets
from typing import Any, Mapping

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError, ValidationError
from app.modules.integrations import store
from app.modules.integrations.adapters.cams import apply
from app.modules.integrations.adapters.cams.enums import (
    CONFIG_KEY, EVENT_PREFIX, MAX_EVENTS, MAX_STORED_PAYLOAD, SIGNATURE_ALGO,
)
from app.platform.settings.models import Setting
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations.cams")


# --------------------------------------------------------------------------- #
# The shared secret
# --------------------------------------------------------------------------- #
# Generated, never defaulted: rule 13 forbids a secret in source, and a well-known
# fallback secret is worse than no signature check at all because it looks like one.

async def config(db: AsyncSession) -> dict:
    return await store.get(db, CONFIG_KEY) or {}


async def rotate_secret(db: AsyncSession, user) -> dict:
    """Mint a new shared secret. The only response that carries it — shown once.

    Only the digest is kept, exactly as an API key is: a secret SCM can read back is a
    secret every future console screen and every DB export carries.
    """
    raw = secrets.token_urlsafe(32)
    doc = {
        **await config(db),
        "secret_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "secret_hmac_key": hmac_storable(raw),
        "rotated_at": ist_now().isoformat(),
        "rotated_by_name": getattr(user, "full_name", None),
        "require_signature": True,
    }
    await store.put(db, CONFIG_KEY, doc, "B-CAMS inbound HMAC secret")
    await db.commit()
    log.info("B-CAMS shared secret rotated by %s", doc["rotated_by_name"] or "?")
    return {"shared_secret": raw, "rotated_at": doc["rotated_at"],
            "note": "Shown once. Store it in B-CAMS now — SCM cannot show it again."}


def hmac_storable(raw: str) -> str:
    """The secret as it is kept.

    Verifying an HMAC needs the key itself, not a digest of it, so unlike an API key
    this cannot be one-way. It is hex-encoded rather than stored bare so that nothing
    prints a usable secret into a log line by accident, and it lives in a row the
    console marks non-editable and the source picker refuses to serve
    (`sys_settings` is in `introspect.BLOCKED_TABLES`).
    """
    return raw.encode("utf-8").hex()


def _secret(doc: Mapping[str, Any]) -> bytes | None:
    stored = str(doc.get("secret_hmac_key") or "")
    if not stored:
        return None
    try:
        return bytes.fromhex(stored)
    except ValueError:
        log.error("B-CAMS secret is not readable — rotate it")
        return None


# --------------------------------------------------------------------------- #
# Signature
# --------------------------------------------------------------------------- #

def expected_signature(secret: bytes, body: bytes) -> str:
    return f"{SIGNATURE_ALGO}={hmac.new(secret, body, hashlib.sha256).hexdigest()}"


async def verify(db: AsyncSession, body: bytes, header: str | None) -> None:
    """401 unless the header carries an HMAC of exactly these bytes.

    Over the RAW body, before any parsing: re-serialising the JSON and signing that
    would compare a signature against a document B-CAMS never sent.
    """
    doc = await config(db)
    secret = _secret(doc)
    if secret is None:
        if doc.get("require_signature") is False:
            # An explicit, recorded decision — used while the two sides are being wired
            # up. Never the state a deployment is left in.
            log.warning("B-CAMS write accepted UNSIGNED: no shared secret is configured")
            return
        raise AuthenticationError(
            "No B-CAMS shared secret is configured on this deployment. Rotate one in "
            "Settings > APIs before posting.")
    if not header:
        raise AuthenticationError("Missing X-CAMS-Signature header")
    if not hmac.compare_digest(expected_signature(secret, body), header.strip()):
        raise AuthenticationError("Signature does not match the request body")


# --------------------------------------------------------------------------- #
# Reading the body
# --------------------------------------------------------------------------- #

def parse(body: bytes, model) -> Any:
    """Bytes -> a validated payload, with the reason on the wire when it is not one."""
    try:
        raw = json.loads(body or b"{}")
    except ValueError as exc:
        raise ValidationError(f"Body is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValidationError("Body must be a JSON object")
    try:
        return model.model_validate(raw)
    except Exception as exc:                       # pydantic ValidationError
        raise ValidationError(_readable(exc)) from exc


def _readable(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if not callable(errors):
        return str(exc)
    parts = []
    for issue in errors()[:10]:
        where = ".".join(str(p) for p in issue.get("loc", ()))
        parts.append(f"{where}: {issue.get('msg', 'invalid')}" if where
                     else str(issue.get("msg", "invalid")))
    return "; ".join(parts) or "Invalid payload"


# --------------------------------------------------------------------------- #
# Idempotency
# --------------------------------------------------------------------------- #

def event_key(event_id: str) -> str:
    return f"{EVENT_PREFIX}{event_id}"


async def seen(db: AsyncSession, event_id: str) -> dict | None:
    return await store.get(db, event_key(event_id))


async def record(db: AsyncSession, payload, body: bytes, *, client_code: str | None,
                 rows: int) -> dict:
    """Store the receipt and answer with it. Committed here — the answer is the proof."""
    text = body.decode("utf-8", "replace")
    fits = len(body) <= MAX_STORED_PAYLOAD
    receipt = {
        "event_id": payload.event_id,
        "event": payload.event,
        "received_at": ist_now().isoformat(),
        "generated_at": payload.generated_at.isoformat() if payload.generated_at else None,
        "client_code": client_code,
        "rows": rows,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "payload": json.loads(text) if fits else None,
        "payload_truncated": not fits,
    }
    if not fits:
        # Too big for the column, so the body goes where a body can go: the log. The
        # receipt still carries the digest, so it can be proven to be this one.
        log.warning("B-CAMS %s %s: %d bytes exceeds the %d-byte store; body logged only",
                    payload.event, payload.event_id, len(body), MAX_STORED_PAYLOAD)
        log.info("B-CAMS payload %s: %s", payload.event_id, text)
    await store.put(db, event_key(payload.event_id), receipt,
                    f"B-CAMS {payload.event}")
    await _prune(db)
    await db.commit()
    log.info("B-CAMS %s accepted: %s (%d rows) from %s",
             payload.event, payload.event_id, rows, client_code or "?")
    return receipt


async def _prune(db: AsyncSession) -> None:
    """Keep the newest `MAX_EVENTS` receipts. This is a de-duplication window, not an
    archive — without a bound, a daily feed writes a `sys_settings` row forever."""
    total = await db.scalar(
        select(func.count()).select_from(Setting)
        .where(Setting.setting_key.like(f"{EVENT_PREFIX}%"))) or 0
    if total <= MAX_EVENTS:
        return
    stale = (await db.execute(
        select(Setting.setting_key)
        .where(Setting.setting_key.like(f"{EVENT_PREFIX}%"))
        .order_by(Setting.updated_at.desc(), Setting.id.desc())
        .offset(MAX_EVENTS)
    )).scalars().all()
    if stale:
        await db.execute(delete(Setting).where(Setting.setting_key.in_(stale)))
        log.info("Pruned %d B-CAMS receipts past the %d kept", len(stale), MAX_EVENTS)


def ok(receipt: Mapping[str, Any]) -> dict:
    """§4's success shape."""
    return {"ok": True, "event_id": receipt["event_id"],
            "received_at": receipt["received_at"]}


def duplicate(receipt: Mapping[str, Any]) -> dict:
    """§4's replay shape: 200, `duplicate`, and nothing changed."""
    return {"ok": True, "duplicate": True, "event_id": receipt["event_id"],
            "received_at": receipt["received_at"]}


# --------------------------------------------------------------------------- #
# The one path all four writes take
# --------------------------------------------------------------------------- #

async def accept(db: AsyncSession, body: bytes, signature: str | None, model,
                 *, client_code: str | None, count) -> dict:
    """Verify -> parse -> de-duplicate -> store. One path, because four would drift.

    The signature is checked BEFORE the payload is parsed and before the event id is
    looked up: an unsigned caller must not be able to learn which event ids exist by
    watching which ones answer `duplicate`.
    """
    await verify(db, body, signature)
    payload = parse(body, model)
    already = await seen(db, payload.event_id)
    if already is not None:
        log.info("B-CAMS %s replayed: %s", payload.event, payload.event_id)
        return duplicate(already)
    receipt = await record(db, payload, body, client_code=client_code,
                           rows=count(payload))

    # NEW 2026-08-26 — consumption and wastage now DEDUCT. The receipt is recorded and
    # committed FIRST, above, and the posting is a second transaction on purpose:
    #
    #   * de-duplication has to hold even if the posting fails. If the two shared one
    #     transaction, a rollback would take the receipt with it and the client's retry
    #     would be accepted as new — posting the same consumption twice, which is the
    #     one outcome worth designing against.
    #   * a line that cannot post is not a failed request. The push arrived, was
    #     stored, and is answered `ok`; what could not be deducted is parked on the
    #     receipt for somebody to reconcile (see apply.apply_event).
    #
    # Every other event type falls straight through, exactly as before.
    outcome = await apply.apply_event(db, payload.event, payload, payload.event_id)
    if outcome["posted"] or outcome["skipped"]:
        await _save_outcome(db, payload.event_id, outcome)
    return ok(receipt)


async def _save_outcome(db: AsyncSession, event_id: str, outcome: dict) -> None:
    """Write what the posting did back onto the stored receipt.

    Its own commit, and swallowed if it fails: the stock movements are already
    committed by this point, and losing the note about them must not roll those back
    or turn an accepted push into an error the client will retry.
    """
    try:
        receipt = await seen(db, event_id)
        if receipt is None:
            return
        await store.put(db, event_key(event_id), {**receipt, "posting": outcome})
        await db.commit()
    except Exception:  # noqa: BLE001 — a note about the work is not the work
        await db.rollback()
        log.exception("could not record the posting outcome for %s", event_id)


# --------------------------------------------------------------------------- #
# Console
# --------------------------------------------------------------------------- #

async def status(db: AsyncSession) -> dict:
    """Is B-CAMS wired up, and has anything arrived — WITHOUT revealing the secret.

    The console needs this before it offers the rotate button. Minting a new secret
    silently invalidates the one the partner is signing with, so an admin has to be
    able to see that one already exists, and when it was issued, before they press it.
    Only the fact and the date, never the key: `hmac_storable` keeps the secret itself
    because verifying an HMAC needs the key, and nothing outside `verify` may read it.
    """
    doc = await config(db)
    events = await store.all_of(db, EVENT_PREFIX)
    received = [str(d.get("received_at", "")) for d in events if d.get("received_at")]
    posted = sum((d.get("posting") or {}).get("posted", 0) for d in events)
    skipped = sum((d.get("posting") or {}).get("skipped", 0) for d in events)
    return {
        "configured": bool(doc.get("secret_hmac_key")),
        "rotated_at": doc.get("rotated_at"),
        "rotated_by_name": doc.get("rotated_by_name"),
        "require_signature": doc.get("require_signature", True),
        "events": len(events),
        "last_received_at": max(received) if received else None,
        "lines_posted": posted,
        "lines_skipped": skipped,
    }


async def receipts(db: AsyncSession, params, event: str | None = None) -> dict:
    """What arrived, newest first — the screen that answers "did last night land"."""
    docs = [d for d in await store.all_of(db, EVENT_PREFIX)
            if not event or d.get("event") == event]
    docs.sort(key=lambda d: str(d.get("received_at", "")), reverse=True)
    window = docs[params.offset:params.offset + params.size]
    # The bodies are large and the list does not show them; one is fetched by id.
    items = [{k: v for k, v in doc.items() if k != "payload"} for doc in window]
    return {"items": items, "total": len(docs),
            "page": params.page, "size": params.size}


async def receipt(db: AsyncSession, event_id: str) -> dict | None:
    return await seen(db, event_id)
