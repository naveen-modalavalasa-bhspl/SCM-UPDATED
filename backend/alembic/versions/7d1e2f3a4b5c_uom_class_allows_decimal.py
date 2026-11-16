"""UOM type "Allows decimal" flag (2026-10-16).

`mst_uom_classes.allows_decimal`: whether every unit of this type may carry a
fractional quantity on a document. Seeded FALSE for the whole-unit classes
(`shared.uom.WHOLE_UNIT_CLASSES`) so the rule that already rounded their splits
is now also the rule that refuses 5.7 on an indent, PO or receipt. Idempotent.

Revision ID: 7d1e2f3a4b5c
Revises: 69f59895baf8
"""
from alembic import op
import sqlalchemy as sa

revision = "7d1e2f3a4b5c"
down_revision = "69f59895baf8"
branch_labels = None
depends_on = None

TABLE = "mst_uom_classes"


def _columns() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if TABLE not in sa.inspect(op.get_bind()).get_table_names():
        return
    if "allows_decimal" not in _columns():
        op.add_column(TABLE, sa.Column("allows_decimal", sa.Boolean(), nullable=False,
                                       server_default=sa.true()))
        op.execute(f"UPDATE {TABLE} SET allows_decimal = 0 "
                   # Long codes and the 3-letter recoded ones (recode_master_codes).
                   "WHERE UPPER(code) IN ('COUNT', 'PACKAGING', 'QUANTITY', "
                   "'COU', 'PAC', 'QUA')")


def downgrade() -> None:
    if "allows_decimal" in _columns():
        op.drop_column(TABLE, "allows_decimal")
