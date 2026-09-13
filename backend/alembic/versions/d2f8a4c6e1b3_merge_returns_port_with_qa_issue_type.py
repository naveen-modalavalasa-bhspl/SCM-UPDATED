"""merge the returns/logistics port with qa's issue-type head

ADDED 2026-09-13, porting the returns and logistics work off
`saiteja-indent,approvals,logistics` into this tree.

Two heads, one per side, and `alembic upgrade head` refuses to move while there is
more than one — the same standoff CLAUDE.md records three times already:

  * `b3c4d5e6f7a1` — the ported side. Itself a merge of `a7b8c9d0e1f2` (the three
    `pro_returns` source columns the returns module writes) and `e4f5a6b7c8d9` (the
    indent line-exclusion columns, already in this tree's lineage). Carried over
    from the source branch UNCHANGED and on purpose: the `sai_scm` development
    database is already stamped at this id, so re-cutting the merge under a new id
    would leave that database pointing at a revision nothing here can locate.
  * `a4d8f2c6b9e3` — qa's own next step, the issue-type column.

No schema change of its own; every column belongs to a parent revision. A merge
revision rather than a re-pointed `down_revision`, for the reason
`f7a1c3e5d9b2` gives: a database already stamped at one side would treat the
other side's revisions as ancestors it had passed and skip them in silence.

Revision ID: d2f8a4c6e1b3
Revises: b3c4d5e6f7a1, a4d8f2c6b9e3
Create Date: 2026-09-13
"""
from typing import Sequence, Union

revision: str = "d2f8a4c6e1b3"
down_revision: Union[str, Sequence[str], None] = ("b3c4d5e6f7a1", "a4d8f2c6b9e3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Nothing to do — both parents carry their own columns."""


def downgrade() -> None:
    """Nothing to undo; splitting the heads again is the parents' business."""
