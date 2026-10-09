"""PO approval chat and decrease-only quantity edits.

Approver can ask questions to the raiser and vice versa on a PO, and can
trim quantities down only (increase blocked) while the order is in approval.
Edited numbers are what the vendor receives.

Revision ID: e9f0a1b2c3d4
Revises: fa0c1d2e3f45
Create Date: 2026-09-02
"""
from alembic import op
import sqlalchemy as sa

revision = "e9f0a1b2c3d4"
down_revision = "fa0c1d2e3f45"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent for DBs where the table was created by the startup ensure
    # (main.py lifespan) before alembic runs.
    conn = op.get_bind()
    exists = conn.exec_driver_sql(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'pro_po_comments'"
    ).scalar()
    if not exists:
        op.create_table(
            "pro_po_comments",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("po_id", sa.BigInteger(), nullable=False),
            sa.Column("author_id", sa.BigInteger(), nullable=True),
            sa.Column("author_name", sa.String(200), nullable=True),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["po_id"], ["pro_purchase_orders.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_pro_po_comments_po_id", "pro_po_comments", ["po_id"])
        op.create_index("ix_pro_po_comments_po_created", "pro_po_comments", ["po_id", "created_at"])
    else:
        # ensure indexes exist even if table pre-existed
        for idx, cols in (
            ("ix_pro_po_comments_po_id", ["po_id"]),
            ("ix_pro_po_comments_po_created", ["po_id", "created_at"]),
        ):
            cnt = conn.exec_driver_sql(
                "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'pro_po_comments' AND index_name = %s",
                (idx,),
            ).scalar()
            if not cnt:
                op.create_index(idx, "pro_po_comments", cols)


def downgrade() -> None:
    op.drop_index("ix_pro_po_comments_po_created", table_name="pro_po_comments")
    op.drop_index("ix_pro_po_comments_po_id", table_name="pro_po_comments")
    op.drop_table("pro_po_comments")
