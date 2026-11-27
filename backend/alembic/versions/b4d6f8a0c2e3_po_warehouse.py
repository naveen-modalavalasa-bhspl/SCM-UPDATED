"""a purchase order's warehouse (2026-11-23)

`pro_purchase_orders.warehouse_id` / `warehouse_name`: where the order is delivered,
picked on a direct PO (and carried from the RFQ otherwise), so its shipping addresses
can be offered. Idempotent.

Revision ID: b4d6f8a0c2e3
Revises: a2c4e6f8b0d1
Create Date: 2026-11-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b4d6f8a0c2e3"
down_revision: Union[str, None] = "a2c4e6f8b0d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("pro_purchase_orders"):
        return
    have = {c["name"] for c in inspector.get_columns("pro_purchase_orders")}
    if "warehouse_id" not in have:
        op.add_column("pro_purchase_orders", sa.Column("warehouse_id", sa.BigInteger, nullable=True))
        op.create_index("ix_pro_purchase_orders_warehouse_id", "pro_purchase_orders", ["warehouse_id"])
    if "warehouse_name" not in have:
        op.add_column("pro_purchase_orders", sa.Column("warehouse_name", sa.String(200), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    have = {c["name"] for c in inspector.get_columns("pro_purchase_orders")}
    if "warehouse_id" in have:
        op.drop_index("ix_pro_purchase_orders_warehouse_id", "pro_purchase_orders")
        op.drop_column("pro_purchase_orders", "warehouse_id")
    if "warehouse_name" in have:
        op.drop_column("pro_purchase_orders", "warehouse_name")
