"""A ladder rung is an HCM org role, not a position level.

Written against the live mirror rather than the seed. There, hcm_position_levels
carries seven coarse bands and COO and SPH share Level-3 — so a level-keyed rung
cannot tell the two apart, and switching one off switches off the other.
hcm_positions.role_id is set on every row, has eighteen distinct values, and reads as
the ladder actually does: COO, SPH, REGIONAL MANAGER, DISTRICT MANAGER, OE, MMU PILOT.

position_level_id is dropped rather than kept: no ladder had been saved against it.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-07-29
"""
import sqlalchemy as sa
from alembic import op

revision = "c2d3e4f5a6b7"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    columns = _columns("wf_stages")
    if "position_role_id" not in columns:
        op.add_column("wf_stages", sa.Column("position_role_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_wf_stages_position_role_id", "wf_stages", ["position_role_id"])
    if "position_level_id" in columns:
        op.drop_index("ix_wf_stages_position_level_id", table_name="wf_stages")
        op.drop_column("wf_stages", "position_level_id")


def downgrade() -> None:
    op.add_column("wf_stages", sa.Column("position_level_id", sa.BigInteger(), nullable=True))
    op.create_index("ix_wf_stages_position_level_id", "wf_stages", ["position_level_id"])
    op.drop_index("ix_wf_stages_position_role_id", table_name="wf_stages")
    op.drop_column("wf_stages", "position_role_id")
