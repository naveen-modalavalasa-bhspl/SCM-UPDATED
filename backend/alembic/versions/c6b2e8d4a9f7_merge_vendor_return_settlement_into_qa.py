"""merge the vendor-return settlement lineage into qa

`f3a5c7e9b1d4` ends the ten-migration chain that carries the purchase return past
SENT_TO_VENDOR: the supplier's receipt and their answer, the refund figure, the
replacement leg with its expected date, whether the goods are delivered or collected,
the collection trip, and the manual-entry return. Every one of them descends from
`a7b8c9d0e1f2`, which qa already had, so the chain grafts on without a re-point.

`d4e8a1c7f3b6` is qa's own end. The two touch different columns of `pro_returns` and
different tables besides, so the join needs no schema of its own.

A merge rather than a re-pointed `down_revision`, for the reason every other merge in
this tree gives: a database already stamped on one side would treat the other side's
revisions as ancestors it had passed and skip them in silence, which is the "database
behind the models" outage rather than a fix for it.

No schema of its own.

Revision ID: c6b2e8d4a9f7
Revises: d4e8a1c7f3b6, f3a5c7e9b1d4
Create Date: 2026-09-18
"""
from typing import Sequence, Union

revision: str = "c6b2e8d4a9f7"
down_revision: Union[str, Sequence[str], None] = ("d4e8a1c7f3b6", "f3a5c7e9b1d4")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
