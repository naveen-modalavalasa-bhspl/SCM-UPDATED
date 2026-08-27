"""Inbound webhooks: who may push data into SCM, what they may send, and what happens
to it — all configured from the screen rather than written per partner.

The B-CAMS adapter is what this generalises. Every integration that pushes to us needs
the same four things — an API key, a shared secret to sign the body with, a list of
event names it is allowed to send, and de-duplication on an event id — and today each
one gets them by having a folder hand-written for it. A partner who only wants to say
"this employee changed" should not need a release.

WHAT AN ADMIN CAN AND CANNOT CONFIGURE, because this is the whole security question:

  * CAN: the source, its secret, which event names it may send, whether a signature is
    required, and which of the fixed handlers below runs.
  * CANNOT: what the handler DOES. There is no table name, no column mapping and no
    SQL on a webhook document. A screen that could point an inbound feed at
    `stk_balance` would be a way around rule 7 — physical stock changes only through
    `inventory.service.move_stock()` — and around every module's own service besides.

So the handler is a CLOSED SET, named in `HANDLERS`. Adding one is a code change, on
purpose, and each one is answerable for its own writes. `record` is the only one today
and it writes nothing: it stores the delivery, which is exactly what a queue of field
events is, and what three of B-CAMS's five writes already do.

Storage is `sys_settings`, as documents under `apis.hook.` — the same store the
console keeps clients, keys and endpoints in. This module owns no tables (see
`models.py`), so a webhook can be registered on a deployment without a migration.
"""
import hashlib
import hmac
import json
import logging
import re
import secrets
from typing import Any, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AuthenticationError, ConflictError, NotFoundError, ValidationError,
)
from app.modules.integrations import store
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations.webhooks")

HOOK = f"{store.PREFIX}hook."
DELIVERY = f"{store.PREFIX}hookevt."

#: `apis.hookevt.` is 13 characters and `sys_settings.setting_key` is VARCHAR(100), so
#: a longer event id could be silently truncated on MySQL — which would collide two
#: deliveries onto one row and answer the second "duplicate".
MAX_EVENT_ID = 80
#: A de-duplication window, not an archive. The oldest are dropped as new ones land.
MAX_DELIVERIES = 2000
#: `sys_settings.setting_value` is a MySQL TEXT: 65,535 BYTES. A payload past this is
#: recorded by digest and logged instead, said out loud rather than silently cut.
MAX_STORED_PAYLOAD = 40_000

SOURCE_PATTERN = r"^[a-z][a-z0-9-]{1,38}$"
SIGNATURE_HEADER = "X-Webhook-Signature"
SIGNATURE_ALGO = "sha256"


# --------------------------------------------------------------------------- #
#  What a webhook may do with what it receives
# --------------------------------------------------------------------------- #

async def _handle_record(db: AsyncSession, hook: dict, payload: Any) -> dict:
    """Store the delivery and nothing else.

    Not a placeholder — it is the honest handler for a feed nobody has agreed the
    downstream effect of yet, and it is what three of the five B-CAMS writes do. The
    delivery is durable, ordered and de-duplicated, which is what a consumer needs.
    """
    return {"handled": "recorded"}


# --------------------------------------------------------------------------- #
#  Keeping the HCM mirror fresh between syncs
# --------------------------------------------------------------------------- #
#
# The mirror is fed by a periodic sync that pulls everything. That makes it CORRECT
# and leaves it up to a whole interval STALE: a joiner HCM created this morning cannot
# log in, does not appear in RBAC, cannot raise an indent and cannot be picked as an
# approver until somebody presses Sync now.
#
# This handler closes that gap without replacing the sync, and the division of labour
# is the point:
#
#   webhook -> fresh.   One record, the moment it changes.
#   sync    -> correct. Everything, on a schedule, including whatever the webhook
#                       missed while their server was down or a retry gave up.
#
# A push that never arrives leaves no trace anywhere, so a feed that only ever adds
# cannot tell you what it skipped. That is the same shape as the position-retirement
# defect this codebase already carries a scar from — which is why the sync stays.
#
# WRITES GO THROUGH THE SYNC'S OWN PATH. `mappers` turns HCM's payload into columns and
# `sync._upsert` writes them, so `hcm_*` keeps exactly ONE writer (rule 10) and every
# HCM field name still lives only in `mappers.py`. Nothing here builds a row by hand.

