"""warranty per received unit on a GRN (MoM 2026-11-18, point 25)

`inb_receipt_unit_warranties`: one row per serial / IMEI received on a GRN line —
start and end date, an optional card number, and the warranty document (a
`sys_attachments` row, entity GRN_WARRANTY).

Idempotent.

Revision ID: c6e8a0b2d4f7
Revises: a4c6e8b0d2f5
Create Date: 2026-11-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c6e8a0b2d4f7"
down_revision: Union[str, None] = "a4c6e8b0d2f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "inb_receipt_unit_warranties"


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("receipt_id", sa.BigInteger,
                  sa.ForeignKey("inb_receipts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("receipt_item_id", sa.BigInteger,
                  sa.ForeignKey("inb_receipt_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.BigInteger, nullable=False),
        sa.Column("unit_code", sa.String(100), nullable=False),
        sa.Column("serial_number", sa.String(100), nullable=True),
        sa.Column("imei", sa.String(50), nullable=True),
        sa.Column("start_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date, nullable=False),
        sa.Column("card_no", sa.String(100), nullable=True),
        sa.Column("attachment_id", sa.BigInteger, nullable=True),
        sa.Column("created_by_id", sa.BigInteger, nullable=True),
        sa.Column("created_by_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("receipt_item_id", "unit_code", name="uq_inb_warranty_unit"),
    )
    op.create_index("ix_inb_receipt_unit_warranties_receipt_id", TABLE, ["receipt_id"])
    op.create_index("ix_inb_receipt_unit_warranties_receipt_item_id", TABLE, ["receipt_item_id"])
    op.create_index("ix_inb_warranty_item_code", TABLE, ["item_id", "unit_code"])
    op.create_index("ix_inb_receipt_unit_warranties_created_by_id", TABLE, ["created_by_id"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table(TABLE):
        op.drop_table(TABLE)
