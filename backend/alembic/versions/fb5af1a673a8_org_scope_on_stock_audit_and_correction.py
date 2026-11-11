"""Organisation, department, project and year on stock audits and stock corrections
(2026-11-11), so their numbers follow the selection and never print NA. A stock
movement order already carries them (it is an `inv_sto` row, `1236d92a1ca7`).

`inv_adjustments.adjustment_no` is widened from 30 to 50, the width every other
document number now has (`1c24d996aa06`), so a number built from codes fits.

Every new column is NULL on an existing row and no row is touched: an older audit or
correction keeps its fields and its number. Idempotent.

Revision ID: fb5af1a673a8
Revises: 5365d18b02c7
Create Date: 2026-11-11
"""
import sqlalchemy as sa
from alembic import op

revision = "fb5af1a673a8"
down_revision = "5365d18b02c7"
branch_labels = None
depends_on = None

DOCUMENTS = ("inv_adjustments", "whs_stock_edits")


def _columns():
    return [
        ("organization_id", sa.BigInteger(), True),
        ("organization_code", sa.String(50), False),
        ("organization_name", sa.String(200), False),
        ("org_department_id", sa.BigInteger(), True),
        ("org_department_name", sa.String(200), False),
        ("fiscal_year", sa.String(10), False),
        ("project_id", sa.BigInteger(), True),
        ("project_name", sa.String(200), False),
    ]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in DOCUMENTS:
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        have = {column["name"] for column in inspector.get_columns(table)}
        for name, type_, indexed in _columns():
            if name not in have:
                op.add_column(table, sa.Column(name, type_, nullable=True))
                if indexed:
                    op.create_index(f"ix_{table}_{name}", table, [name])
    if "inv_adjustments" in tables:
        current = {c["name"]: c for c in inspector.get_columns("inv_adjustments")}
        number = current.get("adjustment_no")
        if number is not None and (getattr(number["type"], "length", None) or 0) < 50:
            op.alter_column("inv_adjustments", "adjustment_no", existing_type=sa.String(30),
                            type_=sa.String(50), existing_nullable=False)


def downgrade() -> None:
    for table in DOCUMENTS:
        for name, _type, indexed in _columns():
            if indexed:
                op.drop_index(f"ix_{table}_{name}", table_name=table)
            op.drop_column(table, name)
