"""Organisation, department and year on indents / STRs / monthly indents, STOs and
material issues (2026-11-09) — the same columns procurement's documents carry
(`OrgScopeColumns`), so their numbers follow the selection and never print NA.

The STO also gains the project it is numbered under (`project_id` / `project_name`): its
`from_project_id` / `to_project_id` say whose stock moves, which is a different thing.

Every column is NULL on an existing row and no row is touched: an older document keeps
its fields, its number and its rules. Idempotent.

Revision ID: 1236d92a1ca7
Revises: 7b0a76022bf8
Create Date: 2026-11-09
"""
import sqlalchemy as sa
from alembic import op

revision = "1236d92a1ca7"
down_revision = "7b0a76022bf8"
branch_labels = None
depends_on = None

DOCUMENTS = ("ind_indents", "inv_sto", "out_issues")
NO_PROJECT_UNTIL_NOW = ("inv_sto",)


def _scope_columns():
    return [
        ("organization_id", sa.BigInteger(), True),
        ("organization_code", sa.String(50), False),
        ("organization_name", sa.String(200), False),
        ("org_department_id", sa.BigInteger(), True),
        ("org_department_name", sa.String(200), False),
        ("fiscal_year", sa.String(10), False),
    ]


def _project_columns():
    return [("project_id", sa.BigInteger(), True), ("project_name", sa.String(200), False)]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in DOCUMENTS:
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        have = {column["name"] for column in inspector.get_columns(table)}
        wanted = _scope_columns() + (_project_columns() if table in NO_PROJECT_UNTIL_NOW else [])
        for name, type_, indexed in wanted:
            if name not in have:
                op.add_column(table, sa.Column(name, type_, nullable=True))
                if indexed:
                    op.create_index(f"ix_{table}_{name}", table, [name])


def downgrade() -> None:
    for table in DOCUMENTS:
        extra = _project_columns() if table in NO_PROJECT_UNTIL_NOW else []
        for name, _type, indexed in _scope_columns() + extra:
            if indexed:
                op.drop_index(f"ix_{table}_{name}", table_name=table)
            op.drop_column(table, name)
