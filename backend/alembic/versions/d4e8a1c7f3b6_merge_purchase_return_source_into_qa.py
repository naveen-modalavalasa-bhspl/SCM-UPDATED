"""merge the purchase-return-source lineage into qa

Two heads again, and the cost is the one every merge revision in this tree was cut
for: with more than one, `alembic upgrade head` refuses to move at all, so BOTH
sides stay unapplied and a screen 500s on a column the models already name.

`a7b8c9d0e1f2` adds the three `pro_purchase_returns` source columns and descends
from `a4c8e2b7d1f9`. `a4d8f2c6b9e3` is qa's own next step. The tables are disjoint,
so the join needs no schema of its own.

The saiteja branch published its own merge for this (`b3c4d5e6f7a1`, joining
`a7b8c9d0e1f2` to `e4f5a6b7c8d9`). It is deliberately NOT ported: qa already
reached `e4f5a6b7c8d9` through `f7a1c3e5d9b2`, so replaying that merge would leave
two heads rather than one. This joins the purchase-return revision to where qa
actually ends.

A merge rather than a re-pointed `down_revision`, for the reason `f7a1c3e5d9b2`
gives: a database already stamped on one side would treat the other side's
revisions as ancestors it had passed and skip them in silence.

No schema of its own.

Revision ID: d4e8a1c7f3b6
Revises: a4d8f2c6b9e3, a7b8c9d0e1f2
Create Date: 2026-09-17
"""
from typing import Sequence, Union

revision: str = "d4e8a1c7f3b6"
down_revision: Union[str, Sequence[str], None] = ("a4d8f2c6b9e3", "a7b8c9d0e1f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
