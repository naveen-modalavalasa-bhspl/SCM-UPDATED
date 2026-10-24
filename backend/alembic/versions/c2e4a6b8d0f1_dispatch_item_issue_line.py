"""Consignment lines name the issue LINE they were packed from (2026-10-07).

Adds `out_dispatch_items.issue_item_id` (indexed, soft) and `bin_code`. One batch
drawn from two storage locations is two issue lines; keyed on (issue, item, batch)
alone the packing grid merged them, so a quantity typed into one row wrote the other.
Existing rows keep NULL and are read the old way.

Idempotent: every step checks the live schema first.

Revision ID: c2e4a6b8d0f1
Revises: b1d3f5a7c9e2
Create Date: 2026-10-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c2e4a6b8d0f1"
down_revision: Union[str, Sequence[str], None] = "b1d3f5a7c9e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "out_dispatch_items"
INDEX = "ix_out_dispatch_items_issue_item_id"


def _inspector():
    return sa.inspect(op.get_bind())


def _columns() -> set[str]:
    return {c["name"] for c in _inspector().get_columns(TABLE)}


def _indexes() -> set[str]:
    return {i["name"] for i in _inspector().get_indexes(TABLE)}


def upgrade() -> None:
    columns = _columns()
    if "issue_item_id" not in columns:
        op.add_column(TABLE, sa.Column("issue_item_id", sa.BigInteger(), nullable=True))
    if "bin_code" not in columns:
        op.add_column(TABLE, sa.Column("bin_code", sa.String(100), nullable=True))
    if INDEX not in _indexes():
        op.create_index(INDEX, TABLE, ["issue_item_id"])


def downgrade() -> None:
    if INDEX in _indexes():
        op.drop_index(INDEX, table_name=TABLE)
    columns = _columns()
    if "bin_code" in columns:
        op.drop_column(TABLE, "bin_code")
    if "issue_item_id" in columns:
        op.drop_column(TABLE, "issue_item_id")
