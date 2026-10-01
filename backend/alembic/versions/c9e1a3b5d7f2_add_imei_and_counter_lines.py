"""Two columns the naveen-whs&proc&masters models carry with no migration (2026-09-30).

* ``inb_inspection_items.imei_numbers`` — the IMEIs a QC line keeps, beside
  ``serial_numbers``. Every inspection INSERT names it, so without it submitting a
  GRN whose items need QC raised 1054.
* ``pro_quote_change_requests.supplier_counter_lines`` — the supplier's counter
  prices on a buyer's change request. Every read of that table names it, so the
  quotation's change-request and price-trail panels 500'd.

Guarded by the inspector: a database built by ``bootstrap`` already has both.

Revision ID: c9e1a3b5d7f2
Revises: b7d9f1a3c5e8
Create Date: 2026-09-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9e1a3b5d7f2"
down_revision: Union[str, Sequence[str], None] = "b7d9f1a3c5e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("inb_inspection_items", "imei_numbers"),
    ("pro_quote_change_requests", "supplier_counter_lines"),
)


def _has(bind, table: str, column: str) -> bool:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return True  # nothing to alter; create_all will build it whole
    return column in {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    for table, column in COLUMNS:
        if not _has(bind, table, column):
            op.add_column(table, sa.Column(column, sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    for table, column in COLUMNS:
        inspector = sa.inspect(bind)
        if table in inspector.get_table_names() and column in {
                c["name"] for c in inspector.get_columns(table)}:
            op.drop_column(table, column)
