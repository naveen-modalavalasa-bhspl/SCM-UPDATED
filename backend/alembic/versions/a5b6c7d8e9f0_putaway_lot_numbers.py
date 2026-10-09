"""Putaway lot numbers, and the location-tree data they depend on.

A lot number names where stock came to rest — `LOT/WH10/A-F1-L1-R1-S1-A1/2026-27/00001`
— so it is stamped at putaway confirm, once a bin is chosen, and never before.

The data repairs are here rather than in a script because the cascading location picker
cannot render a tree that contradicts itself: a location parented into another
warehouse belongs to neither tree, and a bin-managed warehouse with no locations offers
nothing to put anything into.

Revision ID: a5b6c7d8e9f0
Revises: fa0c1d2e3f45
"""
from alembic import op
import sqlalchemy as sa

revision = "a5b6c7d8e9f0"
down_revision = "fa0c1d2e3f45"
branch_labels = None
depends_on = None


LOT_PATTERN = "{PREFIX}/{WH}/{PATH}/{FY}/{SEQ:5}"


def upgrade() -> None:
    op.add_column("whs_warehouse_items",
                  sa.Column("lot_no", sa.String(120), nullable=True))
    op.create_index("ix_whs_warehouse_items_lot_no", "whs_warehouse_items", ["lot_no"])

    op.add_column("whs_serial_numbers",
                  sa.Column("lot_no", sa.String(120), nullable=True))
    op.create_index("ix_whs_serial_numbers_lot_no", "whs_serial_numbers", ["lot_no"])

    # The series the lot number is drawn from. Created here rather than left to
    # numbering's fallback, because the fallback pattern has no {WH}/{PATH} in it and
    # would silently produce lot numbers with no storage path.
    conn = op.get_bind()
    fy = conn.execute(sa.text(
        "SELECT fiscal_year FROM sys_doc_series WHERE is_active = 1 "
        "ORDER BY fiscal_year DESC LIMIT 1"
    )).scalar() or "2026-27"
    exists = conn.execute(sa.text(
        "SELECT id FROM sys_doc_series WHERE doc_type = 'lot'"
    )).scalar()
    if not exists:
        conn.execute(
            sa.text(
                "INSERT INTO sys_doc_series "
                "(doc_type, fiscal_year, prefix, pattern, last_number, is_active, "
                " reset_policy, last_reset_period) "
                "VALUES ('lot', :fy, 'LOT', :pattern, 0, 1, 'YEARLY', :fy)"
            ),
            {"fy": fy, "pattern": LOT_PATTERN},
        )

    # A location whose parent sits in another warehouse is orphaned in both trees.
    # Rooting it in its own warehouse keeps the row and its stock reachable; the
    # service now rejects the same mistake at write time.
    conn.execute(sa.text(
        "UPDATE whs_warehouse_locations child "
        "JOIN whs_warehouse_locations parent ON parent.id = child.parent_location_id "
        "SET child.parent_location_id = NULL "
        "WHERE parent.warehouse_id <> child.warehouse_id"
    ))

    # Bin-managed with no locations means putaway there can never be confirmed. Such a
    # warehouse is stocking in bulk whatever the flag claims, so the flag is corrected.
    conn.execute(sa.text(
        "UPDATE whs_warehouses w SET w.is_bin_managed = 0 "
        "WHERE w.is_bin_managed = 1 AND NOT EXISTS ("
        "  SELECT 1 FROM whs_warehouse_locations l WHERE l.warehouse_id = w.id)"
    ))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM sys_doc_series WHERE doc_type = 'lot'"))
    op.drop_index("ix_whs_serial_numbers_lot_no", table_name="whs_serial_numbers")
    op.drop_column("whs_serial_numbers", "lot_no")
    op.drop_index("ix_whs_warehouse_items_lot_no", table_name="whs_warehouse_items")
    op.drop_column("whs_warehouse_items", "lot_no")
