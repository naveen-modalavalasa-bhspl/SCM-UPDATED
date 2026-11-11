"""The organisation directory, and its organisation and department on every procurement
document (2026-11-05).

`mst_organizations` and `mst_org_departments`: read-only copies of a feed that is not
HCM, keyed on the feed's id, with no link between them.

The seven procurement documents gain the id + snapshot pair for each. Quotation, quote
change request and despatch note also gain the project they never held, so each reads on
its own. Every column is NULL on an existing row, and no row is touched. Idempotent.

Revision ID: d8f2b4a6c1e3
Revises: c7e1a5f3d9b4
Create Date: 2026-11-05
"""
import sqlalchemy as sa
from alembic import op

revision = "d8f2b4a6c1e3"
down_revision = "c7e1a5f3d9b4"
branch_labels = None
depends_on = None

DOCUMENTS = ("pro_purchase_orders", "pro_requisitions", "pro_rfqs", "pro_consolidations",
             "pro_quotations", "pro_quote_change_requests", "pro_despatch_notes")
NO_PROJECT_UNTIL_NOW = ("pro_quotations", "pro_quote_change_requests", "pro_despatch_notes")
DIRECTORY = ("mst_organizations", "mst_org_departments")


def _scope_columns():
    return [
        ("organization_id", sa.BigInteger(), True),
        ("organization_code", sa.String(50), False),
        ("organization_name", sa.String(200), False),
        ("org_department_id", sa.BigInteger(), True),
        ("org_department_name", sa.String(200), False),
    ]


def _project_columns():
    return [("project_id", sa.BigInteger(), True), ("project_name", sa.String(200), False)]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in DIRECTORY:
        if table not in tables:
            op.create_table(
                table,
                sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
                sa.Column("code", sa.String(50), nullable=True),
                sa.Column("name", sa.String(200), nullable=False),
                sa.Column("is_active", sa.Boolean(), nullable=False),
                sa.Column("raw", sa.JSON(), nullable=True),
                sa.Column("synced_at", sa.DateTime(), nullable=False),
            )
            op.create_index(f"ix_{table}_code", table, ["code"])

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
    for table in DIRECTORY:
        op.drop_table(table)
