"""Backfill `pro_purchase_orders.office_id` from the raiser's HCM office (2026-10-03).

A PO created from an RFQ was written with `office_id = NULL`, so at any scope rung
below ALL the order read as "only the person who raised it" and a buyer with every
procurement permission got "PO 6 not found" on a colleague's order. The create path
now stamps the raiser's office; this fills the rows already written. Data only,
idempotent: it touches only rows still NULL.

Revision ID: a3c5e7f9b1d2
Revises: f2b4d6e8a1c3
Create Date: 2026-10-03
"""
from typing import Sequence, Union

from alembic import op

revision: str = "a3c5e7f9b1d2"
down_revision: Union[str, Sequence[str], None] = "f2b4d6e8a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE pro_purchase_orders po "
        "JOIN hcm_employees e ON e.id = po.created_by_id "
        "SET po.office_id = e.office_id "
        "WHERE po.office_id IS NULL AND e.office_id IS NOT NULL"
    )


def downgrade() -> None:
    # Which rows were NULL before is not recorded; the backfill is not reversed.
    pass
