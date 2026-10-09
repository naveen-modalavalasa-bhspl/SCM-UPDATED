"""merge the warehouse/procurement lineage with the indent line-exclusion lineage

Two heads again, for the same reason as `b3e7c9a1d4f6` and with the same cost:
with more than one, `alembic upgrade head` refuses to move and BOTH sides stay
unapplied, so a screen 500s on a column the models already name.

They fork at `c7d8e9f0a1b2`. `b3e7c9a1d4f6` ends the `naveen-whs&proc&masters`
lineage — the storage-type master joined to the qa floor-access lineage.
`e4f5a6b7c8d9` is qa's own next step, the four `ind_indent_items` columns that
record an EXCLUDED line as distinct from one approved at zero.

`ind_indent_items` and the `whs_*` tables are disjoint, so the join needs no
schema of its own. It is a merge rather than a re-pointed `down_revision` for
the reason `b3e7c9a1d4f6` gives: a database already stamped at `b3e7c9a1d4f6`
would treat `e4f5a6b7c8d9` as an ancestor it had passed and silently skip it,
which is the "database behind the models" outage rather than a fix for it.

No schema of its own.

Revision ID: f7a1c3e5d9b2
Revises: b3e7c9a1d4f6, e4f5a6b7c8d9
Create Date: 2026-09-09
"""
from typing import Sequence, Union

revision: str = "f7a1c3e5d9b2"
down_revision: Union[str, Sequence[str], None] = ("b3e7c9a1d4f6", "e4f5a6b7c8d9")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
