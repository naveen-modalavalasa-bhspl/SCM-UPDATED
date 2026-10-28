"""A brand given in place of the one the indent asked for (2026-10-24).

`inv_allocation_items.substituted_from` — the brand / variant / model the indent line
named, when the desk allocated another; `substitution_reason` — why. Idempotent.

Revision ID: 9e209bc57a87
Revises: e314d303f5ff
Create Date: 2026-10-24
"""
import sqlalchemy as sa
from alembic import op

revision = "9e209bc57a87"
down_revision = "e314d303f5ff"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inv_allocation_items")}
    if "substituted_from" not in cols:
        op.add_column("inv_allocation_items",
                      sa.Column("substituted_from", sa.String(300), nullable=True))
    if "substitution_reason" not in cols:
        op.add_column("inv_allocation_items",
                      sa.Column("substitution_reason", sa.String(300), nullable=True))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inv_allocation_items")}
    for name in ("substitution_reason", "substituted_from"):
        if name in cols:
            op.drop_column("inv_allocation_items", name)
