"""Merge the brand-variants line and the part-packs line (2026-10-21).

Schema-free. Two heads again after merging SCM-NAVEEN into siva; a merge revision,
never a re-pointed down_revision (see CLAUDE.md on Alembic heads).

Revision ID: a0c2e4f6b8d1
Revises: 9f3a4b5c6d7e, c8e0a2b4d6f9
"""

revision = "a0c2e4f6b8d1"
down_revision = ("9f3a4b5c6d7e", "c8e0a2b4d6f9")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
