"""Organisation, department, project and year on purchase returns, transport requests
and vendor payments (2026-11-12), so their numbers follow the number card — or the
document they were raised from — and never print NA. An indent return is an `inv_sto`
row and already carries them.

- `pro_returns` also gains the project its number is drawn under.
- `acc_vendor_payments` gains the project NAME beside the id it had, and its
  `payment_no` widens from 30 to 50, the width every other document number has.

Every new column is NULL on an existing row and no row is touched: an older document
keeps its fields and its number. Idempotent.

Revision ID: f5b9d1e3a7c4
Revises: e3a7c5d9b1f2
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "f5b9d1e3a7c4"
down_revision = "e3a7c5d9b1f2"
branch_labels = None
depends_on = None

SCOPE = [
    ("organization_id", sa.BigInteger(), True),
    ("organization_code", sa.String(50), False),
    ("organization_name", sa.String(200), False),
    ("org_department_id", sa.BigInteger(), True),
    ("org_department_name", sa.String(200), False),
    ("fiscal_year", sa.String(10), False),
]
TABLES = {
    "pro_returns": SCOPE + [("project_id", sa.BigInteger(), True),
                            ("project_name", sa.String(200), False)],
    "lgs_transport_requests": SCOPE,
    "acc_vendor_payments": SCOPE + [("project_name", sa.String(200), False)],
}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table, columns in TABLES.items():
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        have = {column["name"]: column for column in inspector.get_columns(table)}
        for name, type_, indexed in columns:
            if name not in have:
                op.add_column(table, sa.Column(name, type_, nullable=True))
                if indexed:
                    op.create_index(f"ix_{table}_{name}", table, [name])
    if "acc_vendor_payments" in tables:
        number = {c["name"]: c for c in inspector.get_columns("acc_vendor_payments")}.get(
            "payment_no")
        if number is not None and (getattr(number["type"], "length", None) or 0) < 50:
            op.alter_column("acc_vendor_payments", "payment_no", existing_type=sa.String(30),
                            type_=sa.String(50), existing_nullable=False)


def downgrade() -> None:
    for table, columns in TABLES.items():
        for name, _type, indexed in columns:
            if indexed:
                op.drop_index(f"ix_{table}_{name}", table_name=table)
            op.drop_column(table, name)