#: Event prefix -> what the sync calls that entity. The suffix (`.created`,
#: `.updated`, `.deactivated`) decides what happens to it, not which table it is.
HCM_ENTITIES = {
    "employee": "employees",
    "position": "positions",
    "office": "offices",
    "department": "departments",
    "project": "projects",
    "section": "sections",
}

#: Suffixes that RETIRE rather than upsert. Retire, not delete: `wf_instances`
#: .resolved_chain and every historical approval name these ids and must still resolve
#: to a name, which is the same reason `sync._retire_positions` deactivates.
RETIRING = ("deactivated", "deleted", "removed", "terminated")


async def _handle_hcm(db: AsyncSession, hook: dict, payload: Any) -> dict:
    """Apply one HCM record to the mirror, the way a sync would.

    The record is taken from `data` when the sender wraps it, and from the payload
    itself otherwise — which is the shape HCM's own feed already uses, so their
    existing serialiser works unchanged.
    """
    from app.platform.hcm import mappers, sync
    from app.platform.hcm.models import (
        HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmSection,
    )

    event = str(payload.get("event") or "")
    head, _, tail = event.partition(".")
    entity = HCM_ENTITIES.get(head)
    if entity is None:
        return {"handled": "recorded",
                "note": f"{event!r} names nothing in the HCM mirror, so it was only "
                        f"recorded"}

    # `data` when the sender wraps the record, otherwise the payload itself — which is
    # the nested {employee, position, office} shape HCM's feed already sends.
    record = payload.get("data") if isinstance(payload.get("data"), dict) else payload

    plan = {
        "employees": (HcmEmployee, mappers.map_employee),
        "positions": (HcmPosition, mappers.map_position),
        "offices": (HcmOffice, mappers.map_office),
        "departments": (HcmDepartment, mappers.map_department),
        "sections": (HcmSection, mappers.map_section),
    }
    if entity == "projects":
        cols = mappers.map_project(record)
        if not await sync._upsert_project(db, cols):
            return {"handled": "rejected", "note": "the record carries no id or name"}
        await db.commit()
        return {"handled": "upserted", "entity": entity, "id": cols.get("id")}

    model, mapper = plan[entity]
    cols = mapper(record)
    row_id = cols.get("id")
    if row_id is None:
        return {"handled": "rejected",
                "note": "the record carries no id, so there is nothing to match on"}

    if tail in RETIRING:
        existing = await db.get(model, row_id)
        if existing is None:
            return {"handled": "ignored",
                    "note": f"{entity} {row_id} is not in the mirror"}
        existing.is_active = False
        # A post nobody holds any more takes its seats with it, exactly as
        # `sync._retire_positions` does.
        if entity == "positions":
            from app.platform.hcm.models import HcmPositionAssignment
            from sqlalchemy import update as sa_update
            await db.execute(
                sa_update(HcmPositionAssignment)
                .where(HcmPositionAssignment.position_id == row_id,
                       HcmPositionAssignment.is_active.is_(True))
                .values(is_active=False)
                .execution_options(synchronize_session=False))
        await db.commit()
        log.info("webhook retired %s %s", entity, row_id)
        return {"handled": "retired", "entity": entity, "id": row_id}

    await sync._upsert(db, model, cols, record)
    outcome = {"handled": "upserted", "entity": entity, "id": row_id}

    if entity == "employees":
        # A row is not a login. Credentials are minted by a sync FOLLOW-UP step, so a
        # handler that stopped here would leave the joiner existing but unable to sign
        # in — which is exactly the defect that had every new starter waiting on an
        # admin. Only ever ADDS, and it is off unless NEW_USER_DEFAULT_PASSWORD is set.
        await db.commit()
        issued = await sync._issue_missing_logins(db)
        outcome["logins_issued"] = issued

    await db.commit()
    log.info("webhook %s %s %s", outcome["handled"], entity, row_id)
    return outcome


#: The closed set. A webhook document names one of these keys and nothing else; there
#: is deliberately no way to describe a write from the screen.
HANDLERS = {
    "record": ("Record only", _handle_record),
    "hcm_mirror": ("Update the HCM mirror", _handle_hcm),
}


