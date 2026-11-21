"""a GRN line's warranty: one for the whole batch, or one per piece (2026-11-21)

`inb_receipt_items.warranty_mode` (BATCH / UNIT) and the batch warranty itself —
start, end, card number and card (a `sys_attachments` row). Idempotent.

Revision ID: e8a0c2d4f6b9
Revises: d7f9b1c3e5a8
Create Date: 2026-11-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e8a0c2d4f6b9"
down_revision: Union[str, None] = "d7f9b1c3e5a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("warranty_mode", sa.String(10)),
    ("warranty_start", sa.Date()),
    ("warranty_end", sa.Date()),
    ("warranty_card_no", sa.String(100)),
    ("warranty_attachment_id", sa.BigInteger()),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("inb_receipt_items"):
        return
    have = {c["name"] for c in inspector.get_columns("inb_receipt_items")}
    for name, kind in COLUMNS:
        if name not in have:
            op.add_column("inb_receipt_items", sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("inb_receipt_items"):
        return
    have = {c["name"] for c in inspector.get_columns("inb_receipt_items")}
    for name, _ in COLUMNS:
        if name in have:
            op.drop_column("inb_receipt_items", name)
