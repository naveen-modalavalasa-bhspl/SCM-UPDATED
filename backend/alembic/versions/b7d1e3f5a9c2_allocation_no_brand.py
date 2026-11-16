"""An allocation line that gives stock with NO brand recorded (2026-10-24).

`inv_allocation_items.no_brand` — the desk chose untagged stock (booked in before
brands were recorded) rather than any brand. Idempotent.

Revision ID: b7d1e3f5a9c2
Revises: 9e209bc57a87
Create Date: 2026-10-24
"""
import sqlalchemy as sa
from alembic import op

revision = "b7d1e3f5a9c2"
down_revision = "9e209bc57a87"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inv_allocation_items")}
    if "no_brand" not in cols:
        op.add_column("inv_allocation_items",
                      sa.Column("no_brand", sa.Boolean(), nullable=False,
                                server_default="0"))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inv_allocation_items")}
    if "no_brand" in cols:
        op.drop_column("inv_allocation_items", "no_brand")
