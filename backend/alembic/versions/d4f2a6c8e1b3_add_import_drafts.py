"""sys_import_drafts — a bulk master import under review, kept until saved (2026-09-30).

The review screen held a whole day's fixes in the browser tab alone; an expired
login on Save redirected to /login and threw them away. One row per person per
master lets them log out, come back from any machine and resume.

Guarded by the inspector: a database built by ``bootstrap`` already has the table.

Revision ID: d4f2a6c8e1b3
Revises: c9e1a3b5d7f2
Create Date: 2026-09-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision: str = "d4f2a6c8e1b3"
down_revision: Union[str, Sequence[str], None] = "c9e1a3b5d7f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "sys_import_drafts"


def upgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("employee_id", sa.BigInteger(), nullable=False),
        sa.Column("master_path", sa.String(100), nullable=False),
        sa.Column("payload", sa.Text().with_variant(mysql.LONGTEXT(), "mysql"),
                  nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("employee_id", "master_path",
                            name="uq_import_draft_owner_master"),
    )
    op.create_index("ix_sys_import_drafts_employee_id", TABLE, ["employee_id"])


def downgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table(TABLE)
