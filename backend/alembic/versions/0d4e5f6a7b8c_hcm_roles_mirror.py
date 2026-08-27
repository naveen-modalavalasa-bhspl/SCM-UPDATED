"""Mirror the complete HCM role catalogue.

Revision ID: 0d4e5f6a7b8c
Revises: e8f9a0b1c2d3
Create Date: 2026-08-27
"""
import sqlalchemy as sa
from alembic import op

revision = "0d4e5f6a7b8c"
down_revision = "e8f9a0b1c2d3"
branch_labels = None
depends_on = None

BigInt = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "hcm_roles",
        sa.Column("id", BigInt, primary_key=True, autoincrement=False),
        sa.Column("code", sa.String(length=50), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        sa.Column("role_type_id", BigInt, nullable=True),
        sa.Column("role_type_name", sa.String(length=200), nullable=True),
        sa.Column("job_family_id", BigInt, nullable=True),
        sa.Column("job_family_name", sa.String(length=200), nullable=True),
        sa.Column("project_id", BigInt, nullable=True),
        sa.Column("project_name", sa.String(length=200), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("synced_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_hcm_roles_role_type_id", "hcm_roles", ["role_type_id"])
    op.create_index("ix_hcm_roles_project_id", "hcm_roles", ["project_id"])
    op.create_index("ix_hcm_roles_is_active", "hcm_roles", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_hcm_roles_is_active", table_name="hcm_roles")
    op.drop_index("ix_hcm_roles_project_id", table_name="hcm_roles")
    op.drop_index("ix_hcm_roles_role_type_id", table_name="hcm_roles")
    op.drop_table("hcm_roles")

