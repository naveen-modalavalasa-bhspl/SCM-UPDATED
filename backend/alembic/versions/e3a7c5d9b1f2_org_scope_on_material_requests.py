"""Organisation, department and year on material requests (2026-11-12), so a direct
material request's number follows the number card and never prints NA. The project
columns were already there.

`inv_material_requests.mr_no` is widened from 30 to 50, the width every other
document number has (`1c24d996aa06`), so a number built from codes fits.

Every new column is NULL on an existing row and no row is touched: an older request
keeps its fields and its number. Idempotent.

Revision ID: e3a7c5d9b1f2
Revises: da110162fdb7
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "e3a7c5d9b1f2"
down_revision = "da110162fdb7"
branch_labels = None
depends_on = None

TABLE = "inv_material_requests"


def _columns():
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
    if TABLE not in set(inspector.get_table_names()):
        return  # A new database is built by bootstrap, from the models.
    have = {column["name"]: column for column in inspector.get_columns(TABLE)}
    for name, type_, indexed in _columns():
        if name not in have:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))
            if indexed:
                op.create_index(f"ix_{TABLE}_{name}", TABLE, [name])
    number = have.get("mr_no")
    if number is not None and (getattr(number["type"], "length", None) or 0) < 50:
        op.alter_column(TABLE, "mr_no", existing_type=sa.String(30),
                        type_=sa.String(50), existing_nullable=False)


def downgrade() -> None:
    for name, _type, indexed in _columns():
        if indexed:
            op.drop_index(f"ix_{TABLE}_{name}", table_name=TABLE)
        op.drop_column(TABLE, name)
