"""Organisation, department and year on material inward / GRN, QC and put-away
(2026-11-11) — the columns procurement, indents, STOs and material issues already carry
(`OrgScopeColumns`), so these numbers follow the organisation and never print NA.

Every column is NULL on an existing row and no row is touched: an older receipt keeps its
fields and its number. Idempotent.

Revision ID: 5365d18b02c7
Revises: 1c24d996aa06
Create Date: 2026-11-11
"""
import sqlalchemy as sa
from alembic import op

revision = "5365d18b02c7"
down_revision = "1c24d996aa06"
branch_labels = None
depends_on = None

DOCUMENTS = ("inb_receipts", "inb_inspections", "whs_warehouse_items")


def _scope_columns():
    return [
        ("organization_id", sa.BigInteger(), True),
        ("organization_code", sa.String(50), False),
        ("organization_name", sa.String(200), False),
        ("org_department_id", sa.BigInteger(), True),
        ("org_department_name", sa.String(200), False),
        ("fiscal_year", sa.String(10), False),
    ]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in DOCUMENTS:
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        have = {column["name"] for column in inspector.get_columns(table)}
        for name, type_, indexed in _scope_columns():
            if name not in have:
                op.add_column(table, sa.Column(name, type_, nullable=True))
                if indexed:
                    op.create_index(f"ix_{table}_{name}", table, [name])


def downgrade() -> None:
    for table in DOCUMENTS:
        for name, _type, indexed in _scope_columns():
            if indexed:
                op.drop_index(f"ix_{table}_{name}", table_name=table)
            op.drop_column(table, name)
