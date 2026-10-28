"""Box codes per ISSUE container (2026-10-26).

`whs_handling_units.held_by` / `held_qty` — an issue line holding a box (the same
"Reserved for issue X line Y" marker a unit carries), and how much of it the line takes
when that is less than the whole box. `whs_box_labels` — the print queue of new box
codes (putaway, the old-stock conversion, a re-code, a part box cut at the issue desk).
Idempotent.

Revision ID: c3e5a7b9d1f4
Revises: b7d1e3f5a9c2
Create Date: 2026-10-26
"""
import sqlalchemy as sa
from alembic import op

revision = "c3e5a7b9d1f4"
down_revision = "b7d1e3f5a9c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    cols = {c["name"] for c in inspector.get_columns("whs_handling_units")}
    if "held_by" not in cols:
        op.add_column("whs_handling_units", sa.Column("held_by", sa.String(120), nullable=True))
        op.create_index("ix_whs_hu_held_by", "whs_handling_units", ["held_by"])
    if "held_qty" not in cols:
        op.add_column("whs_handling_units",
                      sa.Column("held_qty", sa.Numeric(16, 3), nullable=True))
    if "whs_box_labels" not in inspector.get_table_names():
        op.create_table(
            "whs_box_labels",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("handling_unit_id", sa.BigInteger, nullable=False, index=True),
            sa.Column("hu_code", sa.String(120), nullable=False),
            sa.Column("item_id", sa.BigInteger, nullable=False, index=True),
            sa.Column("item_code", sa.String(100), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("warehouse_id", sa.BigInteger, nullable=False, index=True),
            sa.Column("warehouse_name", sa.String(300), nullable=True),
            sa.Column("bin_code", sa.String(120), nullable=True),
            sa.Column("batch_no", sa.String(120), nullable=True),
            sa.Column("pack_name", sa.String(200), nullable=True),
            sa.Column("content_qty", sa.Numeric(16, 3), nullable=False),
            sa.Column("pack_size", sa.Numeric(16, 3), nullable=False),
            sa.Column("uom_code", sa.String(30), nullable=True),
            sa.Column("reason", sa.String(30), nullable=False),
            sa.Column("source_no", sa.String(60), nullable=True),
            sa.Column("status", sa.String(20), nullable=False, server_default="QUEUED",
                      index=True),
            sa.Column("printed_at", sa.DateTime, nullable=True),
            sa.Column("printed_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "whs_box_labels" in inspector.get_table_names():
        op.drop_table("whs_box_labels")
    cols = {c["name"] for c in inspector.get_columns("whs_handling_units")}
    if "held_qty" in cols:
        op.drop_column("whs_handling_units", "held_qty")
    if "held_by" in cols:
        op.drop_index("ix_whs_hu_held_by", table_name="whs_handling_units")
        op.drop_column("whs_handling_units", "held_by")
