"""An approval post can carry a job profile, so seating someone grants their access.

Without it, creating "SCM Head" as a post and seating Rajani in it gave her a rung on
a ladder and nothing else — somebody then had to go to RBAC and grant her the
permissions by hand, and again for every replacement. The post is the chair; the
profile is what the chair may do.

Revision ID: a1b2c3d4e5f7
Revises: e7f8a9b0c1d2
"""
import sqlalchemy as sa
from alembic import op

revision = "a1b2c3d4e5f7"
down_revision = "e7f8a9b0c1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("wf_approval_posts")}
    if "rbac_role_id" not in columns:
        op.add_column("wf_approval_posts",
                      sa.Column("rbac_role_id", sa.BigInteger, nullable=True))
        op.create_index("ix_wf_approval_posts_rbac_role_id",
                        "wf_approval_posts", ["rbac_role_id"])


def downgrade() -> None:
    op.drop_index("ix_wf_approval_posts_rbac_role_id",
                  table_name="wf_approval_posts")
    op.drop_column("wf_approval_posts", "rbac_role_id")
