"""indent item partial exclusion: ind_indent_items.excluded_qty, exclusion_reason

Revision ID: a3c5e7b9d1f2
Revises: e1f2a3b4c5d7
Create Date: 2026-11-16

SCM_0153: an approver may exclude PART of a line ("take 20 of these 50 out") with a
reason, not only the whole of it. `is_excluded` keeps meaning "all of it";
`excluded_qty` is how much has been taken out across every rung, and
`exclusion_reason` the last reason given. Idempotent, like the migrations around it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a3c5e7b9d1f2"
down_revision: Union[str, Sequence[str], None] = "e1f2a3b4c5d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "ind_indent_items"


def _has_column(column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column in {c["name"] for c in inspector.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column("excluded_qty"):
        op.add_column(TABLE, sa.Column("excluded_qty", sa.Numeric(16, 3), nullable=False,
                                       server_default="0"))
    if not _has_column("exclusion_reason"):
        op.add_column(TABLE, sa.Column("exclusion_reason", sa.String(255), nullable=True))


def downgrade() -> None:
    if _has_column("exclusion_reason"):
        op.drop_column(TABLE, "exclusion_reason")
    if _has_column("excluded_qty"):
        op.drop_column(TABLE, "excluded_qty")
