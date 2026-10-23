"""Merge development's line into SCM-NAVEEN's (2026-10-23).

Schema-free. Joins `a4ace224a97d` (development: warehouse address on outward docs,
merged with the PO "copied from" column) and `e7c3a9f1d5b8` (SCM-NAVEEN: packs inside
each consignment package), so `alembic upgrade head` has one head to move to. A merge
revision, never a re-pointed down_revision — see CLAUDE.md on Alembic heads.

Revision ID: d9e1f3a5b7c2
Revises: a4ace224a97d, e7c3a9f1d5b8
"""

revision = "d9e1f3a5b7c2"
down_revision = ("a4ace224a97d", "e7c3a9f1d5b8")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
