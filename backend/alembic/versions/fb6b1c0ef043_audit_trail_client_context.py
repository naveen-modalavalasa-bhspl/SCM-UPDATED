"""audit trail records where from and on what

`sys_audit_log` recorded who changed what and when, and carried an `ip_address` column
that nothing ever wrote — so the Audit Log could not answer "where was this done from",
which is the question asked whenever a change is disputed.

Five columns, all nullable and all snapshots (rule 10): a device that is renamed or an
IP that is reassigned never rewrites history. Nothing backfills — every row written
before this migration keeps NULLs, and the screen shows a dash for them rather than
inventing a location for an event nobody observed.

Revision ID: fb6b1c0ef043
Revises: d3c4b5a6f7e8
"""
from alembic import op
import sqlalchemy as sa

revision = "fb6b1c0ef043"
down_revision = "d3c4b5a6f7e8"
branch_labels = None
depends_on = None


# (name, type) — kept in one list so upgrade and downgrade cannot drift apart.
COLUMNS = [
    ("location", sa.String(200)),
    ("device_type", sa.String(30)),
    ("browser", sa.String(50)),
    ("os", sa.String(50)),
    ("user_agent", sa.String(500)),
]


def _existing() -> set[str]:
    """What the live table already has.

    This build's history is replayed against databases created by `create_all` as
    well as by Alembic (see the bootstrap note in CLAUDE.md), so a column may already
    be present. Adding it again is a hard error in MySQL, and one that stops the whole
    upgrade — checking first is what keeps this migration idempotent.
    """
    bind = op.get_bind()
    return {c["name"] for c in sa.inspect(bind).get_columns("sys_audit_log")}


def upgrade() -> None:
    have = _existing()
    for name, type_ in COLUMNS:
        if name not in have:
            op.add_column("sys_audit_log", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    have = _existing()
    for name, _type in reversed(COLUMNS):
        if name in have:
            op.drop_column("sys_audit_log", name)
