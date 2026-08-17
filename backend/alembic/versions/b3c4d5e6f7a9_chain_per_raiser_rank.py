"""A chain can be pinned to the RANK that raised the document.

One ladder per document could only say one thing: a Store Keeper's indent and a
Regional Manager's climbed the same rungs. The business wants them different — a Store
Keeper's goes OE → RM, an RM's goes straight to the SPH — so a workflow may now name
the raiser's rank it serves. NULL keeps the old meaning: the chain everyone else uses.

Nullable and unindexed-by-default rows already in the table therefore keep working
untouched — this migration adds two columns and nothing else.

Revision ID: b3c4d5e6f7a9
Revises: f2a3b4c5d6e8
"""
import sqlalchemy as sa
from alembic import op

revision = "b3c4d5e6f7a9"
down_revision = "f2a3b4c5d6e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("wf_workflows")}
    if "raiser_role_id" not in columns:
        op.add_column("wf_workflows",
                      sa.Column("raiser_role_id", sa.BigInteger, nullable=True))
        op.create_index("ix_wf_workflows_raiser_role_id",
                        "wf_workflows", ["raiser_role_id"])
    if "raiser_role_name" not in columns:
        op.add_column("wf_workflows",
                      sa.Column("raiser_role_name", sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column("wf_workflows", "raiser_role_name")
    op.drop_index("ix_wf_workflows_raiser_role_id", table_name="wf_workflows")
    op.drop_column("wf_workflows", "raiser_role_id")
