"""supplier bank details, same-state GST switch, a PO's fixed tax split (2026-11-23)

- mst_vendors.bank_name / bank_account_no / ifsc_code / is_same_state
- pro_purchase_orders.tax_region_fixed — INTRA / INTER as of submit.

Existing suppliers keep is_same_state NULL, which follows the GSTIN rule they always
did, so no order's tax changes. Idempotent.

Revision ID: f1b3d5a7c9e2
Revises: e8a0c2d4f6b9
Create Date: 2026-11-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1b3d5a7c9e2"
down_revision: Union[str, None] = "e8a0c2d4f6b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("mst_vendors", "bank_name", sa.String(150)),
    ("mst_vendors", "bank_account_no", sa.String(30)),
    ("mst_vendors", "ifsc_code", sa.String(11)),
    ("mst_vendors", "is_same_state", sa.Boolean()),
    ("pro_purchase_orders", "tax_region_fixed", sa.String(10)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, name, kind in COLUMNS:
        if inspector.has_table(table) and name not in {c["name"] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, name, _ in COLUMNS:
        if inspector.has_table(table) and name in {c["name"] for c in inspector.get_columns(table)}:
            op.drop_column(table, name)
