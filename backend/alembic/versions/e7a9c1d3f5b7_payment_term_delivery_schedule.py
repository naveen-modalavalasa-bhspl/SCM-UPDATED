"""`mst_payment_terms.delivery_schedule` — the delivery share paid in equal instalments,
e.g. "30,60,90" days after delivery (2026-10-06). Idempotent.

Revision ID: e7a9c1d3f5b7
Revises: d6f8b0c2e4a6
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7a9c1d3f5b7"
down_revision: Union[str, Sequence[str], None] = "d6f8b0c2e4a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has() -> bool:
    return "delivery_schedule" in {
        c["name"] for c in sa.inspect(op.get_bind()).get_columns("mst_payment_terms")}


def upgrade() -> None:
    if not _has():
        op.add_column("mst_payment_terms",
                      sa.Column("delivery_schedule", sa.String(60), nullable=True))


def downgrade() -> None:
    if _has():
        op.drop_column("mst_payment_terms", "delivery_schedule")
