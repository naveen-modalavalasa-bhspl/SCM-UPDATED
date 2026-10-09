"""mst_item_eligibility — role/region item tagging for indents

Additive, and empty on arrival. An item with no row here stays requestable by
everyone (see `modules/indents/eligibility.py`), so deploying this changes nothing
until an administrator tags an item. That is the point: reading an empty mapping as
"deny" would have stopped every indent in the company on the day it shipped.

Revision ID: f12e18b268f5
Revises: c49dca12c5f5
Create Date: 2026-08-23
"""
import sqlalchemy as sa
from alembic import op

revision = "f12e18b268f5"
down_revision = "c49dca12c5f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "mst_item_eligibility" in set(sa.inspect(bind).get_table_names()):
        return  # bootstrap built it from the models already

    op.create_table(
        "mst_item_eligibility",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(length=50), nullable=True),
        sa.Column("item_name", sa.String(length=300), nullable=True),
        sa.Column("scope_type", sa.String(length=20), nullable=False),
        sa.Column("scope_id", sa.BigInteger(), nullable=False),
        sa.Column("scope_name", sa.String(length=200), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False,
                  server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_mst_item_eligibility_item_id",
                    "mst_item_eligibility", ["item_id"])
    op.create_index("ix_mst_item_eligibility_scope_type",
                    "mst_item_eligibility", ["scope_type"])
    op.create_index("ix_mst_item_eligibility_scope_id",
                    "mst_item_eligibility", ["scope_id"])
    # One tag per item per scope.
    op.create_index("uq_item_eligibility", "mst_item_eligibility",
                    ["item_id", "scope_type", "scope_id"], unique=True)


def downgrade() -> None:
    op.drop_table("mst_item_eligibility")
