"""PO "copied from" reference (2026-10-19).

`pro_purchase_orders.copied_from_po_id` / `copied_from_po_no`: the order a new PO was
copied from with "Copy as new PO". A reference only — the copy is a new hand-raised
order and nothing follows the pointer back. Idempotent.

Revision ID: 8e2f3a4b5c6d
Revises: 7d1e2f3a4b5c
"""
from alembic import op
import sqlalchemy as sa

revision = "8e2f3a4b5c6d"
down_revision = "7d1e2f3a4b5c"
branch_labels = None
depends_on = None

TABLE = "pro_purchase_orders"
INDEX = "ix_pro_purchase_orders_copied_from_po_id"


def _columns() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if TABLE not in sa.inspect(op.get_bind()).get_table_names():
        return
    columns = _columns()
    if "copied_from_po_id" not in columns:
        op.add_column(TABLE, sa.Column("copied_from_po_id", sa.BigInteger(), nullable=True))
        op.create_index(INDEX, TABLE, ["copied_from_po_id"])
    if "copied_from_po_no" not in columns:
        op.add_column(TABLE, sa.Column("copied_from_po_no", sa.String(30), nullable=True))


def downgrade() -> None:
    columns = _columns()
    if "copied_from_po_id" in columns:
        op.drop_index(INDEX, table_name=TABLE)
        op.drop_column(TABLE, "copied_from_po_id")
    if "copied_from_po_no" in columns:
        op.drop_column(TABLE, "copied_from_po_no")
