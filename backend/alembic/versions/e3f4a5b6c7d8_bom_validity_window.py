"""An optional validity window on a BOM and on a BOM group.

"Until when may this kit be drawn" was previously only expressible by switching the
row off by hand on the right day. Both ends are nullable and independent: no start
means "since always", no end means "until further notice", neither means the row
stands until someone deactivates it. The flag is untouched — a row outside its window
is scheduled or expired, not retired.

mst_boms already carries the pair (the DB team created that table with it); the check
is here so a database that predates it is brought level too. Guarded and additive: a
no-op wherever the columns already exist.

Revision ID: e3f4a5b6c7d8
Revises: d1c2b3a4e5f6
Create Date: 2026-08-10
"""
import sqlalchemy as sa
from alembic import op

revision = "e3f4a5b6c7d8"
down_revision = "d1c2b3a4e5f6"
branch_labels = None
depends_on = None

TABLES = ("mst_boms", "mst_bom_groups")
COLUMNS = ("effective_from", "effective_to")


def _missing(inspector, table: str) -> list[str]:
    if table not in inspector.get_table_names():
        return []
    have = {c["name"] for c in inspector.get_columns(table)}
    return [c for c in COLUMNS if c not in have]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in TABLES:
        for column in _missing(inspector, table):
            op.add_column(table, sa.Column(column, sa.Date(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    # Only mst_bom_groups gained them here; mst_boms had them before this revision.
    if "mst_bom_groups" not in inspector.get_table_names():
        return
    have = {c["name"] for c in inspector.get_columns("mst_bom_groups")}
    for column in COLUMNS:
        if column in have:
            op.drop_column("mst_bom_groups", column)
