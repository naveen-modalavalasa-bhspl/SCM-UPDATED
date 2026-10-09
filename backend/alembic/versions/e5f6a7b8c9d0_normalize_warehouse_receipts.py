"""Normalize legacy warehouse receipt types.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
"""
from alembic import op


revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE inb_receipts
        SET receipt_type = 'PURCHASE'
        WHERE LOWER(receipt_type) = 'direct'
    """)


def downgrade() -> None:
    # "direct" was a legacy import label, not a distinct business document type.
    # Reintroducing it would make GRNs disappear from the current UI.
    pass
