"""Item combinations: item + brand + variant + model (2026-10-23).

`mst_item_combinations` — which combinations of an item exist and whether each is
switched ON. Derived from the mapped brands; see shared/masters/combinations.py.

Idempotent: creates the table only where it is missing.

Revision ID: 3a9f7a787776
Revises: d9e1f3a5b7c2
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "3a9f7a787776"
down_revision = "d9e1f3a5b7c2"
branch_labels = None
depends_on = None

TABLE = "mst_item_combinations"


def upgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("item_id", sa.BigInteger(),
                  sa.ForeignKey("mst_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("brand_id", sa.BigInteger(), nullable=False),
        sa.Column("variant_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("model_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("brand_name", sa.String(200), nullable=True),
        sa.Column("variant_name", sa.String(200), nullable=True),
        sa.Column("model_name", sa.String(200), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("item_id", "brand_id", "variant_id", "model_id",
                            name="uq_item_combination"),
    )
    op.create_index("ix_mst_item_combinations_item_id", TABLE, ["item_id"])
    op.create_index("ix_mst_item_combinations_brand_id", TABLE, ["brand_id"])


def downgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table(TABLE)
