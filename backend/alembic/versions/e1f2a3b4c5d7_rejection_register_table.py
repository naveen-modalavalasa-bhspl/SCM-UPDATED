"""rejection register table whs_rejection_outcomes

Revision ID: e1f2a3b4c5d7
Revises: fb5af1a673a8
Create Date: 2026-11-13

Promotes `whs_rejection_outcomes` from a runtime-bootstrap table to a first-class
Alembic-managed table. The model has lived in `warehouse/models.py` since the
"rejection register data layer" commit (7121260); until now the table was created
only by the application's idempotent `bootstrap` auto-DDL, which is fine for dev but
unsafe for production deploys where bootstrap may be disabled. This migration is
itself idempotent — a database that has already bootstrapped the table is left alone.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e1f2a3b4c5d7"
down_revision: Union[str, Sequence[str], None] = "fb5af1a673a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return table in inspector.get_table_names()


def upgrade() -> None:
    if _has_table("whs_rejection_outcomes"):
        # Already created by bootstrap — leave it alone.
        return
    op.create_table(
        "whs_rejection_outcomes",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("inspection_id", sa.BigInteger, nullable=False, index=True),
        sa.Column("inspection_item_id", sa.BigInteger, nullable=False, index=True),
        sa.Column("inspection_no", sa.String(50), nullable=True),
        # RejectionDirection: INWARD / OUTWARD / STOCK_TRANSFER
        sa.Column("direction", sa.String(20), nullable=False),
        sa.Column("issue_id", sa.BigInteger, nullable=True, index=True),
        sa.Column("receipt_id", sa.BigInteger, nullable=True, index=True),
        sa.Column("warehouse_id", sa.BigInteger, nullable=True, index=True),
        sa.Column("warehouse_name", sa.String(200), nullable=True),
        sa.Column("item_id", sa.BigInteger, nullable=False, index=True),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("batch_no", sa.String(50), nullable=True),
        sa.Column("rejected_qty", sa.Numeric(16, 3), nullable=False, server_default="0"),
        sa.Column("rejection_reason", sa.String(100), nullable=True),
        # [{code, kind, qty?}] — every identifier the rejection turned away
        sa.Column("unit_codes", sa.JSON, nullable=True),
        # RejectionOutcome: PENDING / DISPOSED / RETURNED_TO_VENDOR /
        # RETURNED_TO_STOCK / REPLACED
        sa.Column("outcome", sa.String(30), nullable=False, server_default="PENDING"),
        sa.Column("outcome_by_id", sa.BigInteger, nullable=True),
        sa.Column("outcome_by_name", sa.String(200), nullable=True),
        sa.Column("outcome_at", sa.DateTime, nullable=True),
        sa.Column("outcome_remarks", sa.String(500), nullable=True),
        sa.Column("outcome_doc_no", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "ix_whs_rejection_outcomes_direction", "whs_rejection_outcomes", ["direction"])
    op.create_index(
        "ix_whs_rejection_outcomes_outcome", "whs_rejection_outcomes", ["outcome"])


def downgrade() -> None:
    if not _has_table("whs_rejection_outcomes"):
        return
    op.drop_index("ix_whs_rejection_outcomes_outcome", table_name="whs_rejection_outcomes")
    op.drop_index("ix_whs_rejection_outcomes_direction", table_name="whs_rejection_outcomes")
    op.drop_table("whs_rejection_outcomes")
