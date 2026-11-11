"""A purchase order may be booked to a department instead of a project (2026-11-04).

`pro_purchase_orders.department_id` (soft FK to hcm_departments) + `department_name`
snapshot. Idempotent.

Revision ID: f5b7d9e1a3c6
Revises: e4a6c8b0d2f5
Create Date: 2026-11-04
"""
import sqlalchemy as sa
from alembic import op

revision = "f5b7d9e1a3c6"
down_revision = "e4a6c8b0d2f5"
branch_labels = None
depends_on = None

TABLE = "pro_purchase_orders"


def _cols() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    have = _cols()
    if "department_id" not in have:
        op.add_column(TABLE, sa.Column("department_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_pro_purchase_orders_department_id", TABLE, ["department_id"])
    if "department_name" not in have:
        op.add_column(TABLE, sa.Column("department_name", sa.String(200), nullable=True))


def downgrade() -> None:
    have = _cols()
    if "department_name" in have:
        op.drop_column(TABLE, "department_name")
    if "department_id" in have:
        op.drop_index("ix_pro_purchase_orders_department_id", TABLE)
        op.drop_column(TABLE, "department_id")
