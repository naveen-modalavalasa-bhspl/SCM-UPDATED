"""item operational ownership by HCM department

An item's owner is the department responsible for item-related work and downstream
ticket routing (for example, laptop -> IT). It is not the project dimension on the
stock ledger, which continues to describe who owns a physical quantity.

Both columns are nullable so existing catalogue rows remain truthful until masters
assign them. The ID is the routing authority; the name is a display snapshot.

Revision ID: d8a4f2c6e1b9
Revises: c6b2e8d4a9f7
Create Date: 2026-09-18
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d8a4f2c6e1b9"
down_revision: Union[str, Sequence[str], None] = "c6b2e8d4a9f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "mst_items"
_INDEX = "ix_mst_items_owner_department_id"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {row["name"] for row in inspector.get_columns(_TABLE)}
    if "owner_department_id" not in columns:
        op.add_column(
            _TABLE,
            sa.Column("owner_department_id", sa.BigInteger(), nullable=True),
        )
    if "owner_department_name" not in columns:
        op.add_column(
            _TABLE,
            sa.Column("owner_department_name", sa.String(length=200), nullable=True),
        )

    indexes = {row["name"] for row in sa.inspect(bind).get_indexes(_TABLE)}
    if _INDEX not in indexes:
        op.create_index(_INDEX, _TABLE, ["owner_department_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = {row["name"] for row in inspector.get_indexes(_TABLE)}
    if _INDEX in indexes:
        op.drop_index(_INDEX, table_name=_TABLE)

    columns = {row["name"] for row in sa.inspect(bind).get_columns(_TABLE)}
    if "owner_department_name" in columns:
        op.drop_column(_TABLE, "owner_department_name")
    if "owner_department_id" in columns:
        op.drop_column(_TABLE, "owner_department_id")