#: Event names offered in the picker. SUGGESTIONS, not a whitelist: SCM cannot know
#: what a partner calls its events, so a name typed in is accepted as readily as one
#: chosen. What it saves is the typo — an event name that does not match exactly is
#: refused at push time, and "employee.update" vs "employee.updated" is a silent
#: afternoon of nothing arriving.
SUGGESTED_EVENTS = [
    "employee.created", "employee.updated", "employee.deactivated",
    "position.created", "position.updated", "position.deactivated",
    "office.created", "office.updated",
    "department.created", "department.updated",
    "project.created", "project.updated",
]


async def event_suggestions(db: AsyncSession) -> list[str]:
    """What the picker offers: the curated list plus every event name already in use
    on this deployment, so the second webhook from a partner offers what the first
    one taught us."""
    seen = set(SUGGESTED_EVENTS)
    for doc in await store.all_of(db, HOOK):
        seen.update(str(e) for e in (doc.get("events") or []))
    return sorted(seen)


def handler_choices() -> list[dict]:
    """What the screen may offer. Served, never hardcoded in the UI."""
    return [{"key": key, "label": label} for key, (label, _) in HANDLERS.items()]


# --------------------------------------------------------------------------- #
#  Registration
# --------------------------------------------------------------------------- #

def hook_key(source: str) -> str:
    return f"{HOOK}{source}"


def delivery_key(source: str, event_id: str) -> str:
    return f"{DELIVERY}{source}.{event_id}"


def _public(doc: Mapping[str, Any]) -> dict:
    """A webhook as the screen sees it. NEVER carries the secret — only whether one is
    set, the same way an API key is shown as a prefix and a mask."""
    return {
        "source": doc.get("source"),
        "name": doc.get("name"),
        "description": doc.get("description"),
        "events": list(doc.get("events") or []),
        "handler": doc.get("handler", "record"),
        "require_signature": bool(doc.get("require_signature", True)),
        "has_secret": bool(doc.get("secret_hmac_key")),
        "is_active": bool(doc.get("is_active", True)),
        "url": f"/api/ext/v1/hooks/{doc.get('source')}",
        "created_at": doc.get("created_at"),
        "created_by_name": doc.get("created_by_name"),
        "updated_at": doc.get("updated_at"),
        "last_received_at": doc.get("last_received_at"),
        "received_count": int(doc.get("received_count") or 0),
    }


# --------------------------------------------------------------------------- #
#  Connection details — what you send the system that will push to us
# --------------------------------------------------------------------------- #

#: A worked example per event family, so the sender sees the SHAPE rather than a
#: description of it. Keyed on the entity, because every event of one entity carries
#: the same record — only the suffix differs.
_SAMPLE_RECORDS = {
    "employee": {
        "employee": {"id": 17099, "name": "A New Joiner",
                     "employee_code": "HR-EMP-17099", "status": "Active"},
        "position": {"id": 55163, "department_id": 1235},
        "office": {"id": 1549, "name": "CENTRAL WAREHOUSE-1"},
    },
    "position": {"id": 55163, "name": "SCM HEAD", "code": "SCM-01",
                 "role_id": 186, "role_name": "SCM HEAD", "status": "Active"},
    "office": {"id": 1549, "name": "CENTRAL WAREHOUSE-1", "code": "CW-01",
               "level_name": "CIRCLE OFFICE", "status": "Active"},
    "department": {"id": 1235, "name": "CENTRAL WARE HOUSE DEPARTMENT-1",
                   "status": "Active"},
    "project": {"id": 23, "name": "SUPPLY CHAIN MANAGEMENT", "code": "SCM",
                "status": "Active"},
    "section": {"id": 6094, "name": "WAREHOUSE-01", "status": "Active"},
}


def sample_body(event: str) -> dict:
    """A body the sender can copy, for one of the events this webhook accepts."""
    head = str(event).partition(".")[0]
    record = _SAMPLE_RECORDS.get(head, {"id": 1, "name": "..."})
    return {"event": event, "event_id": f"{head}-2026-08-27-0001", **record}


