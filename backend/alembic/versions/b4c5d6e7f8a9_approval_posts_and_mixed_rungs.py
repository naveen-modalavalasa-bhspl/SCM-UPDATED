"""Local approval posts, and a ladder rung that can name one.

The approval chain the SCM flow needs (Indent Team -> SCM Head -> Floor In-charge ->
Logistics) cannot be built out of the HCM mirror: five of those chairs were never
created in HCM, and the warehouse posts that do exist arrive with no project and no
parent, so nothing climbs to them.

`wf_approval_posts` is a chair this system owns, seated from `wf_approval_post_members`.
`wf_stages.post_id` lets a rung name one. Both are additive — every existing ladder
keeps `position_id`/`position_role_id` and resolves exactly as before.

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
"""
import sqlalchemy as sa
from alembic import op

revision = "b4c5d6e7f8a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "wf_approval_posts" not in tables:
        op.create_table(
            "wf_approval_posts",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("department", sa.String(120), nullable=True),
            # Soft FK: the day HCM creates the real position, point the chair at it.
            sa.Column("hcm_position_id", sa.BigInteger, nullable=True),
            sa.Column("is_active", sa.Boolean, nullable=False,
                      server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
        )
        op.create_index("ix_wf_approval_posts_code", "wf_approval_posts", ["code"])
        op.create_index("ix_wf_approval_posts_hcm_position_id",
                        "wf_approval_posts", ["hcm_position_id"])

    if "wf_approval_post_members" not in tables:
        op.create_table(
            "wf_approval_post_members",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("post_id", sa.BigInteger, nullable=False),
            # Soft FK to hcm_employees (rule 10): indexed, unconstrained.
            sa.Column("employee_id", sa.BigInteger, nullable=False),
            sa.Column("employee_name", sa.String(200), nullable=True),
            sa.Column("is_active", sa.Boolean, nullable=False,
                      server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
        )
        op.create_index("ix_wf_approval_post_members_post_id",
                        "wf_approval_post_members", ["post_id"])
        op.create_index("ix_wf_approval_post_members_employee_id",
                        "wf_approval_post_members", ["employee_id"])

    columns = {column["name"] for column in inspector.get_columns("wf_stages")}
    if "post_id" not in columns:
        op.add_column("wf_stages", sa.Column("post_id", sa.BigInteger, nullable=True))
        op.create_index("ix_wf_stages_post_id", "wf_stages", ["post_id"])


def downgrade() -> None:
    op.drop_index("ix_wf_stages_post_id", table_name="wf_stages")
    op.drop_column("wf_stages", "post_id")
    op.drop_table("wf_approval_post_members")
    op.drop_table("wf_approval_posts")
