"""whs_stock_edits / whs_stock_edit_items — Stock Corrections (2026-10-01).

A request to correct a held batch (batch no., mfg, expiry) or unit (serial, IMEI,
asset / consumable code, lot), approved on the STOCK_EDIT ladder before it is written.

Guarded by the inspector: a database built by ``bootstrap`` already has the tables.

Revision ID: f1b3d5e7a9c2
Revises: e8a3c5b7d9f1
Create Date: 2026-10-01
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f1b3d5e7a9c2"
down_revision: Union[str, Sequence[str], None] = "e8a3c5b7d9f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "whs_stock_edits" not in have:
        op.create_table(
            "whs_stock_edits",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("edit_no", sa.String(50), nullable=False, unique=True),
            sa.Column("warehouse_id", sa.BigInteger(), nullable=False, index=True),
            sa.Column("warehouse_name", sa.String(200)),
            sa.Column("status", sa.String(30), nullable=False, index=True),
            sa.Column("reason", sa.String(500), nullable=False),
            sa.Column("remarks", sa.Text()),
            sa.Column("created_by_id", sa.BigInteger(), index=True),
            sa.Column("created_by_name", sa.String(200)),
            sa.Column("approved_by_id", sa.BigInteger(), index=True),
            sa.Column("approved_by_name", sa.String(200)),
            sa.Column("approved_at", sa.DateTime()),
            sa.Column("current_approver_name", sa.String(300)),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False,
                      server_default=sa.func.now()),
        )
    if "whs_stock_edit_items" not in have:
        op.create_table(
            "whs_stock_edit_items",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("edit_id", sa.BigInteger(),
                      sa.ForeignKey("whs_stock_edits.id", ondelete="CASCADE"),
                      nullable=False, index=True),
            sa.Column("target_type", sa.String(10), nullable=False),
            sa.Column("batch_id", sa.BigInteger(), index=True),
            sa.Column("serial_id", sa.BigInteger(), index=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False, index=True),
            sa.Column("item_code", sa.String(50)),
            sa.Column("item_name", sa.String(300)),
            sa.Column("label", sa.String(200)),
            sa.Column("changes", sa.JSON(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("whs_stock_edit_items")
    op.drop_table("whs_stock_edits")