async def connection_docs(db: AsyncSession, source: str, base_url: str = "") -> dict:
    """Everything the sending system needs. DERIVED from the registration — there is
    no second copy to keep in step, which is the only way a doc stays true."""
    doc = await _raw(db, source)
    url = f"{base_url.rstrip('/')}/api/ext/v1/hooks/{source}" if base_url         else f"/api/ext/v1/hooks/{source}"
    events = list(doc.get("events") or [])
    label, _handler = HANDLERS.get(doc.get("handler", "record"),
                                   ("Record only", None))
    return {
        "source": source,
        "name": doc.get("name") or source,
        "url": url,
        "method": "POST",
        "handler": doc.get("handler", "record"),
        "handler_label": label,
        "events": events,
        "has_secret": bool(doc.get("secret_hmac_key")),
        "require_signature": bool(doc.get("require_signature", True)),
        "headers": [
            {"name": "X-API-Key",
             "note": "The key issued for the calling application."},
            {"name": SIGNATURE_HEADER,
             "note": f"{SIGNATURE_ALGO}=<HMAC-{SIGNATURE_ALGO.upper()} of the RAW "
                     f"request body, using the shared secret>"},
            {"name": "Content-Type", "note": "application/json"},
        ],
        "envelope": [
            {"field": "event",
             "note": "One of the accepted events. Anything else is refused, with the "
                     "list of what is taken."},
            {"field": "event_id",
             "note": f"Unique per push, {MAX_EVENT_ID} characters or fewer. A repeat "
                     f"is answered `duplicate` and changes nothing, so retrying is "
                     f"always safe."},
            {"field": "<the record>",
             "note": "The entity itself, either at the top level or under `data`. "
                     "Both shapes are read."},
        ],
        "answers": [
            {"status": 200, "body": {"ok": True, "event_id": "...",
                                     "received_at": "..."},
             "note": "Accepted."},
            {"status": 200, "body": {"ok": True, "duplicate": True},
             "note": "Already seen. Nothing changed."},
            {"status": 401, "note": "Bad key, missing signature, or a signature that "
                                    "does not match the body."},
            {"status": 422, "note": "An event this webhook does not accept, or a body "
                                    "that is not a JSON object."},
            {"status": 404, "note": "No such webhook, or it has been switched off."},
        ],
        "samples": [{"event": event, "body": sample_body(event)} for event in events],
        "signing_note": (
            "The HMAC is over the RAW bytes of the body, before any re-serialising. "
            "Signing a re-encoded copy produces a signature for a document that was "
            "never sent, and it will be refused."),
    }


async def list_hooks(db: AsyncSession) -> list[dict]:
    docs = await store.all_of(db, HOOK)
    docs.sort(key=lambda d: str(d.get("source", "")))
    return [_public(doc) for doc in docs]


async def get_hook(db: AsyncSession, source: str) -> dict:
    doc = await store.get(db, hook_key(source))
    if doc is None:
        raise NotFoundError(f"No webhook named {source}")
    return _public(doc)


async def _raw(db: AsyncSession, source: str) -> dict:
    doc = await store.get(db, hook_key(source))
    if doc is None:
        raise NotFoundError(f"No webhook named {source}")
    return doc


def _validate(source: str, events: list[str], handler: str) -> None:
    if not re.match(SOURCE_PATTERN, source or ""):
        raise ValidationError(
            "A webhook name is 2-39 characters, lower case, starting with a letter "
            "and using only letters, numbers and hyphens — it becomes part of the URL.")
    if handler not in HANDLERS:
        raise ValidationError(
            f"{handler!r} is not something a webhook can do. "
            f"Choose one of: {', '.join(HANDLERS)}.")
    if not events:
        raise ValidationError(
            "List the event names this source may send. A webhook that accepts "
            "anything cannot be told apart from a misconfigured one.")


async def create_hook(db: AsyncSession, data, user) -> dict:
    source = (data.source or "").strip().lower()
    _validate(source, data.events, data.handler)
    if await store.get(db, hook_key(source)) is not None:
        raise ConflictError(f"A webhook named {source} already exists")

    doc = {
        "source": source,
        "name": data.name,
        "description": data.description,
        "events": data.events,
        "handler": data.handler,
        "require_signature": data.require_signature,
        "is_active": data.is_active,
        "created_at": ist_now().isoformat(),
        "created_by_name": getattr(user, "full_name", None),
        "updated_at": ist_now().isoformat(),
    }
    await store.put(db, hook_key(source), doc, f"Inbound webhook {source}")
    await db.commit()
    log.info("webhook %s registered by %s", source, doc["created_by_name"] or "?")
    return _public(doc)


