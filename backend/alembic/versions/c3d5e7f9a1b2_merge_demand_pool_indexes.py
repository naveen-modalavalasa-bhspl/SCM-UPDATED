"""Merge demand-pool indexes branch with qa merge branch.

fbbe7f58b671 and a2b4c6d8e0f1 are both heads.  This revision merges
them so `alembic upgrade head` works from any starting point.

Revision ID: c3d5e7f9a1b2
Revises: fbbe7f58b671, a2b4c6d8e0f1
"""
from alembic import op

revision = "c3d5e7f9a1b2"
down_revision = ("fbbe7f58b671", "a2b4c6d8e0f1")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
