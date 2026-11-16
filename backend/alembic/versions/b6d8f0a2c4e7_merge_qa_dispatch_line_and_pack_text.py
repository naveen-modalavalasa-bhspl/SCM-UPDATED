"""Merge qa's dispatch-line columns with this branch's ledger pack text (2026-10-08).

`d4e6f8a0c2b5` (qa: `out_dispatch_items.issue_item_id` / `bin_code`, the same
columns as `c2e4a6b8d0f1` here, both idempotent) and `f3b5d7f9a1c4`
(`stk_ledger.pack_text`) were two heads, and `alembic upgrade head` refuses to move
with two. A merge revision, never a re-pointed `down_revision`. No schema of its own.

Revision ID: b6d8f0a2c4e7
Revises: d4e6f8a0c2b5, f3b5d7f9a1c4
Create Date: 2026-10-08
"""
from typing import Sequence, Union

revision: str = "b6d8f0a2c4e7"
down_revision: Union[str, Sequence[str], None] = ("d4e6f8a0c2b5", "f3b5d7f9a1c4")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