async def update_hook(db: AsyncSession, source: str, data, user) -> dict:
    doc = await _raw(db, source)
    _validate(source, data.events, data.handler)
    # The secret is NOT in `data` and cannot be set this way — it is minted by
    # `rotate_secret` and shown once, exactly as an API key is.
    doc.update({
        "name": data.name,
        "description": data.description,
        "events": data.events,
        "handler": data.handler,
        "require_signature": data.require_signature,
        "is_active": data.is_active,
        "updated_at": ist_now().isoformat(),
    })
    await store.put(db, hook_key(source), doc, f"Inbound webhook {source}")
    await db.commit()
    return _public(doc)


async def delete_hook(db: AsyncSession, source: str) -> dict:
    """Deactivates rather than deletes, so the deliveries it took keep their meaning."""
    doc = await _raw(db, source)
    doc["is_active"] = False
    doc["updated_at"] = ist_now().isoformat()
    await store.put(db, hook_key(source), doc)
    await db.commit()
    return _public(doc)


async def rotate_secret(db: AsyncSession, source: str, user) -> dict:
    """Mint the secret this source signs with. The only response that carries it.

    Unlike an API key this cannot be one-way — verifying an HMAC needs the key itself,
    not a digest of it. It is hex-encoded so nothing prints a usable secret into a log
    by accident, and it lives in a row the source picker refuses to serve
    (`sys_settings` is in `introspect.BLOCKED_TABLES`).
    """
    doc = await _raw(db, source)
    raw = secrets.token_urlsafe(32)
    doc.update({
        "secret_hmac_key": raw.encode("utf-8").hex(),
        "require_signature": True,
        "rotated_at": ist_now().isoformat(),
        "rotated_by_name": getattr(user, "full_name", None),
    })
    await store.put(db, hook_key(source), doc, f"Inbound webhook {source}")
    await db.commit()
    log.info("webhook %s secret rotated by %s", source, doc["rotated_by_name"] or "?")
    return {
        "source": source,
        "shared_secret": raw,
        "signature_header": SIGNATURE_HEADER,
        "note": ("Shown once. Give it to the sending system now — SCM keeps it only to "
                 "verify signatures and cannot display it again."),
    }


# --------------------------------------------------------------------------- #
#  Receiving
# --------------------------------------------------------------------------- #

