"""Project-wise approval ladders.

A ladder is an ordered list of position LEVELS, each on or off, scoped to a project
and a document type. See docs/superpowers/specs/2026-07-29-project-approval-ladders-design.md.

Every column is nullable / defaulted, so existing workflows keep behaving exactly as
they do today: the engine only takes the ladder path when a stage carries a
position_level_id.

Revision ID: b1c2d3e4f5a6
Revises: a3c4d5e6f7a8
Create Date: 2026-07-29
"""
import sqlalchemy as sa
from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = "a3c4d5e6f7a8"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = sa.inspect(bind).get_columns(table)
    return any(c["name"] == column for c in cols)


def upgrade() -> None:
    if not _has_column("wf_workflows", "project_id"):
        op.add_column("wf_workflows", sa.Column("project_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_wf_workflows_project_id", "wf_workflows", ["project_id"])
    if not _has_column("wf_workflows", "project_name"):
        op.add_column("wf_workflows", sa.Column("project_name", sa.String(200), nullable=True))
    if not _has_column("wf_workflows", "module"):
        op.add_column("wf_workflows", sa.Column("module", sa.String(30), nullable=True))

    if not _has_column("wf_stages", "position_level_id"):
        op.add_column("wf_stages", sa.Column("position_level_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_wf_stages_position_level_id", "wf_stages", ["position_level_id"])
    if not _has_column("wf_stages", "is_enabled"):
        op.add_column("wf_stages", sa.Column(
            "is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))

    if not _has_column("wf_instances", "project_id"):
        op.add_column("wf_instances", sa.Column("project_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_wf_instances_project_id", "wf_instances", ["project_id"])
    if not _has_column("wf_instances", "resolved_chain"):
        op.add_column("wf_instances", sa.Column("resolved_chain", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("wf_instances", "resolved_chain")
    op.drop_index("ix_wf_instances_project_id", table_name="wf_instances")
    op.drop_column("wf_instances", "project_id")
    op.drop_column("wf_stages", "is_enabled")
    op.drop_index("ix_wf_stages_position_level_id", table_name="wf_stages")
    op.drop_column("wf_stages", "position_level_id")
    op.drop_column("wf_workflows", "module")
    op.drop_column("wf_workflows", "project_name")
    op.drop_index("ix_wf_workflows_project_id", table_name="wf_workflows")
    op.drop_column("wf_workflows", "project_id")
