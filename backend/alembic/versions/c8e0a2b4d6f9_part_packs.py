"""Part packs: a pack's real contents, and a floor per pack level (2026-10-11).

* `whs_handling_units.content_qty` — what a pack REALLY holds when that is less than
  its `pack_size` (a carton of 600 holding 500, or one with 100 issued out of it).
  NULL means full, which is what every pack written before this is.
* `mst_item_packaging.min_fill_qty` — the least one pack of the level may be MADE
  with, in the item's own unit. NULL: no floor.

Idempotent: checks the live schema first.

Revision ID: c8e0a2b4d6f9
Revises: b6d8f0a2c4e7
Create Date: 2026-10-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c8e0a2b4d6f9"
down_revision: Union[str, Sequence[str], None] = "b6d8f0a2c4e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("whs_handling_units", "content_qty"),
    ("mst_item_packaging", "min_fill_qty"),
)


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    for table, column in COLUMNS:
        present = _columns(table)
        if present and column not in present:
            op.add_column(table, sa.Column(column, sa.Numeric(16, 3), nullable=True))


def downgrade() -> None:
    for table, column in COLUMNS:
        if column in _columns(table):
            op.drop_column(table, column)