def json_body(body: bytes) -> dict:
    """Bytes -> a JSON object, with the reason on the wire when it is not one."""
    try:
        raw = json.loads(body or b"{}")
    except ValueError as exc:
        raise ValidationError(f"Body is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValidationError("Body must be a JSON object")
    return raw


def expected_signature(secret: bytes, body: bytes) -> str:
    return f"{SIGNATURE_ALGO}={hmac.new(secret, body, hashlib.sha256).hexdigest()}"


def _secret_bytes(doc: Mapping[str, Any]) -> bytes | None:
    stored = str(doc.get("secret_hmac_key") or "")
    if not stored:
        return None
    try:
        return bytes.fromhex(stored)
    except ValueError:
        log.error("webhook %s secret is not readable — rotate it", doc.get("source"))
        return None


def verify(doc: Mapping[str, Any], body: bytes, header: str | None) -> None:
    """401 unless the header carries an HMAC of exactly these bytes.

    Over the RAW body, before parsing: re-serialising the JSON and signing that would
    compare a signature against a document the sender never sent.
    """
    secret = _secret_bytes(doc)
    if secret is None:
        if doc.get("require_signature") is False:
            # An explicit, recorded decision — used while two sides are being wired
            # together. Never the state a deployment is left in.
            log.warning("webhook %s accepted UNSIGNED: no secret is configured",
                        doc.get("source"))
            return
        raise AuthenticationError(
            "This webhook has no shared secret yet. Rotate one on "
            "Settings > Integrations before sending to it.")
    if not header:
        raise AuthenticationError(f"Missing {SIGNATURE_HEADER} header")
    if not hmac.compare_digest(expected_signature(secret, body), header.strip()):
        raise AuthenticationError("Signature does not match the request body")


async def _prune(db: AsyncSession) -> None:
    docs = await store.all_of(db, DELIVERY)
    if len(docs) <= MAX_DELIVERIES:
        return
    docs.sort(key=lambda d: str(d.get("received_at", "")))
    for doc in docs[:len(docs) - MAX_DELIVERIES]:
        await store.drop(db, delivery_key(doc.get("source", ""),
                                          doc.get("event_id", "")))


async def receive(db: AsyncSession, source: str, body: bytes, signature: str | None,
                  payload: dict, client_code: str | None) -> dict:
    """Authenticate, de-duplicate, record, hand to the handler. Never partial.

    The order matters and mirrors the B-CAMS path: the signature is checked BEFORE the
    event id is looked up, so an unsigned caller cannot learn which event ids exist by
    watching which ones answer `duplicate`.
    """
    doc = await store.get(db, hook_key(source))
    if doc is None or not doc.get("is_active"):
        # The same answer for "no such webhook" and "switched off", and deliberately
        # not "unauthorised": neither tells a stranger which names are real.
        raise NotFoundError(f"No webhook named {source}")

    verify(doc, body, signature)

    event = str(payload.get("event") or "").strip()
    event_id = str(payload.get("event_id") or "").strip()
    if not event or not event_id:
        raise ValidationError("Both `event` and `event_id` are required.")
    if len(event_id) > MAX_EVENT_ID:
        raise ValidationError(
            f"`event_id` must be {MAX_EVENT_ID} characters or fewer.")
    allowed = doc.get("events") or []
    if event not in allowed:
        raise ValidationError(
            f"{event!r} is not an event this webhook accepts. "
            f"It takes: {', '.join(allowed)}.")

    key = delivery_key(source, event_id)
    already = await store.get(db, key)
    if already is not None:
        log.info("webhook %s replayed: %s", source, event_id)
        return {"ok": True, "duplicate": True, "event_id": event_id,
                "received_at": already.get("received_at")}

    fits = len(body) <= MAX_STORED_PAYLOAD
    delivery = {
        "source": source,
        "event": event,
        "event_id": event_id,
        "received_at": ist_now().isoformat(),
        "client_code": client_code,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "payload": payload if fits else None,
        "payload_truncated": not fits,
    }
    if not fits:
        log.warning("webhook %s %s: %d bytes exceeds the %d-byte store; body logged",
                    source, event_id, len(body), MAX_STORED_PAYLOAD)
        log.info("webhook payload %s: %s", event_id, body.decode("utf-8", "replace"))

    _label, handler = HANDLERS[doc.get("handler", "record")]
    delivery["outcome"] = await handler(db, doc, payload)

    await store.put(db, key, delivery, f"{source} {event}")
    doc["last_received_at"] = delivery["received_at"]
    doc["received_count"] = int(doc.get("received_count") or 0) + 1
    await store.put(db, hook_key(source), doc)
    await _prune(db)
    await db.commit()
    log.info("webhook %s accepted %s (%s)", source, event_id, event)
    return {"ok": True, "event_id": event_id,
            "received_at": delivery["received_at"]}


async def deliveries(db: AsyncSession, params, source: str | None = None,
                     event: str | None = None) -> dict:
    """What arrived, newest first — the screen that answers "did their push land"."""
    docs = [d for d in await store.all_of(db, DELIVERY)
            if (not source or d.get("source") == source)
            and (not event or d.get("event") == event)]
    docs.sort(key=lambda d: str(d.get("received_at", "")), reverse=True)
    window = docs[params.offset:params.offset + params.size]
    # The bodies are large and the list does not show them; one is fetched by id.
    items = [{k: v for k, v in doc.items() if k != "payload"} for doc in window]
    return {"items": items, "total": len(docs),
            "page": params.page, "size": params.size}


async def delivery(db: AsyncSession, source: str, event_id: str) -> dict:
    doc = await store.get(db, delivery_key(source, event_id))
    if doc is None:
        raise NotFoundError("No such delivery")
    return doc
