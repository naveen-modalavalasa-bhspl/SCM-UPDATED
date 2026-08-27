"""Where the console keeps its configuration: `sys_settings`, as JSON documents.

The module owns no tables, so a client, a key and an endpoint definition are rows in
an existing key/value table — the same "reuse a table rather than add one" move the
Returns module makes with `inv_sto`. Every key this module writes starts with `apis.`
and carries `category='apis'`, so its rows are trivially separable from real settings
and a stray `apis.*` row can never be read as one.

`sys_settings` is a platform table, which a module may READ and WRITE (imports run
modules -> platform); what a module may not do is edit the files that define it, and
nothing here does.
"""
import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.settings.models import Setting

log = logging.getLogger("app.integrations")

CATEGORY = "apis"
PREFIX = "apis."
CLIENT = f"{PREFIX}client."
KEY = f"{PREFIX}key."
ENDPOINT = f"{PREFIX}endpoint."

# `sys_settings.setting_key` is VARCHAR(100). The longest key this module writes is
# `apis.endpoint.` + a 60-character slug = 74, so nothing can be silently truncated —
# which on MySQL would collide two endpoints onto one row.
MAX_KEY = 100


def client_key(code: str) -> str:
    return f"{CLIENT}{code}"


def key_key(prefix: str) -> str:
    return f"{KEY}{prefix}"


def endpoint_key(slug: str) -> str:
    return f"{ENDPOINT}{slug}"


async def put(db: AsyncSession, key: str, payload: dict, description: str = "") -> None:
    """Upsert one document. Committed by the caller's flow, not here."""
    assert len(key) <= MAX_KEY, f"setting key too long: {key}"
    row = (await db.execute(
        select(Setting).where(Setting.setting_key == key)
    )).scalar_one_or_none()
    body = json.dumps(payload, default=str)
    if row is None:
        db.add(Setting(
            setting_key=key, setting_value=body, value_type="json",
            category=CATEGORY, description=description[:500] or None,
            is_editable=False,   # this is a document, not a knob an admin edits by hand
        ))
    else:
        row.setting_value = body
        if description:
            row.description = description[:500]


async def get(db: AsyncSession, key: str, *, for_update: bool = False) -> dict | None:
    stmt = select(Setting).where(Setting.setting_key == key)
    if for_update:
        stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).scalar_one_or_none()
    return _load(row)


async def all_of(db: AsyncSession, prefix: str) -> list[dict]:
    """Every document under a prefix, oldest key first.

    A row whose JSON someone hand-edited into nonsense is skipped with a warning
    rather than raising: one bad row must not empty the whole console.
    """
    rows = (await db.execute(
        select(Setting).where(
            Setting.category == CATEGORY, Setting.setting_key.like(f"{prefix}%")
        ).order_by(Setting.setting_key)
    )).scalars().all()
    return [doc for doc in (_load(row) for row in rows) if doc is not None]


async def drop(db: AsyncSession, key: str) -> bool:
    row = (await db.execute(
        select(Setting).where(Setting.setting_key == key)
    )).scalar_one_or_none()
    if row is None:
        return False
    await db.delete(row)
    return True


def _load(row: Setting | None) -> dict | None:
    if row is None or not row.setting_value:
        return None
    try:
        payload = json.loads(row.setting_value)
    except ValueError:
        log.warning("Ignoring %s: its value is not JSON", row.setting_key)
        return None
    return payload if isinstance(payload, dict) else None
