"""a warehouse's shipping addresses; an RFQ's chosen one (2026-11-23)

- whs_warehouse_addresses: several per warehouse, one default. Each warehouse's
  existing `address` becomes its first, default address ("Main address").
- pro_rfqs.shipping_address / shipping_address_id, pro_purchase_orders.shipping_address_id:
  what was picked (the text is kept as chosen; the id says which address it was).

Idempotent.

Revision ID: a2c4e6f8b0d1
Revises: f1b3d5a7c9e2
Create Date: 2026-11-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a2c4e6f8b0d1"
down_revision: Union[str, None] = "f1b3d5a7c9e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "whs_warehouse_addresses"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE):
        op.create_table(
            TABLE,
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("warehouse_id", sa.BigInteger,
                      sa.ForeignKey("whs_warehouses.id", ondelete="CASCADE"), nullable=False),
            sa.Column("label", sa.String(100), nullable=False),
            sa.Column("address", sa.String(500), nullable=False),
            sa.Column("city", sa.String(100), nullable=True),
            sa.Column("state", sa.String(100), nullable=True),
            sa.Column("pincode", sa.String(10), nullable=True),
            sa.Column("contact_name", sa.String(150), nullable=True),
            sa.Column("contact_phone", sa.String(20), nullable=True),
            sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.false()),
            sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_whs_warehouse_addresses_warehouse_id", TABLE, ["warehouse_id"])
        # Every warehouse's single address becomes its first, default shipping address.
        if inspector.has_table("whs_warehouses"):
            bind.execute(sa.text(
                f"INSERT INTO {TABLE} (warehouse_id, label, address, is_default, is_active, created_at) "
                "SELECT id, 'Main address', address, 1, 1, NOW() FROM whs_warehouses "
                "WHERE address IS NOT NULL AND TRIM(address) <> ''"))
    for table, name, kind in (
        ("pro_rfqs", "shipping_address", sa.Text()),
        ("pro_rfqs", "shipping_address_id", sa.BigInteger()),
        ("pro_purchase_orders", "shipping_address_id", sa.BigInteger()),
    ):
        if inspector.has_table(table) and name not in {c["name"] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, name in (("pro_rfqs", "shipping_address"), ("pro_rfqs", "shipping_address_id"),
                        ("pro_purchase_orders", "shipping_address_id")):
        if inspector.has_table(table) and name in {c["name"] for c in inspector.get_columns(table)}:
            op.drop_column(table, name)
    if inspector.has_table(TABLE):
        op.drop_table(TABLE)
