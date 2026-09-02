"""An API endpoint address is filed under its application, not globally

An endpoint lived at `apis.endpoint.<slug>` in `sys_settings`, so an address had
exactly ONE owner across the whole deployment. `service.resolve` then compared the
caller's client to the stored one and 404'd a mismatch.

That made the thing the console exists for impossible: seeding a second application
from a first one's exported set — 50 to 120 endpoints, which nobody is going to build
by hand twice — collided on every single row, and the paste was refused entire.

The API key already says which application is calling, so the address never needed to
be global. Endpoints move to `apis.endpoint.<CLIENT>.<slug>` and two applications may
each own `/hcm-employees`, each with its own definition, its own usage and its own
rate limit.

`sys_settings.setting_key` widens from VARCHAR(100) to VARCHAR(150) to hold it: the
worst case is `apis.endpoint.` + a 30-character code + `.` + a 60-character slug =
105, and MySQL truncates silently, which would collide two endpoints onto one row.

Idempotent both ways. Re-running finds every row already carrying its client segment
and moves none.

Revision ID: d3c4b5a6f7e8
Revises: 0d4e5f6a7b8c
Create Date: 2026-09-01
"""
import json
import logging

import sqlalchemy as sa
from alembic import op

revision = "d3c4b5a6f7e8"
down_revision = "0d4e5f6a7b8c"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.endpoints_per_application")

OLD_PREFIX = "apis.endpoint."


def _endpoints(conn):
    """Every endpoint document, as `(id, key, client_code)`."""
    rows = conn.execute(sa.text(
        "SELECT id, setting_key, setting_value FROM sys_settings "
        "WHERE setting_key LIKE :like"
    ), {"like": f"{OLD_PREFIX}%"}).fetchall()
    out = []
    for row_id, key, value in rows:
        try:
            client = str((json.loads(value or "{}") or {}).get("client_code") or "")
        except ValueError:
            # A row whose JSON cannot be read cannot be re-filed, and guessing its
            # owner from the key is not possible — the key is exactly what is missing
            # the owner. Left where it is and said out loud.
            log.warning("sys_settings %s is not readable JSON; left as it is", key)
            continue
        out.append((row_id, key, client.strip().upper()))
    return out


def upgrade() -> None:
    op.alter_column("sys_settings", "setting_key",
                    existing_type=sa.String(100), type_=sa.String(150),
                    existing_nullable=False)

    conn = op.get_bind()
    moved = 0
    for row_id, key, client in _endpoints(conn):
        slug = key[len(OLD_PREFIX):]
        if not client:
            log.warning("%s names no application; left as it is", key)
            continue
        # Already re-filed — the segment after the prefix is this row's own client.
        if slug.upper().startswith(f"{client}."):
            continue
        conn.execute(
            sa.text("UPDATE sys_settings SET setting_key = :new WHERE id = :id"),
            {"new": f"{OLD_PREFIX}{client}.{slug}", "id": row_id},
        )
        moved += 1
    log.info("endpoints re-filed under their application: %d", moved)


def downgrade() -> None:
    conn = op.get_bind()

    # Going back makes the address global again, so two applications owning the same
    # one cannot both survive. Refused rather than silently dropping one of them.
    seen: dict[str, str] = {}
    for _row_id, key, client in _endpoints(conn):
        tail = key[len(OLD_PREFIX):]
        if not client or not tail.upper().startswith(f"{client}."):
            continue
        slug = tail[len(client) + 1:]
        if slug in seen:
            raise RuntimeError(
                f"/{slug} is owned by both {seen[slug]} and {client}. A global address "
                f"has one owner, so this downgrade would destroy one of them. Delete "
                f"the endpoint you do not want first.")
        seen[slug] = client

    moved = 0
    for row_id, key, client in _endpoints(conn):
        tail = key[len(OLD_PREFIX):]
        if not client or not tail.upper().startswith(f"{client}."):
            continue
        conn.execute(
            sa.text("UPDATE sys_settings SET setting_key = :new WHERE id = :id"),
            {"new": f"{OLD_PREFIX}{tail[len(client) + 1:]}", "id": row_id},
        )
        moved += 1
    log.info("endpoints returned to global addresses: %d", moved)

    op.alter_column("sys_settings", "setting_key",
                    existing_type=sa.String(150), type_=sa.String(100),
                    existing_nullable=False)
