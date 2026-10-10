"""Merge the siva lineage with the material-issue destination column (2026-10-10).

Pulling `siva` brought its own head (`d2f8a4c6e1b3`) beside `e7b9d1f3a5c8` (the
issue destination point), and `alembic upgrade head` refuses to move with two heads.

No schema change of its own; every column belongs to a parent revision. A merge
revision rather than a re-pointed `down_revision`, for the reason the other merges
here give: a database already stamped at one side would otherwise treat the other
side's revisions as ancestors it had passed and skip them in silence.

Revision ID: f1a3c5e7b9d2
Revises: d2f8a4c6e1b3, e7b9d1f3a5c8
Create Date: 2026-10-10
"""
from typing import Sequence, Union

revision: str = "f1a3c5e7b9d2"
down_revision: Union[str, Sequence[str], None] = ("d2f8a4c6e1b3", "e7b9d1f3a5c8")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
