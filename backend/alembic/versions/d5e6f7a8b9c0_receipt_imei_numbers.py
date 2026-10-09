"""Record IMEIs on a goods receipt line.

`is_imei_tracked` has been on the item master since the masters overhaul with nothing
anywhere reading it — no column to hold an IMEI, no capture, no check. This adds the
storage so the flag can mean what it says.

Shaped exactly like `serial_numbers`: a JSON list on the receipt line, not a table.
An IMEI identifies the same physical unit a serial does, and splitting them across two
storage shapes would mean two code paths for one idea.

Revision ID: d5e6f7a8b9c0
Revises: c3d4e5f6a7b8
Create Date: 2026-08-06
"""
import sqlalchemy as sa
from alembic import op

revision = "d5e6f7a8b9c0"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inb_receipt_items",
                  sa.Column("imei_numbers", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("inb_receipt_items", "imei_numbers")
