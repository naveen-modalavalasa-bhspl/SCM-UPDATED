"""merge the storage-type master lineage with the qa floor-access lineage

Two heads again, and by the rule CLAUDE.md states: with more than one,
`alembic upgrade head` refuses to move and BOTH sides stay unapplied, so a
screen 500s on a column the models already name.

They fork at `a4c8e2b7d1f9`. `c1a7d3f9b2e5` is the storage-type master —
`whs_warehouse_storage_types`, `whs_storage_type_parents` and the
`storage_type_id` backfill. `c7d8e9f0a1b2` ends the qa lineage of vendor
quote OTP, floor access and the issue split by floor.

Neither touches the other's tables, so the join needs no schema of its own.
It is a merge rather than a re-pointed `down_revision` on purpose: a database
already stamped at `c1a7d3f9b2e5` would treat the three qa revisions as
ancestors it had passed and silently skip them, which is the "database behind
the models" outage rather than a fix for it.

No schema of its own.

Revision ID: b3e7c9a1d4f6
Revises: c1a7d3f9b2e5, c7d8e9f0a1b2
Create Date: 2026-09-09
"""
from typing import Sequence, Union

revision: str = "b3e7c9a1d4f6"
down_revision: Union[str, Sequence[str], None] = ("c1a7d3f9b2e5", "c7d8e9f0a1b2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
