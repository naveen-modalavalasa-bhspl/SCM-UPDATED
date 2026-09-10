"""Backfill item scopes for RFQ invitations created before snapshots existed.

Revision ID: b3e5a7c9d1f2
Revises: a2d4f6b8c0e1
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b3e5a7c9d1f2"
down_revision: Union[str, Sequence[str], None] = "a2d4f6b8c0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    invitations = sa.table(
        "pro_rfq_vendors",
        sa.column("id", sa.BigInteger()),
        sa.column("rfq_id", sa.BigInteger()),
        sa.column("vendor_id", sa.BigInteger()),
        sa.column("mapped_item_ids", sa.JSON()),
    )
    rfq_items = sa.table(
        "pro_rfq_items",
        sa.column("rfq_id", sa.BigInteger()),
        sa.column("item_id", sa.BigInteger()),
    )
    vendor_items = sa.table(
        "mst_vendor_items",
        sa.column("vendor_id", sa.BigInteger()),
        sa.column("item_id", sa.BigInteger()),
    )
    for invitation in bind.execute(sa.select(
            invitations.c.id, invitations.c.rfq_id, invitations.c.vendor_id)):
        item_ids = list(bind.execute(
            sa.select(rfq_items.c.item_id)
            .join(vendor_items, vendor_items.c.item_id == rfq_items.c.item_id)
            .where(
                rfq_items.c.rfq_id == invitation.rfq_id,
                vendor_items.c.vendor_id == invitation.vendor_id,
            )
            .distinct()
        ).scalars())
        bind.execute(
            sa.update(invitations)
            .where(invitations.c.id == invitation.id)
            .values(mapped_item_ids=sorted(item_ids)))


def downgrade() -> None:
    op.execute(sa.text("UPDATE pro_rfq_vendors SET mapped_item_ids = NULL"))
