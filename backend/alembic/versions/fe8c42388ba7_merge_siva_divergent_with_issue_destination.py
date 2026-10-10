"""Merge siva's divergent-migrations merge with the issue-destination merge (2026-10-10).

`30b3e7c3da5f` (siva) joins `d2f8a4c6e1b3` and `d4e6f8a0c2b5`; `f1a3c5e7b9d2` joins
`d2f8a4c6e1b3` and `e7b9d1f3a5c8` (which sits on `d4e6f8a0c2b5`). Both in one tree are
two heads, and `alembic upgrade head` refuses to move with two.

No schema change of its own. A merge revision rather than a re-pointed
`down_revision`: a database already stamped at either side must still reach the
other side's revisions.

Revision ID: fe8c42388ba7
Revises: 30b3e7c3da5f, f1a3c5e7b9d2
Create Date: 2026-10-10
"""
from typing import Sequence, Union

revision: str = "fe8c42388ba7"
down_revision: Union[str, Sequence[str], None] = ("30b3e7c3da5f", "f1a3c5e7b9d2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
