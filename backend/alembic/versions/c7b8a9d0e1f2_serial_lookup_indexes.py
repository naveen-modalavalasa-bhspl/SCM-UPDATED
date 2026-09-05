"""whs_serial_numbers: the indexes its own screens read it by

773,354 unit rows, 23 distinct items and 7 warehouses — so `item_id` alone matches
~33,000 rows and every lookup the issue screen makes scanned them. Opening one
material issue took 26 seconds, all of it here: the reservation lookup had no index
on `remarks` at all and scanned the whole table, and each per-line availability count
walked a third of an item's units.

Three indexes, one per question actually asked:

* `(item_id, warehouse_id, status, is_active, batch_id, bin_id)` — "what does this
  of this item, in this batch, in this bin, free to pick". Every unit query in the
  issue, picking and consignment paths starts with exactly that prefix.
* `(item_id, warehouse_id, is_active)` — "does this item have identified units here
  at all", the DISTINCT behind the unit picker being offered on a line.
* `remarks(80)` — a prefix index, because the column is 500 wide and the reservation
  stamps that are looked up (`Reserved for issue 72 line 5`, `Issued by dispatch 41`)
  are all far shorter than that.

Index-only. No column, no data change.

Revision ID: c7b8a9d0e1f2
Revises: ff00a1b2c3d4
"""
from alembic import op
import sqlalchemy as sa

revision = "c7b8a9d0e1f2"
down_revision = "ff00a1b2c3d4"
branch_labels = None
depends_on = None


TABLE = "whs_serial_numbers"


def _existing(conn) -> set[str]:
    return {
        row[2]
        for row in conn.execute(sa.text(f"SHOW INDEX FROM {TABLE}")).fetchall()
    }


def upgrade() -> None:
    conn = op.get_bind()
    have = _existing(conn)
    if "ix_whs_serial_stock_lookup" not in have:
        op.create_index("ix_whs_serial_stock_lookup", TABLE,
                        ["item_id", "warehouse_id", "status", "is_active",
                         "batch_id", "bin_id"])
    if "ix_whs_serial_point_item" not in have:
        op.create_index("ix_whs_serial_point_item", TABLE,
                        ["item_id", "warehouse_id", "is_active"])
    if "ix_whs_serial_remarks" not in have:
        # A prefix index: MySQL cannot index 500 characters here, and every stamp we
        # look up is shorter than 80.
        conn.execute(sa.text(
            f"CREATE INDEX ix_whs_serial_remarks ON {TABLE} (remarks(80))"))


def downgrade() -> None:
    conn = op.get_bind()
    have = _existing(conn)
    for name in ("ix_whs_serial_remarks", "ix_whs_serial_point_item",
                 "ix_whs_serial_stock_lookup"):
        if name in have:
            op.drop_index(name, table_name=TABLE)
