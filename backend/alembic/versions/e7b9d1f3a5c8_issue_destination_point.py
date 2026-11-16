"""A material issue may name the stocking point it is going to (2026-10-10).

Adds `out_issues.destination_warehouse_id` (indexed, soft) and
`destination_warehouse_name`. A direct issue used to take its destination only from
the issued-to person's office, so a store sending goods to an MDP or a LIP with no
person in mind had no way to say where they were going. NULL keeps the derived
answer, so every existing row reads exactly as before.

Idempotent, like its neighbours.

Revision ID: e7b9d1f3a5c8
Revises: d4e6f8a0c2b5
Create Date: 2026-10-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7b9d1f3a5c8"
down_revision: Union[str, Sequence[str], None] = "d4e6f8a0c2b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "out_issues"
INDEX = "ix_out_issues_destination_warehouse_id"


def _inspector():
    return sa.inspect(op.get_bind())


def _columns() -> set[str]:
    return {c["name"] for c in _inspector().get_columns(TABLE)}


def _indexes() -> set[str]:
    return {i["name"] for i in _inspector().get_indexes(TABLE)}


def upgrade() -> None:
    columns = _columns()
    if "destination_warehouse_id" not in columns:
        op.add_column(TABLE, sa.Column("destination_warehouse_id", sa.BigInteger(), nullable=True))
    if "destination_warehouse_name" not in columns:
        op.add_column(TABLE, sa.Column("destination_warehouse_name", sa.String(200), nullable=True))
    if INDEX not in _indexes():
        op.create_index(INDEX, TABLE, ["destination_warehouse_id"])


def downgrade() -> None:
    if INDEX in _indexes():
        op.drop_index(INDEX, table_name=TABLE)
    columns = _columns()
    if "destination_warehouse_name" in columns:
        op.drop_column(TABLE, "destination_warehouse_name")
    if "destination_warehouse_id" in columns:
        op.drop_column(TABLE, "destination_warehouse_id")
