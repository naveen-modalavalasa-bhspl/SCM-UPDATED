"""Carry HCM's section (LIP/MDP) and physical office type into the mirror.

The rebuilt HCM feed keeps one section per distribution rung — "L I P" and "M.D.P" —
and stamps it on every position, which is the only place the org tells us that a post
is a stocking point. `hcm_positions` had nowhere to put it, so the tag survived only
inside the `raw` JSON blob where nothing can index or join on it. Two columns, id and
name, because the id is HCM's key and the name is what the rung is actually called.

`hcm_offices.office_mode` is HCM's own `office_type` field (Mobile for an MMU vehicle,
Warehouse for a store). It cannot reuse `hcm_offices.office_type`, which holds the
level name (BRANCH OFFICE, FACILITATE) and is returned under that name by
/api/auth/me. Nullable and empty until HCM starts stamping Warehouse on the offices
the warehouse keepers sit in.

Additive and guarded: every step is a no-op on a database that already has the column,
and no existing row changes meaning. The values arrive on the next HCM sync — this
migration deliberately backfills nothing, because the mirror is only ever written by
platform/hcm/sync.py (rule 10).

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a7
Create Date: 2026-08-10
"""
import sqlalchemy as sa
from alembic import op

revision = "c4d5e6f7a8b9"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None

POSITIONS = "hcm_positions"
OFFICES = "hcm_offices"


def _columns(bind, table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _indexes(bind, table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()

    positions = _columns(bind, POSITIONS)
    if "section_id" not in positions:
        op.add_column(POSITIONS, sa.Column("section_id", sa.BigInteger(), nullable=True))
    if "section_name" not in positions:
        op.add_column(POSITIONS, sa.Column("section_name", sa.String(length=200), nullable=True))
    if f"ix_{POSITIONS}_section_id" not in _indexes(bind, POSITIONS):
        op.create_index(f"ix_{POSITIONS}_section_id", POSITIONS, ["section_id"])

    if "office_mode" not in _columns(bind, OFFICES):
        op.add_column(OFFICES, sa.Column("office_mode", sa.String(length=50), nullable=True))
    if f"ix_{OFFICES}_office_mode" not in _indexes(bind, OFFICES):
        op.create_index(f"ix_{OFFICES}_office_mode", OFFICES, ["office_mode"])


def downgrade() -> None:
    bind = op.get_bind()

    if f"ix_{OFFICES}_office_mode" in _indexes(bind, OFFICES):
        op.drop_index(f"ix_{OFFICES}_office_mode", table_name=OFFICES)
    if "office_mode" in _columns(bind, OFFICES):
        op.drop_column(OFFICES, "office_mode")

    if f"ix_{POSITIONS}_section_id" in _indexes(bind, POSITIONS):
        op.drop_index(f"ix_{POSITIONS}_section_id", table_name=POSITIONS)
    positions = _columns(bind, POSITIONS)
    if "section_name" in positions:
        op.drop_column(POSITIONS, "section_name")
    if "section_id" in positions:
        op.drop_column(POSITIONS, "section_id")
